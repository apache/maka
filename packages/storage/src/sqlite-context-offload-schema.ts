/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION = 3;
const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(4));

const INITIAL_SCHEMA = `
  CREATE TABLE context_blobs (
    blob_id BLOB PRIMARY KEY CHECK(length(blob_id) = 32),
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('inline', 'managed_file')),
    payload BLOB NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    CHECK(
      (storage_kind = 'inline' AND length(payload) = size_bytes) OR
      (storage_kind = 'managed_file' AND length(payload) BETWEEN 1 AND 512)
    )
  );

  CREATE TABLE context_refs (
    ref_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK(
      owner_kind IN ('read_image_snapshot', 'tool_result_archive')
    ),
    owner_id TEXT NOT NULL,
    blob_id BLOB NOT NULL REFERENCES context_blobs(blob_id) ON DELETE RESTRICT,
    media_type TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE(session_id, owner_kind, owner_id)
  );

  CREATE INDEX context_refs_session
    ON context_refs(session_id, created_at, ref_id);

  CREATE INDEX context_refs_blob
    ON context_refs(blob_id);

  CREATE TABLE context_gc_candidates (
    blob_id BLOB PRIMARY KEY
      REFERENCES context_blobs(blob_id) ON DELETE CASCADE,
    unreferenced_at INTEGER NOT NULL CHECK(unreferenced_at >= 0)
  );

  CREATE INDEX context_gc_candidates_eligible
    ON context_gc_candidates(unreferenced_at, blob_id);

  CREATE TABLE context_file_deletions (
    locator BLOB PRIMARY KEY CHECK(length(locator) BETWEEN 1 AND 512),
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    enqueued_at INTEGER NOT NULL CHECK(enqueued_at >= 0)
  );

  CREATE INDEX context_file_deletions_pending
    ON context_file_deletions(enqueued_at, locator);

  CREATE TABLE context_session_usage (
    session_id TEXT PRIMARY KEY,
    reference_count INTEGER NOT NULL CHECK(reference_count >= 0),
    logical_bytes INTEGER NOT NULL CHECK(logical_bytes >= 0)
  );

  CREATE TABLE context_store_usage (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    blob_count INTEGER NOT NULL CHECK(blob_count >= 0),
    physical_bytes INTEGER NOT NULL CHECK(physical_bytes >= 0)
  );

  INSERT INTO context_store_usage(singleton, blob_count, physical_bytes)
    VALUES (1, 0, 0);
`;

const SCHEMA_V2_MIGRATION = `
  CREATE TABLE context_gc_candidates (
    blob_id BLOB PRIMARY KEY
      REFERENCES context_blobs(blob_id) ON DELETE CASCADE,
    unreferenced_at INTEGER NOT NULL CHECK(unreferenced_at >= 0)
  );

  CREATE INDEX context_gc_candidates_eligible
    ON context_gc_candidates(unreferenced_at, blob_id);

  INSERT INTO context_gc_candidates(blob_id, unreferenced_at)
  SELECT b.blob_id, b.created_at
  FROM context_blobs b
  WHERE NOT EXISTS (
    SELECT 1 FROM context_refs r WHERE r.blob_id = b.blob_id
  );
`;

