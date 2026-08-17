import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isConnectionReady } from '../connection-readiness.js';
import { PROVIDER_DEFAULTS, type LlmConnection, type ProviderType } from '../llm-connections.js';
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

test('Alibaba Token Plan catalogs the formal Qwen3.8 model instead of its retired preview alias', () => {
  const modelId = 'qwen3.8-max';
  for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
    const defaults = PROVIDER_DEFAULTS[providerType];
    assert.equal(defaults.fallbackModels[0], modelId, providerType);
    assert.equal(defaults.fallbackModels.includes('qwen3.8-max-preview'), false, providerType);

    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: providerType,
        providerType,
        defaultModel: modelId,
        modelSource: 'fallback',
      },
    });
    const model = entries.find((entry) => entry.id === modelId);
    assert.equal(model?.displayName, 'Qwen3.8 Max', providerType);
    assert.equal(model?.contextWindow, 1_000_000, providerType);
    assert.equal(model?.maxOutputTokens, 131_072, providerType);
    assert.equal(model?.structuredOutput, true, providerType);
    assert.deepEqual(
      model?.capabilities,
      { vision: true, reasoning: true, functionCalling: true },
      providerType,
    );
    assert.deepEqual(model?.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] });
    assert.equal(model?.canUseAsChatDefault, true, providerType);
  }
});

test('saved model choices can materialize a user fact override without exposing unrelated entries', () => {
  const entries = buildConnectionModelCatalogEntries({
    connection: {
      slug: 'zai-live',
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-4.7',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
    },
    savedModelIds: [{ id: 'saved-custom', source: 'session_model' }],
    modelFactOverrides: {
      'zai-coding-plan:saved-custom': {
        displayName: 'Saved Custom',
        contextWindow: 88_000,
        knowledgeCutoff: '2026-01-01',
        structuredOutput: true,
        lastUpdated: '2026-02-01',
        modalities: { input: ['text'], output: ['text'] },
      },
      'zai-coding-plan:hidden': { contextWindow: 1_000 },
    },
  });
  const saved = entries.find((entry) => entry.id === 'saved-custom');
  assert.equal(saved?.displayName, 'Saved Custom');
  assert.equal(saved?.contextWindow, 88_000);
  assert.equal(saved?.knowledgeCutoff, '2026-01-01');
  assert.equal(saved?.structuredOutput, true);
  assert.equal(saved?.lastUpdated, '2026-02-01');
  assert.deepEqual(saved?.modalities, { input: ['text'], output: ['text'] });
  assert.equal(
    entries.some((entry) => entry.id === 'hidden'),
    false,
  );
});

test('catalog capability merges retain provider web search facts alongside overrides', () => {
  const entries = buildModelCatalogEntries({
    providerType: 'deepseek',
    models: [{ id: 'deepseek-v4-flash', capabilities: { webSearch: true } }],
    modelSource: 'fetched',
    modelFactOverrides: { 'deepseek:deepseek-v4-flash': { capabilities: { chat: true } } },
  });
  assert.equal(entries[0]?.capabilities.webSearch, true);
});
