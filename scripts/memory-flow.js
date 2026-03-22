#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  loadSessionMemory,
  loadSessionState,
  sortByHeat,
  writeSessionMemory,
  writeSessionState
} = require('./lib/context-anchor');
const { runMemorySave } = require('./memory-save');

function createSyncFingerprint(entry) {
  return JSON.stringify({
    type: entry.type,
    content: entry.content || null,
    summary: entry.summary || null,
    details: entry.details || null,
    solution: entry.solution || null,
    tags: Array.isArray(entry.tags) ? [...entry.tags].sort() : [],
    scope: entry.scope || 'session',
    global: Boolean(entry.global)
  });
}

function normalizeFlowType(type) {
  if (type === 'decision' || type === 'preference') {
    return type;
  }

  if (type === 'lesson' || type === 'best_practice' || type === 'tool-pattern' || type === 'gotcha' || type === 'feature_request') {
    return type;
  }

  if (type === 'error') {
    return 'lesson';
  }

  if (type === 'experience') {
    return 'best_practice';
  }

  return 'fact';
}

function shouldSyncEntry(entry, minimumHeat) {
  const fingerprint = createSyncFingerprint(entry);

  return (
    !entry.archived &&
    entry.sync_to_project !== false &&
    Number(entry.heat || 0) >= minimumHeat &&
    (
      !entry.synced_project_entry_id ||
      entry.last_sync_fingerprint !== fingerprint
    )
  );
}

function syncEntry(paths, sessionState, entry) {
  const type = normalizeFlowType(entry.type);
  const scope = entry.scope === 'global' || type === 'preference' && entry.global ? 'global' : 'project';
  const payload = JSON.stringify({
    entry_id: entry.synced_project_entry_id || null,
    source_session_entry_id: entry.id,
    summary: entry.summary || entry.content,
    details: entry.details || null,
    solution: entry.solution || null,
    tags: entry.tags || [],
    heat: Math.max(DEFAULTS.warmMemoryHeat, Number(entry.heat || 0) - 10),
    source: 'memory-flow',
    validation_status: entry.validation?.status || 'pending'
  });

  return runMemorySave(paths.workspace, sessionState.session_key, scope, type, entry.content || entry.summary, payload);
}

function runMemoryFlow(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionState = loadSessionState(paths, sessionKeyArg, undefined, {
    createIfMissing: true,
    touch: true
  });
  const minimumHeat = Number(options.minimumHeat || DEFAULTS.hotMemoryHeat);
  const entries = sortByHeat(loadSessionMemory(paths, sessionState.session_key));
  const actions = [];

  const nextEntries = entries.map((entry) => {
    if (!shouldSyncEntry(entry, minimumHeat)) {
      return entry;
    }

    const saved = syncEntry(paths, sessionState, entry);
    const nextFingerprint = createSyncFingerprint(entry);
    actions.push({
      session_entry_id: entry.id,
      project_entry_id: saved.id,
      scope: saved.scope,
      type: saved.type
    });

    return {
      ...entry,
      synced_at: new Date().toISOString(),
      last_sync_fingerprint: nextFingerprint,
      synced_scope: saved.scope,
      synced_project_entry_id: saved.id,
      heat: Math.max(DEFAULTS.warmMemoryHeat, Number(entry.heat || 0) - 20)
    };
  });

  writeSessionMemory(paths, sessionState.session_key, nextEntries);

  sessionState.last_flow_at = new Date().toISOString();
  writeSessionState(paths, sessionState.session_key, sessionState);

  return {
    status: 'evaluated',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    total_entries: entries.length,
    synced_entries: actions.length,
    actions
  };
}

function main() {
  const result = runMemoryFlow(process.argv[2], process.argv[3], {
    minimumHeat: process.argv[4] ? Number(process.argv[4]) : undefined
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runMemoryFlow
};
