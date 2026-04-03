#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getOpenClawHome, readJson } = require('./lib/context-anchor');
const { getHostConfigFile, readHostConfig, summarizeHostConfig } = require('./lib/host-config');
const {
  classifyMemorySourceHealth,
  summarizeExternalMemorySources
} = require('./legacy-memory-sync');

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
    issues.push('profile_not_ready');
    status = 'warning';
    summary = 'The OpenClaw profile is not fully configured for context-anchor takeover yet.';
    recommendedAction = {
      type: 'configure_host',
      summary: 'Apply the recommended host configuration before relying on takeover.',
      command: doctorResult?.commands?.configure || null,
      follow_up_command: null
    };
  } else if (!workspace) {
    issues.push('workspace_audit_missing');
    status = 'notice';
    summary = 'Profile takeover is configured, but no workspace was selected for external drift audit.';
    recommendedAction = {
      type: 'select_workspace',
      summary: 'Provide --workspace or configure a default workspace before running the next audit.',
      command: null,
      follow_up_command: null
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
  const workspace = options.workspace
    ? path.resolve(options.workspace)
    : hostConfig.defaults.workspace
      ? path.resolve(hostConfig.defaults.workspace)
      : null;
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
  const memorySourceAction =
    memorySourceHealth.status === 'drift_detected'
      ? {
          type: 'sync_legacy_memory',
          summary: 'External memory sources changed after the last sync. Centralize them into context-anchor now.',
          command: buildNpmScriptCommand('migrate:memory', {
            workspace
          }),
          follow_up_command:
            configuration.memory_takeover_enforced
              ? null
              : buildNpmScriptCommand('configure:host', {
                  workspace,
                  openClawHome,
                  skillsRoot,
                  applyConfig: true,
                  enforceMemoryTakeover: true,
                  yes: true
                })
        }
      : memorySourceHealth.status === 'best_effort'
        ? {
            type: 'enforce_memory_takeover',
            summary: 'Takeover is still best-effort. Enforce context-anchor takeover to reduce future bypass.',
            command: buildNpmScriptCommand('configure:host', {
              workspace,
              openClawHome,
              skillsRoot,
              applyConfig: true,
              enforceMemoryTakeover: true,
              yes: true
            }),
            follow_up_command: null
          }
        : {
            type: 'none',
            summary: 'No repair action required.',
            command: null,
            follow_up_command: null
          };

  return {
    status: installation.ready && configuration.ready && !memorySourceHealth.drift_detected ? 'ok' : 'warning',
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
    memory_sources: {
      ...memorySources,
      health: memorySourceHealth,
      recommended_action: memorySourceAction
    },
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
      workspace
        ? `Memory drift check inspected workspace ${workspace}.`
        : 'Memory drift check is skipped until you provide --workspace or configure a default workspace.',
      configuration.memory_takeover_enforced
        ? 'Memory takeover is enforced for this profile: context-anchor is the intended canonical memory manager.'
        : 'Memory takeover is NOT enforced for this profile: some models or profiles may still manage their own memory files, which can fragment memory and weaken continuity.'
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
  buildTakeoverAudit,
  runDoctor,
  runTakeoverAudit
};
