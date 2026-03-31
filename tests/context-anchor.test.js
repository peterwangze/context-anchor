const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compactPacketFile,
  DEFAULTS,
  createPaths,
  getRecentSessions,
  loadCompactPacket,
  loadRankedCollection,
  loadSessionState,
  loadUserMemories,
  readJson,
  sessionSummaryFile,
  sessionStateFile,
  sessionMemoryFile,
  writeJson
} = require('../scripts/lib/context-anchor');
const { buildBootstrapCacheContent } = require('../scripts/lib/bootstrap-cache');
const {
  describeCollectionFile,
  describeDocumentFile,
  loadRecentSessionIndexEntries,
  readMirrorCollection,
  readMirrorDocument
} = require('../scripts/lib/context-anchor-db');
const { findSessionByKey, getHostConfigFile, resolveOwnership } = require('../scripts/lib/host-config');
const { runCheckpointCreate } = require('../scripts/checkpoint-create');
const { runConfigureHost } = require('../scripts/configure-host');
const { runContextPressureHandle } = require('../scripts/context-pressure-handle');
const { runContextPressureMonitor } = require('../scripts/context-pressure-monitor');
const { handleHookEvent, handleManagedHookEvent } = require('../hooks/context-anchor-hook/handler');
const { runExperienceValidate } = require('../scripts/experience-validate');
const { runInstallHostAssets } = require('../scripts/install-host-assets');
const { runOneClickInstall } = require('../scripts/install-one-click');
const { runMigrateGlobalToUser } = require('../scripts/migrate-global-to-user');
const { runMirrorRebuild } = require('../scripts/mirror-rebuild');
const { runMemoryFlow } = require('../scripts/memory-flow');
const { runMemorySave } = require('../scripts/memory-save');
const { runHeartbeat } = require('../scripts/heartbeat');
const { runHeatEvaluation } = require('../scripts/heat-eval');
const { runMemorySearch } = require('../scripts/memory-search');
const { runDoctor } = require('../scripts/doctor');
const { discoverOpenClawSessions } = require('../scripts/lib/openclaw-session-discovery');
const {
  buildOpenClawSessionStatusReport,
  buildSchedulerDescriptor,
  detectSchedulerStatus,
  renderOpenClawSessionDiagnosisReport,
  renderOpenClawSessionStatusReport
} = require('../scripts/lib/openclaw-session-status');
const { runSkillDiagnose } = require('../scripts/skill-diagnose');
const { runScopePromote } = require('../scripts/scope-promote');
const { runSkillReconcile } = require('../scripts/skill-reconcile');
const { runStatusReport } = require('../scripts/status-report');
const { runSkillSupersede } = require('../scripts/skill-supersede');
const { runSessionClose } = require('../scripts/session-close');
const { runSessionStart } = require('../scripts/session-start');
const { runConfigureSessions } = require('../scripts/configure-sessions');
const { runUpgradeSessions } = require('../scripts/upgrade-sessions');
const { runSkillStatusUpdate } = require('../scripts/skill-status-update');
const { runSkillCreate } = require('../scripts/skill-create');
const { runSkillDraftCreate } = require('../scripts/skill-draft-create');
const { runSkillificationScore } = require('../scripts/skillification-score');
const { runWorkspaceMonitor } = require('../scripts/workspace-monitor');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-'));
}

function cleanupWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function withOpenClawHome(workspace, fn) {
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = path.join(workspace, 'openclaw-home');
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

function writeSessionTranscript(sessionFile, workspace, sessionId) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-03-27T20:08:14.164Z',
      cwd: workspace
    })}\n`,
    'utf8'
  );
}

function writeSessionTranscript(sessionFile, workspace, sessionId) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-03-27T20:08:14.164Z',
      cwd: workspace
    })}\n`,
    'utf8'
  );
}

