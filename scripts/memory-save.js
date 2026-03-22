#!/usr/bin/env node

const {
  DEFAULTS,
  clamp,
  createPaths,
  ensureAnchorDirs,
  ensureProjectArtifacts,
  generateId,
  loadGlobalState,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadProjectState,
  loadSessionMemory,
  loadSessionState,
  normalizeValidation,
  nowIso,
  recordHeatEntry,
  sanitizeKey,
  syncProjectStateMetadata,
  touchSessionIndex,
  uniqueList,
  writeGlobalState,
  writeProjectDecisions,
  writeProjectExperiences,
  writeProjectFacts,
  writeProjectState,
  writeSessionMemory,
  writeSessionState
} = require('./lib/context-anchor');

function parseMetadata(rawValue) {
  if (!rawValue) {
    return {};
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return {};
  }
}

function normalizeType(type) {
  const value = String(type || 'fact').trim();

  if (value === 'error') {
    return 'lesson';
  }

  if (value === 'experience') {
    return 'best_practice';
  }

  return value;
}

function saveToSession(paths, sessionState, type, content, metadata) {
  const entries = loadSessionMemory(paths, sessionState.session_key);
  const timestamp = nowIso();
  const entry = {
    id: generateId('mem'),
    type,
    content,
    summary: metadata.summary || content,
    details: metadata.details || null,
    solution: metadata.solution || null,
    heat: clamp(Number(metadata.heat || 100), 0, 100),
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    created_at: timestamp,
    last_accessed: timestamp,
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    scope: metadata.scope || 'session',
    sync_to_project: metadata.sync_to_project !== false,
    archived: false
  };

  entries.push(entry);
  writeSessionMemory(paths, sessionState.session_key, entries);

  sessionState.notes_count = Number(sessionState.notes_count || 0) + 1;
  writeSessionState(paths, sessionState.session_key, sessionState);

  return {
    scope: 'session',
    id: entry.id,
    type: entry.type,
    heat: entry.heat
  };
}

function saveDecision(paths, sessionState, content, metadata) {
  const decisions = loadProjectDecisions(paths, sessionState.project_id);
  const timestamp = nowIso();
  const entry = {
    id: generateId('dec'),
    type: 'decision',
    decision: content,
    rationale: metadata.rationale || null,
    alternatives: Array.isArray(metadata.alternatives) ? metadata.alternatives : [],
    session_key: sessionState.session_key,
    created_at: timestamp,
    last_accessed: timestamp,
    heat: clamp(Number(metadata.heat || 80), 0, 100),
    access_count: 1,
    access_sessions: [sessionState.session_key],
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    impact: metadata.impact || 'medium',
    archived: false
  };

  decisions.push(entry);
  writeProjectDecisions(paths, sessionState.project_id, decisions);
  recordHeatEntry(paths, sessionState.project_id, entry);
  syncProjectStateMetadata(paths, sessionState.project_id);

  return {
    scope: 'project',
    id: entry.id,
    type: entry.type,
    heat: entry.heat
  };
}

function saveExperience(paths, sessionState, type, content, metadata) {
  const experiences = loadProjectExperiences(paths, sessionState.project_id);
  const timestamp = nowIso();
  const normalizedType = normalizeType(type);
  const entry = {
    id: generateId('exp'),
    type: normalizedType,
    summary: metadata.summary || content,
    details: metadata.details || null,
    solution: metadata.solution || null,
    source: metadata.source || 'agent-observation',
    session_key: sessionState.session_key,
    created_at: timestamp,
    last_accessed: timestamp,
    heat: clamp(Number(metadata.heat || 60), 0, 100),
    applied_count: Number(metadata.applied_count || 0),
    access_count: Number(metadata.access_count || 1),
    access_sessions: uniqueList([sessionState.session_key, ...(metadata.access_sessions || [])]),
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    validation: normalizeValidation(metadata.validation || { status: metadata.validation_status }),
    archived: false
  };

  experiences.push(entry);
  writeProjectExperiences(paths, sessionState.project_id, experiences);
  recordHeatEntry(paths, sessionState.project_id, entry);

  sessionState.experiences_count = Number(sessionState.experiences_count || 0) + 1;
  writeSessionState(paths, sessionState.session_key, sessionState);
  syncProjectStateMetadata(paths, sessionState.project_id);

  return {
    scope: 'project',
    id: entry.id,
    type: entry.type,
    heat: entry.heat,
    validation_status: entry.validation.status
  };
}

