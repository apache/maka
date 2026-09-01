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
import { PROVIDER_REGISTRY, type LlmConnection, type ProviderType } from '../llm-connections.js';
import {
  type BuildModelCatalogInput,
  buildConnectionModelCatalogEntries,
  buildModelCatalogEntries,
  resolveConnectionModelCatalog,
} from '../model-catalog.js';
import {
  CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS,
  CONNECTION_CATALOG_MAX_ENTRIES_PER_CONNECTION,
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
} from '../runtime-policy.js';

/**
 * Whether a build's default model is one the chat can send to. The catalog
 * states this per entry; the tests below ask it of a whole build, so they
 * read the entry the build produced for the model the input names.
 */
function verdict(input: BuildModelCatalogInput) {
  const defaultModel = input.defaultModel?.trim();
  const entry = defaultModel
    ? buildModelCatalogEntries(input).find((candidate) => candidate.id === defaultModel)
    : undefined;
  return { ok: entry?.canUseAsChatDefault === true };
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
  assert.equal(missing?.canUseAsChatDefault, true);
  assert.deepEqual(verdict(input), { ok: true });

  // Retirement is the one provider-level veto left.
  assert.equal(
    buildModelCatalogEntries({ ...input, providerRetired: true })[0]?.canUseAsChatDefault,
    false,
  );
});

