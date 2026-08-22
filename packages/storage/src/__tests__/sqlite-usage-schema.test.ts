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

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteUsageDatabase } from '../sqlite-usage-schema.js';

test('usage migration backfills Session identity for existing ledger rows', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE usage_llm_calls (
        storage_key TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE usage_model_call_attempts (
        attempt_id TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      INSERT INTO usage_llm_calls(storage_key, id, ts, record_json)
      VALUES ('legacy', 'legacy', 1, '{"sessionId":"session-a"}');
      INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json)
      VALUES ('canonical', 1, '{"sessionId":"session-b"}');
    `);

    migrateSqliteUsageDatabase(database);

    assert.equal(
      database.prepare("SELECT session_id FROM usage_llm_calls WHERE id = 'legacy'").get()
        ?.session_id,
      'session-a',
    );
    assert.equal(
      database
        .prepare("SELECT session_id FROM usage_model_call_attempts WHERE attempt_id = 'canonical'")
        .get()?.session_id,
      'session-b',
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'usage_llm_calls_session_ts'",
        )
        .get(),
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'usage_model_call_attempts_session_completed_at'",
        )
        .get(),
    );
  } finally {
    database.close();
  }
});
