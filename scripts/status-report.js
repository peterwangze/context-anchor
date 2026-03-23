#!/usr/bin/env node

const {
  DEFAULTS,
  buildAdaptiveBudget,
  buildHealthSummary,
  collectSkillDiagnostics,
  countByStatus,
  createPaths,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadProjectSkills,
  loadProjectState,
  loadSessionExperiences,
  loadSessionMemory,
  loadSessionSkills,
  loadSessionState,
  loadSessionSummary,
  loadUserExperiences,
  loadUserMemories,
  loadUserSkills,
  loadUserState,
  resolveProjectId,
  resolveUserId,
  sanitizeKey,
  writeStatusSnapshot
} = require('./lib/context-anchor');

function runStatusReport(workspaceArg, sessionKeyArg, projectIdArg, userIdArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const userId = resolveUserId(userIdArg || DEFAULTS.userId);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);

  const projectState = loadProjectState(paths, projectId);
  const userState = loadUserState(paths, userId);
  const sessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: true,
    touch: true
  });

  const sessionMemories = loadSessionMemory(paths, sessionKey);
  const sessionExperiences = loadSessionExperiences(paths, sessionKey);
  const sessionSkills = loadSessionSkills(paths, sessionKey);
  const sessionSummary = loadSessionSummary(paths, sessionKey);
  const projectDecisions = loadProjectDecisions(paths, projectId);
  const projectExperiences = loadProjectExperiences(paths, projectId);
  const projectFacts = loadProjectFacts(paths, projectId);
  const projectSkills = loadProjectSkills(paths, projectId);
  const userMemories = loadUserMemories(paths, userId);
  const userExperiences = loadUserExperiences(paths, userId);
  const userSkills = loadUserSkills(paths, userId);

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
      memories: userMemories.length,
      experiences: userExperiences.length,
      skills: userSkills.length
    },
    project: {
      id: projectId,
      name: projectState.name,
      decisions: projectDecisions.length,
      experiences: projectExperiences.length,
      facts: projectFacts.length,
      skills: projectSkills.length
    },
    session: {
      key: sessionKey,
      active_task: sessionState.active_task,
      pending_commitments: (sessionState.commitments || []).filter((entry) => entry.status === 'pending').length,
      memories: sessionMemories.length,
      experiences: sessionExperiences.length,
      skills: sessionSkills.length,
      last_checkpoint: sessionState.last_checkpoint,
      last_summary: sessionState.last_summary,
      last_summary_snapshot: sessionSummary.created_at ? {
        created_at: sessionSummary.created_at,
        promoted_project_skills: (sessionSummary.promoted_project_skills || []).length,
        promoted_user_skills: (sessionSummary.promoted_user_skills || []).length,
        deactivated_project_skills: sessionSummary.deactivated_project_skills || 0,
        deactivated_user_skills: sessionSummary.deactivated_user_skills || 0
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
