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
import { test } from 'node:test';
import {
  decodeConsumerEventWaitRecord,
  decodeAnyEventWaitRecord,
  decodeEventWaitRecord,
  assertAnyEventWaitTransition,
  EVENT_WAIT_LIMITS,
  type ConsumerEventWaitRecord,
  type ConsumerEventWaitObservation,
} from '../event-wait.js';
function waiting(): ConsumerEventWaitRecord {
  return {
    schemaVersion: 2,
    waitId: 'wait',
    sessionId: 'session',
    sourceTurnId: 'turn',
    consumer: {
      kind: 'tool_invocation',
      runId: 'run',
      invocationId: 'invocation',
      operationId: 'operation',
      toolCallId: 'tool-call',
    },
    resource: { providerId: 'test', connectionId: null, resourceType: 'job', resourceId: 'job' },
    condition: { typeId: 'terminal', version: 1, parameters: {} },
    deadlineAt: null,
    createdAt: 10,
    updatedAt: 10,
    deliveryKey: 'event-wait/wait',
    status: 'waiting',
  };
}
function observation(attempts = 1): ConsumerEventWaitObservation {
  return {
    schemaVersion: 2,
    window: 0,
    attempts,
    lastAttemptAt: 10,
    lastObservedAt: null,
    nextObserveAt: 10,
    nextPollAt: 10,
    consecutiveErrors: 0,
    outcome: 'checking',
    cursor: null,
    eventKey: null,
    reason: null,
  };
}
test('v2 has no fabricated tool identity for natural Goal waiting and no implicit deadline', () => {
  const tool = waiting();
  assert.deepEqual(decodeAnyEventWaitRecord(tool), tool);
  assert.throws(() => decodeEventWaitRecord(tool));
  const goal = {
    ...tool,
    consumer: {
      kind: 'goal_waiting',
      sourceRunId: 'run',
      completionEventId: 'done',
      goalControlLease: { goalId: 'goal', generation: 0 },
      goalRevision: 1,
    },
  };
  assert.deepEqual(decodeConsumerEventWaitRecord(goal), goal);
  assert.throws(() => decodeConsumerEventWaitRecord({ ...goal, sourceToolCallId: 'fake' }));
  assert.throws(() =>
    decodeConsumerEventWaitRecord({ ...tool, consumer: { ...tool.consumer, extra: true } }),
  );
  assert.throws(() => decodeAnyEventWaitRecord({ ...tool, schemaVersion: 3 }));
});
test('v2 can register after its original deadline but cannot expire absent one', () => {
  const w = waiting();
  const late = { ...w, deadlineAt: 5 };
  assert.deepEqual(decodeConsumerEventWaitRecord(late), late);
  assertAnyEventWaitTransition(late, { ...late, status: 'expired', expiredAt: 10 });
  assert.throws(() => decodeConsumerEventWaitRecord({ ...w, status: 'expired', expiredAt: 10 }));
  assertAnyEventWaitTransition(w, {
    ...w,
    status: 'resolved',
    resolvedAt: 10,
    resolution: { outcome: 'satisfied', observedAt: 10, receiptKey: 'receipt', evidenceRefs: [] },
  });
});
test('v2 reservation rolls exactly one full observation window without resetting its deadline or cursor', () => {
  const w = waiting();
  const before: ConsumerEventWaitRecord = {
    ...w,
    observation: {
      ...observation(EVENT_WAIT_LIMITS.observationAttempts),
      outcome: 'pending',
      lastObservedAt: 10,
      cursor: 'cursor',
    },
  };
  const after: ConsumerEventWaitRecord = {
    ...w,
    updatedAt: 20,
    observation: {
      ...observation(),
      window: 1,
      lastAttemptAt: 20,
      lastObservedAt: 10,
      nextObserveAt: 20,
      nextPollAt: 20,
      cursor: 'cursor',
    },
  };
  assertAnyEventWaitTransition(before, after);
  const unknown: ConsumerEventWaitRecord = {
    ...before,
    observation: {
      ...before.observation!,
      outcome: 'unknown',
      consecutiveErrors: EVENT_WAIT_LIMITS.observationAttempts,
    },
  };
  const checkingUnknown: ConsumerEventWaitRecord = {
    ...after,
    observation: { ...after.observation!, consecutiveErrors: 1 },
  };
  assertAnyEventWaitTransition(unknown, checkingUnknown);
  assert.throws(() => assertAnyEventWaitTransition(unknown, after));
  assert.throws(() => assertAnyEventWaitTransition(before, checkingUnknown));
  for (const bad of [
    { ...after, observation: { ...after.observation!, window: 2 } },
    { ...after, observation: { ...after.observation!, cursor: null } },
    { ...after, deadlineAt: 100 },
    { ...after, observation: { ...after.observation!, attempts: 2 } },
  ])
    assert.throws(() => assertAnyEventWaitTransition(before, bad));
  assert.throws(() =>
    assertAnyEventWaitTransition(w, { ...w, observation: { ...observation(), window: 1 } }),
  );
});
test('v2 consumer and accepted result are immutable and delivery mode is consumer-specific', () => {
  const w = waiting();
  assert.throws(() =>
    assertAnyEventWaitTransition(w, {
      ...w,
      consumer: {
        ...w.consumer,
        kind: 'tool_invocation',
        runId: 'another',
        invocationId: 'another',
        operationId: 'another',
        toolCallId: 'another',
      },
    }),
  );
  const resolved: ConsumerEventWaitRecord = {
    ...w,
    status: 'resolved',
    resolvedAt: 10,
    resolution: {
      outcome: 'satisfied',
      observedAt: 10,
      receiptKey: 'receipt',
      evidenceRefs: ['ref'],
    },
  };
  const consumed: ConsumerEventWaitRecord = {
    ...resolved,
    delivery: {
      kind: 'consumed',
      operationId: 'operation',
      resultEventId: 'result',
      resultDigest: `sha256:${'a'.repeat(64)}`,
      at: 10,
    },
  };
  assertAnyEventWaitTransition(resolved, consumed);
  assert.throws(() => assertAnyEventWaitTransition(consumed, resolved));
  assert.throws(() =>
    decodeConsumerEventWaitRecord({
      ...resolved,
      delivery: { kind: 'admitted', turnId: 'next', runId: 'next', userMessageId: 'next', at: 10 },
    }),
  );
  assert.throws(() =>
    decodeConsumerEventWaitRecord({
      ...consumed,
      delivery: { ...consumed.delivery, operationId: 'another' },
    }),
  );
});
test('new dispatch decoders do not execute version accessors', () => {
  let calls = 0;
  const value = { ...waiting() };
  Object.defineProperty(value, 'schemaVersion', {
    enumerable: true,
    get() {
      calls++;
      return 2;
    },
  });
  assert.throws(() => decodeAnyEventWaitRecord(value));
  assert.equal(calls, 0);
});

test('natural Goal wait cancellation is an admitted diagnostic; neutral observations cannot admit', () => {
  const tool = waiting();
  const cancelled: ConsumerEventWaitRecord = {
    ...tool,
    status: 'cancelled',
    cancelledAt: 10,
    reason: 'user_cancelled',
    consumer: {
      kind: 'goal_waiting',
      sourceRunId: 'run',
      completionEventId: 'completion',
      goalRevision: 1,
      goalControlLease: { goalId: 'goal', generation: 0 },
    },
  };
  const admitted: ConsumerEventWaitRecord = {
    ...cancelled,
    delivery: { kind: 'admitted', turnId: 'next', runId: 'next', userMessageId: 'next', at: 10 },
  };
  assertAnyEventWaitTransition(cancelled, admitted);
  assert.deepEqual(decodeConsumerEventWaitRecord(admitted), admitted);
  const { consumer: _consumer, ...base } = admitted;
  assert.throws(() =>
    decodeEventWaitRecord({
      ...base,
      schemaVersion: 1,
      deadlineAt: 100,
      sourceToolCallId: 'tool',
    }),
  );
  assert.throws(() => decodeConsumerEventWaitRecord({ ...admitted, consumer: tool.consumer }));
});
