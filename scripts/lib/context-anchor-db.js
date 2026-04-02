const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let sqliteRuntime = null;
const initializedDbFiles = new Set();
const SQLITE_BUSY_TIMEOUT_MS = 10000;

const BLOB_FIELDS = ['summary', 'content', 'details', 'solution', 'raw_context'];
const BLOB_STORAGE_LIMITS = {
  active: {
    summary: 240,
    content: 240,
    details: 240,
    solution: 240,
    raw_context: 240
  },
  archive: {
    summary: 120,
    content: 120,
    details: 80,
    solution: 80,
    raw_context: 80
  }
};

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS catalog_collections (
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    source TEXT NOT NULL,
    collection_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    item_count INTEGER NOT NULL DEFAULT 0,
    json_mtime_ms INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL,
    PRIMARY KEY (scope, owner_id, source)
  );
  CREATE TABLE IF NOT EXISTS catalog_items (
    item_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    source TEXT NOT NULL,
    collection_type TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    item_type TEXT,
    heat REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    validation_status TEXT,
    access_count REAL NOT NULL DEFAULT 0,
    last_accessed TEXT,
    created_at TEXT,
    search_text TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_items_collection
    ON catalog_items (scope, owner_id, source, archived, heat DESC, sort_order ASC);
  CREATE INDEX IF NOT EXISTS idx_catalog_items_access
    ON catalog_items (scope, owner_id, source, last_accessed DESC);
  CREATE TABLE IF NOT EXISTS catalog_documents (
    doc_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    json_mtime_ms INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_documents_scope
    ON catalog_documents (scope, doc_type, owner_id);
  CREATE TABLE IF NOT EXISTS content_blobs (
    item_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    source TEXT NOT NULL,
    field_name TEXT NOT NULL,
    encoding TEXT NOT NULL,
    blob_text TEXT NOT NULL,
    original_bytes INTEGER NOT NULL DEFAULT 0,
    stored_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_key, field_name)
  );
  CREATE INDEX IF NOT EXISTS idx_content_blobs_collection
    ON content_blobs (scope, owner_id, source);
  CREATE TABLE IF NOT EXISTS governance_runs (
    run_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    session_key TEXT,
    project_id TEXT,
    user_id TEXT,
    reason TEXT,
    mode TEXT NOT NULL,
    prune_archive INTEGER NOT NULL DEFAULT 0,
    applied INTEGER NOT NULL DEFAULT 0,
    governed_at TEXT NOT NULL,
    active_before INTEGER NOT NULL DEFAULT 0,
    archive_before INTEGER NOT NULL DEFAULT 0,
    active_after INTEGER NOT NULL DEFAULT 0,
    archive_after INTEGER NOT NULL DEFAULT 0,
    deduped INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    restored INTEGER NOT NULL DEFAULT 0,
    pruned INTEGER NOT NULL DEFAULT 0,
    bytes_before INTEGER NOT NULL DEFAULT 0,
    bytes_after INTEGER NOT NULL DEFAULT 0,
    collections_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_governance_runs_context
    ON governance_runs (workspace, project_id, user_id, governed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_governance_runs_session
    ON governance_runs (workspace, session_key, governed_at DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS catalog_items_fts
    USING fts5(item_key UNINDEXED, search_text);
`;

const SEARCHABLE_SOURCES = new Set([
  'session_memories',
  'session_memories_archive',
  'session_experiences_archive',
  'project_decisions_archive',
  'project_decisions',
  'project_experiences',
  'project_experiences_archive',
  'project_facts',
  'project_facts_archive',
  'user_memories',
  'user_memories_archive',
  'user_experiences',
  'user_experiences_archive'
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function truncateUtf8Text(value, maxBytes) {
  const text = String(value || '');
  if (!maxBytes || utf8Bytes(text) <= maxBytes) {
    return text;
  }

  let next = '';
  for (const chunk of text) {
    if (utf8Bytes(`${next}${chunk}...`) > maxBytes) {
      break;
    }
    next += chunk;
  }

  return `${next}...`;
}

function isArchiveSource(source = '') {
  return /_archive$/u.test(String(source));
}

function decodeBlobValue(blob = {}) {
  if (!blob || typeof blob.blob_text !== 'string') {
    return null;
  }

  if (blob.encoding === 'gzip-base64') {
    return zlib.gunzipSync(Buffer.from(blob.blob_text, 'base64')).toString('utf8');
  }

  return blob.blob_text;
}

function getSqliteRuntime() {
  if (sqliteRuntime !== null) {
    return sqliteRuntime;
  }

  try {
    const shouldShowWarning = process.env.CONTEXT_ANCHOR_SHOW_SQLITE_WARNING === '1';
    if (shouldShowWarning) {
      sqliteRuntime = require('node:sqlite');
      return sqliteRuntime;
    }

    const originalEmitWarning = process.emitWarning;
    process.emitWarning = function patchedEmitWarning(warning, ...args) {
      const warningName =
        typeof warning === 'string' ? (typeof args[0] === 'string' ? args[0] : '') : warning?.name || '';
      const warningMessage = typeof warning === 'string' ? warning : warning?.message || '';
      const isSqliteExperimentalWarning =
        warningName === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(warningMessage);

      if (isSqliteExperimentalWarning) {
        return;
      }

      return originalEmitWarning.call(this, warning, ...args);
    };

    try {
      sqliteRuntime = require('node:sqlite');
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  } catch {
    sqliteRuntime = false;
  }

  return sqliteRuntime;
}

function isDbEnabled() {
  return process.env.CONTEXT_ANCHOR_DISABLE_DB !== '1' && Boolean(getSqliteRuntime());
}

function normalizeMtime(file) {
  if (!fs.existsSync(file)) {
    return 0;
  }

  return Math.trunc(fs.statSync(file).mtimeMs || 0);
}

function splitPath(file) {
  return path.resolve(file).split(path.sep).filter(Boolean);
}

function rebuildPath(parts, extraParts = []) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return path.join(...extraParts);
  }

  if (/^[a-z]:$/i.test(parts[0])) {
    return path.join(`${parts[0]}${path.sep}`, ...parts.slice(1), ...extraParts);
  }

  return path.join(path.sep, ...parts, ...extraParts);
}

function buildWorkspaceDbFile(parts, anchorIndex) {
  return rebuildPath(parts.slice(0, anchorIndex + 1), ['catalog.sqlite']);
}

function buildUserDbFile(parts, usersIndex) {
  return rebuildPath(parts.slice(0, usersIndex + 1), ['catalog.sqlite']);
}

function describeCollectionFile(file, key) {
  const parts = splitPath(file);
  const normalized = parts.map((entry) => entry.toLowerCase());
  const fileName = normalized[normalized.length - 1];
  const parent = normalized[normalized.length - 2] || null;
  const anchorIndex = normalized.lastIndexOf('.context-anchor');

  if (anchorIndex >= 0 && fileName === '_index.json' && normalized[anchorIndex + 1] === 'sessions' && key === 'sessions') {
    return {
      dbFile: buildWorkspaceDbFile(parts, anchorIndex),
      scope: 'workspace',
      ownerId: 'workspace',
      source: 'session_index',
      collectionType: 'session_index',
      filePath: path.resolve(file)
    };
  }

  if (anchorIndex >= 0 && normalized[anchorIndex + 1] === 'sessions' && parts.length > anchorIndex + 3) {
    const ownerId = parts[anchorIndex + 2];
    const dbFile = buildWorkspaceDbFile(parts, anchorIndex);
    const inArchive = normalized[anchorIndex + 3] === 'archives';

    if (!inArchive && fileName === 'memory-hot.json' && key === 'entries') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_memories',
        collectionType: 'memory',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'memory-hot.json' && key === 'entries') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_memories_archive',
        collectionType: 'memory',
        filePath: path.resolve(file)
      };
    }

    if (!inArchive && fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_experiences',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_experiences_archive',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'index.json' && parent === 'skills' && key === 'skills') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_skills',
        collectionType: 'skill',
        filePath: path.resolve(file)
      };
    }
  }

  if (anchorIndex >= 0 && normalized[anchorIndex + 1] === 'projects' && parts.length > anchorIndex + 3) {
    const ownerId = parts[anchorIndex + 2];
    const dbFile = buildWorkspaceDbFile(parts, anchorIndex);
    const inArchive = normalized[anchorIndex + 3] === 'archives';

    if (!inArchive && fileName === 'decisions.json' && key === 'decisions') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_decisions',
        collectionType: 'decision',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'decisions.json' && key === 'decisions') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_decisions_archive',
        collectionType: 'decision',
        filePath: path.resolve(file)
      };
    }

    if (!inArchive && fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_experiences',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_experiences_archive',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (!inArchive && fileName === 'facts.json' && key === 'facts') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_facts',
        collectionType: 'fact',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'facts.json' && key === 'facts') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_facts_archive',
        collectionType: 'fact',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'index.json' && parent === 'skills' && key === 'skills') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_skills',
        collectionType: 'skill',
        filePath: path.resolve(file)
      };
    }
  }

  const usersIndex = normalized.lastIndexOf('users');
  if (usersIndex >= 0 && parts.length > usersIndex + 2) {
    const ownerId = parts[usersIndex + 1];
    const dbFile = buildUserDbFile(parts, usersIndex);
    const inArchive = normalized[usersIndex + 2] === 'archives';

    if (!inArchive && fileName === 'memories.json' && key === 'memories') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_memories',
        collectionType: 'memory',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'memories.json' && key === 'memories') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_memories_archive',
        collectionType: 'memory',
        filePath: path.resolve(file)
      };
    }

    if (!inArchive && fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_experiences',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (inArchive && fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_experiences_archive',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'index.json' && parent === 'skills' && key === 'skills') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_skills',
        collectionType: 'skill',
        filePath: path.resolve(file)
      };
    }
  }

  return null;
}

function describeDocumentFile(file) {
  const parts = splitPath(file);
  const normalized = parts.map((entry) => entry.toLowerCase());
  const fileName = normalized[normalized.length - 1];
  const parent = normalized[normalized.length - 2] || null;
  const anchorIndex = normalized.lastIndexOf('.context-anchor');
  const usersIndex = normalized.lastIndexOf('users');

  if (anchorIndex >= 0) {
    const dbFile = buildWorkspaceDbFile(parts, anchorIndex);

    if (fileName === 'index.json' && parent === '.context-anchor') {
      return {
        dbFile,
        scope: 'workspace',
        ownerId: 'workspace',
        docType: 'workspace_index',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'state.json' && normalized[anchorIndex + 1] === 'sessions' && parts.length > anchorIndex + 3) {
      return {
        dbFile,
        scope: 'session',
        ownerId: parts[anchorIndex + 2],
        docType: 'session_state',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'runtime-state.json' && normalized[anchorIndex + 1] === 'sessions' && parts.length > anchorIndex + 3) {
      return {
        dbFile,
        scope: 'session',
        ownerId: parts[anchorIndex + 2],
        docType: 'session_runtime_state',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'compact-packet.json' && normalized[anchorIndex + 1] === 'sessions' && parts.length > anchorIndex + 3) {
      return {
        dbFile,
        scope: 'session',
        ownerId: parts[anchorIndex + 2],
        docType: 'session_compact_packet',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'session-summary.json' && normalized[anchorIndex + 1] === 'sessions' && parts.length > anchorIndex + 3) {
      return {
        dbFile,
        scope: 'session',
        ownerId: parts[anchorIndex + 2],
        docType: 'session_summary',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'state.json' && normalized[anchorIndex + 1] === 'projects' && parts.length > anchorIndex + 3) {
      return {
        dbFile,
        scope: 'project',
        ownerId: parts[anchorIndex + 2],
        docType: parts[anchorIndex + 2] === '_global' ? 'global_state' : 'project_state',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'heat-index.json' && normalized[anchorIndex + 1] === 'projects' && parts.length > anchorIndex + 3) {
      return {
        dbFile,
        scope: 'project',
        ownerId: parts[anchorIndex + 2],
        docType: 'project_heat_index',
        filePath: path.resolve(file)
      };
    }
  }

  if (usersIndex >= 0 && parts.length > usersIndex + 2) {
    const dbFile = buildUserDbFile(parts, usersIndex);
    const ownerId = parts[usersIndex + 1];

    if (fileName === 'state.json') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        docType: 'user_state',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'heat-index.json') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        docType: 'user_heat_index',
        filePath: path.resolve(file)
      };
    }
  }

  return null;
}

function openDatabase(dbFile) {
  if (!isDbEnabled()) {
    return null;
  }

  const resolvedDbFile = path.resolve(dbFile);
  const existedBeforeOpen = fs.existsSync(resolvedDbFile);
  ensureDir(path.dirname(dbFile));
  const runtime = getSqliteRuntime();
  const db = new runtime.DatabaseSync(dbFile);
  db.exec(`
    PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
  if (!existedBeforeOpen || !initializedDbFiles.has(resolvedDbFile)) {
    db.exec(SCHEMA_SQL);
    initializedDbFiles.add(resolvedDbFile);
  }
  return db;
}

function recordGovernanceRun(dbFile, run = {}) {
  if (!isDbEnabled()) {
    return false;
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return false;
  }

  try {
    db.prepare(
      `
        INSERT INTO governance_runs (
          run_id, workspace, session_key, project_id, user_id, reason, mode, prune_archive, applied,
          governed_at, active_before, archive_before, active_after, archive_after, deduped, archived,
          restored, pruned, bytes_before, bytes_after, collections_json
        ) VALUES (
          @run_id, @workspace, @session_key, @project_id, @user_id, @reason, @mode, @prune_archive, @applied,
          @governed_at, @active_before, @archive_before, @active_after, @archive_after, @deduped, @archived,
          @restored, @pruned, @bytes_before, @bytes_after, @collections_json
        )
      `
    ).run({
      run_id: run.run_id,
      workspace: run.workspace || null,
      session_key: run.session_key || null,
      project_id: run.project_id || null,
      user_id: run.user_id || null,
      reason: run.reason || null,
      mode: run.mode || 'enforce',
      prune_archive: run.prune_archive ? 1 : 0,
      applied: run.applied ? 1 : 0,
      governed_at: run.governed_at || new Date().toISOString(),
      active_before: Number(run.totals?.active_before || 0),
      archive_before: Number(run.totals?.archive_before || 0),
      active_after: Number(run.totals?.active_after || 0),
      archive_after: Number(run.totals?.archive_after || 0),
      deduped: Number(run.totals?.deduped || 0),
      archived: Number(run.totals?.archived || 0),
      restored: Number(run.totals?.restored || 0),
      pruned: Number(run.totals?.pruned || 0),
      bytes_before: Number(run.totals?.bytes_before || 0),
      bytes_after: Number(run.totals?.bytes_after || 0),
      collections_json: JSON.stringify(run.collections || [])
    });
    return true;
  } finally {
    db.close();
  }
}

function readLatestGovernanceRun(dbFile, filters = {}) {
  if (!isDbEnabled() || !dbFile || !fs.existsSync(dbFile)) {
    return null;
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return null;
  }

  try {
    const row = db.prepare(
      `
        SELECT
          run_id,
          workspace,
          session_key,
          project_id,
          user_id,
          reason,
          mode,
          prune_archive,
          applied,
          governed_at,
          active_before,
          archive_before,
          active_after,
          archive_after,
          deduped,
          archived,
          restored,
          pruned,
          bytes_before,
          bytes_after,
          collections_json
        FROM governance_runs
        WHERE workspace = @workspace
          AND (@project_id IS NULL OR project_id = @project_id)
          AND (@user_id IS NULL OR user_id = @user_id)
        ORDER BY
          CASE WHEN @session_key IS NOT NULL AND session_key = @session_key THEN 0 ELSE 1 END,
          governed_at DESC
        LIMIT 1
      `
    ).get({
      workspace: filters.workspace || null,
      project_id: filters.project_id || null,
      user_id: filters.user_id || null,
      session_key: filters.session_key || null
    });

    if (!row) {
      return null;
    }

    return {
      run_id: row.run_id,
      workspace: row.workspace,
      session_key: row.session_key,
      project_id: row.project_id,
      user_id: row.user_id,
      reason: row.reason,
      mode: row.mode,
      prune_archive: Boolean(row.prune_archive),
      applied: Boolean(row.applied),
      governed_at: row.governed_at,
      totals: {
        active_before: Number(row.active_before || 0),
        archive_before: Number(row.archive_before || 0),
        active_after: Number(row.active_after || 0),
        archive_after: Number(row.archive_after || 0),
        deduped: Number(row.deduped || 0),
        archived: Number(row.archived || 0),
        restored: Number(row.restored || 0),
        pruned: Number(row.pruned || 0),
        bytes_before: Number(row.bytes_before || 0),
        bytes_after: Number(row.bytes_after || 0)
      },
      collections: JSON.parse(row.collections_json || '[]')
    };
  } finally {
    db.close();
  }
}

function buildItemId(item = {}, descriptor, index) {
  return String(
    item.id ||
      item.session_key ||
      item.key ||
      item.name ||
      `${descriptor.source}-${descriptor.ownerId}-${index}`
  );
}

function buildSearchText(item = {}, descriptor) {
  const parts = [
    item.summary,
    item.content,
    item.decision,
    item.rationale,
    item.details,
    item.solution,
    item.name,
    item.notes,
    item.source,
    item.type,
    item.session_key,
    item.project_id,
    item.user_id,
    descriptor.source,
    descriptor.scope,
    ...(Array.isArray(item.tags) ? item.tags : [])
  ];

  return parts
    .filter(Boolean)
    .map((entry) => String(entry).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

function buildBlobEntries(descriptor, itemKey, item = {}) {
  const storedItem = { ...item };
  const blobFields = [];
  const blobRows = [];
  const limits = isArchiveSource(descriptor.source) || Boolean(item.archived)
    ? BLOB_STORAGE_LIMITS.archive
    : BLOB_STORAGE_LIMITS.active;

  BLOB_FIELDS.forEach((fieldName) => {
    const value = storedItem[fieldName];
    if (typeof value !== 'string' || !value) {
      return;
    }

    const inlineLimit = Number(limits[fieldName] || limits.details || 0);
    if (!inlineLimit || utf8Bytes(value) <= inlineLimit) {
      return;
    }

    const shouldCompress = isArchiveSource(descriptor.source) || Boolean(item.archived) || utf8Bytes(value) > 512;
    const encodedText = shouldCompress
      ? zlib.gzipSync(Buffer.from(value, 'utf8')).toString('base64')
      : value;

    blobFields.push(fieldName);
    if (fieldName === 'summary') {
      storedItem.summary = truncateUtf8Text(value, inlineLimit);
    } else if (fieldName === 'content' && !storedItem.summary) {
      storedItem.content = truncateUtf8Text(value, inlineLimit);
    } else {
      storedItem[fieldName] = null;
    }

    blobRows.push({
      item_key: itemKey,
      scope: descriptor.scope,
      owner_id: descriptor.ownerId,
      source: descriptor.source,
      field_name: fieldName,
      encoding: shouldCompress ? 'gzip-base64' : 'plain',
      blob_text: encodedText,
      original_bytes: utf8Bytes(value),
      stored_bytes: shouldCompress ? Buffer.byteLength(encodedText, 'utf8') : utf8Bytes(value)
    });
  });

  if (blobFields.length > 0) {
    storedItem.blob_fields = blobFields;
  } else {
    delete storedItem.blob_fields;
  }

  return {
    storedItem,
    blobRows
  };
}

function hydrateRowPayloads(db, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows;
  }

  const itemKeys = rows.map((row) => row.item_key).filter(Boolean);
  if (itemKeys.length === 0) {
    return rows;
  }

  const placeholders = itemKeys.map(() => '?').join(', ');
  const blobRows = db.prepare(
    `
      SELECT item_key, field_name, encoding, blob_text
      FROM content_blobs
      WHERE item_key IN (${placeholders})
    `
  ).all(...itemKeys);

  const blobsByKey = new Map();
  blobRows.forEach((blob) => {
    if (!blobsByKey.has(blob.item_key)) {
      blobsByKey.set(blob.item_key, new Map());
    }
    blobsByKey.get(blob.item_key).set(blob.field_name, decodeBlobValue(blob));
  });

  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json);
    const blobFields = Array.isArray(payload.blob_fields) ? payload.blob_fields : [];
    const fieldMap = blobsByKey.get(row.item_key);

    blobFields.forEach((fieldName) => {
      if (fieldMap && fieldMap.has(fieldName)) {
        payload[fieldName] = fieldMap.get(fieldName);
      }
    });
    delete payload.blob_fields;

    return {
      ...row,
      payload_json: JSON.stringify(payload)
    };
  });
}

function toRow(descriptor, item, index) {
  const itemId = buildItemId(item, descriptor, index);
  const itemKey = `${descriptor.scope}:${descriptor.ownerId}:${descriptor.source}:${itemId}`;
  const searchText = buildSearchText(item, descriptor);
  const prepared = buildBlobEntries(descriptor, itemKey, item);

  return {
    item_key: itemKey,
    scope: descriptor.scope,
    owner_id: descriptor.ownerId,
    source: descriptor.source,
    collection_type: descriptor.collectionType,
    sort_order: index,
    item_id: itemId,
    item_type: item.type || descriptor.collectionType,
    heat: Number(item.heat || 0),
    archived: item.archived ? 1 : 0,
    status: item.status || null,
    validation_status: item.validation?.status || item.validation_status || null,
    access_count: Number(item.access_count || item.applied_count || 0),
    last_accessed: item.last_accessed || item.last_active || item.updated_at || item.created_at || null,
    created_at: item.created_at || null,
    search_text: searchText,
    file_path: descriptor.filePath,
    payload_json: JSON.stringify(prepared.storedItem),
    blob_rows: prepared.blobRows
  };
}

function syncDocumentMirror(file, data) {
  const descriptor = describeDocumentFile(file);
  if (!descriptor || !isDbEnabled()) {
    return false;
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return false;
  }

  try {
    db.prepare(
      `
        INSERT INTO catalog_documents (
          doc_key, scope, owner_id, doc_type, file_path, json_mtime_ms, last_synced_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_key) DO UPDATE SET
          scope = excluded.scope,
          owner_id = excluded.owner_id,
          doc_type = excluded.doc_type,
          file_path = excluded.file_path,
          json_mtime_ms = excluded.json_mtime_ms,
          last_synced_at = excluded.last_synced_at,
          payload_json = excluded.payload_json
      `
    ).run(
      `${descriptor.scope}:${descriptor.ownerId}:${descriptor.docType}`,
      descriptor.scope,
      descriptor.ownerId,
      descriptor.docType,
      descriptor.filePath,
      normalizeMtime(descriptor.filePath),
      new Date().toISOString(),
      JSON.stringify(data)
    );
    return true;
  } finally {
    db.close();
  }
}

function readMirrorDocument(file) {
  const descriptor = describeDocumentFile(file);
  if (!descriptor || !isDbEnabled() || !fs.existsSync(descriptor.dbFile)) {
    return {
      status: 'missing',
      data: null
    };
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return {
      status: 'missing',
      data: null
    };
  }

  try {
    const row = db.prepare(
      `
        SELECT json_mtime_ms, payload_json
        FROM catalog_documents
        WHERE doc_key = ?
      `
    ).get(`${descriptor.scope}:${descriptor.ownerId}:${descriptor.docType}`);

    if (!row) {
      return {
        status: 'missing',
        data: null
      };
    }

    if (Number(row.json_mtime_ms || 0) !== normalizeMtime(descriptor.filePath)) {
      return {
        status: 'stale',
        data: null
      };
    }

    return {
      status: 'available',
      data: JSON.parse(row.payload_json)
    };
  } finally {
    db.close();
  }
}

function syncCollectionMirror(file, key, items) {
  const descriptor = describeCollectionFile(file, key);
  if (!descriptor || !isDbEnabled()) {
    return false;
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return false;
  }

  const existingRows = db
    .prepare(
      `
        SELECT item_key
        FROM catalog_items
        WHERE scope = ? AND owner_id = ? AND source = ?
      `
    )
    .all(descriptor.scope, descriptor.ownerId, descriptor.source);
  const removeFts = db.prepare('DELETE FROM catalog_items_fts WHERE item_key = ?');
  const removeItems = db.prepare(
    `
      DELETE FROM catalog_items
      WHERE scope = ? AND owner_id = ? AND source = ?
    `
  );
  const removeBlobs = db.prepare(
    `
      DELETE FROM content_blobs
      WHERE scope = ? AND owner_id = ? AND source = ?
    `
  );
  const upsertCollection = db.prepare(
    `
      INSERT INTO catalog_collections (
        scope, owner_id, source, collection_type, file_path, item_count, json_mtime_ms, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, owner_id, source) DO UPDATE SET
        collection_type = excluded.collection_type,
        file_path = excluded.file_path,
        item_count = excluded.item_count,
        json_mtime_ms = excluded.json_mtime_ms,
        last_synced_at = excluded.last_synced_at
    `
  );
  const insertItem = db.prepare(
    `
      INSERT INTO catalog_items (
        item_key, scope, owner_id, source, collection_type, sort_order, item_id, item_type,
        heat, archived, status, validation_status, access_count, last_accessed, created_at,
        search_text, file_path, payload_json
      ) VALUES (
        @item_key, @scope, @owner_id, @source, @collection_type, @sort_order, @item_id, @item_type,
        @heat, @archived, @status, @validation_status, @access_count, @last_accessed, @created_at,
        @search_text, @file_path, @payload_json
      )
    `
  );
  const insertFts = db.prepare(
    `
      INSERT INTO catalog_items_fts (item_key, search_text)
      VALUES (?, ?)
    `
  );
  const insertBlob = db.prepare(
    `
      INSERT INTO content_blobs (
        item_key, scope, owner_id, source, field_name, encoding, blob_text, original_bytes, stored_bytes
      ) VALUES (
        @item_key, @scope, @owner_id, @source, @field_name, @encoding, @blob_text, @original_bytes, @stored_bytes
      )
    `
  );

  db.exec('BEGIN');
  try {
    existingRows.forEach((row) => {
      removeFts.run(row.item_key);
    });
    removeItems.run(descriptor.scope, descriptor.ownerId, descriptor.source);
    removeBlobs.run(descriptor.scope, descriptor.ownerId, descriptor.source);

    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const row = toRow(descriptor, item, index);
      const { blob_rows: blobRows, ...itemRow } = row;
      insertItem.run(itemRow);
      if (SEARCHABLE_SOURCES.has(descriptor.source) && row.search_text) {
        insertFts.run(row.item_key, row.search_text);
      }
      (blobRows || []).forEach((blobRow) => {
        insertBlob.run(blobRow);
      });
    });

    upsertCollection.run(
      descriptor.scope,
      descriptor.ownerId,
      descriptor.source,
      descriptor.collectionType,
      descriptor.filePath,
      Array.isArray(items) ? items.length : 0,
      normalizeMtime(descriptor.filePath),
      new Date().toISOString()
    );
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    return false;
  } finally {
    db.close();
  }
}

