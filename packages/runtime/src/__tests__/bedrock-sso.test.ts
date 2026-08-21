import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBedrockSsoSession,
  serializeBedrockSsoSession,
  type BedrockSsoSession,
} from '../bedrock-sso.js';
import { manualBedrockModel } from '../bedrock-model-discovery.js';
import { buildPricingLookup, withBedrockSourcePricing } from '../telemetry/pricing.js';

const session: BedrockSsoSession = {
  version: 1,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  clientSecretExpiresAt: 2_000_000_000_000,
  accessToken: 'access-token',
  expiresAt: 1_900_000_000_000,
  refreshToken: 'refresh-token',
  scope: ['sso:account:access'],
};

test('Bedrock SSO session round-trips only its versioned bounded schema', () => {
  assert.deepEqual(parseBedrockSsoSession(serializeBedrockSsoSession(session)), session);
  assert.equal(parseBedrockSsoSession('{}'), null);
  assert.equal(parseBedrockSsoSession(JSON.stringify({ ...session, version: 2 })), null);
  assert.equal(parseBedrockSsoSession(JSON.stringify({ ...session, accessToken: '' })), null);
  assert.equal(
    parseBedrockSsoSession(JSON.stringify({ ...session, roleSecret: 'forbidden' })),
    null,
  );
});

test('a single-source inference profile inherits Bedrock pricing without guessing multi-source rates', () => {
  const modelId = 'us.amazon.nova-pro-v1:0';
  const connection = {
    slug: 'amazon-bedrock',
    providerType: 'amazon-bedrock' as const,
    defaultModel: modelId,
    models: [
      {
        id: modelId,
        bedrock: { kind: 'inference-profile' as const, sourceModelIds: ['amazon.nova-pro-v1:0'] },
      },
    ],
  };
  const lookup = withBedrockSourcePricing(buildPricingLookup(), connection, modelId);
  assert.ok(lookup(`amazon-bedrock:${modelId}`));
});

test('manual Bedrock models declare only validated text and tool support', () => {
  assert.deepEqual(manualBedrockModel(' arn:aws:bedrock:us-east-1:123:model/x '), {
    id: 'arn:aws:bedrock:us-east-1:123:model/x',
    capabilities: { chat: true, functionCalling: true },
    modalities: { input: ['text'], output: ['text'] },
    bedrock: { kind: 'manual' },
  });
});
