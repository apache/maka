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
  buildRuntimeEventModelReplayPlan,
  buildRuntimeEventReplayTimeline,
} from '../model-history.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';

test('model history keeps reused step ids as separate chronological segments', () => {
  const items = buildRuntimeEventModelReplayPlan([
    assistantText('text-a', 'shared-step', 'Text A'),
    assistantText('text-b', 'intervening-step', 'Text B'),
    toolCall('call', 'shared-step'),
    toolResult('result'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).map((entry) => {
      if (entry.kind !== 'assistant_step') return entry.kind;
      return {
        stepId: entry.stepId,
        text: entry.text?.content,
        calls: entry.calls.map(({ call, result }) => ({
          id: call.toolCallId,
          settled: result !== undefined,
        })),
      };
    }),
    [
      { stepId: 'shared-step', text: 'Text A', calls: [] },
      { stepId: 'intervening-step', text: 'Text B', calls: [] },
      { stepId: 'shared-step', text: undefined, calls: [{ id: 'read-1', settled: true }] },
    ],
  );
});

test('model history separates settled legacy calls but keeps overlapping calls together', () => {
  const settledItems = buildRuntimeEventModelReplayPlan([
    toolCall('call-1', undefined, 'read-1'),
    toolResult('result-1', 'read-1', 'first'),
    toolCall('call-2', undefined, 'read-2'),
    toolResult('result-2', 'read-2', 'second'),
  ]).items;
  const overlappingItems = buildRuntimeEventModelReplayPlan([
    toolCall('call-1', undefined, 'read-1'),
    toolCall('call-2', undefined, 'read-2'),
    toolResult('result-1', 'read-1', 'first'),
    toolResult('result-2', 'read-2', 'second'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(settledItems).map((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ call }) => call.toolCallId) : [],
    ),
    [['read-1'], ['read-2']],
  );
  assert.deepEqual(
    buildRuntimeEventReplayTimeline(overlappingItems).map((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ call }) => call.toolCallId) : [],
    ),
    [['read-1', 'read-2']],
  );
});

test('model history pairs reused tool call ids by durable occurrence', () => {
  const items = buildRuntimeEventModelReplayPlan([
    toolCall('call-1', 'step-1'),
    toolResult('result-1', 'read-1', 'first'),
    toolCall('call-2', 'step-2'),
    toolResult('result-2', 'read-1', 'second'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).flatMap((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ result }) => result?.output) : [],
    ),
    ['first', 'second'],
  );
});

test('model history does not pair an orphan result with a later reused call id', () => {
  const items = buildRuntimeEventModelReplayPlan([
    toolResult('orphan-result', 'read-1', 'orphan'),
    toolCall('call', 'step-1'),
    toolResult('matching-result', 'read-1', 'matching'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).flatMap((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ result }) => result?.output) : [],
    ),
    ['matching'],
  );
});

test('model history scopes reused tool call ids to their invocation', () => {
  const callA = inInvocation(toolCall('call-a', 'shared-step'), 'a');
  const callB = inInvocation(toolCall('call-b', 'shared-step'), 'b');
  const resultB = inInvocation(toolResult('result-b', 'read-1', 'second'), 'b');

  const plan = buildRuntimeEventModelReplayPlan([callA, callB, resultB]);

  assert.deepEqual(
    plan.diagnostics
      .filter(({ code }) => code === 'unmatched_tool_call')
      .map(({ eventId }) => eventId),
    ['call-a'],
  );
  assert.deepEqual(
    buildRuntimeEventReplayTimeline(plan.items).flatMap((entry) =>
      entry.kind === 'assistant_step'
        ? entry.calls.map(({ call, result }) => ({
            call: call.eventId,
            result: result?.eventId,
          }))
        : [],
    ),
    [{ call: 'call-b', result: 'result-b' }],
  );
});

test('model history keeps reused step ids separate across invocations', () => {
  const textA = inInvocation(assistantText('text-a', 'shared-step', 'First invocation text'), 'a');
  const callB = inInvocation(toolCall('call-b', 'shared-step'), 'b');
  const resultB = inInvocation(toolResult('result-b'), 'b');

  const items = buildRuntimeEventModelReplayPlan([textA, callB, resultB]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).map((entry) => {
      if (entry.kind !== 'assistant_step') return entry.kind;
      return {
        text: entry.text?.eventId,
        calls: entry.calls.map(({ call }) => call.eventId),
      };
    }),
    [
      { text: 'text-a', calls: [] },
      { text: undefined, calls: ['call-b'] },
    ],
  );
});

function inInvocation(event: RuntimeEvent, suffix: string): RuntimeEvent {
  return {
    ...event,
    invocationId: `invocation-${suffix}`,
    runId: `run-${suffix}`,
    turnId: `turn-${suffix}`,
  };
}

function assistantText(id: string, stepId: string, text: string): RuntimeEvent {
  return event({
    id,
    role: 'model',
    author: 'agent',
    refs: { providerEventId: stepId },
    content: { kind: 'text', text },
  });
}

function toolCall(id: string, stepId?: string, toolCallId = 'read-1'): RuntimeEvent {
  return event({
    id,
    role: 'model',
    author: 'agent',
    refs: stepId ? { stepId } : undefined,
    content: {
      kind: 'function_call',
      id: toolCallId,
      name: 'Read',
      args: { path: 'notes.md' },
    },
  });
}

function toolResult(id: string, toolCallId = 'read-1', result = 'contents'): RuntimeEvent {
  return event({
    id,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: toolCallId,
      name: 'Read',
      result,
    },
  });
}

function event(
  input: Pick<RuntimeEvent, 'id' | 'role' | 'author' | 'content'> &
    Partial<Pick<RuntimeEvent, 'refs'>>,
): RuntimeEvent {
  return {
    ...input,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
  };
}
