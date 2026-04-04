#!/usr/bin/env node

const {
  DEFAULTS,
  classifyHeatTier,
  createPaths,
  loadProjectDecisionArchive,
  loadProjectDecisions,
  loadProjectExperienceArchive,
  loadProjectExperiences,
  loadProjectFactArchive,
  loadProjectFacts,
  loadSessionMemory,
  loadSessionMemoryArchive,
  loadSessionState,
  loadUserExperienceArchive,
  loadUserExperiences,
  loadUserMemories,
  loadUserMemoryArchive,
  projectDecisionsArchiveFile,
  projectDecisionsFile,
  projectExperiencesArchiveFile,
  projectExperiencesFile,
  projectFactsArchiveFile,
  projectFactsFile,
  resolveUserId,
  sanitizeKey,
  sessionMemoryArchiveFile,
  sessionMemoryFile,
  sortByHeat,
  userExperiencesArchiveFile,
  userExperiencesFile,
  userMemoriesArchiveFile,
  userMemoriesFile
} = require('./lib/context-anchor');
const {
  describeCollectionFile,
  readCatalogCollectionSummaries,
  searchCatalogItems
} = require('./lib/context-anchor-db');

function tokenizeSearchText(...parts) {
  const tokens = parts
    .flat()
    .filter(Boolean)
    .flatMap((value) => String(value).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,}/gu) || []);

  return [...new Set(tokens)];
}

function countTokenOverlap(queryTokens, ...parts) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
    return 0;
  }

  const candidateTokens = new Set(tokenizeSearchText(parts));
  return queryTokens.filter((token) => candidateTokens.has(token)).length;
}

function canonicalSource(source = '') {
  return String(source).replace(/_archive$/u, '');
}

function isArchiveSource(source = '') {
  return /_archive$/u.test(String(source));
}

function candidateKey(source, id) {
  return `${canonicalSource(source)}:${id}`;
}

function buildCandidate(source, scope, entry, file, summaryParts = [], options = {}) {
  const summary =
    entry.summary ||
    entry.content ||
    entry.decision ||
    entry.what ||
    entry.key ||
    entry.name ||
    entry.id;
  const tier = options.tier || (isArchiveSource(source) ? 'archive' : 'active');
  const heat = Number(entry.heat || 0);

  return {
    source: canonicalSource(source),
    storage_source: source,
    scope,
    file,
    id: entry.id,
    type: entry.type || (canonicalSource(source) === 'project_decisions' ? 'decision' : 'memory'),
    summary,
    details: entry.details || null,
    solution: entry.solution || null,
    heat,
    heat_tier: classifyHeatTier(heat),
    tier,
    from_archive: tier === 'archive',
    retrieval_cost: tier === 'archive' ? 'archive_lookup' : 'active_lookup',
    validation_status: entry.validation?.status || entry.validation_status || null,
    archive_reason: entry.archive_reason || null,
    access_count: Number(entry.access_count || entry.applied_count || 0),
    last_accessed: entry.last_accessed || entry.created_at || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    search_text: [summary, entry.details, entry.solution, entry.decision, ...summaryParts].filter(Boolean).join(' ')
  };
}

function buildCandidateForSource(source, scope, entry, file, options = {}) {
  const logicalSource = canonicalSource(source);

  if (logicalSource === 'project_decisions') {
    return buildCandidate(
      source,
      scope,
      {
        ...entry,
        summary: entry.decision
      },
      file,
      [entry.rationale, entry.impact],
      options
    );
  }

  if (logicalSource === 'project_experiences' || logicalSource === 'user_experiences') {
    return buildCandidate(source, scope, entry, file, [entry.source], options);
  }

  if (logicalSource === 'user_memories') {
    return buildCandidate(source, scope, entry, file, [entry.scope], options);
  }

  if (logicalSource === 'session_memories') {
    return buildCandidate(source, scope, entry, file, [entry.session_key], options);
  }

  return buildCandidate(source, scope, entry, file, [], options);
}

function buildCandidateFromMirrorRow(row) {
  const entry = JSON.parse(row.payload_json);
  return buildCandidateForSource(row.source, row.scope, entry, row.file_path, {
    tier: isArchiveSource(row.source) ? 'archive' : 'active'
  });
}

function intersectQueryTokens(queryTokens, ...parts) {
  const available = new Set(tokenizeSearchText(parts));
  return [...new Set((queryTokens || []).filter((token) => available.has(token)))];
}

