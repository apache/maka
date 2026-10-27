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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { resolveContinuationHeadAnchor } from '../history-compact-head-anchor.js';
import { testInvocationRecord } from './invocation-fixture.js';

function fixture() {
  const original = testInvocationRecord({
    sessionId: 'session',
    invocationId: 'invocation-original',
    runId: 'run-original',
    turnId: 'turn-original',
  });
  const source = {
    sourceInvocationId: original.invocationId,
    sourceRunId: original.runId,
    sourceTurnId: original.turnId,
    sourceRuntimeEventHighWater: 3,
  };
  const resumed = testInvocationRecord({
    sessionId: 'session',
    invocationId: 'invocation-resumed',
    runId: 'run-resumed',
    turnId: 'turn-resumed',
    opening: { source: { kind: 'continuation', ...source } },
  });
  const anchor: RuntimeEvent = {
    id: 'anchor',
    sessionId: 'session',
    invocationId: original.invocationId,
    runId: original.runId,
    turnId: original.turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'Original task', displayText: 'Shown task' },
  };
  return {
    sessionId: 'session',
    continuation: {
      sourceInvocationId: resumed.invocationId,
      sourceRunId: resumed.runId,
      sourceTurnId: resumed.turnId,
      sourceRuntimeEventHighWater: 3,
    },
    runtimeContext: [anchor],
    invocations: [original, resumed],
  };
}

test('a repeated continuation resolves the exact original user event, skipping steering', () => {
  const input = fixture();
  const anchor = input.runtimeContext[0]!;
  input.runtimeContext.push({
    ...anchor,
    id: 'steering',
    invocationId: 'invocation-resumed',
    runId: 'run-resumed',
    turnId: 'turn-resumed',
    content: { kind: 'text', text: 'Keep going', steering: true },
  });
  assert.equal(resolveContinuationHeadAnchor(input), anchor);
});

test('missing and cyclic continuation ancestry cannot borrow a historical prompt', () => {
  const missing = fixture();
  missing.invocations.shift();
  assert.equal(resolveContinuationHeadAnchor(missing), undefined);

  const cyclic = fixture();
  cyclic.invocations[0]!.opening.source = { kind: 'continuation', ...cyclic.continuation };
  assert.equal(resolveContinuationHeadAnchor(cyclic), undefined);
});

test('continuation ancestry must match session, run and turn identities', () => {
  for (const field of ['sessionId', 'runId', 'turnId'] as const) {
    const input = fixture();
    input.invocations[0]![field] = 'unrelated';
    assert.equal(resolveContinuationHeadAnchor(input), undefined, field);
  }
});

test('an unrelated newer task or a missing original event cannot substitute for the anchor', () => {
  const input = fixture();
  const anchor = input.runtimeContext[0]!;
  input.runtimeContext.push({
    ...anchor,
    id: 'another-task',
    invocationId: 'other',
    runId: 'other',
    turnId: 'other',
  });
  assert.equal(resolveContinuationHeadAnchor(input), undefined);
  input.runtimeContext.shift();
  assert.equal(resolveContinuationHeadAnchor(input), undefined);
});

test('steering, hidden or partial events cannot become the task anchor', () => {
  for (const patch of [
    { content: { kind: 'text', text: 'Steering only', steering: true } },
    { partial: true },
    { modelVisibility: 'hidden' },
  ] satisfies Partial<RuntimeEvent>[]) {
    const input = fixture();
    input.runtimeContext[0] = { ...input.runtimeContext[0]!, ...patch };
    assert.equal(resolveContinuationHeadAnchor(input), undefined);
  }
});

// Host handoffs keep the same logical turn while changing the physical run.
for (const author of ['user', 'host'] as const) {
  test(`a same-turn handoff preserves its original ${author} task anchor`, () => {
    const input = fixture();
    const original = input.invocations[0]!;
    const resumed = input.invocations[1]!;
    resumed.turnId = original.turnId;
    resumed.opening.source = {
      ...resumed.opening.source,
      kind: 'handoff',
      rootRunId: original.runId,
      sourceInvocationId: original.invocationId,
      sourceRunId: original.runId,
      sourceTurnId: original.turnId,
      sourceRuntimeEventHighWater: 3,
      claimId: 'handoff-claim',
      boundaryDigest: `sha256:${'0'.repeat(64)}`,
    };
    input.continuation.sourceTurnId = original.turnId;
    const anchor = input.runtimeContext[0]!;
    anchor.author = author;
    input.runtimeContext.push({
      ...anchor,
      id: 'handoff-step',
      invocationId: resumed.invocationId,
      runId: resumed.runId,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'Completed before handoff' },
    });
    assert.equal(resolveContinuationHeadAnchor(input), anchor);
  });
}
