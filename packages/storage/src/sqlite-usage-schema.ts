import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_USAGE_SCHEMA_VERSION = 1;

export function migrateSqliteUsageDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_llm_calls (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS usage_llm_calls_ts
      ON usage_llm_calls(ts DESC, id);

    CREATE TABLE IF NOT EXISTS usage_tool_invocations (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS usage_tool_invocations_ts
      ON usage_tool_invocations(ts DESC, id);

    CREATE TABLE IF NOT EXISTS usage_pricing_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    CREATE TABLE IF NOT EXISTS usage_pricing_overrides (
      model_key TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
  `);
}
