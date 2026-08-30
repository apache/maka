import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBedrockConfig,
  decodeCredentialLocator,
  normalizeConnectionCatalogEntryDraft,
  normalizeConnectionModelDiscoveryResult,
} from '../runtime-policy.js';
import { deriveProviderAuthContract } from '../provider-auth.js';

const config = {
  ssoStartUrl: 'https://example.awsapps.com/start',
  ssoRegion: 'us-east-1',
  region: 'us-west-2',
  accountId: '123456789012',
  roleName: 'BedrockDeveloper',
};

test('Amazon Bedrock configuration is typed, canonical, and provider-scoped', () => {
  assert.deepEqual(decodeBedrockConfig(config), config);
  const draft = normalizeConnectionCatalogEntryDraft({
    slug: 'amazon-bedrock',
    name: 'Amazon Bedrock',
    providerType: 'amazon-bedrock',
    enabled: true,
    enabledModelIds: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0'],
    bedrock: config,
  });
  assert.deepEqual(draft.bedrock, config);
  assert.throws(() =>
    normalizeConnectionCatalogEntryDraft({
      ...draft,
      providerType: 'openai',
    }),
  );
  assert.throws(() => decodeBedrockConfig({ ...config, ssoStartUrl: 'http://localhost/start' }));
  assert.throws(() => decodeBedrockConfig({ ...config, accountId: '123' }));
});

test('AWS SSO has its own credential and auth setup contract', () => {
  assert.deepEqual(
    decodeCredentialLocator({
      scope: 'connection',
      connectionId: '00000000-0000-4000-8000-000000000001',
      kind: 'aws_sso',
    }),
    {
      scope: 'connection',
      connectionId: '00000000-0000-4000-8000-000000000001',
      kind: 'aws_sso',
    },
  );
  const contract = deriveProviderAuthContract({ providerType: 'amazon-bedrock', hasSecret: false });
  assert.equal(contract.setupMode, 'sso');
  assert.equal(contract.actionAvailability.start_sso, 'available');
  assert.equal(contract.actionAvailability.save_secret, 'hidden');
});

test('Bedrock model projection preserves source model ids without credentials', () => {
  const result = normalizeConnectionModelDiscoveryResult({
    source: 'fetched',
    fetchedAt: 1,
    models: [
      {
        id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        capabilities: { chat: true, functionCalling: true },
        bedrock: {
          kind: 'inference-profile',
          sourceModelIds: ['anthropic.claude-sonnet-4-5-20250929-v1:0'],
        },
      },
    ],
  });
  assert.equal(result.models[0]?.bedrock?.kind, 'inference-profile');
  assert.deepEqual(result.models[0]?.bedrock?.sourceModelIds, [
    'anthropic.claude-sonnet-4-5-20250929-v1:0',
  ]);
});
