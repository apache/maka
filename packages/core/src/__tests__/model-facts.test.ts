import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyModelFactOverride,
  applyModelFactOverridesToConnection,
  decodeModelFactsDocument,
  modelFactKey,
} from '../model-facts.js';

test('model facts use provider:model keys and merge fields without replacing provider facts', () => {
  const key = modelFactKey('openai', 'o4-mini');
  const document = decodeModelFactsDocument({
    schemaVersion: 1,
    overrides: { [key]: { contextWindow: 200_000, capabilities: { vision: false } } },
  });
  const model = applyModelFactOverride(
    {
      id: 'o4-mini',
      displayName: 'Provider name',
      maxOutputTokens: 4_000,
      capabilities: { chat: true, vision: true },
    },
    document.overrides[key],
  );
  assert.equal(model.displayName, 'Provider name');
  assert.equal(model.contextWindow, 200_000);
  assert.deepEqual(model.capabilities, { chat: true, vision: false });
});

test('malformed and unknown model fact fields are rejected', () => {
  assert.throws(() =>
    decodeModelFactsDocument({ schemaVersion: 1, overrides: { 'openai:o4-mini': { nope: true } } }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({ schemaVersion: 1, overrides: { 'o4-mini': { contextWindow: 1 } } }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({
      schemaVersion: 1,
      overrides: { 'openai:o4-mini': { contextWindow: 0 } },
    }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({
      schemaVersion: 1,
      overrides: { 'openai:o4-mini': { capabilities: { toString: true } } },
    }),
  );
  assert.throws(() =>
    decodeModelFactsDocument({
      schemaVersion: 1,
      overrides: { 'toString:model': { contextWindow: 1 } },
    }),
  );
});

test('model fact keys preserve colons in provider model ids', () => {
  const key = modelFactKey('ollama-cloud', 'gpt-oss:120b');
  assert.equal(key, 'ollama-cloud:gpt-oss:120b');
  const document = decodeModelFactsDocument({
    schemaVersion: 1,
    overrides: { [key]: { contextWindow: 131_072 } },
  });
  assert.equal(document.overrides[key]?.contextWindow, 131_072);
});

test('override-only models are projected only when enabled', () => {
  const connection = {
    slug: 'openai',
    providerType: 'openai' as const,
    defaultModel: 'custom',
    enabledModelIds: ['custom'],
    models: [{ id: 'provider-model' }],
  };
  const result = applyModelFactOverridesToConnection(connection, {
    'openai:custom': { contextWindow: 64_000 },
    'openai:hidden': { contextWindow: 1_000 },
  });
  assert.deepEqual(result.models, [
    { id: 'provider-model' },
    {
      id: 'custom',
      contextWindow: 64_000,
      inputLimit: 64_000,
      factOverriddenFields: ['contextWindow', 'inputLimit'],
    },
  ]);
});

test('context window facts cannot be truncated by an older input limit', () => {
  const result = applyModelFactOverride(
    { id: 'model', contextWindow: 8_192, inputLimit: 8_192 },
    { contextWindow: 200_000 },
  );
  assert.equal(result.contextWindow, 200_000);
  assert.equal(result.inputLimit, 200_000);
});

test('overrides replace fields on discovered models while preserving untouched provider facts', () => {
  const result = applyModelFactOverridesToConnection(
    {
      providerType: 'openai',
      defaultModel: 'provider-model',
      enabledModelIds: ['provider-model'],
      models: [
        { id: 'provider-model', contextWindow: 8_000, capabilities: { chat: true, vision: true } },
      ],
    },
    { 'openai:provider-model': { contextWindow: 64_000, capabilities: { vision: false } } },
  );
  assert.equal(result.models?.[0]?.contextWindow, 64_000);
  assert.deepEqual(result.models?.[0]?.capabilities, { chat: true, vision: false });
});

test('catalog capabilities preserve web search facts from metadata and overrides', () => {
  const result = applyModelFactOverride(
    { id: 'web-model', capabilities: { webSearch: true } },
    { capabilities: { chat: true } },
  );
  assert.deepEqual(result.capabilities, { webSearch: true, chat: true });
});
