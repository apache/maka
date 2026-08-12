import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { after, describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import {
  fetchProviderModels,
  ProviderModelDiscoveryHttpError,
  runConnectionModelDiscoveryEffect,
} from '../model-fetcher.js';

const servers: Array<{ close(): Promise<void> }> = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

describe('fetchProviderModels', () => {
  test('Cloudflare Workers AI accepts exactly 2,048 models and rejects the first excess item', async () => {
    for (const modelCount of [2_048, 2_049]) {
      let requestCount = 0;
      const server = await startJsonServer((request, response) => {
        requestCount += 1;
        const page = Number(
          new URL(request.url ?? '', 'http://test.local').searchParams.get('page'),
        );
        const pageStart = (page - 1) * 50;
        const result = Array.from(
          { length: Math.max(0, Math.min(50, modelCount - pageStart)) },
          (_, index) => ({ name: `@cf/example/model-${pageStart + index}` }),
        );
        respondJson(response, 200, { success: true, result });
      });

      const request = fetchProviderModels(
        {
          slug: 'cloudflare-workers-ai',
          name: 'Cloudflare Workers AI',
          providerType: 'cloudflare-workers-ai',
          baseUrl: `${server.url}/client/v4/accounts/account-123/ai/v1`,
          defaultModel: '@cf/example/default',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        'cloudflare-api-token',
      );
      if (modelCount === 2_048) {
        assert.equal((await request).length, 2_048);
        assert.equal(requestCount, 42);
      } else {
        await assert.rejects(request, /Failed to fetch provider models/);
        assert.equal(requestCount, 41);
      }
    }
  });

  test('Cloudflare Workers AI bounds pagination before an oversized catalog can be persisted', async () => {
    let requestCount = 0;
    const server = await startJsonServer((_request, response) => {
      requestCount += 1;
      respondJson(response, 200, {
        success: true,
        result: Array.from({ length: 50 }, (_, index) => ({
          name: `@cf/example/page-${requestCount}-model-${index}`,
        })),
        result_info: {
          page: requestCount,
          per_page: 50,
          count: 50,
          total_count: 10_000,
        },
      });
    });

    await assert.rejects(
      fetchProviderModels(
        {
          slug: 'cloudflare-workers-ai',
          name: 'Cloudflare Workers AI',
          providerType: 'cloudflare-workers-ai',
          baseUrl: `${server.url}/client/v4/accounts/account-123/ai/v1`,
          defaultModel: '@cf/example/default',
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        'cloudflare-api-token',
      ),
      /Failed to fetch provider models/,
    );
    assert.equal(requestCount, 41);
  });

  test('Cohere rejects repeated page tokens or excess entries', async () => {
    let repeatedRequests = 0;
    const repeated = await startJsonServer((_request, response) => {
      repeatedRequests += 1;
      respondJson(response, 200, {
        models: [],
        next_page_token: 'same-token',
      });
    });
    await assert.rejects(
      fetchProviderModels(cohereConnection(repeated.url), 'cohere-key'),
      /Failed to fetch provider models/,
    );
    assert.equal(repeatedRequests, 2);

    const oversized = await startJsonServer((_request, response) => {
      respondJson(response, 200, {
        models: Array.from({ length: 2_049 }, (_, index) => ({
          name: `command-${index}`,
          endpoints: ['chat'],
        })),
      });
    });
    await assert.rejects(
      fetchProviderModels(cohereConnection(oversized.url), 'cohere-key'),
      /Failed to fetch provider models/,
    );
  });

  test('Fireworks bounds account concurrency while preserving normal pagination', async () => {
    let activeModelRequests = 0;
    let maxActiveModelRequests = 0;
    const initialModelResponses: Array<() => void> = [];
    const server = await startJsonServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://test.local');
      if (url.pathname === '/v1/accounts') {
        respondJson(response, 200, {
          accounts: Array.from({ length: 6 }, (_, index) => ({
            name: `accounts/team-${index}`,
          })),
        });
        return;
      }

      activeModelRequests += 1;
      maxActiveModelRequests = Math.max(maxActiveModelRequests, activeModelRequests);
      const respondWithModels = () => {
        activeModelRequests -= 1;
        const account = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/models$/)?.[1] ?? 'unknown';
        const pageToken = url.searchParams.get('pageToken');
        respondJson(response, 200, {
          models: [{ name: `accounts/${account}/models/${pageToken ?? 'first'}` }],
          ...(account === 'team-0' && !pageToken ? { nextPageToken: 'second' } : {}),
        });
      };
      if (initialModelResponses.length < 4) {
        initialModelResponses.push(respondWithModels);
        if (initialModelResponses.length === 4) {
          for (const respond of initialModelResponses) respond();
        }
        return;
      }
      respondWithModels();
    });

    const models = await fetchProviderModels(fireworksConnection(server.url), 'fireworks-key');
    assert.equal(maxActiveModelRequests, 4);
    assert.equal(models.length, 8);
    assert.ok(models.some(({ id }) => id === 'accounts/team-0/models/second'));
    assert.ok(models.some(({ id }) => id === 'accounts/fireworks/models/first'));
  });

  test('Fireworks rejects excess account fanout, total raw entries, and repeated page tokens', async () => {
    const tooManyAccounts = await startJsonServer((request, response) => {
      assert.equal(new URL(request.url ?? '', 'http://test.local').pathname, '/v1/accounts');
      respondJson(response, 200, {
        accounts: Array.from({ length: 32 }, (_, index) => ({
          name: `accounts/team-${index}`,
        })),
      });
    });
    await assert.rejects(
      fetchProviderModels(fireworksConnection(tooManyAccounts.url), 'fireworks-key'),
      /Failed to fetch provider models/,
    );

    const tooManyEntries = await startJsonServer((request, response) => {
      const path = new URL(request.url ?? '', 'http://test.local').pathname;
      if (path === '/v1/accounts') {
        respondJson(response, 200, { accounts: [{ name: 'accounts/team' }] });
        return;
      }
      const account = path.includes('/accounts/team/') ? 'team' : 'fireworks';
      respondJson(response, 200, {
        models: Array.from({ length: account === 'team' ? 1_024 : 1_025 }, (_, index) => ({
          name: `accounts/${account}/models/${index}`,
        })),
      });
    });
    await assert.rejects(
      fetchProviderModels(fireworksConnection(tooManyEntries.url), 'fireworks-key'),
      /Failed to fetch provider models/,
    );

    let repeatedRequests = 0;
    const repeatedToken = await startJsonServer((request, response) => {
      const path = new URL(request.url ?? '', 'http://test.local').pathname;
      if (path === '/v1/accounts') {
        respondJson(response, 200, { accounts: [] });
        return;
      }
      repeatedRequests += 1;
      respondJson(response, 200, {
        models: [],
        nextPageToken: 'same-token',
      });
    });
    await assert.rejects(
      fetchProviderModels(fireworksConnection(repeatedToken.url), 'fireworks-key'),
      /Failed to fetch provider models/,
    );
    assert.equal(repeatedRequests, 2);
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
      respondJson(response, 200, { models: [{ slug: 'gpt-5.6-sol' }] });
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

  test('connection discovery classifies structurally invalid JSON from a real HTTP response', async () => {
    const secret = 'raw-provider-secret';
    for (const body of [
      null,
      { data: { id: 'not-an-array', secret } },
      { data: [42, { id: secret }] },
    ]) {
      const server = await startJsonServer((_request, response) => {
        respondJson(response, 200, body);
      });

      const outcome = await runConnectionModelDiscoveryEffect(
        { ...zaiConnection(), baseUrl: server.url },
        'zai-live-secret',
        { fetch: globalThis.fetch },
      );

      assert.deepEqual(outcome, { ok: false, error: { kind: 'invalid_response' } });
      assert.equal(JSON.stringify(outcome).includes(secret), false);
    }
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

function cohereConnection(baseUrl: string): LlmConnection {
  return {
    slug: 'cohere',
    name: 'Cohere',
    providerType: 'cohere',
    baseUrl: `${baseUrl}/v2`,
    defaultModel: 'command-a',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fireworksConnection(baseUrl: string): LlmConnection {
  return {
    slug: 'fireworks',
    name: 'Fireworks',
    providerType: 'fireworks-ai',
    baseUrl: `${baseUrl}/inference/v1`,
    defaultModel: 'accounts/fireworks/models/default',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
