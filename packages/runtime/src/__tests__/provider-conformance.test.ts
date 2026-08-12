import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { after, describe, test } from 'node:test';
import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core/llm-connections';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, isStepCount, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import { resolveOAuthSubscriptionAccessToken } from '../subscription-credentials.js';
import { testConnection } from '../test-connection.js';
import {
  closeAllJsonServers,
  readBody,
  respondJson,
  respondOpenAIStream,
  startJsonServer,
} from './conformance-harness.js';

after(closeAllJsonServers);

describe('models.dev provider conformance', () => {
  test('native Anthropic sends automatic prompt caching on the Messages wire', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/messages');
      assert.equal(request.headers['x-api-key'], 'anthropic-test-key');
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'msg_anthropic_cache',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'Cached.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 4,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
    });
    const connection: LlmConnection = {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      baseUrl: server.url,
      defaultModel: 'claude-opus-4-8',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    await generateText({
      model: getAIModel({
        connection,
        apiKey: 'anthropic-test-key',
        modelId: connection.defaultModel,
      }),
      prompt: 'Hello.',
      providerOptions: buildProviderOptions(connection, connection.defaultModel),
    });

    assert.deepEqual(requestBody?.cache_control, { type: 'ephemeral' });
  });

  test('Anthropic Messages accepts the Claude Code web_search_20250305 tool', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'msg_anthropic_search',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'server_tool_use',
            id: 'search_cc',
            name: 'web_search',
            input: { query: 'latest Maka' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'search_cc',
            content: [
              {
                type: 'web_search_result',
                url: 'https://maka.example/',
                title: 'Maka',
                encrypted_content: 'encrypted-result',
                page_age: '2026-08-04',
              },
            ],
          },
          { type: 'text', text: 'Search complete.' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 3 },
      });
    });
    const connection: LlmConnection = {
      slug: 'anthropic-search',
      name: 'Anthropic Search',
      providerType: 'anthropic',
      baseUrl: server.url,
      defaultModel: 'claude-sonnet-4-6',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    await generateText({
      model: getAIModel({
        connection,
        apiKey: 'anthropic-test-key',
        modelId: connection.defaultModel,
      }),
      prompt: 'Search.',
      tools: {
        WebSearch: anthropic.tools.webSearch_20250305({ maxUses: 8 }),
      },
      maxRetries: 0,
    });

    assert.deepEqual(requestBody?.tools, [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 8,
      },
    ]);
  });

  test('Anthropic Messages replays provider-executed web search inside assistant content', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'msg_anthropic_search_replay',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: 'Replay complete.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 3 },
      });
    });
    const connection: LlmConnection = {
      slug: 'anthropic-compatible-search-replay',
      name: 'Anthropic-compatible Search Replay',
      providerType: 'anthropic-compatible',
      baseUrl: server.url,
      defaultModel: 'deepseek-v4-flash',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Search.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search_cc',
            toolName: 'WebSearch',
            input: { query: 'latest Maka' },
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'search_cc',
            toolName: 'WebSearch',
            output: {
              type: 'json',
              value: [
                {
                  type: 'web_search_result',
                  url: 'https://maka.example/',
                  title: 'Maka',
                  pageAge: null,
                  encryptedContent: 'encrypted-result',
                },
              ],
            },
          },
        ],
      },
      { role: 'user', content: 'Continue without searching.' },
    ];

    await generateText({
      model: getAIModel({
        connection,
        apiKey: 'anthropic-test-key',
        modelId: connection.defaultModel,
      }),
      messages,
      tools: {
        WebSearch: anthropic.tools.webSearch_20250305({ maxUses: 8 }),
      },
      maxRetries: 0,
    });

    const requestMessages = requestBody?.messages as
      | Array<{ role?: string; content?: Array<Record<string, unknown>> }>
      | undefined;
    const assistant = requestMessages?.find((message) => message.role === 'assistant');
    assert.deepEqual(assistant?.content?.[0], {
      type: 'server_tool_use',
      id: 'search_cc',
      name: 'web_search',
      input: { query: 'latest Maka' },
    });
    assert.deepEqual(assistant?.content?.[1], {
      type: 'web_search_tool_result',
      tool_use_id: 'search_cc',
      content: [
        {
          type: 'web_search_result',
          url: 'https://maka.example/',
          title: 'Maka',
          page_age: null,
          encrypted_content: 'encrypted-result',
        },
      ],
    });
  });

  test('xAI OAuth credential completes a Grok 4.5 Responses reasoning tool loop', async () => {
    const modelId = 'grok-4.5';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, 'Bearer xai-oauth-access-refreshed');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'resp_xai_tool',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: modelId,
          output: [
            {
              type: 'reasoning',
              id: 'rs_xai_encrypted',
              summary: [],
              encrypted_content: 'encrypted-reasoning',
            },
            {
              type: 'function_call',
              id: 'fc_xai_echo',
              call_id: 'call_xai_echo',
              name: 'echo',
              arguments: '{"text":"hello"}',
              status: 'completed',
            },
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'resp_xai_final',
        object: 'response',
        created_at: 2,
        status: 'completed',
        model: modelId,
        output: [
          {
            type: 'message',
            id: 'msg_xai_final',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Echoed hello.', annotations: [], logprobs: [] },
            ],
          },
        ],
        usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: 'xai-oauth',
      name: 'xAI OAuth',
      providerType: 'xai-oauth',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    let storedTokens = JSON.stringify({
      access_token: 'xai-oauth-access-expired',
      refresh_token: 'xai-oauth-refresh',
      expires_at: 1_000,
    });
    let refreshRequests = 0;
    const accessToken = await resolveOAuthSubscriptionAccessToken({
      providerType: 'xai-oauth',
      slug: connection.slug,
      credentialStore: {
        getSecret: async () => storedTokens,
        compareAndSetSecret: async (_slug, _kind, expected, value) => {
          if (storedTokens !== expected) return { committed: false, current: storedTokens };
          storedTokens = value;
          return { committed: true };
        },
      },
      now: () => 10_000,
      fetchFn: async (url, init) => {
        refreshRequests += 1;
        assert.equal(String(url), 'https://auth.x.ai/oauth2/token');
        assert.equal(init?.signal instanceof AbortSignal, true);
        return Response.json({
          access_token: 'xai-oauth-access-refreshed',
          refresh_token: 'xai-oauth-refresh-rotated',
          expires_in: 3_600,
        });
      },
    });
    assert.ok(accessToken);
    assert.equal(refreshRequests, 1);
    assert.equal(
      (JSON.parse(storedTokens) as { refresh_token: string }).refresh_token,
      'xai-oauth-refresh-rotated',
    );

    const result = await generateText({
      model: getAIModel({ connection, apiKey: accessToken, modelId }),
      prompt: 'Call echo with hello.',
      providerOptions: buildProviderOptions(connection, modelId, 'high'),
      stopWhen: isStepCount(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.deepEqual(
      requestBodies.map((body) => body.model),
      [modelId, modelId],
    );
    assert.equal(requestBodies[0]?.store, false);
    assert.deepEqual(requestBodies[0]?.include, ['reasoning.encrypted_content']);
    assert.deepEqual(requestBodies[0]?.reasoning, { effort: 'high' });
    const secondInput = requestBodies[1]?.input as Array<Record<string, unknown>>;
    assert.deepEqual(
      secondInput.find(({ type }) => type === 'reasoning'),
      {
        type: 'reasoning',
        id: 'rs_xai_encrypted',
        encrypted_content: 'encrypted-reasoning',
        summary: [],
      },
    );
    assert.deepEqual(
      secondInput.find(({ type }) => type === 'function_call_output'),
      {
        type: 'function_call_output',
        call_id: 'call_xai_echo',
        output: '{"echoed":"hello"}',
      },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('GitHub Copilot connection probe validates the selected account model without inference', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/models');
      assert.equal(request.headers.authorization, 'Bearer github-account-token');
      respondJson(response, 200, {
        data: [
          {
            id: 'gpt-5.4',
            model_picker_enabled: true,
            supported_endpoints: ['/responses'],
            policy: { state: 'enabled' },
            capabilities: { supports: { tool_calls: true } },
          },
        ],
      });
    });
    const result = await testConnection(
      {
        slug: 'github-copilot',
        name: 'GitHub Copilot',
        providerType: 'github-copilot',
        baseUrl: server.url,
        defaultModel: 'gpt-5.4',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'github-account-token',
    );

    assert.deepEqual(result, { ok: true, latencyMs: result.latencyMs, modelTested: 'gpt-5.4' });
  });

  test('GitHub Copilot connection probe rejects an account that cannot discover models', async () => {
    const server = await startJsonServer((_request, response) => respondJson(response, 403, {}));
    const result = await testConnection(
      {
        slug: 'github-copilot',
        name: 'GitHub Copilot',
        providerType: 'github-copilot',
        baseUrl: server.url,
        defaultModel: 'gpt-5.4',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'github-account-token',
    );

    assert.equal(result.ok, false);
  });

  test('connection probe does not revive fallback ids from an authoritative empty inventory', async () => {
    const result = await testConnection(
      {
        slug: 'openai-empty',
        name: 'OpenAI Empty',
        providerType: 'openai',
        baseUrl: 'http://127.0.0.1:1/v1',
        defaultModel: 'gpt-5.5',
        enabled: false,
        models: [],
        modelSource: 'fetched',
        createdAt: 1,
        updatedAt: 1,
      },
      'unused',
    );
    assert.deepEqual(result, { ok: false, errorMessage: 'No model to test' });
  });

  test('connection probe skips a stale default when a live inventory is available', async () => {
    const requestedModels: string[] = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as { model: string };
      requestedModels.push(body.model);
      respondJson(response, 200, {});
    });
    const connection: LlmConnection = {
      slug: 'moonshot-main',
      name: 'Moonshot',
      providerType: 'moonshot',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'moonshot-v1-8k',
      enabledModelIds: ['moonshot-v1-8k', 'kimi-k2.6'],
      models: [{ id: 'kimi-k2.5' }, { id: 'kimi-k2.6' }],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.equal((await testConnection(connection, 'moonshot-key')).modelTested, 'kimi-k2.6');
    assert.equal(
      (await testConnection(connection, 'moonshot-key', 'explicit-preview')).modelTested,
      'explicit-preview',
    );
    const legacy = { ...connection, models: undefined, enabledModelIds: undefined };
    assert.equal((await testConnection(legacy, 'moonshot-key')).modelTested, 'moonshot-v1-8k');
    assert.deepEqual(requestedModels, ['kimi-k2.6', 'explicit-preview', 'moonshot-v1-8k']);
  });

  test('connection probe verifies a connection that enables no models at all', async () => {
    // Enabling zero models is a real, persistable state, and the settings page
    // no longer names a model when it asks for a test. The credential still has
    // to be verifiable: with nothing enabled and no fetched inventory, the probe
    // falls back to the provider's own model rather than 'No model to test'.
    const requestedModels: string[] = [];
    const server = await startJsonServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as { model: string };
      requestedModels.push(body.model);
      respondJson(response, 200, {});
    });
    const result = await testConnection(
      {
        slug: 'moonshot-empty',
        name: 'Moonshot Empty',
        providerType: 'moonshot',
        baseUrl: `${server.url}/v1`,
        defaultModel: '',
        enabledModelIds: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'moonshot-key',
    );

    assert.equal(result.ok, true);
    assert.equal(requestedModels.length, 1);
    assert.ok(
      PROVIDER_DEFAULTS.moonshot.fallbackModels.includes(requestedModels[0]!),
      `expected a provider fallback model, got ${requestedModels[0]}`,
    );
  });

  test('connection probe bounds a fallback snapshot to its non-empty inventory', async () => {
    const requestedModels: string[] = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as { model: string };
      requestedModels.push(body.model);
      respondJson(response, 200, {});
    });
    const result = await testConnection(
      {
        slug: 'moonshot-fallback',
        name: 'Moonshot Fallback',
        providerType: 'moonshot',
        baseUrl: `${server.url}/v1`,
        defaultModel: 'custom-moonshot-preview',
        enabledModelIds: ['custom-moonshot-preview'],
        models: [{ id: 'kimi-k2.6' }],
        modelSource: 'fallback',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'moonshot-key',
    );

    assert.equal(result.modelTested, 'kimi-k2.6');
    assert.deepEqual(requestedModels, ['kimi-k2.6']);
  });

  test('OpenAI routes gpt-5* through the Responses wire and other models through Chat Completions by declaration', async () => {
    const requests: string[] = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer openai-test-key');
      requests.push(request.url ?? '');
      await readBody(request);
      if (request.url === '/v1/responses') {
        respondJson(response, 200, {
          id: 'resp_gpt5',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5.5',
          output: [
            {
              type: 'message',
              id: 'msg_gpt5',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'Responses wire.', annotations: [], logprobs: [] },
              ],
            },
          ],
          usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
        });
        return;
      }
      assert.equal(request.url, '/v1/chat/completions');
      respondJson(response, 200, {
        id: 'chatcmpl-gpt4o',
        object: 'chat.completion',
        created: 2,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Chat wire.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      });
    });
    const connection: LlmConnection = {
      slug: 'openai',
      name: 'OpenAI',
      providerType: 'openai',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'gpt-5.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const gpt5 = await generateText({
      model: getAIModel({ connection, apiKey: 'openai-test-key', modelId: 'gpt-5.5' }),
      prompt: 'Say hi.',
    });
    const gpt4o = await generateText({
      model: getAIModel({ connection, apiKey: 'openai-test-key', modelId: 'gpt-4o' }),
      prompt: 'Say hi.',
    });

    assert.deepEqual(requests, ['/v1/responses', '/v1/chat/completions']);
    assert.equal(gpt5.text, 'Responses wire.');
    assert.equal(gpt4o.text, 'Chat wire.');
  });

  test('DeepSeek V4 Flash uses Responses and accepts provider-native web search', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl: string | undefined;
    let authorization: string | undefined;
    const server = await startJsonServer(async (request, response) => {
      requestUrl = request.url;
      authorization = request.headers.authorization;
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'resp_deepseek_search',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'deepseek-v4-flash',
        output: [
          {
            type: 'web_search_call',
            id: 'search_deepseek',
            status: 'completed',
            action: { type: 'search', queries: ['latest Maka'] },
          },
          {
            type: 'message',
            id: 'msg_deepseek',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Search complete.',
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      });
    });
    const connection: LlmConnection = {
      slug: 'deepseek',
      name: 'DeepSeek',
      providerType: 'deepseek',
      baseUrl: server.url,
      defaultModel: 'deepseek-v4-flash',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    await generateText({
      model: getAIModel({
        connection,
        apiKey: 'deepseek-test-key',
        modelId: connection.defaultModel,
      }),
      prompt: 'Search.',
      tools: { WebSearch: openai.tools.webSearch() },
      maxRetries: 0,
    });

    assert.equal(requestUrl, '/responses');
    assert.equal(authorization, 'Bearer deepseek-test-key');
    assert.deepEqual(requestBody?.tools, [{ type: 'web_search' }]);
  });

  test('DeepSeek Responses replays hosted web search as an item reference, not an orphan output', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {
        id: 'resp_deepseek_search_replay',
        object: 'response',
        created_at: 2,
        status: 'completed',
        model: 'deepseek-v4-flash',
        output: [
          {
            type: 'message',
            id: 'msg_deepseek_replay',
            status: 'completed',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Replay complete.',
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      });
    });
    const connection: LlmConnection = {
      slug: 'deepseek-search-replay',
      name: 'DeepSeek Search Replay',
      providerType: 'deepseek',
      baseUrl: server.url,
      defaultModel: 'deepseek-v4-flash',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Search.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'search_deepseek',
            toolName: 'WebSearch',
            input: {},
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'search_deepseek',
            toolName: 'WebSearch',
            output: {
              type: 'json',
              value: { action: { type: 'search', queries: ['latest Maka'] } },
            },
          },
        ],
      },
      { role: 'user', content: 'Continue without searching.' },
    ];

    await generateText({
      model: getAIModel({
        connection,
        apiKey: 'deepseek-test-key',
        modelId: connection.defaultModel,
      }),
      messages,
      tools: { WebSearch: openai.tools.webSearch() },
      maxRetries: 0,
    });

    const input = requestBody?.input as Array<Record<string, unknown>> | undefined;
    assert.equal(
      input?.some((item) => item.type === 'function_call_output'),
      false,
      JSON.stringify(input),
    );
    assert.equal(
      input?.some((item) => item.type === 'item_reference' && item.id === 'search_deepseek'),
      true,
      JSON.stringify(input),
    );
  });

  test('OpenCode Zen routes GPT through Responses and preserves tool results across both stages', async () => {
    const modelId = 'gpt-5.5';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer opencode-test-key');
      if (request.method === 'GET' && request.url === '/zen/v1/models') {
        respondJson(response, 200, { data: [{ id: modelId }] });
        return;
      }
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/zen/v1/responses');
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'resp_opencode_zen_tool',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: modelId,
          output: [
            {
              type: 'function_call',
              id: 'fc_opencode_zen_echo',
              call_id: 'call_opencode_zen_echo',
              name: 'echo',
              arguments: '{"text":"hello"}',
              status: 'completed',
            },
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'resp_opencode_zen_final',
        object: 'response',
        created_at: 2,
        status: 'completed',
        model: modelId,
        output: [
          {
            type: 'message',
            id: 'msg_opencode_zen_final',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Echoed hello.', annotations: [], logprobs: [] },
            ],
          },
        ],
        usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: 'opencode',
      name: 'OpenCode Zen',
      providerType: 'opencode',
      baseUrl: `${server.url}/zen/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.deepEqual(await fetchProviderModels(connection, 'opencode-test-key'), [{ id: modelId }]);
    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'opencode-test-key', modelId }),
      prompt: 'Call echo with hello.',
      stopWhen: isStepCount(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.deepEqual(
      requestBodies.map((body) => body.model),
      [modelId, modelId],
    );
    assert.deepEqual(
      (requestBodies[1].input as Array<Record<string, unknown>>).find(
        ({ type }) => type === 'function_call_output',
      ),
      {
        type: 'function_call_output',
        call_id: 'call_opencode_zen_echo',
        output: '{"echoed":"hello"}',
      },
    );
    assert.equal(result.text, 'Echoed hello.');
  });

  test('OpenCode connection probes follow each selected model protocol', async () => {
    const requests: Array<{
      url: string;
      headers: IncomingMessage['headers'];
      body: Record<string, unknown>;
    }> = [];
    const server = await startJsonServer(async (request, response) => {
      requests.push({
        url: request.url ?? '',
        headers: request.headers,
        body: JSON.parse(await readBody(request)) as Record<string, unknown>,
      });
      respondJson(response, 200, {});
    });
    const connection: LlmConnection = {
      slug: 'opencode',
      name: 'OpenCode Zen',
      providerType: 'opencode',
      baseUrl: `${server.url}/zen/v1`,
      defaultModel: 'gpt-5.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    for (const modelId of ['gpt-5.5', 'claude-opus-4-8', 'gemini-3.5-flash']) {
      assert.equal((await testConnection(connection, 'opencode-test-key', modelId)).ok, true);
    }

    assert.deepEqual(
      requests.map(({ url }) => url),
      ['/zen/v1/responses', '/zen/v1/messages', '/zen/v1/models/gemini-3.5-flash:generateContent'],
    );
    assert.equal(requests[0]?.headers.authorization, 'Bearer opencode-test-key');
    assert.deepEqual(requests[0]?.body.input, [{ role: 'user', content: 'Hi' }]);
    assert.equal(requests[1]?.headers['x-api-key'], 'opencode-test-key');
    assert.deepEqual(requests[1]?.body.messages, [{ role: 'user', content: 'Hi' }]);
    assert.equal(requests[2]?.headers['x-goog-api-key'], 'opencode-test-key');
    assert.deepEqual(requests[2]?.body.contents, [{ role: 'user', parts: [{ text: 'Hi' }] }]);
  });

  test('Volcengine Agent Plan connection probes do not retain the synthetic response', async () => {
    let body: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/api/plan/v3/responses');
      assert.equal(request.headers.authorization, 'Bearer ark-plan-token');
      body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {});
    });
    const connection: LlmConnection = {
      slug: 'volcengine-agent-plan',
      name: 'Volcengine Ark Agent Plan (China)',
      providerType: 'volcengine-agent-plan',
      baseUrl: `${server.url}/api/plan/v3`,
      defaultModel: 'ark-code-latest',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.equal((await testConnection(connection, 'ark-plan-token')).ok, true);
    assert.equal(body?.store, false);
  });

  test('DeepSeek V4 Pro connection probes use its default Responses wire', async () => {
    let body: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondJson(response, 200, {});
    });
    const connection: LlmConnection = {
      slug: 'deepseek',
      name: 'DeepSeek',
      providerType: 'deepseek',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'deepseek-v4-pro',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    assert.equal((await testConnection(connection, 'deepseek-token')).ok, true);
    assert.equal(body?.model, 'deepseek-v4-pro');
    assert.equal(body?.store, false);
  });

  test('Ollama Cloud requests usage in streamed chat completions', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      requestBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondOpenAIStream(response, [
        {
          id: 'chatcmpl-ollama-cloud-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'glm-5.2',
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
        },
      ]);
    });
    const connection: LlmConnection = {
      slug: 'ollama-cloud',
      name: 'Ollama Cloud',
      providerType: 'ollama-cloud',
      baseUrl: `${server.url}/v1`,
      defaultModel: 'glm-5.2',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const result = streamText({
      model: getAIModel({ connection, apiKey: 'ollama-cloud-test-key', modelId: 'glm-5.2' }),
      prompt: 'Reply ok.',
    });

    assert.equal(await result.text, 'ok');
    assert.deepEqual(requestBody?.stream_options, { include_usage: true });
    const usage = await result.usage;
    assert.equal(usage.inputTokens, 8);
    assert.equal(usage.outputTokens, 1);
    assert.equal(usage.totalTokens, 9);
  });

  test('Hugging Face discovers tool-capable routed models and preserves its two-stage OpenAI wire', async () => {
    const discoveredModelId = 'openai/gpt-oss-120b';
    const modelId = `${discoveredModelId}:preferred`;
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.headers.authorization, 'Bearer hf-test-token');
      if (request.method === 'GET' && request.url === '/v1/models') {
        respondJson(response, 200, {
          object: 'list',
          data: [
            {
              id: discoveredModelId,
              object: 'model',
              owned_by: 'openai',
              providers: [{ provider: 'together', status: 'live', supports_tools: true }],
            },
            {
              id: 'sentence-transformers/all-MiniLM-L6-v2',
              object: 'model',
              owned_by: 'sentence-transformers',
              providers: [{ provider: 'hf-inference', status: 'live', supports_tools: false }],
            },
          ],
        });
        return;
      }

      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'chatcmpl-hf-tool',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                reasoning_content: 'I should call echo and use its result.',
                tool_calls: [
                  {
                    id: 'call_echo',
                    type: 'function',
                    function: { name: 'echo', arguments: '{"text":"hello"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        });
        return;
      }

      respondJson(response, 200, {
        id: 'chatcmpl-hf-final',
        object: 'chat.completion',
        created: 2,
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Echoed hello.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 14, completion_tokens: 5, total_tokens: 19 },
      });
    });
    const connection: LlmConnection = {
      slug: 'huggingface',
      name: 'Hugging Face',
      providerType: 'huggingface',
      baseUrl: `${server.url}/v1`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const models = await fetchProviderModels(connection, 'hf-test-token');
    assert.deepEqual(models, [{ id: discoveredModelId, capabilities: { functionCalling: true } }]);

    const result = await generateText({
      model: getAIModel({ connection, apiKey: 'hf-test-token', modelId }),
      prompt: 'Call echo with hello.',
      stopWhen: isStepCount(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.equal(requestBodies.length, 2);
    assert.deepEqual(
      requestBodies.map((body) => body.model),
      [modelId, modelId],
    );
    const secondMessages = requestBodies[1]?.messages as Array<{
      role: string;
      content: unknown;
      reasoning_content?: string;
    }>;
    assert.equal(
      secondMessages.find(({ role }) => role === 'assistant')?.reasoning_content,
      'I should call echo and use its result.',
    );
    assert.deepEqual(
      secondMessages.find(({ role }) => role === 'tool'),
      { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
    );
    assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
    assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
    assert.equal(result.text, 'Echoed hello.');
  });
});
