#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  compactPacketFile,
  createPaths,
  getOpenClawHome,
  projectDecisionsArchiveFile,
  projectDecisionsFile,
  projectExperiencesArchiveFile,
  projectExperiencesFile,
  projectFactsArchiveFile,
  projectFactsFile,
  projectHeatIndexFile,
  projectSkillsIndexFile,
  projectStateFile,
  readJson,
  resolveUserId,
  runtimeStateFile,
  sessionExperiencesArchiveFile,
  sessionExperiencesFile,
  sessionMemoryArchiveFile,
  sessionMemoryFile,
  sessionSkillsIndexFile,
  sessionStateFile,
  sessionSummaryFile,
  userDir,
  userExperiencesArchiveFile,
  userExperiencesFile,
  userHeatIndexFile,
  userMemoriesArchiveFile,
  userMemoriesFile,
  userSkillsIndexFile,
  userStateFile
} = require('./lib/context-anchor');
const { syncCollectionMirror, syncDocumentMirror } = require('./lib/context-anchor-db');
const { discoverOpenClawSessions } = require('./lib/openclaw-session-discovery');
const { readHostConfig } = require('./lib/host-config');
const { field, renderCliError, section, status } = require('./lib/terminal-format');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    workspace: null,
    userId: null,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--openclaw-home') {
      options.openclawHome = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      options.workspace = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--user-id') {
      options.userId = argv[index + 1] || null;
      index += 1;
      continue;
    }

    if (arg === '--json') {
      options.json = true;
    }
  }

  return options;
}

function addPath(targets, value) {
  if (!value) {
    return;
  }

  targets.add(path.resolve(value));
}

function collectWorkspaceTargets(openClawHome, explicitWorkspace) {
  const targets = new Set();

  if (explicitWorkspace) {
    addPath(targets, explicitWorkspace);
    return [...targets];
  }

  const hostConfig = readHostConfig(openClawHome);
  addPath(targets, hostConfig.defaults?.workspace || null);
  (hostConfig.workspaces || []).forEach((entry) => addPath(targets, entry.workspace));
  (hostConfig.sessions || []).forEach((entry) => addPath(targets, entry.workspace));
  discoverOpenClawSessions(openClawHome).forEach((entry) => addPath(targets, entry.workspace));

  return [...targets];
}

function collectUserTargets(openClawHome, explicitUserId) {
  if (explicitUserId) {
    return [resolveUserId(explicitUserId)];
  }

  const targets = new Set();
  const hostConfig = readHostConfig(openClawHome);
  if (hostConfig.defaults?.user_id) {
    targets.add(resolveUserId(hostConfig.defaults.user_id));
  }
  (hostConfig.users || []).forEach((entry) => targets.add(resolveUserId(entry.user_id)));
  const usersRoot = path.join(openClawHome, 'context-anchor', 'users');
  if (fs.existsSync(usersRoot)) {
    fs.readdirSync(usersRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => targets.add(resolveUserId(entry.name)));
  }

  return [...targets];
}

function syncDocument(file, result, label) {
  if (!fs.existsSync(file)) {
    result.skipped += 1;
    return;
  }

  const data = readJson(file, null);
  if (!data || typeof data !== 'object') {
    result.invalid.push({
      type: label,
      file
    });
    return;
  }

  if (syncDocumentMirror(file, data)) {
    result.documents_synced += 1;
  }
}

function syncCollection(file, key, result, label) {
  if (!fs.existsSync(file)) {
    result.skipped += 1;
    return;
  }

  const content = readJson(file, null);
  if (!content || typeof content !== 'object') {
    result.invalid.push({
      type: label,
      file
    });
    return;
  }

  const items = Array.isArray(content[key]) ? content[key] : [];
  if (syncCollectionMirror(file, key, items)) {
    result.collections_synced += 1;
    result.indexed_items += items.length;
  }
}

