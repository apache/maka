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

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES,
  lookupModelMetadata,
  modelIdAliasesForProvider,
} from '../model-metadata.js';
import { PROVIDER_REGISTRY, providerFallbackModelIds } from '../provider-registry.js';
import {
  authorizeConnectionModel,
  effectiveBaseUrl,
  normalizeConnectionBaseUrl,
  providerAuthRequiresSecret,
  providerDefaultsOf,
  providerAuthSupportsApiKey,
  reconcileConnectionAfterModelFetch,
  validateConnectionBaseUrl,
  type IdentifiedLlmConnection,
  type ProviderType,
} from '../llm-connections.js';
import { isRealConnection } from '../connection-readiness.js';
import { resolveConnectionModelCatalog } from '../model-catalog.js';
import { buildChatModelChoices } from '../chat-model-choice.js';
import { deriveProviderAuthContract } from '../provider-auth.js';

/**
 * The Host resolves a connection's catalog and projects it; the menu is built
 * over that projection. Tests go through the same resolution so they exercise
 * the path a client actually sees.
 */
function chatModelChoicesFor(
  connections: readonly IdentifiedLlmConnection[],
): ReturnType<typeof buildChatModelChoices> {
  return buildChatModelChoices(
    connections.map((connection) => ({
      ...connection,
      catalogEntries: resolveConnectionModelCatalog(connection),
    })),
  );
}

test('connection base URLs allow HTTP(S) and reject unsafe or malformed inputs', () => {
  assert.equal(validateConnectionBaseUrl(undefined), null);
  assert.equal(validateConnectionBaseUrl('https://api.example.com/v1'), null);
  assert.equal(validateConnectionBaseUrl('http://localhost:11434/v1'), null);
  assert.notEqual(validateConnectionBaseUrl('javascript:alert(1)'), null);
  assert.notEqual(validateConnectionBaseUrl('not-a-url'), null);
  assert.notEqual(validateConnectionBaseUrl(`https://example.com/${'a'.repeat(2050)}`), null);

  const exactLimit = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  assert.equal(exactLimit.length, 2048);
  assert.equal(validateConnectionBaseUrl(exactLimit), null);
});

test('base URL normalization preserves clear intent and rejects untrusted runtime types', () => {
  assert.deepEqual(normalizeConnectionBaseUrl('  '), { ok: true, value: '' });
  assert.deepEqual(normalizeConnectionBaseUrl('  https://Example.com:443/V1  '), {
    ok: true,
    value: 'https://Example.com:443/V1',
  });

  assert.equal(normalizeConnectionBaseUrl('javascript:alert(1)').ok, false);
  assert.equal(normalizeConnectionBaseUrl(null).ok, false);
});

test('unknown provider ids fail closed without breaking persisted connections', () => {
  const unknown = 'branch-only-provider' as ProviderType;
  assert.equal(isRealConnection({ providerType: unknown }), false);
  assert.equal(providerDefaultsOf(unknown), undefined);
  assert.equal(
    effectiveBaseUrl({ providerType: unknown, baseUrl: 'https://example.test/v1' }),
    'https://example.test/v1',
  );
  assert.equal(effectiveBaseUrl({ providerType: unknown }), '');
  assert.equal(providerAuthRequiresSecret(unknown), false);
  assert.equal(providerAuthSupportsApiKey(unknown), false);
});

test('a fetch never deletes a choice the user made', () => {
  // Reconciliation used to intersect the selection with whatever the response
  // listed. That deleted models the user had picked on every provider whose
  // list is partial — filtered on arrival, lagging the account, or a shipped
  // snapshot replayed by a provider with no model-list endpoint (#1584). One
  // observation is not grounds for discarding a decision; the picker marks an
  // id the provider stopped mentioning and unchecking it stays the user's
  // call.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: 'live', enabledModelIds: ['retired', 'live'] },
      [{ id: 'live' }, { id: 'other' }],
    ),
    { defaultModel: 'live', enabledModelIds: ['live', 'retired'] },
  );
  // A default absent from the response is not repaired onto another model
  // either — silently switching which model answers is its own surprise.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch({ defaultModel: 'retired', enabledModelIds: ['retired'] }, [
      { id: '  live  ' },
      { id: '' },
      { id: 'live' },
    ]),
    { defaultModel: 'retired', enabledModelIds: ['retired'] },
  );
  assert.deepEqual(
    reconcileConnectionAfterModelFetch({ defaultModel: 'saved', enabledModelIds: ['saved'] }, []),
    { defaultModel: 'saved', enabledModelIds: ['saved'] },
  );
});

