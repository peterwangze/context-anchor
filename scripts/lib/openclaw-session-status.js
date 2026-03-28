const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runDoctor } = require('../doctor');
const { createPaths, sanitizeKey } = require('./context-anchor');
const { discoverOpenClawSessions } = require('./openclaw-session-discovery');
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

function buildSchedulerDescriptor(openClawHome, workspace, currentPlatform = process.platform) {
  const workspacePath = path.resolve(workspace);
  const launcherId = crypto.createHash('sha1').update(workspacePath).digest('hex').slice(0, 8);
  const baseName = `${path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'workspace'}-${launcherId}`;
  const automationRoot = path.join(openClawHome, 'automation', 'context-anchor');
  const launchersDir = path.join(automationRoot, 'launchers');
  const schedulerRoot = path.join(automationRoot, 'schedulers');
  const windows = {
    launcher_path: path.join(launchersDir, `${baseName}.cmd`),
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
    if (!fs.existsSync(descriptor.windows.launcher_path)) {
      return {
        status: 'off',
        runtime: 'missing',
        configured: false,
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
      overall: 'unknown',
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

  let overall = 'needs_attention';
  if (skill === 'ready' && hook === 'on' && scheduler.status === 'running') {
    overall = 'ready';
  }

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
  const doctor = runDoctor({ openclawHome: resolvedOpenClawHome, skillsRoot });
  const hostConfig = readHostConfig(resolvedOpenClawHome);
  const sessions = discoverOpenClawSessions(resolvedOpenClawHome).map((session) => ({
    ...session,
    classification: classifySessionStatus(session, resolvedOpenClawHome, hostConfig, doctor, {
      schedulerProbe: options.schedulerProbe,
      execFileSync: options.execFileSync
    })
  }));
  const groups = groupSessionsByWorkspace(sessions).map((group) => {
    const workspace = group.workspace;
    const workspaceStatus = workspace
      ? getWorkspaceRegistrationStatus(resolvedOpenClawHome, workspace, {
          userId: hostConfig.defaults.user_id
        })
      : null;
    const hookStatus = workspace
      ? group.sessions[0]?.classification?.hook || 'off'
      : 'unknown';
    const monitorStatus = workspace
      ? group.sessions[0]?.classification?.monitor || 'unknown'
      : 'unknown';
    const ready = group.sessions.filter((entry) => entry.classification?.overall === 'ready').length;
    const attention = group.sessions.length - ready;

    return {
      workspace,
      hook_status: hookStatus,
      monitor_status: monitorStatus,
      workspace_status: workspaceStatus,
      session_count: group.sessions.length,
      ready_count: ready,
      attention_count: attention,
      sessions: group.sessions.sort((left, right) => {
        return Number(right.updated_at || 0) - Number(left.updated_at || 0);
      })
    };
  });

  const summary = {
    total_sessions: sessions.length,
    workspaces: groups.length,
    skill_ready_sessions: sessions.filter((entry) => entry.classification.skill === 'ready').length,
    ready_sessions: sessions.filter((entry) => entry.classification.overall === 'ready').length,
    attention_sessions: sessions.filter((entry) => entry.classification.overall !== 'ready').length,
    unresolved_sessions: sessions.filter((entry) => entry.workspace === null).length,
    hook_on_workspaces: groups.filter((entry) => entry.hook_status === 'on').length,
    monitor_running_workspaces: groups.filter((entry) => entry.monitor_status === 'running').length
  };

  return {
    status: 'ok',
    openclaw_home: resolvedOpenClawHome,
    skills_root: skillsRoot,
    global: {
      installation: doctor.installation,
      configuration: doctor.configuration,
      ownership: doctor.ownership
    },
    summary,
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
    'SKILL'.padEnd(12, ' ')
  ].join('  ');
  const lines = [header, `  ${'-'.repeat(36)}  ${'-'.repeat(38)}  ${'-'.repeat(12)}`];

  for (const session of sessions) {
    lines.push(
      [
        '  ' + shorten(session.session_key, 36).padEnd(36, ' '),
        shorten(session.session_id || '-', 38).padEnd(38, ' '),
        session.classification.skill.toUpperCase().padEnd(12, ' ')
      ].join('  ')
    );
  }

  return lines;
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

    const rows = renderSessionRows(group.sessions);
    lines.push(...rows);
    lines.push('');
  }

  lines.push('Legend: READY = linked session state and host registration; PARTIAL = only one side is present; ON = hook is enabled; RUNNING = monitor task is active.');

  return lines.join('\n');
}

module.exports = {
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
  renderOpenClawSessionStatusReport,
  renderSessionRows,
  shorten
};
