const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync, spawn, spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compactPacketFile,
  DEFAULTS,
  createPaths,
  getRecentSessions,
  loadCompactPacket,
  projectExperiencesArchiveFile,
  projectFactsArchiveFile,
  projectFactsFile,
  loadRankedCollection,
  loadSessionState,
  loadUserState,
  loadUserMemories,
  readJson,
  runtimeStateFile,
  sessionMemoryArchiveFile,
  sessionSummaryFile,
  sessionStateFile,
  sessionMemoryFile,
  syncRuntimeStateFromSessionState,
  userMemoriesArchiveFile,
  writeJson
} = require('../scripts/lib/context-anchor');
const { buildBootstrapCacheContent } = require('../scripts/lib/bootstrap-cache');
const { collectSessionCandidates } = require('../scripts/lib/openclaw-session-candidates');
const {
  buildAutoFixCommand,
  classifyAutoFixRisk,
  decodeAutoFixSequence,
  encodeAutoFixSequence,
  filterAutoFixSequence,
  recommendAutoFixStrategy
} = require('../scripts/lib/auto-fix');
const {
  describeCollectionFile,
  describeDocumentFile,
  readCatalogItemRows,
  readContentBlobRows,
  loadRecentSessionIndexEntries,
  readLatestGovernanceRun,
  readMirrorCollection,
  readMirrorCollectionCount,
  readMirrorDocument,
  searchCatalogItems,
  syncCollectionMirror,
  summarizeCatalogDatabase
} = require('../scripts/lib/context-anchor-db');
const { findSessionByKey, getHostConfigFile, resolveOwnership } = require('../scripts/lib/host-config');
const { runCheckpointCreate } = require('../scripts/checkpoint-create');
const {
  buildHostPaths,
  cleanupWindowsSchedulerState,
  computeSchedulerLauncherId,
  runConfigureHost,
  summarizeConfigureHostHealthStatus
} = require('../scripts/configure-host');
const { runContextPressureHandle } = require('../scripts/context-pressure-handle');
const { runContextPressureMonitor } = require('../scripts/context-pressure-monitor');
const { handleHookEvent, handleManagedHookEvent } = require('../hooks/context-anchor-hook/handler');
const { renderExperienceValidateReport, runExperienceValidate } = require('../scripts/experience-validate');
const { runInstallHostAssets } = require('../scripts/install-host-assets');
const { runAutoFix } = require('../scripts/auto-fix');
const { runExternalMemoryWatch } = require('../scripts/external-memory-watch');
const { runLegacyMemorySync } = require('../scripts/legacy-memory-sync');
const { runOneClickInstall, summarizeInstallHealthStatus } = require('../scripts/install-one-click');
const { runMigrateGlobalToUser } = require('../scripts/migrate-global-to-user');
const { runMirrorRebuild } = require('../scripts/mirror-rebuild');
const { runMemoryFlow } = require('../scripts/memory-flow');
const { runMemorySave } = require('../scripts/memory-save');
const { runHeartbeat } = require('../scripts/heartbeat');
const { runHeatEvaluation } = require('../scripts/heat-eval');
const { runMemorySearch } = require('../scripts/memory-search');
const { renderDoctorReport, runDoctor, summarizeDoctorRunStatus } = require('../scripts/doctor');
const { discoverOpenClawSessions } = require('../scripts/lib/openclaw-session-discovery');
const {
  buildActionCommands,
  buildOpenClawSessionStatusReport,
  buildSchedulerDescriptor,
  detectSchedulerStatus,
  renderOpenClawSessionDiagnosisReport,
  renderOpenClawSessionStatusReport
} = require('../scripts/lib/openclaw-session-status');
const { runSkillDiagnose } = require('../scripts/skill-diagnose');
const { runScopePromote } = require('../scripts/scope-promote');
const { runPerfBenchmark } = require('../scripts/perf-benchmark');
const { runSkillReconcile } = require('../scripts/skill-reconcile');
const { renderStatusReportText, runStatusReport } = require('../scripts/status-report');
const { buildRemediationSummary } = require('../scripts/lib/remediation-summary');
const { loadResumePreferences, recordResumeSelections } = require('../scripts/lib/resume-preferences');
const { calculateRetentionScore, compareGovernanceEntries, governCollection } = require('../scripts/storage-governance');
const { runSkillSupersede } = require('../scripts/skill-supersede');
const { runSessionClose } = require('../scripts/session-close');
const { runSessionCompact } = require('../scripts/session-compact');
const { runSessionStart } = require('../scripts/session-start');
const { runConfigureSessions, summarizeConfigureSessionsHealthStatus } = require('../scripts/configure-sessions');
const { renderUpgradeReport, runUpgradeSessions, summarizeUpgradeRunStatus } = require('../scripts/upgrade-sessions');
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

function syncRuntimeStateFixture(workspace, sessionKey, projectId) {
  const paths = createPaths(workspace);
  const sessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: false,
    touch: false
  });
  return syncRuntimeStateFromSessionState(paths, sessionKey, sessionState);
}