test('model reconciliation never invents a default the user cleared', () => {
  // Unchecking the default leaves a legitimate {no default, some enabled}
  // state. Repair had nothing to repair here, so it reached for "the first
  // still-enabled id" and handed the choice back — on every refresh, and on
  // every OAuth resync that runs before a connection list read.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: ['kept', 'retired'], hasModelInventory: true },
      [{ id: 'kept' }, { id: 'fresh' }],
    ),
    { defaultModel: '', enabledModelIds: ['kept', 'retired'] },
  );
  // Same with nothing enabled at all.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: [], hasModelInventory: true },
      [{ id: 'fresh' }],
    ),
    { defaultModel: '', enabledModelIds: [] },
  );
  // The one exception: a connection that has never had a list to pick from.
  // The four providers with no `fallbackModels` are created with an empty
  // default, so discovery is the only place their first one can come from.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: [], hasModelInventory: false },
      [{ id: 'first-live' }, { id: 'other' }],
    ),
    { defaultModel: 'first-live', enabledModelIds: ['first-live'] },
  );
  // Not an exception: a selection exists, so the user has had the list.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: '', enabledModelIds: ['picked'], hasModelInventory: false },
      [{ id: 'picked' }, { id: 'other' }],
    ),
    { defaultModel: '', enabledModelIds: ['picked'] },
  );
});

test('a renamed id follows its model, and only for a caller that supplies the table', () => {
  const curated = [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }];
  const stored = {
    defaultModel: 'claude-haiku-4-5-20251001',
    enabledModelIds: ['claude-haiku-4-5-20251001'],
    hasModelInventory: true,
  };
  // Without the table the rename is invisible, so the stored id is left exactly
  // as the user last set it — a fetch migrates ids it can prove were renamed
  // and touches nothing else.
  assert.deepEqual(reconcileConnectionAfterModelFetch(stored, curated), {
    defaultModel: 'claude-haiku-4-5-20251001',
    enabledModelIds: ['claude-haiku-4-5-20251001'],
  });
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(stored, curated, {
      aliases: CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES,
    }),
    { defaultModel: 'claude-haiku-4-5', enabledModelIds: ['claude-haiku-4-5'] },
  );
  // Both forms enabled collapse onto one entry rather than duplicating, on the
  // path that returns its list without the dedupe the others inherit.
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      {
        defaultModel: '',
        enabledModelIds: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
        hasModelInventory: true,
      },
      curated,
      { aliases: CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES },
    ),
    { defaultModel: '', enabledModelIds: ['claude-haiku-4-5'] },
  );
});

test('the alias table is selected by provider and names only renames', () => {
  assert.equal(
    modelIdAliasesForProvider('claude-subscription'),
    CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES,
  );
  assert.equal(modelIdAliasesForProvider('anthropic'), undefined);
  for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
    assert.deepEqual(
      reconcileConnectionAfterModelFetch(
        {
          defaultModel: 'qwen3.8-max-preview',
          enabledModelIds: ['qwen3.8-max-preview'],
          hasModelInventory: true,
        },
        [{ id: 'qwen3.8-max' }, { id: 'qwen3.7-max' }],
        { aliases: modelIdAliasesForProvider(providerType) },
      ),
      { defaultModel: 'qwen3.8-max', enabledModelIds: ['qwen3.8-max'] },
      providerType,
    );
  }
  const offered = providerFallbackModelIds(PROVIDER_REGISTRY['claude-subscription']);
  for (const [renamed, target] of Object.entries(CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES)) {
    assert.ok(offered.includes(target), `${target} is not offered by the shipped baseline`);
    // A withdrawn model must be repaired against the live list, never rewritten.
    assert.notEqual(lookupModelMetadata('anthropic', renamed).lifecycle, 'deprecated');
  }
});

test('the model picker lists an enabled model a snapshot provider never listed', () => {
  // Catalog projection reads `connection.models`, which for a provider without
  // a model-list endpoint is the array this build shipped — recorded as
  // `modelSource: 'fetched'`, because a discovery run did happen; it just had
  // nothing to ask. Projecting the enabled ids as user choices is what keeps a
  // model the user picked — one their Ark plan serves but Maka's snapshot
  // predates — from vanishing out of every picker (#1584).
  const choices = chatModelChoicesFor([
    {
      connectionId: 'connection-1',
      slug: 'ark-plan',
      name: 'Ark Agent Plan',
      providerType: 'volcengine-agent-plan',
      enabled: true,
      defaultModel: 'doubao-seed-2.1-turbo',
      enabledModelIds: ['doubao-seed-2.1-turbo', 'deepseek-v4-pro-beta'],
      models: [{ id: 'doubao-seed-2.1-turbo' }],
      modelSource: 'fetched',
      createdAt: 1,
      updatedAt: 1,
    },
  ]);

  assert.deepEqual(choices.map(({ model }) => model).sort(), [
    'deepseek-v4-pro-beta',
    'doubao-seed-2.1-turbo',
  ]);
});

test('chat model choices project exact vision support for attachment composition', () => {
  const choices = chatModelChoicesFor([
    {
      connectionId: 'connection-vision',
      slug: 'openai-compatible',
      name: 'OpenAI compatible',
      providerType: 'openai-compatible',
      enabled: true,
      defaultModel: 'text-model',
      enabledModelIds: ['text-model', 'vision-model'],
      models: [
        { id: 'text-model', capabilities: { vision: false } },
        { id: 'vision-model', capabilities: { vision: true } },
      ],
      createdAt: 1,
      updatedAt: 1,
    },
  ]);

  assert.deepEqual(
    choices.map(({ model, supportsVision }) => ({ model, supportsVision })),
    [
      { model: 'text-model', supportsVision: false },
      { model: 'vision-model', supportsVision: true },
    ],
  );
});

