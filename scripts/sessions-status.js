#!/usr/bin/env node

const { buildOpenClawSessionStatusReport, renderOpenClawSessionStatusReport } = require('./lib/openclaw-session-status');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    skillsRoot: null,
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
  main,
  parseArgs,
  runSessionsStatus
};
