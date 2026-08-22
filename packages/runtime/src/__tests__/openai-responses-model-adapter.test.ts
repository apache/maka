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
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { ModelAdapter } from '../model-adapter.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import type { ModelMessage } from '../model-protocol.js';
import type { OpenAiResponsesSemanticBaseline } from '../openai-responses-continuation.js';
import type { OpenAiResponsesTransportState } from '../openai-responses-websocket.js';

const ZERO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

describe('OpenAI Responses ModelAdapter continuation', () => {
  test('maps streamed reasoning summaries into Maka thinking events', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const summary = 'Inspect the failing path before changing code.';
    const answer = 'The path is verified.';
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(openAiReasoningSummaryStream(summary, answer), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;
    const connection = {
      slug: 'responses-relay',
      providerType: 'openai-responses-compatible' as const,
      baseUrl: 'https://relay.example/v1',
      defaultModel: 'gpt-5.6-sol',
    };
    const adapter = new ModelAdapter({
      sessionId: 'session-1',
      connection,
      apiKey: 'test-key',
      modelId: 'gpt-5.6-sol',
      modelFactory: (input) => getAIModel({ ...input, fetch }),
      providerOptions: buildProviderOptions(connection, 'gpt-5.6-sol'),
      newId: () => 'id',
      now: () => 0,
    });
    const model = adapter.resolveModel();
    const result = await adapter.startStream({
      model,
      messages: [{ role: 'user', content: 'inspect it' }],
      tools: {},
      activeTools: [],
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    let thinking = '';
    let text = '';
    for await (const event of result.events) {
      if (event.kind === 'thinking') thinking += event.text;
      if (event.kind === 'text') text += event.text;
    }

    assert.deepEqual(requestBody?.reasoning, { effort: 'medium', summary: 'auto' });
    assert.equal(thinking, summary);
    assert.equal(text, answer);
  });

  test('preserves retryable WebSocket failures through the AI SDK stream boundary', async () => {
    const transportError = Object.assign(new Error('closed before completion'), {
      name: 'OpenAiResponsesTransportError',
      code: 'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.error(transportError);
          },
        }),
      }),
    });
    const adapter = new ModelAdapter({
      sessionId: 'session-1',
      connection: {
        slug: 'openai-main',
        providerType: 'openai',
        defaultModel: 'gpt-5',
      },
      apiKey: 'test-key',
      modelId: 'gpt-5',
      modelFactory: () => model,
      newId: () => 'id',
      now: () => 0,
    });
    const result = await adapter.startStream({
      model,
      messages: [{ role: 'user', content: 'continue' }],
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
        kind: 'network',
        retryable: true,
        code: 'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
        message: 'Network error',
      },
    ]);
  });

  test('feeds the persisted reasoning projection back into the next delta request', async () => {
    let baseline: OpenAiResponsesSemanticBaseline | undefined;
    let pending: Omit<OpenAiResponsesSemanticBaseline, 'responseMessages'> | undefined;
    const transport = {
      semanticBaseline: () => baseline,
      hasPendingSemantic: () => pending !== undefined,
      recordSemanticRequest: (
        _lane: string,
        value: Omit<OpenAiResponsesSemanticBaseline, 'responseMessages'>,
      ) => {
        pending = value;
        baseline = undefined;
      },
      recordSemanticResponse: (_lane: string, responseMessages: readonly ModelMessage[]) => {
        if (!pending) return;
        baseline = { ...pending, responseMessages: structuredClone(responseMessages) };
        pending = undefined;
      },
      clearSemantic: () => {
        baseline = undefined;
        pending = undefined;
      },
      canRecordSemantic: () => true,
      wrapFetch: (fetch: typeof globalThis.fetch) => fetch,
      endLane: () => {},
      close: () => {},
    } as unknown as OpenAiResponsesTransportState;
    const calls: LanguageModelV4CallOptions[] = [];
    let providerCall = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls.push(options);
        providerCall += 1;
        return {
          stream: convertArrayToReadableStream<LanguageModelV4StreamPart>(
            providerCall === 1
              ? firstReasoningToolStep()
              : providerCall === 2
                ? [
                    { type: 'stream-start', warnings: [] },
                    {
                      type: 'response-metadata',
                      id: 'resp-2',
                      modelId: 'gpt-5',
                      timestamp: new Date(0),
                    },
                    {
                      type: 'finish',
                      finishReason: { unified: 'stop', raw: 'stop' },
                      usage: ZERO_USAGE,
                    },
                  ]
                : [
                    { type: 'stream-start', warnings: [] },
                    { type: 'text-start', id: 'text-3' },
                    { type: 'text-delta', id: 'text-3', delta: 'partial' },
                  ],
          ),
        };
      },
    });
    const adapter = new ModelAdapter({
      sessionId: 'session-1',
      connection: {
        slug: 'openai-main',
        providerType: 'openai',
        defaultModel: 'gpt-5',
      },
      apiKey: 'test-key',
      modelId: 'gpt-5',
      modelFactory: () => model,
      newId: () => 'id',
      now: () => 0,
      openAiResponsesTransportState: transport,
    });
    const user: ModelMessage = { role: 'user', content: 'inspect it' };
    const firstOutcome = await drain(adapter, model, [user], ['shell']);

    assert.equal(firstOutcome.kind, 'completed');
    assert.equal(firstOutcome.continuation, 'pending');
    assert.deepEqual(pending, {
      requestMessages: [user],
      responseId: 'resp-1',
    });
    const reasoningOptions = { openai: { itemId: 'reasoning-1' } };
    const persistedResponse: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'inspect first', providerOptions: reasoningOptions },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'shell',
          input: { command: 'pwd' },
        },
      ],
      providerOptions: reasoningOptions,
    };
    adapter.recordContinuationResponse('turn-1', [persistedResponse]);
    const toolResult: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'shell',
          output: { type: 'text', value: '/workspace' },
        },
      ],
    };

    await drain(adapter, model, [user, persistedResponse, toolResult], ['shell']);

    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.prompt.length, 1);
    assert.equal(calls[1]?.prompt[0]?.role, 'tool');
    assert.deepEqual(calls[1]?.providerOptions?.openai, {
      promptCacheKey: 'maka:session-1',
      previousResponseId: 'resp-1',
    });
    assert.equal(calls[1]?.headers?.['x-maka-openai-responses-lane'], 'turn-1');

    const truncated = await drain(adapter, model, [user], ['shell']);
    assert.equal(truncated.kind, 'truncated');
    assert.equal(pending, undefined);
    assert.equal(baseline, undefined);
  });
});

