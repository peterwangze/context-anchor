const fs = require('fs');
const path = require('path');

let sqliteRuntime = null;

const SEARCHABLE_SOURCES = new Set([
  'session_memories',
  'project_decisions',
  'project_experiences',
  'project_facts',
  'user_memories',
  'user_experiences'
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

    if (fileName === 'memory-hot.json' && key === 'entries') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_memories',
        collectionType: 'memory',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'session',
        ownerId,
        source: 'session_experiences',
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

    if (fileName === 'decisions.json' && key === 'decisions') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_decisions',
        collectionType: 'decision',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_experiences',
        collectionType: 'experience',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'facts.json' && key === 'facts') {
      return {
        dbFile,
        scope: 'project',
        ownerId,
        source: 'project_facts',
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

    if (fileName === 'memories.json' && key === 'memories') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_memories',
        collectionType: 'memory',
        filePath: path.resolve(file)
      };
    }

    if (fileName === 'experiences.json' && key === 'experiences') {
      return {
        dbFile,
        scope: 'user',
        ownerId,
        source: 'user_experiences',
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

  ensureDir(path.dirname(dbFile));
  const runtime = getSqliteRuntime();
  const db = new runtime.DatabaseSync(dbFile);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
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
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_items_fts
      USING fts5(item_key UNINDEXED, search_text);
  `);
  return db;
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

function toRow(descriptor, item, index) {
  const itemId = buildItemId(item, descriptor, index);

  return {
    item_key: `${descriptor.scope}:${descriptor.ownerId}:${descriptor.source}:${itemId}`,
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
    search_text: buildSearchText(item, descriptor),
    file_path: descriptor.filePath,
    payload_json: JSON.stringify(item)
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

  db.exec('BEGIN');
  try {
    existingRows.forEach((row) => {
      removeFts.run(row.item_key);
    });
    removeItems.run(descriptor.scope, descriptor.ownerId, descriptor.source);

    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const row = toRow(descriptor, item, index);
      insertItem.run(row);
      if (SEARCHABLE_SOURCES.has(descriptor.source) && row.search_text) {
        insertFts.run(row.item_key, row.search_text);
      }
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
          SELECT payload_json
          FROM catalog_items
          WHERE scope = ? AND owner_id = ? AND source = ?
          ORDER BY sort_order ASC
        `
      )
      .all(descriptor.scope, descriptor.ownerId, descriptor.source);

    return {
      status: 'available',
      items: rows.map((row) => JSON.parse(row.payload_json))
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

    return db.prepare(sql).all(...parameters).map((row) => JSON.parse(row.payload_json));
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
    const rows = [];

    filters.forEach((filter) => {
      if (queryText) {
        try {
          rows.push(
            ...db
              .prepare(
                `
                  SELECT
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
                  WHERE i.scope = ? AND i.owner_id = ? AND i.source = ? AND i.archived = 0
                    AND catalog_items_fts.search_text MATCH ?
                  ORDER BY bm25(catalog_items_fts), i.heat DESC, i.access_count DESC
                  LIMIT ?
                `
              )
              .all(filter.scope, filter.ownerId, filter.source, queryText, limit)
          );
          return;
        } catch {
          rows.push(
            ...db
              .prepare(
                `
                  SELECT
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
                  WHERE scope = ? AND owner_id = ? AND source = ? AND archived = 0
                    AND lower(search_text) LIKE ?
                  ORDER BY heat DESC, access_count DESC, sort_order ASC
                  LIMIT ?
                `
              )
              .all(filter.scope, filter.ownerId, filter.source, `%${queryText.toLowerCase()}%`, limit)
          );
          return;
        }
      }

      rows.push(
        ...db
          .prepare(
            `
              SELECT
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
              WHERE scope = ? AND owner_id = ? AND source = ? AND archived = 0
              ORDER BY heat DESC, access_count DESC, sort_order ASC
              LIMIT ?
            `
          )
          .all(filter.scope, filter.ownerId, filter.source, limit)
      );
    });

    return rows;
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
    const query = db.prepare(
      `
        SELECT source, item_count
        FROM catalog_collections
        WHERE scope = ? AND owner_id = ? AND source = ?
      `
    );
    return filters.reduce((acc, filter) => {
      const row = query.get(filter.scope, filter.ownerId, filter.source);
      if (row) {
        acc[filter.source] = {
          scope: filter.scope,
          count: Number(row.item_count || 0)
        };
      }
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
  readMirrorCollectionCount,
  readMirrorDocument,
  readMirrorCollection,
  readCatalogCollectionSummaries,
  searchCatalogItems,
  syncCollectionMirror,
  syncDocumentMirror
};
