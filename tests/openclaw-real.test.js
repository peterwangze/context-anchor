const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');

const { runSessionStart } = require('../scripts/session-start');

const REPO_ROOT = path.resolve(__dirname, '..');

let cachedOpenClawCommand;
let cachedOpenClawPackageRoot;

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) {
    return text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

function runWindowsCommand(command, args, options) {
  const commandLine = [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ');
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], options);
}

function resolveOpenClawCommand() {
  if (cachedOpenClawCommand !== undefined) {
    return cachedOpenClawCommand;
  }

  const candidates = process.platform === 'win32' ? ['openclaw.cmd', 'openclaw.exe', 'openclaw'] : ['openclaw'];

  for (const candidate of candidates) {
    try {
      if (process.platform === 'win32') {
        const resolved = execFileSync('where.exe', [candidate], {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30000
        })
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find(Boolean);

        if (!resolved) {
          continue;
        }

        runWindowsCommand(resolved, ['--version'], {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30000
        });
        cachedOpenClawCommand = resolved;
        return cachedOpenClawCommand;
      }

      execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000
      });
      cachedOpenClawCommand = candidate;
      return cachedOpenClawCommand;
    } catch {
      continue;
    }
  }

  cachedOpenClawCommand = null;
  return cachedOpenClawCommand;
}

function runNpmRootGlobal() {
  const options = {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30000
  };

  if (process.platform === 'win32') {
    return runWindowsCommand('npm', ['root', '-g'], options);
  }

  return execFileSync('npm', ['root', '-g'], options);
}

function resolveOpenClawPackageRoot() {
  if (cachedOpenClawPackageRoot !== undefined) {
    return cachedOpenClawPackageRoot;
  }

  const commandPath = resolveOpenClawCommand();
  const candidates = [];

  if (commandPath && path.isAbsolute(commandPath)) {
    if (process.platform === 'win32') {
      candidates.push(path.resolve(path.dirname(commandPath), 'node_modules', 'openclaw'));
    } else {
      candidates.push(path.resolve(path.dirname(commandPath), '..', 'lib', 'node_modules', 'openclaw'));
      candidates.push(path.resolve(path.dirname(commandPath), '..', '..', 'lib', 'node_modules', 'openclaw'));
    }
  }

  try {
    const npmRoot = runNpmRootGlobal().trim();
    if (npmRoot) {
      candidates.push(path.join(npmRoot, 'openclaw'));
    }
  } catch {}

  cachedOpenClawPackageRoot =
    candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) || null;
  return cachedOpenClawPackageRoot;
}

