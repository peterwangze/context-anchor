#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createPaths, getOpenClawHome, readJson } = require('./lib/context-anchor');
const { getHostConfigFile, readHostConfig, summarizeHostConfig } = require('./lib/host-config');
const {
  classifyMemorySourceHealth,
  summarizeExternalMemorySources
} = require('./legacy-memory-sync');
const { buildRemediationSummary } = require('./lib/remediation-summary');
const { recordResumeSelections } = require('./lib/resume-preferences');
const {
  command,
  field,
  renderCliError,
  section,
  status
} = require('./lib/terminal-format');

function parseArgs(argv) {
  const options = {
    workspace: null,
    openclawHome: null,
    skillsRoot: null,
    json: false
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
      continue;
    }

    if (arg === '--json') {
      options.json = true;
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

function buildNpmScriptCommand(scriptName, options = {}) {
  const forwarded = [];

  if (options.workspace) {
    forwarded.push('--workspace', quoteArg(options.workspace));
  }
  if (options.projectId) {
    forwarded.push('--project-id', quoteArg(options.projectId));
  }
  if (options.openclawHome) {
    forwarded.push('--openclaw-home', quoteArg(options.openclawHome));
  }
  if (options.skillsRoot) {
    forwarded.push('--skills-root', quoteArg(options.skillsRoot));
  }
  if (options.applyConfig) {
    forwarded.push('--apply-config');
  }
  if (options.enforceMemoryTakeover) {
    forwarded.push('--enforce-memory-takeover');
  }
  if (options.yes) {
    forwarded.push('--yes');
  }

  return forwarded.length > 0
    ? `npm run ${scriptName} -- ${forwarded.join(' ')}`
    : `npm run ${scriptName}`;
}

function buildRepairSequence(command, followUpCommand, recheckCommand) {
  return [
    command ? { step: 'repair', command } : null,
    followUpCommand ? { step: 'follow_up', command: followUpCommand } : null,
    recheckCommand ? { step: 'recheck', command: recheckCommand } : null
  ].filter(Boolean);
}

function buildActionSequence(action = {}) {
  if (Array.isArray(action?.repair_sequence) && action.repair_sequence.length > 0) {
    return action.repair_sequence
      .map((entry) =>
        entry?.command
          ? {
              step: entry.step || 'repair',
              command: entry.command
            }
          : null
      )
      .filter(Boolean);
  }

  return buildRepairSequence(action?.command || null, action?.follow_up_command || null, action?.recheck_command || null);
}

function mergeRepairSequences(actions = [], recheckCommand = null) {
  const merged = [];
  const seen = new Set();

  actions.forEach((action) => {
    buildActionSequence(action)
      .filter((entry) => entry.step !== 'recheck')
      .forEach((entry) => {
        const key = `${entry.step}::${entry.command}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        merged.push(entry);
      });
  });

  if (recheckCommand) {
    merged.push({
      step: 'recheck',
      command: recheckCommand
    });
  }

  return merged;
}

function buildRepairStrategy(type, options = {}) {
  const workspace = options.workspace ? path.resolve(options.workspace) : null;
  const openclawHome = options.openClawHome || null;
  const skillsRoot = options.skillsRoot || null;
  switch (type) {
    case 'migrate_then_enforce_then_recheck':
      return {
        type,
        label: 'migrate -> enforce -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: workspace
          ? `First centralize external memory for ${workspace}, then enforce takeover, then rerun doctor.`
          : 'First centralize external memory, then enforce takeover, then rerun doctor.'
      };
    case 'migrate_then_recheck':
      return {
        type,
        label: 'migrate -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: workspace
          ? `Centralize external memory for ${workspace}, then rerun doctor.`
          : 'Centralize external memory, then rerun doctor.'
      };
    case 'enforce_then_recheck':
      return {
        type,
        label: 'enforce -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Apply enforced takeover for this profile, then rerun doctor.'
      };
    case 'configure_host_then_recheck':
      return {
        type,
        label: 'configure host -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair host configuration first, then rerun doctor.'
      };
    case 'repair_registered_workspaces_then_recheck':
      return {
        type,
        label: 'repair registered workspaces -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair the affected registered workspaces first, then rerun doctor.'
      };
    case 'repair_profile_family_then_recheck':
      return {
        type,
        label: 'repair profile family -> recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'Repair the affected OpenClaw profiles first, then rerun doctor.'
      };
    case 'review_workspace_then_recheck':
      return {
        type,
        label: 'review workspace -> recheck',
        execution_mode: 'manual',
        manual_subtype: 'external_environment',
        external_issue_type: 'workspace_registration_missing',
        requires_manual_confirmation: true,
        summary: 'Fix or remove the broken workspace registration, then rerun doctor.',
        resolution_hint:
          'This workspace is still registered in host config but is not present on disk. If it moved, update the registration to the new path. If it was removed, delete or replace the stale workspace entry.',
        command_examples: [
          buildNpmScriptCommand('configure:host', {
            workspace: '<new-workspace>',
            openclawHome,
            skillsRoot,
            applyConfig: true,
            yes: true
          }),
          buildNpmScriptCommand('doctor', {
            workspace: '<new-workspace>',
            openclawHome,
            skillsRoot
          })
        ]
      };
    case 'select_workspace_then_recheck':
      return {
        type,
        label: 'select workspace -> recheck',
        execution_mode: 'manual',
        manual_subtype: 'confirm_only',
        requires_manual_confirmation: true,
        summary: 'Pick the target workspace first, then rerun doctor.'
      };
    default:
      return {
        type: 'recheck_only',
        label: 'recheck',
        execution_mode: 'automatic',
        requires_manual_confirmation: false,
        summary: 'No repair action is required right now; rerun doctor when the environment changes.'
      };
  }
}

function normalizeWorkspaceKey(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function buildMemorySourceRecommendedAction(memorySourceHealth, options = {}) {
  const workspace = options.workspace ? path.resolve(options.workspace) : null;
  const recheckCommand = buildNpmScriptCommand('doctor', {
    workspace,
    openclawHome: options.openClawHome,
    skillsRoot: options.skillsRoot
  });

  if (memorySourceHealth.status === 'drift_detected') {
    const command = workspace
      ? buildNpmScriptCommand('migrate:memory', {
          workspace
        })
      : null;
    const followUpCommand =
      options.memoryTakeoverEnforced
        ? null
        : buildNpmScriptCommand('configure:host', {
            workspace,
            openClawHome: options.openClawHome,
            skillsRoot: options.skillsRoot,
            applyConfig: true,
            enforceMemoryTakeover: true,
            yes: true
          });
    return {
      type: 'sync_legacy_memory',
      summary: 'External memory sources changed after the last sync. Centralize them into context-anchor now.',
      command,
      follow_up_command: followUpCommand,
      recheck_command: recheckCommand,
      repair_sequence: buildRepairSequence(command, followUpCommand, recheckCommand),
      repair_strategy: buildRepairStrategy(
        followUpCommand ? 'migrate_then_enforce_then_recheck' : 'migrate_then_recheck',
        { workspace, openClawHome: options.openClawHome, skillsRoot: options.skillsRoot }
      )
    };
  }

  if (memorySourceHealth.status === 'best_effort') {
    const command = buildNpmScriptCommand('configure:host', {
      workspace,
      openClawHome: options.openClawHome,
      skillsRoot: options.skillsRoot,
      applyConfig: true,
      enforceMemoryTakeover: true,
      yes: true
    });
    return {
      type: 'enforce_memory_takeover',
      summary: 'Takeover is still best-effort. Enforce context-anchor takeover to reduce future bypass.',
      command,
      follow_up_command: null,
      recheck_command: recheckCommand,
      repair_sequence: buildRepairSequence(command, null, recheckCommand),
      repair_strategy: buildRepairStrategy('enforce_then_recheck', {
        workspace,
        openClawHome: options.openClawHome,
        skillsRoot: options.skillsRoot
      })
    };
  }

  return {
    type: 'none',
    summary: 'No repair action required.',
    command: null,
    follow_up_command: null,
    recheck_command: recheckCommand,
    repair_sequence: buildRepairSequence(null, null, recheckCommand),
    repair_strategy: buildRepairStrategy('recheck_only', { workspace })
  };
}

function collectHostAuditTargets(hostConfig, selectedWorkspace) {
  const targets = new Map();

  function upsertWorkspaceTarget(workspace, metadata = {}) {
    if (!workspace) {
      return;
    }

    const resolvedWorkspace = path.resolve(workspace);
    const key = normalizeWorkspaceKey(resolvedWorkspace);
    const previous = targets.get(key) || {
      workspace: resolvedWorkspace,
      selected: false,
      default: false,
      registered: false,
      user_id: null,
      project_id: null,
      updated_at: null
    };
    targets.set(key, {
      ...previous,
      ...metadata,
      workspace: resolvedWorkspace,
      selected: previous.selected || metadata.selected === true,
      default: previous.default || metadata.default === true,
      registered: previous.registered || metadata.registered === true,
      user_id: metadata.user_id || previous.user_id || null,
      project_id: metadata.project_id || previous.project_id || null,
      updated_at: metadata.updated_at || previous.updated_at || null
    });
  }

  upsertWorkspaceTarget(selectedWorkspace, {
    selected: Boolean(selectedWorkspace)
  });
  upsertWorkspaceTarget(hostConfig?.defaults?.workspace || null, {
    default: Boolean(hostConfig?.defaults?.workspace),
    registered: Boolean(hostConfig?.defaults?.workspace),
    user_id: hostConfig?.defaults?.user_id || null
  });

  (Array.isArray(hostConfig?.workspaces) ? hostConfig.workspaces : []).forEach((entry) => {
    upsertWorkspaceTarget(entry.workspace, {
      registered: true,
      user_id: entry.user_id || null,
      project_id: entry.project_id || null,
      updated_at: entry.updated_at || null
    });
  });

  return [...targets.values()].sort((left, right) => left.workspace.localeCompare(right.workspace));
}

function buildWorkspaceTakeoverInspection(target = {}, options = {}) {
  const workspace = target.workspace ? path.resolve(target.workspace) : null;

  if (!workspace) {
    return null;
  }

  if (!fs.existsSync(workspace)) {
    return {
      workspace,
      selected: Boolean(target.selected),
      default: Boolean(target.default),
      registered: Boolean(target.registered),
      exists: false,
      user_id: target.user_id || null,
      project_id: target.project_id || null,
      updated_at: target.updated_at || null,
      memory_sources: null,
      health: {
        status: 'workspace_missing',
        level: 'warning',
        memory_takeover_mode: options.memoryTakeoverMode,
        drift_detected: false,
        drift_reasons: [],
        summary: 'This workspace is registered in host config but is not present on disk.'
      },
      recommended_action: {
        type: 'review_workspace_registration',
        summary: 'Review this registered workspace path and update the host configuration if it moved or was removed.',
        command: null,
        follow_up_command: null,
        recheck_command: buildNpmScriptCommand('doctor', {
          workspace,
          openClawHome: options.openClawHome,
          skillsRoot: options.skillsRoot
        }),
        repair_sequence: buildRepairSequence(
          null,
          null,
          buildNpmScriptCommand('doctor', {
            workspace,
            openClawHome: options.openClawHome,
            skillsRoot: options.skillsRoot
          })
        ),
        repair_strategy: buildRepairStrategy('review_workspace_then_recheck', {
          workspace,
          openClawHome: options.openClawHome,
          skillsRoot: options.skillsRoot
        })
      }
    };
  }

  const memorySources = summarizeExternalMemorySources(workspace);
  const health = classifyMemorySourceHealth(memorySources, {
    memoryTakeoverMode: options.memoryTakeoverMode
  });

  return {
    workspace,
    selected: Boolean(target.selected),
    default: Boolean(target.default),
    registered: Boolean(target.registered),
    exists: true,
    user_id: target.user_id || null,
    project_id: target.project_id || null,
    updated_at: target.updated_at || null,
    memory_sources: memorySources,
    health,
    recommended_action: buildMemorySourceRecommendedAction(health, {
      workspace,
      openClawHome: options.openClawHome,
      skillsRoot: options.skillsRoot,
      memoryTakeoverEnforced: options.memoryTakeoverEnforced
    })
  };
}

function buildHostTakeoverAudit(options = {}) {
  const targets = collectHostAuditTargets(options.hostConfig || {}, options.selectedWorkspace || null);
  const workspaces = targets
    .map((target) =>
      buildWorkspaceTakeoverInspection(target, {
        openClawHome: options.openClawHome,
        skillsRoot: options.skillsRoot,
        memoryTakeoverMode: options.memoryTakeoverMode,
        memoryTakeoverEnforced: options.memoryTakeoverEnforced
      })
    )
    .filter(Boolean);

  const missingWorkspaceCount = workspaces.filter((entry) => entry.exists === false).length;
  const singleSourceCount = workspaces.filter((entry) => entry.health.status === 'single_source').length;
  const bestEffortCount = workspaces.filter((entry) => entry.health.status === 'best_effort').length;
  const driftCount = workspaces.filter((entry) => entry.health.status === 'drift_detected').length;
  const issues = [];
  let status = 'ok';
  let summary = 'All registered workspaces are aligned with the current takeover policy.';

  if (missingWorkspaceCount > 0) {
    issues.push('registered_workspace_missing');
    status = 'warning';
  }
  if (driftCount > 0) {
    issues.push(options.memoryTakeoverEnforced ? 'registered_workspace_drift' : 'registered_workspace_drift_best_effort');
    status = 'warning';
  }
  if (status !== 'warning' && options.memoryTakeoverEnforced !== true) {
    issues.push('best_effort_takeover');
    status = workspaces.length > 0 ? 'notice' : 'warning';
  }
  if (workspaces.length === 0) {
    issues.push('no_registered_workspaces');
    status = status === 'warning' ? status : 'notice';
    summary = 'No registered workspaces were found for host-level takeover audit.';
  } else if (status === 'warning') {
    const warningParts = [];
    if (driftCount > 0) {
      warningParts.push(`${driftCount} workspace(s) have external memory drift`);
    }
    if (missingWorkspaceCount > 0) {
      warningParts.push(`${missingWorkspaceCount} registered workspace path(s) are missing`);
    }
    summary = warningParts.join('; ') + '.';
  } else if (status === 'notice') {
    summary =
      options.memoryTakeoverEnforced === true
        ? 'Registered workspaces are present, but some host-audit details still need review.'
        : `${bestEffortCount} workspace(s) are still under best-effort takeover and may bypass context-anchor.`;
  }

  const firstProblem =
    workspaces.find((entry) => entry.health.status === 'drift_detected' || entry.health.status === 'workspace_missing') ||
    workspaces.find((entry) => entry.health.status === 'best_effort') ||
    null;
  const aggregateRecheckCommand = buildNpmScriptCommand('doctor', {
    workspace: options.selectedWorkspace || null,
    openClawHome: options.openClawHome,
    skillsRoot: options.skillsRoot
  });
  const autoFixableProblems = workspaces.filter((entry) => {
    if (entry.health.status === 'single_source') {
      return false;
    }
    const mode = entry.recommended_action?.repair_strategy?.execution_mode || 'automatic';
    return mode !== 'manual';
  });
  const hasManualProblems = workspaces.some((entry) => entry.recommended_action?.repair_strategy?.execution_mode === 'manual');
  const aggregateAutoAction =
    !hasManualProblems && autoFixableProblems.length > 1
      ? {
          type: 'repair_registered_workspaces',
          summary:
            driftCount > 0
              ? `Repair ${autoFixableProblems.length} registered workspace(s) with takeover drift, then rerun doctor.`
              : `Repair ${autoFixableProblems.length} registered workspace(s) under best-effort takeover, then rerun doctor.`,
          command: autoFixableProblems[0]?.recommended_action?.command || null,
          follow_up_command: autoFixableProblems[0]?.recommended_action?.follow_up_command || null,
          recheck_command: aggregateRecheckCommand,
          repair_sequence: mergeRepairSequences(
            autoFixableProblems.map((entry) => entry.recommended_action),
            aggregateRecheckCommand
          ),
          affected_targets: autoFixableProblems.map((entry) => entry.workspace),
          repair_strategy: buildRepairStrategy('repair_registered_workspaces_then_recheck', {
            workspace: options.selectedWorkspace || null,
            openClawHome: options.openClawHome,
            skillsRoot: options.skillsRoot
          }),
          workspace: null
        }
      : null;

  return {
    status,
    memory_takeover_mode: options.memoryTakeoverMode || 'best_effort',
    total_registered_workspaces: workspaces.length,
    missing_workspace_count: missingWorkspaceCount,
    single_source_workspaces: singleSourceCount,
    best_effort_workspaces: bestEffortCount,
    drift_workspaces: driftCount,
    issues,
    summary,
    recommended_action: aggregateAutoAction
      ? aggregateAutoAction
      : firstProblem
      ? {
          workspace: firstProblem.workspace,
          ...firstProblem.recommended_action
        }
      : {
          type: 'none',
          summary: 'No repair action required.',
          command: null,
          follow_up_command: null,
          recheck_command: buildNpmScriptCommand('doctor', {
            workspace: options.selectedWorkspace || null,
            openClawHome: options.openClawHome,
            skillsRoot: options.skillsRoot
          }),
          repair_sequence: buildRepairSequence(
            null,
            null,
            buildNpmScriptCommand('doctor', {
              workspace: options.selectedWorkspace || null,
              openClawHome: options.openClawHome,
              skillsRoot: options.skillsRoot
            })
          ),
          repair_strategy: buildRepairStrategy('recheck_only', {
            workspace: options.selectedWorkspace || null
          }),
          workspace: null
        },
    workspaces
  };
}

function resolveProfileFamilyPrefix(profileName) {
  if (profileName === '.openclaw' || String(profileName).startsWith('.openclaw-')) {
    return '.openclaw';
  }

  return String(profileName || '').trim();
}

function discoverPeerProfileHomes(openClawHome) {
  const resolvedHome = path.resolve(openClawHome);
  const parentDir = path.dirname(resolvedHome);
  const profileName = path.basename(resolvedHome);
  const profileFamilyPrefix = resolveProfileFamilyPrefix(profileName);

  if (!fs.existsSync(parentDir)) {
    return [resolvedHome];
  }

  const homes = fs.readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parentDir, entry.name))
    .filter((candidate) => {
      const candidateName = path.basename(candidate);
      if (normalizeWorkspaceKey(candidate) === normalizeWorkspaceKey(resolvedHome)) {
        return true;
      }

      if (!profileFamilyPrefix) {
        return false;
      }

      if (candidateName === profileFamilyPrefix || candidateName.startsWith(`${profileFamilyPrefix}-`)) {
        const hasOpenClawMarkers =
          fs.existsSync(path.join(candidate, 'openclaw.json')) ||
          fs.existsSync(getHostConfigFile(candidate)) ||
          fs.existsSync(path.join(candidate, 'skills')) ||
          fs.existsSync(path.join(candidate, 'hooks'));
        return hasOpenClawMarkers;
      }

      return false;
    })
    .sort((left, right) => left.localeCompare(right));

  return homes.length > 0 ? homes : [resolvedHome];
}

function detectInstalledSkillRoots(openClawHome, options = {}) {
  const configFile = path.join(openClawHome, 'openclaw.json');
  const config = readJson(configFile, null);
  const defaultManagedSkillsRoot = path.join(openClawHome, 'skills');
  const configuredExtraDirs = Array.isArray(config?.skills?.load?.extraDirs) ? config.skills.load.extraDirs : [];
  const candidateRoots = [
    options.skillsRoot ? path.resolve(options.skillsRoot) : null,
    defaultManagedSkillsRoot,
    ...configuredExtraDirs.map((entry) => path.resolve(entry))
  ].filter(Boolean);
  const seen = new Set();
  const installedRoots = [];

  for (const root of candidateRoots) {
    const normalized = normalizeWorkspaceKey(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (fs.existsSync(path.join(root, 'context-anchor', 'SKILL.md'))) {
      installedRoots.push(root);
    }
  }

  return {
    config,
    default_managed_skills_root: defaultManagedSkillsRoot,
    installed_skill_roots: installedRoots,
    configured_extra_dirs: configuredExtraDirs
  };
}

function inspectProfileTakeoverState(openClawHome, options = {}) {
  const resolvedHome = path.resolve(openClawHome);
  const skillRoots = detectInstalledSkillRoots(resolvedHome, {
    skillsRoot: options.skillsRoot || null
  });
  const config = skillRoots.config;
  const hostConfig = readHostConfig(resolvedHome);
  const hooks = config?.hooks || {};
  const preferredSkillsRoot =
    (options.selected && options.skillsRoot ? path.resolve(options.skillsRoot) : null) ||
    skillRoots.installed_skill_roots[0] ||
    skillRoots.default_managed_skills_root;
  const installation = {
    config_exists: fs.existsSync(path.join(resolvedHome, 'openclaw.json')),
    host_config_exists: fs.existsSync(getHostConfigFile(resolvedHome)),
    skill_snapshot_exists: skillRoots.installed_skill_roots.length > 0,
    hook_wrapper_exists: fs.existsSync(path.join(resolvedHome, 'hooks', 'context-anchor-hook', 'handler.js')),
    monitor_wrapper_exists: fs.existsSync(
      path.join(resolvedHome, 'automation', 'context-anchor', 'context-pressure-monitor.js')
    ),
    workspace_monitor_wrapper_exists: fs.existsSync(
      path.join(resolvedHome, 'automation', 'context-anchor', 'workspace-monitor.js')
    ),
    detected_skill_roots: skillRoots.installed_skill_roots
  };
  installation.ready =
    installation.config_exists &&
    installation.skill_snapshot_exists &&
    installation.hook_wrapper_exists &&
    installation.monitor_wrapper_exists &&
    installation.workspace_monitor_wrapper_exists;

  const configuration = {
    internal_hooks_enabled: hooks?.internal?.enabled === true,
    memory_takeover_mode: hostConfig.onboarding.memory_takeover_mode || 'best_effort',
    memory_takeover_enforced: (hostConfig.onboarding.memory_takeover_mode || 'best_effort') === 'enforced'
  };
  configuration.ready = installation.ready && configuration.internal_hooks_enabled;

  const hostTakeoverAudit = buildHostTakeoverAudit({
    hostConfig,
    selectedWorkspace: hostConfig.defaults.workspace || null,
    openClawHome: resolvedHome,
    skillsRoot: preferredSkillsRoot,
    memoryTakeoverMode: configuration.memory_takeover_mode,
    memoryTakeoverEnforced: configuration.memory_takeover_enforced
  });

  let status = 'ok';
  let summary = 'Profile takeover is aligned.';
  let recommendedAction = {
    type: 'none',
    summary: 'No repair action required.',
    command: null,
    follow_up_command: null
  };
  const issues = [];

  if (!configuration.ready) {
    status = 'warning';
    summary = 'This profile is not fully configured for context-anchor takeover.';
    issues.push('profile_not_ready');
    recommendedAction = {
      type: 'configure_host',
      summary: 'Apply the recommended host configuration for this profile.',
      command: buildNpmScriptCommand('configure:host', {
        openClawHome: resolvedHome,
        skillsRoot: preferredSkillsRoot,
        applyConfig: true,
        enforceMemoryTakeover: true,
        yes: true
      }),
      follow_up_command: null
    };
  } else if (hostTakeoverAudit.status === 'warning') {
    status = 'warning';
    summary = hostTakeoverAudit.summary;
    issues.push(...hostTakeoverAudit.issues);
    recommendedAction = hostTakeoverAudit.recommended_action || recommendedAction;
  } else if (configuration.memory_takeover_enforced !== true) {
    status = 'notice';
    summary = 'This profile is still in best-effort takeover mode.';
    issues.push('best_effort_takeover');
    recommendedAction = {
      type: 'enforce_memory_takeover',
      summary: 'Enforce context-anchor takeover for this profile.',
      command: buildNpmScriptCommand('configure:host', {
        openClawHome: resolvedHome,
        skillsRoot: preferredSkillsRoot,
        applyConfig: true,
        enforceMemoryTakeover: true,
        yes: true
      }),
      follow_up_command: null
    };
  } else if (hostTakeoverAudit.status === 'notice') {
    status = 'notice';
    summary = hostTakeoverAudit.summary;
    issues.push(...hostTakeoverAudit.issues);
    recommendedAction = hostTakeoverAudit.recommended_action || recommendedAction;
  }

  return {
    openclaw_home: resolvedHome,
    selected: Boolean(options.selected),
    installation,
    configuration,
    host_takeover_audit: hostTakeoverAudit,
    status,
    summary,
    issues,
    recommended_action: recommendedAction
  };
}

function buildProfileTakeoverAudit(options = {}) {
  const profiles = discoverPeerProfileHomes(options.openClawHome)
    .map((profileHome) =>
      inspectProfileTakeoverState(profileHome, {
        selected: normalizeWorkspaceKey(profileHome) === normalizeWorkspaceKey(options.openClawHome),
        skillsRoot:
          normalizeWorkspaceKey(profileHome) === normalizeWorkspaceKey(options.openClawHome)
            ? options.skillsRoot || null
            : null
      })
    );

  const warningProfiles = profiles.filter((entry) => entry.status === 'warning').length;
  const noticeProfiles = profiles.filter((entry) => entry.status === 'notice').length;
  const enforcedProfiles = profiles.filter((entry) => entry.configuration.memory_takeover_enforced === true).length;
  const driftProfiles = profiles.filter((entry) => entry.host_takeover_audit.drift_workspaces > 0).length;
  const notReadyProfiles = profiles.filter((entry) => entry.issues.includes('profile_not_ready')).length;
  const issues = [];
  let status = 'ok';
  let summary = 'All discovered profiles are aligned with the current takeover policy.';

  if (warningProfiles > 0) {
    status = 'warning';
    if (notReadyProfiles > 0) {
      issues.push('peer_profile_not_ready');
    }
    if (driftProfiles > 0) {
      issues.push('peer_profile_drift');
    }
    summary = `${warningProfiles} profile(s) need attention across the current profile family.`;
  } else if (noticeProfiles > 0) {
    status = 'notice';
    issues.push('peer_profile_best_effort');
    summary = `${noticeProfiles} profile(s) are still running in best-effort takeover mode.`;
  }

  const firstProblem = profiles.find((entry) => entry.status === 'warning' || entry.status === 'notice') || null;
  const aggregateRecheckCommand = buildNpmScriptCommand('doctor', {
    openClawHome: options.openClawHome,
    skillsRoot: options.skillsRoot
  });
  const autoFixableProfiles = profiles.filter((entry) => {
    const mode = entry.recommended_action?.repair_strategy?.execution_mode || 'automatic';
    return entry.status !== 'ok' && mode !== 'manual';
  });
  const hasManualProfiles = profiles.some(
    (entry) => entry.status !== 'ok' && entry.recommended_action?.repair_strategy?.execution_mode === 'manual'
  );
  const aggregateAutoAction =
    !hasManualProfiles && autoFixableProfiles.length > 1
      ? {
          openclaw_home: null,
          type: 'repair_profile_family',
          summary: `Repair ${autoFixableProfiles.length} affected OpenClaw profile(s), then rerun doctor.`,
          command: autoFixableProfiles[0]?.recommended_action?.command || null,
          follow_up_command: autoFixableProfiles[0]?.recommended_action?.follow_up_command || null,
          recheck_command: aggregateRecheckCommand,
          repair_sequence: mergeRepairSequences(
            autoFixableProfiles.map((entry) => entry.recommended_action),
            aggregateRecheckCommand
          ),
          affected_targets: autoFixableProfiles.map((entry) => entry.openclaw_home),
          repair_strategy: buildRepairStrategy('repair_profile_family_then_recheck', {
            openClawHome: options.openClawHome,
            skillsRoot: options.skillsRoot
          })
        }
      : null;

  return {
    status,
    total_profiles: profiles.length,
    warning_profiles: warningProfiles,
    notice_profiles: noticeProfiles,
    enforced_profiles: enforcedProfiles,
    drift_profiles: driftProfiles,
    not_ready_profiles: notReadyProfiles,
    issues,
    summary,
    recommended_action: aggregateAutoAction
      ? aggregateAutoAction
      : firstProblem
      ? {
          openclaw_home: firstProblem.openclaw_home,
          ...firstProblem.recommended_action
        }
      : {
          type: 'none',
          summary: 'No repair action required.',
          command: null,
          follow_up_command: null,
          recheck_command: buildNpmScriptCommand('doctor', {
            openClawHome: options.openClawHome,
            skillsRoot: options.skillsRoot
          }),
          repair_sequence: buildRepairSequence(
            null,
            null,
            buildNpmScriptCommand('doctor', {
              openClawHome: options.openClawHome,
              skillsRoot: options.skillsRoot
            })
          ),
          repair_strategy: buildRepairStrategy('recheck_only', {}),
          openclaw_home: null
        },
    profiles
  };
}

function buildTakeoverAudit(doctorResult = {}) {
  const mode = doctorResult?.configuration?.memory_takeover_mode || 'best_effort';
  const workspace = doctorResult?.paths?.workspace || null;
  const issues = [];
  let status = 'ok';
  let summary = 'Takeover audit passed.';
  let recommendedAction = {
    type: 'none',
    summary: 'No repair action required.',
    command: null,
    follow_up_command: null
  };

  if (!doctorResult?.installation?.ready || !doctorResult?.configuration?.ready) {
    const command = doctorResult?.commands?.configure || null;
    issues.push('profile_not_ready');
    status = 'warning';
    summary = 'The OpenClaw profile is not fully configured for context-anchor takeover yet.';
    recommendedAction = {
      type: 'configure_host',
      summary: 'Apply the recommended host configuration before relying on takeover.',
      command,
      follow_up_command: null,
      recheck_command: buildNpmScriptCommand('doctor', {
        workspace,
        openClawHome: doctorResult?.paths?.openclaw_home || null,
        skillsRoot: doctorResult?.paths?.skills_root || null
      }),
      repair_sequence: buildRepairSequence(
        command,
        null,
        buildNpmScriptCommand('doctor', {
          workspace,
          openClawHome: doctorResult?.paths?.openclaw_home || null,
          skillsRoot: doctorResult?.paths?.skills_root || null
        })
      ),
      repair_strategy: buildRepairStrategy('configure_host_then_recheck', {
        workspace,
        openClawHome: doctorResult?.paths?.openclaw_home || null,
        skillsRoot: doctorResult?.paths?.skills_root || null
      })
    };
  } else if (!workspace) {
    issues.push('workspace_audit_missing');
    status = 'notice';
    summary = 'Profile takeover is configured, but no workspace was selected for external drift audit.';
    recommendedAction = {
      type: 'select_workspace',
      summary: 'Provide --workspace or configure a default workspace before running the next audit.',
      command: null,
      follow_up_command: null,
      recheck_command: buildNpmScriptCommand('doctor', {
        workspace: '<workspace>',
        openClawHome: doctorResult?.paths?.openclaw_home || null,
        skillsRoot: doctorResult?.paths?.skills_root || null
      }),
      repair_sequence: [],
      repair_strategy: buildRepairStrategy('select_workspace_then_recheck', {
        openClawHome: doctorResult?.paths?.openclaw_home || null,
        skillsRoot: doctorResult?.paths?.skills_root || null
      })
    };
  } else if (doctorResult?.memory_sources?.health?.status === 'drift_detected') {
    issues.push(mode === 'enforced' ? 'enforced_mode_external_drift' : 'best_effort_external_drift');
    status = 'warning';
    summary =
      mode === 'enforced'
        ? 'Takeover is enforced, but external memory files changed after the last central sync.'
        : 'External memory files changed after the last central sync while takeover is still best-effort.';
    recommendedAction = doctorResult.memory_sources.recommended_action || recommendedAction;
  } else if (mode !== 'enforced') {
    issues.push('best_effort_takeover');
    status = 'notice';
    summary = 'Profile is still in best-effort takeover mode, so some model or profile paths may bypass context-anchor.';
    recommendedAction = doctorResult?.memory_sources?.recommended_action || recommendedAction;
  } else {
    summary =
      doctorResult?.memory_sources?.health?.status === 'single_source'
        ? 'Enforced takeover is consistent and no external drift is currently detected.'
        : 'Enforced takeover is configured.';
  }

  return {
    status,
    workspace,
    memory_takeover_mode: mode,
    issues,
    summary,
    external_source_count: doctorResult?.memory_sources?.external_source_count ?? null,
    last_legacy_sync_at: doctorResult?.memory_sources?.last_legacy_sync_at || null,
    recommended_action: recommendedAction
  };
}

function runTakeoverAudit(options = {}) {
  return buildTakeoverAudit(runDoctor(options));
}

function runHostTakeoverAudit(options = {}) {
  return runDoctor(options).host_takeover_audit;
}

function runProfileTakeoverAudit(options = {}) {
  return runDoctor(options).profile_takeover_audit;
}

function renderDoctorRemediationSummary(remediationSummary = {}) {
  const lines = [];
  const remediationStatus = String(remediationSummary.status || 'none').toUpperCase();
  const remediationKind =
    remediationSummary.status === 'warning'
      ? 'warning'
      : remediationSummary.manual_count > 0
      ? 'warning'
      : remediationSummary.automatic_count > 0
      ? 'info'
      : 'success';
  lines.push(
    field(
      'Remediation',
      `${status(remediationStatus, remediationKind)} | auto=${Number(remediationSummary.automatic_count || 0)} | manual=${Number(remediationSummary.manual_count || 0)}`,
      { kind: remediationKind }
    )
  );
  lines.push(
    field(
      'Manual split',
      `confirm=${Number(remediationSummary.manual_confirm_only_count || 0)} | external-env=${Number(remediationSummary.manual_external_environment_count || 0)}`,
      { kind: 'muted' }
    )
  );
  const externalIssueTypes = remediationSummary.manual_external_issue_types || {};
  const externalIssueSummary = Object.entries(externalIssueTypes)
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');
  if (externalIssueSummary) {
    lines.push(field('External issues', externalIssueSummary, { kind: 'warning' }));
  }
  const firstExternalManual = Array.isArray(remediationSummary.manual_external_environment)
    ? remediationSummary.manual_external_environment[0]
    : null;
  if (remediationSummary.next_step?.label) {
    const mode = remediationSummary.next_step.execution_mode === 'manual' ? 'manual' : 'auto';
    const subtype =
      remediationSummary.next_step.execution_mode === 'manual'
        ? remediationSummary.next_step.manual_subtype === 'external_environment'
          ? remediationSummary.next_step.external_issue_type === 'workspace_registration_missing'
            ? '/external-env/workspace-registration'
            : remediationSummary.next_step.external_issue_type === 'workspace_path_unresolved'
            ? '/external-env/workspace-path'
            : '/external-env'
          : '/confirm'
        : '';
    lines.push(
      field(
        'Next step',
        `[${mode}${subtype}] ${remediationSummary.next_step.label}` +
          `${remediationSummary.next_step.summary ? ` - ${remediationSummary.next_step.summary}` : ''}`,
        { kind: remediationSummary.next_step.execution_mode === 'manual' ? 'warning' : 'info' }
      )
    );
    if (remediationSummary.next_step.affected_targets_summary) {
      lines.push(field('Affected targets', remediationSummary.next_step.affected_targets_summary, { kind: 'muted' }));
    }
    if (remediationSummary.next_step.resolution_hint) {
      lines.push(field('Guidance', remediationSummary.next_step.resolution_hint, { kind: 'muted' }));
    }
    if (
      remediationSummary.next_step.execution_mode !== 'manual' &&
      Array.isArray(remediationSummary.next_step.command_sequence) &&
      remediationSummary.next_step.command_sequence.length > 0
    ) {
      lines.push(
        field(
          'Auto fix',
          remediationSummary.next_step.command_sequence
            .map((entry, index) => `${index + 1}) ${entry.step}: ${command(entry.command)}`)
            .join(' | '),
          { kind: 'command' }
        )
      );
    }
    if (remediationSummary.next_step.auto_fix_command) {
      lines.push(field('Auto fix command', command(remediationSummary.next_step.auto_fix_command), { kind: 'command' }));
    } else if (remediationSummary.next_step.auto_fix_blocked_reason) {
      lines.push(field('Auto fix unavailable', remediationSummary.next_step.auto_fix_blocked_reason, { kind: 'warning' }));
      if (remediationSummary.next_step.auto_fix_resume_hint) {
        lines.push(field('Auto fix resume', remediationSummary.next_step.auto_fix_resume_hint, { kind: 'muted' }));
      }
      if (remediationSummary.next_step.auto_fix_resume_command) {
        lines.push(field('Resume command', command(remediationSummary.next_step.auto_fix_resume_command), { kind: 'command' }));
      }
      if (remediationSummary.next_step.auto_fix_resume_suggested_command) {
        lines.push(field('Suggested resume', command(remediationSummary.next_step.auto_fix_resume_suggested_command), { kind: 'command' }));
      }
      if (remediationSummary.next_step.auto_fix_resume_suggested_inputs_summary) {
        lines.push(field('Suggested inputs', remediationSummary.next_step.auto_fix_resume_suggested_inputs_summary, { kind: 'muted' }));
      }
      if (remediationSummary.next_step.auto_fix_resume_validation_summary) {
        lines.push(field(
          'Resume checks',
          remediationSummary.next_step.auto_fix_resume_validation_summary,
          {
            kind:
              remediationSummary.next_step.auto_fix_resume_validation_status === 'ready'
                ? 'success'
                : 'warning'
          }
        ));
      }
      if (remediationSummary.next_step.auto_fix_resume_suggested_validation_summary) {
        lines.push(field(
          'Suggested checks',
          remediationSummary.next_step.auto_fix_resume_suggested_validation_summary,
          {
            kind:
              remediationSummary.next_step.auto_fix_resume_suggested_validation_status === 'ready'
                ? 'success'
                : 'warning'
          }
        ));
      }
      if (Array.isArray(remediationSummary.next_step.auto_fix_resume_missing_inputs) && remediationSummary.next_step.auto_fix_resume_missing_inputs.length > 0) {
        lines.push(field('Resume inputs', remediationSummary.next_step.auto_fix_resume_missing_inputs.join(', '), { kind: 'warning' }));
      }
      if (Array.isArray(remediationSummary.next_step.auto_fix_resume_input_details) && remediationSummary.next_step.auto_fix_resume_input_details.length > 0) {
        remediationSummary.next_step.auto_fix_resume_input_details.forEach((entry) => {
          lines.push(field(`Input ${entry.label}`, `${entry.description}${entry.validation_summary ? ` | check=${entry.validation_summary}` : ''}${entry.example ? ` | example=${entry.example}` : ''}`, { kind: 'muted' }));
          if (Array.isArray(entry.candidates) && entry.candidates.length > 0) {
            lines.push(field(`Input ${entry.label} options`, entry.candidates.join(' | '), { kind: 'muted' }));
          }
        });
      }
    }
    if (Array.isArray(remediationSummary.next_step.command_examples) && remediationSummary.next_step.command_examples.length > 0) {
      lines.push(field('Example command', command(remediationSummary.next_step.command_examples[0]), { kind: 'command' }));
    }
  }
  if (firstExternalManual?.resolution_hint) {
    lines.push(field('Guidance', firstExternalManual.resolution_hint, { kind: 'muted' }));
  }
  if (Array.isArray(firstExternalManual?.command_examples) && firstExternalManual.command_examples.length > 0) {
    lines.push(field('Example command', command(firstExternalManual.command_examples[0]), { kind: 'command' }));
  }
  if (Array.isArray(remediationSummary.recheck_commands) && remediationSummary.recheck_commands.length > 0) {
    lines.push(field('Recheck', command(remediationSummary.recheck_commands[0]), { kind: 'command' }));
  }
  return lines;
}

function renderDoctorReport(report) {
  const lines = [];
  const reportStatus = String(report.status || 'unknown').toUpperCase();
  const reportKind =
    report.status === 'warning'
      ? 'warning'
      : report.status === 'notice'
      ? 'info'
      : report.status === 'ok'
      ? 'success'
      : 'muted';
  const takeoverLabel =
    String(report.configuration.memory_takeover_mode || 'best_effort').toLowerCase() === 'best_effort'
      ? 'BEST EFFORT'
      : String(report.configuration.memory_takeover_mode || 'best_effort').replace(/_/g, ' ').toUpperCase();
  const memoryHealthLabel =
    String(report.memory_sources.health?.status || 'unknown').toLowerCase() === 'single_source'
      ? 'SINGLE SOURCE'
      : String(report.memory_sources.health?.status || 'unknown').toLowerCase() === 'best_effort'
      ? 'BEST EFFORT'
      : String(report.memory_sources.health?.status || 'unknown').toLowerCase() === 'drift_detected'
      ? 'DRIFT DETECTED'
      : String(report.memory_sources.health?.status || 'unknown').replace(/_/g, ' ').toUpperCase();
  lines.push(section('Context-Anchor Doctor'));
  lines.push(field('Platform', report.platform_label, { kind: 'muted' }));
  lines.push(field('Status', status(reportStatus, reportKind), { kind: reportKind }));
  lines.push(
    field(
      'Readiness',
      `Installation ${status(report.installation.ready ? 'READY' : 'NOT READY', report.installation.ready ? 'success' : 'warning')} | ` +
        `Configuration ${status(report.configuration.ready ? 'READY' : 'NOT READY', report.configuration.ready ? 'success' : 'warning')} | ` +
        `Takeover ${status(takeoverLabel, report.configuration.memory_takeover_enforced ? 'success' : 'warning')}`,
      { kind: report.installation.ready && report.configuration.ready ? 'success' : 'warning' }
    )
  );
  lines.push(
    field(
      'Workspace',
      `${report.paths.workspace || 'not selected'} | Memory health ${status(memoryHealthLabel, report.memory_sources.health?.status === 'drift_detected' ? 'warning' : report.memory_sources.health?.status === 'single_source' ? 'success' : 'info')}`,
      { kind: report.paths.workspace ? 'info' : 'muted' }
    )
  );
  lines.push(
    field(
      'Audits',
      `Host ${status(String(report.host_takeover_audit.status || 'unknown').toUpperCase(), report.host_takeover_audit.status === 'warning' ? 'warning' : report.host_takeover_audit.status === 'ok' ? 'success' : 'info')} | ` +
        `Profile ${status(String(report.profile_takeover_audit.status || 'unknown').toUpperCase(), report.profile_takeover_audit.status === 'warning' ? 'warning' : report.profile_takeover_audit.status === 'ok' ? 'success' : 'info')}`,
      { kind: report.host_takeover_audit.status === 'warning' || report.profile_takeover_audit.status === 'warning' ? 'warning' : 'info' }
    )
  );
  lines.push(...renderDoctorRemediationSummary(report.remediation_summary));
  lines.push('');
  lines.push(field('Config path', report.paths.config_file, { kind: 'muted' }));
  lines.push(field('Configure command', command(report.commands.configure), { kind: 'command' }));
  if (report.commands.sync_legacy_memory) {
    lines.push(field('Sync command', command(report.commands.sync_legacy_memory), { kind: 'command' }));
  }
  return lines.join('\n');
}

function summarizeDoctorRunStatus({
  installation,
  configuration,
  memorySourceHealth,
  hostTakeoverAudit,
  profileTakeoverAudit
}) {
  const memoryStatus = String(memorySourceHealth?.status || 'unknown').toLowerCase();
  const hostStatus = String(hostTakeoverAudit?.status || 'unknown').toLowerCase();
  const profileStatus = String(profileTakeoverAudit?.status || 'unknown').toLowerCase();

  if (!installation?.ready || !configuration?.ready) {
    return 'warning';
  }

  if (memoryStatus === 'drift_detected' || hostStatus === 'warning' || profileStatus === 'warning') {
    return 'warning';
  }

  if (memoryStatus === 'best_effort' || memoryStatus === 'unknown' || hostStatus === 'notice' || profileStatus === 'notice') {
    return 'notice';
  }

  return 'ok';
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
  const externalMemoryWatchScript = path.join(
    openClawHome,
    'automation',
    'context-anchor',
    'external-memory-watch.js'
  );
  const userDataRoot = path.join(openClawHome, 'context-anchor', 'users', 'default-user');
  const hostConfigFile = getHostConfigFile(openClawHome);
  const config = readJson(configFile, null);
  const hostConfig = readHostConfig(openClawHome);
  const registeredWorkspaceCandidates = [
    hostConfig.defaults?.workspace || null,
    ...(Array.isArray(hostConfig.workspaces) ? hostConfig.workspaces.map((entry) => entry.workspace) : [])
  ].filter(Boolean);
  const extraDirs = Array.isArray(config?.skills?.load?.extraDirs) ? config.skills.load.extraDirs : [];
  const hooks = config?.hooks || {};
  const workspace = options.workspace
    ? path.resolve(options.workspace)
    : hostConfig.defaults.workspace
      ? path.resolve(hostConfig.defaults.workspace)
      : null;
  const doctorPaths = createPaths(workspace || process.cwd());
  const resumePreferences = hostConfig.defaults?.user_id
    ? recordResumeSelections(doctorPaths, hostConfig.defaults.user_id, {
        workspace,
        'openclaw-home': openClawHome,
        'skills-root': skillsRoot
      })
    : null;
  const skillsRootRegistrationRequired = path.resolve(skillsRoot) !== path.resolve(defaultManagedSkillsRoot);

  const installation = {
    config_exists: fs.existsSync(configFile),
    legacy_config_present: fs.existsSync(legacyConfigFile),
    skill_snapshot_exists: fs.existsSync(path.join(installedSkillDir, 'SKILL.md')),
    hook_wrapper_exists: fs.existsSync(hookHandler),
    monitor_wrapper_exists: fs.existsSync(monitorScript),
    workspace_monitor_wrapper_exists: fs.existsSync(workspaceMonitorScript),
    external_memory_watch_wrapper_exists: fs.existsSync(externalMemoryWatchScript),
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
    auto_workspace_registration_enabled: hostConfig.onboarding.auto_register_workspaces !== false,
    memory_takeover_mode: hostConfig.onboarding.memory_takeover_mode || 'best_effort',
    memory_takeover_enforced: (hostConfig.onboarding.memory_takeover_mode || 'best_effort') === 'enforced'
  };
  configuration.ready = configuration.internal_hooks_enabled && configuration.extra_skill_dir_registered;
  configuration.missing = Object.entries(configuration)
    .filter(
      ([key, value]) =>
        !['ready', 'missing', 'memory_takeover_mode', 'memory_takeover_enforced'].includes(key) && value !== true
    )
    .map(([key]) => key);
  const memorySources = workspace
    ? summarizeExternalMemorySources(workspace)
    : {
        workspace: null,
        state_file: null,
        canonical_source: 'context-anchor',
        total_source_count: 1,
        external_source_count: null,
        tracked_source_count: 0,
        synced_source_count: 0,
        never_synced_source_count: 0,
        changed_source_count: 0,
        unsynced_source_count: 0,
        last_legacy_sync_at: null,
        sync_status: 'workspace_required',
        sources: []
      };
  const memorySourceHealth = workspace
    ? classifyMemorySourceHealth(memorySources, {
        memoryTakeoverMode: configuration.memory_takeover_mode
      })
    : {
        status: 'workspace_required',
        level: 'notice',
        memory_takeover_mode: configuration.memory_takeover_mode,
        drift_detected: false,
        drift_reasons: [],
        summary: 'Provide --workspace or configure a default workspace to inspect external memory drift.'
      };
  const memorySourceAction = buildMemorySourceRecommendedAction(memorySourceHealth, {
    workspace,
    openClawHome,
    skillsRoot,
    memoryTakeoverEnforced: configuration.memory_takeover_enforced
  });
  const hostTakeoverAudit = buildHostTakeoverAudit({
    hostConfig,
    selectedWorkspace: workspace,
    openClawHome,
    skillsRoot,
    memoryTakeoverMode: configuration.memory_takeover_mode,
    memoryTakeoverEnforced: configuration.memory_takeover_enforced
  });
  const profileTakeoverAudit = buildProfileTakeoverAudit({
    openClawHome,
    skillsRoot
  });

  return {
    status: summarizeDoctorRunStatus({
      installation,
      configuration,
      memorySourceHealth,
      hostTakeoverAudit,
      profileTakeoverAudit
    }),
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
      external_memory_watch_script: externalMemoryWatchScript,
      host_config_file: hostConfigFile,
      user_data_root: userDataRoot,
      workspace
    },
    installation,
    configuration,
    memory_sources: {
      ...memorySources,
      health: memorySourceHealth,
      recommended_action: memorySourceAction
    },
    host_takeover_audit: hostTakeoverAudit,
    profile_takeover_audit: profileTakeoverAudit,
    ownership: summarizeHostConfig(hostConfig),
    commands: {
      install: `node ${quoteArg(path.join(__dirname, 'install-one-click.js'))}`,
      configure: `node ${quoteArg(path.join(__dirname, 'configure-host.js'))}`,
      sync_legacy_memory: workspace
        ? buildNpmScriptCommand('migrate:memory', {
            workspace
          })
        : buildNpmScriptCommand('migrate:memory', {
            workspace: '<workspace>'
          }),
      rebuild_mirror: `node ${quoteArg(path.join(__dirname, 'mirror-rebuild.js'))}${
        workspace ? ` --workspace ${quoteArg(workspace)}` : ''
      }`,
      hook_with_payload_file: `node ${quoteArg(hookHandler)} heartbeat ${quoteArg(
        process.platform === 'win32' ? '.\\context-anchor-payload.json' : './context-anchor-payload.json'
      )}`,
      workspace_monitor: `node ${quoteArg(workspaceMonitorScript)} ${quoteArg(workspace || '<workspace>')}`,
      external_memory_watch: `node ${quoteArg(externalMemoryWatchScript)} ${quoteArg(
        workspace || '<workspace>'
      )} ${quoteArg('external-memory-watch')} ${quoteArg('<project-id>')} 800`,
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
      'By default, context-anchor automatically registers first-seen workspaces with the default user and workspace basename project id; disable this in configure-host if you want manual approval instead.',
      'Use the external memory watcher when you want faster-than-scheduler centralization after MEMORY.md or memory/*.md changes.',
      hostTakeoverAudit.total_registered_workspaces > 0
        ? `Host takeover audit inspected ${hostTakeoverAudit.total_registered_workspaces} workspace(s): single_source=${hostTakeoverAudit.single_source_workspaces}, best_effort=${hostTakeoverAudit.best_effort_workspaces}, drift=${hostTakeoverAudit.drift_workspaces}, missing=${hostTakeoverAudit.missing_workspace_count}.`
        : 'Host takeover audit did not find any registered workspaces yet.',
      `Profile takeover audit inspected ${profileTakeoverAudit.total_profiles} profile(s): enforced=${profileTakeoverAudit.enforced_profiles}, warning=${profileTakeoverAudit.warning_profiles}, notice=${profileTakeoverAudit.notice_profiles}, drift=${profileTakeoverAudit.drift_profiles}.`,
      workspace
        ? `Memory drift check inspected workspace ${workspace}.`
        : 'Memory drift check is skipped until you provide --workspace or configure a default workspace.',
      configuration.memory_takeover_enforced
        ? 'Memory takeover is enforced for this profile: context-anchor is the intended canonical memory manager.'
        : 'Memory takeover is NOT enforced for this profile: some models or profiles may still manage their own memory files, which can fragment memory and weaken continuity.'
    ],
    remediation_summary: buildRemediationSummary(
      [
        {
          source: 'memory_sources',
          action: {
            ...memorySourceAction,
            resume_context: {
              workspace,
              userId: hostConfig.defaults?.user_id || null,
              openClawHome,
              skillsRoot,
              candidateWorkspaces: registeredWorkspaceCandidates,
              resumePreferences
            }
          }
        },
        {
          source: 'host_takeover_audit',
          action: {
            ...hostTakeoverAudit.recommended_action,
            resume_context: {
              workspace,
              userId: hostConfig.defaults?.user_id || null,
              openClawHome,
              skillsRoot,
              candidateWorkspaces: registeredWorkspaceCandidates,
              resumePreferences
            }
          }
        },
        {
          source: 'profile_takeover_audit',
          action: {
            ...profileTakeoverAudit.recommended_action,
            resume_context: {
              workspace,
              userId: hostConfig.defaults?.user_id || null,
              openClawHome,
              skillsRoot,
              candidateWorkspaces: registeredWorkspaceCandidates,
              candidateOpenClawHomes: [openClawHome],
              candidateSkillsRoots: [skillsRoot],
              resumePreferences
            }
          }
        }
      ],
      {
        auto_fix_options: {
          workspace,
          userId: hostConfig.defaults?.user_id || null
        }
      }
    )
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runDoctor(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderDoctorReport(result));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Doctor Failed', error.message, {
        nextStep: 'Check the OpenClaw profile path and rerun doctor.'
      }));
    } else {
      console.log(JSON.stringify({ status: 'error', message: error.message }, null, 2));
    }
    process.exit(1);
  }
}

module.exports = {
  buildTakeoverAudit,
  buildHostTakeoverAudit,
  buildProfileTakeoverAudit,
  renderDoctorReport,
  runDoctor,
  runHostTakeoverAudit,
  runProfileTakeoverAudit,
  runTakeoverAudit,
  summarizeDoctorRunStatus
};
