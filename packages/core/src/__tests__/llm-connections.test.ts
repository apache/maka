import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES,
  lookupModelMetadata,
  modelIdAliasesForProvider,
} from '../model-metadata.js';
import { curatedCatalogFallbackModelsForProvider } from '../model-metadata.js';
import {
  backendKindOf,
  effectiveBaseUrl,
  normalizeConnectionBaseUrl,
  persistedBaseUrl,
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  reconcileConnectionAfterModelFetch,
  validateConnectionBaseUrl,
  type ProviderType,
} from '../llm-connections.js';

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

test('persisted base URLs retain only meaningful overrides', () => {
  for (const value of [undefined, '  ', 'https://api.openai.com/v1']) {
    assert.equal(persistedBaseUrl('openai', value), undefined);
  }
  assert.equal(
    persistedBaseUrl('openai', '  https://proxy.example.com/v1  '),
    'https://proxy.example.com/v1',
  );
  assert.equal(
    persistedBaseUrl('openai-compatible', 'https://gateway.example.com/v1'),
    'https://gateway.example.com/v1',
  );
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
  assert.equal(backendKindOf({ providerType: unknown }), 'fake');
  assert.equal(
    effectiveBaseUrl({ providerType: unknown, baseUrl: 'https://example.test/v1' }),
    'https://example.test/v1',
  );
  assert.equal(effectiveBaseUrl({ providerType: unknown }), '');
  assert.equal(persistedBaseUrl(unknown, '  '), undefined);
  assert.equal(providerAuthRequiresSecret(unknown), false);
  assert.equal(providerAuthSupportsApiKey(unknown), false);
});

test('model reconciliation keeps live choices and repairs stale defaults', () => {
  assert.deepEqual(
    reconcileConnectionAfterModelFetch(
      { defaultModel: 'live', enabledModelIds: ['retired', 'live'] },
      [{ id: 'live' }, { id: 'other' }],
    ),
    { defaultModel: 'live', enabledModelIds: ['live'] },
  );
  assert.deepEqual(
    reconcileConnectionAfterModelFetch({ defaultModel: 'retired', enabledModelIds: ['retired'] }, [
      { id: '  live  ' },
      { id: '' },
      { id: 'live' },
    ]),
    { defaultModel: 'live', enabledModelIds: ['live'] },
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
    { defaultModel: '', enabledModelIds: ['kept'] },
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
  // `claude-opus-5` leads the inventory, so without the table this falls through
  // to the first live id — the two behaviours differ and the assertion can fail.
  assert.deepEqual(reconcileConnectionAfterModelFetch(stored, curated), {
    defaultModel: 'claude-opus-5',
    enabledModelIds: ['claude-opus-5'],
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
  const offered = curatedCatalogFallbackModelsForProvider('claude-subscription') ?? [];
  for (const [renamed, target] of Object.entries(CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES)) {
    assert.ok(offered.includes(target), `${target} is not offered by the curated inventory`);
    // A withdrawn model must be repaired against the live list, never rewritten.
    assert.notEqual(lookupModelMetadata('anthropic', renamed).lifecycle, 'deprecated');
  }
});
