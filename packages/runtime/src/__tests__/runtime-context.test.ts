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
import { APICallError, type LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { z } from 'zod';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import { decodeRuntimeEvent } from '@maka/core/runtime-event';
import { changedRuntimeContexts, runtimeContextMessage } from '../runtime-context.js';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { projectRuntimeEventsToStoredMessages } from '../runtime-event-read-model.js';
import { createDurableTurnHarness, drainWithDurableTurn } from './durable-turn-harness.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};
const finish = (tool: boolean): LanguageModelV4StreamPart => ({
  type: 'finish',
  finishReason: { unified: tool ? 'tool-calls' : 'stop', raw: tool ? 'tool_calls' : 'stop' },
  usage,
});

test('context changes append in order; stable Inbox is emitted once; a running amendment arrives next step', async () => {
  const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'Check delivery' });
  let step = 0,
    clock = 0,
    id = 0,
    inbox = 'Deliver to Shanghai';
  const model = new MockLanguageModelV4({
    doStream: async () => {
      ++step;
      return {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: 'stream-start', warnings: [] },
          ...(step < 4
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `call-${step}`,
                  toolName: 'Check',
                  input: '{}',
                },
              ]
            : []),
          finish(step < 4),
        ]),
      };
    },
  });
  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
    newId: () => `id-${++id}`,
    now: () => id + 1,
    systemPrompt: () => ({
      sourceRevisions: [],
      contexts: [
        { name: 'clock', text: `UTC: ${++clock}` },
        { name: 'inbox', text: inbox },
      ],
    }),
    tools: [
      {
        name: 'Check',
        description: 'Check delivery',
        parameters: z.object({}),
        impl: () => {
          if (step === 2) inbox = 'Correction: deliver to Beijing';
          return { checked: step };
        },
      },
    ],
  });
  const events = await drainWithDurableTurn(backend.send(durable.sendInput()), durable);
  assert.equal(step, 4);
  const contexts = events.filter((e) => e.type === 'runtime_context');
  assert.equal(contexts.filter((e) => e.name === 'clock').length, 4);
  assert.deepEqual(
    contexts.filter((e) => e.name === 'inbox').map((e) => e.text.split('\n').at(-1)),
    ['Deliver to Shanghai', 'Correction: deliver to Beijing'],
  );
  const calls = model.doStreamCalls;
  for (let i = 1; i < calls.length; i++) {
    assert.deepEqual(
      calls[i]!.prompt.slice(0, calls[i - 1]!.prompt.length),
      calls[i - 1]!.prompt,
      'previous request is an unchanged prefix before new tool output/context',
    );
  }
  assert.doesNotMatch(JSON.stringify(calls[1]!.prompt), /deliver to Beijing/);
  assert.match(JSON.stringify(calls[2]!.prompt), /deliver to Beijing/);

  // Simulate persistence and restart, not just reuse of live in-memory messages.
  const restored = durable.ledger.map((e) => decodeRuntimeEvent(JSON.parse(JSON.stringify(e))));
  const plan = buildRuntimeEventModelReplayPlan(restored);
  assert.equal(
    plan.items.filter((i) => i.kind === 'text' && i.runtimeContextName === 'inbox').length,
    2,
  );
  assert.deepEqual(changedRuntimeContexts([{ name: 'inbox', text: inbox }], plan.textMessages), []);
  const projection = projectRuntimeEventsToStoredMessages(restored, { invocations: [] });
  assert.ok(!JSON.stringify(projection.messages).includes('Runtime context'));
  assert.ok(!projection.diagnostics.some((d) => d.code === 'unsupported_event'));
});

test('provider retry reuses the same context instead of resampling time', async () => {
  const durable = createDurableTurnHarness({ turnId: 'turn-1', text: 'hello' });
  let calls = 0,
    resolutions = 0,
    id = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      if (++calls === 1)
        throw new APICallError({
          message: 'temporary outage',
          url: 'https://test.invalid',
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      return { stream: convertArrayToReadableStream([finish(false)]) };
    },
  });
  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
    providerRetrySleep: async () => {},
    tools: [],
    newId: () => `retry-${++id}`,
    now: () => id + 1,
    systemPrompt: () => ({
      sourceRevisions: [],
      contexts: [{ name: 'clock', text: `UTC: ${++resolutions}` }],
    }),
  });
  const events = await drainWithDurableTurn(backend.send(durable.sendInput()), durable);
  assert.equal(calls, 2);
  assert.deepEqual(model.doStreamCalls[0]!.prompt, model.doStreamCalls[1]!.prompt);
  assert.equal(events.filter((e) => e.type === 'runtime_context').length, 1);
});

test('compacted-away context is refreshed; a change back to an earlier value is not suppressed', () => {
  const a = changedRuntimeContexts([{ name: 'inbox', text: 'A' }], []);
  const b = changedRuntimeContexts([{ name: 'inbox', text: 'B' }], a.map(runtimeContextMessage));
  assert.equal(
    changedRuntimeContexts([{ name: 'inbox', text: 'A' }], [...a, ...b].map(runtimeContextMessage))
      .length,
    1,
  );
  assert.equal(changedRuntimeContexts([{ name: 'inbox', text: 'B' }], []).length, 1);
  assert.equal(
    changedRuntimeContexts([{ name: 'inbox', text: 'B' }], [{ role: 'user', content: b[0]!.text }])
      .length,
    1,
    'user text cannot spoof host deduplication',
  );
});

test('a rebuilt backend replays durable contexts and only appends changed values', async () => {
  let id = 0;
  const first = createDurableTurnHarness({ turnId: 'turn-1', text: 'start' });
  const second = createDurableTurnHarness({ turnId: 'turn-2', text: 'continue' });
  const build = (durable: ReturnType<typeof createDurableTurnHarness>, clock: string) => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([finish(false)]),
      }),
    });
    return {
      model,
      backend: createTestAiSdkBackend({
        sessionId: 'session-1',
        header: header(),
        connection: connection(),
        apiKey: 'sk-test',
        modelId: 'mock-model-id',
        modelFactory: () => model,
        tools: [],
        newId: () => `restart-${++id}`,
        now: () => id + 1,
        loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
        systemPrompt: () => ({
          sourceRevisions: [],
          contexts: [
            { name: 'clock', text: clock },
            { name: 'inbox', text: 'Unchanged task' },
          ],
        }),
      }),
    };
  };
  const original = build(first, 'UTC: 1');
  await drainWithDurableTurn(original.backend.send(first.sendInput()), first);
  const restored = first.ledger.map((e) => decodeRuntimeEvent(JSON.parse(JSON.stringify(e))));
  const rebuilt = build(second, 'UTC: 2');
  const events = await drainWithDurableTurn(
    rebuilt.backend.send(
      second.sendInput({
        runtimeContext: restored,
      }),
    ),
    second,
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'runtime_context').map((e) => e.name),
    ['clock'],
  );
  const prompt = JSON.stringify(rebuilt.model.doStreamCalls[0]!.prompt);
  assert.match(prompt, /UTC: 1/);
  assert.match(prompt, /UTC: 2/);
  assert.equal(prompt.split('Unchanged task').length - 1, 1);
});

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'c',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'mock-model-id',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