test('chat-default validation blocks image-only models but accepts merged partial facts', () => {
  const imageOnly = {
    providerType: 'openai' as const,
    defaultModel: 'gpt-image-1',
    models: [{ id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(imageOnly), { ok: false });

  const partial = {
    providerType: 'openai' as const,
    defaultModel: 'gpt-5.4',
    models: [{ id: 'gpt-5.4', capabilities: { imageGeneration: true } }],
    modelSource: 'fetched' as const,
  };
  const [entry] = buildModelCatalogEntries(partial);
  assert.equal(entry?.canUseAsChatDefault, true);
  assert.equal(entry?.supportsVision, true);
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
  assert.deepEqual(verdict(imageOnly), { ok: false });

  // Audio-only too, and a stray `reasoning: true` on a TTS model does not
  // rescue it: reasoning describes how it composes speech, not that it can
  // answer in text.
  const audioOnly = {
    providerType: 'google' as const,
    defaultModel: 'gemini-3.1-flash-tts-preview',
    models: [{ id: 'gemini-3.1-flash-tts-preview' }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(audioOnly), { ok: false });

  // Video-only says exactly what the other two say. It could not be read at
  // all until `modalities.output` could carry the value.
  const videoOnly = {
    providerType: 'google' as const,
    defaultModel: 'gemini-omni-flash-preview',
    models: [{ id: 'gemini-omni-flash-preview' }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(videoOnly), { ok: false });
});

test('an empty output modality list is not evidence against chat', () => {
  // A provider that declared no output modality and a generator bug that
  // dropped them produce the same shape. Blocking on it would be guessing.
  const undeclared = {
    providerType: 'openai-compatible' as const,
    defaultModel: 'relay-quiet',
    models: [{ id: 'relay-quiet', modalities: { input: ['text' as const], output: [] } }],
    modelSource: 'fetched' as const,
  };
  assert.deepEqual(verdict(undeclared), { ok: true });
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
});

test('failed or pending discovery keeps the static fallback catalog visible', () => {
  const entries = buildModelCatalogEntries({
    providerType: 'openai' as const,
    defaultModel: 'gpt-5.4',
    models: [],
    fallbackModels: ['gpt-5.4', 'gpt-5-mini'],
  });

  assert.deepEqual(
    entries.map(({ id, canUseAsChatDefault }) => [id, canUseAsChatDefault]),
    [
      ['gpt-5.4', true],
      ['gpt-5-mini', true],
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
    entries.map(({ id }) => id),
    ['gpt-5.4'],
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

  const entries = buildConnectionModelCatalogEntries({ connection });

  // The provider's own offerable list stands in for the empty stored one, and
  // every id in it is selectable — including the persisted default, which the
  // empty array would otherwise have left as the connection's only entry.
  assert.ok(entries.length > 1);
  assert.ok(entries.some(({ id }) => id === 'gpt-5.4'));
  assert.ok(entries.every(({ canUseAsChatDefault }) => canUseAsChatDefault));
});

test('connection catalogs list every model the user saved without inventing availability', () => {
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
    connection: { ...connection, enabledModelIds: ['session-model', 'glm-4.7', ' '] },
  });

  // All three are listed and all three are selectable: a live response that
  // omitted two of them has not refused them (#1584). The blank id is dropped.
  assert.deepEqual(
    entries.map(({ id, canUseAsChatDefault }) => [id, canUseAsChatDefault]),
    [
      ['saved-default', true],
      ['glm-4.7', true],
      ['session-model', true],
    ],
  );
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
});

test('catalog provenance follows the projected model facts marker used in production', () => {
  const [entry] = buildConnectionModelCatalogEntries({
    connection: {
      slug: 'facts',
      providerType: 'openai',
      defaultModel: 'custom-model',
      models: [
        {
          id: 'custom-model',
          contextWindow: 200_000,
          capabilities: { chat: true },
          factOverriddenFields: ['contextWindow', 'capabilities'],
        },
      ],
      modelSource: 'fetched',
    },
  });
  assert.equal(entry?.contextWindow, 200_000);
});

test('fallback provider catalogs include projected facts-backed models', () => {
  const entries = buildConnectionModelCatalogEntries({
    connection: {
      slug: 'opencode-free-facts',
      providerType: 'opencode-free',
      defaultModel: 'custom-free-model',
      models: [
        {
          id: 'custom-free-model',
          contextWindow: 128_000,
          factOverriddenFields: ['contextWindow', 'capabilities'],
        },
      ],
      modelSource: 'fallback',
    },
  });
  const entry = entries.find((candidate) => candidate.id === 'custom-free-model');
  assert.equal(entry?.contextWindow, 128_000);
});

test('fallback provider catalogs apply facts to known fallback models', () => {
  const entries = buildConnectionModelCatalogEntries({
    connection: {
      slug: 'opencode-free-known-facts',
      providerType: 'opencode-free',
      defaultModel: 'nemotron-3-ultra-free',
      models: [
        {
          id: 'nemotron-3-ultra-free',
          contextWindow: 200_000,
          inputLimit: 200_000,
          capabilities: { chat: true },
          factOverriddenFields: ['contextWindow', 'inputLimit', 'capabilities'],
        },
      ],
      modelSource: 'fallback',
    },
  });
  const entry = entries.find((candidate) => candidate.id === 'nemotron-3-ultra-free');
  assert.equal(entry?.contextWindow, 200_000);
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
    const defaults = PROVIDER_REGISTRY[providerType];
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
    assert.equal(model?.supportsVision, true, providerType);
    assert.equal(model?.canUseAsChatDefault, true, providerType);
  }
});

test('Alibaba (China) catalogs Qwen3.8 Max as the default model on the China endpoint', () => {
  const providerType = 'alibaba-cn';
  const defaults = PROVIDER_REGISTRY[providerType];
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
  assert.equal(model?.supportsVision, true);
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
  assert.equal(model?.contextWindow, 1_000_000);
  assert.equal(model?.supportsVision, true);
  assert.equal(model?.canUseAsChatDefault, true);
});

test('no provider resolves past the wire bound at the storage maxima', () => {
  // The storage decoder and the wire decoder bound different things — what a
  // connection may persist, and how many entries its resolved catalog may
  // carry — and the Host sits between them. A catalog that storage accepts
  // must therefore resolve to a page the wire accepts, or the Host's own
  // projection is rejected on arrival and every client is left with no models
  // to choose from. This is that boundary, at both maxima at once.
  const models = Array.from(
    { length: CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION },
    (_, index) => ({ id: `stored-model-${index}` }),
  );
  const enabledModelIds = Array.from(
    { length: CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS },
    (_, index) => `enabled-only-${index}`,
  );
  let largest = 0;
  for (const providerType of Object.keys(PROVIDER_REGISTRY) as ProviderType[]) {
    const entries = resolveConnectionModelCatalog({
      slug: 'boundary',
      providerType,
      // Listed by neither array, so it costs the catalog one more entry.
      defaultModel: 'default-the-inventory-never-listed',
      enabledModelIds,
      models,
      modelSource: 'fetched',
    });
    assert.ok(
      entries.length <= CONNECTION_CATALOG_MAX_ENTRIES_PER_CONNECTION,
      `${providerType} resolved ${entries.length} entries, over the bound of ${CONNECTION_CATALOG_MAX_ENTRIES_PER_CONNECTION}`,
    );
    largest = Math.max(largest, entries.length);
  }
  // And the bound is the real maximum, not a comfortable round number: one
  // that drifted above what any catalog can reach would stop reporting when
  // the projection grows underneath it.
  assert.equal(largest, CONNECTION_CATALOG_MAX_ENTRIES_PER_CONNECTION);
});
