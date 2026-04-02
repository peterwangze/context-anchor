#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { ensureDir, getOpenClawHome, writeJson, writeText } = require('./lib/context-anchor');
const {
  DEFAULT_USER_ID,
  getHostConfigFile,
  normalizeProjectId,
  normalizeUserId,
  readHostConfig,
  setHostDefaults,
  setOnboardingPolicy,
  summarizeHostConfig,
  upsertUser,
  upsertWorkspace,
  writeHostConfig
} = require('./lib/host-config');

const DEFAULT_INTERVAL_MINUTES = 5;
const SUPPORTED_SCHEDULER_PLATFORMS = ['windows', 'macos', 'linux'];

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    assumeYes: false,
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
    addWorkspaces: undefined
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

    if (arg === '--workspace') {
      options.schedulerWorkspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--interval-minutes') {
      options.intervalMinutes = argv[index + 1] || null;
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
    }
  }

  return options;
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function quoteVbs(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function readJsonStrict(file, defaultValue) {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Config file ${file} is not valid JSON. Fix or remove it before running configure-host.`);
  }
}

function pathExists(target) {
  return fs.existsSync(target);
}

function normalizeIntervalMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INTERVAL_MINUTES;
  }

  return Math.max(1, Math.round(parsed));
}

function detectSchedulerPlatform(currentPlatform = process.platform) {
  if (currentPlatform === 'win32') {
    return 'windows';
  }

  if (currentPlatform === 'darwin') {
    return 'macos';
  }

  return 'linux';
}

function normalizeSchedulerPlatform(value, currentPlatform = process.platform) {
  if (!value || value === 'auto') {
    return detectSchedulerPlatform(currentPlatform);
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'windows' || normalized === 'win32' || normalized === 'win') {
    return 'windows';
  }

  if (normalized === 'macos' || normalized === 'darwin' || normalized === 'mac' || normalized === 'osx') {
    return 'macos';
  }

  if (normalized === 'linux') {
    return 'linux';
  }

  throw new Error(
    `Unsupported scheduler platform: ${value}. Use one of: ${SUPPORTED_SCHEDULER_PLATFORMS.join(', ')}.`
  );
}

function schedulerModeLabel(targetPlatform) {
  switch (targetPlatform) {
    case 'windows':
      return 'task_scheduler';
    case 'macos':
      return 'launchd';
    default:
      return 'systemd_user';
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildHostPaths(openClawHome, skillsRoot) {
  const installedSkillDir = path.join(skillsRoot, 'context-anchor');
  const configFile = path.join(openClawHome, 'openclaw.json');
  const legacyConfigFile = path.join(openClawHome, 'config.json');
  const defaultManagedSkillsRoot = path.join(openClawHome, 'skills');
  const hookHandler = path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js');
  const monitorScript = path.join(openClawHome, 'automation', 'context-anchor', 'context-pressure-monitor.js');
  const workspaceMonitorScript = path.join(
    openClawHome,
    'automation',
    'context-anchor',
    'workspace-monitor.js'
  );

  return {
    openclaw_home: openClawHome,
    skills_root: skillsRoot,
    default_managed_skills_root: defaultManagedSkillsRoot,
    installed_skill_dir: installedSkillDir,
    config_file: configFile,
    legacy_config_file: legacyConfigFile,
    hook_handler: hookHandler,
    monitor_script: monitorScript,
    workspace_monitor_script: workspaceMonitorScript,
    host_config_file: getHostConfigFile(openClawHome)
  };
}

function buildRecommendedConfig(paths) {
  const needsExtraSkillsDir = path.resolve(paths.skills_root) !== path.resolve(paths.default_managed_skills_root);

  return {
    hooks_internal_enabled: true,
    default_managed_skills_root: paths.default_managed_skills_root,
    extra_skill_dir: needsExtraSkillsDir ? paths.skills_root : null
  };
}

function buildMemoryTakeoverPrompt(paths) {
  return [
    '[Recommended] Let context-anchor take over memory management for this OpenClaw profile?',
    '',
    `This will update ${paths.config_file} so managed hooks stay enabled and context-anchor remains loadable for this profile.`,
    '',
    'If you do NOT enable this:',
    '- some models or profiles may continue writing their own MEMORY.md or private memory files',
    '- memory may stay fragmented across multiple sources instead of one canonical context-anchor state',
    '- continuity restore, experience accumulation, and later retrieval may be incomplete',
    '',
    'Enable memory takeover now?'
  ].join('\n');
}

function backupConfigFile(configFile) {
  if (!pathExists(configFile)) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `${configFile}.context-anchor.bak-${timestamp}`;
  fs.copyFileSync(configFile, backupFile);
  return backupFile;
}

function applyRecommendedConfig(paths) {
  const config = readJsonStrict(paths.config_file, {});
  const recommended = buildRecommendedConfig(paths);
  const next = { ...config };
  const nextHooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? { ...next.hooks } : {};
  const nextInternal =
    nextHooks.internal && typeof nextHooks.internal === 'object' && !Array.isArray(nextHooks.internal)
      ? { ...nextHooks.internal }
      : {};

  nextInternal.enabled = true;
  nextHooks.internal = nextInternal;
  next.hooks = nextHooks;

  let registeredExtraDir = false;
  if (recommended.extra_skill_dir) {
    const nextSkills = next.skills && typeof next.skills === 'object' && !Array.isArray(next.skills) ? { ...next.skills } : {};
    const nextLoad =
      nextSkills.load && typeof nextSkills.load === 'object' && !Array.isArray(nextSkills.load)
        ? { ...nextSkills.load }
        : {};
    const extraDirs = Array.isArray(nextLoad.extraDirs) ? [...nextLoad.extraDirs] : [];
    if (!extraDirs.includes(recommended.extra_skill_dir)) {
      extraDirs.push(recommended.extra_skill_dir);
    }
    nextLoad.extraDirs = extraDirs;
    nextSkills.load = nextLoad;
    next.skills = nextSkills;
    registeredExtraDir = true;
  }

  const changed = JSON.stringify(config) !== JSON.stringify(next);
  const backupFile = changed ? backupConfigFile(paths.config_file) : null;

  if (changed) {
    writeJson(paths.config_file, next);
  }

  return {
    status: changed ? 'applied' : 'unchanged',
    config_file: paths.config_file,
    backup_file: backupFile,
    internal_hooks_enabled: true,
    registered_extra_skill_dir: registeredExtraDir ? recommended.extra_skill_dir : null,
    default_managed_skills_root: recommended.default_managed_skills_root
  };
}

function parseWorkspaceSpec(spec) {
  if (!spec) {
    return null;
  }

  if (typeof spec === 'object') {
    return {
      workspace: spec.workspace,
      userId: spec.userId || null,
      projectId: spec.projectId || null,
      makeDefault: Boolean(spec.makeDefault)
    };
  }

  const [workspace, userId, projectId] = String(spec).split('|');
  return {
    workspace: workspace || null,
    userId: userId || null,
    projectId: projectId || null,
    makeDefault: false
  };
}

function createSchedulerLauncher(paths, workspace, targetPlatform) {
  const workspacePath = path.resolve(workspace);
  const launcherId = crypto
    .createHash('sha1')
    .update(workspacePath)
    .digest('hex')
    .slice(0, 8);
  const baseName = `${path.basename(workspacePath).toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'workspace'}-${launcherId}`;
  const launchersDir = path.join(path.dirname(paths.workspace_monitor_script), 'launchers');
  const isWindowsTarget = targetPlatform === 'windows';
  const launcherPath = path.join(launchersDir, `${baseName}${isWindowsTarget ? '.vbs' : '.sh'}`);
  const legacyWindowsLauncherPath = path.join(launchersDir, `${baseName}.cmd`);

  ensureDir(launchersDir);
  if (isWindowsTarget) {
    if (fs.existsSync(legacyWindowsLauncherPath)) {
      fs.rmSync(legacyWindowsLauncherPath, { force: true });
    }
    writeText(
      launcherPath,
      `Set shell = CreateObject("WScript.Shell")\r\n` +
        `shell.CurrentDirectory = ${quoteVbs(workspacePath)}\r\n` +
        `shell.Run ${[process.execPath, paths.workspace_monitor_script, workspacePath].map(quoteVbs).join(' & " " & ')}, 0, False\r\n`
    );
  } else {
    writeText(
      launcherPath,
      `#!/bin/sh\nexec ${quoteArg(process.execPath)} ${quoteArg(paths.workspace_monitor_script)} ${quoteArg(
        workspacePath
      )}\n`
    );
    fs.chmodSync(launcherPath, 0o755);
  }

  return {
    workspace: workspacePath,
    launcher_id: baseName,
    launcher_path: launcherPath
  };
}

function createWindowsSchedulerSetup(launcher, intervalMinutes) {
  const taskName = `OpenClaw Context Anchor ${launcher.launcher_id}`;
  const taskCommand = `wscript.exe //B //NoLogo "${launcher.launcher_path}"`;

  return {
    mode: schedulerModeLabel('windows'),
    task_name: taskName,
    task_command: taskCommand,
    generated_files: [launcher.launcher_path],
    registration_commands: [
      `schtasks /Create /SC MINUTE /MO ${intervalMinutes} /TN ${quoteArg(taskName)} /TR ${quoteArg(taskCommand)} /F`,
      `schtasks /Run /TN ${quoteArg(taskName)}`
    ]
  };
}

