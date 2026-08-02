import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_AUTOMATION_SCHEMA_VERSION = 1;

export function migrateSqliteAutomationDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_authority_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    INSERT OR IGNORE INTO automation_authority_state(singleton, revision)
    VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS automation_definitions (
      automation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      status TEXT NOT NULL,
      durable INTEGER NOT NULL CHECK (durable IN (0, 1)),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS automation_definitions_session_order
      ON automation_definitions(session_id, created_at, automation_id);

    CREATE INDEX IF NOT EXISTS automation_definitions_active_schedule
      ON automation_definitions(status, created_at, automation_id);

    CREATE TABLE IF NOT EXISTS automation_pending_fires (
      fire_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE,
      target_session_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS automation_pending_fires_order
      ON automation_pending_fires(admitted_at, fire_id);
  `);
}