function readMirrorCollection(file, key) {
  const descriptor = describeCollectionFile(file, key);
  if (!descriptor || !isDbEnabled() || !fs.existsSync(descriptor.dbFile)) {
    return {
      status: 'missing',
      items: null
    };
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return {
      status: 'missing',
      items: null
    };
  }

  try {
    const collection = db
      .prepare(
        `
          SELECT item_count, json_mtime_ms
          FROM catalog_collections
          WHERE scope = ? AND owner_id = ? AND source = ?
        `
      )
      .get(descriptor.scope, descriptor.ownerId, descriptor.source);

    if (!collection) {
      return {
        status: 'missing',
        items: null
      };
    }

    if (Number(collection.json_mtime_ms || 0) !== normalizeMtime(descriptor.filePath)) {
      return {
        status: 'stale',
        items: null
      };
    }

    const rows = db
      .prepare(
        `
          SELECT item_key, payload_json
          FROM catalog_items
          WHERE scope = ? AND owner_id = ? AND source = ?
          ORDER BY sort_order ASC
        `
      )
      .all(descriptor.scope, descriptor.ownerId, descriptor.source);
    const hydratedRows = hydrateRowPayloads(db, rows);

    return {
      status: 'available',
      items: hydratedRows.map((row) => JSON.parse(row.payload_json))
    };
  } finally {
    db.close();
  }
}

