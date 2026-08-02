import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROVIDER_DEFAULTS, type LlmConnection } from '@maka/core';
import { ProviderModelDiscoveryHttpError } from '@maka/runtime';
import {
  createOAuthModelConnectionsMainService,
  XAI_OAUTH_CONNECTION_SLUG,
} from '../oauth-model-connections-main.js';

describe('xAI OAuth model connection synchronization', () => {
  test('activates immediately from the shared xAI fallback catalog, then replaces it with discovery', async () => {
    let saved: LlmConnection | null = null;
    let discoveryCalls = 0;
    const connectionStore = {
      get: async () => saved,
      list: async () => (saved ? [saved] : []),
      save: async (connection: LlmConnection) => {
        saved = connection;
        return connection;
      },
      update: async (_slug: string, patch: Partial<LlmConnection>) => {
        saved = { ...(saved as LlmConnection), ...patch };
        return saved;
      },
    };
    let discoveryStatus: number | null = null;
    const service = createOAuthModelConnectionsMainService({
      connectionStore,
      credentialStore: { getSecret: async () => null },
      claudeSubscription: {} as never,
      openAiCodex: {} as never,
      githubCopilotSubscription: {} as never,
      xaiOAuth: {
        getAccountState: async () => ({
          provider: 'xai-oauth',
          runtimeState: 'authenticated',
        }),
        getAccessTokenInternal: async () => 'xai-oauth-token',
        hasStoredCredential: async () => true,
      },
      fetchModels: async () => {
        discoveryCalls += 1;
        if (discoveryStatus !== null) {
          throw new ProviderModelDiscoveryHttpError(discoveryStatus);
        }
        return [{ id: 'grok-4.5', apiProtocol: 'openai-responses' }];
      },
    } as never);

    const activated = await service.activateXaiOAuthConnection();
    assert.equal(discoveryCalls, 0);
    assert.equal(activated?.slug, XAI_OAUTH_CONNECTION_SLUG);
    assert.equal(activated?.providerType, 'xai-oauth');
    assert.equal(activated?.enabled, true);
    assert.deepEqual(
      activated?.models?.map(({ id }) => id),
      PROVIDER_DEFAULTS['xai-oauth'].fallbackModels,
    );

    const synchronized = await service.syncXaiOAuthConnection();
    assert.equal(discoveryCalls, 1);
    assert.deepEqual(synchronized?.models, [
      { id: 'grok-4.5', apiProtocol: 'openai-responses' },
    ]);
    assert.equal(synchronized?.modelSource, 'fetched');
    assert.equal(synchronized?.defaultModel, 'grok-4.5');
    assert.equal(synchronized?.lastTestStatus, 'verified');

    discoveryStatus = 401;
    const rejected = await service.syncXaiOAuthConnection();
    assert.equal(rejected?.enabled, false);
    assert.equal(rejected?.lastTestStatus, 'needs_reauth');
  });

  test('a resync reconciles the stored selection against the account catalog', async () => {
    // The sync used to pass `enabledModelIds` straight back while replacing
    // `models` with the live catalog, so a retired id stayed enabled forever;
    // and it derived the default itself instead of asking the one function
    // that already answers "the inventory changed, what is still usable".
    let saved: LlmConnection = {
      slug: XAI_OAUTH_CONNECTION_SLUG,
      name: 'xAI OAuth',
      providerType: 'xai-oauth',
      defaultModel: 'grok-3',
      enabled: true,
      enabledModelIds: ['grok-3'],
      models: [{ id: 'grok-3' }],
      modelSource: 'fetched',
      createdAt: 1,
      updatedAt: 1,
    };
    const service = createXaiService(
      () => saved,
      (connection) => {
        saved = connection;
      },
      [{ id: 'grok-4.5' }],
    );

    const synced = await service.syncXaiOAuthConnection();
    assert.equal(synced?.defaultModel, 'grok-4.5');
    assert.deepEqual(synced?.enabledModelIds, ['grok-4.5']);
  });

  test('a resync does not resurrect a selection the user emptied', async () => {
    let saved: LlmConnection = {
      slug: XAI_OAUTH_CONNECTION_SLUG,
      name: 'xAI OAuth',
      providerType: 'xai-oauth',
      defaultModel: '',
      enabled: true,
      enabledModelIds: [],
      models: [{ id: 'grok-4.5' }],
      modelSource: 'fetched',
      createdAt: 1,
      updatedAt: 1,
    };
    const service = createXaiService(
      () => saved,
      (connection) => {
        saved = connection;
      },
      [{ id: 'grok-4.5' }],
    );

    const synced = await service.syncXaiOAuthConnection();
    assert.equal(synced?.defaultModel, '');
    assert.deepEqual(synced?.enabledModelIds, []);
  });

  test('a resync does not re-pick a default the user cleared', async () => {
    // The user unchecked the default model but kept another one enabled — a
    // legitimate state, and the only half of the workspace default pair this
    // page can clear. The sync then re-derived a default with `||` / "first
    // enabled id", and '' is falsy, so it handed the choice back on the very
    // next connections:list — which runs this sync before every read.
    let saved: LlmConnection = {
      slug: XAI_OAUTH_CONNECTION_SLUG,
      name: 'xAI OAuth',
      providerType: 'xai-oauth',
      defaultModel: '',
      enabled: true,
      enabledModelIds: ['grok-4.5'],
      models: [{ id: 'grok-4.5' }],
      modelSource: 'fetched',
      createdAt: 1,
      updatedAt: 1,
    };
    const service = createXaiService(
      () => saved,
      (connection) => {
        saved = connection;
      },
      [{ id: 'grok-4.5' }],
    );

    assert.equal((await service.activateXaiOAuthConnection())?.defaultModel, '');
    assert.equal((await service.syncXaiOAuthConnection())?.defaultModel, '');
    assert.deepEqual(saved.enabledModelIds, ['grok-4.5']);
  });
});

/** An authenticated xAI account whose catalog is `models`, over one stored connection. */
function createXaiService(
  read: () => LlmConnection,
  write: (connection: LlmConnection) => void,
  models: { id: string }[],
) {
  return createOAuthModelConnectionsMainService({
    connectionStore: {
      get: async () => read(),
      list: async () => [read()],
      save: async (connection: LlmConnection) => {
        write(connection);
        return connection;
      },
      update: async (_slug: string, patch: Partial<LlmConnection>) => {
        const next = { ...read(), ...patch };
        write(next);
        return next;
      },
    },
    credentialStore: { getSecret: async () => null },
    claudeSubscription: {} as never,
    openAiCodex: {} as never,
    githubCopilotSubscription: {} as never,
    xaiOAuth: {
      getAccountState: async () => ({ provider: 'xai-oauth', runtimeState: 'authenticated' }),
      getAccessTokenInternal: async () => 'xai-oauth-token',
      hasStoredCredential: async () => true,
    },
    fetchModels: async () => models,
  } as never);
}
