import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderType } from '@maka/core';
import { modelMenuGroups, type ChatModelChoice } from '../chat-model-helpers.js';

function choice(connectionSlug: string, providerType: ProviderType, model: string, label = model): ChatModelChoice {
  const labels: Partial<Record<ProviderType, string>> = {
    'openai-codex': 'OpenAI OAuth',
    'openai-compatible': '自定义',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
  };
  const providerLabel = labels[providerType] ?? providerType[0]!.toUpperCase() + providerType.slice(1);
  return { connectionSlug, providerType, providerLabel, model, label, isDefault: true, thinkingLevels: [] };
}

test('single connection per provider: heading is just the short label', () => {
  const groups = modelMenuGroups([
    choice('openai-main', 'openai', 'gpt-5.5'),
    choice('anthropic-main', 'anthropic', 'claude-opus-4-8'),
  ]);
  assert.deepEqual(
    groups.map((g) => g.heading).sort(),
    ['Anthropic', 'OpenAI'],
  );
});

test('same provider, multiple connections: headings are disambiguated by slug', () => {
  const groups = modelMenuGroups([
    choice('openai-work', 'openai', 'gpt-5.5'),
    choice('openai-personal', 'openai', 'gpt-5.5'),
  ]);
  assert.equal(groups.length, 2);
  const headings = groups.map((g) => g.heading);
  assert.equal(new Set(headings).size, 2, 'two same-provider connections must read as distinct rows');
  for (const h of headings) assert.match(h, /^OpenAI · openai-(work|personal)$/);
});

test('cross-provider same model name stays in separate, distinguishable groups', () => {
  // `gpt-5.5` is reachable both via an OpenAI api key and a Codex subscription;
  // the user must be able to tell which connection a row belongs to.
  const groups = modelMenuGroups([
    choice('openai-main', 'openai', 'gpt-5.5'),
    choice('codex-sub', 'openai-codex', 'gpt-5.5'),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(new Set(groups.map((g) => g.heading)).size, 2);
  assert.deepEqual(
    groups.map((g) => g.heading).sort(),
    ['OpenAI', 'OpenAI OAuth'],
  );
});

test('each group carries its providerType so the menu can pick the right brand mark', () => {
  // The grouped menu renders a provider brand mark on each heading, keyed off
  // this field; a regression that dropped it would silently show the wrong logo.
  const groups = modelMenuGroups([
    choice('zai-live', 'zai-coding-plan', 'glm-4.6'),
    choice('zai-live', 'zai-coding-plan', 'glm-5'),
    choice('anthropic-main', 'anthropic', 'claude-opus-4-8'),
  ]);
  const bySlug = new Map(groups.map((g) => [g.connectionSlug, g]));
  assert.equal(bySlug.get('zai-live')?.providerType, 'zai-coding-plan');
  assert.equal(bySlug.get('zai-live')?.choices.length, 2, 'models of one connection stay in one group');
  assert.equal(bySlug.get('anthropic-main')?.providerType, 'anthropic');
});

test('headings never leak an account email (no @), even with slug disambiguation', () => {
  // Callers only populate connectionName for non-OAuth providers, so OAuth
  // groups can never carry the account email; this guards against a future
  // regression that passes connection.name through unguarded.
  const groups = modelMenuGroups([
    choice('openai-a', 'openai', 'gpt-5.5'),
    choice('openai-b', 'openai', 'gpt-5.5'),
    choice('claude-sub', 'claude-subscription', 'claude-opus-4-8'),
  ]);
  for (const g of groups) assert.ok(!g.heading.includes('@'), `heading "${g.heading}" looks like it leaks an email`);
});

test('connectionName wins over the provider label when supplied', () => {
  // A user-named openai-compatible gateway must read as its own name
  // ("Openrouter"), not the generic "自定义" fallback.
  const groups = modelMenuGroups([
    { ...choice('openrouter', 'openai-compatible', 'anthropic/claude-sonnet-5'), connectionName: 'Openrouter' },
    choice('deepseek', 'deepseek', 'deepseek-v4-flash'),
  ]);
  const bySlug = new Map(groups.map((g) => [g.connectionSlug, g]));
  assert.equal(bySlug.get('openrouter')?.heading, 'Openrouter');
  assert.equal(bySlug.get('deepseek')?.heading, 'DeepSeek');
});

test('blank connectionName falls back to the provider label', () => {
  const groups = modelMenuGroups([
    { ...choice('gateway', 'openai-compatible', 'some/model'), connectionName: '   ' },
  ]);
  assert.equal(groups[0]?.heading, '自定义');
});

test('localized provider headings override the snapshot fallback label', () => {
  const groups = modelMenuGroups([
    { ...choice('claude', 'claude-subscription', 'claude-opus-4-8'), providerLabel: 'Claude Subscription' },
  ], 'zh');
  assert.equal(groups[0]?.heading, 'Claude 订阅');
});

test('unnamed connection keeps slug disambiguation even when a sibling is named', () => {
  // Two openai-compatible connections, only one named: the named one uses its
  // name, the unnamed one still needs the slug suffix to stay distinguishable.
  const groups = modelMenuGroups([
    { ...choice('openrouter', 'openai-compatible', 'a/m1'), connectionName: 'Openrouter' },
    choice('other-gateway', 'openai-compatible', 'b/m2'),
  ]);
  const bySlug = new Map(groups.map((g) => [g.connectionSlug, g]));
  assert.equal(bySlug.get('openrouter')?.heading, 'Openrouter');
  assert.equal(bySlug.get('other-gateway')?.heading, '自定义 · other-gateway');
});

test('connectionName is read from the first choice of each connection', () => {
  // All choices of one connection carry the same connectionName (they come
  // from one LlmConnection); grouping keys off the first and must keep every
  // model row in that single named group.
  const groups = modelMenuGroups([
    { ...choice('openrouter', 'openai-compatible', 'a/m1'), connectionName: 'Openrouter' },
    { ...choice('openrouter', 'openai-compatible', 'b/m2'), connectionName: 'Openrouter' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.heading, 'Openrouter');
  assert.equal(groups[0]?.choices.length, 2);
});

test('two connections sharing the same connectionName are disambiguated by slug', () => {
  // The add form defaults the name to the provider's display label, so two
  // quickly-added keys can easily share a name — they must not collapse into
  // identical headings.
  const groups = modelMenuGroups([
    { ...choice('openrouter-a', 'openai-compatible', 'a/m1'), connectionName: 'OpenRouter' },
    { ...choice('openrouter-b', 'openai-compatible', 'b/m2'), connectionName: 'OpenRouter' },
  ]);
  assert.deepEqual(
    groups.map((g) => g.heading).sort(),
    ['OpenRouter · openrouter-a', 'OpenRouter · openrouter-b'],
  );
});
