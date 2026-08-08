import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDefaultRuntimePolicy,
  decodeCanonicalConnectionCatalogEntry,
  decodeCanonicalRuntimePolicy,
  decodeRelayModelProfilesTable,
  normalizeCreateCatalogConnectionInput,
  normalizeConnectionCatalogEntryUpdate,
  normalizeConnectionCatalogEntryUpdateForProvider,
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

test('relay model profiles round-trip canonical entries and drafts, strictly', () => {
  const table = {
    'relay-reasoner': {
      thinkingLevels: ['minimal', 'low'],
      vision: true,
      contextWindow: 128_000,
    },
  };
  const draft = normalizeCreateCatalogConnectionInput({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'relay',
      name: 'Relay',
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example/v1',
      enabled: true,
      enabledModelIds: ['relay-reasoner'],
      relayModelProfiles: table,
    },
  });
  assert.deepEqual(draft.connection.relayModelProfiles, table);
  // The canonical path re-decodes the same table (entry = draft + identity).
  const entry = decodeCanonicalConnectionCatalogEntry({
    ...draft.connection,
    connectionId: '123e4567-e89b-42d3-a456-426614174000',
    revision: 1,
    models: [],
  });
  assert.deepEqual(entry.relayModelProfiles, table);

  // An empty table is never a state: drafts omit the key, updates read it as
  // the same clear-instruction `null` gives.
  const emptyDraft = normalizeCreateCatalogConnectionInput({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'relay',
      name: 'Relay',
      providerType: 'openai-compatible',
      enabled: true,
      enabledModelIds: [],
      relayModelProfiles: {},
    },
  });
  assert.equal(emptyDraft.connection.relayModelProfiles, undefined);
  const emptyUpdate = normalizeConnectionCatalogEntryUpdate({
    name: 'Relay',
    enabled: true,
    enabledModelIds: [],
    relayModelProfiles: {},
  });
  assert.equal(emptyUpdate.relayModelProfiles, null);

  // The update input is tri-state: null (or the equivalent {}) clears, a
  // table replaces, and an ABSENT key means untouched — absent must never
  // materialize into a clear, which is what keeps profile-blind writers
  // safe.
  const update = normalizeConnectionCatalogEntryUpdate({
    name: 'Relay',
    enabled: true,
    enabledModelIds: [],
    relayModelProfiles: null,
  });
  assert.equal(update.relayModelProfiles, null);
  const absentUpdate = normalizeConnectionCatalogEntryUpdate({
    name: 'Relay',
    enabled: true,
    enabledModelIds: [],
  });
  assert.deepEqual(absentUpdate, {
    name: 'Relay',
    enabled: true,
    enabledModelIds: [],
  });

  // Profiles are a relay-only feature: non-empty tables on other providers
  // are rejected at the write seam (null/absent stay legal for cleanup).
  assert.throws(
    () =>
      normalizeCreateCatalogConnectionInput({
        expectedCatalogRevision: 0,
        connection: {
          slug: 'not-a-relay',
          name: 'Other',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: ['relay-reasoner'],
          relayModelProfiles: table,
        },
      }),
    RuntimePolicyDomainDecodeError,
  );
  assert.throws(
    () =>
      normalizeConnectionCatalogEntryUpdateForProvider(
        {
          name: 'Other',
          enabled: true,
          enabledModelIds: ['relay-reasoner'],
          relayModelProfiles: table,
        },
        'anthropic',
      ),
    RuntimePolicyDomainDecodeError,
  );
  assert.equal(
    normalizeConnectionCatalogEntryUpdateForProvider(
      { name: 'Other', enabled: true, enabledModelIds: [], relayModelProfiles: null },
      'anthropic',
    ).relayModelProfiles,
    null,
  );

  // The subset invariant: profiles exist only for ENABLED models. The store
  // prunes profiles of deselected models, so a key outside the set marks a
  // document the store never wrote.
  assert.throws(
    () =>
      normalizeConnectionCatalogEntryUpdate({
        name: 'Relay',
        enabled: true,
        enabledModelIds: ['relay-reasoner'],
        relayModelProfiles: { 'disabled-model': { vision: true } },
      }),
    RuntimePolicyDomainDecodeError,
  );

  // Model ids are relay-supplied strings; __proto__/constructor/toString
  // must survive the table as ordinary own keys — the decode builds the
  // table with fromEntries precisely so '__proto__' cannot poison the result
  // object's prototype and quietly drop the entry.
  const hostileTable = decodeRelayModelProfilesTable(
    // An object literal could not even express `__proto__` as an own key —
    // the deserialized document is the realistic carrier of a hostile id.
    JSON.parse(
      '{"__proto__":{"vision":true},"constructor":{"vision":false},"toString":{"contextWindow":8192}}',
    ),
    ['__proto__', 'constructor', 'toString'],
  );
  assert.deepEqual(Object.keys(hostileTable).sort(), ['__proto__', 'constructor', 'toString']);
  assert.equal(JSON.stringify(hostileTable).includes('"__proto__"'), true);

  // Strictness: writers emit normalized tables, so anything else is corrupt.
  for (const bad of [
    'nope',
    [],
    { m: { thinkingLevels: ['turbo'] } }, // unknown level
    { m: { thinkingLevels: ['off'] } }, // disable wire, not a declarable tier
    { m: { thinkingLevels: ['low', 'low'] } }, // duplicate
    { m: { thinkingLevels: [] } }, // empty level list
    { m: {} }, // declares nothing
    { m: { vision: 'yes' } },
    { m: { contextWindow: 0 } },
    { m: { contextWindow: 1.5 } },
    { m: { contextWindow: 2 ** 60 } }, // not within 1..MAX_SAFE_INTEGER
    { m: { vision: true, extra: 1 } }, // unknown key in the entry
  ]) {
    assert.throws(
      () => decodeRelayModelProfilesTable(bad, ['m']),
      RuntimePolicyDomainDecodeError,
      JSON.stringify(bad),
    );
  }
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
