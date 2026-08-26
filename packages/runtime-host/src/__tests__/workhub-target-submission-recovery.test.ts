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
import type { RuntimeEvent } from '@maka/core/runtime-event';
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
