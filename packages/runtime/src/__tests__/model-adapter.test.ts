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
import { RetryError } from 'ai';

import { ModelAdapter, normalizeAiSdkUsage } from '../model-adapter.js';
import type { ModelStreamEvent } from '../model-protocol.js';

describe('ModelAdapter stream and error normalization', () => {
  test('resolves optional-key LocalAI without fabricating a credential', () => {
    const model = {};
    let observedApiKey: string | undefined;
    const adapter = new ModelAdapter({
      connection: {
        slug: 'localai',
        providerType: 'localai',
        defaultModel: 'qwen3-8b',
      },
      apiKey: '',
      modelId: 'qwen3-8b',
      modelFactory: (input) => {
        observedApiKey = input.apiKey;
        return model;
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.equal(adapter.resolveModel(), model);
    assert.equal(observedApiKey, '');
  });

  test('supports signed-thinking replay on Copilot models using the Anthropic wire', () => {
    const adapter = new ModelAdapter({
      connection: {
        slug: 'github-copilot',
        providerType: 'github-copilot',
        defaultModel: 'claude-sonnet',
        models: [{ id: 'claude-sonnet', apiProtocol: 'anthropic-messages' }],
      },
      apiKey: 'github-token',
      modelId: 'claude-sonnet',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.equal(adapter.runtimeEventReplaySupport().signedThinking, true);
  });

  test('supports unsigned-thinking replay on Kimi models using the OpenAI wire', () => {
    const adapter = new ModelAdapter({
      connection: {
        slug: 'kimi-coding-plan',
        providerType: 'kimi-coding-plan',
        defaultModel: 'k3',
        models: [{ id: 'k3', apiProtocol: 'openai-chat' }],
      },
      apiKey: 'kimi-token',
      modelId: 'k3',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.deepEqual(adapter.runtimeEventReplaySupport(), {
      toolCalls: true,
      toolResults: true,
      providerExecutedTools: true,
      signedThinking: false,
      unsignedThinking: true,
      responsesReasoning: 'none',
    });
  });

  test('shares one resolved OpenAI Chat reasoning contract with the model factory', () => {
    let observedWire: string | undefined;
    let observedReplayKind: string | undefined;
    let observedRequestField: string | undefined;
    const adapter = new ModelAdapter({
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-pro',
        models: [{ id: 'deepseek-v4-pro', apiProtocol: 'openai-chat' }],
      },
      apiKey: 'deepseek-token',
      modelId: 'deepseek-v4-pro',
      modelFactory: (input) => {
        observedWire = input.resolvedRuntime?.wire;
        observedReplayKind = input.resolvedRuntime?.reasoningReplay.kind;
        observedRequestField = input.openAiChatReasoningTransportState?.requestField;
        return {};
      },
      newId: idGenerator(),
      now: monotonicClock(),
    });

    adapter.resolveModel();

    assert.equal(observedWire, 'openai-chat');
    assert.equal(observedReplayKind, 'openai-chat-plaintext');
    assert.equal(observedRequestField, 'observed');
    assert.equal(adapter.runtimeEventReplaySupport().unsignedThinking, true);
  });

  test('supports Responses reasoning replay for Volcengine Agent Plan', () => {
    const adapter = new ModelAdapter({
      connection: {
        slug: 'volcengine-agent-plan',
        providerType: 'volcengine-agent-plan',
        defaultModel: 'ark-code-latest',
      },
      apiKey: 'ark-plan-token',
      modelId: 'ark-code-latest',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.deepEqual(adapter.runtimeEventReplaySupport(), {
      toolCalls: true,
      toolResults: true,
      providerExecutedTools: true,
      signedThinking: false,
      unsignedThinking: false,
      responsesReasoning: 'encrypted-content',
    });
  });

  test('supports plaintext Responses reasoning replay for DeepSeek V4', () => {
    const adapter = new ModelAdapter({
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      apiKey: 'deepseek-token',
      modelId: 'deepseek-v4-flash',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.deepEqual(adapter.runtimeEventReplaySupport(), {
      toolCalls: true,
      toolResults: true,
      providerExecutedTools: false,
      signedThinking: false,
      unsignedThinking: false,
      responsesReasoning: 'plaintext-content',
    });
  });

  test('supports summary-item Responses reasoning replay for Alibaba Token Plan', () => {
    const adapter = new ModelAdapter({
      connection: {
        slug: 'alibaba-token-plan-cn',
        providerType: 'alibaba-token-plan-cn',
        defaultModel: 'qwen3.8-max',
      },
      apiKey: 'alibaba-token',
      modelId: 'qwen3.8-max',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });

    assert.deepEqual(adapter.runtimeEventReplaySupport(), {
      toolCalls: true,
      toolResults: true,
      providerExecutedTools: false,
      signedThinking: false,
      unsignedThinking: false,
      responsesReasoning: {
        kind: 'plaintext-item',
        profile: 'alibaba-token-plan-cn',
        providerOptionsKey: 'alibaba-token-plan-cn',
      },
    });
  });

  test('normalizes Alibaba stream item ids into bounded durable state from item start', () => {
    const providerType = 'alibaba-token-plan-cn';
    const adapter = new ModelAdapter({
      connection: { slug: providerType, providerType, defaultModel: 'qwen3.8-max' },
      apiKey: 'token',
      modelId: 'qwen3.8-max',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    const providerOptions = {
      makaResponses: {
        version: 1,
        profile: providerType,
        itemId: 'alibaba-reasoning-item',
        summaryPartLengths: [7],
      },
    };
    assert.deepEqual(
      adapter.translateChunk({ type: 'reasoning-start', id: 'alibaba-reasoning-item' } as Chunk),
      [{ kind: 'thinking', text: '', reasoningItemId: 'alibaba-reasoning-item' }],
    );
    assert.deepEqual(
      adapter.translateChunk({
        type: 'reasoning-delta',
        id: 'alibaba-reasoning-item',
        delta: 'summary',
      } as Chunk),
      [{ kind: 'thinking', text: 'summary', reasoningItemId: 'alibaba-reasoning-item' }],
    );
    assert.deepEqual(
      adapter.translateChunk({
        type: 'reasoning-end',
        id: 'alibaba-reasoning-item',
        providerMetadata: {
          [providerType]: {
            itemId: 'alibaba-reasoning-item',
            reasoningSummary: [{ type: 'summary_text', text: 'summary' }],
          },
        },
      } as Chunk),
      [
        {
          kind: 'thinking',
          text: '',
          providerOptions,
          reasoningItemId: 'alibaba-reasoning-item',
          reasoningSummaryText: 'summary',
        },
      ],
    );
    assert.throws(
      () =>
        adapter.translateChunk({
          type: 'reasoning-end',
          id: 'unfinished-flush',
        } as Chunk),
      /missing final summary metadata/,
    );
    assert.throws(
      () =>
        adapter.translateChunk({
          type: 'reasoning-end',
          id: 'missing-final-summary',
          providerMetadata: {
            [providerType]: { itemId: 'missing-final-summary' },
          },
        } as Chunk),
      /missing final summary metadata/,
    );
  });

  test('keeps DeepSeek plaintext replay on the main content-only behavior', () => {
    const adapter = new ModelAdapter({
      connection: { slug: 'deepseek', providerType: 'deepseek', defaultModel: 'deepseek-v4-flash' },
      apiKey: 'token',
      modelId: 'deepseek-v4-flash',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });
    type Chunk = Parameters<typeof adapter.translateChunk>[0];

    assert.deepEqual(
      adapter.translateChunk({
        type: 'reasoning-delta',
        id: 'deepseek-reasoning-item',
        delta: 'plaintext reasoning',
      } as Chunk),
      [{ kind: 'thinking', text: 'plaintext reasoning' }],
    );
    assert.deepEqual(
      adapter.translateChunk({
        type: 'reasoning-end',
        id: 'deepseek-reasoning-item',
        providerMetadata: { deepseek: { itemId: 'deepseek-reasoning-item' } },
      } as Chunk),
      [],
    );
  });

  test('translates provider text, reasoning, tool calls, and errors into ModelStreamEvents', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    const chunks: Chunk[] = [
      { type: 'text-delta', text: 'hello ' },
      { type: 'text-delta', textDelta: 'world' },
      { type: 'reasoning', delta: 'think ' },
      { type: 'reasoning-delta', text: 'more' },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'Read' },
      { type: 'tool-result', toolCallId: 'tool-1', result: { ok: true } },
      { type: 'error', error: Object.assign(new Error('429 rate limit'), { code: 429 }) },
      { type: 'unknown-provider-chunk' },
    ];

    const events: ModelStreamEvent[] = chunks.flatMap((chunk) => adapter.translateChunk(chunk));

    // Tool results and unknown chunks are inert; returned tool calls and errors
    // cross the adapter as Maka-owned events.
    assert.deepEqual(
      events.map((event) => event.kind),
      ['text', 'text', 'thinking', 'thinking', 'tool-call', 'error'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'text')
        .map((event) => (event as { text: string }).text),
      ['hello ', 'world'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'thinking')
        .map((event) => (event as { text: string }).text),
      ['think ', 'more'],
    );
    const errorEvent = events.find(
      (event): event is Extract<ModelStreamEvent, { kind: 'error' }> => event.kind === 'error',
    );
    assert.ok(errorEvent);
    assert.deepEqual(errorEvent.failure, {
      type: 'model_failure',
      kind: 'rate_limit',
      code: '429',
      message: 'Rate limit exceeded',
      retryable: false,
    });
    // The backend consumes the typed failure without recovering the raw
    // provider error shape.
    const shaped = adapter.makeErrorEvent('turn-1', errorEvent.failure);
    assert.equal(shaped.reason, 'rate_limit');
    assert.equal(shaped.code, '429');
    assert.equal(shaped.message, 'Rate limit exceeded');
  });

  test('normalizes a status-less provider server_error into a retryable outage', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    const [event] = adapter.translateChunk({
      type: 'error',
      error: {
        type: 'server_error',
        code: 'server_error',
        message:
          'Streaming response failed: [502] Upstream error from Nvidia: Service temporarily overloaded',
      },
    } as Chunk);

    assert.deepEqual(event, {
      kind: 'error',
      failure: {
        type: 'model_failure',
        kind: 'provider_unavailable',
        code: 'server_error',
        message: 'Provider returned an error',
        retryable: true,
      },
    });
  });

  test('preserves an explicit empty reasoning delta without inventing one for absent text', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];

    assert.deepEqual(adapter.translateChunk({ type: 'reasoning-delta', text: '' } as Chunk), [
      { kind: 'thinking', text: '' },
    ]);
    assert.deepEqual(adapter.translateChunk({ type: 'reasoning-delta' } as Chunk), []);
    assert.deepEqual(
      adapter.translateChunk({
        type: 'reasoning-delta',
        text: '',
        providerMetadata: { anthropic: { signature: 'sig-empty' } },
      } as Chunk),
      [{ kind: 'thinking-signature', signature: 'sig-empty' }],
    );
  });

  test('marks OpenAI Chat field metadata as a Maka transport hint', () => {
    const adapter = new ModelAdapter({
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-pro',
        models: [{ id: 'deepseek-v4-pro', apiProtocol: 'openai-chat' }],
      },
      apiKey: 'deepseek-token',
      modelId: 'deepseek-v4-pro',
      modelFactory: () => ({}),
      newId: idGenerator(),
      now: monotonicClock(),
    });
    type Chunk = Parameters<typeof adapter.translateChunk>[0];

    assert.deepEqual(adapter.translateChunk({ type: 'reasoning-delta', text: 'think' } as Chunk), [
      {
        kind: 'thinking',
        text: 'think',
        providerOptions: { maka: { openAiChatReasoningField: 'reasoning_content' } },
        providerOptionsOrigin: 'maka_transport',
      },
    ]);
  });

  test('surfaces provider-executed tool input as replay-unsafe activity', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];

    assert.deepEqual(
      adapter.translateChunk({
        type: 'tool-input-start',
        toolCallId: 'search-1',
        toolName: 'WebSearch',
        providerExecuted: true,
      } as Chunk),
      [{ kind: 'provider-tool-input' }],
    );
    assert.deepEqual(
      adapter.translateChunk({
        type: 'tool-input-start',
        toolCallId: 'read-1',
        toolName: 'Read',
        providerExecuted: false,
      } as Chunk),
      [],
    );
  });

  test('returns a Maka-owned tool call event from one provider step', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    const chunk = {
      type: 'tool-call',
      toolCallId: 'tool-1',
      toolName: 'Read',
      input: { path: 'README.md' },
      providerExecuted: false,
      providerMetadata: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    } as unknown as Chunk;

    assert.deepEqual(adapter.translateChunk(chunk), [
      {
        kind: 'tool-call',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'Read',
          input: { path: 'README.md' },
          providerExecuted: false,
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
      },
    ]);
  });

  test('normalizes provider-executed search results and text citation metadata', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];

    assert.deepEqual(
      adapter.translateChunk({
        type: 'tool-result',
        toolCallId: 'search-1',
        toolName: 'WebSearch',
        providerExecuted: true,
        output: {
          action: { type: 'search', queries: ['latest Maka'] },
          sources: [{ type: 'url', url: 'https://maka.example/' }],
        },
      } as Chunk),
      [
        {
          kind: 'provider-tool-result',
          toolCallId: 'search-1',
          toolName: 'WebSearch',
          output: {
            action: { type: 'search', queries: ['latest Maka'] },
            sources: [{ type: 'url', url: 'https://maka.example/' }],
          },
        },
      ],
    );

    assert.deepEqual(
      adapter.translateChunk({
        type: 'text-end',
        providerMetadata: {
          openai: {
            itemId: 'message-1',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://maka.example/',
                title: 'Maka',
                startIndex: 0,
                endIndex: 4,
              },
            ],
          },
        },
      } as Chunk),
      [
        {
          kind: 'text-metadata',
          providerOptions: {
            openai: {
              itemId: 'message-1',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://maka.example/',
                  title: 'Maka',
                  startIndex: 0,
                  endIndex: 4,
                },
              ],
            },
          },
        },
      ],
    );
  });

  test('normalizes Anthropic web search results and server-tool errors', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    const result = [
      {
        type: 'web_search_result',
        url: 'https://maka.example/',
        title: 'Maka',
        pageAge: '2026-08-04',
        encryptedContent: 'encrypted-result',
      },
    ];

    assert.deepEqual(
      adapter.translateChunk({
        type: 'tool-result',
        toolCallId: 'search-anthropic',
        toolName: 'WebSearch',
        providerExecuted: true,
        output: result,
      } as Chunk),
      [
        {
          kind: 'provider-tool-result',
          toolCallId: 'search-anthropic',
          toolName: 'WebSearch',
          output: result,
        },
      ],
    );
    assert.deepEqual(
      adapter.translateChunk({
        type: 'tool-error',
        toolCallId: 'search-anthropic-error',
        toolName: 'WebSearch',
        providerExecuted: true,
        error: {
          type: 'web_search_tool_result_error',
          errorCode: 'max_uses_exceeded',
        },
      } as Chunk),
      [
        {
          kind: 'provider-tool-result',
          toolCallId: 'search-anthropic-error',
          toolName: 'WebSearch',
          output: {
            type: 'web_search_tool_result_error',
            errorCode: 'max_uses_exceeded',
          },
          isError: true,
        },
      ],
    );
  });

  test('reduces AI SDK 7 step boundaries to Maka-owned step-finish events', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    // The backend owns step counting + per-step AssistantMessage flush +
    // messageId rotation, but the adapter owns reducing the SDK step-boundary
    // chunk to a `step-finish` event carrying the normalized finish reason.
    // `start-step` carries nothing and is inert.
    const chunks: Chunk[] = [
      { type: 'start-step' },
      { type: 'text-delta', text: 'one' },
      { type: 'finish-step', finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
      { type: 'start-step' },
      { type: 'text-delta', text: 'two' },
      { type: 'finish-step', finishReason: { unified: 'stop', raw: 'stop' } },
    ];
    const events: ModelStreamEvent[] = chunks.flatMap((chunk) => adapter.translateChunk(chunk));

    assert.deepEqual(
      events.map((event) => event.kind),
      ['text', 'step-finish', 'text', 'step-finish'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'text')
        .map((event) => (event as { text: string }).text),
      ['one', 'two'],
    );
    const stepFinishes = events.filter((event) => event.kind === 'step-finish') as Array<
      Extract<ModelStreamEvent, { kind: 'step-finish' }>
    >;
    assert.deepEqual(
      stepFinishes.map((event) => event.finishReason),
      ['tool_calls', 'stop'],
    );
    // No usage on these chunks -> no usage field on the events.
    assert.equal(stepFinishes[0].usage, undefined);
    assert.equal(stepFinishes[1].usage, undefined);
  });

  test('captures the Anthropic reasoning signature without emitting an empty thinking event', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    // Mirrors the @ai-sdk/anthropic stream shape: reasoning text deltas, then a
    // standalone signature-only delta with empty text, then reasoning-end.
    const chunks: Chunk[] = [
      { type: 'reasoning-start' },
      { type: 'reasoning-delta', delta: 'weigh ' },
      { type: 'reasoning-delta', delta: 'options' },
      {
        type: 'reasoning-delta',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-xyz' } },
      },
      { type: 'reasoning-end' },
    ];
    const events: ModelStreamEvent[] = chunks.flatMap((chunk) => adapter.translateChunk(chunk));

    assert.deepEqual(
      events.map((event) => event.kind),
      ['thinking', 'thinking', 'thinking-signature'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'thinking')
        .map((event) => (event as { text: string }).text),
      ['weigh ', 'options'],
    );
    const signatureEvent = events.find((event) => event.kind === 'thinking-signature') as
      | Extract<ModelStreamEvent, { kind: 'thinking-signature' }>
      | undefined;
    assert.equal(signatureEvent?.signature, 'sig-xyz');
  });

  test('preserves OpenAI Responses reasoning metadata through stream normalization', () => {
    const adapter = newAdapter();
    type Chunk = Parameters<typeof adapter.translateChunk>[0];
    const chunks: Chunk[] = [
      {
        type: 'reasoning-delta',
        delta: 'inspect',
        providerMetadata: { openai: { itemId: 'rs_ark' } },
      },
      {
        type: 'reasoning-end',
        providerMetadata: {
          openai: {
            itemId: 'rs_ark',
            reasoningEncryptedContent: 'encrypted-ark-reasoning',
          },
        },
      },
    ];

    assert.deepEqual(
      chunks.flatMap((chunk) => adapter.translateChunk(chunk)),
      [
        {
          kind: 'thinking',
          text: 'inspect',
          providerOptions: { openai: { itemId: 'rs_ark' } },
        },
        {
          kind: 'thinking',
          text: '',
          providerOptions: {
            openai: {
              itemId: 'rs_ark',
              reasoningEncryptedContent: 'encrypted-ark-reasoning',
            },
          },
        },
      ],
    );
  });

  test('classifies provider errors and maps finish reasons through adapter-owned helpers', () => {
    const adapter = newAdapter();

    assert.equal(
      adapter.classifyError(Object.assign(new Error('401 Authorization'), { code: 401 })),
      'Auth',
    );
    assert.equal(adapter.classifyError(new TypeError('terminated')), 'Network');
    const billingError = Object.assign(new Error('provider request failed'), { statusCode: 402 });
    assert.equal(adapter.classifyError(billingError), 'ProviderBilling');
    assert.equal(adapter.makeErrorEvent('turn-1', billingError).reason, 'provider_billing');
    assert.equal(
      adapter.makeErrorEvent('turn-1', new Error('Model stream idle timeout after 120000ms'))
        .reason,
      'timeout',
    );
    assert.equal(adapter.mapFinishReason('stop'), 'end_turn');
    assert.equal(adapter.mapFinishReason('length'), 'max_tokens');
    assert.equal(adapter.mapFinishReason('tool-calls'), 'end_turn');
    assert.equal(adapter.mapFinishReason('provider-new-reason'), 'end_turn');
  });

  test('projects the final provider error inside an AI SDK retry wrapper', () => {
    const inner = Object.assign(new Error('Service unavailable: token=provider-secret'), {
      name: 'AI_APICallError',
      statusCode: 503,
    });
    const wrapped = new RetryError({
      message: 'Provider request failed after retries',
      reason: 'maxRetriesExceeded',
      errors: [inner, inner, inner],
    });

    const event = newAdapter().makeErrorEvent('turn-1', wrapped);

    assert.equal(event.reason, 'provider_unavailable');
    assert.equal(event.message, 'Provider returned an error');
    assert.equal(JSON.stringify(event).includes('provider-secret'), false);
  });

  test('projects a structured network error to a consistent reason and safe message', () => {
    const event = newAdapter().makeErrorEvent('turn-1', {
      message: 'fetch failed',
      detail: 'token=sk-live-secret-token-value',
    });

    assert.equal(event.reason, 'network');
    assert.equal(event.message, 'Network error');
    assert.equal(JSON.stringify(event).includes('sk-live-secret-token-value'), false);
  });

  test('retains Node connection copy without promoting retry classification', () => {
    const adapter = newAdapter();
    const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const event = adapter.makeErrorEvent('turn-1', error);

    assert.equal(adapter.classifyError(error), 'Error');
    assert.equal(event.reason, undefined);
    assert.equal(event.message, 'Network error');
  });

  test('projects string provider errors through the same classification', () => {
    const event = newAdapter().makeErrorEvent('turn-1', 'fetch failed');

    assert.equal(event.reason, 'network');
    assert.equal(event.message, 'Network error');
  });

  test('retains a safe bounded summary from an unknown structured provider error', () => {
    const adapter = newAdapter();
    const failure = adapter.normalizeFailure({
      type: 'error',
      error: {
        code: 'provider_error',
        message: `provider exploded api_key=sk-live-secret-token-value ${'x'.repeat(4_000)}`,
      },
      request_id: 'req-123',
    });
    const event = adapter.makeErrorEvent('turn-1', failure);

    assert.equal(event.reason, undefined);
    assert.equal(event.code, 'provider_error');
    assert.match(event.message, /^provider exploded api_key=\[redacted\]/);
    assert.match(event.message, /… \(code=provider_error, requestId=req-123\)$/);
    assert.equal(Buffer.byteLength(event.message, 'utf8') <= 2 * 1024, true);
    assert.equal(event.message.includes('sk-live-secret-token-value'), false);
  });

  test('normalizes cache and reasoning usage variants in the adapter module', () => {
    assert.deepEqual(
      normalizeAiSdkUsage({
        promptTokens: 20,
        completionTokens: 5,
        totalTokens: 30,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 3,
        inputTokenDetails: {
          reasoningTokens: 2,
        },
      }),
      {
        inputTokens: 20,
        outputTokens: 5,
        cacheHitInputTokens: 7,
        cacheMissInputTokens: 10,
        cacheMissInputSource: 'derived',
        cachedInputTokens: 7,
        cacheWriteInputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 30,
      },
    );
  });

  test('treats incomplete provider usage as unavailable unless total can supply the missing side', () => {
    assert.equal(normalizeAiSdkUsage({ inputTokens: 12 }), undefined);

    assert.deepEqual(normalizeAiSdkUsage({ inputTokens: 12, totalTokens: 15 }), {
      inputTokens: 12,
      outputTokens: 3,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 12,
      cacheMissInputSource: 'derived',
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 15,
    });
  });

  test('derives totals from detail-only AI SDK usage', () => {
    assert.deepEqual(
      normalizeAiSdkUsage({
        inputTokens: {
          total: undefined,
          noCache: 10,
          cacheRead: 5,
          cacheWrite: 2,
        },
        outputTokens: {
          total: undefined,
          text: 4,
          reasoning: 3,
        },
      }),
      {
        inputTokens: 17,
        outputTokens: 7,
        cacheHitInputTokens: 5,
        cacheMissInputTokens: 10,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 5,
        cacheWriteInputTokens: 2,
        reasoningTokens: 3,
        totalTokens: 24,
      },
    );
  });

  test('preserves DeepSeek and OpenAI-compatible raw usage fields', () => {
    assert.deepEqual(
      normalizeAiSdkUsage(
        {
          promptTokens: 100,
          completionTokens: 20,
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
          prompt_tokens_details: {
            cached_tokens: 35,
          },
          completion_tokens_details: {
            reasoning_tokens: 8,
          },
        },
        { rawFinishReason: { unified: 'stop', raw: 'provider_stop' } },
      ),
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheHitInputTokens: 40,
        cacheMissInputTokens: 60,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 40,
        cacheWriteInputTokens: 0,
        reasoningTokens: 8,
        totalTokens: 120,
        rawFinishReason: 'provider_stop',
        raw: {
          prompt_cache_hit_tokens: 40,
          prompt_cache_miss_tokens: 60,
          prompt_tokens_details: {
            cached_tokens: 35,
          },
          completion_tokens_details: {
            reasoning_tokens: 8,
          },
        },
      },
    );
  });

  test('normalizes direct DeepSeek snake_case usage totals', () => {
    assert.deepEqual(
      normalizeAiSdkUsage(
        {
          prompt_tokens: 1460,
          completion_tokens: 2,
          total_tokens: 1462,
          prompt_cache_hit_tokens: 1408,
          prompt_cache_miss_tokens: 52,
          prompt_tokens_details: {
            cached_tokens: 1408,
          },
        },
        { rawFinishReason: 'stop' },
      ),
      {
        inputTokens: 1460,
        outputTokens: 2,
        cacheHitInputTokens: 1408,
        cacheMissInputTokens: 52,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 1408,
        cacheWriteInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1462,
        rawFinishReason: 'stop',
        raw: {
          prompt_tokens: 1460,
          completion_tokens: 2,
          total_tokens: 1462,
          prompt_cache_hit_tokens: 1408,
          prompt_cache_miss_tokens: 52,
          prompt_tokens_details: {
            cached_tokens: 1408,
          },
        },
      },
    );
  });
});

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: {
      slug: 'anthropic-main',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
    },
    apiKey: 'sk-test',
    modelId: 'claude-sonnet-4-5-20250929',
    modelFactory: () => ({}),
    newId: idGenerator(),
    now: monotonicClock(),
  });
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}
