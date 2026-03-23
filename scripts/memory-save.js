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
  loadUserExperiences,
  loadUserMemories,
  loadUserState,
  normalizeValidation,
  nowIso,
  recordHeatEntry,
  recordUserHeatEntry,
  resolveProjectId,
  resolveUserId,
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
  ,
  writeUserExperiences,
  writeUserMemories,
  writeUserState
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

function resolveExistingIndex(entries, metadata) {
  if (metadata.entry_id) {
    const idxById = entries.findIndex((entry) => entry.id === metadata.entry_id);
    if (idxById >= 0) {
      return idxById;
    }
  }

  if (metadata.source_session_entry_id) {
    return entries.findIndex(
      (entry) => entry.source_session_entry_id === metadata.source_session_entry_id
    );
  }

  return -1;
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
  const idx = resolveExistingIndex(decisions, metadata);
  const existing = idx >= 0 ? decisions[idx] : null;
  const entry = {
    ...existing,
    id: existing?.id || metadata.entry_id || generateId('dec'),
    type: 'decision',
    decision: content,
    rationale: metadata.rationale ?? existing?.rationale ?? null,
    alternatives: Array.isArray(metadata.alternatives)
      ? metadata.alternatives
      : existing?.alternatives || [],
    session_key: sessionState.session_key,
    created_at: existing?.created_at || timestamp,
    last_accessed: timestamp,
    heat: clamp(
      Math.max(Number(existing?.heat || 0), Number(metadata.heat || existing?.heat || 80)),
      0,
      100
    ),
    access_count: Number(existing?.access_count || 0) + (metadata.skip_access_increment ? 0 : 1),
    access_sessions: uniqueList([
      ...(existing?.access_sessions || []),
      sessionState.session_key,
      ...(metadata.access_sessions || [])
    ]),
    tags: Array.isArray(metadata.tags) ? metadata.tags : existing?.tags || [],
    impact: metadata.impact || existing?.impact || 'medium',
    archived: false,
    source_session_entry_id: metadata.source_session_entry_id || existing?.source_session_entry_id || null
  };

  if (idx >= 0) {
    decisions[idx] = entry;
  } else {
    decisions.push(entry);
  }
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
  const idx = resolveExistingIndex(experiences, metadata);
  const existing = idx >= 0 ? experiences[idx] : null;
  const entry = {
    ...existing,
    id: existing?.id || metadata.entry_id || generateId('exp'),
    type: normalizedType,
    summary: metadata.summary || content,
    details:
      Object.prototype.hasOwnProperty.call(metadata, 'details') ? metadata.details : existing?.details ?? null,
    solution:
      Object.prototype.hasOwnProperty.call(metadata, 'solution')
        ? metadata.solution
        : existing?.solution ?? null,
    source: metadata.source || existing?.source || 'agent-observation',
    session_key: sessionState.session_key,
    created_at: existing?.created_at || timestamp,
    last_accessed: timestamp,
    heat: clamp(
      Math.max(Number(existing?.heat || 0), Number(metadata.heat || existing?.heat || 60)),
      0,
      100
    ),
    applied_count: Math.max(
      Number(existing?.applied_count || 0),
      Number(metadata.applied_count || existing?.applied_count || 0)
    ),
    access_count:
      Number(existing?.access_count || 0) +
      (metadata.skip_access_increment ? 0 : Number(metadata.access_count || 1)),
    access_sessions: uniqueList([
      ...(existing?.access_sessions || []),
      sessionState.session_key,
      ...(metadata.access_sessions || [])
    ]),
    tags: Array.isArray(metadata.tags) ? metadata.tags : existing?.tags || [],
    validation: normalizeValidation(
      metadata.validation ||
        (metadata.validation_status ? { status: metadata.validation_status } : existing?.validation || {})
    ),
    archived: false,
    source_session_entry_id: metadata.source_session_entry_id || existing?.source_session_entry_id || null
  };

  if (idx >= 0) {
    experiences[idx] = entry;
  } else {
    experiences.push(entry);
  }
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
  const idx = resolveExistingIndex(facts, metadata);
  const existing = idx >= 0 ? facts[idx] : null;
  const entry = {
    ...existing,
    id: existing?.id || metadata.entry_id || generateId('fact'),
    content,
    summary: metadata.summary || content,
    session_key: sessionState.session_key,
    created_at: existing?.created_at || timestamp,
    last_accessed: timestamp,
    heat: clamp(
      Math.max(Number(existing?.heat || 0), Number(metadata.heat || existing?.heat || 50)),
      0,
      100
    ),
    access_count:
      Number(existing?.access_count || 0) +
      (metadata.skip_access_increment ? 0 : Number(metadata.access_count || 1)),
    access_sessions: uniqueList([
      ...(existing?.access_sessions || []),
      sessionState.session_key,
      ...(metadata.access_sessions || [])
    ]),
    tags: Array.isArray(metadata.tags) ? metadata.tags : existing?.tags || [],
    archived: false,
    source_session_entry_id: metadata.source_session_entry_id || existing?.source_session_entry_id || null
  };

  if (idx >= 0) {
    facts[idx] = entry;
  } else {
    facts.push(entry);
  }
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

  if (scope === 'global' || scope === 'user') {
    const userState = loadUserState(paths, sessionState.user_id);
    userState.preferences[key.trim()] = value;
    userState.last_updated = nowIso();
    writeUserState(paths, sessionState.user_id, userState);

    return {
      scope: 'user',
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
  const userId = resolveUserId(metadata.user_id);
  const userState = loadUserState(paths, userId);
  const userMemories = loadUserMemories(paths, userId);
  const userExperiences = loadUserExperiences(paths, userId);
  const timestamp = nowIso();

  if (type === 'preference') {
    const [key, ...valueParts] = String(content || '').split(':');
    const value = valueParts.join(':').trim();
    if (!key || !value) {
      throw new Error('Preference content must use "key:value" format.');
    }

    userState.preferences[key.trim()] = value;
    userState.last_updated = timestamp;
    writeUserState(paths, userId, userState);
    return {
      scope: 'user',
      id: `pref-${key.trim()}`,
      type
    };
  }

  if (type === 'lesson' || type === 'best_practice' || type === 'tool-pattern' || type === 'gotcha' || type === 'feature_request') {
    const idx = resolveExistingIndex(userExperiences, metadata);
    const existing = idx >= 0 ? userExperiences[idx] : null;
    const entry = {
      ...existing,
      id: existing?.id || metadata.entry_id || generateId('user-exp'),
      scope: 'user',
      type,
      summary: metadata.summary || content,
      details:
        Object.prototype.hasOwnProperty.call(metadata, 'details') ? metadata.details : existing?.details ?? null,
      solution:
        Object.prototype.hasOwnProperty.call(metadata, 'solution') ? metadata.solution : existing?.solution ?? null,
      source: metadata.source || existing?.source || 'agent-observation',
      source_user: userId,
      created_at: existing?.created_at || timestamp,
      last_accessed: timestamp,
      heat: clamp(
        Math.max(Number(existing?.heat || 0), Number(metadata.heat || existing?.heat || 60)),
        0,
        100
      ),
      access_count:
        Number(existing?.access_count || 0) +
        (metadata.skip_access_increment ? 0 : Number(metadata.access_count || 1)),
      access_sessions: uniqueList([...(existing?.access_sessions || []), ...(metadata.access_sessions || [])]),
      tags: Array.isArray(metadata.tags) ? metadata.tags : existing?.tags || [],
      validation: normalizeValidation(
        metadata.validation ||
          (metadata.validation_status ? { status: metadata.validation_status } : existing?.validation || {})
      ),
      archived: false,
      source_session_entry_id: metadata.source_session_entry_id || existing?.source_session_entry_id || null
    };
    if (idx >= 0) {
      userExperiences[idx] = entry;
    } else {
      userExperiences.push(entry);
    }
    writeUserExperiences(paths, userId, userExperiences);
    recordUserHeatEntry(paths, userId, entry);
    userState.key_experiences = uniqueList([...(userState.key_experiences || []), entry.id]).slice(0, 20);
    userState.last_updated = timestamp;
    writeUserState(paths, userId, userState);
    return {
      scope: 'user',
      id: entry.id,
      type
    };
  }

  const idx = resolveExistingIndex(userMemories, metadata);
  const entry = {
    ...(idx >= 0 ? userMemories[idx] : {}),
    id:
      (idx >= 0 ? userMemories[idx].id : null) ||
      metadata.entry_id ||
      generateId('user-mem'),
    scope: 'user',
    type: type || 'memory',
    content,
    summary: metadata.summary || content,
    source_user: userId,
    created_at: idx >= 0 ? userMemories[idx].created_at : timestamp,
    last_accessed: timestamp,
    heat: clamp(Math.max(Number((idx >= 0 ? userMemories[idx].heat : 0) || 0), Number(metadata.heat || 60)), 0, 100),
    access_count:
      Number((idx >= 0 ? userMemories[idx].access_count : 0) || 0) +
      (metadata.skip_access_increment ? 0 : Number(metadata.access_count || 1)),
    access_sessions: uniqueList([...(idx >= 0 ? userMemories[idx].access_sessions || [] : []), ...(metadata.access_sessions || [])]),
    validation: normalizeValidation(metadata.validation || { status: metadata.validation_status }),
    source_session_entry_id:
      metadata.source_session_entry_id ||
      (idx >= 0 ? userMemories[idx].source_session_entry_id : null),
    archived: false
  };
  if (idx >= 0) {
    userMemories[idx] = entry;
  } else {
    userMemories.push(entry);
  }
  writeUserMemories(paths, userId, userMemories);
  recordUserHeatEntry(paths, userId, entry);
  userState.key_memories = uniqueList([...(userState.key_memories || []), entry.id]).slice(0, 20);
  userState.last_updated = timestamp;
  writeUserState(paths, userId, userState);

  return {
    scope: 'user',
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
  const projectId = resolveProjectId(paths.workspace, metadata.project_id);
  const sessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: true,
    touch: true
  });
  sessionState.user_id = resolveUserId(metadata.user_id || sessionState.user_id || DEFAULTS.userId);

  ensureProjectArtifacts(paths, sessionState.project_id);

  let result;
  if (scope === 'session') {
    result = saveToSession(paths, sessionState, type, content, metadata);
  } else if (scope === 'global' || scope === 'user') {
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
