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

test('a live inventory annotates a model it omits and preserves higher-priority failures', () => {
  const input = {
    providerType: 'zai-coding-plan' as const,
    defaultModel: 'removed',
    models: [{ id: 'glm-4.7' }],
    modelSource: 'fetched' as const,
  };
  const [missing] = buildModelCatalogEntries(input);
  // Worth saying, not worth blocking: the provider did not mention this model
  // in its last response, which is a fact about that response and not about
  // what the account can run (#1584). It stays selectable and the provider
  // gets to answer for itself.
  assert.equal(missing?.availability, 'warning');
  assert.equal(missing?.canUseAsChatDefault, true);
  assert.equal(missing?.unavailableReason, 'not_in_live_list');
  assert.deepEqual(verdict(input), { ok: true });

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

test('a declared output modality without text rules a model out of chat', () => {
  // The shape this exists for: `gpt-image-2` on a relay. Bundled metadata
  // records `modalities.output: ["image"]` and has never set
  // `capabilities.imageGeneration` for any model, so before this the guard
  // could not fire and an image model was selectable as a chat model.
  const imageOnly = {
    providerType: 'openai' as const,
    defaultModel: 'gpt-image-2',
    models: [{ id: 'gpt-image-2' }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(imageOnly), { ok: false, reason: 'unsupported_for_chat' });

  // Audio-only too, and a stray `reasoning: true` on a TTS model does not
  // rescue it: reasoning describes how it composes speech, not that it can
  // answer in text.
  const audioOnly = {
    providerType: 'google' as const,
    defaultModel: 'gemini-3.1-flash-tts-preview',
    models: [{ id: 'gemini-3.1-flash-tts-preview' }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(audioOnly), { ok: false, reason: 'unsupported_for_chat' });
});

test('an empty output modality list is not evidence against chat', () => {
  // `modalities.output` is typed to text, image, and audio, so a video model's
  // real output has no representation and serializes as `[]` — the same shape
  // a generator bug would produce. Blocking on it would be guessing.
  const video = {
    providerType: 'google' as const,
    defaultModel: 'gemini-omni-flash-preview',
    models: [{ id: 'gemini-omni-flash-preview' }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(video), { ok: true });
});

test('an explicit chat capability outranks the declared output modality', () => {
  // A provider that says both is contradicting itself, and the direct claim
  // about chat is the more specific one.
  const contradictory = {
    providerType: 'openai-compatible' as const,
    defaultModel: 'relay-omni',
    models: [
      {
        id: 'relay-omni',
        capabilities: { chat: true },
        modalities: { input: ['text' as const], output: ['image' as const] },
      },
    ],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(contradictory), { ok: true });
});

test('catalog entries preserve advertised parallel tool-call support', () => {
  const [entry] = buildModelCatalogEntries({
    providerType: 'openai-compatible',
    defaultModel: 'relay-model',
    models: [
      {
        id: 'relay-model',
        capabilities: { functionCalling: true, parallelToolCalls: true },
      },
    ],
    modelSource: 'fetched',
  });
  assert.deepEqual(entry?.capabilities, {
    functionCalling: true,
    parallelToolCalls: true,
  });
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

test('the catalog and the readiness gate agree that no catalog is a veto', () => {
  // The picker must not offer a model the send gate refuses, nor hide one it
  // would accept. Since neither gate refuses on catalog membership any more,
  // agreement means both admit and only the annotation differs.
  const readiness = (modelSource: 'fetched' | 'fallback') =>
    isConnectionReady({
      connection: {
        slug: 'relay',
        name: 'Relay',
        providerType: 'openai-compatible',
        defaultModel: 'custom-default',
        enabled: true,
        models: [{ id: 'relay-static-model' }],
        modelSource,
        createdAt: 1,
        updatedAt: 1,
      },
      hasSecret: true,
    });
  const catalog = (modelSource: 'fetched' | 'fallback') => ({
    providerType: 'openai-compatible' as const,
    defaultModel: 'custom-default',
    models: [{ id: 'relay-static-model' }],
    modelSource,
  });

  // Neither gate blocks, whatever the catalog is: the selection is the
  // authorization and no observation overrules it (#1584).
  for (const modelSource of ['fetched', 'fallback'] as const) {
    assert.equal(buildModelCatalogEntries(catalog(modelSource))[0]?.canUseAsChatDefault, true);
    assert.deepEqual(verdict(catalog(modelSource)), { ok: true }, modelSource);
    assert.deepEqual(readiness(modelSource), { ready: true, model: 'custom-default' }, modelSource);
  }
  // They still differ on what they SAY: a live list that omits the model has
  // something to report, a shipped snapshot has nothing.
  assert.equal(
    buildModelCatalogEntries(catalog('fetched'))[0]?.unavailableReason,
    'not_in_live_list',
  );
  assert.equal(buildModelCatalogEntries(catalog('fallback'))[0]?.unavailableReason, 'none');
});

test('failed or pending discovery keeps the static fallback catalog visible', () => {
  const entries = buildModelCatalogEntries({
    providerType: 'openai' as const,
    defaultModel: 'gpt-5.4',
    models: [],
    fallbackModels: ['gpt-5.4', 'gpt-5-mini'],
  });

  assert.deepEqual(
    entries.map(({ id, source, unavailableReason }) => [id, source, unavailableReason]),
    [
      ['gpt-5.4', 'static_catalog', 'none'],
      ['gpt-5-mini', 'static_catalog', 'none'],
    ],
  );
});

test('an explicitly fetched empty inventory remains authoritative', () => {
  const entries = buildModelCatalogEntries({
    providerType: 'openai' as const,
    defaultModel: 'gpt-5.4',
    models: [],
    modelSource: 'fetched',
    fallbackModels: ['gpt-5.4', 'gpt-5-mini'],
  });

  assert.deepEqual(
    entries.map(({ id, unavailableReason }) => [id, unavailableReason]),
    [['gpt-5.4', 'not_in_live_list']],
  );
});

test('a persisted empty discovery result preserves the connection fallback through the public catalog path', () => {
  const connection: LlmConnection = {
    slug: 'custom-relay',
    name: 'Custom relay',
    providerType: 'openai',
    defaultModel: 'gpt-5.4',
    enabled: true,
    models: [],
    createdAt: 1,
    updatedAt: 1,
  };

  const entries = buildConnectionModelCatalogEntries({
    connection,
    fallbackModels: ['gpt-5.4', 'gpt-5-mini'],
    providerAvailable: true,
    authOk: true,
  });

  assert.deepEqual(
    entries.map(({ id, unavailableReason, provenance }) => [
      id,
      unavailableReason,
      provenance.modelSource,
    ]),
    [
      ['gpt-5.4', 'none', 'fallback'],
      ['gpt-5-mini', 'none', 'fallback'],
    ],
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

  // All three are selectable; what differs is what the catalog knows about
  // them. The two the live response omitted carry `not_in_live_list` so the
  // picker can say so, but saying so is not refusing (#1584).
  assert.deepEqual(
    entries.map(({ id, source, canUseAsChatDefault, unavailableReason }) => [
      id,
      source,
      canUseAsChatDefault,
      unavailableReason,
    ]),
    [
      ['saved-default', 'unknown', true, 'not_in_live_list'],
      ['glm-4.7', 'provider_api', true, 'none'],
      ['session-model', 'unknown', true, 'not_in_live_list'],
    ],
  );
  assert.deepEqual(entries[0]?.provenance.sources?.userChoice, ['connection_default']);
  assert.deepEqual(entries[2]?.provenance.sources?.userChoice, ['session_model']);
});

test('every picker sees a model the user enabled but no catalog describes', () => {
  // The projection lives in the builder, not in one caller: chat, Daily Review
  // and the settings selectors all read it. `deepseek-v4-pro-beta` is enabled
  // but absent from the snapshot this build shipped, and the entry it gets is
  // selectable — that is the whole of #1584 seen from the picker side.
  const entries = buildConnectionModelCatalogEntries({
    connection: {
      slug: 'ark-plan',
      providerType: 'volcengine-agent-plan',
      defaultModel: 'doubao-seed-2.1-turbo',
      enabledModelIds: ['doubao-seed-2.1-turbo', 'deepseek-v4-pro-beta'],
      models: [{ id: 'doubao-seed-2.1-turbo' }],
      // `'fetched'` is the honest record here: a provider with no model-list
      // endpoint still runs discovery, it just replays the array this build
      // shipped. Provenance is not content, so the flag alone cannot say
      // whether a provider enumerated this account.
      modelSource: 'fetched',
    },
  });
  const declared = entries.find(({ id }) => id === 'deepseek-v4-pro-beta');
  assert.equal(declared?.canUseAsChatDefault, true);
  assert.equal(declared?.unavailableReason, 'none');
  assert.deepEqual(declared?.provenance.sources?.userChoice, ['saved_model']);
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

test('Alibaba (China) catalogs Qwen3.8 Max as the default model on the China endpoint', () => {
  const providerType = 'alibaba-cn';
  const defaults = PROVIDER_DEFAULTS[providerType];
  assert.equal(defaults.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(defaults.fallbackModels[0], 'qwen3.8-max');

  const entries = buildConnectionModelCatalogEntries({
    connection: {
      slug: providerType,
      providerType,
      defaultModel: 'qwen3.8-max',
      modelSource: 'fallback',
    },
  });
  const model = entries.find((entry) => entry.id === 'qwen3.8-max');
  assert.equal(model?.displayName, 'Qwen3.8 Max');
  assert.equal(model?.contextWindow, 1_000_000);
  assert.equal(model?.maxOutputTokens, 131_072);
  assert.equal(model?.structuredOutput, true);
  assert.deepEqual(model?.capabilities, { vision: true, reasoning: true, functionCalling: true });
  assert.deepEqual(model?.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] });
  assert.equal(model?.canUseAsChatDefault, true);
});

test('DeepSeek catalogs the V4 vision model display metadata from a bare provider id', () => {
  const modelId = 'deepseek-v4-flash-vision-exp';
  const [model] = buildConnectionModelCatalogEntries({
    connection: {
      slug: 'deepseek',
      providerType: 'deepseek',
      defaultModel: modelId,
      models: [{ id: modelId }],
      modelSource: 'fetched',
    },
  });

  assert.equal(model?.displayName, 'DeepSeek-V4-Flash-Vision-Exp');
  assert.equal(
    model?.description,
    'Experimental DeepSeek V4 Flash model for image understanding and multimodal agent tasks',
  );
  assert.equal(model?.docsUrl, 'https://api-docs.deepseek.com/guides/vision/');
  assert.equal(model?.contextWindow, 1_000_000);
  assert.equal(model?.maxOutputTokens, 384_000);
  assert.equal(model?.structuredOutput, true);
  assert.equal(model?.lastUpdated, '2026-08-21');
  assert.deepEqual(model?.capabilities, {
    reasoning: true,
    functionCalling: true,
    vision: true,
  });
  assert.deepEqual(model?.modalities, { input: ['text', 'image'], output: ['text'] });
  assert.equal(model?.canUseAsChatDefault, true);
});
