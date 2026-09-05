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

import {
  decodeModelCallAttempt,
  projectModelCallPricingRecord,
} from '@maka/core/model-call-attempt';
import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_USAGE_SCHEMA_VERSION = 6;

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
    -- usageBasis/costBasis, which that schema cannot express. record_json holds
    -- the pricing subset of the AgentRun authority's attempt, never the whole
    -- record.
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
  narrowModelCallProjectionRows(db);
}

/**
 * Folds rows written before the projection was narrowed through the same
 * function that writes new ones.
 *
 * Rebuilding from the authority instead would have been the usual move for a
 * read model, but it is not equivalent here: deleting a Session drops its
 * `core_agent_runs` rows and cascades the events, while these rows stay, so a
 * wipe-and-replay would silently erase the spend of every deleted Session from
 * the all-time totals. Re-projecting each row in place keeps the ledger's
 * answers identical and leaves one shape in the table, which is what lets the
 * reader hold a row to it.
 */
function narrowModelCallProjectionRows(db: DatabaseSync): void {
  // Keyed pages rather than one `all()`: the rows this exists to shrink are the
  // large ones, and a workspace can hold hundreds of thousands of them.
  const page = db.prepare(`
    SELECT attempt_id, record_json
    FROM usage_model_call_attempts
    WHERE attempt_id > ?
    ORDER BY attempt_id
    LIMIT 500
  `);
  const update = db.prepare(
    'UPDATE usage_model_call_attempts SET record_json = ? WHERE attempt_id = ?',
  );
  let cursor = '';
  for (;;) {
    const rows = page.all(cursor) as Array<{ attempt_id: string; record_json: string }>;
    if (rows.length === 0) return;
    for (const row of rows) {
      let narrowed: string;
      try {
        narrowed = JSON.stringify(
          projectModelCallPricingRecord(decodeModelCallAttempt(JSON.parse(row.record_json))),
        );
      } catch {
        // Already narrow, or corrupt. Neither is rewritable from itself, and a
        // corrupt row must survive to be reported by a read rather than dropped.
        continue;
      }
      if (narrowed !== row.record_json) update.run(narrowed, row.attempt_id);
    }
    cursor = rows[rows.length - 1]?.attempt_id ?? cursor;
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
