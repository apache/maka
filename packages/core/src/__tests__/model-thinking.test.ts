import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ConnectionThinkingContext,
  normalizeRelayModelProfiles,
  relayModelProfile,
  resolveThinkingLevel,
  deriveThinkingChoices,
  thinkingOptionsForModel,
  thinkingVariantsForConnection,
  thinkingVariantsForModel,
} from '../model-thinking.js';

test('declarable relay levels are every intensity tier but off', () => {
  // `off` is a disable-wire encoding (reasoning_effort 'none'), not an
  // intensity tier — a hybrid UI/data contract keeps it out of declarations.
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

// Reasoning replay has no toggle: DeepSeek-like relays require
// reasoning_content in tool-call history (400 otherwise), and other relays
// ignore it, so the runtime replays unconditionally. That contract is
// enforced per provider by the runtime provider-contract matrix, not here.
