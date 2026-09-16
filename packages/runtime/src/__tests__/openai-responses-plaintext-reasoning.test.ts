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
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildProviderOptions, getAIModel } from '../model-factory.js';

function conn(providerType: LlmConnection['providerType']): LlmConnection {
  return {
    slug: 'test',
    name: 'test',
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const ITEM_ID = 'd2fb9f45-39e8-4f9e-9cc3-999d591a27ab';
const MESSAGE_ID = 'msg_4a1f0c7b';
const REASONING = 'The user asks if 91 is prime. 91 = 7 x 13, so it is composite.';
const ANSWER = 'No — 91 is 7 x 13.';

/**
 * Recorded from a live `deepseek-v4-flash` streaming call: a reasoning item is
 * opened and closed by the same `output_item` events the SDK already reads,
 * while the text itself arrives on `response.reasoning_text.delta`. That is why
 * the reasoning part used to survive the round trip carrying nothing.
 *
 * The assistant's own reply is part of the fixture because the transport
 * rewrites every DeepSeek response body, not just the reasoning in it: a
 * translator that dropped the message entirely would be the worst failure this
 * code can have, and only an assertion on the reply can see it.
 */
function plaintextReasoningStream(
  deltas: string[],
  answer = ANSWER,
  finalSummary: Array<{ type: 'summary_text'; text: string }> = [],
  model = 'deepseek-v4-flash',
): string {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: { id: 'r' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: ITEM_ID, status: 'in_progress', content: [], summary: [] },
    },
    ...deltas.map((delta, index) => ({
      type: 'response.reasoning_text.delta',
      content_index: 0,
      delta,
      item_id: ITEM_ID,
      output_index: 0,
      sequence_number: 4 + index,
    })),
    {
      type: 'response.reasoning_text.done',
      content_index: 0,
      item_id: ITEM_ID,
      output_index: 0,
      text: deltas.join(''),
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: ITEM_ID,
        status: 'completed',
        content: [{ type: 'reasoning_text', text: deltas.join('') }],
        summary: finalSummary,
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'message',
        id: MESSAGE_ID,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: answer,
      item_id: MESSAGE_ID,
      output_index: 1,
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        id: MESSAGE_ID,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        object: 'response',
        created_at: 0,
        model,
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

/** Alibaba's published Responses reasoning-summary stream shape. */
function officialSummaryReasoningStream(
  deltas: string[],
  answer = ANSWER,
  finalSummary: Array<{ type: 'summary_text'; text: string }> = [
    { type: 'summary_text', text: deltas.join('') },
  ],
): string {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', sequence_number: 0, response: { id: 'r' } },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { type: 'reasoning', id: ITEM_ID, status: 'in_progress', content: [], summary: [] },
    },
    ...deltas.map((delta, index) => ({
      type: 'response.reasoning_summary_text.delta',
      sequence_number: 2 + index,
      item_id: ITEM_ID,
      output_index: 0,
      summary_index: 0,
      delta,
    })),
    {
      type: 'response.reasoning_summary_text.done',
      sequence_number: 2 + deltas.length,
      item_id: ITEM_ID,
      output_index: 0,
      summary_index: 0,
      text: deltas.join(''),
    },
    {
      type: 'response.output_item.done',
      sequence_number: 3 + deltas.length,
      output_index: 0,
      item: {
        type: 'reasoning',
        id: ITEM_ID,
        status: 'completed',
        content: [],
        summary: finalSummary,
      },
    },
    {
      type: 'response.output_item.added',
      sequence_number: 4 + deltas.length,
      output_index: 1,
      item: {
        type: 'message',
        id: MESSAGE_ID,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 5 + deltas.length,
      content_index: 0,
      item_id: MESSAGE_ID,
      output_index: 1,
      delta: answer,
    },
    {
      type: 'response.output_item.done',
      sequence_number: 6 + deltas.length,
      output_index: 1,
      item: {
        type: 'message',
        id: MESSAGE_ID,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      sequence_number: 7 + deltas.length,
      response: {
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'qwen3.8-max',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

function standardFunctionCallStream(): string {
  const item = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'Read',
    arguments: '{"path":"package.json"}',
    status: 'completed',
  };
  const events = [
    { type: 'response.created', sequence_number: 0, response: { id: 'r' } },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...item, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.done',
      sequence_number: 2,
      output_index: 0,
      item_id: item.id,
      call_id: item.call_id,
      arguments: item.arguments,
    },
    {
      type: 'response.output_item.done',
      sequence_number: 3,
      output_index: 0,
      item,
    },
    {
      type: 'response.completed',
      sequence_number: 4,
      response: {
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

function unfinalizedReasoningStream(terminal: 'completed' | 'failed'): string {
  const response = {
    id: 'r',
    object: 'response',
    created_at: 0,
    model: 'qwen3.8-max',
    status: terminal,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1 },
    ...(terminal === 'failed'
      ? { error: { code: 'rate_limit_exceeded', message: 'rate limited' } }
      : {}),
  };
  const events = [
    { type: 'response.created', response: { id: 'r' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: ITEM_ID, status: 'in_progress', content: [], summary: [] },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      summary_index: 0,
      delta: 'unfinished reasoning',
      item_id: ITEM_ID,
      output_index: 0,
    },
    { type: `response.${terminal}`, response },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

async function alibabaStreamParts(body: string, chunkSize = Number.MAX_SAFE_INTEGER) {
  const connection = conn('alibaba-token-plan-cn');
  const model = getAIModel({
    connection,
    apiKey: 'test-key',
    modelId: 'qwen3.8-max',
    fetch: sseFetch(body, chunkSize),
  });
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: buildProviderOptions(connection, 'qwen3.8-max', 'high'),
  });
  const parts = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/**
 * Chunks are cut from the encoded bytes, not from the string: slicing the
 * string would hand every chunk a whole character and quietly make multi-byte
 * text untestable, which is the failure this harness exists to expose.
 */
function sseFetch(body: string, chunkSize = Number.MAX_SAFE_INTEGER): typeof globalThis.fetch {
  return (async () => {
    const bytes = new TextEncoder().encode(body);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += chunkSize) {
            controller.enqueue(bytes.slice(at, at + chunkSize));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as unknown as typeof globalThis.fetch;
}

async function streamParts(
  providerType: LlmConnection['providerType'],
  fetch: typeof globalThis.fetch,
): Promise<{ reasoning: string; text: string }> {
  const model = getAIModel({
    connection: conn(providerType),
    apiKey: 'test-key',
    modelId: providerType === 'deepseek' ? 'deepseek-v4-flash' : 'grok-4.5',
    fetch,
  });
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions:
      providerType === 'deepseek'
        ? buildProviderOptions(conn(providerType), 'deepseek-v4-flash', 'high')
        : { openai: { store: false, forceReasoning: true } },
  });
  let reasoning = '';
  let text = '';
  for await (const part of stream) {
    if (part.type === 'reasoning-delta') reasoning += part.delta;
    if (part.type === 'text-delta') text += part.delta;
  }
  return { reasoning, text };
}

describe('open responses plaintext reasoning', () => {
  test('the pinned SDK maps official summary events across raw byte chunks', async () => {
    const deltas = ['检查请求。', '调用 Maka 工具。'];
    const parts = await alibabaStreamParts(officialSummaryReasoningStream(deltas), 7);
    const streamed = parts
      .filter((part) => part.type === 'reasoning-delta')
      .map((part) => part.delta);
    const reasoningEnd = parts.find((part) => part.type === 'reasoning-end');
    assert.ok(reasoningEnd && reasoningEnd.type === 'reasoning-end');
    const provider = reasoningEnd.providerMetadata?.['alibaba-token-plan-cn'] as
      | { reasoningSummary?: Array<{ type: string; text: string }> }
      | undefined;

    assert.deepEqual(streamed, deltas);
    assert.deepEqual(provider?.reasoningSummary, [
      { type: 'summary_text', text: '检查请求。调用 Maka 工具。' },
    ]);
  });

  test('Alibaba-compatible content deltas still match the final summary metadata', async () => {
    const deltas = ['Inspect the request. ', 'Call the Maka tool.'];
    const summary = [{ type: 'summary_text' as const, text: deltas.join('') }];
    const parts = await alibabaStreamParts(
      plaintextReasoningStream(deltas, ANSWER, summary, 'qwen3.8-max'),
    );
    const streamed = parts
      .filter((part) => part.type === 'reasoning-delta')
      .map((part) => part.delta)
      .join('');
    const reasoningEnd = parts.find((part) => part.type === 'reasoning-end');
    assert.ok(reasoningEnd && reasoningEnd.type === 'reasoning-end');
    const provider = reasoningEnd.providerMetadata?.['alibaba-token-plan-cn'] as
      | { reasoningSummary?: Array<{ type: string; text: string }> }
      | undefined;
    assert.deepEqual(provider?.reasoningSummary, [
      { type: 'summary_text', text: 'Inspect the request. Call the Maka tool.' },
    ]);
    assert.equal(streamed, provider?.reasoningSummary?.map((part) => part.text).join(''));
  });

  test('the pinned SDK flushes an unfinalized item without provider metadata', async () => {
    const parts = await alibabaStreamParts(unfinalizedReasoningStream('completed'));
    const reasoningEnd = parts.find((part) => part.type === 'reasoning-end');
    const finish = parts.find((part) => part.type === 'finish');

    assert.ok(reasoningEnd);
    assert.equal(reasoningEnd.providerMetadata, undefined);
    assert.equal(finish?.finishReason.unified, 'stop');
  });

  test('the pinned SDK keeps response.failed ahead of its unfinalized trailer', async () => {
    const parts = await alibabaStreamParts(unfinalizedReasoningStream('failed'));
    const reasoningEnd = parts.find((part) => part.type === 'reasoning-end');
    const finish = parts.find((part) => part.type === 'finish');

    assert.ok(reasoningEnd);
    assert.equal(reasoningEnd.providerMetadata, undefined);
    assert.equal(finish?.finishReason.unified, 'error');
    assert.equal(finish?.finishReason.raw, 'rate_limit_exceeded');
  });

  test('streamed reasoning text reaches the model stream', async () => {
    const deltas = ['The user asks if 91 is prime. ', '91 = 7 x 13, ', 'so it is composite.'];
    const parts = await streamParts('deepseek', sseFetch(plaintextReasoningStream(deltas)));
    assert.equal(parts.reasoning, deltas.join(''));
    assert.equal(parts.text, ANSWER);
  });

  test('everything the transport does not translate passes through untouched', async () => {
    // The transport rewrites every response body from this provider, so the
    // reply it is not there to change is the one thing most worth pinning:
    // dropping message frames wholesale would otherwise leave the suite green.
    const parts = await streamParts(
      'deepseek',
      sseFetch(plaintextReasoningStream(['thinking'], 'The answer is 42.')),
    );
    assert.equal(parts.text, 'The answer is 42.');
  });

  test('reasoning survives frames split across chunk boundaries', async () => {
    // SSE frames arrive on arbitrary byte boundaries, so a translator that
    // assumes one whole event per chunk loses text without failing loudly.
    // The text is deliberately not ASCII: DeepSeek reasons in the language it
    // was asked in, and a 7-byte chunk cuts these characters mid-sequence, so
    // this also pins the decoder's cross-chunk state.
    const deltas = ['用户问 91 是不是质数。', '91 = 7 × 13，', '所以它是合数。'];
    const parts = await streamParts('deepseek', sseFetch(plaintextReasoningStream(deltas), 7));
    assert.equal(parts.reasoning, deltas.join(''));
    assert.equal(parts.text, ANSWER);
  });

  test('a provider we have not measured is left untranslated', async () => {
    // The transport is mounted per provider, not per wire. xAI reaches the same
    // Responses wire but its reasoning shape has not been measured, so nothing
    // should rewrite its stream on the strength of the wire alone.
    const parts = await streamParts('xai', sseFetch(plaintextReasoningStream(['ignored'])));
    assert.equal(parts.reasoning, '');
    assert.equal(parts.text, ANSWER);
  });

  test('ordinary function calls still finish as tool-calls', async () => {
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch: sseFetch(standardFunctionCallStream()),
    });
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'read package.json' }] }],
      tools: [
        {
          type: 'function',
          name: 'Read',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      providerOptions: buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'high'),
    });

    const parts = [];
    for await (const part of stream) parts.push(part);
    assert.deepEqual(
      parts.find((part) => part.type === 'tool-call'),
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'Read',
        input: '{\"path\":\"package.json\"}',
        // 2.0.34 preserves the provider item identity used by ordered replay.
        providerMetadata: { deepseek: { itemId: 'fc_1' } },
      },
    );
    assert.equal(parts.find((part) => part.type === 'finish')?.finishReason.unified, 'tool-calls');
  });

  test('non-streaming reasoning content is read', async () => {
    let body: string | undefined;
    const fetch = (async () => {
      body = JSON.stringify({
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: ITEM_ID,
            summary: [],
            content: [{ type: 'reasoning_text', text: REASONING }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'high'),
    });
    const reasoning = result.content.filter((part) => part.type === 'reasoning');
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].text, REASONING);
  });
});
