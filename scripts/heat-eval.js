#!/usr/bin/env node
/**
 * Heat Evaluation Script (Multi-Session Multi-Project Support)
 * Calculates heat decay and updates heat-index.json for a project
 *
 * Usage: node heat-eval.js <workspace> [project-id]
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const projectId = process.argv[3] || 'default';

const anchorDir = path.join(workspace, '.context-anchor');
const projectsDir = path.join(anchorDir, 'projects');
const projectDir = path.join(projectsDir, projectId);
const heatIndexFile = path.join(projectDir, 'heat-index.json');
const decisionsFile = path.join(projectDir, 'decisions.json');
const experiencesFile = path.join(projectDir, 'experiences.json');

// Decay rate: -1 per hour
const DECAY_RATE = 1;
const HEAT_MIN = 0;
const HEAT_MAX = 100;

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

function calculateDecay(lastAccessed) {
  const now = Date.now();
  const last = new Date(lastAccessed).getTime();
  const hoursSinceAccess = (now - last) / (1000 * 60 * 60);
  return Math.floor(hoursSinceAccess * DECAY_RATE);
}

function evaluateHeat() {
  ensureDir(projectDir);

  const heatIndex = readJson(heatIndexFile, {
    project_id: projectId,
    last_updated: new Date().toISOString(),
    entries: []
  });

  const decisions = readJson(decisionsFile, { decisions: [] }).decisions;
  const experiences = readJson(experiencesFile, { experiences: [] }).experiences;

  const now = new Date().toISOString();
  const actions = [];

  // Build entry map from heat index
  const entryMap = new Map();
  heatIndex.entries.forEach(e => entryMap.set(e.id, e));

  // Process decisions
  decisions.forEach(d => {
    const existing = entryMap.get(d.id) || {
      id: d.id,
      type: 'decision',
      heat: d.heat || 50,
      last_accessed: d.created_at || now,
      access_count: 0,
      access_sessions: []
    };

    const decay = calculateDecay(existing.last_accessed);
    existing.heat = Math.max(HEAT_MIN, Math.min(HEAT_MAX, (d.heat || existing.heat) - decay));
    existing.last_evaluated = now;

    entryMap.set(d.id, existing);
  });

  // Process experiences
  experiences.forEach(e => {
    const existing = entryMap.get(e.id) || {
      id: e.id,
      type: 'experience',
      heat: e.heat || 50,
      last_accessed: e.created_at || now,
      access_count: 0,
      access_sessions: []
    };

    const decay = calculateDecay(existing.last_accessed);
    existing.heat = Math.max(HEAT_MIN, Math.min(HEAT_MAX, (e.heat || existing.heat) - decay));
    existing.last_evaluated = now;

    entryMap.set(e.id, existing);
  });

  // Update heat index
  heatIndex.entries = Array.from(entryMap.values());
  heatIndex.last_updated = now;

  writeJson(heatIndexFile, heatIndex);

  // Identify actions needed
  const needsPromotion = heatIndex.entries.filter(e => e.heat > 80);
  const needsDemotion = heatIndex.entries.filter(e => e.heat < 30);

  console.log(JSON.stringify({
    project_id: projectId,
    evaluated: heatIndex.entries.length,
    needs_promotion: needsPromotion.length,
    needs_demotion: needsDemotion.length,
    promotion_candidates: needsPromotion.map(e => ({ id: e.id, type: e.type, heat: e.heat })),
    demotion_candidates: needsDemotion.map(e => ({ id: e.id, type: e.type, heat: e.heat }))
  }, null, 2));
}

evaluateHeat();