function rebuildWorkspaceMirror(workspace, result) {
  const paths = createPaths(workspace);
  if (!fs.existsSync(paths.anchorDir)) {
    result.skipped_workspaces.push(path.resolve(workspace));
    return;
  }

  result.workspaces_processed.push(paths.workspace);
  syncDocument(paths.indexFile, result, 'workspace_index');
  syncDocument(paths.globalStateFile, result, 'global_state');
  syncCollection(paths.sessionIndexFile, 'sessions', result, 'session_index');

  if (fs.existsSync(paths.projectsDir)) {
    fs.readdirSync(paths.projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => {
        const projectId = entry.name;
        if (projectId !== '_global') {
          syncDocument(projectStateFile(paths, projectId), result, 'project_state');
          syncCollection(projectDecisionsFile(paths, projectId), 'decisions', result, 'project_decisions');
          syncCollection(projectDecisionsArchiveFile(paths, projectId), 'decisions', result, 'project_decisions_archive');
          syncCollection(projectExperiencesFile(paths, projectId), 'experiences', result, 'project_experiences');
          syncCollection(projectExperiencesArchiveFile(paths, projectId), 'experiences', result, 'project_experiences_archive');
          syncCollection(projectFactsFile(paths, projectId), 'facts', result, 'project_facts');
          syncCollection(projectFactsArchiveFile(paths, projectId), 'facts', result, 'project_facts_archive');
          syncDocument(projectHeatIndexFile(paths, projectId), result, 'project_heat_index');
          syncCollection(projectSkillsIndexFile(paths, projectId), 'skills', result, 'project_skills');
        }
      });
  }

  if (fs.existsSync(paths.sessionsDir)) {
    fs.readdirSync(paths.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => {
        const sessionKey = entry.name;
        syncDocument(sessionStateFile(paths, sessionKey), result, 'session_state');
        syncDocument(runtimeStateFile(paths, sessionKey), result, 'session_runtime_state');
        syncCollection(sessionMemoryFile(paths, sessionKey), 'entries', result, 'session_memory');
        syncCollection(sessionMemoryArchiveFile(paths, sessionKey), 'entries', result, 'session_memory_archive');
        syncCollection(sessionExperiencesFile(paths, sessionKey), 'experiences', result, 'session_experiences');
        syncCollection(sessionExperiencesArchiveFile(paths, sessionKey), 'experiences', result, 'session_experiences_archive');
        syncCollection(sessionSkillsIndexFile(paths, sessionKey), 'skills', result, 'session_skills');
        syncDocument(compactPacketFile(paths, sessionKey), result, 'session_compact_packet');
        syncDocument(sessionSummaryFile(paths, sessionKey), result, 'session_summary');
      });
  }
}

function rebuildUserMirror(userId, result) {
    const paths = createPaths(process.cwd());
  const normalizedUserId = resolveUserId(userId);
  const targetDir = userDir(paths, normalizedUserId);
  if (!fs.existsSync(targetDir)) {
    result.skipped_users.push(normalizedUserId);
    return;
  }

  result.users_processed.push(normalizedUserId);
  syncDocument(userStateFile(paths, normalizedUserId), result, 'user_state');
  syncCollection(userMemoriesFile(paths, normalizedUserId), 'memories', result, 'user_memories');
  syncCollection(userMemoriesArchiveFile(paths, normalizedUserId), 'memories', result, 'user_memories_archive');
  syncCollection(userExperiencesFile(paths, normalizedUserId), 'experiences', result, 'user_experiences');
  syncCollection(userExperiencesArchiveFile(paths, normalizedUserId), 'experiences', result, 'user_experiences_archive');
  syncDocument(userHeatIndexFile(paths, normalizedUserId), result, 'user_heat_index');
  syncCollection(userSkillsIndexFile(paths, normalizedUserId), 'skills', result, 'user_skills');
}

function runMirrorRebuild(workspaceArg, openClawHomeArg, options = {}) {
  const openClawHome = getOpenClawHome(openClawHomeArg || options.openclawHome || null);
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = openClawHome;

  try {
    const result = {
      status: 'ok',
      openclaw_home: openClawHome,
      workspaces_processed: [],
      skipped_workspaces: [],
      users_processed: [],
      skipped_users: [],
      collections_synced: 0,
      documents_synced: 0,
      indexed_items: 0,
      skipped: 0,
      invalid: []
    };

    const workspaces = collectWorkspaceTargets(openClawHome, workspaceArg || options.workspace);
    const users = collectUserTargets(openClawHome, options.userId);

    workspaces.forEach((workspace) => rebuildWorkspaceMirror(workspace, result));
    users.forEach((userId) => rebuildUserMirror(userId, result));

    return result;
  } finally {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
  }
}

function renderMirrorRebuildReport(result) {
  const lines = [];
  const hasInvalid = Array.isArray(result.invalid) && result.invalid.length > 0;
  const kind = hasInvalid ? 'warning' : 'success';
  lines.push(section('Context-Anchor Mirror Rebuild', { kind }));
  lines.push(field('Status', status(String(result.status || 'ok').toUpperCase(), kind), { kind }));
  lines.push(field('OpenClaw home', result.openclaw_home, { kind: 'muted' }));
  lines.push(
    field(
      'Processed',
      `Workspaces ${Number(result.workspaces_processed?.length || 0)} | Users ${Number(result.users_processed?.length || 0)} | Collections ${Number(result.collections_synced || 0)} | Documents ${Number(result.documents_synced || 0)} | Indexed items ${Number(result.indexed_items || 0)}`,
      { kind: 'info' }
    )
  );
  lines.push(
    field(
      'Skipped',
      `Workspaces ${Number(result.skipped_workspaces?.length || 0)} | Users ${Number(result.skipped_users?.length || 0)} | Files ${Number(result.skipped || 0)}`,
      { kind: 'muted' }
    )
  );
  if (hasInvalid) {
    lines.push(field('Invalid', `${result.invalid.length} file(s) could not be mirrored`, { kind: 'warning' }));
  }
  return lines.join('\n');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = runMirrorRebuild(options.workspace, options.openclawHome, options);
    if (options.json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(renderMirrorRebuildReport(result));
    }
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Mirror Rebuild Failed', error.message, {
        nextStep: 'Check the workspace/OpenClaw paths, then rerun mirror-rebuild.'
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
  renderMirrorRebuildReport,
  runMirrorRebuild
};
