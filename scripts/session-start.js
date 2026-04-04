#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runCompactPacketCreate } = require('./compact-packet-create');
const { runHeatEvaluation } = require('./heat-eval');
const { recordSessionOwnership, resolveOwnership } = require('./lib/host-config');
const {
  DEFAULTS,
  createPaths,
  ensureAnchorDirs,
  getRepoRoot,
  getRecentSessions,
  loadCompactPacket,
  loadCollection,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadRankedCollection,
  loadProjectSkills,
  loadProjectState,
  loadSessionSkills,
  loadSessionState,
  loadSessionSummary,
  loadUserExperiences,
  loadUserMemories,
  loadUserSkills,
  loadUserState,
  mergeAccessMetadata,
  normalizeSkillRecord,
  projectDecisionsFile,
  projectExperiencesFile,
  projectFactsFile,
  readRuntimeStateSnapshot,
  readText,
  recordHeatEntry,
  recordUserHeatEntry,
  resolveProjectId,
  resolveUserId,
  selectEffectiveSkills,
  sanitizeKey,
  sessionCheckpointFile,
  sessionMemoryFile,
  syncRuntimeStateFromSessionState,
  sortByHeat,
  syncProjectStateMetadata,
  touchGlobalIndex,
  touchSessionIndex,
  userExperiencesFile,
  userMemoriesFile,
  writeProjectDecisions,
  writeProjectExperiences,
  writeSessionState,
  writeUserExperiences,
  writeUserMemories
} = require('./lib/context-anchor');
const { runMemoryFlow } = require('./memory-flow');
const { runLegacyMemorySync } = require('./legacy-memory-sync');
const { runScopePromote } = require('./scope-promote');
const { runSkillReconcile } = require('./skill-reconcile');
const { runSkillificationScore } = require('./skillification-score');

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

function collectPendingCommitments(sessionState = {}, summary = {}, compactPacket = {}) {
  const fromState = Array.isArray(sessionState.commitments)
    ? sessionState.commitments.filter((entry) => entry.status === 'pending')
    : [];
  if (fromState.length > 0) {
    return fromState;
  }

  if (Array.isArray(summary.pending_commitments) && summary.pending_commitments.length > 0) {
    return summary.pending_commitments;
  }

  if (Array.isArray(compactPacket.pending_commitments) && compactPacket.pending_commitments.length > 0) {
    return compactPacket.pending_commitments;
  }

  return [];
}

function mergeRuntimeCommitments(sessionState = {}, runtimeState = null) {
  const existing = Array.isArray(sessionState.commitments) ? sessionState.commitments : [];
  const nonPending = existing.filter((entry) => entry.status !== 'pending');
  const runtimePending = Array.isArray(runtimeState?.pending_commitments)
    ? runtimeState.pending_commitments.map((entry) => ({ ...entry }))
    : [];
  return [...nonPending, ...runtimePending];
}

function summarizeContinuationLatestResult(source) {
  const summary = source?.summary || null;
  if (!summary) {
    return source?.compact_packet?.created_at ? 'Recovered the previous compact packet.' : null;
  }

  const resultParts = [];
  const promotedSkills =
    Number(summary.promoted_project_skills || 0) +
    Number(summary.promoted_user_skills || 0);

  if (Number(summary.new_session_experiences || 0) > 0) {
    resultParts.push(`captured ${summary.new_session_experiences} new experience(s)`);
  }
  if (promotedSkills > 0) {
    resultParts.push(`promoted ${promotedSkills} skill(s)`);
  }
  if (summary.skill_draft?.name) {
    resultParts.push(`prepared draft ${summary.skill_draft.name}`);
  }

  if (resultParts.length > 0) {
    return `Previous session ${resultParts.join('; ')}.`;
  }

  if (Number(summary.memory_count || 0) > 0) {
    return `Closed previous session with ${summary.memory_count} memory item(s).`;
  }

  if (summary.reason) {
    return `Previous session closed via ${summary.reason}.`;
  }

  return source?.compact_packet?.created_at ? 'Recovered the previous compact packet.' : null;
}

