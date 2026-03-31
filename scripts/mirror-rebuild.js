#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  compactPacketFile,
  createPaths,
  getOpenClawHome,
  projectDecisionsFile,
  projectExperiencesFile,
  projectFactsFile,
  projectHeatIndexFile,
  projectSkillsIndexFile,
  projectStateFile,
  readJson,
  resolveUserId,
  sessionExperiencesFile,
  sessionMemoryFile,
  sessionSkillsIndexFile,
  sessionStateFile,
  sessionSummaryFile,
  userDir,
  userExperiencesFile,
  userHeatIndexFile,
  userMemoriesFile,
  userSkillsIndexFile,
  userStateFile
} = require('./lib/context-anchor');
const { syncCollectionMirror, syncDocumentMirror } = require('./lib/context-anchor-db');
const { discoverOpenClawSessions } = require('./lib/openclaw-session-discovery');
const { readHostConfig } = require('./lib/host-config');

function parseArgs(argv) {
  const options = {
    openclawHome: null,
    workspace: null,
    userId: null
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
          syncCollection(projectExperiencesFile(paths, projectId), 'experiences', result, 'project_experiences');
          syncCollection(projectFactsFile(paths, projectId), 'facts', result, 'project_facts');
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
        syncCollection(sessionMemoryFile(paths, sessionKey), 'entries', result, 'session_memory');
        syncCollection(sessionExperiencesFile(paths, sessionKey), 'experiences', result, 'session_experiences');
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
  syncCollection(userExperiencesFile(paths, normalizedUserId), 'experiences', result, 'user_experiences');
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runMirrorRebuild(options.workspace, options.openclawHome, options);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  parseArgs,
  runMirrorRebuild
};
