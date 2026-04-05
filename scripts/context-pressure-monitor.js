#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createPaths, readJson } = require('./lib/context-anchor');
const { runContextPressureHandle } = require('./context-pressure-handle');
const { runRuntimeErrorSync } = require('./runtime-error-sync');
const { field, renderCliError, section, status } = require('./lib/terminal-format');

function loadSnapshot(snapshotArg, usageArg) {
  if (!snapshotArg) {
    return { sessions: [] };
  }

  const maybeFile = path.resolve(snapshotArg);
  if (fs.existsSync(maybeFile)) {
    return readJson(maybeFile, { sessions: [] });
  }

  if (usageArg !== undefined) {
    return {
      sessions: [
        {
          session_key: snapshotArg,
          usage_percent: Number(usageArg)
        }
      ]
    };
  }

  return { sessions: [] };
}

function runContextPressureMonitor(workspaceArg, snapshotArg, usageArg) {
  const paths = createPaths(workspaceArg);
  const snapshot = loadSnapshot(snapshotArg, usageArg);
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];

  return {
    status: 'processed',
    workspace: paths.workspace,
    handled_sessions: sessions.length,
    results: sessions.map((entry) => {
      const pressure = runContextPressureHandle(paths.workspace, entry.session_key, entry.usage_percent);
      const errors = runRuntimeErrorSync(paths.workspace, entry.session_key, entry.errors, {
        projectId: entry.project_id,
        userId: entry.user_id,
        source: 'context-pressure-monitor'
      });

      return {
        ...pressure,
        error_captures: errors.captured,
        ignored_errors: errors.ignored_errors,
        ignored_error_details: errors.ignored
      };
    })
  };
}

function main() {
  try {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const filtered = args.filter((arg) => arg !== '--json');
    const result = runContextPressureMonitor(filtered[0], filtered[1], filtered[2]);
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const lines = [];
    lines.push(section('Context-Anchor Pressure Monitor', { kind: 'info' }));
    lines.push(field('Status', status(String(result.status || 'processed').toUpperCase(), 'info'), { kind: 'info' }));
    lines.push(field('Workspace', result.workspace, { kind: 'muted' }));
    lines.push(
      field(
        'Handled',
        `Sessions ${status(Number(result.handled_sessions || 0), Number(result.handled_sessions || 0) > 0 ? 'success' : 'info')} | Results ${Number((result.results || []).length)}`,
        { kind: Number(result.handled_sessions || 0) > 0 ? 'success' : 'info' }
      )
    );
    const captured = (result.results || []).reduce((sum, entry) => sum + Number(entry.error_captures || 0), 0);
    const ignored = (result.results || []).reduce((sum, entry) => sum + Number(entry.ignored_errors || 0), 0);
    lines.push(field('Errors', `Captured ${captured} | Ignored ${ignored}`, { kind: captured > 0 ? 'warning' : 'muted' }));
    console.log(lines.join('\n'));
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Pressure Monitor Failed', error.message, {
        nextStep: 'Check the workspace and snapshot arguments, then rerun context-pressure-monitor.'
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
  runContextPressureMonitor
};
