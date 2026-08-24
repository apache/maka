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

export const SQLITE_RUNTIME_SCHEMA_VERSION = 12;
export const RUNTIME_RECOVERY_AUTHORITY_CAPABILITY = 'runtime_recovery_authority';
export const RUNTIME_RECOVERY_AUTHORITY_CAPABILITY_VERSION = 1;
export const RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY = 'runtime_continuation_authority';
export const RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY_VERSION = 1;
export const RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY = 'runtime_workspace_version_authority';
export const RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY_VERSION = 1;
const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(4));

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE runtime_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL CHECK (event_seq > 0),
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL,
      UNIQUE (invocation_id, event_seq)
    );

    CREATE INDEX runtime_events_by_run
      ON runtime_events(session_id, run_id, event_seq);

    CREATE INDEX runtime_events_by_session
      ON runtime_events(session_id, committed_at, event_id);

    CREATE TABLE tool_journal_events (
      journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_event_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      runtime_event_id TEXT,
      canonical_args_hash TEXT,
      recovery_mode TEXT,
      external_handle TEXT,
      metadata_json TEXT,
      committed_at INTEGER NOT NULL,
      FOREIGN KEY(runtime_event_id) REFERENCES runtime_events(event_id)
    );

    CREATE INDEX tool_journal_events_by_operation
      ON tool_journal_events(operation_id, journal_seq);

    CREATE TABLE tool_operations (
      operation_id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      canonical_args_hash TEXT NOT NULL,
      recovery_mode TEXT NOT NULL,
      current_state TEXT NOT NULL,
      call_event_id TEXT NOT NULL,
      result_event_id TEXT,
      version INTEGER NOT NULL CHECK (version > 0),
      FOREIGN KEY(call_event_id) REFERENCES runtime_events(event_id),
      FOREIGN KEY(result_event_id) REFERENCES runtime_events(event_id),
      UNIQUE(invocation_id, provider_tool_call_id)
    );
  `,
  ],
  [
    2,
    `
    CREATE TABLE runtime_partial_snapshots (
      stream_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      after_event_id TEXT,
      payload_json TEXT NOT NULL,
      text_content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX runtime_partial_snapshots_by_run
      ON runtime_partial_snapshots(session_id, run_id, updated_at, stream_key);
  `,
  ],
  [
    3,
    `
    SELECT 1;
  `,
  ],
  [
    4,
    `
    ALTER TABLE tool_operations ADD COLUMN dispatch_event_id TEXT
      REFERENCES runtime_events(event_id);
  `,
  ],
  [
    5,
    `
    CREATE TABLE runtime_capabilities (
      capability TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0)
    );

    INSERT INTO runtime_capabilities(capability, version)
      VALUES ('runtime_recovery_authority', 1);
  `,
  ],
  [
    6,
    `
    CREATE TABLE runtime_continuation_claims (
      claim_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      source_invocation_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      source_event_high_water INTEGER NOT NULL CHECK (source_event_high_water > 0),
      source_prefix_digest TEXT NOT NULL,
      boundary_digest TEXT NOT NULL UNIQUE,
      boundary_json TEXT NOT NULL,
      provider_projection_version INTEGER NOT NULL CHECK (provider_projection_version = 1),
      provider_replay_digest TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_invocation_id TEXT NOT NULL UNIQUE,
      target_run_id TEXT NOT NULL UNIQUE,
      target_turn_id TEXT NOT NULL,
      target_run_header_json TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      start_event_id TEXT UNIQUE REFERENCES runtime_events(event_id),
      start_kind TEXT CHECK (
        start_kind IS NULL OR start_kind IN ('runtime_admission', 'claim_repair')
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      UNIQUE (
        source_session_id,
        source_run_id,
        source_event_high_water,
        source_prefix_digest
      ),
      UNIQUE (target_session_id, target_turn_id)
    );

    INSERT INTO runtime_capabilities(capability, version)
      VALUES ('runtime_continuation_authority', 1);
  `,
  ],
  [
    7,
    `
    CREATE TABLE runtime_workspace_epochs (
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL UNIQUE,
      repository_id TEXT NOT NULL,
      workspace_instance_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode = 'managed_worktree'),
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      source_commit_oid TEXT NOT NULL,
      source_tree_oid TEXT NOT NULL,
      initial_workspace_version_id TEXT NOT NULL UNIQUE,
      materialization_profile_digest TEXT NOT NULL,
      materialization_semantics TEXT NOT NULL
        CHECK (materialization_semantics = 'git_tree_materialized_with_fixed_config_v1'),
      policy_hash TEXT NOT NULL,
      authority_session_id TEXT NOT NULL CHECK (authority_session_id = 'maka_workspace_authority'),
      authority_invocation_id TEXT NOT NULL UNIQUE,
      authority_run_id TEXT NOT NULL UNIQUE,
      authority_turn_id TEXT NOT NULL UNIQUE,
      epoch_opened_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(event_id),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      committed_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, workspace_epoch_id)
    );

    CREATE TABLE runtime_workspace_versions (
      workspace_version_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      origin_kind TEXT NOT NULL CHECK (origin_kind = 'baseline'),
      origin_event_id TEXT NOT NULL,
      parents_json TEXT NOT NULL CHECK (parents_json = '[]'),
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      tree_delta_digest TEXT NOT NULL,
      changed_file_count INTEGER NOT NULL CHECK (changed_file_count >= 0),
      deleted_file_count INTEGER NOT NULL CHECK (deleted_file_count = 0),
      accepted_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(event_id),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      committed_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id),
      UNIQUE (
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      )
    );

    CREATE TABLE runtime_workspace_heads (
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      workspace_version_id TEXT NOT NULL,
      accepted_event_id TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      PRIMARY KEY (workspace_id, workspace_epoch_id),
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id),
      FOREIGN KEY (
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      ) REFERENCES runtime_workspace_versions(
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      )
    );

    INSERT INTO runtime_capabilities(capability, version)
      VALUES ('runtime_workspace_version_authority', 1);
  `,
  ],
  [
    8,
    `
    SELECT 1;
  `,
  ],
  [
    9,
    `
    CREATE TABLE runtime_storage_root_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      root_id TEXT NOT NULL CHECK (
        length(root_id) = 64 AND root_id NOT GLOB '*[^0-9a-f]*'
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1)
    );
  `,
  ],
  [
    10,
    `
    CREATE TABLE runtime_partial_segments (
      stream_key TEXT NOT NULL,
      segment_seq INTEGER NOT NULL CHECK (segment_seq > 0),
      text_content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (stream_key, segment_seq),
      FOREIGN KEY (stream_key)
        REFERENCES runtime_partial_snapshots(stream_key)
        ON DELETE CASCADE
    );
  `,
  ],
  [
    11,
    `
    CREATE TABLE runtime_session_event_ordinals (
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      event_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (session_id, ordinal),
      FOREIGN KEY (event_id) REFERENCES runtime_events(event_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    INSERT INTO runtime_session_event_ordinals(session_id, ordinal, event_id)
    SELECT
      session_id,
      ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY rowid ASC
      ),
      event_id
    FROM runtime_events;
  `,
  ],
  [
    12,
    `
    DROP TABLE IF EXISTS headless_task_run_events;
  `,
  ],
]);

export function configureSqliteRuntimeDatabase(db: DatabaseSync): void {
  // Bound lock acquisition before touching persistent journal state. WAL mode is
  // database-persistent, so established workspaces only need to verify it rather
  // than making every concurrent opener execute the setting form of the pragma.
  configureSqliteRuntimeLockWait(db);
  ensureWalJournalMode(db);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

/** Configure connection-local lock waiting without changing persistent database state. */
export function configureSqliteRuntimeLockWait(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
}

export function migrateSqliteRuntimeDatabase(
  db: DatabaseSync,
  options: { transaction?: 'self' | 'caller' } = {},
): void {
  const observedVersion = readUserVersion(db);
  if (observedVersion > SQLITE_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `SQLite runtime schema ${observedVersion} is newer than supported version ${SQLITE_RUNTIME_SCHEMA_VERSION}`,
    );
  }
  if (observedVersion === SQLITE_RUNTIME_SCHEMA_VERSION) return;

  // The optimistic read keeps established databases on a read-only open path.
  // Any pending upgrade is serialized by one write transaction, then re-reads
  // user_version under that lock so a concurrent opener cannot apply a
  // migration another process just committed.
  const ownsTransaction = options.transaction !== 'caller';
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const current = readUserVersion(db);
    if (current > SQLITE_RUNTIME_SCHEMA_VERSION) {
      throw new Error(
        `SQLite runtime schema ${current} is newer than supported version ${SQLITE_RUNTIME_SCHEMA_VERSION}`,
      );
    }
    for (let version = current + 1; version <= SQLITE_RUNTIME_SCHEMA_VERSION; version += 1) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing SQLite runtime migration ${version}`);
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    }
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const value = row?.user_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite runtime schema version');
  }
  return value;
}

function readJournalMode(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
  if (typeof row?.journal_mode !== 'string') {
    throw new Error('Invalid SQLite runtime journal mode');
  }
  return row.journal_mode.toLowerCase();
}

function ensureWalJournalMode(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      const journalMode = readJournalMode(db);
      if (journalMode === 'wal' || journalMode === 'memory') return;
      db.exec('PRAGMA journal_mode = WAL');
      const configuredMode = readJournalMode(db);
      if (configuredMode !== 'wal') {
        throw new Error(`SQLite runtime requires WAL journal mode, received ${configuredMode}`);
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
  const sqliteError = error as Error & {
    code?: unknown;
    errcode?: unknown;
    errstr?: unknown;
  };
  return (
    sqliteError.errcode === 5 ||
    sqliteError.code === 'SQLITE_BUSY' ||
    sqliteError.errstr === 'database is locked' ||
    /database (?:is )?(?:locked|busy)/i.test(sqliteError.message)
  );
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
