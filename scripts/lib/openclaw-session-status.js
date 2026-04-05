const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runDoctor } = require('../doctor');
const {
  createPaths,
  loadSessionSummary,
  readRuntimeStateSnapshot,
  sanitizeKey
} = require('./context-anchor');
const { summarizeCatalogDatabase } = require('./context-anchor-db');
const { buildRemediationSummary } = require('./remediation-summary');
const { buildTaskStateSummary } = require('./task-state');
const {
  classifyMemorySourceHealth,
  summarizeExternalMemorySources
} = require('../legacy-memory-sync');
const { collectSessionCandidates } = require('./openclaw-session-candidates');
const {
  findSession,
  getWorkspaceRegistrationStatus,
  readHostConfig
} = require('./host-config');

function normalizeWorkspaceKey(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function shorten(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 1) {
    return text.slice(0, maxLength);
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildNpmCommand(scriptName, options = {}) {
  const parts = [`npm run ${scriptName}`];
  const forwarded = [];

  if (options.workspace) {
    forwarded.push('--workspace', quoteCommandArg(options.workspace));
  }

  if (options.sessionKey) {
    forwarded.push('--session-key', quoteCommandArg(options.sessionKey));
  }

  if (options.projectId) {
    forwarded.push('--project-id', quoteCommandArg(options.projectId));
  }

  if (options.openclawHome) {
    forwarded.push('--openclaw-home', quoteCommandArg(options.openclawHome));
  }

  if (options.skillsRoot) {
    forwarded.push('--skills-root', quoteCommandArg(options.skillsRoot));
  }

  if (options.yes) {
    forwarded.push('--yes');
  }

  if (options.applyConfig) {
    forwarded.push('--apply-config');
  }

  if (options.enforceMemoryTakeover) {
    forwarded.push('--enforce-memory-takeover');
  }

  if (options.json) {
    forwarded.push('--json');
  }
  if (Array.isArray(options.extraArgs)) {
    options.extraArgs.filter(Boolean).forEach((arg) => {
      forwarded.push(arg);
    });
  }

  if (forwarded.length > 0) {
    parts.push('--', ...forwarded);
  }

  return parts.join(' ');
}

function normalizeScopeWorkspace(workspace) {
  return workspace ? path.resolve(workspace) : null;
}

function collectSessionIssues(classification = {}) {
  const issues = [];

  if (classification.skill === 'unknown') {
    issues.push('workspace_unresolved');
    return issues;
  }

  if (classification.skill !== 'ready') {
    issues.push('session_not_ready');
  }

  if (classification.hook !== 'on') {
    issues.push('hook_not_configured');
  }

  if (classification.monitor === 'off') {
    issues.push('monitor_not_configured');
  }

  if (classification.monitor === 'legacy') {
    issues.push('monitor_legacy_window');
  }

  return issues;
}

function collectMemorySourceIssues(memorySourceHealth = {}) {
  if (!memorySourceHealth || memorySourceHealth.status === 'unknown') {
    return [];
  }

  return Array.isArray(memorySourceHealth.drift_reasons) ? [...memorySourceHealth.drift_reasons] : [];
}

function describeIssue(issue) {
  switch (issue) {
    case 'workspace_unresolved':
      return 'workspace unresolved';
    case 'session_not_ready':
      return 'context-anchor session is not ready';
    case 'hook_not_configured':
      return 'hook is not configured or not enabled';
    case 'monitor_not_configured':
      return 'background monitor is not configured';
    case 'monitor_legacy_window':
      return 'background monitor uses a visible Windows launcher';
    case 'legacy_memory_never_synced':
      return 'external memory source has not been centralized yet';
    case 'legacy_memory_changed_since_sync':
      return 'external memory source changed after the last sync';
    default:
      return issue;
  }
}

function normalizeBenefitSummary(summary) {
  if (!summary || typeof summary !== 'object') {
    return null;
  }

  const summaryLines = Array.isArray(summary.summary_lines)
    ? summary.summary_lines.map((line) => String(line).trim()).filter(Boolean)
    : [];

  return {
    visible: Boolean(summary.visible),
    summary: summary.summary ? String(summary.summary).trim() : null,
    summary_lines: summaryLines
  };
}

function buildSessionVisibilityDetails(session) {
  if (!session.workspace) {
    return {
      task_state_summary: buildTaskStateSummary({}),
      last_benefit_summary: null
    };
  }

  const paths = createPaths(session.workspace);
  const runtimeState =
    readRuntimeStateSnapshot(paths, session.session_key, session.project_id || undefined, {
      userId: session.user_id || undefined
    }) || {};
  const sessionSummary = loadSessionSummary(paths, session.session_key);

  return {
    task_state_summary: buildTaskStateSummary(runtimeState),
    last_benefit_summary: normalizeBenefitSummary(sessionSummary?.benefit_summary)
  };
}

function selectVisibleSessionSummary(sessions, key) {
  return sessions.find((entry) => entry?.[key]?.visible) || null;
}

function formatTaskStateDisplay(summary) {
  if (!summary?.visible) {
    return null;
  }

  const parts = [];
  if (summary.current_goal) {
    parts.push(`goal=${summary.current_goal}`);
  }
  if (summary.latest_verified_result) {
    parts.push(`result=${summary.latest_verified_result}`);
  }
  if (summary.next_step) {
    parts.push(`next=${summary.next_step}`);
  }
  if (summary.blocked_by) {
    parts.push(`blocked_by=${summary.blocked_by}`);
  }
  if (parts.length === 0 && summary.last_user_visible_progress) {
    parts.push(`progress=${summary.last_user_visible_progress}`);
  }

  return parts.length > 0 ? parts.join(' ; ') : summary.summary;
}

function formatBenefitDisplay(summary) {
  if (!summary?.visible) {
    return null;
  }

  return summary.summary || (Array.isArray(summary.summary_lines) ? summary.summary_lines.join('; ') : null);
}

function renderVisibleSummaryLine(label, summaryText, sessionKey) {
  if (!summaryText) {
    return null;
  }

  const prefix = sessionKey ? `${shorten(sessionKey, 32)} -> ` : '';
  return `  ${label}: ${prefix}${shorten(summaryText, 180)}`;
}

function buildSessionRepairStrategy(type) {
  switch (type) {
    case 'configure_sessions_then_migrate_then_recheck':
      return {
        type,
        label: 'configure sessions -> migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair session linkage first, then centralize external memory, then rerun session status.'
      };
    case 'configure_sessions_then_recheck':
      return {
        type,
        label: 'configure sessions -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair session linkage first, then rerun session status.'
      };
    case 'configure_host_then_migrate_then_recheck':
      return {
        type,
        label: 'configure host -> migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair host configuration first, then centralize external memory, then rerun session status.'
      };
    case 'configure_host_then_recheck':
      return {
        type,
        label: 'configure host -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair host configuration first, then rerun session status.'
      };
    case 'migrate_then_enforce_then_recheck':
      return {
        type,
        label: 'migrate -> enforce -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Centralize external memory first, then enforce takeover, then rerun session status.'
      };
    case 'migrate_then_recheck':
      return {
        type,
        label: 'migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Centralize external memory first, then rerun session status.'
      };
    case 'enforce_then_recheck':
      return {
        type,
        label: 'enforce -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Enforce takeover first, then rerun session status.'
      };
    default:
      return {
        type: 'refresh_then_recheck',
        label: 'refresh -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Refresh session linkage, then rerun session status.'
      };
  }
}

function buildUnknownMemorySourceStatus(memoryTakeoverMode) {
  return {
    workspace: null,
    external_source_count: 0,
    changed_source_count: 0,
    never_synced_source_count: 0,
    unsynced_source_count: 0,
    last_legacy_sync_at: null,
    sync_status: 'workspace_unresolved',
    sources: [],
    health: {
      status: 'unknown',
      level: 'notice',
      memory_takeover_mode: memoryTakeoverMode === 'enforced' ? 'enforced' : 'best_effort',
      drift_detected: false,
      drift_reasons: [],
      summary: 'Workspace is unresolved, so external memory drift cannot be inspected.'
    }
  };
}

function buildGroupScope(group, options = {}) {
  const firstResolvedSession = group.sessions.find((entry) => entry.workspace);
  return {
    workspace: normalizeScopeWorkspace(group.workspace || firstResolvedSession?.workspace),
    sessionKey: !group.workspace && group.sessions.length > 0 ? group.sessions[0].session_key : null,
    projectId: options.projectId || firstResolvedSession?.project_id || null
  };
}

function buildWorkspaceMirrorSummary(workspace) {
  if (!workspace) {
    return {
      available: false,
      db_file: null,
      collections: 0,
      documents: 0,
      indexed_items: 0,
      indexed_sessions: 0,
      session_states: 0,
      session_summaries: 0,
      compact_packets: 0,
      projects: 0,
      content_blobs: 0,
      content_blob_bytes: 0,
      content_blob_stored_bytes: 0
    };
  }

  const paths = createPaths(workspace);
  return summarizeCatalogDatabase(path.join(paths.anchorDir, 'catalog.sqlite'));
}

function buildActionCommands(scope, options = {}) {
  const issues = Array.isArray(options.issues) ? options.issues : [];
  const commandScope = {
    workspace: scope.workspace || null,
    sessionKey: scope.sessionKey || null,
    projectId: scope.projectId || null,
    openclawHome: options.openclawHome || null,
    skillsRoot: options.skillsRoot || null
  };
  const diagnostic_command = buildNpmCommand('diagnose:sessions', {
    ...commandScope
  });
  const recheck_command = buildNpmCommand('status:sessions', {
    ...commandScope
  });

  let repair_command;
  let follow_up_command = null;
  const needsMemorySync =
    issues.includes('legacy_memory_never_synced') ||
    issues.includes('legacy_memory_changed_since_sync');
  const needsSessionRepair =
    issues.includes('workspace_unresolved') ||
    issues.includes('session_not_ready');
  const needsHostRepair =
    issues.includes('hook_not_configured') ||
    issues.includes('monitor_not_configured') ||
    issues.includes('monitor_legacy_window') ||
    options.globalConfigurationReady === false;
  const needsTakeoverEnforcement =
    options.memoryTakeoverMode !== 'enforced' &&
    !needsSessionRepair &&
    !needsHostRepair &&
    (needsMemorySync || options.memorySourceStatus === 'best_effort');

  if (needsSessionRepair) {
    repair_command = buildNpmCommand('configure:sessions', {
      ...commandScope,
      yes: Boolean(options.forceYes)
    });
    if (needsMemorySync && scope.workspace) {
      follow_up_command = buildNpmCommand('migrate:memory', {
        workspace: scope.workspace,
        projectId: scope.projectId || null
      });
    }
  } else if (needsHostRepair) {
    const extraArgs = ['--apply-config'];
    if (scope.workspace && (issues.includes('monitor_not_configured') || issues.includes('monitor_legacy_window'))) {
      extraArgs.push('--enable-scheduler');
    }
    repair_command = buildNpmCommand('configure:host', {
      workspace: scope.workspace || null,
        openclawHome: options.openclawHome || null,
        skillsRoot: options.skillsRoot || null,
        yes: true,
        extraArgs
      });
    if (needsMemorySync && scope.workspace) {
      follow_up_command = buildNpmCommand('migrate:memory', {
        workspace: scope.workspace,
        projectId: scope.projectId || null
      });
    }
  } else if (needsMemorySync && scope.workspace) {
    repair_command = buildNpmCommand('migrate:memory', {
      workspace: scope.workspace,
      projectId: scope.projectId || null
    });
    if (needsTakeoverEnforcement) {
      follow_up_command = buildNpmCommand('configure:host', {
        workspace: scope.workspace || null,
        openclawHome: options.openclawHome || null,
        skillsRoot: options.skillsRoot || null,
        applyConfig: true,
        enforceMemoryTakeover: true,
        yes: true
      });
    }
  } else if (needsTakeoverEnforcement && scope.workspace) {
    repair_command = buildNpmCommand('configure:host', {
      workspace: scope.workspace || null,
      openclawHome: options.openclawHome || null,
      skillsRoot: options.skillsRoot || null,
      applyConfig: true,
      enforceMemoryTakeover: true,
      yes: true
    });
  } else {
    repair_command = buildNpmCommand('configure:sessions', {
      ...commandScope,
      yes: Boolean(options.forceYes)
    });
  }

  const repair_sequence = [
    repair_command ? { step: 'repair', command: repair_command } : null,
    follow_up_command ? { step: 'follow_up', command: follow_up_command } : null,
    recheck_command ? { step: 'recheck', command: recheck_command } : null
  ].filter(Boolean);
  const repair_strategy = buildSessionRepairStrategy(
    needsSessionRepair && needsMemorySync
      ? 'configure_sessions_then_migrate_then_recheck'
      : needsSessionRepair
      ? 'configure_sessions_then_recheck'
      : needsHostRepair && needsMemorySync
      ? 'configure_host_then_migrate_then_recheck'
      : needsHostRepair
      ? 'configure_host_then_recheck'
      : needsMemorySync && needsTakeoverEnforcement
      ? 'migrate_then_enforce_then_recheck'
      : needsMemorySync
      ? 'migrate_then_recheck'
      : needsTakeoverEnforcement
      ? 'enforce_then_recheck'
      : 'refresh_then_recheck'
  );

  return {
    diagnostic_command,
    repair_command,
    follow_up_command,
    recheck_command,
    repair_sequence,
    repair_strategy
  };
}

function buildSchedulerDescriptor(openClawHome, workspace, currentPlatform = process.platform) {
  const workspacePath = path.resolve(workspace);
  const launcherId = crypto.createHash('sha1').update(workspacePath).digest('hex').slice(0, 8);
  const baseName = `${path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'workspace'}-${launcherId}`;
  const automationRoot = path.join(openClawHome, 'automation', 'context-anchor');
  const launchersDir = path.join(automationRoot, 'launchers');
  const schedulerRoot = path.join(automationRoot, 'schedulers');
  const windows = {
    launcher_path: path.join(launchersDir, `${baseName}.vbs`),
    legacy_launcher_path: path.join(launchersDir, `${baseName}.cmd`),
    task_name: `OpenClaw Context Anchor ${baseName}`
  };
  const macos = {
    launcher_path: path.join(launchersDir, `${baseName}.sh`),
    label: `com.openclaw.context-anchor.${baseName}`,
    plist_file: path.join(schedulerRoot, 'macos', `com.openclaw.context-anchor.${baseName}.plist`),
    install_file: path.join(os.homedir(), 'Library', 'LaunchAgents', `com.openclaw.context-anchor.${baseName}.plist`)
  };
  const linux = {
    launcher_path: path.join(launchersDir, `${baseName}.sh`),
    service_name: `openclaw-context-anchor-${baseName}.service`,
    timer_name: `openclaw-context-anchor-${baseName}.timer`,
    service_file: path.join(schedulerRoot, 'linux', `openclaw-context-anchor-${baseName}.service`),
    timer_file: path.join(schedulerRoot, 'linux', `openclaw-context-anchor-${baseName}.timer`),
    install_service_file: path.join(os.homedir(), '.config', 'systemd', 'user', `openclaw-context-anchor-${baseName}.service`),
    install_timer_file: path.join(os.homedir(), '.config', 'systemd', 'user', `openclaw-context-anchor-${baseName}.timer`)
  };

  return {
    workspace: workspacePath,
    launcher_id: baseName,
    target_platform: currentPlatform === 'win32' ? 'windows' : currentPlatform === 'darwin' ? 'macos' : 'linux',
    automation_root: automationRoot,
    launchers_dir: launchersDir,
    scheduler_root: schedulerRoot,
    windows,
    macos,
    linux
  };
}

function probeWindowsScheduler(taskName, execImpl = execFileSync) {
  const escapedTaskName = String(taskName).replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'; try { (Get-ScheduledTask -TaskName '${escapedTaskName}' -ErrorAction Stop).State } catch { 'Missing' }`;

  try {
    const output = execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8'
    }).trim();
    return output || 'Missing';
  } catch {
    return 'Missing';
  }
}

