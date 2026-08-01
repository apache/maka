import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_USAGE_SCHEMA_VERSION = 2;

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

    -- Canonical model-call accounting ledger (#1679). Separate from
    -- usage_llm_calls, which is a frozen historical projection: these rows carry
    -- usageBasis/costBasis, which that schema cannot express.
    CREATE TABLE IF NOT EXISTS usage_model_call_attempts (
      attempt_id TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS usage_model_call_attempts_completed_at
      ON usage_model_call_attempts(completed_at DESC, attempt_id);

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
