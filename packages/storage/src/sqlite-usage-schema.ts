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

export const SQLITE_USAGE_SCHEMA_VERSION = 5;

export function migrateSqliteUsageDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_llm_calls (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL,
      session_id TEXT
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
      record_json TEXT NOT NULL,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS usage_model_call_attempts_completed_at
      ON usage_model_call_attempts(completed_at DESC, attempt_id);

    -- The AgentRun sequence is the projection's sole progress authority. A run
    -- is behind exactly when its latest model-call event is newer than this
    -- checkpoint; unreadable evidence is retained without pinning later calls.
    CREATE TABLE IF NOT EXISTS usage_model_call_projection_checkpoints (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      applied_through_sequence INTEGER NOT NULL CHECK (applied_through_sequence >= 0),
      unreadable_events INTEGER NOT NULL DEFAULT 0 CHECK (unreadable_events >= 0),
      PRIMARY KEY (session_id, run_id),
      FOREIGN KEY (session_id, run_id)
        REFERENCES core_agent_runs(session_id, run_id)
        ON DELETE CASCADE
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
  db.exec('DROP TABLE IF EXISTS usage_model_call_reprojection');
  ensureColumn(db, 'usage_llm_calls', 'session_id', 'TEXT');
  ensureColumn(db, 'usage_model_call_attempts', 'session_id', 'TEXT');
  db.exec(`
    UPDATE usage_llm_calls
    SET session_id = json_extract(record_json, '$.sessionId')
    WHERE session_id IS NULL AND json_valid(record_json);

    UPDATE usage_model_call_attempts
    SET session_id = json_extract(record_json, '$.sessionId')
    WHERE session_id IS NULL AND json_valid(record_json);

    CREATE INDEX IF NOT EXISTS usage_llm_calls_session_ts
      ON usage_llm_calls(session_id, ts DESC, id);

    CREATE INDEX IF NOT EXISTS usage_model_call_attempts_session_completed_at
      ON usage_model_call_attempts(session_id, completed_at DESC, attempt_id);
  `);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
