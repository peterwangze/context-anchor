#!/usr/bin/env node

const {
  DEFAULTS,
  SKILL_STATUSES,
  createPaths,
  loadProjectSkills,
  loadSessionSkills,
  loadUserSkills,
  resolveProjectId,
  resolveUserId,
  sanitizeKey,
  writeProjectSkills,
  writeSessionSkills,
  writeUserSkills
} = require('./lib/context-anchor');

function updateSkillStatus(skills, skillId, status, note) {
  const idx = skills.findIndex((skill) => skill.id === skillId);
  if (idx < 0) {
    return null;
  }

  skills[idx] = {
    ...skills[idx],
    status,
    archived: status === 'archived',
    status_updated_at: new Date().toISOString(),
    status_note: note || null,
    status_history: [
      ...(skills[idx].status_history || []),
      {
        status,
        at: new Date().toISOString(),
        reason: note || 'manual-update'
      }
    ]
  };
  return skills[idx];
}

function runSkillStatusUpdate(workspaceArg, scopeArg, skillId, statusArg, identifierArg, noteArg) {
  if (!skillId || !statusArg) {
    throw new Error(
      'Usage: node skill-status-update.js <workspace> <scope> <skill-id> <status> [session-key|project-id|user-id] [note]'
    );
  }

  if (!SKILL_STATUSES.includes(statusArg)) {
    throw new Error(`Skill status must be one of: ${SKILL_STATUSES.join(', ')}`);
  }

  const paths = createPaths(workspaceArg);
  const scope = scopeArg || 'project';

  if (scope === 'session') {
    const sessionKey = sanitizeKey(identifierArg || DEFAULTS.sessionKey);
    const skills = loadSessionSkills(paths, sessionKey);
    const updated = updateSkillStatus(skills, skillId, statusArg, noteArg);
    if (!updated) {
      throw new Error(`Session skill ${skillId} not found`);
    }
    writeSessionSkills(paths, sessionKey, skills);
    return {
      status: 'updated',
      scope,
      session_key: sessionKey,
      skill: updated
    };
  }

  if (scope === 'user') {
    const userId = resolveUserId(identifierArg || DEFAULTS.userId);
    const skills = loadUserSkills(paths, userId);
    const updated = updateSkillStatus(skills, skillId, statusArg, noteArg);
    if (!updated) {
      throw new Error(`User skill ${skillId} not found`);
    }
    writeUserSkills(paths, userId, skills);
    return {
      status: 'updated',
      scope,
      user_id: userId,
      skill: updated
    };
  }

  const projectId = resolveProjectId(paths.workspace, identifierArg || DEFAULTS.projectId);
  const skills = loadProjectSkills(paths, projectId);
  const updated = updateSkillStatus(skills, skillId, statusArg, noteArg);
  if (!updated) {
    throw new Error(`Project skill ${skillId} not found`);
  }
  writeProjectSkills(paths, projectId, skills);
  return {
    status: 'updated',
    scope: 'project',
    project_id: projectId,
    skill: updated
  };
}

function main() {
  try {
    const result = runSkillStatusUpdate(
      process.argv[2],
      process.argv[3],
      process.argv[4],
      process.argv[5],
      process.argv[6],
      process.argv[7]
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
  runSkillStatusUpdate
};
