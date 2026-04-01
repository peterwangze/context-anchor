#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  clamp,
  createPaths,
  loadProjectDecisionArchive,
  loadProjectDecisions,
  loadProjectExperienceArchive,
  loadProjectExperiences,
  loadProjectFactArchive,
  loadProjectFacts,
  loadSessionExperienceArchive,
  loadSessionExperiences,
  loadSessionMemory,
  loadSessionMemoryArchive,
  loadSessionState,
  loadUserExperienceArchive,
  loadUserExperiences,
  loadUserMemories,
  loadUserMemoryArchive,
  nowIso,
  sanitizeKey,
  sessionExperiencesArchiveFile,
  sessionExperiencesFile,
  sessionMemoryArchiveFile,
  sessionMemoryFile,
  syncProjectStateMetadata,
  uniqueList,
  userExperiencesArchiveFile,
  userExperiencesFile,
  userMemoriesArchiveFile,
  userMemoriesFile,
  writeProjectDecisionArchive,
  writeProjectDecisions,
  writeProjectExperienceArchive,
  writeProjectExperiences,
  writeProjectFactArchive,
  writeProjectFacts,
  writeSessionExperienceArchive,
  writeSessionExperiences,
  writeSessionMemory,
  writeSessionMemoryArchive,
  writeUserExperienceArchive,
  writeUserExperiences,
  writeUserMemories,
  writeUserMemoryArchive,
  projectDecisionsArchiveFile,
  projectDecisionsFile,
  projectExperiencesArchiveFile,
  projectExperiencesFile,
  projectFactsArchiveFile,
  projectFactsFile
} = require('./lib/context-anchor');
const { resolveOwnership } = require('./lib/host-config');
const { recordGovernanceRun } = require('./lib/context-anchor-db');

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveGovernanceMode(modeArg) {
  const value = String(modeArg || process.env.CONTEXT_ANCHOR_GOVERNANCE_MODE || 'enforce')
    .trim()
    .toLowerCase();
  return value === 'report' ? 'report' : 'enforce';
}

