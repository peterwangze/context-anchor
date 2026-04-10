const fs = require('fs');
const path = require('path');
const { createPaths, runtimeStateFile, sanitizeKey, sessionStateFile, sessionSummaryFile } = require('./context-anchor');
const { findSession, readHostConfig } = require('./host-config');
const { discoverOpenClawSessions } = require('./openclaw-session-discovery');

function normalizeWorkspaceKey(workspace) {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function candidateIdentity(workspace, sessionKey, fallbackKey = 'unknown') {
  return workspace
    ? `${normalizeWorkspaceKey(workspace)}::${sanitizeKey(sessionKey)}`
    : `unresolved::${sanitizeKey(sessionKey)}::${fallbackKey}`;
}

function isEphemeralSubagentSession(candidate = {}) {
  const chatType = String(candidate.chat_type || '').trim().toLowerCase();
  const deliveryContext = String(candidate.delivery_context || '').trim().toLowerCase();
  const sessionKey = String(candidate.session_key || '').trim().toLowerCase();
  const sanitizedSessionKey = String(candidate.sanitized_session_key || '').trim().toLowerCase();
  const keyLooksLikeSubagent =
    /(^|[-:])subagent([-:]|$)/i.test(sessionKey) ||
    /(^|[-:])subagent([-:]|$)/i.test(sanitizedSessionKey);
  return chatType === 'subagent' || deliveryContext === 'subagent' || keyLooksLikeSubagent;
}

function collectHiddenSessionReasons(candidate = {}) {
  const reasons = [];
  const hasVisibleTranscript = candidate.discovered === true && candidate.transcript_exists === true;
  if (!candidate.registered && !candidate.discovered) {
    reasons.push('not_registered_or_discovered');
  }
  if (candidate.registered && !hasVisibleTranscript && !candidate.managed_artifacts_visible) {
    reasons.push('registered_without_visible_transcript');
  }
  if (!candidate.registered && !candidate.transcript_exists) {
    reasons.push('missing_transcript');
  }
  if (!candidate.registered && !candidate.workspace) {
    reasons.push('workspace_unresolved');
  }
  if (candidate.system_sent === true) {
    reasons.push('system_sent');
  }
  if (candidate.aborted_last_run === true && !candidate.registered) {
    reasons.push('aborted_last_run');
  }
  return reasons;
}

function isUserVisibleSession(candidate = {}) {
  if (candidate.discovered === true && candidate.transcript_exists === true) {
    return true;
  }

  if (candidate.registered && candidate.managed_artifacts_visible) {
    return true;
  }

  return false;
}

function hasManagedSessionArtifacts(workspace, sessionKey) {
  if (!workspace || !sessionKey) {
    return false;
  }

  const paths = createPaths(workspace);
  return [sessionStateFile(paths, sessionKey), runtimeStateFile(paths, sessionKey), sessionSummaryFile(paths, sessionKey)].some(
    (file) => fs.existsSync(file)
  );
}

function upsertCandidate(map, candidate) {
  const identity = candidateIdentity(
    candidate.workspace,
    candidate.session_key,
    candidate.session_id || candidate.agent || 'candidate'
  );
  const existing = map.get(identity) || {
    session_key: candidate.session_key,
    sanitized_session_key: sanitizeKey(candidate.session_key),
    workspace: candidate.workspace ? path.resolve(candidate.workspace) : null,
    session_id: null,
    user_id: null,
    project_id: null,
    host_status: null,
    chat_type: null,
    delivery_context: null,
    ephemeral_subagent: false,
    transcript_exists: false,
    discovered: false,
    registered: false,
    system_sent: false,
    aborted_last_run: false,
    managed_artifacts_visible: false,
    hidden_reasons: [],
    sources: []
  };
  const next = {
    ...existing,
    ...candidate,
    session_key: candidate.session_key || existing.session_key,
    sanitized_session_key: sanitizeKey(candidate.session_key || existing.session_key),
    workspace: candidate.workspace ? path.resolve(candidate.workspace) : existing.workspace,
    session_id: candidate.session_id || existing.session_id || null,
    user_id: candidate.user_id || existing.user_id || null,
    project_id: candidate.project_id || existing.project_id || null,
    host_status: candidate.host_status || existing.host_status || null,
    chat_type: candidate.chat_type || existing.chat_type || null,
    delivery_context: candidate.delivery_context || existing.delivery_context || null,
    ephemeral_subagent: Boolean(candidate.ephemeral_subagent || existing.ephemeral_subagent),
    transcript_exists: Boolean(candidate.transcript_exists || existing.transcript_exists),
    discovered: Boolean(candidate.discovered || existing.discovered),
    registered: Boolean(candidate.registered || existing.registered),
    system_sent: Boolean(candidate.system_sent || existing.system_sent),
    aborted_last_run: Boolean(candidate.aborted_last_run || existing.aborted_last_run),
    managed_artifacts_visible:
      typeof candidate.managed_artifacts_visible === 'boolean'
        ? candidate.managed_artifacts_visible || existing.managed_artifacts_visible
        : existing.managed_artifacts_visible,
    sources: [...new Set([...(existing.sources || []), ...(candidate.sources || [])])]
  };
  next.hidden_reasons = collectHiddenSessionReasons(next);
  map.set(identity, next);
}

function findUniqueHostSessionByKey(config, sessionKey) {
  const matches = (config.sessions || []).filter((entry) => entry.session_key === sanitizeKey(sessionKey));
  return matches.length === 1 ? matches[0] : null;
}

function collectSessionCandidates(openClawHome, options = {}) {
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
      ephemeral_subagent: isEphemeralSubagentSession(entry),
      managed_artifacts_visible: hasManagedSessionArtifacts(entry.workspace, entry.session_key),
      registered: true,
      sources: ['host_config']
    });
  });

  discovered.forEach((entry) => {
    const uniqueHostSession = entry.workspace
      ? findSession(config, entry.workspace, entry.session_key)
      : findUniqueHostSessionByKey(config, entry.session_key);
    upsertCandidate(candidates, {
      session_key: entry.session_key,
      workspace: entry.workspace || uniqueHostSession?.workspace || null,
      session_id: entry.session_id,
      user_id: uniqueHostSession?.user_id || null,
      project_id: uniqueHostSession?.project_id || null,
      host_status: uniqueHostSession?.status || null,
      chat_type: entry.chat_type || null,
      delivery_context: entry.delivery_context || null,
      ephemeral_subagent: isEphemeralSubagentSession(entry),
      transcript_exists: entry.transcript_exists,
      system_sent: entry.system_sent,
      aborted_last_run: entry.aborted_last_run,
      managed_artifacts_visible: hasManagedSessionArtifacts(entry.workspace || uniqueHostSession?.workspace || null, entry.session_key),
      discovered: true,
      registered: Boolean(uniqueHostSession),
      agent: entry.agent,
      sources: ['openclaw_session']
    });
  });

  const allCandidates = [...candidates.values()].sort((left, right) => {
    const leftWorkspace = left.workspace || '';
    const rightWorkspace = right.workspace || '';
    if (leftWorkspace !== rightWorkspace) {
      return leftWorkspace.localeCompare(rightWorkspace);
    }
    return left.session_key.localeCompare(right.session_key);
  });

  const excludedSubagentSessions = options.includeSubagents
    ? []
    : allCandidates.filter((entry) => entry.ephemeral_subagent);
  const visibleCandidates = allCandidates.filter((entry) => isUserVisibleSession(entry));
  const excludedHiddenSessions = options.includeHiddenSessions
    ? []
    : allCandidates.filter((entry) => !entry.ephemeral_subagent && !isUserVisibleSession(entry));

  return {
    candidates: options.includeSubagents
      ? (options.includeHiddenSessions ? allCandidates : visibleCandidates.filter((entry) => !entry.ephemeral_subagent))
      : (options.includeHiddenSessions ? allCandidates.filter((entry) => !entry.ephemeral_subagent) : visibleCandidates.filter((entry) => !entry.ephemeral_subagent)),
    excluded_subagent_sessions: excludedSubagentSessions,
    excluded_hidden_sessions: excludedHiddenSessions
  };
}

module.exports = {
  collectHiddenSessionReasons,
  collectSessionCandidates,
  findUniqueHostSessionByKey,
  isEphemeralSubagentSession,
  isUserVisibleSession,
  normalizeWorkspaceKey,
  upsertCandidate
};
