#!/usr/bin/env node

const path = require('path');
const {
  createPaths,
  getOpenClawHome,
  readMirroredDocumentSnapshot,
  sanitizeKey,
  sessionStateFile
} = require('./lib/context-anchor');
const { buildBootstrapCacheContent, buildBootstrapCachePath, writeBootstrapCache } = require('./lib/bootstrap-cache');
const {
  ensureWorkspaceRegistration,
  findSession,
  readHostConfig,
  resolveOwnership
} = require('./lib/host-config');
const { discoverOpenClawSessions } = require('./lib/openclaw-session-discovery');
const { runMirrorRebuild } = require('./mirror-rebuild');
const { runSessionStart } = require('./session-start');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    workspace: null,
    sessionKey: null,
    includeClosed: false,
    rebuildMirror: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--openclaw-home') {
      options.openclawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--skills-root') {
      options.skillsRoot = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--session-key') {
      options.sessionKey = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--include-closed') {
      options.includeClosed = true;
      continue;
    }

    if (arg === '--rebuild-mirror') {
      options.rebuildMirror = true;
    }
  }

  return options;
}

function normalizeWorkspaceKey(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function candidateIdentity(workspace, sessionKey, fallbackKey = 'unknown') {
  return workspace
    ? `${normalizeWorkspaceKey(workspace)}::${sanitizeKey(sessionKey)}`
    : `unresolved::${sanitizeKey(sessionKey)}::${fallbackKey}`;
}

function upsertCandidate(map, candidate) {
  const identity = candidateIdentity(candidate.workspace, candidate.session_key, candidate.session_id || candidate.agent || 'candidate');
  const existing = map.get(identity) || {
    session_key: sanitizeKey(candidate.session_key),
    workspace: candidate.workspace ? path.resolve(candidate.workspace) : null,
    session_id: null,
    user_id: null,
    project_id: null,
    host_status: null,
    transcript_exists: false,
    discovered: false,
    registered: false,
    sources: []
  };
  const next = {
    ...existing,
    ...candidate,
    session_key: sanitizeKey(candidate.session_key || existing.session_key),
    workspace: candidate.workspace ? path.resolve(candidate.workspace) : existing.workspace,
    session_id: candidate.session_id || existing.session_id || null,
    user_id: candidate.user_id || existing.user_id || null,
    project_id: candidate.project_id || existing.project_id || null,
    host_status: candidate.host_status || existing.host_status || null,
    transcript_exists: Boolean(candidate.transcript_exists || existing.transcript_exists),
    discovered: Boolean(candidate.discovered || existing.discovered),
    registered: Boolean(candidate.registered || existing.registered),
    sources: [...new Set([...(existing.sources || []), ...(candidate.sources || [])])]
  };
  map.set(identity, next);
}

function findUniqueHostSessionByKey(config, sessionKey) {
  const matches = (config.sessions || []).filter((entry) => entry.session_key === sanitizeKey(sessionKey));
  return matches.length === 1 ? matches[0] : null;
}

function collectUpgradeCandidates(openClawHome) {
  const config = readHostConfig(openClawHome);
  const discovered = discoverOpenClawSessions(openClawHome);
  const candidates = new Map();

  (config.sessions || []).forEach((entry) => {
    upsertCandidate(candidates, {
      session_key: entry.session_key,
      workspace: entry.workspace,
      user_id: entry.user_id,
      project_id: entry.project_id,
      host_status: entry.status || 'active',
      registered: true,
      sources: ['host_config']
    });
  });

  discovered.forEach((entry) => {
    const uniqueHostSession = entry.workspace ? findSession(config, entry.workspace, entry.session_key) : findUniqueHostSessionByKey(config, entry.session_key);
    upsertCandidate(candidates, {
      session_key: entry.session_key,
      workspace: entry.workspace || uniqueHostSession?.workspace || null,
      session_id: entry.session_id,
      user_id: uniqueHostSession?.user_id || null,
      project_id: uniqueHostSession?.project_id || null,
      host_status: uniqueHostSession?.status || null,
      transcript_exists: entry.transcript_exists,
      discovered: true,
      registered: Boolean(uniqueHostSession),
      agent: entry.agent,
      sources: ['openclaw_session']
    });
  });

  return [...candidates.values()].sort((left, right) => {
    const leftWorkspace = left.workspace || '';
    const rightWorkspace = right.workspace || '';
    if (leftWorkspace !== rightWorkspace) {
      return leftWorkspace.localeCompare(rightWorkspace);
    }
    return left.session_key.localeCompare(right.session_key);
  });
}

function matchesFilters(candidate, options = {}) {
  if (options.workspace) {
    if (!candidate.workspace) {
      return false;
    }

    if (normalizeWorkspaceKey(candidate.workspace) !== normalizeWorkspaceKey(options.workspace)) {
      return false;
    }
  }

  if (options.sessionKey && sanitizeKey(candidate.session_key) !== sanitizeKey(options.sessionKey)) {
    return false;
  }

  return true;
}

function classifyClosedCandidate(candidate, existingState) {
  if (candidate.discovered) {
    return false;
  }

  return candidate.host_status === 'closed' || Boolean(existingState?.closed_at);
}

function upgradeCandidate(openClawHome, candidate, options = {}) {
  if (!candidate.workspace) {
    return {
      session_key: candidate.session_key,
      workspace: null,
      action: 'skipped',
      reason: 'workspace_unresolved',
      status: 'unresolved',
      sources: candidate.sources
    };
  }

  const paths = createPaths(candidate.workspace);
  const existingState = readMirroredDocumentSnapshot(sessionStateFile(paths, candidate.session_key), null);
  const closed = classifyClosedCandidate(candidate, existingState);
  if (closed && !options.includeClosed) {
    return {
      session_key: candidate.session_key,
      workspace: candidate.workspace,
      action: 'skipped',
      reason: 'closed_session',
      status: 'closed',
      sources: candidate.sources
    };
  }

  const ownership = resolveOwnership(openClawHome, {
    workspace: candidate.workspace,
    sessionKey: candidate.session_key,
    projectId: candidate.project_id,
    userId: candidate.user_id
  });
  const ensured = ensureWorkspaceRegistration(openClawHome, candidate.workspace, {
    userId: ownership.userId,
    projectId: ownership.projectId,
    reason: 'upgrade_sessions'
  });

  if (ensured.status === 'blocked') {
    return {
      session_key: candidate.session_key,
      workspace: candidate.workspace,
      action: 'skipped',
      reason: 'workspace_needs_configuration',
      status: 'needs_configuration',
      sources: candidate.sources,
      onboarding: ensured
    };
  }

  const summary = runSessionStart(candidate.workspace, candidate.session_key, ownership.projectId, {
    userId: ownership.userId,
    openClawSessionId: candidate.session_id || existingState?.metadata?.openclaw_session_id || null,
    reopenClosed: !closed
  });
  const bootstrapCache = buildBootstrapCachePath(candidate.workspace, candidate.session_key);
  writeBootstrapCache(bootstrapCache, buildBootstrapCacheContent(summary));

  return {
    session_key: candidate.session_key,
    workspace: candidate.workspace,
    action: 'upgraded',
    status: closed ? 'closed' : 'active',
    sources: candidate.sources,
    bootstrap_cache: bootstrapCache,
    session_id: candidate.session_id || existingState?.metadata?.openclaw_session_id || null,
    recovered_continuity: Boolean(summary.recovery?.continuity?.recovered_before_restore),
    restored: Boolean(summary.session?.restored),
    continued_from: summary.session?.continued_from || null,
    effective_skills: (summary.effective_skills || []).length
  };
}

function runUpgradeSessions(openClawHomeArg, skillsRootArg, options = {}) {
  const openClawHome = getOpenClawHome(openClawHomeArg || options.openclawHome || null);
  const candidates = collectUpgradeCandidates(openClawHome).filter((candidate) => matchesFilters(candidate, options));
  const results = candidates.map((candidate) => upgradeCandidate(openClawHome, candidate, options));
  const rebuildWorkspace =
    options.workspace ||
    ([...new Set(results.map((entry) => entry.workspace).filter(Boolean))].length === 1
      ? results.map((entry) => entry.workspace).filter(Boolean)[0]
      : null);
  const mirrorRebuild = options.rebuildMirror
    ? runMirrorRebuild(rebuildWorkspace, openClawHome, {})
    : null;

  return {
    status: 'ok',
    openclaw_home: openClawHome,
    selected_sessions: candidates.length,
    upgraded_sessions: results.filter((entry) => entry.action === 'upgraded').length,
    skipped_sessions: results.filter((entry) => entry.action === 'skipped').length,
    unresolved_sessions: results.filter((entry) => entry.reason === 'workspace_unresolved').length,
    configuration_required_sessions: results.filter((entry) => entry.reason === 'workspace_needs_configuration').length,
    mirror_rebuild: mirrorRebuild,
    results
  };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runUpgradeSessions(options.openclawHome, options.skillsRoot, options);
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
  collectUpgradeCandidates,
  main,
  parseArgs,
  runUpgradeSessions
};
