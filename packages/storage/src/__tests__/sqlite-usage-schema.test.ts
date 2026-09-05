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
import {
  MODEL_CALL_NOW as NOW,
  MODEL_CALL_PRICING_ROW_KEYS,
  storedModelCallRecord as storedRecord,
  wideModelCallAttempt as wideAttempt,
} from './fixtures/model-call-attempt.js';

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

test('usage migration narrows ledger rows to the fields a cost answer reads', () => {
  const database = new DatabaseSync(':memory:');
  try {
    migrateSqliteUsageDatabase(database);
    const wide = wideAttempt();
    const insert = database.prepare(`
      INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json, session_id)
      VALUES (?, ?, ?, ?)
    `);
    insert.run(wide.attemptId, wide.completedAt, JSON.stringify(wide), wide.sessionId);
    insert.run('corrupt', NOW - 400, '{"schemaVersion":1,', 'session-1');
    const wideBytes = recordBytes(database, wide.attemptId);

    migrateSqliteUsageDatabase(database);

    const narrowed = storedRecord(database, wide.attemptId);
    assert.deepEqual(Object.keys(narrowed).sort(), MODEL_CALL_PRICING_ROW_KEYS);
    // Every number a Usage total is built from reads the same after the fold.
    assert.equal(narrowed.costUsd, 0.004);
    assert.equal(narrowed.inputTokens, 100);
    assert.equal(narrowed.outputTokens, 20);
    assert.equal(narrowed.costBasis, 'priced');
    assert.ok(recordBytes(database, wide.attemptId) < wideBytes / 10);
    // A corrupt row is not rewritable from itself and must stay, so a read can
    // keep reporting it instead of a total quietly losing a real call.
    assert.equal(
      database
        .prepare("SELECT record_json FROM usage_model_call_attempts WHERE attempt_id = 'corrupt'")
        .get()?.record_json,
      '{"schemaVersion":1,',
    );
  } finally {
    database.close();
  }
});

test('usage migration leaves an already narrowed ledger row untouched', () => {
  const database = new DatabaseSync(':memory:');
  try {
    migrateSqliteUsageDatabase(database);
    const wide = wideAttempt();
    database
      .prepare(`
        INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json, session_id)
        VALUES (?, ?, ?, ?)
      `)
      .run(wide.attemptId, wide.completedAt, JSON.stringify(wide), wide.sessionId);
    migrateSqliteUsageDatabase(database);
    const once = storedRecord(database, wide.attemptId);

    migrateSqliteUsageDatabase(database);

    assert.deepEqual(storedRecord(database, wide.attemptId), once);
  } finally {
    database.close();
  }
});

test('usage migration narrows every row, not just the first page', () => {
  const database = new DatabaseSync(':memory:');
  try {
    migrateSqliteUsageDatabase(database);
    const insert = database.prepare(`
      INSERT INTO usage_model_call_attempts(attempt_id, completed_at, record_json, session_id)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < 1_200; index += 1) {
      const wide = wideAttempt({ attemptId: `attempt-${String(index).padStart(5, '0')}` });
      insert.run(wide.attemptId, wide.completedAt, JSON.stringify(wide), wide.sessionId);
    }

    migrateSqliteUsageDatabase(database);

    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_model_call_attempts WHERE record_json LIKE '%requestObservation%'",
        )
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

function recordBytes(database: DatabaseSync, attemptId: string): number {
  return Number(
    database
      .prepare(
        'SELECT length(record_json) AS bytes FROM usage_model_call_attempts WHERE attempt_id = ?',
      )
      .get(attemptId)?.bytes ?? 0,
  );
}
