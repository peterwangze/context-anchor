#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { command, field, renderCliError, section, status } = require('./lib/terminal-format');

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

function readLegacyMemorySyncState(workspaceArg) {
  const paths = createPaths(workspaceArg);
  return {
    paths,
    stateFile: legacyMemorySyncStateFile(paths),
    state: readJson(legacyMemorySyncStateFile(paths), {
      files: {}
    })
  };
}

function getLatestIsoTimestamp(values = []) {
  return values
    .filter((value) => typeof value === 'string' && value.trim())
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
}

function summarizeExternalMemorySources(workspaceArg) {
  const { paths, stateFile, state } = readLegacyMemorySyncState(workspaceArg);
  const trackedFiles = state && typeof state === 'object' && state.files && typeof state.files === 'object'
    ? state.files
    : {};
  const detectedFiles = collectLegacyMemoryFiles(paths.workspace);
  const sources = detectedFiles.map((filePath) => {
    const relativeFile = path.relative(paths.workspace, filePath).replace(/\\/g, '/');
    const syncState = trackedFiles[relativeFile] || null;
    const content = fs.readFileSync(filePath, 'utf8');
    const contentHash = crypto.createHash('sha1').update(content).digest('hex');
    const syncStatus =
      !syncState
        ? 'never_synced'
        : syncState.hash === contentHash
          ? 'up_to_date'
          : 'changed_since_sync';

    return {
      file: relativeFile,
      path: filePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      sync_status: syncStatus,
      last_synced_at: syncState?.last_synced_at || null,
      tracked_hash: syncState?.hash || null,
      synced_entries: Number(syncState?.synced_entries || 0),
      mode: syncState?.mode || null
    };
  });

  const externalSourceCount = sources.length;
  const neverSyncedSourceCount = sources.filter((entry) => entry.sync_status === 'never_synced').length;
  const changedSourceCount = sources.filter((entry) => entry.sync_status === 'changed_since_sync').length;
  const syncedSourceCount = sources.filter((entry) => entry.sync_status === 'up_to_date').length;
  const unsyncedSourceCount = neverSyncedSourceCount + changedSourceCount;
  const lastLegacySyncAt = getLatestIsoTimestamp(
    Object.values(trackedFiles).map((entry) => entry?.last_synced_at || null)
  );

  return {
    workspace: paths.workspace,
    state_file: stateFile,
    canonical_source: 'context-anchor',
    total_source_count: 1 + externalSourceCount,
    external_source_count: externalSourceCount,
    tracked_source_count: Object.keys(trackedFiles).length,
    synced_source_count: syncedSourceCount,
    never_synced_source_count: neverSyncedSourceCount,
    changed_source_count: changedSourceCount,
    unsynced_source_count: unsyncedSourceCount,
    last_legacy_sync_at: lastLegacySyncAt,
    sync_status:
      externalSourceCount === 0
        ? 'no_external_sources'
        : unsyncedSourceCount > 0
          ? 'unsynced_external_sources'
          : 'centralized',
    sources
  };
}

function classifyMemorySourceHealth(summary, options = {}) {
  const takeoverMode = options.memoryTakeoverMode === 'enforced' ? 'enforced' : 'best_effort';
  const driftReasons = [];

  if (Number(summary?.never_synced_source_count || 0) > 0) {
    driftReasons.push('legacy_memory_never_synced');
  }
  if (Number(summary?.changed_source_count || 0) > 0) {
    driftReasons.push('legacy_memory_changed_since_sync');
  }

  const driftDetected = driftReasons.length > 0;
  const externalSourceCount = Number(summary?.external_source_count || 0);
  let status;
  let level;
  let summaryText;

  if (driftDetected) {
    status = 'drift_detected';
    level = 'warning';
    summaryText =
      externalSourceCount > 0
        ? `${externalSourceCount} external memory source(s) detected and ${summary.unsynced_source_count} source(s) need re-sync.`
        : 'Memory drift detected and legacy memory sources need re-sync.';
  } else if (takeoverMode === 'enforced') {
    status = 'single_source';
    level = 'ok';
    summaryText =
      externalSourceCount > 0
        ? `context-anchor is the effective canonical memory plane; ${externalSourceCount} external source(s) are currently centralized.`
        : 'context-anchor is the canonical memory plane and no external memory sources were detected.';
  } else {
    status = 'best_effort';
    level = 'notice';
    summaryText =
      externalSourceCount > 0
        ? `${externalSourceCount} external memory source(s) are currently centralized, but takeover is still best-effort.`
        : 'No external memory sources were detected, but takeover is still best-effort.';
  }

  return {
    status,
    level,
    memory_takeover_mode: takeoverMode,
    drift_detected: driftDetected,
    drift_reasons: driftReasons,
    summary: summaryText
  };
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
  try {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const filtered = args.filter((arg) => arg !== '--json');
    const result = runLegacyMemorySync(filtered[0], filtered[1], {
      projectId: filtered[2],
      reason: filtered[3],
      force: filtered[4] === 'force'
    });
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
    const kind = errorCount > 0 ? 'warning' : 'success';
    const lines = [];
    lines.push(section('Context-Anchor Legacy Memory Sync', { kind }));
    lines.push(field('Status', status(String(result.status || 'ok').toUpperCase(), kind), { kind }));
    lines.push(field('Workspace', result.workspace, { kind: 'muted' }));
    lines.push(
      field(
        'Sync result',
        `Detected ${Number(result.detected_files || 0)} | Synced files ${status(Number(result.synced_files || 0), Number(result.synced_files || 0) > 0 ? 'success' : 'info')} | Skipped ${Number(result.skipped_files || 0)} | Entries ${Number(result.synced_entries || 0)}`,
        { kind: Number(result.synced_files || 0) > 0 ? 'success' : 'info' }
      )
    );
    lines.push(field('Errors', status(errorCount, errorCount > 0 ? 'warning' : 'success'), { kind: errorCount > 0 ? 'warning' : 'success' }));
    if (result.reason) {
      lines.push(field('Reason', result.reason, { kind: 'info' }));
    }
    console.log(lines.join('\n'));
  } catch (error) {
    if (process.stdout.isTTY) {
      console.log(renderCliError('Context-Anchor Legacy Memory Sync Failed', error.message, {
        nextStep: 'Check the workspace/session/project arguments, then rerun legacy-memory-sync.'
      }));
    } else {
      console.log(JSON.stringify({ status: 'error', message: error.message }, null, 2));
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyMemorySourceHealth,
  collectLegacyMemoryFiles,
  legacyMemorySyncStateFile,
  parseLegacyEntries,
  readLegacyMemorySyncState,
  runLegacyMemorySync,
  summarizeExternalMemorySources
};
