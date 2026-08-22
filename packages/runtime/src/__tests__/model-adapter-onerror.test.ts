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
import { describe, test } from 'node:test';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import {
  APICallError,
  type LanguageModelV4StreamPart,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';

import { ModelAdapter, settleModelStepOutcome } from '../model-adapter.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: { providerType: 'openai' } as never,
    apiKey: 'test',
    modelId: 'mock',
    modelFactory: () => ({}),
    newId: () => 'id',
    now: () => 0,
  });
}

describe('settleModelStepOutcome', () => {
  test('explicit stream failure takes precedence over finish metadata', () => {
    const failure = {
      type: 'model_failure' as const,
      kind: 'rate_limit' as const,
      message: 'Rate limit exceeded',
      retryable: true,
    };

    const outcome = settleModelStepOutcome({
      aborted: false,
      failure,
      sawFinish: true,
      finishReason: 'content-filter',
      request: {},
    });

    assert.equal(outcome.kind, 'retryable-failure');
    if (outcome.kind !== 'retryable-failure') return;
    assert.equal(outcome.failure, failure);
  });
});

describe('ModelAdapter.startStream onError', () => {
  test('normalizes provider retry eligibility and Retry-After at the adapter boundary', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: 'rate limited',
          url: 'https://provider.invalid/v1/messages',
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { 'retry-after-ms': '2500' },
        });
      },
    });
    const result = await newAdapter().startStream({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      activeTools: [],
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });

    const failures = [];
    for await (const event of result.events) {
      if (event.kind === 'error') failures.push(event.failure);
    }

    assert.deepEqual(failures, [
      {
        type: 'model_failure',
        kind: 'rate_limit',
        code: '429',
        message: 'Rate limit exceeded',
        retryable: true,
        retryAfterMs: 2500,
      },
    ]);
    assert.deepEqual(await result.outcome, {
      kind: 'retryable-failure',
      failure: failures[0],
      request: { messages: [{ role: 'user', content: 'hi' }] },
      continuation: 'none',
    });
  });

  test('does not hide provider retries inside one adapter call', async () => {
    let providerCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        providerCalls += 1;
        throw new APICallError({
          message: 'retry me',
          url: 'https://provider.invalid/v1/messages',
          requestBodyValues: {},
          statusCode: 503,
          responseHeaders: { 'retry-after-ms': '0' },
        });
      },
    });
    const result = await newAdapter().startStream({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      activeTools: [],
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });

    for await (const _event of result.events) {
      void _event;
    }

    assert.equal(providerCalls, 1);
  });

  test('returns normalized Maka-owned request metadata', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        request: { body: { model: 'mock', temperature: 0 } },
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      },
    });
    const result = await newAdapter().startStream({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      tools: {},
      activeTools: [],
      onStreamActivity: () => {},
      system: 'sys',
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    for await (const _event of result.events) {
      void _event;
    }

    assert.deepEqual(await result.outcome, {
      kind: 'completed',
      finishReason: 'stop',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheHitInputTokens: 0,
        cacheMissInputTokens: 1,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 2,
        rawFinishReason: 'stop',
      },
      request: { messages: [{ role: 'user', content: 'hi' }] },
      continuation: 'none',
    });
  });

  test('settles a stream without a finish frame as truncated', async () => {
    const outcome = await settle([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'partial' },
    ]);

    assert.equal(outcome.kind, 'truncated');
    if (outcome.kind !== 'truncated') return;
    assert.equal(outcome.failure.message, 'Provider stream ended without finishing (other)');
    assert.equal(outcome.continuation, 'none');
  });

  test('preserves a provider reason hidden by the SDK other bucket', async () => {
    const outcome = await settle([
      { type: 'stream-start', warnings: [] },
      {
        type: 'finish',
        finishReason: { unified: 'other', raw: 'eos_token' },
        usage: ZERO_USAGE,
      },
    ]);

    assert.equal(outcome.kind, 'completed');
    if (outcome.kind !== 'completed') return;
    assert.equal(outcome.finishReason, 'eos_token');
    assert.equal(outcome.usage?.rawFinishReason, 'eos_token');
  });

  test('settles a content filter as a terminal failure', async () => {
    const outcome = await settle([
      { type: 'stream-start', warnings: [] },
      {
        type: 'finish',
        finishReason: { unified: 'content-filter', raw: 'content_filter' },
        usage: ZERO_USAGE,
      },
    ]);

    assert.equal(outcome.kind, 'terminal-failure');
    if (outcome.kind !== 'terminal-failure') return;
    assert.equal(outcome.failure.kind, 'unknown');
    assert.equal(outcome.failure.message, 'Provider stopped the stream on a content filter');
  });

  test('settles an aborted request as aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await settle(
      [
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: ZERO_USAGE,
        },
      ],
      controller.signal,
    );

    assert.equal(outcome.kind, 'aborted');
  });

  // streamText's default onError is `console.error(error)`, which dumps the
  // raw error object (stack + request bodies) straight onto the terminal,
  // bypassing the TUI transcript. Stream failures already reach the user via
  // the stream `error` chunk → ErrorEvent path, so nothing may leak to
  // console.error.
  test('a provider stream failure never reaches console.error', async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const model = new MockLanguageModelV4({
        doStream: async () => {
          throw new Error(
            'Client network socket disconnected before secure TLS connection was established',
          );
        },
      });
      const result = await newAdapter().startStream({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        activeTools: [],
        onStreamActivity: () => {},
        system: 'sys',
        abortSignal: new AbortController().signal,
        repairToolCall: async () => null,
      });
      const failures = [];
      for await (const event of result.events) {
        if (event.kind === 'error') failures.push(event.failure);
      }
      // Let any post-chunk callback settle before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(failures, [
        {
          type: 'model_failure',
          kind: 'network',
          message: 'Network error',
          retryable: true,
        },
      ]);
    } finally {
      console.error = original;
    }
    assert.deepEqual(
      logged,
      [],
      'stream errors must surface via the error chunk, not console.error',
    );
  });
});

async function settle(
  chunks: LanguageModelV4StreamPart[],
  abortSignal = new AbortController().signal,
) {
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
  const result = await newAdapter().startStream({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    activeTools: [],
    onStreamActivity: () => {},
    abortSignal,
    repairToolCall: async () => null,
  });
  for await (const _event of result.events) void _event;
  return await result.outcome;
}
