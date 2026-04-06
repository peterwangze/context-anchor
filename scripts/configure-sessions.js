#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { buildOpenClawSessionStatusReport } = require('./lib/openclaw-session-status');
const { runConfigureHost } = require('./configure-host');
const { runDoctor } = require('./doctor');
const { runInstallHostAssets } = require('./install-host-assets');
const { runSessionStart } = require('./session-start');
const {
  ensureWorkspaceRegistration,
  readHostConfig,
  findSession,
  getWorkspaceRegistrationStatus,
  resolveOwnership
} = require('./lib/host-config');
const { discoverOpenClawSessions } = require('./lib/openclaw-session-discovery');
const { getOpenClawHome, sanitizeKey } = require('./lib/context-anchor');
const { command, field, section, status, tag } = require('./lib/terminal-format');
const { runCliMain } = require('./lib/cli-runtime');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    assumeYes: false,
    json: false,
    workspace: null,
    sessionKey: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--openclaw-home') {
      options.openclawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--skills-root') {
      options.skillsRoot = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--session-key') {
      options.sessionKey = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--yes') {
      options.assumeYes = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

function normalizeWorkspaceKey(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function formatWorkspaceLabel(workspace) {
  return workspace || '<workspace unknown>';
}

function formatInteractivePrompt(prompt) {
  return `${tag('input', 'info')} ${prompt}`;
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildSessionsRecheckCommand(openClawHome, skillsRoot, options = {}) {
  const forwarded = [
    '--openclaw-home',
    quoteArg(openClawHome),
    '--skills-root',
    quoteArg(skillsRoot)
  ];

  if (options.workspace) {
    forwarded.push('--workspace', quoteArg(options.workspace));
  }
  if (options.sessionKey) {
    forwarded.push('--session-key', quoteArg(options.sessionKey));
  }

  return `npm run status:sessions -- ${forwarded.join(' ')}`;
}

function summarizeSessionVerificationState(sessionReport = {}) {
  const summary = sessionReport.summary || {};
  return {
    report_status: sessionReport.status || 'warning',
    ready_sessions: Number(summary.ready_sessions || 0),
    attention_sessions: Number(summary.attention_sessions || 0),
    unresolved_sessions: Number(summary.unresolved_sessions || 0),
    drift_workspaces: Number(summary.drift_workspaces || 0),
    task_visible_workspaces: Number(summary.task_visible_workspaces || 0),
    benefit_visible_workspaces: Number(summary.benefit_visible_workspaces || 0)
  };
}

function summarizeTargetSessionState(sessionReport = {}, sessionKeys = new Set()) {
  const scopedSessions = Array.isArray(sessionReport.sessions)
    ? sessionReport.sessions.filter((entry) => sessionKeys.has(sanitizeKey(entry.session_key)))
    : [];
  const targetAttention = scopedSessions.filter((entry) => {
    const classification = entry.classification || {};
    return classification.skill !== 'ready' || classification.hook !== 'on';
  }).length;

  return {
    target_sessions: scopedSessions.length,
    target_ready_sessions: scopedSessions.length - targetAttention,
    target_attention_sessions: targetAttention
  };
}

function buildConfigureSessionsVerification({
  openClawHome,
  skillsRoot,
  options,
  results,
  doctor,
  beforeSessionReport,
  sessionReport
}) {
  const configuredResults = results.filter((entry) => entry.action === 'configured' || entry.action === 'reconfigured');
  const configuredKeys = new Set(configuredResults.map((entry) => sanitizeKey(entry.session_key)));
  const verifiedSessions = sessionReport.sessions.filter((entry) => configuredKeys.has(sanitizeKey(entry.session_key)));
  const remainingAttention = verifiedSessions.filter((entry) => {
    const classification = entry.classification || {};
    return classification.skill !== 'ready' || classification.hook !== 'on';
  });
  const issues = [];
  let status = 'verified';
  let summary = 'Configure-sessions recheck passed.';
  const before = {
    ...summarizeSessionVerificationState(beforeSessionReport),
    ...summarizeTargetSessionState(beforeSessionReport, configuredKeys)
  };
  const after = {
    ...summarizeSessionVerificationState(sessionReport),
    ...summarizeTargetSessionState(sessionReport, configuredKeys)
  };
  const changed =
    before.target_ready_sessions !== after.target_ready_sessions ||
    before.target_attention_sessions !== after.target_attention_sessions ||
    before.unresolved_sessions !== after.unresolved_sessions ||
    before.drift_workspaces !== after.drift_workspaces;

  if (!doctor.installation.ready || !doctor.configuration.ready) {
    issues.push('profile_not_ready');
    status = 'needs_attention';
  }

  if (remainingAttention.length > 0) {
    issues.push('session_not_ready_after_repair');
    status = 'needs_attention';
  }

  if (status === 'needs_attention') {
    summary = !doctor.installation.ready || !doctor.configuration.ready
      ? 'Configure-sessions recheck still sees host/runtime issues after the repair run.'
      : `${remainingAttention.length} configured session(s) still need attention after recheck.`;
  } else if (configuredResults.length === 0) {
    summary = 'No sessions were configured in this run, so only the current status snapshot was rechecked.';
  }

  if (status === 'needs_attention' && !changed) {
    summary = `${summary} Recheck did not reduce the visible session issues yet.`;
  } else if (status === 'verified' && changed) {
    summary = `${summary} Recheck confirms session readiness improved.`;
  } else if (status === 'verified' && configuredResults.length > 0 && !changed) {
    summary = `${summary} Recheck did not show a visible delta because the target sessions already looked ready in status checks.`;
  }

  return {
    status,
    summary,
    issues,
    readiness_transition: {
      changed,
      improved:
        after.target_attention_sessions < before.target_attention_sessions ||
        after.target_ready_sessions > before.target_ready_sessions ||
        after.unresolved_sessions < before.unresolved_sessions ||
        after.drift_workspaces < before.drift_workspaces,
      before,
      after
    },
    configured_sessions: configuredResults.length,
    verified_sessions: verifiedSessions.length,
    remaining_attention_sessions: remainingAttention.length,
    doctor_status: doctor.status,
    session_report_status: sessionReport.status,
    recheck_command: buildSessionsRecheckCommand(openClawHome, skillsRoot, {
      workspace: options.workspace || null,
      sessionKey: options.sessionKey || null
    })
  };
}

function askText(prompt, defaultValue = '', ask = null) {
  if (ask) {
    return ask(prompt, defaultValue);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(formatInteractivePrompt(prompt), (answer) => {
      rl.close();
      const normalized = String(answer || '').trim();
      resolve(normalized || defaultValue);
    });
  });
}

function askYesNo(prompt, defaultYes = true, ask = null) {
  if (ask) {
    return ask(prompt, defaultYes);
  }

  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${formatInteractivePrompt(prompt)}${suffix}`, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }

      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function normalizeActionAnswer(answer, defaultAction, configured) {
  const normalized = String(answer || '').trim().toLowerCase();
  if (!normalized) {
    return defaultAction;
  }

  if (['s', 'skip'].includes(normalized)) {
    return 'skip';
  }

  if (['c', 'configure', 'setup', 'start'].includes(normalized)) {
    return configured ? 'reconfigure' : 'configure';
  }

  if (['r', 'reconfigure', 'repair'].includes(normalized)) {
    return 'reconfigure';
  }

  if (configured && ['yes', 'y'].includes(normalized)) {
    return 'reconfigure';
  }

  return defaultAction;
}

function classifySession(session, openClawHome) {
  const workspace = session.workspace ? path.resolve(session.workspace) : null;
  const hostConfig = readHostConfig(openClawHome);
  const workspaceStatus = workspace
    ? getWorkspaceRegistrationStatus(openClawHome, workspace)
    : {
        configured: false,
        workspace: null,
        workspaceEntry: null,
        suggestedUserId: hostConfig.defaults.user_id,
        suggestedProjectId: null
      };
  const sessionStateFile = workspace
    ? path.join(workspace, '.context-anchor', 'sessions', sanitizeKey(session.session_key), 'state.json')
    : null;
  const sessionStateExists = Boolean(sessionStateFile && fs.existsSync(sessionStateFile));
  const hostSession = workspace ? findSession(hostConfig, workspace, session.session_key) : null;
  const ready = Boolean(workspace && workspaceStatus.configured && sessionStateExists && hostSession);
  const partial = Boolean(workspace && !ready && (workspaceStatus.configured || sessionStateExists || hostSession));

  return {
    ready,
    partial,
    workspaceStatus,
    sessionStateFile,
    sessionStateExists,
    hostSessionExists: Boolean(hostSession)
  };
}

async function configureWorkspaceForSession({
  openClawHome,
  skillsRoot,
  session,
  ownership,
  workspaceEnsured,
  options
}) {
  const workspaceKey = normalizeWorkspaceKey(session.workspace);
  if (workspaceEnsured.has(workspaceKey)) {
    return workspaceEnsured.get(workspaceKey);
  }

  const needsWorkspaceSetup = !session.classification.workspaceStatus.configured || session.action === 'reconfigure';
  if (!needsWorkspaceSetup) {
    workspaceEnsured.set(workspaceKey, { status: 'reused' });
    return workspaceEnsured.get(workspaceKey);
  }

  if (session.action !== 'reconfigure') {
    const ensured = ensureWorkspaceRegistration(openClawHome, session.workspace, {
      userId: ownership.userId,
      projectId: ownership.projectId,
      reason: 'configure_sessions'
    });
    if (ensured.status !== 'blocked') {
      workspaceEnsured.set(workspaceKey, ensured);
      return ensured;
    }
  }

  const configResult = await runConfigureHost(openClawHome, skillsRoot, {
    assumeYes: true,
    applyConfig: true,
    enableScheduler: true,
    schedulerWorkspace: session.workspace,
    schedulerUserId: ownership.userId,
    schedulerProjectId: ownership.projectId,
    currentPlatform: options.currentPlatform || process.platform,
    intervalMinutes: options.intervalMinutes,
    autoRegister: options.autoRegister,
    schedulerRegistrar: options.schedulerRegistrar
  });

  workspaceEnsured.set(workspaceKey, configResult);
  return configResult;
}

async function runConfigureSessions(openClawHomeArg, skillsRootArg, options = {}) {
  const openClawHome = getOpenClawHome(openClawHomeArg || options.openclawHome || null);
  const skillsRoot = path.resolve(
    skillsRootArg ||
      options.skillsRoot ||
      process.env.CONTEXT_ANCHOR_SKILLS_ROOT ||
      path.join(openClawHome, 'skills')
  );
  const assumeYes = Boolean(options.assumeYes);
  const ask = options.ask || null;
  const beforeSessionReport = buildOpenClawSessionStatusReport(openClawHome, skillsRoot, {
    workspace: options.workspace || null,
    sessionKey: options.sessionKey || null
  });

  let doctor = runDoctor({ openclawHome: openClawHome, skillsRoot });
  let repair = null;
  if (!doctor.installation.ready || !doctor.configuration.ready) {
    const shouldRepair = assumeYes
      ? true
      : await askYesNo(
          'context-anchor is not fully installed/configured yet. Repair the runtime before onboarding sessions now?',
          true,
          ask
        );

    if (shouldRepair) {
      repair = {
        install: runInstallHostAssets(openClawHome, skillsRoot),
        config: await runConfigureHost(openClawHome, skillsRoot, {
          assumeYes: true,
          applyConfig: true,
          enableScheduler: false,
          currentPlatform: options.currentPlatform || process.platform,
          schedulerRegistrar: options.schedulerRegistrar
        })
      };
      doctor = runDoctor({ openclawHome: openClawHome, skillsRoot });
    }
  }

  const discoveredSessions = discoverOpenClawSessions(openClawHome);
  const filteredSessions = discoveredSessions.filter((session) => {
    if (options.workspace) {
      if (!session.workspace || path.resolve(session.workspace) !== path.resolve(options.workspace)) {
        return false;
      }
    }

    if (options.sessionKey && sanitizeKey(session.session_key) !== sanitizeKey(options.sessionKey)) {
      return false;
    }

    return true;
  });
  const workspaceEnsured = new Map();
  const results = [];

  for (const session of filteredSessions) {
    const classification = classifySession(session, openClawHome);
    const defaultAction = classification.ready ? 'skip' : 'configure';
    const prompt = classification.ready
      ? `Session ${session.session_key} in ${formatWorkspaceLabel(session.workspace)} is already configured. Action [skip/reconfigure] (default: skip): `
      : `Session ${session.session_key} in ${formatWorkspaceLabel(session.workspace)} is ${classification.partial ? 'partially configured' : 'not configured'}. Action [skip/configure] (default: configure): `;
    const action = assumeYes && !ask
      ? defaultAction
      : normalizeActionAnswer(await askText(prompt, defaultAction, ask), defaultAction, classification.ready);

    if (action === 'skip') {
      results.push({
        session_key: session.session_key,
        workspace: session.workspace || null,
        agent: session.agent,
        action: 'skipped',
        reason: classification.ready ? 'user_skipped_configured_session' : 'user_skipped_unconfigured_session',
        status: classification.ready ? 'configured' : classification.partial ? 'partial' : 'unconfigured'
      });
      continue;
    }

    let workspace = session.workspace;
    if (!workspace) {
      if (assumeYes && !ask) {
        results.push({
          session_key: session.session_key,
          workspace: null,
          agent: session.agent,
          action: 'skipped',
          reason: 'workspace_not_provided',
          status: 'unresolved'
        });
        continue;
      }

      workspace = await askText(
        `Workspace path for session ${session.session_key} (leave blank to skip): `,
        '',
        ask
      );
      if (!workspace) {
        results.push({
          session_key: session.session_key,
          workspace: null,
          agent: session.agent,
          action: 'skipped',
          reason: 'workspace_not_provided',
          status: 'unresolved'
        });
        continue;
      }
    }

    const ownership = resolveOwnership(openClawHome, {
      workspace,
      sessionKey: session.session_key
    });

    const sessionContext = {
      ...session,
      workspace: path.resolve(workspace),
      action,
      classification
    };

    const workspaceSetup = await configureWorkspaceForSession({
      openClawHome,
      skillsRoot,
      session: sessionContext,
      ownership,
      workspaceEnsured,
      options
    });

    const sessionStart = runSessionStart(sessionContext.workspace, session.session_key, ownership.projectId, {
      userId: ownership.userId,
      openClawSessionId: session.session_id,
      reopenClosed: true
    });

    results.push({
      session_key: session.session_key,
      session_id: session.session_id,
      agent: session.agent,
      workspace: sessionContext.workspace,
      action: action === 'reconfigure' ? 'reconfigured' : 'configured',
      status: classification.ready ? 'configured' : classification.partial ? 'partial' : 'unconfigured',
      workspace_setup: workspaceSetup,
      session_start: sessionStart,
      workspace_registered: Boolean(readHostConfig(openClawHome).workspaces.find((entry) => entry.workspace === path.resolve(sessionContext.workspace)))
    });
  }

  const verificationReport = buildOpenClawSessionStatusReport(openClawHome, skillsRoot, {
    workspace: options.workspace || null,
    sessionKey: options.sessionKey || null
  });
  const verification = buildConfigureSessionsVerification({
    openClawHome,
    skillsRoot,
    options,
    results,
    doctor,
    beforeSessionReport,
    sessionReport: verificationReport
  });

  return {
    status: 'ok',
    openclaw_home: openClawHome,
    skills_root: skillsRoot,
    discovered_sessions: discoveredSessions.length,
    selected_sessions: filteredSessions.length,
    configured_sessions: results.filter((entry) => entry.action === 'configured' || entry.action === 'reconfigured').length,
    skipped_sessions: results.filter((entry) => entry.action === 'skipped').length,
    results,
    verification,
    verification_report: verificationReport,
    doctor,
    repair
  };
}

function renderConfigureSessionsReport(result) {
  const lines = [];
  const verification = result.verification || {};
  const verificationKind =
    verification.status === 'verified'
      ? 'success'
      : verification.status === 'needs_attention'
      ? 'warning'
      : 'info';
  const unresolved = Array.isArray(result.results)
    ? result.results.filter((entry) => entry.status === 'unresolved').length
    : 0;

  lines.push(section('Context-Anchor Session Configuration', { kind: verificationKind }));
  lines.push(field('Status', status(String(result.status || 'ok').toUpperCase(), verificationKind), { kind: verificationKind }));
  lines.push(
    field(
      'Selection',
      `Discovered ${Number(result.discovered_sessions || 0)} | Selected ${Number(result.selected_sessions || 0)} | Configured ${status(Number(result.configured_sessions || 0), Number(result.configured_sessions || 0) > 0 ? 'success' : 'info')} | Skipped ${Number(result.skipped_sessions || 0)} | Unresolved ${status(unresolved, unresolved > 0 ? 'warning' : 'success')}`,
      { kind: unresolved > 0 ? 'warning' : Number(result.configured_sessions || 0) > 0 ? 'success' : 'info' }
    )
  );
  if (result.repair) {
    lines.push(field('Runtime repair', 'Host assets/configuration were refreshed before onboarding sessions.', { kind: 'info' }));
  }
  lines.push(
    field(
      'Verification',
      `${status(String(verification.status || 'unknown').toUpperCase(), verificationKind)}${verification.summary ? ` | ${verification.summary}` : ''}`,
      { kind: verificationKind }
    )
  );
  if (verification.recheck_command) {
    lines.push(field('Recheck', command(verification.recheck_command), { kind: 'command' }));
  }
  if (verification.remediation_summary?.next_step?.label) {
    lines.push(
      field(
        'Next step',
        `${verification.remediation_summary.next_step.label}${verification.remediation_summary.next_step.summary ? ` - ${verification.remediation_summary.next_step.summary}` : ''}`,
        { kind: verification.remediation_summary.next_step.execution_mode === 'manual' ? 'warning' : 'info' }
      )
    );
  }
  if (
    verification.remediation_summary?.next_step?.execution_mode !== 'manual' &&
    Array.isArray(verification.remediation_summary?.next_step?.command_sequence) &&
    verification.remediation_summary.next_step.command_sequence.length > 0
  ) {
    lines.push(
      field(
        'Auto fix',
        verification.remediation_summary.next_step.command_sequence
          .map((entry, index) => `${index + 1}) ${entry.step}: ${command(entry.command)}`)
          .join(' | '),
        { kind: 'command' }
      )
    );
  }
  if (verification.remediation_summary?.next_step?.auto_fix_command) {
    lines.push(field('Auto fix command', command(verification.remediation_summary.next_step.auto_fix_command), { kind: 'command' }));
  } else if (verification.remediation_summary?.next_step?.auto_fix_blocked_reason) {
    lines.push(field('Auto fix unavailable', verification.remediation_summary.next_step.auto_fix_blocked_reason, { kind: 'warning' }));
    if (verification.remediation_summary?.next_step?.auto_fix_resume_hint) {
      lines.push(field('Auto fix resume', verification.remediation_summary.next_step.auto_fix_resume_hint, { kind: 'muted' }));
    }
    if (verification.remediation_summary?.next_step?.auto_fix_resume_command) {
      lines.push(field('Resume command', command(verification.remediation_summary.next_step.auto_fix_resume_command), { kind: 'command' }));
    }
    if (Array.isArray(verification.remediation_summary?.next_step?.auto_fix_resume_missing_inputs) && verification.remediation_summary.next_step.auto_fix_resume_missing_inputs.length > 0) {
      lines.push(field('Resume inputs', verification.remediation_summary.next_step.auto_fix_resume_missing_inputs.join(', '), { kind: 'warning' }));
    }
    if (Array.isArray(verification.remediation_summary?.next_step?.auto_fix_resume_input_details) && verification.remediation_summary.next_step.auto_fix_resume_input_details.length > 0) {
      verification.remediation_summary.next_step.auto_fix_resume_input_details.forEach((entry) => {
        lines.push(field(`Input ${entry.label}`, `${entry.description}${entry.example ? ` | example=${entry.example}` : ''}`, { kind: 'muted' }));
      });
    }
  }
  lines.push('');

  for (const entry of result.results || []) {
    const entryKind =
      entry.action === 'configured' || entry.action === 'reconfigured'
        ? 'success'
        : entry.status === 'unresolved'
        ? 'warning'
        : 'muted';
    lines.push(
      field(
        entry.session_key,
        `${status(String(entry.action || 'unknown').toUpperCase(), entryKind)} | workspace ${entry.workspace || '<unresolved>'}${entry.reason ? ` | ${entry.reason}` : ''}`,
        { kind: entryKind }
      )
    );
  }

  return lines.join('\n');
}

async function main() {
  return runCliMain(process.argv.slice(2), {
    parseArgs,
    run: async (options) => runConfigureSessions(options.openclawHome, options.skillsRoot, options),
    renderText: renderConfigureSessionsReport,
    errorTitle: 'Context-Anchor Session Configuration Failed',
    errorNextStep: 'Review the selected workspace/session arguments, then rerun configure:sessions.'
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  askText,
  askYesNo,
  classifySession,
  main,
  normalizeActionAnswer,
  normalizeWorkspaceKey,
  parseArgs,
  renderConfigureSessionsReport,
  runConfigureSessions
};
