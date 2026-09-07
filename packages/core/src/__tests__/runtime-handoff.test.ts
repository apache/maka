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
import { encodeCanonicalRuntimeEvent } from '../canonical-runtime-event.js';
import { test } from 'node:test';
import { decodeRuntimeEvent, isTerminalRuntimeEvent, type RuntimeEvent } from '../runtime-event.js';
import { runtimeInvocationOutcome } from '../runtime-invocation.js';
import { runtimeHandoffPause } from '../runtime-handoff.js';

const paused: RuntimeEvent = {
  id: 'pause',
  invocationId: 'physical-1',
  runId: 'physical-1',
  sessionId: 'session',
  turnId: 'logical-turn',
  ts: 1,
  partial: false,
  role: 'system',
  author: 'host',
  actions: {
    endInvocation: true,
    handoffPause: {
      protocol: 'runtime_handoff_pause_v1',
      handoffId: 'handoff',
      hostEpoch: 'source-host',
      remainingSteps: null,
      rootRunId: 'physical-1',
      successorRunId: 'physical-2',
      successorInvocationId: 'physical-2',
      claimId: 'exact-claim',
    },
  },
};

test('a handoff seals a physical invocation without ending its logical execution', () => {
  const event = decodeRuntimeEvent(paused);
  assert.equal(isTerminalRuntimeEvent(event), true);
  assert.equal(runtimeInvocationOutcome({ terminalEvent: event }), undefined);
  assert.equal(runtimeHandoffPause(event)?.successorRunId, 'physical-2');
  const frozen = Object.freeze({ ...event, actions: Object.freeze({ ...event.actions }) });
  assert.deepEqual(encodeCanonicalRuntimeEvent(frozen).event, event);
});

test('a handoff seal cannot claim completion, carry work, or authorize itself as successor', () => {
  for (const invalid of [
    ...[0, -1, 1.5, undefined, Number.MAX_SAFE_INTEGER + 1].map((remainingSteps) => ({
      ...paused,
      actions: {
        ...paused.actions,
        handoffPause: { ...paused.actions!.handoffPause, remainingSteps },
      },
    })),
    { ...paused, status: 'completed' },
    { ...paused, partial: true },
    { ...paused, content: { kind: 'text', text: 'work' } },
    { ...paused, actions: { ...paused.actions, toolDispatch: {} } },
    { ...paused, actions: { ...paused.actions, endInvocation: false } },
    {
      ...paused,
      actions: {
        ...paused.actions,
        handoffPause: {
          ...paused.actions!.handoffPause,
          successorRunId: paused.runId,
        },
      },
    },
    {
      ...paused,
      actions: {
        ...paused.actions,
        handoffPause: {
          ...paused.actions!.handoffPause,
          unrecognizedAuthority: true,
        },
      },
    },
  ])
    assert.throws(() => decodeRuntimeEvent(invalid));
});