function readMirrorCollectionCount(file, key) {
  const descriptor = describeCollectionFile(file, key);
  if (!descriptor || !isDbEnabled() || !fs.existsSync(descriptor.dbFile)) {
    return {
      status: 'missing',
      count: null
    };
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return {
      status: 'missing',
      count: null
    };
  }

  try {
    const collection = db
      .prepare(
        `
          SELECT item_count, json_mtime_ms
          FROM catalog_collections
          WHERE scope = ? AND owner_id = ? AND source = ?
        `
      )
      .get(descriptor.scope, descriptor.ownerId, descriptor.source);

    if (!collection) {
      return {
        status: 'missing',
        count: null
      };
    }

    if (Number(collection.json_mtime_ms || 0) !== normalizeMtime(descriptor.filePath)) {
      return {
        status: 'stale',
        count: null
      };
    }

    return {
      status: 'available',
      count: Number(collection.item_count || 0)
    };
  } finally {
    db.close();
  }
}

function loadRankedMirrorCollection(file, key, options = {}) {
  const descriptor = describeCollectionFile(file, key);
  if (!descriptor || !isDbEnabled() || !fs.existsSync(descriptor.dbFile)) {
    return null;
  }

  const mirror = readMirrorCollection(file, key);
  if (mirror.status !== 'available') {
    return null;
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return null;
  }

  try {
    const limit = Number(options.limit || 0);
    const includeArchived = Boolean(options.includeArchived);
    const minHeat = options.minHeat === undefined ? null : Number(options.minHeat);
    let sql = `
      SELECT payload_json
      FROM catalog_items
      WHERE scope = ? AND owner_id = ? AND source = ?
    `;
    const parameters = [descriptor.scope, descriptor.ownerId, descriptor.source];

    if (!includeArchived) {
      sql += ' AND archived = 0';
    }
    if (minHeat !== null) {
      sql += ' AND heat >= ?';
      parameters.push(minHeat);
    }

    sql += ' ORDER BY heat DESC, access_count DESC, sort_order ASC';
    if (limit > 0) {
      sql += ' LIMIT ?';
      parameters.push(limit);
    }

    const rows = db.prepare(sql.replace('SELECT payload_json', 'SELECT item_key, payload_json')).all(...parameters);
    return hydrateRowPayloads(db, rows).map((row) => JSON.parse(row.payload_json));
  } finally {
    db.close();
  }
}

