import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RetryError } from 'ai';

import { ModelAdapter, lowerNativeAudioMessages, normalizeAiSdkUsage } from '../model-adapter.js';
import type { ModelStreamEvent } from '../model-protocol.js';

describe('ModelAdapter stream and error normalization', () => {
  test('lowers explicit audio only at the provider boundary without copying bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const [message] = lowerNativeAudioMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'follow the voice request' },
          {
            type: 'audio',
            data: bytes,
            mediaType: 'audio/wav',
            format: 'wav',
            durationMs: 500,
            retention: 'operation_memory',
          },
        ],
      },
    ]);
    assert.equal(message?.role, 'user');
    assert.notEqual(typeof message?.content, 'string');
    if (!message || message.role !== 'user' || typeof message.content === 'string') return;
    const file = message.content.find((part) => part.type === 'file');
    assert.equal(file?.type, 'file');
    if (
      file?.type !== 'file' ||
      typeof file.data !== 'object' ||
      file.data === null ||
      !('type' in file.data) ||
      file.data.type !== 'data'
    ) {
      return;
    }
    assert.equal(file.data.data, bytes);
    assert.equal(file.mediaType, 'audio/wav');
    assert.equal(file.filename, 'voice-input.wav');
  });

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
      signedThinking: false,
      unsignedThinking: true,
      openAiResponsesThinking: false,
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
      signedThinking: false,
      unsignedThinking: false,
      openAiResponsesThinking: true,
    });
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
      retryable: true,
    });
    // The backend consumes the typed failure without recovering the raw
    // provider error shape.
    const shaped = adapter.makeErrorEvent('turn-1', errorEvent.failure);
    assert.equal(shaped.reason, 'rate_limit');
    assert.equal(shaped.code, '429');
    assert.equal(shaped.message, 'Rate limit exceeded');
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
    assert.equal(adapter.mapFinishReason('content-filter'), 'error');
    assert.equal(adapter.mapFinishReason('error'), 'error');
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

  test('keeps an unknown structured provider error generic', () => {
    const event = newAdapter().makeErrorEvent('turn-1', { message: 'provider exploded' });

    assert.equal(event.reason, undefined);
    assert.equal(event.message, 'Operation failed');
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

  test('treats provider usage without token values as unavailable', () => {
    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      }),
      undefined,
    );
  });

  test('treats incomplete provider usage as unavailable unless total can supply the missing side', () => {
    assert.equal(normalizeAiSdkUsage({ inputTokens: 12 }), undefined);
    assert.equal(normalizeAiSdkUsage({ outputTokens: 3 }), undefined);
    assert.equal(normalizeAiSdkUsage({ totalTokens: 15 }), undefined);

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
    assert.deepEqual(normalizeAiSdkUsage({ outputTokens: 3, totalTokens: 15 }), {
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
    assert.deepEqual(normalizeAiSdkUsage({ inputTokens: 0, outputTokens: 0 }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheHitInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheMissInputSource: 'derived',
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
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

  test('derives totals from the legacy scalar detail shape', () => {
    const usage = {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      },
      outputTokenDetails: {
        textTokens: 4,
        reasoningTokens: 3,
      },
    } as unknown as Parameters<typeof normalizeAiSdkUsage>[0];

    assert.deepEqual(normalizeAiSdkUsage(usage), {
      inputTokens: 17,
      outputTokens: 7,
      cacheHitInputTokens: 5,
      cacheMissInputTokens: 10,
      cacheMissInputSource: 'explicit',
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      reasoningTokens: 3,
      totalTokens: 24,
    });
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

  test('normalizes AI SDK raw DeepSeek usage metadata and no-cache token details', () => {
    assert.deepEqual(
      normalizeAiSdkUsage(
        {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: {
            noCacheTokens: 25,
            cacheReadTokens: 75,
          },
          outputTokenDetails: {
            reasoningTokens: 9,
          },
          raw: {
            prompt_cache_hit_tokens: 70,
            prompt_cache_miss_tokens: 30,
            prompt_tokens_details: {
              cached_tokens: 70,
            },
            completion_tokens_details: {
              reasoning_tokens: 11,
            },
          },
        },
        { rawFinishReason: 'stop' },
      ),
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheHitInputTokens: 70,
        cacheMissInputTokens: 30,
        cacheMissInputSource: 'explicit',
        cachedInputTokens: 70,
        cacheWriteInputTokens: 0,
        reasoningTokens: 9,
        totalTokens: 120,
        rawFinishReason: 'stop',
        raw: {
          prompt_cache_hit_tokens: 70,
          prompt_cache_miss_tokens: 30,
          prompt_tokens_details: {
            cached_tokens: 70,
          },
          completion_tokens_details: {
            reasoning_tokens: 11,
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

  test('derives cache miss input when explicit miss is absent and treats no cache data as fresh', () => {
    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 20,
      })?.cacheMissInputTokens,
      50,
    );
    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 20,
      })?.cacheMissInputSource,
      'derived',
    );

    assert.equal(
      normalizeAiSdkUsage({
        inputTokens: 100,
        outputTokens: 10,
      })?.cacheMissInputTokens,
      100,
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