function probeLaunchctlRuntime(label, execImpl = execFileSync) {
  try {
    const output = execImpl('launchctl', ['print', `gui/${process.getuid()}/${label}`], {
      encoding: 'utf8'
    }).trim();
    return output ? 'running' : 'ready';
  } catch {
    return 'missing';
  }
}

function probeSystemdRuntime(unitName, execImpl = execFileSync) {
  try {
    const output = execImpl('systemctl', ['--user', 'is-active', unitName], {
      encoding: 'utf8'
    }).trim();
    return output || 'inactive';
  } catch {
    return 'inactive';
  }
}

function detectSchedulerStatus(openClawHome, workspace, currentPlatform = process.platform, options = {}) {
  const descriptor = buildSchedulerDescriptor(openClawHome, workspace, currentPlatform);
  const execImpl = options.execFileSync || execFileSync;
  const schedulerRootExists = fs.existsSync(descriptor.scheduler_root);

  if (currentPlatform === 'win32') {
    const launcherExists = fs.existsSync(descriptor.windows.launcher_path);
    const legacyLauncherExists = fs.existsSync(descriptor.windows.legacy_launcher_path);
    if (!launcherExists && !legacyLauncherExists) {
      return {
        status: 'off',
        runtime: 'missing',
        configured: false,
        descriptor
      };
    }

    if (!launcherExists && legacyLauncherExists) {
      return {
        status: 'legacy',
        runtime: 'visible_console',
        configured: true,
        descriptor
      };
    }

    const probe = typeof options.schedulerProbe === 'function'
      ? options.schedulerProbe(descriptor, { platform: 'windows' })
      : probeWindowsScheduler(descriptor.windows.task_name, execImpl);

    const normalized = String(probe || '').toLowerCase();
    if (normalized === 'running') {
      return {
        status: 'running',
        runtime: 'running',
        configured: true,
        descriptor
      };
    }

    if (normalized === 'ready' || normalized === 'queued') {
      return {
        status: 'ready',
        runtime: normalized,
        configured: true,
        descriptor
      };
    }

    if (normalized === 'disabled') {
      return {
        status: 'off',
        runtime: 'disabled',
        configured: true,
        descriptor
      };
    }

    if (legacyLauncherExists && normalized !== 'running') {
      return {
        status: 'legacy',
        runtime: normalized || 'visible_console',
        configured: true,
        descriptor
      };
    }

    return {
      status: 'ready',
      runtime: normalized || 'unknown',
      configured: true,
      descriptor
    };
  }

  if (currentPlatform === 'darwin') {
    if (!fs.existsSync(descriptor.macos.launcher_path) && !fs.existsSync(descriptor.macos.plist_file) && !fs.existsSync(descriptor.macos.install_file)) {
      return {
        status: 'off',
        runtime: 'missing',
        configured: false,
        descriptor
      };
    }

    const probe = typeof options.schedulerProbe === 'function'
      ? options.schedulerProbe(descriptor, { platform: 'macos' })
      : probeLaunchctlRuntime(descriptor.macos.label, execImpl);

    const normalized = String(probe || '').toLowerCase();
    if (normalized === 'running' || normalized === 'loaded') {
      return {
        status: 'running',
        runtime: normalized,
        configured: true,
        descriptor
      };
    }

    return {
      status: 'ready',
      runtime: normalized || 'unknown',
      configured: true,
      descriptor
    };
  }

  if (!fs.existsSync(descriptor.linux.launcher_path) && !fs.existsSync(descriptor.linux.service_file) && !fs.existsSync(descriptor.linux.timer_file) && !fs.existsSync(descriptor.linux.install_service_file) && !fs.existsSync(descriptor.linux.install_timer_file)) {
    return {
      status: 'off',
      runtime: 'missing',
      configured: false,
      descriptor
    };
  }

  const probe = typeof options.schedulerProbe === 'function'
    ? options.schedulerProbe(descriptor, { platform: 'linux' })
    : probeSystemdRuntime(descriptor.linux.timer_name, execImpl);

  const normalized = String(probe || '').toLowerCase();
  if (normalized === 'active' || normalized === 'running') {
    return {
      status: 'running',
      runtime: normalized,
      configured: true,
      descriptor
    };
  }

  return {
    status: 'ready',
    runtime: normalized || (schedulerRootExists ? 'configured' : 'unknown'),
    configured: true,
    descriptor
  };
}

