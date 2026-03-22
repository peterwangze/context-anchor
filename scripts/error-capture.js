#!/usr/bin/env node

const { createPaths, loadSessionState, sanitizeKey, writeSessionState } = require('./lib/context-anchor');
const { runMemorySave } = require('./memory-save');

function runErrorCapture(workspaceArg, sessionKeyArg, errorTypeArg, summaryArg, detailsArg, solutionArg) {
  const summary = summaryArg || '';
  if (!summary) {
    throw new Error(
      'Usage: node error-capture.js <workspace> <session-key> <error-type> <summary> [details] [solution]'
    );
  }

  const sessionKey = sanitizeKey(sessionKeyArg);
  const paths = createPaths(workspaceArg);
  const sessionState = loadSessionState(paths, sessionKey, undefined, {
    createIfMissing: true,
    touch: true
  });
  const errorType = errorTypeArg || 'general';
  const heatMap = {
    user_correction: 70,
    command_failed: 60,
    api_failed: 60,
    general: 50
  };

  const saved = runMemorySave(
    paths.workspace,
    sessionState.session_key,
    'project',
    'lesson',
    summary,
    JSON.stringify({
      details: detailsArg || '',
      solution: solutionArg || '',
      summary,
      heat: heatMap[errorType] || 50,
      tags: ['error', errorType],
      validation_status: 'pending',
      source: 'error-capture'
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
  runErrorCapture
};