function summarizeContinuationNextStep(sessionState = {}, continuationSource = null) {
  const pendingCommitments = Array.isArray(sessionState.commitments)
    ? sessionState.commitments.filter((entry) => entry.status === 'pending')
    : [];
  if (pendingCommitments.length > 0) {
    return pendingCommitments[0].what || null;
  }

  const sourcePending = Array.isArray(continuationSource?.pending_commitments)
    ? continuationSource.pending_commitments.filter((entry) => entry.status !== 'done')
    : [];
  return sourcePending[0]?.what || null;
}

function buildContinuitySummary(sessionState = {}, continuationSource = null, continuityRestoration = {}) {
  const restoredGoal = sessionState.active_task || continuationSource?.active_task || null;
  const latestResult = summarizeContinuationLatestResult(continuationSource);
  const nextStep = summarizeContinuationNextStep(sessionState, continuationSource);
  const recoveredAssets = continuationSource
    ? {
        checkpoint: Boolean(continuationSource.checkpoint_excerpt),
        summary: Boolean(continuationSource.summary?.created_at),
        compact_packet: Boolean(continuationSource.compact_packet?.created_at)
      }
    : {
        checkpoint: false,
        summary: false,
        compact_packet: false
      };

  if (!continuationSource && !restoredGoal && !latestResult && !nextStep) {
    return null;
  }

  return {
    source_session_key: continuationSource?.session_key || null,
    restored_goal: restoredGoal,
    latest_result: latestResult,
    next_step: nextStep,
    reference_only: Boolean(continuityRestoration.reference_only),
    recovered_before_restore: Boolean(continuityRestoration.recovered_before_restore),
    recovered_assets: recoveredAssets,
    visible:
      Boolean(restoredGoal) ||
      Boolean(latestResult) ||
      Boolean(nextStep) ||
      Boolean(continuationSource?.session_key)
  };
}

function applyRuntimeStateToSessionState(sessionState, runtimeState) {
  if (!runtimeState) {
    return;
  }

  sessionState.active_task = runtimeState.active_task;
  sessionState.commitments = mergeRuntimeCommitments(sessionState, runtimeState);
  sessionState.last_checkpoint = runtimeState.last_checkpoint || sessionState.last_checkpoint || null;
  sessionState.checkpoint_reason = runtimeState.checkpoint_reason || sessionState.checkpoint_reason || null;
  sessionState.last_summary = runtimeState.last_summary || sessionState.last_summary || null;
  sessionState.closed_at = runtimeState.closed_at || null;
  sessionState.metadata = {
    ...(sessionState.metadata || {}),
    ...(runtimeState.metadata || {})
  };
}

