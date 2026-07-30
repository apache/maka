import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';

import { ModelAdapter } from '../model-adapter.js';

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
        message: 'Rate limit exceeded',
        retryable: true,
        retryAfterMs: 2500,
      },
    ]);
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
      system: 'sys',
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    for await (const _event of result.events) {
      void _event;
    }

    assert.deepEqual(await result.request, {
      messages: [{ role: 'user', content: 'hi' }],
    });
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
