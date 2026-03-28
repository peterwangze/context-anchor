#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { runConfigureHost } = require('./configure-host');
const { runDoctor } = require('./doctor');
const { runInstallHostAssets } = require('./install-host-assets');
const { runSessionStart } = require('./session-start');
const { readHostConfig, findSession, getWorkspaceRegistrationStatus, resolveOwnership } = require('./lib/host-config');
const { discoverOpenClawSessions } = require('./lib/openclaw-session-discovery');
const { getOpenClawHome, sanitizeKey } = require('./lib/context-anchor');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    assumeYes: false
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

    if (arg === '--yes') {
      options.assumeYes = true;
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

function askText(prompt, defaultValue = '', ask = null) {
  if (ask) {
    return ask(prompt, defaultValue);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
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
    rl.question(`${prompt}${suffix}`, (answer) => {
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
  const workspaceEnsured = new Map();
  const results = [];

  for (const session of discoveredSessions) {
    const classification = classifySession(session, openClawHome);
    const defaultAction = classification.ready ? 'skip' : 'configure';
    const prompt = classification.ready
      ? `Session ${session.session_key} in ${formatWorkspaceLabel(session.workspace)} is already configured. Action [skip/reconfigure] (default: skip): `
      : `Session ${session.session_key} in ${formatWorkspaceLabel(session.workspace)} is ${classification.partial ? 'partially configured' : 'not configured'}. Action [skip/configure] (default: configure): `;
    const actionAnswer = await askText(prompt, defaultAction, ask);
    const action = normalizeActionAnswer(actionAnswer, defaultAction, classification.ready);

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

  return {
    status: 'ok',
    openclaw_home: openClawHome,
    skills_root: skillsRoot,
    discovered_sessions: discoveredSessions.length,
    configured_sessions: results.filter((entry) => entry.action === 'configured' || entry.action === 'reconfigured').length,
    skipped_sessions: results.filter((entry) => entry.action === 'skipped').length,
    results,
    doctor,
    repair
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runConfigureSessions(options.openclawHome, options.skillsRoot, options);
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
  askText,
  askYesNo,
  classifySession,
  main,
  normalizeActionAnswer,
  normalizeWorkspaceKey,
  parseArgs,
  runConfigureSessions
};
