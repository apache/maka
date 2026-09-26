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
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { LanguageModelV4ProviderTool, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { AiSdkMessageProjection } from '../ai-sdk-message-projection.js';
import { getAIModel } from '../model-factory.js';
import { ModelAdapter, lowerModelTools } from '../model-adapter.js';
import {
  buildRuntimeEventModelReplayPlan,
  type RuntimeEventModelReplayPlan,
} from '../model-history.js';
import {
  attachOpenResponsesExtensionReplayItem,
  createDeepSeekOpenResponsesExtensions,
  DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID,
  OPEN_RESPONSES_EXTENSION_REPLAY_KIND,
  openResponsesExtensionReplayCarrierPart,
  openResponsesExtensionReplayItem,
  openResponsesExtensionReplayReferenceOptions,
  rewriteDeepSeekOpenResponsesIncomingValue,
  rewriteDeepSeekOpenResponsesOutgoingBody,
  usesDeepSeekOpenResponsesExtensions,
  wrapFetchForDeepSeekOpenResponsesExtensions,
} from '../deepseek-open-responses-extensions.js';
import { routeWebSearchTools } from '../native-web-search-tool.js';

function conn(providerType: LlmConnection['providerType'], slug = 'test'): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function deepSeekAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: {
      slug: 'deepseek',
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
    },
    apiKey: 'test-key',
    modelId: 'deepseek-v4-flash',
    modelFactory: () => ({}),
    newId: () => 'id-1',
    now: () => 1,
  });
}

function anthropicReplayAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: {
      slug: 'anthropic-main',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
    },
    apiKey: 'test-key',
    modelId: 'claude-sonnet-4-5-20250929',
    modelFactory: () => ({}),
    newId: () => 'id-1',
    now: () => 1,
  });
}

function hostedReplayIdentity(plan: RuntimeEventModelReplayPlan): string[] {
  return plan.items.flatMap((item) =>
    item.kind === 'tool_call' || item.kind === 'tool_result'
      ? [`${item.invocationId}:${item.kind}:${item.toolCallId}`]
      : [],
  );
}

function crossInvocationHostedSearchHistory(ids: {
  deepSeek: string;
  anthropic: string;
}): RuntimeEvent[] {
  const exchange = (
    invocationId: string,
    toolCallId: string,
    providerOptions: Record<string, unknown>,
    providerOutput: unknown,
  ): RuntimeEvent[] => [
    {
      id: `${invocationId}-call`,
      invocationId,
      runId: invocationId,
      sessionId: 'session-replay',
      turnId: invocationId,
      ts: 1,
      partial: false,
      role: 'model',
      author: 'agent',
      refs: { stepId: `${invocationId}-step` },
      content: {
        kind: 'function_call',
        id: toolCallId,
        name: 'WebSearch',
        args: { query: 'latest Maka' },
        providerExecuted: true,
        providerOptions,
      },
    },
    {
      id: `${invocationId}-result`,
      invocationId,
      runId: invocationId,
      sessionId: 'session-replay',
      turnId: invocationId,
      ts: 2,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: toolCallId,
        name: 'WebSearch',
        result: providerOutput,
        providerExecuted: true,
        providerOutput,
        isError: false,
      },
    },
  ];
  return [
    ...exchange(
      'invocation-deepseek',
      ids.deepSeek,
      {
        deepseek: {
          openResponsesExtension: {
            id: 'openai.web_search',
            item: { id: ids.deepSeek, type: 'web_search_call', status: 'completed' },
          },
        },
      },
      { type: 'web_search_call', status: 'completed' },
    ),
    ...exchange('invocation-anthropic', ids.anthropic, { anthropic: { type: 'server_tool_use' } }, [
      {
        type: 'web_search_result',
        url: 'https://maka.example/',
        encryptedContent: 'encrypted-result',
      },
    ]),
  ];
}