function openAiReasoningSummaryStream(summary: string, answer: string): string {
  const reasoningId = 'rs_1';
  const messageId = 'msg_1';
  const events: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      response: {
        id: 'resp-1',
        object: 'response',
        created_at: 0,
        model: 'gpt-5.6-sol',
        status: 'in_progress',
        output: [],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: reasoningId,
        status: 'in_progress',
        content: [],
        summary: [],
      },
    },
    {
      type: 'response.reasoning_summary_part.added',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: summary,
    },
    {
      type: 'response.reasoning_summary_part.done',
      item_id: reasoningId,
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: summary },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: reasoningId,
        status: 'completed',
        content: [],
        summary: [{ type: 'summary_text', text: summary }],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'message',
        id: messageId,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: answer,
      item_id: messageId,
      output_index: 1,
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp-1',
        object: 'response',
        created_at: 0,
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

function firstReasoningToolStep(): LanguageModelV4StreamPart[] {
  const reasoningMetadata = { openai: { itemId: 'reasoning-1' } };
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'response-metadata',
      id: 'resp-1',
      modelId: 'gpt-5',
      timestamp: new Date(0),
    },
    { type: 'reasoning-start', id: 'reasoning-1', providerMetadata: reasoningMetadata },
    {
      type: 'reasoning-delta',
      id: 'reasoning-1',
      delta: 'inspect first',
      providerMetadata: reasoningMetadata,
    },
    { type: 'reasoning-end', id: 'reasoning-1', providerMetadata: reasoningMetadata },
    {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'shell',
      input: JSON.stringify({ command: 'pwd' }),
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: ZERO_USAGE,
    },
  ];
}

async function drain(
  adapter: ModelAdapter,
  model: MockLanguageModelV4,
  messages: ModelMessage[],
  activeTools: string[],
) {
  const result = await adapter.startStream({
    model,
    messages,
    tools: { shell: { inputSchema: z.object({ command: z.string() }) } },
    activeTools,
    onStreamActivity: () => {},
    abortSignal: new AbortController().signal,
    repairToolCall: async () => null,
    continuationKey: 'turn-1',
  });
  for await (const event of result.events) void event;
  return await result.outcome;
}
