#!/usr/bin/env node

const { createPaths, loadSessionState, sanitizeKey } = require('./lib/context-anchor');
const { runContextPressureHandle } = require('./context-pressure-handle');
const { runHeatEvaluation } = require('./heat-eval');
const { runMemoryFlow } = require('./memory-flow');
const { runSkillReconcile } = require('./skill-reconcile');
const { runScopePromote } = require('./scope-promote');
const { runSkillificationScore } = require('./skillification-score');

function runHeartbeat(workspaceArg, sessionKeyArg, projectIdArg, usagePercentArg) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg);
  const sessionState = loadSessionState(paths, sessionKey, projectIdArg, {
    createIfMissing: true,
    touch: true
  });
  const flow = runMemoryFlow(paths.workspace, sessionState.session_key, {});
  const heat = runHeatEvaluation(paths.workspace, sessionState.project_id);
  const skillification = runSkillificationScore(paths.workspace, sessionState.project_id);
  const promotions = runScopePromote(paths.workspace, {
    sessionKey: sessionState.session_key,
    projectId: sessionState.project_id,
    userId: sessionState.user_id
  });
  const reconcile = runSkillReconcile(paths.workspace, {
    projectId: sessionState.project_id,
    userId: sessionState.user_id
  });
  const pressure =
    usagePercentArg !== undefined
      ? runContextPressureHandle(paths.workspace, sessionState.session_key, usagePercentArg)
      : null;

  return {
    status: 'heartbeat_ok',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    flow,
    heat,
    skillification,
    promotions,
    reconcile,
    pressure
  };
}

function main() {
  const result = runHeartbeat(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runHeartbeat
};
