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
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { thinkingVariantsForModel, type ThinkingLevel } from '@maka/core/model-thinking';

import { buildProviderOptions, getAIModel } from '../model-factory.js';

function conn(providerType: LlmConnection['providerType'], slug = 'test'): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('buildProviderOptions: thinking level', () => {
  test('Anthropic-compatible providers do not inherit automatic prompt caching', () => {
    for (const providerType of ['MiniMax', 'MiniMax-cn', 'kimi-coding-plan'] as const) {
      const anthropic = buildProviderOptions(conn(providerType), 'claude-opus-4-8').anthropic;
      assert.equal(
        (anthropic as { cacheControl?: unknown } | undefined)?.cacheControl,
        undefined,
        `${providerType} must not inherit Anthropic automatic prompt caching`,
      );
    }
  });

  test('anthropic effort model (opus-4-8) sends effort field directly; no budgetTokens mapping', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'high'), {
      anthropic: { cacheControl: { type: 'ephemeral' }, effort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'max'), {
      anthropic: { cacheControl: { type: 'ephemeral' }, effort: 'max' },
    });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'xhigh'), {
      anthropic: { cacheControl: { type: 'ephemeral' }, effort: 'xhigh' },
    });
  });

  test('anthropic budget/toggle model (haiku-4-5) sends thinking.disabled for off; drops unsupported effort', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-haiku-4-5', 'off'), {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
        thinking: { type: 'disabled' },
      },
    });
    // haiku-4-5 has no effort variants, only off → high is dropped
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-haiku-4-5', 'high'), {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  test('anthropic effort model without toggle (opus-4-8) drops off (cannot disable)', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8', 'off'), {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  test('Kimi K3 passes the chosen effort through adaptive thinking, defaulting to max', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('kimi-coding-plan', 'k3')],
      ['low', 'high', 'max'],
    );
    const expected = { anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } };
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3'), expected);
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3', 'max'), expected);
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3', 'low'), {
      anthropic: { thinking: { type: 'adaptive' }, effort: 'low' },
    });
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3', 'high'), {
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    // k3-256k shares the K3 family wire.
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3-256k', 'high'), {
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
  });

  test('Kimi K3 sends the chosen reasoning effort through the selected OpenAI-compatible namespace', () => {
    const connection = {
      ...conn('kimi-coding-plan'),
      models: [{ id: 'k3', apiProtocol: 'openai-chat' as const }],
    };
    const expected = { kimiCodingPlan: { reasoningEffort: 'max' } };
    assert.deepEqual(buildProviderOptions(connection, 'k3'), expected);
    assert.deepEqual(buildProviderOptions(connection, 'k3', 'max'), expected);
    assert.deepEqual(buildProviderOptions(connection, 'k3', 'low'), {
      kimiCodingPlan: { reasoningEffort: 'low' },
    });
    assert.deepEqual(buildProviderOptions(connection, 'k3', 'high'), {
      kimiCodingPlan: { reasoningEffort: 'high' },
    });
    // Kimi has no off wire: an explicit off request is rejected (empty
    // options), never silently upgraded to max. Unsupported levels other
    // than off keep the global default-max semantics.
    assert.deepEqual(buildProviderOptions(connection, 'k3', 'off'), {});
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3', 'off'), {});
  });

  test('openai gpt-5.5 sends reasoningEffort (none for off, max for max); gpt-4o drops level', () => {
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-4o', 'high'), {
      openai: { store: false },
    });
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-5.5', 'medium'), {
      openai: { store: false, reasoningEffort: 'medium' },
    });
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-5.5', 'xhigh'), {
      openai: { store: false, reasoningEffort: 'xhigh' },
    });
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-5.5', 'off'), {
      openai: { store: false, reasoningEffort: 'none' },
    });
  });

  test('openai-codex (gpt-5.5) preserves store:false / textVerbosity and merges reasoningEffort', () => {
    assert.deepEqual(buildProviderOptions(conn('openai-codex'), 'gpt-5.5'), {
      openai: { store: false, textVerbosity: 'medium' },
    });
    assert.deepEqual(buildProviderOptions(conn('openai-codex'), 'gpt-5.5', 'high'), {
      openai: { store: false, textVerbosity: 'medium', reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('openai-codex'), 'gpt-5.5', 'off'), {
      openai: { store: false, textVerbosity: 'medium', reasoningEffort: 'none' },
    });
  });

  test('google effort model (gemini-3) sends thinkingLevel; Gemini 2.5 Flash off sends thinkingBudget 0; safetySettings always present', () => {
    const g3 = buildProviderOptions(conn('google'), 'gemini-3.1-pro-preview', 'high');
    assert.equal(
      (g3.google as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel,
      'high',
    );
    assert.ok((g3.google as { safetySettings: unknown[] }).safetySettings.length > 0);
    // off not in gemini-3.1-pro-preview variants (only low/medium/high) → dropped → no
    // thinkingConfig
    const g3off = buildProviderOptions(conn('google'), 'gemini-3.1-pro-preview', 'off');
    assert.equal((g3off.google as { thinkingConfig?: unknown }).thinkingConfig, undefined);
    // gemini-2.5-flash is toggle-only (off); off is the Google budget-zero wire.
    const g25 = buildProviderOptions(conn('google'), 'gemini-2.5-flash', 'off');
    assert.deepEqual((g25.google as { thinkingConfig?: unknown }).thinkingConfig, {
      thinkingBudget: 0,
    });
    assert.ok((g25.google as { safetySettings: unknown[] }).safetySettings.length > 0);
  });

  test('openai-compatible sends reasoningEffort for effort levels and does not expose no-op off', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('deepinfra', 'moonshotai/Kimi-K2.7-Code')],
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('deepinfra'), 'moonshotai/Kimi-K2.7-Code', 'high'), {
      deepinfra: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('deepinfra'), 'moonshotai/Kimi-K2.7-Code', 'off'), {
      deepinfra: { reasoningEffort: 'none' },
    });
    // Groq reasoning_effort: the gpt-oss family declares low/medium/high (no
    // `none`), so an off choice never reaches the wire. qwen3-32b is pinned to
    // no knob (Groq docs list reasoning_effort only for the gpt-oss family and
    // qwen3.6-27b; models.dev's ['none','default'] is qwen3.6's set misapplied).
    assert.deepEqual(
      [...thinkingVariantsForModel('groq', 'openai/gpt-oss-120b')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('groq'), 'openai/gpt-oss-120b', 'high'), {
      groq: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('groq'), 'openai/gpt-oss-120b', 'off'), {});
    assert.deepEqual([...thinkingVariantsForModel('groq', 'qwen/qwen3-32b')], []);
    assert.deepEqual(buildProviderOptions(conn('groq'), 'qwen/qwen3-32b', 'off'), {});
    // gpt-oss-safeguard-20b declares the same low/medium/high effort set as
    // the rest of the Groq gpt-oss family in the current snapshot.
    assert.deepEqual(
      [...thinkingVariantsForModel('groq', 'openai/gpt-oss-safeguard-20b')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual([...thinkingVariantsForModel('groq', 'llama-3.3-70b-versatile')], []);
    // OpenRouter accepts the same `reasoning_effort` shorthand (none disables).
    assert.deepEqual(
      [...thinkingVariantsForModel('openrouter', 'openai/gpt-5.6-sol')],
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.deepEqual(buildProviderOptions(conn('openrouter'), 'openai/gpt-5.6-sol', 'high'), {
      openrouter: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('openrouter'), 'openai/gpt-5.6-sol', 'off'), {
      openrouter: { reasoningEffort: 'none' },
    });
    // claude-sonnet-5 exposes no off switch (no `none` effort); only effort tiers.
    assert.deepEqual(
      [...thinkingVariantsForModel('openrouter', 'anthropic/claude-sonnet-5')],
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.deepEqual(
      [...thinkingVariantsForModel('deepseek', 'deepseek-v4-flash')],
      ['high', 'max'],
    );
    // DeepSeek V4 uses the generic Open Responses adapter, which passes a
    // provider-native reasoningEffort through verbatim: `max` stays `max`
    // (DeepSeek's documented mapping sends `xhigh` to high, not max).
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'high'), {
      deepseek: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'max'), {
      deepseek: { reasoningEffort: 'max' },
    });
    for (const unsupported of ['off', 'low', 'medium', 'minimal'] as const) {
      assert.deepEqual(
        buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', unsupported),
        {},
      );
    }
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-5.1')], []);
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-4.5-air')], []);
    // miss model (deepseek-chat non-reasoning) drops level
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-chat', 'high'), {});
  });

  test('Alibaba Token Plan sends the formal Qwen3.8 effort and disable wires', () => {
    for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
      assert.deepEqual(
        Object.values(buildProviderOptions(conn(providerType), 'qwen3.8-max', 'xhigh')),
        [{ reasoningEffort: 'xhigh' }],
        providerType,
      );
      assert.deepEqual(
        Object.values(buildProviderOptions(conn(providerType), 'qwen3.8-max', 'medium')),
        [{ reasoningEffort: 'medium' }],
        providerType,
      );
      assert.deepEqual(
        Object.values(buildProviderOptions(conn(providerType), 'qwen3.8-max', 'off')),
        [{ reasoningEffort: 'none' }],
        providerType,
      );
    }
  });

  test('family fallback wires per-model override adapters under their SDK namespaces', () => {
    // opencode serves models across several protocols via models.dev package
    // overrides; the family fallback must emit the namespace each SDK consumes.
    // gpt-5.5 resolves to the Responses wire, so it takes the wire branch and
    // its encrypted-reasoning terms rather than a bare effort.
    assert.deepEqual(buildProviderOptions(conn('opencode'), 'gpt-5.5', 'high'), {
      openai: { store: false, forceReasoning: true, reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('opencode'), 'claude-fable-5', 'high'), {
      anthropic: { effort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('opencode'), 'gemini-3.5-flash', 'high'), {
      google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
    });
    // Plain OpenAI-compatible access paths use the provider-type namespace.
    assert.deepEqual(buildProviderOptions(conn('zenmux'), 'deepseek/deepseek-v4-flash', 'high'), {
      zenmux: { reasoningEffort: 'high' },
    });
    // Copilot defaults to its OpenAI-compatible chat wire without a protocol hint.
    assert.deepEqual(buildProviderOptions(conn('github-copilot'), 'gpt-5.4', 'high'), {
      githubCopilot: { reasoningEffort: 'high' },
    });
  });

  test('github-copilot routes thinking by the account-declared model protocol', () => {
    const anthropic = {
      ...conn('github-copilot'),
      models: [{ id: 'claude-opus-4.8', apiProtocol: 'anthropic-messages' as const }],
    };
    assert.deepEqual(buildProviderOptions(anthropic, 'claude-opus-4.8', 'high'), {
      anthropic: { effort: 'high' },
    });
    const responses = {
      ...conn('github-copilot'),
      models: [{ id: 'gpt-5.5', apiProtocol: 'openai-responses' as const }],
    };
    // The Responses protocol takes the shared wire branch, so Copilot asks for
    // encrypted reasoning on the same terms every other Responses model does.
    assert.deepEqual(buildProviderOptions(responses, 'gpt-5.5', 'high'), {
      openai: { store: false, forceReasoning: true, reasoningEffort: 'high' },
    });
  });

  test('Cloudflare Workers AI sends Kimi K2.6 reasoning effort and its real thinking-off wire', () => {
    const modelId = '@cf/moonshotai/kimi-k2.6';
    assert.deepEqual(
      [...thinkingVariantsForModel('cloudflare-workers-ai', modelId)],
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('cloudflare-workers-ai'), modelId), {});
    assert.deepEqual(buildProviderOptions(conn('cloudflare-workers-ai'), modelId, 'high'), {
      cloudflareWorkersAi: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('cloudflare-workers-ai'), modelId, 'off'), {
      cloudflareWorkersAi: { chat_template_kwargs: { thinking: false } },
    });
  });

  test('StepFun Step Plan sends only officially supported reasoning effort levels', () => {
    assert.deepEqual(buildProviderOptions(conn('stepfun-step-plan'), 'step-3.7-flash', 'medium'), {
      stepfunStepPlan: { reasoningEffort: 'medium' },
    });
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-step-plan'), 'step-3.5-flash-2603', 'high'),
      { stepfunStepPlan: { reasoningEffort: 'high' } },
    );
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-step-plan'), 'step-3.5-flash-2603', 'medium'),
      {},
    );
    assert.deepEqual(buildProviderOptions(conn('stepfun-step-plan'), 'step-router-v1', 'high'), {});
    // step-router-v1 follows models.dev (no reasoning_options): no effort
    // levels at all. Locks the intent so a future upstream flip to
    // reasoning=true without options surfaces here instead of silently
    // changing the UI.
    assert.deepEqual([...thinkingVariantsForModel('stepfun-step-plan', 'step-router-v1')], []);
  });

  test('Volcengine Ark sends its official thinking object and optional reasoning effort', () => {
    const modelId = 'doubao-seed-2-0-pro-260215';
    assert.deepEqual(
      [...thinkingVariantsForModel('volcengine-ark', modelId)],
      ['off', 'minimal', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('volcengine-ark'), modelId), {
      volcengineArk: { thinking: { type: 'enabled' } },
    });
    assert.deepEqual(buildProviderOptions(conn('volcengine-ark'), modelId, 'high'), {
      volcengineArk: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('volcengine-ark'), modelId, 'off'), {
      volcengineArk: { thinking: { type: 'disabled' } },
    });
  });

  test('Cohere sends its native disabled thinking object without inventing effort levels', () => {
    const modelId = 'command-a-plus-05-2026';
    assert.deepEqual([...thinkingVariantsForModel('cohere', modelId)], ['off']);
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId), {});
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId, 'off'), {
      cohere: { thinking: { type: 'disabled' } },
    });
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId, 'high'), {});
  });

  test('Cohere north-mini serves the OpenAI-compatible compat wire declared by models.dev', () => {
    // north-mini-code-1-0 carries a models.dev package override to the
    // OpenAI-compatible endpoint, so its wire is the compat reasoning_effort
    // shape, not the native Cohere thinking object.
    const modelId = 'north-mini-code-1-0';
    assert.deepEqual([...thinkingVariantsForModel('cohere', modelId)], ['off', 'high']);
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId, 'high'), {
      cohere: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId, 'off'), {
      cohere: { reasoningEffort: 'none' },
    });
  });

  test('Tencent Token Plan sends its documented reasoning effort under the stable provider namespace', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('tencent-token-plan', 'hy3')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('tencent-token-plan'), 'hy3', 'high'), {
      tencentTokenPlan: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('tencent-token-plan'), 'hy3', 'off'), {});
  });

  test('Vercel Gateway sends reasoning effort under its stable namespace and exact model id', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('vercel', 'openai/gpt-5.1-thinking')],
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('vercel'), 'openai/gpt-5.1-thinking', 'high'), {
      vercel: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('vercel'), 'openai/gpt-5.1-thinking', 'off'), {
      vercel: { reasoningEffort: 'none' },
    });
    assert.deepEqual(buildProviderOptions(conn('vercel'), 'gpt-5.1-thinking', 'high'), {});
  });

  test('Ollama Cloud sends reasoning effort under its namespace; standard models expose off, GPT-OSS does not', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('ollama-cloud', 'glm-5.2')],
      ['off', 'low', 'medium', 'high', 'max'],
    );
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'glm-5.2', 'high'), {
      ollamaCloud: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'glm-5.2', 'off'), {
      ollamaCloud: { reasoningEffort: 'none' },
    });
    assert.deepEqual(
      [...thinkingVariantsForModel('ollama-cloud', 'gpt-oss:120b')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'gpt-oss:120b', 'high'), {
      ollamaCloud: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'gpt-oss:120b', 'off'), {});
  });

  test('a level the model does not support is dropped (defensive)', () => {
    assert.deepEqual(buildProviderOptions(conn('openai'), 'gpt-4o', 'high'), {
      openai: { store: false },
    });
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-haiku-4-5', 'max'), {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });
});

