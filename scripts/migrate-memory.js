#!/usr/bin/env node

const { runLegacyMemorySync } = require('./legacy-memory-sync');

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
  const result = runMigrateMemory(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runMigrateMemory
};