function createTestProfileName(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getProfileHome(profileName) {
  return path.join(os.homedir(), `.openclaw-${profileName}`);
}

function assertSafeCleanupTarget(targetDir, parentDir, namePrefix) {
  const resolvedTarget = path.resolve(targetDir);
  const resolvedParent = path.resolve(parentDir);
  const relative = path.relative(resolvedParent, resolvedTarget);

  assert.notEqual(relative, '');
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(relative.startsWith('..'), false);
  assert.ok(path.basename(resolvedTarget).startsWith(namePrefix));
}

function cleanupTestDir(targetDir, parentDir, namePrefix) {
  if (!fs.existsSync(targetDir)) {
    return;
  }

  assertSafeCleanupTarget(targetDir, parentDir, namePrefix);
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function runInstallCommand(args) {
  return execFileSync(process.execPath, ['scripts/install-one-click.js', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
}

function runNodeScript(scriptPath, args = [], env = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      ...env
    }
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function withOpenClawHome(openClawHome, fn) {
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openClawHome;

  const restore = () => {
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }

    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function resolveImportedFunction(mod, exportName = 'default') {
  if (typeof mod?.[exportName] === 'function') {
    return mod[exportName];
  }

  if (typeof mod?.default === 'function' && exportName === 'default') {
    return mod.default;
  }

  if (mod?.default && typeof mod.default[exportName] === 'function') {
    return mod.default[exportName];
  }

  if (exportName === 'default' && mod?.default && typeof mod.default.default === 'function') {
    return mod.default.default;
  }

  return null;
}

async function importOpenClawDistModule(packageRoot, prefix, subdir = 'dist') {
  const moduleDir = path.join(packageRoot, subdir);
  const fileName = fs
    .readdirSync(moduleDir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.js'))
    .sort()[0];

  assert.ok(fileName, `Could not find installed OpenClaw module with prefix "${prefix}" under ${moduleDir}.`);
  return import(pathToFileURL(path.join(moduleDir, fileName)).href);
}

async function loadManagedHooksIntoRuntime(profileHome, workspaceDir, config) {
  const packageRoot = resolveOpenClawPackageRoot();
  assert.ok(packageRoot, 'Installed OpenClaw package root could not be resolved.');

  const workspaceModule = await importOpenClawDistModule(packageRoot, 'workspace-');
  const registryModule = await importOpenClawDistModule(packageRoot, 'registry-');
  const loadWorkspaceHookEntries = workspaceModule.t;
  const shouldIncludeHook = workspaceModule.i;
  const clearInternalHooks = registryModule.D;
  const registerInternalHook = registryModule.k;
  const triggerInternalHook = registryModule.A;
  const createInternalHookEvent = registryModule.O;

  assert.equal(typeof loadWorkspaceHookEntries, 'function');
  assert.equal(typeof shouldIncludeHook, 'function');
  assert.equal(typeof clearInternalHooks, 'function');
  assert.equal(typeof registerInternalHook, 'function');
  assert.equal(typeof triggerInternalHook, 'function');
  assert.equal(typeof createInternalHookEvent, 'function');

  clearInternalHooks();

  const eligibleEntries = loadWorkspaceHookEntries(workspaceDir, {
    config,
    managedHooksDir: path.join(profileHome, 'hooks'),
    bundledHooksDir: ''
  }).filter((entry) => shouldIncludeHook({ entry, config }));

  for (const entry of eligibleEntries) {
    const mod = await import(pathToFileURL(entry.hook.handlerPath).href);
    const exportName = entry.metadata?.export || 'default';
    const handler = resolveImportedFunction(mod, exportName);

    assert.equal(typeof handler, 'function', `Hook ${entry.hook.name} did not expose a callable ${exportName} export.`);

    for (const eventName of entry.metadata?.events || []) {
      registerInternalHook(eventName, handler);
    }
  }

  return {
    clearInternalHooks,
    triggerInternalHook,
    createInternalHookEvent,
    eligibleEntries
  };
}

function runOpenClaw(profileName, args) {
  const openClawCommand = resolveOpenClawCommand();
  assert.ok(openClawCommand, 'OpenClaw CLI is required for real environment tests.');

  const options = {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    }
  };

  if (process.platform === 'win32') {
    return runWindowsCommand(openClawCommand, ['--profile', profileName, '--no-color', ...args], options);
  }

  return execFileSync(openClawCommand, ['--profile', profileName, '--no-color', ...args], options);
}

test('real OpenClaw profile discovers context-anchor after one-click install', { timeout: 240000 }, (t) => {
  if (!resolveOpenClawCommand()) {
    t.skip('OpenClaw CLI is not installed on PATH.');
    return;
  }

  const profileName = createTestProfileName('context-anchor-real-managed');
  const profileHome = getProfileHome(profileName);

  try {
    const install = JSON.parse(
      runInstallCommand([
        '--openclaw-home',
        profileHome,
        '--yes',
        '--keep-memory',
        '--apply-config'
      ])
    );

    assert.equal(install.status, 'installed');
    assert.equal(install.install.openclaw_home, profileHome);

    const hooksList = runOpenClaw(profileName, ['hooks', 'list']);
    const hookInfo = runOpenClaw(profileName, ['hooks', 'info', 'context-anchor-hook']);
    const skillsList = runOpenClaw(profileName, ['skills', 'list']);

    assert.match(hooksList, /anchor-hook/);
    assert.match(hookInfo, /Source:\s+openclaw-managed/);
    assert.match(
      hookInfo,
      /Events:\s+agent:bootstrap, command:new, command:reset, command:stop, session:compact:before, session:compact:after/
    );
    assert.match(skillsList, /context-anchor/);
    assert.match(skillsList, /context-anchor[\s\S]{0,240}openclaw-managed/);
  } finally {
    cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-real-managed-');
  }
});

test(
  'real OpenClaw profile discovers context-anchor from a custom extra skills root',
  { timeout: 240000 },
  (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-real-extra');
    const profileHome = getProfileHome(profileName);
    const customSkillsRoot = path.join(
      os.tmpdir(),
      createTestProfileName('context-anchor-real-custom-skills')
    );

    try {
      const install = JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--skills-root',
          customSkillsRoot,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      assert.equal(install.status, 'installed');
      assert.equal(install.install.skills_root, customSkillsRoot);
      assert.equal(install.configuration.config.registered_extra_skill_dir, customSkillsRoot);

      const hookInfo = runOpenClaw(profileName, ['hooks', 'info', 'context-anchor-hook']);
      const skillsList = runOpenClaw(profileName, ['skills', 'list']);

      assert.match(hookInfo, /Source:\s+openclaw-managed/);
      assert.match(skillsList, /context-anchor/);
      assert.match(skillsList, /context-anchor[\s\S]{0,240}openclaw-extra/);
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-real-extra-');
      cleanupTestDir(customSkillsRoot, os.tmpdir(), 'context-anchor-real-custom-skills-');
    }
  }
);

test(
  'real installed host hook wrapper returns resume guidance on gateway startup',
  { timeout: 240000 },
  (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-installed-startup');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-installed-startup-'));
    const payloadFile = path.join(workspaceDir, 'gateway-startup-payload.json');

    try {
      const install = JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      withOpenClawHome(profileHome, () => {
        runSessionStart(workspaceDir, 'installed-resume', 'demo', {
          openClawSessionId: 'openclaw-installed-resume'
        });

        const stateFile = path.join(
          workspaceDir,
          '.context-anchor',
          'sessions',
          'installed-resume',
          'state.json'
        );
        const checkpointFile = path.join(
          workspaceDir,
          '.context-anchor',
          'sessions',
          'installed-resume',
          'checkpoint.md'
        );
        const state = readJson(stateFile);

        state.active_task = 'finish repair';
        state.commitments = [
          {
            id: 'resume-commitment',
            what: 'ship fix',
            status: 'pending'
          }
        ];
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        fs.writeFileSync(checkpointFile, '# Checkpoint\n\n- verify rollback path\n', 'utf8');
      });

      fs.writeFileSync(payloadFile, JSON.stringify({ workspace: workspaceDir }, null, 2));

      const result = JSON.parse(
        runNodeScript(install.install.hook_handler, ['gateway:startup', payloadFile], {
          OPENCLAW_HOME: profileHome
        })
      );

      assert.equal(result.status, 'resume_available');
      assert.equal(result.session_key, 'installed-resume');
      assert.match(result.resume_message, /finish repair/);
      assert.match(result.resume_message, /ship fix/);
      assert.match(result.resume_message, /verify rollback path/);
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-installed-startup-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-installed-startup-');
    }
  }
);

test(
  'real installed workspace monitor wrapper processes recent sessions',
  { timeout: 240000 },
  (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-installed-monitor');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-installed-monitor-'));

    try {
      const install = JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      withOpenClawHome(profileHome, () => {
        runSessionStart(workspaceDir, 'monitor-session', 'demo', {
          openClawSessionId: 'openclaw-installed-monitor'
        });
      });

      const result = JSON.parse(
        runNodeScript(install.install.workspace_monitor_script, [workspaceDir], {
          OPENCLAW_HOME: profileHome
        })
      );

      assert.equal(result.status, 'processed');
      assert.equal(result.handled_sessions, 1);
      assert.equal(result.results[0].status, 'maintenance_ok');
      assert.equal(result.results[0].session_key, 'monitor-session');
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-installed-monitor-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-installed-monitor-');
    }
  }
);

test(
  'real installed context pressure monitor wrapper creates checkpoint artifacts',
  { timeout: 240000 },
  (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-installed-pressure');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-installed-pressure-'));
    const snapshotFile = path.join(workspaceDir, 'pressure-snapshot.json');

    try {
      const install = JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      withOpenClawHome(profileHome, () => {
        runSessionStart(workspaceDir, 'pressure-session', 'demo', {
          openClawSessionId: 'openclaw-installed-pressure'
        });
      });

      fs.writeFileSync(
        snapshotFile,
        JSON.stringify(
          {
            sessions: [
              {
                session_key: 'pressure-session',
                usage_percent: 91
              }
            ]
          },
          null,
          2
        )
      );

      const result = JSON.parse(
        runNodeScript(install.install.monitor_script, [workspaceDir, snapshotFile], {
          OPENCLAW_HOME: profileHome
        })
      );

      assert.equal(result.status, 'processed');
      assert.equal(result.handled_sessions, 1);
      assert.ok(result.results[0].actions.includes('checkpoint_created'));
      assert.ok(result.results[0].actions.includes('compact_packet_created'));
      assert.ok(
        fs.existsSync(
          path.join(workspaceDir, '.context-anchor', 'sessions', 'pressure-session', 'checkpoint.md')
        )
      );
      assert.ok(
        fs.existsSync(
          path.join(workspaceDir, '.context-anchor', 'sessions', 'pressure-session', 'compact-packet.json')
        )
      );
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-installed-pressure-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-installed-pressure-');
    }
  }
);