test('session-start preserves existing session state', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'session-a', 'demo');
    const sessionFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'session-a',
      'state.json'
    );
    const state = readJson(sessionFile, {});
    state.active_task = 'keep-me';
    state.commitments = [
      {
        id: 'c1',
        what: 'do x',
        when: '2026-03-22T00:00:00Z',
        status: 'pending'
      }
    ];
    writeJson(sessionFile, state);

    const result = runSessionStart(workspace, 'session-a', 'demo');
    const nextState = readJson(sessionFile, {});

    assert.equal(nextState.active_task, 'keep-me');
    assert.equal(nextState.commitments.length, 1);
    assert.equal(result.session.restored, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('context pressure handling creates a checkpoint and syncs hot memories', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-b', 'demo');
    runMemorySave(
      workspace,
      'session-b',
      'session',
      'decision',
      'Use JSON storage',
      JSON.stringify({ heat: 95, tags: ['architecture'] })
    );

    const result = runContextPressureHandle(workspace, 'session-b', 80);
    const checkpointFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'session-b',
      'checkpoint.md'
    );
    const decisionsFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'decisions.json'
    );
    const decisions = readJson(decisionsFile, { decisions: [] }).decisions;

    assert.ok(result.actions.includes('checkpoint_created'));
    assert.ok(fs.existsSync(checkpointFile));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'Use JSON storage');
    assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-b', 'compact-packet.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('context pressure monitor captures structured errors into project lessons and preserves pressure handling', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'pressure-errors', 'demo');
      const snapshotFile = path.join(workspace, 'pressure-errors.json');
      writeJson(snapshotFile, {
        sessions: [
          {
            session_key: 'pressure-errors',
            usage_percent: 91,
            errors: [
              {
                error_id: 'cmd-failure-1',
                type: 'command_failed',
                summary: 'npm test failed',
                details: 'exit code 1',
                solution: 'rerun in band'
              }
            ]
          }
        ]
      });

      const result = runContextPressureMonitor(workspace, snapshotFile);
      const experiences = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json'),
        { experiences: [] }
      ).experiences;
      const state = readJson(
        path.join(workspace, '.context-anchor', 'sessions', 'pressure-errors', 'state.json'),
        {}
      );

      assert.equal(result.status, 'processed');
      assert.equal(result.results[0].status, 'handled');
      assert.ok(result.results[0].actions.includes('checkpoint_created'));
      assert.equal(result.results[0].error_captures.length, 1);
      assert.equal(result.results[0].ignored_errors, 0);
      assert.equal(experiences.length, 1);
      assert.equal(experiences[0].type, 'lesson');
      assert.equal(experiences[0].summary, 'npm test failed');
      assert.ok(experiences[0].tags.includes('error'));
      assert.ok(experiences[0].tags.includes('command_failed'));
      assert.equal(state.errors_count, 1);
      assert.ok(state.last_error);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('context pressure monitor upserts repeated structured errors by error id and ignores malformed errors', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'pressure-upsert', 'demo');
      const snapshotFile = path.join(workspace, 'pressure-upsert.json');
      writeJson(snapshotFile, {
        sessions: [
          {
            session_key: 'pressure-upsert',
            usage_percent: 0,
            errors: [
              {
                error_id: 'cmd-failure-1',
                type: 'command_failed',
                summary: 'npm test failed',
                details: 'exit code 1'
              },
              {
                type: 'command_failed',
                details: 'missing summary should be ignored'
              }
            ]
          }
        ]
      });

      const first = runContextPressureMonitor(workspace, snapshotFile);

      writeJson(snapshotFile, {
        sessions: [
          {
            session_key: 'pressure-upsert',
            usage_percent: 0,
            errors: [
              {
                error_id: 'cmd-failure-1',
                type: 'command_failed',
                summary: 'npm test failed',
                details: 'exit code 2',
                solution: 'rerun in band'
              },
              {
                type: 'command_failed',
                details: 'missing summary should still be ignored'
              }
            ]
          }
        ]
      });

      const second = runContextPressureMonitor(workspace, snapshotFile);
      const experiences = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json'),
        { experiences: [] }
      ).experiences;

      assert.equal(first.results[0].error_captures.length, 1);
      assert.equal(first.results[0].ignored_errors, 1);
      assert.equal(second.results[0].error_captures.length, 1);
      assert.equal(second.results[0].ignored_errors, 1);
      assert.equal(experiences.length, 1);
      assert.equal(experiences[0].details, 'exit code 2');
      assert.equal(experiences[0].solution, 'rerun in band');
      assert.equal(experiences[0].access_count, 2);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('memory-flow upserts a previously synced session memory when it changes', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-upsert', 'demo');
    runMemorySave(
      workspace,
      'session-upsert',
      'session',
      'best_practice',
      'first version',
      JSON.stringify({ heat: 95, details: 'v1' })
    );

    runMemoryFlow(workspace, 'session-upsert', { minimumHeat: 80 });

    const memoryFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'session-upsert',
      'memory-hot.json'
    );
    const memory = readJson(memoryFile, { entries: [] });
    memory.entries[0].content = 'second version';
    memory.entries[0].summary = 'second version';
    memory.entries[0].details = 'v2';
    memory.entries[0].heat = 95;
    writeJson(memoryFile, memory);

    const result = runMemoryFlow(workspace, 'session-upsert', { minimumHeat: 80 });
    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'experiences.json'
    );
    const experiences = readJson(experiencesFile, { experiences: [] }).experiences;

    assert.equal(result.synced_entries, 1);
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].summary, 'second version');
    assert.equal(experiences[0].details, 'v2');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session memory writes sync a SQLite mirror and ranked reads use the mirrored order', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'sqlite-mirror', 'demo');
      runMemorySave(
        workspace,
        'sqlite-mirror',
        'session',
        'best_practice',
        'medium heat retry note',
        JSON.stringify({ heat: 86 })
      );
      runMemorySave(
        workspace,
        'sqlite-mirror',
        'session',
        'best_practice',
        'highest heat checkout retry playbook',
        JSON.stringify({ heat: 99 })
      );
      runMemorySave(
        workspace,
        'sqlite-mirror',
        'session',
        'best_practice',
        'high heat cache verification note',
        JSON.stringify({ heat: 93 })
      );

      const paths = createPaths(workspace);
      const memoryFile = sessionMemoryFile(paths, 'sqlite-mirror');
      const descriptor = describeCollectionFile(memoryFile, 'entries');
      const mirror = readMirrorCollection(memoryFile, 'entries');
      const ranked = loadRankedCollection(memoryFile, 'entries', {
        minHeat: 90,
        limit: 2
      });

      assert.ok(descriptor?.dbFile);
      assert.ok(fs.existsSync(descriptor.dbFile));
      assert.equal(mirror.status, 'available');
      assert.equal(mirror.items.length, 3);
      assert.equal(ranked.length, 2);
      assert.match(ranked[0].summary || ranked[0].content, /highest heat checkout retry playbook/);
      assert.match(ranked[1].summary || ranked[1].content, /high heat cache verification note/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session state and session index sync to SQLite metadata mirrors', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'sqlite-meta-a', 'demo');
      runSessionStart(workspace, 'sqlite-meta-b', 'demo');

      const paths = createPaths(workspace);
      const stateFile = sessionStateFile(paths, 'sqlite-meta-a');
      const stateDescriptor = describeDocumentFile(stateFile);
      const stateMirror = readMirrorDocument(stateFile);
      const indexMirror = readMirrorCollection(paths.sessionIndexFile, 'sessions');
      const recentFromDb = loadRecentSessionIndexEntries(paths.sessionIndexFile, DEFAULTS.recentSessionWindowMs);
      const recent = getRecentSessions(paths, DEFAULTS.recentSessionWindowMs);
      const loadedState = loadSessionState(paths, 'sqlite-meta-a', 'demo', {
        createIfMissing: false,
        touch: false
      });

      assert.ok(stateDescriptor?.dbFile);
      assert.ok(fs.existsSync(stateDescriptor.dbFile));
      assert.equal(stateMirror.status, 'available');
      assert.equal(stateMirror.data.session_key, 'sqlite-meta-a');
      assert.equal(indexMirror.status, 'available');
      assert.ok(Array.isArray(recentFromDb));
      assert.ok(recentFromDb.some((entry) => entry.session_key === 'sqlite-meta-a'));
      assert.ok(recent.some((entry) => entry.session_key === 'sqlite-meta-b'));
      assert.equal(loadedState.session_key, 'sqlite-meta-a');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat incrementally derives session experiences and upserts them by source memory', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'heartbeat-experience', 'demo');
    const saved = runMemorySave(
      workspace,
      'heartbeat-experience',
      'session',
      'best_practice',
      'first version',
      JSON.stringify({ heat: 95, details: 'v1', solution: 'step one' })
    );

    const first = runHeartbeat(workspace, 'heartbeat-experience', 'demo', 50);
    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'heartbeat-experience',
      'experiences.json'
    );
    let experiences = readJson(experiencesFile, { experiences: [] }).experiences;

    assert.equal(first.session_experiences.created, 1);
    assert.equal(first.session_experiences.updated, 0);
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].source_memory_id, saved.id);
    assert.equal(experiences[0].summary, 'first version');
    assert.equal(experiences[0].details, 'v1');
    assert.equal(experiences[0].solution, 'step one');

    const second = runHeartbeat(workspace, 'heartbeat-experience', 'demo', 50);
    experiences = readJson(experiencesFile, { experiences: [] }).experiences;

    assert.equal(second.session_experiences.created, 0);
    assert.equal(second.session_experiences.updated, 0);
    assert.equal(second.session_experiences.unchanged, 1);
    assert.equal(experiences.length, 1);

    const memoryFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'heartbeat-experience',
      'memory-hot.json'
    );
    const memory = readJson(memoryFile, { entries: [] });
    memory.entries[0].content = 'second version';
    memory.entries[0].summary = 'second version';
    memory.entries[0].details = 'v2';
    memory.entries[0].solution = 'step two';
    memory.entries[0].heat = 96;
    writeJson(memoryFile, memory);

    const third = runHeartbeat(workspace, 'heartbeat-experience', 'demo', 50);
    experiences = readJson(experiencesFile, { experiences: [] }).experiences;

    assert.equal(third.session_experiences.created, 0);
    assert.equal(third.session_experiences.updated, 1);
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].summary, 'second version');
    assert.equal(experiences[0].details, 'v2');
    assert.equal(experiences[0].solution, 'step two');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skillification auto-validates reused experiences before suggesting a skill', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-c', 'demo');
    const saved = runMemorySave(
      workspace,
      'session-c',
      'project',
      'best_practice',
      'Reusable deployment checklist',
      JSON.stringify({
        heat: 95,
        access_count: 8,
        access_sessions: ['session-d', 'session-e'],
        tags: ['deployment'],
        validation_status: 'pending'
      })
    );

    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'experiences.json'
    );
    const experiences = readJson(experiencesFile, { experiences: [] });
    experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
    writeJson(experiencesFile, experiences);

    const result = runSkillificationScore(workspace, 'demo');

    assert.equal(result.candidates, 1);
    assert.equal(result.candidates_list[0].id, saved.id);
    assert.equal(result.candidates_list[0].validation_status, 'validated');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill-create materializes a validated experience into a sibling skill directory', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-d', 'demo');
    const saved = runMemorySave(
      workspace,
      'session-d',
      'project',
      'best_practice',
      'Reusable deployment checklist',
      JSON.stringify({
        heat: 95,
        access_count: 4,
        access_sessions: ['session-e'],
        tags: ['deployment'],
        validation_status: 'validated'
      })
    );

    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'experiences.json'
    );
    const experiences = readJson(experiencesFile, { experiences: [] });
    experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
    writeJson(experiencesFile, experiences);

    const skillsRoot = path.join(workspace, 'skills-root');
    const created = runSkillCreate(workspace, saved.id, 'deploy-guide', 'demo', {
      skillsRoot
    });

    assert.equal(created.status, 'created');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'deploy-guide', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillsRoot, '_skill-index.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('experience-validate rejects unsupported validation statuses', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-validate', 'demo');
    const saved = runMemorySave(
      workspace,
      'session-validate',
      'project',
      'best_practice',
      'validation candidate'
    );

    assert.throws(
      () => runExperienceValidate(workspace, saved.id, 'typo_status', 'demo'),
      /Validation status must be one of/
    );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('gateway startup hook emits a resume message for the latest active session', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(workspace, 'resume-session', 'demo');
      const sessionFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'resume-session',
        'state.json'
      );
      const state = readJson(sessionFile, {});
      state.active_task = 'finish repair';
      state.commitments = [
        {
          id: 'c2',
          what: 'ship fix',
          when: '2026-03-22T00:00:00Z',
          status: 'pending'
        }
      ];
      writeJson(sessionFile, state);
      runCheckpointCreate(workspace, 'resume-session', 'manual');

      const result = handleHookEvent('gateway:startup', {
        workspace
      });

      assert.equal(result.status, 'resume_available');
      assert.match(result.resume_message, /finish repair/);
      assert.match(result.resume_message, /ship fix/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('install-host-assets deploys a self-contained skill snapshot and managed hook wrapper', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    withOpenClawHome(workspace, () => {
    const result = runInstallHostAssets(openClawHome);
    const installedSkillDir = path.join(openClawHome, 'skills', 'context-anchor');
    const hookWrapper = fs.readFileSync(
      path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js'),
      'utf8'
    );
    const hookModule = require(path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js'));
    const normalizedWrapper = hookWrapper.replaceAll('\\\\', '\\');

    assert.equal(result.status, 'installed');
    assert.equal(result.installed_skill_dir, installedSkillDir);
    assert.equal(path.basename(result.installed_skill_dir), 'context-anchor');
    assert.ok(fs.existsSync(path.join(installedSkillDir, 'README.md')));
    assert.ok(fs.existsSync(path.join(installedSkillDir, 'scripts', 'memory-flow.js')));
    assert.ok(fs.existsSync(path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js')));
    assert.ok(
      fs.existsSync(
        path.join(openClawHome, 'automation', 'context-anchor', 'context-pressure-monitor.js')
      )
    );
    assert.ok(
      fs.existsSync(path.join(openClawHome, 'automation', 'context-anchor', 'workspace-monitor.js'))
    );
    assert.ok(normalizedWrapper.includes(installedSkillDir));
    assert.equal(typeof hookModule.default, 'function');
    assert.equal(typeof hookModule.handleManagedHookEvent, 'function');
    const hookResult = hookModule.default('heartbeat', {
      workspace,
      session_key: 'installed-wrapper-session',
      usage_percent: 66
    });
    const hostConfig = readJson(getHostConfigFile(openClawHome), {});
    assert.equal(hookResult.status, 'handled');
    assert.equal(hookResult.result.status, 'heartbeat_ok');
    assert.ok(hostConfig.workspaces.some((entry) => path.resolve(entry.workspace) === path.resolve(workspace)));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('installed hook wrapper exposes a function as the ESM default export', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      const installedHandler = path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js');
      const mod = await import(pathToFileURL(installedHandler).href);

      assert.equal(typeof mod.default, 'function');
      const result = mod.default('heartbeat', {
        workspace,
        session_key: 'esm-wrapper-session',
        usage_percent: 60
      });
      assert.equal(result.status, 'handled');
      assert.equal(result.result.status, 'heartbeat_ok');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host writes recommended hooks and workspace monitor entries and keeps a backup', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configFile = path.join(openClawHome, 'openclaw.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      writeJson(configFile, {
        hooks: {
          internal: {
            enabled: false
          }
        },
        skills: {
          load: {
            extraDirs: ['D:\\existing-skills']
          }
        }
      });

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: []
      });
      const config = readJson(configFile, {});

      assert.equal(result.config.status, 'applied');
      assert.ok(result.config.backup_file);
      assert.ok(fs.existsSync(result.config.backup_file));
      assert.equal(config.hooks.internal.enabled, true);
      assert.deepEqual(config.skills.load.extraDirs, ['D:\\existing-skills']);
      assert.equal(result.config.internal_hooks_enabled, true);
      assert.equal(result.config.registered_extra_skill_dir, null);
      assert.equal(result.ownership.onboarding.auto_register_workspaces, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host writes default user and workspace ownership registry', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const defaultWorkspace = path.join(workspace, 'default-project');
  const secondWorkspace = path.join(workspace, 'client-b');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace,
        addUsers: ['bob'],
        addWorkspaces: [
          {
            workspace: secondWorkspace,
            userId: 'bob',
            projectId: 'client-b'
          }
        ]
      });
      const hostConfig = readJson(getHostConfigFile(openClawHome), {});

      assert.equal(result.ownership.defaults.user_id, 'alice');
      assert.equal(path.resolve(result.ownership.defaults.workspace), path.resolve(defaultWorkspace));
      assert.equal(hostConfig.defaults.user_id, 'alice');
      assert.equal(path.resolve(hostConfig.defaults.workspace), path.resolve(defaultWorkspace));
      assert.ok(hostConfig.users.some((entry) => entry.user_id === 'alice'));
      assert.ok(hostConfig.users.some((entry) => entry.user_id === 'bob'));
      assert.ok(
        hostConfig.workspaces.some(
          (entry) =>
            path.resolve(entry.workspace) === path.resolve(defaultWorkspace) &&
            entry.user_id === 'alice' &&
            entry.project_id === 'default-project'
        )
      );
      assert.ok(
        hostConfig.workspaces.some(
          (entry) =>
            path.resolve(entry.workspace) === path.resolve(secondWorkspace) &&
            entry.user_id === 'bob' &&
            entry.project_id === 'client-b'
        )
      );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host can register a Windows scheduler when the selected platform is Windows', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const monitoredWorkspace = path.join(workspace, 'project-a');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(monitoredWorkspace, { recursive: true });

      const calls = [];
      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: true,
        targetPlatform: 'windows',
        schedulerWorkspace: monitoredWorkspace,
        intervalMinutes: 7,
        currentPlatform: 'win32',
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: [],
        schedulerRegistrar: (...args) => {
          calls.push(args);
        }
      });

      assert.ok(fs.existsSync(result.scheduler.launcher_path));
      assert.equal(path.extname(result.scheduler.launcher_path), '.vbs');
      assert.equal(path.resolve(result.scheduler.workspace), path.resolve(monitoredWorkspace));
      assert.equal(result.scheduler.status, 'registered');
      assert.equal(result.scheduler.target_platform, 'windows');
      assert.equal(result.scheduler.interval_minutes, 7);
      assert.match(result.scheduler.task_command, /wscript\.exe/i);
      assert.equal(calls.length, 2);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('legacy Windows scheduler launchers are reported as visible-console tasks', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const monitoredWorkspace = path.join(workspace, 'project-legacy');
  const descriptor = buildSchedulerDescriptor(openClawHome, monitoredWorkspace, 'win32');

  try {
    fs.mkdirSync(path.dirname(descriptor.windows.legacy_launcher_path), { recursive: true });
    fs.writeFileSync(descriptor.windows.legacy_launcher_path, '@echo off\r\n', 'utf8');

    const legacy = detectSchedulerStatus(openClawHome, monitoredWorkspace, 'win32');

    assert.equal(legacy.status, 'legacy');
    assert.equal(legacy.runtime, 'visible_console');
    assert.equal(legacy.configured, true);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host can prepare macOS and Linux scheduler assets by explicit platform choice', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const monitoredWorkspace = path.join(workspace, 'project-b');
  const fakeHome = path.join(workspace, 'home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(monitoredWorkspace, { recursive: true });

      const macos = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: true,
        targetPlatform: 'macos',
        schedulerWorkspace: monitoredWorkspace,
        intervalMinutes: 9,
        currentPlatform: 'linux',
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: [],
        homeDir: fakeHome
      });
      const linux = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: true,
        targetPlatform: 'linux',
        schedulerWorkspace: monitoredWorkspace,
        intervalMinutes: 11,
        currentPlatform: 'darwin',
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: [],
        homeDir: fakeHome
      });

      assert.equal(macos.scheduler.status, 'prepared');
      assert.equal(macos.scheduler.target_platform, 'macos');
      assert.equal(macos.scheduler.mode, 'launchd');
      assert.ok(fs.existsSync(macos.scheduler.plist_file));
      assert.match(macos.scheduler.install_file, /LaunchAgents/);

      assert.equal(linux.scheduler.status, 'prepared');
      assert.equal(linux.scheduler.target_platform, 'linux');
      assert.equal(linux.scheduler.mode, 'systemd_user');
      assert.ok(fs.existsSync(linux.scheduler.service_file));
      assert.ok(fs.existsSync(linux.scheduler.timer_file));
      assert.match(linux.scheduler.install_service_file, /systemd/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host falls back to prepared assets when automatic scheduler registration fails', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const monitoredWorkspace = path.join(workspace, 'project-c');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(monitoredWorkspace, { recursive: true });

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: true,
        targetPlatform: 'linux',
        schedulerWorkspace: monitoredWorkspace,
        currentPlatform: 'linux',
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: [],
        homeDir: path.join(workspace, 'home'),
        schedulerRegistrar: () => {
          throw new Error('systemctl unavailable');
        }
      });

      assert.equal(result.scheduler.status, 'prepared');
      assert.match(result.scheduler.registration_error, /systemctl unavailable/);
      assert.ok(fs.existsSync(result.scheduler.service_file));
      assert.ok(fs.existsSync(result.scheduler.timer_file));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('hook runtime applies workspace ownership defaults and records session ownership', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const defaultWorkspace = path.join(workspace, 'workspace-a');
  const secondWorkspace = path.join(workspace, 'workspace-b');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: secondWorkspace,
            userId: 'bob',
            projectId: 'client-b'
          }
        ]
      });

      const defaultResult = handleHookEvent('heartbeat', {
        session_key: 'default-owned-session',
        usage_percent: 72
      });
      const secondResult = handleHookEvent('heartbeat', {
        workspace: secondWorkspace,
        session_key: 'workspace-owned-session',
        usage_percent: 88
      });
      const defaultState = readJson(
        path.join(defaultWorkspace, '.context-anchor', 'sessions', 'default-owned-session', 'state.json'),
        {}
      );
      const secondState = readJson(
        path.join(secondWorkspace, '.context-anchor', 'sessions', 'workspace-owned-session', 'state.json'),
        {}
      );
      const hostConfig = readJson(getHostConfigFile(openClawHome), {});

      assert.equal(defaultResult.status, 'handled');
      assert.equal(secondResult.status, 'handled');
      assert.equal(defaultState.user_id, 'alice');
      assert.equal(defaultState.project_id, 'workspace-a');
      assert.equal(secondState.user_id, 'bob');
      assert.equal(secondState.project_id, 'client-b');
      assert.ok(
        hostConfig.sessions.some(
          (entry) =>
            path.resolve(entry.workspace) === path.resolve(defaultWorkspace) &&
            entry.session_key === 'default-owned-session' &&
            entry.user_id === 'alice'
        )
      );
      assert.ok(
        hostConfig.sessions.some(
          (entry) =>
            path.resolve(entry.workspace) === path.resolve(secondWorkspace) &&
            entry.session_key === 'workspace-owned-session' &&
            entry.user_id === 'bob' &&
            entry.project_id === 'client-b'
        )
      );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('host ownership can resolve an active session by session key without an explicit workspace', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const targetWorkspace = path.join(workspace, 'session-owned-workspace');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: path.join(workspace, 'default-workspace'),
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(targetWorkspace, 'compact-owned-session', 'target-project', {
        userId: 'alice',
        openClawSessionId: 'openclaw-compact-owned'
      });

      const hostConfig = readJson(getHostConfigFile(openClawHome), {});
      const matched = findSessionByKey(hostConfig, 'compact-owned-session');
      const resolved = resolveOwnership(openClawHome, {
        sessionKey: 'compact-owned-session'
      });

      assert.equal(matched.workspace, path.resolve(targetWorkspace));
      assert.equal(resolved.workspace, path.resolve(targetWorkspace));
      assert.equal(resolved.projectId, 'target-project');
      assert.equal(resolved.userId, 'alice');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('unregistered workspace auto-registers by default and continues hook handling', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const unknownWorkspace = path.join(workspace, 'unknown-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace: path.join(workspace, 'configured-project'),
        addUsers: [],
        addWorkspaces: []
      });

      const startup = handleHookEvent('gateway:startup', {
        workspace: unknownWorkspace
      });
      const heartbeat = handleHookEvent('heartbeat', {
        workspace: unknownWorkspace,
        session_key: 'unknown-session',
        usage_percent: 70
      });
      const hostConfig = readJson(getHostConfigFile(openClawHome), {});

      assert.equal(startup.status, 'idle');
      assert.equal(heartbeat.status, 'handled');
      assert.equal(heartbeat.result.status, 'heartbeat_ok');
      assert.ok(
        hostConfig.workspaces.some(
          (entry) =>
            path.resolve(entry.workspace) === path.resolve(unknownWorkspace) &&
            entry.user_id === 'alice' &&
            entry.project_id === 'unknown-project'
        )
      );
      assert.ok(fs.existsSync(path.join(unknownWorkspace, '.context-anchor', 'sessions', 'unknown-session', 'state.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('manual onboarding mode returns configuration guidance instead of auto-registering ownership', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const unknownWorkspace = path.join(workspace, 'unknown-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace: path.join(workspace, 'configured-project'),
        autoRegisterWorkspaces: false,
        addUsers: [],
        addWorkspaces: []
      });

      const startup = handleHookEvent('gateway:startup', {
        workspace: unknownWorkspace
      });
      const heartbeat = handleHookEvent('heartbeat', {
        workspace: unknownWorkspace,
        session_key: 'unknown-session',
        usage_percent: 70
      });
      const hostConfig = readJson(getHostConfigFile(openClawHome), {});

      assert.equal(startup.status, 'needs_configuration');
      assert.equal(heartbeat.status, 'needs_configuration');
      assert.equal(hostConfig.onboarding.auto_register_workspaces, false);
      assert.match(startup.configure_command, /configure-host\.js/);
      assert.match(heartbeat.message, /not registered yet/);
      assert.equal(fs.existsSync(path.join(unknownWorkspace, '.context-anchor')), false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('one-click install preserves memories while cleaning previous install files when requested', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const memoryFile = path.join(openClawHome, 'context-anchor', 'users', 'default-user', 'memories.json');
  const staleInstalledFile = path.join(openClawHome, 'skills', 'context-anchor', 'stale.txt');
  const staleHookFile = path.join(openClawHome, 'hooks', 'context-anchor-hook', 'stale.txt');
  const staleAutomationFile = path.join(openClawHome, 'automation', 'context-anchor', 'stale.txt');

  try {
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, '{"memories":[{"id":"keep-me"}]}\n', 'utf8');
    fs.mkdirSync(path.dirname(staleInstalledFile), { recursive: true });
    fs.writeFileSync(staleInstalledFile, 'stale', 'utf8');
    fs.mkdirSync(path.dirname(staleHookFile), { recursive: true });
    fs.writeFileSync(staleHookFile, 'stale', 'utf8');
    fs.mkdirSync(path.dirname(staleAutomationFile), { recursive: true });
    fs.writeFileSync(staleAutomationFile, 'stale', 'utf8');

    const result = await runOneClickInstall(openClawHome, undefined, {
      applyConfig: false,
      enableScheduler: false,
      defaultUserId: 'default-user',
      defaultWorkspace: null,
      addUsers: [],
      addWorkspaces: [],
      ask: async (prompt) => {
        if (prompt.includes('Clean previous install files')) {
          return true;
        }

        if (prompt.includes('Preserve these memories')) {
          return true;
        }

        throw new Error(`Unexpected prompt: ${prompt}`);
      }
    });

    assert.equal(result.status, 'installed');
    assert.equal(result.previous_install_detected, true);
    assert.equal(result.previous_memory_detected, true);
    assert.equal(result.preserved_memories, true);
    assert.ok(fs.existsSync(memoryFile));
    assert.equal(fs.existsSync(staleInstalledFile), false);
    assert.equal(fs.existsSync(staleHookFile), false);
    assert.equal(fs.existsSync(staleAutomationFile), false);
    assert.ok(fs.existsSync(path.join(openClawHome, 'skills', 'context-anchor', 'SKILL.md')));
    assert.equal(result.configuration.config.status, 'skipped');
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('one-click install can drop old memories when requested', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const memoryRoot = path.join(openClawHome, 'context-anchor');

  try {
    fs.mkdirSync(path.join(memoryRoot, 'users', 'default-user'), { recursive: true });
    fs.writeFileSync(path.join(memoryRoot, 'users', 'default-user', 'memories.json'), '{"memories":[]}\n', 'utf8');

    const result = await runOneClickInstall(openClawHome, undefined, {
      assumeYes: true,
      preserveMemories: false
    });

    assert.equal(result.status, 'installed');
    assert.equal(result.preserved_memories, false);
    assert.equal(fs.existsSync(memoryRoot), false);
    assert.ok(fs.existsSync(path.join(openClawHome, 'skills', 'context-anchor', 'SKILL.md')));
    assert.equal(result.configuration.config.status, 'applied');
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('one-click install can apply recommended config without reinstall prompts', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      const result = await runOneClickInstall(openClawHome, undefined, {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: []
      });
      const config = readJson(path.join(openClawHome, 'openclaw.json'), {});

      assert.equal(result.status, 'installed');
      assert.equal(result.configuration.config.status, 'applied');
      assert.equal(config.hooks.internal.enabled, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('upgrade-sessions refreshes registered active sessions and skips closed sessions by default', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const activeWorkspace = path.join(workspace, 'active-project');
  const closedWorkspace = path.join(workspace, 'closed-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: activeWorkspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: closedWorkspace,
            userId: 'peter',
            projectId: 'closed-project'
          }
        ]
      });

      runSessionStart(activeWorkspace, 'active-session', 'active-project', {
        userId: 'peter'
      });
      runMemorySave(
        activeWorkspace,
        'active-session',
        'session',
        'best_practice',
        'Keep active session upgradeable',
        JSON.stringify({ heat: 92, details: 'active session memory' })
      );
      const activeStateFile = path.join(
        activeWorkspace,
        '.context-anchor',
        'sessions',
        'active-session',
        'state.json'
      );
      const activeState = readJson(activeStateFile, {});
      activeState.active_task = 'refresh the active session';
      writeJson(activeStateFile, activeState);

      runSessionStart(closedWorkspace, 'closed-session', 'closed-project', {
        userId: 'peter'
      });
      runSessionClose(closedWorkspace, 'closed-session', {
        reason: 'manual-close'
      });

      const result = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'));
      const activeResult = result.results.find((entry) => entry.session_key === 'active-session');
      const closedResult = result.results.find((entry) => entry.session_key === 'closed-session');
      const activeBootstrap = path.join(
        activeWorkspace,
        '.context-anchor',
        'sessions',
        'active-session',
        'openclaw-bootstrap.md'
      );

      assert.equal(result.status, 'ok');
      assert.equal(result.upgraded_sessions, 1);
      assert.equal(activeResult.action, 'upgraded');
      assert.equal(closedResult.action, 'skipped');
      assert.equal(closedResult.reason, 'closed_session');
      assert.ok(fs.existsSync(activeBootstrap));
      assert.match(fs.readFileSync(activeBootstrap, 'utf8'), /refresh the active session/);
      assert.equal(
        fs.existsSync(
          path.join(closedWorkspace, '.context-anchor', 'sessions', 'closed-session', 'openclaw-bootstrap.md')
        ),
        false
      );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('one-click install can upgrade existing sessions after refreshing runtime assets', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const sessionWorkspace = path.join(workspace, 'workspace-a');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const transcriptFile = path.join(agentSessionsDir, 'openclaw-session-a.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      runSessionStart(sessionWorkspace, 'agent:main:main', 'workspace-a', {
        userId: 'default-user',
        openClawSessionId: 'openclaw-session-a'
      });
      const sessionStateFile = path.join(
        sessionWorkspace,
        '.context-anchor',
        'sessions',
        'agent-main-main',
        'state.json'
      );
      const sessionState = readJson(sessionStateFile, {});
      sessionState.active_task = 'refresh runtime for stored session';
      writeJson(sessionStateFile, sessionState);

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(transcriptFile, sessionWorkspace, 'openclaw-session-a');
      writeJson(sessionsIndex, {
        'agent:main:main': {
          sessionId: 'openclaw-session-a',
          sessionFile: transcriptFile,
          updatedAt: 1774705704043,
          chatType: 'direct'
        }
      });

      const result = await runOneClickInstall(openClawHome, undefined, {
        assumeYes: true,
        preserveMemories: true,
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: sessionWorkspace,
        addUsers: [],
        addWorkspaces: [],
        upgradeSessions: true
      });
      const bootstrapFile = path.join(
        sessionWorkspace,
        '.context-anchor',
        'sessions',
        'agent-main-main',
        'openclaw-bootstrap.md'
      );

      assert.equal(result.status, 'installed');
      assert.equal(result.session_upgrade.status, 'ok');
      assert.equal(result.session_upgrade.upgraded_sessions, 1);
      assert.ok(fs.existsSync(bootstrapFile));
      assert.match(fs.readFileSync(bootstrapFile, 'utf8'), /refresh runtime for stored session/);
      assert.ok(fs.existsSync(path.join(openClawHome, 'skills', 'context-anchor', 'SKILL.md')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('discoverOpenClawSessions resolves real workspaces and leaves unresolved sessions explicit', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const indexedSessionFile = path.join(agentSessionsDir, 'session-a.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');
  const resolvedWorkspace = path.join(workspace, 'workspace-a');

  try {
    fs.mkdirSync(agentSessionsDir, { recursive: true });
    writeSessionTranscript(indexedSessionFile, resolvedWorkspace, 'session-a');
    writeJson(sessionsIndex, {
      'agent:main:main': {
        sessionId: 'session-a',
        sessionFile: indexedSessionFile,
        updatedAt: 1774705355999,
        chatType: 'direct'
      },
      'agent:main:group:missing': {
        sessionId: 'missing-session',
        updatedAt: 1774705356000
      }
    });

    const sessions = discoverOpenClawSessions(openClawHome);
    const resolved = sessions.find((entry) => entry.session_key === 'agent:main:main');
    const unresolved = sessions.find((entry) => entry.session_key === 'agent:main:group:missing');

    assert.equal(sessions.length, 2);
    assert.equal(resolved.workspace, path.resolve(resolvedWorkspace));
    assert.equal(resolved.workspace_source, 'cwd');
    assert.equal(unresolved.workspace, null);
    assert.equal(unresolved.transcript_exists, false);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-sessions prompts per session and preserves configured sessions while onboarding new ones', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const newWorkspace = path.join(workspace, 'new-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const configuredSessionFile = path.join(agentSessionsDir, 'configured.jsonl');
  const newSessionFile = path.join(agentSessionsDir, 'new.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');
  const schedulerCalls = [];

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: true,
        defaultUserId: 'peter',
        schedulerWorkspace: configuredWorkspace,
        schedulerUserId: 'peter',
        schedulerProjectId: 'configured-workspace',
        schedulerRegistrar: () => {}
      });
      runSessionStart(configuredWorkspace, 'agent:main:main', 'configured-workspace', {
        userId: 'peter',
        openClawSessionId: 'openclaw-session-a'
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(configuredSessionFile, configuredWorkspace, 'openclaw-session-a');
      writeSessionTranscript(newSessionFile, newWorkspace, 'openclaw-session-b');
      writeJson(sessionsIndex, {
        'agent:main:main': {
          sessionId: 'openclaw-session-a',
          sessionFile: configuredSessionFile,
          updatedAt: 1774705704043,
          chatType: 'direct'
        },
        'agent:main:new': {
          sessionId: 'openclaw-session-b',
          sessionFile: newSessionFile,
          updatedAt: 1774705705000,
          chatType: 'direct'
        }
      });

      const result = await runConfigureSessions(openClawHome, path.join(openClawHome, 'skills'), {
        ask: async (prompt, defaultValue) => {
          if (prompt.includes('agent:main:main')) {
            return 'skip';
          }

          if (prompt.includes('agent:main:new')) {
            return 'configure';
          }

          return defaultValue;
        },
        schedulerRegistrar: (...args) => {
          schedulerCalls.push(args);
        }
      });

      const configuredState = readJson(
        path.join(configuredWorkspace, '.context-anchor', 'sessions', 'agent-main-main', 'state.json'),
        {}
      );
      const newState = readJson(
        path.join(newWorkspace, '.context-anchor', 'sessions', 'agent-main-new', 'state.json'),
        {}
      );
      const hostConfig = readJson(path.join(openClawHome, 'context-anchor-host-config.json'), {});

      assert.equal(result.discovered_sessions, 2);
      assert.equal(result.skipped_sessions, 1);
      assert.equal(result.configured_sessions, 1);
      assert.equal(result.results.find((entry) => entry.session_key === 'agent:main:main').action, 'skipped');
      assert.equal(result.results.find((entry) => entry.session_key === 'agent:main:new').action, 'configured');
      assert.equal(configuredState.session_key, 'agent-main-main');
      assert.equal(newState.session_key, 'agent-main-new');
      assert.equal(newState.project_id, path.basename(newWorkspace));
      assert.ok(hostConfig.workspaces.some((entry) => entry.workspace === path.resolve(newWorkspace)));
      assert.ok(hostConfig.sessions.some((entry) => entry.session_key === 'agent-main-new'));
      assert.equal(result.results.find((entry) => entry.session_key === 'agent:main:new').workspace_setup.status, 'auto_registered');
      assert.equal(schedulerCalls.length, 0);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-sessions can target a single workspace without touching others', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const targetWorkspace = path.join(workspace, 'target-workspace');
  const otherWorkspace = path.join(workspace, 'other-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const targetTranscript = path.join(agentSessionsDir, 'target.jsonl');
  const otherTranscript = path.join(agentSessionsDir, 'other.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(targetTranscript, targetWorkspace, 'target-session-id');
      writeSessionTranscript(otherTranscript, otherWorkspace, 'other-session-id');
      writeJson(sessionsIndex, {
        'agent:main:target': {
          sessionId: 'target-session-id',
          sessionFile: targetTranscript,
          updatedAt: 1774705709043,
          chatType: 'direct'
        },
        'agent:main:other': {
          sessionId: 'other-session-id',
          sessionFile: otherTranscript,
          updatedAt: 1774705708043,
          chatType: 'direct'
        }
      });

      const result = await runConfigureSessions(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        workspace: targetWorkspace,
        schedulerRegistrar: () => {}
      });

      assert.equal(result.selected_sessions, 1);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].workspace, path.resolve(targetWorkspace));
      assert.ok(fs.existsSync(path.join(targetWorkspace, '.context-anchor', 'sessions', 'agent-main-target', 'state.json')));
      assert.equal(fs.existsSync(path.join(otherWorkspace, '.context-anchor', 'sessions', 'agent-main-other', 'state.json')), false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session status overview groups workspaces and shows skill, hook, and monitor states', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const unregisteredWorkspace = path.join(workspace, 'unregistered-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const configuredReadyTranscript = path.join(agentSessionsDir, 'configured-ready.jsonl');
  const configuredPartialTranscript = path.join(agentSessionsDir, 'configured-partial.jsonl');
  const unregisteredTranscript = path.join(agentSessionsDir, 'unregistered.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: true,
        defaultUserId: 'peter',
        defaultWorkspace: configuredWorkspace,
        schedulerWorkspace: configuredWorkspace,
        schedulerUserId: 'peter',
        schedulerProjectId: 'configured-workspace',
        schedulerRegistrar: () => {}
      });

      runSessionStart(configuredWorkspace, 'agent:main:main', 'configured-workspace', {
        userId: 'peter',
        openClawSessionId: 'ready-session-id'
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(configuredReadyTranscript, configuredWorkspace, 'ready-session-id');
      writeSessionTranscript(configuredPartialTranscript, configuredWorkspace, 'partial-session-id');
      writeSessionTranscript(unregisteredTranscript, unregisteredWorkspace, 'unregistered-session-id');
      writeJson(sessionsIndex, {
        'agent:main:main': {
          sessionId: 'ready-session-id',
          sessionFile: configuredReadyTranscript,
          updatedAt: 1774705704043,
          chatType: 'direct'
        },
        'agent:main:resume': {
          sessionId: 'partial-session-id',
          sessionFile: configuredPartialTranscript,
          updatedAt: 1774705705043,
          chatType: 'direct'
        },
        'agent:main:unregistered': {
          sessionId: 'unregistered-session-id',
          sessionFile: unregisteredTranscript,
          updatedAt: 1774705706043,
          chatType: 'direct'
        },
        'agent:main:ghost': {
          sessionId: 'ghost-session-id',
          updatedAt: 1774705707043,
          chatType: 'direct'
        }
      });

      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'), {
        schedulerProbe: () => 'running'
      });
      const rendered = renderOpenClawSessionStatusReport(report);
      const diagnosisRendered = renderOpenClawSessionDiagnosisReport(report);
      const configuredGroup = report.groups.find((entry) => entry.workspace && entry.workspace.endsWith('configured-workspace'));
      const unregisteredGroup = report.groups.find((entry) => entry.workspace && entry.workspace.endsWith('unregistered-workspace'));
      const unresolvedGroup = report.groups.find((entry) => entry.workspace === null);

      assert.equal(report.summary.total_sessions, 4);
      assert.equal(report.summary.ready_sessions, 1);
      assert.equal(report.summary.attention_sessions, 3);
      assert.equal(report.summary.unresolved_sessions, 1);
      assert.equal(configuredGroup.hook_status, 'on');
      assert.equal(configuredGroup.monitor_status, 'running');
      assert.equal(configuredGroup.mirror.available, true);
      assert.ok(configuredGroup.mirror.collections >= 1);
      assert.ok(configuredGroup.mirror.documents >= 1);
      assert.ok(configuredGroup.mirror.indexed_sessions >= 1);
      assert.equal(
        configuredGroup.sessions.find((entry) => entry.session_key === 'agent:main:main').classification.skill,
        'ready'
      );
      assert.equal(
        configuredGroup.sessions.find((entry) => entry.session_key === 'agent:main:resume').classification.skill,
        'partial'
      );
      assert.equal(unregisteredGroup.hook_status, 'off');
      assert.equal(unregisteredGroup.monitor_status, 'off');
      assert.equal(unregisteredGroup.mirror.available, false);
      assert.equal(unregisteredGroup.sessions[0].classification.skill, 'missing');
      assert.equal(unresolvedGroup.mirror.available, false);
      assert.equal(unresolvedGroup.sessions[0].classification.skill, 'unknown');
      assert.match(report.commands.diagnostic_command, /diagnose:sessions/);
      assert.match(report.commands.repair_command, /configure:sessions/);
      assert.match(configuredGroup.diagnostic_command, /--workspace/);
      assert.match(rendered, /Mirror: ON/);
      assert.match(diagnosisRendered, /Mirror: ON/);
      assert.match(configuredGroup.repair_command, /--workspace/);
      assert.match(rendered, /Context-Anchor Session Overview/);
      assert.match(rendered, /Diagnostic command:/);
      assert.match(rendered, /Repair command:/);
      assert.match(rendered, /Warning: 3 session\(s\) need attention/);
      assert.match(rendered, /Workspace: .*configured-workspace/);
      assert.match(rendered, /Hook: ON/);
      assert.match(rendered, /Monitor: RUNNING/);
      assert.match(rendered, /READY/);
      assert.match(rendered, /PARTIAL/);
      assert.match(rendered, /MISSING/);
      assert.match(rendered, /UNKNOWN/);
      assert.match(rendered, /ready-session-id/);
      assert.match(diagnosisRendered, /Context-Anchor Session Diagnosis/);
      assert.match(diagnosisRendered, /Issues:/);
      assert.match(diagnosisRendered, /Diagnose:/);
      assert.match(diagnosisRendered, /Repair:/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host refuses to overwrite an invalid openclaw.json', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configFile = path.join(openClawHome, 'openclaw.json');

  try {
    await withOpenClawHome(workspace, async () => {
      fs.mkdirSync(openClawHome, { recursive: true });
      fs.writeFileSync(configFile, '{"broken": ', 'utf8');

      await assert.rejects(
        () => runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
          applyConfig: true,
          enableScheduler: false,
          defaultUserId: 'default-user',
          defaultWorkspace: null,
          addUsers: [],
          addWorkspaces: []
        }),
        /is not valid JSON/
      );
      assert.equal(fs.readFileSync(configFile, 'utf8'), '{"broken": ');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor reports installed absolute paths and wrapper returns a helpful payload error', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      const result = runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: []
      });
      const doctor = runDoctor({ openclawHome: openClawHome });

      assert.equal(doctor.status, 'ok');
      assert.equal(doctor.installation.ready, true);
      assert.equal(doctor.paths.hook_handler, result.hook_handler);
      assert.equal(doctor.paths.monitor_script, result.monitor_script);
      assert.equal(doctor.paths.workspace_monitor_script, result.workspace_monitor_script);
      assert.ok(fs.existsSync(result.doctor_script));
      assert.equal(doctor.configuration.ready, true);
      assert.ok(doctor.commands.hook_with_payload_file.includes(result.hook_handler));
      assert.match(doctor.commands.rebuild_mirror, /mirror-rebuild\.js/);

      assert.throws(
        () => execFileSync(process.execPath, [result.hook_handler, 'heartbeat', '{broken-json'], { encoding: 'utf8' }),
        (error) => {
          assert.match(error.stdout || '', /Payload must be valid JSON or a path to a JSON file/);
          return true;
        }
      );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('mirror-rebuild backfills sqlite mirrors from existing JSON assets', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'mirror-rebuild-session', 'demo');
      runMemorySave(
        workspace,
        'mirror-rebuild-session',
        'session',
        'best_practice',
        'Backfill checkout retry memory',
        JSON.stringify({ heat: 96 })
      );
      runMemorySave(
        workspace,
        'mirror-rebuild-session',
        'user',
        'best_practice',
        'Backfill user summary preference',
        JSON.stringify({
          user_id: 'default-user',
          heat: 72
        })
      );
      runSessionClose(workspace, 'mirror-rebuild-session', {
        reason: 'session-end'
      });

      const paths = createPaths(workspace);
      const workspaceDb = path.join(workspace, '.context-anchor', 'catalog.sqlite');
      const userDb = path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'catalog.sqlite');
      if (fs.existsSync(workspaceDb)) {
        fs.rmSync(workspaceDb, { force: true });
      }
      if (fs.existsSync(userDb)) {
        fs.rmSync(userDb, { force: true });
      }

      const result = runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));
      const sessionMemoryMirror = readMirrorCollection(sessionMemoryFile(paths, 'mirror-rebuild-session'), 'entries');
      const sessionSummaryMirror = readMirrorDocument(sessionSummaryFile(paths, 'mirror-rebuild-session'));
      const userMemoryMirror = readMirrorCollection(
        path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'default-user', 'memories.json'),
        'memories'
      );

      assert.equal(result.status, 'ok');
      assert.ok(result.workspaces_processed.some((entry) => entry === workspace));
      assert.ok(result.users_processed.includes('default-user'));
      assert.ok(result.collections_synced >= 1);
      assert.ok(result.documents_synced >= 1);
      assert.ok(fs.existsSync(workspaceDb));
      assert.ok(fs.existsSync(userDb));
      assert.equal(sessionMemoryMirror.status, 'available');
      assert.equal(sessionSummaryMirror.status, 'available');
      assert.equal(userMemoryMirror.status, 'available');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('workspace monitor runs maintenance for recent sessions without extending their last_active time', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(workspace, 'monitor-session', 'demo');
      runMemorySave(
        workspace,
        'monitor-session',
        'session',
        'decision',
        'keep last_active stable',
        JSON.stringify({ heat: 90 })
      );
      runMemorySave(
        workspace,
        'monitor-session',
        'session',
        'best_practice',
        'keep maintenance accumulation continuous',
        JSON.stringify({ heat: 94, details: 'monitor derived experience' })
      );

      const stateFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'monitor-session',
        'state.json'
      );
      const indexFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        '_index.json'
      );
      const state = readJson(stateFile, {});
      const index = readJson(indexFile, { sessions: [] });
      const preservedLastActive = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      state.last_active = preservedLastActive;
      index.sessions[0].last_active = state.last_active;
      writeJson(stateFile, state);
      writeJson(indexFile, index);

      const result = runWorkspaceMonitor(workspace, {
        windowMs: 7 * 24 * 60 * 60 * 1000
      });
      const experiencesFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'monitor-session',
        'experiences.json'
      );
      const experiences = readJson(experiencesFile, { experiences: [] }).experiences;
      const nextState = readJson(stateFile, {});
      const nextIndex = readJson(indexFile, { sessions: [] });

      assert.equal(result.status, 'processed');
      assert.equal(result.handled_sessions, 1);
      assert.equal(result.results[0].session_experiences.created, 1);
      assert.equal(experiences.length, 1);
      assert.equal(experiences[0].summary, 'keep maintenance accumulation continuous');
      assert.equal(nextState.last_active, preservedLastActive);
      assert.equal(nextIndex.sessions[0].last_active, preservedLastActive);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('workspace monitor auto-registers a first-seen workspace before processing', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const monitoredWorkspace = path.join(workspace, 'fresh-workspace');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace: path.join(workspace, 'configured-project'),
        addUsers: [],
        addWorkspaces: []
      });

      const result = runWorkspaceMonitor(monitoredWorkspace);
      const hostConfig = readJson(getHostConfigFile(openClawHome), {});

      assert.equal(result.status, 'idle');
      assert.equal(result.onboarding.status, 'auto_registered');
      assert.ok(
        hostConfig.workspaces.some(
          (entry) =>
            path.resolve(entry.workspace) === path.resolve(monitoredWorkspace) &&
            entry.user_id === 'alice' &&
            entry.project_id === 'fresh-workspace'
        )
      );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('hook handler rejects missing required payload fields before mutating state', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      assert.throws(
        () => handleHookEvent('gateway:startup', {}),
        /gateway:startup requires payload field\(s\): workspace/
      );

      assert.throws(
        () => handleHookEvent('heartbeat', { workspace }),
        /heartbeat requires payload field\(s\): session_key/
      );

      assert.throws(
        () => handleHookEvent('command:stop', { workspace }),
        /command:stop requires payload field\(s\): session_key/
      );

      assert.equal(fs.existsSync(path.join(workspace, '.context-anchor')), false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('workspace basename is used as the default project id for project-scoped commands', () => {
  const root = makeWorkspace();
  const workspace = path.join(root, 'named-project');
  const skillsRoot = path.join(root, 'skills-root');

  fs.mkdirSync(workspace, { recursive: true });

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'named-session');
      const saved = runMemorySave(
        workspace,
        'named-session',
        'project',
        'best_practice',
        'Named project checklist',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-a', 'session-b']
        })
      );

      const validated = runExperienceValidate(workspace, saved.id, 'validated');
      assert.equal(validated.project_id, 'named-project');

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'named-project', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      const score = runSkillificationScore(workspace);
      const heat = runHeatEvaluation(workspace);
      const created = runSkillCreate(workspace, saved.id, 'portable-skill', undefined, { skillsRoot });
      const skillIndex = readJson(path.join(skillsRoot, '_skill-index.json'), { skills: [] });

      assert.equal(score.project_id, 'named-project');
      assert.equal(heat.project_id, 'named-project');
      assert.equal(created.skill_name, 'portable-skill');
      assert.equal(skillIndex.skills[0].source_project, 'named-project');
    });
  } finally {
    cleanupWorkspace(root);
  }
});