describe('getAIModel: models.dev registry providers', () => {
  test('routes the existing Kimi provider through its explicitly selected protocol', () => {
    const anthropic = getAIModel({
      connection: conn('kimi-coding-plan'),
      apiKey: 'test-key',
      modelId: 'k3',
    });
    const openai = getAIModel({
      connection: {
        ...conn('kimi-coding-plan'),
        models: [{ id: 'k3', apiProtocol: 'openai-chat' }],
      },
      apiKey: 'test-key',
      modelId: 'k3',
    });

    assert.equal(anthropic.provider, 'anthropic.messages');
    assert.equal(openai.provider, 'kimi-coding-plan.chat');
    assert.throws(
      () =>
        getAIModel({
          connection: {
            ...conn('kimi-coding-plan'),
            models: [{ id: 'k3', apiProtocol: 'openai-responses' }],
          },
          apiKey: 'test-key',
          modelId: 'k3',
        }),
      /Kimi Coding Plan.*openai-chat.*anthropic-messages/,
    );
  });

  test('routes OpenCode Zen and Go models through their registry-owned protocol overrides', () => {
    const cases = [
      ['opencode', 'gpt-5.5', 'openai.responses'],
      ['opencode', 'claude-opus-4-8', 'anthropic.messages'],
      ['opencode', 'gemini-3.5-flash', 'google.generative-ai'],
      ['opencode-go', 'kimi-k2.7-code', 'opencode-go.chat'],
      ['opencode-go', 'minimax-m3', 'anthropic.messages'],
    ] as const;

    for (const [providerType, modelId, expectedProvider] of cases) {
      const model = getAIModel({ connection: conn(providerType), apiKey: 'test-key', modelId });
      assert.equal(model.provider, expectedProvider, `${providerType}/${modelId}`);
      assert.equal(model.modelId, modelId);
    }
  });

  test('routes each exact GitHub Copilot model through its account-advertised wire', () => {
    for (const [modelId, apiProtocol, expectedProvider] of [
      ['gpt-5.4', 'openai-responses', 'openai.responses'],
      ['claude-sonnet-4.6', 'anthropic-messages', 'anthropic.messages'],
      ['gemini-3.1-pro-preview', 'openai-chat', 'github-copilot.chat'],
    ] as const) {
      const model = getAIModel({
        connection: {
          ...conn('github-copilot'),
          models: [{ id: modelId, apiProtocol }],
        },
        apiKey: 'github-account-token',
        modelId,
        fetch: async () => Response.json({}),
      });

      assert.equal(model.provider, expectedProvider);
      assert.equal(model.modelId, modelId);
    }
  });
});

