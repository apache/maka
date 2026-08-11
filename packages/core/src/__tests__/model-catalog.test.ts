import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isConnectionReady } from '../connection-readiness.js';
import type { LlmConnection, ProviderType } from '../llm-connections.js';
import {
  buildConnectionModelCatalogEntries,
  buildModelCatalogEntries,
  validateChatDefaultModel,
} from '../model-catalog.js';

function verdict(input: Parameters<typeof validateChatDefaultModel>[0]) {
  const result = validateChatDefaultModel(input);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

test('live inventory blocks missing defaults and preserves higher-priority failures', () => {
  const input = {
    providerType: 'zai-coding-plan' as const,
    defaultModel: 'removed',
    models: [{ id: 'glm-4.7' }],
    modelSource: 'fetched' as const,
  };
  const [missing] = buildModelCatalogEntries(input);
  assert.equal(missing?.availability, 'blocked');
  assert.equal(missing?.canUseAsChatDefault, false);
  assert.deepEqual(verdict(input), { ok: false, reason: 'not_in_live_list' });

  assert.equal(buildModelCatalogEntries({ ...input, authOk: false })[0]?.unavailableReason, 'auth');
  assert.equal(
    buildModelCatalogEntries({ ...input, providerAvailable: false })[0]?.unavailableReason,
    'provider_removed',
  );
});

test('chat-default validation blocks image-only models but accepts merged partial facts', () => {
  const imageOnly = {
    providerType: 'openai' as const,
    defaultModel: 'gpt-image-1',
    models: [{ id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(imageOnly), { ok: false, reason: 'unsupported_for_chat' });

  const partial = {
    providerType: 'openai' as const,
    defaultModel: 'gpt-5.4',
    models: [{ id: 'gpt-5.4', capabilities: { imageGeneration: true } }],
    modelSource: 'fetched' as const,
  };
  const [entry] = buildModelCatalogEntries(partial);
  assert.equal(entry?.canUseAsChatDefault, true);
  assert.deepEqual(entry?.capabilities, {
    reasoning: true,
    functionCalling: true,
    imageGeneration: true,
    vision: true,
  });
  assert.deepEqual(verdict(partial), { ok: true });
});

test('stale provider inventory warns without blocking sends', () => {
  const input = {
    providerType: 'anthropic' as const,
    defaultModel: 'claude-sonnet-4-5-20250929',
    models: [{ id: 'claude-sonnet-4-5-20250929' }],
    modelSource: 'fetched' as const,
    modelsFetchedAt: 1_700_000_000_000,
    now: 1_800_000_000_000,
    staleAfterMs: 1,
  };
  const [entry] = buildModelCatalogEntries(input);
  assert.equal(entry?.availability, 'warning');
  assert.equal(entry?.unavailableReason, 'stale');
  assert.equal(entry?.canUseAsChatDefault, true);
  assert.deepEqual(verdict(input), { ok: true });
});

test('fallback missing choices agree with the connection readiness gate', () => {
  const input = {
    providerType: 'openai-compatible' as const,
    defaultModel: 'custom-default',
    models: [{ id: 'relay-static-model' }],
    modelSource: 'fallback' as const,
  };
  assert.equal(buildModelCatalogEntries(input)[0]?.canUseAsChatDefault, false);
  assert.deepEqual(verdict(input), { ok: false, reason: 'not_in_live_list' });
  assert.deepEqual(
    isConnectionReady({
      connection: {
        slug: 'relay',
        name: 'Relay',
        providerType: 'openai-compatible',
        defaultModel: 'custom-default',
        enabled: true,
        models: input.models,
        modelSource: 'fallback',
        createdAt: 1,
        updatedAt: 1,
      },
      hasSecret: true,
    }),
    { ready: false, reason: 'model_not_enabled' },
  );
});

test('connection catalogs preserve user-choice provenance without inventing availability', () => {
  const connection: LlmConnection = {
    slug: 'zai-live',
    name: 'Z.AI',
    providerType: 'zai-coding-plan',
    defaultModel: 'saved-default',
    enabled: true,
    models: [{ id: 'glm-4.7' }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
  };
  const entries = buildConnectionModelCatalogEntries({
    connection,
    savedModelIds: [{ id: 'session-model', source: 'session_model' }, 'glm-4.7', ' '],
  });

  assert.deepEqual(
    entries.map(({ id, source, canUseAsChatDefault }) => [id, source, canUseAsChatDefault]),
    [
      ['saved-default', 'unknown', false],
      ['glm-4.7', 'provider_api', true],
      ['session-model', 'unknown', false],
    ],
  );
  assert.deepEqual(entries[0]?.provenance.sources?.userChoice, ['connection_default']);
  assert.deepEqual(entries[2]?.provenance.sources?.userChoice, ['session_model']);
});

test('unknown persisted provider ids return an empty catalog', () => {
  assert.deepEqual(
    buildConnectionModelCatalogEntries({
      connection: {
        slug: 'unknown',
        providerType: 'branch-only-provider' as ProviderType,
        defaultModel: 'model',
      },
    }),
    [],
  );
});
