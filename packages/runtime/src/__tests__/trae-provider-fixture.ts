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
import { runConnectionModelDiscoveryEffect } from '../model-fetcher.js';
import { getAIModel, buildProviderOptions } from '../model-factory.js';
import { parseTraeCatalog } from '../trae/catalog.js';
import { traeMessages, traeToolSchema } from '../trae/messages.js';
import { ModelAdapter } from '../model-adapter.js';
import type { LlmConnection } from '@maka/core/llm-connections';

/** Discovery through the Host's effect entry, unwrapped for tests that expect a list. */
export async function fetchTraeModels(
  ...input: Parameters<typeof runConnectionModelDiscoveryEffect>
) {
  const outcome = await runConnectionModelDiscoveryEffect(...input);
  if (!outcome.ok) throw Object.assign(new Error('Trae discovery failed'), { outcome });
  return [...outcome.models];
}

export const traeCatalogFixture = {
  config_info_list: [
    {
      config_name: 'gpt-5.6-sol',
      usage: 'chat_completion',
      config_switch: true,
      display_config: {
        display_name: 'GPT-5.6-Sol',
        model_capability: 'reasoning_model',
        multimodal: true,
        tool_response_multimodal: true,
      },
      model_detail_list: [
        {
          model_name: 'gpt-5.6-sol__dev',
          prompt_max_tokens: 240000,
          max_tokens: 32000,
          model_extra_config: JSON.stringify({
            reasoning_effort_options: ['low', 'medium', 'high'],
          }),
        },
        {
          model_name: 'gpt-5.6-sol__max',
          prompt_max_tokens: 768000,
          max_tokens: 32000,
          model_extra_config: JSON.stringify({ reasoning_effort_options: ['high', 'ultra'] }),
        },
      ],
    },
  ],
};
export function traeConnection(): LlmConnection {
  const models = parseTraeCatalog(traeCatalogFixture);
  return {
    createdAt: 1,
    updatedAt: 1,
    slug: 'trae',
    name: 'Trae',
    providerType: 'trae',
    enabled: true,
    defaultModel: models[0]!.id,
    enabledModelIds: models.map((model) => model.id),
    models,
  };
}
export function traeResponse(frames: Array<[string, unknown]>, split = false): Response {
  const bytes = new TextEncoder().encode(
    frames
      .map(([event, data]) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`)
      .join(''),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        if (split)
          for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

export async function runTraeContract(): Promise<void> {
  const connection = traeConnection();
  const models = await fetchTraeModels(connection, 'account-token', {
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://copilot-cn.bytedance.net/api/ide/v1/get_detail_param');
      assert.equal(new Headers(init?.headers).get('x-jwt-token'), 'account-token');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      assert.equal(JSON.parse(String(init?.body)).function, 'traecli_next');
      return Response.json(traeCatalogFixture);
    },
  });
  assert.equal(models.length, 2);
  assert.equal(models[1]?.contextWindow, 800000);
  assert.equal(models[1]?.inputLimit, 768000);
  const selected = models[1]!;
  const requests: Record<string, unknown>[] = [];
  let call = 0;
  const model = getAIModel({
    connection: { ...connection, models },
    apiKey: 'account-token',
    modelId: selected.id,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      assert.equal(new Headers(init?.headers).get('x-jwt-token'), 'account-token');
      return call++ === 0
        ? traeResponse(
            [
              ['queue_begin', { position: 3 }],
              ['queue_end', {}],
              ['output', { reasoning_content: '推理中的空格 ' }],
              [
                'output',
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      function_call: { name: 'read_file', arguments: '{"path":' },
                    },
                  ],
                },
              ],
              [
                'output',
                { tool_calls: [{ index: 0, function_call: { arguments: '"README.md"}' } }] },
              ],
              [
                'token_usage',
                { prompt_tokens: 100, completion_tokens: 20, cache_read_input_tokens: 40 },
              ],
              ['done', { finish_reason: 'tool_calls' }],
            ],
            true,
          )
        : traeResponse(
            [
              ['output', { response: '  完成\n' }],
              ['done', { finish_reason: 'stop' }],
            ],
            true,
          );
    },
  });
  const first = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Read README' }] }],
    tools: [
      {
        type: 'function',
        name: 'read_file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    providerOptions: buildProviderOptions({ ...connection, models }, selected.id, 'ultra'),
  });
  assert.equal(first.finishReason.unified, 'tool-calls');
  assert.equal(first.usage.inputTokens.total, 100);
  assert.equal(first.usage.inputTokens.cacheRead, 40);
  const tool = first.content.find((part) => part.type === 'tool-call');
  assert.ok(tool?.type === 'tool-call');
  assert.equal(tool.input, '{"path":"README.md"}');
  const second = await model.doGenerate({
    prompt: [
      { role: 'user', content: [{ type: 'text', text: 'Read README' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'private prior reasoning' },
          {
            type: 'tool-call',
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            input: JSON.parse(tool.input),
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            output: { type: 'text', value: 'README contents' },
          },
        ],
      },
    ],
  });
  assert.deepEqual(second.content, [{ type: 'text', text: '  完成\n' }]);
  assert.equal(requests[0]?.config_name, 'gpt-5.6-sol');
  assert.equal(requests[0]?.model_name, 'gpt-5.6-sol__max');
  assert.equal(requests[0]?.reasoning_effort, 'max');
  assert.equal(requests[0]?.session_id, requests[1]?.session_id);
  assert.ok(!JSON.stringify(requests[1]).includes('private prior reasoning'));
  const history = requests[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(history[2]?.role, 'tool');
  assert.equal(history[2]?.tool_call_id, 'call-1');
  const schema = {
    type: 'object',
    title: 'annotation',
    properties: {
      title: { type: 'string', default: 'x' },
      default: { enum: [{ title: 'literal' }] },
    },
  };
  assert.deepEqual(traeToolSchema(schema), {
    type: 'object',
    properties: {
      title: { type: 'string' },
      // A non-string literal set cannot be a Gemini enum; it survives as a hint.
      default: { type: 'object', description: 'Allowed values: {"title":"literal"}.' },
    },
  });
  assert.ok(
    traeMessages(
      [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: new Uint8Array([1, 2]) },
            },
          ],
        },
      ],
      selected.trae!,
    )[0]?.content[0]?.type === 'image_url',
  );
}

export async function runTraeSdkQueueContract(): Promise<void> {
  const connection = traeConnection();
  const adapter = new ModelAdapter({
    connection,
    apiKey: 'account-token',
    modelId: connection.defaultModel,
    modelFactory: (input) =>
      getAIModel({
        ...input,
        fetch: async () =>
          traeResponse([
            ['queue_begin', { position: 4 }],
            ['request_wait_in_queue', { position: 2 }],
            ['queue_end', {}],
            ['output', { response: 'hello' }],
            ['token_usage', { prompt_tokens: 10, completion_tokens: 1 }],
            ['done', { finish_reason: 'stop' }],
          ]),
      }),
    newId: () => 'id',
    now: Date.now,
  });
  let activity = 0;
  const stream = await adapter.startStream({
    model: adapter.resolveModel(),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: {},
    activeTools: [],
    repairToolCall: () => null,
    abortSignal: new AbortController().signal,
    onStreamActivity: () => {
      activity += 1;
    },
  });
  const events = [];
  for await (const event of stream.events) events.push(event);
  assert.deepEqual(
    events.filter((event) => event.kind === 'provider-queue'),
    [
      { kind: 'provider-queue', queued: true, position: 4 },
      { kind: 'provider-queue', queued: true, position: 2 },
      { kind: 'provider-queue', queued: false },
    ],
  );
  assert.ok(events.some((event) => event.kind === 'text' && event.text === 'hello'));
  assert.ok(activity >= 5);
}