test(
  'real OpenClaw runtime loads managed hooks and injects bootstrap content through the internal hook registry',
  { timeout: 240000 },
  async (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-runtime-bootstrap');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-runtime-bootstrap-'));

    try {
      JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      const config = readJson(path.join(profileHome, 'openclaw.json'));

      await withOpenClawHome(profileHome, async () => {
        const runtime = await loadManagedHooksIntoRuntime(profileHome, workspaceDir, config);
        assert.ok(runtime.eligibleEntries.some((entry) => entry.hook.name === 'context-anchor-hook'));

        const event = runtime.createInternalHookEvent('agent', 'bootstrap', 'agent:main:runtime', {
          workspaceDir,
          bootstrapFiles: [],
          cfg: config,
          sessionKey: 'agent:main:runtime',
          sessionId: 'openclaw-runtime-bootstrap',
          agentId: 'main'
        });

        await runtime.triggerInternalHook(event);

        assert.ok(Array.isArray(event.context.bootstrapFiles));
        assert.equal(event.context.bootstrapFiles.length, 1);
        assert.equal(event.context.bootstrapFiles[0].name, 'MEMORY.md');
        assert.ok(fs.existsSync(event.context.bootstrapFiles[0].path));
        assert.match(event.context.bootstrapFiles[0].content, /context-anchor/i);

        runtime.clearInternalHooks();
      });
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-runtime-bootstrap-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-runtime-bootstrap-');
    }
  }
);

