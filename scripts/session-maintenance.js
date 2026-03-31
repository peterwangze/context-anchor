#!/usr/bin/env node

const {
  createPaths,
  readMirroredDocumentSnapshot,
  sanitizeKey,
  sessionStateFile,
  touchSessionIndex,
  writeSessionState
} = require('./lib/context-anchor');
const { runHeartbeat } = require('./heartbeat');

function runSessionMaintenance(workspaceArg, sessionKeyArg, projectIdArg, usagePercentArg) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg);
  const stateFile = sessionStateFile(paths, sessionKey);
  const previousState = readMirroredDocumentSnapshot(stateFile, null);

  if (!previousState) {
    return {
      status: 'skipped',
      reason: 'session_not_found',
      workspace: paths.workspace,
      session_key: sessionKey,
      project_id: projectIdArg || null
    };
  }

  const preservedLastActive = previousState.last_active || null;
  const result = runHeartbeat(
    paths.workspace,
    sessionKey,
    projectIdArg || previousState.project_id,
    usagePercentArg
  );
  const nextState = readMirroredDocumentSnapshot(stateFile, previousState);

  if (preservedLastActive) {
    nextState.last_active = preservedLastActive;
    writeSessionState(paths, sessionKey, nextState);
    touchSessionIndex(paths, nextState);
  }

  return {
    ...result,
    status: 'maintenance_ok',
    preserved_last_active: preservedLastActive
  };
}

function main() {
  const result = runSessionMaintenance(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSessionMaintenance
};
