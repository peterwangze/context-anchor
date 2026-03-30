#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  generateId,
  loadSessionExperiences,
  loadSessionMemory,
  loadSessionState,
  normalizeValidation,
  resolveUserId,
  sanitizeKey,
  writeSessionExperiences
} = require('./lib/context-anchor');

const EXPERIENCE_MEMORY_TYPES = new Set(['lesson', 'best_practice', 'tool-pattern', 'gotcha', 'feature_request']);

function isDerivableMemory(entry = {}) {
  return !entry.archived && EXPERIENCE_MEMORY_TYPES.has(entry.type);
}

function createDefaultLoadPolicy(existing = {}) {
  return {
    auto_load: existing.auto_load ?? existing.load_policy?.auto_load ?? true,
    priority: Number(existing.load_policy?.priority ?? 80),
    budget_weight: Number(existing.load_policy?.budget_weight ?? 1)
  };
}

function buildDerivedExperience(sessionState, memoryEntry, existing = {}, timestamp) {
  return {
    ...existing,
    id: existing.id || generateId('sess-exp'),
    scope: 'session',
    type: memoryEntry.type,
    summary: memoryEntry.summary || memoryEntry.content,
    details: memoryEntry.details || null,
    solution: memoryEntry.solution || null,
    source_memory_id: memoryEntry.id,
    source_session: sessionState.session_key,
    source_project: sessionState.project_id,
    source_user: resolveUserId(sessionState.user_id),
    created_at: existing.created_at || timestamp,
    updated_at: timestamp,
    heat: Math.max(DEFAULTS.warmMemoryHeat, Number(existing.heat || 0), Number(memoryEntry.heat || 0)),
    access_count: Math.max(Number(existing.access_count || 0), 1),
    access_sessions: Array.from(new Set([...(existing.access_sessions || []), sessionState.session_key])),
    validation: normalizeValidation(existing.validation),
    promotion_history: Array.isArray(existing.promotion_history) ? existing.promotion_history : [],
    load_policy: createDefaultLoadPolicy(existing),
    archived: false,
    archived_at: null
  };
}

function buildExperienceFingerprint(entry = {}) {
  return JSON.stringify({
    type: entry.type || null,
    summary: entry.summary || null,
    details: entry.details || null,
    solution: entry.solution || null,
    source_memory_id: entry.source_memory_id || null,
    source_session: entry.source_session || null,
    source_project: entry.source_project || null,
    source_user: entry.source_user || null,
    heat: Number(entry.heat || 0),
    archived: Boolean(entry.archived)
  });
}

function archiveDerivedExperience(existing, timestamp) {
  return {
    ...existing,
    archived: true,
    archived_at: existing.archived_at || timestamp,
    updated_at: timestamp
  };
}

function runSessionExperienceSync(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, options.projectId, {
    createIfMissing: true,
    touch: true,
    userId: options.userId
  });
  const timestamp = new Date().toISOString();
  const sessionMemories = loadSessionMemory(paths, sessionState.session_key);
  const existingExperiences = loadSessionExperiences(paths, sessionState.session_key);
  const derivableMemories = sessionMemories.filter(isDerivableMemory);
  const derivableBySourceMemoryId = new Map(derivableMemories.map((entry) => [entry.id, entry]));
  const consumedSourceMemoryIds = new Set();
  let created = 0;
  let updated = 0;
  let archived = 0;
  let unchanged = 0;

  const nextExperiences = existingExperiences.map((existing) => {
    if (!existing.source_memory_id) {
      unchanged += 1;
      return existing;
    }

    const sourceMemory = derivableBySourceMemoryId.get(existing.source_memory_id);
    if (!sourceMemory) {
      if (existing.archived) {
        unchanged += 1;
        return existing;
      }

      archived += 1;
      return archiveDerivedExperience(existing, timestamp);
    }

    consumedSourceMemoryIds.add(sourceMemory.id);
    const nextExperience = buildDerivedExperience(sessionState, sourceMemory, existing, timestamp);
    if (buildExperienceFingerprint(existing) === buildExperienceFingerprint(nextExperience)) {
      unchanged += 1;
      return existing;
    }

    updated += 1;
    return nextExperience;
  });

  derivableMemories.forEach((memoryEntry) => {
    if (consumedSourceMemoryIds.has(memoryEntry.id)) {
      return;
    }

    created += 1;
    nextExperiences.push(buildDerivedExperience(sessionState, memoryEntry, {}, timestamp));
  });

  writeSessionExperiences(paths, sessionState.session_key, nextExperiences);

  return {
    status: 'synced',
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: resolveUserId(sessionState.user_id),
    scanned_memories: sessionMemories.length,
    derivable_memories: derivableMemories.length,
    total_experiences: nextExperiences.length,
    active_experiences: nextExperiences.filter((entry) => !entry.archived).length,
    created,
    updated,
    archived,
    unchanged
  };
}

function main() {
  const result = runSessionExperienceSync(process.argv[2], process.argv[3], {
    projectId: process.argv[4],
    userId: process.argv[5]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  EXPERIENCE_MEMORY_TYPES,
  runSessionExperienceSync
};
