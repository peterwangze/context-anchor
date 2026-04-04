#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { getOpenClawHome } = require('./lib/context-anchor');
const { runConfigureHost } = require('./configure-host');
const { runInstallHostAssets } = require('./install-host-assets');
const { runMirrorRebuild } = require('./mirror-rebuild');
const { runUpgradeSessions } = require('./upgrade-sessions');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    assumeYes: false,
    preserveMemories: undefined,
    applyConfig: undefined,
    memoryTakeover: undefined,
    enableScheduler: undefined,
    targetPlatform: null,
    schedulerWorkspace: null,
    intervalMinutes: null,
    defaultUserId: undefined,
    defaultWorkspace: undefined,
    autoRegisterWorkspaces: undefined,
    addUsers: undefined,
    addWorkspaces: undefined,
    upgradeSessions: false,
    upgradeWorkspace: null,
    upgradeSessionKey: null,
    includeClosedSessions: false,
    runGovernance: undefined,
    governanceMode: null,
    governancePrune: undefined
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
      continue;
    }

    if (arg === '--apply-config') {
      options.applyConfig = true;
      continue;
    }

    if (arg === '--skip-config') {
      options.applyConfig = false;
      continue;
    }

    if (arg === '--enforce-memory-takeover') {
      options.memoryTakeover = true;
      continue;
    }

    if (arg === '--no-enforce-memory-takeover') {
      options.memoryTakeover = false;
      continue;
    }

    if (arg === '--enable-scheduler') {
      options.enableScheduler = true;
      continue;
    }

    if (arg === '--skip-scheduler') {
      options.enableScheduler = false;
      continue;
    }

    if (arg === '--target-platform') {
      options.targetPlatform = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--default-user') {
      options.defaultUserId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--default-workspace') {
      options.defaultWorkspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--auto-register-workspaces') {
      options.autoRegisterWorkspaces = true;
      continue;
    }

    if (arg === '--no-auto-register-workspaces') {
      options.autoRegisterWorkspaces = false;
      continue;
    }

    if (arg === '--add-user') {
      options.addUsers = options.addUsers || [];
      options.addUsers.push(argv[index + 1] || null);
      index += 1;
      continue;
    }

    if (arg === '--add-workspace') {
      options.addWorkspaces = options.addWorkspaces || [];
      options.addWorkspaces.push(argv[index + 1] || null);
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      options.schedulerWorkspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--upgrade-sessions') {
      options.upgradeSessions = true;
      continue;
    }

    if (arg === '--upgrade-workspace') {
      options.upgradeWorkspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--upgrade-session-key') {
      options.upgradeSessionKey = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--include-closed-sessions') {
      options.includeClosedSessions = true;
      continue;
    }

    if (arg === '--run-governance') {
      options.runGovernance = true;
      continue;
    }

    if (arg === '--skip-governance') {
      options.runGovernance = false;
      continue;
    }

    if (arg === '--governance-mode') {
      options.governanceMode = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--governance-prune') {
      const rawValue = String(argv[index + 1] || '').trim();
      options.governancePrune = !(rawValue === '0' || /^false$/i.test(rawValue));
      index += 1;
      continue;
    }

    if (arg === '--interval-minutes') {
      options.intervalMinutes = argv[index + 1] || null;
      index += 1;
    }
  }

  return options;
}

function pathExists(target) {
  return fs.existsSync(target);
}

function emitProgress(progress, event) {
  if (typeof progress === 'function') {
    progress(event);
  }
}

function createCliProgressReporter(stream = process.stderr) {
  return (event = {}) => {
    if (!stream || typeof stream.write !== 'function') {
      return;
    }

    let line = null;
    switch (event.type) {
      case 'install:start':
        line = '[install] preparing reinstall flow';
        break;
      case 'install:assets:start':
        line = '[install] installing host assets';
        break;
      case 'install:assets:done':
        line = '[install] host assets installed';
        break;
      case 'install:config:start':
        line = '[install] applying host configuration';
        break;
      case 'install:config:done':
        line = `[install] host configuration ${event.status || 'completed'}${event.strategy_labels?.length ? ` | strategies=${event.strategy_labels.join(', ')}` : ''}`;
        break;
      case 'install:upgrade:start':
        line = '[install] running session upgrade chain';
        break;
      case 'install:upgrade:done':
        line = `[install] session upgrade chain completed upgraded=${event.upgraded_sessions || 0}${event.strategy_labels?.length ? ` | strategies=${event.strategy_labels.join(', ')}` : ''}`;
        break;
      case 'install:mirror:start':
        line = '[install] running mirror rebuild';
        break;
      case 'install:mirror:done':
        line = '[install] mirror rebuild completed';
        break;
      default:
        if (String(event.type || '').startsWith('upgrade:')) {
          line = event.message || null;
        }
        break;
    }

    if (line) {
      stream.write(`${line}\n`);
    }
  };
}

