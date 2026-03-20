#!/usr/bin/env node
/**
 * Memory Flow Script
 * Moves memories between Cache and Disk based on heat
 *
 * Usage: node memory-flow.js <workspace>
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const memoryDir = path.join(workspace, 'memory');
const memoryFile = path.join(workspace, 'MEMORY.md');
const stateDir = path.join(workspace, '.context-anchor');
const heatIndexFile = path.join(stateDir, 'heat-index.json');

const CACHE_THRESHOLD = 50;
const DISK_THRESHOLD = 30;

function getTodayFile() {
  const today = new Date().toISOString().split('T')[0];
  return path.join(memoryDir, `${today}.md`);
}

function parseMemoryEntries(content) {
  const entries = [];
  const regex = /## (MEM-[^\n]+)\n([\s\S]*?)(?=## MEM-|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];

    // Parse heat from body
    const heatMatch = body.match(/heat:\s*(\d+)/);
    const heat = heatMatch ? parseInt(heatMatch[1]) : 50;

    entries.push({ id, heat, body, raw: match[0] });
  }

  return entries;
}

function flowMemories() {
  const todayFile = getTodayFile();

  if (!fs.existsSync(todayFile)) {
    console.log(JSON.stringify({ status: 'no_cache_file', actions: [] }));
    return;
  }

  const content = fs.readFileSync(todayFile, 'utf8');
  const entries = parseMemoryEntries(content);
  const actions = [];

  entries.forEach(entry => {
    if (entry.heat < DISK_THRESHOLD) {
      // Demote to Disk
      actions.push({
        action: 'demote',
        id: entry.id,
        from: 'cache',
        to: 'disk',
        heat: entry.heat
      });
    }
  });

  console.log(JSON.stringify({
    status: 'evaluated',
    total: entries.length,
    actions
  }, null, 2));
}

flowMemories();
