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
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { ModelAdapter } from '../model-adapter.js';

async function activityCount(parts: LanguageModelV4StreamPart[]): Promise<number> {
  const model = new MockLanguageModelV4({
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        ...parts,
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ]),
    },
  });
  const adapter = new ModelAdapter({
    connection: { providerType: 'openai' } as never,
    apiKey: 'test',
    modelId: 'mock',
    modelFactory: () => model,
    newId: () => 'id',
    now: () => 0,
  });
  let count = 0;
  const result = await adapter.startStream({
    model,
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: {},
    activeTools: [],
    abortSignal: new AbortController().signal,
    repairToolCall: async () => null,
    onStreamActivity: () => {
      count += 1;
    },
  });
  for await (const _event of result.events) {
    /* drain */
  }
  assert.equal((await result.outcome).kind, 'completed');
  // SDK start/start-step and finish-step/finish remain activity.
  return count - 4;
}

for (const providerExecuted of [false, true]) {
  test(`ignores insignificant whitespace after a value (providerExecuted=${providerExecuted})`, async () => {
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'tool-input-start', id: 'a', toolName: 'Bash', providerExecuted },
      { type: 'tool-input-delta', id: 'a', delta: '{"boundary_intent":"current"' },
      ...Array.from({ length: 30 }, () => ({
        type: 'tool-input-delta' as const,
        id: 'a',
        delta: ' \n\r\t',
      })),
      { type: 'tool-input-end', id: 'a' },
    ];
    assert.equal(await activityCount(parts), 3);
  });
}

test('preserves whitespace inside strings across escaped quotes and backslashes', async () => {
  const deltas = ['{"content":"line1', '\n\n   ', '\\', '"', ' ', '\\', '\\', '"', ' \t', '}'];
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'tool-input-start', id: 'a', toolName: 'Write' },
    ...deltas.map((delta) => ({ type: 'tool-input-delta' as const, id: 'a', delta })),
    { type: 'tool-input-end', id: 'a' },
  ];
  // The escaped quote stays inside; the quote after an escaped backslash closes.
  assert.equal(await activityCount(parts), parts.length - 1);
});

test('keeps interleaved call state independent and resets ended IDs', async () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'tool-input-start', id: 'a', toolName: 'Write' },
    { type: 'tool-input-delta', id: 'a', delta: '{"content":"' },
    { type: 'tool-input-start', id: 'b', toolName: 'Bash' },
    { type: 'tool-input-delta', id: 'b', delta: '{"command":"pwd"' },
    { type: 'tool-input-delta', id: 'b', delta: ' ' },
    { type: 'tool-input-delta', id: 'a', delta: ' ' },
    { type: 'tool-input-end', id: 'a' },
    { type: 'tool-input-start', id: 'a', toolName: 'Write' },
    { type: 'tool-input-delta', id: 'a', delta: ' ' },
    { type: 'tool-input-delta', id: 'b', delta: ' }' },
    { type: 'tool-input-end', id: 'a' },
    { type: 'tool-input-end', id: 'b' },
  ];
  assert.equal(await activityCount(parts), parts.length - 2);
});

test('only JSON whitespace is insignificant outside strings', async () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'tool-input-start', id: 'a', toolName: 'Bash' },
    { type: 'tool-input-delta', id: 'a', delta: '\u00a0' },
    { type: 'tool-input-delta', id: 'a', delta: '\v' },
    { type: 'tool-input-delta', id: 'a', delta: ' \t{}' },
    { type: 'tool-input-end', id: 'a' },
  ];
  assert.equal(await activityCount(parts), parts.length);
});

test('counts every whitespace delta while a string remains open', async () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'tool-input-start', id: 'a', toolName: 'Write' },
    { type: 'tool-input-delta', id: 'a', delta: '{"content":"line1' },
    { type: 'tool-input-delta', id: 'a', delta: '   ' },
    { type: 'tool-input-delta', id: 'a', delta: '\\' },
    { type: 'tool-input-delta', id: 'a', delta: '"' },
    { type: 'tool-input-delta', id: 'a', delta: '\n\t ' },
    { type: 'tool-input-end', id: 'a' },
  ];
  assert.equal(await activityCount(parts), parts.length);
});

test('preserves whitespace activity for text and reasoning streams', async () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: ' \n' },
    { type: 'text-end', id: 'text' },
    { type: 'reasoning-start', id: 'thought' },
    { type: 'reasoning-delta', id: 'thought', delta: ' \n' },
    { type: 'reasoning-end', id: 'thought' },
  ];
  assert.equal(await activityCount(parts), parts.length);
});
