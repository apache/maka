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
  modelCallAttempt as attempt,
  wideModelCallAttempt as wideAttempt,
} from './fixtures/model-call-attempt.js';
import { MODEL_CALL_COLUMNS } from '../sqlite-usage-schema.js';

/** A ledger as it stood before the record was spread into columns. */
function blobLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE usage_model_call_attempts (
      attempt_id TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      session_id TEXT
    );
  `);
}

function insertBlob(
  database: DatabaseSync,
  attemptId: string,
  record: unknown,
  sessionId?: string,
) {
  database
    .prepare('INSERT INTO usage_model_call_attempts VALUES (?, ?, ?, ?)')
    .run(
      attemptId,
      NOW - 500,
      typeof record === 'string' ? record : JSON.stringify(record),
      sessionId ?? null,
    );
}

function storedRow(database: DatabaseSync, attemptId: string): Record<string, unknown> {
  return database
    .prepare('SELECT * FROM usage_model_call_attempts WHERE attempt_id = ?')
    .get(attemptId) as Record<string, unknown>;
}

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

test('the migration spreads a stored record into the columns a cost answer sums', () => {
  const database = new DatabaseSync(':memory:');
  try {
    blobLedger(database);
    const wide = wideAttempt();
    insertBlob(database, wide.attemptId, wide, wide.sessionId);

    migrateSqliteUsageDatabase(database);

    const row = storedRow(database, wide.attemptId);
    assert.deepEqual(Object.keys(row), [...MODEL_CALL_COLUMNS]);
    // Every number a Usage total is built from reads the same after the spread.
    assert.equal(row.cost_usd, 0.004);
    assert.equal(row.cost_basis, 'priced');
    assert.equal(row.input_tokens, 100);
    assert.equal(row.output_tokens, 20);
    assert.equal(row.provider_id, 'anthropic');
    assert.equal(row.session_id, 'session-1');
  } finally {
    database.close();
  }
});

test('a record the migration cannot read whole keeps its identity and loses the rest', () => {
  // A row that ends up half-filled would make the table's own CHECK
  // unsatisfiable and take the whole migration with it, so conversion is
  // all-or-nothing per row. What is left says a call happened and its cost is
  // gone — which is what a read reports as unreadable.
  const database = new DatabaseSync(':memory:');
  try {
    blobLedger(database);
    insertBlob(database, 'damaged', '{"schemaVersion":1,', 'session-1');
    insertBlob(database, 'alien', { sessionId: 'session-2' });
    const priced = attempt({ attemptId: 'priced' });
    insertBlob(database, priced.attemptId, priced, priced.sessionId);

    migrateSqliteUsageDatabase(database);

    assert.deepEqual(
      database
        .prepare(
          'SELECT attempt_id, session_id FROM usage_model_call_attempts WHERE cost_basis IS NULL ORDER BY attempt_id',
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { attempt_id: 'alien', session_id: 'session-2' },
        { attempt_id: 'damaged', session_id: 'session-1' },
      ],
    );
    assert.equal(storedRow(database, 'priced').cost_usd, 0.004);
  } finally {
    database.close();
  }
});

test('the migration is a no-op once the ledger already holds columns', () => {
  const database = new DatabaseSync(':memory:');
  try {
    blobLedger(database);
    const wide = wideAttempt();
    insertBlob(database, wide.attemptId, wide, wide.sessionId);
    migrateSqliteUsageDatabase(database);
    const once = storedRow(database, wide.attemptId);

    migrateSqliteUsageDatabase(database);

    assert.deepEqual(storedRow(database, wide.attemptId), once);
  } finally {
    database.close();
  }
});

test('the migration converts every row, however many a workspace holds', () => {
  const database = new DatabaseSync(':memory:');
  try {
    blobLedger(database);
    for (let index = 0; index < 1_200; index += 1) {
      const row = attempt({ attemptId: `attempt-${String(index).padStart(5, '0')}` });
      insertBlob(database, row.attemptId, row, row.sessionId);
    }

    migrateSqliteUsageDatabase(database);

    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM usage_model_call_attempts WHERE cost_basis IS NULL')
        .get()?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test('the ledger refuses a row that would make a total dishonest', () => {
  const database = new DatabaseSync(':memory:');
  try {
    migrateSqliteUsageDatabase(database);
    const insert = (values: Record<string, unknown>) => {
      const columns = Object.keys(values);
      database
        .prepare(
          `INSERT INTO usage_model_call_attempts(${columns.join(', ')}) VALUES (${columns
            .map(() => '?')
            .join(', ')})`,
        )
        .run(...(Object.values(values) as (string | number | null)[]));
    };
    const base = {
      completed_at: NOW,
      logical_call_id: 'call-1',
      turn_id: 'turn-1',
      call_kind: 'main',
      provider_id: 'anthropic',
      model_id: 'claude-opus-5',
      latency_ms: 10,
      status: 'completed',
      usage_basis: 'reported',
    };
    // A price nobody could resolve must never surface as an amount.
    assert.throws(() =>
      insert({ ...base, attempt_id: 'a', cost_basis: 'unpriced', cost_usd: 0.004 }),
    );
    // A priced call must carry one; zero is legal and means genuinely free.
    assert.throws(() => insert({ ...base, attempt_id: 'b', cost_basis: 'priced' }));
    // "No usage reported" and "zero tokens" are different facts.
    assert.throws(() =>
      insert({
        ...base,
        attempt_id: 'c',
        usage_basis: 'missing',
        input_tokens: 0,
        cost_basis: 'priced',
        cost_usd: 0,
      }),
    );
    // Half a record is not a record.
    assert.throws(() => insert({ attempt_id: 'd', completed_at: NOW, cost_basis: 'unpriced' }));
  } finally {
    database.close();
  }
});
