#!/usr/bin/env node
/**
 * Memory Save Script (Multi-Session Multi-Project Support)
 * Saves memory to appropriate scope (session/project/global)
 *
 * Usage: node memory-save.js <workspace> <session-key> <scope> <type> <content>
 *
 * scope: session | project | global
 * type: decision | experience | preference | fact | error
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const sessionKey = (process.argv[3] || 'default').replace(/[:/]/g, '-');
const scope = process.argv[4] || 'project';
const type = process.argv[5] || 'fact';
const content = process.argv[6] || '';

const anchorDir = path.join(workspace, '.context-anchor');
const sessionsDir = path.join(anchorDir, 'sessions');
const projectsDir = path.join(anchorDir, 'projects');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function generateId(type) {
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 6);
  return `${type}-${date}-${random}`;
}

function saveToSession(sessionKey, type, content) {
  const sessionDir = path.join(sessionsDir, sessionKey);
  const memoryFile = path.join(sessionDir, 'memory-hot.json');

  const memory = readJson(memoryFile, { entries: [] });
  const id = generateId(type);

  memory.entries.push({
    id,
    type,
    content,
    heat: 100,
    created_at: new Date().toISOString(),
    session_key: sessionKey
  });

  writeJson(memoryFile, memory);

  return { scope: 'session', id, type };
}

function saveToProject(projectId, type, content) {
  const projectDir = path.join(projectsDir, projectId);

  if (type === 'decision') {
    const file = path.join(projectDir, 'decisions.json');
    const data = readJson(file, { decisions: [] });
    const id = generateId('dec');

    data.decisions.push({
      id,
      decision: content,
      session_key: sessionKey,
      created_at: new Date().toISOString(),
      heat: 80,
      access_sessions: [sessionKey],
      tags: []
    });

    writeJson(file, data);
    return { scope: 'project', id, type: 'decision' };
  }

  if (type === 'experience' || type === 'error') {
    const file = path.join(projectDir, 'experiences.json');
    const data = readJson(file, { experiences: [] });
    const id = generateId('exp');

    data.experiences.push({
      id,
      type: type === 'error' ? 'lesson' : type,
      summary: content,
      session_key: sessionKey,
      created_at: new Date().toISOString(),
      heat: 60,
      applied_count: 0,
      tags: []
    });

    writeJson(file, data);
    return { scope: 'project', id, type: 'experience' };
  }

  if (type === 'preference') {
    const file = path.join(projectDir, 'state.json');
    const data = readJson(file, { project_id: projectId, user_preferences: {} });

    // Parse content as "key:value" format
    const [key, ...valueParts] = content.split(':');
    if (key && valueParts.length > 0) {
      data.user_preferences[key.trim()] = valueParts.join(':').trim();
    }

    data.last_updated = new Date().toISOString();
    writeJson(file, data);
    return { scope: 'project', id: `pref-${key}`, type: 'preference' };
  }

  // Default: save as fact
  const file = path.join(projectDir, 'facts.json');
  const data = readJson(file, { facts: [] });
  const id = generateId('fact');

  data.facts.push({
    id,
    content,
    session_key: sessionKey,
    created_at: new Date().toISOString(),
    heat: 70
  });

  writeJson(file, data);
  return { scope: 'project', id, type: 'fact' };
}

function saveToGlobal(type, content) {
  const globalDir = path.join(projectsDir, '_global');
  const file = path.join(globalDir, 'state.json');

  const data = readJson(file, {
    user_preferences: {},
    important_facts: []
  });

  if (type === 'preference') {
    const [key, ...valueParts] = content.split(':');
    if (key && valueParts.length > 0) {
      data.user_preferences[key.trim()] = valueParts.join(':').trim();
    }
  } else {
    data.important_facts.push({
      content,
      created_at: new Date().toISOString()
    });
  }

  writeJson(file, data);
  return { scope: 'global', type };
}

function saveMemory() {
  ensureDir(anchorDir);
  ensureDir(sessionsDir);
  ensureDir(projectsDir);

  // Get project_id from session state
  const sessionStateFile = path.join(sessionsDir, sessionKey, 'state.json');
  const sessionState = readJson(sessionStateFile, { project_id: 'default' });
  const projectId = sessionState.project_id || 'default';

  let result;

  switch (scope) {
    case 'session':
      result = saveToSession(sessionKey, type, content);
      break;
    case 'global':
      result = saveToGlobal(type, content);
      break;
    case 'project':
    default:
      result = saveToProject(projectId, type, content);
      break;
  }

  console.log(JSON.stringify({
    status: 'saved',
    ...result,
    timestamp: new Date().toISOString()
  }, null, 2));
}

saveMemory();
