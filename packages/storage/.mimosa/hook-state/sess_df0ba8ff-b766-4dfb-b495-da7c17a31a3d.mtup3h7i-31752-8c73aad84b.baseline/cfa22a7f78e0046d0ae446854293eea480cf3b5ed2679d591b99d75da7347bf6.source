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
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import {
  AgentGraphIntentClaimConflictError,
  createSqliteSessionMetadataStore,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from '../sqlite-session-metadata-store.js';

describe('SQLite agent graph intent claims', () => {
  test('atomically allocates one stable activation identity per intent', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: () => 42 });
    try {
      const first = await store.claimAgentGraphIntent(request());
      const retry = await store.claimAgentGraphIntent(
        request({ targetTurnId: 'discarded-turn', targetRunId: 'discarded-run' }),
      );
      assert.equal(first.created, true);
      assert.equal(retry.created, false);
      assert.deepEqual(retry.claim, first.claim);
      assert.equal(retry.claim.targetTurnId, 'turn-next');
      assert.equal(retry.claim.targetRunId, 'run-next');
      assert.deepEqual(await store.readAgentGraphIntentClaim('graph-1', request().intentId), {
        ...request(),
        claimedAt: 42,
      });
      assert.deepEqual(await store.listAgentGraphIntentClaims('graph-1'), [first.claim]);
    } finally {
      store.close();
    }
  });

  test('rejects reused intent and activation identities with different semantics', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    try {
      await store.claimAgentGraphIntent(request());
      await assert.rejects(
        store.claimAgentGraphIntent(request({ intentFingerprint: `sha256:${'e'.repeat(64)}` })),
        AgentGraphIntentClaimConflictError,
      );
      await assert.rejects(
        store.claimAgentGraphIntent(
          request({
            claimId: `graph_claim_${'f'.repeat(32)}`,
            intentId: `graph_intent_${'e'.repeat(32)}`,
          }),
        ),
        AgentGraphIntentClaimConflictError,
      );
      await assert.rejects(
        store.claimAgentGraphIntent(
          request({
            claimId: `graph_claim_${'1'.repeat(32)}`,
            intentId: `graph_intent_${'2'.repeat(32)}`,
            targetRunId: 'different-run',
          }),
        ),
        AgentGraphIntentClaimConflictError,
      );
      assert.equal((await store.listAgentGraphIntentClaims()).length, 1);
    } finally {
      store.close();
    }
  });

  test('rolls back a claim when the transaction fails before commit', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', {
      failpoint(point) {
        if (point === 'after_agent_graph_intent_claim_write') throw new Error('crash');
      },
    });
    try {
      await assert.rejects(store.claimAgentGraphIntent(request()), /crash/);
      assert.deepEqual(await store.listAgentGraphIntentClaims(), []);
    } finally {
      store.close();
    }
  });

  test('atomically transitions claimed work to executing or cancelled', async () => {
    const store = createSqliteSessionMetadataStore(':memory:', { now: nextNumber(50) });
    try {
      await store.claimAgentGraphIntent(request());
      assert.deepEqual(
        await store.beginAgentGraphIntentExecutionAtScheduleRevision(
          'graph-1',
          request().intentId,
          0,
        ),
        {
          state: 'executing',
          previousState: 'claimed',
          changed: true,
        },
      );
      assert.deepEqual(
        await store.cancelAgentGraphIntentExecution(
          'graph-1',
          request().intentId,
          'Supervisor stopped the work.',
        ),
        {
          state: 'cancelled',
          previousState: 'executing',
          changed: true,
        },
      );
      assert.deepEqual(
        await store.beginAgentGraphIntentExecutionAtScheduleRevision(
          'graph-1',
          request().intentId,
          0,
        ),
        {
          state: 'cancelled',
          previousState: 'cancelled',
          changed: false,
        },
      );
    } finally {
      store.close();
    }
  });
});

function request(
  overrides: Partial<ReturnType<typeof baseRequest>> = {},
): ReturnType<typeof baseRequest> {
  return { ...baseRequest(), ...overrides };
}

function baseRequest() {
  return {
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'summarizer',
    targetSessionId: 'session-child',
    targetTurnId: 'turn-next',
    targetRunId: 'run-next',
  };
}

function nextNumber(start: number): () => number {
  let value = start;
  return () => value++;
}
