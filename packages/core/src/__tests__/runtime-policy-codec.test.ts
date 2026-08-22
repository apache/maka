/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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

test('keeps user-approved subagent presets canonical in Runtime Policy', () => {
  const preset = {
    id: 'fast-reader',
    name: 'Fast reader',
    description: 'Cheap scans',
    profile: 'local_read' as const,
    connectionSlug: 'openrouter',
    model: 'openrouter/free',
    enabled: true,
  };
  const policy = { ...createDefaultRuntimePolicy(), subagents: { presets: [preset] } };
  assert.deepEqual(decodeCanonicalRuntimePolicy(policy).subagents.presets, [preset]);
  assert.deepEqual(
    normalizeRuntimePolicyMutation({
      expectedRevision: 2,
      operation: { kind: 'set_subagents', value: { presets: [preset] } },
    }),
    { expectedRevision: 2, operation: { kind: 'set_subagents', value: { presets: [preset] } } },
  );
});

test('normalizes the explicit Git Bash preference and rejects arbitrary shell kinds', () => {
  assert.deepEqual(
    normalizeRuntimePolicyMutation({
      expectedRevision: 3,
      operation: {
        kind: 'set_shell',
        value: {
          preference: 'git_bash',
          executable: ' C:\\Program Files\\Git\\bin\\bash.exe ',
        },
      },
    }),
    {
      expectedRevision: 3,
      operation: {
        kind: 'set_shell',
        value: {
          preference: 'git_bash',
          executable: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
      },
    },
  );
  assert.throws(
    () =>
      normalizeRuntimePolicyMutation({
        expectedRevision: 3,
        operation: {
          kind: 'set_shell',
          value: { preference: 'custom', executable: 'C:\\tools\\fish.exe' },
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
      normalizeCreateCatalogConnectionInput({
        expectedCatalogRevision: 0,
        connection: {
          slug: 'unicode-relay',
          name: 'Unicode relay',
          providerType: 'openai-compatible',
          baseUrl: `https://example.test/${'界'.repeat(2_000)}`,
          enabled: true,
          enabledModelIds: [],
        },
      }),
    /must not exceed 2048 bytes/,
  );

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

test('rejects new connections for the retired Gemini CLI account provider', () => {
  assert.throws(
    () =>
      normalizeCreateCatalogConnectionInput({
        expectedCatalogRevision: 0,
        connection: {
          slug: 'gemini-account',
          name: 'Gemini account',
          providerType: 'gemini-cli',
          enabled: true,
          enabledModelIds: [],
        },
      }),
    /provider type is not registered/,
  );
});

test('relay model profiles round-trip canonical entries and drafts, strictly', () => {
  const table = {
    'relay-reasoner': {
      thinkingLevels: ['minimal', 'low'],
      vision: true,
      contextWindow: 128_000,
      serviceTier: 'fast',
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
  const responsesDraft = normalizeCreateCatalogConnectionInput({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'responses-relay',
      name: 'Responses Relay',
      providerType: 'openai-responses-compatible',
      baseUrl: 'https://responses.example/v1',
      enabled: true,
      enabledModelIds: ['relay-reasoner'],
      relayModelProfiles: table,
    },
  });
  assert.deepEqual(responsesDraft.connection.relayModelProfiles, table);
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

  // The write seam splits the table by FIELD, not by provider (#1584).
  // `contextWindow` and `vision` state facts about a model, and a user has
  // them when Maka does not — a model newer than the bundled snapshot, or any
  // model on a provider with no model-list endpoint — so they are legal
  // everywhere.
  const facts = { 'relay-reasoner': { vision: true, contextWindow: 128_000 } };
  assert.deepEqual(
    normalizeCreateCatalogConnectionInput({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'not-a-relay',
        name: 'Other',
        providerType: 'openai',
        enabled: true,
        enabledModelIds: ['relay-reasoner'],
        relayModelProfiles: facts,
      },
    }).connection.relayModelProfiles,
    facts,
  );
  assert.deepEqual(
    normalizeConnectionCatalogEntryUpdateForProvider(
      {
        name: 'Other',
        enabled: true,
        enabledModelIds: ['relay-reasoner'],
        relayModelProfiles: facts,
      },
      'anthropic',
    ).relayModelProfiles,
    facts,
  );

  // `thinkingLevels` and `serviceTier` name a wire feature only the
  // OpenAI-compatible relays accept, so they stay relay-only on both write
  // paths: elsewhere they are a request Maka would never send.
  for (const wireShaped of [
    { 'relay-reasoner': { thinkingLevels: ['low'] } },
    { 'relay-reasoner': { serviceTier: 'fast' } },
  ]) {
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
            relayModelProfiles: wireShaped,
          },
        }),
      /require[s]? an OpenAI-compatible connection/,
      JSON.stringify(wireShaped),
    );
    assert.throws(
      () =>
        normalizeConnectionCatalogEntryUpdateForProvider(
          {
            name: 'Other',
            enabled: true,
            enabledModelIds: ['relay-reasoner'],
            relayModelProfiles: wireShaped,
          },
          'anthropic',
        ),
      /require[s]? an OpenAI-compatible connection/,
      JSON.stringify(wireShaped),
    );
  }

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
