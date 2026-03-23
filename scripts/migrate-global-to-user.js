#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  loadGlobalState,
  loadUserExperiences,
  loadUserMemories,
  loadUserState,
  resolveUserId,
  writeUserExperiences,
  writeUserMemories,
  writeUserState
} = require('./lib/context-anchor');

function runMigrateGlobalToUser(workspaceArg, userIdArg) {
  const paths = createPaths(workspaceArg);
  const userId = resolveUserId(userIdArg || DEFAULTS.userId);
  const legacyGlobal = loadGlobalState(paths);
  const userState = loadUserState(paths, userId);
  const userMemories = loadUserMemories(paths, userId);
  const userExperiences = loadUserExperiences(paths, userId);

  userState.preferences = {
    ...(legacyGlobal.user_preferences || {}),
    ...(userState.preferences || {})
  };
  userState.last_updated = new Date().toISOString();
  writeUserState(paths, userId, userState);

  const nextMemories = [...userMemories];
  (legacyGlobal.important_facts || []).forEach((entry) => {
    if (nextMemories.some((memory) => memory.id === entry.id || memory.content === entry.content)) {
      return;
    }

    nextMemories.push({
      ...entry,
      type: entry.type || 'memory',
      scope: 'user',
      source_user: userId,
      created_at: entry.created_at || new Date().toISOString(),
      heat: entry.heat || 60,
      access_count: entry.access_count || 1,
      access_sessions: entry.access_sessions || [],
      validation: entry.validation || {
        status: 'pending',
        count: 0,
        auto_validated: false,
        last_reviewed_at: null,
        notes: []
      },
      archived: Boolean(entry.archived)
    });
  });
  writeUserMemories(paths, userId, nextMemories);

  const nextExperiences = [...userExperiences];
  (legacyGlobal.global_experiences || []).forEach((entry) => {
    if (nextExperiences.some((experience) => experience.id === entry.id || experience.summary === entry.summary)) {
      return;
    }

    nextExperiences.push({
      ...entry,
      scope: 'user',
      source_user: userId,
      created_at: entry.created_at || new Date().toISOString(),
      validation: entry.validation || {
        status: 'pending',
        count: 0,
        auto_validated: false,
        last_reviewed_at: null,
        notes: []
      },
      archived: Boolean(entry.archived)
    });
  });
  writeUserExperiences(paths, userId, nextExperiences);

  return {
    status: 'migrated',
    user_id: userId,
    imported_preferences: Object.keys(legacyGlobal.user_preferences || {}).length,
    imported_memories: (legacyGlobal.important_facts || []).length,
    imported_experiences: (legacyGlobal.global_experiences || []).length
  };
}

function main() {
  const result = runMigrateGlobalToUser(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runMigrateGlobalToUser
};
