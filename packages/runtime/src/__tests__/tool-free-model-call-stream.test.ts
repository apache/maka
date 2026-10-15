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
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { generateToolFreeModelCall } from '../tool-free-model-call.js';

test('stream-only auxiliary model preserves one-call text and usage without exposing tools', async () => {
  let streamed = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw Error('Stream must be set to true');
    },
    doStream: async (options) => {
      streamed++;
      assert.equal(options.tools?.length ?? 0, 0);
      assert.equal(options.maxOutputTokens, 2048);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Extracted facts' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const result = await generateToolFreeModelCall({
    model,
    prompt: 'Originals',
    stream: true,
    maxOutputTokens: 2048,
  });
  assert.equal(streamed, 1);
  assert.equal(result.text, 'Extracted facts');
  assert.equal(result.finishReason, 'stop');
  assert.ok(result.usage);
});

test('stream-only auxiliary errors are not returned as successful partial text', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [{ type: 'error', error: new Error('provider failed') }],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
  await assert.rejects(
    generateToolFreeModelCall({ model, prompt: 'Originals', stream: true, maxOutputTokens: 2048 }),
    /provider failed/,
  );
});

test('stream-only endpoint can own its output limit', async () => {
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      assert.equal(options.maxOutputTokens, undefined);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Extracted facts' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const result = await generateToolFreeModelCall({ model, prompt: 'Originals', stream: true });
  assert.equal(result.text, 'Extracted facts');
});