function loadRecentSessionIndexEntries(file, windowMs, options = {}) {
  const descriptor = describeCollectionFile(file, 'sessions');
  if (!descriptor || descriptor.source !== 'session_index' || !isDbEnabled() || !fs.existsSync(descriptor.dbFile)) {
    return null;
  }

  const mirror = readMirrorCollection(file, 'sessions');
  if (mirror.status !== 'available') {
    return null;
  }

  const db = openDatabase(descriptor.dbFile);
  if (!db) {
    return null;
  }

  try {
    const sinceIso = new Date(Date.now() - Number(windowMs || 0)).toISOString();
    const limit = Number(options.limit || 0);
    let sql = `
      SELECT payload_json
      FROM catalog_items
      WHERE scope = ? AND owner_id = ? AND source = ? AND archived = 0
        AND last_accessed >= ?
      ORDER BY last_accessed DESC, sort_order ASC
    `;
    const parameters = [descriptor.scope, descriptor.ownerId, descriptor.source, sinceIso];

    if (limit > 0) {
      sql += ' LIMIT ?';
      parameters.push(limit);
    }

    return db.prepare(sql).all(...parameters).map((row) => JSON.parse(row.payload_json));
  } finally {
    db.close();
  }
}

function readContentBlobRows(dbFile, filters = {}) {
  if (!isDbEnabled() || !dbFile || !fs.existsSync(dbFile)) {
    return [];
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return [];
  }

  try {
    return db.prepare(
      `
        SELECT item_key, scope, owner_id, source, field_name, encoding, original_bytes, stored_bytes
        FROM content_blobs
        WHERE (@source IS NULL OR source = @source)
          AND (@item_key IS NULL OR item_key = @item_key)
        ORDER BY item_key ASC, field_name ASC
      `
    ).all({
      source: filters.source || null,
      item_key: filters.item_key || null
    });
  } finally {
    db.close();
  }
}

