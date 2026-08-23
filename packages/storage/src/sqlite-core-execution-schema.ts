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

export const SQLITE_CORE_EXECUTION_SCHEMA_VERSION = 4;

export function migrateSqliteCoreExecutionDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS core_agent_runs (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      latest_model_call_sequence INTEGER CHECK (latest_model_call_sequence >= 0),
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

    CREATE INDEX IF NOT EXISTS core_agent_run_events_type_sequence
      ON core_agent_run_events(event_type, session_id, run_id, sequence);

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
  ensureColumn(
    db,
    'core_agent_runs',
    'latest_model_call_sequence',
    'INTEGER CHECK (latest_model_call_sequence >= 0)',
  );
  db.exec(`
    UPDATE core_agent_runs
    SET latest_model_call_sequence = (
      SELECT MAX(sequence)
      FROM core_agent_run_events
      WHERE core_agent_run_events.session_id = core_agent_runs.session_id
        AND core_agent_run_events.run_id = core_agent_runs.run_id
        AND event_type = 'model_call_attempt_recorded'
    )
    WHERE latest_model_call_sequence IS NULL
      AND EXISTS (
        SELECT 1
        FROM core_agent_run_events
        WHERE core_agent_run_events.session_id = core_agent_runs.session_id
          AND core_agent_run_events.run_id = core_agent_runs.run_id
          AND event_type = 'model_call_attempt_recorded'
      );

    CREATE INDEX IF NOT EXISTS core_agent_runs_model_call_high_water
      ON core_agent_runs(session_id, latest_model_call_sequence, run_id)
      WHERE latest_model_call_sequence IS NOT NULL;
  `);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
