#!/usr/bin/env node

const { createPaths, getRecentSessions } = require('./lib/context-anchor');
const { ensureWorkspaceRegistration, getWorkspaceRegistrationStatus, resolveOwnership } = require('./lib/host-config');
const { runLegacyMemorySync, summarizeExternalMemorySources } = require('./legacy-memory-sync');
const { runSessionMaintenance } = require('./session-maintenance');
const { field, renderCliError, section, status } = require('./lib/terminal-format');

function sortRecentSessions(entries = []) {
  return [...entries].sort((left, right) => {
    return new Date(right.last_active).getTime() - new Date(left.last_active).getTime();
  });
}

function runWorkspaceMonitor(workspaceArg, options = {}) {
  const ownership = resolveOwnership(undefined, {
    workspace: workspaceArg
  });
  const paths = createPaths(ownership.workspace || workspaceArg);
  const ensured = ensureWorkspaceRegistration(paths.openClawHome, paths.workspace, {
    userId: ownership.userId,
    projectId: ownership.projectId,
    reason: 'workspace_monitor'
  });
  const registration = getWorkspaceRegistrationStatus(paths.openClawHome, paths.workspace);

  if (!registration.configured) {
    return {
      status: 'needs_configuration',
      workspace: paths.workspace,
      actions: ['configure_workspace'],
      onboarding: ensured,
      message: `Workspace ${paths.workspace} is not registered yet. Configure it before enabling workspace monitoring.`
    };
  }

  const recentSessions = sortRecentSessions(getRecentSessions(paths, options.windowMs));
  const externalMemorySources = summarizeExternalMemorySources(paths.workspace);

  if (recentSessions.length === 0) {
    const legacyMemorySync =
      externalMemorySources.external_source_count > 0 && externalMemorySources.unsynced_source_count > 0
        ? runLegacyMemorySync(paths.workspace, 'workspace-monitor', {
            projectId: ownership.projectId,
            reason: 'workspace-monitor'
          })
        : {
            status: 'skipped',
            workspace: paths.workspace,
            session_key: 'workspace-monitor',
            project_id: ownership.projectId,
            reason:
              externalMemorySources.external_source_count > 0
                ? 'already_centralized'
                : 'no_external_sources',
            detected_files: externalMemorySources.external_source_count,
            synced_files: 0,
            skipped_files: externalMemorySources.external_source_count,
            synced_entries: 0,
            files: [],
            errors: []
          };

    return {
      status: 'idle',
      workspace: paths.workspace,
      onboarding: ensured,
      recent_sessions: 0,
      handled_sessions: 0,
      results: [],
      memory_sources: {
        external_source_count: externalMemorySources.external_source_count,
        unsynced_source_count: externalMemorySources.unsynced_source_count,
        last_legacy_sync_at: externalMemorySources.last_legacy_sync_at
      },
      legacy_memory_sync: legacyMemorySync
    };
  }

  const results = recentSessions.map((entry) =>
    runSessionMaintenance(paths.workspace, entry.session_key, entry.project_id, options.usagePercent, {
      reason: 'workspace-monitor'
    })
  );

  return {
    status: 'processed',
    workspace: paths.workspace,
    onboarding: ensured,
    recent_sessions: recentSessions.length,
    handled_sessions: results.filter((entry) => entry.status === 'maintenance_ok').length,
    results
  };
}

function main() {
  try {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const filtered = args.filter((arg) => arg !== '--json');
    const result = runWorkspaceMonitor(filtered[0]);
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const kind =
      result.status === 'processed'
        ? 'success'
        : result.status === 'idle'
        ? 'info'
        : 'warning';
    const lines = [];
    lines.push(section('Context-Anchor Workspace Monitor', { kind }));
    lines.push(field('Status', status(String(result.status || 'unknown').replace(/_/g, ' ').toUpperCase(), kind), { kind }));
    lines.push(field('Workspace', result.workspace, { kind: 'muted' }));
    if (result.status === 'needs_configuration') {
      lines.push(field('Action', result.message, { kind: 'warning' }));
    } else {
      lines.push(
        field(
          'Sessions',
          `Recent ${Number(result.recent_sessions || 0)} | Handled ${status(Number(result.handled_sessions || 0), Number(result.handled_sessions || 0) > 0 ? 'success' : 'info')}`,
          { kind: Number(result.handled_sessions || 0) > 0 ? 'success' : 'info' }
        )
      );
      if (result.memory_sources) {
        lines.push(field('Memory sources', `External ${Number(result.memory_sources.external_source_count || 0)} | Unsynced ${Number(result.memory_sources.unsynced_source_count || 0)} | Last sync ${result.memory_sources.last_legacy_sync_at || '-'}`, { kind: 'info' }));
      }
    }
    console.log(lines.join('\n'));
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Workspace Monitor Failed', error.message, {
        nextStep: 'Check the workspace path and rerun workspace-monitor.'
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
  runWorkspaceMonitor
};
