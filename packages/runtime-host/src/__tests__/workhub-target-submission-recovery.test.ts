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
import test from 'node:test';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { ROOT_TURN_ADMISSION_SCHEMA_VERSION } from '@maka/storage/agent-run-store';
import type { WorkHubSubmissionRecoveryStores } from '../server/workhub-target-submission-recovery.js';
import { recoverWorkHubTargetSubmission } from '../server/workhub-target-submission-recovery.js';

test('recovers a handed-off steering submission from its immutable proof', async () => {
  const text = 'Continue payment work';
  const event = {
    id: 'steering-event',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'payment',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text, steering: true },
    refs: { providerEventId: 'message-1' },
  } satisfies RuntimeEvent;
  const stores = {
    readRootTurnSourceMessageReceipt: async () => undefined,
    readMessageAdmission: async () => undefined,
    readRootTurnAdmission: async () => undefined,
    readImmutableSteeringMessageProof: async () => ({ event }),
  } satisfies WorkHubSubmissionRecoveryStores;

  assert.deepEqual(
    await recoverWorkHubTargetSubmission(stores, {
      sessionId: 'payment',
      messageId: 'message-1',
      text,
    }),
    { turnId: 'turn-1', steered: true },
  );
});

test('recovers only a matching pending steering admission', async () => {
  const text = 'Continue payment work';
  const content = normalizeMessageContent({ text });
  const admission = {
    sessionId: 'payment',
    turnId: 'turn-1',
    runId: 'run-1',
    messageId: 'message-1',
    content,
    submittedContentDigest: messageContentDigest(content),
    submittedPlacement: 'current_turn' as const,
    placement: 'current_turn' as const,
    disposition: 'steering' as const,
    admittedAt: 1,
  };
  const stores = {
    readRootTurnSourceMessageReceipt: async () => undefined,
    readMessageAdmission: async () => admission,
    readRootTurnAdmission: async () => ({
      schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
      sessionId: 'payment',
      turnId: 'turn-1',
      runId: 'run-1',
      userMessageId: 'message-1',
      execution: { kind: 'external_message' },
      previousRootTurnId: null,
      normalizedInput: content,
      sourceMessages: [],
      admittedAt: 1,
    }),
    readImmutableSteeringMessageProof: async () => undefined,
  } satisfies WorkHubSubmissionRecoveryStores;

  assert.deepEqual(
    await recoverWorkHubTargetSubmission(stores, {
      sessionId: 'payment',
      messageId: 'message-1',
      text,
    }),
    { turnId: 'turn-1', steered: true },
  );
  assert.equal(
    await recoverWorkHubTargetSubmission(
      { ...stores, readMessageAdmission: async () => ({ ...admission, disposition: 'followup' }) },
      { sessionId: 'payment', messageId: 'message-1', text },
    ),
    undefined,
  );
});