function createMacSchedulerSetup(paths, launcher, intervalMinutes, homeDir) {
  const label = `com.openclaw.context-anchor.${launcher.launcher_id}`;
  const schedulersDir = path.join(path.dirname(paths.workspace_monitor_script), 'schedulers', 'macos');
  const plistFile = path.join(schedulersDir, `${label}.plist`);
  const installDir = path.join(homeDir, 'Library', 'LaunchAgents');
  const installFile = path.join(installDir, `${label}.plist`);
  const logDir = path.join(path.dirname(paths.workspace_monitor_script), 'logs');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(paths.workspace_monitor_script)}</string>
    <string>${xmlEscape(launcher.workspace)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(launcher.workspace)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, `${launcher.launcher_id}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, `${launcher.launcher_id}.err.log`))}</string>
</dict>
</plist>
`;

  ensureDir(schedulersDir);
  ensureDir(logDir);
  writeText(plistFile, plist);

  return {
    mode: schedulerModeLabel('macos'),
    label,
    plist_file: plistFile,
    install_file: installFile,
    generated_files: [launcher.launcher_path, plistFile],
    registration_commands: [
      `mkdir -p ${shellQuote(installDir)}`,
      `cp ${shellQuote(plistFile)} ${shellQuote(installFile)}`,
      `launchctl bootstrap gui/$(id -u) ${shellQuote(installFile)}`,
      `launchctl kickstart -k gui/$(id -u)/${label}`
    ]
  };
}

