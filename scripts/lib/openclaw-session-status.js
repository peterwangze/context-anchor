const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runDoctor } = require('../doctor');
const {
  createPaths,
  loadSessionState,
  loadSessionSummary,
  readRuntimeStateSnapshot,
  sanitizeKey
} = require('./context-anchor');
const { summarizeCatalogDatabase } = require('./context-anchor-db');
const { buildRemediationSummary } = require('./remediation-summary');
const { assessTaskStateHealth, buildTaskStateFields, buildTaskStateSummary } = require('./task-state');
const { buildTaskStateRepairProfile } = require('./task-state-remediation');
const {
  command,
  field,
  section,
  status
} = require('./terminal-format');
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

function buildHeartbeatCommand(workspace, sessionKey, projectId, usagePercent = 50) {
  const args = [
    'node',
    quoteCommandArg(path.join(__dirname, '..', 'heartbeat.js')),
    quoteCommandArg(workspace),
    quoteCommandArg(sessionKey || DEFAULTS.sessionKey),
    quoteCommandArg(projectId || DEFAULTS.projectId),
    quoteCommandArg(usagePercent)
  ];
  return args.join(' ');
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

  if (classification.task_state_health?.status === 'missing') {
    issues.push('task_state_missing');
  } else if (classification.task_state_health?.status === 'partial') {
    issues.push('task_state_incomplete');
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
    case 'task_state_missing':
      return 'task continuity is not visible yet';
    case 'task_state_incomplete':
      return 'task continuity is still incomplete';
    case 'task_state_missing_goal':
      return 'task continuity is missing current goal';
    case 'task_state_missing_next_step':
      return 'task continuity is missing next step';
    case 'task_state_missing_goal_and_next_step':
      return 'task continuity is missing current goal and next step';
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
  const sessionState = loadSessionState(paths, session.session_key, session.project_id || undefined, {
    createIfMissing: false,
    touch: false
  }) || {};
  const sessionSummary = loadSessionSummary(paths, session.session_key);
  const taskStateSummary = buildTaskStateSummary({
    ...runtimeState,
    ...buildTaskStateFields(sessionState, runtimeState)
  });

  return {
    task_state_summary: taskStateSummary,
    task_state_health: assessTaskStateHealth(taskStateSummary),
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
  return field(label, `${prefix}${shorten(summaryText, 180)}`, {
    indent: 2,
    kind: label === 'Last benefit' ? 'success' : 'info'
  });
}

function renderTaskContinuityHealth(summary) {
  if (!summary?.status) {
    return null;
  }

  const kind = summary.status === 'ready' || summary.status === 'complete' ? 'success' : 'warning';
  return `${status(String(summary.status).toUpperCase(), kind)} | ${summary.summary}`;
}

function summarizeStatusKind(value) {
  switch (String(value || '').toLowerCase()) {
    case 'ready':
    case 'running':
    case 'on':
    case 'single_source':
    case 'ok':
      return 'success';
    case 'partial':
    case 'missing':
    case 'off':
    case 'warning':
    case 'drift_detected':
    case 'best_effort':
      return 'warning';
    case 'unresolved':
    case 'unknown':
      return 'muted';
    default:
      return 'info';
  }
}

function formatHealthDisplay(statusValue) {
  switch (String(statusValue || '').toLowerCase()) {
    case 'single_source':
      return 'SINGLE SOURCE';
    case 'best_effort':
      return 'BEST EFFORT';
    case 'drift_detected':
      return 'DRIFT DETECTED';
    case 'workspace_missing':
      return 'WORKSPACE MISSING';
    case 'workspace_unresolved':
      return 'WORKSPACE UNRESOLVED';
    default:
      return String(statusValue || 'unknown')
        .replace(/_/g, ' ')
        .toUpperCase();
  }
}

function formatMonitorDisplay(statusValue, runtimeValue) {
  const normalized = String(statusValue || '').toLowerCase();
  if (normalized === 'running') {
    return 'RUNNING';
  }
  if (normalized === 'ready') {
    return runtimeValue ? `CONFIGURED (${String(runtimeValue).toUpperCase()})` : 'CONFIGURED';
  }
  if (normalized === 'legacy') {
    return 'LEGACY';
  }
  if (normalized === 'off') {
    return 'OFF';
  }
  if (normalized === 'unknown') {
    return 'UNKNOWN';
  }
  return String(statusValue || 'unknown').toUpperCase();
}

function buildSessionRepairStrategy(type) {
  switch (type) {
    case 'repair_task_goal_then_recheck': {
      const profile = buildTaskStateRepairProfile(['task_state_missing_goal'], {
        recheckTarget: 'session status'
      });
      return {
        type,
        label: profile.strategy_label,
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: profile.strategy_summary,
        resolution_hint: profile.resolution_hint
      };
    }
    case 'repair_task_next_step_then_recheck': {
      const profile = buildTaskStateRepairProfile(['task_state_missing_next_step'], {
        recheckTarget: 'session status'
      });
      return {
        type,
        label: profile.strategy_label,
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: profile.strategy_summary,
        resolution_hint: profile.resolution_hint
      };
    }
    case 'repair_task_goal_and_next_step_then_recheck': {
      const profile = buildTaskStateRepairProfile(['task_state_missing_goal_and_next_step'], {
        recheckTarget: 'session status'
      });
      return {
        type,
        label: profile.strategy_label,
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: profile.strategy_summary,
        resolution_hint: profile.resolution_hint
      };
    }
    case 'repair_task_state_then_recheck': {
      const profile = buildTaskStateRepairProfile(['task_state_incomplete'], {
        recheckTarget: 'session status'
      });
      return {
        type,
        label: profile.strategy_label,
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: profile.strategy_summary,
        resolution_hint: profile.resolution_hint
      };
    }
    case 'configure_sessions_then_migrate_then_recheck':
      return {
        type,
        label: 'configure sessions -> migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair session linkage first, then centralize external memory, then rerun session status.',
        resolution_hint: 'This workspace needs both session linkage repair and external memory centralization before status should be trusted again.'
      };
    case 'configure_sessions_then_recheck':
      return {
        type,
        label: 'configure sessions -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair session linkage first, then rerun session status.',
        resolution_hint: 'Repair the session linkage under the correct workspace, then rerun status to confirm the session is ready.'
      };
    case 'configure_host_then_migrate_then_recheck':
      return {
        type,
        label: 'configure host -> migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair host configuration first, then centralize external memory, then rerun session status.',
        resolution_hint: 'Fix host integration first so later memory centralization lands on the right canonical path.'
      };
    case 'configure_host_then_recheck':
      return {
        type,
        label: 'configure host -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair host configuration first, then rerun session status.',
        resolution_hint: 'Repair the host-level hook or monitor setup first, then rerun status to confirm the workspace is healthy.'
      };
    case 'migrate_then_enforce_then_recheck':
      return {
        type,
        label: 'migrate -> enforce -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Centralize external memory first, then enforce takeover, then rerun session status.',
        resolution_hint: 'External memory has diverged and takeover is still not enforced; centralize first, then lock takeover down to prevent future drift.'
      };
    case 'migrate_then_recheck':
      return {
        type,
        label: 'migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Centralize external memory first, then rerun session status.',
        resolution_hint: 'External memory changed after the last sync; centralize it before trusting the current continuity state.'
      };
    case 'enforce_then_recheck':
      return {
        type,
        label: 'enforce -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Enforce takeover first, then rerun session status.',
        resolution_hint: 'Takeover is still best-effort; enforce it now so later sessions stop bypassing context-anchor.'
      };
    default:
      return {
        type: 'refresh_then_recheck',
        label: 'refresh -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Refresh session linkage, then rerun session status.',
        resolution_hint: 'Refresh the current session linkage and rerun status to confirm the latest state.'
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
    projectId: options.projectId || firstResolvedSession?.project_id || null,
    userId: options.userId || firstResolvedSession?.user_id || null
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
  const needsTaskStateRepair =
    !needsSessionRepair &&
    (
      issues.includes('task_state_missing') ||
      issues.includes('task_state_incomplete') ||
      issues.includes('task_state_missing_goal') ||
      issues.includes('task_state_missing_next_step') ||
      issues.includes('task_state_missing_goal_and_next_step')
    );
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
  const taskStateRepairProfile = needsTaskStateRepair
    ? buildTaskStateRepairProfile(issues, {
        recheckTarget: 'session status'
      })
    : null;

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
  } else if (needsTaskStateRepair) {
    repair_command = buildNpmCommand('configure:sessions', {
      ...commandScope,
      yes: Boolean(options.forceYes)
    });
    if (
      scope.workspace &&
      scope.sessionKey &&
      scope.projectId &&
      taskStateRepairProfile?.needs_follow_up_heartbeat
    ) {
      follow_up_command = buildHeartbeatCommand(scope.workspace, scope.sessionKey, scope.projectId, 50);
    }
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
      : needsTaskStateRepair
      ? issues.includes('task_state_missing_goal_and_next_step')
        ? 'repair_task_goal_and_next_step_then_recheck'
        : issues.includes('task_state_missing_next_step')
        ? 'repair_task_next_step_then_recheck'
        : issues.includes('task_state_missing_goal')
        ? 'repair_task_goal_then_recheck'
        : 'repair_task_state_then_recheck'
      : 'refresh_then_recheck'
  );
  if (taskStateRepairProfile) {
    repair_strategy.label = taskStateRepairProfile.strategy_label;
    repair_strategy.summary = taskStateRepairProfile.strategy_summary;
    repair_strategy.resolution_hint = taskStateRepairProfile.resolution_hint;
  }
  repair_strategy.command_examples = [repair_command, follow_up_command, recheck_command].filter(Boolean);

  return {
    diagnostic_command,
    repair_command,
    follow_up_command,
    recheck_command,
    repair_sequence,
    repair_strategy,
    resolution_hint: taskStateRepairProfile?.resolution_hint || repair_strategy.resolution_hint || null,
    command_examples: [repair_command, follow_up_command, recheck_command].filter(Boolean)
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
  const visibility = buildSessionVisibilityDetails(session);
  const issues = collectSessionIssues({
    skill,
    hook,
    monitor: scheduler.status,
    task_state_health: visibility.task_state_health,
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
    task_state_health: visibility.task_state_health,
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
  const hostConfig = readHostConfig(resolvedOpenClawHome);
  const scope = {
    workspace: normalizeScopeWorkspace(options.workspace || null),
    sessionKey: options.sessionKey ? sanitizeKey(options.sessionKey) : null,
    userId: hostConfig?.defaults?.user_id || null
  };
  const doctor = runDoctor({ openclawHome: resolvedOpenClawHome, skillsRoot });
  const collected = collectSessionCandidates(resolvedOpenClawHome, {
    includeSubagents: Boolean(options.includeSubagents),
    includeHiddenSessions: Boolean(options.includeHiddenSessions)
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
        null,
      userId:
        workspaceStatus?.workspaceEntry?.user_id ||
        group.sessions[0]?.user_id ||
        hostConfig.defaults.user_id ||
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
      remediation_summary: buildRemediationSummary(
        [
          {
            source: 'session_status',
            action: {
              ...commands,
              issues,
              command: commands.repair_command,
              follow_up_command: commands.follow_up_command,
              recheck_command: commands.recheck_command,
              resume_context: {
                workspace: commandScope.workspace,
                sessionKey: commandScope.sessionKey,
                projectId: commandScope.projectId,
                userId: commandScope.userId,
                openclawHome: resolvedOpenClawHome,
                skillsRoot,
                candidateSessionKeys: sortedSessions.map((entry) => entry.session_key).filter(Boolean),
                candidateWorkspaces: [commandScope.workspace].filter(Boolean),
                candidateProjectIds: sortedSessions.map((entry) => entry.project_id).filter(Boolean)
              }
            }
          }
        ],
        {
          auto_fix_options: {
            workspace: commandScope.workspace,
            userId: commandScope.userId
          }
        }
      ),
      task_state_summary: primaryTaskStateSession?.task_state_summary || buildTaskStateSummary({}),
      task_state_health: primaryTaskStateSession?.task_state_health || assessTaskStateHealth(buildTaskStateSummary({})),
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
    excluded_hidden_sessions: collected.excluded_hidden_sessions.length,
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
    remediation_summary: buildRemediationSummary(
      [
        {
          source: 'session_status_global',
          action: {
            ...globalCommands,
            issues: doctor.configuration.ready ? [] : ['hook_not_configured'],
            command: globalCommands.repair_command,
            follow_up_command: globalCommands.follow_up_command,
            recheck_command: globalCommands.recheck_command,
            resume_context: {
              workspace: scope.workspace,
              sessionKey: scope.sessionKey,
              userId: scope.userId,
              openclawHome: resolvedOpenClawHome,
              skillsRoot,
              candidateSessionKeys: sessions.map((entry) => entry.session_key).filter(Boolean),
              candidateWorkspaces: groups.map((entry) => entry.workspace).filter(Boolean)
            }
          }
        }
      ],
      {
        auto_fix_options: {
          workspace: scope.workspace,
          userId: scope.userId
        }
      }
    ),
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
  lines.push(field('Diagnostic command', command(report.commands.diagnostic_command), { kind: 'command' }));
  lines.push(field('Repair command', command(report.commands.repair_command), { kind: 'command' }));
  lines.push(field('Recheck command', command(report.commands.recheck_command), { kind: 'command' }));
  const strategyLine = renderRepairStrategy(report.commands.repair_strategy);
  if (strategyLine) {
    lines.push(field('Strategy', strategyLine.replace(/^Strategy:\s*/, ''), { kind: 'info' }));
  }
  const nextStepLine = renderRemediationNextStep(report.remediation_summary);
  if (nextStepLine) {
    lines.push(field('Next step', nextStepLine.replace(/^Next step:\s*/, ''), { kind: 'info' }));
  }
  if (report.remediation_summary?.next_step?.affected_targets_summary) {
    lines.push(field('Affected targets', report.remediation_summary.next_step.affected_targets_summary, { kind: 'muted' }));
  }
  const autoFixPath = renderAutoFixPath(report.remediation_summary);
  if (autoFixPath) {
    lines.push(field('Auto fix path', autoFixPath, { kind: 'command' }));
  }
  if (report.remediation_summary?.next_step?.auto_fix_command) {
    lines.push(field('Auto fix command', command(report.remediation_summary.next_step.auto_fix_command), { kind: 'command' }));
  } else if (report.remediation_summary?.next_step?.auto_fix_blocked_reason) {
    lines.push(field('Auto fix unavailable', report.remediation_summary.next_step.auto_fix_blocked_reason, { kind: 'warning' }));
    if (report.remediation_summary?.next_step?.auto_fix_resume_hint) {
      lines.push(field('Auto fix resume', report.remediation_summary.next_step.auto_fix_resume_hint, { kind: 'muted' }));
    }
    if (report.remediation_summary?.next_step?.auto_fix_resume_command) {
      lines.push(field('Resume command', command(report.remediation_summary.next_step.auto_fix_resume_command), { kind: 'command' }));
    }
    if (report.remediation_summary?.next_step?.auto_fix_resume_suggested_command) {
      lines.push(field('Suggested resume', command(report.remediation_summary.next_step.auto_fix_resume_suggested_command), { kind: 'command' }));
    }
    if (report.remediation_summary?.next_step?.auto_fix_resume_validation_summary) {
      lines.push(field(
        'Resume checks',
        report.remediation_summary.next_step.auto_fix_resume_validation_summary,
        {
          kind:
            report.remediation_summary.next_step.auto_fix_resume_validation_status === 'ready'
              ? 'success'
              : 'warning'
        }
      ));
    }
    if (report.remediation_summary?.next_step?.auto_fix_resume_suggested_validation_summary) {
      lines.push(field(
        'Suggested checks',
        report.remediation_summary.next_step.auto_fix_resume_suggested_validation_summary,
        {
          kind:
            report.remediation_summary.next_step.auto_fix_resume_suggested_validation_status === 'ready'
              ? 'success'
              : 'warning'
        }
      ));
    }
    if (Array.isArray(report.remediation_summary?.next_step?.auto_fix_resume_missing_inputs) && report.remediation_summary.next_step.auto_fix_resume_missing_inputs.length > 0) {
      lines.push(field('Resume inputs', report.remediation_summary.next_step.auto_fix_resume_missing_inputs.join(', '), { kind: 'warning' }));
    }
    if (Array.isArray(report.remediation_summary?.next_step?.auto_fix_resume_input_details) && report.remediation_summary.next_step.auto_fix_resume_input_details.length > 0) {
      report.remediation_summary.next_step.auto_fix_resume_input_details.forEach((entry) => {
        lines.push(field(`Input ${entry.label}`, `${entry.description}${entry.validation_summary ? ` | check=${entry.validation_summary}` : ''}${entry.example ? ` | example=${entry.example}` : ''}`, { kind: 'muted' }));
        if (Array.isArray(entry.candidates) && entry.candidates.length > 0) {
          lines.push(field(`Input ${entry.label} options`, entry.candidates.join(' | '), { kind: 'muted' }));
        }
      });
    }
  }
  if (report.summary.drift_workspaces > 0) {
    lines.push(field('Attention', `Memory drift detected in ${report.summary.drift_workspaces} workspace(s); prefer the per-workspace repair command shown below.`, { kind: 'warning' }));
  }
  if (report.summary.attention_sessions > 0) {
    lines.push(field('Warning', `${report.summary.attention_sessions} session(s) need attention. Run the diagnostic command first, then the repair command.`, { kind: 'warning' }));
  } else if (report.summary.drift_workspaces > 0) {
    lines.push(field('Status', 'Session linkage looks healthy, but external memory drift still needs attention.', { kind: 'warning' }));
  } else {
    lines.push(field('Status', 'All discovered sessions are healthy.', { kind: 'success' }));
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

function renderRemediationGuidance(remediationSummary) {
  const nextStep = remediationSummary?.next_step;
  if (!nextStep) {
    return [];
  }

  const lines = [];
  if (nextStep.resolution_hint) {
    lines.push(`Guidance: ${nextStep.resolution_hint}`);
  }
  if (Array.isArray(nextStep.command_examples) && nextStep.command_examples.length > 0) {
    lines.push(`Example command: ${nextStep.command_examples[0]}`);
  }
  return lines;
}

function renderAutoFixPath(remediationSummary) {
  const nextStep = remediationSummary?.next_step;
  if (
    !nextStep ||
    nextStep.execution_mode === 'manual' ||
    !Array.isArray(nextStep.command_sequence) ||
    nextStep.command_sequence.length === 0
  ) {
    return null;
  }

  return nextStep.command_sequence
    .map((entry, index) => `${index + 1}) ${entry.step}: ${entry.command}`)
    .join(' | ');
}

function renderOpenClawSessionStatusReport(report) {
  const lines = [];
  lines.push(section('Context-Anchor Session Overview'));
  lines.push(field('OpenClaw home', report.openclaw_home, { kind: 'muted' }));
  lines.push(
    field(
      'Global',
      `Install ${status(report.global.installation.ready ? 'READY' : 'NOT READY', report.global.installation.ready ? 'success' : 'warning')} | ` +
        `Hooks ${status(report.global.configuration.ready ? 'ON' : 'OFF', report.global.configuration.ready ? 'success' : 'warning')} | ` +
        `Sessions ${report.summary.total_sessions} | Workspaces ${report.summary.workspaces}`,
      { kind: report.global.installation.ready && report.global.configuration.ready ? 'success' : 'warning' }
    )
  );
  lines.push(
    field(
      'Coverage',
      `Skill ready sessions ${report.summary.skill_ready_sessions} | Overall ready sessions ${report.summary.ready_sessions} | Needs attention ${report.summary.attention_sessions} | Unresolved ${report.summary.unresolved_sessions}`,
      { kind: report.summary.attention_sessions > 0 ? 'warning' : 'success' }
    )
  );
  lines.push(
    field(
      'Visible continuity',
      `${report.summary.task_visible_workspaces} workspace(s) | Visible benefit ${report.summary.benefit_visible_workspaces} workspace(s)`,
      { kind: 'info' }
    )
  );
  if (report.summary.excluded_subagent_sessions > 0) {
    lines.push(field('Excluded subagent sessions', report.summary.excluded_subagent_sessions, { kind: 'muted' }));
  }
  if (report.summary.excluded_hidden_sessions > 0) {
    lines.push(field('Excluded hidden sessions', report.summary.excluded_hidden_sessions, { kind: 'muted' }));
  }
  lines.push(
    field(
      'Memory sources',
      `${status('SINGLE SOURCE', 'success')} ${report.summary.single_source_workspaces} | ` +
        `${status('BEST EFFORT', 'warning')} ${report.summary.best_effort_workspaces} | ` +
        `${status('DRIFT', 'warning')} ${report.summary.drift_workspaces}`,
      { kind: report.summary.drift_workspaces > 0 ? 'warning' : 'info' }
    )
  );
  lines.push(...renderCommandSummary(report));
  lines.push('');

  for (const group of report.groups) {
    lines.push(section(`Workspace: ${group.workspace || 'unresolved'}`, {
      kind: group.needs_attention ? 'warning' : 'success'
    }));
    lines.push(
      field(
        'Runtime',
        `Hook ${status(group.hook_status.toUpperCase(), summarizeStatusKind(group.hook_status))} | ` +
          `Monitor ${status(formatMonitorDisplay(group.monitor_status, group.sessions[0]?.classification?.monitor_runtime), summarizeStatusKind(group.monitor_status))} | ` +
          `Sessions ${group.session_count} | Ready ${group.ready_count} | Attention ${group.attention_count}`,
        { indent: 2, kind: group.attention_count > 0 ? 'warning' : 'success' }
      )
    );
    lines.push(
      field(
        'Mirror',
        `${group.mirror.available ? status('ON', 'success') : status('OFF', 'warning')} | ` +
          `Collections ${group.mirror.collections} | Docs ${group.mirror.documents} | Indexed sessions ${group.mirror.indexed_sessions}`,
        { indent: 2, kind: group.mirror.available ? 'success' : 'warning' }
      )
    );
    lines.push(
      field(
        'Memory',
        `${status(formatHealthDisplay(group.memory_sources.health.status), summarizeStatusKind(group.memory_sources.health.status))} | ` +
          `External ${group.memory_sources.external_source_count} | Unsynced ${group.memory_sources.unsynced_source_count} | Last sync ${group.memory_sources.last_legacy_sync_at || '-'}`,
        { indent: 2, kind: summarizeStatusKind(group.memory_sources.health.status) }
      )
    );
    const taskStateLine = renderVisibleSummaryLine(
      'Task continuity',
      formatTaskStateDisplay(group.task_state_summary),
      group.task_state_session_key
    );
    if (taskStateLine) {
      lines.push(taskStateLine);
    }
    const taskHealthLine = renderTaskContinuityHealth(group.task_state_health);
    if (taskHealthLine) {
      lines.push(field('Task continuity health', taskHealthLine, { indent: 2, kind: ['ready', 'complete'].includes(group.task_state_health?.status) ? 'success' : 'warning' }));
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
      lines.push(field('Issues', group.issues.map(describeIssue).join(', '), { indent: 2, kind: 'warning' }));
      lines.push(field('Diagnose', command(group.diagnostic_command), { indent: 2, kind: 'command' }));
      lines.push(field('Repair', command(group.repair_command), { indent: 2, kind: 'command' }));
      if (group.follow_up_command) {
        lines.push(field('Follow-up', command(group.follow_up_command), { indent: 2, kind: 'command' }));
      }
      lines.push(field('Recheck', command(group.recheck_command), { indent: 2, kind: 'command' }));
      const strategyLine = renderRepairStrategy(group.repair_strategy);
      if (strategyLine) {
        lines.push(field('Strategy', strategyLine.replace(/^Strategy:\s*/, ''), { indent: 2, kind: 'info' }));
      }
      const nextStepLine = renderRemediationNextStep(group.remediation_summary);
      if (nextStepLine) {
        lines.push(field('Next step', nextStepLine.replace(/^Next step:\s*/, ''), { indent: 2, kind: 'info' }));
      }
      if (group.remediation_summary?.next_step?.affected_targets_summary) {
        lines.push(field('Affected targets', group.remediation_summary.next_step.affected_targets_summary, { indent: 2, kind: 'muted' }));
      }
      const autoFixPath = renderAutoFixPath(group.remediation_summary);
      if (autoFixPath) {
        lines.push(field('Auto fix path', autoFixPath, { indent: 2, kind: 'command' }));
      }
      if (group.remediation_summary?.next_step?.auto_fix_command) {
        lines.push(field('Auto fix command', command(group.remediation_summary.next_step.auto_fix_command), { indent: 2, kind: 'command' }));
      } else if (group.remediation_summary?.next_step?.auto_fix_blocked_reason) {
        lines.push(field('Auto fix unavailable', group.remediation_summary.next_step.auto_fix_blocked_reason, { indent: 2, kind: 'warning' }));
        if (group.remediation_summary?.next_step?.auto_fix_resume_hint) {
          lines.push(field('Auto fix resume', group.remediation_summary.next_step.auto_fix_resume_hint, { indent: 2, kind: 'muted' }));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_command) {
          lines.push(field('Resume command', command(group.remediation_summary.next_step.auto_fix_resume_command), { indent: 2, kind: 'command' }));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_suggested_command) {
          lines.push(field('Suggested resume', command(group.remediation_summary.next_step.auto_fix_resume_suggested_command), { indent: 2, kind: 'command' }));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_validation_summary) {
          lines.push(field(
            'Resume checks',
            group.remediation_summary.next_step.auto_fix_resume_validation_summary,
            {
              indent: 2,
              kind:
                group.remediation_summary.next_step.auto_fix_resume_validation_status === 'ready'
                  ? 'success'
                  : 'warning'
            }
          ));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_suggested_validation_summary) {
          lines.push(field(
            'Suggested checks',
            group.remediation_summary.next_step.auto_fix_resume_suggested_validation_summary,
            {
              indent: 2,
              kind:
                group.remediation_summary.next_step.auto_fix_resume_suggested_validation_status === 'ready'
                  ? 'success'
                  : 'warning'
            }
          ));
        }
        if (Array.isArray(group.remediation_summary?.next_step?.auto_fix_resume_missing_inputs) && group.remediation_summary.next_step.auto_fix_resume_missing_inputs.length > 0) {
          lines.push(field('Resume inputs', group.remediation_summary.next_step.auto_fix_resume_missing_inputs.join(', '), { indent: 2, kind: 'warning' }));
        }
        if (Array.isArray(group.remediation_summary?.next_step?.auto_fix_resume_input_details) && group.remediation_summary.next_step.auto_fix_resume_input_details.length > 0) {
          group.remediation_summary.next_step.auto_fix_resume_input_details.forEach((entry) => {
            lines.push(field(`Input ${entry.label}`, `${entry.description}${entry.validation_summary ? ` | check=${entry.validation_summary}` : ''}${entry.example ? ` | example=${entry.example}` : ''}`, { indent: 2, kind: 'muted' }));
            if (Array.isArray(entry.candidates) && entry.candidates.length > 0) {
              lines.push(field(`Input ${entry.label} options`, entry.candidates.join(' | '), { indent: 2, kind: 'muted' }));
            }
          });
        }
      }
      renderRemediationGuidance(group.remediation_summary).forEach((line) => {
        const [label, ...rest] = line.split(': ');
        lines.push(field(label, rest.join(': '), { indent: 2, kind: label === 'Example command' ? 'command' : 'muted' }));
      });
      const repairPath = renderRepairSequence(group.repair_sequence);
      if (repairPath) {
        lines.push(field('Repair path', repairPath, { indent: 2, kind: 'muted' }));
      }
    }

    const rows = renderSessionRows(group.sessions);
    lines.push(...rows);
    lines.push('');
  }

  lines.push(field('Legend', 'READY = active task continuity is fully restorable; COMPLETE = previous task is finished and kept as reference-only continuity; PARTIAL = only part of the active task state is visible; ON = hook is enabled; RUNNING = monitor task is active; CONFIGURED = monitor assets exist but the scheduler is idle/queued; DRIFT = external memory files changed after the last central sync.', { kind: 'muted' }));

  return lines.join('\n');
}

function renderOpenClawSessionDiagnosisReport(report) {
  const lines = [];
  lines.push(section('Context-Anchor Session Diagnosis'));
  lines.push(field('OpenClaw home', report.openclaw_home, { kind: 'muted' }));
  lines.push(...renderCommandSummary(report));
  lines.push('');

  const problemGroups = report.groups.filter((group) => group.issues.length > 0);
  if (problemGroups.length === 0) {
    lines.push(field('Status', 'No session anomalies detected.', { kind: 'success' }));
    lines.push('');
    for (const group of report.groups) {
      lines.push(section(`Workspace: ${group.workspace || 'unresolved'}`, { kind: 'success' }));
      lines.push(field('Mirror', `${group.mirror.available ? status('ON', 'success') : status('OFF', 'warning')} | Collections ${group.mirror.collections} | Docs ${group.mirror.documents} | Indexed sessions ${group.mirror.indexed_sessions}`, { indent: 2, kind: group.mirror.available ? 'success' : 'warning' }));
      lines.push(field('Memory', `${status(formatHealthDisplay(group.memory_sources.health.status), summarizeStatusKind(group.memory_sources.health.status))} | External ${group.memory_sources.external_source_count} | Unsynced ${group.memory_sources.unsynced_source_count} | Last sync ${group.memory_sources.last_legacy_sync_at || '-'}`, { indent: 2, kind: summarizeStatusKind(group.memory_sources.health.status) }));
      const taskStateLine = renderVisibleSummaryLine(
        'Task continuity',
        formatTaskStateDisplay(group.task_state_summary),
        group.task_state_session_key
      );
      if (taskStateLine) {
        lines.push(taskStateLine);
      }
      const taskHealthLine = renderTaskContinuityHealth(group.task_state_health);
      if (taskHealthLine) {
        lines.push(field('Task continuity health', taskHealthLine, { indent: 2, kind: ['ready', 'complete'].includes(group.task_state_health?.status) ? 'success' : 'warning' }));
      }
      const benefitLine = renderVisibleSummaryLine(
        'Last benefit',
        formatBenefitDisplay(group.last_benefit_summary),
        group.last_benefit_session_key
      );
      if (benefitLine) {
        lines.push(benefitLine);
      }
      lines.push(field('Diagnose', command(group.diagnostic_command), { indent: 2, kind: 'command' }));
      lines.push(field('Repair', command(group.repair_command), { indent: 2, kind: 'command' }));
      if (group.follow_up_command) {
        lines.push(field('Follow-up', command(group.follow_up_command), { indent: 2, kind: 'command' }));
      }
      lines.push(field('Recheck', command(group.recheck_command), { indent: 2, kind: 'command' }));
      const strategyLine = renderRepairStrategy(group.repair_strategy);
      if (strategyLine) {
        lines.push(field('Strategy', strategyLine.replace(/^Strategy:\s*/, ''), { indent: 2, kind: 'info' }));
      }
      const nextStepLine = renderRemediationNextStep(group.remediation_summary);
      if (nextStepLine) {
        lines.push(field('Next step', nextStepLine.replace(/^Next step:\s*/, ''), { indent: 2, kind: 'info' }));
      }
      if (group.remediation_summary?.next_step?.affected_targets_summary) {
        lines.push(field('Affected targets', group.remediation_summary.next_step.affected_targets_summary, { indent: 2, kind: 'muted' }));
      }
      const autoFixPath = renderAutoFixPath(group.remediation_summary);
      if (autoFixPath) {
        lines.push(field('Auto fix path', autoFixPath, { indent: 2, kind: 'command' }));
      }
      if (group.remediation_summary?.next_step?.auto_fix_command) {
        lines.push(field('Auto fix command', command(group.remediation_summary.next_step.auto_fix_command), { indent: 2, kind: 'command' }));
      } else if (group.remediation_summary?.next_step?.auto_fix_blocked_reason) {
        lines.push(field('Auto fix unavailable', group.remediation_summary.next_step.auto_fix_blocked_reason, { indent: 2, kind: 'warning' }));
        if (group.remediation_summary?.next_step?.auto_fix_resume_hint) {
          lines.push(field('Auto fix resume', group.remediation_summary.next_step.auto_fix_resume_hint, { indent: 2, kind: 'muted' }));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_command) {
          lines.push(field('Resume command', command(group.remediation_summary.next_step.auto_fix_resume_command), { indent: 2, kind: 'command' }));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_suggested_command) {
          lines.push(field('Suggested resume', command(group.remediation_summary.next_step.auto_fix_resume_suggested_command), { indent: 2, kind: 'command' }));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_validation_summary) {
          lines.push(field(
            'Resume checks',
            group.remediation_summary.next_step.auto_fix_resume_validation_summary,
            {
              indent: 2,
              kind:
                group.remediation_summary.next_step.auto_fix_resume_validation_status === 'ready'
                  ? 'success'
                  : 'warning'
            }
          ));
        }
        if (group.remediation_summary?.next_step?.auto_fix_resume_suggested_validation_summary) {
          lines.push(field(
            'Suggested checks',
            group.remediation_summary.next_step.auto_fix_resume_suggested_validation_summary,
            {
              indent: 2,
              kind:
                group.remediation_summary.next_step.auto_fix_resume_suggested_validation_status === 'ready'
                  ? 'success'
                  : 'warning'
            }
          ));
        }
        if (Array.isArray(group.remediation_summary?.next_step?.auto_fix_resume_missing_inputs) && group.remediation_summary.next_step.auto_fix_resume_missing_inputs.length > 0) {
          lines.push(field('Resume inputs', group.remediation_summary.next_step.auto_fix_resume_missing_inputs.join(', '), { indent: 2, kind: 'warning' }));
        }
        if (Array.isArray(group.remediation_summary?.next_step?.auto_fix_resume_input_details) && group.remediation_summary.next_step.auto_fix_resume_input_details.length > 0) {
          group.remediation_summary.next_step.auto_fix_resume_input_details.forEach((entry) => {
            lines.push(field(`Input ${entry.label}`, `${entry.description}${entry.validation_summary ? ` | check=${entry.validation_summary}` : ''}${entry.example ? ` | example=${entry.example}` : ''}`, { indent: 2, kind: 'muted' }));
            if (Array.isArray(entry.candidates) && entry.candidates.length > 0) {
              lines.push(field(`Input ${entry.label} options`, entry.candidates.join(' | '), { indent: 2, kind: 'muted' }));
            }
          });
        }
      }
      renderRemediationGuidance(group.remediation_summary).forEach((line) => {
        const [label, ...rest] = line.split(': ');
        lines.push(field(label, rest.join(': '), { indent: 2, kind: label === 'Example command' ? 'command' : 'muted' }));
      });
      const repairPath = renderRepairSequence(group.repair_sequence);
      if (repairPath) {
        lines.push(field('Repair path', repairPath, { indent: 2, kind: 'muted' }));
      }
      lines.push(...renderSessionRows(group.sessions));
      lines.push('');
    }
    return lines.join('\n');
  }

  for (const group of problemGroups) {
    lines.push(section(`Workspace: ${group.workspace || 'unresolved'}`, { kind: 'warning' }));
    lines.push(field('Mirror', `${group.mirror.available ? status('ON', 'success') : status('OFF', 'warning')} | Collections ${group.mirror.collections} | Docs ${group.mirror.documents} | Indexed sessions ${group.mirror.indexed_sessions}`, { indent: 2, kind: group.mirror.available ? 'success' : 'warning' }));
    lines.push(field('Memory', `${status(formatHealthDisplay(group.memory_sources.health.status), summarizeStatusKind(group.memory_sources.health.status))} | External ${group.memory_sources.external_source_count} | Unsynced ${group.memory_sources.unsynced_source_count} | Last sync ${group.memory_sources.last_legacy_sync_at || '-'}`, { indent: 2, kind: summarizeStatusKind(group.memory_sources.health.status) }));
    const taskStateLine = renderVisibleSummaryLine(
      'Task continuity',
      formatTaskStateDisplay(group.task_state_summary),
      group.task_state_session_key
    );
    if (taskStateLine) {
      lines.push(taskStateLine);
    }
    const taskHealthLine = renderTaskContinuityHealth(group.task_state_health);
    if (taskHealthLine) {
      lines.push(field('Task continuity health', taskHealthLine, { indent: 2, kind: ['ready', 'complete'].includes(group.task_state_health?.status) ? 'success' : 'warning' }));
    }
    const benefitLine = renderVisibleSummaryLine(
      'Last benefit',
      formatBenefitDisplay(group.last_benefit_summary),
      group.last_benefit_session_key
    );
    if (benefitLine) {
      lines.push(benefitLine);
    }
    lines.push(field('Issues', group.issues.map(describeIssue).join(', '), { indent: 2, kind: 'warning' }));
    lines.push(field('Diagnose', command(group.diagnostic_command), { indent: 2, kind: 'command' }));
    lines.push(field('Repair', command(group.repair_command), { indent: 2, kind: 'command' }));
    if (group.follow_up_command) {
      lines.push(field('Follow-up', command(group.follow_up_command), { indent: 2, kind: 'command' }));
    }
    lines.push(field('Recheck', command(group.recheck_command), { indent: 2, kind: 'command' }));
    const strategyLine = renderRepairStrategy(group.repair_strategy);
    if (strategyLine) {
      lines.push(field('Strategy', strategyLine.replace(/^Strategy:\s*/, ''), { indent: 2, kind: 'info' }));
    }
    const nextStepLine = renderRemediationNextStep(group.remediation_summary);
    if (nextStepLine) {
      lines.push(field('Next step', nextStepLine.replace(/^Next step:\s*/, ''), { indent: 2, kind: 'info' }));
    }
    if (group.remediation_summary?.next_step?.affected_targets_summary) {
      lines.push(field('Affected targets', group.remediation_summary.next_step.affected_targets_summary, { indent: 2, kind: 'muted' }));
    }
    const autoFixPath = renderAutoFixPath(group.remediation_summary);
    if (autoFixPath) {
      lines.push(field('Auto fix path', autoFixPath, { indent: 2, kind: 'command' }));
    }
    if (group.remediation_summary?.next_step?.auto_fix_command) {
      lines.push(field('Auto fix command', command(group.remediation_summary.next_step.auto_fix_command), { indent: 2, kind: 'command' }));
    } else if (group.remediation_summary?.next_step?.auto_fix_blocked_reason) {
      lines.push(field('Auto fix unavailable', group.remediation_summary.next_step.auto_fix_blocked_reason, { indent: 2, kind: 'warning' }));
      if (group.remediation_summary?.next_step?.auto_fix_resume_hint) {
        lines.push(field('Auto fix resume', group.remediation_summary.next_step.auto_fix_resume_hint, { indent: 2, kind: 'muted' }));
      }
      if (group.remediation_summary?.next_step?.auto_fix_resume_command) {
        lines.push(field('Resume command', command(group.remediation_summary.next_step.auto_fix_resume_command), { indent: 2, kind: 'command' }));
      }
      if (group.remediation_summary?.next_step?.auto_fix_resume_suggested_command) {
        lines.push(field('Suggested resume', command(group.remediation_summary.next_step.auto_fix_resume_suggested_command), { indent: 2, kind: 'command' }));
      }
      if (group.remediation_summary?.next_step?.auto_fix_resume_validation_summary) {
        lines.push(field(
          'Resume checks',
          group.remediation_summary.next_step.auto_fix_resume_validation_summary,
          {
            indent: 2,
            kind:
              group.remediation_summary.next_step.auto_fix_resume_validation_status === 'ready'
                ? 'success'
                : 'warning'
          }
        ));
      }
      if (group.remediation_summary?.next_step?.auto_fix_resume_suggested_validation_summary) {
        lines.push(field(
          'Suggested checks',
          group.remediation_summary.next_step.auto_fix_resume_suggested_validation_summary,
          {
            indent: 2,
            kind:
              group.remediation_summary.next_step.auto_fix_resume_suggested_validation_status === 'ready'
                ? 'success'
                : 'warning'
          }
        ));
      }
      if (Array.isArray(group.remediation_summary?.next_step?.auto_fix_resume_missing_inputs) && group.remediation_summary.next_step.auto_fix_resume_missing_inputs.length > 0) {
        lines.push(field('Resume inputs', group.remediation_summary.next_step.auto_fix_resume_missing_inputs.join(', '), { indent: 2, kind: 'warning' }));
      }
      if (Array.isArray(group.remediation_summary?.next_step?.auto_fix_resume_input_details) && group.remediation_summary.next_step.auto_fix_resume_input_details.length > 0) {
        group.remediation_summary.next_step.auto_fix_resume_input_details.forEach((entry) => {
          lines.push(field(`Input ${entry.label}`, `${entry.description}${entry.validation_summary ? ` | check=${entry.validation_summary}` : ''}${entry.example ? ` | example=${entry.example}` : ''}`, { indent: 2, kind: 'muted' }));
          if (Array.isArray(entry.candidates) && entry.candidates.length > 0) {
            lines.push(field(`Input ${entry.label} options`, entry.candidates.join(' | '), { indent: 2, kind: 'muted' }));
          }
        });
      }
    }
    renderRemediationGuidance(group.remediation_summary).forEach((line) => {
      const [label, ...rest] = line.split(': ');
      lines.push(field(label, rest.join(': '), { indent: 2, kind: label === 'Example command' ? 'command' : 'muted' }));
    });
    const repairPath = renderRepairSequence(group.repair_sequence);
    if (repairPath) {
      lines.push(field('Repair path', repairPath, { indent: 2, kind: 'muted' }));
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
