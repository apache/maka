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
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildSessionRecapMessages, SESSION_RECAP_INSTRUCTION } from '../session-recap.js';

test('session recap bounds its request to the newest complete turns', () => {
  const events: RuntimeEvent[] = [];
  for (let index = 0; index < 20; index += 1) {
    const turnId = `turn-${index}`;
    events.push(textEvent(`user-${index}`, turnId, 'user', `user-${index} ${'u'.repeat(2_000)}`));
    events.push(
      textEvent(`model-${index}`, turnId, 'model', `model-${index} ${'m'.repeat(2_000)}`),
    );
  }

  const messages = buildSessionRecapMessages({
    events,
    connection: connection(),
    modelId: 'gpt-4',
  });
  const serialized = JSON.stringify(messages);

  assert.equal(serialized.includes('user-0 '), false);
  assert.equal(serialized.includes('model-19 '), true);
  assert.ok(messages.length < events.length + 1);
});

test('session recap keeps bounded evidence from one oversized latest turn', () => {
  const sentinel = 'LATEST-TURN-SENTINEL';
  const messages = buildSessionRecapMessages({
    events: [
      textEvent(
        'latest-user',
        'turn-1',
        'user',
        `${sentinel} ${'oversized context '.repeat(2_000)}`,
      ),
    ],
    connection: connection(),
    modelId: 'gpt-4',
  });
  const serialized = JSON.stringify(messages);

  assert.equal(messages.length, 2);
  assert.equal(serialized.includes(sentinel), true);
  assert.ok(serialized.length <= 13_000);
});

test('session recap includes a concise durable outcome without tool protocol or raw output', () => {
  const oversizedOutput = 'tool-output-sentinel '.repeat(2_000);
  const durableOutcome = 'state.txt says ready=true';
  const messages = buildSessionRecapMessages({
    events: [
      textEvent('latest-user', 'turn-1', 'user', 'Inspect the current state.'),
      toolCallEvent('call-event', 'call-1', 'turn-1'),
      toolResultEvent('result-event', 'call-1', 'turn-1', oversizedOutput, durableOutcome),
    ],
    connection: connection(),
    modelId: 'gpt-4',
  });
  const serialized = JSON.stringify(messages);

  assert.deepEqual(
    messages.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content
            .filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
            .map((part) => ({ type: part.type, toolCallId: part.toolCallId })),
    ),
    [],
  );
  assert.equal(serialized.includes(durableOutcome), true);
  assert.equal(serialized.includes(oversizedOutput), false);
  assert.ok(serialized.length <= 13_000);
});

test('session recap budgets only the evidence it sends', () => {
  const earlierSentinel = 'EARLIER-RECAP-SENTINEL';
  const oversizedArgs = 'tool-args-sentinel '.repeat(4_000);
  const call = toolCallEvent('call-event', 'call-1', 'turn-2');
  const messages = buildSessionRecapMessages({
    events: [
      textEvent('earlier-user', 'turn-1', 'user', earlierSentinel),
      textEvent('latest-user', 'turn-2', 'user', 'Inspect the current state.'),
      {
        ...call,
        content: {
          kind: 'function_call',
          id: 'call-1',
          name: 'Read',
          args: { query: oversizedArgs },
        },
      },
      toolResultEvent('result-event', 'call-1', 'turn-2', 'raw output', 'state is ready'),
    ],
    connection: {
      ...connection(),
      defaultModel: 'declared-16k-model',
      relayModelProfiles: { 'declared-16k-model': { contextWindow: 16_384 } },
    },
    modelId: 'declared-16k-model',
  });
  const serialized = JSON.stringify(messages);

  assert.equal(serialized.includes(earlierSentinel), true);
  assert.equal(serialized.includes(oversizedArgs), false);
});

test('session recap excludes model-hidden tool outcomes', () => {
  const messages = buildSessionRecapMessages({
    events: [
      {
        ...toolResultEvent(
          'hidden-result',
          'nested-call',
          'turn-1',
          'raw nested output',
          'internal nested outcome',
        ),
        modelVisibility: 'hidden',
      },
    ],
    connection: {
      ...connection(),
      defaultModel: 'declared-4k-model',
      relayModelProfiles: { 'declared-4k-model': { contextWindow: 4_096 } },
    },
    modelId: 'declared-4k-model',
  });

  assert.deepEqual(messages, [
    {
      role: 'user',
      content: SESSION_RECAP_INSTRUCTION,
    },
  ]);
});

test('session recap treats a zero evidence budget as no evidence, not unbounded input', () => {
  const sentinel = 'ZERO-BUDGET-SENTINEL';
  const messages = buildSessionRecapMessages({
    events: [
      textEvent(
        'latest-user',
        'turn-1',
        'user',
        `${sentinel} ${'oversized context '.repeat(2_000)}`,
      ),
    ],
    connection: {
      ...connection(),
      defaultModel: 'declared-4k-model',
      relayModelProfiles: { 'declared-4k-model': { contextWindow: 4_096 } },
    },
    modelId: 'declared-4k-model',
  });

  assert.deepEqual(messages, [
    {
      role: 'user',
      content: SESSION_RECAP_INSTRUCTION,
    },
  ]);
});

function textEvent(id: string, turnId: string, role: 'user' | 'model', text: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: `run-${turnId}`,
    turnId,
    invocationId: `invocation-${turnId}`,
    ts: Number(turnId.slice('turn-'.length)),
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
}

function toolCallEvent(id: string, callId: string, turnId: string): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: `run-${turnId}`,
    turnId,
    invocationId: `invocation-${turnId}`,
    ts: 2,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: callId, name: 'Read', args: { path: 'state.txt' } },
  };
}

function toolResultEvent(
  id: string,
  callId: string,
  turnId: string,
  result: string,
  durableOutcome: string,
): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: `run-${turnId}`,
    turnId,
    invocationId: `invocation-${turnId}`,
    ts: 3,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: callId,
      name: 'Read',
      result,
      modelProjection: { version: 1, kind: 'text', text: durableOutcome },
    },
  };
}

function connection(): LlmConnection {
  return {
    slug: 'openai-main',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'gpt-4',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