function classifySessionStatus(session, openClawHome, hostConfig, doctor, options = {}) {
  if (!session.workspace) {
    return {
      skill: 'unknown',
      skill_reason: 'workspace_unresolved',
      hook: 'unknown',
      monitor: 'unknown',
      monitor_runtime: 'unknown',
      overall: 'needs_attention',
      issues: ['workspace_unresolved'],
      workspace_status: null
    };
  }

  const workspace = path.resolve(session.workspace);
  const paths = createPaths(workspace);
  const sessionKey = sanitizeKey(session.session_key);
  const sessionStateFile = path.join(paths.sessionsDir, sessionKey, 'state.json');
  const sessionStateExists = fs.existsSync(sessionStateFile);
  const hostSession = findSession(hostConfig, workspace, session.session_key);
  const workspaceStatus = getWorkspaceRegistrationStatus(openClawHome, workspace, {
    userId: session.user_id || hostConfig.defaults.user_id,
    projectId: session.project_id || null
  });
  const skillReady = sessionStateExists && Boolean(hostSession) && workspaceStatus.configured;
  const skillPartial = Boolean(sessionStateExists || hostSession || workspaceStatus.configured);
  const skill = skillReady ? 'ready' : skillPartial ? 'partial' : 'missing';
  const hook = doctor.configuration.ready && workspaceStatus.configured ? 'on' : 'off';
  const scheduler = detectSchedulerStatus(openClawHome, workspace, process.platform, {
    schedulerProbe: options.schedulerProbe,
    execFileSync: options.execFileSync
  });
  const issues = collectSessionIssues({
    skill,
    hook,
    monitor: scheduler.status,
    workspaceConfigured: workspaceStatus.configured,
    sessionStateExists,
    hostSessionExists: Boolean(hostSession)
  });

  const overall = issues.length === 0 ? 'ready' : 'needs_attention';

  return {
    skill,
    skill_reason: skillReady
      ? 'session_state_and_host_registration_present'
      : skillPartial
        ? 'partially_configured'
        : 'not_configured',
    hook,
    monitor: scheduler.status,
    monitor_runtime: scheduler.runtime,
    overall,
    issues,
    workspace_status: workspaceStatus,
    session_state_file: sessionStateExists ? sessionStateFile : null
  };
}