function readCatalogItemRows(dbFile, filters = {}) {
  if (!isDbEnabled() || !dbFile || !fs.existsSync(dbFile)) {
    return [];
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return [];
  }

  try {
    return db.prepare(
      `
        SELECT item_key, source, payload_json
        FROM catalog_items
        WHERE (@source IS NULL OR source = @source)
          AND (@item_key IS NULL OR item_key = @item_key)
        ORDER BY item_key ASC
      `
    ).all({
      source: filters.source || null,
      item_key: filters.item_key || null
    });
  } finally {
    db.close();
  }
}

function summarizeCatalogDatabase(dbFile) {
  if (!isDbEnabled() || !dbFile || !fs.existsSync(dbFile)) {
    return {
      available: false,
      db_file: dbFile || null,
      collections: 0,
      documents: 0,
      indexed_items: 0,
      indexed_sessions: 0,
      session_states: 0,
      session_summaries: 0,
      compact_packets: 0,
      projects: 0,
      content_blobs: 0,
      content_blob_bytes: 0,
      content_blob_stored_bytes: 0
    };
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return {
      available: false,
      db_file: dbFile,
      collections: 0,
      documents: 0,
      indexed_items: 0,
      indexed_sessions: 0,
      session_states: 0,
      session_summaries: 0,
      compact_packets: 0,
      projects: 0,
      content_blobs: 0,
      content_blob_bytes: 0,
      content_blob_stored_bytes: 0
    };
  }

  try {
    const collectionSummary = db.prepare(
      `
        SELECT
          COUNT(*) AS collections,
          COALESCE(SUM(item_count), 0) AS indexed_items,
          COALESCE(MAX(CASE WHEN source = 'session_index' THEN item_count ELSE 0 END), 0) AS indexed_sessions,
          COUNT(DISTINCT CASE WHEN scope = 'project' THEN owner_id END) AS projects
        FROM catalog_collections
      `
    ).get();
    const documentSummary = db.prepare(
      `
        SELECT
          COUNT(*) AS documents,
          COALESCE(SUM(CASE WHEN doc_type = 'session_state' THEN 1 ELSE 0 END), 0) AS session_states,
          COALESCE(SUM(CASE WHEN doc_type = 'session_summary' THEN 1 ELSE 0 END), 0) AS session_summaries,
          COALESCE(SUM(CASE WHEN doc_type = 'session_compact_packet' THEN 1 ELSE 0 END), 0) AS compact_packets
        FROM catalog_documents
      `
    ).get();
    const blobSummary = db.prepare(
      `
        SELECT
          COUNT(*) AS content_blobs,
          COALESCE(SUM(original_bytes), 0) AS content_blob_bytes,
          COALESCE(SUM(stored_bytes), 0) AS content_blob_stored_bytes
        FROM content_blobs
      `
    ).get();

    return {
      available: true,
      db_file: dbFile,
      collections: Number(collectionSummary?.collections || 0),
      documents: Number(documentSummary?.documents || 0),
      indexed_items: Number(collectionSummary?.indexed_items || 0),
      indexed_sessions: Number(collectionSummary?.indexed_sessions || 0),
      session_states: Number(documentSummary?.session_states || 0),
      session_summaries: Number(documentSummary?.session_summaries || 0),
      compact_packets: Number(documentSummary?.compact_packets || 0),
      projects: Number(collectionSummary?.projects || 0),
      content_blobs: Number(blobSummary?.content_blobs || 0),
      content_blob_bytes: Number(blobSummary?.content_blob_bytes || 0),
      content_blob_stored_bytes: Number(blobSummary?.content_blob_stored_bytes || 0)
    };
  } finally {
    db.close();
  }
}

