import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createOAuthModelConnectionsMainService,
  CODEX_SUBSCRIPTION_CONNECTION_SLUG,
} from '../oauth-model-connections-main.js';
import { PROVIDER_REGISTRY, PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { OpenAiCodexDiscoveryError } from '@maka/runtime';
import type { LlmConnection } from '@maka/core/llm-connections';

// syncOpenAiCodexConnection live-discovers the account's Codex model list
// from chatgpt.com/backend-api/codex/models. These behavior tests inject fake
// deps (connectionStore / openAiCodex / fetchModels) so the three discovery
// outcomes - fetched, empty, failed - and the OAuth-token-failure path can be
// asserted directly, instead of grepping source.

type ModelInfo = NonNullable<LlmConnection['models']>[number];

function makeExisting(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: CODEX_SUBSCRIPTION_CONNECTION_SLUG,
    name: 'Codex OAuth',
    providerType: 'openai-codex',
    baseUrl: PROVIDER_DEFAULTS['openai-codex'].baseUrl,
    defaultModel: 'gpt-5.6-sol',
    enabled: true,
    models: [{ id: 'gpt-5.6-sol' }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeService(opts: {
  existing?: LlmConnection | null;
  token?: string | null;
  fetchModels?: (conn: LlmConnection, token: string) => Promise<ModelInfo[]>;
  accountState?: { runtimeState: string };
}): {
  activate: () => Promise<LlmConnection | null>;
  sync: () => Promise<LlmConnection | null>;
  getSaved: () => LlmConnection | null;
} {
  let saved: LlmConnection | null = null;
  const existing = opts.existing ?? null;
  const connectionStore = {
    get: async () => existing,
    list: async () => (existing ? [existing] : []),
    save: async (v: LlmConnection) => {
      saved = v;
      return v;
    },
    update: async (_slug: string, patch: Partial<LlmConnection>) => {
      saved = { ...(existing as LlmConnection), ...patch } as LlmConnection;
      return saved;
    },
    create: async () => {
      throw new Error('not used');
    },
    delete: async () => {},
    remove: async () => {},
    getDefault: async () => null,
    setDefault: async () => {},
  };
  const service = createOAuthModelConnectionsMainService({
    connectionStore,
    credentialStore: {
      getSecret: async () => null,
      setSecret: async () => {},
      deleteSecret: async () => {},
    },
    claudeSubscription: {} as never,
    openAiCodex: {
      getAccountState: async () => ({
        provider: 'openai-codex',
        runtimeState: opts.accountState?.runtimeState ?? 'authenticated',
      }),
      getAccessTokenInternal: async () => opts.token ?? null,
    },
    githubCopilotSubscription: {} as never,
    fetchModels: opts.fetchModels,
  } as never);
  return {
    activate: () => service.activateOpenAiCodexConnection(),
    sync: () => service.syncOpenAiCodexConnection(),
    getSaved: () => saved,
  };
}

describe('syncOpenAiCodexConnection live discovery behavior', () => {
  it('declares protocol live discovery for the openai-codex provider', () => {
    assert.deepEqual(
      PROVIDER_REGISTRY['openai-codex'].modelDiscovery,
      { kind: 'protocol', auth: 'openai-codex' },
    );
  });

  it('activates a newly authenticated connection without waiting for model discovery', async () => {
    let discoveryCalls = 0;
    const { activate, getSaved } = makeService({
      existing: makeExisting({
        enabled: false,
        lastTestStatus: 'needs_reauth',
        modelSource: 'fallback',
      }),
      token: 'tok',
      fetchModels: async () => {
        discoveryCalls += 1;
        return [{ id: 'gpt-5.6-sol' }];
      },
    });

    const result = await activate();

    assert.equal(discoveryCalls, 0);
    assert.equal(result?.enabled, true);
    assert.equal(result?.lastTestStatus, 'verified');
    assert.equal(result?.lastTestMessage, 'Codex OAuth 已登录。');
    assert.deepEqual(
      result?.models?.map((model) => model.id),
      PROVIDER_DEFAULTS['openai-codex'].fallbackModels,
    );
    assert.equal(getSaved()?.enabled, true);
  });

  it('preserves a non-empty fetched model cache during immediate activation', async () => {
    const existing = makeExisting({
      enabled: false,
      lastTestStatus: 'needs_reauth',
      models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.5' }],
      modelSource: 'fetched',
      modelsFetchedAt: 42,
    });
    const { activate } = makeService({ existing, token: 'tok' });

    const result = await activate();

    assert.deepEqual(result?.models, existing.models);
    assert.equal(result?.modelSource, 'fetched');
    assert.equal(result?.modelsFetchedAt, 42);
    assert.equal(result?.enabled, true);
  });

  it('stamps modelSource=fetched and persists discovered models on success', async () => {
    const { sync, getSaved } = makeService({
      token: 'tok',
      fetchModels: async () => [{ id: 'gpt-5.6-sol', contextWindow: 372000 }, { id: 'gpt-5.5' }],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.modelSource, 'fetched');
    assert.deepEqual(saved.models, [{ id: 'gpt-5.6-sol', contextWindow: 372000 }, { id: 'gpt-5.5' }]);
    assert.equal(saved.enabled, true);
    assert.equal(saved.lastTestStatus, 'verified');
  });

  it('preserves the user-enabled model allowlist during OAuth synchronization', async () => {
    const existing = makeExisting({
      enabledModelIds: ['gpt-5.6-sol', 'gpt-5.5'],
      models: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.5' }],
    });
    const { sync, getSaved } = makeService({
      existing,
      token: 'tok',
      fetchModels: async () => existing.models!,
    });

    await sync();

    assert.deepEqual(getSaved()!.enabledModelIds, ['gpt-5.6-sol', 'gpt-5.5']);
  });

  it('disables the connection with lastTestStatus=error when /models returns an empty list', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: 'tok',
      fetchModels: async () => [],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'error');
  });

  it('disables the connection with lastTestStatus=needs_reauth when the access token is unavailable', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: null,
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'needs_reauth');
  });

  it('rebuilds the fallback list from the registry on discovery failure, not the stale persisted copy', async () => {
    // Existing connection carries an old fallback snapshot (pre-gpt-5.6-sol).
    // A transient discovery failure must not reuse that stale copy; it must
    // rebuild from the current registry fallbackModels so gpt-5.6-sol appears.
    const { sync, getSaved } = makeService({
      existing: makeExisting({ models: [{ id: 'gpt-5.4' }], modelSource: 'fallback' }),
      token: 'tok',
      fetchModels: async () => {
        throw new Error('offline');
      },
    });
    await sync();
    const saved = getSaved()!;
    assert.deepEqual(
      saved.models!.map((m) => m.id),
      PROVIDER_DEFAULTS['openai-codex'].fallbackModels,
    );
    assert.ok(
      saved.models!.some((m) => m.id === 'gpt-5.6-sol'),
      'fallback must include gpt-5.6-sol from the current registry',
    );
    assert.equal(saved.modelSource, 'fallback');
    assert.equal(saved.enabled, true);
    assert.equal(saved.lastTestStatus, 'verified');
  });

  it('keeps the last fetched list as a cache on transient discovery failure', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting({ models: [{ id: 'gpt-5.6-sol' }], modelSource: 'fetched' }),
      token: 'tok',
      fetchModels: async () => {
        throw new Error('offline');
      },
    });
    await sync();
    const saved = getSaved()!;
    assert.deepEqual(saved.models, [{ id: 'gpt-5.6-sol' }]);
    assert.equal(saved.modelSource, 'fetched');
    assert.equal(saved.enabled, true);
  });

  it('normalizes an enabled fetched-empty snapshot to disabled on transient failure', async () => {
    const existing = makeExisting({
      enabled: true,
      models: [],
      modelSource: 'fetched',
      lastTestStatus: 'verified',
    });
    const { sync, getSaved } = makeService({
      existing,
      token: 'tok',
      fetchModels: async () => {
        throw new Error('offline');
      },
    });

    const result = await sync();

    assert.deepEqual(result?.models, []);
    assert.equal(result?.modelSource, 'fetched');
    assert.equal(result?.enabled, false);
    assert.equal(result?.lastTestStatus, 'error');
    assert.deepEqual(getSaved()?.models, []);
    assert.equal(getSaved()?.enabled, false);
  });

  it('re-enables a fetched-empty connection after later non-empty discovery', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting({
        enabled: false,
        models: [],
        modelSource: 'fetched',
        lastTestStatus: 'error',
      }),
      token: 'tok',
      fetchModels: async () => [{ id: 'gpt-5.6-sol' }],
    });

    const result = await sync();

    assert.deepEqual(result?.models, [{ id: 'gpt-5.6-sol' }]);
    assert.equal(result?.modelSource, 'fetched');
    assert.equal(result?.enabled, true);
    assert.equal(result?.lastTestStatus, 'verified');
    assert.equal(getSaved()?.enabled, true);
  });

  it('does not preserve a non-empty fetched list when every cached id is now unsupported', async () => {
    const existing = makeExisting({
      models: [{ id: 'gpt-5-codex' }],
      modelSource: 'fetched',
    });
    const { sync, getSaved } = makeService({
      existing,
      token: 'tok',
      fetchModels: async () => {
        throw new Error('offline');
      },
    });

    const result = await sync();
    assert.deepEqual(result?.models, []);
    assert.equal(result?.enabled, false);
    assert.equal(result?.lastTestStatus, 'error');
    assert.deepEqual(getSaved()?.models, []);
  });

  it('disables with needs_reauth when /models rejects with 401', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: 'tok',
      fetchModels: async () => {
        throw new OpenAiCodexDiscoveryError(401);
      },
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'needs_reauth');
  });

  it('disables with error when all discovered models are filtered as unsupported', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting(),
      token: 'tok',
      fetchModels: async () => [{ id: 'gpt-5-codex' }],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'error');
  });

  it('clears stale models when /models returns empty', async () => {
    const { sync, getSaved } = makeService({
      existing: makeExisting({ models: [{ id: 'gpt-5.6-sol' }], modelSource: 'fetched' }),
      token: 'tok',
      fetchModels: async () => [],
    });
    await sync();
    const saved = getSaved()!;
    assert.equal(saved.enabled, false);
    assert.equal(saved.lastTestStatus, 'error');
    assert.deepEqual(saved.models, []);
    assert.equal(saved.modelSource, 'fetched');
  });
});

