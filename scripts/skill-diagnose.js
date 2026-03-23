#!/usr/bin/env node

const {
  DEFAULTS,
  collectSkillDiagnostics,
  createPaths,
  loadProjectSkills,
  loadSessionSkills,
  loadUserSkills,
  matchSkillIdentifier,
  resolveProjectId,
  resolveUserId,
  sanitizeKey
} = require('./lib/context-anchor');

function runSkillDiagnose(workspaceArg, identifier, sessionKeyArg, projectIdArg, userIdArg) {
  if (!identifier) {
    throw new Error(
      'Usage: node skill-diagnose.js <workspace> <skill-id|name|conflict-key> [session-key] [project-id] [user-id]'
    );
  }

  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const userId = resolveUserId(userIdArg || DEFAULTS.userId);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);

  const diagnostics = collectSkillDiagnostics({
    session: loadSessionSkills(paths, sessionKey),
    project: loadProjectSkills(paths, projectId),
    user: loadUserSkills(paths, userId)
  });

  const matches = diagnostics.all.filter((skill) => matchSkillIdentifier(skill, identifier));
  return {
    status: 'ok',
    identifier,
    session_key: sessionKey,
    project_id: projectId,
    user_id: userId,
    matches,
    effective_match: diagnostics.active.find((skill) => matchSkillIdentifier(skill, identifier)) || null,
    reasons: matches.map((skill) => ({
      id: skill.id,
      scope: skill.scope,
      diagnosis: skill.diagnosis,
      status: skill.status,
      superseded_by: skill.superseded_by || null,
      shadowed_by: skill.shadowed_by || null,
      budget_reason: skill.budget_reason || null
    }))
  };
}

function main() {
  try {
    const result = runSkillDiagnose(
      process.argv[2],
      process.argv[3],
      process.argv[4],
      process.argv[5],
      process.argv[6]
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
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
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runSkillDiagnose
};