function groupSessionsByWorkspace(sessions) {
  const groups = new Map();

  for (const session of sessions) {
    const key = session.workspace ? normalizeWorkspaceKey(session.workspace) : '__unresolved__';
    if (!groups.has(key)) {
      groups.set(key, {
        workspace: session.workspace ? path.resolve(session.workspace) : null,
        sessions: []
      });
    }

    groups.get(key).sessions.push(session);
  }

  return [...groups.values()].sort((left, right) => {
    const leftLabel = left.workspace || 'zzz-unresolved';
    const rightLabel = right.workspace || 'zzz-unresolved';
    return leftLabel.localeCompare(rightLabel);
  });
}

function buildOpenClawSessionStatusReport(openClawHomeArg, skillsRootArg, options = {}) {
  const openClawHome = openClawHomeArg ? path.resolve(openClawHomeArg) : options.openclawHome ? path.resolve(options.openclawHome) : null;
  const resolvedOpenClawHome = openClawHome || path.join(process.env.HOME || os.homedir(), '.openclaw');
  const skillsRoot = path.resolve(
    skillsRootArg ||
      options.skillsRoot ||
      process.env.CONTEXT_ANCHOR_SKILLS_ROOT ||
      path.join(resolvedOpenClawHome, 'skills')
  );
  const scope = {
    workspace: normalizeScopeWorkspace(options.workspace || null),
    sessionKey: options.sessionKey ? sanitizeKey(options.sessionKey) : null
  };
  const doctor = runDoctor({ openclawHome: resolvedOpenClawHome, skillsRoot });
  const hostConfig = readHostConfig(resolvedOpenClawHome);
  const collected = collectSessionCandidates(resolvedOpenClawHome, {
    includeSubagents: Boolean(options.includeSubagents)
  });
  const sessions = collected.candidates
    .filter((session) => {
      if (scope.workspace && normalizeScopeWorkspace(session.workspace) !== scope.workspace) {
        return false;
      }

      if (scope.sessionKey && sanitizeKey(session.session_key) !== scope.sessionKey) {
        return false;
      }

      return true;
    })
    .map((session) => ({
      ...session,
      classification: classifySessionStatus(session, resolvedOpenClawHome, hostConfig, doctor, {
        schedulerProbe: options.schedulerProbe,
        execFileSync: options.execFileSync
      }),
      ...buildSessionVisibilityDetails(session)
    }));
  const groups = groupSessionsByWorkspace(sessions).map((group) => {
    const workspace = group.workspace;
    const workspaceStatus = workspace
      ? getWorkspaceRegistrationStatus(resolvedOpenClawHome, workspace, {
          userId: hostConfig.defaults.user_id
        })
      : null;
    const memorySources = workspace
      ? summarizeExternalMemorySources(workspace)
      : buildUnknownMemorySourceStatus(doctor.configuration.memory_takeover_mode);
    const memorySourceHealth = workspace
      ? classifyMemorySourceHealth(memorySources, {
          memoryTakeoverMode: doctor.configuration.memory_takeover_mode
        })
      : memorySources.health;
    const issues = [
      ...new Set([
        ...group.sessions.flatMap((session) => session.classification.issues || []),
        ...collectMemorySourceIssues(memorySourceHealth)
      ])
    ];
    const commandScope = buildGroupScope(group, {
      projectId:
        workspaceStatus?.workspaceEntry?.project_id ||
        workspaceStatus?.suggestedProjectId ||
        group.sessions[0]?.project_id ||
        null
    });
    const commands = buildActionCommands(commandScope, {
      openclawHome: resolvedOpenClawHome,
      skillsRoot,
      forceYes: Boolean(commandScope.workspace),
      issues,
      globalConfigurationReady: doctor.configuration.ready,
      memoryTakeoverMode: doctor.configuration.memory_takeover_mode,
      memorySourceStatus: memorySourceHealth.status
    });
    const sortedSessions = [...group.sessions].sort((left, right) => {
      return Number(right.updated_at || 0) - Number(left.updated_at || 0);
    });
    const hookStatus = workspace
      ? sortedSessions[0]?.classification?.hook || 'off'
      : 'unknown';
    const monitorStatus = workspace
      ? sortedSessions[0]?.classification?.monitor || 'unknown'
      : 'unknown';
    const ready = sortedSessions.filter((entry) => entry.classification?.overall === 'ready').length;
    const attention = sortedSessions.length - ready;
    const primaryTaskStateSession = selectVisibleSessionSummary(sortedSessions, 'task_state_summary');
    const primaryBenefitSession = selectVisibleSessionSummary(sortedSessions, 'last_benefit_summary');

    return {
      workspace,
      scope: commandScope,
      hook_status: hookStatus,
      monitor_status: monitorStatus,
      mirror: buildWorkspaceMirrorSummary(workspace),
      memory_sources: {
        ...memorySources,
        health: memorySourceHealth
      },
      workspace_status: workspaceStatus,
      session_count: group.sessions.length,
      ready_count: ready,
      attention_count: attention,
      needs_attention: issues.length > 0,
      issues,
      diagnostic_command: commands.diagnostic_command,
      repair_command: commands.repair_command,
      follow_up_command: commands.follow_up_command,
      recheck_command: commands.recheck_command,
      repair_sequence: commands.repair_sequence,
      repair_strategy: commands.repair_strategy,
      remediation_summary: buildRemediationSummary([
        {
          source: 'session_status',
          action: {
            ...commands,
            command: commands.repair_command,
            follow_up_command: commands.follow_up_command,
            recheck_command: commands.recheck_command
          }
        }
      ]),
      task_state_summary: primaryTaskStateSession?.task_state_summary || buildTaskStateSummary({}),
      task_state_session_key: primaryTaskStateSession?.session_key || null,
      last_benefit_summary: primaryBenefitSession?.last_benefit_summary || null,
      last_benefit_session_key: primaryBenefitSession?.session_key || null,
      sessions: sortedSessions
    };
  });

  const globalCommands = buildActionCommands(scope, {
    openclawHome: resolvedOpenClawHome,
    skillsRoot,
    forceYes: true,
    issues: doctor.configuration.ready ? [] : ['hook_not_configured'],
    globalConfigurationReady: doctor.configuration.ready
  });
  const summary = {
    total_sessions: sessions.length,
    excluded_subagent_sessions: collected.excluded_subagent_sessions.length,
    workspaces: groups.length,
    skill_ready_sessions: sessions.filter((entry) => entry.classification.skill === 'ready').length,
    ready_sessions: sessions.filter((entry) => entry.classification.overall === 'ready').length,
    attention_sessions: sessions.filter((entry) => entry.classification.overall !== 'ready').length,
    unresolved_sessions: sessions.filter((entry) => entry.workspace === null).length,
    hook_on_workspaces: groups.filter((entry) => entry.hook_status === 'on').length,
    monitor_running_workspaces: groups.filter((entry) => entry.monitor_status === 'running').length,
    task_visible_workspaces: groups.filter((entry) => entry.task_state_summary?.visible).length,
    benefit_visible_workspaces: groups.filter((entry) => entry.last_benefit_summary?.visible).length,
    single_source_workspaces: groups.filter((entry) => entry.memory_sources.health.status === 'single_source').length,
    best_effort_workspaces: groups.filter((entry) => entry.memory_sources.health.status === 'best_effort').length,
    drift_workspaces: groups.filter((entry) => entry.memory_sources.health.status === 'drift_detected').length
  };

  return {
    status: summary.attention_sessions > 0 || summary.drift_workspaces > 0 ? 'warning' : 'ok',
    openclaw_home: resolvedOpenClawHome,
    skills_root: skillsRoot,
    scope,
    global: {
      installation: doctor.installation,
      configuration: doctor.configuration,
      ownership: doctor.ownership
    },
    summary,
    commands: globalCommands,
    remediation_summary: buildRemediationSummary([
      {
        source: 'session_status_global',
        action: {
          ...globalCommands,
          command: globalCommands.repair_command,
          follow_up_command: globalCommands.follow_up_command,
          recheck_command: globalCommands.recheck_command
        }
      }
    ]),
    groups,
    sessions
  };
}