test('workspace basename is used as the default project id for project skill governance commands', () => {
  const root = makeWorkspace();
  const workspace = path.join(root, 'named-project');

  fs.mkdirSync(workspace, { recursive: true });

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'named-session');
      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'named-project', 'experiences.json');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'named-project', 'skills');

      runMemorySave(
        workspace,
        'named-session',
        'project',
        'best_practice',
        'Govern named project skill',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-a', 'session-b'],
          validation_status: 'validated'
        })
      );

      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'named-session',
        userId: 'default-user'
      });

      let projectSkills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;
      const statusUpdated = runSkillStatusUpdate(workspace, 'project', projectSkills[0].id, 'inactive');
      assert.equal(statusUpdated.project_id, 'named-project');

      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'winner-skill',
            name: 'winner-skill',
            conflict_key: 'winner-skill',
            scope: 'project',
            status: 'active'
          },
          {
            id: 'loser-skill',
            name: 'loser-skill',
            conflict_key: 'loser-skill',
            scope: 'project',
            status: 'active'
          }
        ]
      });

      const superseded = runSkillSupersede(workspace, 'project', 'winner-skill', 'loser-skill');
      const reconciled = runSkillReconcile(workspace, { userId: 'default-user' });

      assert.equal(superseded.project_id, 'named-project');
      assert.equal(reconciled.project_id, 'named-project');
    });
  } finally {
    cleanupWorkspace(root);
  }
});