test(
  'real OpenClaw runtime loads managed hooks and closes a session through the internal command stop hook',
  { timeout: 240000 },
  async (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-runtime-stop');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-runtime-stop-'));

    try {
      JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      const config = readJson(path.join(profileHome, 'openclaw.json'));

      await withOpenClawHome(profileHome, async () => {
        runSessionStart(workspaceDir, 'runtime-stop', 'runtime-project', {
          openClawSessionId: 'openclaw-runtime-stop'
        });

        const runtime = await loadManagedHooksIntoRuntime(profileHome, workspaceDir, config);
        const event = runtime.createInternalHookEvent('command', 'stop', 'runtime-stop', {
          sessionEntry: {
            systemPromptReport: {
              workspaceDir
            }
          },
          sessionId: 'openclaw-runtime-stop',
          commandSource: 'test'
        });

        await runtime.triggerInternalHook(event);

        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-stop', 'session-summary.json')
          )
        );
        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-stop', 'compact-packet.json')
          )
        );

        runtime.clearInternalHooks();
      });
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-runtime-stop-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-runtime-stop-');
    }
  }
);

test(
  'real OpenClaw runtime loads managed hooks and closes the prior session on command:new rollover',
  { timeout: 240000 },
  async (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-runtime-rollover');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-runtime-rollover-'));

    try {
      JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      const config = readJson(path.join(profileHome, 'openclaw.json'));

      await withOpenClawHome(profileHome, async () => {
        runSessionStart(workspaceDir, 'runtime-rollover', 'runtime-project', {
          openClawSessionId: 'openclaw-runtime-rollover'
        });

        const runtime = await loadManagedHooksIntoRuntime(profileHome, workspaceDir, config);
        const event = runtime.createInternalHookEvent('command', 'new', 'runtime-rollover', {
          workspaceDir,
          cfg: config,
          sessionEntry: {
            systemPromptReport: {
              workspaceDir
            }
          },
          previousSessionEntry: {
            systemPromptReport: {
              workspaceDir
            }
          },
          commandSource: 'test'
        });

        await runtime.triggerInternalHook(event);

        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-rollover', 'session-summary.json')
          )
        );
        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-rollover', 'compact-packet.json')
          )
        );

        runtime.clearInternalHooks();
      });
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-runtime-rollover-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-runtime-rollover-');
    }
  }
);

