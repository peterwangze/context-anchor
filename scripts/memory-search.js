#!/usr/bin/env node

const {
  DEFAULTS,
  classifyHeatTier,
  createPaths,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadSessionMemory,
  loadSessionState,
  loadUserExperiences,
  loadUserMemories,
  projectDecisionsFile,
  projectExperiencesFile,
  projectFactsFile,
  resolveUserId,
  sanitizeKey,
  sessionMemoryFile,
  sortByHeat,
  userExperiencesFile,
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

function buildCandidate(source, scope, entry, file, summaryParts = []) {
  const summary =
    entry.summary ||
    entry.content ||
    entry.decision ||
    entry.what ||
    entry.key ||
    entry.name ||
    entry.id;

  return {
    source,
    scope,
    file,
    id: entry.id,
    type: entry.type || (source === 'project_decisions' ? 'decision' : 'memory'),
    summary,
    details: entry.details || null,
    solution: entry.solution || null,
    heat: Number(entry.heat || 0),
    validation_status: entry.validation?.status || null,
    access_count: Number(entry.access_count || entry.applied_count || 0),
    last_accessed: entry.last_accessed || entry.created_at || null,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    search_text: [summary, entry.details, entry.solution, entry.decision, ...summaryParts].filter(Boolean).join(' ')
  };
}

function buildCandidateFromMirrorRow(row) {
  const entry = JSON.parse(row.payload_json);

  if (row.source === 'project_decisions') {
    return buildCandidate(
      row.source,
      row.scope,
      {
        ...entry,
        summary: entry.decision
      },
      row.file_path,
      [entry.rationale, entry.impact]
    );
  }

  if (row.source === 'project_experiences') {
    return buildCandidate(row.source, row.scope, entry, row.file_path, [entry.source]);
  }

  if (row.source === 'user_memories') {
    return buildCandidate(row.source, row.scope, entry, row.file_path, [entry.scope]);
  }

  if (row.source === 'user_experiences') {
    return buildCandidate(row.source, row.scope, entry, row.file_path, [entry.source]);
  }

  if (row.source === 'session_memories') {
    return buildCandidate(row.source, row.scope, entry, row.file_path, [entry.session_key]);
  }

  return buildCandidate(row.source, row.scope, entry, row.file_path);
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

function collectFallbackCandidates(paths, sessionState, userId) {
  return [
    ...sortByHeat(loadSessionMemory(paths, sessionState.session_key))
      .filter((entry) => !entry.archived)
      .map((entry) =>
        buildCandidate(
          'session_memories',
          'session',
          entry,
          sessionMemoryFile(paths, sessionState.session_key),
          [entry.session_key]
        )
      ),
    ...sortByHeat(loadProjectDecisions(paths, sessionState.project_id))
      .filter((entry) => !entry.archived)
      .map((entry) =>
        buildCandidate(
          'project_decisions',
          'project',
          {
            ...entry,
            summary: entry.decision
          },
          projectDecisionsFile(paths, sessionState.project_id),
          [entry.rationale, entry.impact]
        )
      ),
    ...sortByHeat(loadProjectExperiences(paths, sessionState.project_id))
      .filter((entry) => !entry.archived)
      .map((entry) =>
        buildCandidate(
          'project_experiences',
          'project',
          entry,
          projectExperiencesFile(paths, sessionState.project_id),
          [entry.source]
        )
      ),
    ...sortByHeat(loadProjectFacts(paths, sessionState.project_id))
      .filter((entry) => !entry.archived)
      .map((entry) =>
        buildCandidate('project_facts', 'project', entry, projectFactsFile(paths, sessionState.project_id))
      ),
    ...sortByHeat(loadUserMemories(paths, userId))
      .filter((entry) => !entry.archived)
      .map((entry) =>
        buildCandidate('user_memories', 'user', entry, userMemoriesFile(paths, userId), [entry.scope])
      ),
    ...sortByHeat(loadUserExperiences(paths, userId))
      .filter((entry) => !entry.archived)
      .map((entry) =>
        buildCandidate('user_experiences', 'user', entry, userExperiencesFile(paths, userId), [entry.source])
      )
  ];
}

function buildMirrorConfig(paths, sessionState, userId) {
  const workspaceFilters = [
    {
      scope: 'session',
      ownerId: sessionState.session_key,
      source: 'session_memories'
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_decisions'
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_experiences'
    },
    {
      scope: 'project',
      ownerId: sessionState.project_id,
      source: 'project_facts'
    }
  ];
  const userFilters = [
    {
      scope: 'user',
      ownerId: userId,
      source: 'user_memories'
    },
    {
      scope: 'user',
      ownerId: userId,
      source: 'user_experiences'
    }
  ];
  const workspaceDescriptor = describeCollectionFile(sessionMemoryFile(paths, sessionState.session_key), 'entries');
  const userDescriptor = describeCollectionFile(userMemoriesFile(paths, userId), 'memories');

  return {
    workspaceDbFile: workspaceDescriptor?.dbFile || null,
    workspaceFilters,
    userDbFile: userDescriptor?.dbFile || null,
    userFilters
  };
}

function collectMirrorCandidates(paths, sessionState, userId, queryText, limit) {
  const config = buildMirrorConfig(paths, sessionState, userId);
  const rows = [
    ...searchCatalogItems(config.workspaceDbFile, config.workspaceFilters, queryText, Math.max(limit * 4, 12)),
    ...searchCatalogItems(config.userDbFile, config.userFilters, queryText, Math.max(limit * 4, 12))
  ];

  const deduped = new Map();
  rows.forEach((row) => {
    const key = `${row.source}:${row.item_id}`;
    if (!deduped.has(key)) {
      deduped.set(key, buildCandidateFromMirrorRow(row));
    }
  });

  return {
    candidates: [...deduped.values()],
    scopeSummary: {
      ...readCatalogCollectionSummaries(config.workspaceDbFile, config.workspaceFilters),
      ...readCatalogCollectionSummaries(config.userDbFile, config.userFilters)
    }
  };
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
  const mirrorResult = collectMirrorCandidates(paths, sessionState, userId, queryText, limit);
  const candidates =
    mirrorResult.candidates.length > 0 ? mirrorResult.candidates : collectFallbackCandidates(paths, sessionState, userId);
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      tier: classifyHeatTier(candidate.heat),
      score: scoreCandidate(candidate, queryTokens)
    }))
    .filter((candidate) => queryTokens.length === 0 || candidate.score > candidate.heat)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((candidate) => ({
      source: candidate.source,
      scope: candidate.scope,
      tier: candidate.tier,
      id: candidate.id,
      type: candidate.type,
      summary: candidate.summary,
      heat: candidate.heat,
      score: candidate.score,
      validation_status: candidate.validation_status,
      file: candidate.file
    }));

  const scopeSummary =
    Object.keys(mirrorResult.scopeSummary).length > 0
      ? mirrorResult.scopeSummary
      : candidates.reduce((acc, candidate) => {
          const summary = acc[candidate.source] || {
            scope: candidate.scope,
            count: 0
          };
          summary.count += 1;
          acc[candidate.source] = summary;
          return acc;
        }, {});

  return {
    status: 'ok',
    workspace: paths.workspace,
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: userId,
    query,
    query_tokens: queryTokens,
    total_candidates: candidates.length,
    returned: scored.length,
    scope_summary: scopeSummary,
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
