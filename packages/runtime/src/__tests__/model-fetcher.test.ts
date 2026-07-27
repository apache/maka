import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { fetchProviderModels, ProviderModelDiscoveryHttpError } from '../model-fetcher.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('fetchProviderModels', () => {
  test('OpenCode Zen and Go discover exact account model ids with their shared API-key auth shape', async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const server = await startJsonServer((request, response) => {
      requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
      respondJson(response, 200, {
        data: [{ id: request.url?.includes('/go/') ? 'minimax-m3' : 'gpt-5.5' }],
      });
    });
    const base = {
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    } as const;

    const zen = await fetchProviderModels(
      {
        ...base,
        slug: 'opencode',
        name: 'OpenCode Zen',
        providerType: 'opencode',
        baseUrl: `${server.url}/zen/v1`,
        defaultModel: 'gpt-5.5',
      },
      'opencode-test-key',
    );
    const go = await fetchProviderModels(
      {
        ...base,
        slug: 'opencode-go',
        name: 'OpenCode Go',
        providerType: 'opencode-go',
        baseUrl: `${server.url}/zen/go/v1`,
        defaultModel: 'minimax-m3',
      },
      'opencode-test-key',
    );

    assert.deepEqual(zen, [{ id: 'gpt-5.5' }]);
    assert.deepEqual(go, [{ id: 'minimax-m3' }]);
    assert.deepEqual(requests, [
      { url: '/zen/v1/models', authorization: 'Bearer opencode-test-key' },
      { url: '/zen/go/v1/models', authorization: 'Bearer opencode-test-key' },
    ]);
  });

  test('xAI OAuth discovers only supported Grok models with bearer auth', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, 'Bearer xai-oauth-token');
      respondJson(response, 200, {
        data: [{ id: 'grok-4.5' }, { id: 'grok-imagine-image' }],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'xai-oauth',
        name: 'xAI OAuth',
        providerType: 'xai-oauth',
        baseUrl: `${server.url}/v1`,
        defaultModel: 'grok-4.5',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'xai-oauth-token',
    );

    assert.deepEqual(models, [{ id: 'grok-4.5' }]);
  });

  test('xAI OAuth preserves discovery HTTP status for auth-failure classification', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 401, { error: 'invalid_token' });
    });

    await assert.rejects(
      fetchProviderModels(
        {
          slug: 'xai-oauth',
          name: 'xAI OAuth',
          providerType: 'xai-oauth',
          baseUrl: `${server.url}/v1`,
          defaultModel: 'grok-4.5',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        'expired-xai-oauth-token',
      ),
      (error: unknown) => error instanceof ProviderModelDiscoveryHttpError && error.status === 401,
    );
  });

  test('Vercel AI Gateway discovers the complete public language-model list without exposing its inference key', async () => {
    const modelId = 'anthropic/claude-opus-4.8';
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        object: 'list',
        data: [
          {
            id: modelId,
            object: 'model',
            name: 'Claude Opus 4.8',
            type: 'language',
            context_window: 1_000_000,
            max_tokens: 128_000,
            tags: ['reasoning', 'tool-use', 'vision'],
          },
          {
            id: 'openai/text-embedding-3-small',
            object: 'model',
            name: 'Text Embedding 3 Small',
            type: 'embedding',
          },
        ],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'vercel',
        name: 'Vercel AI Gateway',
        providerType: 'vercel',
        baseUrl: `${server.url}/v1`,
        defaultModel: modelId,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'vercel-inference-key',
    );

    assert.deepEqual(models, [
      {
        id: modelId,
        displayName: 'Claude Opus 4.8',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        capabilities: { vision: true, reasoning: true, functionCalling: true },
      },
    ]);
  });

  test('ZenMux intersects its public directory with the tool-capable snapshot without exposing its inference key', async () => {
    const modelId = 'moonshotai/kimi-k2.5';
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        object: 'list',
        data: [
          {
            id: modelId,
            object: 'model',
            display_name: 'Kimi K2.5',
            context_length: 262_000,
            input_modalities: ['text', 'image', 'video'],
            output_modalities: ['text'],
            capabilities: { reasoning: true },
          },
          {
            id: 'new-provider/new-model',
            object: 'model',
            display_name: 'Unreviewed Model',
            context_length: 128_000,
            input_modalities: ['text'],
            output_modalities: ['text'],
            capabilities: { reasoning: false },
          },
          {
            id: 'anthropic/claude-sonnet-4.6',
            object: 'model',
            display_name: 'Claude Sonnet 4.6',
            context_length: 1_000_000,
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            capabilities: { reasoning: true },
          },
        ],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'zenmux',
        name: 'ZenMux',
        providerType: 'zenmux',
        baseUrl: `${server.url}/v1`,
        defaultModel: modelId,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'zenmux-inference-key',
    );

    assert.deepEqual(models, [
      {
        id: modelId,
        displayName: 'Kimi K2.5',
        contextWindow: 262_000,
        capabilities: { vision: true, reasoning: true },
      },
    ]);
  });

  test('LocalAI discovers exact model aliases without sending empty authorization', async () => {
    const modelId = 'localai/Qwen3-8B-Instruct-GGUF:Q4_K_M';
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, { data: [{ id: modelId }] });
    });

    const models = await fetchProviderModels(
      {
        slug: 'localai',
        name: 'LocalAI',
        providerType: 'localai',
        baseUrl: `${server.url}/v1`,
        defaultModel: modelId,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      '',
    );

    assert.deepEqual(models, [{ id: modelId }]);
  });

  test('LocalAI sends a user-supplied API key as Bearer during discovery', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.headers.authorization, 'Bearer localai-user-key');
      respondJson(response, 200, { data: [{ id: 'qwen3-8b' }] });
    });

    await fetchProviderModels(
      {
        slug: 'localai-keyed',
        name: 'LocalAI protected',
        providerType: 'localai',
        baseUrl: `${server.url}/v1`,
        defaultModel: 'qwen3-8b',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'localai-user-key',
    );
  });

  test('LM Studio discovers exact local model ids without authentication', async () => {
    const server = await startJsonServer((request, response) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/models');
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        data: [
          { id: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF' },
          { id: 'mlx-community/Qwen3-4B-Instruct-4bit' },
        ],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'lm-studio',
        name: 'LM Studio',
        providerType: 'lm-studio',
        baseUrl: `${server.url}/v1`,
        defaultModel: '',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      '',
    );

    assert.deepEqual(models, [
      { id: 'lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF' },
      { id: 'mlx-community/Qwen3-4B-Instruct-4bit' },
    ]);
  });

  test('Z.ai fetches live /models results, including IDs outside fallback defaults', async () => {
    let observedAuth = '';
    let observedContentType = '';
    const server = await startJsonServer((request, response) => {
      observedAuth = request.headers.authorization ?? '';
      observedContentType = request.headers['content-type'] ?? '';
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/models');
      respondJson(response, 200, {
        data: [{ id: 'glm-4.6' }, { id: 'glm-z1-air' }],
      });
    });

    const models = await fetchProviderModels(
      { ...zaiConnection(), baseUrl: server.url },
      'zai-live-secret',
    );

    assert.equal(observedAuth, 'Bearer zai-live-secret');
    assert.equal(observedContentType, 'application/json');
    assert.deepEqual(models, [{ id: 'glm-4.6' }, { id: 'glm-z1-air' }]);
  });

  test('Z.ai baseUrl trailing slash is trimmed before appending /models', async () => {
    let observedPath = '';
    const server = await startJsonServer((request, response) => {
      observedPath = request.url ?? '';
      respondJson(response, 200, { data: [{ id: 'glm-live' }] });
    });

    const models = await fetchProviderModels(
      { ...zaiConnection(), baseUrl: `${server.url}/` },
      'zai-live-secret',
    );

    assert.equal(observedPath, '/models');
    assert.deepEqual(models, [{ id: 'glm-live' }]);
  });

  test('provider model capability fields are preserved when present', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 200, {
        data: [
          {
            id: 'kimi-k2.7',
            supports_image_in: true,
            supports_reasoning: true,
            context_length: 262_144,
          },
          { id: 'moonshot-v1-8k', supports_image_in: false },
        ],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'moonshot',
        name: 'Moonshot',
        providerType: 'moonshot',
        baseUrl: server.url,
        defaultModel: 'kimi-k2.7',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'moonshot-secret',
    );

    assert.deepEqual(models, [
      {
        id: 'kimi-k2.7',
        contextWindow: 262_144,
        capabilities: { vision: true, reasoning: true },
      },
      { id: 'moonshot-v1-8k', capabilities: { vision: false } },
    ]);
  });

  test('provider fetch failures throw generalized errors instead of returning fallback models', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 401, {
        error: 'bad token',
        authorization: 'Bearer zai-live-secret',
      });
    });

    await assert.rejects(
      () => fetchProviderModels({ ...zaiConnection(), baseUrl: server.url }, 'zai-live-secret'),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Authentication failed');
        assert.equal(error.message.includes('zai-live-secret'), false);
        return true;
      },
    );
  });

  test('Custom OpenAI relay providers fetch live /models instead of returning fallback defaults', async () => {
    for (const [providerType, modelId] of [
      ['openai-compatible', 'custom-chat-model'],
      ['openai-responses-compatible', 'custom-responses-model'],
    ] as const) {
      const server = await startJsonServer((request, response) => {
        assert.equal(request.url, '/v1/models');
        assert.equal(request.headers.authorization, 'Bearer relay-secret');
        respondJson(response, 200, {
          data: [{ id: modelId }],
        });
      });

      const models = await fetchProviderModels(
        {
          slug: `${providerType}-relay`,
          name: 'Relay',
          providerType,
          baseUrl: `${server.url}/v1`,
          defaultModel: modelId,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        'relay-secret',
      );

      assert.deepEqual(models, [{ id: modelId }]);
    }
  });

  test('Custom Anthropic relay providers fetch live /v1/models with x-api-key auth', async () => {
    let observedApiKey = '';
    const server = await startJsonServer((request, response) => {
      observedApiKey = (request.headers['x-api-key'] as string | undefined) ?? '';
      assert.equal(request.url, '/anthropic/v1/models');
      respondJson(response, 200, { data: [{ id: 'claude-relay-sonnet' }] });
    });

    const models = await fetchProviderModels(
      {
        slug: 'anthropic-relay',
        name: 'Anthropic Relay',
        providerType: 'anthropic-compatible',
        baseUrl: `${server.url}/anthropic`,
        defaultModel: 'claude-relay-sonnet',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'anthropic-relay-secret',
    );

    assert.equal(observedApiKey, 'anthropic-relay-secret');
    assert.deepEqual(models, [{ id: 'claude-relay-sonnet' }]);
  });

  test('Google Gemini appends /models to a /v1beta base URL without doubling the version segment', async () => {
    let observedPath = '';
    let observedKey = '';
    const server = await startJsonServer((request, response) => {
      observedPath = request.url ?? '';
      const url = new URL(request.url ?? '', 'http://test.local');
      observedKey = url.searchParams.get('key') ?? '';
      assert.equal(request.method, 'GET');
      respondJson(response, 200, {
        models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.0-flash' }],
      });
    });

    const models = await fetchProviderModels(
      { ...googleConnection(), baseUrl: `${server.url}/v1beta` },
      'google-api-key',
    );

    // baseUrl already ends with /v1beta — the fetcher must append /models,
    // not /v1beta/models (which would double the version segment and 404).
    assert.equal(observedPath, '/v1beta/models?key=google-api-key');
    assert.equal(observedKey, 'google-api-key');
    assert.deepEqual(models, [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.0-flash' }]);
  });

  test('Claude subscription model fetch uses OAuth bearer headers, not x-api-key', async () => {
    let observedAuth = '';
    let observedApiKey = '';
    let observedBeta = '';
    let observedApp = '';
    const server = await startJsonServer((request, response) => {
      observedAuth = request.headers.authorization ?? '';
      observedApiKey = (request.headers['x-api-key'] as string | undefined) ?? '';
      observedBeta = (request.headers['anthropic-beta'] as string | undefined) ?? '';
      observedApp = (request.headers['x-app'] as string | undefined) ?? '';
      assert.equal(request.url, '/v1/models');
      respondJson(response, 200, {
        data: [{ id: 'claude-sonnet-4-5-20250929' }],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'claude-subscription',
        name: 'Claude OAuth',
        providerType: 'claude-subscription',
        baseUrl: server.url,
        defaultModel: 'claude-sonnet-4-5-20250929',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'oauth-access-token',
    );

    assert.equal(observedAuth, 'Bearer oauth-access-token');
    assert.equal(observedApiKey, '');
    assert.match(observedBeta, /oauth-2025-04-20/);
    assert.equal(observedApp, 'cli');
    assert.deepEqual(models, [{ id: 'claude-sonnet-4-5-20250929' }]);
  });

  test('Claude subscription model fetch accepts a stored /v1 base URL without doubling it', async () => {
    let observedPath = '';
    const server = await startJsonServer((request, response) => {
      observedPath = request.url ?? '';
      respondJson(response, 200, { data: [{ id: 'claude-haiku-4-5-20251001' }] });
    });

    const models = await fetchProviderModels(
      {
        slug: 'claude-subscription',
        name: 'Claude OAuth',
        providerType: 'claude-subscription',
        baseUrl: `${server.url}/v1`,
        defaultModel: 'claude-haiku-4-5-20251001',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'oauth-access-token',
    );

    assert.equal(observedPath, '/v1/models');
    assert.deepEqual(models, [{ id: 'claude-haiku-4-5-20251001' }]);
  });

  test('MiniMax Coding Plan discovers exact model ids with Anthropic API-key authentication', async () => {
    let observedAuthorization = '';
    let observedApiKey = '';
    const server = await startJsonServer((request, response) => {
      observedAuthorization = request.headers.authorization ?? '';
      observedApiKey = (request.headers['x-api-key'] as string | undefined) ?? '';
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/anthropic/v1/models');
      respondJson(response, 200, {
        data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7-highspeed' }],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'minimax-plan',
        name: 'MiniMax Coding Plan',
        providerType: 'minimax-coding-plan',
        baseUrl: `${server.url}/anthropic`,
        defaultModel: 'MiniMax-M3',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'minimax-plan-secret',
    );

    assert.equal(observedAuthorization, '');
    assert.equal(observedApiKey, 'minimax-plan-secret');
    assert.deepEqual(models, [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7-highspeed' }]);
  });

  test('Codex OAuth discovers models from the chatgpt.com/backend-api/codex/models endpoint', async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const server = await startJsonServer((request, response) => {
      requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
      respondJson(response, 200, {
        models: [
          { slug: 'hidden-model', visibility: 'hide', priority: 0 },
          { slug: 'gpt-5.6-sol', priority: 1, context_window: 372000 },
          { slug: 'gpt-5.5', priority: 2, context_window: 272000 },
          { slug: 'gpt-5.4-mini', priority: 3 },
          { slug: '', priority: 4 },
        ],
      });
    });

    const models = await fetchProviderModels(
      {
        slug: 'openai-codex',
        name: 'Codex OAuth',
        providerType: 'openai-codex',
        baseUrl: server.url,
        defaultModel: 'gpt-5.6-sol',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      'codex-oauth-token',
    );

    assert.deepEqual(requests, [
      { url: '/models?client_version=1.0.0', authorization: 'Bearer codex-oauth-token' },
    ]);
    assert.deepEqual(models, [
      { id: 'gpt-5.6-sol', contextWindow: 372000 },
      { id: 'gpt-5.5', contextWindow: 272000 },
      { id: 'gpt-5.4-mini' },
    ]);
  });

  test('Codex OAuth discovery sends ChatGPT-Account-Id for account routing', async () => {
    const payload = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } }),
    ).toString('base64url');
    const token = `header.${payload}.sig`;
    let capturedAccountId: string | string[] | undefined;
    const server = await startJsonServer((request, response) => {
      capturedAccountId = request.headers['chatgpt-account-id'];
      respondJson(response, 200, { models: [] });
    });
    await fetchProviderModels(
      {
        slug: 'openai-codex',
        name: 'Codex OAuth',
        providerType: 'openai-codex',
        baseUrl: server.url,
        defaultModel: 'gpt-5.6-sol',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      token,
    );
    assert.equal(capturedAccountId, 'acct-42');
  });

  test('Codex OAuth discovery surfaces the HTTP status on auth failure for caller classification', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 401, { error: 'unauthorized' });
    });
    await assert.rejects(
      fetchProviderModels(
        {
          slug: 'openai-codex',
          name: 'Codex OAuth',
          providerType: 'openai-codex',
          baseUrl: server.url,
          defaultModel: 'gpt-5.6-sol',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        'codex-oauth-token',
      ),
      (err: unknown) => (err as { status?: number }).status === 401,
    );
  });

  test('successful empty provider responses stay fetched-empty instead of falling back', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 200, { data: [] });
    });

    const models = await fetchProviderModels(
      { ...zaiConnection(), baseUrl: server.url },
      'zai-live-secret',
    );

    assert.deepEqual(models, []);
  });
});

async function startJsonServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const control = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  servers.push(control);
  return control;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function zaiConnection(): LlmConnection {
  return {
    slug: 'zai',
    name: 'Z.ai',
    providerType: 'zai-coding-plan',
    defaultModel: 'glm-4.7',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function googleConnection(): LlmConnection {
  return {
    slug: 'google',
    name: 'Google Gemini',
    providerType: 'google',
    defaultModel: 'gemini-2.5-flash',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
