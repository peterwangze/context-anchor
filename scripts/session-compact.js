#!/usr/bin/env node

const {
  buildBootstrapCachePath,
  buildMinimalBootstrapContent,
  writeBootstrapCache
} = require('./lib/bootstrap-cache');
const {
  createPaths,
  loadSessionState,
  sanitizeKey,
  writeSessionState
} = require('./lib/context-anchor');
const { recordSessionOwnership, resolveOwnership } = require('./lib/host-config');
const { runCheckpointCreate } = require('./checkpoint-create');
const { runCompactPacketCreate } = require('./compact-packet-create');
const { runHeartbeat } = require('./heartbeat');
const { runSessionExperienceSync } = require('./session-experience-sync');
const { runSkillDraftCreate } = require('./skill-draft-create');

function updateCompactMetadata(sessionState, phase, eventContext = {}) {
  sessionState.metadata = {
    ...(sessionState.metadata || {}),
    ...(typeof eventContext.sessionId === 'string' && eventContext.sessionId.trim()
      ? { openclaw_session_id: eventContext.sessionId.trim() }
      : {}),
    last_compaction_event: phase,
    last_compaction_at: new Date().toISOString()
  };

  if (eventContext.messageCount !== undefined) {
    sessionState.metadata.compaction_message_count = Number(eventContext.messageCount);
  }
  if (eventContext.tokenCount !== undefined) {
    sessionState.metadata.compaction_token_count = Number(eventContext.tokenCount);
  }
  if (eventContext.compactedCount !== undefined) {
    sessionState.metadata.compaction_compacted_count = Number(eventContext.compactedCount);
  }
  if (eventContext.firstKeptEntryId) {
    sessionState.metadata.compaction_first_kept_entry_id = eventContext.firstKeptEntryId;
  }
}

function refreshBootstrapCache(workspace, sessionKey, ownership) {
  const bootstrapCache = buildBootstrapCachePath(workspace, sessionKey);
  const content = buildMinimalBootstrapContent(workspace, sessionKey, ownership);
  if (content.trim()) {
    writeBootstrapCache(bootstrapCache, content);
  }

  return {
    bootstrap_cache: bootstrapCache,
    bootstrap_content_written: Boolean(content.trim())
  };
}

function runSessionCompact(workspaceArg, sessionKeyArg, options = {}) {
  const phase = options.phase === 'after' ? 'after' : 'before';
  const sessionKey = sanitizeKey(sessionKeyArg);
  const paths = createPaths(workspaceArg);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    sessionKey,
    projectId: options.projectId,
    userId: options.userId
  });

  const sessionState = loadSessionState(paths, sessionKey, ownership.projectId, {
    createIfMissing: true,
    touch: true,
    userId: ownership.userId
  });
  sessionState.user_id = ownership.userId;
  sessionState.project_id = ownership.projectId;
  updateCompactMetadata(sessionState, phase, options.eventContext);
  writeSessionState(paths, sessionKey, sessionState);

  const actions = [];
  const result = {
    status: 'handled',
    phase,
    session_key: sessionKey,
    project_id: ownership.projectId,
    user_id: ownership.userId,
    actions
  };

  if (phase === 'before') {
    result.heartbeat = runHeartbeat(paths.workspace, sessionKey, ownership.projectId, undefined, {
      userId: ownership.userId
    });
    result.checkpoint = runCheckpointCreate(paths.workspace, sessionKey, 'compact-before');
    actions.push('heartbeat', 'checkpoint_created');
  } else {
    result.session_experience_sync = runSessionExperienceSync(paths.workspace, sessionKey, {
      projectId: ownership.projectId,
      userId: ownership.userId
    });
    if (
      result.session_experience_sync.created > 0 ||
      result.session_experience_sync.updated > 0 ||
      result.session_experience_sync.archived > 0
    ) {
      actions.push('session_experiences_synced');
    }
    result.skill_draft = runSkillDraftCreate(paths.workspace, sessionKey, {
      note: 'Auto-generated during session compaction'
    });
    if (result.skill_draft.status !== 'skipped') {
      actions.push('skill_draft_refreshed');
    }
    result.compact = runCompactPacketCreate(paths.workspace, sessionKey, {
      reason: 'compact-after',
      projectId: ownership.projectId,
      userId: ownership.userId
    });
    actions.push('compact_packet_created');
  }

  const bootstrap = refreshBootstrapCache(paths.workspace, sessionKey, {
    project_id: ownership.projectId,
    user_id: ownership.userId
  });
  result.bootstrap = bootstrap;
  if (bootstrap.bootstrap_content_written) {
    actions.push('bootstrap_cache_refreshed');
  }

  const persistedState = loadSessionState(paths, sessionKey, ownership.projectId, {
    createIfMissing: false,
    touch: false
  });
  if (persistedState) {
    recordSessionOwnership(paths.openClawHome, paths.workspace, persistedState, {
      status: persistedState.closed_at ? 'closed' : 'active'
    });
  }

  return result;
}

function main() {
  const result = runSessionCompact(process.argv[2], process.argv[3], {
    phase: process.argv[4],
    projectId: process.argv[5],
    userId: process.argv[6]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSessionCompact
};