describe('OAuth model connection user settings', () => {
  it('preserves the Claude user-enabled model allowlist during synchronization', async () => {
    const defaults = PROVIDER_DEFAULTS['claude-subscription'];
    const existing = makeExisting({
      slug: 'claude-subscription',
      providerType: 'claude-subscription',
      defaultModel: defaults.fallbackModels[0],
      enabledModelIds: defaults.fallbackModels.slice(0, 2),
      models: defaults.fallbackModels.map((id) => ({ id })),
    });
    let saved: LlmConnection | null = null;
    const service = createOAuthModelConnectionsMainService({
      connectionStore: {
        get: async () => existing,
        save: async (value: LlmConnection) => {
          saved = value;
          return value;
        },
      },
      claudeSubscription: {
        getAccountState: async () => ({ runtimeState: 'authenticated' }),
      },
    } as never);

    await service.syncClaudeSubscriptionConnection();

    assert.deepEqual(saved!.enabledModelIds, defaults.fallbackModels.slice(0, 2));
  });

  it('preserves the GitHub Copilot user-enabled model allowlist during synchronization', async () => {
    const existing = makeExisting({
      slug: 'github-copilot',
      providerType: 'github-copilot',
      defaultModel: 'gpt-5.4',
      enabledModelIds: ['gpt-5.4', 'claude-sonnet-4.6'],
      models: [{ id: 'gpt-5.4' }, { id: 'claude-sonnet-4.6' }],
    });
    let saved: LlmConnection | null = null;
    const service = createOAuthModelConnectionsMainService({
      connectionStore: {
        get: async () => existing,
        save: async (value: LlmConnection) => {
          saved = value;
          return value;
        },
      },
      githubCopilotSubscription: {
        getAccountState: async () => ({ runtimeState: 'authenticated' }),
        getTokensInternal: async () => ({ access_token: 'tok', base_url: 'https://api.githubcopilot.com' }),
      },
      fetchModels: async () => existing.models!,
    } as never);

    await service.syncGitHubCopilotConnection();

    assert.deepEqual(saved!.enabledModelIds, ['gpt-5.4', 'claude-sonnet-4.6']);
  });
});
