#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  projectId: 'default',
  sessionKey: 'default',
  thresholdWarning: 75,
  thresholdCritical: 85,
  thresholdEmergency: 90,
  hotMemoryHeat: 80,
  warmMemoryHeat: 50,
  coldMemoryHeat: 30,
  archiveHeat: 10,
  recentSessionWindowMs: 2 * 60 * 60 * 1000,
  autoValidation: {
    minDays: 7,
    minAccessCount: 3,
    minSessions: 2
  }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeKey(value = DEFAULTS.sessionKey) {
  const cleaned = String(value).trim().replace(/[:/\\]/g, '-');
  return cleaned || DEFAULTS.sessionKey;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readText(file, defaultValue = '') {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }

  return fs.readFileSync(file, 'utf8');
}

function readJson(file, defaultValue = {}) {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeText(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, 'utf8');
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function resolveWorkspace(workspaceArg) {
  return path.resolve(workspaceArg || process.cwd());
}

function getRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function getSkillsRoot(explicitRoot) {
  return path.resolve(
    explicitRoot ||
      process.env.CONTEXT_ANCHOR_SKILLS_ROOT ||
      path.resolve(getRepoRoot(), '..')
  );
}

function getOpenClawHome(explicitRoot) {
  return path.resolve(
    explicitRoot ||
      process.env.OPENCLAW_HOME ||
      path.join(os.homedir(), '.openclaw')
  );
}

function createPaths(workspaceArg) {
  const workspace = resolveWorkspace(workspaceArg);
  const anchorDir = path.join(workspace, '.context-anchor');
  const sessionsDir = path.join(anchorDir, 'sessions');
  const projectsDir = path.join(anchorDir, 'projects');
  const globalDir = path.join(projectsDir, '_global');

  return {
    workspace,
    anchorDir,
    sessionsDir,
    sessionIndexFile: path.join(sessionsDir, '_index.json'),
    projectsDir,
    globalDir,
    globalStateFile: path.join(globalDir, 'state.json'),
    indexFile: path.join(anchorDir, 'index.json')
  };
}

function ensureAnchorDirs(paths) {
  ensureDir(paths.anchorDir);
  ensureDir(paths.sessionsDir);
  ensureDir(paths.projectsDir);
  ensureDir(paths.globalDir);
}

function sessionDir(paths, sessionKey) {
  return path.join(paths.sessionsDir, sanitizeKey(sessionKey));
}

function sessionStateFile(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'state.json');
}

function sessionMemoryFile(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'memory-hot.json');
}

function sessionCheckpointFile(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'checkpoint.md');
}

function projectDir(paths, projectId = DEFAULTS.projectId) {
  return path.join(paths.projectsDir, projectId);
}

function projectStateFile(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectDir(paths, projectId), 'state.json');
}

function projectDecisionsFile(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectDir(paths, projectId), 'decisions.json');
}

function projectExperiencesFile(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectDir(paths, projectId), 'experiences.json');
}

function projectHeatIndexFile(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectDir(paths, projectId), 'heat-index.json');
}

function projectFactsFile(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectDir(paths, projectId), 'facts.json');
}

function loadCollection(file, key) {
  const content = readJson(file, { [key]: [] });
  const items = Array.isArray(content[key]) ? content[key] : [];
  return items;
}

function writeCollection(file, key, items) {
  writeJson(file, { [key]: items });
}

