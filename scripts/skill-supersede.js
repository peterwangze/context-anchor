#!/usr/bin/env node

const {
  DEFAULTS,
  appendEvidence,
  createPaths,
  loadProjectSkills,
  loadUserSkills,
  normalizeSkillRecord,
  resolveProjectId,
  resolveUserId,
  writeProjectSkills,
  writeUserSkills
} = require('./lib/context-anchor');

function applySupersede(skills, winnerId, loserId) {
  const winnerIdx = skills.findIndex((skill) => skill.id === winnerId);
  const loserIdx = skills.findIndex((skill) => skill.id === loserId);

  if (winnerIdx < 0 || loserIdx < 0) {
    return null;
  }

  const winner = normalizeSkillRecord(skills[winnerIdx], skills[winnerIdx].scope);
  const loser = normalizeSkillRecord(skills[loserIdx], skills[loserIdx].scope);
  const updatedAt = new Date().toISOString();
  winner.supersedes = Array.from(new Set([...(winner.supersedes || []), loser.conflict_key, loser.id]));
  winner.status_history = [
    ...(winner.status_history || []),
    {
      status: winner.status,
      at: updatedAt,
      reason: `supersedes ${loser.id}`
    }
  ];
  const nextWinner = appendEvidence(winner, {
    type: 'skill_supersede_winner',
    at: updatedAt,
    scope: winner.scope,
    source_session: winner.source_session || null,
    source_project: winner.source_project || null,
    source_user: winner.source_user || null,
    actor: 'skill-supersede',
    reason: `supersedes ${loser.id}`,
    details: {
      loser_id: loser.id,
      loser_conflict_key: loser.conflict_key
    }
  });

  loser.superseded_by = winner.id;
  loser.status = 'inactive';
  loser.status_note = `superseded by ${winner.id}`;
  loser.status_updated_at = updatedAt;
  loser.status_history = [
    ...(loser.status_history || []),
    {
      status: 'inactive',
      at: loser.status_updated_at,
      reason: `superseded by ${winner.id}`
    }
  ];
  const nextLoser = appendEvidence(loser, {
    type: 'skill_superseded',
    at: updatedAt,
    scope: loser.scope,
    source_session: loser.source_session || null,
    source_project: loser.source_project || null,
    source_user: loser.source_user || null,
    actor: 'skill-supersede',
    reason: `superseded by ${winner.id}`,
    details: {
      winner_id: winner.id,
      winner_conflict_key: winner.conflict_key
    }
  });

  skills[winnerIdx] = nextWinner;
  skills[loserIdx] = nextLoser;
  return {
    winner: nextWinner,
    loser: nextLoser
  };
}

function runSkillSupersede(workspaceArg, scopeArg, winnerId, loserId, identifierArg) {
  if (!winnerId || !loserId) {
    throw new Error(
      'Usage: node skill-supersede.js <workspace> <scope> <winner-skill-id> <loser-skill-id> [project-id|user-id]'
    );
  }

  const scope = scopeArg || 'project';
  const paths = createPaths(workspaceArg);

  if (scope === 'user') {
    const userId = resolveUserId(identifierArg || DEFAULTS.userId);
    const skills = loadUserSkills(paths, userId);
    const result = applySupersede(skills, winnerId, loserId);
    if (!result) {
      throw new Error('Skill ids not found in user scope');
    }
    writeUserSkills(paths, userId, skills);
    return {
      status: 'updated',
      scope,
      user_id: userId,
      ...result
    };
  }

  const projectId = resolveProjectId(paths.workspace, identifierArg || DEFAULTS.projectId);
  const skills = loadProjectSkills(paths, projectId);
  const result = applySupersede(skills, winnerId, loserId);
  if (!result) {
    throw new Error('Skill ids not found in project scope');
  }
  writeProjectSkills(paths, projectId, skills);
  return {
    status: 'updated',
    scope: 'project',
    project_id: projectId,
    ...result
  };
}

function main() {
  try {
    const result = runSkillSupersede(
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
  runSkillSupersede
};