function loadContinuationSource(paths, currentSessionKey, projectId) {
  const candidates = loadCollection(paths.sessionIndexFile, 'sessions');
  const previous = candidates
    .filter((entry) => entry.session_key !== currentSessionKey && entry.project_id === projectId)
    .sort((left, right) => new Date(right.last_active || 0).getTime() - new Date(left.last_active || 0).getTime())[0];

  if (!previous) {
    return null;
  }

  const state = loadSessionState(paths, previous.session_key, previous.project_id, {
    createIfMissing: false,
    touch: false
  });
  const runtimeState = readRuntimeStateSnapshot(paths, previous.session_key, previous.project_id, {
    userId: previous.user_id || state?.user_id || null
  });
  const summary = loadSessionSummary(paths, previous.session_key);
  const compactPacket = loadCompactPacket(paths, previous.session_key);
  const checkpoint = readText(sessionCheckpointFile(paths, previous.session_key), '');
  const activeTask =
    (runtimeState && Object.prototype.hasOwnProperty.call(runtimeState, 'active_task')
      ? runtimeState.active_task
      : null) ||
    state?.active_task ||
    summary?.active_task ||
    compactPacket?.active_task ||
    null;
  const pendingCommitments =
    Array.isArray(runtimeState?.pending_commitments) && runtimeState.pending_commitments.length > 0
      ? runtimeState.pending_commitments.map((entry) => ({ ...entry }))
      : collectPendingCommitments(state || {}, summary || {}, compactPacket || {});

  if (!activeTask && pendingCommitments.length === 0 && !checkpoint && !summary?.created_at && !compactPacket?.created_at) {
    return null;
  }

  return {
    session_key: previous.session_key,
    project_id: previous.project_id,
    user_id: previous.user_id || runtimeState?.user_id || state?.user_id || null,
    last_active: runtimeState?.last_active || previous.last_active || state?.last_active || null,
    closed_at:
      Object.prototype.hasOwnProperty.call(runtimeState || {}, 'closed_at')
        ? runtimeState?.closed_at || null
        : Object.prototype.hasOwnProperty.call(state || {}, 'closed_at')
          ? state?.closed_at || null
        : null,
    active_task: activeTask,
    pending_commitments: pendingCommitments,
    checkpoint_excerpt: checkpoint ? checkpoint.split('\n').slice(0, 10).join('\n') : null,
    continuation_recovered_at:
      runtimeState?.metadata?.continuation_recovered_at || state?.metadata?.continuation_recovered_at || null,
    runtime_state: runtimeState,
    summary,
    compact_packet: compactPacket
  };
}

function continuationSourceNeedsRecovery(source) {
  if (!source) {
    return false;
  }

  if (!source.compact_packet?.created_at) {
    return true;
  }

  return !source.summary?.created_at && !source.continuation_recovered_at;
}

function recoverContinuationSource(paths, currentSessionKey, source, options = {}) {
  if (!continuationSourceNeedsRecovery(source)) {
    return {
      source,
      recovered: false
    };
  }

  const preservedState = loadSessionState(paths, source.session_key, source.project_id, {
    createIfMissing: false,
    touch: false
  });
  const preservedLastActive = preservedState?.last_active || source.last_active || null;
  const preservedClosedAt =
    Object.prototype.hasOwnProperty.call(preservedState || {}, 'closed_at') ? preservedState.closed_at : null;

  runMemoryFlow(paths.workspace, source.session_key, {
    minimumHeat: DEFAULTS.warmMemoryHeat
  });
  runHeatEvaluation(paths.workspace, source.project_id);
  runSkillificationScore(paths.workspace, source.project_id);
  runScopePromote(paths.workspace, {
    sessionKey: source.session_key,
    projectId: source.project_id,
    userId: source.user_id || options.userId
  });
  runSkillReconcile(paths.workspace, {
    projectId: source.project_id,
    userId: source.user_id || options.userId
  });
  runCompactPacketCreate(paths.workspace, source.session_key, {
    reason: 'continuation-recovery',
    projectId: source.project_id,
    userId: source.user_id || options.userId
  });

  const recoveredState = loadSessionState(paths, source.session_key, source.project_id, {
    createIfMissing: false,
    touch: false
  });

  if (recoveredState) {
    recoveredState.last_active = preservedLastActive;
    recoveredState.closed_at = preservedClosedAt;
    recoveredState.metadata = {
      ...(recoveredState.metadata || {}),
      continuation_recovered_at: new Date().toISOString()
    };
    writeSessionState(paths, source.session_key, recoveredState);
    syncRuntimeStateFromSessionState(paths, source.session_key, recoveredState, {
      lastActive: preservedLastActive,
      closedAt: preservedClosedAt,
      metadata: recoveredState.metadata
    });
    touchSessionIndex(paths, recoveredState);
  }

  return {
    source: loadContinuationSource(paths, currentSessionKey, source.project_id),
    recovered: true
  };
}

function cloneCommitment(entry = {}, sourceSessionKey) {
  return {
    ...entry,
    source_session: entry.source_session || sourceSessionKey || null,
    inherited_from_session: sourceSessionKey || null
  };
}

