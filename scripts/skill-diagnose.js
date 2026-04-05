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
  sanitizeKey,
  summarizeEvidence
} = require('./lib/context-anchor');
const { field, section, status } = require('./lib/terminal-format');
const { runCliMain } = require('./lib/cli-runtime');

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
  const reasons = matches.map((skill) => ({
    id: skill.id,
    scope: skill.scope,
    diagnosis: skill.diagnosis,
    status: skill.status,
    superseded_by: skill.superseded_by || null,
    shadowed_by: skill.shadowed_by || null,
    budget_reason: skill.budget_reason || null,
    evidence_summary: summarizeEvidence(skill.evidence || [])
  }));
  const recommendations = [];

  if (matches.length === 0) {
    recommendations.push('Check the skill id, name, or conflict_key.');
  }

  reasons.forEach((reason) => {
    switch (reason.diagnosis) {
      case 'shadowed':
        recommendations.push(`Skill ${reason.id} is shadowed; consider lowering the winner scope, renaming conflict_key, or inactivating the winner.`);
        break;
      case 'superseded':
        recommendations.push(`Skill ${reason.id} is superseded; inspect the winner skill and remove or update the supersede relation if this is no longer intended.`);
        break;
      case 'budgeted_out':
        recommendations.push(`Skill ${reason.id} is budgeted out; consider increasing the activation budget or lowering competing skills' budget_weight/priority.`);
        break;
      case 'inactive':
        recommendations.push(`Skill ${reason.id} is inactive; reactivate it manually if it should load again, or keep it inactive if deprecated.`);
        break;
      case 'archived':
        recommendations.push(`Skill ${reason.id} is archived; unarchive or recreate it only if it has renewed supporting evidence.`);
        break;
      default:
        break;
    }
  });

  return {
    status: 'ok',
    identifier,
    session_key: sessionKey,
    project_id: projectId,
    user_id: userId,
    matches,
    effective_match: diagnostics.active.find((skill) => matchSkillIdentifier(skill, identifier)) || null,
    reasons,
    recommendations: Array.from(new Set(recommendations))
  };
}

function parseArgs(argv) {
  return {
    workspace: argv[0],
    identifier: argv[1],
    sessionKey: argv[2],
    projectId: argv[3],
    userId: argv[4],
    json: argv.includes('--json')
  };
}

function renderSkillDiagnoseReport(result) {
  const lines = [];
  const hasMatch = Array.isArray(result.matches) && result.matches.length > 0;
  lines.push(section('Context-Anchor Skill Diagnose', { kind: hasMatch ? 'info' : 'warning' }));
  lines.push(field('Identifier', result.identifier, { kind: 'info' }));
  lines.push(field('Matches', status(Number(result.matches?.length || 0), hasMatch ? 'success' : 'warning'), { kind: hasMatch ? 'success' : 'warning' }));
  lines.push(field('Scope', `Session ${result.session_key} | Project ${result.project_id} | User ${result.user_id}`, { kind: 'muted' }));
  if (result.effective_match) {
    lines.push(
      field(
        'Effective match',
        `${result.effective_match.name || result.effective_match.id} | scope ${result.effective_match.scope} | status ${result.effective_match.status || 'active'} | diagnosis ${result.effective_match.diagnosis || 'active'}`,
        { kind: 'success' }
      )
    );
  }
  (result.reasons || []).slice(0, 5).forEach((reason) => {
    lines.push(
      field(
        reason.id,
        `scope ${reason.scope} | status ${reason.status} | diagnosis ${reason.diagnosis}`,
        { kind: reason.diagnosis === 'active' ? 'success' : 'warning' }
      )
    );
  });
  if (Array.isArray(result.recommendations) && result.recommendations.length > 0) {
    lines.push(field('Recommendation', result.recommendations[0], { kind: 'info' }));
  }
  return lines.join('\n');
}

function main() {
  return runCliMain(process.argv.slice(2), {
    parseArgs,
    run: async (options) =>
      runSkillDiagnose(options.workspace, options.identifier, options.sessionKey, options.projectId, options.userId),
    renderText: renderSkillDiagnoseReport,
    errorTitle: 'Context-Anchor Skill Diagnose Failed',
    errorNextStep: 'Check the workspace and skill identifier, then rerun skill-diagnose.'
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderSkillDiagnoseReport,
  runSkillDiagnose
};
