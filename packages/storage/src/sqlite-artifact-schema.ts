import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_ARTIFACT_SCHEMA_VERSION = 1;

export function migrateSqliteArtifactDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_records (
      storage_key TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('live', 'deleted')),
      relative_path TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS artifact_records_session_order
      ON artifact_records(session_id, created_at, storage_key);

    CREATE UNIQUE INDEX IF NOT EXISTS artifact_records_relative_path
      ON artifact_records(relative_path);
  `);
}