function restoreSessionContinuity(sessionState, continuationSource) {
  if (!continuationSource) {
    return {
      restored: false,
      inherited_active_task: false,
      inherited_commitments: 0,
      reference_only: false
    };
  }

  let inheritedActiveTask = false;
  let inheritedCommitments = 0;
  let referenceOnly = false;
  const currentPendingCommitments = Array.isArray(sessionState.commitments)
    ? sessionState.commitments.filter((entry) => entry.status === 'pending')
    : [];
  const shouldCarryActiveTask =
    continuationSource.pending_commitments.length > 0 || !continuationSource.closed_at;

  if (!sessionState.active_task && shouldCarryActiveTask && continuationSource.active_task) {
    sessionState.active_task = continuationSource.active_task;
    inheritedActiveTask = true;
  }

  if (currentPendingCommitments.length === 0 && continuationSource.pending_commitments.length > 0) {
    sessionState.commitments = continuationSource.pending_commitments.map((entry) =>
      cloneCommitment(entry, continuationSource.session_key)
    );
    inheritedCommitments = sessionState.commitments.length;
  }

  if (continuationSource.session_key) {
    referenceOnly = !(inheritedActiveTask || inheritedCommitments > 0);
  }

  if (inheritedActiveTask || inheritedCommitments > 0 || referenceOnly) {
    sessionState.metadata = {
      ...(sessionState.metadata || {}),
      continued_from_session: continuationSource.session_key,
      continuity_restored_at: new Date().toISOString(),
      ...(referenceOnly ? { continuity_reference_only: true } : {})
    };
  }

  return {
    restored: inheritedActiveTask || inheritedCommitments > 0 || referenceOnly,
    inherited_active_task: inheritedActiveTask,
    inherited_commitments: inheritedCommitments,
    reference_only: referenceOnly
  };
}

function tokenizeReuseText(...parts) {
  const tokens = parts
    .flat()
    .filter(Boolean)
    .flatMap((value) => String(value).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) || []);

  return [...new Set(tokens)];
}

function countTokenOverlap(contextTokens, candidateText) {
  if (!Array.isArray(contextTokens) || contextTokens.length === 0 || !candidateText) {
    return 0;
  }

  const candidateTokens = new Set(tokenizeReuseText(candidateText));
  return contextTokens.filter((token) => candidateTokens.has(token)).length;
}

function buildReuseReason(overlap, options = {}) {
  const reasons = [];

  if (overlap > 0) {
    reasons.push('matched_current_context');
  }
  if (options.validated) {
    reasons.push('validated');
  }
  if (options.active) {
    reasons.push('active_skill');
  }
  if (Number(options.heat || 0) >= 80) {
    reasons.push('high_heat');
  }

  return reasons.length > 0 ? reasons : ['high_value_fallback'];
}

function buildPersistentLookupCommand(paths, sessionState) {
  return `node "${path.join(getRepoRoot(), 'scripts', 'memory-search.js')}" "${paths.workspace}" "${sessionState.session_key}" "<query>"`;
}

function buildPersistentCatalogEntry(source, scope, tier, count, file, options = {}) {
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
    validated_count: Number(options.validatedCount || 0),
    summary: options.summary || null
  };
}