test('skill-create rejects path traversal skill names', () => {
  const workspace = makeWorkspace();
  const skillsRoot = path.join(workspace, 'skills-root');

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'path-skill', 'demo');
      const saved = runMemorySave(
        workspace,
        'path-skill',
        'project',
        'best_practice',
        'Portable skill only',
        JSON.stringify({
          validation_status: 'validated'
        })
      );

      assert.throws(
        () => runSkillCreate(workspace, saved.id, '../escape', undefined, { skillsRoot }),
        /single directory name/
      );
      assert.equal(fs.existsSync(path.join(workspace, 'escape')), false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start loads user scope memories and skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runMemorySave(
        workspace,
        'bootstrap-session',
        'user',
        'preference',
        'language:zh-CN',
        JSON.stringify({ user_id: 'default-user' })
      );
      runMemorySave(
        workspace,
        'bootstrap-session',
        'user',
        'best_practice',
        'Prefer concise summaries',
        JSON.stringify({
          user_id: 'default-user',
          heat: 90,
          access_sessions: ['other-session']
        })
      );
      const openClawHome = path.join(workspace, 'openclaw-home');
      const userSkillDir = path.join(openClawHome, 'context-anchor', 'users', 'default-user', 'skills');
      fs.mkdirSync(userSkillDir, { recursive: true });
      writeJson(path.join(userSkillDir, 'index.json'), {
        skills: [
          {
            id: 'user-skill-1',
            name: 'default-user-skill',
            scope: 'user',
            status: 'active',
            summary: 'Loaded at session start'
          }
        ]
      });

      const result = runSessionStart(workspace, 'session-user-load');
      assert.equal(result.user.id, 'default-user');
      assert.ok(result.memories_to_inject.some((entry) => entry.source === 'user_preferences'));
      assert.ok(result.persistent_memory.catalogs.some((entry) => entry.source === 'user_experiences'));
      assert.equal(result.skills_to_activate.user.length, 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('bootstrap cache keeps only short-term hot memory in context and leaves long-term memory persisted', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'memory-source', 'demo');
      runMemorySave(
        workspace,
        'memory-source',
        'session',
        'best_practice',
        'Use checkout retry budget before restarting the worker',
        JSON.stringify({
          heat: 98,
          details: 'short-term operational memory'
        })
      );
      runMemorySave(
        workspace,
        'memory-source',
        'project',
        'fact',
        'warm archive note '.repeat(140),
        JSON.stringify({
          summary: 'Large persisted project fact',
          heat: 45
        })
      );
      runMemorySave(
        workspace,
        'memory-source',
        'project',
        'best_practice',
        'warm archive practice '.repeat(120),
        JSON.stringify({
          summary: 'Large persisted project experience',
          heat: 72,
          validation_status: 'validated'
        })
      );
      runMemorySave(
        workspace,
        'memory-source',
        'user',
        'best_practice',
        'user archive preference '.repeat(120),
        JSON.stringify({
          user_id: 'default-user',
          summary: 'Large persisted user experience',
          heat: 75,
          validation_status: 'validated'
        })
      );

      runSessionClose(workspace, 'memory-source', {
        reason: 'command-reset',
        usagePercent: 84
      });

      const result = runSessionStart(workspace, 'memory-target', 'demo');
      const bootstrap = buildBootstrapCacheContent(result);
      const packet = loadCompactPacket(createPaths(workspace), 'memory-source');

      assert.ok(result.memories_to_inject.some((entry) => entry.source === 'short_term_hot_memories'));
      assert.ok(result.persistent_memory.catalogs.some((entry) => entry.source === 'project_facts'));
      assert.ok(result.persistent_memory.catalogs.some((entry) => entry.source === 'project_experiences'));
      assert.ok(result.persistent_memory.catalogs.some((entry) => entry.source === 'user_experiences'));
      assert.ok(Buffer.byteLength(bootstrap, 'utf8') <= DEFAULTS.bootstrapContextBudget);
      assert.match(bootstrap, /Short-Term Hot Memory/);
      assert.match(bootstrap, /checkout retry budget/);
      assert.match(bootstrap, /Long-Term Memory/);
      assert.match(bootstrap, /lookup:/i);
      assert.doesNotMatch(bootstrap, /truncated to stay within the 10K bootstrap budget/i);
      assert.doesNotMatch(bootstrap, /warm archive note warm archive note/);
      assert.ok(Array.isArray(packet.memory_tiers.hot.session_memories));
      assert.ok(packet.memory_tiers.hot.session_memories.some((entry) => entry.summary.includes('checkout retry budget')));
      assert.ok(packet.persistent_memory.catalogs.some((entry) => entry.source === 'project_facts'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('bootstrap cache compacts semantically under a tight budget instead of hard truncating', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'tight-budget-source', 'demo');

      for (let index = 0; index < 5; index += 1) {
        runMemorySave(
          workspace,
          'tight-budget-source',
          'session',
          'best_practice',
          `Checkout retry budget rule ${index}: retry worker restart only after bounded checkout recovery and dependency cache verification`,
          JSON.stringify({
            heat: 95 - index
          })
        );
      }

      runMemorySave(
        workspace,
        'tight-budget-source',
        'user',
        'preference',
        'language:zh-CN',
        JSON.stringify({ user_id: 'default-user' })
      );
      runMemorySave(
        workspace,
        'tight-budget-source',
        'project',
        'best_practice',
        'Stabilize checkout retries with bounded retry budget and cache verification',
        JSON.stringify({
          heat: 88,
          validation_status: 'validated'
        })
      );

      const sourceStateFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'tight-budget-source',
        'state.json'
      );
      const sourceState = readJson(sourceStateFile, {});
      sourceState.active_task = 'stabilize checkout retries without wasting context';
      sourceState.commitments = [
        {
          id: 'tight-1',
          what: 'verify checkout retry budget',
          status: 'pending'
        },
        {
          id: 'tight-2',
          what: 'confirm cache verification order',
          status: 'pending'
        }
      ];
      writeJson(sourceStateFile, sourceState);

      runSessionClose(workspace, 'tight-budget-source', {
        reason: 'command-reset',
        usagePercent: 83
      });

      const result = runSessionStart(workspace, 'tight-budget-target', 'demo');
      const bootstrap = buildBootstrapCacheContent(result, {
        budgetBytes: 700
      });

      assert.ok(Buffer.byteLength(bootstrap, 'utf8') <= 700);
      assert.doesNotMatch(bootstrap, /truncated to stay within the 10K bootstrap budget/i);
      assert.match(bootstrap, /Context Anchor Session Memory/);
      assert.match(bootstrap, /checkout retry/);
      assert.match(bootstrap, /Long-Term Memory/);
      assert.match(bootstrap, /\+\d+ more/);
      assert.match(bootstrap, /lookup:/i);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start continues from the latest related session and recommends reusable assets', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'previous-session', 'demo');
      const sessionFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'previous-session',
        'state.json'
      );
      const previousState = readJson(sessionFile, {});
      previousState.active_task = 'stabilize checkout pipeline';
      previousState.commitments = [
        {
          id: 'commitment-1',
          what: 'stabilize checkout pipeline',
          status: 'pending'
        }
      ];
      writeJson(sessionFile, previousState);

      runMemorySave(
        workspace,
        'previous-session',
        'project',
        'best_practice',
        'Stabilize checkout pipeline with retries',
        JSON.stringify({
          heat: 95,
          access_count: 6,
          access_sessions: ['older-session'],
          validation_status: 'validated'
        })
      );

      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-checkout',
            name: 'checkout-pipeline-playbook',
            scope: 'project',
            status: 'active',
            summary: 'Use retries to stabilize checkout pipeline',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          }
        ]
      });

      runSessionClose(workspace, 'previous-session', {
        reason: 'command-reset',
        usagePercent: 82
      });

      const result = runSessionStart(workspace, 'continued-session', 'demo');

      assert.equal(result.session.continued_from, 'previous-session');
      assert.equal(result.recovery.active_task, 'stabilize checkout pipeline');
      assert.equal(result.recovery.pending_commitments.length, 1);
      assert.equal(result.recovery.continuity.source_session_key, 'previous-session');
      assert.ok(result.recommended_reuse.experiences.some((entry) => entry.summary.includes('checkout pipeline')));
      assert.ok(result.recommended_reuse.skills.some((entry) => entry.scope === 'project'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('memory-search retrieves persisted long-term memory on demand', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'lookup-session', 'demo');
      runMemorySave(
        workspace,
        'lookup-session',
        'project',
        'fact',
        'Checkout retry budget is capped at three attempts',
        JSON.stringify({
          heat: 55
        })
      );
      runMemorySave(
        workspace,
        'lookup-session',
        'project',
        'best_practice',
        'Use checkout retries with a bounded retry budget',
        JSON.stringify({
          heat: 88,
          validation_status: 'validated'
        })
      );
      runMemorySave(
        workspace,
        'lookup-session',
        'user',
        'best_practice',
        'Prefer concise retry summaries for checkout incidents',
        JSON.stringify({
          user_id: 'default-user',
          heat: 70
        })
      );

      const result = runMemorySearch(workspace, 'lookup-session', 'checkout retry budget');

      assert.equal(result.status, 'ok');
      assert.ok(result.returned > 0);
      assert.equal(result.results[0].source, 'project_experiences');
      assert.match(result.results[0].summary, /retry budget/);
      assert.ok(result.results.some((entry) => entry.source === 'project_facts'));
      assert.ok(result.scope_summary.project_experiences.count >= 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start auto-recovers unfinished continuation assets before restoring context', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'handoff-source', 'demo');
      runMemorySave(
        workspace,
        'handoff-source',
        'session',
        'best_practice',
        'Use retry budget to stabilize checkout pipeline',
        JSON.stringify({
          heat: 95,
          details: 'observed during interrupted run',
          tags: ['checkout', 'retry']
        })
      );

      const sourceStateFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'handoff-source',
        'state.json'
      );
      const sourceState = readJson(sourceStateFile, {});
      sourceState.active_task = 'stabilize checkout pipeline';
      sourceState.commitments = [
        {
          id: 'handoff-commitment',
          what: 'stabilize checkout pipeline',
          status: 'pending'
        }
      ];
      writeJson(sourceStateFile, sourceState);
      const preservedLastActive = readJson(sourceStateFile, {}).last_active;

      const result = runSessionStart(workspace, 'handoff-target', 'demo');
      const compactPacketFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'handoff-source',
        'compact-packet.json'
      );
      const projectExperiences = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json'),
        { experiences: [] }
      ).experiences;
      const recoveredState = readJson(sourceStateFile, {});

      assert.equal(result.session.continued_from, 'handoff-source');
      assert.equal(result.recovery.active_task, 'stabilize checkout pipeline');
      assert.equal(result.recovery.continuity.recovered_before_restore, true);
      assert.equal(result.recovery.continuity.source_compact_packet_available, true);
      assert.ok(fs.existsSync(compactPacketFile));
      assert.ok(projectExperiences.some((entry) => entry.summary.includes('checkout pipeline')));
      assert.equal(recoveredState.closed_at, null);
      assert.equal(recoveredState.last_active, preservedLastActive);
      assert.ok(recoveredState.metadata.continuation_recovered_at);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('managed bootstrap injects recovered continuity for an unfinished prior session', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'bootstrap-source', 'demo', {
        openClawSessionId: 'openclaw-source'
      });
      runMemorySave(
        workspace,
        'bootstrap-source',
        'session',
        'best_practice',
        'Apply checkout retries before restarting the worker',
        JSON.stringify({
          heat: 96,
          details: 'captured before crash',
          tags: ['checkout', 'retry']
        })
      );

      const sourceStateFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'bootstrap-source',
        'state.json'
      );
      const sourceState = readJson(sourceStateFile, {});
      sourceState.active_task = 'repair checkout retries';
      sourceState.commitments = [
        {
          id: 'bootstrap-commitment',
          what: 'repair checkout retries',
          status: 'pending'
        }
      ];
      writeJson(sourceStateFile, sourceState);

      const event = {
        type: 'agent',
        action: 'bootstrap',
        sessionKey: 'bootstrap-target',
        context: {
          sessionId: 'openclaw-target',
          sessionKey: 'bootstrap-target',
          workspaceDir: workspace,
          bootstrapFiles: []
        }
      };

      const result = handleManagedHookEvent(event);

      assert.equal(result.status, 'handled');
      assert.equal(result.actions[0], 'bootstrap_injected');
      assert.equal(event.context.bootstrapFiles.length, 1);
      assert.match(event.context.bootstrapFiles[0].content, /Continued from: bootstrap-source/);
      assert.match(event.context.bootstrapFiles[0].content, /repair checkout retries/);
      assert.match(event.context.bootstrapFiles[0].content, /checkout retries/);
      assert.ok(
        fs.existsSync(
          path.join(workspace, '.context-anchor', 'sessions', 'bootstrap-source', 'compact-packet.json')
        )
      );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('managed compact hooks persist checkpoint before compaction and refresh compact assets after compaction', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'compact-hook', 'demo', {
        openClawSessionId: 'openclaw-compact-hook'
      });
      runMemorySave(
        workspace,
        'compact-hook',
        'session',
        'best_practice',
        'refresh checkout retries before compaction',
        JSON.stringify({ heat: 96, details: 'compact lifecycle accumulation' })
      );

      const beforeEvent = {
        type: 'session',
        action: 'compact:before',
        sessionKey: 'compact-hook',
        context: {
          sessionId: 'openclaw-compact-hook',
          messageCount: 48,
          tokenCount: 3200
        }
      };

      const beforeResult = handleManagedHookEvent(beforeEvent);
      assert.equal(beforeResult.status, 'handled');
      assert.equal(beforeResult.result.phase, 'before');
      assert.equal(beforeResult.result.heartbeat.session_experiences.created, 1);
      assert.ok(
        fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'checkpoint.md'))
      );
      assert.ok(
        fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'openclaw-bootstrap.md'))
      );
      assert.ok(
        fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'experiences.json'))
      );

      const afterEvent = {
        type: 'session',
        action: 'compact:after',
        sessionKey: 'compact-hook',
        context: {
          sessionId: 'openclaw-compact-hook',
          messageCount: 18,
          tokenCount: 900,
          compactedCount: 30,
          firstKeptEntryId: 'entry-1'
        }
      };

      const afterResult = handleManagedHookEvent(afterEvent);
      const sessionState = readJson(
        path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'state.json'),
        {}
      );
      const sessionSkills = readJson(
        path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(afterResult.status, 'handled');
      assert.equal(afterResult.result.phase, 'after');
      assert.equal(afterResult.result.skill_draft.status, 'created');
      assert.ok(
        fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'compact-packet.json'))
      );
      assert.equal(sessionSkills.length, 1);
      assert.equal(sessionSkills[0].status, 'draft');
      assert.equal(sessionSkills[0].summary, 'refresh checkout retries before compaction');
      assert.equal(sessionState.metadata.last_compaction_event, 'after');
      assert.equal(sessionState.metadata.compaction_compacted_count, 30);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-close refreshes an existing compact-generated draft instead of duplicating it', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'compact-close-refresh', 'demo', {
        openClawSessionId: 'openclaw-compact-close-refresh'
      });
      runMemorySave(
        workspace,
        'compact-close-refresh',
        'session',
        'best_practice',
        'first compact draft',
        JSON.stringify({ heat: 88, details: 'initial compact draft source' })
      );

      handleManagedHookEvent({
        type: 'session',
        action: 'compact:before',
        sessionKey: 'compact-close-refresh',
        context: {
          sessionId: 'openclaw-compact-close-refresh'
        }
      });
      handleManagedHookEvent({
        type: 'session',
        action: 'compact:after',
        sessionKey: 'compact-close-refresh',
        context: {
          sessionId: 'openclaw-compact-close-refresh'
        }
      });

      const skillsFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'compact-close-refresh',
        'skills',
        'index.json'
      );
      const firstSkills = readJson(skillsFile, { skills: [] }).skills;
      const firstDraftId = firstSkills[0].id;

      runMemorySave(
        workspace,
        'compact-close-refresh',
        'session',
        'tool-pattern',
        'second close draft',
        JSON.stringify({ heat: 99, details: 'better final draft source' })
      );

      const result = runSessionClose(workspace, 'compact-close-refresh', {
        reason: 'session-end'
      });
      const finalSkills = readJson(skillsFile, { skills: [] }).skills;

      assert.equal(firstSkills.length, 1);
      assert.equal(result.skill_draft.status, 'updated');
      assert.equal(finalSkills.length, 1);
      assert.equal(finalSkills[0].id, firstDraftId);
      assert.equal(finalSkills[0].summary, 'second close draft');
      assert.equal(finalSkills[0].source_type, 'tool-pattern');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-close writes summary, compact packet, and session skill draft', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'session-close', 'demo');
      runMemorySave(
        workspace,
        'session-close',
        'session',
        'best_practice',
        'Always checkpoint before compaction',
        JSON.stringify({ heat: 95, details: 'session lesson' })
      );

      const result = runSessionClose(workspace, 'session-close', {
        reason: 'session-end',
        usagePercent: 88
      });

      assert.equal(result.status, 'closed');
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'session-summary.json')));
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'compact-packet.json')));
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'skills', 'index.json')));
      const skills = readJson(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'skills', 'index.json'), { skills: [] }).skills;
      assert.equal(skills.length, 1);
      const paths = createPaths(workspace);
      const compactPacket = loadCompactPacket(paths, 'session-close');
      const compactMirror = readMirrorDocument(compactPacketFile(paths, 'session-close'));
      const summaryMirror = readMirrorDocument(sessionSummaryFile(paths, 'session-close'));
      assert.equal(compactPacket.session_key, 'session-close');
      assert.equal(compactMirror.status, 'available');
      assert.equal(compactMirror.data.session_key, 'session-close');
      assert.equal(summaryMirror.status, 'available');
      assert.equal(summaryMirror.data.session_key, 'session-close');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill-draft-create prefers the highest-value session experience as source', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'draft-ranking', 'demo');
      runMemorySave(
        workspace,
        'draft-ranking',
        'session',
        'fact',
        'Minor note',
        JSON.stringify({ heat: 20 })
      );

      const experiencesFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'draft-ranking',
        'experiences.json'
      );
      writeJson(experiencesFile, {
        experiences: [
          {
            id: 'exp-high-value',
            type: 'best_practice',
            summary: 'Use rollback-safe checkout retries',
            heat: 95,
            validation: {
              status: 'validated',
              count: 1,
              auto_validated: false,
              last_reviewed_at: '2026-03-01T00:00:00Z',
              notes: []
            },
            archived: false
          }
        ]
      });

      const result = runSkillDraftCreate(workspace, 'draft-ranking');
      const skills = readJson(
        path.join(workspace, '.context-anchor', 'sessions', 'draft-ranking', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.status, 'created');
      assert.equal(skills[0].source_id, 'exp-high-value');
      assert.equal(skills[0].source_kind, 'experience');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('migrate-global-to-user imports legacy global state into user scope', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const globalFile = path.join(workspace, '.context-anchor', 'projects', '_global', 'state.json');
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      writeJson(globalFile, {
        user_preferences: {
          timezone: 'Asia/Shanghai'
        },
        important_facts: [
          {
            id: 'glob-1',
            content: 'User prefers Chinese'
          }
        ],
        global_experiences: [
          {
            id: 'glob-exp-1',
            type: 'best_practice',
            summary: 'Reuse stable prompts'
          }
        ]
      });

      const result = runMigrateGlobalToUser(workspace);
      const userMemories = loadUserMemories(require('../scripts/lib/context-anchor').createPaths(workspace), 'default-user');

      assert.equal(result.status, 'migrated');
      assert.equal(result.imported_memories, 1);
      assert.equal(userMemories.length, 1);
      assert.equal(userMemories[0].scope, 'user');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('command stop hook runs unified session close lifecycle', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(workspace, 'hook-close', 'demo');
      runMemorySave(
        workspace,
        'hook-close',
        'session',
        'best_practice',
        'Close through unified lifecycle',
        JSON.stringify({ heat: 95 })
      );

      const result = handleHookEvent('command:stop', {
        workspace,
        session_key: 'hook-close',
        project_id: 'demo',
        usage_percent: 91
      });

      assert.equal(result.status, 'handled');
      assert.equal(result.result.status, 'closed');
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'hook-close', 'session-summary.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat promotes validated project experiences into active project skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'promote-project', 'demo');
      const saved = runMemorySave(
        workspace,
        'promote-project',
        'project',
        'best_practice',
        'Use scoped checkpoints',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          tags: ['checkpoint'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(
        workspace,
        '.context-anchor',
        'projects',
        'demo',
        'experiences.json'
      );
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      const result = runHeartbeat(workspace, 'promote-project', 'demo', 50);
      const projectSkills = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.promotions.project_promotions, 1);
      assert.equal(projectSkills.length, 1);
      assert.equal(projectSkills[0].scope, 'project');
      assert.equal(projectSkills[0].source_experience, saved.id);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('scope promote creates active user skills from validated user experiences with cross-project evidence', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runMemorySave(
        workspace,
        'promote-user',
        'user',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          user_id: 'default-user',
          heat: 95,
          access_count: 8,
          access_sessions: ['session-a', 'session-b'],
          validation: {
            status: 'validated',
            count: 2,
            evidence_count: 4,
            cross_project_count: 2,
            auto_validated: false,
            last_reviewed_at: '2026-03-22T00:00:00Z',
            notes: []
          }
        })
      );

      const userExperiencesFile = path.join(
        workspace,
        'openclaw-home',
        'context-anchor',
        'users',
        'default-user',
        'experiences.json'
      );
      const experiences = readJson(userExperiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(userExperiencesFile, experiences);

      const result = runScopePromote(workspace, {
        sessionKey: 'promote-user',
        projectId: 'demo',
        userId: 'default-user'
      });
      const userSkills = readJson(
        path.join(
          workspace,
          'openclaw-home',
          'context-anchor',
          'users',
          'default-user',
          'skills',
          'index.json'
        ),
        { skills: [] }
      ).skills;

      assert.equal(result.user_promotions, 1);
      assert.equal(userSkills.length, 1);
      assert.equal(userSkills[0].scope, 'user');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat aggregates validated project experiences across user workspaces into one user experience and promotes a user skill', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const clientA = path.join(workspace, 'client-a');
  const clientB = path.join(workspace, 'client-b');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace: clientA,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: clientB,
            userId: 'alice',
            projectId: 'client-b'
          }
        ]
      });

      runSessionStart(clientA, 'user-rollup-a', 'client-a');
      runSessionStart(clientB, 'user-rollup-b', 'client-b');

      const savedA = runMemorySave(
        clientA,
        'user-rollup-a',
        'project',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          heat: 95,
          access_count: 4,
          access_sessions: ['user-rollup-a-reuse'],
          details: 'shared pattern from client A',
          tags: ['summary']
        })
      );
      const savedB = runMemorySave(
        clientB,
        'user-rollup-b',
        'project',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          heat: 93,
          access_count: 5,
          access_sessions: ['user-rollup-b-reuse'],
          details: 'shared pattern from client B',
          tags: ['summary']
        })
      );

      runExperienceValidate(clientA, savedA.id, 'validated', 'client-a');
      runExperienceValidate(clientB, savedB.id, 'validated', 'client-b');

      const projectAFile = path.join(clientA, '.context-anchor', 'projects', 'client-a', 'experiences.json');
      const projectA = readJson(projectAFile, { experiences: [] });
      projectA.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(projectAFile, projectA);

      const projectBFile = path.join(clientB, '.context-anchor', 'projects', 'client-b', 'experiences.json');
      const projectB = readJson(projectBFile, { experiences: [] });
      projectB.experiences[0].created_at = '2026-03-03T00:00:00Z';
      writeJson(projectBFile, projectB);

      const result = runHeartbeat(clientA, 'user-rollup-a', 'client-a', 50, {
        userId: 'alice'
      });
      const userExperiences = readJson(
        path.join(openClawHome, 'context-anchor', 'users', 'alice', 'experiences.json'),
        { experiences: [] }
      ).experiences;
      const userSkills = readJson(
        path.join(openClawHome, 'context-anchor', 'users', 'alice', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.promotions.user_promotions, 1);
      assert.equal(userExperiences.length, 1);
      assert.equal(userExperiences[0].source, 'project-experience-rollup');
      assert.equal(userExperiences[0].validation.cross_project_count, 2);
      assert.deepEqual(userExperiences[0].supporting_projects.sort(), ['client-a', 'client-b']);
      assert.equal(userExperiences[0].summary, 'Keep user-facing summaries concise');
      assert.equal(userSkills.length, 1);
      assert.equal(userSkills[0].scope, 'user');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat keeps user rollups scoped to the owning user and does not mix other users workspaces', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const clientA = path.join(workspace, 'client-a');
  const clientB = path.join(workspace, 'client-b');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace: clientA,
        addUsers: ['bob'],
        addWorkspaces: [
          {
            workspace: clientB,
            userId: 'bob',
            projectId: 'client-b'
          }
        ]
      });

      runSessionStart(clientA, 'user-owner-a', 'client-a');
      runSessionStart(clientB, 'user-owner-b', 'client-b');

      const savedA = runMemorySave(
        clientA,
        'user-owner-a',
        'project',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          heat: 95,
          access_count: 4,
          access_sessions: ['user-owner-a-reuse'],
          details: 'alice pattern',
          tags: ['summary']
        })
      );
      const savedB = runMemorySave(
        clientB,
        'user-owner-b',
        'project',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          heat: 96,
          access_count: 5,
          access_sessions: ['user-owner-b-reuse'],
          details: 'bob pattern',
          tags: ['summary']
        })
      );

      runExperienceValidate(clientA, savedA.id, 'validated', 'client-a');
      runExperienceValidate(clientB, savedB.id, 'validated', 'client-b');

      const projectAFile = path.join(clientA, '.context-anchor', 'projects', 'client-a', 'experiences.json');
      const projectA = readJson(projectAFile, { experiences: [] });
      projectA.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(projectAFile, projectA);

      const projectBFile = path.join(clientB, '.context-anchor', 'projects', 'client-b', 'experiences.json');
      const projectB = readJson(projectBFile, { experiences: [] });
      projectB.experiences[0].created_at = '2026-03-03T00:00:00Z';
      writeJson(projectBFile, projectB);

      const result = runHeartbeat(clientA, 'user-owner-a', 'client-a', 50, {
        userId: 'alice'
      });
      const aliceExperiences = readJson(
        path.join(openClawHome, 'context-anchor', 'users', 'alice', 'experiences.json'),
        { experiences: [] }
      ).experiences;
      const aliceSkills = readJson(
        path.join(openClawHome, 'context-anchor', 'users', 'alice', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.promotions.user_promotions, 0);
      assert.equal(aliceExperiences.length, 1);
      assert.equal(aliceExperiences[0].validation.cross_project_count, 1);
      assert.deepEqual(aliceExperiences[0].supporting_projects, ['client-a']);
      assert.equal(aliceSkills.length, 0);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat deactivates a promoted user skill when cross-project support falls back to a single project', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const clientA = path.join(workspace, 'client-a');
  const clientB = path.join(workspace, 'client-b');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'alice',
        defaultWorkspace: clientA,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: clientB,
            userId: 'alice',
            projectId: 'client-b'
          }
        ]
      });

      runSessionStart(clientA, 'user-reconcile-a', 'client-a');
      runSessionStart(clientB, 'user-reconcile-b', 'client-b');

      const savedA = runMemorySave(
        clientA,
        'user-reconcile-a',
        'project',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          heat: 95,
          access_count: 4,
          access_sessions: ['user-reconcile-a-reuse'],
          details: 'client A evidence',
          tags: ['summary']
        })
      );
      const savedB = runMemorySave(
        clientB,
        'user-reconcile-b',
        'project',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          heat: 93,
          access_count: 5,
          access_sessions: ['user-reconcile-b-reuse'],
          details: 'client B evidence',
          tags: ['summary']
        })
      );

      runExperienceValidate(clientA, savedA.id, 'validated', 'client-a');
      runExperienceValidate(clientB, savedB.id, 'validated', 'client-b');

      const projectAFile = path.join(clientA, '.context-anchor', 'projects', 'client-a', 'experiences.json');
      const projectA = readJson(projectAFile, { experiences: [] });
      projectA.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(projectAFile, projectA);

      const projectBFile = path.join(clientB, '.context-anchor', 'projects', 'client-b', 'experiences.json');
      const projectB = readJson(projectBFile, { experiences: [] });
      projectB.experiences[0].created_at = '2026-03-03T00:00:00Z';
      writeJson(projectBFile, projectB);

      const first = runHeartbeat(clientA, 'user-reconcile-a', 'client-a', 50, {
        userId: 'alice'
      });
      assert.equal(first.promotions.user_promotions, 1);

      runExperienceValidate(clientB, savedB.id, 'rejected', 'client-b');

      const second = runHeartbeat(clientA, 'user-reconcile-a', 'client-a', 50, {
        userId: 'alice'
      });
      const userExperiences = readJson(
        path.join(openClawHome, 'context-anchor', 'users', 'alice', 'experiences.json'),
        { experiences: [] }
      ).experiences;
      const userSkills = readJson(
        path.join(openClawHome, 'context-anchor', 'users', 'alice', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(second.reconcile.user_deactivated, 1);
      assert.equal(userExperiences.length, 1);
      assert.equal(userExperiences[0].validation.cross_project_count, 1);
      assert.equal(userExperiences[0].skillification_suggested, false);
      assert.equal(userSkills.length, 1);
      assert.equal(userSkills[0].status, 'inactive');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('scope promote reuses an existing active project skill for same-name experiences', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'promote-reuse', 'demo');
      const first = runMemorySave(
        workspace,
        'promote-reuse',
        'project',
        'best_practice',
        'Use scoped checkpoints',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          tags: ['checkpoint'],
          validation_status: 'validated'
        })
      );
      const second = runMemorySave(
        workspace,
        'promote-reuse',
        'project',
        'best_practice',
        'Use scoped checkpoints',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-d', 'session-e'],
          tags: ['checkpoint'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences.forEach((entry) => {
        entry.created_at = '2026-03-01T00:00:00Z';
      });
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'promote-reuse',
        projectId: 'demo',
        userId: 'default-user'
      });
      const result = runScopePromote(workspace, {
        sessionKey: 'promote-reuse',
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json'),
        { skills: [] }
      ).skills;
      const updatedExperiences = readJson(experiencesFile, { experiences: [] }).experiences;

      assert.equal(result.project_promotions, 0);
      assert.equal(projectSkills.length, 1);
      assert.ok(projectSkills[0].related_experiences.includes(first.id));
      assert.ok(projectSkills[0].related_experiences.includes(second.id));
      assert.equal(updatedExperiences[0].skill_id, updatedExperiences[1].skill_id);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start prefers session over project over user skills with same conflict key', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'priority-session', 'demo');

      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-1',
            name: 'shared-skill',
            conflict_key: 'shared-skill',
            scope: 'project',
            status: 'active',
            summary: 'project version'
          }
        ]
      });

      const userSkillDir = path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'default-user', 'skills');
      fs.mkdirSync(userSkillDir, { recursive: true });
      writeJson(path.join(userSkillDir, 'index.json'), {
        skills: [
          {
            id: 'user-skill-1',
            name: 'shared-skill',
            conflict_key: 'shared-skill',
            scope: 'user',
            status: 'active',
            summary: 'user version'
          }
        ]
      });

      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'priority-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 'session-skill-1',
            name: 'shared-skill',
            conflict_key: 'shared-skill',
            scope: 'session',
            status: 'draft',
            summary: 'session version'
          }
        ]
      });

      const result = runSessionStart(workspace, 'priority-session', 'demo');

      assert.equal(result.effective_skills.length, 1);
      assert.equal(result.effective_skills[0].id, 'session-skill-1');
      assert.equal(result.skills_to_activate.session.length, 1);
      assert.equal(result.skills_to_activate.project.length, 0);
      assert.equal(result.skills_to_activate.user.length, 0);
      assert.equal(result.shadowed_skills.length, 2);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('inactive skills are filtered from effective activation', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'inactive-skill', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-1',
            name: 'inactive-skill',
            scope: 'project',
            status: 'active',
            summary: 'to be deactivated'
          }
        ]
      });

      runSkillStatusUpdate(workspace, 'project', 'project-skill-1', 'inactive', 'demo', 'disabled in test');
      const result = runSessionStart(workspace, 'inactive-skill', 'demo');

      assert.equal(result.effective_skills.length, 0);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill reconcile deactivates project skills whose supporting experience is rejected', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'reconcile-project', 'demo');
      const saved = runMemorySave(
        workspace,
        'reconcile-project',
        'project',
        'best_practice',
        'Keep promotion evidence fresh',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'reconcile-project',
        projectId: 'demo',
        userId: 'default-user'
      });

      const promotedExperiences = readJson(experiencesFile, { experiences: [] });
      promotedExperiences.experiences[0].validation.status = 'rejected';
      writeJson(experiencesFile, promotedExperiences);

      const result = runSkillReconcile(workspace, {
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.project_deactivated, 1);
      assert.equal(projectSkills[0].status, 'inactive');
      assert.ok(projectSkills[0].status_history.length >= 2);
      assert.equal(projectSkills[0].source_experience, saved.id);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('project skill records promotion history and manual status history', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'history-project', 'demo');
      runMemorySave(
        workspace,
        'history-project',
        'project',
        'best_practice',
        'Track promotion history',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'history-project',
        projectId: 'demo',
        userId: 'default-user'
      });

      const projectSkillsFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json');
      const promotedSkills = readJson(projectSkillsFile, { skills: [] }).skills;
      runSkillStatusUpdate(workspace, 'project', promotedSkills[0].id, 'inactive', 'demo', 'manual test deactivate');
      const updatedSkills = readJson(projectSkillsFile, { skills: [] }).skills;

      assert.ok(updatedSkills[0].promotion_history.length >= 1);
      assert.ok(updatedSkills[0].status_history.length >= 2);
      assert.equal(updatedSkills[0].status, 'inactive');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill supersede deactivates loser and keeps only winner effective', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'supersede-project', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-a',
            name: 'shared-project-skill-a',
            conflict_key: 'shared-project-skill-a',
            scope: 'project',
            status: 'active',
            summary: 'winner',
            load_policy: { priority: 60, budget_weight: 1, auto_load: true }
          },
          {
            id: 'project-skill-b',
            name: 'shared-project-skill-b',
            conflict_key: 'shared-project-skill-b',
            scope: 'project',
            status: 'active',
            summary: 'loser',
            load_policy: { priority: 50, budget_weight: 1, auto_load: true }
          }
        ]
      });

      runSkillSupersede(workspace, 'project', 'project-skill-a', 'project-skill-b', 'demo');
      const skills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;
      const result = runSessionStart(workspace, 'supersede-project', 'demo');

      assert.ok((skills[0].evidence || []).some((event) => event.type === 'skill_supersede_winner'));
      assert.ok((skills[1].evidence || []).some((event) => event.type === 'skill_superseded'));
      assert.ok(result.effective_skills.some((skill) => skill.id === 'project-skill-a'));
      assert.ok(!result.effective_skills.some((skill) => skill.id === 'project-skill-b'));
      assert.ok(result.shadowed_skills.length === 0);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill activation budget limits effective skills and reports budgeted out skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'budget-session', 'demo');
      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'budget-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 's1',
            name: 'skill-1',
            conflict_key: 'skill-1',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          },
          {
            id: 's2',
            name: 'skill-2',
            conflict_key: 'skill-2',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 80, budget_weight: 1, auto_load: true }
          },
          {
            id: 's3',
            name: 'skill-3',
            conflict_key: 'skill-3',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 70, budget_weight: 1, auto_load: true }
          }
        ]
      });
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'p1',
            name: 'project-skill-1',
            conflict_key: 'project-skill-1',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 60, budget_weight: 1, auto_load: true }
          },
          {
            id: 'p2',
            name: 'project-skill-2',
            conflict_key: 'project-skill-2',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 50, budget_weight: 1, auto_load: true }
          },
          {
            id: 'p3',
            name: 'project-skill-3',
            conflict_key: 'project-skill-3',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 40, budget_weight: 1, auto_load: true }
          }
        ]
      });
      const userSkillDir = path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'default-user', 'skills');
      fs.mkdirSync(userSkillDir, { recursive: true });
      writeJson(path.join(userSkillDir, 'index.json'), {
        skills: [
          {
            id: 'u1',
            name: 'user-skill-1',
            conflict_key: 'user-skill-1',
            scope: 'user',
            status: 'active',
            load_policy: { priority: 30, budget_weight: 1, auto_load: true }
          },
          {
            id: 'u2',
            name: 'user-skill-2',
            conflict_key: 'user-skill-2',
            scope: 'user',
            status: 'active',
            load_policy: { priority: 20, budget_weight: 1, auto_load: true }
          }
        ]
      });

      const result = runSessionStart(workspace, 'budget-session', 'demo');

      assert.equal(result.effective_skills.length, 5);
      assert.ok(result.shadowed_skills.length === 0);
      assert.ok(result.boot_packet.skill_governance.budgeted_out.length >= 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill reconcile archives low-value inactive skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'archive-skill', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-archive',
            name: 'archive-me',
            scope: 'project',
            status: 'inactive',
            usage_count: 0,
            load_policy: { priority: 10, budget_weight: 1, auto_load: true },
            status_history: [
              {
                status: 'inactive',
                at: '2026-03-24T00:00:00Z',
                reason: 'manual'
              }
            ]
          }
        ]
      });

      const result = runSkillReconcile(workspace, {
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;

      assert.equal(result.project_archived, 1);
      assert.equal(projectSkills[0].status, 'archived');
      assert.equal(projectSkills[0].archived, true);
      assert.ok((projectSkills[0].evidence || []).some((event) => event.type === 'skill_archived'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill reconcile reactivates inactive skills when supporting evidence returns', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'reactivate-skill', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      const projectExperiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(projectExperiencesFile, {
        experiences: [
          {
            id: 'exp-reactivate',
            type: 'best_practice',
            summary: 'Reusable lesson',
            validation: { status: 'validated' },
            skillification_suggested: true,
            archived: false,
            source_project: 'demo',
            source_user: 'default-user'
          }
        ]
      });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-reactivate',
            name: 'reactivate-me',
            scope: 'project',
            status: 'inactive',
            related_experiences: ['exp-reactivate'],
            source_project: 'demo',
            source_user: 'default-user',
            status_history: [
              {
                status: 'inactive',
                at: '2026-03-24T00:00:00Z',
                reason: 'manual'
              }
            ]
          }
        ]
      });

      const result = runSkillReconcile(workspace, {
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;

      assert.equal(result.project_reactivated, 1);
      assert.equal(projectSkills[0].status, 'active');
      assert.ok((projectSkills[0].evidence || []).some((event) => event.type === 'skill_reactivated'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report summarizes user project session counts and governance', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'report-session', 'demo');
      runMemorySave(
        workspace,
        'report-session',
        'user',
        'best_practice',
        'User level guidance'
      );
      runMemorySave(
        workspace,
        'report-session',
        'project',
        'best_practice',
        'Project level guidance'
      );
      runMemorySave(
        workspace,
        'report-session',
        'session',
        'best_practice',
        'Session level guidance'
      );
      runSessionClose(workspace, 'report-session', {
        reason: 'session-end',
        usagePercent: 88
      });

      const report = runStatusReport(workspace, 'report-session', 'demo', 'default-user');

      assert.equal(report.status, 'ok');
      assert.equal(report.user.id, 'default-user');
      assert.equal(report.project.id, 'demo');
      assert.equal(report.session.key, 'report-session');
      assert.ok(report.session.last_summary_snapshot);
      assert.ok(typeof report.governance.active === 'number');
      assert.ok(report.evidence.project_skills);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report is read-only unless snapshot output is requested', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const report = runStatusReport(workspace, 'dry-run-session');

      assert.equal(report.status, 'ok');
      assert.equal(fs.existsSync(path.join(workspace, '.context-anchor')), false);
      assert.equal(fs.existsSync(path.join(workspace, 'openclaw-home', 'context-anchor')), false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report can write a snapshot file and return adaptive budget guidance', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'snapshot-session', 'demo');
      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'snapshot-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 'snap-s1',
            name: 'snap-s1',
            conflict_key: 'snap-s1',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          },
          {
            id: 'snap-s2',
            name: 'snap-s2',
            conflict_key: 'snap-s2',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 80, budget_weight: 1, auto_load: true }
          },
          {
            id: 'snap-s3',
            name: 'snap-s3',
            conflict_key: 'snap-s3',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 70, budget_weight: 1, auto_load: true }
          }
        ]
      });

      const report = runStatusReport(workspace, 'snapshot-session', 'demo', 'default-user', {
        writeSnapshot: true
      });

      assert.ok(fs.existsSync(report.snapshot_file));
      assert.ok(report.adaptive_budget);
      assert.ok(report.adaptive_budget.recommended.total >= report.adaptive_budget.current.total);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill diagnose explains active shadowed superseded and budgeted skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'diagnose-session', 'demo');
      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'diagnose-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 'diag-session',
            name: 'shared-diag',
            conflict_key: 'shared-diag',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-budget-1',
            name: 'budget-a',
            conflict_key: 'budget-a',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 85, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-budget-2',
            name: 'budget-b',
            conflict_key: 'budget-b',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 80, budget_weight: 1, auto_load: true }
          }
        ]
      });
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'diag-project',
            name: 'shared-diag',
            conflict_key: 'shared-diag',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 60, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-supersede-winner',
            name: 'winner-skill',
            conflict_key: 'winner-skill',
            scope: 'project',
            status: 'active',
            supersedes: ['loser-skill'],
            load_policy: { priority: 70, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-supersede-loser',
            name: 'loser-skill',
            conflict_key: 'loser-skill',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 65, budget_weight: 1, auto_load: true }
          }
        ]
      });

      const diagActive = runSkillDiagnose(workspace, 'diag-session', 'diagnose-session', 'demo', 'default-user');
      const diagShadowed = runSkillDiagnose(workspace, 'diag-project', 'diagnose-session', 'demo', 'default-user');
      const diagSuperseded = runSkillDiagnose(workspace, 'diag-supersede-loser', 'diagnose-session', 'demo', 'default-user');
      const diagBudget = runSkillDiagnose(workspace, 'diag-budget-2', 'diagnose-session', 'demo', 'default-user');

      assert.equal(diagActive.effective_match.id, 'diag-session');
      assert.equal(diagShadowed.reasons[0].diagnosis, 'shadowed');
      assert.equal(diagSuperseded.reasons[0].diagnosis, 'superseded');
      assert.equal(diagBudget.reasons[0].diagnosis, 'budgeted_out');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill diagnose returns recommended actions for non-active diagnoses', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'diag-actions', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'diag-archived',
            name: 'diag-archived',
            conflict_key: 'diag-archived',
            scope: 'project',
            status: 'archived',
            archived: true
          }
        ]
      });

      const result = runSkillDiagnose(workspace, 'diag-archived', 'diag-actions', 'demo', 'default-user');

      assert.equal(result.reasons[0].diagnosis, 'archived');
      assert.ok(result.recommendations.length >= 1);
      assert.ok(result.reasons[0].evidence_summary);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});
