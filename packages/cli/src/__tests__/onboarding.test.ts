import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, ModelInfo, ProviderType } from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';
import {
  listApiKeyOnboardableProviders,
  listOnboardingProviders,
  saveApiKeyConnection,
  verifyApiKeyConnection,
} from '../onboarding.js';

describe('listOnboardingProviders', () => {
  test('marks existing connections as set and carries their enabled model ids', async () => {
    const openai = makeConnection({
      slug: 'openai',
      providerType: 'openai',
      defaultModel: 'gpt-5.5',
      enabledModelIds: ['gpt-5.5', 'gpt-5.5-mini'],
    });
    const minimax = makeConnection({
      slug: 'minimax',
      providerType: 'MiniMax',
      defaultModel: 'MiniMax-M3',
      enabledModelIds: ['MiniMax-M3'],
    });

    const providers = await listOnboardingProviders({
      connectionStore: {
        list: async () => [openai, minimax],
      },
    });

    const openaiEntry = providers.find((p) => p.providerType === 'openai');
    assert.equal(openaiEntry?.hasConnection, true);
    assert.deepEqual(openaiEntry?.enabledModelIds, ['gpt-5.5', 'gpt-5.5-mini']);
    // A provider with no connection is not marked set and starts with no models.
    const anthropic = providers.find((p) => p.providerType === 'anthropic');
    assert.equal(anthropic?.hasConnection, false);
    assert.deepEqual(anthropic?.enabledModelIds, []);
    const minimaxEntry = providers.find((p) => p.providerType === 'MiniMax');
    assert.equal(minimaxEntry?.hasConnection, true);
    assert.deepEqual(minimaxEntry?.enabledModelIds, ['MiniMax-M3']);
  });

  test('does not select noncanonical connections for a provider', async () => {
    const providers = await listOnboardingProviders({
      connectionStore: {
        list: async () => [
          makeConnection({ slug: 'openai-2', providerType: 'openai' }),
          makeConnection({ slug: 'openai-work', providerType: 'openai' }),
        ],
      },
    });

    const openai = providers.find((provider) => provider.providerType === 'openai');
    assert.equal(openai?.hasConnection, false);
    assert.deepEqual(openai?.enabledModelIds, []);
  });

  test('does not mark a provider as configured when its canonical slug belongs to another provider', async () => {
    const providers = await listOnboardingProviders({
      connectionStore: {
        list: async () => [
          makeConnection({
            slug: 'openai',
            providerType: 'anthropic',
            defaultModel: 'claude-sonnet-5',
          }),
        ],
      },
    });

    const openai = providers.find((provider) => provider.providerType === 'openai');
    assert.equal(openai?.hasConnection, false);
    assert.deepEqual(openai?.enabledModelIds, []);
  });
});

