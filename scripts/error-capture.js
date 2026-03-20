#!/usr/bin/env node
/**
 * Error Capture Script
 * Captures errors and records them to experiences.json
 *
 * Usage: node error-capture.js <workspace> <session-key> <error-type> <summary> [details] [solution]
 *
 * error-type: command_failed | user_correction | api_failed | general
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const sessionKey = (process.argv[3] || 'default').replace(/[:/]/g, '-');
const errorType = process.argv[4] || 'general';
const summary = process.argv[5] || '';
const details = process.argv[6] || '';
const solution = process.argv[7] || '';

if (!summary) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Usage: node error-capture.js <workspace> <session-key> <error-type> <summary> [details] [solution]'
  }, null, 2));
  process.exit(1);
}

const anchorDir = path.join(workspace, '.context-anchor');
const projectsDir = path.join(anchorDir, 'projects');
const sessionsDir = path.join(anchorDir, 'sessions');

// Get project_id from session state
const sessionStateFile = path.join(sessionsDir, sessionKey, 'state.json');
let projectId = 'default';

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
  return `exp-${date}-${random}`;
}

function getInitialHeat(errorType) {
  const heatMap = {
    'user_correction': 70,
    'command_failed': 60,
    'api_failed': 60,
    'general': 50
  };
  return heatMap[errorType] || 50;
}

function captureError() {
  ensureDir(anchorDir);
  ensureDir(projectsDir);
  ensureDir(sessionsDir);

  // Get project_id from session
  if (fs.existsSync(sessionStateFile)) {
    const sessionState = readJson(sessionStateFile, {});
    projectId = sessionState.project_id || 'default';
  }

  const projectDir = path.join(projectsDir, projectId);
  ensureDir(projectDir);
  
  const experiencesFile = path.join(projectDir, 'experiences.json');

  // Generate experience entry
  const id = generateId('exp');
  const now = new Date().toISOString();

  const experience = {
    id,
    type: 'lesson',
    summary,
    details: details || undefined,
    solution: solution || undefined,
    error_type: errorType,
    session_key: sessionKey,
    created_at: now,
    heat: getInitialHeat(errorType),
    access_count: 0,
    access_sessions: [sessionKey],
    tags: ['error', errorType]
  };

  // Remove undefined fields
  Object.keys(experience).forEach(key => {
    if (experience[key] === undefined) {
      delete experience[key];
    }
  });

  // Write to experiences.json
  const experiences = readJson(experiencesFile, { experiences: [] });
  experiences.experiences.push(experience);
  writeJson(experiencesFile, experiences);

  // Update session state
  const sessionDir = path.join(sessionsDir, sessionKey);
  const stateFile = path.join(sessionDir, 'state.json');
  const state = readJson(stateFile, {
    session_key: sessionKey,
    project_id: projectId,
    errors_count: 0
  });
  state.errors_count = (state.errors_count || 0) + 1;
  state.last_error = now;
  writeJson(stateFile, state);

  console.log(JSON.stringify({
    status: 'captured',
    id,
    type: 'lesson',
    error_type: errorType,
    heat: experience.heat,
    message: `Error captured: ${summary}`
  }, null, 2));
}

captureError();
