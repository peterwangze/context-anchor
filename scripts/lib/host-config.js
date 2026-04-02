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

function normalizePathForComparison(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function isPathWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (!relative) {
    return true;
  }

  return !relative.startsWith('..') && !path.isAbsolute(relative);
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
    onboarding: {
      auto_register_workspaces: true,
      memory_takeover_mode: 'best_effort'
    },
    users: [],
    workspaces: [],
    sessions: []
  };
}

function normalizeOnboarding(onboarding = {}) {
  const rawMode = String(onboarding?.memory_takeover_mode || 'best_effort').trim().toLowerCase();
  const memoryTakeoverMode = rawMode === 'enforced' ? 'enforced' : 'best_effort';
  return {
    auto_register_workspaces: onboarding?.auto_register_workspaces !== false,
    memory_takeover_mode: memoryTakeoverMode
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
      owner_workspace: entry.owner_workspace
        ? path.resolve(entry.owner_workspace)
        : previous?.owner_workspace || null,
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
  config.onboarding = normalizeOnboarding(raw.onboarding);
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
  return findWorkspaceEntry(config, workspaceArg);
}

function findWorkspaceExact(config, workspaceArg) {
  if (!workspaceArg) {
    return null;
  }

  const workspace = path.resolve(workspaceArg);
  return config.workspaces.find((entry) => samePath(entry.workspace, workspace)) || null;
}

function findWorkspaceEntry(config, workspaceArg, options = {}) {
  if (!workspaceArg) {
    return null;
  }

  const workspace = path.resolve(workspaceArg);
  const exactMatch = findWorkspaceExact(config, workspace);
  if (exactMatch || options.match === 'exact') {
    return exactMatch;
  }

  const matches = config.workspaces
    .filter((entry) => isPathWithin(entry.workspace, workspace))
    .sort((left, right) => right.workspace.length - left.workspace.length);

  return matches[0] || null;
}

function getWorkspaceRegistrationStatus(openClawHomeArg, workspaceArg, options = {}) {
  if (!workspaceArg) {
    return {
      config: readHostConfig(openClawHomeArg),
      workspace: null,
      configured: false,
      workspaceEntry: null,
      suggestedUserId: normalizeUserId(options.userId || DEFAULT_USER_ID),
      suggestedProjectId: normalizeProjectId(options.projectId, process.cwd())
    };
  }

  const config = readHostConfig(openClawHomeArg);
  const workspace = path.resolve(workspaceArg);
  const workspaceEntry = findWorkspaceEntry(config, workspace);
  const suggestedUserId = normalizeUserId(
    options.userId ||
      workspaceEntry?.user_id ||
      config.defaults.user_id ||
      DEFAULT_USER_ID
  );
  const suggestedProjectId = normalizeProjectId(
    options.projectId || workspaceEntry?.project_id,
    workspace
  );

  return {
    config,
    workspace,
    configured: Boolean(workspaceEntry),
    workspaceEntry,
    suggestedUserId,
    suggestedProjectId
  };
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

function findSessionByKey(config, sessionKeyArg) {
  if (!sessionKeyArg) {
    return null;
  }

  const sessionKey = sanitizeKey(sessionKeyArg, 'default');
  const matches = config.sessions.filter((entry) => entry.session_key === sessionKey);
  if (matches.length === 0) {
    return null;
  }

  return [...matches].sort((left, right) => {
    const leftActive = left.status === 'active' ? 1 : 0;
    const rightActive = right.status === 'active' ? 1 : 0;
    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }

    const rightUpdated = new Date(right.updated_at || right.last_active || 0).getTime();
    const leftUpdated = new Date(left.updated_at || left.last_active || 0).getTime();
    if (rightUpdated !== leftUpdated) {
      return rightUpdated - leftUpdated;
    }

    const rightActiveAt = new Date(right.last_active || 0).getTime();
    const leftActiveAt = new Date(left.last_active || 0).getTime();
    return rightActiveAt - leftActiveAt;
  })[0];
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
  const existing = findWorkspaceExact(config, workspace);
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

function setOnboardingPolicy(config, options = {}) {
  const next = normalizeHostConfig(config);

  if (typeof options.autoRegisterWorkspaces === 'boolean') {
    next.onboarding.auto_register_workspaces = options.autoRegisterWorkspaces;
  }
  if (typeof options.memoryTakeover === 'boolean') {
    next.onboarding.memory_takeover_mode = options.memoryTakeover ? 'enforced' : 'best_effort';
  }
  if (typeof options.memoryTakeoverMode === 'string' && options.memoryTakeoverMode.trim()) {
    next.onboarding.memory_takeover_mode =
      options.memoryTakeoverMode.trim().toLowerCase() === 'enforced' ? 'enforced' : 'best_effort';
  }

  return next;
}

function resolveOwnership(openClawHomeArg, options = {}) {
  const config = readHostConfig(openClawHomeArg);
  const globalSession = options.sessionKey ? findSessionByKey(config, options.sessionKey) : null;
  const workspace =
    options.workspace !== undefined && options.workspace !== null && options.workspace !== ''
      ? path.resolve(options.workspace)
      : globalSession?.workspace
        ? path.resolve(globalSession.workspace)
        : config.defaults.workspace
        ? path.resolve(config.defaults.workspace)
        : null;
  const session = workspace && options.sessionKey ? findSession(config, workspace, options.sessionKey) || globalSession : globalSession;
  const workspaceEntry = workspace ? findWorkspaceEntry(config, workspace) : null;
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

function ensureWorkspaceRegistration(openClawHomeArg, workspaceArg, options = {}) {
  const config = readHostConfig(openClawHomeArg);

  if (!workspaceArg) {
    return {
      status: 'skipped',
      reason: 'workspace_required',
      config,
      workspace: null,
      workspaceEntry: null
    };
  }

  const workspace = path.resolve(workspaceArg);
  const exactWorkspaceEntry = findWorkspaceExact(config, workspace);
  if (exactWorkspaceEntry) {
    return {
      status: 'reused',
      reason: 'workspace_already_registered',
      config,
      workspace,
      workspaceEntry: exactWorkspaceEntry,
      user_id: exactWorkspaceEntry.user_id,
      project_id: exactWorkspaceEntry.project_id
    };
  }

  const inheritedWorkspaceEntry = findWorkspaceEntry(config, workspace);
  if (inheritedWorkspaceEntry) {
    return {
      status: 'reused',
      reason: 'workspace_inherits_registered_parent',
      config,
      workspace,
      workspaceEntry: inheritedWorkspaceEntry,
      user_id: inheritedWorkspaceEntry.user_id,
      project_id: inheritedWorkspaceEntry.project_id
    };
  }

  if (config.onboarding.auto_register_workspaces === false) {
    return {
      status: 'blocked',
      reason: 'auto_register_workspaces_disabled',
      config,
      workspace,
      workspaceEntry: null,
      user_id: normalizeUserId(options.userId || config.defaults.user_id || DEFAULT_USER_ID),
      project_id: normalizeProjectId(options.projectId, workspace)
    };
  }

  const nextConfig = normalizeHostConfig(config);
  const workspaceEntry = upsertWorkspace(nextConfig, workspace, {
    userId: options.userId || nextConfig.defaults.user_id || DEFAULT_USER_ID,
    projectId: options.projectId
  });
  const file = writeHostConfig(openClawHomeArg, nextConfig);

  return {
    status: 'auto_registered',
    reason: options.reason || 'automatic_onboarding',
    file,
    config: nextConfig,
    workspace,
    workspaceEntry,
    user_id: workspaceEntry.user_id,
    project_id: workspaceEntry.project_id
  };
}

function recordSessionOwnership(openClawHomeArg, workspaceArg, sessionState, options = {}) {
  const config = readHostConfig(openClawHomeArg);
  upsertUser(config, sessionState.user_id);
  const workspace = path.resolve(workspaceArg);
  const exactWorkspaceEntry = findWorkspaceExact(config, workspace);
  const ownerWorkspaceEntry = exactWorkspaceEntry || findWorkspaceEntry(config, workspace);
  let persistedWorkspaceEntry = exactWorkspaceEntry
    ? upsertWorkspace(config, workspace, {
        userId: sessionState.user_id,
        projectId: sessionState.project_id,
        preserveExisting: true
      })
    : null;
  if (!persistedWorkspaceEntry && !ownerWorkspaceEntry && config.onboarding.auto_register_workspaces !== false) {
    persistedWorkspaceEntry = upsertWorkspace(config, workspace, {
      userId: sessionState.user_id,
      projectId: sessionState.project_id
    });
  }
  const sessionKey = sanitizeKey(sessionState.session_key, 'default');
  const existing = findSession(config, workspace, sessionKey);
  const status = options.status || existing?.status || 'active';
  const closedAt =
    status === 'closed'
      ? options.closedAt || sessionState.closed_at || nowIso()
      : existing?.closed_at || null;
  const next = {
    workspace,
    owner_workspace: persistedWorkspaceEntry?.workspace || ownerWorkspaceEntry?.workspace || null,
    session_key: sessionKey,
    user_id: normalizeUserId(sessionState.user_id),
    project_id: normalizeProjectId(sessionState.project_id, workspace),
    status,
    started_at: existing?.started_at || sessionState.started_at || nowIso(),
    last_active: sessionState.last_active || existing?.last_active || nowIso(),
    closed_at: closedAt,
    updated_at: nowIso()
  };

  if (existing) {
    config.sessions = config.sessions.map((entry) =>
      samePath(entry.workspace, workspace) && entry.session_key === sessionKey ? next : entry
    );
  } else {
    config.sessions = [...config.sessions, next];
  }

  const file = writeHostConfig(openClawHomeArg, config);
  return {
    file,
    session: next,
    workspace: persistedWorkspaceEntry || ownerWorkspaceEntry || null
  };
}

function summarizeHostConfig(config) {
  const normalized = normalizeHostConfig(config);
  return {
    defaults: normalized.defaults,
    onboarding: normalized.onboarding,
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
  findSessionByKey,
  findUser,
  findWorkspace,
  findWorkspaceExact,
  ensureWorkspaceRegistration,
  getWorkspaceRegistrationStatus,
  getHostConfigFile,
  getOpenClawHome,
  normalizeProjectId,
  normalizeUserId,
  readHostConfig,
  recordSessionOwnership,
  resolveOwnership,
  setHostDefaults,
  setOnboardingPolicy,
  summarizeHostConfig,
  upsertUser,
  upsertWorkspace,
  writeHostConfig
};
