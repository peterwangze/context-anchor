#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectSkills,
  loadSessionExperiences,
  loadSessionMemory,
  loadSessionState,
  loadUserExperiences,
  loadUserMemories,
  loadUserSkills,
  normalizeSkillRecord,
  resolveUserId,
  selectEffectiveSkills,
  sanitizeKey,
  sortByHeat,
  writeCompactPacket
} = require('./lib/context-anchor');

function summarizeSkills(skills) {
  return (skills || []).slice(0, 5).map((skill) => ({
    id: skill.id,
    name: skill.name,
    scope: skill.scope,
    status: skill.status || 'active',
    summary: skill.summary || skill.description || null
  }));
}

function runCompactPacketCreate(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, options.projectId, {
    createIfMissing: true,
    touch: true
  });
  const userId = resolveUserId(options.userId || sessionState.user_id || DEFAULTS.userId);
  const sessionMemories = sortByHeat(loadSessionMemory(paths, sessionKey)).filter((entry) => !entry.archived);
  const sessionExperiences = sortByHeat(loadSessionExperiences(paths, sessionKey)).filter((entry) => !entry.archived);
  const projectDecisions = sortByHeat(loadProjectDecisions(paths, sessionState.project_id)).filter((entry) => !entry.archived);
  const projectExperiences = sortByHeat(loadProjectExperiences(paths, sessionState.project_id)).filter((entry) => !entry.archived);
  const userMemories = sortByHeat(loadUserMemories(paths, userId)).filter((entry) => !entry.archived);
  const userExperiences = sortByHeat(loadUserExperiences(paths, userId)).filter((entry) => !entry.archived);
  const resolvedSkills = selectEffectiveSkills({
    session: require('./lib/context-anchor').loadSessionSkills(paths, sessionKey).map((skill) => normalizeSkillRecord(skill, 'session')),
    project: loadProjectSkills(paths, sessionState.project_id).map((skill) => normalizeSkillRecord(skill, 'project')),
    user: loadUserSkills(paths, userId).map((skill) => normalizeSkillRecord(skill, 'user'))
  });
  const packet = {
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: userId,
    created_at: new Date().toISOString(),
    reason: options.reason || 'pressure',
    usage_percent: options.usagePercent ?? null,
    active_task: sessionState.active_task,
    pending_commitments: (sessionState.commitments || []).filter((entry) => entry.status === 'pending'),
    session_memories: sessionMemories.slice(0, 8).map((entry) => ({
      id: entry.id,
      type: entry.type,
      summary: entry.summary || entry.content,
      heat: entry.heat
    })),
    session_experiences: sessionExperiences.slice(0, 5).map((entry) => ({
      id: entry.id,
      type: entry.type,
      summary: entry.summary,
      validation_status: entry.validation?.status || 'pending'
    })),
    project_memories: projectDecisions.slice(0, 4).map((entry) => ({
      id: entry.id,
      type: 'decision',
      summary: entry.decision,
      heat: entry.heat
    })),
    project_experiences: projectExperiences.slice(0, 4).map((entry) => ({
      id: entry.id,
      type: entry.type,
      summary: entry.summary,
      heat: entry.heat
    })),
    user_memories: userMemories.slice(0, 4).map((entry) => ({
      id: entry.id,
      type: entry.type || 'memory',
      summary: entry.summary || entry.content,
      heat: entry.heat || 50
    })),
    user_experiences: userExperiences.slice(0, 4).map((entry) => ({
      id: entry.id,
      type: entry.type,
      summary: entry.summary,
      heat: entry.heat
    })),
    active_skills: {
      session: summarizeSkills(resolvedSkills.effective.filter((skill) => skill.scope === 'session')),
      project: summarizeSkills(resolvedSkills.effective.filter((skill) => skill.scope === 'project')),
      user: summarizeSkills(resolvedSkills.effective.filter((skill) => skill.scope === 'user'))
    },
    skill_governance: {
      shadowed: summarizeSkills(resolvedSkills.shadowed),
      superseded: summarizeSkills(resolvedSkills.superseded),
      budgeted_out: summarizeSkills(resolvedSkills.budgeted_out)
    }
  };

  writeCompactPacket(paths, sessionKey, packet);

  return {
    status: 'created',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: userId,
    compact_packet_file: require('./lib/context-anchor').compactPacketFile(paths, sessionKey)
  };
}

function main() {
  const result = runCompactPacketCreate(process.argv[2], process.argv[3], {
    reason: process.argv[4],
    usagePercent: process.argv[5] ? Number(process.argv[5]) : undefined
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runCompactPacketCreate
};
