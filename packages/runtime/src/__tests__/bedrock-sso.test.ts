import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBedrockSsoSession,
  serializeBedrockSsoSession,
  type BedrockSsoSession,
} from '../bedrock-sso.js';
import { discoverBedrockModels, manualBedrockModel } from '../bedrock-model-discovery.js';
import { getAIModel } from '../model-factory.js';
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

test('Bedrock discovery forces SigV4 when an ambient bearer token exists', async () => {
  const previous = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'ambient-wrong-identity';
  let credentialCalls = 0;
  let authorization = '';
  try {
    await assert.rejects(() =>
      discoverBedrockModels({
        region: 'us-east-1',
        credentialProvider: async () => {
          credentialCalls += 1;
          return {
            accessKeyId: 'AKIATEST',
            secretAccessKey: 'test-secret',
            sessionToken: 'test-session',
          };
        },
        fetchFn: (async (_input, init) => {
          authorization = new Headers(init?.headers).get('authorization') ?? '';
          return new Response('provider unavailable', { status: 503 });
        }) as typeof fetch,
      }),
    );
    assert.ok(credentialCalls > 0, 'discovery must invoke the explicit Host SSO provider');
    assert.match(authorization, /^AWS4-HMAC-SHA256 /);
  } finally {
    if (previous === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = previous;
  }
});

test('explicit SSO credentials cannot be overridden by AWS_BEARER_TOKEN_BEDROCK', async () => {
  const previous = process.env.AWS_BEARER_TOKEN_BEDROCK;
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'ambient-wrong-identity';
  let credentialCalls = 0;
  let authorization = '';
  try {
    const model = getAIModel({
      connection: {
        slug: 'amazon-bedrock',
        providerType: 'amazon-bedrock',
        defaultModel: 'amazon.nova-pro-v1:0',
        models: [manualBedrockModel('amazon.nova-pro-v1:0')],
        bedrock: {
          ssoStartUrl: 'https://example.awsapps.com/start',
          ssoRegion: 'us-east-1',
          region: 'us-east-1',
          accountId: '123456789012',
          roleName: 'Developer',
        },
      },
      apiKey: '',
      modelId: 'amazon.nova-pro-v1:0',
      awsCredentialProvider: async () => {
        credentialCalls += 1;
        return {
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'test-secret',
          sessionToken: 'test-session',
        };
      },
      fetch: (async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return new Response('provider unavailable', { status: 503 });
      }) as typeof fetch,
    });

    await assert.rejects(() =>
      Promise.resolve(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        }),
      ),
    );
    assert.ok(credentialCalls > 0, 'the explicit Host SSO provider must be invoked');
    assert.match(authorization, /^AWS4-HMAC-SHA256 /);
    assert.doesNotMatch(authorization, /ambient-wrong-identity/);
  } finally {
    if (previous === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = previous;
  }
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
