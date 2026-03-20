#!/usr/bin/env node
/**
 * Session Start Script
 * Loads yesterday's memory and high-heat entries
 *
 * Usage: node session-start.js <workspace>
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const memoryDir = path.join(workspace, 'memory');
const memoryFile = path.join(workspace, 'MEMORY.md');
const stateDir = path.join(workspace, '.context-anchor');
const heatIndexFile = path.join(stateDir, 'heat-index.json');

function getYesterday() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split('T')[0];
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function parseMemoryEntries(content) {
  const entries = [];
  const regex = /## (MEM-[^\n]+)\n([\s\S]*?)(?=## MEM-|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];

    // Parse metadata
    const typeMatch = body.match(/type:\s*(\w+)/);
    const heatMatch = body.match(/heat:\s*(\d+)/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]+)\]/);

    entries.push({
      id,
      type: typeMatch ? typeMatch[1] : 'unknown',
      heat: heatMatch ? parseInt(heatMatch[1]) : 50,
      tags: tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [],
      content: body.trim()
    });
  }

  return entries;
}

function loadMemories() {
  const result = {
    today: { file: null, entries: [] },
    yesterday: { file: null, entries: [] },
    highHeat: []
  };

  // Check today's memory
  const todayFile = path.join(memoryDir, `${getToday()}.md`);
  if (fs.existsSync(todayFile)) {
    result.today.file = todayFile;
    result.today.entries = parseMemoryEntries(fs.readFileSync(todayFile, 'utf8'));
  }

  // Check yesterday's memory
  const yesterdayFile = path.join(memoryDir, `${getYesterday()}.md`);
  if (fs.existsSync(yesterdayFile)) {
    result.yesterday.file = yesterdayFile;
    result.yesterday.entries = parseMemoryEntries(fs.readFileSync(yesterdayFile, 'utf8'));
  }

  // Check MEMORY.md for high-heat entries
  if (fs.existsSync(memoryFile)) {
    const diskEntries = parseMemoryEntries(fs.readFileSync(memoryFile, 'utf8'));
    result.highHeat = diskEntries.filter(e => e.heat > 70);
  }

  // Generate summary
  const summary = {
    status: 'loaded',
    today_count: result.today.entries.length,
    yesterday_count: result.yesterday.entries.length,
    high_heat_count: result.highHeat.length,
    memories_to_inject: []
  };

  // Collect memories to inject
  // Yesterday's important decisions and todos
  const yesterdayImportant = result.yesterday.entries.filter(e =>
    e.type === 'decision' || e.type === 'todo' || e.heat > 80
  );

  // High heat from disk
  const diskHighHeat = result.highHeat.slice(0, 5); // Top 5

  if (yesterdayImportant.length > 0) {
    summary.memories_to_inject.push({
      source: 'yesterday',
      entries: yesterdayImportant.map(e => ({
        id: e.id,
        type: e.type,
        preview: e.content.split('\n').slice(0, 3).join('\n').substring(0, 200)
      }))
    });
  }

  if (diskHighHeat.length > 0) {
    summary.memories_to_inject.push({
      source: 'disk_high_heat',
      entries: diskHighHeat.map(e => ({
        id: e.id,
        type: e.type,
        heat: e.heat,
        preview: e.content.split('\n').slice(0, 3).join('\n').substring(0, 200)
      }))
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

loadMemories();
