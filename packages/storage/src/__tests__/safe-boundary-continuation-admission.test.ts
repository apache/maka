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
import { test } from 'node:test';
import { createSqliteAgentRunStore } from '../agent-run-store.js';

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
