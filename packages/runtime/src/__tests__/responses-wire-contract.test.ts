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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { z } from 'zod';
import { modelMetadataIdsForProvider } from '@maka/core/model-metadata';
import { PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import { ModelAdapter } from '../model-adapter.js';
import { TOOL_SEARCH_PROVIDER_NAME } from '../tool-availability.js';
import { resolveModelRuntime } from '../model-runtime.js';
import { resolveRuntimeProviderAdapter } from '../provider-runtime-policy.js';
import { lowerModelTools } from '../model-adapter.js';
import { openAiCodexCompactionMessages } from '../openai-codex-history-compactor.js';
import { openAiResponsesBaseUrl, openResponsesUrl } from '../provider-urls.js';

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

/** OpenAI's encrypted Responses dialect still reads the `openai` namespace. */
function openAiNamespace(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const inner = options.openai;
  return typeof inner === 'object' && inner !== null
    ? (inner as Record<string, unknown>)
    : undefined;
}

describe('responses wire contract', () => {
  test('does not route Maka tool_search history through OpenAI native tool_search validation', async () => {
    const connection = conn('openai-codex', 'codex-subscription');
    connection.defaultModel = 'gpt-5.6-sol';
    const requestBodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        id: 'response-tool-search-alias',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new ModelAdapter({
      connection,
      apiKey: 'test-token',
      modelId: connection.defaultModel,
      modelFactory: (input) =>
        getAIModel({
          connection,
          apiKey: input.apiKey,
          modelId: connection.defaultModel,
          fetch,
        }),
      newId: () => 'test-id',
      now: () => 0,
    });
    const result = await adapter.startStream({
      model: adapter.resolveModel(),
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'search-call',
              toolName: 'tool_search',
              input: { query: 'browser' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'search-call',
              toolName: 'tool_search',
              output: { type: 'json', value: { activated: ['browser_click'] } },
            },
          ],
        },
      ],
      tools: {
        tool_search: {
          description: 'Search Maka deferred tools',
          inputSchema: z.object({ query: z.string() }),
        },
      },
      activeTools: ['tool_search'],
      system: 'Call tool_search; keep existing maka_tool_search text unchanged.',
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
    });
    for await (const _event of result.events) void _event;
    const body = requestBodies[0];
    const input = body?.input as Array<Record<string, unknown>>;
    assert.equal(
      input?.find((item) => item.type === 'function_call')?.name,
      TOOL_SEARCH_PROVIDER_NAME,
    );
    assert.equal(
      input?.find((item) => item.type === 'function_call_output')?.call_id,
      'search-call',
    );
    assert.equal(
      input?.find((item) => item.role === 'developer')?.content,
      'Call maka_tool_search; keep existing maka_tool_search text unchanged.',
    );
  });

  test('routes only Qwen3.8 Max through Token Plan Responses', () => {
    for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
      assert.equal(
        resolveModelRuntime({ providerType }, 'qwen3.8-max').wire,
        'openai-responses',
        providerType,
      );
      assert.equal(resolveModelRuntime({ providerType }, 'qwen3.7-max').wire, 'openai-chat');
      assert.equal(
        resolveModelRuntime(
          { providerType, models: [{ id: 'qwen3.8-max', apiProtocol: 'openai-chat' }] },
          'qwen3.8-max',
        ).wire,
        'openai-chat',
      );
    }
  });

  test('keeps Qwen3.8 Max on Alibaba (China) Chat until the provider adapter supports Responses', () => {
    assert.equal(
      resolveModelRuntime({ providerType: 'alibaba-cn' }, 'qwen3.8-max').wire,
      'openai-chat',
    );
  });

  test('routes OpenCode Go Muse Spark through the Responses endpoint', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('opencode-go'),
      apiKey: '[redacted]',
      modelId: 'muse-spark-1.2-contributor',
      fetch,
    });

    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    });

    assert.deepEqual(urls, ['https://opencode.ai/zen/go/v1/responses']);
  });

  test('normalizes the upstream Open Responses endpoint exactly once', () => {
    assert.equal(
      openResponsesUrl('https://api.deepseek.com/v1'),
      'https://api.deepseek.com/v1/responses',
    );
    assert.equal(
      openResponsesUrl('https://api.deepseek.com/v1/responses'),
      'https://api.deepseek.com/v1/responses',
    );
    assert.equal(openResponsesUrl('https://relay.example/'), 'https://relay.example/responses');
  });

  test('reduces an endpoint-form override to the base the native adapter expects', async () => {
    assert.equal(
      openAiResponsesBaseUrl('https://relay.example/v1/responses'),
      'https://relay.example/v1',
    );
    assert.equal(openAiResponsesBaseUrl('https://relay.example/v1'), 'https://relay.example/v1');
    assert.equal(openAiResponsesBaseUrl('https://relay.example/'), 'https://relay.example/');

    // Behavior level: the probe accepts the endpoint form; the native OpenAI
    // adapter appends `/responses` internally, so the request must not land on
    // `/responses/responses` (#2972).
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request, _init?: RequestInit) => {
      urls.push(String(url));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = {
      ...conn('openai-responses-compatible'),
      baseUrl: 'https://relay.example/v1/responses',
    };
    const model = getAIModel({ connection, apiKey: '[redacted]', modelId: 'relay-model', fetch });

    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    });

    assert.deepEqual(urls, ['https://relay.example/v1/responses']);
  });

  test('resolves only supported Responses adapter and replay pairings', () => {
    const deepseek = resolveModelRuntime({ providerType: 'deepseek' }, 'deepseek-v4-flash');
    assert.deepEqual(deepseek.reasoningReplay, {
      kind: 'responses',
      contract: { adapter: 'open-responses', reasoningReplay: 'plaintext-content' },
    });
    assert.equal(deepseek.responsesProviderOptionsKey, undefined);
    assert.equal(deepseek.responsesReplayProfile, undefined);

    const alibaba = resolveModelRuntime({ providerType: 'alibaba-token-plan-cn' }, 'qwen3.8-max');
    assert.deepEqual(alibaba.reasoningReplay, {
      kind: 'responses',
      contract: {
        adapter: 'open-responses',
        reasoningReplay: 'plaintext-summary',
        compatibility: 'alibaba-token-plan',
      },
    });
    assert.equal(alibaba.responsesProviderOptionsKey, 'alibaba-token-plan-cn');
    assert.equal(alibaba.responsesReplayProfile, 'alibaba-token-plan-cn');
    const accountScopedAlibaba = resolveModelRuntime(
      { providerType: 'alibaba-token-plan-cn', slug: 'token-plan-account-a' },
      'qwen3.8-max',
    );
    assert.equal(accountScopedAlibaba.responsesProviderOptionsKey, 'alibaba-token-plan-cn');
    assert.equal(accountScopedAlibaba.responsesReplayProfile, 'token-plan-account-a');

    const xai = resolveModelRuntime({ providerType: 'xai' }, 'grok-4.5');
    assert.deepEqual(xai.reasoningReplay, {
      kind: 'responses',
      contract: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
    });

    const relay = resolveModelRuntime(
      { providerType: 'openai-responses-compatible' },
      'relay-model',
    );
    assert.deepEqual(relay.reasoningReplay, {
      kind: 'responses',
      contract: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
    });
  });

  test('resolves parallel tool calls from model facts before native wire defaults', () => {
    assert.equal(
      resolveModelRuntime({ providerType: 'openai' }, 'gpt-5.5').parallelToolCalls,
      true,
    );
    assert.equal(
      resolveModelRuntime(
        {
          providerType: 'openai',
          models: [{ id: 'gpt-5.5', capabilities: { parallelToolCalls: false } }],
        },
        'gpt-5.5',
      ).parallelToolCalls,
      false,
    );
    assert.equal(
      resolveModelRuntime({ providerType: 'openai-compatible' }, 'relay-model').parallelToolCalls,
      undefined,
    );
    assert.equal(
      resolveModelRuntime(
        {
          providerType: 'openai-compatible',
          models: [{ id: 'relay-model', capabilities: { parallelToolCalls: true } }],
        },
        'relay-model',
      ).parallelToolCalls,
      true,
    );
  });

  test('enables Responses only through an explicit supported contract', () => {
    const configured = Object.entries(PROVIDER_REGISTRY).flatMap(([providerType, definition]) => {
      const adapter = resolveRuntimeProviderAdapter(definition.runtimeAdapter);
      return adapter.kind === 'openai-compatible' && adapter.responses
        ? [{ providerType, contract: adapter.responses }]
        : [];
    });

    assert.deepEqual(configured, [
      {
        providerType: 'deepseek',
        contract: { adapter: 'open-responses', reasoningReplay: 'plaintext-content' },
      },
      {
        providerType: 'xai',
        contract: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
      },
      {
        providerType: 'xai-oauth',
        contract: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
      },
      {
        providerType: 'alibaba-token-plan-cn',
        contract: {
          adapter: 'open-responses',
          reasoningReplay: 'plaintext-summary',
          compatibility: 'alibaba-token-plan',
        },
      },
      {
        providerType: 'alibaba-token-plan',
        contract: {
          adapter: 'open-responses',
          reasoningReplay: 'plaintext-summary',
          compatibility: 'alibaba-token-plan',
        },
      },
    ]);

    const relay = PROVIDER_REGISTRY['openai-responses-compatible'].runtimeAdapter;
    assert.equal(relay.kind, 'openai');
  });

  test('every encrypted-content Responses contract asks for encrypted reasoning', () => {
    // `store: false` is not a privacy preference here, it is the switch that
    // makes the SDK add `include: ['reasoning.encrypted_content']` and drop
    // reasoning items that came back without one. Asking is the only way a
    // provider that speaks that contract can hand back a replayable chain;
    // for one that does not, the drop stops us shipping empty husks. This
    // asserts we ask — not that any given provider answers, and not that
    // encrypted content is the only dialect a provider may carry reasoning in.
    const gaps: string[] = [];
    for (const providerType of Object.keys(PROVIDER_REGISTRY) as LlmConnection['providerType'][]) {
      const modelIds = new Set([
        ...PROVIDER_REGISTRY[providerType].fallbackModels,
        ...modelMetadataIdsForProvider(providerType),
      ]);
      for (const modelId of modelIds) {
        let runtime: ReturnType<typeof resolveModelRuntime>;
        try {
          runtime = resolveModelRuntime({ providerType }, modelId);
        } catch {
          continue;
        }
        if (
          runtime.wire !== 'openai-responses' ||
          (runtime.reasoningReplay.kind === 'responses' &&
            runtime.reasoningReplay.contract.adapter === 'open-responses')
        ) {
          continue;
        }
        // Sweep the declared levels and the unset case: `store` is a property
        // of the wire, not of a thinking choice, so a model reaches this branch
        // whether or not a level was picked.
        for (const level of [undefined, ...thinkingVariantsForModel(providerType, modelId)]) {
          const options = buildProviderOptions(conn(providerType), modelId, level);
          const openai = openAiNamespace(options);
          const label = `${providerType}/${modelId} @ ${level ?? 'unset'}`;
          if (!openai) {
            gaps.push(`${label} wires no openai namespace: ${JSON.stringify(options)}`);
          } else if (openai.store !== false) {
            gaps.push(`${label} omits store:false: ${JSON.stringify(options)}`);
          }
        }
      }
    }
    assert.deepEqual(gaps, []);
  });
});