function buildPersistentMemoryCatalog(paths, sessionState, collections = {}) {
  return {
    strategy: 'persist_on_demand',
    lookup_command: buildPersistentLookupCommand(paths, sessionState),
    catalogs: [
      buildPersistentCatalogEntry(
        'project_decisions',
        'project',
        'warm',
        collections.decisions.length,
        projectDecisionsFile(paths, sessionState.project_id),
        {
          hotCount: collections.decisions.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          summary: 'Project-level decisions and implementation choices'
        }
      ),
      buildPersistentCatalogEntry(
        'project_experiences',
        'project',
        'warm',
        collections.experiences.length,
        projectExperiencesFile(paths, sessionState.project_id),
        {
          hotCount: collections.experiences.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          validatedCount: collections.experiences.filter((entry) => entry.validation?.status === 'validated').length,
          summary: 'Validated and reusable project lessons'
        }
      ),
      buildPersistentCatalogEntry(
        'project_facts',
        'project',
        'cold',
        collections.projectFacts.length,
        projectFactsFile(paths, sessionState.project_id),
        {
          hotCount: collections.projectFacts.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          summary: 'Low-frequency facts and reference notes'
        }
      ),
      buildPersistentCatalogEntry(
        'user_memories',
        'user',
        'warm',
        collections.userMemories.length,
        userMemoriesFile(paths, sessionState.user_id),
        {
          hotCount: collections.userMemories.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          summary: 'Reusable user preferences and recurring habits'
        }
      ),
      buildPersistentCatalogEntry(
        'user_experiences',
        'user',
        'warm',
        collections.userExperiences.length,
        userExperiencesFile(paths, sessionState.user_id),
        {
          hotCount: collections.userExperiences.filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat).length,
          validatedCount: collections.userExperiences.filter((entry) => entry.validation?.status === 'validated').length,
          summary: 'Cross-project user-level reusable lessons'
        }
      )
    ].filter(Boolean)
  };
}

function calculateRecencyBonus(timestamp) {
  if (!timestamp) {
    return 0;
  }

  const ageHours = (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
  if (ageHours <= 6) {
    return 20;
  }
  if (ageHours <= 24) {
    return 12;
  }
  if (ageHours <= 72) {
    return 6;
  }

  return 0;
}

function collectContinuationHotMemories(continuationSource) {
  if (!continuationSource?.compact_packet) {
    return [];
  }

  const packet = continuationSource.compact_packet;
  const entries = Array.isArray(packet.memory_tiers?.hot?.session_memories)
    ? packet.memory_tiers.hot.session_memories
    : Array.isArray(packet.session_memories)
      ? packet.session_memories
      : [];

  return entries
    .filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat)
    .map((entry) => ({
      ...entry,
      source: 'continued_session',
      source_session: continuationSource.session_key,
      last_accessed: continuationSource.last_active || packet.created_at || null
    }));
}