function makeGovernanceEntry(prefix, index, overrides = {}) {
  return {
    id: `${prefix}-${index}`,
    type: overrides.type || 'fact',
    summary: overrides.summary || `${prefix} summary ${index}`,
    content: overrides.content || `${prefix} content ${index}`,
    heat: overrides.heat === undefined ? Math.max(5, 100 - index) : overrides.heat,
    access_count: overrides.access_count === undefined ? 1 : overrides.access_count,
    access_sessions: overrides.access_sessions || [`session-${index}`],
    created_at: overrides.created_at || `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    last_accessed: overrides.last_accessed || `2026-03-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    archived: Boolean(overrides.archived),
    ...overrides
  };
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
    syncRuntimeStateFixture(workspace, 'session-a', 'demo');

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

test('session-start auto-ingests legacy MEMORY.md into context-anchor project memory and stays idempotent', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      fs.writeFileSync(
        path.join(workspace, 'MEMORY.md'),
        [
          '## MEM-legacy-1',
          'type: best_practice',
          'heat: 88',
          'tags: [legacy, model-memory]',
          'Use one unified memory plane for long tasks.'
        ].join('\n'),
        'utf8'
      );

      const first = runSessionStart(workspace, 'legacy-sync-session', 'demo');
      const second = runSessionStart(workspace, 'legacy-sync-session', 'demo');
      const experiences = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json'),
        { experiences: [] }
      ).experiences;
      const syncState = readJson(path.join(workspace, '.context-anchor', 'legacy-memory-sync.json'), { files: {} });

      assert.equal(first.compatibility.legacy_memory_sync.synced_entries, 1);
      assert.equal(second.compatibility.legacy_memory_sync.synced_entries, 0);
      assert.equal(experiences.length, 1);
      assert.match(experiences[0].summary, /unified memory plane/);
      assert.ok(syncState.files['MEMORY.md']);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('legacy memory sync can ingest raw external memory files without MEM entry blocks', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'memory', 'model-note.md'),
        '# External Memory\n\nThis was written by another model path and should still be centralized.',
        'utf8'
      );

      const result = runLegacyMemorySync(workspace, 'legacy-raw', {
        projectId: 'demo',
        reason: 'test'
      });
      const facts = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'facts.json'),
        { facts: [] }
      ).facts;

      assert.equal(result.synced_entries, 1);
      assert.equal(facts.length, 1);
      assert.match(facts[0].content, /written by another model path/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('external memory watcher debounces repeated file changes into one sync', async () => {
  const workspace = makeWorkspace();
  const callbacks = new Map();
  const signal = new AbortController();
  let summary = {
    external_source_count: 1,
    unsynced_source_count: 1,
    last_legacy_sync_at: null
  };
  const syncCalls = [];

  try {
    const watchRun = runExternalMemoryWatch(workspace, {
      debounceMs: 15,
      signal: signal.signal,
      existsImpl: () => true,
      summarizeImpl: () => summary,
      syncImpl: (watchWorkspace, sessionKey, options) => {
        syncCalls.push({ watchWorkspace, sessionKey, options });
        summary = {
          ...summary,
          unsynced_source_count: 0,
          last_legacy_sync_at: new Date().toISOString()
        };
        return {
          synced_entries: 1,
          synced_files: 1,
          skipped_files: 0
        };
      },
      watchImpl: (target, listener) => {
        callbacks.set(target, listener);
        return {
          close() {
            callbacks.delete(target);
          }
        };
      }
    });

    callbacks.get(path.resolve(workspace))('rename', 'MEMORY.md');
    callbacks.get(path.resolve(workspace))('change', 'memory');
    await new Promise((resolve) => setTimeout(resolve, 50));
    signal.abort();
    const result = await watchRun;

    assert.equal(syncCalls.length, 1);
    assert.equal(result.sync_count, 1);
    assert.ok(result.observed_events >= 3);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('external memory watcher skips syncing when changes are already centralized', async () => {
  const workspace = makeWorkspace();
  const callbacks = new Map();
  const signal = new AbortController();
  const syncCalls = [];

  try {
    const watchRun = runExternalMemoryWatch(workspace, {
      debounceMs: 15,
      signal: signal.signal,
      existsImpl: () => true,
      summarizeImpl: () => ({
        external_source_count: 1,
        unsynced_source_count: 0,
        last_legacy_sync_at: new Date().toISOString()
      }),
      syncImpl: (...args) => {
        syncCalls.push(args);
        return {
          synced_entries: 1,
          synced_files: 1,
          skipped_files: 0
        };
      },
      watchImpl: (target, listener) => {
        callbacks.set(target, listener);
        return {
          close() {
            callbacks.delete(target);
          }
        };
      }
    });

    callbacks.get(path.resolve(workspace))('change', 'MEMORY.md');
    await new Promise((resolve) => setTimeout(resolve, 50));
    signal.abort();
    const result = await watchRun;

    assert.equal(syncCalls.length, 0);
    assert.equal(result.sync_count, 0);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start prefers runtime state over stale session state for the current session', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const paths = createPaths(workspace);
      runSessionStart(workspace, 'runtime-backed-session', 'demo');

      const stateFile = sessionStateFile(paths, 'runtime-backed-session');
      const runtimeFile = runtimeStateFile(paths, 'runtime-backed-session');
      const state = readJson(stateFile, {});
      const runtimeState = readJson(runtimeFile, {});

      state.active_task = 'stale state task';
      state.commitments = [];
      writeJson(stateFile, state);

      runtimeState.active_task = 'continue from runtime state';
      runtimeState.pending_commitments = [
        {
          id: 'runtime-1',
          what: 'ship runtime sync',
          status: 'pending'
        }
      ];
      runtimeState.closed_at = null;
      writeJson(runtimeFile, runtimeState);

      const result = runSessionStart(workspace, 'runtime-backed-session', 'demo');
      const nextState = readJson(stateFile, {});

      assert.equal(result.recovery.active_task, 'continue from runtime state');
      assert.equal(result.recovery.pending_commitments.length, 1);
      assert.equal(nextState.active_task, 'continue from runtime state');
      assert.equal(nextState.commitments.filter((entry) => entry.status === 'pending').length, 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat updates task-state continuity fields in runtime state', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const paths = createPaths(workspace);
      runSessionStart(workspace, 'task-heartbeat', 'demo');

      const stateFile = sessionStateFile(paths, 'task-heartbeat');
      const state = readJson(stateFile, {});
      state.active_task = 'stabilize checkout retries';
      state.commitments = [
        {
          id: 'task-heartbeat-1',
          what: 'ship checkout retry fix',
          status: 'pending'
        }
      ];
      state.metadata = {
        ...(state.metadata || {}),
        blocked_by: 'waiting for CI rerun'
      };
      writeJson(stateFile, state);

      const result = runHeartbeat(workspace, 'task-heartbeat', 'demo', 50);
      const runtimeState = readJson(runtimeStateFile(paths, 'task-heartbeat'), {});

      assert.equal(runtimeState.current_goal, 'stabilize checkout retries');
      assert.equal(runtimeState.next_step, 'ship checkout retry fix');
      assert.equal(runtimeState.blocked_by, 'waiting for CI rerun');
      assert.equal(runtimeState.latest_verified_result, null);
      assert.equal(runtimeState.last_user_visible_progress, null);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-compact after refreshes runtime state metadata', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const paths = createPaths(workspace);
      runSessionStart(workspace, 'compact-runtime-session', 'demo');

      const stateFile = sessionStateFile(paths, 'compact-runtime-session');
      const state = readJson(stateFile, {});
      state.active_task = 'refresh runtime after compact';
      state.commitments = [
        {
          id: 'compact-runtime-1',
          what: 'keep pending work visible',
          status: 'pending'
        }
      ];
      writeJson(stateFile, state);
      syncRuntimeStateFixture(workspace, 'compact-runtime-session', 'demo');

      const result = runSessionCompact(workspace, 'compact-runtime-session', {
        phase: 'after',
        projectId: 'demo'
      });
      const runtimeState = readJson(runtimeStateFile(paths, 'compact-runtime-session'), {});

      assert.equal(result.status, 'handled');
      assert.ok(result.actions.includes('runtime_state_refreshed'));
      assert.ok(result.actions.includes('task_state_summarized'));
      assert.equal(runtimeState.active_task, 'refresh runtime after compact');
      assert.equal(runtimeState.pending_commitments.length, 1);
      assert.equal(runtimeState.current_goal, 'refresh runtime after compact');
      assert.equal(runtimeState.next_step, 'keep pending work visible');
      assert.equal(result.task_state_summary.current_goal, 'refresh runtime after compact');
      assert.equal(result.task_state_summary.next_step, 'keep pending work visible');
      assert.equal(result.task_state_summary.visible, true);
      assert.equal(runtimeState.metadata.last_compaction_event, 'after');
      assert.ok(runtimeState.metadata.last_compaction_at);
      assert.equal(runtimeState.metadata.runtime_state_reason, 'compact-after');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('storage governance retention scores prefer validated and cross-session entries in a stable order', () => {
  const now = Date.parse('2026-04-01T00:00:00.000Z');
  const pending = makeGovernanceEntry('retention', 1, {
    type: 'best_practice',
    summary: 'same experience',
    heat: 70,
    access_count: 2,
    access_sessions: ['s1'],
    last_accessed: '2026-03-28T00:00:00.000Z',
    validation: { status: 'pending' }
  });
  const validated = {
    ...pending,
    id: 'retention-validated',
    validation: { status: 'validated' }
  };
  const crossSession = {
    ...validated,
    id: 'retention-cross',
    access_count: 4,
    access_sessions: ['s1', 's2', 's3'],
    last_accessed: '2026-03-31T00:00:00.000Z'
  };
  const stale = {
    ...validated,
    id: 'retention-stale',
    access_count: 1,
    access_sessions: ['s1'],
    last_accessed: '2026-01-10T00:00:00.000Z'
  };

  const pendingScore = calculateRetentionScore(pending, 'project_experiences', now);
  const validatedScore = calculateRetentionScore(validated, 'project_experiences', now);
  const crossSessionScore = calculateRetentionScore(crossSession, 'project_experiences', now);
  const staleScore = calculateRetentionScore(stale, 'project_experiences', now);

  assert.ok(validatedScore > pendingScore);
  assert.ok(crossSessionScore > validatedScore);
  assert.ok(validatedScore > staleScore);

  const sortOnce = [pending, stale, crossSession, validated]
    .map((entry) => ({
      ...entry,
      retention_score: calculateRetentionScore(entry, 'project_experiences', now)
    }))
    .sort(compareGovernanceEntries)
    .map((entry) => entry.id);
  const sortTwice = [pending, stale, crossSession, validated]
    .map((entry) => ({
      ...entry,
      retention_score: calculateRetentionScore(entry, 'project_experiences', now)
    }))
    .sort(compareGovernanceEntries)
    .map((entry) => entry.id);

  assert.deepEqual(sortOnce, sortTwice);
  assert.equal(sortOnce[0], 'retention-cross');
});

test('storage governance dedupes entries and splits active archive budgets with prune', () => {
  let writtenActive = [];
  let writtenArchive = [];
  const result = governCollection(
    {
      source: 'project_experiences',
      key: 'experiences',
      budget: {
        active: 2,
        archive: 2
      },
      activeFile: 'active.json',
      archiveFile: 'archive.json',
      loadActive: () => [
        makeGovernanceEntry('dup', 1, {
          type: 'best_practice',
          summary: 'duplicate experience',
          content: 'duplicate experience',
          heat: 95,
          access_sessions: ['s1']
        }),
        makeGovernanceEntry('keep', 1, {
          type: 'best_practice',
          summary: 'keep active',
          heat: 88
        }),
        makeGovernanceEntry('archive', 1, {
          type: 'best_practice',
          summary: 'archive this',
          heat: 40
        }),
        makeGovernanceEntry('prune', 1, {
          type: 'best_practice',
          summary: 'prune this',
          heat: 10,
          last_accessed: '2025-12-01T00:00:00.000Z'
        })
      ],
      loadArchive: () => [
        makeGovernanceEntry('dup', 2, {
          type: 'best_practice',
          summary: 'duplicate experience',
          content: 'duplicate experience',
          heat: 72,
          access_sessions: ['s2'],
          archived: true,
          archived_at: '2026-03-20T00:00:00.000Z',
          archive_reason: 'retention_budget'
        }),
        makeGovernanceEntry('archive', 2, {
          type: 'best_practice',
          summary: 'already archived',
          heat: 25,
          archived: true,
          archived_at: '2026-03-10T00:00:00.000Z',
          archive_reason: 'retention_budget'
        })
      ],
      writeActive: (items) => {
        writtenActive = items;
      },
      writeArchive: (items) => {
        writtenArchive = items;
      }
    },
    {
      mode: 'enforce',
      pruneArchive: true,
      timestamp: '2026-04-01T00:00:00.000Z'
    }
  );

  assert.equal(result.deduped, 1);
  assert.equal(result.active_after, 2);
  assert.equal(result.archive_after, 2);
  assert.equal(result.pruned, 1);
  assert.equal(writtenActive.length, 2);
  assert.equal(writtenArchive.length, 2);
  assert.ok(writtenArchive.every((entry) => entry.archived));
  assert.ok(writtenArchive.every((entry) => entry.archived_at));

  const mergedDuplicate = [...writtenActive, ...writtenArchive].find((entry) => entry.summary === 'duplicate experience');
  assert.deepEqual((mergedDuplicate.access_sessions || []).sort(), ['s1', 's2']);
  assert.ok(mergedDuplicate.content_hash);
});

test('heartbeat runs storage governance and syncs active and archive mirrors', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'govern-heartbeat', 'demo');
      const paths = createPaths(workspace);
      writeJson(sessionMemoryFile(paths, 'govern-heartbeat'), {
        entries: Array.from({ length: 85 }, (_, index) =>
          makeGovernanceEntry('heartbeat-memory', index, {
            type: 'fact',
            session_key: 'govern-heartbeat',
            project_id: 'demo',
            scope: 'session'
          })
        )
      });

      const result = runHeartbeat(workspace, 'govern-heartbeat', 'demo', 50);
      const activeEntries = readJson(sessionMemoryFile(paths, 'govern-heartbeat'), { entries: [] }).entries;
      const archiveEntries = readJson(sessionMemoryArchiveFile(paths, 'govern-heartbeat'), { entries: [] }).entries;
      const activeMirror = readMirrorCollectionCount(sessionMemoryFile(paths, 'govern-heartbeat'), 'entries');
      const archiveMirror = readMirrorCollectionCount(sessionMemoryArchiveFile(paths, 'govern-heartbeat'), 'entries');

      assert.equal(activeEntries.length, DEFAULTS.storageGovernance.session_memories.active);
      assert.equal(archiveEntries.length, 5);
      assert.ok(result.governance.collections.some((entry) => entry.source === 'session_memories' && entry.archive_after === 5));
      assert.equal(activeMirror.status, 'available');
      assert.equal(activeMirror.count, DEFAULTS.storageGovernance.session_memories.active);
      assert.equal(archiveMirror.status, 'available');
      assert.equal(archiveMirror.count, 5);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-close runs storage governance for project collections', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'govern-close', 'demo');
      const paths = createPaths(workspace);
      writeJson(projectFactsFile(paths, 'demo'), {
        facts: Array.from({ length: 402 }, (_, index) =>
          makeGovernanceEntry('project-fact', index, {
            type: 'fact',
            project_id: 'demo',
            session_key: 'govern-close'
          })
        )
      });

      const result = runSessionClose(workspace, 'govern-close', {
        reason: 'phase-2-governance'
      });
      const activeFacts = readJson(projectFactsFile(paths, 'demo'), { facts: [] }).facts;
      const archiveFacts = readJson(projectFactsArchiveFile(paths, 'demo'), { facts: [] }).facts;

      assert.equal(activeFacts.length, DEFAULTS.storageGovernance.project_facts.active);
      assert.equal(archiveFacts.length, 2);
      assert.ok(result.governance.collections.some((entry) => entry.source === 'project_facts' && entry.archive_after === 2));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('workspace monitor inherits storage governance through maintenance heartbeat', async () => {
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

      runSessionStart(workspace, 'govern-monitor', 'demo');
      const paths = createPaths(workspace);
      writeJson(sessionMemoryFile(paths, 'govern-monitor'), {
        entries: Array.from({ length: 82 }, (_, index) =>
          makeGovernanceEntry('monitor-memory', index, {
            type: 'fact',
            session_key: 'govern-monitor',
            project_id: 'demo',
            scope: 'session'
          })
        )
      });

      const result = runWorkspaceMonitor(workspace, {
        windowMs: 7 * 24 * 60 * 60 * 1000
      });
      const archiveEntries = readJson(sessionMemoryArchiveFile(paths, 'govern-monitor'), { entries: [] }).entries;

      assert.equal(result.status, 'processed');
      assert.equal(result.results[0].status, 'maintenance_ok');
      assert.equal(result.results[0].governance.reason, 'workspace-monitor');
      assert.ok(result.results[0].governance.totals.archived >= 2);
      assert.equal(archiveEntries.length, 2);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('storage governance persists governance runs into the workspace catalog', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'govern-record', 'demo');
      const paths = createPaths(workspace);
      writeJson(sessionMemoryFile(paths, 'govern-record'), {
        entries: Array.from({ length: 81 }, (_, index) =>
          makeGovernanceEntry('record-memory', index, {
            type: 'fact',
            session_key: 'govern-record',
            project_id: 'demo',
            scope: 'session'
          })
        )
      });

      const result = runHeartbeat(workspace, 'govern-record', 'demo', 50);
      const dbFile = describeCollectionFile(sessionMemoryFile(paths, 'govern-record'), 'entries').dbFile;
      const latestRun = readLatestGovernanceRun(dbFile, {
        workspace,
        session_key: 'govern-record',
        project_id: 'demo',
        user_id: 'default-user'
      });

      assert.equal(result.governance.recorded, true);
      assert.ok(result.governance.run_id);
      assert.equal(latestRun.reason, 'heartbeat');
      assert.equal(latestRun.session_key, 'govern-record');
      assert.ok(latestRun.totals.archived >= 1);
      assert.ok(Array.isArray(latestRun.collections));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('mirror-rebuild backfills archive collections into sqlite mirrors', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'archive-rebuild', 'demo');
      const paths = createPaths(workspace);
      writeJson(sessionMemoryFile(paths, 'archive-rebuild'), {
        entries: [
          makeGovernanceEntry('active-mirror', 1, {
            type: 'fact',
            session_key: 'archive-rebuild',
            project_id: 'demo',
            scope: 'session'
          })
        ]
      });
      writeJson(sessionMemoryArchiveFile(paths, 'archive-rebuild'), {
        entries: [
          makeGovernanceEntry('archive-mirror', 1, {
            type: 'fact',
            session_key: 'archive-rebuild',
            project_id: 'demo',
            scope: 'session',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget'
          })
        ]
      });
      writeJson(userMemoriesArchiveFile(paths, 'default-user'), {
        memories: [
          makeGovernanceEntry('user-archive-mirror', 1, {
            scope: 'user',
            source_user: 'default-user',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget'
          })
        ]
      });

      const workspaceDb = path.join(workspace, '.context-anchor', 'catalog.sqlite');
      const userDb = path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'catalog.sqlite');
      if (fs.existsSync(workspaceDb)) {
        fs.rmSync(workspaceDb, { force: true });
      }
      if (fs.existsSync(userDb)) {
        fs.rmSync(userDb, { force: true });
      }

      const rebuild = runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));
      const sessionArchiveMirror = readMirrorCollection(sessionMemoryArchiveFile(paths, 'archive-rebuild'), 'entries');
      const userArchiveMirror = readMirrorCollection(userMemoriesArchiveFile(paths, 'default-user'), 'memories');
      const archiveDescriptor = describeCollectionFile(sessionMemoryArchiveFile(paths, 'archive-rebuild'), 'entries');

      assert.equal(rebuild.status, 'ok');
      assert.equal(archiveDescriptor.source, 'session_memories_archive');
      assert.equal(sessionArchiveMirror.status, 'available');
      assert.equal(sessionArchiveMirror.items.length, 1);
      assert.equal(userArchiveMirror.status, 'available');
      assert.equal(userArchiveMirror.items.length, 1);
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

test('sqlite mirror waits out a transient write lock instead of failing immediately', async () => {
  const workspace = makeWorkspace();

  try {
    await withOpenClawHome(workspace, async () => {
      runSessionStart(workspace, 'sqlite-busy', 'demo');
      runMemorySave(
        workspace,
        'sqlite-busy',
        'session',
        'best_practice',
        'retry after temporary lock',
        JSON.stringify({ heat: 96 })
      );

      const paths = createPaths(workspace);
      const memoryFile = sessionMemoryFile(paths, 'sqlite-busy');
      const descriptor = describeCollectionFile(memoryFile, 'entries');
      const currentItems = readJson(memoryFile, { entries: [] }).entries;
      const lockScript = [
        "const { DatabaseSync } = require('node:sqlite');",
        "const db = new DatabaseSync(process.argv[1]);",
        "db.exec(`PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;`);",
        "setTimeout(() => { try { db.exec('COMMIT'); } catch {} db.close(); }, 750);",
        "setTimeout(() => process.exit(0), 900);"
      ].join(' ');
      const child = spawn(process.execPath, ['-e', lockScript, descriptor.dbFile], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'ignore'
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = Date.now();
      const synced = syncCollectionMirror(memoryFile, 'entries', currentItems);
      const waitedMs = Date.now() - started;

      await new Promise((resolve, reject) => {
        child.once('exit', (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`lock holder exited with code ${code}`));
        });
        child.once('error', reject);
      });

      assert.equal(synced, true);
      assert.ok(waitedMs >= 500);
      assert.equal(readMirrorCollection(memoryFile, 'entries').status, 'available');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('sqlite mirror externalizes long fields into content blobs while rehydrating reads', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const longContent = 'blob backed content '.repeat(80);
      const longDetails = 'blob backed details '.repeat(120);
      const longSolution = 'blob backed solution '.repeat(120);

      runSessionStart(workspace, 'blob-mirror', 'demo');
      runMemorySave(
        workspace,
        'blob-mirror',
        'session',
        'best_practice',
        longContent,
        JSON.stringify({
          heat: 96,
          details: longDetails,
          solution: longSolution
        })
      );

      const paths = createPaths(workspace);
      const memoryFile = sessionMemoryFile(paths, 'blob-mirror');
      const descriptor = describeCollectionFile(memoryFile, 'entries');
      const mirror = readMirrorCollection(memoryFile, 'entries');
      const ranked = loadRankedCollection(memoryFile, 'entries', {
        minHeat: 90,
        limit: 1
      });
      const dbSummary = summarizeCatalogDatabase(descriptor.dbFile);
      const blobRows = readContentBlobRows(descriptor.dbFile, {
        source: 'session_memories'
      });
      const catalogRows = readCatalogItemRows(descriptor.dbFile, {
        source: 'session_memories'
      });

      assert.equal(mirror.status, 'available');
      assert.equal(mirror.items[0].content, longContent);
      assert.equal(mirror.items[0].details, longDetails);
      assert.equal(mirror.items[0].solution, longSolution);
      assert.equal(ranked[0].details, longDetails);
      assert.ok(dbSummary.content_blobs >= 2);
      assert.ok(dbSummary.content_blob_bytes > 0);
      assert.ok(blobRows.some((row) => row.field_name === 'details'));
      assert.ok(blobRows.some((row) => row.field_name === 'solution'));
      assert.doesNotMatch(catalogRows[0].payload_json, /blob backed details blob backed details/);
      assert.doesNotMatch(catalogRows[0].payload_json, /blob backed solution blob backed solution/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('archive blobs are compressed and rehydrated after mirror rebuild', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const longArchiveDetails = 'archive compression candidate '.repeat(180);

      runSessionStart(workspace, 'blob-archive', 'demo');
      const paths = createPaths(workspace);
      writeJson(projectExperiencesArchiveFile(paths, 'demo'), {
        experiences: [
          makeGovernanceEntry('blob-archive', 1, {
            type: 'best_practice',
            summary: 'Archive blob record',
            details: longArchiveDetails,
            solution: 'archive compressed solution '.repeat(120),
            project_id: 'demo',
            session_key: 'blob-archive',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget',
            validation: { status: 'validated' }
          })
        ]
      });

      const dbFile = path.join(workspace, '.context-anchor', 'catalog.sqlite');
      if (fs.existsSync(dbFile)) {
        fs.rmSync(dbFile, { force: true });
      }

      const rebuild = runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));
      const descriptor = describeCollectionFile(projectExperiencesArchiveFile(paths, 'demo'), 'experiences');
      const blobRows = readContentBlobRows(descriptor.dbFile, {
        source: 'project_experiences_archive'
      });
      const mirror = readMirrorCollection(projectExperiencesArchiveFile(paths, 'demo'), 'experiences');
      const archiveSearchRows = searchCatalogItems(
        descriptor.dbFile,
        [
          {
            scope: 'project',
            ownerId: 'demo',
            source: 'project_experiences_archive',
            archived: true
          }
        ],
        'compression candidate',
        5
      );

      assert.equal(rebuild.status, 'ok');
      assert.ok(blobRows.length >= 1);
      assert.ok(blobRows.every((row) => row.encoding === 'gzip-base64'));
      assert.ok(blobRows.some((row) => Number(row.stored_bytes || 0) < Number(row.original_bytes || 0)));
      assert.equal(mirror.status, 'available');
      assert.equal(mirror.items[0].details, longArchiveDetails);
      assert.equal(archiveSearchRows.length, 1);
      assert.match(JSON.parse(archiveSearchRows[0].payload_json).details, /compression candidate/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('perf benchmark emits storage scale metrics for a small generated dataset', () => {
  const result = runPerfBenchmark(undefined, {
    workspaceCount: 1,
    activeItems: 24,
    archiveItems: 16
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.generated.workspace_count, 1);
  assert.equal(result.generated.archive_probe_items, 16);
  assert.equal(result.generated.total_items, 56);
  assert.ok(typeof result.metrics.active_search_ms === 'number');
  assert.ok(typeof result.metrics.archive_fallback_search_ms === 'number');
  assert.ok(typeof result.metrics.governance_ms === 'number');
  assert.ok(typeof result.metrics.mirror_rebuild_ms === 'number');
  assert.equal(result.samples.active_search_tier, 'active');
  assert.equal(result.samples.archive_search_tier, 'archive');
  assert.equal(fs.existsSync(result.workspace_root), false);
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
      const runtimeFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'resume-session',
        'runtime-state.json'
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
      syncRuntimeStateFixture(workspace, 'resume-session', 'demo');
      const runtimeState = readJson(runtimeFile, {});
      runtimeState.current_goal = 'finish repair';
      runtimeState.latest_verified_result = 'Validated rollback path and captured 1 lesson.';
      runtimeState.next_step = 'ship fix';
      runtimeState.blocked_by = 'waiting for final review';
      runtimeState.last_user_visible_progress = 'rollback path verified';
      writeJson(runtimeFile, runtimeState);
      runCheckpointCreate(workspace, 'resume-session', 'manual');

      const result = handleHookEvent('gateway:startup', {
        workspace
      });

      assert.equal(result.status, 'resume_available');
      assert.match(result.resume_message, /finish repair/);
      assert.match(result.resume_message, /Validated rollback path and captured 1 lesson/);
      assert.match(result.resume_message, /rollback path verified/);
      assert.match(result.resume_message, /ship fix/);
      assert.match(result.resume_message, /waiting for final review/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('experience-validate renders a concise text view', () => {
  const rendered = renderExperienceValidateReport({
    status: 'updated',
    experience_id: 'exp-1',
    project_id: 'demo',
    validation_status: 'validated',
    validation_count: 2
  });

  assert.match(rendered, /Context-Anchor Experience Validate/);
  assert.match(rendered, /Experience/);
  assert.match(rendered, /VALIDATED/);
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
    assert.ok(
      fs.existsSync(path.join(openClawHome, 'automation', 'context-anchor', 'external-memory-watch.js'))
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
      assert.equal(result.memory_takeover.mode, 'enforced');
      assert.equal(result.ownership.onboarding.memory_takeover_mode, 'enforced');
      assert.equal(result.verification.status, 'verified');
      assert.equal(result.verification.readiness_transition.changed, true);
      assert.equal(result.verification.readiness_transition.improved, true);
      assert.equal(result.verification.readiness_transition.before.installation_ready, false);
      assert.equal(result.verification.readiness_transition.after.installation_ready, true);
      assert.match(result.verification.recheck_command, /npm run doctor/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host asks whether to enforce context-anchor memory takeover and records the accepted mode', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const prompts = [];

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: [],
        ask: async (prompt, defaultYes) => {
          prompts.push(prompt);
          return defaultYes;
        },
        askText: async (_prompt, defaultValue) => defaultValue
      });

      assert.equal(result.config.status, 'applied');
      assert.equal(result.memory_takeover.mode, 'enforced');
      assert.ok(prompts[0].includes('[Recommended] Let context-anchor take over memory management'));
      assert.ok(prompts[0].includes('some models or profiles may continue writing their own MEMORY.md'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host warns when enforced takeover still sees external memory drift', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.writeFileSync(
        path.join(workspace, 'MEMORY.md'),
        [
          '## MEM-config-drift-1',
          'type: best_practice',
          'heat: 86',
          'This external memory still needs to be centralized after enabling takeover.'
        ].join('\n'),
        'utf8'
      );

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: []
      });

      assert.equal(result.memory_takeover.mode, 'enforced');
      assert.equal(result.takeover_audit.status, 'warning');
      assert.ok(result.takeover_audit.issues.includes('enforced_mode_external_drift'));
      assert.match(result.takeover_audit.recommended_action.command, /migrate:memory/);
      assert.equal(result.verification.status, 'needs_attention');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host reports host audit issues across another registered workspace', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const secondaryWorkspace = path.join(workspace, 'secondary-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(primaryWorkspace, { recursive: true });
      fs.mkdirSync(secondaryWorkspace, { recursive: true });
      fs.writeFileSync(
        path.join(secondaryWorkspace, 'MEMORY.md'),
        [
          '## MEM-host-audit-1',
          'type: best_practice',
          'heat: 88',
          'This workspace still writes external memory outside context-anchor.'
        ].join('\n'),
        'utf8'
      );

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: secondaryWorkspace,
            userId: 'default-user',
            projectId: 'secondary-project'
          }
        ]
      });
      const driftWorkspace = result.host_takeover_audit.workspaces.find(
        (entry) => path.resolve(entry.workspace) === path.resolve(secondaryWorkspace)
      );

      assert.equal(result.takeover_audit.status, 'ok');
      assert.equal(result.host_takeover_audit.status, 'warning');
      assert.equal(result.host_takeover_audit.total_registered_workspaces, 2);
      assert.equal(result.host_takeover_audit.drift_workspaces, 1);
      assert.equal(driftWorkspace.health.status, 'drift_detected');
      assert.match(result.host_takeover_audit.recommended_action.command, /migrate:memory/);
      assert.match(result.host_takeover_audit.recommended_action.command, /secondary-project/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host reports profile audit issues across a sibling OpenClaw profile', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const peerOpenClawHome = path.join(workspace, 'openclaw-home-peer');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const peerWorkspace = path.join(workspace, 'peer-project');

  try {
    await withOpenClawHome(workspace, async () => {
      fs.mkdirSync(primaryWorkspace, { recursive: true });
      fs.mkdirSync(peerWorkspace, { recursive: true });

      runInstallHostAssets(peerOpenClawHome);
      fs.writeFileSync(
        path.join(peerWorkspace, 'MEMORY.md'),
        [
          '## MEM-profile-audit-1',
          'type: best_practice',
          'heat: 84',
          'A sibling OpenClaw profile still has external memory drift.'
        ].join('\n'),
        'utf8'
      );
      await runConfigureHost(peerOpenClawHome, path.join(peerOpenClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: peerWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runInstallHostAssets(openClawHome);
      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: []
      });
      const peerProfile = result.profile_takeover_audit.profiles.find(
        (entry) => path.resolve(entry.openclaw_home) === path.resolve(peerOpenClawHome)
      );

      assert.equal(result.profile_takeover_audit.status, 'warning');
      assert.equal(result.profile_takeover_audit.total_profiles, 2);
      assert.equal(result.profile_takeover_audit.drift_profiles, 1);
      assert.equal(result.profile_takeover_audit.warning_profiles, 1);
      assert.equal(peerProfile.host_takeover_audit.drift_workspaces, 1);
      assert.equal(result.profile_takeover_audit.recommended_action.openclaw_home, path.resolve(peerOpenClawHome));
      assert.match(result.profile_takeover_audit.recommended_action.command, /migrate:memory/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('configure-host can leave memory takeover in best-effort mode and returns clear limitations', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);

      const result = await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: [],
        ask: async () => false,
        askText: async (_prompt, defaultValue) => defaultValue
      });

      assert.equal(result.config.status, 'skipped');
      assert.equal(result.memory_takeover.mode, 'best_effort');
      assert.ok(result.memory_takeover.limitations.some((item) => item.includes('fragmented across sources')));
      assert.equal(result.ownership.onboarding.memory_takeover_mode, 'best_effort');
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

test('configure-host cleanup removes orphaned and stale Windows scheduler tasks', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const skillsRoot = path.join(openClawHome, 'skills');
  const validWorkspace = path.join(workspace, 'project-valid');
  const staleWorkspace = path.join(workspace, 'project-stale');

  try {
    fs.mkdirSync(validWorkspace, { recursive: true });
    fs.mkdirSync(staleWorkspace, { recursive: true });

    const paths = buildHostPaths(openClawHome, skillsRoot);
    const launchersDir = path.join(path.dirname(paths.workspace_monitor_script), 'launchers');
    fs.mkdirSync(launchersDir, { recursive: true });

    const validId = computeSchedulerLauncherId(validWorkspace);
    const staleId = computeSchedulerLauncherId(staleWorkspace);
    fs.writeFileSync(path.join(launchersDir, `${validId}.vbs`), 'valid', 'utf8');
    fs.writeFileSync(path.join(launchersDir, `${staleId}.vbs`), 'stale', 'utf8');
    fs.writeFileSync(path.join(launchersDir, `${staleId}.cmd`), '@echo off\r\n', 'utf8');

    const deletedTasks = [];
    const cleanup = cleanupWindowsSchedulerState(
      paths,
      {
        defaults: {
          workspace: validWorkspace
        },
        workspaces: [
          {
            workspace: validWorkspace
          }
        ]
      },
      {
        currentPlatform: 'win32',
        schedulerInspector: () => [
          `\\OpenClaw Context Anchor ${validId}`,
          `\\OpenClaw Context Anchor ${staleId}`,
          '\\OpenClaw Context Anchor missing-launcher-id'
        ],
        schedulerTaskDeleter: (taskName) => {
          deletedTasks.push(taskName);
        }
      }
    );

    assert.equal(cleanup.status, 'cleaned');
    assert.deepEqual(deletedTasks, [
      `\\OpenClaw Context Anchor ${staleId}`,
      '\\OpenClaw Context Anchor missing-launcher-id'
    ]);
    assert.ok(cleanup.removed_launchers.includes(`${staleId}.vbs`));
    assert.ok(cleanup.removed_launchers.includes(`${staleId}.cmd`));
    assert.equal(fs.existsSync(path.join(launchersDir, `${validId}.vbs`)), true);
    assert.equal(fs.existsSync(path.join(launchersDir, `${staleId}.vbs`)), false);
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
      assert.equal(Object.prototype.hasOwnProperty.call(heartbeat.result, 'flow'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(heartbeat.result, 'heat'), false);
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
      assert.equal(result.verification.status, 'verified');
      assert.match(result.verification.recheck_command, /npm run doctor/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('one-click install can explicitly keep memory takeover in best-effort mode', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      const result = await runOneClickInstall(openClawHome, undefined, {
        assumeYes: true,
        preserveMemories: true,
        applyConfig: false,
        memoryTakeover: false,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: null,
        addUsers: [],
        addWorkspaces: []
      });

      assert.equal(result.status, 'installed');
      assert.equal(result.configuration.memory_takeover.mode, 'best_effort');
      assert.equal(result.configuration.config.status, 'skipped');
      assert.equal(result.configuration.takeover_audit.status, 'warning');
      assert.ok(result.configuration.takeover_audit.issues.includes('profile_not_ready'));
      assert.equal(result.takeover_audit.status, 'warning');
      assert.equal(result.host_takeover_audit.status, 'warning');
      assert.equal(result.profile_takeover_audit.total_profiles, 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('install-one-click CLI stays quiet on stderr when no session upgrade is requested', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/install-one-click.js',
        '--openclaw-home',
        openClawHome,
        '--yes',
        '--keep-memory',
        '--apply-config',
        '--skip-scheduler'
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENCLAW_HOME: openClawHome
        }
      }
    );

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'installed');
    assert.equal(result.stderr.trim(), '');
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('upgrade-sessions refreshes registered active sessions and skips closed sessions by default', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const activeWorkspace = path.join(workspace, 'active-project');
  const closedWorkspace = path.join(workspace, 'closed-project');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const subagentTranscript = path.join(agentSessionsDir, 'subagent-session.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

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
      syncRuntimeStateFixture(activeWorkspace, 'active-session', 'active-project');

      runSessionStart(closedWorkspace, 'closed-session', 'closed-project', {
        userId: 'peter'
      });
      runSessionClose(closedWorkspace, 'closed-session', {
        reason: 'manual-close'
      });

      const hostConfigFile = getHostConfigFile(openClawHome);
      const hostConfig = readJson(hostConfigFile, {});
      hostConfig.sessions = [
        ...(hostConfig.sessions || []),
        {
          workspace: path.resolve(activeWorkspace),
          owner_workspace: path.resolve(activeWorkspace),
          session_key: 'agent-main-subagent-legacy',
          user_id: 'peter',
          project_id: 'active-project',
          status: 'active',
          started_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          closed_at: null,
          updated_at: new Date().toISOString()
        }
      ];
      writeJson(hostConfigFile, hostConfig);

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(subagentTranscript, activeWorkspace, 'subagent-session-id');
      writeJson(sessionsIndex, {
        'agent:main:subagent': {
          sessionId: 'subagent-session-id',
          sessionFile: subagentTranscript,
          updatedAt: 1774705706043,
          chatType: 'subagent'
        }
      });

      const result = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'), {
        rebuildMirror: true
      });
      const statusReport = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'));
      const activeResult = result.results.find((entry) => entry.session_key === 'active-session');
      const closedResult = result.results.find((entry) => entry.session_key === 'closed-session');
      const subagentResult = result.results.find((entry) => entry.session_key === 'agent-main-subagent');
      const activeBootstrap = path.join(
        activeWorkspace,
        '.context-anchor',
        'sessions',
        'active-session',
        'openclaw-bootstrap.md'
      );

      assert.equal(result.status, 'warning');
      assert.equal(result.selected_sessions, 2);
      assert.equal(result.excluded_subagent_sessions, 2);
      assert.equal(statusReport.summary.total_sessions, result.selected_sessions);
      assert.equal(statusReport.summary.excluded_subagent_sessions, result.excluded_subagent_sessions);
      assert.equal(result.upgraded_sessions, 1);
      assert.equal(result.mirror_rebuild.status, 'ok');
      assert.deepEqual(result.governance_runs, []);
      assert.equal(result.takeover_audit.status, 'warning');
      assert.ok(result.takeover_audit.issues.includes('profile_not_ready'));
      assert.equal(result.host_takeover_audit.status, 'notice');
      assert.equal(result.profile_takeover_audit.total_profiles, 1);
      assert.equal(result.verification.status, 'verified');
      assert.ok(result.verification.readiness_transition);
      assert.equal(typeof result.verification.readiness_transition.changed, 'boolean');
      assert.equal(typeof result.verification.readiness_transition.improved, 'boolean');
      assert.equal(result.verification.repair_strategy.type, 'recheck_upgrade_state');
      assert.equal(result.verification.repair_strategy.execution_mode, 'automatic');
      assert.ok(result.verification.remediation_summary);
      assert.equal(result.verification.remediation_summary.status, 'automatic_available');
      assert.equal(result.verification.remediation_summary.next_step.label, 'recheck upgraded sessions');
      assert.ok(typeof result.verification.remediation_summary.manual_confirm_only_count === 'number');
      assert.equal(result.verification.readiness_transition.after.target_sessions, 1);
      assert.equal(result.verification.upgraded_sessions, 1);
      assert.equal(result.verification.remaining_attention_sessions, 0);
      assert.match(result.verification.recheck_command, /status:sessions/);
      assert.ok(result.mirror_rebuild.workspaces_processed.some((entry) => entry === activeWorkspace));
      assert.equal(activeResult.action, 'upgraded');
      assert.equal(closedResult.action, 'skipped');
      assert.equal(subagentResult, undefined);
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

test('upgrade-sessions turns unresolved targets into confirm-only workspace selection when workspace candidates exist', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const secondaryWorkspace = path.join(workspace, 'secondary-project');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const transcriptFile = path.join(agentSessionsDir, 'unresolved-upgrade.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: secondaryWorkspace,
            userId: 'peter',
            projectId: 'secondary-project'
          }
        ]
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      fs.writeFileSync(
        transcriptFile,
        `${JSON.stringify({
          type: 'session',
          version: 3,
          id: 'unresolved-upgrade-session-id',
          timestamp: '2026-03-27T20:08:14.164Z'
        })}\n`,
        'utf8'
      );
      writeJson(sessionsIndex, {
        'agent:main:upgrade:unresolved': {
          sessionId: 'unresolved-upgrade-session-id',
          sessionFile: transcriptFile,
          updatedAt: 1774705709043,
          chatType: 'direct'
        }
      });

      const result = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'));
      const rendered = renderUpgradeReport(result);
      const workspaceDetail = result.verification.remediation_summary.next_step.auto_fix_resume_input_details.find(
        (entry) => entry.label === 'workspace'
      );

      assert.equal(result.status, 'warning');
      assert.equal(result.unresolved_sessions, 1);
      assert.equal(result.results[0].reason, 'workspace_unresolved');
      assert.equal(result.verification.status, 'needs_attention');
      assert.equal(result.verification.repair_strategy.type, 'select_workspace_then_recheck');
      assert.equal(result.verification.repair_strategy.manual_subtype, 'confirm_only');
      assert.equal(result.verification.remediation_summary.next_step.auto_fix_command, null);
      assert.match(result.verification.remediation_summary.next_step.auto_fix_blocked_reason, /workspace/i);
      assert.doesNotMatch(result.verification.remediation_summary.next_step.auto_fix_blocked_reason, /session key/i);
      assert.match(result.verification.remediation_summary.next_step.auto_fix_resume_command, /upgrade:sessions/);
      assert.equal(result.verification.remediation_summary.next_step.auto_fix_resume_validation_status, 'needs_input');
      assert.match(result.verification.remediation_summary.next_step.auto_fix_resume_validation_summary, /workspace/i);
      assert.deepEqual(workspaceDetail.candidates, [primaryWorkspace, secondaryWorkspace]);
      assert.equal(workspaceDetail.validation_status, 'candidate_available');
      assert.match(rendered, /Resume checks:/);
      assert.match(rendered, /Input workspace options:/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('upgrade summary status turns warning when verification or audits still need attention', () => {
  assert.equal(
    summarizeUpgradeRunStatus(
      { status: 'verified' },
      { takeover: 'ok', host: 'notice', profile: 'ok' }
    ),
    'ok'
  );
  assert.equal(
    summarizeUpgradeRunStatus(
      { status: 'needs_attention' },
      { takeover: 'ok', host: 'ok', profile: 'ok' }
    ),
    'warning'
  );
  assert.equal(
    summarizeUpgradeRunStatus(
      { status: 'verified' },
      { takeover: 'warning', host: 'notice', profile: 'ok' }
    ),
    'warning'
  );
  assert.equal(
    summarizeUpgradeRunStatus(
      { status: 'verified' },
      { takeover: 'ok', host: 'ok', profile: 'warning' }
    ),
    'warning'
  );
});

test('upgrade-sessions can run storage governance after rebuilding mirror data', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const activeWorkspace = path.join(workspace, 'active-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: activeWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(activeWorkspace, 'active-session', 'active-project', {
        userId: 'peter'
      });
      const paths = createPaths(activeWorkspace);
      writeJson(sessionMemoryFile(paths, 'active-session'), {
        entries: Array.from({ length: 85 }, (_, index) =>
          makeGovernanceEntry('upgrade-govern', index, {
            type: 'fact',
            session_key: 'active-session',
            project_id: 'active-project',
            scope: 'session'
          })
        )
      });

      const result = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'), {
        rebuildMirror: true,
        runGovernance: true,
        governanceMode: 'enforce'
      });
      const archiveEntries = readJson(sessionMemoryArchiveFile(paths, 'active-session'), { entries: [] }).entries;
      const dbFile = describeCollectionFile(sessionMemoryFile(paths, 'active-session'), 'entries').dbFile;
      const latestRun = readLatestGovernanceRun(dbFile, {
        workspace: activeWorkspace,
        session_key: 'active-session',
        project_id: 'active-project',
        user_id: 'peter'
      });

      assert.equal(result.status, 'ok');
      assert.equal(result.governance_runs.length, 1);
      assert.equal(result.governance_runs[0].reason, 'upgrade-sessions');
      assert.equal(archiveEntries.length, 5);
      assert.equal(latestRun.reason, 'upgrade-sessions');
      assert.ok(latestRun.totals.archived >= 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('upgrade-sessions reports structured progress events during long-running upgrade chains', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const activeWorkspace = path.join(workspace, 'active-project');

  try {
    await withOpenClawHome(workspace, async () => {
      const progressEvents = [];
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: activeWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(activeWorkspace, 'active-session', 'active-project', {
        userId: 'peter'
      });

      const result = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'), {
        rebuildMirror: true,
        runGovernance: true,
        progress: (event) => progressEvents.push(event)
      });

      assert.equal(result.status, 'warning');
      assert.ok(progressEvents.some((event) => event.type === 'scan:start'));
      assert.ok(progressEvents.some((event) => event.type === 'scan:done'));
      assert.ok(progressEvents.some((event) => event.type === 'session:start'));
      assert.ok(progressEvents.some((event) => event.type === 'session:done'));
      assert.ok(progressEvents.some((event) => event.type === 'mirror:start'));
      assert.ok(progressEvents.some((event) => event.type === 'mirror:done'));
      assert.ok(progressEvents.some((event) => event.type === 'governance:start'));
      assert.ok(progressEvents.some((event) => event.type === 'governance:target:done'));
      assert.ok(progressEvents.some((event) => event.type === 'finish'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('upgrade-sessions automatically cleans stale Windows scheduler tasks during upgrade', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const activeWorkspace = path.join(workspace, 'active-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: activeWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(activeWorkspace, 'active-session', 'active-project', {
        userId: 'peter'
      });

      const staleWorkspace = path.join(workspace, 'stale-project');
      const launchersDir = path.join(openClawHome, 'automation', 'context-anchor', 'launchers');
      fs.mkdirSync(launchersDir, { recursive: true });
      const staleLauncherId = computeSchedulerLauncherId(staleWorkspace);
      fs.writeFileSync(path.join(launchersDir, `${staleLauncherId}.vbs`), 'stale', 'utf8');

      const deletedTasks = [];
      const progressEvents = [];
      const result = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'), {
        currentPlatform: 'win32',
        schedulerInspector: () => [`\\OpenClaw Context Anchor ${staleLauncherId}`],
        schedulerTaskDeleter: (taskName) => deletedTasks.push(taskName),
        progress: (event) => progressEvents.push(event)
      });

      assert.equal(result.scheduler_cleanup.status, 'cleaned');
      assert.deepEqual(result.scheduler_cleanup.removed_tasks, [`\\OpenClaw Context Anchor ${staleLauncherId}`]);
      assert.ok(result.scheduler_cleanup.removed_launchers.includes(`${staleLauncherId}.vbs`));
      assert.deepEqual(deletedTasks, [`\\OpenClaw Context Anchor ${staleLauncherId}`]);
      assert.ok(progressEvents.some((event) => event.type === 'scheduler:cleanup'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('upgrade-sessions CLI emits progress on stderr while keeping stdout as JSON', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const activeWorkspace = path.join(workspace, 'active-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: false,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: activeWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(activeWorkspace, 'active-session', 'active-project', {
        userId: 'peter'
      });

      const result = spawnSync(
        process.execPath,
        [
          'scripts/upgrade-sessions.js',
          '--openclaw-home',
          openClawHome,
          '--skills-root',
          path.join(openClawHome, 'skills'),
          '--rebuild-mirror',
          '--run-governance'
        ],
        {
          cwd: path.resolve(__dirname, '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            OPENCLAW_HOME: openClawHome
          }
        }
      );

      assert.equal(result.status, 0);
      assert.match(result.stderr, /\[upgrade\] selected \d+ session\(s\) for processing/);
      assert.match(result.stderr, /\[upgrade\] mirror rebuild: starting/);
      assert.match(result.stderr, /\[upgrade\] governance: running \d+ target\(s\)/);
      assert.match(result.stderr, /\[upgrade\] complete upgraded=\d+ skipped=\d+ unresolved=\d+/);
      assert.equal(JSON.parse(result.stdout).status, 'ok');
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
      syncRuntimeStateFixture(sessionWorkspace, 'agent-main-main', 'workspace-a');

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
      assert.equal(result.session_upgrade.mirror_rebuild.status, 'ok');
      assert.equal(result.session_upgrade.governance_runs.length, 1);
      assert.equal(result.session_upgrade.governance_runs[0].reason, 'upgrade-sessions');
      assert.ok(result.session_upgrade.mirror_rebuild.workspaces_processed.some((entry) => entry === sessionWorkspace));
      assert.equal(result.mirror_rebuild, null);
      assert.equal(result.verification.status, 'needs_attention');
      assert.match(result.verification.recheck_command, /npm run doctor/);
      assert.ok(Array.isArray(result.verification.repair_strategies.all));
      assert.ok(result.verification.repair_strategies.configuration.all.length >= 1);
      assert.ok(Array.isArray(result.verification.repair_strategies.automatic));
      assert.ok(result.verification.remediation_summary);
      assert.ok(typeof result.verification.remediation_summary.manual_count === 'number');
      assert.ok(result.verification.remediation_summary.next_step);
      assert.ok(Array.isArray(result.verification.repair_strategies.manual_confirm_only));
      assert.ok(Array.isArray(result.verification.repair_strategies.manual_external_environment));
      assert.ok(typeof result.verification.remediation_summary.manual_external_issue_types === 'object');
      assert.equal(result.session_upgrade.verification.status, 'verified');
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
      assert.equal(result.verification.status, 'verified');
      assert.equal(result.verification.readiness_transition.changed, true);
      assert.equal(result.verification.readiness_transition.improved, true);
      assert.ok(result.verification.readiness_transition.before.target_attention_sessions >= 1);
      assert.equal(result.verification.readiness_transition.after.target_attention_sessions, 0);
      assert.equal(result.verification.configured_sessions, 1);
      assert.equal(result.verification.verified_sessions, 1);
      assert.equal(result.verification.remaining_attention_sessions, 0);
      assert.match(result.verification.recheck_command, /status:sessions/);
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

      assert.equal(report.summary.total_sessions, 3);
      assert.equal(report.summary.excluded_hidden_sessions, 1);
      assert.equal(report.summary.ready_sessions, 1);
      assert.equal(report.summary.attention_sessions, 2);
      assert.equal(report.summary.unresolved_sessions, 0);
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
      assert.equal(unresolvedGroup, undefined);
      assert.match(report.commands.diagnostic_command, /diagnose:sessions/);
      assert.match(report.commands.repair_command, /configure:sessions/);
      assert.match(configuredGroup.diagnostic_command, /--workspace/);
      assert.match(rendered, /Mirror: ON/);
      assert.match(diagnosisRendered, /Mirror: ON/);
      assert.match(configuredGroup.repair_command, /--workspace/);
      assert.match(rendered, /Context-Anchor Session Overview/);
      assert.match(rendered, /Diagnostic command:/);
      assert.match(rendered, /Repair command:/);
      assert.match(rendered, /Warning: 2 session\(s\) need attention/);
      assert.match(rendered, /Excluded hidden sessions: 1/);
      assert.match(rendered, /Workspace: .*configured-workspace/);
      assert.match(rendered, /Hook: ON/);
      assert.match(rendered, /Monitor: RUNNING/);
      assert.match(rendered, /READY/);
      assert.match(rendered, /PARTIAL/);
      assert.match(rendered, /MISSING/);
      assert.doesNotMatch(rendered, /UNKNOWN/);
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

test('session status can include hidden sessions when explicitly requested', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const configuredReadyTranscript = path.join(agentSessionsDir, 'configured-ready.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: configuredWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(configuredWorkspace, 'agent:main:main', 'configured-workspace', {
        userId: 'peter',
        openClawSessionId: 'ready-session-id'
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(configuredReadyTranscript, configuredWorkspace, 'ready-session-id');
      writeJson(sessionsIndex, {
        'agent:main:main': {
          sessionId: 'ready-session-id',
          sessionFile: configuredReadyTranscript,
          updatedAt: 1774705704043,
          chatType: 'direct'
        },
        'agent:main:ghost': {
          sessionId: 'ghost-session-id',
          updatedAt: 1774705707043,
          chatType: 'direct'
        }
      });

      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'), {
        includeHiddenSessions: true
      });

      assert.equal(report.summary.total_sessions, 2);
      assert.equal(report.summary.excluded_hidden_sessions, 0);
      assert.ok(report.groups.some((entry) => entry.workspace === null));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session status summarizes hidden session reasons in the default overview', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const configuredReadyTranscript = path.join(agentSessionsDir, 'configured-ready.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: configuredWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(configuredWorkspace, 'agent:main:main', 'configured-workspace', {
        userId: 'peter',
        openClawSessionId: 'ready-session-id'
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(configuredReadyTranscript, configuredWorkspace, 'ready-session-id');
      writeJson(sessionsIndex, {
        'agent:main:main': {
          sessionId: 'ready-session-id',
          sessionFile: configuredReadyTranscript,
          updatedAt: 1774705704043,
          chatType: 'direct'
        },
        'agent:main:ghost': {
          sessionId: 'ghost-session-id',
          updatedAt: 1774705707043,
          chatType: 'direct'
        }
      });

      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'));
      const rendered = renderOpenClawSessionStatusReport(report);

      assert.equal(report.summary.excluded_hidden_sessions, 1);
      assert.equal(report.summary.hidden_session_summary.by_reason.workspace_unresolved, 1);
      assert.match(rendered, /Excluded hidden sessions: 1/);
      assert.match(rendered, /Hidden filter: workspace unresolved 1/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('registered host-only stale sessions are hidden by default from status and upgrade', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const visibleWorkspace = path.join(workspace, 'visible-workspace');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: visibleWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(visibleWorkspace, 'agent:main:visible', 'visible-workspace', {
        userId: 'peter',
        openClawSessionId: 'visible-session-id'
      });

      const hostConfigFile = getHostConfigFile(openClawHome);
      const hostConfig = readJson(hostConfigFile, {});
      hostConfig.sessions = [
        ...(hostConfig.sessions || []),
        {
          workspace: path.resolve(path.join(workspace, 'stale-workspace')),
          session_key: 'agent:main:stale',
          user_id: 'peter',
          project_id: 'stale-workspace',
          status: 'active',
          started_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          closed_at: null,
          updated_at: new Date().toISOString()
        }
      ];
      writeJson(hostConfigFile, hostConfig);

      const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
      fs.mkdirSync(agentSessionsDir, { recursive: true });
      const visibleTranscript = path.join(agentSessionsDir, 'visible.jsonl');
      const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');
      writeSessionTranscript(visibleTranscript, visibleWorkspace, 'visible-session-id');
      writeJson(sessionsIndex, {
        'agent:main:visible': {
          sessionId: 'visible-session-id',
          sessionFile: visibleTranscript,
          updatedAt: 1774705704043,
          chatType: 'direct'
        }
      });

      const statusReport = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'));
      const upgradeResult = runUpgradeSessions(openClawHome, path.join(openClawHome, 'skills'));
      const renderedUpgrade = renderUpgradeReport(upgradeResult);

      assert.equal(statusReport.summary.total_sessions, 1);
      assert.equal(statusReport.summary.excluded_hidden_sessions, 1);
      assert.equal(statusReport.summary.hidden_session_summary.by_reason.registered_without_visible_transcript, 1);
      assert.equal(upgradeResult.selected_sessions, 1);
      assert.equal(upgradeResult.excluded_hidden_sessions, 1);
      assert.equal(upgradeResult.hidden_session_summary.by_reason.registered_without_visible_transcript, 1);
      assert.match(renderedUpgrade, /Hidden filter: stale host-only 1/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('registered managed sessions without OpenClaw transcripts remain visible by default', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const managedWorkspace = path.join(workspace, 'managed-workspace');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'peter',
        defaultWorkspace: managedWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runSessionStart(managedWorkspace, 'managed-session', 'managed-workspace', {
        userId: 'peter'
      });

      const collected = collectSessionCandidates(openClawHome);
      const managedSession = collected.candidates.find((entry) => entry.session_key === 'managed-session');

      assert.equal(collected.excluded_hidden_sessions.length, 0);
      assert.ok(managedSession);
      assert.equal(managedSession.managed_artifacts_visible, true);
      assert.equal(managedSession.transcript_exists, false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session status highlights task continuity and last visible benefit per workspace', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const transcriptFile = path.join(agentSessionsDir, 'continuity.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      const paths = createPaths(configuredWorkspace);

      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: true,
        defaultUserId: 'default-user',
        defaultWorkspace: configuredWorkspace,
        schedulerWorkspace: configuredWorkspace,
        schedulerUserId: 'default-user',
        schedulerProjectId: 'configured-workspace',
        schedulerRegistrar: () => {},
        addUsers: [],
        addWorkspaces: []
      });
      runSessionStart(configuredWorkspace, 'agent:main:continuity', 'configured-workspace', {
        userId: 'default-user',
        openClawSessionId: 'continuity-session-id'
      });

      const stateFile = sessionStateFile(paths, 'agent:main:continuity');
      const state = readJson(stateFile, {});
      state.active_task = 'stabilize checkout retries';
      state.commitments = [
        {
          id: 'continuity-next-step',
          what: 'ship checkout retry fix',
          status: 'pending'
        }
      ];
      state.metadata = {
        ...(state.metadata || {}),
        blocked_by: 'waiting for CI rerun'
      };
      writeJson(stateFile, state);
      runHeartbeat(configuredWorkspace, 'agent:main:continuity', 'configured-workspace', 50);

      const runtimeState = readJson(runtimeStateFile(paths, 'agent:main:continuity'), {});
      runtimeState.latest_verified_result = 'retry policy updated';
      runtimeState.last_user_visible_progress = 'retry policy updated';
      writeJson(runtimeStateFile(paths, 'agent:main:continuity'), runtimeState);

      writeJson(sessionSummaryFile(paths, 'agent:main:continuity'), {
        created_at: '2026-04-04T00:00:00.000Z',
        benefit_summary: {
          visible: true,
          summary: 'captured 1 new lesson(s); updated draft checkout-retry-skill',
          summary_lines: [
            'captured 1 new lesson(s)',
            'updated draft checkout-retry-skill'
          ]
        }
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(transcriptFile, configuredWorkspace, 'continuity-session-id');
      writeJson(sessionsIndex, {
        'agent:main:continuity': {
          sessionId: 'continuity-session-id',
          sessionFile: transcriptFile,
          updatedAt: 1774705709043,
          chatType: 'direct'
        }
      });

      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'), {
        schedulerProbe: () => 'running'
      });
      const rendered = renderOpenClawSessionStatusReport(report);
      const diagnosisRendered = renderOpenClawSessionDiagnosisReport(report);
      const group = report.groups.find((entry) => entry.workspace && entry.workspace.endsWith('configured-workspace'));
      const session = group.sessions.find((entry) => entry.session_key === 'agent:main:continuity');

      assert.equal(report.summary.task_visible_workspaces, 1);
      assert.equal(report.summary.benefit_visible_workspaces, 1);
      assert.equal(group.task_state_session_key, 'agent:main:continuity');
      assert.equal(group.task_state_summary.current_goal, 'stabilize checkout retries');
      assert.equal(group.task_state_summary.latest_verified_result, 'retry policy updated');
      assert.equal(group.task_state_summary.next_step, 'ship checkout retry fix');
      assert.equal(group.task_state_summary.blocked_by, 'waiting for CI rerun');
      assert.equal(group.last_benefit_session_key, 'agent:main:continuity');
      assert.equal(group.last_benefit_summary.visible, true);
      assert.match(group.last_benefit_summary.summary, /captured 1 new lesson/);
      assert.equal(session.task_state_summary.current_goal, 'stabilize checkout retries');
      assert.equal(session.last_benefit_summary.visible, true);
      assert.match(rendered, /Visible continuity: 1 workspace\(s\)/);
      assert.match(rendered, /Task continuity: agent:main:continuity -> goal=stabilize checkout retries/);
      assert.match(rendered, /result=retry policy updated/);
      assert.match(rendered, /next=ship checkout retry fix/);
      assert.match(rendered, /blocked_by=waiting for CI rerun/);
      assert.match(rendered, /Last benefit: agent:main:continuity -> captured 1 new lesson\(s\); updated draft checkout-retry-skill/);
      assert.match(diagnosisRendered, /Task continuity: agent:main:continuity -> goal=stabilize checkout retries/);
      assert.match(diagnosisRendered, /Last benefit: agent:main:continuity -> captured 1 new lesson\(s\); updated draft checkout-retry-skill/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session diagnosis surfaces task continuity health when task state is missing', () => {
  const report = {
    openclaw_home: 'C:/Users/demo/.openclaw',
    summary: {
      total_sessions: 1,
      attention_sessions: 1,
      drift_workspaces: 0,
      task_visible_workspaces: 0,
      benefit_visible_workspaces: 0
    },
    global: {
      installation: { ready: true },
      configuration: { ready: true },
      ownership: {}
    },
    commands: {
      diagnostic_command: 'npm run diagnose:sessions',
      repair_command: 'npm run configure:sessions',
      recheck_command: 'npm run status:sessions',
      repair_strategy: { label: 'configure sessions -> recheck', execution_mode: 'automatic' }
    },
    remediation_summary: { next_step: null },
    groups: [
      {
        workspace: 'D:/demo',
        needs_attention: true,
        mirror: { available: true, collections: 1, documents: 1, indexed_sessions: 1 },
        memory_sources: { health: { status: 'single_source' }, external_source_count: 0, unsynced_source_count: 0, last_legacy_sync_at: null },
        task_state_summary: { visible: false, summary: 'No task-state continuity summary available.' },
        task_state_health: { status: 'missing', summary: 'No visible task-state continuity is available yet.' },
        task_state_session_key: null,
        last_benefit_summary: null,
        last_benefit_session_key: null,
        issues: ['task_state_missing'],
        diagnostic_command: 'npm run diagnose:sessions -- --workspace "D:/demo"',
        repair_command: 'npm run configure:sessions -- --workspace "D:/demo" --yes',
        follow_up_command: null,
        recheck_command: 'npm run status:sessions -- --workspace "D:/demo"',
        repair_strategy: { label: 'configure sessions -> recheck', execution_mode: 'automatic' },
        remediation_summary: { next_step: null },
        repair_sequence: [],
        sessions: []
      }
    ]
  };

  const rendered = renderOpenClawSessionDiagnosisReport(report);
  assert.match(rendered, /Task continuity health/);
  assert.match(rendered, /MISSING/);
  assert.match(rendered, /task continuity is not visible yet/);
  assert.match(rendered, /configure sessions -> recheck|repair task state -> recheck/);
});

test('status report recommends repairing task state when continuity is incomplete', async () => {
  const workspace = makeWorkspace();

  try {
    await withOpenClawHome(workspace, async () => {
      const openClawHome = path.join(workspace, 'openclaw-home');
      const hostConfigFile = getHostConfigFile(openClawHome);
      fs.mkdirSync(path.dirname(hostConfigFile), { recursive: true });
      writeJson(hostConfigFile, {
        defaults: {
          user_id: 'default-user',
          workspace
        },
        onboarding: {
          auto_register_workspaces: true,
          memory_takeover_mode: 'enforced'
        },
        users: [{ user_id: 'default-user' }],
        workspaces: [{ workspace, user_id: 'default-user', project_id: 'demo' }],
        sessions: []
      });
      runSessionStart(workspace, 'task-state-report', 'demo', { userId: 'default-user' });
      const paths = createPaths(workspace);
      const runtimeFile = runtimeStateFile(paths, 'task-state-report');
      const runtimeState = readJson(runtimeFile, {});
      runtimeState.current_goal = 'stabilize checkout retries';
      runtimeState.next_step = null;
      runtimeState.blocked_by = null;
      writeJson(runtimeFile, runtimeState);

      const report = runStatusReport(workspace, 'task-state-report', 'demo', 'default-user');

      assert.equal(report.session.task_state_health.status, 'partial');
      assert.equal(report.recommended_action.type, 'repair_task_state');
      assert.equal(report.recommended_action.repair_strategy.type, 'repair_task_next_step_then_recheck');
      assert.match(report.recommended_action.summary, /capture a fresh next step/i);
      assert.match(report.recommended_action.resolution_hint, /run one heartbeat/i);
      assert.match(report.recommended_action.follow_up_command, /heartbeat\.js/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report treats result-only task continuity as complete and does not route to repair', async () => {
  const workspace = makeWorkspace();

  try {
    await withOpenClawHome(workspace, async () => {
      const openClawHome = path.join(workspace, 'openclaw-home');
      const hostConfigFile = getHostConfigFile(openClawHome);
      fs.mkdirSync(path.dirname(hostConfigFile), { recursive: true });
      writeJson(hostConfigFile, {
        defaults: {
          user_id: 'default-user',
          workspace
        },
        onboarding: {
          auto_register_workspaces: true,
          memory_takeover_mode: 'enforced'
        },
        users: [{ user_id: 'default-user' }],
        workspaces: [{ workspace, user_id: 'default-user', project_id: 'demo' }],
        sessions: []
      });

      runSessionStart(workspace, 'completed-task-report', 'demo', { userId: 'default-user' });
      const paths = createPaths(workspace);
      const runtimeFile = runtimeStateFile(paths, 'completed-task-report');
      const runtimeState = readJson(runtimeFile, {});
      runtimeState.current_goal = null;
      runtimeState.latest_verified_result = 'validated retry direction';
      runtimeState.next_step = null;
      runtimeState.blocked_by = null;
      runtimeState.last_user_visible_progress = 'validated retry direction';
      writeJson(runtimeFile, runtimeState);

      const report = runStatusReport(workspace, 'completed-task-report', 'demo', 'default-user');
      const rendered = renderStatusReportText(report);

      assert.equal(report.session.task_state_health.status, 'complete');
      assert.equal(report.recommended_action.type, 'none');
      assert.match(rendered, /COMPLETE/);
      assert.match(rendered, /reference-only progress/i);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('task-state health classifies missing goal and next step distinctly', () => {
  const summary = assessTaskStateHealth({
    visible: true,
    current_goal: null,
    next_step: null,
    blocked_by: null,
    last_user_visible_progress: 'captured retry constraints'
  });

  assert.equal(summary.status, 'partial');
  assert.deepEqual(summary.issues, ['task_state_missing_goal_and_next_step']);
});

test('task-state health classifies reference-only completed continuity as complete', () => {
  const { assessTaskStateHealth } = require('../scripts/lib/task-state');
  const summary = assessTaskStateHealth({
    visible: true,
    current_goal: null,
    next_step: null,
    blocked_by: null,
    latest_verified_result: 'validated retry direction',
    last_user_visible_progress: 'captured retry constraints'
  });

  assert.equal(summary.status, 'complete');
  assert.deepEqual(summary.issues, []);
});

test('session status adds heartbeat follow-up when next step continuity is missing', () => {
  const commands = buildActionCommands(
    {
      workspace: 'D:/demo',
      sessionKey: 'agent:main:checkout-fix',
      projectId: 'demo',
      userId: 'alice'
    },
    {
      openclawHome: 'D:/openclaw-home',
      skillsRoot: 'D:/openclaw-home/skills',
      issues: ['task_state_missing_next_step'],
      globalConfigurationReady: true,
      memoryTakeoverMode: 'enforced',
      memorySourceStatus: 'single_source',
      forceYes: true
    }
  );

  assert.match(commands.repair_command, /configure:sessions/);
  assert.match(commands.follow_up_command, /heartbeat\.js/);
  assert.equal(commands.repair_strategy.type, 'repair_task_next_step_then_recheck');
  assert.match(commands.resolution_hint, /run one heartbeat/i);
  assert.ok(Array.isArray(commands.command_examples));
  assert.match(commands.command_examples[1], /heartbeat\.js/);
});

test('session diagnosis explains missing goal and next step with concrete remediation guidance', () => {
  const report = {
    openclaw_home: 'C:/Users/demo/.openclaw',
    summary: {
      total_sessions: 1,
      attention_sessions: 1,
      drift_workspaces: 0,
      task_visible_workspaces: 1,
      benefit_visible_workspaces: 0
    },
    global: {
      installation: { ready: true },
      configuration: { ready: true },
      ownership: {}
    },
    commands: {
      diagnostic_command: 'npm run diagnose:sessions',
      repair_command: 'npm run configure:sessions',
      recheck_command: 'npm run status:sessions',
      repair_strategy: { label: 'configure sessions -> recheck', execution_mode: 'automatic' }
    },
    remediation_summary: { next_step: null },
    groups: [
      {
        workspace: 'D:/demo',
        needs_attention: true,
        mirror: { available: true, collections: 1, documents: 1, indexed_sessions: 1 },
        memory_sources: { health: { status: 'single_source' }, external_source_count: 0, unsynced_source_count: 0, last_legacy_sync_at: null },
        task_state_summary: { visible: true, summary: 'progress=captured retry constraints', last_user_visible_progress: 'captured retry constraints' },
        task_state_health: {
          status: 'partial',
          summary: 'Task continuity is missing current goal and next step.',
          issues: ['task_state_missing_goal_and_next_step']
        },
        task_state_session_key: 'agent:main:checkout-fix',
        last_benefit_summary: null,
        last_benefit_session_key: null,
        issues: ['task_state_missing_goal_and_next_step'],
        diagnostic_command: 'npm run diagnose:sessions -- --workspace "D:/demo"',
        repair_command: 'npm run configure:sessions -- --workspace "D:/demo" --session-key "agent:main:checkout-fix" --project-id "demo" --yes',
        follow_up_command: 'node "D:/demo/heartbeat.js"',
        recheck_command: 'npm run status:sessions -- --workspace "D:/demo"',
        repair_strategy: {
          type: 'repair_task_goal_and_next_step_then_recheck',
          label: 'repair task goal+next step -> recheck',
          execution_mode: 'automatic',
          requires_manual_confirmation: false,
          summary: 'Refresh task continuity, capture both current goal and next step again, then rerun session status.',
          resolution_hint: 'Neither current goal nor next step is visible yet. Rebuild the session linkage first, then run one heartbeat so later restores stop feeling blank.',
          command_examples: [
            'npm run configure:sessions -- --workspace "D:/demo" --session-key "agent:main:checkout-fix" --project-id "demo" --yes',
            'node "D:/demo/heartbeat.js"',
            'npm run status:sessions -- --workspace "D:/demo"'
          ]
        },
        remediation_summary: {
          next_step: {
            label: 'repair task goal+next step -> recheck',
            summary: 'Refresh task continuity, capture both current goal and next step again, then rerun session status.',
            execution_mode: 'automatic',
            resolution_hint: 'Neither current goal nor next step is visible yet. Rebuild the session linkage first, then run one heartbeat so later restores stop feeling blank.',
            command_examples: [
              'npm run configure:sessions -- --workspace "D:/demo" --session-key "agent:main:checkout-fix" --project-id "demo" --yes'
            ]
          }
        },
        repair_sequence: [],
        sessions: []
      }
    ]
  };

  const rendered = renderOpenClawSessionDiagnosisReport(report);
  assert.match(rendered, /Guidance: Neither current goal nor next step is visible yet\./);
  assert.match(rendered, /run one heartbeat/);
  assert.match(rendered, /Example command: npm run configure:sessions/);
});

test('task-state summary stringifies structured current goal values for user-facing reports', () => {
  const { buildTaskStateSummary } = require('../scripts/lib/task-state');

  const summary = buildTaskStateSummary({
    current_goal: { goal: 'stabilize checkout retries', owner: 'ci' },
    next_step: { summary: 'ship checkout retry fix' }
  });

  assert.equal(summary.current_goal, 'stabilize checkout retries');
  assert.equal(summary.next_step, 'ship checkout retry fix');
  assert.match(summary.summary, /goal=stabilize checkout retries/);
});

test('session status recommends configure-host when only monitor setup is missing', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const transcriptFile = path.join(agentSessionsDir, 'monitor-missing.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: configuredWorkspace,
        addUsers: [],
        addWorkspaces: []
      });
      runSessionStart(configuredWorkspace, 'agent:main:monitor:missing', 'configured-workspace', {
        userId: 'default-user',
        openClawSessionId: 'monitor-missing-session-id'
      });

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(transcriptFile, configuredWorkspace, 'monitor-missing-session-id');
      writeJson(sessionsIndex, {
        'agent:main:monitor:missing': {
          sessionId: 'monitor-missing-session-id',
          sessionFile: transcriptFile,
          updatedAt: 1774705704043,
          chatType: 'direct'
        }
      });

      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'), {
        schedulerProbe: () => 'missing'
      });
      const group = report.groups.find((entry) => entry.workspace && entry.workspace.endsWith('configured-workspace'));

      assert.equal(group.hook_status, 'on');
      assert.equal(group.monitor_status, 'off');
      assert.ok(group.issues.includes('monitor_not_configured'));
      assert.match(group.repair_command, /configure:host/);
      assert.match(group.repair_command, /--enable-scheduler/);
      assert.doesNotMatch(group.repair_command, /configure:sessions/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session status global repair command recommends configure-host when host configuration is not ready', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'));

      assert.match(report.commands.repair_command, /configure:host/);
      assert.match(report.commands.repair_command, /--apply-config/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session status surfaces external memory drift and recommends migrate-memory with an enforcement follow-up', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const configuredWorkspace = path.join(workspace, 'configured-workspace');
  const agentSessionsDir = path.join(openClawHome, 'agents', 'main', 'sessions');
  const transcriptFile = path.join(agentSessionsDir, 'memory-drift.jsonl');
  const sessionsIndex = path.join(agentSessionsDir, 'sessions.json');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        assumeYes: true,
        applyConfig: true,
        enableScheduler: true,
        defaultUserId: 'default-user',
        defaultWorkspace: configuredWorkspace,
        schedulerWorkspace: configuredWorkspace,
        schedulerUserId: 'default-user',
        schedulerProjectId: 'configured-workspace',
        schedulerRegistrar: () => {},
        addUsers: [],
        addWorkspaces: [],
        memoryTakeover: false
      });
      runSessionStart(configuredWorkspace, 'agent:main:memory:drift', 'configured-workspace', {
        userId: 'default-user',
        openClawSessionId: 'memory-drift-session-id'
      });

      fs.mkdirSync(path.join(configuredWorkspace, 'memory'), { recursive: true });
      fs.writeFileSync(
        path.join(configuredWorkspace, 'memory', 'model-note.md'),
        '# Drifted Memory\n\nThis external memory file still needs to be centralized.',
        'utf8'
      );

      fs.mkdirSync(agentSessionsDir, { recursive: true });
      writeSessionTranscript(transcriptFile, configuredWorkspace, 'memory-drift-session-id');
      writeJson(sessionsIndex, {
        'agent:main:memory:drift': {
          sessionId: 'memory-drift-session-id',
          sessionFile: transcriptFile,
          updatedAt: 1774705708043,
          chatType: 'direct'
        }
      });

      const report = buildOpenClawSessionStatusReport(openClawHome, path.join(openClawHome, 'skills'), {
        schedulerProbe: () => 'running'
      });
      const rendered = renderOpenClawSessionStatusReport(report);
      const diagnosisRendered = renderOpenClawSessionDiagnosisReport(report);
      const group = report.groups.find((entry) => entry.workspace && entry.workspace.endsWith('configured-workspace'));

      assert.equal(report.status, 'warning');
      assert.equal(report.summary.drift_workspaces, 1);
      assert.equal(group.memory_sources.health.status, 'drift_detected');
      assert.ok(group.issues.includes('legacy_memory_never_synced'));
      assert.match(group.repair_command, /migrate:memory/);
      assert.match(group.repair_command, /--workspace/);
      assert.match(group.follow_up_command, /configure:host/);
      assert.match(group.follow_up_command, /--enforce-memory-takeover/);
      assert.match(group.recheck_command, /status:sessions/);
      assert.equal(group.repair_strategy.type, 'migrate_then_enforce_then_recheck');
      assert.match(rendered, /Memory sources: SINGLE_SOURCE/);
      assert.match(rendered, /DRIFT 1/);
      assert.match(rendered, /Memory: DRIFT_DETECTED/);
      assert.match(diagnosisRendered, /Next step: \[auto\] migrate -> enforce -> recheck/);
      assert.match(diagnosisRendered, /external memory source has not been centralized yet/);
      assert.match(diagnosisRendered, /Follow-up:/);
      assert.match(diagnosisRendered, /Recheck:/);
      assert.match(diagnosisRendered, /Strategy: \[auto\] migrate -> enforce -> recheck/);
      assert.match(diagnosisRendered, /Auto fix path:/);
      assert.match(diagnosisRendered, /Auto fix command:/);
      assert.match(diagnosisRendered, /Guidance:/);
      assert.match(diagnosisRendered, /Example command:/);
      assert.match(diagnosisRendered, /Repair path:/);
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

test('auto-fix helper encodes a command sequence into a reusable one-click command', async () => {
  const sequence = [
    { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/demo"' },
    { step: 'recheck', command: 'npm run doctor -- --workspace "D:/demo"' }
  ];

  const token = encodeAutoFixSequence(sequence);
  const commandLine = buildAutoFixCommand(sequence);
  const decoded = decodeAutoFixSequence(token);
  const result = await runAutoFix({
    steps: token,
    dryRun: true
  });

  assert.ok(token);
  assert.match(commandLine, /scripts[\\/]+auto-fix\.js/);
  assert.doesNotMatch(commandLine, /--yes/);
  assert.equal(decoded[0].risk_level, 'medium');
  assert.equal(decoded[0].requires_confirmation, false);
  assert.equal(decoded[1].risk_level, 'low');
  assert.equal(decoded[1].requires_confirmation, false);
  assert.equal(result.status, 'planned');
  assert.equal(result.total_steps, 2);
  assert.equal(result.high_risk_steps, 0);
  assert.equal(result.steps[0].risk_level, 'medium');
  assert.equal(result.steps[1].risk_level, 'low');
});

test('auto-fix classifies host configuration changes as high-risk with confirmation', async () => {
  const sequence = [
    { step: 'repair', command: 'npm run configure:host -- --workspace "D:/demo" --apply-config --enable-scheduler' },
    { step: 'recheck', command: 'npm run doctor -- --workspace "D:/demo"' }
  ];

  const risk = classifyAutoFixRisk(sequence[0].command, sequence[0].step);
  const result = await runAutoFix({
    steps: encodeAutoFixSequence(sequence),
    dryRun: true
  });

  assert.equal(risk.risk_level, 'high');
  assert.equal(risk.requires_confirmation, true);
  assert.equal(result.high_risk_steps, 1);
  assert.equal(result.steps[0].risk_level, 'high');
  assert.equal(result.steps[0].requires_confirmation, true);
});

test('auto-fix supports batch strategy filters for until, skip-recheck, and risk-threshold', async () => {
  const sequence = [
    { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/demo"' },
    { step: 'follow_up', command: 'npm run configure:host -- --workspace "D:/demo" --apply-config --enable-scheduler' },
    { step: 'recheck', command: 'npm run doctor -- --workspace "D:/demo"' }
  ];

  const filteredUntil = filterAutoFixSequence(sequence, { until: 'repair' });
  const filteredRisk = filterAutoFixSequence(sequence, { riskThreshold: 'medium' });
  const commandLine = buildAutoFixCommand(sequence, {
    until: 'follow_up',
    skipRecheck: true,
    riskThreshold: 'high'
  });
  const result = await runAutoFix({
    steps: encodeAutoFixSequence(sequence),
    until: 'follow_up',
    skipRecheck: true,
    riskThreshold: 'high',
    dryRun: true
  });

  assert.equal(filteredUntil.length, 1);
  assert.equal(filteredUntil[0].step, 'repair');
  assert.equal(filteredRisk.length, 2);
  assert.deepEqual(filteredRisk.map((entry) => entry.step), ['repair', 'recheck']);
  assert.match(commandLine, /--until follow_up/);
  assert.match(commandLine, /--skip-recheck/);
  assert.match(commandLine, /--risk-threshold high/);
  assert.equal(result.total_steps, 2);
  assert.equal(result.steps[0].step, 'repair');
  assert.equal(result.steps[1].step, 'follow_up');
  assert.equal(result.high_risk_steps, 1);
  assert.equal(result.strategy.until, 'follow_up');
  assert.equal(result.strategy.skip_recheck, true);
  assert.equal(result.strategy.risk_threshold, 'high');
});

test('auto-fix persists user default strategy and reuses it on later runs', async () => {
  const workspace = makeWorkspace();

  try {
    const sequence = [
      { step: 'repair', command: 'node -e "process.exit(0)"' },
      { step: 'follow_up', command: 'node -e "process.exit(0)"' },
      { step: 'recheck', command: 'node -e "process.exit(0)"' }
    ];
    const token = encodeAutoFixSequence(sequence);

    const saved = await runAutoFix({
      steps: token,
      workspace,
      userId: 'alice',
      until: 'follow_up',
      skipRecheck: true,
      riskThreshold: 'high',
      saveDefaults: true,
      assumeYes: true
    });
    const paths = createPaths(workspace);
    const userState = loadUserState(paths, 'alice');
    const inherited = await runAutoFix({
      steps: token,
      workspace,
      userId: 'alice',
      dryRun: true
    });
    const cleared = await runAutoFix({
      steps: token,
      workspace,
      userId: 'alice',
      clearDefaults: true,
      assumeYes: true
    });
    const afterClear = loadUserState(paths, 'alice');

    assert.equal(saved.defaults_change, 'saved');
    assert.deepEqual(userState.preferences.auto_fix_defaults, {
      until: 'follow_up',
      skip_recheck: true,
      risk_threshold: 'high'
    });
    assert.equal(inherited.strategy.until, 'follow_up');
    assert.equal(inherited.strategy.skip_recheck, true);
    assert.equal(inherited.strategy.risk_threshold, 'high');
    assert.equal(inherited.total_steps, 2);
    assert.equal(inherited.defaults_source, 'user preferences');
    assert.equal(cleared.defaults_change, 'cleared');
    assert.equal(afterClear.preferences.auto_fix_defaults, undefined);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('remediation summary auto-fix command carries workspace and user context', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'demo',
        action: {
          type: 'sync_legacy_memory',
          command: 'npm run migrate:memory -- --workspace "D:/demo"',
          follow_up_command: 'npm run configure:host -- --workspace "D:/demo" --apply-config',
          recheck_command: 'npm run doctor -- --workspace "D:/demo"',
          repair_strategy: {
            type: 'migrate_then_recheck',
            label: 'migrate -> recheck',
            execution_mode: 'automatic',
            summary: 'Centralize then recheck.'
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.match(summary.next_step.auto_fix_command, /--workspace "D:\/demo"/);
  assert.match(summary.next_step.auto_fix_command, /--user-id "alice"/);
});

test('auto-fix recommends drift flows to stop after follow-up and skip recheck by default', () => {
  const strategy = recommendAutoFixStrategy({
    actionType: 'sync_legacy_memory',
    strategyType: 'migrate_then_enforce_then_recheck',
    hasFollowUp: true,
    hasRecheck: true
  });
  const commandLine = buildAutoFixCommand(
    [
      { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/demo"' },
      { step: 'follow_up', command: 'npm run configure:host -- --workspace "D:/demo" --apply-config --enforce-memory-takeover --yes' },
      { step: 'recheck', command: 'npm run doctor -- --workspace "D:/demo"' }
    ],
    {
      workspace: 'D:/demo',
      userId: 'alice',
      actionType: 'sync_legacy_memory',
      strategyType: 'migrate_then_enforce_then_recheck'
    }
  );

  assert.equal(strategy.until, 'follow_up');
  assert.equal(strategy.skipRecheck, true);
  assert.match(commandLine, /--until follow_up/);
  assert.match(commandLine, /--skip-recheck/);
});

test('auto-fix keeps recheck in host-configuration flows by default', () => {
  const strategy = recommendAutoFixStrategy({
    actionType: 'host_repair',
    strategyType: 'configure_host_then_recheck',
    issues: ['monitor_not_configured'],
    hasFollowUp: false,
    hasRecheck: true
  });
  const commandLine = buildAutoFixCommand(
    [
      { step: 'repair', command: 'npm run configure:host -- --workspace "D:/demo" --apply-config --enable-scheduler --yes' },
      { step: 'recheck', command: 'npm run doctor -- --workspace "D:/demo"' }
    ],
    {
      workspace: 'D:/demo',
      userId: 'alice',
      strategyType: 'configure_host_then_recheck',
      issues: ['monitor_not_configured']
    }
  );

  assert.equal(strategy.until, 'recheck');
  assert.equal(strategy.skipRecheck, false);
  assert.match(commandLine, /--until recheck/);
  assert.doesNotMatch(commandLine, /--skip-recheck/);
});

test('auto-fix treats aggregated registered-workspace drift repair as a drift flow', () => {
  const strategy = recommendAutoFixStrategy({
    actionType: 'repair_registered_workspaces',
    strategyType: 'repair_registered_workspaces_then_recheck',
    issues: ['registered_workspace_drift'],
    hasFollowUp: false,
    hasRecheck: true
  });
  const commandLine = buildAutoFixCommand(
    [
      { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/demo-a"' },
      { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/demo-b"' },
      { step: 'recheck', command: 'npm run doctor -- --workspace "D:/primary"' }
    ],
    {
      workspace: 'D:/primary',
      userId: 'alice',
      actionType: 'repair_registered_workspaces',
      strategyType: 'repair_registered_workspaces_then_recheck',
      issues: ['registered_workspace_drift']
    }
  );

  assert.equal(strategy.until, 'repair');
  assert.equal(strategy.skipRecheck, true);
  assert.equal(strategy.riskThreshold, 'high');
  assert.match(commandLine, /--until repair/);
  assert.match(commandLine, /--skip-recheck/);
});

test('auto-fix treats aggregated sibling-profile drift repair as a drift flow', () => {
  const strategy = recommendAutoFixStrategy({
    actionType: 'repair_profile_family',
    strategyType: 'repair_profile_family_then_recheck',
    issues: ['peer_profile_drift'],
    hasFollowUp: false,
    hasRecheck: true
  });
  const commandLine = buildAutoFixCommand(
    [
      { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/peer-a"' },
      { step: 'repair', command: 'npm run migrate:memory -- --workspace "D:/peer-b"' },
      { step: 'recheck', command: 'npm run doctor -- --openclaw-home "D:/primary-home"' }
    ],
    {
      workspace: 'D:/primary',
      userId: 'alice',
      actionType: 'repair_profile_family',
      strategyType: 'repair_profile_family_then_recheck',
      issues: ['peer_profile_drift']
    }
  );

  assert.equal(strategy.until, 'repair');
  assert.equal(strategy.skipRecheck, true);
  assert.equal(strategy.riskThreshold, 'high');
  assert.match(commandLine, /--until repair/);
  assert.match(commandLine, /--skip-recheck/);
});

test('auto-fix prefers repair-only defaults for workspace configuration recovery flows', () => {
  const strategy = recommendAutoFixStrategy({
    actionType: 'upgrade_verification',
    strategyType: 'configure_sessions_then_recheck',
    issues: ['workspace_needs_configuration'],
    hasRecheck: true
  });
  const commandLine = buildAutoFixCommand(
    [
      { step: 'repair', command: 'npm run configure:sessions -- --workspace "D:/demo" --session-key "s1" --yes' },
      { step: 'recheck', command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "s1"' }
    ],
    {
      workspace: 'D:/demo',
      userId: 'alice',
      actionType: 'upgrade_verification',
      strategyType: 'configure_sessions_then_recheck',
      issues: ['workspace_needs_configuration']
    }
  );

  assert.equal(strategy.until, 'repair');
  assert.equal(strategy.skipRecheck, true);
  assert.equal(strategy.riskThreshold, 'medium');
  assert.match(commandLine, /--until repair/);
  assert.match(commandLine, /--skip-recheck/);
  assert.match(commandLine, /--risk-threshold medium/);
});

test('auto-fix keeps full recheck path for upgraded session materialization failures', () => {
  const strategy = recommendAutoFixStrategy({
    actionType: 'upgrade_verification',
    strategyType: 'repair_sessions_then_recheck',
    issues: ['upgraded_session_not_materialized'],
    hasRecheck: true
  });
  const commandLine = buildAutoFixCommand(
    [
      { step: 'repair', command: 'npm run configure:sessions -- --workspace "D:/demo" --session-key "s1" --yes' },
      { step: 'recheck', command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "s1"' }
    ],
    {
      workspace: 'D:/demo',
      userId: 'alice',
      actionType: 'upgrade_verification',
      strategyType: 'repair_sessions_then_recheck',
      issues: ['upgraded_session_not_materialized']
    }
  );

  assert.equal(strategy.until, 'recheck');
  assert.equal(strategy.skipRecheck, false);
  assert.equal(strategy.riskThreshold, 'high');
  assert.match(commandLine, /--until recheck/);
  assert.doesNotMatch(commandLine, /--skip-recheck/);
});

test('manual external-environment remediation does not expose auto-fix command', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'doctor',
        action: {
          type: 'workspace_review',
          recheck_command: 'npm run doctor -- --workspace "D:/demo"',
          repair_strategy: {
            type: 'review_workspace_then_recheck',
            label: 'review workspace -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'external_environment',
            external_issue_type: 'workspace_registration_missing',
            requires_manual_confirmation: true,
            summary: 'Fix or remove the broken workspace registration, then rerun doctor.'
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.equal(summary.next_step.auto_fix_command, null);
  assert.match(summary.next_step.auto_fix_blocked_reason, /auto-fix is intentionally disabled/i);
});

test('manual confirm-only remediation explains how to resume auto-fix after confirmation', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'doctor',
        action: {
          type: 'workspace_select',
          recheck_command: 'npm run doctor -- --workspace "D:/demo"',
          repair_strategy: {
            type: 'select_workspace_then_recheck',
            label: 'select workspace -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target workspace first, then rerun doctor.'
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.equal(summary.next_step.auto_fix_command, null);
  assert.match(summary.next_step.auto_fix_blocked_reason, /select the target workspace first/i);
  assert.match(summary.next_step.auto_fix_resume_hint, /explicit --workspace/i);
});

test('manual confirm-only remediation can explain missing session-key input', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'sessions',
        action: {
          type: 'session_select',
          recheck_command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun status.',
            command_examples: ['npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"']
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.equal(summary.next_step.auto_fix_command, null);
  assert.match(summary.next_step.auto_fix_blocked_reason, /select the target session first/i);
  assert.match(summary.next_step.auto_fix_resume_hint, /explicit --session-key/i);
  assert.match(summary.next_step.auto_fix_resume_command, /--session-key "<session-key>"/i);
  assert.deepEqual(summary.next_step.auto_fix_resume_missing_inputs, ['session-key']);
  assert.equal(summary.next_step.auto_fix_resume_input_details[0].label, 'session-key');
  assert.match(summary.next_step.auto_fix_resume_input_details[0].description, /session/i);
  assert.ok(summary.next_step.auto_fix_resume_input_details[0].example);
  assert.deepEqual(summary.next_step.auto_fix_resume_input_details[0].candidates, []);
});

test('resume input details can expose candidate suggestions for missing parameters', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'sessions',
        action: {
          type: 'session_select',
          recheck_command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
          resume_context: {
            workspace: 'D:/demo',
            candidateSessionKeys: ['agent:main:checkout-fix', 'agent:main:review']
          },
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun status.',
            command_examples: ['npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"']
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.deepEqual(summary.next_step.auto_fix_resume_input_details[0].candidates, [
    'agent:main:checkout-fix',
    'agent:main:review'
  ]);
});

test('resume guidance can suggest a ready-to-run command when a missing input has a single candidate', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'sessions',
        action: {
          type: 'session_select',
          recheck_command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
          resume_context: {
            workspace: 'D:/demo',
            candidateSessionKeys: ['agent:main:checkout-fix']
          },
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun status.',
            command_examples: ['npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"']
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.match(summary.next_step.auto_fix_resume_suggested_command, /--session-key "agent:main:checkout-fix"/i);
  assert.equal(summary.next_step.auto_fix_resume_suggested_validation_status, 'ready');
  assert.match(summary.next_step.auto_fix_resume_suggested_validation_summary, /已知输入检查通过|可直接重新执行/i);
});

test('resume guidance can suggest a top-ranked command when missing input has multiple candidates', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'sessions',
        action: {
          type: 'session_select',
          recheck_command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
          resume_context: {
            workspace: 'D:/demo',
            candidateSessionKeys: ['agent:main:checkout-fix', 'agent:main:review']
          },
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun status.',
            command_examples: ['npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"']
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.match(summary.next_step.auto_fix_resume_suggested_command, /--session-key "agent:main:checkout-fix"/i);
  assert.equal(summary.next_step.auto_fix_resume_suggested_validation_status, 'needs_review');
  assert.match(summary.next_step.auto_fix_resume_suggested_validation_summary, /排序第一的候选值/);
  assert.match(summary.next_step.auto_fix_resume_suggested_inputs_summary, /session-key=agent:main:checkout-fix/);
  assert.match(summary.next_step.auto_fix_resume_suggested_inputs_summary, /top-ranked candidate/);
});

test('resume guidance prefers candidates from confirmed history when multiple choices exist', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const paths = createPaths(workspace);
      const resumePreferences = recordResumeSelections(paths, 'alice', {
        workspace,
        'session-key': 'agent:main:review'
      });
      const summary = buildRemediationSummary(
        [
          {
            source: 'sessions',
            action: {
              type: 'session_select',
              recheck_command: `npm run status:sessions -- --workspace "${workspace}" --session-key "<session-key>"`,
              resume_context: {
                workspace,
                candidateSessionKeys: ['agent:main:checkout-fix', 'agent:main:review'],
                resumePreferences
              },
              repair_strategy: {
                type: 'select_session_then_recheck',
                label: 'select session -> recheck',
                execution_mode: 'manual',
                manual_subtype: 'confirm_only',
                requires_manual_confirmation: true,
                summary: 'Pick the target session first, then rerun status.',
                command_examples: [`npm run status:sessions -- --workspace "${workspace}" --session-key "<session-key>"`]
              }
            }
          }
        ],
        {
          auto_fix_options: {
            workspace,
            userId: 'alice'
          }
        }
      );

      assert.deepEqual(summary.next_step.auto_fix_resume_input_details[0].candidates, [
        'agent:main:review',
        'agent:main:checkout-fix'
      ]);
      assert.match(summary.next_step.auto_fix_resume_suggested_command, /--session-key "agent:main:review"/i);
      assert.equal(summary.next_step.auto_fix_resume_suggested_validation_status, 'needs_review');
      assert.match(summary.next_step.auto_fix_resume_suggested_validation_summary, /最近确认历史更一致/);
      assert.match(summary.next_step.auto_fix_resume_suggested_inputs_summary, /preferred candidate from confirmed history/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('resume preference history is stored in user metadata instead of injected user preferences', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const paths = createPaths(workspace);
      recordResumeSelections(paths, 'alice', {
        workspace,
        'session-key': 'agent:main:checkout-fix',
        'openclaw-home': path.join(workspace, 'openclaw-home')
      });
      const userState = loadUserState(paths, 'alice');
      const resumePreferences = loadResumePreferences(paths, 'alice');

      assert.equal(userState.preferences.resume_candidate_preferences, undefined);
      assert.equal(
        userState.metadata.resume_candidate_preferences.inputs['session-key'].values['agent:main:checkout-fix'].count,
        1
      );
      assert.ok(resumePreferences.inputs.workspace);
      assert.ok(resumePreferences.inputs['openclaw-home']);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('resume validation summarizes missing inputs when candidates are already available', () => {
  const workspace = makeWorkspace();

  try {
    const summary = buildRemediationSummary(
      [
        {
          source: 'sessions',
          action: {
            type: 'session_select',
            recheck_command: `npm run status:sessions -- --workspace "${workspace}" --session-key "<session-key>"`,
            resume_context: {
              workspace,
              candidateSessionKeys: ['agent:main:checkout-fix', 'agent:main:review']
            },
            repair_strategy: {
              type: 'select_session_then_recheck',
              label: 'select session -> recheck',
              execution_mode: 'manual',
              manual_subtype: 'confirm_only',
              requires_manual_confirmation: true,
              summary: 'Pick the target session first, then rerun status.',
              command_examples: [`npm run status:sessions -- --workspace "${workspace}" --session-key "<session-key>"`]
            }
          }
        }
      ],
      {
        auto_fix_options: {
          workspace,
          userId: 'alice'
        }
      }
    );

    assert.equal(summary.next_step.auto_fix_resume_validation_status, 'needs_input');
    assert.match(summary.next_step.auto_fix_resume_validation_summary, /session-key/i);
    assert.match(summary.next_step.auto_fix_resume_validation_summary, /候选值/);
    assert.equal(summary.next_step.auto_fix_resume_input_details[0].validation_status, 'candidate_available');
    assert.match(summary.next_step.auto_fix_resume_input_details[0].validation_summary, /候选值/);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('resume validation flags prefilled profile paths that no longer exist', () => {
  const workspace = makeWorkspace();
  const missingOpenClawHome = path.join(workspace, 'missing-openclaw-home');
  const missingSkillsRoot = path.join(missingOpenClawHome, 'skills');
  const replacementOpenClawHome = path.join(workspace, 'replacement-openclaw-home');
  const replacementSkillsRoot = path.join(replacementOpenClawHome, 'skills');

  try {
    fs.mkdirSync(replacementSkillsRoot, { recursive: true });
    const summary = buildRemediationSummary(
      [
        {
          source: 'upgrade_verification',
          action: {
            type: 'profile_select',
            recheck_command: 'npm run upgrade:sessions',
            resume_context: {
              workspace,
              openclawHome: missingOpenClawHome,
              skillsRoot: missingSkillsRoot,
              candidateOpenClawHomes: [replacementOpenClawHome],
              candidateSkillsRoots: [replacementSkillsRoot]
            },
            repair_strategy: {
              type: 'select_profile_then_recheck',
              label: 'select profile -> recheck',
              execution_mode: 'manual',
              manual_subtype: 'confirm_only',
              requires_manual_confirmation: true,
              summary: 'Pick the target profile first, then rerun upgrade.',
              command_examples: [
                'npm run upgrade:sessions -- --openclaw-home "<openclaw-home>" --skills-root "<skills-root>"'
              ]
            }
          }
        }
      ],
      {
        auto_fix_options: {
          workspace,
          userId: 'alice'
        }
      }
    );

    const homeDetail = summary.next_step.auto_fix_resume_input_details.find((entry) => entry.label === 'openclaw-home');

    assert.equal(summary.next_step.auto_fix_resume_validation_status, 'needs_attention');
    assert.match(summary.next_step.auto_fix_resume_validation_summary, /openclaw-home/i);
    assert.equal(homeDetail.validation_status, 'path_missing');
    assert.match(homeDetail.validation_summary, /不存在/);
    assert.match(summary.next_step.auto_fix_resume_suggested_command, /--openclaw-home ".*replacement-openclaw-home"/i);
    assert.match(summary.next_step.auto_fix_resume_suggested_command, /--skills-root ".*replacement-openclaw-home[\\\/]skills"/i);
    assert.equal(summary.next_step.auto_fix_resume_suggested_validation_status, 'ready');
    assert.match(summary.next_step.auto_fix_resume_suggested_inputs_summary, /replaces invalid value with an existing path/i);
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('resume command prefers source-matching template when multiple confirm-only commands exist', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'upgrade_verification',
        action: {
          type: 'session_select',
          recheck_command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun upgrade.',
            command_examples: [
              'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
              'npm run configure:sessions -- --workspace "D:/demo" --session-key "<session-key>" --yes',
              'npm run upgrade:sessions -- --workspace "D:/demo" --session-key "<session-key>"'
            ]
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.match(summary.next_step.auto_fix_resume_command, /upgrade:sessions/);
});

test('resume command prefers lower-edit template within the same source context', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'sessions',
        action: {
          type: 'session_select',
          recheck_command: 'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"',
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun status.',
            command_examples: [
              'npm run status:sessions -- --workspace "<workspace>" --session-key "<session-key>" --project-id "<project-id>"',
              'npm run status:sessions -- --workspace "D:/demo" --session-key "<session-key>"'
            ]
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.doesNotMatch(summary.next_step.auto_fix_resume_command, /--project-id/);
  assert.match(summary.next_step.auto_fix_resume_command, /status:sessions/);
});

test('resume command pre-fills known context parameters into templates', () => {
  const summary = buildRemediationSummary(
    [
      {
        source: 'upgrade_verification',
        action: {
          type: 'session_select',
          recheck_command: 'npm run upgrade:sessions -- --workspace "<workspace>" --session-key "<session-key>"',
          resume_context: {
            workspace: 'D:/demo',
            sessionKey: 's1',
            userId: 'alice',
            openclawHome: 'D:/openclaw-home',
            skillsRoot: 'D:/openclaw-home/skills'
          },
          repair_strategy: {
            type: 'select_session_then_recheck',
            label: 'select session -> recheck',
            execution_mode: 'manual',
            manual_subtype: 'confirm_only',
            requires_manual_confirmation: true,
            summary: 'Pick the target session first, then rerun upgrade.',
            command_examples: [
              'npm run upgrade:sessions -- --openclaw-home "<openclaw-home>" --skills-root "<skills-root>" --workspace "<workspace>" --session-key "<session-key>"'
            ]
          }
        }
      }
    ],
    {
      auto_fix_options: {
        workspace: 'D:/demo',
        userId: 'alice'
      }
    }
  );

  assert.match(summary.next_step.auto_fix_resume_command, /--openclaw-home "D:\/openclaw-home"/i);
  assert.match(summary.next_step.auto_fix_resume_command, /--skills-root "D:\/openclaw-home\/skills"/i);
  assert.match(summary.next_step.auto_fix_resume_command, /--workspace "D:\/demo"/i);
  assert.match(summary.next_step.auto_fix_resume_command, /--session-key "s1"/i);
});

test('status report text view shows resume validation guidance for confirm-only remediation', () => {
  const workspace = makeWorkspace();

  try {
    const summary = buildRemediationSummary(
      [
        {
          source: 'sessions',
          action: {
            type: 'session_select',
            recheck_command: `npm run status:sessions -- --workspace "${workspace}" --session-key "<session-key>"`,
            resume_context: {
              workspace,
              candidateSessionKeys: ['agent:main:checkout-fix']
            },
            repair_strategy: {
              type: 'select_session_then_recheck',
              label: 'select session -> recheck',
              execution_mode: 'manual',
              manual_subtype: 'confirm_only',
              requires_manual_confirmation: true,
              summary: 'Pick the target session first, then rerun status.',
              command_examples: [`npm run status:sessions -- --workspace "${workspace}" --session-key "<session-key>"`]
            }
          }
        }
      ],
      {
        auto_fix_options: {
          workspace,
          userId: 'alice'
        }
      }
    );

    const rendered = renderStatusReportText({
      workspace,
      user: { id: 'alice' },
      project: { id: 'demo' },
      session: {
        key: 's1',
        task_state_summary: null,
        task_state_health: null,
        last_benefit_summary: null
      },
      governance: { active: 0, budgeted_out: 0 },
      memory_source_health: { status: 'single_source' },
      remediation_summary: summary,
      recommended_action: {}
    });

    assert.match(rendered, /Resume checks:/);
    assert.match(rendered, /session-key/i);
    assert.match(rendered, /check=/);
    assert.match(rendered, /Suggested resume:/);
    assert.match(rendered, /Suggested inputs:/);
    assert.match(rendered, /Suggested checks:/);
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
      const rendered = renderDoctorReport(doctor);

      assert.equal(doctor.status, 'notice');
      assert.equal(doctor.installation.ready, true);
      assert.equal(doctor.paths.hook_handler, result.hook_handler);
      assert.equal(doctor.paths.monitor_script, result.monitor_script);
      assert.equal(doctor.paths.workspace_monitor_script, result.workspace_monitor_script);
      assert.ok(fs.existsSync(result.doctor_script));
      assert.equal(doctor.configuration.ready, true);
      assert.equal(doctor.configuration.memory_takeover_mode, 'enforced');
      assert.equal(doctor.configuration.memory_takeover_enforced, true);
      assert.ok(!doctor.configuration.missing.includes('memory_takeover_mode'));
      assert.ok(doctor.commands.hook_with_payload_file.includes(result.hook_handler));
      assert.match(doctor.commands.rebuild_mirror, /mirror-rebuild\.js/);
      assert.match(rendered, /Status:/);
      assert.match(rendered, /NOTICE/);

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

test('doctor status summary distinguishes ok, notice, and warning states', () => {
  assert.equal(
    summarizeDoctorRunStatus({
      installation: { ready: true },
      configuration: { ready: true },
      memorySourceHealth: { status: 'single_source' },
      hostTakeoverAudit: { status: 'ok' },
      profileTakeoverAudit: { status: 'ok' }
    }),
    'ok'
  );
  assert.equal(
    summarizeDoctorRunStatus({
      installation: { ready: true },
      configuration: { ready: true },
      memorySourceHealth: { status: 'workspace_required' },
      hostTakeoverAudit: { status: 'notice' },
      profileTakeoverAudit: { status: 'ok' }
    }),
    'notice'
  );
  assert.equal(
    summarizeDoctorRunStatus({
      installation: { ready: true },
      configuration: { ready: true },
      memorySourceHealth: { status: 'drift_detected' },
      hostTakeoverAudit: { status: 'ok' },
      profileTakeoverAudit: { status: 'ok' }
    }),
    'warning'
  );
});

test('configure-host health summary distinguishes ok, notice, and warning states', () => {
  assert.equal(
    summarizeConfigureHostHealthStatus({
      verification: { status: 'verified' },
      takeoverAudit: { status: 'ok' },
      hostTakeoverAudit: { status: 'ok' },
      profileTakeoverAudit: { status: 'ok' },
      memoryTakeover: 'enforced'
    }),
    'ok'
  );
  assert.equal(
    summarizeConfigureHostHealthStatus({
      verification: { status: 'verified' },
      takeoverAudit: { status: 'notice' },
      hostTakeoverAudit: { status: 'ok' },
      profileTakeoverAudit: { status: 'ok' },
      memoryTakeover: 'best_effort'
    }),
    'notice'
  );
  assert.equal(
    summarizeConfigureHostHealthStatus({
      verification: { status: 'needs_attention' },
      takeoverAudit: { status: 'warning' },
      hostTakeoverAudit: { status: 'ok' },
      profileTakeoverAudit: { status: 'ok' },
      memoryTakeover: 'enforced'
    }),
    'warning'
  );
});

test('configure-sessions health summary distinguishes ok, notice, and warning states', () => {
  assert.equal(
    summarizeConfigureSessionsHealthStatus({
      verification: { status: 'verified' },
      doctor: { status: 'ok' }
    }),
    'ok'
  );
  assert.equal(
    summarizeConfigureSessionsHealthStatus({
      verification: { status: 'verified' },
      doctor: { status: 'notice' }
    }),
    'notice'
  );
  assert.equal(
    summarizeConfigureSessionsHealthStatus({
      verification: { status: 'needs_attention' },
      doctor: { status: 'ok' }
    }),
    'warning'
  );
});

test('install health summary distinguishes ok, notice, and warning states', () => {
  assert.equal(
    summarizeInstallHealthStatus({
      verification: { status: 'verified' },
      configuration: { health_status: 'ok', memory_takeover: { mode: 'enforced' }, takeover_audit: { status: 'ok' } },
      sessionUpgrade: { health_status: 'ok', status: 'ok', takeover_audit: { status: 'ok' } }
    }),
    'ok'
  );
  assert.equal(
    summarizeInstallHealthStatus({
      verification: { status: 'verified' },
      configuration: { health_status: 'notice', memory_takeover: { mode: 'best_effort' }, takeover_audit: { status: 'notice' } },
      sessionUpgrade: null
    }),
    'notice'
  );
  assert.equal(
    summarizeInstallHealthStatus({
      verification: { status: 'needs_attention' },
      configuration: { health_status: 'ok', memory_takeover: { mode: 'enforced' }, takeover_audit: { status: 'ok' } },
      sessionUpgrade: { health_status: 'warning', status: 'warning', takeover_audit: { status: 'warning' } }
    }),
    'warning'
  );
});

test('doctor builds remediation summary without crashing when openclaw-home is included in resume context', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: []
      });

      fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'memory', 'model-note.md'), '# Drift\n\nNeeds centralization.', 'utf8');

      const doctor = runDoctor({ openclawHome: openClawHome, workspace });

      assert.equal(doctor.status, 'warning');
      assert.ok(doctor.remediation_summary);
      assert.ok(doctor.remediation_summary.next_step);
      assert.match(doctor.remediation_summary.next_step.recheck_command, /--openclaw-home/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor renders a concise remediation summary view by default', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const missingWorkspace = path.join(workspace, 'missing-workspace');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: missingWorkspace,
            userId: 'default-user',
            projectId: 'missing-project'
          }
        ]
      });

      fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'memory', 'model-note.md'), '# Drift\n\nNeeds centralization.', 'utf8');

      const doctor = runDoctor({ openclawHome: openClawHome, workspace });
      const rendered = renderDoctorReport(doctor);

      assert.match(rendered, /Context-Anchor Doctor/);
      assert.match(rendered, /Remediation:/);
      assert.match(rendered, /External issues:/);
      assert.match(rendered, /Next step:/);
      assert.match(rendered, /Auto fix:/);
      assert.match(rendered, /Auto fix command:/);
      assert.match(rendered, /Guidance:/);
      assert.match(rendered, /Example command:/);
      assert.match(rendered, /Recheck:/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor classifies synchronized external memory as single-source when takeover is enforced', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: workspace,
        addUsers: [],
        addWorkspaces: []
      });

      fs.writeFileSync(
        path.join(workspace, 'MEMORY.md'),
        [
          '## MEM-doctor-sync-1',
          'type: best_practice',
          'heat: 80',
          'Centralize external memory before the next session starts.'
        ].join('\n'),
        'utf8'
      );
      runLegacyMemorySync(workspace, 'doctor-sync', {
        projectId: 'demo',
        reason: 'test'
      });

      const doctor = runDoctor({ openclawHome: openClawHome, workspace });

      assert.equal(doctor.status, 'ok');
      assert.equal(doctor.memory_sources.external_source_count, 1);
      assert.equal(doctor.memory_sources.sync_status, 'centralized');
      assert.equal(doctor.memory_sources.health.status, 'single_source');
      assert.equal(doctor.memory_sources.recommended_action.type, 'none');
      assert.match(doctor.memory_sources.recommended_action.recheck_command, /npm run doctor/);
      assert.equal(Array.isArray(doctor.memory_sources.recommended_action.repair_sequence), true);
      assert.equal(doctor.memory_sources.recommended_action.repair_strategy.type, 'recheck_only');
      assert.equal(doctor.memory_sources.recommended_action.repair_strategy.execution_mode, 'automatic');
      assert.ok(doctor.remediation_summary);
      assert.ok(typeof doctor.remediation_summary.automatic_count === 'number');
      assert.equal(doctor.memory_sources.last_legacy_sync_at !== null, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor host audit flags drift in another registered workspace', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const secondaryWorkspace = path.join(workspace, 'secondary-project');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(primaryWorkspace, { recursive: true });
      fs.mkdirSync(secondaryWorkspace, { recursive: true });
      fs.writeFileSync(
        path.join(secondaryWorkspace, 'MEMORY.md'),
        [
          '## MEM-host-doctor-1',
          'type: best_practice',
          'heat: 82',
          'Another registered workspace still drifts outside the canonical memory plane.'
        ].join('\n'),
        'utf8'
      );

      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: secondaryWorkspace,
            userId: 'default-user',
            projectId: 'secondary-project'
          }
        ]
      });

      const doctor = runDoctor({ openclawHome: openClawHome, workspace: primaryWorkspace });
      const driftWorkspace = doctor.host_takeover_audit.workspaces.find(
        (entry) => path.resolve(entry.workspace) === path.resolve(secondaryWorkspace)
      );

      assert.equal(doctor.memory_sources.health.status, 'single_source');
      assert.equal(doctor.host_takeover_audit.status, 'warning');
      assert.equal(doctor.host_takeover_audit.total_registered_workspaces, 2);
      assert.equal(doctor.host_takeover_audit.single_source_workspaces, 1);
      assert.equal(doctor.host_takeover_audit.drift_workspaces, 1);
      assert.equal(driftWorkspace.health.status, 'drift_detected');
      assert.match(doctor.host_takeover_audit.summary, /1 workspace\(s\) have external memory drift/);
      assert.match(doctor.host_takeover_audit.recommended_action.recheck_command, /npm run doctor/);
      assert.equal(doctor.host_takeover_audit.recommended_action.repair_sequence.at(-1).step, 'recheck');
      assert.equal(doctor.host_takeover_audit.recommended_action.repair_strategy.type, 'migrate_then_recheck');
      assert.equal(doctor.host_takeover_audit.recommended_action.repair_strategy.execution_mode, 'automatic');
      assert.ok(doctor.remediation_summary.manual_count >= 0);
      assert.ok(typeof doctor.remediation_summary.manual_external_environment_count === 'number');
      assert.ok(typeof doctor.remediation_summary.manual_external_issue_types === 'object');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor host audit aggregates repair steps across multiple drift workspaces', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const secondaryWorkspaceA = path.join(workspace, 'secondary-project-a');
  const secondaryWorkspaceB = path.join(workspace, 'secondary-project-b');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(primaryWorkspace, { recursive: true });
      fs.mkdirSync(secondaryWorkspaceA, { recursive: true });
      fs.mkdirSync(secondaryWorkspaceB, { recursive: true });
      fs.writeFileSync(
        path.join(secondaryWorkspaceA, 'MEMORY.md'),
        [
          '## MEM-host-aggregate-1',
          'type: best_practice',
          'heat: 82',
          'Secondary workspace A still drifts outside the canonical memory plane.'
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        path.join(secondaryWorkspaceB, 'MEMORY.md'),
        [
          '## MEM-host-aggregate-2',
          'type: best_practice',
          'heat: 84',
          'Secondary workspace B still drifts outside the canonical memory plane.'
        ].join('\n'),
        'utf8'
      );

      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: [
          {
            workspace: secondaryWorkspaceA,
            userId: 'default-user',
            projectId: 'secondary-project-a'
          },
          {
            workspace: secondaryWorkspaceB,
            userId: 'default-user',
            projectId: 'secondary-project-b'
          }
        ]
      });

      const doctor = runDoctor({ openclawHome: openClawHome, workspace: primaryWorkspace });
      const rendered = renderDoctorReport(doctor);
      const repairSequence = doctor.host_takeover_audit.recommended_action.repair_sequence || [];

      assert.equal(doctor.host_takeover_audit.status, 'warning');
      assert.equal(doctor.host_takeover_audit.drift_workspaces, 2);
      assert.equal(doctor.host_takeover_audit.recommended_action.repair_strategy.type, 'repair_registered_workspaces_then_recheck');
      assert.deepEqual(doctor.remediation_summary.next_step.affected_targets, [secondaryWorkspaceA, secondaryWorkspaceB]);
      assert.ok(repairSequence.some((entry) => String(entry.command).includes(secondaryWorkspaceA)));
      assert.ok(repairSequence.some((entry) => String(entry.command).includes(secondaryWorkspaceB)));
      assert.equal(repairSequence.at(-1).step, 'recheck');
      assert.match(rendered, /Affected targets:/);
      assert.match(rendered, /secondary-project-a/);
      assert.match(rendered, /secondary-project-b/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor profile audit flags drift in a sibling OpenClaw profile', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const peerOpenClawHome = path.join(workspace, 'openclaw-home-peer');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const peerWorkspace = path.join(workspace, 'peer-project');

  try {
    await withOpenClawHome(workspace, async () => {
      fs.mkdirSync(primaryWorkspace, { recursive: true });
      fs.mkdirSync(peerWorkspace, { recursive: true });

      runInstallHostAssets(peerOpenClawHome);
      fs.writeFileSync(
        path.join(peerWorkspace, 'MEMORY.md'),
        [
          '## MEM-profile-doctor-1',
          'type: best_practice',
          'heat: 83',
          'A sibling profile still has external memory drift.'
        ].join('\n'),
        'utf8'
      );
      await runConfigureHost(peerOpenClawHome, path.join(peerOpenClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: peerWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      const doctor = runDoctor({ openclawHome: openClawHome, workspace: primaryWorkspace });
      const peerProfile = doctor.profile_takeover_audit.profiles.find(
        (entry) => path.resolve(entry.openclaw_home) === path.resolve(peerOpenClawHome)
      );

      assert.equal(doctor.profile_takeover_audit.status, 'warning');
      assert.equal(doctor.profile_takeover_audit.total_profiles, 2);
      assert.equal(doctor.profile_takeover_audit.drift_profiles, 1);
      assert.equal(doctor.profile_takeover_audit.warning_profiles, 1);
      assert.equal(peerProfile.host_takeover_audit.drift_workspaces, 1);
      assert.match(doctor.profile_takeover_audit.summary, /1 profile\(s\) need attention/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('doctor profile audit aggregates repair steps across multiple sibling profiles', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const peerOpenClawHomeA = path.join(workspace, 'openclaw-home-peer-a');
  const peerOpenClawHomeB = path.join(workspace, 'openclaw-home-peer-b');
  const primaryWorkspace = path.join(workspace, 'primary-project');
  const peerWorkspaceA = path.join(workspace, 'peer-project-a');
  const peerWorkspaceB = path.join(workspace, 'peer-project-b');

  try {
    await withOpenClawHome(workspace, async () => {
      fs.mkdirSync(primaryWorkspace, { recursive: true });
      fs.mkdirSync(peerWorkspaceA, { recursive: true });
      fs.mkdirSync(peerWorkspaceB, { recursive: true });

      runInstallHostAssets(peerOpenClawHomeA);
      fs.writeFileSync(
        path.join(peerWorkspaceA, 'MEMORY.md'),
        [
          '## MEM-profile-aggregate-1',
          'type: best_practice',
          'heat: 83',
          'Peer profile A still has external memory drift.'
        ].join('\n'),
        'utf8'
      );
      await runConfigureHost(peerOpenClawHomeA, path.join(peerOpenClawHomeA, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: peerWorkspaceA,
        addUsers: [],
        addWorkspaces: []
      });

      runInstallHostAssets(peerOpenClawHomeB);
      fs.writeFileSync(
        path.join(peerWorkspaceB, 'MEMORY.md'),
        [
          '## MEM-profile-aggregate-2',
          'type: best_practice',
          'heat: 85',
          'Peer profile B still has external memory drift.'
        ].join('\n'),
        'utf8'
      );
      await runConfigureHost(peerOpenClawHomeB, path.join(peerOpenClawHomeB, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: peerWorkspaceB,
        addUsers: [],
        addWorkspaces: []
      });

      runInstallHostAssets(openClawHome);
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: primaryWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      const doctor = runDoctor({ openclawHome: openClawHome, workspace: primaryWorkspace });
      const rendered = renderDoctorReport(doctor);
      const repairSequence = doctor.profile_takeover_audit.recommended_action.repair_sequence || [];

      assert.equal(doctor.profile_takeover_audit.status, 'warning');
      assert.equal(doctor.profile_takeover_audit.drift_profiles, 2);
      assert.equal(doctor.profile_takeover_audit.recommended_action.repair_strategy.type, 'repair_profile_family_then_recheck');
      assert.deepEqual(doctor.remediation_summary.next_step.affected_targets, [path.resolve(peerOpenClawHomeA), path.resolve(peerOpenClawHomeB)]);
      assert.ok(repairSequence.some((entry) => String(entry.command).includes(peerWorkspaceA)));
      assert.ok(repairSequence.some((entry) => String(entry.command).includes(peerWorkspaceB)));
      assert.equal(repairSequence.at(-1).step, 'recheck');
      assert.match(rendered, /Affected targets:/);
      assert.match(rendered, /openclaw-home-peer-a/);
      assert.match(rendered, /openclaw-home-peer-b/);
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

test('workspace monitor centralizes external memory during idle periods without re-sync noise', async () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');
  const monitoredWorkspace = path.join(workspace, 'idle-sync-workspace');

  try {
    await withOpenClawHome(workspace, async () => {
      runInstallHostAssets(openClawHome);
      fs.mkdirSync(monitoredWorkspace, { recursive: true });
      await runConfigureHost(openClawHome, path.join(openClawHome, 'skills'), {
        applyConfig: true,
        enableScheduler: false,
        defaultUserId: 'default-user',
        defaultWorkspace: monitoredWorkspace,
        addUsers: [],
        addWorkspaces: []
      });

      fs.mkdirSync(path.join(monitoredWorkspace, 'memory'), { recursive: true });
      fs.writeFileSync(
        path.join(monitoredWorkspace, 'memory', 'model-note.md'),
        '# External Memory\n\nIdle workspace monitor should still centralize this file.',
        'utf8'
      );

      const first = runWorkspaceMonitor(monitoredWorkspace, {
        windowMs: -1
      });
      const second = runWorkspaceMonitor(monitoredWorkspace, {
        windowMs: -1
      });
      const facts = readJson(
        path.join(monitoredWorkspace, '.context-anchor', 'projects', path.basename(monitoredWorkspace), 'facts.json'),
        { facts: [] }
      ).facts;

      assert.equal(first.status, 'idle');
      assert.equal(first.legacy_memory_sync.synced_entries, 1);
      assert.equal(first.memory_sources.external_source_count, 1);
      assert.equal(second.status, 'idle');
      assert.equal(second.legacy_memory_sync.synced_entries, 0);
      assert.equal(second.legacy_memory_sync.skipped_files, 1);
      assert.equal(facts.length, 1);
      assert.match(facts[0].content, /centralize this file/);
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
      syncRuntimeStateFixture(workspace, 'tight-budget-source', 'demo');

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
      assert.match(bootstrap, /Current Task State|task:/i);
      assert.match(bootstrap, /Long-Term Memory/);
      assert.match(bootstrap, /\+\d+ more/);
      assert.match(bootstrap, /lookup:/i);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('bootstrap cache prefers compact profile under the default budget to protect context headroom', () => {
  const summary = {
    session: {
      key: 'default-budget-session',
      project: 'demo',
      user: 'default-user',
      restored: true,
      continued_from: 'older-session'
    },
    recovery: {
      active_task: 'stabilize checkout retries with a very long task description that should stay compact',
      pending_commitments: [
        { what: 'ship retry fix', when: null }
      ],
      checkpoint_excerpt: '- line one\n- line two\n- line three\n- line four\n- line five',
      task_state_summary: {
        visible: true,
        current_goal: 'stabilize checkout retries',
        latest_verified_result: 'validated retry direction',
        next_step: 'ship retry fix',
        blocked_by: null,
        last_user_visible_progress: 'captured retry constraints'
      },
      continuity_summary: {
        visible: true,
        source_session_key: 'older-session',
        restored_goal: 'stabilize checkout retries',
        latest_result: 'validated retry direction',
        next_step: 'ship retry fix',
        blocked_by: null,
        last_user_visible_progress: 'captured retry constraints',
        recovered_assets: {
          summary: true,
          compact_packet: true,
          checkpoint: true
        }
      }
    },
    memories_to_inject: [
      {
        source: 'short_term_hot_memories',
        entries: Array.from({ length: 4 }, (_, index) => ({
          source: 'current_session',
          type: 'best_practice',
          heat: 95 - index,
          summary: `hot memory ${index} checkout retry stabilization details`
        }))
      }
    ],
    effective_skills: Array.from({ length: 4 }, (_, index) => ({
      scope: 'project',
      name: `skill-${index}`
    })),
    recommended_reuse: {
      experiences: Array.from({ length: 3 }, (_, index) => ({
        scope: 'project',
        summary: `experience ${index} for retry stabilization`,
        reasons: ['context_overlap']
      })),
      skills: Array.from({ length: 3 }, (_, index) => ({
        scope: 'project',
        name: `reuse-skill-${index}`,
        reasons: ['active_skill_fallback']
      }))
    },
    persistent_memory: {
      catalogs: Array.from({ length: 5 }, (_, index) => ({
        tier: 'warm',
        scope: 'project',
        source: `catalog-${index}`,
        count: 12 + index,
        hot_count: 2,
        validated_count: 1
      }))
    },
    related_sessions: Array.from({ length: 3 }, (_, index) => ({
      session_key: `related-${index}`,
      project_id: 'demo'
    }))
  };

  const bootstrap = buildBootstrapCacheContent(summary);

  assert.ok(Buffer.byteLength(bootstrap, 'utf8') <= 6000);
  assert.doesNotMatch(bootstrap, /\+2 more items/);
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
      syncRuntimeStateFixture(workspace, 'previous-session', 'demo');

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

      const previousRuntimeFile = runtimeStateFile(createPaths(workspace), 'previous-session');
      const previousRuntime = readJson(previousRuntimeFile, {});
      previousRuntime.current_goal = 'stabilize checkout pipeline';
      previousRuntime.latest_verified_result = 'Validated checkout retry playbook and promoted 1 project skill.';
      previousRuntime.next_step = 'ship checkout retry fix';
      previousRuntime.blocked_by = 'waiting for CI rerun';
      previousRuntime.last_user_visible_progress = 'checkout retry playbook drafted';
      writeJson(previousRuntimeFile, previousRuntime);

      const result = runSessionStart(workspace, 'continued-session', 'demo');

      assert.equal(result.session.continued_from, 'previous-session');
      assert.equal(result.recovery.active_task, 'stabilize checkout pipeline');
      assert.equal(result.recovery.pending_commitments.length, 1);
      assert.equal(result.recovery.continuity.source_session_key, 'previous-session');
      assert.equal(result.recovery.continuity_summary.source_session_key, 'previous-session');
      assert.equal(result.recovery.continuity_summary.restored_goal, 'stabilize checkout pipeline');
      assert.equal(result.recovery.continuity_summary.next_step, 'ship checkout retry fix');
      assert.equal(result.recovery.continuity_summary.latest_result, 'Validated checkout retry playbook and promoted 1 project skill.');
      assert.equal(result.recovery.continuity_summary.blocked_by, 'waiting for CI rerun');
      assert.equal(result.recovery.continuity_summary.last_user_visible_progress, 'checkout retry playbook drafted');
      assert.ok(result.recommended_reuse.experiences.some((entry) => entry.summary.includes('checkout pipeline')));
      assert.ok(result.recommended_reuse.skills.some((entry) => entry.scope === 'project'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start does not carry forward stale active task from a closed session without pending commitments', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'finished-session', 'demo');
      runMemorySave(
        workspace,
        'finished-session',
        'session',
        'best_practice',
        'Finalize sqlite mirror rollout',
        JSON.stringify({
          heat: 94
        })
      );

      const stateFile = path.join(
        workspace,
        '.context-anchor',
        'sessions',
        'finished-session',
        'state.json'
      );
      const finishedState = readJson(stateFile, {});
      finishedState.active_task = 'stale task from older round';
      finishedState.commitments = [];
      writeJson(stateFile, finishedState);
      syncRuntimeStateFixture(workspace, 'finished-session', 'demo');

      runSessionClose(workspace, 'finished-session', {
        reason: 'command-reset'
      });

      const previousRuntimeFile = runtimeStateFile(createPaths(workspace), 'finished-session');
      const previousRuntime = readJson(previousRuntimeFile, {});
      previousRuntime.current_goal = 'stale task from older round';
      previousRuntime.latest_verified_result = 'completed sqlite mirror rollout';
      previousRuntime.next_step = null;
      previousRuntime.blocked_by = null;
      previousRuntime.last_user_visible_progress = 'completed sqlite mirror rollout';
      writeJson(previousRuntimeFile, previousRuntime);

      const result = runSessionStart(workspace, 'next-session', 'demo');

      assert.equal(result.session.continued_from, 'finished-session');
      assert.equal(result.recovery.active_task, null);
      assert.equal(result.recovery.pending_commitments.length, 0);
      assert.equal(result.recovery.continuity.inherited_active_task, false);
      assert.equal(result.recovery.continuity.reference_only, true);
      assert.equal(result.recovery.continuity_summary.mode, 'completed_reference');
      assert.equal(result.recovery.continuity_summary.restored_goal, null);
      assert.equal(result.recovery.continuity_summary.next_step, null);
      assert.equal(result.recovery.continuity_summary.latest_result, 'completed sqlite mirror rollout');
      assert.equal(result.recovery.task_state_summary.current_goal, null);
      assert.equal(result.recovery.task_state_summary.next_step, null);

      const bootstrap = buildBootstrapCacheContent(result);
      assert.match(bootstrap, /state: completed task kept as reference-only continuity/i);
      assert.match(bootstrap, /restore: no active goal or next step was carried forward/i);
      assert.doesNotMatch(bootstrap, /- progress: completed sqlite mirror rollout/i);
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
      assert.equal(result.results[0].tier, 'active');
      assert.equal(result.results[0].from_archive, false);
      assert.equal(result.results[0].retrieval_cost, 'active_lookup');
      assert.match(result.results[0].summary, /retry budget/);
      assert.ok(result.results[0].why_matched.matched_terms.includes('checkout'));
      assert.ok(result.results[0].why_matched.matched_fields.includes('summary'));
      assert.equal(result.results[0].why_from_archive, null);
      assert.ok(result.results.some((entry) => entry.source === 'project_facts'));
      assert.ok(result.scope_summary.project_experiences.count >= 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('memory-search falls back to archive when active has no matching hits', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'archive-lookup', 'demo');
      const paths = createPaths(workspace);
      writeJson(projectExperiencesArchiveFile(paths, 'demo'), {
        experiences: [
          makeGovernanceEntry('archive-search', 1, {
            type: 'best_practice',
            summary: 'Recover archived checkout policy',
            details: 'Use archive fallback when the active layer has no checkout evidence.',
            project_id: 'demo',
            session_key: 'archive-lookup',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget',
            validation: { status: 'validated' }
          })
        ]
      });
      runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));

      const result = runMemorySearch(workspace, 'archive-lookup', 'archived checkout policy');

      assert.equal(result.status, 'ok');
      assert.ok(result.returned > 0);
      assert.equal(result.results[0].source, 'project_experiences');
      assert.equal(result.results[0].tier, 'archive');
      assert.equal(result.results[0].from_archive, true);
      assert.equal(result.results[0].retrieval_cost, 'archive_lookup');
      assert.match(result.results[0].why_from_archive.summary, /archive fallback/);
      assert.ok(typeof result.results[0].why_matched.summary === 'string');
      assert.ok(result.scope_summary.project_experiences_archive.count >= 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('memory-search prefers active hits over archive hits for the same query', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'mixed-lookup', 'demo');
      runMemorySave(
        workspace,
        'mixed-lookup',
        'project',
        'best_practice',
        'Use active retries before the archived fallback playbook',
        JSON.stringify({
          summary: 'Active checkout policy',
          heat: 70,
          validation_status: 'validated'
        })
      );
      const paths = createPaths(workspace);
      writeJson(projectExperiencesArchiveFile(paths, 'demo'), {
        experiences: [
          makeGovernanceEntry('archive-priority', 1, {
            type: 'best_practice',
            summary: 'Archived checkout policy',
            details: 'Archived fallback playbook for checkout retries.',
            project_id: 'demo',
            session_key: 'mixed-lookup',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget',
            validation: { status: 'validated' }
          })
        ]
      });
      runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));

      const result = runMemorySearch(workspace, 'mixed-lookup', 'checkout policy');

      assert.equal(result.status, 'ok');
      assert.ok(result.returned >= 2);
      assert.equal(result.results[0].tier, 'active');
      assert.equal(result.results[0].from_archive, false);
      assert.equal(result.results[0].why_from_archive, null);
      assert.ok(result.results.some((entry) => entry.tier === 'archive'));
      assert.ok(result.results.find((entry) => entry.tier === 'archive').why_from_archive);
      assert.deepEqual(result.tiers_searched, ['active', 'archive']);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('archive content stays out of bootstrap while remaining retrievable on demand', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'bootstrap-archive-source', 'demo');
      const paths = createPaths(workspace);
      writeJson(projectExperiencesArchiveFile(paths, 'demo'), {
        experiences: [
          makeGovernanceEntry('bootstrap-archive', 1, {
            type: 'best_practice',
            summary: 'Archived deployment rollback note',
            details: 'ARCHIVE ONLY rollback detail should never be preloaded into bootstrap content.',
            project_id: 'demo',
            session_key: 'bootstrap-archive-source',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget',
            validation: { status: 'validated' }
          })
        ]
      });
      runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));

      const summary = runSessionStart(workspace, 'bootstrap-archive-target', 'demo');
      const bootstrap = buildBootstrapCacheContent(summary);
      const lookup = runMemorySearch(workspace, 'bootstrap-archive-target', 'deployment rollback note');

      assert.doesNotMatch(bootstrap, /ARCHIVE ONLY rollback detail/);
      assert.equal(lookup.results[0].tier, 'archive');
      assert.equal(lookup.results[0].from_archive, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('archive items are searchable through the sqlite mirror FTS path', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'archive-fts', 'demo');
      const paths = createPaths(workspace);
      writeJson(projectExperiencesArchiveFile(paths, 'demo'), {
        experiences: [
          makeGovernanceEntry('archive-fts', 1, {
            type: 'best_practice',
            summary: 'Mirror archive retrieval playbook',
            details: 'Mirror FTS archive search should find this retrieval playbook.',
            project_id: 'demo',
            session_key: 'archive-fts',
            archived: true,
            archived_at: '2026-04-01T00:00:00.000Z',
            archive_reason: 'retention_budget',
            validation: { status: 'validated' }
          })
        ]
      });
      runMirrorRebuild(workspace, path.join(workspace, 'openclaw-home'));

      const descriptor = describeCollectionFile(projectExperiencesArchiveFile(paths, 'demo'), 'experiences');
      const rows = searchCatalogItems(
        descriptor.dbFile,
        [
          {
            scope: 'project',
            ownerId: 'demo',
            source: 'project_experiences_archive',
            archived: true
          }
        ],
        'retrieval playbook',
        5
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'project_experiences_archive');
      assert.equal(rows[0].archived, 1);
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
      syncRuntimeStateFixture(workspace, 'handoff-source', 'demo');
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
      syncRuntimeStateFixture(workspace, 'bootstrap-source', 'demo');

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
      assert.equal(event.context.bootstrapFiles[0].name, 'CONTEXT-ANCHOR.md');
      assert.match(event.context.bootstrapFiles[0].content, /Continued from: bootstrap-source/);
      assert.match(event.context.bootstrapFiles[0].content, /## Current Task State/);
      assert.match(event.context.bootstrapFiles[0].content, /## Recovered Continuity/);
      assert.ok(
        event.context.bootstrapFiles[0].content.indexOf('## Current Task State') <
          event.context.bootstrapFiles[0].content.indexOf('## Recovered Continuity')
      );
      assert.match(event.context.bootstrapFiles[0].content, /latest result:/);
      assert.match(event.context.bootstrapFiles[0].content, /next step: repair checkout retries/);
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
      assert.equal(Object.prototype.hasOwnProperty.call(beforeResult.result.heartbeat, 'flow'), false);
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
      const bootstrapContent = fs.readFileSync(
        path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'openclaw-bootstrap.md'),
        'utf8'
      );

      assert.equal(afterResult.status, 'handled');
      assert.equal(afterResult.result.phase, 'after');
      assert.equal(afterResult.result.skill_draft.status, 'created');
      assert.equal(Object.prototype.hasOwnProperty.call(afterResult.result, 'runtime_state'), false);
      assert.ok(
        fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'compact-hook', 'compact-packet.json'))
      );
      assert.equal(sessionSkills.length, 1);
      assert.equal(sessionSkills[0].status, 'draft');
      assert.equal(sessionSkills[0].summary, 'refresh checkout retries before compaction');
      assert.equal(sessionState.metadata.last_compaction_event, 'after');
      assert.equal(sessionState.metadata.compaction_compacted_count, 30);
      assert.ok(Buffer.byteLength(bootstrapContent, 'utf8') <= 2201);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('bootstrap stays lean after compact when a new OpenClaw session id resumes the same managed session', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'compact-lean-bootstrap', 'demo', {
        openClawSessionId: 'openclaw-compact-original'
      });
      runMemorySave(
        workspace,
        'compact-lean-bootstrap',
        'session',
        'best_practice',
        'refresh checkout retries before compaction',
        JSON.stringify({ heat: 96, details: 'compact lifecycle accumulation' })
      );

      handleManagedHookEvent({
        type: 'session',
        action: 'compact:before',
        sessionKey: 'compact-lean-bootstrap',
        context: {
          sessionId: 'openclaw-compact-original',
          tokenCount: 3200
        }
      });
      handleManagedHookEvent({
        type: 'session',
        action: 'compact:after',
        sessionKey: 'compact-lean-bootstrap',
        context: {
          sessionId: 'openclaw-compact-original',
          tokenCount: 900,
          compactedCount: 30
        }
      });

      const event = {
        type: 'agent',
        action: 'bootstrap',
        sessionKey: 'compact-lean-bootstrap',
        context: {
          sessionId: 'openclaw-compact-new',
          sessionKey: 'compact-lean-bootstrap',
          workspaceDir: workspace,
          bootstrapFiles: []
        }
      };
      const result = handleManagedHookEvent(event);
      const content = event.context.bootstrapFiles[0].content;

      assert.equal(result.status, 'handled');
      assert.equal(event.context.bootstrapFiles.length, 1);
      assert.ok(Buffer.byteLength(content, 'utf8') <= 2201);
      assert.doesNotMatch(content, /## Suggested Reuse/);
      assert.doesNotMatch(content, /## Related Sessions/);
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
      assert.equal(result.captured_summary.visible, true);
      assert.ok(result.captured_summary.summary_lines.some((line) => line.includes('captured 1 new lesson')));
      assert.ok(summaryMirror.data.benefit_summary);
      assert.ok(summaryMirror.data.benefit_summary.summary_lines.some((line) => line.includes('updated draft')));
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
      const next = runSessionStart(workspace, 'hook-close-next', 'demo');

      assert.equal(result.status, 'handled');
      assert.equal(result.result.status, 'closed');
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'hook-close', 'session-summary.json')));
      assert.equal(next.session.continued_from, 'hook-close');
      assert.equal(next.recovery.active_task, null);
      assert.equal(next.recovery.pending_commitments.length, 0);
      assert.equal(next.recovery.continuity.reference_only, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('command new hook closes through unified lifecycle but preserves unfinished task continuity', async () => {
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

      runSessionStart(workspace, 'hook-new', 'demo');
      const stateFile = path.join(workspace, '.context-anchor', 'sessions', 'hook-new', 'state.json');
      const state = readJson(stateFile, {});
      state.active_task = 'continue checkout stabilization';
      state.commitments = [
        {
          id: 'hook-new-1',
          what: 'finish checkout stabilization',
          status: 'pending'
        }
      ];
      writeJson(stateFile, state);

      const result = handleHookEvent('command:new', {
        workspace,
        session_key: 'hook-new',
        project_id: 'demo'
      });
      const next = runSessionStart(workspace, 'hook-new-next', 'demo');

      assert.equal(result.status, 'handled');
      assert.equal(result.result.status, 'closed');
      assert.equal(result.result.task_state_transition.mode, 'retained');
      assert.equal(next.session.continued_from, 'hook-new');
      assert.equal(next.recovery.active_task, 'continue checkout stabilization');
      assert.equal(next.recovery.pending_commitments.length, 1);
      assert.equal(next.recovery.continuity.reference_only, false);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('command reset hook closes through unified lifecycle but preserves unfinished task continuity', async () => {
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

      runSessionStart(workspace, 'hook-reset', 'demo');
      const stateFile = path.join(workspace, '.context-anchor', 'sessions', 'hook-reset', 'state.json');
      const state = readJson(stateFile, {});
      state.active_task = 'reproduce checkout bug';
      state.commitments = [
        {
          id: 'hook-reset-1',
          what: 'capture clean repro',
          status: 'pending'
        }
      ];
      writeJson(stateFile, state);

      const result = handleHookEvent('command:reset', {
        workspace,
        session_key: 'hook-reset',
        project_id: 'demo'
      });
      const next = runSessionStart(workspace, 'hook-reset-next', 'demo');

      assert.equal(result.status, 'handled');
      assert.equal(result.result.status, 'closed');
      assert.equal(result.result.task_state_transition.mode, 'retained');
      assert.equal(next.session.continued_from, 'hook-reset');
      assert.equal(next.recovery.active_task, 'reproduce checkout bug');
      assert.equal(next.recovery.pending_commitments.length, 1);
      assert.equal(next.recovery.continuity.reference_only, false);
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
      assert.equal(result.captured_summary.visible, true);
      assert.ok(result.captured_summary.summary_lines.some((line) => line.includes('promoted 1 project skill')));
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
      assert.ok(result.captured_summary.summary_lines.some((line) => line.includes('promoted 1 user skill')));
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
      const paths = createPaths(workspace);
      const stateFile = sessionStateFile(paths, 'report-session');
      const state = readJson(stateFile, {});
      state.active_task = 'stabilize checkout retries';
      state.commitments = [
        {
          id: 'report-1',
          what: 'ship checkout retry fix',
          status: 'pending'
        }
      ];
      state.metadata = {
        ...(state.metadata || {}),
        blocked_by: 'waiting for CI rerun'
      };
      writeJson(stateFile, state);
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
      assert.equal(report.session.active_task, 'stabilize checkout retries');
      assert.equal(report.session.task_state_summary.current_goal, 'stabilize checkout retries');
      assert.equal(report.session.task_state_summary.next_step, 'ship checkout retry fix');
      assert.equal(report.session.task_state_summary.blocked_by, 'waiting for CI rerun');
      assert.equal(report.session.last_benefit_summary.visible, true);
      assert.ok(report.session.last_benefit_summary.summary_lines.some((line) => line.includes('captured 1 new lesson')));
      assert.ok(typeof report.governance.active === 'number');
      assert.ok(report.storage_governance.active_item_count >= 3);
      assert.ok(typeof report.storage_governance.archive_item_count === 'number');
      assert.equal(report.storage_governance.last_run.reason, 'session-end');
      assert.ok(typeof report.storage_governance.last_run.bytes_before === 'number');
      assert.ok(typeof report.storage_governance.last_run.bytes_after === 'number');
      assert.ok(typeof report.storage_governance.last_run.prune_count === 'number');
      assert.equal(report.external_sources.external_source_count, 0);
      assert.equal(report.memory_source_health.status, 'best_effort');
      assert.equal(report.recommended_action.type, 'enforce_memory_takeover');
      assert.match(report.recommended_action.command, /configure:host/);
      assert.ok(report.recommended_action.resolution_hint);
      assert.ok(Array.isArray(report.recommended_action.command_examples));
      assert.ok(report.remediation_summary);
      assert.equal(report.remediation_summary.status, 'automatic_available');
      assert.ok(report.evidence.project_skills);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report renders a concise remediation-aware text view', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'text-report-session', 'demo');
      const paths = createPaths(workspace);
      const stateFile = sessionStateFile(paths, 'text-report-session');
      const state = readJson(stateFile, {});
      state.active_task = 'stabilize checkout retries';
      writeJson(stateFile, state);

      const report = runStatusReport(workspace, 'text-report-session', 'demo', 'default-user');
      const rendered = renderStatusReportText(report);

      assert.match(rendered, /Context-Anchor Status Report/);
      assert.match(rendered, /Memory health:/);
      assert.match(rendered, /Next step:/);
      assert.match(rendered, /Auto fix:/);
      assert.match(rendered, /Auto fix command:/);
      assert.match(rendered, /Guidance:/);
      assert.match(rendered, /Example command:/);
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
