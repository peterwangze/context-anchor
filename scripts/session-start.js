#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  createPaths,
  ensureAnchorDirs,
  getRecentSessions,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectSkills,
  loadProjectState,
  loadSessionSkills,
  loadSessionState,
  loadUserExperiences,
  loadUserMemories,
  loadUserSkills,
  loadUserState,
  mergeAccessMetadata,
  normalizeSkillRecord,
  readText,
  recordHeatEntry,
  recordUserHeatEntry,
  resolveProjectId,
  resolveUserId,
  selectEffectiveSkills,
  sanitizeKey,
  sessionCheckpointFile,
  sortByHeat,
  syncProjectStateMetadata,
  touchGlobalIndex,
  touchSessionIndex,
  writeProjectDecisions,
  writeProjectExperiences,
  writeSessionState,
  writeUserExperiences,
  writeUserMemories
} = require('./lib/context-anchor');

function detectLegacyMemory(workspace) {
  const results = [];
  const memoryFile = path.join(workspace, 'MEMORY.md');
  const memoryDir = path.join(workspace, 'memory');

  if (fs.existsSync(memoryFile)) {
    results.push('MEMORY.md');
  }

  if (fs.existsSync(memoryDir)) {
    results.push('memory/');
  }

  return results;
}

function runSessionStart(workspaceArg, sessionKeyArg, projectIdArg) {
  const paths = createPaths(workspaceArg);
  ensureAnchorDirs(paths);

  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const checkpointFile = sessionCheckpointFile(paths, sessionKey);
  const hadCheckpoint = fs.existsSync(checkpointFile);

  const sessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: true,
    touch: true
  });
  sessionState.user_id = resolveUserId(sessionState.user_id || DEFAULTS.userId);
  writeSessionState(paths, sessionState.session_key, sessionState);
  const projectState = loadProjectState(paths, sessionState.project_id);
  const loadedDecisions = loadProjectDecisions(paths, sessionState.project_id);
  const loadedExperiences = loadProjectExperiences(paths, sessionState.project_id);
  const projectSkills = loadProjectSkills(paths, sessionState.project_id);
  const sessionSkills = loadSessionSkills(paths, sessionState.session_key);
  const decisions = sortByHeat(loadedDecisions).filter(
    (entry) => !entry.archived
  );
  const experiences = sortByHeat(loadedExperiences).filter(
    (entry) => !entry.archived
  );
  const userState = loadUserState(paths, sessionState.user_id);
  const userMemories = sortByHeat(loadUserMemories(paths, sessionState.user_id)).filter((entry) => !entry.archived);
  const userExperiences = sortByHeat(loadUserExperiences(paths, sessionState.user_id)).filter((entry) => !entry.archived);
  const userSkills = loadUserSkills(paths, sessionState.user_id);
  const checkpoint = hadCheckpoint ? readText(checkpointFile, '') : '';
  const relatedSessions = getRecentSessions(paths)
    .filter(
      (entry) =>
        entry.project_id === sessionState.project_id && entry.session_key !== sessionState.session_key
    )
    .slice(0, 3);

  touchSessionIndex(paths, sessionState);
  const injectedDecisionIds = decisions
    .filter((entry) => Number(entry.heat || 0) >= 70)
    .slice(0, 5)
    .map((entry) => entry.id);
  const injectedExperienceIds = experiences
    .filter((entry) => Number(entry.heat || 0) >= 60)
    .slice(0, 5)
    .map((entry) => entry.id);
  const injectedUserMemoryIds = userMemories
    .filter((entry) => Number(entry.heat || 0) >= 60)
    .slice(0, 5)
    .map((entry) => entry.id);
  const injectedUserExperienceIds = userExperiences
    .filter((entry) => Number(entry.heat || 0) >= 60)
    .slice(0, 5)
    .map((entry) => entry.id);

  if (injectedDecisionIds.length > 0) {
    const nextDecisions = loadedDecisions.map((entry) => {
      if (!injectedDecisionIds.includes(entry.id)) {
        return entry;
      }

      const isCrossSession = !(entry.access_sessions || []).includes(sessionState.session_key);
      const nextEntry = mergeAccessMetadata(entry, sessionState.session_key, {
        heatDelta: isCrossSession ? 10 : 5
      });
      recordHeatEntry(paths, sessionState.project_id, {
        ...nextEntry,
        type: 'decision'
      });
      return nextEntry;
    });
    writeProjectDecisions(paths, sessionState.project_id, nextDecisions);
  }

  if (injectedExperienceIds.length > 0) {
    const nextExperiences = loadedExperiences.map((entry) => {
      if (!injectedExperienceIds.includes(entry.id)) {
        return entry;
      }

      const isCrossSession = !(entry.access_sessions || []).includes(sessionState.session_key);
      const nextEntry = mergeAccessMetadata(entry, sessionState.session_key, {
        heatDelta: isCrossSession ? 10 : 5
      });
      recordHeatEntry(paths, sessionState.project_id, {
        ...nextEntry,
        type: entry.type || 'experience'
      });
      return nextEntry;
    });
    writeProjectExperiences(paths, sessionState.project_id, nextExperiences);
  }

  if (injectedUserMemoryIds.length > 0) {
    const nextUserMemories = userMemories.map((entry) => {
      if (!injectedUserMemoryIds.includes(entry.id)) {
        return entry;
      }

      const isCrossSession = !(entry.access_sessions || []).includes(sessionState.session_key);
      const nextEntry = mergeAccessMetadata(entry, sessionState.session_key, {
        heatDelta: isCrossSession ? 10 : 5
      });
      recordUserHeatEntry(paths, sessionState.user_id, nextEntry);
      return nextEntry;
    });
    writeUserMemories(paths, sessionState.user_id, nextUserMemories);
  }

  if (injectedUserExperienceIds.length > 0) {
    const nextUserExperiences = userExperiences.map((entry) => {
      if (!injectedUserExperienceIds.includes(entry.id)) {
        return entry;
      }

      const isCrossSession = !(entry.access_sessions || []).includes(sessionState.session_key);
      const nextEntry = mergeAccessMetadata(entry, sessionState.session_key, {
        heatDelta: isCrossSession ? 10 : 5
      });
      recordUserHeatEntry(paths, sessionState.user_id, nextEntry);
      return nextEntry;
    });
    writeUserExperiences(paths, sessionState.user_id, nextUserExperiences);
  }

  syncProjectStateMetadata(paths, sessionState.project_id);
  touchGlobalIndex(paths);

  const pendingCommitments = (sessionState.commitments || []).filter(
    (entry) => entry.status === 'pending'
  );

  const summary = {
    status: 'initialized',
    session: {
      key: sessionState.session_key,
      project: sessionState.project_id,
      user: sessionState.user_id,
      restored: hadCheckpoint || pendingCommitments.length > 0 || Boolean(sessionState.active_task)
    },
    project: {
      id: sessionState.project_id,
      name: projectState.name,
      decisions_count: decisions.length,
      experiences_count: experiences.length,
      key_decisions: projectState.key_decisions || [],
      key_experiences: projectState.key_experiences || []
    },
    user: {
      id: sessionState.user_id,
      preferences_count: Object.keys(userState.preferences || {}).length,
      memories_count: userMemories.length,
      experiences_count: userExperiences.length,
      skills_count: userSkills.length
    },
    recovery: {
      active_task: sessionState.active_task,
      pending_commitments: pendingCommitments,
      checkpoint_available: hadCheckpoint,
      checkpoint_excerpt: checkpoint ? checkpoint.split('\n').slice(0, 10).join('\n') : null
    },
    boot_packet: {
      active_task: sessionState.active_task,
      pending_commitments: pendingCommitments,
      active_skills: {
        session: sessionSkills.slice(0, 5),
        project: projectSkills.slice(0, 5),
        user: userSkills.slice(0, 5)
      }
    },
    memories_to_inject: [],
    related_sessions: relatedSessions,
    compatibility: {
      legacy_memory_files: detectLegacyMemory(paths.workspace)
    }
  };

  if (decisions.length > 0) {
    summary.memories_to_inject.push({
      source: 'project_decisions',
      entries: decisions.slice(0, 5).map((entry) => ({
        id: entry.id,
        decision: entry.decision,
        heat: entry.heat
      }))
    });
  }

  if (experiences.length > 0) {
    summary.memories_to_inject.push({
      source: 'project_experiences',
      entries: experiences.slice(0, 5).map((entry) => ({
        id: entry.id,
        type: entry.type,
        summary: entry.summary,
        heat: entry.heat,
        validation_status: entry.validation?.status || 'pending'
      }))
    });
  }

  if (Object.keys(userState.preferences || {}).length > 0) {
    summary.memories_to_inject.push({
      source: 'user_preferences',
      entries: Object.entries(userState.preferences).map(([key, value]) => ({
        key,
        value
      }))
    });
  }

  if (userMemories.length > 0) {
    summary.memories_to_inject.push({
      source: 'user_memories',
      entries: userMemories.slice(0, 5).map((entry) => ({
        id: entry.id,
        summary: entry.summary || entry.content,
        heat: entry.heat
      }))
    });
  }

  if (userExperiences.length > 0) {
    summary.memories_to_inject.push({
      source: 'user_experiences',
      entries: userExperiences.slice(0, 5).map((entry) => ({
        id: entry.id,
        type: entry.type,
        summary: entry.summary,
        heat: entry.heat,
        validation_status: entry.validation?.status || 'pending'
      }))
    });
  }

  const resolvedSkills = selectEffectiveSkills({
    session: sessionSkills.map((skill) => normalizeSkillRecord(skill, 'session')),
    project: projectSkills.map((skill) => normalizeSkillRecord(skill, 'project')),
    user: userSkills.map((skill) => normalizeSkillRecord(skill, 'user'))
  });

  summary.skills_to_activate = {
    session: sessionSkills.slice(0, 5),
    project: projectSkills.slice(0, 5),
    user: userSkills.slice(0, 5)
  };
  summary.effective_skills = resolvedSkills.effective;
  summary.shadowed_skills = resolvedSkills.shadowed;
  summary.boot_packet.active_skills = {
    session: resolvedSkills.effective.filter((skill) => skill.scope === 'session'),
    project: resolvedSkills.effective.filter((skill) => skill.scope === 'project'),
    user: resolvedSkills.effective.filter((skill) => skill.scope === 'user')
  };

  return summary;
}

function main() {
  const result = runSessionStart(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSessionStart
};
