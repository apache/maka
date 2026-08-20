import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDefaultContextBudgetPolicy,
  resolveSelectedModelContextWindow,
} from '../context-budget-policy.js';

test('context budgeting prefers a model input limit over its context window', () => {
  const connection = {
    slug: 'openai',
    providerType: 'openai' as const,
    defaultModel: 'model-with-narrow-input',
    models: [{ id: 'model-with-narrow-input', contextWindow: 1_000, inputLimit: 600 }],
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 600);
  assert.equal(
    buildDefaultContextBudgetPolicy(connection, { env: {} })?.maxHistoryEstimatedTokens,
    450,
  );
});

test('invalid zero input limits do not disable the context-window fallback', () => {
  const connection = {
    slug: 'openai',
    providerType: 'openai' as const,
    defaultModel: 'model-with-invalid-input',
    models: [{ id: 'model-with-invalid-input', contextWindow: 1_000, inputLimit: 0 }],
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 1_000);
});

test('a relay user declaration remains ahead of runtime and static model facts', () => {
  const connection = {
    slug: 'relay',
    providerType: 'openai-compatible' as const,
    defaultModel: 'relay-model',
    models: [{ id: 'relay-model', contextWindow: 64_000, inputLimit: 128_000 }],
    relayModelProfiles: { 'relay-model': { contextWindow: 32_000 } },
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 32_000);
});

test('a model-facts context window is the authoritative user declaration', () => {
  const connection = {
    slug: 'relay',
    providerType: 'openai-compatible' as const,
    defaultModel: 'relay-model',
    models: [
      {
        id: 'relay-model',
        contextWindow: 200_000,
        inputLimit: 200_000,
        factOverriddenFields: ['contextWindow', 'inputLimit'] as const,
      },
    ],
    relayModelProfiles: { 'relay-model': { contextWindow: 8_192 } },
  };

  assert.equal(resolveSelectedModelContextWindow(connection, undefined), 200_000);
});
