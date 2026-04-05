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
const { field, section, status } = require('./lib/terminal-format');
const { runCliMain } = require('./lib/cli-runtime');

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

  const projectId = resolveProjectId(paths.workspace, identifierArg);
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

function parseArgs(argv) {
  return {
    workspace: argv[0],
    scope: argv[1],
    skillId: argv[2],
    statusValue: argv[3],
    identifier: argv[4],
    note: argv[5],
    json: argv.includes('--json')
  };
}

function renderSkillStatusUpdateReport(result) {
  const lines = [];
  lines.push(section('Context-Anchor Skill Status Update', { kind: 'success' }));
  lines.push(field('Status', status(String(result.status || 'updated').toUpperCase(), 'success'), { kind: 'success' }));
  lines.push(field('Scope', result.scope, { kind: 'info' }));
  if (result.session_key) {
    lines.push(field('Session', result.session_key, { kind: 'muted' }));
  }
  if (result.project_id) {
    lines.push(field('Project', result.project_id, { kind: 'muted' }));
  }
  if (result.user_id) {
    lines.push(field('User', result.user_id, { kind: 'muted' }));
  }
  lines.push(field('Skill', `${result.skill?.name || result.skill?.id || '-'} | status ${String(result.skill?.status || 'unknown').toUpperCase()}`, { kind: 'success' }));
  if (result.skill?.status_note) {
    lines.push(field('Note', result.skill.status_note, { kind: 'info' }));
  }
  return lines.join('\n');
}

function main() {
  return runCliMain(process.argv.slice(2), {
    parseArgs,
    run: async (options) =>
      runSkillStatusUpdate(
        options.workspace,
        options.scope,
        options.skillId,
        options.statusValue,
        options.identifier,
        options.note
      ),
    renderText: renderSkillStatusUpdateReport,
    errorTitle: 'Context-Anchor Skill Status Update Failed',
    errorNextStep: 'Check the scope, skill id, and target status, then rerun skill-status-update.'
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderSkillStatusUpdateReport,
  runSkillStatusUpdate
};