function createLinuxSchedulerSetup(paths, launcher, intervalMinutes, homeDir) {
  const unitName = `openclaw-context-anchor-${launcher.launcher_id}`;
  const schedulersDir = path.join(path.dirname(paths.workspace_monitor_script), 'schedulers', 'linux');
  const serviceFile = path.join(schedulersDir, `${unitName}.service`);
  const timerFile = path.join(schedulersDir, `${unitName}.timer`);
  const installDir = path.join(homeDir, '.config', 'systemd', 'user');
  const installServiceFile = path.join(installDir, `${unitName}.service`);
  const installTimerFile = path.join(installDir, `${unitName}.timer`);
  const service = `[Unit]
Description=OpenClaw Context Anchor workspace monitor (${launcher.workspace})

[Service]
Type=oneshot
ExecStart=/usr/bin/env sh ${shellQuote(launcher.launcher_path)}
`;
  const timer = `[Unit]
Description=OpenClaw Context Anchor workspace monitor timer (${launcher.workspace})

[Timer]
OnBootSec=2min
OnUnitActiveSec=${intervalMinutes}min
AccuracySec=1min
Unit=${unitName}.service

[Install]
WantedBy=timers.target
`;

  ensureDir(schedulersDir);
  writeText(serviceFile, service);
  writeText(timerFile, timer);

  return {
    mode: schedulerModeLabel('linux'),
    service_name: `${unitName}.service`,
    timer_name: `${unitName}.timer`,
    service_file: serviceFile,
    timer_file: timerFile,
    install_service_file: installServiceFile,
    install_timer_file: installTimerFile,
    generated_files: [launcher.launcher_path, serviceFile, timerFile],
    registration_commands: [
      `mkdir -p ${shellQuote(installDir)}`,
      `cp ${shellQuote(serviceFile)} ${shellQuote(installServiceFile)}`,
      `cp ${shellQuote(timerFile)} ${shellQuote(installTimerFile)}`,
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${unitName}.timer`
    ]
  };
}

function createSchedulerSetup(paths, workspace, options = {}) {
  const currentPlatform = options.currentPlatform || process.platform;
  const targetPlatform = normalizeSchedulerPlatform(options.targetPlatform, currentPlatform);
  const runtimePlatform = detectSchedulerPlatform(currentPlatform);
  const intervalMinutes = normalizeIntervalMinutes(options.intervalMinutes);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const launcher = createSchedulerLauncher(paths, workspace, targetPlatform);

  let platformSetup;
  switch (targetPlatform) {
    case 'windows':
      platformSetup = createWindowsSchedulerSetup(launcher, intervalMinutes);
      break;
    case 'macos':
      platformSetup = createMacSchedulerSetup(paths, launcher, intervalMinutes, homeDir);
      break;
    default:
      platformSetup = createLinuxSchedulerSetup(paths, launcher, intervalMinutes, homeDir);
      break;
  }

  return {
    target_platform: targetPlatform,
    runtime_platform: runtimePlatform,
    interval_minutes: intervalMinutes,
    ...launcher,
    ...platformSetup
  };
}

function registerWindowsScheduler(setup, registrar) {
  registrar('schtasks', [
    '/Create',
    '/SC',
    'MINUTE',
    '/MO',
    String(setup.interval_minutes),
    '/TN',
    setup.task_name,
    '/TR',
    setup.task_command,
    '/F'
  ]);

  let started = true;
  let startMessage = null;
  try {
    registrar('schtasks', ['/Run', '/TN', setup.task_name]);
  } catch (error) {
    started = false;
    startMessage = error.message;
  }

  return {
    ...setup,
    status: 'registered',
    started,
    start_message: startMessage
  };
}

function registerMacScheduler(setup, registrar) {
  ensureDir(path.dirname(setup.install_file));
  fs.copyFileSync(setup.plist_file, setup.install_file);

  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '$(id -u)';
  const domain = `gui/${uid}`;

  try {
    registrar('launchctl', ['bootout', domain, setup.install_file]);
  } catch {}

  registrar('launchctl', ['bootstrap', domain, setup.install_file]);
  registrar('launchctl', ['kickstart', '-k', `${domain}/${setup.label}`]);

  return {
    ...setup,
    status: 'registered',
    started: true
  };
}

function registerLinuxScheduler(setup, registrar) {
  ensureDir(path.dirname(setup.install_service_file));
  fs.copyFileSync(setup.service_file, setup.install_service_file);
  fs.copyFileSync(setup.timer_file, setup.install_timer_file);

  registrar('systemctl', ['--user', 'daemon-reload']);
  registrar('systemctl', ['--user', 'enable', '--now', setup.timer_name]);

  return {
    ...setup,
    status: 'registered',
    started: true
  };
}

function registerScheduler(paths, workspace, options = {}) {
  const setup = createSchedulerSetup(paths, workspace, options);
  const registrar = options.schedulerRegistrar || execFileSync;
  const autoRegister = options.autoRegister !== false;

  if (!autoRegister || setup.runtime_platform !== setup.target_platform) {
    return {
      ...setup,
      status: 'prepared',
      started: false,
      message:
        setup.runtime_platform !== setup.target_platform
          ? `Prepared ${setup.target_platform} scheduler assets. Run registration on a ${setup.target_platform} host to activate them.`
          : 'Prepared scheduler assets without registering them.'
    };
  }

  try {
    switch (setup.target_platform) {
      case 'windows':
        return registerWindowsScheduler(setup, registrar);
      case 'macos':
        return registerMacScheduler(setup, registrar);
      default:
        return registerLinuxScheduler(setup, registrar);
    }
  } catch (error) {
    return {
      ...setup,
      status: 'prepared',
      started: false,
      registration_error: error.message,
      message: `Generated ${setup.target_platform} scheduler assets, but automatic registration failed. Use the generated files or registration commands to finish setup manually.`
    };
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

async function askSchedulerPlatform(defaultPlatform, ask = null) {
  while (true) {
    const answer = await askText(
      `Choose scheduler platform [windows/macos/linux] (default: ${defaultPlatform}): `,
      defaultPlatform,
      ask
    );

    try {
      return normalizeSchedulerPlatform(answer, defaultPlatform);
    } catch (error) {
      if (ask) {
        throw error;
      }

      console.log(error.message);
    }
  }
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

async function configureOwnership(paths, options = {}) {
  let config = readHostConfig(paths.openclaw_home);
  const ask = options.ask || null;
  const askInput = options.askText || null;
  const assumeYes = Boolean(options.assumeYes);
  const addedUsers = [];
  const addedWorkspaces = [];
  const existingDefaultUserId = config.defaults.user_id || DEFAULT_USER_ID;
  const existingDefaultWorkspace = config.defaults.workspace || '';

  if (typeof options.autoRegisterWorkspaces === 'boolean') {
    config = setOnboardingPolicy(config, {
      autoRegisterWorkspaces: options.autoRegisterWorkspaces
    });
  }
  if (typeof options.memoryTakeover === 'boolean') {
    config = setOnboardingPolicy(config, {
      memoryTakeover: options.memoryTakeover
    });
  }

  let defaultUserId = options.defaultUserId;
  if (defaultUserId === undefined && !assumeYes) {
    defaultUserId = await askText(
      `Default user name (default: ${existingDefaultUserId}): `,
      existingDefaultUserId,
      askInput
    );
  }
  defaultUserId = normalizeUserId(defaultUserId || existingDefaultUserId || DEFAULT_USER_ID);
  config = setHostDefaults(config, {
    userId: defaultUserId
  });

  let defaultWorkspace = options.defaultWorkspace;
  if (defaultWorkspace === undefined && !assumeYes) {
    defaultWorkspace = await askText(
      existingDefaultWorkspace
        ? `Default workspace path (default: ${existingDefaultWorkspace}): `
        : 'Default workspace path (leave blank to skip): ',
      existingDefaultWorkspace,
      askInput
    );
  }

  if (defaultWorkspace) {
    config = setHostDefaults(config, {
      userId: defaultUserId,
      workspace: defaultWorkspace
    });
    addedWorkspaces.push({
      workspace: path.resolve(defaultWorkspace),
      user_id: defaultUserId,
      project_id: normalizeProjectId(null, defaultWorkspace),
      default: true
    });
  }

  const configuredUsers = normalizeArray(options.addUsers);
  for (const userIdArg of configuredUsers) {
    const userId = normalizeUserId(userIdArg);
    upsertUser(config, userId);
    addedUsers.push(userId);
  }

  if (!assumeYes && !Array.isArray(options.addUsers)) {
    while (await askYesNo('Add another user now?', false, ask)) {
      const userId = normalizeUserId(await askText('User name: ', '', askInput));
      upsertUser(config, userId);
      addedUsers.push(userId);
    }
  }

  const workspaceSpecs = normalizeArray(options.addWorkspaces)
    .map(parseWorkspaceSpec)
    .filter((entry) => entry?.workspace);

  if (!assumeYes && !Array.isArray(options.addWorkspaces)) {
    while (await askYesNo('Add a workspace now?', false, ask)) {
      const workspace = await askText('Workspace path: ', '', askInput);
      if (!workspace) {
        break;
      }
      const ownerUserId = normalizeUserId(
        await askText(`Owner user name (default: ${defaultUserId}): `, defaultUserId, askInput)
      );
      const projectIdRaw = await askText(
        `Project id (default: ${normalizeProjectId(null, workspace)}): `,
        '',
        askInput
      );
      workspaceSpecs.push({
        workspace,
        userId: ownerUserId,
        projectId: projectIdRaw || null,
        makeDefault: false
      });
    }
  }

  for (const spec of workspaceSpecs) {
    const entry = upsertWorkspace(config, spec.workspace, {
      userId: spec.userId || defaultUserId,
      projectId: spec.projectId
    });
    if (spec.makeDefault) {
      config = setHostDefaults(config, {
        userId: config.defaults.user_id,
        workspace: entry.workspace,
        projectId: entry.project_id
      });
    }
    addedWorkspaces.push({
      workspace: entry.workspace,
      user_id: entry.user_id,
      project_id: entry.project_id,
      default: Boolean(spec.makeDefault)
    });
  }

  if (options.schedulerWorkspace) {
    const currentWorkspace = config.workspaces.find(
      (entry) => entry.workspace === path.resolve(options.schedulerWorkspace)
    );
    const entry = upsertWorkspace(config, options.schedulerWorkspace, {
      userId: options.schedulerUserId || currentWorkspace?.user_id || config.defaults.user_id || defaultUserId,
      projectId: options.schedulerProjectId || currentWorkspace?.project_id || normalizeProjectId(null, options.schedulerWorkspace)
    });
    if (!addedWorkspaces.some((item) => item.workspace === entry.workspace)) {
      addedWorkspaces.push({
        workspace: entry.workspace,
        user_id: entry.user_id,
        project_id: entry.project_id,
        default: false
      });
    }
  }

  const file = writeHostConfig(paths.openclaw_home, config);
  return {
    status: 'configured',
    host_config_file: file,
    defaults: config.defaults,
    onboarding: config.onboarding,
    added_users: addedUsers,
    added_workspaces: addedWorkspaces,
    summary: summarizeHostConfig(config)
  };
}

async function runConfigureHost(openClawHomeArg, skillsRootArg, options = {}) {
  const openClawHome = getOpenClawHome(openClawHomeArg || options.openclawHome || null);
  const skillsRoot = path.resolve(
    skillsRootArg ||
      options.skillsRoot ||
      process.env.CONTEXT_ANCHOR_SKILLS_ROOT ||
      path.join(openClawHome, 'skills')
  );
  const currentPlatform = options.currentPlatform || process.platform;
  const paths = buildHostPaths(openClawHome, skillsRoot);
  const assumeYes = Boolean(options.assumeYes);
  const ask = options.ask || null;
  const askInput = options.askText || null;
  let memoryTakeover = options.memoryTakeover;
  if (typeof memoryTakeover !== 'boolean') {
    if (typeof options.applyConfig === 'boolean') {
      memoryTakeover = options.applyConfig === true;
    } else {
      memoryTakeover = assumeYes
        ? true
        : await askYesNo(
            buildMemoryTakeoverPrompt(paths),
            true,
            ask
          );
    }
  }

  let applyConfig = options.applyConfig;
  if (memoryTakeover) {
    applyConfig = true;
  } else if (typeof applyConfig !== 'boolean') {
    applyConfig = false;
  }

  const config = applyConfig
    ? applyRecommendedConfig(paths)
    : {
        status: 'skipped',
        reason: 'user_declined'
      };

  const ownership = await configureOwnership(paths, {
    ...options,
    assumeYes,
    memoryTakeover,
    ask,
    askText: askInput
  });

  let enableScheduler = options.enableScheduler;
  if (typeof enableScheduler !== 'boolean') {
    enableScheduler = assumeYes
      ? false
      : await askYesNo(
          'Enable a background workspace monitor task now?',
          false,
          ask
        );
  }

  let scheduler = {
    status: 'skipped',
    reason: enableScheduler ? 'workspace_required' : 'user_declined'
  };

  if (enableScheduler) {
    let targetPlatform = options.targetPlatform;
    if (!targetPlatform && !assumeYes) {
      targetPlatform = await askSchedulerPlatform(detectSchedulerPlatform(currentPlatform), askInput);
    }

    let workspace = options.schedulerWorkspace || ownership.defaults.workspace || null;
    if (!workspace && !assumeYes) {
      workspace = await askText(
        ownership.defaults.workspace
          ? `Workspace path to monitor (default: ${ownership.defaults.workspace}): `
          : 'Workspace path to monitor (leave blank to skip): ',
        ownership.defaults.workspace || '',
        askInput
      );
    }

    if (workspace) {
      scheduler = registerScheduler(paths, workspace, {
        intervalMinutes: options.intervalMinutes,
        targetPlatform,
        currentPlatform,
        homeDir: options.homeDir,
        autoRegister: options.autoRegister,
        schedulerRegistrar: options.schedulerRegistrar
      });
    }
  }

  return {
    status: 'configured',
    paths,
    config,
    memory_takeover: {
      mode: memoryTakeover ? 'enforced' : 'best_effort',
      limitations: memoryTakeover
        ? []
        : [
            'Some models or profiles may continue managing their own memory files.',
            'Memory may remain fragmented across sources outside context-anchor.',
            'Continuity restore and long-term experience accumulation may be incomplete.'
          ]
    },
    ownership,
    scheduler
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runConfigureHost(options.openclawHome, options.skillsRoot, options);
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
  DEFAULT_INTERVAL_MINUTES,
  SUPPORTED_SCHEDULER_PLATFORMS,
  buildHostPaths,
  buildRecommendedConfig,
  configureOwnership,
  createSchedulerSetup,
  detectSchedulerPlatform,
  normalizeSchedulerPlatform,
  parseWorkspaceSpec,
  registerScheduler,
  runConfigureHost
};