function searchCatalogItems(dbFile, filters, query, limit) {
  if (!isDbEnabled() || !fs.existsSync(dbFile) || !Array.isArray(filters) || filters.length === 0) {
    return [];
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return [];
  }

  try {
    const queryText = String(query || '').trim();
    const limitPerFilter = Math.max(1, Number(limit || 0));
    const totalLimit = limitPerFilter * filters.length;
    const predicates = [];
    const predicateParameters = [];

    filters.forEach((filter) => {
      predicates.push('(scope = ? AND owner_id = ? AND source = ? AND (? IS NULL OR archived = ?))');
      const archived = typeof filter.archived === 'boolean' ? (filter.archived ? 1 : 0) : null;
      predicateParameters.push(filter.scope, filter.ownerId, filter.source, archived, archived);
    });

    if (queryText) {
      try {
        const rows = db.prepare(
          `
            SELECT
              i.item_key,
              i.scope,
              i.owner_id,
              i.source,
              i.collection_type,
              i.item_id,
              i.item_type,
              i.heat,
              i.archived,
              i.status,
              i.validation_status,
              i.access_count,
              i.last_accessed,
              i.created_at,
              i.file_path,
              i.payload_json,
              bm25(catalog_items_fts) AS fts_rank
            FROM catalog_items_fts
            JOIN catalog_items i ON i.item_key = catalog_items_fts.item_key
            WHERE (${predicates.map((predicate) => predicate.replace(/\bscope\b/g, 'i.scope').replace(/\bowner_id\b/g, 'i.owner_id').replace(/\bsource\b/g, 'i.source').replace(/\barchived\b/g, 'i.archived')).join(' OR ')})
              AND catalog_items_fts.search_text MATCH ?
            ORDER BY bm25(catalog_items_fts), i.heat DESC, i.access_count DESC
            LIMIT ?
          `
        ).all(...predicateParameters, queryText, totalLimit);

        return hydrateRowPayloads(db, rows);
      } catch {
        const rows = db.prepare(
          `
            SELECT
              item_key,
              scope,
              owner_id,
              source,
              collection_type,
              item_id,
              item_type,
              heat,
              archived,
              status,
              validation_status,
              access_count,
              last_accessed,
              created_at,
              file_path,
              payload_json,
              0 AS fts_rank
            FROM catalog_items
            WHERE (${predicates.join(' OR ')})
              AND lower(search_text) LIKE ?
            ORDER BY heat DESC, access_count DESC, sort_order ASC
            LIMIT ?
          `
        ).all(...predicateParameters, `%${queryText.toLowerCase()}%`, totalLimit);

        return hydrateRowPayloads(db, rows);
      }
    }

    const rows = db.prepare(
      `
        SELECT
          item_key,
          scope,
          owner_id,
          source,
          collection_type,
          item_id,
          item_type,
          heat,
          archived,
          status,
          validation_status,
          access_count,
          last_accessed,
          created_at,
          file_path,
          payload_json,
          0 AS fts_rank
        FROM catalog_items
        WHERE (${predicates.join(' OR ')})
        ORDER BY heat DESC, access_count DESC, sort_order ASC
        LIMIT ?
      `
    ).all(...predicateParameters, totalLimit);

    return hydrateRowPayloads(db, rows);
  } finally {
    db.close();
  }
}

