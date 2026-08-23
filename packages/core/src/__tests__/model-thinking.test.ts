/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
  supportsRelayFastServiceTier,
} from '../model-thinking.js';
import { isRelayProviderType } from '../llm-connections.js';

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

test('relay profiles preserve the fast service tier declaration', () => {
  assert.deepEqual(normalizeRelayModelProfiles({ m: { serviceTier: 'fast' } }), {
    m: { serviceTier: 'fast' },
  });
  assert.deepEqual(normalizeRelayModelProfiles({ m: { serviceTier: 'unknown' } }), undefined);
});

test('Fast visibility mirrors the pinned OpenAI SDK priority-processing families', () => {
  const cases = [
    ['gpt-4o', true],
    ['gpt-4.1', true],
    ['gpt-5', true],
    ['gpt-5.1', true],
    ['gpt-5-nano', false],
    ['gpt-5-chat-latest', false],
    ['o3-mini', true],
    ['o4-mini', true],
    ['plain-relay-id', false],
  ] as const;
  for (const [modelId, expected] of cases) {
    assert.equal(supportsRelayFastServiceTier('openai-responses-compatible', modelId), expected);
    assert.equal(supportsRelayFastServiceTier('openai-compatible', modelId), false);
  }
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

test('relayModelProfile honours a declaration on any provider', () => {
  const profiles = { m: { vision: true, contextWindow: 64_000 } };
  // A declaration is a user statement about one model, and the reason to make
  // one — Maka has no other way to learn the fact — is not confined to relays:
  // it holds for any model newer than the bundled snapshot, and for every
  // model on a provider with no model-list endpoint (#1584).
  for (const providerType of [
    'openai-compatible',
    'openai-responses-compatible',
    'anthropic',
    'volcengine-agent-plan',
  ] as const) {
    assert.deepEqual(relayModelProfile({ providerType, relayModelProfiles: profiles }, 'm'), {
      vision: true,
      contextWindow: 64_000,
    });
  }
  // Absent stays absent: an undeclared model falls through to the metadata chain.
  assert.equal(
    relayModelProfile({ providerType: 'anthropic', relayModelProfiles: profiles }, 'other'),
    undefined,
  );
});

test('isRelayProviderType only accepts the two custom OpenAI relay providers', () => {
  assert.equal(isRelayProviderType('openai-compatible'), true);
  assert.equal(isRelayProviderType('openai-responses-compatible'), true);
  assert.equal(isRelayProviderType('openai'), false);
  assert.equal(isRelayProviderType('anthropic'), false);
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

test('Alibaba Token Plan exposes the formal Qwen3.8 effort and disable contract', () => {
  for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
    assert.deepEqual(
      [...thinkingVariantsForModel(providerType, 'qwen3.8-max')],
      ['off', 'low', 'medium', 'xhigh'],
      providerType,
    );
    assert.equal(resolveThinkingLevel({ providerType }, 'qwen3.8-max', 'off'), 'off', providerType);
  }
});

// Reasoning replay has no toggle: DeepSeek-like relays require
// reasoning_content in tool-call history (400 otherwise), and other relays
// ignore it, so the runtime replays unconditionally. That contract is
// enforced per provider by the runtime provider-contract matrix, not here.
