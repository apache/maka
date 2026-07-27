import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_RUNTIME_SCHEMA_VERSION = 5;
export const RUNTIME_RECOVERY_AUTHORITY_CAPABILITY = 'runtime_recovery_authority';
export const RUNTIME_RECOVERY_AUTHORITY_CAPABILITY_VERSION = 1;

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
    CREATE TABLE runtime_import_sources (
      source_path TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    );
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
]);

export function configureSqliteRuntimeDatabase(db: DatabaseSync): void {
  // Bound lock acquisition before touching persistent journal state. WAL mode is
  // database-persistent, so established workspaces only need to verify it rather
  // than making every concurrent opener execute the setting form of the pragma.
  db.exec('PRAGMA busy_timeout = 5000');
  const journalMode = readJournalMode(db);
  if (journalMode !== 'wal') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function migrateSqliteRuntimeDatabase(db: DatabaseSync): void {
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
  db.exec('BEGIN IMMEDIATE');
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
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
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

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
