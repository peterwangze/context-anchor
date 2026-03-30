#!/usr/bin/env node

const { resolveOwnership } = require('./lib/host-config');
const { runErrorCapture } = require('./error-capture');

function normalizeErrorEntry(raw = {}, index = 0) {
  if (!raw || typeof raw !== 'object') {
    return {
      valid: false,
      reason: 'invalid_error_payload',
      index
    };
  }

  const summary = String(raw.summary || '').trim();
  if (!summary) {
    return {
      valid: false,
      reason: 'summary_required',
      index,
      error_id: raw.error_id || raw.id || null
    };
  }

  return {
    valid: true,
    index,
    error_id: raw.error_id || raw.id || null,
    type: String(raw.type || 'general').trim() || 'general',
    summary,
    details: raw.details || '',
    solution: raw.solution || '',
    heat: raw.heat,
    source: raw.source || null,
    tags: Array.isArray(raw.tags) ? raw.tags : []
  };
}

function runRuntimeErrorSync(workspaceArg, sessionKeyArg, errors = [], options = {}) {
  const ownership = resolveOwnership(undefined, {
    workspace: workspaceArg,
    sessionKey: sessionKeyArg,
    projectId: options.projectId,
    userId: options.userId
  });
  const normalizedErrors = (Array.isArray(errors) ? errors : []).map((entry, index) => normalizeErrorEntry(entry, index));
  const ignored = [];
  const captured = [];

  normalizedErrors.forEach((entry) => {
    if (!entry.valid) {
      ignored.push({
        index: entry.index,
        reason: entry.reason,
        error_id: entry.error_id || null
      });
      return;
    }

    captured.push(
      runErrorCapture(
        ownership.workspace || workspaceArg,
        sessionKeyArg,
        entry.type,
        entry.summary,
        entry.details,
        entry.solution,
        {
          entryId: entry.error_id || undefined,
          dedupeKey: entry.error_id || undefined,
          heat: entry.heat,
          tags: entry.tags,
          source: entry.source || options.source || 'runtime-error-sync',
          projectId: ownership.projectId,
          userId: ownership.userId
        }
      )
    );
  });

  return {
    status: 'synced',
    workspace: ownership.workspace || workspaceArg,
    session_key: sessionKeyArg,
    project_id: ownership.projectId,
    user_id: ownership.userId,
    captured,
    ignored,
    ignored_errors: ignored.length
  };
}

function main() {
  const result = runRuntimeErrorSync(process.argv[2], process.argv[3], []);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeErrorEntry,
  runRuntimeErrorSync
};