test('chat model choices keep provider metadata separate from user context declarations', () => {
  const choices = chatModelChoicesFor([
    {
      connectionId: 'connection-context',
      slug: 'openai-compatible',
      name: 'OpenAI compatible',
      providerType: 'openai-compatible',
      enabled: true,
      defaultModel: 'declared-model',
      enabledModelIds: ['declared-model', 'reported-model'],
      models: [
        { id: 'declared-model', contextWindow: 64_000, inputLimit: 48_000 },
        { id: 'reported-model', contextWindow: 128_000 },
      ],
      relayModelProfiles: { 'declared-model': { contextWindow: 32_000 } },
      createdAt: 1,
      updatedAt: 1,
    },
  ]);

  assert.deepEqual(
    choices.map(({ model, contextWindow, declaredContextWindow }) => ({
      model,
      contextWindow,
      declaredContextWindow,
    })),
    [
      { model: 'declared-model', contextWindow: 64_000, declaredContextWindow: 32_000 },
      { model: 'reported-model', contextWindow: 128_000, declaredContextWindow: undefined },
    ],
  );
});

test('provider recognition does not resolve inherited object members', () => {
  // `PROVIDER_REGISTRY` is an object literal, so plain indexing answers truthy
  // for `__proto__` / `toString` / `constructor` and they would read as
  // registered providers. Recognition owns the own-property check so no
  // caller has to repeat it.
  for (const inherited of ['__proto__', 'toString', 'constructor', 'valueOf']) {
    const providerType = inherited as ProviderType;
    assert.equal(providerDefaultsOf(inherited), undefined, inherited);
    assert.equal(isRealConnection({ providerType }), false, inherited);
    assert.deepEqual(
      chatModelChoicesFor([
        {
          slug: 'inherited',
          name: 'inherited',
          providerType,
          enabled: true,
          defaultModel: 'm',
          models: [{ id: 'm' }],
        } as unknown as Parameters<typeof buildChatModelChoices>[0][number],
      ]),
      [],
      inherited,
    );
    // The auth contract has its own unknown-provider branch, and its comment
    // says it mirrors `isRealConnection`. It only does so while it asks the
    // same question the same way: indexing the registry directly handed it an
    // inherited member instead of `undefined`, and the branch never ran.
    const contract = deriveProviderAuthContract({ providerType, hasSecret: false });
    assert.equal(
      Object.values(contract.actionAvailability).every((value) => value === false),
      true,
      inherited,
    );
  }
});

test('a quarantined model id is vetoed even when enabled and present in the inventory', () => {
  const connection = {
    providerType: 'opencode-free' as ProviderType,
    enabledModelIds: ['nemotron-3-ultra-free', 'muse-spark-1.2-contributor-free'],
    models: [{ id: 'nemotron-3-ultra-free' }, { id: 'muse-spark-1.2-contributor-free' }],
  };
  assert.equal(authorizeConnectionModel(connection, 'muse-spark-1.2-contributor-free'), undefined);
  assert.deepEqual(authorizeConnectionModel(connection, 'nemotron-3-ultra-free'), {
    id: 'nemotron-3-ultra-free',
  });
});

test('a quarantined stored default is dropped from the picker, not re-added as a missing-default row', () => {
  // The retired `x-preview-f-free` was picker-visible before the quarantine, so
  // an upgrade connection can carry it as `defaultModel` and enabled. `models`
  // and `enabledModelIds` are filtered against `brokenModelIds`, but the raw
  // `defaultModel` used to pass through unfiltered and `makeMissingDefaultEntry`
  // re-added it as a selectable `provider_default` row — visible and pickable
  // while `authorizeConnectionModel` vetoed the same id. The picker and the send
  // authority must agree: neither offers it, and the live model still renders.
  const connection = {
    connectionId: 'connection-opencode-free',
    slug: 'opencode-free',
    name: 'OpenCode Free',
    providerType: 'opencode-free' as ProviderType,
    enabled: true,
    defaultModel: 'x-preview-f-free',
    enabledModelIds: ['x-preview-f-free', 'nemotron-3-ultra-free'],
    models: [{ id: 'x-preview-f-free' }, { id: 'nemotron-3-ultra-free' }],
    modelSource: 'fetched' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const models = chatModelChoicesFor([connection]).map(({ model }) => model);
  assert.ok(!models.includes('x-preview-f-free'), 'quarantined default must not be offered');
  assert.ok(models.includes('nemotron-3-ultra-free'), 'live enabled model still renders');
  assert.equal(authorizeConnectionModel(connection, 'x-preview-f-free'), undefined);
});
