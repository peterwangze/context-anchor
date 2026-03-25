#!/usr/bin/env node

const { createPaths, getRecentSessions } = require('./lib/context-anchor');
const { getWorkspaceRegistrationStatus, resolveOwnership } = require('./lib/host-config');
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
  const registration = getWorkspaceRegistrationStatus(paths.openClawHome, paths.workspace);

  if (!registration.configured) {
    return {
      status: 'needs_configuration',
      workspace: paths.workspace,
      actions: ['configure_workspace'],
      message: `Workspace ${paths.workspace} is not registered yet. Configure it before enabling workspace monitoring.`
    };
  }

  const recentSessions = sortRecentSessions(getRecentSessions(paths, options.windowMs));

  if (recentSessions.length === 0) {
    return {
      status: 'idle',
      workspace: paths.workspace,
      recent_sessions: 0,
      handled_sessions: 0,
      results: []
    };
  }

  const results = recentSessions.map((entry) =>
    runSessionMaintenance(paths.workspace, entry.session_key, entry.project_id, options.usagePercent)
  );

  return {
    status: 'processed',
    workspace: paths.workspace,
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
