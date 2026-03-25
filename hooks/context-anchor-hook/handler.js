#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  createPaths,
  getRecentSessions,
  loadSessionState,
  readText,
  sessionCheckpointFile
} = require('../../scripts/lib/context-anchor');
const { resolveOwnership } = require('../../scripts/lib/host-config');
const { runHeartbeat } = require('../../scripts/heartbeat');
const { runSessionClose } = require('../../scripts/session-close');

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

function handleStartup(payload) {
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, 'gateway:startup', ['workspace']);
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
  const checkpoint = readText(sessionCheckpointFile(paths, latest.session_key), '');
  const pendingCommitments = (sessionState?.commitments || []).filter(
    (entry) => entry.status === 'pending'
  );
  const resumeMessage = [
    '我回来了。',
    `上次会话: ${latest.session_key}`,
    sessionState?.active_task ? `当前任务: ${sessionState.active_task}` : null,
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
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, 'command:stop', ['workspace', 'session_key']);
  return {
    status: 'handled',
    event: 'command:stop',
    actions: ['session_closed'],
    result: runSessionClose(normalizedPayload.workspace, normalizedPayload.session_key, {
      reason: 'command-stop',
      usagePercent: normalizedPayload.usage_percent,
      projectId: normalizedPayload.project_id,
      userId: normalizedPayload.user_id
    })
  };
}

function handleSessionEnd(payload) {
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, 'session:end', ['workspace', 'session_key']);
  return {
    status: 'handled',
    event: 'session:end',
    actions: ['session_closed'],
    result: runSessionClose(normalizedPayload.workspace, normalizedPayload.session_key, {
      reason: 'session-end',
      usagePercent: normalizedPayload.usage_percent,
      projectId: normalizedPayload.project_id,
      userId: normalizedPayload.user_id
    })
  };
}

function handleHeartbeat(payload) {
  const normalizedPayload = normalizePayload(payload);
  requirePayloadFields(normalizedPayload, 'heartbeat', ['workspace', 'session_key']);
  return {
    status: 'handled',
    event: 'heartbeat',
    actions: ['heartbeat'],
    result: runHeartbeat(
      normalizedPayload.workspace,
      normalizedPayload.session_key,
      normalizedPayload.project_id,
      normalizedPayload.usage_percent,
      {
        userId: normalizedPayload.user_id
      }
    )
  };
}

function handleHookEvent(eventName, payload = {}) {
  switch (eventName) {
    case 'gateway:startup':
      return handleStartup(payload);
    case 'command:stop':
      return handleStop(payload);
    case 'session:end':
      return handleSessionEnd(payload);
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

module.exports = {
  handleHookEvent,
  parsePayload
};