function explainCandidateMatch(candidate, queryTokens) {
  const fieldMatches = [];
  const matchedTerms = intersectQueryTokens(
    queryTokens,
    candidate.summary,
    candidate.details,
    candidate.solution,
    candidate.tags.join(' ')
  );

  if (intersectQueryTokens(queryTokens, candidate.summary).length > 0) {
    fieldMatches.push('summary');
  }
  if (intersectQueryTokens(queryTokens, candidate.details).length > 0) {
    fieldMatches.push('details');
  }
  if (intersectQueryTokens(queryTokens, candidate.solution).length > 0) {
    fieldMatches.push('solution');
  }
  if (intersectQueryTokens(queryTokens, candidate.tags.join(' ')).length > 0) {
    fieldMatches.push('tags');
  }

  const scoreSignals = [];
  if (candidate.validation_status === 'validated') {
    scoreSignals.push('validated');
  }
  if ((candidate.heat || 0) >= DEFAULTS.hotMemoryHeat) {
    scoreSignals.push(`heat:${candidate.heat}`);
  }
  if ((candidate.access_count || 0) > 0) {
    scoreSignals.push(`reuse:${candidate.access_count}`);
  }

  const summaryParts = [];
  if (matchedTerms.length > 0) {
    summaryParts.push(`matched ${matchedTerms.join(', ')}`);
  }
  if (fieldMatches.length > 0) {
    summaryParts.push(`via ${fieldMatches.join('/')}`);
  }
  if (scoreSignals.length > 0) {
    summaryParts.push(`ranked by ${scoreSignals.join(', ')}`);
  }

  return {
    matched_terms: matchedTerms,
    matched_fields: fieldMatches,
    score_signals: scoreSignals,
    summary: summaryParts.join('; ') || 'ranked by fallback relevance heuristics'
  };
}

function explainArchiveResult(candidate, activeResults, activeCandidates) {
  if (!candidate.from_archive) {
    return null;
  }

  const activeHadHits = Array.isArray(activeResults) && activeResults.length > 0;
  const activeHadCandidates = Array.isArray(activeCandidates) && activeCandidates.length > 0;
  const summary = activeHadHits
    ? 'Active tier had some matches, but archive fallback filled the remaining result slots.'
    : activeHadCandidates
      ? 'Active tier had candidates, but none ranked high enough for the returned results, so archive fallback was used.'
      : 'No active-tier matches were available, so archive fallback was used.';

  return {
    archive_reason: candidate.archive_reason || null,
    active_results_available: activeResults.length,
    active_candidates_available: activeCandidates.length,
    summary
  };
}

function scoreCandidate(candidate, queryTokens) {
  const overlap = countTokenOverlap(queryTokens, candidate.search_text, candidate.tags.join(' '));
  const recencyBonus = candidate.last_accessed
    ? Math.max(
        0,
        15 - Math.floor((Date.now() - new Date(candidate.last_accessed).getTime()) / (1000 * 60 * 60 * 24))
      )
    : 0;
  const validatedBonus = candidate.validation_status === 'validated' ? 15 : 0;

  return overlap * 25 + candidate.heat + Math.min(10, candidate.access_count) + recencyBonus + validatedBonus;
}

function buildSearchConfig(paths, sessionState, userId) {
  const workspaceActiveFilters = [
    {
      scope: 'session',
      ownerId: sessionState.session_key,
      source: 'session_memories',
      archived: false
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_decisions',
      archived: false
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_experiences',
      archived: false
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_facts',
      archived: false
    }
  ];
  const workspaceArchiveFilters = [
    {
      scope: 'session',
      ownerId: sessionState.session_key,
      source: 'session_memories_archive',
      archived: true
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_decisions_archive',
      archived: true
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_experiences_archive',
      archived: true
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_facts_archive',
      archived: true
    }
  ];
  const userActiveFilters = [
    {
      scope: 'user',
      ownerId: userId,
      source: 'user_memories',
      archived: false
    },
    {
      scope: 'user',
      ownerId: userId,
      source: 'user_experiences',
      archived: false
    }
  ];
  const userArchiveFilters = [
    {
      scope: 'user',
      ownerId: userId,
      source: 'user_memories_archive',
      archived: true
    },
    {
      scope: 'user',
      ownerId: userId,
      source: 'user_experiences_archive',
      archived: true
    }
  ];

  const workspaceDescriptor =
    describeCollectionFile(sessionMemoryFile(paths, sessionState.session_key), 'entries') ||
    describeCollectionFile(sessionMemoryArchiveFile(paths, sessionState.session_key), 'entries');
  const userDescriptor =
    describeCollectionFile(userMemoriesFile(paths, userId), 'memories') ||
    describeCollectionFile(userMemoriesArchiveFile(paths, userId), 'memories');

  return {
    workspaceDbFile: workspaceDescriptor?.dbFile || null,
    workspaceActiveFilters,
    workspaceArchiveFilters,
    userDbFile: userDescriptor?.dbFile || null,
    userActiveFilters,
    userArchiveFilters
  };
}

