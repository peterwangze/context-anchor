#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isDbEnabled,
  loadRankedMirrorCollection,
  readMirrorCollection,
  syncCollectionMirror
} = require('./context-anchor-db');

const DEFAULTS = {
  userId: 'default-user',
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
  },
  skillActivationBudget: {
    total: 5,
    session: 2,
    project: 2,
    user: 1
  },
  bootstrapContextBudget: 10000,
  bootstrapHotMemoryLimit: 4,
  bootstrapWarmPreviewLimit: 2,
  bootstrapRelatedSessionLimit: 2,
  memorySearchResultLimit: 8,
  skillArchivePriorityThreshold: 25
  ,
  skillArchiveUsageThreshold: 0
};
const VALIDATION_STATUSES = ['pending', 'validated', 'rejected'];
const SKILL_STATUSES = ['draft', 'active', 'inactive', 'archived'];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function classifyHeatTier(heat) {
  const numericHeat = Number(heat || 0);

  if (numericHeat >= DEFAULTS.hotMemoryHeat) {
    return 'hot';
  }

  if (numericHeat >= DEFAULTS.warmMemoryHeat) {
    return 'warm';
  }

  return 'cold';
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

function normalizeEvidenceArray(evidence = []) {
  return (Array.isArray(evidence) ? evidence : []).map((entry) => ({
    type: entry.type || 'event',
    at: entry.at || nowIso(),
    scope: entry.scope || null,
    source_session: entry.source_session || null,
    source_project: entry.source_project || null,
    source_user: entry.source_user || null,
    actor: entry.actor || 'system',
    reason: entry.reason || null,
    details: entry.details || {}
  }));
}

function appendEvidence(entity = {}, event = {}) {
  return {
    ...entity,
    evidence: normalizeEvidenceArray([...(entity.evidence || []), event])
  };
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
  const openClawHome = getOpenClawHome();
  const anchorHomeDir = path.join(openClawHome, 'context-anchor');
  const usersDir = path.join(anchorHomeDir, 'users');
  const anchorDir = path.join(workspace, '.context-anchor');
  const sessionsDir = path.join(anchorDir, 'sessions');
  const projectsDir = path.join(anchorDir, 'projects');
  const globalDir = path.join(projectsDir, '_global');
  const reportsDir = path.join(anchorDir, 'reports');

  return {
    workspace,
    openClawHome,
    anchorHomeDir,
    usersDir,
    anchorDir,
    reportsDir,
    sessionsDir,
    sessionIndexFile: path.join(sessionsDir, '_index.json'),
    projectsDir,
    globalDir,
    globalStateFile: path.join(globalDir, 'state.json'),
    indexFile: path.join(anchorDir, 'index.json')
  };
}

function ensureAnchorDirs(paths) {
  ensureDir(paths.anchorHomeDir);
  ensureDir(paths.usersDir);
  ensureDir(paths.anchorDir);
  ensureDir(paths.reportsDir);
  ensureDir(paths.sessionsDir);
  ensureDir(paths.projectsDir);
  ensureDir(paths.globalDir);
}

function resolveUserId(explicitUserId) {
  return sanitizeKey(explicitUserId || DEFAULTS.userId);
}

function resolveProjectId(workspace, explicitProjectId) {
  if (explicitProjectId) {
    return sanitizeKey(explicitProjectId);
  }

  return sanitizeKey(path.basename(resolveWorkspace(workspace)) || DEFAULTS.projectId);
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

function projectSkillsDir(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectDir(paths, projectId), 'skills');
}

function projectSkillsIndexFile(paths, projectId = DEFAULTS.projectId) {
  return path.join(projectSkillsDir(paths, projectId), 'index.json');
}

function sessionExperiencesFile(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'experiences.json');
}

function sessionSkillsDir(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'skills');
}

function sessionSkillsIndexFile(paths, sessionKey) {
  return path.join(sessionSkillsDir(paths, sessionKey), 'index.json');
}

