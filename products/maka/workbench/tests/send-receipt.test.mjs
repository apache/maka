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
import {
  sendReceiptFailure,
  shouldHideAcceptedQueuedStatus,
  shouldProjectPendingSend,
} from '../../../../plugins/agent/conversations/ui/sendReceipt.ts';

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

test('a run that is still unsettled produces a definitive send failure', () => {
  const result = {
    kind: 'success',
    value: { kind: 'rejected', sessionId: 'conversation', reason: 'original_operation_unsettled' },
  };
  assert.deepEqual(sendReceiptFailure(recorded({ kind: 'returned', result })), {
    detail: {
      key: 'Message was not sent because the previous run is unsettled. Your message is kept.',
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

test('idle queued sends project immediately into the transcript while followups stay in the dock', () => {
  assert.equal(
    shouldProjectPendingSend({ kind: 'queued' }, { immediate: true, activeRunId: null }),
    true,
  );
  assert.equal(
    shouldProjectPendingSend({ kind: 'queued' }, { immediate: false, activeRunId: 'run-1' }),
    false,
  );
  assert.equal(
    shouldProjectPendingSend({ kind: 'queued' }, { immediate: true, activeRunId: 'run-1' }),
    false,
  );
  assert.equal(
    shouldProjectPendingSend({ kind: 'started' }, { immediate: false, activeRunId: 'run-1' }),
    true,
  );
});

test('accepted queued sends already visible in transcript or followups hide transient dock status', () => {
  const base = {
    failed: false,
    detail: undefined,
    delivery: 'accepted',
    messageId: 'msg-1',
    followups: new Set(),
    inTranscript: (id) => id === 'msg-1',
  };
  assert.equal(shouldHideAcceptedQueuedStatus(base), true);
  assert.equal(shouldHideAcceptedQueuedStatus({ ...base, delivery: 'unknown' }), false);
  assert.equal(shouldHideAcceptedQueuedStatus({ ...base, failed: true }), false);
  assert.equal(
    shouldHideAcceptedQueuedStatus({
      ...base,
      inTranscript: () => false,
      followups: new Set(['msg-1']),
    }),
    true,
  );
  assert.equal(shouldHideAcceptedQueuedStatus({ ...base, inTranscript: () => false }), false);
});
