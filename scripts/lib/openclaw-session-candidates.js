const fs = require('fs');
const path = require('path');
const { createPaths, readJson, runtimeStateFile, sanitizeKey, sessionStateFile, sessionSummaryFile } = require('./context-anchor');
const { findSession, readHostConfig } = require('./host-config');
const { discoverOpenClawSessions } = require('./openclaw-session-discovery');

const HIDDEN_REASON_PRIORITY = [
  'closed_managed_session',
  'managed_session_binding_missing',
  'registered_without_visible_transcript',
  'workspace_unresolved',
  'missing_transcript',
  'system_sent',
  'aborted_last_run',
  'not_registered_or_discovered'
];

const HIDDEN_REASON_LABELS = {
  closed_managed_session: 'closed managed residue',
  managed_session_binding_missing: 'unbound managed residue',
  registered_without_visible_transcript: 'stale host-only',
  workspace_unresolved: 'workspace unresolved',
  missing_transcript: 'missing transcript',
  system_sent: 'system-generated',
  aborted_last_run: 'aborted residue',
  not_registered_or_discovered: 'orphaned candidate',
  other_hidden_reason: 'other hidden reason'
};

const HIDDEN_REASON_HINTS = {
  closed_managed_session:
    'Inspect the hidden sessions once, then keep closed managed residues hidden unless you intentionally want to reopen them.',
  managed_session_binding_missing:
    'Inspect the hidden sessions once, then remove or rebind the managed residues that no longer have a valid OpenClaw session id.',
  registered_without_visible_transcript:
    'Inspect the hidden sessions once, then remove or reconfigure the stale host-only registrations you no longer want to keep.',
  workspace_unresolved:
    'Inspect the hidden sessions once, then restore the missing workspace path or ignore the unresolved residue if it is no longer needed.',
  missing_transcript:
    'Inspect the hidden sessions once, then restore the missing transcript or ignore the residue if the session is no longer useful.',
  system_sent:
    'Inspect the hidden sessions only if this count looks unexpected; system-generated residues are often safe to leave hidden.',
  aborted_last_run:
    'Inspect the hidden sessions once, then decide whether to rerun or ignore the aborted residue.',
  not_registered_or_discovered:
    'Inspect the hidden sessions once, then decide whether the orphaned candidate should be restored or ignored.',
  other_hidden_reason:
    'Inspect the hidden sessions once to understand whether these residues still need attention.'
};

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
  if (
    candidate.registered &&
    candidate.managed_artifacts_visible &&
    (candidate.host_status === 'closed' || Boolean(candidate.managed_closed_at))
  ) {
    reasons.push('closed_managed_session');
  }
  if (
    candidate.registered &&
    candidate.managed_artifacts_visible &&
    !candidate.managed_openclaw_session_id
  ) {
    reasons.push('managed_session_binding_missing');
  }
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
  if (candidate.discovered === true && candidate.transcript_exists === true && candidate.session_id) {
    return true;
  }

  if (
    candidate.registered &&
    candidate.managed_artifacts_visible &&
    candidate.managed_openclaw_session_id &&
    candidate.host_status !== 'closed' &&
    !candidate.managed_closed_at
  ) {
    return true;
  }

  return false;
}

function selectPrimaryHiddenReason(candidate = {}) {
  const reasons = Array.isArray(candidate.hidden_reasons) ? candidate.hidden_reasons : [];
  for (const reason of HIDDEN_REASON_PRIORITY) {
    if (reasons.includes(reason)) {
      return reason;
    }
  }
  return reasons[0] || 'other_hidden_reason';
}