function runtimeEvent(input: {
  id: string;
  role: RuntimeEvent['role'];
  author: RuntimeEvent['author'];
  content: RuntimeEvent['content'];
  refs?: RuntimeEvent['refs'];
}): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'inv-durable',
    runId: 'run-durable',
    sessionId: 'sess-durable',
    turnId: 'turn-durable',
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    content: input.content,
    ...(input.refs ? { refs: input.refs } : {}),
  };
}

function webSearchTool(): LanguageModelV4ProviderTool {
  const tools = lowerModelTools({
    WebSearch: { kind: 'provider', providerTool: { kind: 'openai-web-search' } },
  });
  return {
    ...(tools.WebSearch as object),
    type: 'provider',
    id: DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID,
    name: 'WebSearch',
    args: { searchContextSize: 'medium' },
  };
}

function completedResponse(output: unknown[]): Record<string, unknown> {
  return {
    id: 'resp_deepseek_search',
    object: 'response',
    created_at: 1_700_000_000,
    model: 'deepseek-v4-flash',
    status: 'completed',
    output,
    usage: { input_tokens: 8, output_tokens: 4 },
  };
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event, index) => `data: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`)
    .join('');
}

describe('DeepSeek Open Responses extension codecs', () => {
  test('registers against the compiled Open Responses search tool id', () => {
    const extensions = createDeepSeekOpenResponsesExtensions();
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0]?.id, DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID);
    assert.equal(usesDeepSeekOpenResponsesExtensions('deepseek'), true);
    assert.equal(usesDeepSeekOpenResponsesExtensions('alibaba-token-plan-cn'), false);
  });

  test('rewrites only allowlisted DeepSeek discriminators', () => {
    assert.deepEqual(
      rewriteDeepSeekOpenResponsesOutgoingBody({
        tools: [
          { type: 'openai:web_search' },
          { type: 'function', name: 'Read' },
          { type: 'openai.file_search' },
        ],
        tool_choice: { type: 'openai:web_search' },
        input: [
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'openai:web_search_call', id: 'ws_1', status: 'completed' },
        ],
      }),
      {
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'Read' },
          { type: 'openai.file_search' },
        ],
        tool_choice: { type: 'web_search' },
        input: [
          { type: 'message', role: 'user', content: 'hi' },
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        ],
      },
    );
    assert.deepEqual(
      rewriteDeepSeekOpenResponsesIncomingValue({
        type: 'response.web_search_call.in_progress',
        item_id: 'ws_1',
        item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' },
        output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }],
      }),
      {
        type: 'openai:web_search_call.in_progress',
        item_id: 'ws_1',
        item: { type: 'openai:web_search_call', id: 'ws_1', status: 'in_progress' },
        output: [{ type: 'openai:web_search_call', id: 'ws_1', status: 'completed' }],
      },
    );
    assert.equal(
      (
        rewriteDeepSeekOpenResponsesIncomingValue({ type: 'web_search_2025_08_26' }) as {
          type: string;
        }
      ).type,
      'openai:web_search',
    );
    assert.equal(
      rewriteDeepSeekOpenResponsesOutgoingBody({
        tools: [{ type: 'function', name: 'Read' }],
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      }),
      undefined,
    );
  });

  test('wrapFetch rewrites only allowlisted discriminators on the wire', async () => {
    let sent: Record<string, unknown> | undefined;
    const fetch = wrapFetchForDeepSeekOpenResponsesExtensions(async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        output: [
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_read',
            name: 'Read',
            arguments: '{}',
          },
        ],
      });
    });
    const response = await fetch('https://example.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: [{ type: 'openai:web_search' }, { type: 'function', name: 'Read' }],
        input: [{ type: 'openai:web_search_call', id: 'ws_1', status: 'completed' }],
      }),
    });
    assert.deepEqual(sent?.tools, [{ type: 'web_search' }, { type: 'function', name: 'Read' }]);
    assert.deepEqual(
      ((await response.json()) as { output: Array<{ type: string }> }).output.map(
        (item) => item.type,
      ),
      ['openai:web_search_call', 'function_call'],
    );
  });

  test('wrapFetch keeps JSON request bodies as text when nothing maps', async () => {
    let sent: unknown;
    const fetch = wrapFetchForDeepSeekOpenResponsesExtensions(async (_url, init) => {
      sent = init?.body;
      return Response.json({ output: [] });
    });
    await fetch('https://example.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: [{ type: 'function', name: 'Read' }],
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(typeof sent, 'string');
    assert.deepEqual(JSON.parse(String(sent)), {
      tools: [{ type: 'function', name: 'Read' }],
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    });
  });

  test('encodes DeepSeek hosted search as a bare web_search tool', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(completedResponse([]));
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search the web' }] }],
      tools: [webSearchTool()],
    });

    assert.deepEqual(bodies[0]?.tools, [{ type: 'web_search' }]);
    assert.equal(
      result.warnings?.some(
        (warning) =>
          warning.type === 'unsupported' &&
          warning.feature ===
            `provider-defined tool ${DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID}`,
      ),
      false,
      JSON.stringify(result.warnings),
    );
  });

  test('omits unregistered provider tools with an explicit warning', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(completedResponse([]));
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search files' }] }],
      tools: [
        webSearchTool(),
        { type: 'provider', id: 'openai.file_search', name: 'file_search', args: {} },
      ],
    });

    assert.deepEqual(bodies[0]?.tools, [{ type: 'web_search' }]);
    assert.equal(
      result.warnings?.some(
        (warning) =>
          warning.type === 'unsupported' &&
          warning.feature === 'provider-defined tool openai.file_search',
      ),
      true,
      JSON.stringify(result.warnings),
    );
  });

  test('decodes a completed hosted search item without entering the client tool loop', async () => {
    const fetch = (async () =>
      Response.json(
        completedResponse([
          {
            id: 'ws_opaque',
            type: 'web_search_call',
            status: 'completed',
            provider_trace: 'opaque-replay',
            action: { type: 'search', query: 'latest Maka', queries: ['latest Maka'] },
          },
          {
            id: 'msg_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Maka shipped the feature.' }],
          },
        ]),
      )) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      tools: [webSearchTool()],
    });

    const types = result.content.map((part) => part.type);
    assert.deepEqual(
      types.filter((type) => type === 'tool-call' || type === 'tool-result' || type === 'text'),
      ['tool-call', 'tool-result', 'text'],
    );
    const call = result.content.find((part) => part.type === 'tool-call');
    const searchResult = result.content.find((part) => part.type === 'tool-result');
    assert.equal(call && 'providerExecuted' in call ? call.providerExecuted : undefined, true);
    assert.equal(call && 'toolName' in call ? call.toolName : undefined, 'WebSearch');
    assert.match(JSON.stringify(call), /latest Maka/);
    assert.match(JSON.stringify(searchResult), /latest Maka/);
    assert.equal(
      result.finishReason.unified === 'stop' || result.finishReason.unified === 'tool-calls',
      true,
      JSON.stringify(result.finishReason),
    );
  });

  test('keeps mixed client and provider-executed tools in chronology', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(
        completedResponse([
          {
            id: 'ws_mixed',
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'maka codecs' },
          },
          {
            id: 'fc_read',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_read',
            name: 'Read',
            arguments: '{"path":"README.md"}',
          },
        ]),
      );
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search then read' }] }],
      tools: [
        webSearchTool(),
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
    });

    assert.deepEqual(
      (bodies[0]?.tools as Array<Record<string, unknown>> | undefined)?.map((tool) => tool.type),
      ['web_search', 'function'],
    );
    const owned = result.content
      .filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
      .map((part) => ({
        type: part.type,
        toolName: 'toolName' in part ? part.toolName : undefined,
        providerExecuted: 'providerExecuted' in part ? part.providerExecuted : undefined,
      }));
    assert.deepEqual(owned, [
      { type: 'tool-call', toolName: 'WebSearch', providerExecuted: true },
      { type: 'tool-result', toolName: 'WebSearch', providerExecuted: true },
      { type: 'tool-call', toolName: 'Read', providerExecuted: undefined },
    ]);
  });

  test('replays the original hosted search item exactly once', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(
        completedResponse([
          {
            id: 'ws_opaque',
            type: 'web_search_call',
            status: 'completed',
            provider_trace: 'opaque-replay',
            action: { type: 'open_page', url: 'https://maka.example/' },
          },
          {
            id: 'msg_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Opened the page.' }],
          },
        ]),
      );
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const first = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'open the docs' }] }],
      tools: [webSearchTool()],
    });
    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'open the docs' }] },
        { role: 'assistant', content: first.content as never },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
      tools: [webSearchTool()],
    });

    const replayed = (bodies[1]?.input as Array<Record<string, unknown>> | undefined)?.filter(
      (item) => item.type === 'web_search_call',
    );
    assert.equal(replayed?.length, 1, JSON.stringify(bodies[1]?.input));
    assert.equal(replayed?.[0]?.id, 'ws_opaque');
    assert.equal(replayed?.[0]?.provider_trace, 'opaque-replay');
    assert.deepEqual(replayed?.[0]?.action, { type: 'open_page', url: 'https://maka.example/' });
  });

  test('replays distinct hosted search items when ids differ', async () => {
    // SDK encode dedups on `${type}:${id}`. Distinct ids must both reach the
    // wire; same-id reuse across DeepSeek responses is unverified.
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(completedResponse([]));
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const first = {
      type: 'tool-call' as const,
      toolCallId: 'ws_a',
      toolName: 'WebSearch',
      input: JSON.stringify({ type: 'search', query: 'first' }),
      providerExecuted: true,
      providerOptions: {
        deepseek: {
          openResponsesExtension: {
            id: 'openai.web_search',
            item: {
              id: 'ws_a',
              type: 'openai:web_search_call',
              status: 'completed',
              action: { type: 'search', query: 'first' },
            },
          },
        },
      },
    };
    const second = {
      type: 'tool-call' as const,
      toolCallId: 'ws_b',
      toolName: 'WebSearch',
      input: JSON.stringify({ type: 'search', query: 'second' }),
      providerExecuted: true,
      providerOptions: {
        deepseek: {
          openResponsesExtension: {
            id: 'openai.web_search',
            item: {
              id: 'ws_b',
              type: 'openai:web_search_call',
              status: 'completed',
              action: { type: 'search', query: 'second' },
            },
          },
        },
      },
    };
    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'search twice' }] },
        { role: 'assistant', content: [first, second] as never },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
      tools: [webSearchTool()],
    });
    const replayed = (bodies[0]?.input as Array<Record<string, unknown>> | undefined)?.filter(
      (item) => item.type === 'web_search_call',
    );
    assert.deepEqual(
      replayed?.map((item) => item.id),
      ['ws_a', 'ws_b'],
      JSON.stringify(bodies[0]?.input),
    );
  });

  test('merges the opaque replay item onto tool-call provider options', () => {
    const item = {
      id: 'ws_merge',
      type: 'openai:web_search_call',
      status: 'completed',
      provider_trace: 'opaque-merge',
    };
    const merged = attachOpenResponsesExtensionReplayItem(
      { deepseek: { openResponsesExtension: { id: 'openai.web_search', itemId: 'ws_merge' } } },
      { deepseek: { openResponsesExtension: { id: 'openai.web_search', item } } },
    );
    assert.equal(openResponsesExtensionReplayItem(merged)?.provider_trace, 'opaque-merge');
    assert.equal(
      openResponsesExtensionReplayCarrierPart(merged)?.kind,
      OPEN_RESPONSES_EXTENSION_REPLAY_KIND,
    );
    assert.deepEqual(openResponsesExtensionReplayReferenceOptions(merged), {
      deepseek: { openResponsesExtension: { id: 'openai.web_search', itemId: 'ws_merge' } },
    });
    assert.equal(
      openResponsesExtensionReplayReferenceOptions({ anthropic: { type: 'server_tool_use' } }),
      undefined,
    );
  });

  test('replays the hosted search item through the durable RuntimeEvent boundary', async () => {
    const adapter = deepSeekAdapter();
    const pending = new Map();
    const item = {
      id: 'ws_durable',
      type: 'openai:web_search_call',
      status: 'completed',
      provider_trace: 'opaque-durable-trace',
      action: { type: 'search', query: 'durable replay' },
    };
    assert.deepEqual(
      adapter.translateChunk(
        {
          type: 'custom',
          kind: OPEN_RESPONSES_EXTENSION_REPLAY_KIND,
          providerMetadata: {
            deepseek: { openResponsesExtension: { id: 'openai.web_search', item } },
          },
        },
        undefined,
        pending,
      ),
      [],
    );
    const translated = adapter.translateChunk(
      {
        type: 'tool-call',
        toolCallId: 'ws_durable',
        toolName: 'WebSearch',
        input: JSON.stringify(item.action),
        providerExecuted: true,
        providerMetadata: {
          deepseek: { openResponsesExtension: { id: 'openai.web_search', itemId: 'ws_durable' } },
        },
      },
      undefined,
      pending,
    );
    const callEvent = translated[0];
    assert.equal(callEvent?.kind, 'tool-call');
    const persistedOptions =
      callEvent?.kind === 'tool-call' ? callEvent.toolCall.providerOptions : undefined;
    assert.equal(
      openResponsesExtensionReplayItem(persistedOptions)?.provider_trace,
      'opaque-durable-trace',
    );
    assert.ok(persistedOptions);

    const persisted = [
      runtimeEvent({
        id: 'evt-user-durable',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'search and remember the trace' },
      }),
      runtimeEvent({
        id: 'evt-search-call',
        role: 'model',
        author: 'agent',
        refs: { toolCallId: 'ws_durable', stepId: 'step-durable' },
        content: {
          kind: 'function_call',
          id: 'ws_durable',
          name: 'WebSearch',
          args: item.action,
          providerExecuted: true,
          providerOptions: persistedOptions,
        },
      }),
      runtimeEvent({
        id: 'evt-search-result',
        role: 'tool',
        author: 'tool',
        refs: { toolCallId: 'ws_durable' },
        content: {
          kind: 'function_response',
          id: 'ws_durable',
          name: 'WebSearch',
          result: { type: 'web_search_call', status: 'completed', action: item.action },
          providerExecuted: true,
          providerOutput: { type: 'web_search_call', status: 'completed', action: item.action },
          isError: false,
        },
      }),
    ].map((event) => encodeCanonicalRuntimeEvent(event).event);

    assert.equal(adapter.runtimeEventReplaySupport().providerExecutedTools, true);
    const plan = buildRuntimeEventModelReplayPlan(persisted);
    const projection = new AiSdkMessageProjection({
      modelAdapter: adapter,
      applyPatchProfile: null,
    });
    const replayPlan = projection.dropUnsupportedReplayItems(plan);
    assert.equal(
      replayPlan.items.filter((entry) => entry.kind === 'tool_call' || entry.kind === 'tool_result')
        .length,
      2,
      JSON.stringify(replayPlan.items.map((entry) => entry.kind)),
    );
    const messages = await projection.materializeRuntimeReplayPlan(
      replayPlan,
      { used: 0, decisions: new Map() },
      undefined,
      new Set(),
    );
    const assistant = messages.find(
      (message) =>
        message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === 'tool-call'),
    );
    assert.ok(assistant && Array.isArray(assistant.content), JSON.stringify(messages));
    const carrier = assistant.content.find(
      (part) => part.type === 'custom' && part.kind === OPEN_RESPONSES_EXTENSION_REPLAY_KIND,
    );
    assert.equal(
      openResponsesExtensionReplayItem(
        carrier && 'providerOptions' in carrier ? carrier.providerOptions : undefined,
      )?.provider_trace,
      'opaque-durable-trace',
      JSON.stringify(assistant.content),
    );

    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(completedResponse([]));
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [
        ...(messages as never[]),
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
      tools: [webSearchTool()],
    });

    const replayed = (bodies[0]?.input as Array<Record<string, unknown>> | undefined)?.filter(
      (entry) => entry.type === 'web_search_call',
    );
    assert.equal(replayed?.length, 1, JSON.stringify(bodies[0]?.input));
    assert.equal(replayed?.[0]?.id, 'ws_durable');
    assert.equal(replayed?.[0]?.provider_trace, 'opaque-durable-trace');
    assert.deepEqual(replayed?.[0]?.action, item.action);
    assert.equal(
      result.warnings?.some(
        (warning) =>
          warning.type === 'unsupported' &&
          warning.feature ===
            `provider-defined tool ${DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID} tool-result history`,
      ),
      false,
      JSON.stringify(result.warnings),
    );
  });

  test('keeps a later Anthropic hosted search when an older DeepSeek exchange reused its id', () => {
    const projection = new AiSdkMessageProjection({
      modelAdapter: anthropicReplayAdapter(),
      applyPatchProfile: null,
    });
    const replayToolIds = (toolCallId: { deepSeek: string; anthropic: string }) => {
      const plan = buildRuntimeEventModelReplayPlan(crossInvocationHostedSearchHistory(toolCallId));
      assert.deepEqual(hostedReplayIdentity(plan), [
        `invocation-deepseek:tool_call:${toolCallId.deepSeek}`,
        `invocation-deepseek:tool_result:${toolCallId.deepSeek}`,
        `invocation-anthropic:tool_call:${toolCallId.anthropic}`,
        `invocation-anthropic:tool_result:${toolCallId.anthropic}`,
      ]);
      return hostedReplayIdentity(projection.dropUnsupportedReplayItems(plan));
    };

    assert.deepEqual(
      replayToolIds({ deepSeek: 'search-deepseek', anthropic: 'search-anthropic' }),
      [
        'invocation-anthropic:tool_call:search-anthropic',
        'invocation-anthropic:tool_result:search-anthropic',
      ],
    );
    assert.deepEqual(replayToolIds({ deepSeek: 'search-reused', anthropic: 'search-reused' }), [
      'invocation-anthropic:tool_call:search-reused',
      'invocation-anthropic:tool_result:search-reused',
    ]);
  });

  test('marks a failed hosted search item as an error result', async () => {
    const fetch = (async () =>
      Response.json(
        completedResponse([
          {
            id: 'ws_failed',
            type: 'web_search_call',
            status: 'failed',
            action: { type: 'search', query: 'missing page' },
          },
        ]),
      )) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      tools: [webSearchTool()],
    });
    const searchResult = result.content.find((part) => part.type === 'tool-result');
    assert.equal(
      searchResult && 'providerExecuted' in searchResult
        ? searchResult.providerExecuted
        : undefined,
      true,
    );
    assert.equal(
      searchResult && 'isError' in searchResult ? searchResult.isError : undefined,
      true,
    );
    assert.match(JSON.stringify(searchResult), /failed/);
  });

  test('streams hosted-search progress then finishes without a client tool call', async () => {
    const fetch = (async () =>
      new Response(
        sse([
          {
            type: 'response.created',
            response: { id: 'resp_stream', status: 'in_progress', output: [] },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'ws_stream', type: 'web_search_call', status: 'in_progress' },
          },
          { type: 'response.web_search_call.in_progress', item_id: 'ws_stream' },
          { type: 'response.web_search_call.searching', item_id: 'ws_stream' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'ws_stream',
              type: 'web_search_call',
              status: 'completed',
              action: { type: 'find_in_page', url: 'https://maka.example/', pattern: 'codec' },
            },
          },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              id: 'msg_stream',
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          },
          {
            type: 'response.content_part.added',
            item_id: 'msg_stream',
            output_index: 1,
            content_index: 0,
            part: { type: 'output_text', text: '' },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg_stream',
            output_index: 1,
            content_index: 0,
            delta: 'Found the codec notes.',
          },
          {
            type: 'response.output_text.done',
            item_id: 'msg_stream',
            output_index: 1,
            content_index: 0,
            text: 'Found the codec notes.',
          },
          {
            type: 'response.content_part.done',
            item_id: 'msg_stream',
            output_index: 1,
            content_index: 0,
            part: { type: 'output_text', text: 'Found the codec notes.' },
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              id: 'msg_stream',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Found the codec notes.' }],
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp_stream',
              status: 'completed',
              output: [],
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'find the codec' }] }],
      tools: [webSearchTool()],
    });
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of stream) parts.push(part);

    assert.equal(
      parts.some(
        (part) =>
          part.type === 'tool-input-start' &&
          part.toolName === 'WebSearch' &&
          part.providerExecuted === true,
      ),
      true,
      JSON.stringify(parts.map((part) => part.type)),
    );
    assert.equal(
      parts.some(
        (part) =>
          part.type === 'tool-call' &&
          part.toolName === 'WebSearch' &&
          part.providerExecuted === true,
      ),
      true,
      JSON.stringify(
        parts.filter((part) => part.type === 'tool-call' || part.type === 'tool-result'),
      ),
    );
    assert.equal(
      parts.some((part) => part.type === 'tool-result' && part.toolName === 'WebSearch'),
      true,
    );
    assert.match(JSON.stringify(parts), /Found the codec notes/);
    const finish = parts.find((part) => part.type === 'finish');
    assert.ok(finish);
  });

  test('leaves generic Open Responses providers fail-closed for hosted search', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(completedResponse([]));
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: { ...conn('alibaba-token-plan-cn'), defaultModel: 'qwen3.8-max' },
      apiKey: 'test-key',
      modelId: 'qwen3.8-max',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      tools: [webSearchTool()],
    });
    assert.equal(bodies[0]?.tools, undefined);
    assert.equal(
      result.warnings?.some(
        (warning) =>
          warning.type === 'unsupported' &&
          warning.feature ===
            `provider-defined tool ${DEEPSEEK_OPEN_RESPONSES_WEB_SEARCH_EXTENSION_ID}`,
      ),
      true,
      JSON.stringify(result.warnings),
    );
  });

  test('keeps Tavily and Anthropic-compatible DeepSeek routing off the Responses codec', () => {
    const tavily = {
      name: 'WebSearch',
      description: 'Tavily',
      parameters: {},
      impl: async () => undefined,
    };
    const routedTavily = routeWebSearchTools({
      tools: [tavily],
      settings: { enabled: true, defaultProvider: 'tavily' },
      connection: {
        slug: 'deepseek',
        providerType: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
      },
      model: 'deepseek-v4-flash',
      tavilyReady: true,
    });
    assert.equal(routedTavily[0], tavily);

    const routedAnthropic = routeWebSearchTools({
      tools: [tavily],
      settings: { enabled: true, defaultProvider: 'model' },
      connection: {
        slug: 'anthropic-compatible',
        providerType: 'anthropic-compatible',
        defaultModel: 'deepseek-v4-flash',
        models: [{ id: 'deepseek-v4-flash', apiProtocol: 'anthropic-messages' }],
      },
      model: 'deepseek-v4-flash',
      tavilyReady: false,
    });
    assert.equal(routedAnthropic[0]?.providerTool?.kind, 'anthropic-web-search-20250305');
  });
});
