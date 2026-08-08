import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_CORE_EXECUTION_SCHEMA_VERSION = 2;

export function migrateSqliteCoreExecutionDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_agent_runs (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, run_id)
    );

    CREATE INDEX IF NOT EXISTS core_agent_runs_session_order
      ON core_agent_runs(session_id, created_at, run_id);

    CREATE INDEX IF NOT EXISTS core_agent_runs_identity
      ON core_agent_runs(run_id, session_id);

    CREATE TABLE IF NOT EXISTS core_agent_run_events (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_ts INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, run_id, sequence),
      FOREIGN KEY (session_id, run_id)
        REFERENCES core_agent_runs(session_id, run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS core_agent_run_events_identity
      ON core_agent_run_events(session_id, run_id, event_id);

    CREATE TABLE IF NOT EXISTS core_agent_run_projections (
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_json TEXT,
      PRIMARY KEY (session_id, event_type)
    );

    CREATE TABLE IF NOT EXISTS core_root_turn_admissions (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_id)
    );

    CREATE INDEX IF NOT EXISTS core_root_turn_admissions_order
      ON core_root_turn_admissions(session_id, admitted_at, turn_id);

    CREATE TABLE IF NOT EXISTS core_root_turn_start_rejections (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      rejected_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_id)
    );

    CREATE TABLE IF NOT EXISTS core_root_source_message_proofs (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id),
      FOREIGN KEY (session_id, turn_id)
        REFERENCES core_root_turn_admissions(session_id, turn_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS core_interaction_requests (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      request_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS core_interaction_pending
      ON core_interaction_requests(session_id, created_at, request_id);

    CREATE TABLE IF NOT EXISTS core_interaction_outcomes (
      request_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      FOREIGN KEY (request_id)
        REFERENCES core_interaction_requests(request_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS core_message_host_epochs (
      host_epoch TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS core_message_receipts (
      host_epoch TEXT NOT NULL,
      operation TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (host_epoch, operation, session_id, operation_id),
      FOREIGN KEY (host_epoch)
        REFERENCES core_message_host_epochs(host_epoch)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS core_shell_runs (
      session_id TEXT NOT NULL,
      shell_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, shell_run_id)
    );

    CREATE INDEX IF NOT EXISTS core_shell_runs_session_order
      ON core_shell_runs(session_id, started_at, shell_run_id);
  `);
}
