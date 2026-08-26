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
import type { RootExecutionDescriptor } from '@maka/core/agent-run';
import { createSqliteAgentRunStore } from '../agent-run-store.js';

test('WorkHub Coordination admission preserves its bounded content identity across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-admission-'));
  const inputDigest = `sha256:${'a'.repeat(64)}` as const;
  try {
    const store = createSqliteAgentRunStore(root);
    const admitted = await store.admitRootTurn({
      sessionId: 'coordination-session',
      turnId: 'coordination-turn',
      proposedRunId: 'coordination-run',
      proposedUserMessageId: 'coordination-message',
      execution: { kind: 'workhub_coordination', inputDigest },
      previousRootTurnId: null,
      normalizedInput: { text: 'What should happen next?' },
      sourceMessages: [],
      admittedAt: 50,
    });
    assert.equal(admitted.kind, 'admitted');
    store.close?.();

    const reopened = createSqliteAgentRunStore(root);
    assert.deepEqual(
      await reopened.readRootTurnAdmission('coordination-session', 'coordination-turn'),
      admitted.admission,
    );
    await assert.rejects(
      () =>
        reopened.admitRootTurn({
          sessionId: 'coordination-session',
          turnId: 'invalid-coordination-turn',
          proposedRunId: 'invalid-coordination-run',
          proposedUserMessageId: 'invalid-coordination-message',
          execution: {
            kind: 'workhub_coordination',
            inputDigest: 'sha256:not-a-digest',
          } as RootExecutionDescriptor,
          previousRootTurnId: 'coordination-turn',
          normalizedInput: { text: 'Invalid identity' },
          sourceMessages: [],
          admittedAt: 60,
        }),
      /Invalid root execution descriptor/u,
    );
    reopened.close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
