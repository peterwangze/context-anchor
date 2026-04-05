#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildBootstrapCacheContent,
  buildBootstrapCachePath,
  buildMinimalBootstrapContent,
  writeBootstrapCache
} = require('../../scripts/lib/bootstrap-cache');
const { buildTaskStateSummary } = require('../../scripts/lib/task-state');
const {
  createPaths,
  getRecentSessions,
  loadSessionState,
  readRuntimeStateSnapshot,
  readText,
  sanitizeKey,
  sessionCheckpointFile
} = require('../../scripts/lib/context-anchor');
const {
  ensureWorkspaceRegistration,
  getWorkspaceRegistrationStatus,
  resolveOwnership
} = require('../../scripts/lib/host-config');
const { runHeartbeat } = require('../../scripts/heartbeat');
const { runSessionClose } = require('../../scripts/session-close');
const { runSessionCompact } = require('../../scripts/session-compact');
const { runSessionStart } = require('../../scripts/session-start');

function parsePayload(rawArg) {
  if (!rawArg) {
    return {};
  }

  const maybeFile = path.resolve(rawArg);
  try {
    if (fs.existsSync(maybeFile)) {
      return JSON.parse(fs.readFileSync(maybeFile, 'utf8'));
    }

    return JSON.parse(rawArg);
  } catch (error) {
    throw new Error(
      'Payload must be valid JSON or a path to a JSON file. Use a payload file if your shell quoting is difficult.'
    );
  }
}

function stripInvocationEnvelope(request = {}) {
  const next = { ...request };
  ['event', 'eventName', 'name', 'hook', 'type', 'payload', 'data', 'body', 'input', 'args'].forEach((key) => {
    delete next[key];
  });
  return next;
}

function resolveHookInvocation(arg1, arg2, arg3) {
  if (typeof arg1 === 'string') {
    return {
      eventName: arg1,
      payload: arg2 && typeof arg2 === 'object' ? arg2 : {}
    };
  }

  const request = arg1 && typeof arg1 === 'object' ? arg1 : {};
  const context = arg2 && typeof arg2 === 'object' ? arg2 : arg3 && typeof arg3 === 'object' ? arg3 : {};
  const eventName =
    request.event ||
    request.eventName ||
    request.name ||
    request.hook ||
    context.event ||
    context.eventName ||
    context.name ||
    context.hook ||
    null;
  const payloadCandidate =
    request.payload ||
    request.data ||
    request.body ||
    request.input ||
    request.args ||
    null;

  return {
    eventName,
    payload: payloadCandidate && typeof payloadCandidate === 'object' ? payloadCandidate : stripInvocationEnvelope(request)
  };
}

