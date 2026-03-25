#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getOpenClawHome, readJson } = require('./lib/context-anchor');

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
  const userDataRoot = path.join(openClawHome, 'context-anchor', 'users', 'default-user');
  const config = readJson(configFile, null);
  const extraDirs = Array.isArray(config?.extraDirs) ? config.extraDirs : [];
  const workspace = options.workspace ? path.resolve(options.workspace) : null;

  const installation = {
    config_exists: fs.existsSync(configFile),
    skill_snapshot_exists: fs.existsSync(path.join(installedSkillDir, 'SKILL.md')),
    hook_wrapper_exists: fs.existsSync(hookHandler),
    monitor_wrapper_exists: fs.existsSync(monitorScript),
    extra_dir_registered: extraDirs.includes(skillsRoot)
  };
  installation.ready = Object.values(installation).every(Boolean);
  installation.missing = Object.entries(installation)
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
      user_data_root: userDataRoot,
      workspace
    },
    installation,
    commands: {
      install: `node ${quoteArg(path.join(__dirname, 'install-one-click.js'))}`,
      hook_with_payload_file: `node ${quoteArg(hookHandler)} heartbeat ${quoteArg(
        process.platform === 'win32' ? '.\\context-anchor-payload.json' : './context-anchor-payload.json'
      )}`,
      monitor_single_session: `node ${quoteArg(monitorScript)} ${quoteArg(
        workspace || '<workspace>'
      )} ${quoteArg('<session-key>')} 82`
    },
    notes: [
      'Prefer absolute paths and always wrap paths in double quotes when running commands manually.',
      'Do not rely on "~" expansion inside config files; use the actual path shown in this report.',
      'If shell quoting is difficult, write payload JSON to a file and pass the file path to the hook handler.',
      'The one-click installer will ask whether to preserve existing memories before it cleans previous installation files.'
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
