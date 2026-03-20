#!/usr/bin/env node
/**
 * Session Start Script (Multi-Session Multi-Project Support)
 * Loads project-level and global memories
 *
 * Usage: node session-start.js <workspace> <session-key> [project-id]
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const sessionKey = (process.argv[3] || 'default').replace(/[:/]/g, '-');
const projectId = process.argv[4] || 'default';

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

function initSession() {
  const sessionDir = path.join(sessionsDir, sessionKey);
  const sessionStateFile = path.join(sessionDir, 'state.json');

  // Initialize session state
  const sessionState = {
    session_key: sessionKey,
    project_id: projectId,
    started_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    commitments: [],
    active_task: null,
    errors_count: 0,
    experiences_count: 0
  };

  writeJson(sessionStateFile, sessionState);

  // Update session index
  const indexFile = path.join(sessionsDir, '_index.json');
  const index = readJson(indexFile, { sessions: [] });

  const existingIdx = index.sessions.findIndex(s => s.session_key === sessionKey);
  const sessionInfo = {
    session_key: sessionKey,
    project_id: projectId,
    started_at: sessionState.started_at,
    last_active: sessionState.last_active
  };

  if (existingIdx >= 0) {
    index.sessions[existingIdx] = sessionInfo;
  } else {
    index.sessions.push(sessionInfo);
  }

  writeJson(indexFile, index);

  return sessionState;
}

function loadProjectMemories() {
  const projectDir = path.join(projectsDir, projectId);
  const projectStateFile = path.join(projectDir, 'state.json');
  const decisionsFile = path.join(projectDir, 'decisions.json');
  const experiencesFile = path.join(projectDir, 'experiences.json');
  const heatIndexFile = path.join(projectDir, 'heat-index.json');

  const result = {
    project: {
      id: projectId,
      state: readJson(projectStateFile, { project_id: projectId, name: projectId }),
      decisions: readJson(decisionsFile, { decisions: [] }).decisions,
      experiences: readJson(experiencesFile, { experiences: [] }).experiences,
      heatIndex: readJson(heatIndexFile, { entries: [] }).entries
    }
  };

  // Get high-heat decisions and experiences
  result.project.highHeatDecisions = result.project.decisions
    .filter(d => d.heat > 70)
    .slice(0, 5);

  result.project.highHeatExperiences = result.project.experiences
    .filter(e => e.heat > 60)
    .slice(0, 5);

  return result;
}

function loadGlobalMemories() {
  const globalDir = path.join(projectsDir, '_global');
  const globalStateFile = path.join(globalDir, 'state.json');

  return {
    global: readJson(globalStateFile, {
      user_preferences: {},
      important_facts: []
    })
  };
}

function generateSummary(sessionState, projectMemories, globalMemories) {
  const summary = {
    status: 'initialized',
    session: {
      key: sessionKey,
      project: projectId
    },
    project: {
      id: projectId,
      decisions_count: projectMemories.project.decisions.length,
      experiences_count: projectMemories.project.experiences.length,
      high_heat_decisions: projectMemories.project.highHeatDecisions.length,
      high_heat_experiences: projectMemories.project.highHeatExperiences.length
    },
    memories_to_inject: []
  };

  // Add high-heat decisions
  if (projectMemories.project.highHeatDecisions.length > 0) {
    summary.memories_to_inject.push({
      source: 'project_decisions',
      entries: projectMemories.project.highHeatDecisions.map(d => ({
        id: d.id,
        decision: d.decision,
        heat: d.heat
      }))
    });
  }

  // Add high-heat experiences
  if (projectMemories.project.highHeatExperiences.length > 0) {
    summary.memories_to_inject.push({
      source: 'project_experiences',
      entries: projectMemories.project.highHeatExperiences.map(e => ({
        id: e.id,
        type: e.type,
        summary: e.summary,
        heat: e.heat
      }))
    });
  }

  // Add global preferences
  if (Object.keys(globalMemories.global.user_preferences).length > 0) {
    summary.memories_to_inject.push({
      source: 'global_preferences',
      entries: Object.entries(globalMemories.global.user_preferences).map(([k, v]) => ({
        key: k,
        value: v
      }))
    });
  }

  return summary;
}

// Main execution
ensureDir(anchorDir);
ensureDir(sessionsDir);
ensureDir(projectsDir);

const sessionState = initSession();
const projectMemories = loadProjectMemories();
const globalMemories = loadGlobalMemories();
const summary = generateSummary(sessionState, projectMemories, globalMemories);

console.log(JSON.stringify(summary, null, 2));
