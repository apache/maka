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
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import { migrateSqliteUsageDatabase } from '../sqlite-usage-schema.js';

const NOW = 1_750_000_000_000;

function wideAttempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    startedAt: NOW - 1_000,
    completedAt: NOW - 500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 100,
    outputTokens: 20,
    costBasis: 'priced',
    costUsd: 0.004,
    promptComposition: { segments: [{ kind: 'messages', bytes: 4_096 }] },
    // Sized like the real thing: the request observation is what made a stored
    // row grow with the conversation rather than with spend.
    requestObservation: {
      schemaVersion: 1,
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: 27_817,
      segments: Array.from({ length: 64 }, (_, index) => ({
        kind: 'tool_schema' as const,
        index,
        cacheable: true,
        comparison: 'exact' as const,
        digest: `sha256:${String(index).padStart(64, '0')}`,
        bytes: 434,
        label: `tool-${index}`,
      })),
    },
    providerRequestId: 'req-1',
    httpStatus: 200,
    pricingRevision: 3,
    ...overrides,
  };
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
    assert.deepEqual(Object.keys(narrowed).sort(), [
      'attemptId',
      'callKind',
      'completedAt',
      'costBasis',
      'costUsd',
      'inputTokens',
      'latencyMs',
      'logicalCallId',
      'modelId',
      'outputTokens',
      'providerId',
      'sessionId',
      'status',
      'turnId',
      'usageBasis',
    ]);
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

function storedRecord(database: DatabaseSync, attemptId: string): Record<string, unknown> {
  const row = database
    .prepare('SELECT record_json FROM usage_model_call_attempts WHERE attempt_id = ?')
    .get(attemptId) as { record_json?: string } | undefined;
  return JSON.parse(row?.record_json ?? '{}') as Record<string, unknown>;
}

function recordBytes(database: DatabaseSync, attemptId: string): number {
  return Number(
    database
      .prepare(
        'SELECT length(record_json) AS bytes FROM usage_model_call_attempts WHERE attempt_id = ?',
      )
      .get(attemptId)?.bytes ?? 0,
  );
}