function generateId(prefix) {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${suffix}`;
}

function createSessionState(sessionKey, projectId, existing = {}) {
  const timestamp = nowIso();

  return {
    session_key: sanitizeKey(existing.session_key || sessionKey),
    project_id: existing.project_id || projectId || DEFAULTS.projectId,
    started_at: existing.started_at || timestamp,
    last_active: timestamp,
    commitments: Array.isArray(existing.commitments) ? existing.commitments : [],
    active_task:
      Object.prototype.hasOwnProperty.call(existing, 'active_task') ? existing.active_task : null,
    errors_count: Number(existing.errors_count || 0),
    experiences_count: Number(existing.experiences_count || 0),
    notes_count: Number(existing.notes_count || 0),
    last_checkpoint: existing.last_checkpoint || null,
    checkpoint_reason: existing.checkpoint_reason || null,
    last_pressure_check: existing.last_pressure_check || null,
    last_pressure_usage: existing.last_pressure_usage || null,
    recovered_from_hook_at: existing.recovered_from_hook_at || null,
    metadata: existing.metadata || {}
  };
}

function loadSessionState(paths, sessionKey, projectId = DEFAULTS.projectId, options = {}) {
  const normalizedKey = sanitizeKey(sessionKey);
  const file = sessionStateFile(paths, normalizedKey);
  const existing = readJson(file, null);

  if (!existing && options.createIfMissing === false) {
    return null;
  }

  const state = createSessionState(normalizedKey, projectId, existing || {});

  if (options.touch !== false || !existing) {
    writeJson(file, state);
  }

  return state;
}

function writeSessionState(paths, sessionKey, state) {
  writeJson(sessionStateFile(paths, sessionKey), state);
}

function loadSessionMemory(paths, sessionKey) {
  return loadCollection(sessionMemoryFile(paths, sessionKey), 'entries');
}

function writeSessionMemory(paths, sessionKey, entries) {
  writeCollection(sessionMemoryFile(paths, sessionKey), 'entries', entries);
}

function createProjectState(projectId, existing = {}) {
  const timestamp = nowIso();

  return {
    project_id: existing.project_id || projectId,
    name: existing.name || projectId,
    created_at: existing.created_at || timestamp,
    last_updated: timestamp,
    sessions_count: Number(existing.sessions_count || 0),
    key_decisions: Array.isArray(existing.key_decisions) ? existing.key_decisions : [],
    key_experiences: Array.isArray(existing.key_experiences) ? existing.key_experiences : [],
    user_preferences: existing.user_preferences || {},
    metadata: existing.metadata || {}
  };
}

function ensureProjectArtifacts(paths, projectId = DEFAULTS.projectId) {
  const dir = projectDir(paths, projectId);
  ensureDir(dir);

  const stateFile = projectStateFile(paths, projectId);
  const state = createProjectState(projectId, readJson(stateFile, {}));
  writeJson(stateFile, state);

  if (!fs.existsSync(projectDecisionsFile(paths, projectId))) {
    writeCollection(projectDecisionsFile(paths, projectId), 'decisions', []);
  }

  if (!fs.existsSync(projectExperiencesFile(paths, projectId))) {
    writeCollection(projectExperiencesFile(paths, projectId), 'experiences', []);
  }

  if (!fs.existsSync(projectFactsFile(paths, projectId))) {
    writeCollection(projectFactsFile(paths, projectId), 'facts', []);
  }

  if (!fs.existsSync(projectHeatIndexFile(paths, projectId))) {
    writeJson(projectHeatIndexFile(paths, projectId), {
      project_id: projectId,
      last_updated: nowIso(),
      entries: []
    });
  }

  if (!fs.existsSync(paths.globalStateFile)) {
    writeJson(paths.globalStateFile, {
      user_preferences: {},
      important_facts: [],
      global_experiences: []
    });
  }
}

function loadProjectState(paths, projectId = DEFAULTS.projectId) {
  ensureProjectArtifacts(paths, projectId);
  return createProjectState(projectId, readJson(projectStateFile(paths, projectId), {}));
}

function writeProjectState(paths, projectId, state) {
  writeJson(projectStateFile(paths, projectId), state);
}

function loadProjectDecisions(paths, projectId = DEFAULTS.projectId) {
  ensureProjectArtifacts(paths, projectId);
  return loadCollection(projectDecisionsFile(paths, projectId), 'decisions');
}

function writeProjectDecisions(paths, projectId, decisions) {
  writeCollection(projectDecisionsFile(paths, projectId), 'decisions', decisions);
}

function loadProjectExperiences(paths, projectId = DEFAULTS.projectId) {
  ensureProjectArtifacts(paths, projectId);
  return loadCollection(projectExperiencesFile(paths, projectId), 'experiences');
}

function writeProjectExperiences(paths, projectId, experiences) {
  writeCollection(projectExperiencesFile(paths, projectId), 'experiences', experiences);
}

function loadProjectFacts(paths, projectId = DEFAULTS.projectId) {
  ensureProjectArtifacts(paths, projectId);
  return loadCollection(projectFactsFile(paths, projectId), 'facts');
}

function writeProjectFacts(paths, projectId, facts) {
  writeCollection(projectFactsFile(paths, projectId), 'facts', facts);
}

function loadGlobalState(paths) {
  ensureAnchorDirs(paths);
  return readJson(paths.globalStateFile, {
    user_preferences: {},
    important_facts: [],
    global_experiences: []
  });
}

function writeGlobalState(paths, state) {
  writeJson(paths.globalStateFile, state);
}

function loadHeatIndex(paths, projectId = DEFAULTS.projectId) {
  ensureProjectArtifacts(paths, projectId);
  return readJson(projectHeatIndexFile(paths, projectId), {
    project_id: projectId,
    last_updated: nowIso(),
    entries: []
  });
}

function writeHeatIndex(paths, projectId, heatIndex) {
  writeJson(projectHeatIndexFile(paths, projectId), heatIndex);
}

function uniqueList(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function mergeAccessMetadata(entry, sessionKey, options = {}) {
  const timestamp = options.timestamp || nowIso();
  const heatDelta = Number(options.heatDelta || 0);
  const sessions = uniqueList([...(entry.access_sessions || []), sanitizeKey(sessionKey)]);

  return {
    ...entry,
    access_count: Number(entry.access_count || 0) + 1,
    access_sessions: sessions,
    last_accessed: timestamp,
    heat: clamp(Number(entry.heat || 0) + heatDelta, 0, 100)
  };
}

function normalizeValidation(validation = {}) {
  return {
    status: validation.status || 'pending',
    count: Number(validation.count || 0),
    auto_validated: Boolean(validation.auto_validated),
    last_reviewed_at: validation.last_reviewed_at || null,
    notes: Array.isArray(validation.notes) ? validation.notes : []
  };
}

function calculateDaysSince(timestamp) {
  return (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
}

function isAutoValidationEligible(experience) {
  const daysSinceCreated = calculateDaysSince(experience.created_at);
  const accessCount = Number(experience.access_count || experience.applied_count || 0);
  const sessionCount = (experience.access_sessions || []).length;

  return (
    daysSinceCreated >= DEFAULTS.autoValidation.minDays &&
    accessCount >= DEFAULTS.autoValidation.minAccessCount &&
    sessionCount >= DEFAULTS.autoValidation.minSessions
  );
}

function ensureExperienceValidation(experience, noteSource = 'auto') {
  const validation = normalizeValidation(experience.validation);

  if (validation.status === 'pending' && isAutoValidationEligible(experience)) {
    validation.status = 'validated';
    validation.count += 1;
    validation.auto_validated = true;
    validation.last_reviewed_at = nowIso();
    validation.notes.push({
      source: noteSource,
      at: validation.last_reviewed_at,
      note: 'Validated by repeated cross-session reuse and retention.'
    });
  }

  return validation;
}

function recordHeatEntry(paths, projectId, entry) {
  const heatIndex = loadHeatIndex(paths, projectId);
  const entries = Array.isArray(heatIndex.entries) ? heatIndex.entries : [];
  const idx = entries.findIndex((item) => item.id === entry.id);
  const next = {
    id: entry.id,
    type: entry.type,
    heat: Number(entry.heat || 0),
    last_accessed: entry.last_accessed || entry.created_at || nowIso(),
    last_evaluated: entry.last_evaluated || nowIso(),
    access_count: Number(entry.access_count || entry.applied_count || 0),
    access_sessions: uniqueList(entry.access_sessions || []),
    archived: Boolean(entry.archived)
  };

  if (idx >= 0) {
    entries[idx] = next;
  } else {
    entries.push(next);
  }

  heatIndex.entries = entries.sort((left, right) => right.heat - left.heat);
  heatIndex.last_updated = nowIso();
  writeHeatIndex(paths, projectId, heatIndex);
  return heatIndex;
}

function touchSessionIndex(paths, sessionState) {
  const index = readJson(paths.sessionIndexFile, { sessions: [] });
  const sessions = Array.isArray(index.sessions) ? index.sessions : [];
  const idx = sessions.findIndex((entry) => entry.session_key === sessionState.session_key);
  const next = {
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    started_at: sessionState.started_at,
    last_active: sessionState.last_active
  };

  if (idx >= 0) {
    sessions[idx] = next;
  } else {
    sessions.push(next);
  }

  writeJson(paths.sessionIndexFile, {
    sessions: sessions.sort((left, right) => {
      return new Date(right.last_active).getTime() - new Date(left.last_active).getTime();
    })
  });
}

function touchGlobalIndex(paths) {
  const sessionIndex = readJson(paths.sessionIndexFile, { sessions: [] });
  const projectIds = fs.existsSync(paths.projectsDir)
    ? fs
        .readdirSync(paths.projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name !== '_global')
    : [];

  let totalDecisions = 0;
  let totalExperiences = 0;
  projectIds.forEach((projectId) => {
    totalDecisions += loadProjectDecisions(paths, projectId).length;
    totalExperiences += loadProjectExperiences(paths, projectId).length;
  });

  writeJson(paths.indexFile, {
    version: '0.2.0',
    created_at: readJson(paths.indexFile, { created_at: nowIso() }).created_at || nowIso(),
    last_updated: nowIso(),
    projects: projectIds,
    active_sessions: (sessionIndex.sessions || [])
      .filter((session) => {
        return Date.now() - new Date(session.last_active).getTime() <= DEFAULTS.recentSessionWindowMs;
      })
      .map((session) => session.session_key),
    stats: {
      total_sessions: (sessionIndex.sessions || []).length,
      total_decisions: totalDecisions,
      total_experiences: totalExperiences
    }
  });
}

function syncProjectStateMetadata(paths, projectId) {
  const state = loadProjectState(paths, projectId);
  const decisions = loadProjectDecisions(paths, projectId).filter((entry) => !entry.archived);
  const experiences = loadProjectExperiences(paths, projectId).filter((entry) => !entry.archived);
  const sessionIndex = readJson(paths.sessionIndexFile, { sessions: [] });

  state.sessions_count = (sessionIndex.sessions || []).filter((entry) => entry.project_id === projectId).length;
  state.key_decisions = decisions
    .filter((entry) => Number(entry.heat || 0) >= DEFAULTS.hotMemoryHeat)
    .map((entry) => entry.id)
    .slice(0, 20);
  state.key_experiences = experiences
    .filter((entry) => Number(entry.heat || 0) >= DEFAULTS.warmMemoryHeat)
    .map((entry) => entry.id)
    .slice(0, 20);
  state.last_updated = nowIso();

  writeProjectState(paths, projectId, state);
  touchGlobalIndex(paths);
  return state;
}

function sortByHeat(items) {
  return [...items].sort((left, right) => Number(right.heat || 0) - Number(left.heat || 0));
}

function getRecentSessions(paths, windowMs = DEFAULTS.recentSessionWindowMs) {
  const index = readJson(paths.sessionIndexFile, { sessions: [] });
  return (index.sessions || []).filter((entry) => {
    return Date.now() - new Date(entry.last_active).getTime() <= windowMs;
  });
}

function buildCheckpointContent(template, values) {
  return template
    .replace('{timestamp}', values.timestamp)
    .replace('{active_task}', values.activeTask)
    .replace('{hot_memories}', values.hotMemories)
    .replace('{key_decisions}', values.keyDecisions)
    .replace('{pending_commitments}', values.pendingCommitments)
    .replace('{next_steps}', values.nextSteps);
}

function copyDir(sourceDir, targetDir) {
  ensureDir(targetDir);

  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
      return;
    }

    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  });
}

module.exports = {
  DEFAULTS,
  buildCheckpointContent,
  calculateDaysSince,
  clamp,
  copyDir,
  createPaths,
  createSessionState,
  ensureAnchorDirs,
  ensureDir,
  ensureExperienceValidation,
  ensureProjectArtifacts,
  generateId,
  getOpenClawHome,
  getRepoRoot,
  getSkillsRoot,
  getRecentSessions,
  loadCollection,
  loadGlobalState,
  loadHeatIndex,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadProjectState,
  loadSessionMemory,
  loadSessionState,
  mergeAccessMetadata,
  normalizeValidation,
  nowIso,
  projectDecisionsFile,
  projectDir,
  projectExperiencesFile,
  projectFactsFile,
  projectHeatIndexFile,
  projectStateFile,
  readJson,
  readText,
  recordHeatEntry,
  resolveWorkspace,
  sanitizeKey,
  sessionCheckpointFile,
  sessionDir,
  sessionMemoryFile,
  sessionStateFile,
  sortByHeat,
  syncProjectStateMetadata,
  touchGlobalIndex,
  touchSessionIndex,
  uniqueList,
  writeCollection,
  writeGlobalState,
  writeHeatIndex,
  writeJson,
  writeProjectDecisions,
  writeProjectExperiences,
  writeProjectFacts,
  writeProjectState,
  writeSessionMemory,
  writeSessionState,
  writeText
};
