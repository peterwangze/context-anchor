#!/usr/bin/env node

const { runLegacyMemorySync } = require('./legacy-memory-sync');

function parseArgs(argv) {
  const options = {
    workspace: null,
    projectId: null,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--project-id') {
      options.projectId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
    }
  }

  if (!options.workspace && argv[0] && !String(argv[0]).startsWith('--')) {
    options.workspace = argv[0];
  }
  if (!options.projectId && argv[1] && !String(argv[1]).startsWith('--')) {
    options.projectId = argv[1];
  }

  return options;
}

function runMigrateMemory(workspaceArg, projectIdArg) {
  const result = runLegacyMemorySync(workspaceArg, 'migration', {
    projectId: projectIdArg,
    reason: 'migrate-memory',
    force: true
  });

  return {
    status: 'migrated',
    decisions: 0,
    experiences: result.synced_entries,
    facts: 0,
    errors: result.errors,
    legacy_memory_sync: result
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runMigrateMemory(options.workspace, options.projectId);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  runMigrateMemory
};
