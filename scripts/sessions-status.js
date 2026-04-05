#!/usr/bin/env node

const { buildOpenClawSessionStatusReport, renderOpenClawSessionStatusReport } = require('./lib/openclaw-session-status');
const { renderCliError } = require('./lib/terminal-format');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
    workspace: null,
    sessionKey: null,
    includeSubagents: false,
    includeHiddenSessions: false,
    json: false
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

    if (arg === '--include-subagents') {
      options.includeSubagents = true;
      continue;
    }

    if (arg === '--include-hidden-sessions') {
      options.includeHiddenSessions = true;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

function runSessionsStatus(openclawHomeArg, skillsRootArg, options = {}) {
  return buildOpenClawSessionStatusReport(openclawHomeArg, skillsRootArg, options);
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runSessionsStatus(options.openclawHome, options.skillsRoot, options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderOpenClawSessionStatusReport(report));
    }
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Session Overview Failed', error.message, {
        nextStep: 'Check the workspace/openclaw path arguments, then rerun status:sessions.'
      }));
    } else {
      console.log(JSON.stringify({ status: 'error', message: error.message }, null, 2));
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs,
  runSessionsStatus
};
