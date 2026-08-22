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
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { getAIModel } from '@maka/runtime/model-factory';

const connection: RuntimeExecutionConnection = {
  slug: 'relay',
  providerType: 'openai-compatible',
  baseUrl: 'https://relay.invalid/v1',
  defaultModel: 'claude-opus-4-8',
};

const prompt: LanguageModelV4CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
];

const tools: LanguageModelV4CallOptions['tools'] = [
  {
    type: 'function',
    name: 'read_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    type: 'function',
    name: 'write_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

interface ToolCallDelta {
  index?: number | null;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

function chunk(delta: unknown, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'claude-opus-4-8',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function deltaRelay(deltas: readonly ToolCallDelta[]): typeof globalThis.fetch {
  const payloads = [
    ...deltas.map((delta) => chunk({ tool_calls: [delta] })),
    chunk({}, 'tool_calls'),
  ];
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectDeltas(
  deltas: readonly ToolCallDelta[],
  providerType: 'openai-compatible' | 'openai' = 'openai-compatible',
): Promise<{ parts: LanguageModelV4StreamPart[]; failure: unknown }> {
  const model = getAIModel({
    connection: { ...connection, providerType },
    apiKey: 'test-key',
    modelId: 'claude-opus-4-8',
    fetch: deltaRelay(deltas),
  });
  const { stream } = await model.doStream({ prompt, tools });
  const parts: LanguageModelV4StreamPart[] = [];
  try {
    for await (const part of stream) parts.push(part);
  } catch (error) {
    return { parts, failure: error };
  }
  const errorPart = parts.find((part) => part.type === 'error');
  return { parts, failure: errorPart ? (errorPart as { error: unknown }).error : undefined };
}

function toolCallsOf(parts: LanguageModelV4StreamPart[]) {
  return parts
    .filter((part) => part.type === 'tool-call')
    .map(({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }));
}

function assertHealthyStream(parts: LanguageModelV4StreamPart[], failure: unknown): void {
  assert.equal(failure, undefined);
  assert.equal(parts.at(-1)?.type, 'finish');
  const calls = toolCallsOf(parts);
  const ids = calls.map(({ toolCallId }) => toolCallId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    ids.filter((id) => id.trim() === ''),
    [],
  );
  for (const { toolCallId, toolName, input } of calls) {
    if (input !== '') JSON.parse(input);
    const streamed = parts
      .filter((part) => part.type === 'tool-input-delta' && part.id === toolCallId)
      .map((part) => (part as { delta: string }).delta)
      .join('');
    assert.equal(streamed, input);
    const start = parts.find((part) => part.type === 'tool-input-start' && part.id === toolCallId);
    assert.equal(
      start === undefined ? undefined : (start as { toolName: string }).toolName,
      toolName,
    );
  }
}

describe('streamed tool-call association', () => {
  test('orders distinct non-zero indices without treating them as storage slots', async () => {
    const { parts, failure } = await collectDeltas([
      {
        index: 2,
        id: 'call_second',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      {
        index: 1,
        id: 'call_first',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
    ]);

    assertHealthyStream(parts, failure);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolCallId }) => toolCallId),
      ['call_first', 'call_second'],
    );
  });

  for (const providerType of ['openai-compatible', 'openai'] as const) {
    test(`keeps calls distinct when ${providerType} reuses index zero`, async () => {
      const { parts, failure } = await collectDeltas(
        [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a"}' },
          },
          {
            index: 0,
            id: 'call_b',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"b"}' },
          },
        ],
        providerType,
      );

      assertHealthyStream(parts, failure);
      assert.deepEqual(toolCallsOf(parts), [
        { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
        { toolCallId: 'call_b', toolName: 'write_file', input: '{"path":"b"}' },
      ]);
    });
  }

  test('continues the only open call when index is absent', async () => {
    const { parts, failure } = await collectDeltas([
      { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
      { function: { arguments: 'th":"a"}' } },
    ]);

    assertHealthyStream(parts, failure);
    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
    ]);
  });

  test('records an id that arrives after the call starts', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, type: 'function', function: { name: 'read_file', arguments: '{"pa' } },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { index: 0, id: 'late', function: { arguments: 'th"' } },
      { id: 'late', function: { arguments: ':"a"}' } },
    ]);

    assertHealthyStream(parts, failure);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolName, input }) => ({ toolName, input })),
      [
        { toolName: 'read_file', input: '{"path":"a"}' },
        { toolName: 'write_file', input: '{}' },
      ],
    );
  });

  test('fails closed when a bare delta could belong to several calls', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { function: { arguments: '{"path":"a"}' } },
    ]);

    assert.notEqual(failure, undefined);
    const calls = toolCallsOf(parts);
    assert.equal(new Set(calls.map(({ toolCallId }) => toolCallId)).size, calls.length);
  });

  test('fails closed when index and id address different calls', async () => {
    const { failure } = await collectDeltas([
      { index: 0, id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'write_file', arguments: '' } },
      { index: 0, id: 'call_b', function: { arguments: '{}' } },
    ]);

    assert.notEqual(failure, undefined);
  });

  for (const providerType of ['openai-compatible', 'openai'] as const) {
    test(`treats blank continuation aliases as absent on ${providerType}`, async () => {
      const { parts, failure } = await collectDeltas(
        [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path"' },
          },
          { index: 0, id: ' ', function: { arguments: ':"a"}' } },
        ],
        providerType,
      );

      assertHealthyStream(parts, failure);
      assert.deepEqual(toolCallsOf(parts), [
        { toolCallId: 'call_a', toolName: 'read_file', input: '{"path":"a"}' },
      ]);
    });
  }

  test('mints unique usable ids when wire ids are unavailable', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: ' ', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { index: 1, id: '\t', type: 'function', function: { name: 'write_file', arguments: '{}' } },
    ]);

    assertHealthyStream(parts, failure);
    assert.deepEqual(
      toolCallsOf(parts).map(({ toolName }) => toolName),
      ['read_file', 'write_file'],
    );
  });

  test('replaces a non-adjacent duplicate wire id', async () => {
    const { parts, failure } = await collectDeltas([
      { index: 0, id: 'dup', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      {
        index: 1,
        id: 'other',
        type: 'function',
        function: { name: 'write_file', arguments: '{}' },
      },
      { index: 2, id: 'dup', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ]);

    assertHealthyStream(parts, failure);
    assert.equal(toolCallsOf(parts).length, 3);
  });
});
