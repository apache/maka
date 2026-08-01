import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  listReadyModelChoices,
  resolveDefaultSessionTarget,
  selectableModelIdsForTarget,
} from '../connection-target.js';

describe('default session target resolver', () => {
  test('uses the selected API-key connection without rewriting its endpoint or model', async () => {
    const connection = makeConnection({
      slug: 'vercel',
      name: 'Vercel AI Gateway',
      providerType: 'vercel',
      baseUrl: 'https://gateway.example.test/v1',
      defaultModel: 'xai/grok-4.3',
      enabledModelIds: ['xai/grok-4.3', 'anthropic/claude-sonnet-4.5'],
    });

    const target = await resolveDefaultSessionTarget({
      connectionStore: storeFor(connection),
      credentialStore: {
        getSecret: async (_slug, kind) => (kind === 'api_key' ? 'gateway-key' : null),
      },
      requestedModel: 'anthropic/claude-sonnet-4.5',
    });

    assert.equal(target.connection, connection);
    assert.equal(target.apiKey, 'gateway-key');
    assert.equal(target.model, 'anthropic/claude-sonnet-4.5');
  });

  test('honors required, optional, and absent credential policies', async () => {
    const cases = [
      {
        connection: makeConnection({
          slug: 'lm-studio',
          providerType: 'lm-studio',
          defaultModel: 'lmstudio-community/Qwen3-Coder',
        }),
        expectedReads: 0,
      },
      {
        connection: makeConnection({
          slug: 'localai',
          providerType: 'localai',
          defaultModel: 'localai/Qwen3-8B:Q4_K_M',
        }),
        expectedReads: 1,
      },
    ];

    for (const { connection, expectedReads } of cases) {
      let reads = 0;
      const target = await resolveDefaultSessionTarget({
        connectionStore: storeFor(connection),
        credentialStore: {
          getSecret: async () => {
            reads += 1;
            return null;
          },
        },
      });

      assert.equal(reads, expectedReads, connection.providerType);
      assert.equal(target.apiKey, '');
      assert.equal(target.model, connection.defaultModel);
    }

    const required = makeConnection({
      slug: 'openai',
      providerType: 'openai',
      defaultModel: 'gpt-5.5',
    });
    await assert.rejects(
      resolveDefaultSessionTarget({
        connectionStore: storeFor(required),
        credentialStore: { getSecret: async () => null },
      }),
      /NO_REAL_CONNECTION:missing_api_key/,
    );
  });

  test('uses the account endpoint from a valid OAuth credential record', async () => {
    const connection = makeConnection({
      slug: 'github-copilot',
      providerType: 'github-copilot',
      baseUrl: 'https://api.githubcopilot.com',
      defaultModel: 'gpt-5.4',
    });
    const target = await resolveDefaultSessionTarget({
      connectionStore: storeFor(connection),
      credentialStore: {
        getSecret: async () =>
          JSON.stringify({
            access_token: 'github-account-token',
            refresh_token: 'github-account-token',
            expires_at: Date.now() + 10 * 60_000,
            base_url: 'https://api.business.githubcopilot.com',
          }),
      },
    });

    assert.equal(target.apiKey, 'github-account-token');
    assert.equal(target.connection.baseUrl, 'https://api.business.githubcopilot.com');
  });

  test('refreshes and persists an expired OAuth credential before returning it', async () => {
    const connection = makeConnection({
      slug: 'openai-codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
    });
    let stored = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: 1_000,
      account_id: 'acct_123',
    });
    let refreshBody = '';

    const target = await resolveDefaultSessionTarget({
      connectionStore: storeFor(connection),
      credentialStore: {
        getSecret: async () => stored,
        setSecret: async (_slug, _kind, value) => {
          stored = value;
        },
      },
      now: () => 10_000,
      fetchFn: async (_url, init) => {
        refreshBody = String(init?.body ?? '');
        return Response.json({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        });
      },
    });

    assert.equal(target.apiKey, 'fresh-access-token');
    assert.match(refreshBody, /grant_type=refresh_token/);
    assert.match(refreshBody, /refresh_token=oauth-refresh-token/);
    assert.equal(JSON.parse(stored).access_token, 'fresh-access-token');
  });

  test('rejects malformed or unrefreshable OAuth credentials instead of using raw secrets', async () => {
    const connection = makeConnection({
      slug: 'openai-codex',
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
    });
    const expiredToken = JSON.stringify({
      access_token: 'expired-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: 1_000,
      account_id: 'acct_123',
    });

    for (const secret of ['not-json', expiredToken]) {
      await assert.rejects(
        resolveDefaultSessionTarget({
          connectionStore: storeFor(connection),
          credentialStore: { getSecret: async () => secret },
          now: () => 10_000,
          fetchFn: async () => new Response('refresh failed', { status: 500 }),
        }),
        /NO_REAL_CONNECTION:missing_api_key/,
      );
    }
  });

  test('fails closed when no default connection exists', async () => {
    await assert.rejects(
      resolveDefaultSessionTarget({
        connectionStore: {
          getDefault: async () => null,
          get: async () => null,
        },
        credentialStore: { getSecret: async () => null },
      }),
      /NO_REAL_CONNECTION:missing_default_connection/,
    );
  });
});

