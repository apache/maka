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

export const SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION = 5;

const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type SqliteLongTermMemoryMigrationFailpoint = 'after_schema_sql';

export interface SqliteLongTermMemoryMigrationOptions {
  readonly failpoint?: (point: SqliteLongTermMemoryMigrationFailpoint) => void;
}

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE memory_items (
      item_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 1),
      content TEXT NOT NULL CHECK (length(content) > 0),
      kind TEXT NOT NULL CHECK (
        kind IN ('preference', 'identity', 'context', 'knowledge', 'failure', 'note')
      ),
      statement_type TEXT NOT NULL CHECK (statement_type IN ('fact', 'plan', 'prediction')),
      temporal_type TEXT NOT NULL CHECK (
        temporal_type IN ('undated', 'point', 'interval', 'open_ended')
      ),
      scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'workspace')),
      scope_key TEXT,
      event_started_at INTEGER,
      event_ended_at INTEGER,
      observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'archived')),
      origin TEXT NOT NULL CHECK (origin IN ('agent_extracted', 'user_requested')),
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (scope_type = 'global' AND scope_key IS NULL)
        OR
        (scope_type = 'workspace' AND scope_key IS NOT NULL AND length(scope_key) > 0)
      ),
      CHECK (
        (temporal_type = 'undated'
          AND event_started_at IS NULL
          AND event_ended_at IS NULL)
        OR
        (temporal_type = 'point'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND (event_ended_at IS NULL OR event_ended_at > event_started_at))
        OR
        (temporal_type = 'interval'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NOT NULL
          AND event_ended_at > event_started_at)
        OR
        (temporal_type = 'open_ended'
          AND event_started_at IS NOT NULL
          AND event_started_at >= 0
          AND event_ended_at IS NULL)
      ),
      CHECK (created_at <= updated_at),
      CHECK (observed_at <= updated_at)
    );

    CREATE INDEX memory_items_by_scope_and_lifecycle
      ON memory_items(scope_type, scope_key, lifecycle_state, updated_at DESC, item_id);

    CREATE TABLE memory_item_keys (
      item_id TEXT NOT NULL,
      key_text TEXT NOT NULL CHECK (length(key_text) > 0),
      normalized_key TEXT NOT NULL CHECK (length(normalized_key) > 0),
      key_type TEXT NOT NULL CHECK (key_type IN ('exact', 'entity', 'concept', 'alias', 'code')),
      key_origin TEXT NOT NULL CHECK (key_origin IN ('deterministic', 'llm', 'user')),
      PRIMARY KEY(item_id, normalized_key),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX memory_item_keys_by_normalized_key
      ON memory_item_keys(normalized_key, item_id);

    CREATE TABLE memory_item_sources (
      item_id TEXT NOT NULL,
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      run_id TEXT NOT NULL CHECK (length(run_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      event_id TEXT NOT NULL CHECK (length(event_id) > 0),
      PRIMARY KEY(item_id, event_id),
      FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX memory_item_sources_by_event
      ON memory_item_sources(event_id, item_id);

    CREATE INDEX memory_item_sources_by_turn
      ON memory_item_sources(session_id, turn_id, item_id);

    CREATE TABLE memory_write_operations (
      operation_id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL CHECK (
        operation_type IN ('create', 'update', 'archive', 'restore', 'batch')
      ),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0)
    );
  `,
  ],
  [
    2,
    `
    CREATE TABLE memory_extraction_cursors (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      processed_ordinal INTEGER NOT NULL CHECK (processed_ordinal > 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    );

    CREATE TABLE memory_extraction_receipts (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
      result_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      FOREIGN KEY (operation_id) REFERENCES memory_write_operations(operation_id) ON DELETE CASCADE
    );
  `,
  ],
  [
    3,
    `
    CREATE TABLE memory_extraction_failures (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      from_ordinal INTEGER NOT NULL CHECK (from_ordinal > 0),
      through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= from_ordinal),
      coverage_hash TEXT NOT NULL CHECK (length(coverage_hash) = 64),
      first_operation_id TEXT NOT NULL UNIQUE CHECK (length(first_operation_id) > 0),
      first_trigger TEXT NOT NULL CHECK (first_trigger IN ('remember', 'extract')),
      first_failure_class TEXT NOT NULL CHECK (
        first_failure_class IN (
          'provider', 'schema', 'evidence', 'localization', 'requested_admission'
        )
      ),
      failed_at INTEGER NOT NULL CHECK (failed_at >= 0)
    );
  `,
  ],
  [
    4,
    `
    ALTER TABLE memory_extraction_failures RENAME TO memory_extraction_failures_v3;

    CREATE TABLE memory_extraction_failures (
      session_id TEXT PRIMARY KEY CHECK (length(session_id) > 0),
      from_ordinal INTEGER NOT NULL CHECK (from_ordinal > 0),
      through_ordinal INTEGER NOT NULL CHECK (through_ordinal >= from_ordinal),
      coverage_hash TEXT NOT NULL CHECK (length(coverage_hash) = 64),
      first_operation_id TEXT NOT NULL UNIQUE CHECK (length(first_operation_id) > 0),
      first_trigger TEXT NOT NULL CHECK (
        first_trigger IN ('remember', 'extract', 'compaction')
      ),
      compaction_checkpoint_id TEXT CHECK (
        compaction_checkpoint_id IS NULL OR length(compaction_checkpoint_id) > 0
      ),
      first_failure_class TEXT NOT NULL CHECK (
        first_failure_class IN (
          'provider', 'schema', 'evidence', 'localization', 'requested_admission'
        )
      ),
      failed_at INTEGER NOT NULL CHECK (failed_at >= 0),
      CHECK (
        (first_trigger = 'compaction' AND compaction_checkpoint_id IS NOT NULL)
        OR (first_trigger != 'compaction' AND compaction_checkpoint_id IS NULL)
      )
    );

    INSERT INTO memory_extraction_failures(
      session_id, from_ordinal, through_ordinal, coverage_hash,
      first_operation_id, first_trigger, compaction_checkpoint_id,
      first_failure_class, failed_at
    )
    SELECT
      session_id, from_ordinal, through_ordinal, coverage_hash,
      first_operation_id, first_trigger, NULL,
      first_failure_class, failed_at
    FROM memory_extraction_failures_v3;

    DROP TABLE memory_extraction_failures_v3;
  `,
  ],
  [
    5,
    `
    CREATE TABLE memory_compaction_policy_denials (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      compaction_checkpoint_id TEXT NOT NULL CHECK (length(compaction_checkpoint_id) > 0),
      denied_at INTEGER NOT NULL CHECK (denied_at >= 0),
      PRIMARY KEY(session_id, compaction_checkpoint_id)
    ) WITHOUT ROWID;
  `,
  ],
]);

interface MinimumTableShape {
  readonly name: string;
  readonly requiredColumns: readonly string[];
}

interface MinimumIndexShape {
  readonly name: string;
  readonly tableName: string;
  readonly requiredColumnPrefix: readonly string[];
}

interface MinimumSchemaShape {
  readonly tables: readonly MinimumTableShape[];
  readonly indexes: readonly MinimumIndexShape[];
}

// Each entry describes the complete minimum shape required by that schema version. Extra
// columns and indexes are allowed so additive migrations do not fail exact-DDL validation.
const VERSION_1_MINIMUM_SCHEMA_SHAPE: MinimumSchemaShape = {
  tables: [
    {
      name: 'memory_items',
      requiredColumns: [
        'item_id',
        'version',
        'content',
        'kind',
        'statement_type',
        'temporal_type',
        'scope_type',
        'scope_key',
        'event_started_at',
        'event_ended_at',
        'observed_at',
        'lifecycle_state',
        'origin',
        'content_hash',
        'created_at',
        'updated_at',
      ],
    },
    {
      name: 'memory_item_keys',
      requiredColumns: ['item_id', 'key_text', 'normalized_key', 'key_type', 'key_origin'],
    },
    {
      name: 'memory_item_sources',
      requiredColumns: ['item_id', 'session_id', 'run_id', 'turn_id', 'event_id'],
    },
    {
      name: 'memory_write_operations',
      requiredColumns: [
        'operation_id',
        'operation_type',
        'request_hash',
        'result_json',
        'committed_at',
      ],
    },
  ],
  indexes: [
    {
      name: 'memory_item_keys_by_normalized_key',
      tableName: 'memory_item_keys',
      requiredColumnPrefix: ['normalized_key', 'item_id'],
    },
  ],
};

const MINIMUM_SCHEMA_SHAPES = new Map<number, MinimumSchemaShape>([
  [1, VERSION_1_MINIMUM_SCHEMA_SHAPE],
  [
    2,
    {
      tables: [
        ...VERSION_1_MINIMUM_SCHEMA_SHAPE.tables,
        {
          name: 'memory_extraction_cursors',
          requiredColumns: ['session_id', 'processed_ordinal', 'updated_at'],
        },
        {
          name: 'memory_extraction_receipts',
          requiredColumns: [
            'operation_id',
            'session_id',
            'request_hash',
            'result_json',
            'committed_at',
          ],
        },
      ],
      indexes: VERSION_1_MINIMUM_SCHEMA_SHAPE.indexes,
    },
  ],
  [
    3,
    {
      tables: [
        ...VERSION_1_MINIMUM_SCHEMA_SHAPE.tables,
        {
          name: 'memory_extraction_cursors',
          requiredColumns: ['session_id', 'processed_ordinal', 'updated_at'],
        },
        {
          name: 'memory_extraction_receipts',
          requiredColumns: [
            'operation_id',
            'session_id',
            'request_hash',
            'result_json',
            'committed_at',
          ],
        },
        {
          name: 'memory_extraction_failures',
          requiredColumns: [
            'session_id',
            'from_ordinal',
            'through_ordinal',
            'coverage_hash',
            'first_operation_id',
            'first_trigger',
            'first_failure_class',
            'failed_at',
          ],
        },
      ],
      indexes: VERSION_1_MINIMUM_SCHEMA_SHAPE.indexes,
    },
  ],
  [
    4,
    {
      tables: [
        ...VERSION_1_MINIMUM_SCHEMA_SHAPE.tables,
        {
          name: 'memory_extraction_cursors',
          requiredColumns: ['session_id', 'processed_ordinal', 'updated_at'],
        },
        {
          name: 'memory_extraction_receipts',
          requiredColumns: [
            'operation_id',
            'session_id',
            'request_hash',
            'result_json',
            'committed_at',
          ],
        },
        {
          name: 'memory_extraction_failures',
          requiredColumns: [
            'session_id',
            'from_ordinal',
            'through_ordinal',
            'coverage_hash',
            'first_operation_id',
            'first_trigger',
            'compaction_checkpoint_id',
            'first_failure_class',
            'failed_at',
          ],
        },
      ],
      indexes: VERSION_1_MINIMUM_SCHEMA_SHAPE.indexes,
    },
  ],
]);

const version4MinimumShape = MINIMUM_SCHEMA_SHAPES.get(4)!;
MINIMUM_SCHEMA_SHAPES.set(5, {
  tables: [
    ...version4MinimumShape.tables,
    {
      name: 'memory_compaction_policy_denials',
      requiredColumns: ['session_id', 'compaction_checkpoint_id', 'denied_at'],
    },
  ],
  indexes: version4MinimumShape.indexes,
});

for (let version = 1; version <= SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION; version += 1) {
  if (!MIGRATIONS.has(version)) {
    throw new Error(`Missing long-term memory SQLite migration ${version}`);
  }
  if (!MINIMUM_SCHEMA_SHAPES.has(version)) {
    throw new Error(`Missing long-term memory SQLite minimum schema shape ${version}`);
  }
}

export function configureSqliteLongTermMemoryDatabase(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
  ensureWalJournalMode(db);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function migrateSqliteLongTermMemoryDatabase(
  db: DatabaseSync,
  options: SqliteLongTermMemoryMigrationOptions = {},
): void {
  const observedVersion = readSqliteLongTermMemorySchemaVersion(db);
  if (observedVersion > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
  if (observedVersion === SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    validateMinimumSchemaShape(db, observedVersion);
    return;
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readSqliteLongTermMemorySchemaVersion(db);
    if (current > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) throw newerSchemaError(current);
    for (
      let version = current + 1;
      version <= SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION;
      version += 1
    ) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing long-term memory SQLite migration ${version}`);
      db.exec(sql);
      options.failpoint?.('after_schema_sql');
      db.exec(`PRAGMA user_version = ${version}`);
    }
    validateMinimumSchemaShape(db, SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function assertSupportedSqliteLongTermMemorySchemaVersion(db: DatabaseSync): void {
  const observedVersion = readSqliteLongTermMemorySchemaVersion(db);
  if (observedVersion > SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION) {
    throw newerSchemaError(observedVersion);
  }
}

export function readSqliteLongTermMemorySchemaVersion(db: DatabaseSync): number {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const value = row?.user_version;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid long-term memory SQLite schema version');
    }
    return value;
  });
}

