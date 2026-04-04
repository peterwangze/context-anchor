#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runLegacyMemorySync, summarizeExternalMemorySources } = require('./legacy-memory-sync');

const DEFAULT_DEBOUNCE_MS = 800;

function parseArgs(argv) {
  const options = {
    workspace: null,
    sessionKey: 'external-memory-watch',
    projectId: null,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    durationMs: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--session-key') {
      options.sessionKey = argv[index + 1] || options.sessionKey;
      index += 1;
      continue;
    }

    if (arg === '--project-id') {
      options.projectId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--debounce-ms') {
      options.debounceMs = Number(argv[index + 1] || DEFAULT_DEBOUNCE_MS);
      index += 1;
      continue;
    }

    if (arg === '--duration-ms') {
      options.durationMs = Number(argv[index + 1] || 0);
      index += 1;
      continue;
    }
  }

  if (!options.workspace && argv[0] && !String(argv[0]).startsWith('--')) {
    options.workspace = argv[0];
  }

  return options;
}

function shouldReactToWorkspaceEvent(fileName) {
  const normalized = String(fileName || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) {
    return true;
  }

  return (
    normalized === 'memory.md' ||
    normalized === 'memory' ||
    normalized.startsWith('memory/')
  );
}

function createWatchRegistry() {
  return {
    workspace: null,
    memoryFile: null,
    memoryDir: null
  };
}

async function runExternalMemoryWatch(workspaceArg, options = {}) {
  const workspace = path.resolve(workspaceArg);
  const memoryFile = path.join(workspace, 'MEMORY.md');
  const memoryDir = path.join(workspace, 'memory');
  const debounceMs = Number.isFinite(Number(options.debounceMs)) && Number(options.debounceMs) >= 0
    ? Number(options.debounceMs)
    : DEFAULT_DEBOUNCE_MS;
  const durationMs = Number.isFinite(Number(options.durationMs)) && Number(options.durationMs) > 0
    ? Number(options.durationMs)
    : null;
  const watchImpl = options.watchImpl || fs.watch;
  const existsImpl = options.existsImpl || fs.existsSync;
  const summarizeImpl = options.summarizeImpl || summarizeExternalMemorySources;
  const syncImpl = options.syncImpl || ((watchWorkspace, watchSessionKey, syncOptions) =>
    runLegacyMemorySync(watchWorkspace, watchSessionKey, syncOptions));
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const signal = options.signal || null;

  const events = [];
  const syncRuns = [];
  const errors = [];
  const watchers = createWatchRegistry();
  const startTime = Date.now();
  let debounceTimer = null;
  let durationTimer = null;
  let stopped = false;
  let resolveDone;

  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function emit(event) {
    events.push(event);
    if (onEvent) {
      onEvent(event);
    }
  }

  function closeWatcher(key) {
    if (watchers[key] && typeof watchers[key].close === 'function') {
      watchers[key].close();
    }
    watchers[key] = null;
  }

  function closeAllWatchers() {
    closeWatcher('workspace');
    closeWatcher('memoryFile');
    closeWatcher('memoryDir');
  }

  function refreshWatchers() {
    if (!watchers.workspace) {
      watchers.workspace = watchImpl(workspace, (_eventType, fileName) => {
        if (!shouldReactToWorkspaceEvent(fileName)) {
          return;
        }
        scheduleSync('workspace_change', {
          file_name: fileName || null
        });
      });
    }

    const memoryFileExists = existsImpl(memoryFile);
    if (memoryFileExists && !watchers.memoryFile) {
      watchers.memoryFile = watchImpl(memoryFile, () => {
        scheduleSync('memory_file_change', {
          file_name: 'MEMORY.md'
        });
      });
    } else if (!memoryFileExists && watchers.memoryFile) {
      closeWatcher('memoryFile');
    }

    const memoryDirExists = existsImpl(memoryDir);
    if (memoryDirExists && !watchers.memoryDir) {
      watchers.memoryDir = watchImpl(memoryDir, (_eventType, fileName) => {
        scheduleSync('memory_dir_change', {
          file_name: fileName || null
        });
      });
    } else if (!memoryDirExists && watchers.memoryDir) {
      closeWatcher('memoryDir');
    }
  }

  function finalize(reason) {
    if (stopped) {
      return;
    }

    stopped = true;
    if (debounceTimer) {
      clearTimeoutImpl(debounceTimer);
      debounceTimer = null;
    }
    if (durationTimer) {
      clearTimeoutImpl(durationTimer);
      durationTimer = null;
    }
    closeAllWatchers();

    resolveDone({
      status: 'stopped',
      reason,
      workspace,
      session_key: options.sessionKey || 'external-memory-watch',
      project_id: options.projectId || null,
      sync_runs: syncRuns,
      sync_count: syncRuns.length,
      errors,
      observed_events: events.length,
      watched_targets: [
        workspace,
        existsImpl(memoryFile) ? memoryFile : null,
        existsImpl(memoryDir) ? memoryDir : null
      ].filter(Boolean),
      elapsed_ms: Date.now() - startTime
    });
  }

  function performSync(trigger) {
    if (stopped) {
      return;
    }

    try {
      const summary = summarizeImpl(workspace);
      refreshWatchers();

      if (summary.external_source_count <= 0 || summary.unsynced_source_count <= 0) {
        emit({
          type: 'watch:skip',
          trigger,
          external_source_count: summary.external_source_count,
          unsynced_source_count: summary.unsynced_source_count
        });
        return;
      }

      const result = syncImpl(workspace, options.sessionKey || 'external-memory-watch', {
        projectId: options.projectId || null,
        reason: options.reason || 'external-memory-watch'
      });
      syncRuns.push(result);
      emit({
        type: 'watch:sync',
        trigger,
        synced_entries: result.synced_entries,
        synced_files: result.synced_files,
        skipped_files: result.skipped_files
      });
      refreshWatchers();
    } catch (error) {
      errors.push(error.message);
      emit({
        type: 'watch:error',
        trigger,
        message: error.message
      });
    }
  }

  function scheduleSync(triggerType, payload = {}) {
    if (stopped) {
      return;
    }

    emit({
      type: 'watch:change',
      trigger: triggerType,
      ...payload
    });

    refreshWatchers();
    if (debounceTimer) {
      clearTimeoutImpl(debounceTimer);
    }
    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      performSync({
        type: triggerType,
        ...payload
      });
    }, debounceMs);
  }

  if (signal) {
    if (signal.aborted) {
      finalize('aborted');
      return done;
    }

    signal.addEventListener('abort', () => finalize('aborted'), { once: true });
  }

  refreshWatchers();
  emit({
    type: 'watch:start',
    workspace,
    debounce_ms: debounceMs,
    duration_ms: durationMs
  });

  if (durationMs) {
    durationTimer = setTimeoutImpl(() => finalize('duration_elapsed'), durationMs);
  }

  return done;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.workspace) {
    throw new Error('external-memory-watch requires --workspace <workspace>');
  }
  const result = await runExternalMemoryWatch(options.workspace, options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
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
  });
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  parseArgs,
  runExternalMemoryWatch,
  shouldReactToWorkspaceEvent
};
