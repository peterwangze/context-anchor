#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getOpenClawHome } = require('./lib/context-anchor');
const { runInstallHostAssets } = require('./install-host-assets');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    assumeYes: false,
    preserveMemories: undefined
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
      continue;
    }

    if (arg === '--keep-memory') {
      options.preserveMemories = true;
      continue;
    }

    if (arg === '--drop-memory') {
      options.preserveMemories = false;
    }
  }

  return options;
}

function pathExists(target) {
  return fs.existsSync(target);
}

function dirHasFiles(targetDir) {
  if (!pathExists(targetDir)) {
    return false;
  }

  const stack = [targetDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else {
        return true;
      }
    }
  }

  return false;
}

function detectExistingState(openClawHome, skillsRoot) {
  const installedSkillDir = path.join(skillsRoot, 'context-anchor');
  const hooksTargetDir = path.join(openClawHome, 'hooks', 'context-anchor-hook');
  const automationTargetDir = path.join(openClawHome, 'automation', 'context-anchor');
  const memoryRoot = path.join(openClawHome, 'context-anchor');

  return {
    openclaw_home: openClawHome,
    skills_root: skillsRoot,
    installed_skill_dir: installedSkillDir,
    hooks_dir: hooksTargetDir,
    automation_dir: automationTargetDir,
    memory_root: memoryRoot,
    has_install_artifacts:
      pathExists(installedSkillDir) || pathExists(hooksTargetDir) || pathExists(automationTargetDir),
    has_memory_data: dirHasFiles(memoryRoot)
  };
}

function removeIfExists(target) {
  if (pathExists(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function cleanupPreviousInstall(state, preserveMemories) {
  removeIfExists(state.installed_skill_dir);
  removeIfExists(state.hooks_dir);
  removeIfExists(state.automation_dir);

  if (!preserveMemories) {
    removeIfExists(state.memory_root);
  }
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

async function runOneClickInstall(openClawHomeArg, skillsRootArg, options = {}) {
  const openClawHome = getOpenClawHome(openClawHomeArg || options.openclawHome || null);
  const skillsRoot = path.resolve(
    skillsRootArg ||
      options.skillsRoot ||
      process.env.CONTEXT_ANCHOR_SKILLS_ROOT ||
      path.join(openClawHome, 'skills')
  );
  const state = detectExistingState(openClawHome, skillsRoot);
  const ask = options.ask || null;
  const assumeYes = Boolean(options.assumeYes);

  let preserveMemories =
    typeof options.preserveMemories === 'boolean' ? options.preserveMemories : undefined;
  let proceed = true;

  if (state.has_install_artifacts) {
    proceed = assumeYes
      ? true
      : await askYesNo(
          `Detected an existing context-anchor installation in ${state.installed_skill_dir}. Clean previous install files and reinstall now?`,
          true,
          ask
        );
  }

  if (!proceed) {
    return {
      status: 'cancelled',
      reason: 'user_declined_reinstall',
      ...state
    };
  }

  if (state.has_memory_data && preserveMemories === undefined) {
    preserveMemories = assumeYes
      ? true
      : await askYesNo(
          `Detected existing context-anchor memory data in ${state.memory_root}. Preserve these memories and only clean the old installation files?`,
          true,
          ask
        );
  }

  if (preserveMemories === undefined) {
    preserveMemories = true;
  }

  cleanupPreviousInstall(state, preserveMemories);
  const install = runInstallHostAssets(openClawHome, skillsRoot);

  return {
    status: 'installed',
    previous_install_detected: state.has_install_artifacts,
    previous_memory_detected: state.has_memory_data,
    preserved_memories: preserveMemories,
    install
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runOneClickInstall(options.openclawHome, options.skillsRoot, options);
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
  cleanupPreviousInstall,
  detectExistingState,
  runOneClickInstall
};