function compactPacketFile(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'compact-packet.json');
}

function sessionSummaryFile(paths, sessionKey) {
  return path.join(sessionDir(paths, sessionKey), 'session-summary.json');
}

function statusSnapshotFile(paths, sessionKey = 'latest') {
  return path.join(paths.reportsDir, `${sanitizeKey(sessionKey)}-status.json`);
}

function userDir(paths, userId = DEFAULTS.userId) {
  return path.join(paths.usersDir, resolveUserId(userId));
}

function userStateFile(paths, userId = DEFAULTS.userId) {
  return path.join(userDir(paths, userId), 'state.json');
}

function userMemoriesFile(paths, userId = DEFAULTS.userId) {
  return path.join(userDir(paths, userId), 'memories.json');
}

function userExperiencesFile(paths, userId = DEFAULTS.userId) {
  return path.join(userDir(paths, userId), 'experiences.json');
}

function userHeatIndexFile(paths, userId = DEFAULTS.userId) {
  return path.join(userDir(paths, userId), 'heat-index.json');
}

function userSkillsDir(paths, userId = DEFAULTS.userId) {
  return path.join(userDir(paths, userId), 'skills');
}

function userSkillsIndexFile(paths, userId = DEFAULTS.userId) {
  return path.join(userSkillsDir(paths, userId), 'index.json');
}

function loadCollection(file, key) {
  const mirror = readMirrorCollection(file, key);
  if (mirror.status === 'available') {
    return Array.isArray(mirror.items) ? mirror.items : [];
  }

  const content = readJson(file, { [key]: [] });
  const items = Array.isArray(content[key]) ? content[key] : [];
  if (isDbEnabled()) {
    syncCollectionMirror(file, key, items);
  }
  return items;
}

function writeCollection(file, key, items) {
  writeJson(file, { [key]: items });
  if (isDbEnabled()) {
    syncCollectionMirror(file, key, items);
  }
}