function collectMirrorScopeSummary(config) {
  return {
    ...readCatalogCollectionSummaries(config.workspaceDbFile, [
      ...config.workspaceActiveFilters,
      ...config.workspaceArchiveFilters
    ]),
    ...readCatalogCollectionSummaries(config.userDbFile, [...config.userActiveFilters, ...config.userArchiveFilters])
  };
}

function dedupeMirrorRows(rows, seenKeys = new Set()) {
  const candidates = [];
  rows.forEach((row) => {
    const key = candidateKey(row.source, row.item_id);
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    candidates.push(buildCandidateFromMirrorRow(row));
  });
  return candidates;
}

function collectMirrorCandidatesForTier(config, queryText, limit, tier, seenKeys = new Set()) {
  const workspaceFilters = tier === 'archive' ? config.workspaceArchiveFilters : config.workspaceActiveFilters;
  const userFilters = tier === 'archive' ? config.userArchiveFilters : config.userActiveFilters;
  const rows = [
    ...searchCatalogItems(config.workspaceDbFile, workspaceFilters, queryText, Math.max(limit * 4, 12)),
    ...searchCatalogItems(config.userDbFile, userFilters, queryText, Math.max(limit * 4, 12))
  ];

  return dedupeMirrorRows(rows, seenKeys);
}

function collectFallbackCandidatesForTier(paths, sessionState, userId, tier, seenKeys = new Set()) {
  const specs =
    tier === 'archive'
      ? [
          {
            source: 'session_memories_archive',
            scope: 'session',
            file: sessionMemoryArchiveFile(paths, sessionState.session_key),
            load: () => sortByHeat(loadSessionMemoryArchive(paths, sessionState.session_key))
          },
          {
            source: 'project_decisions_archive',
            scope: 'project',
            file: projectDecisionsArchiveFile(paths, sessionState.project_id),
            load: () => sortByHeat(loadProjectDecisionArchive(paths, sessionState.project_id))
          },
          {
            source: 'project_experiences_archive',
            scope: 'project',
            file: projectExperiencesArchiveFile(paths, sessionState.project_id),
            load: () => sortByHeat(loadProjectExperienceArchive(paths, sessionState.project_id))
          },
          {
            source: 'project_facts_archive',
            scope: 'project',
            file: projectFactsArchiveFile(paths, sessionState.project_id),
            load: () => sortByHeat(loadProjectFactArchive(paths, sessionState.project_id))
          },
          {
            source: 'user_memories_archive',
            scope: 'user',
            file: userMemoriesArchiveFile(paths, userId),
            load: () => sortByHeat(loadUserMemoryArchive(paths, userId))
          },
          {
            source: 'user_experiences_archive',
            scope: 'user',
            file: userExperiencesArchiveFile(paths, userId),
            load: () => sortByHeat(loadUserExperienceArchive(paths, userId))
          }
        ]
      : [
          {
            source: 'session_memories',
            scope: 'session',
            file: sessionMemoryFile(paths, sessionState.session_key),
            load: () => sortByHeat(loadSessionMemory(paths, sessionState.session_key)).filter((entry) => !entry.archived)
          },
          {
            source: 'project_decisions',
            scope: 'project',
            file: projectDecisionsFile(paths, sessionState.project_id),
            load: () => sortByHeat(loadProjectDecisions(paths, sessionState.project_id)).filter((entry) => !entry.archived)
          },
          {
            source: 'project_experiences',
            scope: 'project',
            file: projectExperiencesFile(paths, sessionState.project_id),
            load: () => sortByHeat(loadProjectExperiences(paths, sessionState.project_id)).filter((entry) => !entry.archived)
          },
          {
            source: 'project_facts',
            scope: 'project',
            file: projectFactsFile(paths, sessionState.project_id),
            load: () => sortByHeat(loadProjectFacts(paths, sessionState.project_id)).filter((entry) => !entry.archived)
          },
          {
            source: 'user_memories',
            scope: 'user',
            file: userMemoriesFile(paths, userId),
            load: () => sortByHeat(loadUserMemories(paths, userId)).filter((entry) => !entry.archived)
          },
          {
            source: 'user_experiences',
            scope: 'user',
            file: userExperiencesFile(paths, userId),
            load: () => sortByHeat(loadUserExperiences(paths, userId)).filter((entry) => !entry.archived)
          }
        ];

  const scopeSummary = {};
  const candidates = [];

  specs.forEach((spec) => {
    const items = spec.load();
    scopeSummary[spec.source] = {
      scope: spec.scope,
      count: items.length
    };

    items.forEach((entry) => {
      const key = candidateKey(spec.source, entry.id);
      if (seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      candidates.push(
        buildCandidateForSource(spec.source, spec.scope, entry, spec.file, {
          tier
        })
      );
    });
  });

  return {
    candidates,
    scopeSummary
  };
}

function scoreAndSortCandidates(candidates, queryTokens) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, queryTokens)
    }))
    .filter((candidate) => queryTokens.length === 0 || candidate.score > candidate.heat)
    .sort((left, right) => right.score - left.score);
}