function formatField(label, value, width) {
  return `${String(label).padEnd(width, ' ')} ${value}`;
}

function renderSessionRows(sessions) {
  const header = [
    '  ' + 'SESSION KEY'.padEnd(36, ' '),
    'SESSION ID'.padEnd(38, ' '),
    'SKILL'.padEnd(12, ' '),
    'STATE'.padEnd(16, ' ')
  ].join('  ');
  const lines = [header, `  ${'-'.repeat(36)}  ${'-'.repeat(38)}  ${'-'.repeat(12)}  ${'-'.repeat(16)}`];

  for (const session of sessions) {
    lines.push(
      [
        '  ' + shorten(session.session_key, 36).padEnd(36, ' '),
        shorten(session.session_id || '-', 38).padEnd(38, ' '),
        session.classification.skill.toUpperCase().padEnd(12, ' '),
        session.classification.overall.toUpperCase().padEnd(16, ' ')
      ].join('  ')
    );
  }

  return lines;
}

function renderCommandSummary(report) {
  const lines = [];
  lines.push(`Diagnostic command: ${report.commands.diagnostic_command}`);
  lines.push(`Repair command: ${report.commands.repair_command}`);
  lines.push(`Recheck command: ${report.commands.recheck_command}`);
  const strategyLine = renderRepairStrategy(report.commands.repair_strategy);
  if (strategyLine) {
    lines.push(strategyLine);
  }
  const nextStepLine = renderRemediationNextStep(report.remediation_summary);
  if (nextStepLine) {
    lines.push(nextStepLine);
  }
  if (report.summary.drift_workspaces > 0) {
    lines.push(`Memory drift detected in ${report.summary.drift_workspaces} workspace(s); prefer the per-workspace repair command shown below.`);
  }
  if (report.summary.attention_sessions > 0) {
    lines.push(`Warning: ${report.summary.attention_sessions} session(s) need attention. Run the diagnostic command first, then the repair command.`);
  } else if (report.summary.drift_workspaces > 0) {
    lines.push('Session linkage looks healthy, but external memory drift still needs attention.');
  } else {
    lines.push('All discovered sessions are healthy.');
  }
  return lines;
}

