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
});
