#!/usr/bin/env node
/**
 * Memory Migration Script
 * Migrates old format (MEMORY.md, memory/) to new format (.context-anchor/)
 *
 * Usage: node migrate-memory.js <workspace> [project-id]
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const projectId = process.argv[3] || 'default';

const anchorDir = path.join(workspace, '.context-anchor');
const projectsDir = path.join(anchorDir, 'projects');
const projectDir = path.join(projectsDir, projectId);

const oldMemoryFile = path.join(workspace, 'MEMORY.md');
const oldMemoryDir = path.join(workspace, 'memory');

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

function parseMemoryMd(content) {
  const entries = [];
  const regex = /## (MEM-[^\n]+)\n([\s\S]*?)(?=## MEM-|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];

    // Parse metadata
    const typeMatch = body.match(/type:\s*(\w+)/);
    const heatMatch = body.match(/heat:\s*(\d+)/);
    const createdMatch = body.match(/created:\s*([^\n]+)/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]+)\]/);

    // Get content (after metadata)
    const lines = body.split('\n');
    const contentStart = lines.findIndex(l => !l.match(/^(type|heat|created|tags|frozen|last_accessed):/));
    const content = lines.slice(contentStart).join('\n').trim();

    entries.push({
      id,
      type: typeMatch ? typeMatch[1] : 'fact',
      heat: heatMatch ? parseInt(heatMatch[1]) : 50,
      created_at: createdMatch ? createdMatch[1].trim() : new Date().toISOString(),
      tags: tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [],
      content: content.substring(0, 500) // Truncate for summary
    });
  }

  return entries;
}

function parseDailyMemory(content) {
  const entries = [];
  const regex = /## (MEM-[^\n]+)\n([\s\S]*?)(?=## MEM-|## TOOL-|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];

    const typeMatch = body.match(/type:\s*(\w+)/);
    const heatMatch = body.match(/heat:\s*(\d+)/);
    const createdMatch = body.match(/created:\s*([^\n]+)/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]+)\]/);

    const lines = body.split('\n');
    const contentStart = lines.findIndex(l => !l.match(/^(type|heat|created|tags):/));
    const content = lines.slice(contentStart).join('\n').trim();

    entries.push({
      id,
      type: typeMatch ? typeMatch[1] : 'fact',
      heat: heatMatch ? parseInt(heatMatch[1]) : 50,
      created_at: createdMatch ? createdMatch[1].trim() : new Date().toISOString(),
      tags: tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()) : [],
      summary: content.substring(0, 200)
    });
  }

  return entries;
}

function migrate() {
  ensureDir(projectDir);

  const result = {
    status: 'migrated',
    decisions: 0,
    experiences: 0,
    errors: []
  };

  // Migrate MEMORY.md
  if (fs.existsSync(oldMemoryFile)) {
    try {
      const content = fs.readFileSync(oldMemoryFile, 'utf8');
      const entries = parseMemoryMd(content);

      const decisions = [];
      const experiences = [];

      entries.forEach(entry => {
        if (entry.type === 'decision') {
          decisions.push({
            id: entry.id,
            decision: entry.content,
            created_at: entry.created_at,
            heat: entry.heat,
            tags: entry.tags,
            access_sessions: []
          });
        } else {
          experiences.push({
            id: entry.id,
            type: entry.type,
            summary: entry.summary || entry.content,
            created_at: entry.created_at,
            heat: entry.heat,
            tags: entry.tags,
            access_sessions: []
          });
        }
      });

      // Write decisions
      const decisionsFile = path.join(projectDir, 'decisions.json');
      const existingDecisions = readJson(decisionsFile, { decisions: [] });
      existingDecisions.decisions.push(...decisions);
      writeJson(decisionsFile, existingDecisions);
      result.decisions = decisions.length;

      // Write experiences
      const experiencesFile = path.join(projectDir, 'experiences.json');
      const existingExperiences = readJson(experiencesFile, { experiences: [] });
      existingExperiences.experiences.push(...experiences);
      writeJson(experiencesFile, existingExperiences);
      result.experiences = experiences.length;

    } catch (e) {
      result.errors.push(`MEMORY.md: ${e.message}`);
    }
  }

  // Migrate memory/YYYY-MM-DD.md
  if (fs.existsSync(oldMemoryDir)) {
    try {
      const files = fs.readdirSync(oldMemoryDir).filter(f => f.endsWith('.md'));

      files.forEach(file => {
        const filePath = path.join(oldMemoryDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const entries = parseDailyMemory(content);

        const experiencesFile = path.join(projectDir, 'experiences.json');
        const existingExperiences = readJson(experiencesFile, { experiences: [] });

        entries.forEach(entry => {
          existingExperiences.experiences.push({
            id: entry.id,
            type: entry.type,
            summary: entry.summary,
            created_at: entry.created_at,
            heat: entry.heat,
            tags: entry.tags,
            access_sessions: []
          });
          result.experiences++;
        });

        writeJson(experiencesFile, existingExperiences);
      });

    } catch (e) {
      result.errors.push(`memory/: ${e.message}`);
    }
  }

  // Update project state
  const stateFile = path.join(projectDir, 'state.json');
  const state = readJson(stateFile, { project_id: projectId });
  state.last_migrated = new Date().toISOString();
  writeJson(stateFile, state);

  console.log(JSON.stringify(result, null, 2));
}

migrate();