function readJournalMode(db: DatabaseSync): string {
  return retryWhileSqliteBusy(() => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    if (typeof row?.journal_mode !== 'string') {
      throw new Error('Invalid long-term memory SQLite journal mode');
    }
    return row.journal_mode.toLowerCase();
  });
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
          `Long-term memory SQLite requires WAL journal mode, received ${configuredMode}`,
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

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'SQLITE_BUSY' || /database is locked/i.test(error.message);
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

function newerSchemaError(version: number): Error {
  return new Error(
    `Long-term memory SQLite schema ${version} is newer than supported version ${SQLITE_LONG_TERM_MEMORY_SCHEMA_VERSION}`,
  );
}

function validateMinimumSchemaShape(db: DatabaseSync, version: number): void {
  const shape = MINIMUM_SCHEMA_SHAPES.get(version);
  if (!shape) {
    throw new Error(`Missing long-term memory SQLite minimum schema shape ${version}`);
  }

  const readSchemaObject = db.prepare('SELECT type, tbl_name FROM sqlite_schema WHERE name = ?');
  for (const table of shape.tables) {
    const object = readSchemaObject.get(table.name) as
      | { type?: unknown; tbl_name?: unknown }
      | undefined;
    if (object?.type !== 'table' || object.tbl_name !== table.name) {
      throw incompleteSchemaError(`missing required table ${table.name}`);
    }

    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`).all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    for (const column of table.requiredColumns) {
      if (!columns.has(column)) {
        throw incompleteSchemaError(`table ${table.name} is missing required column ${column}`);
      }
    }
  }

  for (const index of shape.indexes) {
    const object = readSchemaObject.get(index.name) as
      | { type?: unknown; tbl_name?: unknown }
      | undefined;
    if (object?.type !== 'index' || object.tbl_name !== index.tableName) {
      throw incompleteSchemaError(`missing required index ${index.name}`);
    }

    const columns = (
      db.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all() as Array<{
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
    if (index.requiredColumnPrefix.some((column, position) => columns[position] !== column)) {
      throw incompleteSchemaError(`required index ${index.name} has incompatible columns`);
    }
  }
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function incompleteSchemaError(detail: string): Error {
  return new Error(`Incomplete long-term memory SQLite schema: ${detail}`);
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