function saveFact(paths, sessionState, content, metadata) {
  const facts = loadProjectFacts(paths, sessionState.project_id);
  const timestamp = nowIso();
  const entry = {
    id: generateId('fact'),
    content,
    summary: metadata.summary || content,
    session_key: sessionState.session_key,
    created_at: timestamp,
    last_accessed: timestamp,
    heat: clamp(Number(metadata.heat || 50), 0, 100),
    access_count: Number(metadata.access_count || 1),
    access_sessions: [sessionState.session_key],
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    archived: false
  };

  facts.push(entry);
  writeProjectFacts(paths, sessionState.project_id, facts);
  recordHeatEntry(paths, sessionState.project_id, {
    ...entry,
    type: 'fact'
  });
  syncProjectStateMetadata(paths, sessionState.project_id);

  return {
    scope: 'project',
    id: entry.id,
    type: 'fact',
    heat: entry.heat
  };
}

function savePreference(paths, sessionState, scope, content) {
  const [key, ...valueParts] = String(content || '').split(':');
  const value = valueParts.join(':').trim();

  if (!key || !value) {
    throw new Error('Preference content must use "key:value" format.');
  }

  if (scope === 'global') {
    const globalState = loadGlobalState(paths);
    globalState.user_preferences[key.trim()] = value;
    writeGlobalState(paths, globalState);

    return {
      scope: 'global',
      id: `pref-${key.trim()}`,
      type: 'preference'
    };
  }

  const state = loadProjectState(paths, sessionState.project_id);
  state.user_preferences[key.trim()] = value;
  writeProjectState(paths, sessionState.project_id, state);
  syncProjectStateMetadata(paths, sessionState.project_id);

  return {
    scope: 'project',
    id: `pref-${key.trim()}`,
    type: 'preference'
  };
}

function saveToGlobal(paths, type, content, metadata) {
  const globalState = loadGlobalState(paths);
  const timestamp = nowIso();

  if (type === 'preference') {
    const [key, ...valueParts] = String(content || '').split(':');
    const value = valueParts.join(':').trim();
    if (!key || !value) {
      throw new Error('Preference content must use "key:value" format.');
    }

    globalState.user_preferences[key.trim()] = value;
    writeGlobalState(paths, globalState);
    return {
      scope: 'global',
      id: `pref-${key.trim()}`,
      type
    };
  }

  globalState.important_facts = Array.isArray(globalState.important_facts)
    ? globalState.important_facts
    : [];
  globalState.important_facts.push({
    id: generateId('glob'),
    content,
    summary: metadata.summary || content,
    created_at: timestamp
  });
  writeGlobalState(paths, globalState);

  return {
    scope: 'global',
    type: type || 'fact'
  };
}

function runMemorySave(workspaceArg, sessionKeyArg, scopeArg, typeArg, contentArg, metadataArg) {
  const paths = createPaths(workspaceArg);
  ensureAnchorDirs(paths);

  const scope = scopeArg || 'project';
  const type = normalizeType(typeArg || 'fact');
  const content = contentArg || '';
  const metadata = parseMetadata(metadataArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, metadata.project_id || DEFAULTS.projectId, {
    createIfMissing: true,
    touch: true
  });

  ensureProjectArtifacts(paths, sessionState.project_id);

  let result;
  if (scope === 'session') {
    result = saveToSession(paths, sessionState, type, content, metadata);
  } else if (scope === 'global') {
    result = saveToGlobal(paths, type, content, metadata);
  } else if (type === 'decision') {
    result = saveDecision(paths, sessionState, content, metadata);
  } else if (type === 'preference') {
    result = savePreference(paths, sessionState, scope, content);
  } else if (type === 'lesson' || type === 'best_practice' || type === 'tool-pattern' || type === 'gotcha' || type === 'feature_request') {
    result = saveExperience(paths, sessionState, type, content, metadata);
  } else {
    result = saveFact(paths, sessionState, content, metadata);
  }

  touchSessionIndex(paths, sessionState);

  return {
    status: 'saved',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    timestamp: nowIso(),
    ...result
  };
}

function main() {
  try {
    const result = runMemorySave(
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
  runMemorySave
};
