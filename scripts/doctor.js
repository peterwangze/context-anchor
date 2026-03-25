#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getOpenClawHome, readJson } = require('./lib/context-anchor');
const { getHostConfigFile, readHostConfig, summarizeHostConfig } = require('./lib/host-config');

function parseArgs(argv) {
  const options = {
    workspace: null,
    openclawHome: null,
    skillsRoot: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--openclaw-home') {
      options.openclawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--skills-root') {
      options.skillsRoot = argv[index + 1] || null;
      index += 1;
    }
  }

  return options;
}

function platformLabel(platform) {
  switch (platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    default:
      return 'Linux';
  }
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function runDoctor(options = {}) {
  const openClawHome = getOpenClawHome(options.openclawHome || null);
  const skillsRoot = path.resolve(
    options.skillsRoot || process.env.CONTEXT_ANCHOR_SKILLS_ROOT || path.join(openClawHome, 'skills')
  );
  const installedSkillDir = path.join(skillsRoot, 'context-anchor');
  const configFile = path.join(openClawHome, 'config.json');
  const hookHandler = path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js');
  const monitorScript = path.join(openClawHome, 'automation', 'context-anchor', 'context-pressure-monitor.js');
  const workspaceMonitorScript = path.join(
    openClawHome,
    'automation',
    'context-anchor',
    'workspace-monitor.js'
  );
  const userDataRoot = path.join(openClawHome, 'context-anchor', 'users', 'default-user');
  const hostConfigFile = getHostConfigFile(openClawHome);
  const config = readJson(configFile, null);
  const hostConfig = readHostConfig(openClawHome);
  const extraDirs = Array.isArray(config?.extraDirs) ? config.extraDirs : [];
  const hooks = config?.hooks || {};
  const automation = config?.automation || {};
  const workspace = options.workspace ? path.resolve(options.workspace) : null;

  const installation = {
    config_exists: fs.existsSync(configFile),
    skill_snapshot_exists: fs.existsSync(path.join(installedSkillDir, 'SKILL.md')),
    hook_wrapper_exists: fs.existsSync(hookHandler),
    monitor_wrapper_exists: fs.existsSync(monitorScript),
    workspace_monitor_wrapper_exists: fs.existsSync(workspaceMonitorScript),
    extra_dir_registered: extraDirs.includes(skillsRoot)
  };
  installation.ready = Object.values(installation).every(Boolean);
  installation.missing = Object.entries(installation)
    .filter(([key, value]) => key !== 'ready' && key !== 'missing' && value !== true)
    .map(([key]) => key);
  const configuration = {
    hooks_registered:
      typeof hooks['gateway:startup'] === 'string' &&
      hooks['gateway:startup'].includes(hookHandler) &&
      typeof hooks['command:stop'] === 'string' &&
      hooks['command:stop'].includes(hookHandler) &&
      typeof hooks['session:end'] === 'string' &&
      hooks['session:end'].includes(hookHandler) &&
      typeof hooks.heartbeat === 'string' &&
      hooks.heartbeat.includes(hookHandler),
    workspace_monitor_registered:
      typeof automation['context-anchor-workspace-monitor'] === 'string' &&
      automation['context-anchor-workspace-monitor'].includes(workspaceMonitorScript)
  };
  configuration.ready = configuration.hooks_registered && configuration.workspace_monitor_registered;
  configuration.missing = Object.entries(configuration)
    .filter(([key, value]) => key !== 'ready' && key !== 'missing' && value !== true)
    .map(([key]) => key);

  return {
    status: installation.ready ? 'ok' : 'warning',
    platform: process.platform,
    platform_label: platformLabel(process.platform),
    paths: {
      openclaw_home: openClawHome,
      skills_root: skillsRoot,
      installed_skill_dir: installedSkillDir,
      config_file: configFile,
      hook_handler: hookHandler,
      monitor_script: monitorScript,
      workspace_monitor_script: workspaceMonitorScript,
      host_config_file: hostConfigFile,
      user_data_root: userDataRoot,
      workspace
    },
    installation,
    configuration,
    ownership: summarizeHostConfig(hostConfig),
    commands: {
      install: `node ${quoteArg(path.join(__dirname, 'install-one-click.js'))}`,
      configure: `node ${quoteArg(path.join(__dirname, 'configure-host.js'))}`,
      hook_with_payload_file: `node ${quoteArg(hookHandler)} heartbeat ${quoteArg(
        process.platform === 'win32' ? '.\\context-anchor-payload.json' : './context-anchor-payload.json'
      )}`,
      workspace_monitor: `node ${quoteArg(workspaceMonitorScript)} ${quoteArg(workspace || '<workspace>')}`,
      monitor_single_session: `node ${quoteArg(monitorScript)} ${quoteArg(
        workspace || '<workspace>'
      )} ${quoteArg('<session-key>')} 82`
    },
    notes: [
      'Prefer absolute paths and always wrap paths in double quotes when running commands manually.',
      'Do not rely on "~" expansion inside config files; use the actual path shown in this report.',
      'If shell quoting is difficult, write payload JSON to a file and pass the file path to the hook handler.',
      'The one-click installer will ask whether to preserve existing memories before it cleans previous installation files.',
      'If you skipped automatic config writing during install, rerun configure-host to register the recommended hooks and workspace monitor entry.'
    ]
  };
}

function main() {
  const result = runDoctor(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runDoctor
};