function resolveArchivePruneEnabled(pruneArg) {
  if (pruneArg !== undefined) {
    return Boolean(pruneArg);
  }

  return process.env.CONTEXT_ANCHOR_ARCHIVE_PRUNE !== '0';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getValidationStatus(entry = {}) {
  return entry.validation?.status || entry.validation_status || null;
}

function scoreValidation(status) {
  switch (status) {
    case 'validated':
      return 100;
    case 'pending':
      return 40;
    case 'rejected':
      return 0;
    default:
      return 30;
  }
}

function scoreSourcePriority(entry = {}, source) {
  if (source === 'project_decisions') {
    return 100;
  }

  if (source === 'project_experiences' || source === 'user_experiences' || source === 'session_experiences') {
    return getValidationStatus(entry) === 'validated' ? 95 : 80;
  }

  if (source === 'project_facts') {
    return 70;
  }

  if (source === 'user_memories' || source === 'session_memories') {
    return 60;
  }

  return 50;
}

function scoreRecency(entry = {}, nowMs = Date.now()) {
  const candidate = new Date(entry.last_accessed || entry.created_at || 0).getTime();
  if (!candidate) {
    return 0;
  }

  const days = Math.max(0, (nowMs - candidate) / DAY_MS);
  return clamp(100 - days * 2, 0, 100);
}

function scoreAccess(entry = {}) {
  const accessCount = Number(entry.access_count || entry.applied_count || 0);
  return clamp(accessCount * 10, 0, 100);
}

function scoreCrossSession(entry = {}) {
  const sessionCount = uniqueList(entry.access_sessions || []).length;
  return clamp(sessionCount * 25, 0, 100);
}

function calculateRetentionScore(entry = {}, source, nowMs = Date.now()) {
  const heat = clamp(Number(entry.heat || 0), 0, 100);
  const recency = scoreRecency(entry, nowMs);
  const access = scoreAccess(entry);
  const validation = scoreValidation(getValidationStatus(entry));
  const crossSession = scoreCrossSession(entry);
  const sourcePriority = scoreSourcePriority(entry, source);

  return Number(
    (
      heat * 0.35 +
      recency * 0.2 +
      access * 0.15 +
      validation * 0.15 +
      crossSession * 0.1 +
      sourcePriority * 0.05
    ).toFixed(4)
  );
}

function compareIsoDesc(left, right) {
  return new Date(right || 0).getTime() - new Date(left || 0).getTime();
}

function compareGovernanceEntries(left, right) {
  const scoreGap = Number(right.retention_score || 0) - Number(left.retention_score || 0);
  if (scoreGap !== 0) {
    return scoreGap;
  }

  const lastAccessGap = compareIsoDesc(left.last_accessed || left.created_at, right.last_accessed || right.created_at);
  if (lastAccessGap !== 0) {
    return lastAccessGap;
  }

  const createdGap = compareIsoDesc(left.created_at, right.created_at);
  if (createdGap !== 0) {
    return createdGap;
  }

  return String(left.id || '').localeCompare(String(right.id || ''));
}

function stableJsonHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function buildContentHash(entry = {}, source) {
  if (entry.content_hash) {
    return entry.content_hash;
  }

  return stableJsonHash({
    source,
    type: entry.type || null,
    summary: normalizeText(entry.summary || entry.decision || entry.content || entry.what || entry.name || entry.id),
    content: normalizeText(entry.content || entry.decision || ''),
    source_entry: entry.source_session_entry_id || null,
    source_name: normalizeText(entry.source || ''),
    source_session: sanitizeKey(entry.source_session || entry.session_key || ''),
    source_project: sanitizeKey(entry.source_project || entry.project_id || ''),
    source_user: sanitizeKey(entry.source_user || entry.user_id || '')
  });
}

function pickEarlier(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left;
  }
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function pickLater(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left;
  }
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function pickLonger(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left;
  }
  return String(left).length >= String(right).length ? left : right;
}

