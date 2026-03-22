#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  createPaths,
  ensureAnchorDirs,
  getRecentSessions,
  loadGlobalState,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectState,
  loadSessionState,
  mergeAccessMetadata,
  readText,
  recordHeatEntry,
  sanitizeKey,
  sessionCheckpointFile,
  sortByHeat,
  syncProjectStateMetadata,
  touchGlobalIndex,
  touchSessionIndex,
  writeProjectDecisions,
  writeProjectExperiences
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
  const projectId = projectIdArg || DEFAULTS.projectId;
  const checkpointFile = sessionCheckpointFile(paths, sessionKey);
  const hadCheckpoint = fs.existsSync(checkpointFile);

  const sessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: true,
    touch: true
  });
  const projectState = loadProjectState(paths, sessionState.project_id);
  const loadedDecisions = loadProjectDecisions(paths, sessionState.project_id);
  const loadedExperiences = loadProjectExperiences(paths, sessionState.project_id);
  const decisions = sortByHeat(loadedDecisions).filter(
    (entry) => !entry.archived
  );
  const experiences = sortByHeat(loadedExperiences).filter(
    (entry) => !entry.archived
  );
  const globalState = loadGlobalState(paths);
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
    recovery: {
      active_task: sessionState.active_task,
      pending_commitments: pendingCommitments,
      checkpoint_available: hadCheckpoint,
      checkpoint_excerpt: checkpoint ? checkpoint.split('\n').slice(0, 10).join('\n') : null
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

  if (Object.keys(globalState.user_preferences || {}).length > 0) {
    summary.memories_to_inject.push({
      source: 'global_preferences',
      entries: Object.entries(globalState.user_preferences).map(([key, value]) => ({
        key,
        value
      }))
    });
  }

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
