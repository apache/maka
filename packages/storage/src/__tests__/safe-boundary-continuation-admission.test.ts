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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { migrateSqliteCoreExecutionDatabase } from '../sqlite-core-execution-schema.js';

test('core execution migration preserves databases with historical continuation forks', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE core_root_turn_admissions (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        admitted_at INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );
    `);
    const insert = database.prepare(`
      INSERT INTO core_root_turn_admissions(session_id, turn_id, admitted_at, record_json)
      VALUES (?, ?, ?, ?)
    `);
    for (const [turnId, admittedAt] of [
      ['continuation-a', 20],
      ['continuation-b', 30],
    ] as const) {
      insert.run(
        'session',
        turnId,
        admittedAt,
        JSON.stringify({
          sessionId: 'session',
          turnId,
          execution: {
            kind: 'safe_boundary_continuation',
            sourceTurnId: 'source-turn',
            sourceRunId: 'source-run',
          },
        }),
      );
    }

    assert.doesNotThrow(() => migrateSqliteCoreExecutionDatabase(database));
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM core_root_turn_admissions').get()?.count,
      2,
    );
  } finally {
    database.close();
  }
});

test('safe-boundary continuation admission is indexed by its source execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-continuation-admission-'));
  try {
    const store = createSqliteAgentRunStore(root);
    const origin = await store.admitRootTurn({
      sessionId: 'session',
      turnId: 'source-turn',
      proposedRunId: 'source-run',
      proposedUserMessageId: 'source-message',
      execution: { kind: 'external_message' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Start work' },
      sourceMessages: [],
      admittedAt: 10,
    });
    assert.equal(origin.kind, 'admitted');
    const continuation = await store.admitRootTurn({
      sessionId: 'session',
      turnId: 'continuation-turn',
      proposedRunId: 'continuation-run',
      proposedUserMessageId: null,
      execution: {
        kind: 'safe_boundary_continuation',
        sourceInvocationId: 'source-invocation',
        sourceRunId: 'source-run',
        sourceTurnId: 'source-turn',
        sourceRuntimeEventHighWater: 7,
        claimId: 'continuation-claim',
        boundaryDigest: `sha256:${'a'.repeat(64)}`,
        providerReplayDigest: `sha256:${'b'.repeat(64)}`,
        safetyDigest: `sha256:${'c'.repeat(64)}`,
        targetInvocationId: 'continuation-invocation',
      },
      previousRootTurnId: 'source-turn',
      normalizedInput: null,
      sourceMessages: [],
      admittedAt: 20,
    });
    assert.equal(continuation.kind, 'admitted');
    await assert.rejects(
      store.admitRootTurn({
        sessionId: 'session',
        turnId: 'competing-continuation-turn',
        proposedRunId: 'competing-continuation-run',
        proposedUserMessageId: null,
        execution: {
          kind: 'safe_boundary_continuation',
          sourceInvocationId: 'source-invocation',
          sourceRunId: 'source-run',
          sourceTurnId: 'source-turn',
          sourceRuntimeEventHighWater: 7,
          claimId: 'competing-continuation-claim',
          boundaryDigest: `sha256:${'d'.repeat(64)}`,
          providerReplayDigest: `sha256:${'e'.repeat(64)}`,
          safetyDigest: `sha256:${'f'.repeat(64)}`,
          targetInvocationId: 'competing-continuation-invocation',
        },
        previousRootTurnId: 'source-turn',
        normalizedInput: null,
        sourceMessages: [],
        admittedAt: 30,
      }),
      /already has continuation continuation-turn/,
    );

    assert.deepEqual(
      await store.readRootTurnContinuationAdmission('session', 'source-turn', 'source-run'),
      continuation.admission,
    );
    assert.equal(
      await store.readRootTurnContinuationAdmission('session', 'source-turn', 'other-run'),
      undefined,
    );
    store.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
