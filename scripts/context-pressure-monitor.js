#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createPaths, readJson } = require('./lib/context-anchor');
const { runContextPressureHandle } = require('./context-pressure-handle');

function loadSnapshot(snapshotArg, usageArg) {
  if (!snapshotArg) {
    return { sessions: [] };
  }

  const maybeFile = path.resolve(snapshotArg);
  if (fs.existsSync(maybeFile)) {
    return readJson(maybeFile, { sessions: [] });
  }

  if (usageArg !== undefined) {
    return {
      sessions: [
        {
          session_key: snapshotArg,
          usage_percent: Number(usageArg)
        }
      ]
    };
  }

  return { sessions: [] };
}

function runContextPressureMonitor(workspaceArg, snapshotArg, usageArg) {
  const paths = createPaths(workspaceArg);
  const snapshot = loadSnapshot(snapshotArg, usageArg);
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];

  return {
    status: 'processed',
    workspace: paths.workspace,
    handled_sessions: sessions.length,
    results: sessions.map((entry) =>
      runContextPressureHandle(paths.workspace, entry.session_key, entry.usage_percent)
    )
  };
}

function main() {
  const result = runContextPressureMonitor(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runContextPressureMonitor
};