function renderRepairSequence(sequence = []) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    return null;
  }

  return sequence
    .map((entry, index) => `${index + 1}) ${entry.step}: ${entry.command}`)
    .join(' | ');
}

function renderRepairStrategy(strategy) {
  if (!strategy?.label) {
    return null;
  }

  const mode = strategy.execution_mode === 'manual' ? 'manual' : 'auto';
  const subtype =
    strategy.execution_mode === 'manual'
      ? strategy.manual_subtype === 'external_environment'
        ? strategy.external_issue_type === 'workspace_path_unresolved'
          ? 'external-env/workspace-path'
          : strategy.external_issue_type === 'workspace_registration_missing'
          ? 'external-env/workspace-registration'
          : 'external-env'
        : 'confirm'
      : null;
  const modeLabel = subtype ? `${mode}/${subtype}` : mode;
  return `Strategy: [${modeLabel}] ${strategy.label}${strategy.summary ? ` (${strategy.summary})` : ''}`;
}

function renderRemediationNextStep(remediationSummary) {
  const nextStep = remediationSummary?.next_step;
  if (!nextStep?.label) {
    return null;
  }

  const mode = nextStep.execution_mode === 'manual' ? 'manual' : 'auto';
  const subtype =
    nextStep.execution_mode === 'manual'
      ? nextStep.manual_subtype === 'external_environment'
        ? nextStep.external_issue_type === 'workspace_path_unresolved'
          ? 'external-env/workspace-path'
          : nextStep.external_issue_type === 'workspace_registration_missing'
          ? 'external-env/workspace-registration'
          : 'external-env'
        : 'confirm'
      : null;
  const modeLabel = subtype ? `${mode}/${subtype}` : mode;
  return `Next step: [${modeLabel}] ${nextStep.label}${nextStep.summary ? ` (${nextStep.summary})` : ''}`;
}

