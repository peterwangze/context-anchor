#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { createPaths, ensureAnchorDirs, readJson, resolveProjectId, writeJson } = require('./lib/context-anchor');
const { runMemorySave } = require('./memory-save');

function legacyMemorySyncStateFile(paths) {
  return path.join(paths.anchorDir, 'legacy-memory-sync.json');
}

function collectLegacyMemoryFiles(workspace) {
  const files = [];
  const memoryFile = path.join(workspace, 'MEMORY.md');
  const memoryDir = path.join(workspace, 'memory');

  if (fs.existsSync(memoryFile)) {
    files.push(memoryFile);
  }

  if (fs.existsSync(memoryDir)) {
    fs.readdirSync(memoryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .forEach((entry) => {
        files.push(path.join(memoryDir, entry.name));
      });
  }

  return files;
}

function parseLegacyEntries(content, filePath) {
  const entries = [];
  const regex = /## (MEM-[^\n]+)\n([\s\S]*?)(?=## MEM-|## TOOL-|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];
    const typeMatch = body.match(/type:\s*([^\n]+)/);
    const heatMatch = body.match(/heat:\s*(\d+)/);
    const tagsMatch = body.match(/tags:\s*\[([^\]]+)\]/);
    const lines = body.split('\n');
    const contentStart = lines.findIndex((line) => !line.match(/^(type|heat|created|tags|frozen|last_accessed):/));
    const summary = lines.slice(Math.max(contentStart, 0)).join('\n').trim();

    if (!summary) {
      continue;
    }

    entries.push({
      stable_id: id,
      type: typeMatch ? String(typeMatch[1]).trim() : 'fact',
      heat: heatMatch ? Number(heatMatch[1]) : undefined,
      tags: tagsMatch ? tagsMatch[1].split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      content: summary,
      summary
    });
  }

  if (entries.length > 0) {
    return {
      mode: 'parsed',
      entries
    };
  }

  const trimmed = String(content || '').trim();
  if (!trimmed) {
    return {
      mode: 'empty',
      entries: []
    };
  }

  return {
    mode: 'raw_file',
    entries: [
      {
        stable_id: 'full-file',
        type: 'fact',
        heat: 70,
        tags: ['legacy-memory', path.basename(filePath)],
        content: trimmed,
        summary: `Imported legacy memory file: ${path.basename(filePath)}`
      }
    ]
  };
}

function stableLegacyId(relativeFile, stableId) {
  return `legacy-${crypto.createHash('sha1').update(`${relativeFile}:${stableId}`).digest('hex').slice(0, 16)}`;
}

function runLegacyMemorySync(workspaceArg, sessionKeyArg, options = {}) {
  const paths = createPaths(workspaceArg);
  ensureAnchorDirs(paths);
  const projectId = resolveProjectId(paths.workspace, options.projectId);
  const sessionKey = sessionKeyArg || 'legacy-sync';
  const stateFile = legacyMemorySyncStateFile(paths);
  const state = readJson(stateFile, {
    files: {}
  });
  const files = collectLegacyMemoryFiles(paths.workspace);
  const result = {
    status: 'ok',
    workspace: paths.workspace,
    session_key: sessionKey,
    project_id: projectId,
    reason: options.reason || null,
    detected_files: files.length,
    synced_files: 0,
    skipped_files: 0,
    synced_entries: 0,
    files: [],
    errors: []
  };

  files.forEach((filePath) => {
    const relativeFile = path.relative(paths.workspace, filePath).replace(/\\/g, '/');
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const contentHash = crypto.createHash('sha1').update(content).digest('hex');
      if (!options.force && state.files?.[relativeFile]?.hash === contentHash) {
        result.skipped_files += 1;
        result.files.push({
          file: relativeFile,
          action: 'skipped',
          mode: state.files?.[relativeFile]?.mode || 'unknown'
        });
        return;
      }

      const parsed = parseLegacyEntries(content, filePath);
      let savedEntries = 0;

      parsed.entries.forEach((entry) => {
        runMemorySave(paths.workspace, sessionKey, 'project', entry.type, entry.content, JSON.stringify({
          project_id: projectId,
          entry_id: stableLegacyId(relativeFile, entry.stable_id),
          summary: entry.summary,
          heat: entry.heat,
          tags: ['legacy-memory-sync', ...entry.tags].filter(Boolean),
          source: 'legacy-memory-sync',
          skip_access_increment: true
        }));
        savedEntries += 1;
      });

      state.files = state.files || {};
      state.files[relativeFile] = {
        hash: contentHash,
        mode: parsed.mode,
        last_synced_at: new Date().toISOString(),
        synced_entries: savedEntries
      };
      writeJson(stateFile, state);

      result.synced_files += 1;
      result.synced_entries += savedEntries;
      result.files.push({
        file: relativeFile,
        action: 'synced',
        mode: parsed.mode,
        synced_entries: savedEntries
      });
    } catch (error) {
      result.errors.push(`${relativeFile}: ${error.message}`);
      result.files.push({
        file: relativeFile,
        action: 'error',
        message: error.message
      });
    }
  });

  return result;
}

function main() {
  const result = runLegacyMemorySync(process.argv[2], process.argv[3], {
    projectId: process.argv[4],
    reason: process.argv[5],
    force: process.argv[6] === 'force'
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  collectLegacyMemoryFiles,
  legacyMemorySyncStateFile,
  parseLegacyEntries,
  runLegacyMemorySync
};
