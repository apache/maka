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
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';

import { ModelAdapter } from '../model-adapter.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

test('reports activity for every pulled SDK stream part before semantic translation', async () => {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'tool-1', toolName: 'Write' },
    { type: 'tool-input-delta', id: 'tool-1', delta: '{"path":' },
    { type: 'tool-input-delta', id: 'tool-1', delta: '"report.md"}' },
    { type: 'tool-input-end', id: 'tool-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: ZERO_USAGE,
    },
  ];
  const model = new MockLanguageModelV4({
    doStream: {
      stream: convertArrayToReadableStream(parts),
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
  let activityCount = 0;

  const result = await adapter.startStream({
    model,
    messages: [{ role: 'user', content: 'write it' }],
    tools: {},
    activeTools: [],
    abortSignal: new AbortController().signal,
    repairToolCall: async () => null,
    onStreamActivity: () => {
      activityCount += 1;
    },
  });
  const semanticKinds: string[] = [];
  for await (const event of result.events) semanticKinds.push(event.kind);

  // streamText consumes the provider stream-start/finish parts and emits
  // start/start-step plus finish-step/finish, so this fixture becomes eight
  // pulled SDK parts. Tool-input parts stay absent from the semantic stream.
  assert.equal(activityCount, parts.length + 2);
  assert.ok(activityCount > semanticKinds.length);
});
