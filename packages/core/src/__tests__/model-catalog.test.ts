import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildConnectionModelCatalogEntries,
  buildModelCatalogEntries,
  validateChatDefaultModel,
} from '../model-catalog.js';
import { isConnectionReady } from '../connection-readiness.js';
import type { LlmConnection, ModelInfo, ProviderType } from '../llm-connections.js';

describe('ModelCatalogEntry', () => {
  it('uses the official StepFun Step Plan snapshot without inventing live model discovery', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'stepfun-step-plan',
        providerType: 'stepfun-step-plan',
        defaultModel: 'step-3.7-flash',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash', 'step-router-v1'],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 256_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
    assert.equal(entries[3]?.displayName, 'Step Router V1');
    assert.deepEqual(entries[3]?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the official StepFun Step Plan Global snapshot without inventing live model discovery', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'stepfun-ai-step-plan',
        providerType: 'stepfun-ai-step-plan',
        defaultModel: 'step-3.7-flash',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash'],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 256_000);
    assert.equal(entries[0]?.maxOutputTokens, 256_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the official Alibaba Coding Plan snapshot for both regions without inventing live discovery', () => {
    const expectedIds = [
      'qwen3.7-plus',
      'qwen3.7-max',
      'qwen3.6-plus',
      'qwen3.6-flash',
      'qwen3.5-plus',
      'qwen3-max-2026-01-23',
      'qwen3-coder-next',
      'qwen3-coder-plus',
      'glm-5',
      'glm-4.7',
      'kimi-k2.5',
      'MiniMax-M2.5',
    ];
    for (const providerType of ['alibaba-coding-plan-cn', 'alibaba-coding-plan'] as const) {
      const entries = buildConnectionModelCatalogEntries({
        connection: { slug: providerType, providerType, defaultModel: 'qwen3.7-plus' },
      });

      assert.deepEqual(
        entries.map((entry) => entry.id),
        expectedIds,
      );
      assert.equal(entries[0]?.source, 'static_catalog');
      assert.equal(entries[0]?.provenance.modelSource, 'fallback');
      assert.equal(entries[0]?.contextWindow, 1_000_000);
      assert.equal(entries[0]?.maxOutputTokens, 64_000);
      assert.deepEqual(entries[0]?.capabilities, {
        vision: true,
        reasoning: true,
        functionCalling: true,
      });
    }
  });

  it('uses the official Alibaba Token Plan snapshot without inventing live model discovery', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'alibaba-token-plan-cn',
        providerType: 'alibaba-token-plan-cn',
        defaultModel: 'qwen3.7-max',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      [
        'qwen3.7-max',
        'qwen3.7-plus',
        'qwen3.6-plus',
        'qwen3.6-flash',
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'deepseek-v3.2',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'kimi-k2.5',
        'glm-5.2',
        'glm-5.1',
        'glm-5',
        'MiniMax-M2.5',
      ],
    );
    // The plan's image models (qwen-image / wan) are not tool-callable and are absent.
    for (const imageModel of [
      'qwen-image-2.0',
      'qwen-image-2.0-pro',
      'wan2.7-image',
      'wan2.7-image-pro',
    ]) {
      assert.ok(
        !entries.some((entry) => entry.id === imageModel),
        `${imageModel} must not be catalogued`,
      );
    }
    assert.equal(entries[0]?.displayName, 'Qwen3.7 Max');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 1_000_000);
    assert.equal(entries[0]?.maxOutputTokens, 65_536);
    assert.deepEqual(entries[0]?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
  });

  for (const providerType of [
    'xiaomi-token-plan-cn',
    'xiaomi-token-plan-sgp',
    'xiaomi-token-plan-ams',
  ] as const) {
    it(`uses the official ${providerType} snapshot without inventing live model discovery`, () => {
      const entries = buildConnectionModelCatalogEntries({
        connection: {
          slug: providerType,
          providerType,
          defaultModel: 'mimo-v2.5-pro',
        },
      });

      assert.deepEqual(
        entries.map((entry) => entry.id),
        ['mimo-v2.5-pro', 'mimo-v2.5'],
      );
      assert.equal(entries[0]?.source, 'static_catalog');
      assert.equal(entries[0]?.provenance.modelSource, 'fallback');
      assert.equal(entries[0]?.contextWindow, 1_048_576);
      assert.equal(entries[0]?.maxOutputTokens, 131_072);
      // mimo-v2.5-pro is text-only; mimo-v2.5 adds vision. Both reason and tool-call.
      assert.equal(entries[0]?.capabilities.vision, undefined);
      assert.equal(entries[0]?.capabilities.reasoning, true);
      assert.equal(entries[0]?.capabilities.functionCalling, true);
      assert.equal(entries[1]?.capabilities.vision, true);
      assert.equal(entries[1]?.capabilities.reasoning, true);
      assert.equal(entries[1]?.capabilities.functionCalling, true);
    });
  }

  it('uses the checked-in StepFun Global snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'stepfun-ai',
        providerType: 'stepfun-ai',
        defaultModel: 'step-3.7-flash',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash'],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 256_000);
    assert.equal(entries[0]?.maxOutputTokens, 256_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the official Volcengine Ark snapshot without inventing live model discovery', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'volcengine-ark',
        providerType: 'volcengine-ark',
        defaultModel: 'doubao-seed-2-0-pro-260215',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['doubao-seed-2-0-pro-260215'],
    );
    assert.equal(entries[0]?.displayName, 'Doubao Seed 2.0 Pro');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the official Volcengine Agent Plan text-model snapshot without inventing data-plane discovery', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'volcengine-agent-plan',
        providerType: 'volcengine-agent-plan',
        defaultModel: 'ark-code-latest',
      },
    });

    assert.equal(entries[0]?.id, 'ark-code-latest');
    assert.equal(entries[0]?.displayName, 'Ark Code Latest');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 256_000);
    assert.equal(entries[0]?.maxOutputTokens, 32_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });

    for (const entry of entries) {
      assert.equal(entry.docsUrl, 'https://www.volcengine.com/docs/82379/2366394', entry.id);
      assert.ok(entry.contextWindow, entry.id);
      assert.ok(entry.maxOutputTokens, entry.id);
      assert.equal(entry.capabilities.reasoning, true, entry.id);
      assert.equal(entry.capabilities.functionCalling, true, entry.id);
    }

    for (const modelId of [
      'ark-code-latest',
      'doubao-seed-2.0-mini',
      'doubao-seed-2.0-lite',
      'doubao-seed-2.1-turbo',
      'doubao-seed-evolving',
      'minimax-m3',
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi-k3',
    ]) {
      assert.equal(
        entries.find((entry) => entry.id === modelId)?.capabilities.vision,
        true,
        modelId,
      );
    }

    for (const modelId of [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.2',
      'glm-latest',
      'minimax-m2.7',
    ]) {
      assert.equal(
        entries.find((entry) => entry.id === modelId)?.capabilities.vision,
        undefined,
        modelId,
      );
    }

    const glmLatest = entries.find((entry) => entry.id === 'glm-latest');
    assert.equal(glmLatest?.contextWindow, 1_024_000);
    assert.equal(glmLatest?.maxOutputTokens, 128_000);

    const deepseek = entries.find((entry) => entry.id === 'deepseek-v4-pro');
    assert.equal(deepseek?.contextWindow, 1_024_000);
    assert.equal(deepseek?.maxOutputTokens, 384_000);
    assert.equal(deepseek?.capabilities.vision, undefined);

    const retiring = entries.find((entry) => entry.id === 'doubao-seed-2.0-code');
    assert.equal(retiring?.lifecycle, 'deprecated');
    assert.equal(retiring?.contextWindow, 256_000);
    assert.equal(retiring?.maxOutputTokens, 128_000);
  });

  it('uses the checked-in StepFun China snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'stepfun',
        providerType: 'stepfun',
        defaultModel: 'step-3.7-flash',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash', 'step-1-32k', 'step-2-16k'],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 256_000);
    assert.equal(entries[0]?.maxOutputTokens, 256_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the checked-in Tencent TokenHub snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'tencent-tokenhub',
        providerType: 'tencent-tokenhub',
        defaultModel: 'hy3',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['hy3', 'hy3-preview'],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 256_000);
    assert.equal(entries[0]?.maxOutputTokens, 64_000);
    assert.deepEqual(entries[0]?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the checked-in Mistral snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'mistral',
        providerType: 'mistral',
        defaultModel: 'mistral-large-latest',
      },
    });

    assert.equal(entries[0]?.id, 'mistral-large-latest');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      functionCalling: true,
    });
    assert.ok(!entries.some((entry) => entry.id === 'mistral-embed'));
  });

  it('uses Cohere tool-capable snapshot models until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'cohere',
        providerType: 'cohere',
        defaultModel: 'command-a-plus-05-2026',
      },
    });

    assert.equal(entries[0]?.id, 'command-a-plus-05-2026');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 128_000);
    assert.equal(entries[0]?.maxOutputTokens, 64_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'command-a-reasoning-08-2025'));
    assert.ok(!entries.some((entry) => entry.id === 'c4ai-aya-expanse-32b'));
  });

  it('uses Hugging Face tool-capable snapshot models until router discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'huggingface',
        providerType: 'huggingface',
        defaultModel: 'openai/gpt-oss-120b',
      },
    });

    assert.equal(entries[0]?.id, 'openai/gpt-oss-120b');
    assert.equal(entries[0]?.displayName, 'GPT OSS 120B');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 131_072);
    assert.equal(entries[0]?.maxOutputTokens, 32_768);
    assert.deepEqual(entries[0]?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'meta-llama/Llama-3.3-70B-Instruct'));
    assert.ok(!entries.some((entry) => entry.id === 'sentence-transformers/all-MiniLM-L6-v2'));
  });

  it('uses the checked-in Together AI snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'together',
        providerType: 'togetherai',
        defaultModel: 'MiniMaxAI/MiniMax-M3',
      },
    });

    assert.equal(entries[0]?.id, 'MiniMaxAI/MiniMax-M3');
    assert.equal(entries[0]?.displayName, 'MiniMax-M3');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'Qwen/Qwen3.5-9B'));
  });

  it('uses the checked-in DeepInfra snapshot until live discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'deepinfra',
        providerType: 'deepinfra',
        defaultModel: 'moonshotai/Kimi-K2.7-Code',
      },
    });

    assert.equal(entries[0]?.id, 'moonshotai/Kimi-K2.7-Code');
    assert.equal(entries[0]?.displayName, 'Kimi K2.7 Code');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'moonshotai/Kimi-K2.6'));
    assert.ok(!entries.some((entry) => entry.id === 'BAAI/bge-m3'));
  });

  it('uses the checked-in Groq snapshot until live discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'groq',
        providerType: 'groq',
        defaultModel: 'llama-3.3-70b-versatile',
      },
    });

    assert.equal(entries[0]?.id, 'llama-3.3-70b-versatile');
    assert.equal(entries[0]?.displayName, 'Llama 3.3 70B');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'openai/gpt-oss-120b'));
    assert.ok(entries.some((entry) => entry.id === 'openai/gpt-oss-safeguard-20b'));
    assert.ok(!entries.some((entry) => entry.id === 'whisper-large-v3'));
  });

  it('uses the checked-in OpenRouter snapshot until live discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'openrouter',
        providerType: 'openrouter',
        defaultModel: 'anthropic/claude-sonnet-5',
      },
    });

    assert.equal(entries[0]?.id, 'anthropic/claude-sonnet-5');
    assert.equal(entries[0]?.displayName, 'Claude Sonnet 5');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'openai/gpt-5.6-sol'));
  });

  it('uses the checked-in Ollama Cloud snapshot with exact model ids until discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'ollama-cloud',
        providerType: 'ollama-cloud',
        defaultModel: 'qwen3.5:397b',
      },
    });

    assert.equal(entries[0]?.id, 'qwen3.5:397b');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 262_144);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'gpt-oss:120b'));
  });

  it('uses the checked-in Fireworks snapshot until live discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'fireworks-ai',
        providerType: 'fireworks-ai',
        defaultModel: 'accounts/fireworks/models/kimi-k2p6',
      },
    });

    assert.equal(entries[0]?.id, 'accounts/fireworks/models/kimi-k2p6');
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.contextWindow, 262_000);
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the checked-in xAI snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'xai',
        providerType: 'xai',
        defaultModel: 'grok-4.5',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      [
        'grok-4.5',
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-0309-reasoning',
        'grok-4.3',
        'grok-build-0.1',
      ],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the checked-in Cerebras snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'cerebras',
        providerType: 'cerebras',
        defaultModel: 'gpt-oss-120b',
      },
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['gpt-oss-120b', 'gemma-4-31b', 'zai-glm-4.7'],
    );
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.deepEqual(entries[0]?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
  });

  it('uses the checked-in NVIDIA snapshot until account discovery succeeds', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'nvidia',
        providerType: 'nvidia',
        defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
      },
    });

    const recommended = entries[0];
    assert.equal(recommended?.id, 'nvidia/nemotron-3-super-120b-a12b');
    assert.equal(recommended?.source, 'static_catalog');
    assert.equal(recommended?.provenance.modelSource, 'fallback');
    assert.deepEqual(recommended?.capabilities, {
      reasoning: true,
      functionCalling: true,
    });
    assert.ok(entries.some((entry) => entry.id === 'openai/gpt-oss-120b'));
  });

  for (const provider of [
    { type: 'xiaomi', modelId: 'mimo-v2.5', vision: true },
    { type: 'zai', modelId: 'glm-5.2', vision: undefined },
  ] as const) {
    it(`uses the checked-in ${provider.type} snapshot until account discovery succeeds`, () => {
      const entries = buildConnectionModelCatalogEntries({
        connection: {
          slug: provider.type,
          providerType: provider.type,
          defaultModel: provider.modelId,
        },
      });

      assert.equal(entries[0]?.id, provider.modelId);
      assert.equal(entries[0]?.source, 'static_catalog');
      assert.equal(entries[0]?.provenance.modelSource, 'fallback');
      assert.equal(entries[0]?.capabilities.vision, provider.vision);
      assert.equal(entries[0]?.capabilities.reasoning, true);
      assert.equal(entries[0]?.capabilities.functionCalling, true);
    });
  }

  it('uses models.dev fallback metadata for a SiliconFlow connection before live discovery', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'siliconflow',
        providerType: 'siliconflow',
        defaultModel: 'moonshotai/Kimi-K2.6',
      },
    });

    const kimi = entries.find((entry) => entry.id === 'moonshotai/Kimi-K2.6');
    assert.ok(kimi, 'the exact models.dev id must remain selectable');
    assert.equal(kimi.source, 'static_catalog');
    assert.equal(kimi.capabilitySource, 'static_catalog');
    assert.equal(kimi.contextWindow, 262_000);
    assert.equal(kimi.maxOutputTokens, 262_000);
    assert.deepEqual(kimi.capabilities, {
      chat: true,
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('normalizes Z.ai fetched models as provider_api facts without guessing unknown capabilities', () => {
    const models: ModelInfo[] = [
      { id: 'glm-4.5' },
      { id: 'glm-4.5-air' },
      { id: 'glm-4.6' },
      {
        id: 'glm-4.7',
        capabilities: { reasoning: true, functionCalling: true },
        contextWindow: 128_000,
      },
      { id: 'glm-5' },
      { id: 'glm-5-turbo' },
      { id: 'glm-5.1' },
    ];
    const entries = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      connectionSlug: 'zai-live',
      defaultModel: 'glm-4.7',
      models,
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    });

    assert.equal(entries.length, 7);
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4.7', 'glm-5', 'glm-5-turbo', 'glm-5.1'],
    );
    assert.equal(entries[0]?.source, 'provider_api');
    assert.equal(entries[0]?.capabilitySource, 'unknown');
    assert.deepEqual(entries[0]?.capabilities, {});
    const defaultEntry = entries.find((entry) => entry.id === 'glm-4.7');
    assert.equal(defaultEntry?.isDefault, true);
    assert.equal(defaultEntry?.capabilitySource, 'provider_api');
    assert.deepEqual(defaultEntry?.capabilities, { reasoning: true, functionCalling: true });
    assert.equal(defaultEntry?.contextWindow, 128_000);
  });

  it('keeps fallback source explicit and does not pretend static models were fetched', () => {
    const entries = buildModelCatalogEntries({
      providerType: 'openai-compatible',
      defaultModel: 'relay-static-model',
      fallbackModels: ['relay-static-model'],
      modelSource: 'fallback',
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.source, 'static_catalog');
    assert.equal(entries[0]?.capabilitySource, 'unknown');
    assert.equal(entries[0]?.provenance.modelSource, 'fallback');
    assert.equal(entries[0]?.unavailableReason, 'none');
    assert.equal(entries[0]?.canUseAsChatDefault, true);
  });

  it('tracks provider inventory, static metadata, and connection default as separate source facts', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'openai',
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });

    assert.deepEqual(entry?.provenance.sources, {
      providerInventory: true,
      staticCatalog: true,
      userChoice: ['connection_default'],
    });
    assert.equal(entry?.source, 'provider_api');
    assert.equal(entry?.displayName, 'GPT-5.5');
  });

  it('keeps static recommendation metadata separate from provider availability', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'deepseek-api',
        providerType: 'deepseek',
        defaultModel: '',
      },
    });

    assert.deepEqual(
      entries.slice(0, 2).map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        recommendedRank: entry.recommendedRank,
        lifecycle: entry.lifecycle,
        docsUrl: entry.docsUrl,
        source: entry.source,
      })),
      [
        {
          id: 'deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          recommendedRank: 1,
          lifecycle: 'active',
          docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
          source: 'static_catalog',
        },
        {
          id: 'deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          recommendedRank: 2,
          lifecycle: 'active',
          docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
          source: 'static_catalog',
        },
      ],
    );
  });

  it('marks deprecated metadata without blocking live availability', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'anthropic',
      defaultModel: 'claude-opus-4-1-20250805',
      models: [{ id: 'claude-opus-4-1-20250805' }],
      modelSource: 'fetched',
    });

    assert.equal(entry?.lifecycle, 'deprecated');
    assert.equal(entry?.availability, 'available');
    assert.equal(entry?.canUseAsChatDefault, true);
  });

  it('fills missing provider limits and capabilities from static model metadata', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
      models: [{ id: 'deepseek-v4-pro' }],
      modelSource: 'fetched',
    });

    assert.equal(entry?.contextWindow, 1_000_000);
    assert.equal(entry?.maxOutputTokens, 384_000);
    assert.equal(entry?.capabilitySource, 'static_catalog');
    assert.deepEqual(entry?.capabilities, { reasoning: true, functionCalling: true });
  });

  it('keeps provider limits and capabilities ahead of static model metadata', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
      models: [
        {
          id: 'deepseek-v4-pro',
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          capabilities: { reasoning: false, functionCalling: false },
        },
      ],
      modelSource: 'fetched',
    });

    assert.equal(entry?.contextWindow, 128_000);
    assert.equal(entry?.maxOutputTokens, 8_192);
    assert.equal(entry?.capabilitySource, 'provider_api');
    assert.deepEqual(entry?.capabilities, {});
  });

  it('fills only missing capability fields when provider capability facts are partial', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
      models: [{ id: 'deepseek-v4-pro', capabilities: { chat: true, reasoning: false } }],
      modelSource: 'fetched',
    });

    assert.equal(entry?.capabilitySource, 'provider_api');
    assert.deepEqual(entry?.capabilities, { chat: true, functionCalling: true });
  });

  it('keeps OpenAI OAuth limits provider-specific instead of reusing OpenAI API context', () => {
    const [[openaiEntry], [oauthEntry]] = (
      [
        ['openai', 'gpt-5.5'],
        ['openai-codex', 'gpt-5.5'],
      ] as const
    ).map(([providerType, model]) =>
      buildModelCatalogEntries({
        providerType,
        defaultModel: model,
        models: [{ id: model }],
        modelSource: 'fetched',
      }),
    );

    assert.equal(openaiEntry?.contextWindow, 1_050_000);
    assert.equal(oauthEntry?.contextWindow, 272_000);
    assert.notEqual(oauthEntry?.contextWindow, openaiEntry?.contextWindow);
    assert.equal(oauthEntry?.maxOutputTokens, 128_000);
  });

  it('uses provider-specific Anthropic output limits over stale aggregate catalog values', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
      models: [{ id: 'claude-sonnet-4-6' }],
      modelSource: 'fetched',
    });

    assert.equal(entry?.contextWindow, 1_000_000);
    assert.equal(entry?.maxOutputTokens, 128_000);
  });

  it('keeps Claude subscription access-path limits unknown while reusing model capabilities', () => {
    const [[apiEntry], [subscriptionEntry]] = (
      [
        ['anthropic', 'claude-sonnet-4-6'],
        ['claude-subscription', 'claude-sonnet-4-6'],
      ] as const
    ).map(([providerType, model]) =>
      buildModelCatalogEntries({
        providerType,
        defaultModel: model,
        models: [{ id: model }],
        modelSource: 'fetched',
      }),
    );

    assert.equal(apiEntry?.contextWindow, 1_000_000);
    assert.equal(apiEntry?.maxOutputTokens, 128_000);
    assert.equal(subscriptionEntry?.contextWindow, undefined);
    assert.equal(subscriptionEntry?.maxOutputTokens, undefined);
    assert.deepEqual(subscriptionEntry?.capabilities, {
      vision: true,
      reasoning: true,
      functionCalling: true,
    });
  });

  it('keeps static model facts on missing default entries without making them sendable', () => {
    const [entry] = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-4.7',
      models: [{ id: 'glm-5.2' }],
      modelSource: 'fetched',
    });

    assert.equal(entry?.id, 'glm-4.7');
    assert.equal(entry?.source, 'unknown');
    assert.equal(entry?.unavailableReason, 'not_in_live_list');
    assert.equal(entry?.canUseAsChatDefault, false);
    assert.equal(entry?.contextWindow, 204_800);
    assert.equal(entry?.maxOutputTokens, 131_072);
    assert.equal(entry?.capabilitySource, 'static_catalog');
    assert.deepEqual(entry?.capabilities, { reasoning: true, functionCalling: true });
  });

  it('marks a fetched model as default when the saved default id has surrounding whitespace', () => {
    const entries = buildModelCatalogEntries({
      providerType: 'openai',
      defaultModel: ' gpt-4.1 ',
      models: [{ id: 'gpt-4.1' }],
      modelSource: 'fetched',
    });

    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.isDefault, entry.provenance.sources?.userChoice]),
      [['gpt-4.1', true, ['connection_default']]],
    );
  });

  it('adds a blocked default entry when a live provider list no longer contains the selected model', () => {
    const entries = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-removed',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    });

    const missingDefault = entries[0];
    assert.equal(missingDefault?.id, 'glm-removed');
    assert.equal(missingDefault?.source, 'unknown');
    assert.equal(missingDefault?.capabilitySource, 'unknown');
    assert.equal(missingDefault?.unavailableReason, 'not_in_live_list');
    assert.equal(missingDefault?.availability, 'blocked');
    assert.equal(missingDefault?.canUseAsChatDefault, false);

    const validation = validateChatDefaultModel({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-removed',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    });
    assert.deepEqual(
      validation.ok ? validation : { ok: validation.ok, reason: validation.reason },
      { ok: false, reason: 'not_in_live_list' },
    );
  });

  it('keeps auth and provider state ahead of live-list missing entries', () => {
    const withAuthFailure = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-removed',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      authOk: false,
    });

    const withProviderFailure = buildModelCatalogEntries({
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-removed',
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      providerAvailable: false,
    });

    assert.equal(withAuthFailure[0]?.unavailableReason, 'auth');
    assert.equal(withProviderFailure[0]?.unavailableReason, 'provider_removed');
  });

  it('keeps fallback missing saved choices visible without making them directly sendable', () => {
    const entries = buildModelCatalogEntries({
      providerType: 'openai-compatible',
      defaultModel: 'custom-default',
      models: [{ id: 'relay-static-model' }],
      modelSource: 'fallback',
      savedModelIds: [{ id: 'custom-session', source: 'session_model' }],
    });

    assert.deepEqual(
      entries.map((entry) => [
        entry.id,
        entry.unavailableReason,
        entry.availability,
        entry.canUseAsChatDefault,
      ]),
      [
        ['custom-default', 'not_in_live_list', 'blocked', false],
        ['relay-static-model', 'none', 'available', true],
        ['custom-session', 'not_in_live_list', 'blocked', false],
      ],
    );
  });

  it('does not allow fallback missing defaults that the local send gate will reject', () => {
    const input = {
      providerType: 'openai-compatible' as const,
      defaultModel: 'custom-default',
      models: [{ id: 'relay-static-model' }],
      modelSource: 'fallback' as const,
    };

    const [missingDefault] = buildModelCatalogEntries(input);
    const validation = validateChatDefaultModel(input);
    const readiness = isConnectionReady({
      connection: {
        slug: 'relay',
        name: 'Relay',
        providerType: 'openai-compatible',
        defaultModel: 'custom-default',
        enabled: true,
        models: [{ id: 'relay-static-model' }],
        modelSource: 'fallback',
        createdAt: 1,
        updatedAt: 1,
      },
      hasSecret: true,
    });

    assert.equal(missingDefault?.id, 'custom-default');
    assert.equal(missingDefault?.canUseAsChatDefault, false);
    assert.deepEqual(
      validation.ok ? validation : { ok: validation.ok, reason: validation.reason },
      { ok: false, reason: 'not_in_live_list' },
    );
    assert.deepEqual(readiness, { ready: false, reason: 'model_not_enabled' });
  });

  it('blocks explicitly image-only models from becoming a chat default', () => {
    const input = {
      providerType: 'openai' as const,
      defaultModel: 'gpt-image-1',
      models: [{ id: 'gpt-image-1', capabilities: { imageGeneration: true, chat: false } }],
      modelSource: 'fetched' as const,
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    };
    const [entry] = buildModelCatalogEntries(input);
    assert.equal(entry?.unavailableReason, 'unsupported_for_chat');
    assert.equal(entry?.availability, 'blocked');
    assert.equal(entry?.canUseAsChatDefault, false);
    assert.deepEqual(entry?.capabilities, { vision: true, imageGeneration: true });

    const validation = validateChatDefaultModel(input);
    assert.deepEqual(
      validation.ok ? validation : { ok: validation.ok, reason: validation.reason },
      { ok: false, reason: 'unsupported_for_chat' },
    );
  });

  it('uses merged static capabilities before deciding whether a partial provider model is chat-capable', () => {
    const input = {
      providerType: 'openai' as const,
      defaultModel: 'gpt-5.4',
      models: [{ id: 'gpt-5.4', capabilities: { imageGeneration: true } }],
      modelSource: 'fetched' as const,
    };
    const [entry] = buildModelCatalogEntries(input);

    assert.equal(entry?.unavailableReason, 'none');
    assert.equal(entry?.availability, 'available');
    assert.equal(entry?.canUseAsChatDefault, true);
    assert.deepEqual(entry?.capabilities, {
      reasoning: true,
      functionCalling: true,
      imageGeneration: true,
      vision: true,
    });
    assert.equal(validateChatDefaultModel(input).ok, true);
  });

  it('treats stale fetchedAt as a warning, not a send-blocking failure', () => {
    const input = {
      providerType: 'anthropic' as const,
      defaultModel: 'claude-sonnet-4-5-20250929',
      models: [{ id: 'claude-sonnet-4-5-20250929', capabilities: { reasoning: true } }],
      modelSource: 'fetched' as const,
      modelsFetchedAt: 1_700_000_000_000,
      now: 1_800_000_000_000,
      staleAfterMs: 7 * 24 * 60 * 60 * 1000,
    };
    const [entry] = buildModelCatalogEntries(input);
    assert.equal(entry?.unavailableReason, 'stale');
    assert.equal(entry?.availability, 'warning');
    assert.equal(entry?.canUseAsChatDefault, true);
    assert.deepEqual(validateChatDefaultModel(input).ok, true);
  });

  it('keeps unknown capability as unknown instead of warning like known false', () => {
    const input = {
      providerType: 'openai' as const,
      defaultModel: 'future-model',
      models: [{ id: 'future-model', capabilities: { vision: false, reasoning: undefined } }],
      modelSource: 'fetched' as const,
      modelsFetchedAt: 1_800_000_000_000,
      now: 1_800_000_001_000,
    };
    const [entry] = buildModelCatalogEntries(input);
    assert.equal(entry?.unavailableReason, 'none');
    assert.equal(entry?.canUseAsChatDefault, true);
    assert.deepEqual(entry?.capabilities, {});
  });

  it('builds a connection-scoped catalog from fetched connection models', () => {
    const connection: LlmConnection = {
      slug: 'zai-live',
      name: 'Z.AI account',
      providerType: 'zai-coding-plan',
      defaultModel: 'glm-saved',
      enabled: true,
      models: [{ id: 'glm-4.7' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
      createdAt: 1,
      updatedAt: 1,
    };

    const entries = buildConnectionModelCatalogEntries({
      connection,
      savedModelIds: [
        { id: 'glm-session', source: 'session_model' },
        { id: 'glm-daily-review', source: 'daily_review_model' },
        'glm-4.7',
        ' ',
      ],
      now: 1_800_000_001_000,
    });

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ['glm-saved', 'glm-4.7', 'glm-session', 'glm-daily-review'],
    );
    assert.equal(entries[0]?.connectionSlug, 'zai-live');
    assert.equal(entries[0]?.unavailableReason, 'not_in_live_list');
    assert.equal(entries[0]?.isDefault, true);
    assert.equal(entries[1]?.source, 'provider_api');
    assert.equal(entries[2]?.source, 'unknown');
    assert.equal(entries[2]?.provenance.userChoice, true);
    assert.deepEqual(entries[0]?.provenance.sources?.userChoice, ['connection_default']);
    assert.deepEqual(entries[2]?.provenance.sources?.userChoice, ['session_model']);
    assert.deepEqual(entries[3]?.provenance.sources?.userChoice, ['daily_review_model']);
  });

  it('uses curated catalog fallbacks for a connection without fetched models', () => {
    const connection: LlmConnection = {
      slug: 'openai-api',
      name: 'OpenAI',
      providerType: 'openai',
      defaultModel: '',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const entries = buildConnectionModelCatalogEntries({ connection });

    assert.deepEqual(
      entries.slice(0, 2).map((entry) => [entry.id, entry.source, entry.provenance.modelSource]),
      [
        ['gpt-5.5', 'static_catalog', 'fallback'],
        ['gpt-5.5-pro', 'static_catalog', 'fallback'],
      ],
    );
  });

  it('treats the registry snapshot as authoritative for fallback-only providers', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'volcengine-ark',
        providerType: 'volcengine-ark',
        defaultModel: 'doubao-seed-2-0-pro-260215',
        models: [{ id: 'stale-cli-snapshot' }],
        modelSource: 'fetched',
        modelsFetchedAt: 1,
      },
    });

    assert.ok(entries.some((entry) => entry.id === 'doubao-seed-2-0-pro-260215'));
    assert.ok(!entries.some((entry) => entry.id === 'stale-cli-snapshot'));
    assert.ok(entries.every((entry) => entry.source === 'static_catalog'));
    assert.ok(entries.every((entry) => entry.provenance.modelSource === 'fallback'));
  });

  it('carries display names separately from stable model ids', () => {
    const [fetchedEntry] = buildModelCatalogEntries({
      providerType: 'openai-codex',
      defaultModel: 'gpt-5.5',
      models: [{ id: 'gpt-5.5', displayName: 'GPT 5.5' }],
      modelSource: 'fetched',
      modelsFetchedAt: 1_800_000_000_000,
    });

    assert.equal(fetchedEntry?.id, 'gpt-5.5');
    assert.equal(fetchedEntry?.displayName, 'GPT 5.5');

    const [fallbackEntry] = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'openai-codex',
        providerType: 'openai-codex',
        defaultModel: '',
      },
    });

    assert.equal(fallbackEntry?.id, 'gpt-5.6-sol');
    assert.equal(fallbackEntry?.displayName, 'GPT-5.6 Sol');
  });

  it('exposes gpt-5.6-sol as the lead OpenAI Codex OAuth fallback model with the access-path context window', () => {
    // gpt-5.6-sol is the current ChatGPT/Codex flagship slug served by the
    // chatgpt.com/backend-api/codex OAuth backend (per the OpenAI codex CLI
    // models.json and hermes DEFAULT_CODEX_MODELS). It must lead the OAuth
    // fallback list, and its context window is the access-path limit (372k),
    // not the platform-API limit (1.05M) from the models.dev snapshot.
    // gpt-5.6-luna/terra and the bare gpt-5.6 platform-API slug are
    // intentionally excluded: they are not selectable through the
    // ChatGPT/Codex OAuth path.
    const [lead] = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'openai-codex',
        providerType: 'openai-codex',
        defaultModel: '',
      },
    });

    assert.equal(lead?.id, 'gpt-5.6-sol');
    assert.equal(lead?.displayName, 'GPT-5.6 Sol');
    assert.equal(lead?.contextWindow, 372_000);
  });

  it('enriches provider model ids with models.dev display names', () => {
    assert.deepEqual(
      (
        [
          ['anthropic', 'claude-sonnet-4-6'],
          ['claude-subscription', 'claude-opus-4-8'],
          ['openai', 'gpt-5.5-pro'],
          ['openai', 'gpt-4o-mini'],
          ['google', 'gemini-3.5-flash'],
          ['gemini-cli', 'gemini-2.5-pro'],
          ['deepseek', 'deepseek-v4-flash'],
          ['zai-coding-plan', 'glm-5.2'],
          ['openai-codex', 'gpt-5.3-codex-spark'],
        ] as Array<[ProviderType, string]>
      ).map(([providerType, model]) => {
        const [entry] = buildModelCatalogEntries({
          providerType,
          defaultModel: model,
          models: [{ id: model }],
          modelSource: 'fetched',
          modelsFetchedAt: 1_800_000_000_000,
        });
        return [entry?.id, entry?.displayName];
      }),
      [
        ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
        ['claude-opus-4-8', 'Claude Opus 4.8'],
        ['gpt-5.5-pro', 'GPT-5.5 Pro'],
        ['gpt-4o-mini', 'GPT-4o mini'],
        ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
        ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
        ['glm-5.2', 'GLM-5.2'],
        ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'],
      ],
    );

    const [fallbackEntry] = buildModelCatalogEntries({
      providerType: 'deepseek',
      defaultModel: 'deepseek-reasoner',
      fallbackModels: ['deepseek-reasoner'],
      modelSource: 'fallback',
    });

    assert.equal(fallbackEntry?.id, 'deepseek-reasoner');
    assert.equal(fallbackEntry?.displayName, 'DeepSeek Reasoner');
  });

  it('does not invent provider metadata when models.dev has no matching model id', () => {
    assert.deepEqual(
      (
        [
          ['google', 'gemini-1.5-pro'],
          ['moonshot', 'moonshot-v1-8k'],
        ] as const
      ).map(([providerType, model]) => {
        const [entry] = buildModelCatalogEntries({
          providerType,
          defaultModel: model,
          models: [{ id: model }],
          modelSource: 'fetched',
          modelsFetchedAt: 1_800_000_000_000,
        });
        return [
          entry?.id,
          entry?.displayName,
          entry?.contextWindow,
          entry?.maxOutputTokens,
          entry?.capabilitySource,
          entry?.capabilities,
        ];
      }),
      [
        ['gemini-1.5-pro', undefined, undefined, undefined, 'unknown', {}],
        ['moonshot-v1-8k', undefined, undefined, undefined, 'unknown', {}],
      ],
    );
  });

  it('keeps fallback catalog choices aligned with current models.dev provider ids', () => {
    const googleEntries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'google-api',
        providerType: 'google',
        defaultModel: '',
      },
    });
    const zaiEntries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'zai-api',
        providerType: 'zai-coding-plan',
        defaultModel: '',
      },
    });

    assert.deepEqual(
      googleEntries.map((entry) => [entry.id, entry.displayName]),
      [
        ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
        ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
        ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
        ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ],
    );
    assert.deepEqual(
      zaiEntries.map((entry) => [entry.id, entry.displayName]),
      [
        ['glm-5.2', 'GLM-5.2'],
        ['glm-5.1', 'GLM-5.1'],
        ['glm-5-turbo', 'GLM-5-Turbo'],
        ['glm-4.7', 'GLM-4.7'],
        ['glm-4.5-air', 'GLM-4.5-Air'],
      ],
    );
  });

  it('does not apply provider metadata to custom or local model ids', () => {
    assert.deepEqual(
      (
        [
          ['openai-compatible', 'gpt-4o-mini'],
          ['ollama', 'gemini-2.5-pro'],
        ] as const
      ).map(([providerType, model]) => {
        const [entry] = buildModelCatalogEntries({
          providerType,
          defaultModel: model,
          models: [{ id: model }],
          modelSource: 'fetched',
          modelsFetchedAt: 1_800_000_000_000,
        });
        return [entry?.id, entry?.displayName];
      }),
      [
        ['gpt-4o-mini', undefined],
        ['gemini-2.5-pro', undefined],
      ],
    );
  });
});

describe('buildConnectionModelCatalogEntries unknown-providerType fallback', () => {
  // A connection persisted on another branch may carry a providerType this
  // build's PROVIDER_REGISTRY doesn't know (e.g. 'groq'). Catalog building
  // must return no entries instead of crashing on `defaults.fallbackModels`.
  // Mirrors `isFakeBackend` in connection-readiness.ts.
  it('returns [] for an unregistered providerType', () => {
    const entries = buildConnectionModelCatalogEntries({
      connection: {
        slug: 'groq',
        providerType: 'branch-only-provider' as ProviderType,
        defaultModel: 'llama-3.1-8b-instant',
      },
    });
    assert.deepEqual(entries, []);
  });
});
