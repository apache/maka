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
import { sendReceiptFailure } from '../../../../plugins/agent/conversations/ui/sendReceipt.ts';

const recorded = (outcome) => ({ kind: 'recorded', outcome, cleanup: { kind: 'confirmed' } });

test('a Host handler failure displays its reason without offering an unsafe retry', () => {
  const result = { kind: 'failure', diagnostic: 'agent_execution_unavailable' };
  assert.deepEqual(sendReceiptFailure(recorded({ kind: 'returned', result })), {
    detail: { key: 'Send failed: {reason}', values: { reason: 'agent_execution_unavailable' } },
    retryable: false,
  });
});

test('a rejected send keeps its reason and can be retried', () => {
  const result = {
    kind: 'success',
    value: { kind: 'rejected', sessionId: 'conversation', reason: 'model_unavailable' },
  };
  assert.deepEqual(sendReceiptFailure(recorded({ kind: 'returned', result })), {
    detail: {
      key: 'The selected model is unavailable. Try again or choose another model.',
      values: undefined,
    },
    retryable: true,
  });
});

test('an unknown outcome supplies no definitive send failure', () => {
  assert.equal(
    sendReceiptFailure(recorded({ kind: 'unknown', diagnostic: 'connection lost' })),
    null,
  );
});
