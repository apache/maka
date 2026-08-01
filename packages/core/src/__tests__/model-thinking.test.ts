import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  THINKING_LEVELS,
  deriveThinkingChoices,
  isThinkingLevel,
  thinkingOptionsForModel,
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

test('model variants are derived from the same options contract', () => {
  for (const [provider, model] of [
    ['openai', 'gpt-5.5'],
    ['anthropic', 'claude-opus-4-8'],
    ['google', 'gemini-2.5-flash'],
    ['deepseek', 'deepseek-v4-flash'],
    ['cohere', 'command-a-plus-05-2026'],
    ['ollama', 'llama3'],
  ] as const) {
    assert.deepEqual(
      [...thinkingVariantsForModel(provider, model)],
      [...deriveThinkingChoices(thinkingOptionsForModel(provider, model))],
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
});

test('provider-scoped model ids do not leak metadata to ambiguous ids', () => {
  assert.deepEqual(
    [...thinkingVariantsForModel('vercel', 'xai/grok-4.3')],
    ['off', 'low', 'medium', 'high'],
  );
  assert.deepEqual([...thinkingVariantsForModel('vercel', 'grok-4.3')], []);
  assert.deepEqual([...thinkingVariantsForModel('openai-compatible', 'gpt-5.5')], []);
});

test('thinking-level guard accepts only the closed display vocabulary', () => {
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  for (const value of ['default', 'turbo', undefined, 123]) {
    assert.equal(isThinkingLevel(value), false);
  }
});