describe('verifyApiKeyConnection', () => {
  test('probes a new connection with the supplied key without persisting', async () => {
    let created = false;
    let secretStored = false;
    let defaultSet = false;
    let probed: Array<{ slug: string; providerType: ProviderType; apiKey: string }> = [];
    const connectionStore: Pick<
      ConnectionStore,
      'get' | 'create' | 'update' | 'remove' | 'getDefault' | 'setDefault'
    > = {
      get: async () => null,
      create: async () => {
        created = true;
        return makeConnection({});
      },
      update: async () => {
        throw new Error('update must not be called during verify');
      },
      remove: async () => {},
      getDefault: async () => null,
      setDefault: async () => {
        defaultSet = true;
      },
    };
    const credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret'> = {
      getSecret: async () => null,
      setSecret: async () => {
        secretStored = true;
      },
    };

    const result = await verifyApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      connectionStore,
      credentialStore,
      fetchModels: async (connection, apiKey) => {
        probed.push({ slug: connection.slug, providerType: connection.providerType, apiKey });
        return [{ id: 'gpt-5.5' }];
      },
    });

    assert.deepEqual(result, { kind: 'ok', models: [{ id: 'gpt-5.5' }] });
    assert.equal(created, false, 'verify must not create the connection');
    assert.equal(secretStored, false, 'verify must not store the secret');
    assert.equal(defaultSet, false, 'verify must not set the default');
    assert.equal(probed.length, 1);
    assert.equal(probed[0]!.apiKey, 'sk-test');
    assert.equal(probed[0]!.providerType, 'openai');
  });

  test('rejects a blank key for a new required-key provider without probing', async () => {
    let probed = false;
    const result = await verifyApiKeyConnection({
      providerType: 'openai',
      apiKey: '   ',
      connectionStore: { get: async () => null },
      credentialStore: { getSecret: async () => null },
      fetchModels: async () => {
        probed = true;
        return [];
      },
    });

    assert.equal(result.kind, 'error');
    assert.match((result as { text: string }).text, /API key is required/);
    assert.equal(probed, false);
  });

  test('reuses the stored secret for an existing connection when the key is blank', async () => {
    let probedKey = '';
    let secretStored = false;
    const credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret'> = {
      getSecret: async () => 'stored-key',
      setSecret: async () => {
        secretStored = true;
      },
    };
    const result = await verifyApiKeyConnection({
      providerType: 'openai',
      apiKey: '',
      connectionStore: {
        get: async () => makeConnection({ slug: 'openai', providerType: 'openai' }),
      },
      credentialStore,
      fetchModels: async (_connection, apiKey) => {
        probedKey = apiKey;
        return [{ id: 'gpt-5.5' }];
      },
    });

    assert.equal(result.kind, 'ok');
    assert.equal(probedKey, 'stored-key');
    assert.equal(secretStored, false, 'verify must not rotate the stored key');
  });

  test('probes with a newly supplied key for an existing connection (rotation preview)', async () => {
    let probedKey = '';
    let readStored = false;
    const result = await verifyApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-rotated',
      connectionStore: {
        get: async () => makeConnection({ slug: 'openai', providerType: 'openai' }),
      },
      credentialStore: {
        getSecret: async () => {
          readStored = true;
          return 'stored-key';
        },
      },
      fetchModels: async (_connection, apiKey) => {
        probedKey = apiKey;
        return [{ id: 'gpt-5.5' }];
      },
    });

    assert.equal(result.kind, 'ok');
    assert.equal(probedKey, 'sk-rotated');
    assert.equal(readStored, false, 'a supplied key short-circuits the stored secret read');
  });

  test('records a probe failure as an error without throwing', async () => {
    const result = await verifyApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-bad',
      connectionStore: { get: async () => null },
      credentialStore: { getSecret: async () => null },
      fetchModels: async () => {
        throw new Error('HTTP 401');
      },
    });

    assert.deepEqual(result, { kind: 'error', text: 'HTTP 401' });
  });

  test('rejects a canonical slug owned by another provider before reading credentials or probing', async () => {
    let readCredential = false;
    let probed = false;
    const result = await verifyApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      connectionStore: {
        get: async (slug) =>
          makeConnection({ slug, providerType: 'anthropic', defaultModel: 'claude-sonnet-5' }),
      },
      credentialStore: {
        getSecret: async () => {
          readCredential = true;
          return null;
        },
      },
      fetchModels: async () => {
        probed = true;
        return [];
      },
    });

    assert.deepEqual(result, {
      kind: 'error',
      text: 'Connection slug "openai" belongs to another provider',
    });
    assert.equal(readCredential, false);
    assert.equal(probed, false);
  });
});