function buildShortTermHotMemories(sessionState, continuationSource, contextTokens, sessionMemories = []) {
  const candidates = [
    ...sessionMemories
      .filter((entry) => !entry.archived && Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat)
      .map((entry) => ({
        id: entry.id,
        type: entry.type || 'memory',
        summary: entry.summary || entry.content,
        heat: Number(entry.heat || 0),
        source: 'current_session',
        source_session: sessionState.session_key,
        last_accessed: entry.last_accessed || entry.created_at || null,
        access_count: Number(entry.access_count || 0)
      })),
    ...collectContinuationHotMemories(continuationSource).map((entry) => ({
      id: entry.id,
      type: entry.type || 'memory',
      summary: entry.summary || entry.content,
      heat: Number(entry.heat || 0),
      source: entry.source,
      source_session: entry.source_session,
      last_accessed: entry.last_accessed || null,
      access_count: Number(entry.access_count || 0)
    }))
  ];

  return candidates
    .map((entry) => {
      const overlap = countTokenOverlap(contextTokens, [entry.summary, entry.type].filter(Boolean).join(' '));
      const score =
        overlap * 30 +
        entry.heat +
        calculateRecencyBonus(entry.last_accessed) +
        Math.min(10, entry.access_count || 0) +
        (entry.source === 'continued_session' ? 25 : 20);

      return {
        id: entry.id,
        type: entry.type,
        summary: entry.summary,
        heat: entry.heat,
        source: entry.source,
        source_session: entry.source_session,
        score,
        reasons: buildReuseReason(overlap, {
          heat: entry.heat
        })
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, DEFAULTS.bootstrapHotMemoryLimit);
}

function recommendExperienceReuse(contextTokens, experiences = [], scope) {
  return experiences
    .filter((entry) => !entry.archived)
    .map((entry) => {
      const overlap = countTokenOverlap(
        contextTokens,
        [entry.summary, entry.details, entry.solution, entry.type].filter(Boolean).join(' ')
      );
      const heat = Number(entry.heat || 0);
      const validated = entry.validation?.status === 'validated';
      const score =
        overlap * 20 +
        heat / 2 +
        (validated ? 20 : 0) +
        Math.min(10, Number(entry.access_count || 0));

      return {
        scope,
        id: entry.id,
        type: entry.type,
        summary: entry.summary,
        heat,
        validation_status: entry.validation?.status || 'pending',
        score,
        reasons: buildReuseReason(overlap, {
          validated,
          heat
        })
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

function recommendSkillReuse(contextTokens, skills = [], scope) {
  return skills
    .filter((entry) => !entry.archived && entry.status !== 'inactive' && entry.status !== 'archived')
    .map((entry) => {
      const overlap = countTokenOverlap(
        contextTokens,
        [entry.name, entry.summary, entry.notes].filter(Boolean).join(' ')
      );
      const priority = Number(entry.load_policy?.priority || 0);
      const active = entry.status === 'active' || scope === 'session';
      const score =
        overlap * 20 +
        priority / 2 +
        Math.min(10, Number(entry.usage_count || 0)) +
        (active ? 20 : 0);

      return {
        scope,
        id: entry.id,
        name: entry.name,
        summary: entry.summary || null,
        status: entry.status || 'active',
        score,
        reasons: buildReuseReason(overlap, {
          active,
          heat: priority
        })
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

function runSessionStart(workspaceArg, sessionKeyArg, projectIdArg, options = {}) {
  const paths = createPaths(workspaceArg);
  ensureAnchorDirs(paths);

  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: projectIdArg,
    userId: options.userId
  });
  const projectId = ownership.projectId || resolveProjectId(paths.workspace, projectIdArg);
  const checkpointFile = sessionCheckpointFile(paths, sessionKey);
  const hadCheckpoint = fs.existsSync(checkpointFile);

  const sessionState = loadSessionState(paths, sessionKey, projectId, {
    createIfMissing: true,
    touch: true,
    userId: ownership.userId
  });
  const existingRuntimeState = readRuntimeStateSnapshot(paths, sessionKey, projectId, {
    userId: ownership.userId,
    fallbackToSession: false
  });
  applyRuntimeStateToSessionState(sessionState, existingRuntimeState);
  const openClawSessionId =
    typeof options.openClawSessionId === 'string' && options.openClawSessionId.trim()
      ? options.openClawSessionId.trim()
      : null;
  const previousOpenClawSessionId = sessionState.metadata?.openclaw_session_id || null;
  if (options.reopenClosed !== false && sessionState.closed_at) {
    sessionState.closed_at = null;
  }
  if (openClawSessionId && previousOpenClawSessionId && previousOpenClawSessionId !== openClawSessionId) {
    sessionState.started_at = new Date().toISOString();
    sessionState.closed_at = null;
  }
  sessionState.user_id = resolveUserId(sessionState.user_id || ownership.userId || DEFAULTS.userId);
  sessionState.project_id = projectId;
  const legacyMemorySync = runLegacyMemorySync(paths.workspace, sessionKey, {
    projectId,
    reason: 'session-start'
  });
  const continuationRecovery = recoverContinuationSource(
    paths,
    sessionKey,
    loadContinuationSource(paths, sessionKey, projectId),
    {
      userId: sessionState.user_id
    }
  );
  const continuationSource = continuationRecovery.source;
  const continuityRestoration = restoreSessionContinuity(sessionState, continuationSource);
  continuityRestoration.recovered_before_restore = continuationRecovery.recovered;
  sessionState.metadata = {
    ...(sessionState.metadata || {}),
    ...(openClawSessionId ? { openclaw_session_id: openClawSessionId } : {})
  };
  writeSessionState(paths, sessionState.session_key, sessionState);
  syncRuntimeStateFromSessionState(paths, sessionState.session_key, sessionState, {
    metadata: sessionState.metadata
  });
  const projectState = loadProjectState(paths, sessionState.project_id);
  const loadedDecisions = loadProjectDecisions(paths, sessionState.project_id);
  const loadedExperiences = loadProjectExperiences(paths, sessionState.project_id);
  const loadedProjectFacts = loadProjectFacts(paths, sessionState.project_id);
  const projectSkills = loadProjectSkills(paths, sessionState.project_id);
  const sessionSkills = loadSessionSkills(paths, sessionState.session_key);
  const sessionMemories = loadRankedCollection(sessionMemoryFile(paths, sessionState.session_key), 'entries', {
    minHeat: DEFAULTS.hotMemoryHeat,
    limit: DEFAULTS.bootstrapHotMemoryLimit * 4
  });
  const decisions = sortByHeat(loadedDecisions).filter(
    (entry) => !entry.archived
  );
  const experiences = sortByHeat(loadedExperiences).filter(
    (entry) => !entry.archived
  );
  const projectFacts = sortByHeat(loadedProjectFacts).filter((entry) => !entry.archived);
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

  syncProjectStateMetadata(paths, sessionState.project_id);
  touchGlobalIndex(paths);
  recordSessionOwnership(paths.openClawHome, paths.workspace, sessionState, {
    status: sessionState.closed_at ? 'closed' : 'active'
  });

  const pendingCommitments = (sessionState.commitments || []).filter(
    (entry) => entry.status === 'pending'
  );
  const reuseContextTokens = tokenizeReuseText(
    sessionState.active_task,
    pendingCommitments.map((entry) => entry.what),
    continuationSource?.summary?.active_task,
    continuationSource?.summary?.reason,
    continuationSource?.summary?.skill_draft?.name
  );
  const shortTermHotMemories = buildShortTermHotMemories(
    sessionState,
    continuationSource,
    reuseContextTokens,
    sessionMemories
  );
  const persistentMemory = buildPersistentMemoryCatalog(paths, sessionState, {
    decisions,
    experiences,
    projectFacts,
    userMemories,
    userExperiences
  });
  const recommendedReuse = {
    experiences: [
      ...recommendExperienceReuse(reuseContextTokens, experiences, 'project'),
      ...recommendExperienceReuse(reuseContextTokens, userExperiences, 'user')
    ]
      .sort((left, right) => right.score - left.score)
      .slice(0, 5),
    skills: [
      ...recommendSkillReuse(reuseContextTokens, groupedNormalizeSkills(sessionSkills, 'session'), 'session'),
      ...recommendSkillReuse(reuseContextTokens, groupedNormalizeSkills(projectSkills, 'project'), 'project'),
      ...recommendSkillReuse(reuseContextTokens, groupedNormalizeSkills(userSkills, 'user'), 'user')
    ]
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
  };

  const summary = {
    status: 'initialized',
    session: {
      key: sessionState.session_key,
      project: sessionState.project_id,
      user: sessionState.user_id,
      restored:
        hadCheckpoint ||
        pendingCommitments.length > 0 ||
        Boolean(sessionState.active_task) ||
        continuityRestoration.restored,
      continued_from: sessionState.metadata?.continued_from_session || null
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
      checkpoint_excerpt: checkpoint ? checkpoint.split('\n').slice(0, 10).join('\n') : null,
      continuity: continuationSource ? {
        source_session_key: continuationSource.session_key,
        source_last_active: continuationSource.last_active,
        source_closed_at: continuationSource.closed_at,
        inherited_active_task: continuityRestoration.inherited_active_task,
        inherited_commitments: continuityRestoration.inherited_commitments,
        reference_only: continuityRestoration.reference_only,
        recovered_before_restore: continuationRecovery.recovered,
        recovered_at: continuationSource.continuation_recovered_at || null,
        source_summary_available: Boolean(continuationSource.summary?.created_at),
        source_compact_packet_available: Boolean(continuationSource.compact_packet?.created_at)
      } : null,
      continuity_summary: buildContinuitySummary(sessionState, continuationSource, continuityRestoration)
    },
    boot_packet: {
      active_task: sessionState.active_task,
      pending_commitments: pendingCommitments,
      continuation: continuationSource ? {
        source_session_key: continuationSource.session_key,
        source_last_active: continuationSource.last_active,
        source_active_task: continuationSource.active_task,
        source_checkpoint_excerpt: continuationSource.checkpoint_excerpt
      } : null,
      continuity_summary: buildContinuitySummary(sessionState, continuationSource, continuityRestoration),
      active_skills: {
        session: sessionSkills.slice(0, 5),
        project: projectSkills.slice(0, 5),
        user: userSkills.slice(0, 5)
      },
      memory_policy: {
        bootstrap_context_budget: DEFAULTS.bootstrapContextBudget,
        inject_tiers: ['hot', 'preference'],
        persist_tiers: ['warm', 'cold']
      },
      persistent_memory: persistentMemory,
      recommended_reuse: recommendedReuse
    },
    memories_to_inject: [],
    persistent_memory: persistentMemory,
    memory_policy: {
      bootstrap_context_budget: DEFAULTS.bootstrapContextBudget,
      inject_tiers: ['hot', 'preference'],
      persist_tiers: ['warm', 'cold']
    },
    recommended_reuse: recommendedReuse,
    related_sessions: relatedSessions,
    compatibility: {
      legacy_memory_files: detectLegacyMemory(paths.workspace),
      legacy_memory_sync: legacyMemorySync
    }
  };

  if (shortTermHotMemories.length > 0) {
    summary.memories_to_inject.push({
      source: 'short_term_hot_memories',
      tier: 'hot',
      entries: shortTermHotMemories
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

  const resolvedSkills = selectEffectiveSkills({
    session: sessionSkills.map((skill) => normalizeSkillRecord(skill, 'session')),
    project: projectSkills.map((skill) => normalizeSkillRecord(skill, 'project')),
    user: userSkills.map((skill) => normalizeSkillRecord(skill, 'user'))
  });
  const groupedEffectiveSkills = {
    session: resolvedSkills.effective.filter((skill) => skill.scope === 'session'),
    project: resolvedSkills.effective.filter((skill) => skill.scope === 'project'),
    user: resolvedSkills.effective.filter((skill) => skill.scope === 'user')
  };

  summary.skills_to_activate = groupedEffectiveSkills;
  summary.effective_skills = resolvedSkills.effective;
  summary.shadowed_skills = resolvedSkills.shadowed;
  if (summary.recommended_reuse.skills.length === 0) {
    summary.recommended_reuse.skills = resolvedSkills.effective.slice(0, 5).map((skill) => ({
      scope: skill.scope,
      id: skill.id,
      name: skill.name,
      summary: skill.summary || null,
      status: skill.status || 'active',
      score: Number(skill.load_policy?.priority || 0),
      reasons: ['active_skill_fallback']
    }));
    summary.boot_packet.recommended_reuse.skills = summary.recommended_reuse.skills;
  }
  if (
    summary.recommended_reuse.skills.length === 0 &&
    continuationSource?.compact_packet?.active_skills
  ) {
    const previousActiveSkills = Object.entries(continuationSource.compact_packet.active_skills)
      .flatMap(([scope, entries]) =>
        (Array.isArray(entries) ? entries : []).map((entry) => ({
          scope,
          id: entry.id,
          name: entry.name,
          summary: entry.summary || null,
          status: entry.status || 'active',
          score: 0,
          reasons: ['previous_session_active_skill']
        }))
      )
      .slice(0, 5);
    summary.recommended_reuse.skills = previousActiveSkills;
    summary.boot_packet.recommended_reuse.skills = summary.recommended_reuse.skills;
  }
  summary.boot_packet.active_skills = groupedEffectiveSkills;
  summary.boot_packet.skill_governance = {
    shadowed: resolvedSkills.shadowed,
    superseded: resolvedSkills.superseded,
    budgeted_out: resolvedSkills.budgeted_out
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

function groupedNormalizeSkills(skills = [], scope) {
  return skills.map((skill) => normalizeSkillRecord(skill, scope));
}
