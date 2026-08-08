import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ConnectionThinkingContext,
  DECLARABLE_RELAY_THINKING_LEVELS,
  normalizeRelayModelProfiles,
  relayModelProfile,
  resolveThinkingLevel,
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
    [...deriveThinkingChoices({ toggle: true, offBehavior: 'anthropic-thinking-disabled' })],
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

test('thinking-level guard accepts only the closed display vocabulary', () => {
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  for (const value of ['default', 'turbo', undefined, 123]) {
    assert.equal(isThinkingLevel(value), false);
  }
});

test('declarable relay levels are every intensity tier but off', () => {
  // `off` is a disable-wire encoding (reasoning_effort 'none'), not an
  // intensity tier — a hybrid UI/data contract keeps it out of declarations.
  assert.deepEqual(
    [...DECLARABLE_RELAY_THINKING_LEVELS],
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(normalizeRelayModelProfiles({ m: { thinkingLevels: ['off', 'low'] } }), {
    m: { thinkingLevels: ['low'] },
  });
  assert.equal(normalizeRelayModelProfiles({ m: { thinkingLevels: ['off'] } }), undefined);
  const declaredOff = {
    providerType: 'openai-compatible',
    relayModelProfiles: { m: { thinkingLevels: ['off', 'low'] } },
  } as const;
  assert.deepEqual([...thinkingVariantsForConnection(declaredOff, 'm')], ['low']);
});

test('relay profiles declare thinking levels per model, precisely', () => {
  // A declaration is exactly the subset the user ticked — no default set is
  // ever invented — and display order is restored on read.
  const connection = {
    providerType: 'openai-compatible',
    relayModelProfiles: { reasoner: { thinkingLevels: ['max', 'high'] } },
  } as const;
  assert.deepEqual(relayModelProfile(connection, 'reasoner')?.thinkingLevels, ['high', 'max']);
  assert.deepEqual([...thinkingVariantsForConnection(connection, 'reasoner')], ['high', 'max']);
  // A sibling model on the same relay without a declaration sees no menu —
  // the granularity is the model, not the connection.
  assert.deepEqual([...thinkingVariantsForConnection(connection, 'plain-instruct')], []);
});

test('relayModelProfile returns undefined without a usable declaration', () => {
  const connection = {
    providerType: 'openai-compatible',
    relayModelProfiles: {
      empty: {},
      junk: 'nope',
      badLevels: { thinkingLevels: 'low' },
      unknownLevels: { thinkingLevels: ['turbo'] },
      offOnly: { thinkingLevels: ['off'] },
      badVision: { vision: 'yes' },
    },
  } as unknown as ConnectionThinkingContext;
  for (const modelId of [
    'missing',
    'empty',
    'junk',
    'badLevels',
    'unknownLevels',
    'offOnly',
    'badVision',
  ]) {
    assert.equal(relayModelProfile(connection, modelId), undefined, modelId);
  }
});

test('relayModelProfile normalizes order, keeps explicit vision:false, and bounds context windows', () => {
  const connection = {
    providerType: 'openai-compatible',
    relayModelProfiles: {
      reasoner: { thinkingLevels: ['high', 'low', 'turbo'], vision: false },
      visual: { vision: true },
    },
  } as unknown as ConnectionThinkingContext;
  // Declared levels keep display order; unknown values are dropped;
  // vision:false is a meaningful DISABLE, distinct from absence (Auto).
  assert.deepEqual(relayModelProfile(connection, 'reasoner'), {
    thinkingLevels: ['low', 'high'],
    vision: false,
  });
  assert.deepEqual(relayModelProfile(connection, 'visual'), { vision: true });

  const windowed = (contextWindow: unknown) =>
    ({
      providerType: 'openai-compatible' as const,
      relayModelProfiles: { m: { contextWindow } },
    }) as unknown as ConnectionThinkingContext;
  assert.deepEqual(relayModelProfile(windowed(128_000), 'm'), { contextWindow: 128_000 });
  // Unusable values degrade to "no declaration", not to a lie.
  for (const bad of [0, -1, 1.5, 2 ** 60, '128000', null]) {
    assert.equal(relayModelProfile(windowed(bad), 'm'), undefined, JSON.stringify(bad));
  }
});

test('relayModelProfile gates declarations to openai-compatible relays', () => {
  const profiles = { m: { vision: true, contextWindow: 64_000 } };
  assert.deepEqual(
    relayModelProfile({ providerType: 'openai-compatible', relayModelProfiles: profiles }, 'm'),
    { vision: true, contextWindow: 64_000 },
  );
  // The same table on a non-relay connection is inert: metadata rules.
  for (const providerType of ['anthropic', 'openai'] as const) {
    assert.equal(relayModelProfile({ providerType, relayModelProfiles: profiles }, 'm'), undefined);
  }
});

test('normalizeRelayModelProfiles sanitizes write-side tables', () => {
  const sanitized = normalizeRelayModelProfiles({
    reasoner: { thinkingLevels: ['high', 'low', 'turbo'], vision: true, contextWindow: 200_000 },
    empty: {},
    junk: 'not-an-entry',
    huge: { contextWindow: 2 ** 60 },
    '': { vision: true },
    [`${'x'.repeat(513)}`]: { vision: true },
  });
  assert.deepEqual(sanitized, {
    reasoner: { thinkingLevels: ['low', 'high'], vision: true, contextWindow: 200_000 },
  });
  assert.equal(normalizeRelayModelProfiles({}), undefined);
  assert.equal(normalizeRelayModelProfiles(undefined), undefined);
  assert.equal(normalizeRelayModelProfiles({ junk: 'not-an-entry' }), undefined);
  // Relay-supplied ids may be prototype keys; the table defines them as own
  // data properties or the entries would vanish on the next enumeration.
  const hostile = normalizeRelayModelProfiles(
    JSON.parse('{"__proto__":{"vision":true},"toString":{"contextWindow":64}}'),
  );
  assert.deepEqual(Object.keys(hostile ?? {}).sort(), ['__proto__', 'toString']);
  assert.equal(JSON.stringify(hostile).includes('"__proto__"'), true);
});

test('resolveThinkingLevel discards levels the model does not offer', () => {
  const relay = {
    providerType: 'openai-compatible',
    relayModelProfiles: { m: { thinkingLevels: ['off', 'low'] } },
  } as const;
  assert.equal(resolveThinkingLevel(relay, 'm', 'low'), 'low');
  // `off` is not declarable for relays: a stray entry degrades to absent.
  assert.equal(resolveThinkingLevel(relay, 'm', 'off'), undefined);
  assert.equal(resolveThinkingLevel(relay, 'm', 'max'), undefined);
  assert.equal(resolveThinkingLevel(relay, 'm', undefined), undefined);
  assert.equal(resolveThinkingLevel({ providerType: 'openai' }, 'gpt-5.5', 'xhigh'), 'xhigh');
});

test('openai-compatible thinking variants are declared per model', () => {
  const connection = {
    providerType: 'openai-compatible',
    relayModelProfiles: { reasoner: { thinkingLevels: ['high', 'low', 'turbo'] } },
  } as unknown as ConnectionThinkingContext;
  assert.deepEqual([...thinkingVariantsForConnection(connection, 'reasoner')], ['low', 'high']);
  // A sibling model on the same relay without a declaration sees no menu —
  // the granularity is the model, not the connection.
  assert.deepEqual([...thinkingVariantsForConnection(connection, 'plain-instruct')], []);
});

test('openai-compatible connections without a declaration fall back to metadata variants', () => {
  for (const relayModelProfiles of [
    undefined,
    {},
    { 'deepseek-v4-flash': {} },
    { 'deepseek-v4-flash': { thinkingLevels: [] } },
    { 'deepseek-v4-flash': { thinkingLevels: 'low' } },
    { 'deepseek-v4-flash': { thinkingLevels: ['turbo'] } },
  ]) {
    assert.deepEqual(
      [
        ...thinkingVariantsForConnection(
          {
            providerType: 'openai-compatible',
            relayModelProfiles,
          } as unknown as ConnectionThinkingContext,
          'deepseek-v4-flash',
        ),
      ],
      [],
      JSON.stringify(relayModelProfiles),
    );
  }
  // Non-custom providers keep metadata-derived variants: a profiles table
  // riding along on their connection is inert.
  assert.deepEqual(
    [
      ...thinkingVariantsForConnection(
        {
          providerType: 'openai',
          relayModelProfiles: { 'gpt-5.5': { thinkingLevels: ['off'] } },
        },
        'gpt-5.5',
      ),
    ],
    ['off', 'low', 'medium', 'high', 'xhigh'],
  );
});

// Reasoning replay has no toggle: DeepSeek-like relays require
// reasoning_content in tool-call history (400 otherwise), and other relays
// ignore it, so the runtime replays unconditionally. That contract is
// enforced per provider by the runtime provider-contract matrix, not here.
