#!/usr/bin/env node

const { runLegacyMemorySync } = require('./legacy-memory-sync');
const { command, field, renderCliError, section, status } = require('./lib/terminal-format');

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

function renderMigrateMemoryReport(result) {
  const lines = [];
  const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
  const kind = errorCount > 0 ? 'warning' : 'success';
  lines.push(section('Context-Anchor Memory Migration', { kind }));
  lines.push(field('Status', status(String(result.status || 'migrated').toUpperCase(), kind), { kind }));
  lines.push(field('Experiences synced', Number(result.experiences || 0), { kind: 'success' }));
  lines.push(field('Errors', status(errorCount, errorCount > 0 ? 'warning' : 'success'), { kind: errorCount > 0 ? 'warning' : 'success' }));
  if (result.legacy_memory_sync?.workspace) {
    lines.push(field('Workspace', result.legacy_memory_sync.workspace, { kind: 'muted' }));
  }
  if (result.legacy_memory_sync?.command) {
    lines.push(field('Source action', command(result.legacy_memory_sync.command), { kind: 'command' }));
  }
  return lines.join('\n');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runMigrateMemory(options.workspace, options.projectId);
    if (options.json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderMigrateMemoryReport(result));
    }
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Memory Migration Failed', error.message, {
        nextStep: 'Check the workspace/project arguments, then rerun migrate-memory.'
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
  parseArgs,
  renderMigrateMemoryReport,
  runMigrateMemory
};