function renderOpenClawSessionStatusReport(report) {
  const lines = [];
  lines.push('Context-Anchor Session Overview');
  lines.push(`OpenClaw home: ${report.openclaw_home}`);
  lines.push(
    `Global install: ${report.global.installation.ready ? 'READY' : 'NOT READY'} | ` +
      `Hooks: ${report.global.configuration.ready ? 'ON' : 'OFF'} | ` +
      `Sessions: ${report.summary.total_sessions} | ` +
      `Workspaces: ${report.summary.workspaces}`
  );
  lines.push(
    `Skill ready sessions: ${report.summary.skill_ready_sessions} | ` +
      `Overall ready sessions: ${report.summary.ready_sessions} | ` +
      `Needs attention: ${report.summary.attention_sessions} | ` +
      `Unresolved: ${report.summary.unresolved_sessions}`
  );
  lines.push(
    `Visible continuity: ${report.summary.task_visible_workspaces} workspace(s) | ` +
      `Visible benefit: ${report.summary.benefit_visible_workspaces} workspace(s)`
  );
  if (report.summary.excluded_subagent_sessions > 0) {
    lines.push(`Excluded subagent sessions: ${report.summary.excluded_subagent_sessions}`);
  }
  lines.push(
    `Memory sources: SINGLE_SOURCE ${report.summary.single_source_workspaces} | ` +
      `BEST_EFFORT ${report.summary.best_effort_workspaces} | ` +
      `DRIFT ${report.summary.drift_workspaces}`
  );
  lines.push(...renderCommandSummary(report));
  lines.push('');

  for (const group of report.groups) {
    lines.push(`Workspace: ${group.workspace || 'unresolved'}`);
    lines.push(
      `  Hook: ${group.hook_status.toUpperCase()} | ` +
        `Monitor: ${group.monitor_status.toUpperCase()} | ` +
        `Sessions: ${group.session_count} | ` +
        `Ready: ${group.ready_count} | ` +
        `Attention: ${group.attention_count}`
    );
    lines.push(
      `  Mirror: ${group.mirror.available ? 'ON' : 'OFF'} | ` +
        `Collections: ${group.mirror.collections} | ` +
        `Docs: ${group.mirror.documents} | ` +
        `Indexed sessions: ${group.mirror.indexed_sessions}`
    );
    lines.push(
      `  Memory: ${group.memory_sources.health.status.toUpperCase()} | ` +
        `External: ${group.memory_sources.external_source_count} | ` +
        `Unsynced: ${group.memory_sources.unsynced_source_count} | ` +
        `Last sync: ${group.memory_sources.last_legacy_sync_at || '-'}`
    );
    const taskStateLine = renderVisibleSummaryLine(
      'Task continuity',
      formatTaskStateDisplay(group.task_state_summary),
      group.task_state_session_key
    );
    if (taskStateLine) {
      lines.push(taskStateLine);
    }
    const benefitLine = renderVisibleSummaryLine(
      'Last benefit',
      formatBenefitDisplay(group.last_benefit_summary),
      group.last_benefit_session_key
    );
    if (benefitLine) {
      lines.push(benefitLine);
    }
    if (group.issues.length > 0) {
      lines.push(`  Issues: ${group.issues.map(describeIssue).join(', ')}`);
      lines.push(`  Diagnose: ${group.diagnostic_command}`);
      lines.push(`  Repair: ${group.repair_command}`);
      if (group.follow_up_command) {
        lines.push(`  Follow-up: ${group.follow_up_command}`);
      }
      lines.push(`  Recheck: ${group.recheck_command}`);
      const strategyLine = renderRepairStrategy(group.repair_strategy);
      if (strategyLine) {
        lines.push(`  ${strategyLine}`);
      }
      const nextStepLine = renderRemediationNextStep(group.remediation_summary);
      if (nextStepLine) {
        lines.push(`  ${nextStepLine}`);
      }
      const repairPath = renderRepairSequence(group.repair_sequence);
      if (repairPath) {
        lines.push(`  Repair path: ${repairPath}`);
      }
    }

    const rows = renderSessionRows(group.sessions);
    lines.push(...rows);
    lines.push('');
  }

  lines.push('Legend: READY = linked session state and host registration; PARTIAL = only one side is present; ON = hook is enabled; RUNNING = monitor task is active; DRIFT = external memory files changed after the last central sync.');

  return lines.join('\n');
}