function collectStrategyEntries(...values) {
  return values
    .flatMap((value) => {
      if (!value) {
        return [];
      }
      if (Array.isArray(value)) {
        return value;
      }
      return [value];
    })
    .filter((entry) => entry && typeof entry === 'object' && entry.type && entry.label);
}

function dedupeStrategies(entries = []) {
  const seen = new Set();
  return collectStrategyEntries(entries).filter((entry) => {
    const key = `${entry.type}::${entry.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function summarizeStrategyKinds(entries = []) {
  const normalized = dedupeStrategies(entries);
  return {
    automatic: normalized.filter((entry) => entry.execution_mode !== 'manual'),
    manual: normalized.filter((entry) => entry.execution_mode === 'manual')
  };
}

function formatStrategyLabel(entry) {
  if (!entry?.label) {
    return null;
  }

  return `${entry.execution_mode === 'manual' ? 'manual' : 'auto'}:${entry.label}`;
}

function extractInstallRepairStrategies(configuration, sessionUpgrade) {
  const configurationStrategies = collectStrategyEntries(
    configuration?.verification?.repair_strategy,
    configuration?.takeover_audit?.recommended_action?.repair_strategy,
    configuration?.host_takeover_audit?.recommended_action?.repair_strategy,
    configuration?.profile_takeover_audit?.recommended_action?.repair_strategy
  );
  const upgradeStrategies = collectStrategyEntries(
    sessionUpgrade?.verification?.repair_strategy,
    sessionUpgrade?.takeover_audit?.recommended_action?.repair_strategy,
    sessionUpgrade?.host_takeover_audit?.recommended_action?.repair_strategy,
    sessionUpgrade?.profile_takeover_audit?.recommended_action?.repair_strategy
  );

  const configurationAll = dedupeStrategies(configurationStrategies);
  const sessionsAll = dedupeStrategies(upgradeStrategies);
  const all = dedupeStrategies([...configurationStrategies, ...upgradeStrategies]);

  return {
    configuration: {
      all: configurationAll,
      ...summarizeStrategyKinds(configurationAll)
    },
    sessions: {
      all: sessionsAll,
      ...summarizeStrategyKinds(sessionsAll)
    },
    all,
    ...summarizeStrategyKinds(all)
  };
}

function buildInstallVerification(configuration, sessionUpgrade) {
  const configurationVerification = configuration?.verification || null;
  const sessionUpgradeVerification = sessionUpgrade?.verification || null;
  const issues = [];
  let status = 'verified';
  let summary = 'Install recheck passed.';
  let recheckCommand = null;

  if (configurationVerification?.status === 'needs_attention') {
    status = 'needs_attention';
    issues.push('configuration_verification_failed');
    summary = configurationVerification.summary;
    recheckCommand = configurationVerification.recheck_command || recheckCommand;
  }

  if (sessionUpgradeVerification?.status === 'needs_attention') {
    status = 'needs_attention';
    issues.push('session_upgrade_verification_failed');
    summary = sessionUpgradeVerification.summary;
    recheckCommand = sessionUpgradeVerification.recheck_command || recheckCommand;
  }

  if (status === 'verified') {
    if (sessionUpgradeVerification) {
      summary = sessionUpgradeVerification.summary;
      recheckCommand = sessionUpgradeVerification.recheck_command || recheckCommand;
    } else if (configurationVerification) {
      summary = configurationVerification.summary;
      recheckCommand = configurationVerification.recheck_command || recheckCommand;
    }
  }

  const repairStrategies = extractInstallRepairStrategies(configuration, sessionUpgrade);

  return {
    status,
    summary,
    issues,
    recheck_command: recheckCommand,
    repair_strategies: repairStrategies,
    remediation_summary: {
      total: repairStrategies.all.length,
      status:
        repairStrategies.manual.length > 0
          ? 'manual_required'
          : repairStrategies.automatic.length > 0
          ? 'automatic_available'
          : 'none',
      automatic_count: repairStrategies.automatic.length,
      manual_count: repairStrategies.manual.length,
      automatic: repairStrategies.automatic,
      manual: repairStrategies.manual,
      next_step: repairStrategies.automatic[0] || repairStrategies.manual[0] || null,
      recheck_commands: [...new Set([
        configurationVerification?.recheck_command || null,
        sessionUpgradeVerification?.recheck_command || null
      ].filter(Boolean))]
    },
    readiness_transition: {
      configuration: configurationVerification?.readiness_transition || null,
      sessions: sessionUpgradeVerification?.readiness_transition || null
    }
  };
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
  const progress = options.progress;
  const shouldReportInstallStages = Boolean(options.upgradeSessions);
  if (shouldReportInstallStages) {
    emitProgress(progress, {
      type: 'install:start'
    });
  }

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
  if (shouldReportInstallStages) {
    emitProgress(progress, {
      type: 'install:assets:start'
    });
  }
  const install = runInstallHostAssets(openClawHome, skillsRoot);
  if (shouldReportInstallStages) {
    emitProgress(progress, {
      type: 'install:assets:done'
    });
    emitProgress(progress, {
      type: 'install:config:start'
    });
  }
  const configuration = await runConfigureHost(openClawHome, skillsRoot, {
    assumeYes,
    applyConfig: options.applyConfig,
    memoryTakeover: options.memoryTakeover,
    enableScheduler: options.enableScheduler,
    targetPlatform: options.targetPlatform,
    schedulerWorkspace: options.schedulerWorkspace,
    intervalMinutes: options.intervalMinutes,
    defaultUserId: options.defaultUserId,
    defaultWorkspace: options.defaultWorkspace,
    autoRegisterWorkspaces: options.autoRegisterWorkspaces,
    addUsers: options.addUsers,
    addWorkspaces: options.addWorkspaces,
    ask,
    askText: options.askText,
    schedulerRegistrar: options.schedulerRegistrar
  });
  if (shouldReportInstallStages) {
    const configurationStrategies = extractInstallRepairStrategies(configuration, null).configuration.all;
    emitProgress(progress, {
      type: 'install:config:done',
      status: configuration?.config?.status || configuration?.status || 'completed',
      strategy_labels: configurationStrategies.map(formatStrategyLabel).filter(Boolean)
    });
    if (configuration?.takeover_audit?.status && configuration.takeover_audit.status !== 'ok') {
      emitProgress(progress, {
        type: 'install:config:audit',
        status: configuration.takeover_audit.status,
        message: `[install] takeover audit: ${configuration.takeover_audit.summary}`
      });
    }
    if (configuration?.host_takeover_audit?.status && configuration.host_takeover_audit.status !== 'ok') {
      emitProgress(progress, {
        type: 'install:config:host-audit',
        status: configuration.host_takeover_audit.status,
        message: `[install] host audit: ${configuration.host_takeover_audit.summary}`
      });
    }
    if (configuration?.profile_takeover_audit?.status && configuration.profile_takeover_audit.status !== 'ok') {
      emitProgress(progress, {
        type: 'install:config:profile-audit',
        status: configuration.profile_takeover_audit.status,
        message: `[install] profile audit: ${configuration.profile_takeover_audit.summary}`
      });
    }
  }
  const upgradeRunGovernance =
    typeof options.runGovernance === 'boolean' ? options.runGovernance : options.upgradeSessions && preserveMemories !== false;
  const sessionUpgrade = options.upgradeSessions
    ? (emitProgress(progress, {
        type: 'install:upgrade:start'
      }),
      runUpgradeSessions(openClawHome, skillsRoot, {
        workspace: options.upgradeWorkspace,
        sessionKey: options.upgradeSessionKey,
        includeClosed: options.includeClosedSessions,
        rebuildMirror: preserveMemories !== false,
        runGovernance: upgradeRunGovernance,
        governanceMode: options.governanceMode,
        governancePrune: options.governancePrune,
        progress: (event) => {
          if (!progress) {
            return;
          }
          if (event.type === 'scan:start') {
            return;
          }
          if (event.type === 'scan:done') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] selected ${event.selected || 0} session(s) for processing`
            });
            return;
          }
          if (event.type === 'session:start') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] session ${event.index}/${event.total}: ${event.session_key}`
            });
            return;
          }
          if (event.type === 'session:done') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] session ${event.index}/${event.total}: ${event.action}${event.reason ? ` (${event.reason})` : ''}`
            });
            return;
          }
          if (event.type === 'mirror:start') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: '[upgrade] mirror rebuild: starting'
            });
            return;
          }
          if (event.type === 'mirror:done') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: '[upgrade] mirror rebuild: done'
            });
            return;
          }
          if (event.type === 'governance:start') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] governance: running ${event.total || 0} target(s)`
            });
            return;
          }
          if (event.type === 'governance:target:start') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] governance ${event.index}/${event.total}: ${event.session_key}`
            });
            return;
          }
          if (event.type === 'governance:target:done') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] governance ${event.index}/${event.total}: archived=${event.result?.totals?.archived || 0} pruned=${event.result?.totals?.pruned || 0}`
            });
            return;
          }
          if (event.type === 'finish') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] complete upgraded=${event.upgraded_sessions || 0} skipped=${event.skipped_sessions || 0} unresolved=${event.unresolved_sessions || 0}${event.strategy_label ? ` | strategy=${event.strategy_label}` : ''}`
            });
            return;
          }
          if (event.type === 'verification:strategy') {
            emitProgress(progress, {
              type: 'upgrade:forwarded',
              message: `[upgrade] verification strategy: ${event.label}${event.summary ? ` - ${event.summary}` : ''}`
            });
          }
        }
      }))
    : null;
  if (sessionUpgrade) {
    const upgradeStrategies = extractInstallRepairStrategies(null, sessionUpgrade).sessions.all;
    emitProgress(progress, {
      type: 'install:upgrade:done',
      upgraded_sessions: sessionUpgrade.upgraded_sessions,
      strategy_labels: upgradeStrategies.map(formatStrategyLabel).filter(Boolean)
    });
    if (sessionUpgrade?.takeover_audit?.status && sessionUpgrade.takeover_audit.status !== 'ok') {
      emitProgress(progress, {
        type: 'install:upgrade:audit',
        status: sessionUpgrade.takeover_audit.status,
        message: `[install] takeover audit: ${sessionUpgrade.takeover_audit.summary}`
      });
    }
    if (sessionUpgrade?.host_takeover_audit?.status && sessionUpgrade.host_takeover_audit.status !== 'ok') {
      emitProgress(progress, {
        type: 'install:upgrade:host-audit',
        status: sessionUpgrade.host_takeover_audit.status,
        message: `[install] host audit: ${sessionUpgrade.host_takeover_audit.summary}`
      });
    }
    if (sessionUpgrade?.profile_takeover_audit?.status && sessionUpgrade.profile_takeover_audit.status !== 'ok') {
      emitProgress(progress, {
        type: 'install:upgrade:profile-audit',
        status: sessionUpgrade.profile_takeover_audit.status,
        message: `[install] profile audit: ${sessionUpgrade.profile_takeover_audit.summary}`
      });
    }
  }
  const mirrorRebuild =
    !options.upgradeSessions && preserveMemories !== false && state.has_memory_data
      ? (emitProgress(progress, {
          type: 'install:mirror:start'
        }),
        runMirrorRebuild(options.upgradeWorkspace, openClawHome, {}))
      : null;
  if (mirrorRebuild) {
    emitProgress(progress, {
      type: 'install:mirror:done'
    });
  }

  return {
    status: 'installed',
    previous_install_detected: state.has_install_artifacts,
    previous_memory_detected: state.has_memory_data,
    preserved_memories: preserveMemories,
    install,
    configuration,
    session_upgrade: sessionUpgrade,
    mirror_rebuild: mirrorRebuild,
    verification: buildInstallVerification(configuration, sessionUpgrade),
    takeover_audit: sessionUpgrade?.takeover_audit || configuration?.takeover_audit || null,
    host_takeover_audit: sessionUpgrade?.host_takeover_audit || configuration?.host_takeover_audit || null,
    profile_takeover_audit: sessionUpgrade?.profile_takeover_audit || configuration?.profile_takeover_audit || null
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runOneClickInstall(options.openclawHome, options.skillsRoot, {
      ...options,
      progress: createCliProgressReporter(process.stderr)
    });
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
  createCliProgressReporter,
  detectExistingState,
  runOneClickInstall
};
