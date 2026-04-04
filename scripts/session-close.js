#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  loadSessionMemory,
  loadSessionState,
  resolveUserId,
  sanitizeKey,
  writeSessionState,
  writeSessionSummary
} = require('./lib/context-anchor');
const { recordSessionOwnership, resolveOwnership } = require('./lib/host-config');
const { runCheckpointCreate } = require('./checkpoint-create');
const { runCompactPacketCreate } = require('./compact-packet-create');
const { runHeatEvaluation } = require('./heat-eval');
const { runLegacyMemorySync } = require('./legacy-memory-sync');
const { runMemoryFlow } = require('./memory-flow');
const { runRuntimeStateUpdate } = require('./runtime-state-update');
const { runSessionExperienceSync } = require('./session-experience-sync');
const { runSkillReconcile } = require('./skill-reconcile');
const { runScopePromote } = require('./scope-promote');
const { runSkillDraftCreate } = require('./skill-draft-create');
const { runSkillificationScore } = require('./skillification-score');
const { runStorageGovernance } = require('./storage-governance');
const { buildVisibleBenefitSummary } = require('./lib/visible-benefit-summary');

function shouldClearTaskStateForReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return normalized === 'command-stop';
}

function runSessionClose(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: options.projectId,
    userId: options.userId
  });
  const sessionState = loadSessionState(paths, sessionKey, ownership.projectId, {
    createIfMissing: true,
    touch: true,
    userId: ownership.userId
  });
  sessionState.user_id = ownership.userId;
  sessionState.project_id = ownership.projectId;
  writeSessionState(paths, sessionKey, sessionState);
  const legacy_memory_sync = runLegacyMemorySync(paths.workspace, sessionKey, {
    projectId: sessionState.project_id,
    reason: options.reason || 'session-close'
  });
  const checkpoint = runCheckpointCreate(paths.workspace, sessionKey, options.reason || 'session-close', {
    usagePercent: options.usagePercent
  });
  const compact = runCompactPacketCreate(paths.workspace, sessionKey, {
    reason: options.reason || 'session-close',
    usagePercent: options.usagePercent,
    userId: sessionState.user_id
  });
  const sessionExperiences = runSessionExperienceSync(paths.workspace, sessionKey, {
    projectId: sessionState.project_id,
    userId: sessionState.user_id
  });
  const flow = runMemoryFlow(paths.workspace, sessionKey, { minimumHeat: 50 });
  const sessionMemories = loadSessionMemory(paths, sessionKey);

  const skillDraft = runSkillDraftCreate(paths.workspace, sessionKey);
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
  const summary = {
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: resolveUserId(sessionState.user_id),
    created_at: new Date().toISOString(),
    reason: options.reason || 'session-close',
    active_task: sessionState.active_task,
    pending_commitments: (sessionState.commitments || []).filter((entry) => entry.status === 'pending'),
    memory_count: sessionMemories.length,
    new_session_experiences: sessionExperiences.created,
    compact_packet_file: compact.compact_packet_file,
    promoted_project_skills: promotions.project_skills,
    promoted_user_skills: promotions.user_skills,
    deactivated_project_skills: reconcile.project_deactivated,
    reactivated_project_skills: reconcile.project_reactivated,
    deactivated_user_skills: reconcile.user_deactivated,
    reactivated_user_skills: reconcile.user_reactivated,
    archived_project_skills: reconcile.project_archived,
    archived_user_skills: reconcile.user_archived,
    skill_draft: skillDraft.status !== 'skipped' ? {
      id: skillDraft.skill_id,
      name: skillDraft.skill_name,
      status: skillDraft.status
    } : null
  };
  summary.benefit_summary = buildVisibleBenefitSummary({
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
    reactivated_user_skills: reconcile.user_reactivated,
    skill_draft: summary.skill_draft
  });
  writeSessionSummary(paths, sessionKey, summary);

  sessionState.closed_at = new Date().toISOString();
  sessionState.last_summary = summary.created_at;
  writeSessionState(paths, sessionKey, sessionState);
  const runtimeState = runRuntimeStateUpdate(paths.workspace, sessionKey, {
    projectId: sessionState.project_id,
    userId: sessionState.user_id,
    reason: options.reason || 'session-close',
    currentGoal: shouldClearTaskStateForReason(options.reason) ? null : sessionState.active_task,
    latestVerifiedResult: summary.benefit_summary.visible ? summary.benefit_summary.summary : null,
    nextStep: shouldClearTaskStateForReason(options.reason)
      ? null
      : (
          Array.isArray(sessionState.commitments)
            ? sessionState.commitments.find((entry) => entry.status === 'pending')?.what
            : null
        ) || null,
    blockedBy: sessionState.metadata?.blocked_by || null,
    lastUserVisibleProgress: summary.benefit_summary.visible ? summary.benefit_summary.summary : null
  });
  const governance = runStorageGovernance(paths.workspace, sessionKey, {
    projectId: sessionState.project_id,
    userId: sessionState.user_id,
    reason: options.reason || 'session-close'
  });
  recordSessionOwnership(paths.openClawHome, paths.workspace, sessionState, {
    status: 'closed',
    closedAt: sessionState.closed_at
  });

  return {
    status: 'closed',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    checkpoint,
    compact,
    captured_summary: summary.benefit_summary,
    legacy_memory_sync,
    flow,
    session_experience_sync: sessionExperiences,
    session_summary_file: require('./lib/context-anchor').sessionSummaryFile(paths, sessionKey),
    runtime_state: runtimeState.runtime_state,
    governance,
    session_experiences: sessionExperiences.total_experiences,
    skill_draft: skillDraft,
    promotions,
    reconcile,
    heat,
    skillification
  };
}

function main() {
  const result = runSessionClose(process.argv[2], process.argv[3], {
    reason: process.argv[4],
    usagePercent: process.argv[5] ? Number(process.argv[5]) : undefined,
    projectId: process.argv[6]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSessionClose
};
