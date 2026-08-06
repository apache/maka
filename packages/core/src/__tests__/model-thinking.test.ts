import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  THINKING_LEVELS,
  deriveThinkingChoices,
  isThinkingLevel,
  thinkingOptionsForModel,
  thinkingVariantsForConnection,
  thinkingVariantsForModel,
} from '../model-thinking.js';

test('thinking choices are filtered, ordered, and expose off only with a real wire', () => {
  assert.deepEqual(
    [...deriveThinkingChoices({ efforts: ['max', 'turbo', 'none', 'low', 'high'] })],
    ['off', 'low', 'high', 'max'],
  );
  assert.deepEqual([...deriveThinkingChoices({ toggle: true })], []);
  assert.deepEqual(
    [...deriveThinkingChoices({ toggle: true, offBehavior: 'google-thinking-budget-zero' })],
    ['off'],
  );
  assert.deepEqual([...deriveThinkingChoices(undefined)], []);
});

test('model options preserve declared effort and off-wire facts', () => {
  assert.deepEqual(thinkingOptionsForModel('openai', 'gpt-5.5'), {
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  });
  assert.deepEqual(thinkingOptionsForModel('anthropic', 'claude-haiku-4-5'), {
    toggle: true,
    offBehavior: 'anthropic-thinking-disabled',
  });
  assert.deepEqual(thinkingOptionsForModel('deepseek', 'deepseek-v4-flash'), {
    efforts: ['high', 'max'],
    toggle: true,
  });
  assert.equal(thinkingOptionsForModel('openai', 'unknown-model'), undefined);
});

test("model variants expose each provider model's declared choices", () => {
  for (const [provider, model, expected] of [
    ['openai', 'gpt-5.5', ['off', 'low', 'medium', 'high', 'xhigh']],
    ['anthropic', 'claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['google', 'gemini-2.5-flash', ['off']],
    ['deepseek', 'deepseek-v4-flash', ['high', 'max']],
    ['cohere', 'command-a-plus-05-2026', ['off']],
    ['ollama', 'llama3', []],
  ] as const) {
    assert.deepEqual(
      [...thinkingVariantsForModel(provider, model)],
      expected,
      `${provider}:${model}`,
    );
  }
});

test('account access paths inherit thinking metadata from their provider', () => {
  assert.deepEqual(
    thinkingOptionsForModel('openai-codex', 'gpt-5.5'),
    thinkingOptionsForModel('openai', 'gpt-5.5'),
  );
  assert.deepEqual(
    thinkingOptionsForModel('claude-subscription', 'claude-opus-4-8'),
    thinkingOptionsForModel('anthropic', 'claude-opus-4-8'),
  );
  assert.deepEqual(
    thinkingOptionsForModel('openai-codex', 'gpt-5.6-luna'),
    thinkingOptionsForModel('openai', 'gpt-5.6-luna'),
  );
});

test('provider-scoped model ids do not leak metadata to ambiguous ids', () => {
  assert.deepEqual(
    [...thinkingVariantsForModel('vercel', 'xai/grok-4.3')],
    ['off', 'low', 'medium', 'high'],
  );
  assert.deepEqual([...thinkingVariantsForModel('vercel', 'grok-4.3')], []);
  assert.deepEqual([...thinkingVariantsForModel('openai-compatible', 'gpt-5.5')], []);
});

test('connection declarations win over the built-in catalog', () => {
  const relay = {
    providerType: 'openai-compatible' as const,
    models: [
      { id: 'deepseek-v4-flash-0731', thinkingOptions: { efforts: ['low', 'high', 'max'] } },
    ],
  };
  assert.deepEqual(
    [...thinkingVariantsForConnection(relay, 'deepseek-v4-flash-0731')],
    ['low', 'high', 'max'],
  );
  // 'none' in a declaration surfaces the off level, exactly like the catalog.
  assert.deepEqual(
    [
      ...thinkingVariantsForConnection(
        {
          providerType: 'openai-compatible' as const,
          models: [{ id: 'm', thinkingOptions: { efforts: ['none', 'low', 'high'] } }],
        },
        'm',
      ),
    ],
    ['off', 'low', 'high'],
  );
});

test('connection misses fall back to the built-in catalog', () => {
  // A catalog-backed model on any connection keeps its catalog levels when the
  // connection does not declare anything for it.
  assert.deepEqual(
    [
      ...thinkingVariantsForConnection(
        { providerType: 'openai' as const, models: [{ id: 'gpt-5.5' }] },
        'gpt-5.5',
      ),
    ],
    ['off', 'low', 'medium', 'high', 'xhigh'],
  );
  // A declared connection still reports nothing for undeclared models…
  const relay = {
    providerType: 'openai-compatible' as const,
    models: [
      { id: 'deepseek-v4-flash-0731', thinkingOptions: { efforts: ['low', 'high', 'max'] } },
    ],
  };
  assert.deepEqual([...thinkingVariantsForConnection(relay, 'some-other-model')], []);
  // …and a connection with no declarations at all behaves exactly like
  // `thinkingVariantsForModel` (the pre-feature behavior for every connection).
  assert.deepEqual(
    [
      ...thinkingVariantsForConnection(
        { providerType: 'openai-compatible' as const, models: [] },
        'm',
      ),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...thinkingVariantsForConnection(
        { providerType: 'anthropic' as const, models: [] },
        'claude-opus-4-8',
      ),
    ],
    thinkingVariantsForModel('anthropic', 'claude-opus-4-8'),
  );
});

test('thinking-level guard accepts only the closed display vocabulary', () => {
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  for (const value of ['default', 'turbo', undefined, 123]) {
    assert.equal(isThinkingLevel(value), false);
  }
});