describe('buildProviderOptions: openai-compatible namespace', () => {
  test('zai-coding-plan emits reasoningEffort under the camelCase namespace', () => {
    assert.deepEqual(
      buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-5.2', 'high'),
      { zaiCodingPlan: { reasoningEffort: 'high' } },
    );
    assert.deepEqual(
      buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-5.2', 'max'),
      { zaiCodingPlan: { reasoningEffort: 'max' } },
    );
  });
  test('deepseek wires provider-native effort on both chat and Responses dialects', () => {
    const chatConnection: LlmConnection = {
      ...conn('deepseek', 'deepseek'),
      models: [{ id: 'deepseek-v4-pro', apiProtocol: 'openai-chat' }],
    };
    assert.deepEqual(buildProviderOptions(chatConnection, 'deepseek-v4-pro', 'high'), {
      deepseek: { reasoningEffort: 'high' },
    });
    // The Responses wire keys the same effort under the raw provider name the
    // Open Responses SDK resolves (no camelCase alias on that package).
    assert.deepEqual(
      buildProviderOptions(conn('deepseek', 'deepseek'), 'deepseek-v4-flash', 'high'),
      {
        deepseek: { reasoningEffort: 'high' },
      },
    );
  });

  test('custom relay connections use per-model declared levels under the camelCase slug namespace', () => {
    const declared: LlmConnection = {
      ...conn('openai-compatible', 'my-relay'),
      baseUrl: 'https://relay.example/v1',
      relayModelProfiles: {
        'dsv4-flash': { thinkingLevels: ['minimal', 'low', 'medium', 'high', 'max'] },
      },
    };
    // Declared levels land under the provider-options key derived from the
    // connection slug. The SDK's canonical key for a dashed provider name is
    // its camelCase alias — using the raw form still works but returns a
    // `deprecated` warning on every call. ('off' cannot appear in a
    // declaration — see DECLARABLE_RELAY_THINKING_LEVELS — so no off→'none'
    // mapping for relays is asserted here.)
    assert.deepEqual(buildProviderOptions(declared, 'dsv4-flash', 'high'), {
      myRelay: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(declared, 'dsv4-flash', 'max'), {
      myRelay: { reasoningEffort: 'max' },
    });
    // Levels outside the declaration stay gated off, and undeclared
    // connections emit nothing (prior behaviour).
    assert.deepEqual(buildProviderOptions(declared, 'dsv4-flash', 'xhigh'), {});
    assert.deepEqual(
      buildProviderOptions(conn('openai-compatible', 'my-relay'), 'any-model', 'high'),
      {},
    );
  });

  test('custom Responses relays use per-model declared levels on the Responses wire', () => {
    const declared: LlmConnection = {
      ...conn('openai-responses-compatible', 'my-responses-relay'),
      baseUrl: 'https://relay.example/v1',
      models: [{ id: 'custom-reasoner', apiProtocol: 'openai-responses' }],
      relayModelProfiles: {
        'custom-reasoner': { thinkingLevels: ['minimal', 'low', 'medium', 'high', 'max'] },
      },
    };
    assert.deepEqual(buildProviderOptions(declared, 'custom-reasoner', 'high'), {
      openai: { store: false, forceReasoning: true, reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(declared, 'custom-reasoner', 'max'), {
      openai: { store: false, forceReasoning: true, reasoningEffort: 'max' },
    });
    assert.deepEqual(buildProviderOptions(declared, 'custom-reasoner', 'xhigh'), {
      openai: { store: false, forceReasoning: true },
    });
  });

  test('custom relays send the declared fast service tier independently of reasoning', () => {
    const chat: LlmConnection = {
      ...conn('openai-compatible', 'my-relay'),
      baseUrl: 'https://relay.example/v1',
      relayModelProfiles: { 'fast-model': { serviceTier: 'fast' } },
    };
    assert.deepEqual(buildProviderOptions(chat, 'fast-model'), {});
    const responses: LlmConnection = {
      ...conn('openai-responses-compatible', 'my-responses-relay'),
      baseUrl: 'https://relay.example/v1',
      models: [{ id: 'gpt-5-relay', apiProtocol: 'openai-responses' }],
      relayModelProfiles: { 'gpt-5-relay': { serviceTier: 'fast' } },
    };
    assert.deepEqual(buildProviderOptions(responses, 'gpt-5-relay'), {
      openai: { store: false, forceReasoning: true, serviceTier: 'fast' },
    });
    assert.deepEqual(
      buildProviderOptions(
        { ...conn('openai-compatible', 'my-relay'), baseUrl: 'https://relay.example/v1' },
        'fast-model',
      ),
      {},
    );
  });

  test('Fast provider options mirror the pinned OpenAI SDK model gate', () => {
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
    for (const [modelId, supported] of cases) {
      const connection: LlmConnection = {
        ...conn('openai-responses-compatible', 'my-responses-relay'),
        baseUrl: 'https://relay.example/v1',
        models: [{ id: modelId, apiProtocol: 'openai-responses' }],
        relayModelProfiles: { [modelId]: { serviceTier: 'fast' } },
      };
      assert.deepEqual(buildProviderOptions(connection, modelId), {
        openai: {
          store: false,
          forceReasoning: true,
          ...(supported ? { serviceTier: 'fast' } : {}),
        },
      });
    }
  });

  test('Fast reaches the Responses request body for an OpenAI-named relay model', async () => {
    const bodies: Record<string, unknown>[] = [];
    const modelConnection: LlmConnection = {
      ...conn('openai-responses-compatible', 'my-responses-relay'),
      baseUrl: 'https://relay.example/v1',
      models: [{ id: 'gpt-5-relay', apiProtocol: 'openai-responses' }],
      relayModelProfiles: { 'gpt-5-relay': { serviceTier: 'fast' } },
    };
    const model = getAIModel({
      connection: modelConnection,
      apiKey: 'relay-key',
      modelId: 'gpt-5-relay',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ id: 'resp-1', object: 'response', model: 'gpt-5-relay', output: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: buildProviderOptions(modelConnection, 'gpt-5-relay'),
    });
    assert.equal(bodies[0]?.service_tier, 'fast');
  });

  test('declared relay levels reach the actual chat-completions request body', async () => {
    // Intermediate providerOptions objects matching does not prove the wire
    // carries the effort — this capture asserts the SDK's camelCase slug key
    // is accepted AND translated into the body with zero deprecations.
    const bodies: Record<string, unknown>[] = [];
    const captureFetch: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'dsv4-flash',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const declared: LlmConnection = {
      ...conn('openai-compatible', 'my-relay'),
      baseUrl: 'https://relay.example/v1',
      relayModelProfiles: {
        'dsv4-flash': { thinkingLevels: ['minimal', 'low', 'medium', 'high', 'max'] },
      },
    };
    const model = getAIModel({
      connection: declared,
      apiKey: 'relay-key',
      modelId: 'dsv4-flash',
      fetch: captureFetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: buildProviderOptions(declared, 'dsv4-flash', 'high'),
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.reasoning_effort, 'high');
    // The raw dashed slug as a providerOptions key is deprecated by the SDK:
    // the camelCase alias must carry no such warning.
    assert.equal(
      (result.warnings ?? []).some((warning) => warning.type === 'deprecated'),
      false,
      JSON.stringify(result.warnings),
    );
  });

  test('built-in dashed provider effort reaches the chat request body without deprecation', async () => {
    // Built-in counterpart of the relay capture above: built-in dashed
    // providerTypes must emit the SDK's camelCase alias too.
    const bodies: Record<string, unknown>[] = [];
    const captureFetch: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'glm-5.2',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const connection = conn('zai-coding-plan', 'zai-coding-plan');
    const model = getAIModel({
      connection,
      apiKey: 'zai-key',
      modelId: 'glm-5.2',
      fetch: captureFetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: buildProviderOptions(connection, 'glm-5.2', 'high'),
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.reasoning_effort, 'high');
    assert.equal(
      (result.warnings ?? []).some((warning) => warning.type === 'deprecated'),
      false,
      JSON.stringify(result.warnings),
    );
    // The options key also selects the SDK's response metadata namespace:
    // metadata must come back under the camelCase alias, not the dashed name.
    assert.deepEqual(Object.keys(result.providerMetadata ?? {}), ['zaiCodingPlan']);
  });

  test('passthrough provider options reach the chat request body without deprecation', async () => {
    // reasoningEffort above travels the SDK's schema lane, which parses both
    // spellings. Volcengine Ark's `thinking` object is not in the schema and
    // travels the passthrough spread instead — pin that lane at the wire too.
    const bodies: Record<string, unknown>[] = [];
    const captureFetch: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'doubao-seed-2-0-pro-260215',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const connection = conn('volcengine-ark', 'volcengine-ark');
    const model = getAIModel({
      connection,
      apiKey: 'ark-key',
      modelId: 'doubao-seed-2-0-pro-260215',
      fetch: captureFetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: buildProviderOptions(connection, 'doubao-seed-2-0-pro-260215'),
    });
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0]?.thinking, { type: 'enabled' });
    assert.equal(
      (result.warnings ?? []).some((warning) => warning.type === 'deprecated'),
      false,
      JSON.stringify(result.warnings),
    );
  });
});
