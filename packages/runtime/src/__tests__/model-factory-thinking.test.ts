import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { thinkingVariantsForModel, type ThinkingLevel } from '@maka/core';
import { changesBackendConfig, buildProviderOptions, getAIModel } from '@maka/runtime';

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
  test('only native Anthropic enables automatic prompt caching', () => {
    assert.deepEqual(buildProviderOptions(conn('anthropic'), 'claude-opus-4-8'), {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
    for (const providerType of [
      'claude-subscription',
      'MiniMax',
      'MiniMax-cn',
      'kimi-coding-plan',
    ] as const) {
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

  test('Kimi K3 always sends its required adaptive thinking at max effort', () => {
    assert.deepEqual([...thinkingVariantsForModel('kimi-coding-plan', 'k3')], ['max']);
    const expected = { anthropic: { thinking: { type: 'adaptive' }, effort: 'max' } };
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3'), expected);
    assert.deepEqual(buildProviderOptions(conn('kimi-coding-plan'), 'k3', 'max'), expected);
  });

  test('Kimi K3 sends max reasoning effort through the selected OpenAI-compatible namespace', () => {
    const connection = {
      ...conn('kimi-coding-plan'),
      models: [{ id: 'k3', apiProtocol: 'openai-chat' as const }],
    };
    const expected = { kimiCodingPlan: { reasoningEffort: 'max' } };
    assert.deepEqual(buildProviderOptions(connection, 'k3'), expected);
    assert.deepEqual(buildProviderOptions(connection, 'k3', 'max'), expected);
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

  test('openai-codex gpt-5.6-sol sends xhigh reasoning effort', () => {
    assert.deepEqual(buildProviderOptions(conn('openai-codex'), 'gpt-5.6-sol', 'xhigh'), {
      openai: { store: false, textVerbosity: 'medium', reasoningEffort: 'xhigh' },
    });
  });

  test('google effort model (gemini-3) sends thinkingLevel; Gemini 2.5 Flash off sends thinkingBudget 0; safetySettings always present', () => {
    const g3 = buildProviderOptions(conn('google'), 'gemini-3-pro-preview', 'high');
    assert.equal(
      (g3.google as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel,
      'high',
    );
    assert.ok((g3.google as { safetySettings: unknown[] }).safetySettings.length > 0);
    // off not in gemini-3-pro-preview variants (only low/high) → dropped → no thinkingConfig
    const g3off = buildProviderOptions(conn('google'), 'gemini-3-pro-preview', 'off');
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
    // Groq reasoning_effort: only gpt-oss-120b / gpt-oss-20b accept it, with
    // low/medium/high (no `none`). qwen/qwen3-32b does not accept reasoning_effort.
    assert.deepEqual(
      [...thinkingVariantsForModel('groq', 'openai/gpt-oss-120b')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('groq'), 'openai/gpt-oss-120b', 'high'), {
      groq: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('groq'), 'openai/gpt-oss-120b', 'off'), {});
    assert.deepEqual([...thinkingVariantsForModel('groq', 'qwen/qwen3-32b')], []);
    assert.deepEqual([...thinkingVariantsForModel('groq', 'openai/gpt-oss-safeguard-20b')], []);
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
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'high'), {
      deepseek: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'max'), {
      deepseek: { reasoningEffort: 'max' },
    });
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-v4-flash', 'off'), {});
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-5.1')], []);
    assert.deepEqual([...thinkingVariantsForModel('zai-coding-plan', 'glm-4.5-air')], []);
    // miss model (deepseek-chat non-reasoning) drops level
    assert.deepEqual(buildProviderOptions(conn('deepseek'), 'deepseek-chat', 'high'), {});
  });

  test('xAI Grok 4.5 sends its declared reasoning effort under the xai namespace', () => {
    assert.deepEqual([...thinkingVariantsForModel('xai', 'grok-4.5')], ['low', 'medium', 'high']);
    assert.deepEqual(buildProviderOptions(conn('xai'), 'grok-4.5', 'high'), {
      xai: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('xai'), 'grok-4.5', 'off'), {});
  });

  test('Cloudflare Workers AI sends Kimi K2.6 reasoning effort and its real thinking-off wire', () => {
    const modelId = '@cf/moonshotai/kimi-k2.6';
    assert.deepEqual(
      [...thinkingVariantsForModel('cloudflare-workers-ai', modelId)],
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('cloudflare-workers-ai'), modelId), {});
    assert.deepEqual(buildProviderOptions(conn('cloudflare-workers-ai'), modelId, 'high'), {
      'cloudflare-workers-ai': { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('cloudflare-workers-ai'), modelId, 'off'), {
      'cloudflare-workers-ai': { chat_template_kwargs: { thinking: false } },
    });
  });

  test('StepFun Step Plan sends only officially supported reasoning effort levels', () => {
    assert.deepEqual(buildProviderOptions(conn('stepfun-step-plan'), 'step-3.7-flash', 'medium'), {
      'stepfun-step-plan': { reasoningEffort: 'medium' },
    });
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-step-plan'), 'step-3.5-flash-2603', 'high'),
      { 'stepfun-step-plan': { reasoningEffort: 'high' } },
    );
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-step-plan'), 'step-3.5-flash-2603', 'medium'),
      {},
    );
    assert.deepEqual(buildProviderOptions(conn('stepfun-step-plan'), 'step-router-v1', 'high'), {});
  });

  test('StepFun Step Plan Global sends only officially supported reasoning effort levels', () => {
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-ai-step-plan'), 'step-3.7-flash', 'medium'),
      { 'stepfun-ai-step-plan': { reasoningEffort: 'medium' } },
    );
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-ai-step-plan'), 'step-3.5-flash-2603', 'low'),
      { 'stepfun-ai-step-plan': { reasoningEffort: 'low' } },
    );
    assert.deepEqual(
      buildProviderOptions(conn('stepfun-ai-step-plan'), 'step-3.5-flash', 'medium'),
      {},
    );
  });

  test('Volcengine Ark sends its official thinking object and optional reasoning effort', () => {
    const modelId = 'doubao-seed-2-0-pro-260215';
    assert.deepEqual(
      [...thinkingVariantsForModel('volcengine-ark', modelId)],
      ['off', 'minimal', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('volcengine-ark'), modelId), {
      'volcengine-ark': { thinking: { type: 'enabled' } },
    });
    assert.deepEqual(buildProviderOptions(conn('volcengine-ark'), modelId, 'high'), {
      'volcengine-ark': { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('volcengine-ark'), modelId, 'off'), {
      'volcengine-ark': { thinking: { type: 'disabled' } },
    });
  });

  test('Cohere sends its native disabled thinking object without inventing effort levels', () => {
    const modelId = 'command-a-plus-05-2026';
    assert.deepEqual([...thinkingVariantsForModel('cohere', modelId)], ['off']);
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId), { cohere: {} });
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId, 'off'), {
      cohere: { thinking: { type: 'disabled' } },
    });
    assert.deepEqual(buildProviderOptions(conn('cohere'), modelId, 'high'), { cohere: {} });
  });

  test('Tencent Token Plan sends its documented reasoning effort under the stable provider namespace', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('tencent-token-plan', 'hy3')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('tencent-token-plan'), 'hy3', 'high'), {
      'tencent-token-plan': { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('tencent-token-plan'), 'hy3', 'off'), {});
  });

  test('Vercel Gateway sends reasoning effort under its stable namespace and exact model id', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('vercel', 'xai/grok-4.3')],
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('vercel'), 'xai/grok-4.3', 'high'), {
      vercel: { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('vercel'), 'xai/grok-4.3', 'off'), {
      vercel: { reasoningEffort: 'none' },
    });
    assert.deepEqual(buildProviderOptions(conn('vercel'), 'grok-4.3', 'high'), {});
  });

  test('Ollama Cloud sends reasoning effort under its namespace; standard models expose off, GPT-OSS does not', () => {
    assert.deepEqual(
      [...thinkingVariantsForModel('ollama-cloud', 'glm-5.2')],
      ['off', 'low', 'medium', 'high', 'max'],
    );
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'glm-5.2', 'high'), {
      'ollama-cloud': { reasoningEffort: 'high' },
    });
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'glm-5.2', 'off'), {
      'ollama-cloud': { reasoningEffort: 'none' },
    });
    assert.deepEqual(
      [...thinkingVariantsForModel('ollama-cloud', 'gpt-oss:120b')],
      ['low', 'medium', 'high'],
    );
    assert.deepEqual(buildProviderOptions(conn('ollama-cloud'), 'gpt-oss:120b', 'high'), {
      'ollama-cloud': { reasoningEffort: 'high' },
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

  test('routes SiliconFlow through the shared OpenAI-compatible adapter without rewriting model ids', () => {
    const model = getAIModel({
      connection: conn('siliconflow'),
      apiKey: 'sf-test-key',
      modelId: 'moonshotai/Kimi-K2.6',
    });

    assert.equal(model.provider, 'siliconflow.chat');
    assert.equal(model.modelId, 'moonshotai/Kimi-K2.6');
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
  test('zai-coding-plan emits reasoningEffort under the raw dashed namespace', () => {
    assert.deepEqual(
      buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-5.2', 'high'),
      { 'zai-coding-plan': { reasoningEffort: 'high' } },
    );
    assert.deepEqual(
      buildProviderOptions(conn('zai-coding-plan', 'zai-coding-plan'), 'glm-5.2', 'max'),
      { 'zai-coding-plan': { reasoningEffort: 'max' } },
    );
  });
  test('deepseek uses its own raw namespace', () => {
    assert.deepEqual(
      buildProviderOptions(conn('deepseek', 'deepseek'), 'deepseek-v4-flash', 'high'),
      { deepseek: { reasoningEffort: 'high' } },
    );
  });
});

describe('buildProviderOptions: resolver/options drift guard', () => {
  // Every displayed level must map to a real providerOptions fragment. For
  // `off`, that fragment must be an actual disabled/none/budget-zero wire, not
  // an empty object that only means "no override".
  const cases: Array<{
    providerType: LlmConnection['providerType'];
    model: string;
    slug?: string;
  }> = [
    { providerType: 'anthropic', model: 'claude-opus-4-8' },
    { providerType: 'anthropic', model: 'claude-haiku-4-5' },
    { providerType: 'claude-subscription', model: 'claude-opus-4-8' },
    { providerType: 'openai', model: 'gpt-5.5' },
    { providerType: 'openai', model: 'gpt-5' },
    { providerType: 'openai-codex', model: 'gpt-5.5' },
    { providerType: 'google', model: 'gemini-3-pro-preview' },
    { providerType: 'google', model: 'gemini-3.5-flash' },
    { providerType: 'deepseek', model: 'deepseek-v4-flash' },
    { providerType: 'xai', model: 'grok-4.5' },
    { providerType: 'deepinfra', model: 'moonshotai/Kimi-K2.7-Code' },
    { providerType: 'groq', model: 'openai/gpt-oss-120b' },
    { providerType: 'openrouter', model: 'openai/gpt-5.6-sol' },
    { providerType: 'vercel', model: 'xai/grok-4.3' },
    { providerType: 'ollama-cloud', model: 'glm-5.2' },
    { providerType: 'ollama-cloud', model: 'gpt-oss:120b' },
    { providerType: 'cloudflare-workers-ai', model: '@cf/moonshotai/kimi-k2.6' },
    { providerType: 'zai-coding-plan', model: 'glm-5.2', slug: 'zai-coding-plan' },
    { providerType: 'volcengine-ark', model: 'doubao-seed-2-0-pro-260215' },
    { providerType: 'cohere', model: 'command-a-plus-05-2026' },
  ];
  for (const { providerType, model, slug } of cases) {
    test(`every effort level for ${providerType}/${model} maps to a non-empty fragment`, () => {
      const connection = conn(providerType, slug ?? providerType);
      for (const level of thinkingVariantsForModel(providerType, model)) {
        const opts = buildProviderOptions(connection, model, level as ThinkingLevel);
        const nonEmpty = Object.keys(opts).some((k) => {
          const v = (opts as Record<string, unknown>)[k];
          return v !== null && typeof v === 'object' && Object.keys(v as object).length > 0;
        });
        assert.equal(nonEmpty, true, `${providerType}/${model} level=${level} produced no options`);
        if (level === 'off')
          assert.equal(
            hasRealOffWire(opts),
            true,
            `${providerType}/${model} exposed off without a real disabled wire`,
          );
      }
    });
  }

  test('models without a real off wire do not expose off', () => {
    assert.equal(thinkingVariantsForModel('deepseek', 'deepseek-v4-flash').includes('off'), false);
    assert.equal(thinkingVariantsForModel('zai-coding-plan', 'glm-5.1').includes('off'), false);
    assert.equal(thinkingVariantsForModel('zai-coding-plan', 'glm-4.5-air').includes('off'), false);
  });

  function hasRealOffWire(opts: Record<string, unknown>): boolean {
    const serialized = JSON.stringify(opts);
    return (
      serialized.includes('"reasoningEffort":"none"') ||
      serialized.includes('"type":"disabled"') ||
      serialized.includes('"thinkingBudget":0') ||
      serialized.includes('"thinking":false')
    );
  }
});

describe('changesBackendConfig', () => {
  test('thinkingLevel change triggers backend reconfiguration', () => {
    assert.equal(changesBackendConfig({ thinkingLevel: 'high' }), true);
    assert.equal(changesBackendConfig({ thinkingLevel: undefined }), true);
  });

  test('unrelated patches do not', () => {
    assert.equal(changesBackendConfig({ name: 'x' }), false);
    assert.equal(changesBackendConfig({}), false);
  });

  test('backend / llmConnectionSlug / model still trigger', () => {
    assert.equal(changesBackendConfig({ backend: 'ai-sdk' }), true);
    assert.equal(changesBackendConfig({ llmConnectionSlug: 'a' }), true);
    assert.equal(changesBackendConfig({ model: 'm' }), true);
  });
});
