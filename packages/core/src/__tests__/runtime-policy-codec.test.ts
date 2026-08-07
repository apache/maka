import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDefaultRuntimePolicy,
  decodeCanonicalConnectionCatalogEntry,
  decodeCanonicalRuntimePolicy,
  normalizeCreateCatalogConnectionInput,
  normalizeConnectionModelDiscoveryResult,
  normalizeRuntimePolicyMutation,
  normalizeSetCredentialInput,
  RuntimePolicyDomainDecodeError,
} from '../runtime-policy.js';

test('normalizes policy input while canonical policy decode rejects producer drift', () => {
  const mutation = normalizeRuntimePolicyMutation({
    expectedRevision: 0,
    operation: {
      kind: 'set_network_proxy',
      value: { ...createDefaultRuntimePolicy().networkProxy, enabled: true, host: ' proxy.local ' },
    },
  });
  assert.equal(mutation.operation.kind, 'set_network_proxy');
  if (mutation.operation.kind !== 'set_network_proxy') return;
  assert.equal(mutation.operation.value.host, 'proxy.local');

  assert.throws(
    () =>
      decodeCanonicalRuntimePolicy({
        ...createDefaultRuntimePolicy(),
        networkProxy: { ...mutation.operation.value, host: ' proxy.local ' },
      }),
    RuntimePolicyDomainDecodeError,
  );
  assert.doesNotThrow(() =>
    decodeCanonicalRuntimePolicy({
      ...createDefaultRuntimePolicy(),
      networkProxy: { ...mutation.operation.value, host: 'proxy.local' },
    }),
  );
});

test('preserves a valid default thinking level and rejects unknown levels', () => {
  const policy = {
    ...createDefaultRuntimePolicy(),
    chatDefaults: { permissionMode: 'ask' as const, thinkingLevel: 'high' as const },
  };
  assert.deepEqual(decodeCanonicalRuntimePolicy(policy).chatDefaults, policy.chatDefaults);
  assert.throws(
    () =>
      normalizeRuntimePolicyMutation({
        expectedRevision: 0,
        operation: {
          kind: 'set_chat_defaults',
          value: { permissionMode: 'ask', thinkingLevel: 'unbounded' },
        },
      }),
    RuntimePolicyDomainDecodeError,
  );
});

test('normalizes only the bounded agent settings patch surface', () => {
  assert.deepEqual(
    normalizeRuntimePolicyMutation({
      expectedRevision: 4,
      operation: {
        kind: 'patch_agent_settings',
        value: {
          personalization: { assistantTone: 'Be direct.' },
          memory: { agentReadEnabled: true },
          webSearch: { enabled: true },
        },
      },
    }),
    {
      expectedRevision: 4,
      operation: {
        kind: 'patch_agent_settings',
        value: {
          personalization: { assistantTone: 'Be direct.' },
          memory: { agentReadEnabled: true },
          webSearch: { enabled: true },
        },
      },
    },
  );
  assert.throws(
    () =>
      normalizeRuntimePolicyMutation({
        expectedRevision: 4,
        operation: {
          kind: 'patch_agent_settings',
          value: { networkProxy: { enabled: false } },
        },
      }),
    RuntimePolicyDomainDecodeError,
  );
});

test('normalizes catalog inputs while canonical entries reject noncanonical endpoints', () => {
  const input = normalizeCreateCatalogConnectionInput({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'openai-main',
      name: 'OpenAI',
      providerType: 'openai',
      baseUrl: 'https://proxy.example:443/v1',
      enabled: true,
      enabledModelIds: [],
    },
  });
  assert.equal(input.connection.baseUrl, 'https://proxy.example/v1');

  assert.throws(
    () =>
      decodeCanonicalConnectionCatalogEntry({
        ...input.connection,
        connectionId: '123e4567-e89b-42d3-a456-426614174000',
        revision: 1,
        baseUrl: 'https://proxy.example:443/v1',
        models: [],
      }),
    RuntimePolicyDomainDecodeError,
  );
});

test('normalizes exact bounded model discovery results', () => {
  assert.deepEqual(
    normalizeConnectionModelDiscoveryResult({
      models: [{ id: 'gpt-5', capabilities: { chat: true } }],
      source: 'fetched',
      fetchedAt: 42,
    }),
    {
      models: [{ id: 'gpt-5', capabilities: { chat: true } }],
      source: 'fetched',
      fetchedAt: 42,
    },
  );
  for (const invalid of [
    {
      models: [{ id: 'duplicate' }, { id: 'duplicate' }],
      source: 'fetched',
      fetchedAt: 42,
    },
    { models: [{ id: 'gpt-5' }], source: 'unknown', fetchedAt: 42 },
    { models: [{ id: 'gpt-5' }], source: 'fetched', fetchedAt: 42, rawBody: 'secret' },
  ]) {
    assert.throws(
      () => normalizeConnectionModelDiscoveryResult(invalid),
      RuntimePolicyDomainDecodeError,
    );
  }
});

test('credential domain validation requires material but leaves capacity to callers', () => {
  const input = normalizeSetCredentialInput({
    locator: {
      scope: 'connection',
      connectionId: '123e4567-e89b-42d3-a456-426614174000',
      kind: 'api_key',
    },
    expected: null,
    secret: 's'.repeat(20 * 1024),
  });
  assert.equal(input.secret.length, 20 * 1024);
  assert.throws(
    () => normalizeSetCredentialInput({ ...input, secret: '' }),
    RuntimePolicyDomainDecodeError,
  );
});