describe('responses wire request body', () => {
  test('Alibaba compatibility owns store:false after request overlays', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'response-1',
        object: 'response',
        created_at: 1,
        model: 'qwen3.8-max',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = {
      ...conn('alibaba-token-plan-cn'),
      baseUrl: 'https://token-plan.example/compatible-mode/v1',
      requestBodyOverlay: { store: true },
    };
    const model = getAIModel({
      connection,
      apiKey: 'token-plan-key',
      modelId: 'qwen3.8-max',
      fetch,
    });

    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      providerOptions: buildProviderOptions(connection, 'qwen3.8-max', 'medium'),
    });

    assert.deepEqual(urls, ['https://token-plan.example/compatible-mode/v1/responses']);
    assert.equal(bodies[0]?.store, false);
    assert.deepEqual(bodies[0]?.reasoning, { effort: 'medium' });
  });

  test('Alibaba compatibility preserves documented required tool choices', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'response-required-tool',
        object: 'response',
        created_at: 1,
        model: 'qwen3.8-max',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = {
      ...conn('alibaba-token-plan-cn'),
      baseUrl: 'https://token-plan.example/compatible-mode/v1',
    };
    const model = getAIModel({
      connection,
      apiKey: 'token-plan-key',
      modelId: 'qwen3.8-max',
      fetch,
    });

    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'look it up' }] }],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
      toolChoice: { type: 'required' },
    });

    const allowedToolsChoice = {
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'function', name: 'lookup' }],
    };
    const overlayModel = getAIModel({
      connection: { ...connection, requestBodyOverlay: { tool_choice: allowedToolsChoice } },
      apiKey: 'token-plan-key',
      modelId: 'qwen3.8-max',
      fetch,
    });
    await overlayModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'look it up again' }] }],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });

    assert.equal(bodies[0]?.tool_choice, 'required');
    assert.equal((bodies[0]?.tools as unknown[] | undefined)?.length, 1);
    assert.equal(bodies[0]?.store, false);
    assert.deepEqual(bodies[1]?.tool_choice, allowedToolsChoice);
    assert.equal((bodies[1]?.tools as unknown[] | undefined)?.length, 1);
    assert.equal(bodies[1]?.store, false);
  });

  test('Alibaba compatibility survives header-only request customization', async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return Response.json({
        id: 'response-header-customization',
        object: 'response',
        created_at: 1,
        model: 'qwen3.8-max',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = {
      ...conn('alibaba-token-plan-cn'),
      baseUrl: 'https://token-plan.example/compatible-mode/v1',
    };
    const model = getAIModel({
      connection,
      apiKey: 'token-plan-key',
      modelId: 'qwen3.8-max',
      requestHeaders: { 'x-token-plan-routing': 'custom' },
      fetch,
    });

    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    });

    assert.equal(body?.store, false);
    assert.equal(headers?.get('x-token-plan-routing'), 'custom');
  });

  test('adds the V2 trigger only through the explicit OpenAI provider option', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const ordinaryModel = getAIModel({
      connection: conn('openai-codex', 'codex-subscription'),
      apiKey: 'codex-token',
      modelId: 'gpt-5.3-codex',
      fetch,
    });
    await ordinaryModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ordinary model' }] }],
    });

    await ordinaryModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'compact me' }] }],
      providerOptions: { openai: { compactionTrigger: true } },
    });
    await ordinaryModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ordinary request' }] }],
      providerOptions: { openai: { compactionTrigger: false } },
    });

    const ordinaryInput = bodies[0]?.input;
    const compactInput = bodies[1]?.input;
    const unmarkedInput = bodies[2]?.input;
    assert.ok(Array.isArray(ordinaryInput));
    assert.ok(Array.isArray(compactInput));
    assert.ok(Array.isArray(unmarkedInput));
    assert.equal(
      ordinaryInput.some((item) => item.type === 'compaction_trigger'),
      false,
    );
    assert.deepEqual(compactInput.at(-1), { type: 'compaction_trigger' });
    assert.equal(
      unmarkedInput.some((item) => item.type === 'compaction_trigger'),
      false,
    );
  });

  test('keeps provider-executed tool history free of dangling outputs', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const event = (
      id: string,
      role: RuntimeEvent['role'],
      author: RuntimeEvent['author'],
      content: RuntimeEvent['content'],
      refs?: RuntimeEvent['refs'],
    ): RuntimeEvent => ({
      id,
      invocationId: 'inv-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      partial: false,
      role,
      author,
      content,
      ...(refs ? { refs } : {}),
    });
    const messages = openAiCodexCompactionMessages([
      event('user', 'user', 'user', { kind: 'text', text: 'search' }),
      event(
        'call',
        'model',
        'agent',
        {
          kind: 'function_call',
          id: 'search-1',
          name: 'WebSearch',
          args: { query: 'latest Maka' },
          providerExecuted: true,
        },
        { stepId: 'provider-step' },
      ),
      event('result', 'tool', 'tool', {
        kind: 'function_response',
        id: 'search-1',
        name: 'WebSearch',
        result: { type: 'web_search_result', query: 'latest Maka' },
        providerOutput: { type: 'web_search_result', id: 'ws_123' },
        providerExecuted: true,
        isError: false,
      }),
      event(
        'text',
        'model',
        'agent',
        { kind: 'text', text: 'Maka shipped.' },
        { providerEventId: 'provider-step' },
      ),
    ]);
    assert.deepEqual(
      messages.map((message) => ({
        role: message.role,
        parts:
          typeof message.content === 'string' ? ['text'] : message.content.map((part) => part.type),
      })),
      [
        { role: 'user', parts: ['text'] },
        { role: 'assistant', parts: ['tool-call'] },
        { role: 'tool', parts: ['tool-result'] },
        { role: 'assistant', parts: ['text'] },
      ],
    );

    const model = getAIModel({
      connection: conn('openai-codex', 'codex-subscription'),
      apiKey: 'codex-token',
      modelId: 'gpt-5.3-codex',
      fetch,
    });
    await model.doGenerate({
      prompt: messages as never,
      providerOptions: { openai: { store: false, compactionTrigger: true } },
    });

    const input = body?.input as Array<Record<string, unknown>>;
    const callIds = new Set(
      input.filter((item) => item.type === 'function_call').map((item) => String(item.call_id)),
    );
    const danglingOutputIds = input
      .filter((item) => item.type === 'function_call_output')
      .map((item) => String(item.call_id))
      .filter((callId) => !callIds.has(callId));
    assert.deepEqual([...callIds], ['search-1']);
    assert.deepEqual(
      input
        .filter((item) => item.type === 'function_call_output')
        .map((item) => String(item.call_id)),
      ['search-1'],
    );
    assert.deepEqual(danglingOutputIds, [], JSON.stringify(input));
  });

  test('returns native apply_patch results with the provider output item', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = conn('openai');
    const model = getAIModel({ connection, apiKey: 'test-key', modelId: 'gpt-5.4', fetch });
    const tools = lowerModelTools({
      apply_patch: { kind: 'provider', providerTool: { kind: 'openai-apply-patch' } },
    });

    await model.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'apply_patch',
              input: {
                callId: 'call-1',
                operation: { type: 'delete_file', path: 'old.txt' },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'apply_patch',
              output: { type: 'json', value: { status: 'failed', output: 'conflict' } },
            },
          ],
        },
      ],
      tools: [tools.apply_patch as never],
      providerOptions: { openai: { store: false } },
    });

    assert.deepEqual((body?.input as unknown[] | undefined)?.at(-1), {
      type: 'apply_patch_call_output',
      call_id: 'call-1',
      status: 'failed',
      output: 'conflict',
    });
  });

  test('DeepSeek uses plaintext Responses options without asking for encrypted content', async () => {
    const bodies: Record<string, unknown>[] = [];
    let headers: Headers | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: 'r',
          object: 'response',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const connection = conn('deepseek');
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    for (const level of ['high', 'max'] as const) {
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: buildProviderOptions(connection, 'deepseek-v4-flash', level),
      });
    }

    assert.equal(bodies[0]?.store, undefined);
    assert.equal(bodies[0]?.include, undefined);
    assert.equal((bodies[0]?.reasoning as { effort?: string } | undefined)?.effort, 'high');
    // The provider-native reasoningEffort passes `max` through verbatim; the
    // old top-level enum downgrade (`xhigh`) would land on DeepSeek as high.
    assert.equal((bodies[1]?.reasoning as { effort?: string } | undefined)?.effort, 'max');
    assert.equal(headers?.get('authorization'), 'Bearer test-key');
  });

  test('replays plaintext reasoning before its function call and result', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = conn('deepseek');
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });

    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should inspect the requested file.' },
            {
              type: 'tool-call',
              toolCallId: 'call-read',
              toolName: 'Read',
              input: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-read',
              toolName: 'Read',
              output: { type: 'text', value: '{"name":"maka"}' },
            },
          ],
        },
      ],
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
    });

    const input = body?.input as Array<Record<string, unknown>> | undefined;
    assert.deepEqual(
      input?.map((item) => item.type),
      ['message', 'reasoning', 'function_call', 'function_call_output'],
    );
    assert.deepEqual(input?.[1], {
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'I should inspect the requested file.' }],
    });
    assert.deepEqual(input?.[2], {
      type: 'function_call',
      call_id: 'call-read',
      name: 'Read',
      arguments: '{"path":"package.json"}',
    });
    assert.deepEqual(input?.[3], {
      type: 'function_call_output',
      call_id: 'call-read',
      output: '{"name":"maka"}',
    });
  });
});
