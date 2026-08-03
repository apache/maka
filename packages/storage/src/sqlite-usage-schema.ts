import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_USAGE_SCHEMA_VERSION = 3;

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

    -- Runs whose attempts are committed to the AgentRun stream but may not have
    -- reached the table above. The marker is an optimization, not the
    -- correctness argument: the stream holds every record, so a full
    -- re-projection recovers a run even when its marker was never written.
    CREATE TABLE IF NOT EXISTS usage_model_call_reprojection (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      marked_at INTEGER NOT NULL CHECK (marked_at >= 0),
      PRIMARY KEY (session_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS usage_pricing_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    INSERT OR IGNORE INTO usage_pricing_authority(singleton, revision)
    VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS usage_pricing_overrides (
      model_key TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
  `);
}