function summarizeHiddenSessionCandidates(entries = []) {
  const groups = new Map();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const reason = selectPrimaryHiddenReason(entry);
    const existing = groups.get(reason) || {
      reason,
      label: HIDDEN_REASON_LABELS[reason] || HIDDEN_REASON_LABELS.other_hidden_reason,
      count: 0,
      examples: []
    };
    existing.count += 1;
    if (existing.examples.length < 3 && entry?.session_key) {
      existing.examples.push(String(entry.session_key));
    }
    groups.set(reason, existing);
  });

  const reasons = [...groups.values()].sort((left, right) => {
    const countDelta = Number(right.count || 0) - Number(left.count || 0);
    if (countDelta !== 0) {
      return countDelta;
    }
    return String(left.label || left.reason).localeCompare(String(right.label || right.reason));
  });
  const primaryReason = reasons[0] || null;

  return {
    total: Array.isArray(entries) ? entries.length : 0,
    by_reason: reasons.reduce((acc, entry) => {
      acc[entry.reason] = Number(entry.count || 0);
      return acc;
    }, {}),
    reasons,
    summary: reasons.length > 0 ? reasons.map((entry) => `${entry.label} ${entry.count}`).join(' | ') : null,
    next_step_reason: primaryReason?.reason || null,
    next_step_hint: primaryReason ? HIDDEN_REASON_HINTS[primaryReason.reason] || HIDDEN_REASON_HINTS.other_hidden_reason : null
  };
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

function readManagedSessionBinding(workspace, sessionKey) {
  if (!workspace || !sessionKey) {
    return {
      managed_openclaw_session_id: null,
      managed_closed_at: null
    };
  }

  const paths = createPaths(workspace);
  const stateFile = sessionStateFile(paths, sessionKey);
  if (!fs.existsSync(stateFile)) {
    return {
      managed_openclaw_session_id: null,
      managed_closed_at: null
    };
  }

  const state = readJson(stateFile, null);
  return {
    managed_openclaw_session_id: state?.metadata?.openclaw_session_id || null,
    managed_closed_at: state?.closed_at || null
  };
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
    managed_openclaw_session_id: null,
    managed_closed_at: null,
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
    managed_openclaw_session_id: candidate.managed_openclaw_session_id || existing.managed_openclaw_session_id || null,
    managed_closed_at: candidate.managed_closed_at || existing.managed_closed_at || null,
    managed_artifacts_visible:
      typeof candidate.managed_artifacts_visible === 'boolean'
        ? candidate.managed_artifacts_visible || existing.managed_artifacts_visible
        : existing.managed_artifacts_visible,
    sources: [...new Set([...(existing.sources || []), ...(candidate.sources || [])])]
  };
  if (!next.session_id && next.managed_openclaw_session_id) {
    next.session_id = next.managed_openclaw_session_id;
  }
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
    const binding = readManagedSessionBinding(entry.workspace, entry.session_key);
    upsertCandidate(candidates, {
      session_key: entry.session_key,
      workspace: entry.workspace,
      user_id: entry.user_id,
      project_id: entry.project_id,
      host_status: entry.status || 'active',
      ephemeral_subagent: isEphemeralSubagentSession(entry),
      managed_openclaw_session_id: binding.managed_openclaw_session_id,
      managed_closed_at: binding.managed_closed_at,
      managed_artifacts_visible: hasManagedSessionArtifacts(entry.workspace, entry.session_key),
      registered: true,
      sources: ['host_config']
    });
  });

  discovered.forEach((entry) => {
    const uniqueHostSession = entry.workspace
      ? findSession(config, entry.workspace, entry.session_key)
      : findUniqueHostSessionByKey(config, entry.session_key);
    const binding = readManagedSessionBinding(entry.workspace || uniqueHostSession?.workspace || null, entry.session_key);
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
      managed_openclaw_session_id: binding.managed_openclaw_session_id,
      managed_closed_at: binding.managed_closed_at,
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
    excluded_hidden_sessions: excludedHiddenSessions,
    hidden_session_summary: summarizeHiddenSessionCandidates(excludedHiddenSessions)
  };
}

module.exports = {
  collectHiddenSessionReasons,
  collectSessionCandidates,
  findUniqueHostSessionByKey,
  isEphemeralSubagentSession,
  isUserVisibleSession,
  normalizeWorkspaceKey,
  selectPrimaryHiddenReason,
  summarizeHiddenSessionCandidates,
  upsertCandidate
};