function renderOpenClawSessionDiagnosisReport(report) {
  const lines = [];
  lines.push('Context-Anchor Session Diagnosis');
  lines.push(`OpenClaw home: ${report.openclaw_home}`);
  lines.push(...renderCommandSummary(report));
  lines.push('');

  const problemGroups = report.groups.filter((group) => group.issues.length > 0);
  if (problemGroups.length === 0) {
    lines.push('No session anomalies detected.');
    lines.push('');
    for (const group of report.groups) {
      lines.push(`Workspace: ${group.workspace || 'unresolved'}`);
      lines.push(
        `  Mirror: ${group.mirror.available ? 'ON' : 'OFF'} | ` +
          `Collections: ${group.mirror.collections} | ` +
          `Docs: ${group.mirror.documents} | ` +
          `Indexed sessions: ${group.mirror.indexed_sessions}`
      );
      lines.push(
        `  Memory: ${group.memory_sources.health.status.toUpperCase()} | ` +
          `External: ${group.memory_sources.external_source_count} | ` +
          `Unsynced: ${group.memory_sources.unsynced_source_count} | ` +
          `Last sync: ${group.memory_sources.last_legacy_sync_at || '-'}`
      );
      const taskStateLine = renderVisibleSummaryLine(
        'Task continuity',
        formatTaskStateDisplay(group.task_state_summary),
        group.task_state_session_key
      );
      if (taskStateLine) {
        lines.push(taskStateLine);
      }
      const benefitLine = renderVisibleSummaryLine(
        'Last benefit',
        formatBenefitDisplay(group.last_benefit_summary),
        group.last_benefit_session_key
      );
      if (benefitLine) {
        lines.push(benefitLine);
      }
      lines.push(`  Diagnose: ${group.diagnostic_command}`);
      lines.push(`  Repair: ${group.repair_command}`);
      if (group.follow_up_command) {
        lines.push(`  Follow-up: ${group.follow_up_command}`);
      }
      lines.push(`  Recheck: ${group.recheck_command}`);
      const strategyLine = renderRepairStrategy(group.repair_strategy);
      if (strategyLine) {
        lines.push(`  ${strategyLine}`);
      }
      const nextStepLine = renderRemediationNextStep(group.remediation_summary);
      if (nextStepLine) {
        lines.push(`  ${nextStepLine}`);
      }
      const repairPath = renderRepairSequence(group.repair_sequence);
      if (repairPath) {
        lines.push(`  Repair path: ${repairPath}`);
      }
      lines.push(...renderSessionRows(group.sessions));
      lines.push('');
    }
    return lines.join('\n');
  }

  for (const group of problemGroups) {
    lines.push(`Workspace: ${group.workspace || 'unresolved'}`);
    lines.push(
      `  Mirror: ${group.mirror.available ? 'ON' : 'OFF'} | ` +
        `Collections: ${group.mirror.collections} | ` +
        `Docs: ${group.mirror.documents} | ` +
        `Indexed sessions: ${group.mirror.indexed_sessions}`
    );
    lines.push(
      `  Memory: ${group.memory_sources.health.status.toUpperCase()} | ` +
        `External: ${group.memory_sources.external_source_count} | ` +
        `Unsynced: ${group.memory_sources.unsynced_source_count} | ` +
        `Last sync: ${group.memory_sources.last_legacy_sync_at || '-'}`
    );
    const taskStateLine = renderVisibleSummaryLine(
      'Task continuity',
      formatTaskStateDisplay(group.task_state_summary),
      group.task_state_session_key
    );
    if (taskStateLine) {
      lines.push(taskStateLine);
    }
    const benefitLine = renderVisibleSummaryLine(
      'Last benefit',
      formatBenefitDisplay(group.last_benefit_summary),
      group.last_benefit_session_key
    );
    if (benefitLine) {
      lines.push(benefitLine);
    }
    lines.push(`  Issues: ${group.issues.map(describeIssue).join(', ')}`);
    lines.push(`  Diagnose: ${group.diagnostic_command}`);
    lines.push(`  Repair: ${group.repair_command}`);
    if (group.follow_up_command) {
      lines.push(`  Follow-up: ${group.follow_up_command}`);
    }
    lines.push(`  Recheck: ${group.recheck_command}`);
    const strategyLine = renderRepairStrategy(group.repair_strategy);
    if (strategyLine) {
      lines.push(`  ${strategyLine}`);
    }
    const nextStepLine = renderRemediationNextStep(group.remediation_summary);
    if (nextStepLine) {
      lines.push(`  ${nextStepLine}`);
    }
    const repairPath = renderRepairSequence(group.repair_sequence);
    if (repairPath) {
      lines.push(`  Repair path: ${repairPath}`);
    }
    lines.push(...renderSessionRows(group.sessions));
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  buildActionCommands,
  buildOpenClawSessionStatusReport,
  buildSchedulerDescriptor,
  classifySessionStatus,
  detectSchedulerStatus,
  formatField,
  groupSessionsByWorkspace,
  normalizeWorkspaceKey,
  probeLaunchctlRuntime,
  probeSystemdRuntime,
  probeWindowsScheduler,
  quoteCommandArg,
  renderOpenClawSessionStatusReport,
  renderOpenClawSessionDiagnosisReport,
  renderSessionRows,
  shorten
};
