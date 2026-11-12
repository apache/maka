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
  HOST_OPERATION_SPECS,
  decodeSessionEventWaitsProjection,
  decodeSubscriptionFrame,
} from '../protocol/index.js';
const target = {
  sessionId: 'session',
  waitId: 'wait',
  consumer: {
    kind: 'tool_invocation' as const,
    runId: 'run',
    invocationId: 'invocation',
    operationId: 'operation',
  },
};
const projection = {
  ...target,
  sourceTurnId: 'turn',
  resource: { providerId: 'test', resourceType: 'job', resourceId: 'job' },
  deadlineAt: null,
  phase: 'observing',
  observation: 'pending',
  reasonCode: null,
};
test('Session waits support parallel consumers, no deadline and precise cancellation', () => {
  assert.deepEqual(HOST_OPERATION_SPECS['session.event-wait.cancel'].decodeInput(target), target);
  const natural = {
    ...projection,
    waitId: 'natural',
    consumer: {
      kind: 'goal_waiting',
      goalId: 'goal',
      controlGeneration: 1,
      expectedGoalRevision: 4,
    },
  };
  const page = { items: [projection, natural], nextCursor: null };
  assert.deepEqual(decodeSessionEventWaitsProjection(page), page);
  assert.throws(() =>
    decodeSessionEventWaitsProjection({ items: [projection, projection], nextCursor: null }),
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['session.event-wait.cancel'].decodeInput({
      ...target,
      consumer: { kind: 'tool_invocation', runId: 'run' },
    }),
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['session.event-wait.cancel'].decodeInput({
      ...target,
      consumer: { ...target.consumer, goalId: 'goal' },
    }),
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['session.event-waits.query'].decodeOutput({ sessionId: 'other', ...page }),
  );
});
test('Session wait pagination requires an explicit valid cursor and limits projection size', () => {
  assert.deepEqual(
    HOST_OPERATION_SPECS['session.event-waits.query'].decodeInput({
      sessionId: 'session',
      afterWaitId: 'previous',
    }),
    { sessionId: 'session', afterWaitId: 'previous' },
  );
  assert.throws(() =>
    decodeSessionEventWaitsProjection({
      items: Array.from({ length: 65 }, (_, i) => ({ ...projection, waitId: `wait-${i}` })),
      nextCursor: null,
    }),
  );
});

test('event wait invalidations use the sequenced Session domain protocol', () => {
  const frame = {
    kind: 'subscription.session_domain_changed',
    hostEpoch: 'host',
    subscriptionId: 'subscription',
    sequence: 1,
    sessionId: 'session',
    domain: 'event_wait',
  };
  assert.deepEqual(decodeSubscriptionFrame(frame), frame);
  assert.throws(() => decodeSubscriptionFrame({ ...frame, resources: [] }));
});
