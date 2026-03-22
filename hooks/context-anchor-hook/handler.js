#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  DEFAULTS,
  createPaths,
  getRecentSessions,
  loadSessionState,
  readText,
  sessionCheckpointFile
} = require('../../scripts/lib/context-anchor');
const { runCheckpointCreate } = require('../../scripts/checkpoint-create');
const { runHeartbeat } = require('../../scripts/heartbeat');
const { runHeatEvaluation } = require('../../scripts/heat-eval');
const { runMemoryFlow } = require('../../scripts/memory-flow');
const { runSkillificationScore } = require('../../scripts/skillification-score');

function parsePayload(rawArg) {
  if (!rawArg) {
    return {};
  }

  const maybeFile = path.resolve(rawArg);
  if (fs.existsSync(maybeFile)) {
    return JSON.parse(fs.readFileSync(maybeFile, 'utf8'));
  }

  try {
    return JSON.parse(rawArg);
  } catch {
    return {};
  }
}

function handleStartup(payload) {
  const paths = createPaths(payload.workspace);
  const recentSessions = getRecentSessions(paths);

  if (recentSessions.length === 0) {
    return {
      status: 'idle',
      event: 'gateway:startup',
      actions: [],
      message: 'No recent session to restore.'
    };
  }

  const latest = recentSessions[0];
  const sessionState = loadSessionState(paths, latest.session_key, latest.project_id, {
    createIfMissing: false,
    touch: false
  });
  const checkpoint = readText(sessionCheckpointFile(paths, latest.session_key), '');
  const pendingCommitments = (sessionState?.commitments || []).filter(
    (entry) => entry.status === 'pending'
  );
  const resumeMessage = [
    '我回来了。',
    `上次会话: ${latest.session_key}`,
    sessionState?.active_task ? `当前任务: ${sessionState.active_task}` : null,
    pendingCommitments.length > 0
      ? `待处理承诺: ${pendingCommitments.map((entry) => entry.what).join('；')}`
      : null,
    checkpoint ? `检查点: ${checkpoint.split('\n').slice(0, 6).join(' / ')}` : null
  ]
    .filter(Boolean)
    .join('\n');

  return {
    status: 'resume_available',
    event: 'gateway:startup',
    actions: ['resume_session'],
    session_key: latest.session_key,
    project_id: latest.project_id,
    resume_message: resumeMessage
  };
}

function handleStop(payload) {
  const workspace = payload.workspace;
  const sessionKey = payload.session_key || DEFAULTS.sessionKey;
  const checkpoint = runCheckpointCreate(workspace, sessionKey, 'command-stop');
  const flow = runMemoryFlow(workspace, sessionKey, { minimumHeat: 60 });

  return {
    status: 'handled',
    event: 'command:stop',
    actions: ['checkpoint_created', 'memory_synced'],
    checkpoint,
    flow
  };
}

function handleSessionEnd(payload) {
  const workspace = payload.workspace;
  const sessionKey = payload.session_key || DEFAULTS.sessionKey;
  const paths = createPaths(workspace);
  const sessionState = loadSessionState(paths, sessionKey, payload.project_id, {
    createIfMissing: true,
    touch: true
  });
  const checkpoint = runCheckpointCreate(workspace, sessionKey, 'session-end');
  const flow = runMemoryFlow(workspace, sessionKey, { minimumHeat: 50 });
  const heat = runHeatEvaluation(workspace, sessionState.project_id);
  const skillification = runSkillificationScore(workspace, sessionState.project_id);

  return {
    status: 'handled',
    event: 'session:end',
    actions: ['checkpoint_created', 'memory_synced', 'heat_evaluated', 'skillification_checked'],
    checkpoint,
    flow,
    heat,
    skillification
  };
}

function handleHeartbeat(payload) {
  return {
    status: 'handled',
    event: 'heartbeat',
    actions: ['heartbeat'],
    result: runHeartbeat(payload.workspace, payload.session_key, payload.project_id, payload.usage_percent)
  };
}

function handleHookEvent(eventName, payload = {}) {
  switch (eventName) {
    case 'gateway:startup':
      return handleStartup(payload);
    case 'command:stop':
      return handleStop(payload);
    case 'session:end':
      return handleSessionEnd(payload);
    case 'heartbeat':
    case 'on_heartbeat':
      return handleHeartbeat(payload);
    default:
      return {
        status: 'ignored',
        event: eventName,
        actions: [],
        message: `Unsupported event: ${eventName}`
      };
  }
}

function main() {
  const result = handleHookEvent(process.argv[2], parsePayload(process.argv[3]));
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  handleHookEvent
};
