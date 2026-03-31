#!/usr/bin/env node

const {
  createPaths,
  loadSessionState,
  runtimeStateFile,
  sanitizeKey,
  syncRuntimeStateFromSessionState
} = require('./lib/context-anchor');
const { resolveOwnership } = require('./lib/host-config');

function runRuntimeStateUpdate(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: options.projectId,
    userId: options.userId
  });
  const sessionState = loadSessionState(paths, sessionKey, ownership.projectId, {
    createIfMissing: true,
    touch: false,
    userId: ownership.userId
  });

  sessionState.user_id = ownership.userId;
  sessionState.project_id = ownership.projectId;

  const runtimeState = syncRuntimeStateFromSessionState(paths, sessionKey, sessionState, {
    metadata: {
      ...(sessionState.metadata || {}),
      runtime_state_reason: options.reason || null,
      runtime_state_updated_at: new Date().toISOString()
    }
  });

  return {
    status: 'updated',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: sessionState.user_id,
    runtime_state_file: runtimeStateFile(paths, sessionKey),
    runtime_state: runtimeState
  };
}

function main() {
  const result = runRuntimeStateUpdate(process.argv[2], process.argv[3], {
    projectId: process.argv[4],
    userId: process.argv[5],
    reason: process.argv[6]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runRuntimeStateUpdate
};