function runMemorySearch(workspaceArg, sessionKeyArg, queryArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const sessionState = loadSessionState(paths, sessionKey, options.projectId, {
    createIfMissing: true,
    touch: false,
    userId: options.userId
  });
  const userId = resolveUserId(options.userId || sessionState.user_id || DEFAULTS.userId);
  const query = String(queryArg || options.query || sessionState.active_task || '').trim();
  const queryTokens = tokenizeSearchText(query, options.context || '');
  const limit = Number(options.limit || DEFAULTS.memorySearchResultLimit);
  const queryText = queryTokens.join(' ');
  const config = buildSearchConfig(paths, sessionState, userId);
  const scopeSummary = collectMirrorScopeSummary(config);

  const activeMirrorCandidates = collectMirrorCandidatesForTier(config, queryText, limit, 'active');
  const activeFallback =
    activeMirrorCandidates.length === 0
      ? collectFallbackCandidatesForTier(paths, sessionState, userId, 'active')
      : {
          candidates: [],
          scopeSummary: {}
        };
  const activeCandidates = activeMirrorCandidates.length > 0 ? activeMirrorCandidates : activeFallback.candidates;
  const activeResults = scoreAndSortCandidates(activeCandidates, queryTokens).slice(0, limit);

  const seenKeys = new Set(activeResults.map((entry) => candidateKey(entry.storage_source, entry.id)));
  let archiveCandidates = [];
  let archiveFallback = {
    candidates: [],
    scopeSummary: {}
  };

  if (activeResults.length < limit) {
    const archiveMirrorCandidates = collectMirrorCandidatesForTier(config, queryText, limit, 'archive', seenKeys);
    archiveFallback =
      archiveMirrorCandidates.length === 0
        ? collectFallbackCandidatesForTier(paths, sessionState, userId, 'archive', seenKeys)
        : archiveFallback;
    archiveCandidates = archiveMirrorCandidates.length > 0 ? archiveMirrorCandidates : archiveFallback.candidates;
  }

  const archiveResults = scoreAndSortCandidates(archiveCandidates, queryTokens).slice(
    0,
    Math.max(0, limit - activeResults.length)
  );
  const scored = [...activeResults, ...archiveResults].map((candidate) => ({
    source: candidate.source,
    storage_source: candidate.storage_source,
    scope: candidate.scope,
    tier: candidate.tier,
    heat_tier: candidate.heat_tier,
    from_archive: candidate.from_archive,
    retrieval_cost: candidate.retrieval_cost,
    id: candidate.id,
    type: candidate.type,
    summary: candidate.summary,
    heat: candidate.heat,
    score: candidate.score,
    validation_status: candidate.validation_status,
    file: candidate.file,
    why_matched: explainCandidateMatch(candidate, queryTokens),
    why_from_archive: explainArchiveResult(candidate, activeResults, activeCandidates)
  }));

  return {
    status: 'ok',
    workspace: paths.workspace,
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: userId,
    query,
    query_tokens: queryTokens,
    tiers_searched: archiveResults.length > 0 ? ['active', 'archive'] : ['active'],
    total_candidates: activeCandidates.length + archiveCandidates.length,
    returned: scored.length,
    scope_summary: {
      ...scopeSummary,
      ...activeFallback.scopeSummary,
      ...archiveFallback.scopeSummary
    },
    results: scored
  };
}

function main() {
  const result = runMemorySearch(process.argv[2], process.argv[3], process.argv[4], {
    limit: process.argv[5] ? Number(process.argv[5]) : undefined
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runMemorySearch
};