function requirePayloadFields(payload, eventName, requiredFields) {
  const missing = requiredFields.filter((field) => {
    const value = payload?.[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Event ${eventName} requires payload field(s): ${missing.join(', ')}. Use a payload JSON file if manual shell quoting is difficult.`
    );
  }
}

function normalizePayload(payload = {}) {
  const ownership = resolveOwnership(undefined, {
    workspace: payload.workspace,
    sessionKey: payload.session_key,
    projectId: payload.project_id,
    userId: payload.user_id
  });

  return {
    ...payload,
    workspace: ownership.workspace || payload.workspace || null,
    project_id: payload.project_id || ownership.projectId || null,
    user_id: payload.user_id || ownership.userId || null
  };
}

function buildConfigureGuidance(eventName, payload) {
  const ensured = ensureWorkspaceRegistration(undefined, payload.workspace, {
    userId: payload.user_id,
    projectId: payload.project_id,
    reason: `hook:${eventName}`
  });
  if (ensured.status !== 'blocked') {
    return null;
  }

  const status = getWorkspaceRegistrationStatus(undefined, payload.workspace, {
    userId: payload.user_id,
    projectId: payload.project_id
  });
  const configureScript = path.resolve(__dirname, '..', '..', 'scripts', 'configure-host.js');

  if (status.configured) {
    return null;
  }

  return {
    status: 'needs_configuration',
    event: eventName,
    actions: ['configure_workspace'],
    onboarding: ensured,
    workspace: status.workspace,
    suggested_user_id: status.suggestedUserId,
    suggested_project_id: status.suggestedProjectId,
    configure_command: `node "${configureScript}" --add-workspace "${status.workspace}|${status.suggestedUserId}|${status.suggestedProjectId}"`,
    interactive_command: `node "${configureScript}"`,
    message:
      `Workspace ${status.workspace} is not registered yet. Configure its owner before using context-anchor in this workspace.`
  };
}

function buildConfigureBootstrapContent(guidance) {
  return [
    '# Context Anchor Setup Required',
    '',
    'This workspace is not registered in context-anchor ownership settings yet.',
    'Do not assume a user, project, or session owner until the workspace is configured.',
    '',
    `- Workspace: ${guidance.workspace}`,
    `- Suggested user: ${guidance.suggested_user_id}`,
    `- Suggested project: ${guidance.suggested_project_id}`,
    '',
    'Ask the user to run one of these commands:',
    `- Interactive: ${guidance.interactive_command}`,
    `- Direct add: ${guidance.configure_command}`
  ].join('\n');
}

function appendBootstrapFile(event, name, filePath, content) {
  if (!event?.context || !Array.isArray(event.context.bootstrapFiles) || !content.trim()) {
    return false;
  }

  event.context.bootstrapFiles.push({
    name,
    path: filePath,
    content,
    missing: false
  });
  return true;
}

function summarizeHeartbeatHookResult(result = {}) {
  return {
    status: result.status || 'heartbeat_ok',
    session_key: result.session_key || null,
    project_id: result.project_id || null,
    captured_summary: result.captured_summary || null,
    legacy_memory_sync: result.legacy_memory_sync
      ? {
          synced_entries: Number(result.legacy_memory_sync.synced_entries || 0),
          synced_files: Number(result.legacy_memory_sync.synced_files || 0),
          skipped_files: Number(result.legacy_memory_sync.skipped_files || 0)
        }
      : null,
    session_experiences: result.session_experiences
      ? {
          created: Number(result.session_experiences.created || 0),
          updated: Number(result.session_experiences.updated || 0),
          archived: Number(result.session_experiences.archived || 0)
        }
      : null,
    promotions: result.promotions
      ? {
          project_promotions: Number(result.promotions.project_promotions || 0),
          user_promotions: Number(result.promotions.user_promotions || 0)
        }
      : null,
    reconcile: result.reconcile
      ? {
          project_archived: Number(result.reconcile.project_archived || 0),
          user_archived: Number(result.reconcile.user_archived || 0),
          project_reactivated: Number(result.reconcile.project_reactivated || 0),
          user_reactivated: Number(result.reconcile.user_reactivated || 0)
        }
      : null,
    governance: result.governance
      ? {
          active_after: Number(result.governance.totals?.active_after || 0),
          archive_after: Number(result.governance.totals?.archive_after || 0),
          archived: Number(result.governance.totals?.archived || 0),
          pruned: Number(result.governance.totals?.pruned || 0)
        }
      : null,
    pressure: result.pressure
      ? {
          status: result.pressure.status || null,
          requires_compact: Boolean(result.pressure.requires_compact)
        }
      : null
  };
}

function summarizeCompactHookResult(result = {}) {
  return {
    status: result.status || 'handled',
    phase: result.phase || null,
    session_key: result.session_key || null,
    project_id: result.project_id || null,
    user_id: result.user_id || null,
    actions: Array.isArray(result.actions) ? result.actions : [],
    heartbeat: result.heartbeat ? summarizeHeartbeatHookResult(result.heartbeat) : null,
    legacy_memory_sync: result.legacy_memory_sync
      ? {
          synced_entries: Number(result.legacy_memory_sync.synced_entries || 0),
          synced_files: Number(result.legacy_memory_sync.synced_files || 0)
        }
      : null,
    session_experience_sync: result.session_experience_sync
      ? {
          created: Number(result.session_experience_sync.created || 0),
          updated: Number(result.session_experience_sync.updated || 0),
          archived: Number(result.session_experience_sync.archived || 0)
        }
      : null,
    skill_draft: result.skill_draft
      ? {
          status: result.skill_draft.status || null,
          skill_name: result.skill_draft.skill_name || null
        }
      : null,
    compact: result.compact
      ? {
          status: result.compact.status || null,
          compact_packet_file: result.compact.compact_packet_file || null
        }
      : null,
    bootstrap: result.bootstrap || null,
    task_state_summary: result.task_state_summary ? buildTaskStateSummary(result.task_state_summary) : null
  };
}

function resolveManagedEventKey(event = {}) {
  if (!event?.type || !event?.action) {
    return null;
  }

  return `${event.type}:${event.action}`;
}

function resolveWorkspaceFromManagedEvent(event = {}) {
  const context = event.context || {};
  const workspace =
    context.workspaceDir ||
    context.sessionEntry?.systemPromptReport?.workspaceDir ||
    context.previousSessionEntry?.systemPromptReport?.workspaceDir ||
    context.sessionEntry?.spawnedWorkspaceDir ||
    context.previousSessionEntry?.spawnedWorkspaceDir ||
    context.cfg?.agents?.defaults?.workspace ||
    null;

  return workspace ? path.resolve(workspace) : null;
}

function resolveManagedPayload(event = {}) {
  return normalizePayload({
    workspace: resolveWorkspaceFromManagedEvent(event),
    session_key: event.sessionKey || event.context?.sessionKey || null
  });
}

function handleStartup(payload) {
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, 'gateway:startup', ['workspace']);
  const guidance = buildConfigureGuidance('gateway:startup', normalizedPayload);
  if (guidance) {
    return guidance;
  }
  const paths = createPaths(normalizedPayload.workspace);
  const recentSessions = getRecentSessions(paths);

  if (recentSessions.length === 0) {
    return {
      status: 'idle',
      event: 'gateway:startup',
      actions: [],
      message: 'No recent session to restore.'
    };
  }

  const latest = recentSessions[0];
  const sessionState = loadSessionState(paths, latest.session_key, latest.project_id, {
    createIfMissing: false,
    touch: false
  });
  const runtimeState = readRuntimeStateSnapshot(paths, latest.session_key, latest.project_id, {
    userId: latest.user_id || sessionState?.user_id || null
  });
  const checkpoint = readText(sessionCheckpointFile(paths, latest.session_key), '');
  const pendingCommitments = Array.isArray(runtimeState?.pending_commitments)
    ? runtimeState.pending_commitments
    : (sessionState?.commitments || []).filter((entry) => entry.status === 'pending');
  const closedAt =
    Object.prototype.hasOwnProperty.call(runtimeState || {}, 'closed_at')
      ? runtimeState?.closed_at || null
      : sessionState?.closed_at || null;
  const activeTask =
    pendingCommitments.length > 0 || !closedAt
      ? runtimeState?.current_goal || runtimeState?.active_task || sessionState?.active_task || null
      : null;
  const taskStateSummary = buildTaskStateSummary({
    current_goal: runtimeState?.current_goal || activeTask,
    latest_verified_result: runtimeState?.latest_verified_result || null,
    next_step: runtimeState?.next_step || pendingCommitments[0]?.what || null,
    blocked_by: runtimeState?.blocked_by || null,
    last_user_visible_progress: runtimeState?.last_user_visible_progress || null
  });
  const resumeMessage = [
    '我回来了。',
    `上次会话: ${latest.session_key}`,
    taskStateSummary.current_goal ? `当前目标: ${taskStateSummary.current_goal}` : activeTask ? `当前任务: ${activeTask}` : null,
    taskStateSummary.latest_verified_result ? `最近结果: ${taskStateSummary.latest_verified_result}` : null,
    taskStateSummary.last_user_visible_progress ? `最近进展: ${taskStateSummary.last_user_visible_progress}` : null,
    taskStateSummary.next_step ? `下一步: ${taskStateSummary.next_step}` : null,
    taskStateSummary.blocked_by ? `当前阻塞: ${taskStateSummary.blocked_by}` : null,
    pendingCommitments.length > 0
      ? `待处理承诺: ${pendingCommitments.map((entry) => entry.what).join('；')}`
      : null,
    checkpoint ? `检查点: ${checkpoint.split('\n').slice(0, 6).join(' / ')}` : null
  ]
    .filter(Boolean)
    .join('\n');

  return {
    status: 'resume_available',
    event: 'gateway:startup',
    actions: ['resume_session'],
    session_key: latest.session_key,
    project_id: latest.project_id,
    resume_message: resumeMessage
  };
}

function handleStop(payload) {
  return handleStopWithReason(payload, 'command:stop', 'command-stop');
}

function handleStopWithReason(payload, eventName, closeReason, usagePercent) {
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, eventName, ['workspace', 'session_key']);
  const guidance = buildConfigureGuidance(eventName, normalizedPayload);
  if (guidance) {
    return guidance;
  }
  return {
    status: 'handled',
    event: eventName,
    actions: ['session_closed'],
    result: runSessionClose(normalizedPayload.workspace, normalizedPayload.session_key, {
      reason: closeReason,
      usagePercent: usagePercent !== undefined ? usagePercent : normalizedPayload.usage_percent,
      projectId: normalizedPayload.project_id,
      userId: normalizedPayload.user_id
    })
  };
}

function handleSessionRollover(event) {
  const normalizedPayload = resolveManagedPayload(event);
  requirePayloadFields(normalizedPayload, resolveManagedEventKey(event), ['workspace', 'session_key']);
  const guidance = buildConfigureGuidance(resolveManagedEventKey(event), normalizedPayload);
  if (guidance) {
    if (Array.isArray(event.messages)) {
      event.messages.push([guidance.message, guidance.configure_command].filter(Boolean).join('\n'));
    }
    return guidance;
  }

  return {
    status: 'handled',
    event: resolveManagedEventKey(event),
    actions: ['session_closed'],
    result: runSessionClose(normalizedPayload.workspace, normalizedPayload.session_key, {
      reason: `command-${event.action}`,
      projectId: normalizedPayload.project_id,
      userId: normalizedPayload.user_id
    })
  };
}

function handleManagedStop(event) {
  const workspace = resolveWorkspaceFromManagedEvent(event);
  if (!workspace) {
    return {
      status: 'ignored',
      event: 'command:stop',
      actions: [],
      message: 'Workspace could not be resolved from command:stop event context.'
    };
  }

  const normalizedPayload = resolveManagedPayload(event);
  const guidance = buildConfigureGuidance('command:stop', normalizedPayload);
  if (guidance) {
    return guidance;
  }

  return {
    status: 'handled',
    event: 'command:stop',
    actions: ['session_closed'],
    result: runSessionClose(workspace, normalizedPayload.session_key, {
      reason: 'command-stop',
      projectId: normalizedPayload.project_id,
      userId: normalizedPayload.user_id
    })
  };
}

function handleManagedBootstrap(event) {
  const normalizedPayload = resolveManagedPayload(event);
  requirePayloadFields(normalizedPayload, 'agent:bootstrap', ['workspace', 'session_key']);
  const guidance = buildConfigureGuidance('agent:bootstrap', normalizedPayload);
  const bootstrapCache = buildBootstrapCachePath(normalizedPayload.workspace, normalizedPayload.session_key);

  if (guidance) {
    appendBootstrapFile(
      event,
      'BOOTSTRAP.md',
      path.join(path.dirname(bootstrapCache), 'context-anchor-config-guidance.md'),
      buildConfigureBootstrapContent(guidance)
    );
    return guidance;
  }

  const paths = createPaths(normalizedPayload.workspace);
  const existingSessionState = loadSessionState(paths, normalizedPayload.session_key, normalizedPayload.project_id, {
    createIfMissing: false,
    touch: false
  });
  const openClawSessionId = typeof event.context?.sessionId === 'string' ? event.context.sessionId.trim() : null;
  const cachedSessionId = existingSessionState?.metadata?.openclaw_session_id || null;
  let bootstrapContent = readText(bootstrapCache, '').trim();
  const mustRefresh = !bootstrapContent || !existingSessionState || (openClawSessionId && cachedSessionId !== openClawSessionId);

  if (mustRefresh) {
    const summary = runSessionStart(normalizedPayload.workspace, normalizedPayload.session_key, normalizedPayload.project_id, {
      userId: normalizedPayload.user_id,
      openClawSessionId,
      reopenClosed: true
    });
    bootstrapContent = buildBootstrapCacheContent(summary);
    writeBootstrapCache(bootstrapCache, bootstrapContent);
  } else if (!bootstrapContent) {
    bootstrapContent = buildMinimalBootstrapContent(
      normalizedPayload.workspace,
      normalizedPayload.session_key,
      normalizedPayload
    );
    if (bootstrapContent) {
      writeBootstrapCache(bootstrapCache, bootstrapContent);
    }
  }

  appendBootstrapFile(event, 'CONTEXT-ANCHOR.md', bootstrapCache, bootstrapContent);
  return {
    status: 'handled',
    event: 'agent:bootstrap',
    actions: ['bootstrap_injected'],
    bootstrap_cache: bootstrapCache,
    refreshed: mustRefresh
  };
}

function handleManagedCompact(event) {
  const normalizedPayload = resolveManagedPayload(event);
  if (!normalizedPayload.workspace) {
    return {
      status: 'ignored',
      event: resolveManagedEventKey(event),
      actions: [],
      message: 'Workspace could not be resolved from compact event context.'
    };
  }

  const guidance = buildConfigureGuidance(resolveManagedEventKey(event), normalizedPayload);
  if (guidance) {
    return guidance;
  }

  const phase = event.action === 'compact:after' ? 'after' : 'before';
  return {
    status: 'handled',
    event: resolveManagedEventKey(event),
    actions: [`compact_${phase}`],
    result: summarizeCompactHookResult(runSessionCompact(normalizedPayload.workspace, normalizedPayload.session_key, {
      phase,
      projectId: normalizedPayload.project_id,
      userId: normalizedPayload.user_id,
      eventContext: event.context || {}
    }))
  };
}

function handleHeartbeat(payload) {
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, 'heartbeat', ['workspace', 'session_key']);
  const guidance = buildConfigureGuidance('heartbeat', normalizedPayload);
  if (guidance) {
    return guidance;
  }
  return {
    status: 'handled',
    event: 'heartbeat',
    actions: ['heartbeat'],
    result: summarizeHeartbeatHookResult(runHeartbeat(
      normalizedPayload.workspace,
      normalizedPayload.session_key,
      normalizedPayload.project_id,
      normalizedPayload.usage_percent,
      {
        userId: normalizedPayload.user_id
      }
    ))
  };
}

function handleHookEvent(eventName, payload = {}) {
  switch (eventName) {
    case 'gateway:startup':
      return handleStartup(payload);
    case 'command:stop':
      return handleStop(payload);
    case 'command:new':
      return handleStopWithReason(payload, 'command:new', 'command-new');
    case 'command:reset':
      return handleStopWithReason(payload, 'command:reset', 'command-reset');
    case 'heartbeat':
    case 'on_heartbeat':
      return handleHeartbeat(payload);
    default:
      return {
        status: 'ignored',
        event: eventName,
        actions: [],
        message: `Unsupported event: ${eventName}`
      };
  }
}

function handleManagedHookEvent(event = {}) {
  switch (resolveManagedEventKey(event)) {
    case 'agent:bootstrap':
      return handleManagedBootstrap(event);
    case 'command:new':
    case 'command:reset':
      return handleSessionRollover(event);
    case 'command:stop':
      return handleManagedStop(event);
    case 'session:compact:before':
    case 'session:compact:after':
      return handleManagedCompact(event);
    default:
      return {
        status: 'ignored',
        event: resolveManagedEventKey(event),
        actions: [],
        message: `Unsupported managed hook event: ${resolveManagedEventKey(event) || 'unknown'}`
      };
  }
}

function defaultHookHandler(arg1, arg2, arg3) {
  if (
    arg1 &&
    typeof arg1 === 'object' &&
    typeof arg1.type === 'string' &&
    typeof arg1.action === 'string' &&
    arg1.context &&
    typeof arg1.context === 'object'
  ) {
    return handleManagedHookEvent(arg1);
  }

  const invocation = resolveHookInvocation(arg1, arg2, arg3);
  if (!invocation.eventName) {
    return {
      status: 'error',
      event: null,
      actions: [],
      message: 'Hook invocation did not include an event name.'
    };
  }

  return handleHookEvent(invocation.eventName, invocation.payload);
}

function main() {
  try {
    const result = handleHookEvent(process.argv[2], parsePayload(process.argv[3]));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          status: 'error',
          message: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = defaultHookHandler;
module.exports.default = defaultHookHandler;
module.exports.defaultHookHandler = defaultHookHandler;
module.exports.handleHookEvent = handleHookEvent;
module.exports.handleManagedHookEvent = handleManagedHookEvent;
module.exports.parsePayload = parsePayload;
module.exports.resolveHookInvocation = resolveHookInvocation;