test('selectable models are limited to the curated set plus the current model', () => {
  const connection = makeConnection({
    providerType: 'ollama',
    defaultModel: 'glm-5.2',
    enabledModelIds: ['glm-5.2'],
    models: [{ id: 'glm-5.2' }, { id: 'glm-5-air' }, { id: 'glm-4.6' }],
  });

  assert.deepEqual(selectableModelIdsForTarget({ connection, model: 'glm-5-air' }), [
    'glm-5-air',
    'glm-5.2',
  ]);
});

test('ready model choices apply curation and isolate unavailable credentials', async () => {
  const local = makeConnection({
    slug: 'local',
    name: 'Local',
    providerType: 'ollama',
    defaultModel: 'qwen',
    enabledModelIds: ['qwen'],
    models: [{ id: 'qwen' }, { id: 'hidden' }],
  });
  const openai = makeConnection({
    slug: 'openai',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'gpt-5.5',
    enabledModelIds: ['gpt-5.5'],
    models: [{ id: 'gpt-5.5' }],
  });
  const keyless = makeConnection({
    slug: 'keyless',
    providerType: 'openai',
    defaultModel: 'gpt-5.5',
    enabledModelIds: ['gpt-5.5'],
    models: [{ id: 'gpt-5.5' }],
  });
  const corrupt = makeConnection({
    slug: 'corrupt',
    providerType: 'openai',
    defaultModel: 'gpt-5.5',
    enabledModelIds: ['gpt-5.5'],
    models: [{ id: 'gpt-5.5' }],
  });

  const choices = await listReadyModelChoices({
    connectionStore: {
      list: async () => [local, openai, keyless, corrupt],
      getDefault: async () => 'local',
    },
    credentialStore: {
      getSecret: async (slug) => {
        if (slug === 'openai') return 'sk-real';
        if (slug === 'corrupt') throw new Error('credentials.json is unreadable');
        return null;
      },
    },
  });

  assert.deepEqual(
    choices.map(({ connectionSlug, model, isDefaultConnection }) => ({
      connectionSlug,
      model,
      isDefaultConnection,
    })),
    [
      { connectionSlug: 'local', model: 'qwen', isDefaultConnection: true },
      { connectionSlug: 'openai', model: 'gpt-5.5', isDefaultConnection: false },
    ],
  );
});

function storeFor(connection: LlmConnection) {
  return {
    getDefault: async () => connection.slug,
    get: async (slug: string) => (slug === connection.slug ? connection : null),
  };
}

function makeConnection(input: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'conn',
    name: 'Connection',
    providerType: 'ollama',
    defaultModel: 'llama3.2',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}
