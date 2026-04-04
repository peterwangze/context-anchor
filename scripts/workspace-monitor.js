#!/usr/bin/env node

const { createPaths, getRecentSessions } = require('./lib/context-anchor');
const { ensureWorkspaceRegistration, getWorkspaceRegistrationStatus, resolveOwnership } = require('./lib/host-config');
const { runLegacyMemorySync, summarizeExternalMemorySources } = require('./legacy-memory-sync');
const { runSessionMaintenance } = require('./session-maintenance');

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
  const result = runWorkspaceMonitor(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runWorkspaceMonitor
};
