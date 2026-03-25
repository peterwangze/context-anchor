#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_USER_ID = 'default-user';
const DEFAULT_PROJECT_ID = 'default';
const HOST_CONFIG_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeKey(value, fallback = DEFAULT_PROJECT_ID) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[:/\\]/g, '-');
  return cleaned || fallback;
}

function normalizeUserId(value) {
  return sanitizeKey(value, DEFAULT_USER_ID);
}

function normalizeProjectId(value, workspace) {
  if (value) {
    return sanitizeKey(value, DEFAULT_PROJECT_ID);
  }

  if (!workspace) {
    return DEFAULT_PROJECT_ID;
  }

  return sanitizeKey(path.basename(path.resolve(workspace)), DEFAULT_PROJECT_ID);
}

function getOpenClawHome(explicitRoot) {
  return path.resolve(
    explicitRoot ||
      process.env.OPENCLAW_HOME ||
      path.join(os.homedir(), '.openclaw')
  );
}

function getHostConfigFile(openClawHomeArg) {
  return path.join(getOpenClawHome(openClawHomeArg), 'context-anchor-host-config.json');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function defaultHostConfig() {
  return {
    version: HOST_CONFIG_VERSION,
    defaults: {
      user_id: DEFAULT_USER_ID,
      workspace: null
    },
    users: [],
    workspaces: [],
    sessions: []
  };
}

function normalizeUsers(users = []) {
  const seen = new Map();
  for (const entry of Array.isArray(users) ? users : []) {
    const userId = normalizeUserId(entry?.user_id);
    const previous = seen.get(userId);
    seen.set(userId, {
      user_id: userId,
      created_at: previous?.created_at || entry?.created_at || nowIso(),
      updated_at: entry?.updated_at || nowIso()
    });
  }

  return [...seen.values()].sort((left, right) => left.user_id.localeCompare(right.user_id));
}

function normalizeWorkspaces(workspaces = []) {
  const seen = new Map();
  for (const entry of Array.isArray(workspaces) ? workspaces : []) {
    if (!entry?.workspace) {
      continue;
    }

    const workspace = path.resolve(entry.workspace);
    const previous = seen.get(workspace);
    seen.set(workspace, {
      workspace,
      user_id: normalizeUserId(entry.user_id || previous?.user_id || DEFAULT_USER_ID),
      project_id: normalizeProjectId(entry.project_id || previous?.project_id, workspace),
      created_at: previous?.created_at || entry.created_at || nowIso(),
      updated_at: entry.updated_at || nowIso()
    });
  }

  return [...seen.values()].sort((left, right) => left.workspace.localeCompare(right.workspace));
}

function normalizeSessions(sessions = []) {
  const seen = new Map();
  for (const entry of Array.isArray(sessions) ? sessions : []) {
    if (!entry?.workspace || !entry?.session_key) {
      continue;
    }

    const workspace = path.resolve(entry.workspace);
    const sessionKey = sanitizeKey(entry.session_key, 'default');
    const identity = `${workspace}::${sessionKey}`;
    const previous = seen.get(identity);
    seen.set(identity, {
      workspace,
      session_key: sessionKey,
      user_id: normalizeUserId(entry.user_id || previous?.user_id || DEFAULT_USER_ID),
      project_id: normalizeProjectId(entry.project_id || previous?.project_id, workspace),
      status: entry.status || previous?.status || 'active',
      started_at: previous?.started_at || entry.started_at || nowIso(),
      last_active: entry.last_active || previous?.last_active || nowIso(),
      closed_at: entry.closed_at || previous?.closed_at || null,
      updated_at: entry.updated_at || nowIso()
    });
  }

  return [...seen.values()].sort((left, right) => {
    return `${left.workspace}::${left.session_key}`.localeCompare(`${right.workspace}::${right.session_key}`);
  });
}

function normalizeHostConfig(raw = {}) {
  const defaults = raw.defaults || {};
  const config = defaultHostConfig();
  config.version = HOST_CONFIG_VERSION;
  config.defaults.user_id = normalizeUserId(defaults.user_id || DEFAULT_USER_ID);
  config.defaults.workspace = defaults.workspace ? path.resolve(defaults.workspace) : null;
  config.users = normalizeUsers(raw.users);
  config.workspaces = normalizeWorkspaces(raw.workspaces);
  config.sessions = normalizeSessions(raw.sessions);
  return config;
}

function readHostConfig(openClawHomeArg) {
  const file = getHostConfigFile(openClawHomeArg);
  if (!fs.existsSync(file)) {
    return normalizeHostConfig();
  }

  try {
    return normalizeHostConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return normalizeHostConfig();
  }
}

function writeHostConfig(openClawHomeArg, config) {
  const file = getHostConfigFile(openClawHomeArg);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(normalizeHostConfig(config), null, 2)}\n`, 'utf8');
  return file;
}

function findUser(config, userId) {
  const normalizedUserId = normalizeUserId(userId);
  return config.users.find((entry) => entry.user_id === normalizedUserId) || null;
}

function findWorkspace(config, workspaceArg) {
  if (!workspaceArg) {
    return null;
  }

  const workspace = path.resolve(workspaceArg);
  return config.workspaces.find((entry) => entry.workspace === workspace) || null;
}

function findSession(config, workspaceArg, sessionKeyArg) {
  if (!workspaceArg || !sessionKeyArg) {
    return null;
  }

  const workspace = path.resolve(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg, 'default');
  return (
    config.sessions.find((entry) => entry.workspace === workspace && entry.session_key === sessionKey) ||
    null
  );
}

function upsertUser(config, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const existing = findUser(config, normalizedUserId);
  const next = {
    user_id: normalizedUserId,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso()
  };

  if (existing) {
    config.users = config.users.map((entry) => (entry.user_id === normalizedUserId ? next : entry));
  } else {
    config.users = [...config.users, next];
  }

  return next;
}

function upsertWorkspace(config, workspaceArg, options = {}) {
  const workspace = path.resolve(workspaceArg);
  const existing = findWorkspace(config, workspace);
  const userId =
    options.preserveExisting && existing
      ? existing.user_id
      : normalizeUserId(options.userId || existing?.user_id || config.defaults.user_id || DEFAULT_USER_ID);
  const projectId =
    options.preserveExisting && existing
      ? existing.project_id
      : normalizeProjectId(options.projectId || existing?.project_id, workspace);
  upsertUser(config, userId);
  const next = {
    workspace,
    user_id: userId,
    project_id: projectId,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso()
  };

  if (existing) {
    config.workspaces = config.workspaces.map((entry) => (entry.workspace === workspace ? next : entry));
  } else {
    config.workspaces = [...config.workspaces, next];
  }

  return next;
}

function setHostDefaults(config, options = {}) {
  const next = normalizeHostConfig(config);
  const userId = normalizeUserId(options.userId || next.defaults.user_id || DEFAULT_USER_ID);
  next.defaults.user_id = userId;
  upsertUser(next, userId);

  if (options.workspace) {
    const workspace = upsertWorkspace(next, options.workspace, {
      userId,
      projectId: options.projectId
    });
    next.defaults.workspace = workspace.workspace;
  } else if (Object.prototype.hasOwnProperty.call(options, 'workspace') && !options.workspace) {
    next.defaults.workspace = null;
  }

  return next;
}

function resolveOwnership(openClawHomeArg, options = {}) {
  const config = readHostConfig(openClawHomeArg);
  const workspace =
    options.workspace !== undefined && options.workspace !== null && options.workspace !== ''
      ? path.resolve(options.workspace)
      : config.defaults.workspace
        ? path.resolve(config.defaults.workspace)
        : null;
  const session = workspace && options.sessionKey ? findSession(config, workspace, options.sessionKey) : null;
  const workspaceEntry = workspace ? findWorkspace(config, workspace) : null;
  const userId = normalizeUserId(
    options.userId ||
      session?.user_id ||
      workspaceEntry?.user_id ||
      config.defaults.user_id ||
      DEFAULT_USER_ID
  );
  const projectId = normalizeProjectId(
    options.projectId ||
      session?.project_id ||
      workspaceEntry?.project_id,
    workspace || process.cwd()
  );

  return {
    config,
    workspace,
    userId,
    projectId,
    workspaceEntry,
    sessionEntry: session
  };
}

function recordSessionOwnership(openClawHomeArg, workspaceArg, sessionState, options = {}) {
  const config = readHostConfig(openClawHomeArg);
  upsertUser(config, sessionState.user_id);
  const workspaceEntry = upsertWorkspace(config, workspaceArg, {
    userId: sessionState.user_id,
    projectId: sessionState.project_id,
    preserveExisting: true
  });
  const sessionKey = sanitizeKey(sessionState.session_key, 'default');
  const existing = findSession(config, workspaceEntry.workspace, sessionKey);
  const status = options.status || existing?.status || 'active';
  const closedAt =
    status === 'closed'
      ? options.closedAt || sessionState.closed_at || nowIso()
      : existing?.closed_at || null;
  const next = {
    workspace: workspaceEntry.workspace,
    session_key: sessionKey,
    user_id: normalizeUserId(sessionState.user_id),
    project_id: normalizeProjectId(sessionState.project_id, workspaceEntry.workspace),
    status,
    started_at: existing?.started_at || sessionState.started_at || nowIso(),
    last_active: sessionState.last_active || existing?.last_active || nowIso(),
    closed_at: closedAt,
    updated_at: nowIso()
  };

  if (existing) {
    config.sessions = config.sessions.map((entry) =>
      entry.workspace === workspaceEntry.workspace && entry.session_key === sessionKey ? next : entry
    );
  } else {
    config.sessions = [...config.sessions, next];
  }

  const file = writeHostConfig(openClawHomeArg, config);
  return {
    file,
    session: next,
    workspace: workspaceEntry
  };
}

function summarizeHostConfig(config) {
  const normalized = normalizeHostConfig(config);
  return {
    defaults: normalized.defaults,
    users: normalized.users.length,
    workspaces: normalized.workspaces.length,
    sessions: normalized.sessions.length,
    active_sessions: normalized.sessions.filter((entry) => entry.status !== 'closed').length
  };
}

module.exports = {
  DEFAULT_USER_ID,
  DEFAULT_PROJECT_ID,
  HOST_CONFIG_VERSION,
  findSession,
  findUser,
  findWorkspace,
  getHostConfigFile,
  getOpenClawHome,
  normalizeProjectId,
  normalizeUserId,
  readHostConfig,
  recordSessionOwnership,
  resolveOwnership,
  setHostDefaults,
  summarizeHostConfig,
  upsertUser,
  upsertWorkspace,
  writeHostConfig
};