function loadRankedCollection(file, key, options = {}) {
  const ranked = loadRankedMirrorCollection(file, key, options);
  if (Array.isArray(ranked)) {
    return ranked;
  }

  const content = readJson(file, { [key]: [] });
  const items = Array.isArray(content[key]) ? content[key] : [];
  const minHeat = options.minHeat === undefined ? null : Number(options.minHeat);
  const includeArchived = Boolean(options.includeArchived);
  const limit = Number(options.limit || 0);

  const filtered = items
    .filter((entry) => includeArchived || !entry.archived)
    .filter((entry) => minHeat === null || Number(entry.heat || 0) >= minHeat)
    .sort((left, right) => {
      const byHeat = Number(right.heat || 0) - Number(left.heat || 0);
      if (byHeat !== 0) {
        return byHeat;
      }

      return Number(right.access_count || right.applied_count || 0) - Number(left.access_count || left.applied_count || 0);
    });

  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

function generateId(prefix) {
  const stamp = nowIso().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${suffix}`;
}

function createSessionState(sessionKey, projectId, existing = {}, options = {}) {
  const timestamp = nowIso();

  return {
    session_key: sanitizeKey(existing.session_key || sessionKey),
    user_id: resolveUserId(existing.user_id || options.userId || DEFAULTS.userId),
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
    closed_at: existing.closed_at || null,
    last_summary: existing.last_summary || null,
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

  const state = createSessionState(normalizedKey, projectId, existing || {}, options);
  if (existing && options.touch === false && existing.last_active) {
    state.last_active = existing.last_active;
  }

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

function createUserState(userId, existing = {}) {
  const timestamp = nowIso();

  return {
    user_id: existing.user_id || resolveUserId(userId),
    created_at: existing.created_at || timestamp,
    last_updated: timestamp,
    preferences: existing.preferences || existing.user_preferences || {},
    profile: existing.profile || {},
    key_memories: Array.isArray(existing.key_memories) ? existing.key_memories : [],
    key_experiences: Array.isArray(existing.key_experiences) ? existing.key_experiences : [],
    key_skills: Array.isArray(existing.key_skills) ? existing.key_skills : [],
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

  ensureDir(projectSkillsDir(paths, projectId));
  if (!fs.existsSync(projectSkillsIndexFile(paths, projectId))) {
    writeJson(projectSkillsIndexFile(paths, projectId), { skills: [] });
  }
}

function ensureUserArtifacts(paths, userId = DEFAULTS.userId) {
  const normalizedUserId = resolveUserId(userId);
  const dir = userDir(paths, normalizedUserId);
  ensureDir(dir);

  const legacyGlobal = loadGlobalState(paths);
  const state = createUserState(normalizedUserId, readJson(userStateFile(paths, normalizedUserId), {
    user_id: normalizedUserId,
    preferences: legacyGlobal.user_preferences || {}
  }));
  writeJson(userStateFile(paths, normalizedUserId), state);

  if (!fs.existsSync(userMemoriesFile(paths, normalizedUserId))) {
    writeCollection(
      userMemoriesFile(paths, normalizedUserId),
      'memories',
      (legacyGlobal.important_facts || []).map((entry) => ({
        ...entry,
        scope: 'user',
        type: entry.type || 'memory',
        source_user: normalizedUserId,
        heat: entry.heat || 60,
        access_count: entry.access_count || 1,
        access_sessions: entry.access_sessions || [],
        validation: normalizeValidation(entry.validation),
        archived: Boolean(entry.archived)
      }))
    );
  }

  if (!fs.existsSync(userExperiencesFile(paths, normalizedUserId))) {
    writeCollection(
      userExperiencesFile(paths, normalizedUserId),
      'experiences',
      (legacyGlobal.global_experiences || []).map((entry) => ({
        ...entry,
        scope: 'user',
        source_user: normalizedUserId,
        heat: entry.heat || 60,
        access_count: entry.access_count || 1,
        access_sessions: entry.access_sessions || [],
        validation: normalizeValidation(entry.validation),
        archived: Boolean(entry.archived)
      }))
    );
  }

  ensureDir(userSkillsDir(paths, normalizedUserId));
  if (!fs.existsSync(userSkillsIndexFile(paths, normalizedUserId))) {
    writeJson(userSkillsIndexFile(paths, normalizedUserId), { skills: [] });
  }

  if (!fs.existsSync(userHeatIndexFile(paths, normalizedUserId))) {
    writeJson(userHeatIndexFile(paths, normalizedUserId), {
      user_id: normalizedUserId,
      last_updated: nowIso(),
      entries: []
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

function loadProjectSkills(paths, projectId = DEFAULTS.projectId) {
  ensureProjectArtifacts(paths, projectId);
  return loadCollection(projectSkillsIndexFile(paths, projectId), 'skills');
}

function writeProjectSkills(paths, projectId, skills) {
  writeCollection(projectSkillsIndexFile(paths, projectId), 'skills', skills);
}

function loadSessionExperiences(paths, sessionKey) {
  return loadCollection(sessionExperiencesFile(paths, sessionKey), 'experiences');
}

function writeSessionExperiences(paths, sessionKey, experiences) {
  writeCollection(sessionExperiencesFile(paths, sessionKey), 'experiences', experiences);
}

function loadSessionSkills(paths, sessionKey) {
  return loadCollection(sessionSkillsIndexFile(paths, sessionKey), 'skills');
}

function writeSessionSkills(paths, sessionKey, skills) {
  ensureDir(sessionSkillsDir(paths, sessionKey));
  writeCollection(sessionSkillsIndexFile(paths, sessionKey), 'skills', skills);
}

function loadUserState(paths, userId = DEFAULTS.userId) {
  ensureUserArtifacts(paths, userId);
  return createUserState(userId, readJson(userStateFile(paths, userId), {}));
}

function writeUserState(paths, userId, state) {
  writeJson(userStateFile(paths, userId), state);
}

function loadUserMemories(paths, userId = DEFAULTS.userId) {
  ensureUserArtifacts(paths, userId);
  return loadCollection(userMemoriesFile(paths, userId), 'memories');
}

function writeUserMemories(paths, userId, memories) {
  writeCollection(userMemoriesFile(paths, userId), 'memories', memories);
}

function loadUserExperiences(paths, userId = DEFAULTS.userId) {
  ensureUserArtifacts(paths, userId);
  return loadCollection(userExperiencesFile(paths, userId), 'experiences');
}

function writeUserExperiences(paths, userId, experiences) {
  writeCollection(userExperiencesFile(paths, userId), 'experiences', experiences);
}

function loadUserSkills(paths, userId = DEFAULTS.userId) {
  ensureUserArtifacts(paths, userId);
  return loadCollection(userSkillsIndexFile(paths, userId), 'skills');
}

function writeUserSkills(paths, userId, skills) {
  writeCollection(userSkillsIndexFile(paths, userId), 'skills', skills);
}

function writeCompactPacket(paths, sessionKey, packet) {
  writeJson(compactPacketFile(paths, sessionKey), packet);
}

function loadCompactPacket(paths, sessionKey) {
  return readJson(compactPacketFile(paths, sessionKey), {});
}

function writeSessionSummary(paths, sessionKey, summary) {
  writeJson(sessionSummaryFile(paths, sessionKey), summary);
}

function loadSessionSummary(paths, sessionKey) {
  return readJson(sessionSummaryFile(paths, sessionKey), {});
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
  const status = VALIDATION_STATUSES.includes(validation.status) ? validation.status : 'pending';

  return {
    status,
    count: Number(validation.count || 0),
    evidence_count: Number(validation.evidence_count || validation.count || 0),
    cross_project_count: Number(validation.cross_project_count || 0),
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

function recordUserHeatEntry(paths, userId, entry) {
  ensureUserArtifacts(paths, userId);
  const heatIndex = readJson(userHeatIndexFile(paths, userId), {
    user_id: resolveUserId(userId),
    last_updated: nowIso(),
    entries: []
  });
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
  writeJson(userHeatIndexFile(paths, userId), heatIndex);
  return heatIndex;
}

function touchSessionIndex(paths, sessionState) {
  const index = readJson(paths.sessionIndexFile, { sessions: [] });
  const sessions = Array.isArray(index.sessions) ? index.sessions : [];
  const idx = sessions.findIndex((entry) => entry.session_key === sessionState.session_key);
  const next = {
    session_key: sessionState.session_key,
    project_id: sessionState.project_id,
    user_id: sessionState.user_id,
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

function skillConflictKey(name = '') {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'skill';
}

function normalizeSkillRecord(skill = {}, defaultScope = 'project') {
  const scope = skill.scope || defaultScope;
  const status = SKILL_STATUSES.includes(skill.status) ? skill.status : (scope === 'session' ? 'draft' : 'active');
  return {
    ...skill,
    scope,
    status,
    archived: Boolean(skill.archived || status === 'archived'),
    conflict_key: skill.conflict_key || skillConflictKey(skill.name || skill.id || 'skill'),
    related_experiences: Array.isArray(skill.related_experiences) ? skill.related_experiences : [],
    promotion_history: Array.isArray(skill.promotion_history) ? skill.promotion_history : [],
    status_history: Array.isArray(skill.status_history) ? skill.status_history : [],
    supersedes: Array.isArray(skill.supersedes) ? skill.supersedes : [],
    superseded_by: skill.superseded_by || null,
    usage_count: Number(skill.usage_count || 0),
    last_used_at: skill.last_used_at || null,
    evidence: normalizeEvidenceArray(skill.evidence),
    load_policy: {
      auto_load: skill.load_policy?.auto_load !== false,
      priority: Number(skill.load_policy?.priority || 50),
      budget_weight: Number(skill.load_policy?.budget_weight || 1)
    }
  };
}

function isSkillLoadable(skill) {
  if (!skill || skill.archived) {
    return false;
  }

  if (skill.status === 'inactive' || skill.status === 'archived') {
    return false;
  }

  if (skill.superseded_by) {
    return false;
  }

  return skill.load_policy?.auto_load !== false;
}

function skillSupersedeTargets(skill) {
  return (skill.supersedes || []).map((item) => skillConflictKey(item));
}

function selectEffectiveSkills(skillGroups = {}, budgets = DEFAULTS.skillActivationBudget) {
  const order = ['session', 'project', 'user'];
  const candidates = [];
  const shadowed = [];
  const superseded = [];
  const budgeted_out = [];
  const chosenByKey = new Map();

  order.forEach((scope, index) => {
    const normalized = (skillGroups[scope] || [])
      .map((skill) => normalizeSkillRecord(skill, scope))
      .filter((skill) => isSkillLoadable(skill))
      .sort((left, right) => {
        const priorityDiff = Number(right.load_policy?.priority || 0) - Number(left.load_policy?.priority || 0);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        return new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime();
      });

    normalized.forEach((skill) => {
      const key = skill.conflict_key;
      if (chosenByKey.has(key)) {
        const winner = chosenByKey.get(key);
        shadowed.push({
          ...skill,
          shadowed_by: winner.id,
          shadowed_by_scope: winner.scope
        });
        return;
      }

      const withPrecedence = {
        ...skill,
        precedence: index
      };
      chosenByKey.set(key, withPrecedence);
      candidates.push(withPrecedence);
    });
  });

  const supersededKeys = new Set();
  candidates.forEach((skill) => {
    skillSupersedeTargets(skill).forEach((targetKey) => {
      supersededKeys.add(targetKey);
    });
  });

  const afterSupersede = [];
  candidates.forEach((skill) => {
    if (supersededKeys.has(skill.conflict_key) && !skillSupersedeTargets(skill).includes(skill.conflict_key)) {
      superseded.push({
        ...skill,
        superseded_reason: 'superseded_by_other_skill'
      });
      return;
    }

    afterSupersede.push(skill);
  });

  const scopeBudgetLeft = {
    session: Number(budgets.session || 0),
    project: Number(budgets.project || 0),
    user: Number(budgets.user || 0)
  };
  let totalBudgetLeft = Number(budgets.total || 0);
  const effective = [];

  afterSupersede.forEach((skill) => {
    const scope = skill.scope;
    const weight = Math.max(1, Number(skill.load_policy?.budget_weight || 1));
    if (totalBudgetLeft < weight || scopeBudgetLeft[scope] < weight) {
      budgeted_out.push({
        ...skill,
        budget_reason: 'budget_exhausted'
      });
      return;
    }

    totalBudgetLeft -= weight;
    scopeBudgetLeft[scope] -= weight;
    effective.push(skill);
  });

  return {
    effective,
    shadowed,
    superseded,
    budgeted_out
  };
}

function buildScopedSkillMarkdown(skill) {
  return [
    '---',
    `id: ${skill.id}`,
    `name: ${skill.name}`,
    `scope: ${skill.scope}`,
    `status: ${skill.status || 'active'}`,
    `created_at: ${skill.created_at || nowIso()}`,
    skill.source_experience ? `source_experience: ${skill.source_experience}` : null,
    skill.source_session ? `source_session: ${skill.source_session}` : null,
    skill.source_project ? `source_project: ${skill.source_project}` : null,
    skill.source_user ? `source_user: ${skill.source_user}` : null,
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.summary || 'Scoped skill generated from validated experience.',
    '',
    '## Source',
    '',
    skill.source_experience ? `- experience: ${skill.source_experience}` : '- experience: none',
    skill.source_scope ? `- source_scope: ${skill.source_scope}` : null,
    '',
    '## Notes',
    '',
    `- scope: ${skill.scope}`,
    `- status: ${skill.status || 'active'}`,
    skill.notes ? `- notes: ${skill.notes}` : null
  ]
    .filter((line) => line !== null)
    .join('\n')
    .concat('\n');
}

function matchSkillIdentifier(skill, identifier) {
  if (!identifier) {
    return false;
  }

  const normalizedIdentifier = String(identifier).trim().toLowerCase();
  return [
    skill.id,
    skill.name,
    skill.conflict_key
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .includes(normalizedIdentifier);
}

function collectSkillDiagnostics(skillGroups = {}, budgets = DEFAULTS.skillActivationBudget) {
  const normalizedGroups = {
    session: (skillGroups.session || []).map((skill) => normalizeSkillRecord(skill, 'session')),
    project: (skillGroups.project || []).map((skill) => normalizeSkillRecord(skill, 'project')),
    user: (skillGroups.user || []).map((skill) => normalizeSkillRecord(skill, 'user'))
  };
  const resolved = selectEffectiveSkills(normalizedGroups, budgets);

  const activeIds = new Set(resolved.effective.map((skill) => skill.id));
  const shadowedIds = new Set(resolved.shadowed.map((skill) => skill.id));
  const supersededIds = new Set(resolved.superseded.map((skill) => skill.id));
  const budgetedIds = new Set(resolved.budgeted_out.map((skill) => skill.id));

  const all = Object.values(normalizedGroups).flat().map((skill) => {
    let reason = 'inactive';

    if (activeIds.has(skill.id)) {
      reason = 'active';
    } else if (shadowedIds.has(skill.id)) {
      reason = 'shadowed';
    } else if (supersededIds.has(skill.id)) {
      reason = 'superseded';
    } else if (budgetedIds.has(skill.id)) {
      reason = 'budgeted_out';
    } else if (skill.status === 'inactive') {
      reason = 'inactive';
    } else if (skill.status === 'archived' || skill.archived) {
      reason = 'archived';
    }

    return {
      ...skill,
      diagnosis: reason
    };
  });

  return {
    all,
    active: resolved.effective,
    shadowed: resolved.shadowed,
    superseded: resolved.superseded,
    budgeted_out: resolved.budgeted_out
  };
}

function summarizeEvidence(evidence = []) {
  const normalized = normalizeEvidenceArray(evidence);
  const counts = normalized.reduce((acc, item) => {
    acc[item.type] = Number(acc[item.type] || 0) + 1;
    return acc;
  }, {});

  return {
    count: normalized.length,
    by_type: counts,
    recent: normalized.slice(-5).reverse()
  };
}

function countByStatus(items = []) {
  return items.reduce((acc, item) => {
    const key = item.status || 'unknown';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildHealthSummary(input) {
  const warnings = [];

  if ((input.session?.pending_commitments || 0) > 0) {
    warnings.push('pending_commitments');
  }

  if ((input.governance?.budgeted_out || 0) > 0) {
    warnings.push('budget_pressure_on_skills');
  }

  if ((input.governance?.shadowed || 0) > 0) {
    warnings.push('shadowed_skills_present');
  }

  if ((input.governance?.superseded || 0) > 0) {
    warnings.push('superseded_skills_present');
  }

  if ((input.skills?.inactive || 0) > 0) {
    warnings.push('inactive_skills_present');
  }

  if ((input.skills?.archived || 0) > 0) {
    warnings.push('archived_skills_present');
  }

  return {
    warnings,
    healthy: warnings.length === 0
  };
}

function buildAdaptiveBudget(baseBudget = DEFAULTS.skillActivationBudget, report = {}) {
  const nextBudget = {
    total: Number(baseBudget.total || DEFAULTS.skillActivationBudget.total),
    session: Number(baseBudget.session || DEFAULTS.skillActivationBudget.session),
    project: Number(baseBudget.project || DEFAULTS.skillActivationBudget.project),
    user: Number(baseBudget.user || DEFAULTS.skillActivationBudget.user)
  };

  const notes = [];
  const budgetedOut = Number(report?.governance?.budgeted_out || 0);
  const shadowed = Number(report?.governance?.shadowed || 0);
  const superseded = Number(report?.governance?.superseded || 0);

  if (budgetedOut > 0) {
    nextBudget.total += 1;
    nextBudget.project += 1;
    notes.push('budgeted_out skills detected, recommended temporary increase to total/project budget');
  }

  if (shadowed > 3 || superseded > 3) {
    nextBudget.user = Math.max(0, nextBudget.user - 1);
    notes.push('many shadowed/superseded skills detected, recommended reducing user budget');
  }

  return {
    current: baseBudget,
    recommended: nextBudget,
    notes
  };
}

function writeStatusSnapshot(paths, sessionKey, report) {
  const file = statusSnapshotFile(paths, sessionKey || 'latest');
  writeJson(file, report);
  return file;
}

module.exports = {
  DEFAULTS,
  SKILL_STATUSES,
  VALIDATION_STATUSES,
  appendEvidence,
  buildAdaptiveBudget,
  buildHealthSummary,
  buildCheckpointContent,
  buildScopedSkillMarkdown,
  calculateDaysSince,
  classifyHeatTier,
  clamp,
  copyDir,
  createPaths,
  createSessionState,
  ensureAnchorDirs,
  ensureDir,
  ensureExperienceValidation,
  ensureProjectArtifacts,
  ensureUserArtifacts,
  generateId,
  getOpenClawHome,
  getRepoRoot,
  getSkillsRoot,
  getRecentSessions,
  collectSkillDiagnostics,
  loadCompactPacket,
  loadCollection,
  loadGlobalState,
  loadHeatIndex,
  loadProjectDecisions,
  loadProjectExperiences,
  loadProjectFacts,
  loadRankedCollection,
  loadProjectSkills,
  loadProjectState,
  loadSessionMemory,
  loadSessionExperiences,
  loadSessionSkills,
  loadSessionState,
  loadSessionSummary,
  loadUserExperiences,
  loadUserMemories,
  loadUserSkills,
  loadUserState,
  mergeAccessMetadata,
  normalizeValidation,
  normalizeEvidenceArray,
  normalizeSkillRecord,
  nowIso,
  compactPacketFile,
  projectDecisionsFile,
  projectDir,
  projectExperiencesFile,
  projectFactsFile,
  projectHeatIndexFile,
  projectSkillsDir,
  projectSkillsIndexFile,
  projectStateFile,
  readJson,
  readText,
  recordHeatEntry,
  recordUserHeatEntry,
  resolveWorkspace,
  resolveProjectId,
  resolveUserId,
  sanitizeKey,
  sessionExperiencesFile,
  sessionCheckpointFile,
  sessionDir,
  sessionMemoryFile,
  sessionSkillsDir,
  sessionSkillsIndexFile,
  sessionStateFile,
  sessionSummaryFile,
  statusSnapshotFile,
  sortByHeat,
  summarizeEvidence,
  isSkillLoadable,
  matchSkillIdentifier,
  selectEffectiveSkills,
  skillConflictKey,
  countByStatus,
  syncProjectStateMetadata,
  touchGlobalIndex,
  touchSessionIndex,
  uniqueList,
  userDir,
  userExperiencesFile,
  userHeatIndexFile,
  userMemoriesFile,
  userSkillsDir,
  userSkillsIndexFile,
  userStateFile,
  writeCollection,
  writeCompactPacket,
  writeGlobalState,
  writeHeatIndex,
  writeJson,
  writeProjectDecisions,
  writeProjectExperiences,
  writeProjectFacts,
  writeProjectSkills,
  writeProjectState,
  writeSessionMemory,
  writeSessionExperiences,
  writeSessionSkills,
  writeSessionState,
  writeSessionSummary,
  writeStatusSnapshot,
  writeText,
  writeUserExperiences,
  writeUserMemories,
  writeUserSkills,
  writeUserState
};