const SCHEMA_V3_MIGRATION = `
  CREATE TABLE context_blobs_v3 (
    blob_id BLOB PRIMARY KEY CHECK(length(blob_id) = 32),
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('inline', 'managed_file')),
    payload BLOB NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    CHECK(
      (storage_kind = 'inline' AND length(payload) = size_bytes) OR
      (storage_kind = 'managed_file' AND length(payload) BETWEEN 1 AND 512)
    )
  );

  CREATE TABLE context_refs_v3 (
    ref_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK(
      owner_kind IN ('read_image_snapshot', 'tool_result_archive')
    ),
    owner_id TEXT NOT NULL,
    blob_id BLOB NOT NULL REFERENCES context_blobs_v3(blob_id) ON DELETE RESTRICT,
    media_type TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE(session_id, owner_kind, owner_id)
  );

  CREATE TABLE context_gc_candidates_v3 (
    blob_id BLOB PRIMARY KEY
      REFERENCES context_blobs_v3(blob_id) ON DELETE CASCADE,
    unreferenced_at INTEGER NOT NULL CHECK(unreferenced_at >= 0)
  );

  INSERT INTO context_blobs_v3(blob_id, storage_kind, payload, size_bytes, created_at)
  SELECT blob_id, 'inline', payload, size_bytes, created_at FROM context_blobs;

  INSERT INTO context_refs_v3(
    ref_id, session_id, owner_kind, owner_id, blob_id, media_type, created_at
  )
  SELECT ref_id, session_id, owner_kind, owner_id, blob_id, media_type, created_at
  FROM context_refs;

  INSERT INTO context_gc_candidates_v3(blob_id, unreferenced_at)
  SELECT blob_id, unreferenced_at FROM context_gc_candidates;

  DROP TABLE context_refs;
  DROP TABLE context_gc_candidates;
  DROP TABLE context_blobs;

  ALTER TABLE context_blobs_v3 RENAME TO context_blobs;
  ALTER TABLE context_refs_v3 RENAME TO context_refs;
  ALTER TABLE context_gc_candidates_v3 RENAME TO context_gc_candidates;

  CREATE INDEX context_refs_session
    ON context_refs(session_id, created_at, ref_id);
  CREATE INDEX context_refs_blob
    ON context_refs(blob_id);
  CREATE INDEX context_gc_candidates_eligible
    ON context_gc_candidates(unreferenced_at, blob_id);

  CREATE TABLE context_file_deletions (
    locator BLOB PRIMARY KEY CHECK(length(locator) BETWEEN 1 AND 512),
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    enqueued_at INTEGER NOT NULL CHECK(enqueued_at >= 0)
  );

  CREATE INDEX context_file_deletions_pending
    ON context_file_deletions(enqueued_at, locator);
`;

const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  ['table', 'context_blobs'],
  ['table', 'context_refs'],
  ['table', 'context_session_usage'],
  ['table', 'context_store_usage'],
  ['table', 'context_gc_candidates'],
  ['table', 'context_file_deletions'],
  ['index', 'context_refs_session'],
  ['index', 'context_refs_blob'],
  ['index', 'context_gc_candidates_eligible'],
  ['index', 'context_file_deletions_pending'],
] as const);

const REQUIRED_TABLE_COLUMNS = Object.freeze({
  context_blobs: ['blob_id', 'storage_kind', 'payload', 'size_bytes', 'created_at'],
  context_refs: [
    'ref_id',
    'session_id',
    'owner_kind',
    'owner_id',
    'blob_id',
    'media_type',
    'created_at',
  ],
  context_session_usage: ['session_id', 'reference_count', 'logical_bytes'],
  context_store_usage: ['singleton', 'blob_count', 'physical_bytes'],
  context_gc_candidates: ['blob_id', 'unreferenced_at'],
  context_file_deletions: ['locator', 'size_bytes', 'enqueued_at'],
} as const);

const REQUIRED_INDEX_COLUMNS = Object.freeze({
  context_refs_session: ['session_id', 'created_at', 'ref_id'],
  context_refs_blob: ['blob_id'],
  context_gc_candidates_eligible: ['unreferenced_at', 'blob_id'],
  context_file_deletions_pending: ['enqueued_at', 'locator'],
} as const);

export function configureSqliteContextOffloadDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
  // WAL initialization fixes the database header in a form where changing
  // auto_vacuum from NONE is no longer accepted. Configure it first, while a
  // brand-new dedicated database still has no application schema objects.
  if (readSqliteContextOffloadSchemaVersion(db) === 0 && !hasApplicationSchemaObjects(db)) {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  }
  ensureWalJournalMode(db);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function migrateSqliteContextOffloadDatabase(db: DatabaseSync): void {
  const observedVersion = readSqliteContextOffloadSchemaVersion(db);
  if (observedVersion > SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
  if (observedVersion === SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION) {
    validateSchema(db);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    let current = readSqliteContextOffloadSchemaVersion(db);
    if (current > SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION) throw newerSchemaError(current);
    if (current === 0) {
      if (hasApplicationSchemaObjects(db)) {
        throw new Error('Unversioned context-offload SQLite schema is not supported');
      }
      db.exec(INITIAL_SCHEMA);
      db.exec(`PRAGMA user_version = ${SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION}`);
      current = SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION;
    }
    if (current === 1) {
      db.exec(SCHEMA_V2_MIGRATION);
      db.exec('PRAGMA user_version = 2');
      current = 2;
    }
    if (current === 2) {
      db.exec(SCHEMA_V3_MIGRATION);
      db.exec(`PRAGMA user_version = ${SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION}`);
      current = SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION;
    }
    validateSchema(db);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function readSqliteContextOffloadSchemaVersion(db: DatabaseSync): number {
  const row = retryWhileSqliteBusy(
    () => db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined,
  );
  const value = row?.user_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid context-offload SQLite schema version');
  }
  return value;
}

function validateSchema(db: DatabaseSync): void {
  const autoVacuum = db.prepare('PRAGMA auto_vacuum').get() as
    | { auto_vacuum?: unknown }
    | undefined;
  if (autoVacuum?.auto_vacuum !== 2) {
    throw new Error('Incomplete context-offload SQLite schema: incremental auto-vacuum required');
  }
  const readObject = db.prepare('SELECT type FROM sqlite_schema WHERE name = ?');
  for (const [type, name] of REQUIRED_SCHEMA_OBJECTS) {
    const row = readObject.get(name) as { type?: unknown } | undefined;
    if (row?.type !== type) {
      throw new Error(`Incomplete context-offload SQLite schema: missing ${type} ${name}`);
    }
  }
  for (const [table, requiredColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).flatMap(
        (row) => (typeof row.name === 'string' ? [row.name] : []),
      ),
    );
    for (const column of requiredColumns) {
      if (!columns.has(column)) {
        throw new Error(
          `Incomplete context-offload SQLite schema: table ${table} is missing column ${column}`,
        );
      }
    }
  }
  for (const [index, requiredColumns] of Object.entries(REQUIRED_INDEX_COLUMNS)) {
    const columns = (
      db.prepare(`PRAGMA index_info(${index})`).all() as Array<{
        seqno?: unknown;
        name?: unknown;
      }>
    )
      .filter(
        (row): row is { seqno: number; name: string } =>
          typeof row.seqno === 'number' && typeof row.name === 'string',
      )
      .sort((left, right) => left.seqno - right.seqno)
      .map((row) => row.name);
    if (requiredColumns.some((column, position) => columns[position] !== column)) {
      throw new Error(
        `Incomplete context-offload SQLite schema: index ${index} has incompatible columns`,
      );
    }
  }
  const usage = db
    .prepare('SELECT blob_count, physical_bytes FROM context_store_usage WHERE singleton = 1')
    .get() as { blob_count?: unknown; physical_bytes?: unknown } | undefined;
  if (!isNonNegativeInteger(usage?.blob_count) || !isNonNegativeInteger(usage.physical_bytes)) {
    throw new Error('Incomplete context-offload SQLite schema: missing store usage row');
  }
}

function hasApplicationSchemaObjects(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' LIMIT 1`,
    )
    .get() as { present?: unknown } | undefined;
  return row?.present === 1;
}

function ensureWalJournalMode(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    const journalMode = readJournalMode(db);
    if (journalMode === 'wal' || journalMode === 'memory') return;
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const configuredMode = readJournalMode(db);
      if (configuredMode !== 'wal') {
        throw new Error(
          `Context-offload SQLite requires WAL journal mode, received ${configuredMode}`,
        );
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function readJournalMode(db: DatabaseSync): string {
  const row = retryWhileSqliteBusy(
    () => db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined,
  );
  if (typeof row?.journal_mode !== 'string') {
    throw new Error('Invalid context-offload SQLite journal mode');
  }
  return row.journal_mode.toLowerCase();
}

function retryWhileSqliteBusy<T>(operation: () => T): T {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'SQLITE_BUSY' || /database (?:is )?(?:locked|busy)/i.test(error.message);
}

function newerSchemaError(version: number): Error {
  return new Error(
    `Context-offload SQLite schema ${version} is newer than supported version ${SQLITE_CONTEXT_OFFLOAD_SCHEMA_VERSION}`,
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
