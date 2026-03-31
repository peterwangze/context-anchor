#!/usr/bin/env node

const {
  DEFAULTS,
  buildAdaptiveBudget,
  buildHealthSummary,
  collectSkillDiagnostics,
  countByStatus,
  createPaths,
  loadCollectionCountSnapshot,
  loadCollectionSnapshot,
  loadSessionState,
  projectDecisionsFile,
  projectExperiencesFile,
  projectFactsFile,
  projectSkillsIndexFile,
  projectStateFile,
  readMirroredDocumentSnapshot,
  resolveProjectId,
  resolveUserId,
  sanitizeKey,
  sessionExperiencesFile,
  sessionMemoryFile,
  sessionSkillsIndexFile,
  sessionSummaryFile,
  summarizeEvidence,
  userExperiencesFile,
  userMemoriesFile,
  userSkillsIndexFile,
  userStateFile,
  writeStatusSnapshot
} = require('./lib/context-anchor');
const { resolveOwnership } = require('./lib/host-config');

function summarizeSkillEvidence(skills = []) {
  const entries = skills.flatMap((skill) =>
    (Array.isArray(skill.evidence) ? skill.evidence : []).map((event) => ({
      ...event,
      skill_id: skill.id,
      skill_name: skill.name,
      skill_scope: skill.scope
    }))
  );
  const summary = summarizeEvidence(entries);
  return {
    ...summary,
    recent: summary.recent.map((event) => ({
      type: event.type,
      at: event.at,
      reason: event.reason,
      actor: event.actor,
      skill_id: event.skill_id,
      skill_name: event.skill_name,
      scope: event.skill_scope
    }))
  };
}

function runStatusReport(workspaceArg, sessionKeyArg, projectIdArg, userIdArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: projectIdArg,
    userId: userIdArg
  });
  const projectId = ownership.projectId || resolveProjectId(paths.workspace, projectIdArg);
  const existingSessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: false,
    touch: false
  });
  const userId = resolveUserId(userIdArg || existingSessionState?.user_id || ownership.userId || DEFAULTS.userId);

  const projectState = readMirroredDocumentSnapshot(projectStateFile(paths, projectId), {
    project_id: projectId,
    name: projectId,
    created_at: null,
    last_updated: null,
    sessions_count: 0,
    key_decisions: [],
    key_experiences: [],
    user_preferences: {},
    metadata: {}
  });
  const userState = readMirroredDocumentSnapshot(userStateFile(paths, userId), {
    user_id: userId,
    created_at: null,
    last_updated: null,
    preferences: {},
    profile: {},
    key_memories: [],
    key_experiences: [],
    key_skills: [],
    metadata: {}
  });
  const sessionState =
    existingSessionState || {
      session_key: sessionKey,
      project_id: projectId,
      user_id: userId,
      active_task: null,
      commitments: [],
      last_checkpoint: null,
      last_summary: null
    };

  const sessionMemories = loadCollectionCountSnapshot(sessionMemoryFile(paths, sessionKey), 'entries');
  const sessionExperiences = loadCollectionCountSnapshot(sessionExperiencesFile(paths, sessionKey), 'experiences');
  const sessionSkills = loadCollectionSnapshot(sessionSkillsIndexFile(paths, sessionKey), 'skills');
  const sessionSummary = readMirroredDocumentSnapshot(sessionSummaryFile(paths, sessionKey), {});
  const projectDecisions = loadCollectionCountSnapshot(projectDecisionsFile(paths, projectId), 'decisions');
  const projectExperiences = loadCollectionCountSnapshot(projectExperiencesFile(paths, projectId), 'experiences');
  const projectFacts = loadCollectionCountSnapshot(projectFactsFile(paths, projectId), 'facts');
  const projectSkills = loadCollectionSnapshot(projectSkillsIndexFile(paths, projectId), 'skills');
  const userMemories = loadCollectionCountSnapshot(userMemoriesFile(paths, userId), 'memories');
  const userExperiences = loadCollectionCountSnapshot(userExperiencesFile(paths, userId), 'experiences');
  const userSkills = loadCollectionSnapshot(userSkillsIndexFile(paths, userId), 'skills');

  const diagnostics = collectSkillDiagnostics({
    session: sessionSkills,
    project: projectSkills,
    user: userSkills
  });
  const skillStatusCounts = countByStatus(diagnostics.all);

  const report = {
    status: 'ok',
    workspace: paths.workspace,
    user: {
      id: userId,
      preferences_count: Object.keys(userState.preferences || {}).length,
      memories: userMemories,
      experiences: userExperiences,
      skills: userSkills.length
    },
    project: {
      id: projectId,
      name: projectState.name,
      decisions: projectDecisions,
      experiences: projectExperiences,
      facts: projectFacts,
      skills: projectSkills.length
    },
    session: {
      key: sessionKey,
      active_task: sessionState.active_task,
      pending_commitments: (sessionState.commitments || []).filter((entry) => entry.status === 'pending').length,
      memories: sessionMemories,
      experiences: sessionExperiences,
      skills: sessionSkills.length,
      last_checkpoint: sessionState.last_checkpoint,
      last_summary: sessionState.last_summary,
      last_summary_snapshot: sessionSummary.created_at ? {
        created_at: sessionSummary.created_at,
        promoted_project_skills: (sessionSummary.promoted_project_skills || []).length,
        promoted_user_skills: (sessionSummary.promoted_user_skills || []).length,
        deactivated_project_skills: sessionSummary.deactivated_project_skills || 0,
        reactivated_project_skills: sessionSummary.reactivated_project_skills || 0,
        deactivated_user_skills: sessionSummary.deactivated_user_skills || 0,
        reactivated_user_skills: sessionSummary.reactivated_user_skills || 0,
        archived_project_skills: sessionSummary.archived_project_skills || 0,
        archived_user_skills: sessionSummary.archived_user_skills || 0
      } : null
    },
    governance: {
      active: diagnostics.active.length,
      shadowed: diagnostics.shadowed.length,
      superseded: diagnostics.superseded.length,
      budgeted_out: diagnostics.budgeted_out.length
    },
    skills: skillStatusCounts
  };

  report.health = buildHealthSummary(report);
  report.adaptive_budget = buildAdaptiveBudget(DEFAULTS.skillActivationBudget, report);
  report.evidence = {
    session_skills: summarizeSkillEvidence(diagnostics.all.filter((skill) => skill.scope === 'session')),
    project_skills: summarizeSkillEvidence(diagnostics.all.filter((skill) => skill.scope === 'project')),
    user_skills: summarizeSkillEvidence(diagnostics.all.filter((skill) => skill.scope === 'user'))
  };

  if (options.writeSnapshot) {
    report.snapshot_file = writeStatusSnapshot(paths, sessionKey, report);
  }

  return report;
}

function main() {
  const result = runStatusReport(
    process.argv[2],
    process.argv[3],
    process.argv[4],
    process.argv[5],
    {
      writeSnapshot: process.argv[6] === 'snapshot'
    }
  );
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runStatusReport
};