describe('saveApiKeyConnection', () => {
  test('does not select noncanonical same-provider connections', async () => {
    const connections = [
      makeConnection({ slug: 'openai-2', providerType: 'openai' }),
      makeConnection({ slug: 'openai-work', providerType: 'openai' }),
    ];
    const createdSlugs: string[] = [];
    const updatedSlugs: string[] = [];

    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      enabledModelIds: ['gpt-5.5'],
      models: [{ id: 'gpt-5.5' }],
      connectionStore: {
        get: async (slug) => connections.find((connection) => connection.slug === slug) ?? null,
        create: async (input) => {
          createdSlugs.push(input.slug);
          return makeConnection({
            slug: input.slug,
            providerType: input.providerType,
            defaultModel: input.defaultModel,
          });
        },
        update: async (slug) => {
          updatedSlugs.push(slug);
          return makeConnection({ slug, providerType: 'openai', defaultModel: 'gpt-5.5' });
        },
        remove: async () => {},
        getDefault: async () => 'openai-2',
        setDefault: async () => {},
      },
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'ok');
    assert.deepEqual(createdSlugs, ['openai']);
    assert.deepEqual(updatedSlugs, ['openai']);
  });

  test('rejects a canonical slug owned by another provider without writing state', async () => {
    let created = false;
    let updated = false;
    let removed = false;
    let credentialRead = false;
    let credentialWritten = false;
    let defaultRead = false;

    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      enabledModelIds: ['gpt-5.5'],
      models: [{ id: 'gpt-5.5' }],
      connectionStore: {
        get: async (slug) =>
          makeConnection({ slug, providerType: 'anthropic', defaultModel: 'claude-sonnet-5' }),
        create: async () => {
          created = true;
          return makeConnection({});
        },
        update: async () => {
          updated = true;
          return makeConnection({});
        },
        remove: async () => {
          removed = true;
        },
        getDefault: async () => {
          defaultRead = true;
          return null;
        },
        setDefault: async () => {},
      },
      credentialStore: {
        getSecret: async () => {
          credentialRead = true;
          return null;
        },
        setSecret: async () => {
          credentialWritten = true;
        },
        deleteSecret: async () => {},
      },
      fetchModelChoices: async () => [],
    });

    assert.deepEqual(result, {
      kind: 'error',
      text: 'Connection slug "openai" belongs to another provider',
    });
    assert.equal(created, false);
    assert.equal(updated, false);
    assert.equal(removed, false);
    assert.equal(credentialRead, false);
    assert.equal(credentialWritten, false);
    assert.equal(defaultRead, false);
  });

  test('re-enables a disabled canonical connection before making it default', async () => {
    let enabledPatch: boolean | undefined;
    const setDefaultSlugs: string[] = [];

    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: '',
      enabledModelIds: ['gpt-5.5'],
      models: [{ id: 'gpt-5.5' }],
      connectionStore: {
        get: async () =>
          makeConnection({
            slug: 'openai',
            providerType: 'openai',
            defaultModel: 'gpt-5.5',
            enabled: false,
          }),
        create: async () => {
          throw new Error('create must not be called for an existing connection');
        },
        update: async (slug, patch) => {
          enabledPatch = patch.enabled;
          return makeConnection({
            slug,
            providerType: 'openai',
            defaultModel: 'gpt-5.5',
            enabled: patch.enabled ?? false,
          });
        },
        remove: async () => {},
        getDefault: async () => null,
        setDefault: async (slug) => {
          if (slug) setDefaultSlugs.push(slug);
        },
      },
      credentialStore: {
        getSecret: async () => 'stored-key',
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'ok');
    assert.equal(enabledPatch, true);
    assert.deepEqual(setDefaultSlugs, ['openai']);
  });

  test('persists a new connection with curation and sets default only when none exists', async () => {
    const createdInputs: Array<{ slug: string; providerType: ProviderType; defaultModel: string }> =
      [];
    const updatedPatches: Array<{
      enabledModelIds?: string[];
      defaultModel?: string;
      models?: ModelInfo[];
      lastTestStatus?: string;
    }> = [];
    const storedSecrets: Array<{ slug: string; value: string }> = [];
    let defaultSlug: string | null = null;
    const setDefaultCalls: string[] = [];

    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      enabledModelIds: ['gpt-5.5', 'gpt-5.5-mini'],
      models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }],
      connectionStore: {
        get: async () => null,
        create: async (input) => {
          createdInputs.push({
            slug: input.slug,
            providerType: input.providerType,
            defaultModel: input.defaultModel ?? '',
          });
          return makeConnection({
            slug: input.slug,
            providerType: input.providerType,
            defaultModel: input.defaultModel ?? 'gpt-5.5',
          });
        },
        update: async (_slug, patch) => {
          updatedPatches.push({
            enabledModelIds: patch.enabledModelIds,
            defaultModel: patch.defaultModel,
            models: patch.models,
            lastTestStatus: patch.lastTestStatus,
          });
          return makeConnection({ slug: 'openai', providerType: 'openai' });
        },
        remove: async () => {},
        getDefault: async () => defaultSlug,
        setDefault: async (slug) => {
          if (slug) setDefaultCalls.push(slug);
          defaultSlug = slug;
        },
      },
      credentialStore: {
        getSecret: async () => null,
        deleteSecret: async () => {},
        setSecret: async (slug, _kind, value) => {
          storedSecrets.push({ slug, value });
        },
      },
      fetchModelChoices: async () => [
        {
          connectionSlug: 'openai',
          connectionName: 'OpenAI',
          providerType: 'openai',
          model: 'gpt-5.5',
          isDefaultConnection: true,
        },
      ],
    });

    assert.equal(result.kind, 'ok');
    // The secret is written for a new connection.
    assert.deepEqual(storedSecrets, [{ slug: 'openai', value: 'sk-test' }]);
    // The connection is created then updated with the curated enabled set + cache.
    assert.equal(createdInputs.length, 1);
    assert.equal(createdInputs[0]!.slug, 'openai');
    assert.equal(updatedPatches.length, 1);
    assert.deepEqual(updatedPatches[0]!.enabledModelIds, ['gpt-5.5', 'gpt-5.5-mini']);
    assert.deepEqual(updatedPatches[0]!.models, [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }]);
    assert.equal(updatedPatches[0]!.lastTestStatus, 'verified');
    // No default existed, so the new connection becomes the default.
    assert.deepEqual(setDefaultCalls, ['openai']);
    // The refreshed ready model choices come back for the running TUI.
    assert.equal((result as { modelChoices: unknown[] }).modelChoices.length, 1);
  });

  test('rolls back a newly created connection when the secret write fails', async () => {
    const removedSlugs: string[] = [];
    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      enabledModelIds: ['gpt-5.5'],
      models: [{ id: 'gpt-5.5' }],
      connectionStore: {
        get: async () => null,
        create: async (input) =>
          makeConnection({ slug: input.slug, providerType: input.providerType }),
        update: async () => {
          throw new Error('update must not be called when the secret write fails');
        },
        remove: async (slug) => {
          removedSlugs.push(slug);
        },
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        getSecret: async () => null,
        deleteSecret: async () => {},
        setSecret: async () => {
          throw new Error('disk full');
        },
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'error');
    assert.match((result as { text: string }).text, /disk full/);
    assert.deepEqual(removedSlugs, ['openai']);
  });

  test('rolls back a newly created connection and secret when the model update fails', async () => {
    const removedSlugs: string[] = [];
    const deletedSecrets: Array<{ slug: string; kind?: string }> = [];
    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-new',
      enabledModelIds: ['gpt-5.5'],
      models: [{ id: 'gpt-5.5' }],
      connectionStore: {
        get: async () => null,
        create: async (input) =>
          makeConnection({ slug: input.slug, providerType: input.providerType }),
        update: async () => {
          throw new Error('disk full');
        },
        remove: async (slug) => {
          removedSlugs.push(slug);
        },
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async (slug, kind) => {
          deletedSecrets.push({ slug, kind });
        },
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'error');
    assert.match((result as { text: string }).text, /disk full/);
    assert.deepEqual(removedSlugs, ['openai']);
    assert.deepEqual(deletedSecrets, [{ slug: 'openai', kind: 'api_key' }]);
  });

  test('rolls back a rotated secret when the model update fails on an existing connection', async () => {
    const secretWrites: string[] = [];
    let currentSecret = 'sk-old';
    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-new',
      enabledModelIds: ['gpt-5.5'],
      models: [{ id: 'gpt-5.5' }],
      connectionStore: {
        get: async () =>
          makeConnection({ slug: 'openai', providerType: 'openai', defaultModel: 'gpt-5.5' }),
        create: async () => {
          throw new Error('create must not be called for an existing connection');
        },
        update: async () => {
          throw new Error('disk full');
        },
        remove: async () => {},
        getDefault: async () => 'openai',
        setDefault: async () => {
          throw new Error('setDefault must not be called when a default already exists');
        },
      },
      credentialStore: {
        getSecret: async () => currentSecret,
        setSecret: async (_slug, _kind, value) => {
          secretWrites.push(value);
          currentSecret = value;
        },
        deleteSecret: async () => {
          throw new Error('deleteSecret must not be called when an old secret exists');
        },
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'error');
    assert.match((result as { text: string }).text, /disk full/);
    assert.deepEqual(secretWrites, ['sk-new', 'sk-old']);
    assert.equal(currentSecret, 'sk-old');
  });

  test('updates an existing connection without rotating the key when it is blank', async () => {
    let secretStored = false;
    const updatedPatches: Array<{ enabledModelIds?: string[]; defaultModel?: string }> = [];
    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: '',
      enabledModelIds: ['gpt-5.5', 'gpt-5.5-mini'],
      models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-mini' }],
      connectionStore: {
        get: async () =>
          makeConnection({ slug: 'openai', providerType: 'openai', defaultModel: 'gpt-5.5' }),
        create: async () => {
          throw new Error('create must not be called for an existing connection');
        },
        update: async (_slug, patch) => {
          updatedPatches.push({
            enabledModelIds: patch.enabledModelIds,
            defaultModel: patch.defaultModel,
          });
          return makeConnection({ slug: 'openai', providerType: 'openai' });
        },
        remove: async () => {},
        getDefault: async () => 'openai',
        setDefault: async () => {
          throw new Error('setDefault must not be called when a default already exists');
        },
      },
      credentialStore: {
        getSecret: async () => null,
        deleteSecret: async () => {},
        setSecret: async () => {
          secretStored = true;
        },
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'ok');
    assert.equal(secretStored, false, 'a blank key must not rotate the stored secret');
    assert.equal(updatedPatches.length, 1);
    assert.deepEqual(updatedPatches[0]!.enabledModelIds, ['gpt-5.5', 'gpt-5.5-mini']);
  });

  test('does not replace an existing default connection during in-session setup', async () => {
    const setDefaultCalls: string[] = [];
    const result = await saveApiKeyConnection({
      providerType: 'anthropic',
      apiKey: 'sk-test',
      enabledModelIds: ['claude-sonnet-5'],
      models: [{ id: 'claude-sonnet-5' }],
      connectionStore: {
        get: async (slug) =>
          slug === 'anthropic'
            ? makeConnection({ slug: 'anthropic', providerType: 'anthropic' })
            : null,
        create: async (input) =>
          makeConnection({ slug: input.slug, providerType: input.providerType }),
        update: async () => makeConnection({ slug: 'anthropic', providerType: 'anthropic' }),
        remove: async () => {},
        getDefault: async () => 'openai', // another connection is already the default
        setDefault: async (slug) => {
          if (slug) setDefaultCalls.push(slug);
        },
      },
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'ok');
    assert.deepEqual(setDefaultCalls, [], 'in-session setup must not replace the existing default');
  });

  test('keeps the existing defaultModel when it is still enabled, else picks the first enabled', async () => {
    const cases: Array<{ existingDefault: string; enabled: string[]; expected: string }> = [
      { existingDefault: 'gpt-5.5', enabled: ['gpt-5.5', 'gpt-5.5-mini'], expected: 'gpt-5.5' },
      { existingDefault: 'gpt-4', enabled: ['gpt-5.5', 'gpt-5.5-mini'], expected: 'gpt-5.5' },
    ];
    for (const { existingDefault, enabled, expected } of cases) {
      let savedDefault: string | undefined;
      await saveApiKeyConnection({
        providerType: 'openai',
        apiKey: '',
        enabledModelIds: enabled,
        models: enabled.map((id) => ({ id })),
        connectionStore: {
          get: async () =>
            makeConnection({
              slug: 'openai',
              providerType: 'openai',
              defaultModel: existingDefault,
            }),
          create: async () => {
            throw new Error('create must not be called');
          },
          update: async (_slug, patch) => {
            savedDefault = patch.defaultModel;
            return makeConnection({ slug: 'openai', providerType: 'openai' });
          },
          remove: async () => {},
          getDefault: async () => 'openai',
          setDefault: async () => {},
        },
        credentialStore: {
          getSecret: async () => null,
          setSecret: async () => {},
          deleteSecret: async () => {},
        },
        fetchModelChoices: async () => [],
      });
      assert.equal(savedDefault, expected);
    }
  });

  test('rejects an empty enabled-model set before touching the stores', async () => {
    let created = false;
    let updated = false;
    let secretStored = false;
    const result = await saveApiKeyConnection({
      providerType: 'openai',
      apiKey: 'sk-test',
      enabledModelIds: [],
      models: [],
      connectionStore: {
        get: async () => null,
        create: async () => {
          created = true;
          return makeConnection({});
        },
        update: async () => {
          updated = true;
          return makeConnection({});
        },
        remove: async () => {},
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        getSecret: async () => null,
        deleteSecret: async () => {},
        setSecret: async () => {
          secretStored = true;
        },
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'error');
    assert.match((result as { text: string }).text, /至少选择一个模型|at least one model/i);
    assert.equal(created, false);
    assert.equal(updated, false);
    assert.equal(secretStored, false);
  });

  test('rejects a provider that does not accept an API key before persisting', async () => {
    const result = await saveApiKeyConnection({
      providerType: 'ollama',
      apiKey: 'unused',
      enabledModelIds: ['x'],
      models: [{ id: 'x' }],
      connectionStore: {
        get: async () => null,
        create: async () => makeConnection({}),
        update: async () => makeConnection({}),
        remove: async () => {},
        getDefault: async () => null,
        setDefault: async () => {},
      },
      credentialStore: {
        getSecret: async () => null,
        setSecret: async () => {},
        deleteSecret: async () => {},
      },
      fetchModelChoices: async () => [],
    });

    assert.equal(result.kind, 'error');
    assert.match((result as { text: string }).text, /does not accept an API key/);
  });
});

describe('listApiKeyOnboardableProviders', () => {
  test('lists only API-key providers, excluding OAuth and keyless ones', () => {
    const providers = listApiKeyOnboardableProviders();
    const types = providers.map((p) => p.providerType);

    assert.ok(types.includes('anthropic'));
    assert.ok(types.includes('openai'));
    // keyless local models and OAuth subscription providers are not onboardable this way
    assert.ok(!types.includes('ollama'));

    for (const provider of providers) {
      assert.ok(
        provider.authKind === 'api_key' || provider.authKind === 'optional_api_key',
        `${provider.providerType} should accept an api key`,
      );
    }
  });

  test('excludes providers that require a user-supplied baseUrl (phase 1)', () => {
    const providers = listApiKeyOnboardableProviders();
    const anthropic = providers.find((p) => p.providerType === 'anthropic');

    // anthropic ships a default baseUrl, so the wizard skips that field for it.
    assert.equal(anthropic?.requiresBaseUrl, false);
    // Phase 1 cannot collect a base URL, so providers without a default one are
    // not onboardable yet (they would wedge the install — see PR #1177 review).
    for (const provider of providers) {
      assert.equal(
        provider.requiresBaseUrl,
        false,
        `${provider.providerType} requires a base URL and must be excluded until the wizard can prompt for one`,
      );
    }
  });
});

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
