#!/usr/bin/env node
/**
 * Heat Evaluation Script
 * Calculates heat decay and updates heat-index.json
 *
 * Usage: node heat-eval.js <workspace>
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const stateDir = path.join(workspace, '.context-anchor');
const heatIndexFile = path.join(stateDir, 'heat-index.json');
const memoryDir = path.join(workspace, 'memory');

// Decay rate: -1 per hour
const DECAY_RATE = 1;
const HEAT_MIN = 0;
const HEAT_MAX = 100;

function loadHeatIndex() {
  if (!fs.existsSync(heatIndexFile)) {
    return { last_updated: new Date().toISOString(), entries: [] };
  }
  return JSON.parse(fs.readFileSync(heatIndexFile, 'utf8'));
}

function saveHeatIndex(index) {
  index.last_updated = new Date().toISOString();
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  fs.writeFileSync(heatIndexFile, JSON.stringify(index, null, 2));
}

function calculateDecay(lastAccessed) {
  const now = Date.now();
  const last = new Date(lastAccessed).getTime();
  const hoursSinceAccess = (now - last) / (1000 * 60 * 60);
  return Math.floor(hoursSinceAccess * DECAY_RATE);
}

function evaluateHeat() {
  const index = loadHeatIndex();
  const now = new Date().toISOString();

  index.entries.forEach(entry => {
    const decay = calculateDecay(entry.last_accessed);
    entry.heat = Math.max(HEAT_MIN, Math.min(HEAT_MAX, entry.heat - decay));
    entry.last_evaluated = now;
  });

  saveHeatIndex(index);

  // Output summary
  const needsPromotion = index.entries.filter(e => e.heat > 80);
  const needsDemotion = index.entries.filter(e => e.heat < 30);

  console.log(JSON.stringify({
    evaluated: index.entries.length,
    needsPromotion: needsPromotion.length,
    needsDemotion: needsDemotion.length,
    entries: index.entries
  }, null, 2));
}

evaluateHeat();
