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
  const defaultManagedSkillsRoot = path.join(openClawHome, 'skills');
  const installedSkillDir = path.join(skillsRoot, 'context-anchor');
  const configFile = path.join(openClawHome, 'openclaw.json');
  const legacyConfigFile = path.join(openClawHome, 'config.json');
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
  const extraDirs = Array.isArray(config?.skills?.load?.extraDirs) ? config.skills.load.extraDirs : [];
  const hooks = config?.hooks || {};
  const workspace = options.workspace ? path.resolve(options.workspace) : null;
  const skillsRootRegistrationRequired = path.resolve(skillsRoot) !== path.resolve(defaultManagedSkillsRoot);

  const installation = {
    config_exists: fs.existsSync(configFile),
    legacy_config_present: fs.existsSync(legacyConfigFile),
    skill_snapshot_exists: fs.existsSync(path.join(installedSkillDir, 'SKILL.md')),
    hook_wrapper_exists: fs.existsSync(hookHandler),
    monitor_wrapper_exists: fs.existsSync(monitorScript),
    workspace_monitor_wrapper_exists: fs.existsSync(workspaceMonitorScript),
    extra_skill_dir_registered: skillsRootRegistrationRequired ? extraDirs.includes(skillsRoot) : true
  };
  installation.managed_skills_root = defaultManagedSkillsRoot;
  installation.ready =
    installation.skill_snapshot_exists &&
    installation.hook_wrapper_exists &&
    installation.monitor_wrapper_exists &&
    installation.workspace_monitor_wrapper_exists &&
    installation.extra_skill_dir_registered;
  installation.missing = Object.entries(installation)
    .filter(
      ([key, value]) =>
        !['ready', 'missing', 'legacy_config_present', 'managed_skills_root'].includes(key) && value !== true
    )
    .map(([key]) => key);
  const configuration = {
    internal_hooks_enabled: hooks?.internal?.enabled === true,
    extra_skill_dir_registered: installation.extra_skill_dir_registered,
    auto_workspace_registration_enabled: hostConfig.onboarding.auto_register_workspaces !== false
  };
  configuration.ready = configuration.internal_hooks_enabled && configuration.extra_skill_dir_registered;
  configuration.missing = Object.entries(configuration)
    .filter(([key, value]) => key !== 'ready' && key !== 'missing' && value !== true)
    .map(([key]) => key);

  return {
    status: installation.ready && configuration.ready ? 'ok' : 'warning',
    platform: process.platform,
    platform_label: platformLabel(process.platform),
    paths: {
      openclaw_home: openClawHome,
      skills_root: skillsRoot,
      default_managed_skills_root: defaultManagedSkillsRoot,
      installed_skill_dir: installedSkillDir,
      config_file: configFile,
      legacy_config_file: legacyConfigFile,
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
      rebuild_mirror: `node ${quoteArg(path.join(__dirname, 'mirror-rebuild.js'))}${
        workspace ? ` --workspace ${quoteArg(workspace)}` : ''
      }`,
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
      'If you introduced the SQLite mirror on top of existing JSON memories, run the rebuild_mirror command once to backfill old data.',
      'OpenClaw reads managed hook and skill settings from openclaw.json; the legacy config.json file is not used for this integration.',
      'If you install context-anchor into the default managed skills directory (~/.openclaw/skills), skills.load.extraDirs is not required.',
      'If shell quoting is difficult, write payload JSON to a file and pass the file path to the hook handler.',
      'The one-click installer will ask whether to preserve existing memories before it cleans previous installation files.',
      'If internal hooks are disabled, context-anchor-hook will not run even if the managed hook files are installed.',
      'By default, context-anchor automatically registers first-seen workspaces with the default user and workspace basename project id; disable this in configure-host if you want manual approval instead.'
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
