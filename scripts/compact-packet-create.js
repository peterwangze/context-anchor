#!/usr/bin/env node

const path = require('path');

const {
  DEFAULTS,
  createPaths,
  getRepoRoot,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadRankedCollection,
  loadProjectSkills,
  loadSessionState,
  loadUserExperiences,
  loadUserMemories,
  loadUserSkills,
  normalizeSkillRecord,
  projectDecisionsFile,
  projectExperiencesFile,
  projectFactsFile,
  resolveUserId,
  selectEffectiveSkills,
  sanitizeKey,
  sessionExperiencesFile,
  sessionMemoryFile,
  sortByHeat,
  userExperiencesFile,
  userMemoriesFile,
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

function buildPersistentLookupCommand(paths, sessionState) {
  return `node "${path.join(getRepoRoot(), 'scripts', 'memory-search.js')}" "${paths.workspace}" "${sessionState.session_key}" "<query>"`;
}

function buildCatalogEntry(source, scope, tier, count, file, options = {}) {
  if (!count) {
    return null;
  }

  return {
    source,
    scope,
    tier,
    count,
    file,
    hot_count: Number(options.hotCount || 0),
    validated_count: Number(options.validatedCount || 0)
  };
}

function runCompactPacketCreate(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, options.projectId, {
    createIfMissing: true,
    touch: true
  });
  const userId = resolveUserId(options.userId || sessionState.user_id || DEFAULTS.userId);
  const sessionMemories = loadRankedCollection(sessionMemoryFile(paths, sessionKey), 'entries', {
    minHeat: DEFAULTS.hotMemoryHeat,
    limit: DEFAULTS.bootstrapHotMemoryLimit
  });
  const sessionExperiences = loadRankedCollection(sessionExperiencesFile(paths, sessionKey), 'experiences', {
    minHeat: DEFAULTS.warmMemoryHeat,
    limit: DEFAULTS.bootstrapWarmPreviewLimit * 3
  });
  const projectDecisions = sortByHeat(loadProjectDecisions(paths, sessionState.project_id)).filter((entry) => !entry.archived);
  const projectExperiences = sortByHeat(loadProjectExperiences(paths, sessionState.project_id)).filter((entry) => !entry.archived);
  const projectFacts = sortByHeat(loadProjectFacts(paths, sessionState.project_id)).filter((entry) => !entry.archived);
  const userMemories = sortByHeat(loadUserMemories(paths, userId)).filter((entry) => !entry.archived);
  const userExperiences = sortByHeat(loadUserExperiences(paths, userId)).filter((entry) => !entry.archived);
  const resolvedSkills = selectEffectiveSkills({
    session: require('./lib/context-anchor').loadSessionSkills(paths, sessionKey).map((skill) => normalizeSkillRecord(skill, 'session')),
    project: loadProjectSkills(paths, sessionState.project_id).map((skill) => normalizeSkillRecord(skill, 'project')),
    user: loadUserSkills(paths, userId).map((skill) => normalizeSkillRecord(skill, 'user'))
  });
  const hotSessionMemories = sessionMemories
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      summary: entry.summary || entry.content,
      heat: entry.heat,
      source_session: sessionState.session_key
    }));
  const hotSessionExperiences = sessionExperiences
    .filter((entry) => entry.validation?.status === 'validated' || Number(entry.heat || 0) >= DEFAULTS.warmMemoryHeat)
    .slice(0, DEFAULTS.bootstrapWarmPreviewLimit)
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      summary: entry.summary,
      heat: entry.heat || DEFAULTS.warmMemoryHeat,
      validation_status: entry.validation?.status || 'pending'
    }));
  const persistentMemory = {
    strategy: 'persist_on_demand',
    lookup_command: buildPersistentLookupCommand(paths, sessionState),
    catalogs: [
      buildCatalogEntry(
        'project_decisions',
        'project',
        'warm',
        projectDecisions.length,
        projectDecisionsFile(paths, sessionState.project_id),
        {
          hotCount: projectDecisions.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length
        }
      ),
      buildCatalogEntry(
        'project_experiences',
        'project',
        'warm',
        projectExperiences.length,
        projectExperiencesFile(paths, sessionState.project_id),
        {
          hotCount: projectExperiences.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          validatedCount: projectExperiences.filter((entry) => entry.validation?.status === 'validated').length
        }
      ),
      buildCatalogEntry(
        'project_facts',
        'project',
        'cold',
        projectFacts.length,
        projectFactsFile(paths, sessionState.project_id),
        {
          hotCount: projectFacts.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length
        }
      ),
      buildCatalogEntry(
        'user_memories',
        'user',
        'warm',
        userMemories.length,
        userMemoriesFile(paths, userId),
        {
          hotCount: userMemories.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length
        }
      ),
      buildCatalogEntry(
        'user_experiences',
        'user',
        'warm',
        userExperiences.length,
        userExperiencesFile(paths, userId),
        {
          hotCount: userExperiences.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          validatedCount: userExperiences.filter((entry) => entry.validation?.status === 'validated').length
        }
      )
    ].filter(Boolean)
  };
  const packet = {
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: userId,
    created_at: new Date().toISOString(),
    reason: options.reason || 'pressure',
    usage_percent: options.usagePercent ?? null,
    active_task: sessionState.active_task,
    pending_commitments: (sessionState.commitments || []).filter((entry) => entry.status === 'pending'),
    memory_policy: {
      bootstrap_context_budget: DEFAULTS.bootstrapContextBudget,
      inject_tiers: ['hot', 'preference'],
      persist_tiers: ['warm', 'cold']
    },
    session_memories: hotSessionMemories,
    session_experiences: hotSessionExperiences,
    project_memories: projectDecisions.slice(0, DEFAULTS.bootstrapWarmPreviewLimit).map((entry) => ({
      id: entry.id,
      type: 'decision',
      heat: entry.heat
    })),
    project_experiences: projectExperiences.slice(0, DEFAULTS.bootstrapWarmPreviewLimit).map((entry) => ({
      id: entry.id,
      type: entry.type,
      heat: entry.heat,
      validation_status: entry.validation?.status || 'pending'
    })),
    user_memories: userMemories.slice(0, DEFAULTS.bootstrapWarmPreviewLimit).map((entry) => ({
      id: entry.id,
      type: entry.type || 'memory',
      heat: entry.heat || DEFAULTS.warmMemoryHeat
    })),
    user_experiences: userExperiences.slice(0, DEFAULTS.bootstrapWarmPreviewLimit).map((entry) => ({
      id: entry.id,
      type: entry.type,
      heat: entry.heat,
      validation_status: entry.validation?.status || 'pending'
    })),
    memory_tiers: {
      hot: {
        session_memories: hotSessionMemories,
        session_experiences: hotSessionExperiences
      },
      warm: {
        project_decisions: projectDecisions.length,
        project_experiences: projectExperiences.length,
        user_memories: userMemories.length,
        user_experiences: userExperiences.length
      },
      cold: {
        project_facts: projectFacts.length
      }
    },
    persistent_memory: persistentMemory,
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
