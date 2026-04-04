#!/usr/bin/env node

const { createPaths, loadSessionState, sanitizeKey, writeSessionState } = require('./lib/context-anchor');
const { recordSessionOwnership, resolveOwnership } = require('./lib/host-config');
const { runContextPressureHandle } = require('./context-pressure-handle');
const { runHeatEvaluation } = require('./heat-eval');
const { runLegacyMemorySync } = require('./legacy-memory-sync');
const { runMemoryFlow } = require('./memory-flow');
const { runSessionExperienceSync } = require('./session-experience-sync');
const { runSkillReconcile } = require('./skill-reconcile');
const { runScopePromote } = require('./scope-promote');
const { runSkillificationScore } = require('./skillification-score');
const { runStorageGovernance } = require('./storage-governance');
const { buildVisibleBenefitSummary } = require('./lib/visible-benefit-summary');

function runHeartbeat(workspaceArg, sessionKeyArg, projectIdArg, usagePercentArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: projectIdArg,
    userId: options.userId
  });
  const sessionState = loadSessionState(paths, sessionKey, ownership.projectId, {
    createIfMissing: true,
    touch: true,
    userId: ownership.userId
  });
  sessionState.user_id = ownership.userId;
  sessionState.project_id = ownership.projectId;
  writeSessionState(paths, sessionState.session_key, sessionState);
  const legacy_memory_sync = runLegacyMemorySync(paths.workspace, sessionState.session_key, {
    projectId: sessionState.project_id,
    reason: options.governanceReason || options.reason || 'heartbeat'
  });
  recordSessionOwnership(paths.openClawHome, paths.workspace, sessionState, {
    status: sessionState.closed_at ? 'closed' : 'active'
  });
  const sessionExperiences = runSessionExperienceSync(paths.workspace, sessionState.session_key, {
    projectId: sessionState.project_id,
    userId: sessionState.user_id
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
  const governance = runStorageGovernance(paths.workspace, sessionState.session_key, {
    projectId: sessionState.project_id,
    userId: sessionState.user_id,
    reason: options.governanceReason || options.reason || 'heartbeat'
  });
  const pressure =
    usagePercentArg !== undefined
      ? runContextPressureHandle(paths.workspace, sessionState.session_key, usagePercentArg)
      : null;
  const capturedSummary = buildVisibleBenefitSummary({
    session_experiences_created: sessionExperiences.created,
    session_experiences_updated: sessionExperiences.updated,
    session_experiences_archived: sessionExperiences.archived,
    legacy_synced_entries: legacy_memory_sync.synced_entries,
    promoted_project_skills: promotions.project_promotions,
    promoted_user_skills: promotions.user_promotions,
    archived_project_skills: reconcile.project_archived,
    archived_user_skills: reconcile.user_archived,
    deactivated_project_skills: reconcile.project_deactivated,
    deactivated_user_skills: reconcile.user_deactivated,
    reactivated_project_skills: reconcile.project_reactivated,
    reactivated_user_skills: reconcile.user_reactivated
  });

  return {
    status: 'heartbeat_ok',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    captured_summary: capturedSummary,
    session_experiences: sessionExperiences,
    legacy_memory_sync,
    flow,
    heat,
    skillification,
    promotions,
    reconcile,
    governance,
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