function mergeEvidence(left = [], right = []) {
  const seen = new Set();
  return [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].filter((entry) => {
    const key = stableJsonHash(entry || {});
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function mergeValidation(primary, secondary) {
  const primaryStatus = getValidationStatus(primary);
  const secondaryStatus = getValidationStatus(secondary);
  const betterStatus =
    scoreValidation(primaryStatus) >= scoreValidation(secondaryStatus) ? primaryStatus : secondaryStatus;

  if (!betterStatus) {
    return {
      validation: primary.validation || secondary.validation || undefined,
      validation_status: primary.validation_status || secondary.validation_status || undefined
    };
  }

  const baseValidation = primary.validation || secondary.validation || {};
  return {
    validation: {
      ...baseValidation,
      status: betterStatus
    },
    validation_status: betterStatus
  };
}

function prepareGovernanceEntry(entry, source, originTier, nowMs) {
  const normalized = {
    ...entry,
    content_hash: buildContentHash(entry, source),
    origin_tiers: [originTier],
    duplicate_ids: entry.id ? [entry.id] : []
  };
  normalized.retention_score = calculateRetentionScore(normalized, source, nowMs);
  return normalized;
}

function mergeDuplicateEntries(existing, incoming, source, nowMs) {
  const existingOrder = compareGovernanceEntries(existing, incoming);
  const preferred = existingOrder <= 0 ? existing : incoming;
  const secondary = preferred === existing ? incoming : existing;
  const validation = mergeValidation(preferred, secondary);

  const merged = {
    ...secondary,
    ...preferred,
    id: preferred.id || secondary.id,
    content_hash: preferred.content_hash || secondary.content_hash || buildContentHash(preferred, source),
    heat: Math.max(Number(preferred.heat || 0), Number(secondary.heat || 0)),
    access_count: Math.max(Number(preferred.access_count || 0), Number(secondary.access_count || 0)),
    applied_count: Math.max(Number(preferred.applied_count || 0), Number(secondary.applied_count || 0)),
    access_sessions: uniqueList([...(preferred.access_sessions || []), ...(secondary.access_sessions || [])]),
    tags: uniqueList([...(preferred.tags || []), ...(secondary.tags || [])]),
    created_at: pickEarlier(preferred.created_at, secondary.created_at),
    last_accessed: pickLater(
      preferred.last_accessed || preferred.created_at,
      secondary.last_accessed || secondary.created_at
    ),
    archived: Boolean(preferred.archived || secondary.archived),
    archived_at: preferred.archived_at || secondary.archived_at || null,
    archive_reason: preferred.archive_reason || secondary.archive_reason || null,
    details: pickLonger(preferred.details, secondary.details),
    solution: pickLonger(preferred.solution, secondary.solution),
    content: pickLonger(preferred.content, secondary.content),
    summary: preferred.summary || secondary.summary || null,
    evidence: mergeEvidence(preferred.evidence, secondary.evidence),
    origin_tiers: uniqueList([...(preferred.origin_tiers || []), ...(secondary.origin_tiers || [])]),
    duplicate_ids: uniqueList([...(preferred.duplicate_ids || []), ...(secondary.duplicate_ids || [])]),
    ...validation
  };
  merged.retention_score = calculateRetentionScore(merged, source, nowMs);
  return merged;
}

function stripGovernanceFields(entry = {}) {
  const next = { ...entry };
  delete next.retention_score;
  delete next.origin_tiers;
  delete next.duplicate_ids;
  return next;
}

function activateEntry(entry) {
  return {
    ...stripGovernanceFields(entry),
    archived: false,
    archived_at: null,
    archive_reason: null
  };
}

function archiveEntry(entry, timestamp) {
  return {
    ...stripGovernanceFields(entry),
    archived: true,
    archived_at: entry.archived_at || timestamp,
    archive_reason: entry.archive_reason || 'retention_budget'
  };
}

function measureCollectionBytes(key, items) {
  return Buffer.byteLength(`${JSON.stringify({ [key]: items }, null, 2)}\n`, 'utf8');
}

function buildGovernanceSpecs(paths, sessionKey, projectId, userId) {
  return [
    {
      source: 'session_memories',
      key: 'entries',
      budget: DEFAULTS.storageGovernance.session_memories,
      activeFile: sessionMemoryFile(paths, sessionKey),
      archiveFile: sessionMemoryArchiveFile(paths, sessionKey),
      loadActive: () => (fs.existsSync(sessionMemoryFile(paths, sessionKey)) ? loadSessionMemory(paths, sessionKey) : []),
      loadArchive: () =>
        (fs.existsSync(sessionMemoryArchiveFile(paths, sessionKey)) ? loadSessionMemoryArchive(paths, sessionKey) : []),
      writeActive: (items) => writeSessionMemory(paths, sessionKey, items),
      writeArchive: (items) => writeSessionMemoryArchive(paths, sessionKey, items)
    },
    {
      source: 'session_experiences',
      key: 'experiences',
      budget: DEFAULTS.storageGovernance.session_experiences,
      activeFile: sessionExperiencesFile(paths, sessionKey),
      archiveFile: sessionExperiencesArchiveFile(paths, sessionKey),
      loadActive: () =>
        (fs.existsSync(sessionExperiencesFile(paths, sessionKey)) ? loadSessionExperiences(paths, sessionKey) : []),
      loadArchive: () =>
        (fs.existsSync(sessionExperiencesArchiveFile(paths, sessionKey))
          ? loadSessionExperienceArchive(paths, sessionKey)
          : []),
      writeActive: (items) => writeSessionExperiences(paths, sessionKey, items),
      writeArchive: (items) => writeSessionExperienceArchive(paths, sessionKey, items)
    },
    {
      source: 'project_decisions',
      key: 'decisions',
      budget: DEFAULTS.storageGovernance.project_decisions,
      activeFile: projectDecisionsFile(paths, projectId),
      archiveFile: projectDecisionsArchiveFile(paths, projectId),
      loadActive: () => loadProjectDecisions(paths, projectId),
      loadArchive: () => loadProjectDecisionArchive(paths, projectId),
      writeActive: (items) => writeProjectDecisions(paths, projectId, items),
      writeArchive: (items) => writeProjectDecisionArchive(paths, projectId, items)
    },
    {
      source: 'project_experiences',
      key: 'experiences',
      budget: DEFAULTS.storageGovernance.project_experiences,
      activeFile: projectExperiencesFile(paths, projectId),
      archiveFile: projectExperiencesArchiveFile(paths, projectId),
      loadActive: () => loadProjectExperiences(paths, projectId),
      loadArchive: () => loadProjectExperienceArchive(paths, projectId),
      writeActive: (items) => writeProjectExperiences(paths, projectId, items),
      writeArchive: (items) => writeProjectExperienceArchive(paths, projectId, items)
    },
    {
      source: 'project_facts',
      key: 'facts',
      budget: DEFAULTS.storageGovernance.project_facts,
      activeFile: projectFactsFile(paths, projectId),
      archiveFile: projectFactsArchiveFile(paths, projectId),
      loadActive: () => loadProjectFacts(paths, projectId),
      loadArchive: () => loadProjectFactArchive(paths, projectId),
      writeActive: (items) => writeProjectFacts(paths, projectId, items),
      writeArchive: (items) => writeProjectFactArchive(paths, projectId, items)
    },
    {
      source: 'user_memories',
      key: 'memories',
      budget: DEFAULTS.storageGovernance.user_memories,
      activeFile: userMemoriesFile(paths, userId),
      archiveFile: userMemoriesArchiveFile(paths, userId),
      loadActive: () => loadUserMemories(paths, userId),
      loadArchive: () => loadUserMemoryArchive(paths, userId),
      writeActive: (items) => writeUserMemories(paths, userId, items),
      writeArchive: (items) => writeUserMemoryArchive(paths, userId, items)
    },
    {
      source: 'user_experiences',
      key: 'experiences',
      budget: DEFAULTS.storageGovernance.user_experiences,
      activeFile: userExperiencesFile(paths, userId),
      archiveFile: userExperiencesArchiveFile(paths, userId),
      loadActive: () => loadUserExperiences(paths, userId),
      loadArchive: () => loadUserExperienceArchive(paths, userId),
      writeActive: (items) => writeUserExperiences(paths, userId, items),
      writeArchive: (items) => writeUserExperienceArchive(paths, userId, items)
    }
  ];
}

function governCollection(spec, options = {}) {
  const timestamp = options.timestamp || nowIso();
  const nowMs = new Date(timestamp).getTime();
  const activeItems = spec.loadActive();
  const archiveItems = spec.loadArchive();
  const merged = new Map();

  [...activeItems.map((entry) => ({ entry, tier: 'active' })), ...archiveItems.map((entry) => ({ entry, tier: 'archive' }))].forEach(
    ({ entry, tier }) => {
      const prepared = prepareGovernanceEntry(entry, spec.source, tier, nowMs);
      const existing = merged.get(prepared.content_hash);
      if (!existing) {
        merged.set(prepared.content_hash, prepared);
        return;
      }

      merged.set(prepared.content_hash, mergeDuplicateEntries(existing, prepared, spec.source, nowMs));
    }
  );

  const ranked = [...merged.values()].sort(compareGovernanceEntries);
  const activeLimit = Number(spec.budget.active || 0);
  const archiveLimit = Number(spec.budget.archive || 0);
  const nextActive = ranked.slice(0, activeLimit).map((entry) => activateEntry(entry));
  const nextArchiveAll = ranked.slice(activeLimit).map((entry) => archiveEntry(entry, timestamp));
  const nextArchive = options.pruneArchive === false ? nextArchiveAll : nextArchiveAll.slice(0, archiveLimit);
  const pruned = options.pruneArchive === false ? [] : nextArchiveAll.slice(archiveLimit);
  const activeIdsBefore = new Set(activeItems.map((entry) => entry.id).filter(Boolean));
  const archiveIdsBefore = new Set(archiveItems.map((entry) => entry.id).filter(Boolean));

  if (options.mode === 'enforce') {
    spec.writeActive(nextActive);
    spec.writeArchive(nextArchive);
  }

  return {
    source: spec.source,
    active_file: spec.activeFile,
    archive_file: spec.archiveFile,
    active_before: activeItems.length,
    archive_before: archiveItems.length,
    active_after: nextActive.length,
    archive_after: nextArchive.length,
    deduped: activeItems.length + archiveItems.length - ranked.length,
    archived: nextArchive.filter((entry) => activeIdsBefore.has(entry.id)).length,
    restored: nextActive.filter((entry) => archiveIdsBefore.has(entry.id)).length,
    pruned: pruned.length,
    bytes_before: measureCollectionBytes(spec.key, activeItems) + measureCollectionBytes(spec.key, archiveItems),
    bytes_after: measureCollectionBytes(spec.key, nextActive) + measureCollectionBytes(spec.key, nextArchive),
    moved_ids: {
      archived: nextArchive.map((entry) => entry.id).filter((id) => activeIdsBefore.has(id)),
      restored: nextActive.map((entry) => entry.id).filter((id) => archiveIdsBefore.has(id)),
      pruned: pruned.map((entry) => entry.id).filter(Boolean)
    }
  };
}

function runStorageGovernance(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg || DEFAULTS.sessionKey);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: options.projectId,
    userId: options.userId
  });
  const sessionState = loadSessionState(paths, sessionKey, ownership.projectId, {
    createIfMissing: true,
    touch: false,
    userId: ownership.userId
  });
  const projectId = sessionState.project_id || ownership.projectId;
  const userId = sessionState.user_id || ownership.userId;
  const mode = resolveGovernanceMode(options.mode);
  const pruneArchive = resolveArchivePruneEnabled(options.pruneArchive);
  const timestamp = nowIso();
  const collections = buildGovernanceSpecs(paths, sessionKey, projectId, userId).map((spec) =>
    governCollection(spec, {
      mode,
      pruneArchive,
      timestamp
    })
  );

  if (mode === 'enforce') {
    syncProjectStateMetadata(paths, projectId);
  }

  const result = {
    status: 'ok',
    workspace: paths.workspace,
    session_key: sessionKey,
    project_id: projectId,
    user_id: userId,
    reason: options.reason || null,
    mode,
    prune_archive: pruneArchive,
    applied: mode === 'enforce',
    governed_at: timestamp,
    collections,
    totals: collections.reduce(
      (acc, entry) => {
        acc.active_before += entry.active_before;
        acc.archive_before += entry.archive_before;
        acc.active_after += entry.active_after;
        acc.archive_after += entry.archive_after;
        acc.deduped += entry.deduped;
        acc.archived += entry.archived;
        acc.restored += entry.restored;
        acc.pruned += entry.pruned;
        acc.bytes_before += entry.bytes_before;
        acc.bytes_after += entry.bytes_after;
        return acc;
      },
      {
        active_before: 0,
        archive_before: 0,
        active_after: 0,
        archive_after: 0,
        deduped: 0,
        archived: 0,
        restored: 0,
        pruned: 0,
        bytes_before: 0,
        bytes_after: 0
      }
    )
  };

  result.run_id = `gov-${timestamp.replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  result.recorded = recordGovernanceRun(path.join(paths.anchorDir, 'catalog.sqlite'), result);

  return result;
}

function main() {
  const result = runStorageGovernance(process.argv[2], process.argv[3], {
    projectId: process.argv[4],
    userId: process.argv[5],
    reason: process.argv[6],
    mode: process.argv[7]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  calculateRetentionScore,
  compareGovernanceEntries,
  governCollection,
  runStorageGovernance
};