test(
  'real OpenClaw runtime loads managed hooks and persists assets across session compaction',
  { timeout: 240000 },
  async (t) => {
    if (!resolveOpenClawCommand()) {
      t.skip('OpenClaw CLI is not installed on PATH.');
      return;
    }

    const profileName = createTestProfileName('context-anchor-runtime-compact');
    const profileHome = getProfileHome(profileName);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-runtime-compact-'));

    try {
      JSON.parse(
        runInstallCommand([
          '--openclaw-home',
          profileHome,
          '--yes',
          '--keep-memory',
          '--apply-config'
        ])
      );

      const config = readJson(path.join(profileHome, 'openclaw.json'));

      await withOpenClawHome(profileHome, async () => {
        runSessionStart(workspaceDir, 'runtime-compact', 'runtime-project', {
          openClawSessionId: 'openclaw-runtime-compact'
        });

        const runtime = await loadManagedHooksIntoRuntime(profileHome, workspaceDir, config);
        const compactBeforeEvent = runtime.createInternalHookEvent('session', 'compact:before', 'runtime-compact', {
          sessionId: 'openclaw-runtime-compact',
          messageCount: 52,
          tokenCount: 4100
        });

        await runtime.triggerInternalHook(compactBeforeEvent);

        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-compact', 'checkpoint.md')
          )
        );
        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-compact', 'openclaw-bootstrap.md')
          )
        );

        const compactAfterEvent = runtime.createInternalHookEvent('session', 'compact:after', 'runtime-compact', {
          sessionId: 'openclaw-runtime-compact',
          messageCount: 14,
          tokenCount: 900,
          compactedCount: 38,
          firstKeptEntryId: 'entry-42'
        });

        await runtime.triggerInternalHook(compactAfterEvent);

        const state = readJson(
          path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-compact', 'state.json')
        );

        assert.ok(
          fs.existsSync(
            path.join(workspaceDir, '.context-anchor', 'sessions', 'runtime-compact', 'compact-packet.json')
          )
        );
        assert.equal(state.metadata.last_compaction_event, 'after');
        assert.equal(state.metadata.compaction_compacted_count, 38);

        runtime.clearInternalHooks();
      });
    } finally {
      cleanupTestDir(profileHome, os.homedir(), '.openclaw-context-anchor-runtime-compact-');
      cleanupTestDir(workspaceDir, os.tmpdir(), 'context-anchor-runtime-compact-');
    }
  }
);
