#!/usr/bin/env node

const crypto = require('crypto');
const { createPaths, loadSessionState, sanitizeKey, writeSessionState } = require('./lib/context-anchor');
const { resolveOwnership } = require('./lib/host-config');
const { runMemorySave } = require('./memory-save');

function buildStableErrorEntryId(sessionKey, errorType, summary, dedupeKey) {
  const fingerprint = `${dedupeKey || ''}|${sessionKey}|${errorType}|${summary}`.toLowerCase();
  const digest = crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 16);
  return `err-${digest}`;
}

function runErrorCapture(workspaceArg, sessionKeyArg, errorTypeArg, summaryArg, detailsArg, solutionArg, options = {}) {
  const summary = summaryArg || '';
  if (!summary) {
    throw new Error(
      'Usage: node error-capture.js <workspace> <session-key> <error-type> <summary> [details] [solution]'
    );
  }

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
  const errorType = errorTypeArg || 'general';
  sessionState.user_id = ownership.userId;
  sessionState.project_id = ownership.projectId;
  const heatMap = {
    user_correction: 70,
    command_failed: 60,
    api_failed: 60,
    general: 50
  };
  const tags = ['error', errorType, ...(Array.isArray(options.tags) ? options.tags : [])]
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .filter((entry, index, values) => values.indexOf(entry) === index);
  const entryId = buildStableErrorEntryId(
    sessionState.session_key,
    errorType,
    summary,
    options.dedupeKey || options.entryId
  );

  const saved = runMemorySave(
    paths.workspace,
    sessionState.session_key,
    'project',
    'lesson',
    summary,
    JSON.stringify({
      entry_id: options.entryId || entryId,
      details: detailsArg || '',
      solution: solutionArg || '',
      summary,
      heat: options.heat ?? (heatMap[errorType] || 50),
      tags,
      validation_status: 'pending',
      source: options.source || 'error-capture',
      user_id: sessionState.user_id,
      project_id: sessionState.project_id,
      access_count: Number(options.accessCount || 1),
      access_sessions: Array.isArray(options.accessSessions) ? options.accessSessions : [sessionState.session_key]
    })
  );

  sessionState.errors_count = Number(sessionState.errors_count || 0) + 1;
  sessionState.last_error = new Date().toISOString();
  writeSessionState(paths, sessionKey, sessionState);

  return {
    status: 'captured',
    id: saved.id,
    type: 'lesson',
    error_type: errorType,
    project_id: sessionState.project_id,
    user_id: sessionState.user_id,
    heat: saved.heat,
    message: `Error captured: ${summary}`
  };
}

function main() {
  try {
    const result = runErrorCapture(
      process.argv[2],
      process.argv[3],
      process.argv[4],
      process.argv[5],
      process.argv[6],
      process.argv[7]
    );
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
  buildStableErrorEntryId,
  runErrorCapture
};