function readCatalogCollectionSummaries(dbFile, filters) {
  if (!isDbEnabled() || !fs.existsSync(dbFile) || !Array.isArray(filters) || filters.length === 0) {
    return {};
  }

  const db = openDatabase(dbFile);
  if (!db) {
    return {};
  }

  try {
    const uniqueFilters = [];
    const seen = new Set();
    filters.forEach((filter) => {
      const key = `${filter.scope}:${filter.ownerId}:${filter.source}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      uniqueFilters.push(filter);
    });

    const predicates = uniqueFilters.map(() => '(scope = ? AND owner_id = ? AND source = ?)').join(' OR ');
    const parameters = uniqueFilters.flatMap((filter) => [filter.scope, filter.ownerId, filter.source]);
    const rows = db.prepare(
      `
        SELECT scope, owner_id, source, item_count
        FROM catalog_collections
        WHERE ${predicates}
      `
    ).all(...parameters);

    return rows.reduce((acc, row) => {
      acc[row.source] = {
        scope: row.scope,
        count: Number(row.item_count || 0)
      };
      return acc;
    }, {});
  } finally {
    db.close();
  }
}

module.exports = {
  describeCollectionFile,
  describeDocumentFile,
  isDbEnabled,
  loadRankedMirrorCollection,
  loadRecentSessionIndexEntries,
  readCatalogItemRows,
  readContentBlobRows,
  readLatestGovernanceRun,
  readMirrorCollectionCount,
  readMirrorDocument,
  readMirrorCollection,
  readCatalogCollectionSummaries,
  recordGovernanceRun,
  searchCatalogItems,
  summarizeCatalogDatabase,
  syncCollectionMirror,
  syncDocumentMirror
};
