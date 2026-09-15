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
import { aggregateMessageContents, messageContentDigest } from '@maka/core/events';
import type { RootExecutionDescriptor } from '@maka/core/runtime-invocation';
import { createSqliteAgentRunStore } from '../agent-run-store.js';

for (const actionId of [undefined, 'stable-action']) {
  test(`WorkHub Coordination admission preserves its bounded content identity across restart (${actionId ?? 'legacy'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-admission-'));
    const inputDigest = `sha256:${'a'.repeat(64)}` as const;
    try {
      const store = createSqliteAgentRunStore(root);
      const admitted = await store.admitRootTurn({
        sessionId: 'coordination-session',
        turnId: 'coordination-turn',
        proposedRunId: 'coordination-run',
        proposedUserMessageId: 'coordination-message',
        execution: {
          kind: 'workhub_coordination',
          inputDigest,
          capabilityBinding: `sha256:${'b'.repeat(64)}`,
          ...(actionId ? { operation: 'action' as const, actionId } : {}),
          ...(!actionId
            ? {
                routingDecision: {
                  kind: 'routing' as const,
                  disposition: 'delegate_existing' as const,
                  candidateSetId: `sha256:${'b'.repeat(64)}`,
                  candidateRef: 'whc_candidate_a',
                },
              }
            : {}),
        },
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
}

for (const count of [1, 3]) {
  test(`WorkHub queued source admission survives restart (${count} messages) and cannot authorize an action root`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-queued-admission-'));
    let store = createSqliteAgentRunStore(root);
    try {
      const sourceMessages = Array.from({ length: count }, (_, index) => ({
        messageId: `message-${index}`,
        content: { text: `request ${index}` },
        placement: count === 1 ? ('next_turn' as const) : ('current_turn' as const),
        disposition: count === 1 ? ('followup' as const) : ('steering' as const),
      }));
      const normalizedInput = aggregateMessageContents(
        sourceMessages.map((source) => source.content),
      );
      const input = {
        sessionId: 'coordination-session',
        turnId: 'queued-turn',
        proposedRunId: 'queued-run',
        proposedUserMessageId: count === 1 ? sourceMessages[0]!.messageId : null,
        execution: {
          kind: 'workhub_coordination' as const,
          inputDigest: messageContentDigest(normalizedInput),
        },
        previousRootTurnId: null,
        normalizedInput,
        sourceMessages,
        admittedAt: 50,
      };
      const admitted = await store.admitRootTurn(input);
      store.close?.();
      store = createSqliteAgentRunStore(root);
      assert.deepEqual(
        await store.readRootTurnAdmission(input.sessionId, input.turnId),
        admitted.admission,
      );
      await assert.rejects(
        () =>
          store.admitRootTurn({
            ...input,
            turnId: 'invalid-action',
            proposedUserMessageId: 'action-message',
            execution: { ...input.execution, operation: 'action', actionId: 'action' },
          }),
        /host-authored execution cannot have source messages/,
      );
    } finally {
      store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
}
