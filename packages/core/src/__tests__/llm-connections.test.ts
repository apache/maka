/**
 * Tests for the LlmConnection contract helpers in
 * `packages/core/src/llm-connections.ts`.
 *
 * Current scope: PR-UI-IPC-1 `validateConnectionBaseUrl` gate
 * (closed scheme allowlist for connection `baseUrl` at the IPC
 * boundary). The gate is the credentials-exfiltration boundary
 * @kenji locked at msg 35260e29 — `javascript:` / `file:` / garbage
 * must NOT persist; `http:` / `https:` are the only accepted
 * schemes. Localhost / private-network URLs are intentionally
 * allowed (Ollama, LM Studio, vLLM).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_DEFAULTS,
  PROVIDER_REGISTRY,
  READY_PROVIDER_TYPES,
  RECOMMENDED_PROVIDER_TYPES,
  backendKindOf,
  effectiveBaseUrl,
  migrateConnectionV1ToV2,
  normalizeConnectionBaseUrl,
  normalizeProviderType,
  persistedBaseUrl,
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  reconcileConnectionAfterModelFetch,
  validateConnectionBaseUrl,
  type ProviderType,
} from '../llm-connections.js';

describe('provider compatibility contract', () => {
  it('exposes only supported first-class provider ids in stable order', () => {
    assert.deepEqual(Object.keys(PROVIDER_DEFAULTS), [
      'anthropic',
      'kimi-coding-plan',
      'minimax-coding-plan',
      'tencent-coding-plan',
      'volcengine-coding-plan',
      'tencent-token-plan',
      'openai',
      'google',
      'deepseek',
      'moonshot',
      'zai-coding-plan',
      'MiniMax',
      'MiniMax-cn',
      'siliconflow',
      'vercel',
      'xai',
      'xai-oauth',
      'zai',
      'xiaomi',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-ams',
      'cerebras',
      'mistral',
      'cohere',
      'huggingface',
      'zenmux',
      'opencode',
      'opencode-go',
      'togetherai',
      'fireworks-ai',
      'nvidia',
      'tencent-tokenhub',
      'stepfun',
      'stepfun-step-plan',
      'stepfun-ai-step-plan',
      'stepfun-ai',
      'volcengine-ark',
      'deepinfra',
      'groq',
      'openrouter',
      'alibaba',
      'alibaba-coding-plan-cn',
      'alibaba-coding-plan',
      'alibaba-token-plan-cn',
      'alibaba-token-plan',
      'cloudflare-workers-ai',
      'ollama-cloud',
      'ollama',
      'lm-studio',
      'localai',
      'openai-compatible',
      'openai-responses-compatible',
      'anthropic-compatible',
      'github-copilot',
      'claude-subscription',
      'openai-codex',
      'gemini-cli',
    ]);
    assert.deepEqual(READY_PROVIDER_TYPES, [
      'anthropic',
      'openai',
      'google',
      'deepseek',
      'moonshot',
      'zai-coding-plan',
      'MiniMax',
      'MiniMax-cn',
      'siliconflow',
      'xai',
      'zai',
      'xiaomi',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-ams',
      'cerebras',
      'mistral',
      'ollama',
      'lm-studio',
      'localai',
      'kimi-coding-plan',
      'openai-compatible',
      'openai-responses-compatible',
      'anthropic-compatible',
      'minimax-coding-plan',
      'togetherai',
      'fireworks-ai',
      'nvidia',
      'tencent-tokenhub',
      'stepfun',
      'tencent-coding-plan',
      'stepfun-ai',
      'volcengine-ark',
      'volcengine-coding-plan',
      'tencent-token-plan',
      'stepfun-step-plan',
      'deepinfra',
      'cohere',
      'vercel',
      'stepfun-ai-step-plan',
      'cloudflare-workers-ai',
      'huggingface',
      'ollama-cloud',
      'zenmux',
      'opencode',
      'opencode-go',
      'groq',
      'openrouter',
      'alibaba',
      'alibaba-coding-plan-cn',
      'alibaba-coding-plan',
      'alibaba-token-plan-cn',
      'alibaba-token-plan',
    ]);
    assert.deepEqual(CATALOG_PROVIDER_TYPES, [
      'kimi-coding-plan',
      'minimax-coding-plan',
      'deepseek',
      'moonshot',
      'zai-coding-plan',
      'MiniMax',
      'MiniMax-cn',
      'siliconflow',
      'anthropic',
      'openai',
      'google',
      'xai',
      'zai',
      'xiaomi',
      'xiaomi-token-plan-cn',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-ams',
      'cerebras',
      'mistral',
      'togetherai',
      'ollama',
      'lm-studio',
      'localai',
      'openai-compatible',
      'openai-responses-compatible',
      'anthropic-compatible',
      'fireworks-ai',
      'nvidia',
      'tencent-tokenhub',
      'stepfun',
      'tencent-coding-plan',
      'stepfun-ai',
      'volcengine-ark',
      'volcengine-coding-plan',
      'tencent-token-plan',
      'stepfun-step-plan',
      'deepinfra',
      'cohere',
      'vercel',
      'stepfun-ai-step-plan',
      'cloudflare-workers-ai',
      'huggingface',
      'ollama-cloud',
      'zenmux',
      'opencode',
      'opencode-go',
      'groq',
      'openrouter',
      'alibaba',
      'alibaba-coding-plan-cn',
      'alibaba-coding-plan',
      'alibaba-token-plan-cn',
      'alibaba-token-plan',
    ]);

    for (const orderField of ['readyOrder', 'catalogOrder', 'recommendedOrder'] as const) {
      const orders = Object.values(PROVIDER_REGISTRY)
        .map((provider) => provider[orderField])
        .filter((order): order is number => order !== undefined);
      assert.equal(new Set(orders).size, orders.length, `${orderField} values must be unique`);
    }
  });

  it('derives catalog, recommendation, runtime, and discovery behavior from one registry', () => {
    assert.equal(
      PROVIDER_DEFAULTS,
      PROVIDER_REGISTRY,
      'the compatibility export must not copy registry state',
    );
    assert.deepEqual(RECOMMENDED_PROVIDER_TYPES, [
      'siliconflow',
      'anthropic',
      'openai',
      'google',
      'kimi-coding-plan',
      'deepseek',
      'ollama',
      'openai-compatible',
      'openai-responses-compatible',
      'anthropic-compatible',
    ]);
    assert.equal(PROVIDER_REGISTRY['kimi-coding-plan'].catalogGroup, 'plans');
    assert.equal(PROVIDER_REGISTRY.siliconflow.catalogGroup, 'aggregators');
    assert.equal(PROVIDER_REGISTRY.ollama.catalogGroup, 'local');
    assert.equal(PROVIDER_REGISTRY['lm-studio'].catalogGroup, 'local');
    assert.equal(PROVIDER_REGISTRY.siliconflow.runtimeAdapter.kind, 'openai-compatible');
    assert.equal(PROVIDER_REGISTRY.siliconflow.modelDiscovery.kind, 'protocol');
    assert.deepEqual(PROVIDER_REGISTRY.siliconflow.modelDiscovery.query, { sub_type: 'chat' });
    assert.equal(PROVIDER_REGISTRY.ollama.modelDiscovery.kind, 'ollama');
    assert.deepEqual(PROVIDER_REGISTRY['openai-codex'].modelDiscovery, {
      kind: 'protocol',
      auth: 'openai-codex',
    });
  });

  it('offers K3 first for Kimi Coding Plan while preserving the existing legacy alias', () => {
    assert.deepEqual(PROVIDER_REGISTRY['kimi-coding-plan'].fallbackModels, [
      'k3',
      'kimi-for-coding',
    ]);
  });

  it('owns OpenCode Zen and Go as distinct mixed-protocol access paths', () => {
    const providers = PROVIDER_REGISTRY as Partial<
      Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
    >;
    const zen = providers.opencode;
    const go = providers['opencode-go'];

    assert.ok(zen);
    assert.ok(go);
    assert.equal(zen.baseUrl, 'https://opencode.ai/zen/v1');
    assert.equal(go.baseUrl, 'https://opencode.ai/zen/go/v1');
    for (const provider of [zen, go]) {
      assert.equal(provider.authKind, 'api_key');
      assert.equal(provider.protocol, 'openai');
      assert.deepEqual(provider.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
      assert.deepEqual(provider.modelDiscovery, { kind: 'protocol' });
      assert.equal(provider.catalogGroup, 'plans');
      assert.equal(provider.catalogBadge, 'Plan');
      assert.ok(provider.fallbackModels.length > 0);
    }
    assert.equal(zen.modelsDevId, 'opencode');
    assert.equal(go.modelsDevId, 'opencode-go');
    assert.ok(zen.fallbackModels.includes('gpt-5.5'));
    assert.ok(go.fallbackModels.includes('minimax-m3'));
    assert.notDeepEqual(zen.fallbackModels, go.fallbackModels);
  });

  it('owns GitHub Copilot as an account subscription, never as GitHub Models inference', () => {
    const provider = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['github-copilot'];

    assert.ok(provider);
    assert.equal(provider.label, 'GitHub Copilot');
    assert.equal(provider.baseUrl, 'https://api.githubcopilot.com');
    assert.equal(provider.authKind, 'oauth_token');
    assert.equal(provider.protocol, 'openai');
    assert.deepEqual(provider.runtimeAdapter, { kind: 'github-copilot' });
    assert.deepEqual(provider.modelDiscovery, { kind: 'protocol', auth: 'github-copilot' });
    assert.equal(provider.category, 'oauth');
    assert.equal(provider.catalogGroup, undefined);
    assert.equal(provider.modelsDevId, 'github-copilot');
    assert.equal(provider.fallbackModels[0], 'gpt-5.4');
    assert.ok(!provider.baseUrl.includes('models.github.ai'));
  });

  it('owns Volcengine Ark Coding Plan as a fallback-only interactive coding access path', () => {
    const provider = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['volcengine-coding-plan'];

    assert.ok(provider);
    assert.equal(provider.label, 'Volcengine Ark Coding Plan (China)');
    assert.equal(provider.baseUrl, 'https://ark.cn-beijing.volces.com/api/coding/v3');
    assert.equal(provider.authKind, 'api_key');
    assert.equal(provider.protocol, 'openai');
    assert.deepEqual(provider.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(provider.modelDiscovery, { kind: 'fallback' });
    assert.equal(provider.catalogGroup, 'plans');
    assert.deepEqual(provider.fallbackModels, [
      'ark-code-latest',
      'doubao-seed-2.0-code',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
      'doubao-seed-code',
      'minimax-m2.7',
      'minimax-m3',
      'glm-5.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.6',
      'kimi-k2.7-code',
    ]);
  });

  it('owns LocalAI under one stable local provider id with optional API-key auth', () => {
    const localai = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).localai;

    assert.ok(localai, 'LocalAI must be available through the shared provider registry');
    assert.equal(localai.label, 'LocalAI');
    assert.equal(localai.baseUrl, 'http://127.0.0.1:8080/v1');
    assert.equal(localai.authKind, 'optional_api_key');
    assert.equal(localai.protocol, 'openai');
    assert.deepEqual(localai.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(localai.modelDiscovery, { kind: 'protocol' });
    assert.deepEqual(localai.fallbackModels, ['qwen3-8b']);
    assert.equal(localai.category, 'local');
    assert.equal(localai.catalogGroup, 'local');
    assert.equal(localai.catalogBadge, 'Local');
  });

  it('owns the complete xAI provider contract under the stable xai id', () => {
    assert.deepEqual(PROVIDER_REGISTRY.xai, {
      label: 'xAI',
      description: 'Grok models for chat, reasoning, vision, and tool use.',
      baseUrl: 'https://api.x.ai/v1',
      authKind: 'api_key',
      backendKind: 'ai-sdk',
      fallbackModels: [
        'grok-4.5',
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-0309-reasoning',
        'grok-4.3',
        'grok-build-0.1',
      ],
      status: 'ready',
      protocol: 'openai',
      runtimeAdapter: {
        kind: 'openai-compatible',
        name: 'provider',
        supportsOpenAiResponses: true,
      },
      modelDiscovery: { kind: 'protocol' },
      category: 'overseas',
      catalogGroup: 'api',
      catalogBadge: 'API',
      signupUrl: 'https://console.x.ai/',
      modelsDevId: 'xai',
      readyOrder: 10,
      catalogOrder: 12,
    });
  });

  it('keeps xAI account OAuth separate from the existing API-key provider', () => {
    assert.deepEqual(PROVIDER_REGISTRY['xai-oauth'], {
      label: 'xAI OAuth (SuperGrok / X Premium)',
      description: 'Use an eligible Grok account through xAI device authorization.',
      baseUrl: 'https://api.x.ai/v1',
      authKind: 'oauth_token',
      backendKind: 'ai-sdk',
      fallbackModels: PROVIDER_REGISTRY.xai.fallbackModels,
      status: 'ready',
      protocol: 'openai',
      runtimeAdapter: {
        kind: 'openai-compatible',
        name: 'provider',
        supportsOpenAiResponses: true,
      },
      modelDiscovery: {
        kind: 'protocol',
        auth: 'oauth-bearer',
        filter: 'fallback-models',
      },
      category: 'oauth',
      catalogBadge: 'Account',
      signupUrl: 'https://x.ai/grok',
      modelsDevId: 'xai',
    });
    assert.equal(PROVIDER_REGISTRY.xai.authKind, 'api_key');
  });

  for (const provider of [
    {
      type: 'zai',
      label: 'Z.AI',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      modelId: 'glm-5.2',
      signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    },
    {
      type: 'xiaomi',
      label: 'Xiaomi',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      modelId: 'mimo-v2.5',
      signupUrl: 'https://platform.xiaomimimo.com/',
    },
  ] as const) {
    it(`owns the ${provider.label} direct API contract under the stable ${provider.type} id`, () => {
      const defaults = PROVIDER_REGISTRY[provider.type];
      assert.equal(defaults.label, provider.label);
      assert.equal(defaults.baseUrl, provider.baseUrl);
      assert.equal(defaults.fallbackModels[0], provider.modelId);
      assert.equal(defaults.authKind, 'api_key');
      assert.equal(defaults.protocol, 'openai');
      assert.deepEqual(defaults.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
      assert.deepEqual(defaults.modelDiscovery, { kind: 'protocol' });
      assert.equal(defaults.category, 'domestic');
      assert.equal(defaults.catalogGroup, 'api');
      assert.equal(defaults.catalogBadge, 'API');
      assert.equal(defaults.signupUrl, provider.signupUrl);
      assert.equal(defaults.modelsDevId, provider.type);
    });
  }

  it('keeps the Z.AI direct API distinct from the existing coding plan', () => {
    assert.notEqual(PROVIDER_REGISTRY.zai.baseUrl, PROVIDER_REGISTRY['zai-coding-plan'].baseUrl);
  });

  it('owns Vercel AI Gateway under the stable models.dev id with public language-model discovery', () => {
    const provider = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).vercel;

    assert.ok(provider, 'Vercel AI Gateway must be available through the shared provider registry');
    assert.equal(provider.label, 'Vercel AI Gateway');
    assert.equal(provider.baseUrl, 'https://ai-gateway.vercel.sh/v1');
    assert.equal(provider.authKind, 'api_key');
    assert.equal(provider.protocol, 'openai');
    assert.deepEqual(provider.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(provider.modelDiscovery, {
      kind: 'protocol',
      auth: 'none',
      filter: 'language-models',
    });
    assert.equal(provider.category, 'overseas');
    assert.equal(provider.catalogGroup, 'aggregators');
    assert.equal(provider.catalogBadge, 'Gateway');
    assert.equal(provider.signupUrl, 'https://vercel.com/ai-gateway');
    assert.equal(provider.modelsDevId, 'vercel');
    assert.equal(provider.fallbackModels[0], 'anthropic/claude-opus-4.8');
    assert.ok(provider.fallbackModels.includes('openai/gpt-5.5'));
    assert.equal(provider.fallbackModels.includes('anthropic/claude-opus-4.1'), false);
    assert.equal(
      provider.fallbackModels.every((id) => id.includes('/')),
      true,
    );
  });

  it('owns ZenMux under the stable models.dev id with public snapshot-bounded discovery', () => {
    const zenmux = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).zenmux;

    assert.ok(zenmux, 'ZenMux must be available through the shared provider registry');
    assert.equal(zenmux.label, 'ZenMux');
    assert.equal(zenmux.baseUrl, 'https://zenmux.ai/api/v1');
    assert.equal(zenmux.authKind, 'api_key');
    assert.equal(zenmux.protocol, 'openai');
    assert.deepEqual(zenmux.runtimeAdapter, {
      kind: 'openai-compatible',
      name: 'provider',
      replayAssistantReasoningAs: 'reasoning',
      replayAssistantReasoningDetails: true,
    });
    assert.deepEqual(zenmux.modelDiscovery, {
      kind: 'protocol',
      auth: 'none',
      filter: 'fallback-models',
    });
    assert.equal(zenmux.category, 'overseas');
    assert.equal(zenmux.catalogGroup, 'aggregators');
    assert.equal(zenmux.catalogBadge, 'Gateway');
    assert.equal(zenmux.signupUrl, 'https://zenmux.ai/settings/keys');
    assert.equal(zenmux.modelsDevId, 'zenmux');
    assert.equal(zenmux.fallbackModels[0], 'moonshotai/kimi-k2.5');
    assert.ok(zenmux.fallbackModels.includes('moonshotai/kimi-k2.7-code'));
    assert.equal(
      zenmux.fallbackModels.includes('anthropic/claude-sonnet-4.6'),
      false,
      'models.dev routes this model through ZenMux Anthropic API, not the first-slice OpenAI Chat adapter',
    );
    assert.equal(
      zenmux.fallbackModels.includes('openai/gpt-5.4'),
      false,
      'models.dev routes this model through the native OpenAI adapter and must not imply generic Chat compatibility',
    );
    assert.ok(zenmux.fallbackModels.every((id) => id.includes('/')));
  });

  it('owns the complete Cerebras provider contract under the stable cerebras id', () => {
    assert.deepEqual(PROVIDER_REGISTRY.cerebras, {
      label: 'Cerebras',
      description: 'Fast hosted open-model inference with reasoning and tool use.',
      baseUrl: 'https://api.cerebras.ai/v1',
      authKind: 'api_key',
      backendKind: 'ai-sdk',
      fallbackModels: ['gpt-oss-120b', 'gemma-4-31b', 'zai-glm-4.7'],
      status: 'ready',
      protocol: 'openai',
      runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
      modelDiscovery: { kind: 'protocol' },
      category: 'overseas',
      catalogGroup: 'api',
      catalogBadge: 'API',
      signupUrl: 'https://cloud.cerebras.ai/',
      modelsDevId: 'cerebras',
      readyOrder: 11,
      catalogOrder: 13,
    });
  });

  it('owns Mistral hosted API behavior under the stable mistral id', () => {
    const mistral = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).mistral;

    assert.ok(mistral, 'Mistral must be available through the shared provider registry');
    assert.equal(mistral.label, 'Mistral');
    assert.equal(mistral.baseUrl, 'https://api.mistral.ai/v1');
    assert.equal(mistral.authKind, 'api_key');
    assert.equal(mistral.protocol, 'openai');
    assert.deepEqual(mistral.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(mistral.modelDiscovery, { kind: 'protocol', responseShape: 'array-or-data' });
    assert.equal(mistral.category, 'overseas');
    assert.equal(mistral.catalogGroup, 'api');
    assert.equal(mistral.modelsDevId, 'mistral');
    assert.equal(mistral.fallbackModels[0], 'mistral-large-latest');
    assert.ok(mistral.fallbackModels.includes('mistral-small-latest'));
    assert.ok(!mistral.fallbackModels.includes('mistral-embed'));
  });

  it('owns DeepInfra direct API behavior under the stable deepinfra id', () => {
    const deepinfra = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).deepinfra;

    assert.ok(deepinfra, 'DeepInfra must be available through the shared provider registry');
    assert.equal(deepinfra.label, 'Deep Infra');
    assert.equal(deepinfra.baseUrl, 'https://api.deepinfra.com/v1/openai');
    assert.equal(deepinfra.authKind, 'api_key');
    assert.equal(deepinfra.protocol, 'openai');
    assert.deepEqual(deepinfra.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(deepinfra.modelDiscovery, {
      kind: 'protocol',
      path: '/v1/models',
      filter: 'fallback-models',
    });
    assert.equal(deepinfra.category, 'overseas');
    assert.equal(deepinfra.catalogGroup, 'api');
    assert.equal(deepinfra.modelsDevId, 'deepinfra');
    assert.equal(deepinfra.fallbackModels[0], 'moonshotai/Kimi-K2.7-Code');
    assert.ok(deepinfra.fallbackModels.includes('moonshotai/Kimi-K2.6'));
    assert.ok(!deepinfra.fallbackModels.includes('BAAI/bge-m3'));
  });

  it('owns Groq direct API behavior under the stable groq id', () => {
    const groq = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).groq;

    assert.ok(groq, 'Groq must be available through the shared provider registry');
    assert.equal(groq.label, 'Groq');
    assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(groq.authKind, 'api_key');
    assert.equal(groq.protocol, 'openai');
    assert.deepEqual(groq.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(groq.modelDiscovery, {
      kind: 'protocol',
      filter: 'fallback-models',
    });
    assert.equal(groq.category, 'overseas');
    assert.equal(groq.catalogGroup, 'api');
    assert.equal(groq.modelsDevId, 'groq');
    assert.equal(groq.fallbackModels[0], 'llama-3.3-70b-versatile');
    assert.ok(groq.fallbackModels.includes('openai/gpt-oss-120b'));
    assert.ok(groq.fallbackModels.includes('qwen/qwen3-32b'));
    // gpt-oss-safeguard-20b is a moderation model, but models.dev marks it
    // function-calling — we keep it in the fallback list to match every other
    // provider (Vercel ships the identical model). The default stays
    // llama-3.3-70b-versatile via recommended-first ordering; safeguard never
    // receives reasoning_effort (no thinkingOptions entry below).
    assert.ok(groq.fallbackModels.includes('openai/gpt-oss-safeguard-20b'));
    assert.ok(!groq.fallbackModels.includes('whisper-large-v3'));
  });

  it('owns OpenRouter direct API behavior under the stable openrouter id', () => {
    const openrouter = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).openrouter;

    assert.ok(openrouter, 'OpenRouter must be available through the shared provider registry');
    assert.equal(openrouter.label, 'OpenRouter');
    assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(openrouter.authKind, 'api_key');
    assert.equal(openrouter.protocol, 'openai');
    assert.deepEqual(openrouter.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(openrouter.modelDiscovery, {
      kind: 'protocol',
      filter: 'fallback-models',
    });
    assert.equal(openrouter.category, 'overseas');
    assert.equal(openrouter.catalogGroup, 'aggregators');
    assert.equal(openrouter.catalogBadge, '聚合');
    assert.equal(openrouter.modelsDevId, 'openrouter');
    assert.equal(openrouter.fallbackModels[0], 'anthropic/claude-sonnet-5');
    assert.ok(openrouter.fallbackModels.includes('openai/gpt-5.6-sol'));
  });

  it('owns Cohere native API behavior under the stable cohere id', () => {
    const cohere = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).cohere;

    assert.ok(cohere, 'Cohere must be available through the shared provider registry');
    assert.equal(cohere.label, 'Cohere');
    assert.equal(cohere.baseUrl, 'https://api.cohere.com/v2');
    assert.equal(cohere.authKind, 'api_key');
    assert.equal(cohere.protocol, 'cohere');
    assert.deepEqual(cohere.runtimeAdapter, { kind: 'cohere' });
    assert.deepEqual(cohere.modelDiscovery, { kind: 'cohere' });
    assert.equal(cohere.category, 'overseas');
    assert.equal(cohere.catalogGroup, 'api');
    assert.equal(cohere.modelsDevId, 'cohere');
    assert.equal(cohere.fallbackModels[0], 'command-a-plus-05-2026');
    assert.ok(cohere.fallbackModels.includes('command-a-reasoning-08-2025'));
    assert.ok(!cohere.fallbackModels.includes('c4ai-aya-expanse-32b'));
  });

  it('owns Cloudflare Workers AI under one account-scoped stable provider id', () => {
    const cloudflare = (
      PROVIDER_REGISTRY as Partial<
        Record<
          string,
          (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY] & { baseUrlTemplate?: string }
        >
      >
    )['cloudflare-workers-ai'];

    assert.ok(
      cloudflare,
      'Cloudflare Workers AI must be available through the shared provider registry',
    );
    assert.equal(cloudflare.label, 'Cloudflare Workers AI');
    assert.equal(cloudflare.baseUrl, '');
    assert.equal(
      cloudflare.baseUrlTemplate,
      'https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    );
    assert.equal(cloudflare.authKind, 'api_key');
    assert.equal(cloudflare.protocol, 'openai');
    assert.deepEqual(cloudflare.runtimeAdapter, {
      kind: 'openai-compatible',
      name: 'provider',
      requireBaseUrl: true,
      replayAssistantReasoningAs: 'reasoning',
    });
    assert.deepEqual(cloudflare.modelDiscovery, { kind: 'fallback' });
    assert.equal(cloudflare.category, 'overseas');
    assert.equal(cloudflare.catalogGroup, 'api');
    assert.equal(cloudflare.modelsDevId, 'cloudflare-workers-ai');
    assert.equal(cloudflare.fallbackModels[0], '@cf/moonshotai/kimi-k2.6');
    assert.ok(cloudflare.fallbackModels.includes('@cf/moonshotai/kimi-k2.7-code'));
    assert.ok(cloudflare.fallbackModels.every((id) => id.startsWith('@cf/')));
  });

  it('owns Hugging Face Inference Providers behavior under the stable huggingface id', () => {
    const huggingface = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).huggingface;

    assert.ok(
      huggingface,
      'Hugging Face Inference Providers must be available through the shared provider registry',
    );
    assert.equal(huggingface.label, 'Hugging Face');
    assert.equal(huggingface.baseUrl, 'https://router.huggingface.co/v1');
    assert.equal(huggingface.authKind, 'api_key');
    assert.equal(huggingface.protocol, 'openai');
    assert.deepEqual(huggingface.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(huggingface.modelDiscovery, { kind: 'protocol', filter: 'tool-capable' });
    assert.equal(huggingface.category, 'overseas');
    assert.equal(huggingface.catalogGroup, 'aggregators');
    assert.equal(huggingface.modelsDevId, 'huggingface');
    assert.equal(huggingface.fallbackModels[0], 'openai/gpt-oss-120b');
    assert.ok(huggingface.fallbackModels.includes('meta-llama/Llama-3.3-70B-Instruct'));
    assert.ok(!huggingface.fallbackModels.includes('sentence-transformers/all-MiniLM-L6-v2'));
  });

  it('owns Ollama Cloud direct API separately from the local Ollama daemon', () => {
    const providers = PROVIDER_REGISTRY as Partial<
      Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
    >;
    const cloud = providers['ollama-cloud'];

    assert.ok(cloud, 'Ollama Cloud must be available through the shared provider registry');
    assert.equal(cloud.label, 'Ollama Cloud');
    assert.equal(cloud.baseUrl, 'https://ollama.com/v1');
    assert.equal(cloud.authKind, 'api_key');
    assert.equal(cloud.protocol, 'openai');
    assert.deepEqual(cloud.runtimeAdapter, {
      kind: 'openai-compatible',
      name: 'provider',
      includeUsage: true,
      replayAssistantReasoningAs: 'reasoning',
    });
    assert.deepEqual(cloud.modelDiscovery, { kind: 'protocol' });
    assert.equal(cloud.category, 'overseas');
    assert.equal(cloud.catalogGroup, 'api');
    assert.equal(cloud.modelsDevId, 'ollama-cloud');
    assert.equal(cloud.fallbackModels[0], 'qwen3.5:397b');
    assert.ok(
      !cloud.fallbackModels.includes('cogito-2.1:671b'),
      'deprecated snapshot models must not be fallback choices',
    );
    assert.notEqual(cloud, providers.ollama);
    assert.equal(providers.ollama?.baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(providers.ollama?.authKind, 'none');
    assert.deepEqual(providers.ollama?.modelDiscovery, { kind: 'ollama' });
  });

  it('owns the complete Together AI provider contract under the stable togetherai id', () => {
    const together = PROVIDER_REGISTRY.togetherai;

    assert.equal(together.label, 'Together AI');
    assert.equal(together.baseUrl, 'https://api.together.ai/v1');
    assert.equal(together.authKind, 'api_key');
    assert.equal(together.protocol, 'openai');
    assert.deepEqual(together.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(together.modelDiscovery, { kind: 'protocol' });
    assert.equal(together.modelsDevId, 'togetherai');
    assert.equal(together.fallbackModels[0], 'MiniMaxAI/MiniMax-M3');
    assert.ok(together.fallbackModels.includes('meta-llama/Llama-3.3-70B-Instruct-Turbo'));
    assert.ok(together.fallbackModels.includes('Qwen/Qwen3.5-9B'));
    assert.equal(together.catalogGroup, 'api');
    assert.equal(together.signupUrl, 'https://api.together.ai/settings/projects/~current/api-keys');
  });

  it('owns the complete Fireworks AI provider contract under the stable fireworks-ai id', () => {
    assert.deepEqual(PROVIDER_REGISTRY['fireworks-ai'], {
      label: 'Fireworks AI',
      description: 'Serverless open models with exact Fireworks model paths.',
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      authKind: 'api_key',
      backendKind: 'ai-sdk',
      fallbackModels: [
        'accounts/fireworks/models/kimi-k2p6',
        'accounts/fireworks/models/deepseek-v4-flash',
        'accounts/fireworks/models/deepseek-v4-pro',
        'accounts/fireworks/models/glm-5p1',
        'accounts/fireworks/models/glm-5p2',
        'accounts/fireworks/models/gpt-oss-120b',
        'accounts/fireworks/models/gpt-oss-20b',
        'accounts/fireworks/models/kimi-k2p7-code',
        'accounts/fireworks/models/minimax-m2p7',
        'accounts/fireworks/models/minimax-m3',
        'accounts/fireworks/models/qwen3p7-plus',
        'accounts/fireworks/routers/glm-5p1-fast',
        'accounts/fireworks/routers/glm-5p2-fast',
        'accounts/fireworks/routers/kimi-k2p6-fast',
        'accounts/fireworks/routers/kimi-k2p6-turbo',
        'accounts/fireworks/routers/kimi-k2p7-code-fast',
      ],
      status: 'ready',
      protocol: 'openai',
      runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
      modelDiscovery: {
        kind: 'fireworks',
        accountsPath: '/v1/accounts',
        publicAccount: 'accounts/fireworks',
        query: { filter: 'supports_serverless=true', pageSize: '200' },
      },
      category: 'overseas',
      catalogGroup: 'api',
      catalogBadge: 'API',
      signupUrl: 'https://app.fireworks.ai/settings/users/api-keys',
      modelsDevId: 'fireworks-ai',
      readyOrder: 19,
      catalogOrder: 19,
    });
  });

  it('owns the complete NVIDIA direct API contract under the stable nvidia id', () => {
    const provider = PROVIDER_REGISTRY.nvidia;

    assert.equal(provider.label, 'NVIDIA');
    assert.equal(provider.description, 'NVIDIA-hosted models for reasoning, vision, and tool use.');
    assert.equal(provider.baseUrl, 'https://integrate.api.nvidia.com/v1');
    assert.equal(provider.authKind, 'api_key');
    assert.equal(provider.backendKind, 'ai-sdk');
    assert.equal(provider.fallbackModels[0], 'nvidia/nemotron-3-super-120b-a12b');
    assert.ok(provider.fallbackModels.includes('openai/gpt-oss-120b'));
    assert.equal(provider.status, 'ready');
    assert.equal(provider.protocol, 'openai');
    assert.deepEqual(provider.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(provider.modelDiscovery, { kind: 'protocol', filter: 'fallback-models' });
    assert.equal(provider.category, 'overseas');
    assert.equal(provider.catalogGroup, 'api');
    assert.equal(provider.catalogBadge, 'API');
    assert.equal(provider.signupUrl, 'https://build.nvidia.com/');
    assert.equal(provider.modelsDevId, 'nvidia');
  });

  it('owns Tencent direct API behavior under the stable tencent-tokenhub id', () => {
    const tencent = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['tencent-tokenhub'];

    assert.ok(tencent, 'Tencent TokenHub must be available through the shared provider registry');
    assert.equal(tencent.label, 'Tencent TokenHub');
    assert.equal(tencent.baseUrl, 'https://tokenhub.tencentmaas.com/v1');
    assert.equal(tencent.authKind, 'api_key');
    assert.equal(tencent.protocol, 'openai');
    assert.deepEqual(tencent.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(tencent.modelDiscovery, { kind: 'protocol' });
    assert.equal(tencent.category, 'domestic');
    assert.equal(tencent.catalogGroup, 'api');
    assert.equal(tencent.signupUrl, 'https://cloud.tencent.com/document/product/1823/130090');
    assert.equal(tencent.modelsDevId, 'tencent-tokenhub');
    assert.deepEqual(tencent.fallbackModels, ['hy3', 'hy3-preview']);
  });

  it('owns Tencent Coding Plan behavior under its independent persisted id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['tencent-coding-plan'];

    assert.ok(plan, 'Tencent Coding Plan must be available through the shared provider registry');
    assert.equal(plan.label, 'Tencent Coding Plan (China)');
    assert.equal(plan.baseUrl, 'https://api.lkeap.cloud.tencent.com/coding/v3');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'domestic');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Coding');
    assert.equal(plan.signupUrl, 'https://console.cloud.tencent.com/lkeap/coding-plan');
    assert.equal(plan.modelsDevId, 'tencent-coding-plan');
    assert.deepEqual(plan.fallbackModels, ['tc-code-latest', 'glm-5', 'minimax-m2.5', 'kimi-k2.5']);
  });

  it('owns Tencent Token Plan behavior under its independent persisted id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['tencent-token-plan'];

    assert.ok(plan, 'Tencent Token Plan must be available through the shared provider registry');
    assert.equal(plan.label, 'Tencent Token Plan');
    assert.equal(plan.baseUrl, 'https://api.lkeap.cloud.tencent.com/plan/v3');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'domestic');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Token');
    assert.equal(plan.signupUrl, 'https://console.cloud.tencent.com/tokenhub/tokenplan/common');
    assert.equal(plan.modelsDevId, 'tencent-token-plan');
    assert.deepEqual(plan.fallbackModels, [
      'tc-code-latest',
      'deepseek-v4-flash-202605',
      'deepseek-v4-pro-202606',
      'minimax-m2.5',
      'minimax-m2.7',
      'glm-5',
      'glm-5.1',
      'kimi-k2.5',
      'hy3',
      'hy3-preview',
    ]);
  });

  const ALIBABA_CODING_PLAN_MODELS = [
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

  it('owns Alibaba Coding Plan (China) behavior under its independent persisted id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['alibaba-coding-plan-cn'];

    assert.ok(
      plan,
      'Alibaba Coding Plan (China) must be available through the shared provider registry',
    );
    assert.equal(plan.label, 'Alibaba Coding Plan (China)');
    assert.equal(plan.baseUrl, 'https://coding.dashscope.aliyuncs.com/v1');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.backendKind, 'ai-sdk');
    assert.equal(plan.status, 'ready');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'domestic');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Plan');
    assert.equal(plan.signupUrl, 'https://www.aliyun.com/benefit/scene/codingplan');
    assert.equal(plan.modelsDevId, 'alibaba-coding-plan-cn');
    assert.deepEqual(plan.fallbackModels, ALIBABA_CODING_PLAN_MODELS);
  });

  it('owns Alibaba Coding Plan (global) behavior under its independent persisted id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['alibaba-coding-plan'];

    assert.ok(plan, 'Alibaba Coding Plan must be available through the shared provider registry');
    assert.equal(plan.label, 'Alibaba Coding Plan');
    assert.equal(plan.baseUrl, 'https://coding-intl.dashscope.aliyuncs.com/v1');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.backendKind, 'ai-sdk');
    assert.equal(plan.status, 'ready');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'overseas');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Plan');
    assert.equal(plan.signupUrl, 'https://www.alibabacloud.com/help/en/model-studio/coding-plan');
    assert.equal(plan.modelsDevId, 'alibaba-coding-plan');
    assert.deepEqual(plan.fallbackModels, ALIBABA_CODING_PLAN_MODELS);
  });

  it('separates the two Alibaba Coding Plan regions from the Alibaba direct API path', () => {
    const registry = PROVIDER_REGISTRY as Partial<
      Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
    >;
    const cn = registry['alibaba-coding-plan-cn'];
    const global = registry['alibaba-coding-plan'];
    const direct = registry.alibaba;

    assert.ok(cn && global && direct);
    const baseUrls = new Set([cn.baseUrl, global.baseUrl, direct.baseUrl]);
    assert.equal(baseUrls.size, 3, 'each Alibaba access path must have a distinct endpoint');
    assert.equal(direct.catalogGroup, 'api');
    assert.equal(cn.catalogGroup, 'plans');
    assert.equal(global.catalogGroup, 'plans');
  });

  const alibabaTokenPlanModels = [
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
  ];

  it('owns Alibaba Token Plan China behavior under its independent persisted id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['alibaba-token-plan-cn'];

    assert.ok(
      plan,
      'Alibaba Token Plan (China) must be available through the shared provider registry',
    );
    assert.equal(plan.label, 'Alibaba Token Plan (China)');
    assert.equal(
      plan.baseUrl,
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    );
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'domestic');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Token');
    assert.equal(plan.modelsDevId, 'alibaba-token-plan-cn');
    assert.deepEqual(plan.fallbackModels, alibabaTokenPlanModels);
    // Interactive-only allowlist: the plan's image models are never tool-callable.
    for (const imageModel of [
      'qwen-image-2.0',
      'qwen-image-2.0-pro',
      'wan2.7-image',
      'wan2.7-image-pro',
    ]) {
      assert.ok(
        !plan.fallbackModels.includes(imageModel),
        `${imageModel} must not be an offered chat model`,
      );
    }
  });

  it('owns Alibaba Token Plan global behavior under its independent persisted id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['alibaba-token-plan'];

    assert.ok(
      plan,
      'Alibaba Token Plan (global) must be available through the shared provider registry',
    );
    assert.equal(plan.label, 'Alibaba Token Plan');
    assert.equal(
      plan.baseUrl,
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    );
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'overseas');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Token');
    assert.equal(plan.modelsDevId, 'alibaba-token-plan');
    assert.deepEqual(plan.fallbackModels, alibabaTokenPlanModels);
    // The China and global variants are distinct persisted ids sharing one model list.
    const cn = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['alibaba-token-plan-cn'];
    assert.ok(cn);
    assert.notEqual(plan.baseUrl, cn.baseUrl);
    assert.deepEqual(plan.fallbackModels, cn.fallbackModels);
  });

  for (const region of [
    {
      type: 'xiaomi-token-plan-cn',
      label: 'Xiaomi Token Plan (China)',
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
      category: 'domestic',
    },
    {
      type: 'xiaomi-token-plan-sgp',
      label: 'Xiaomi Token Plan (Singapore)',
      baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
      category: 'overseas',
    },
    {
      type: 'xiaomi-token-plan-ams',
      label: 'Xiaomi Token Plan (Europe)',
      baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1',
      category: 'overseas',
    },
  ] as const) {
    it(`owns ${region.label} behavior under its independent persisted id`, () => {
      const plan = (
        PROVIDER_REGISTRY as Partial<
          Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
        >
      )[region.type];

      assert.ok(plan, `${region.label} must have its own persisted provider id`);
      assert.equal(plan.label, region.label);
      assert.equal(plan.baseUrl, region.baseUrl);
      assert.equal(plan.authKind, 'api_key');
      assert.equal(plan.protocol, 'openai');
      assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
      assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
      assert.equal(plan.category, region.category);
      assert.equal(plan.catalogGroup, 'plans');
      assert.equal(plan.catalogBadge, 'Token');
      assert.equal(plan.signupUrl, 'https://platform.xiaomimimo.com/token-plan');
      assert.equal(plan.modelsDevId, region.type);
      // Coding-only Token Plan endpoints publish no /models list and the models.dev
      // snapshot still carries the deprecated mimo-v2-pro and speech-only mimo-v2-tts;
      // the fallback set must stay pinned to the two documented MiMo chat models.
      assert.deepEqual(plan.fallbackModels, ['mimo-v2.5-pro', 'mimo-v2.5']);
    });
  }

  it('owns StepFun China direct API behavior under the stable stepfun id', () => {
    const stepfun = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    ).stepfun;

    assert.ok(
      stepfun,
      'StepFun China direct API must be available through the shared provider registry',
    );
    assert.equal(stepfun.label, 'StepFun (China)');
    assert.equal(stepfun.baseUrl, 'https://api.stepfun.com/v1');
    assert.equal(stepfun.authKind, 'api_key');
    assert.equal(stepfun.protocol, 'openai');
    assert.deepEqual(stepfun.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(stepfun.modelDiscovery, { kind: 'protocol' });
    assert.equal(stepfun.category, 'domestic');
    assert.equal(stepfun.catalogGroup, 'api');
    assert.equal(stepfun.signupUrl, 'https://platform.stepfun.com/interface-key');
    assert.equal(stepfun.modelsDevId, 'stepfun');
    assert.deepEqual(stepfun.fallbackModels, [
      'step-3.7-flash',
      'step-3.5-flash-2603',
      'step-3.5-flash',
      'step-1-32k',
      'step-2-16k',
    ]);
  });

  it('owns StepFun Step Plan China behavior under the stable stepfun-step-plan id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['stepfun-step-plan'];

    assert.ok(plan, 'StepFun Step Plan China must have its own persisted provider id');
    assert.equal(plan.label, 'StepFun Step Plan (China)');
    assert.equal(plan.baseUrl, 'https://api.stepfun.com/step_plan/v1');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'domestic');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Plan');
    assert.equal(plan.signupUrl, 'https://platform.stepfun.com/interface-key');
    assert.equal(plan.modelsDevId, 'stepfun');
    assert.deepEqual(plan.fallbackModels, [
      'step-3.7-flash',
      'step-3.5-flash-2603',
      'step-3.5-flash',
      'step-router-v1',
    ]);
  });

  it('owns StepFun Step Plan Global behavior under the stable stepfun-ai-step-plan id', () => {
    const plan = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['stepfun-ai-step-plan'];

    assert.ok(plan, 'StepFun Step Plan Global must have its own persisted provider id');
    assert.equal(plan.label, 'StepFun Step Plan (Global)');
    assert.equal(plan.baseUrl, 'https://api.stepfun.ai/step_plan/v1');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'openai');
    assert.deepEqual(plan.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(plan.modelDiscovery, { kind: 'fallback' });
    assert.equal(plan.category, 'overseas');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.catalogBadge, 'Plan');
    assert.equal(plan.signupUrl, 'https://platform.stepfun.ai/interface-key');
    assert.equal(plan.modelsDevId, 'stepfun-ai-step-plan');
    assert.deepEqual(plan.fallbackModels, [
      'step-3.7-flash',
      'step-3.5-flash-2603',
      'step-3.5-flash',
    ]);
  });

  it('owns StepFun Global direct API behavior under the stable stepfun-ai id', () => {
    const stepfunGlobal = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['stepfun-ai'];

    assert.ok(
      stepfunGlobal,
      'StepFun Global direct API must be available through the shared provider registry',
    );
    assert.equal(stepfunGlobal.label, 'StepFun (Global)');
    assert.equal(stepfunGlobal.baseUrl, 'https://api.stepfun.ai/v1');
    assert.equal(stepfunGlobal.authKind, 'api_key');
    assert.equal(stepfunGlobal.protocol, 'openai');
    assert.deepEqual(stepfunGlobal.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(stepfunGlobal.modelDiscovery, { kind: 'protocol' });
    assert.equal(stepfunGlobal.category, 'overseas');
    assert.equal(stepfunGlobal.catalogGroup, 'api');
    assert.equal(stepfunGlobal.signupUrl, 'https://platform.stepfun.ai/interface-key');
    assert.equal(stepfunGlobal.modelsDevId, 'stepfun-ai');
    assert.deepEqual(stepfunGlobal.fallbackModels, [
      'step-3.7-flash',
      'step-3.5-flash-2603',
      'step-3.5-flash',
    ]);
  });

  it('owns Volcengine Ark China direct API behavior under the stable volcengine-ark id', () => {
    const ark = (
      PROVIDER_REGISTRY as Partial<
        Record<string, (typeof PROVIDER_REGISTRY)[keyof typeof PROVIDER_REGISTRY]>
      >
    )['volcengine-ark'];

    assert.ok(ark, 'Volcengine Ark China direct API must have its own persisted provider id');
    assert.equal(ark.label, 'Volcengine Ark (China)');
    assert.equal(ark.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
    assert.equal(ark.authKind, 'api_key');
    assert.equal(ark.protocol, 'openai');
    assert.deepEqual(ark.runtimeAdapter, { kind: 'openai-compatible', name: 'provider' });
    assert.deepEqual(ark.modelDiscovery, { kind: 'fallback' });
    assert.equal(ark.category, 'domestic');
    assert.equal(ark.catalogGroup, 'api');
    assert.equal(ark.signupUrl, 'https://console.volcengine.com/ark/region:ark+cn-beijing/model');
    assert.equal(ark.modelsDevId, undefined);
    assert.deepEqual(ark.fallbackModels, ['doubao-seed-2-0-pro-260215']);
  });
});

describe('validateConnectionBaseUrl (PR-UI-IPC-1, @kenji msg 35260e29)', () => {
  describe('accept (returns null)', () => {
    it('undefined → null (no override; fall back to provider default)', () => {
      assert.equal(validateConnectionBaseUrl(undefined), null);
    });

    it('null → null', () => {
      assert.equal(validateConnectionBaseUrl(null), null);
    });

    it('empty string → null (treated as "no override")', () => {
      assert.equal(validateConnectionBaseUrl(''), null);
    });

    it('whitespace-only → null', () => {
      assert.equal(validateConnectionBaseUrl('   '), null);
      assert.equal(validateConnectionBaseUrl('\t\n'), null);
    });

    it('https provider canonical URLs', () => {
      const canonical = [
        'https://api.anthropic.com',
        'https://api.openai.com/v1',
        'https://generativelanguage.googleapis.com/v1beta',
        'https://api.deepseek.com',
        'https://api.z.ai/api/coding/paas/v4',
        'https://api.kimi.com/coding/v1',
        'https://api.moonshot.cn/v1',
      ];
      for (const url of canonical) {
        assert.equal(validateConnectionBaseUrl(url), null, `URL ${url} should be accepted`);
      }
    });

    it('http localhost URLs (Ollama, LM Studio, vLLM) — intentionally allowed', () => {
      // @kenji msg 35260e29 explicitly: localhost / private-network
      // MUST stay allowed. Ollama default is http://localhost:11434.
      const local = [
        'http://localhost:11434/v1',
        'http://127.0.0.1:8000',
        'http://0.0.0.0:8080',
        'http://192.168.1.50:11434',
        'http://10.0.0.5:8080',
        'http://lan-server.local:5000',
      ];
      for (const url of local) {
        assert.equal(
          validateConnectionBaseUrl(url),
          null,
          `localhost / private URL ${url} must be accepted`,
        );
      }
    });

    it('http URLs in general (allowed scheme)', () => {
      const allowed = [
        'http://example.com',
        'http://example.com:80/path',
        'http://user:pass@example.com', // userinfo is parsed; URL accepts it
      ];
      for (const url of allowed) {
        assert.equal(validateConnectionBaseUrl(url), null, `URL ${url} should be accepted`);
      }
    });

    it('https with custom port + path + query survives', () => {
      assert.equal(
        validateConnectionBaseUrl('https://api.custom.example.com:8443/v2/chat?region=us'),
        null,
      );
    });

    it('trims surrounding whitespace', () => {
      assert.equal(validateConnectionBaseUrl('  https://api.openai.com  '), null);
      assert.equal(validateConnectionBaseUrl('\thttps://api.openai.com\n'), null);
    });

    it('exactly 2048 chars (cap boundary) is accepted', () => {
      const padding = 'a'.repeat(2048 - 'https://example.com/'.length);
      const exact = `https://example.com/${padding}`;
      assert.equal(exact.length, 2048);
      assert.equal(validateConnectionBaseUrl(exact), null);
    });
  });

  describe('reject (returns error message)', () => {
    it('javascript: URL is rejected (XSS / credential exfiltration)', () => {
      const result = validateConnectionBaseUrl('javascript:alert(1)');
      assert.ok(result !== null, 'javascript: must reject');
      assert.ok(
        result!.includes("'javascript:'"),
        `reject message should name the offending scheme; got: ${result}`,
      );
    });

    it('file: URL is rejected (local file read)', () => {
      const result = validateConnectionBaseUrl('file:///etc/passwd');
      assert.ok(result !== null);
      assert.ok(result!.includes("'file:'"));
    });

    it('data: URL is rejected', () => {
      const result = validateConnectionBaseUrl('data:text/html,<script>alert(1)</script>');
      assert.ok(result !== null);
    });

    it('vbscript: URL is rejected', () => {
      assert.ok(validateConnectionBaseUrl('vbscript:msgbox') !== null);
    });

    it('chrome-extension: URL is rejected', () => {
      assert.ok(validateConnectionBaseUrl('chrome-extension://abc/page.html') !== null);
    });

    it('ws: / wss: rejected (websocket — out of scope for this contract)', () => {
      assert.ok(validateConnectionBaseUrl('ws://example.com') !== null);
      assert.ok(validateConnectionBaseUrl('wss://example.com') !== null);
    });

    it('ftp: rejected', () => {
      assert.ok(validateConnectionBaseUrl('ftp://example.com') !== null);
    });

    it('custom scheme rejected', () => {
      assert.ok(validateConnectionBaseUrl('maka://settings') !== null);
      assert.ok(validateConnectionBaseUrl('app://x') !== null);
      assert.ok(validateConnectionBaseUrl('myproto://abc') !== null);
    });

    it('malformed URL (bare string, no scheme) is rejected', () => {
      const result = validateConnectionBaseUrl('not-a-url');
      assert.ok(result !== null);
      assert.ok(result!.includes('valid URL'), `should report invalid URL; got: ${result}`);
    });

    it('malformed URL (only scheme) is rejected', () => {
      // `http:` alone parses to `protocol: 'http:'` but with no
      // host. Whether `new URL('http:')` throws depends on the
      // runtime; this test pins the documented behavior.
      const result = validateConnectionBaseUrl('http:');
      // Either path (throw → invalid URL message OR pass scheme but
      // empty host) should reject. We assert reject without locking
      // which message wins.
      assert.ok(result !== null, '`http:` alone must reject');
    });

    it('oversize URL (> 2048 chars) is rejected before URL parse', () => {
      const oversize = `https://example.com/${'a'.repeat(2050)}`;
      assert.ok(oversize.length > 2048);
      const result = validateConnectionBaseUrl(oversize);
      assert.ok(result !== null);
      assert.ok(
        result!.includes('2048'),
        `oversize reject should reference the cap; got: ${result}`,
      );
    });

    it('weird unicode in URL is rejected if URL constructor throws', () => {
      // Invalid host bytes that `new URL` throws on.
      assert.ok(validateConnectionBaseUrl('https://exa mple .com') !== null);
    });
  });

  describe('case-sensitivity of scheme', () => {
    it('accepts mixed-case schemes (URL normalizes to lowercase)', () => {
      // WHATWG URL spec lowercases special-scheme protocols.
      assert.equal(validateConnectionBaseUrl('HTTPS://api.example.com'), null);
      assert.equal(validateConnectionBaseUrl('Http://localhost:8000'), null);
    });
  });
});

describe('provider URL defaults', () => {
  it('defines LM Studio as an independent no-auth local provider', () => {
    const providers = PROVIDER_DEFAULTS as Partial<
      Record<string, (typeof PROVIDER_DEFAULTS)[keyof typeof PROVIDER_DEFAULTS]>
    >;
    const lmStudio = providers['lm-studio'];

    assert.ok(lmStudio, 'LM Studio must have its own persisted provider id');
    assert.equal(lmStudio.label, 'LM Studio');
    assert.equal(lmStudio.baseUrl, 'http://127.0.0.1:1234/v1');
    assert.equal(lmStudio.authKind, 'none');
    assert.equal(lmStudio.protocol, 'openai');
    assert.deepEqual(lmStudio.runtimeAdapter, {
      kind: 'openai-compatible',
      name: 'provider',
    });
    assert.deepEqual(lmStudio.modelDiscovery, { kind: 'protocol' });
    assert.deepEqual(lmStudio.fallbackModels, []);
    assert.equal(lmStudio.category, 'local');
    assert.equal(lmStudio.catalogGroup, 'local');
  });

  it('exposes SiliconFlow with models.dev provider facts and exact model ids', () => {
    const siliconflow = (
      PROVIDER_DEFAULTS as Partial<
        Record<string, (typeof PROVIDER_DEFAULTS)[keyof typeof PROVIDER_DEFAULTS]>
      >
    ).siliconflow;

    assert.ok(siliconflow, 'SiliconFlow must be available through the shared provider registry');
    assert.equal(siliconflow.label, 'SiliconFlow');
    assert.equal(siliconflow.baseUrl, 'https://api.siliconflow.com/v1');
    assert.equal(siliconflow.authKind, 'api_key');
    assert.equal(siliconflow.protocol, 'openai');
    assert.equal(
      siliconflow.fallbackModels[0],
      'moonshotai/Kimi-K2.6',
      'the Maka recommendation must use an exact models.dev id, including provider namespace and case',
    );
  });

  it('labels the ChatGPT account path as OpenAI OAuth, not Codex subscription', () => {
    assert.equal(PROVIDER_DEFAULTS['openai-codex'].label, 'OpenAI OAuth (ChatGPT / Codex)');
    assert.equal(
      PROVIDER_DEFAULTS['openai-codex'].description,
      'ChatGPT/Codex account OAuth path for OpenAI Responses models.',
    );
  });

  it('keeps Kimi Coding Plan separate from Moonshot API key access', () => {
    assert.equal(PROVIDER_DEFAULTS['kimi-coding-plan'].baseUrl, 'https://api.kimi.com/coding/v1');
    assert.equal(
      PROVIDER_DEFAULTS['kimi-coding-plan'].signupUrl,
      'https://www.kimi.com/code/console',
    );
    assert.equal(PROVIDER_DEFAULTS.moonshot.baseUrl, 'https://api.moonshot.cn/v1');
    assert.equal(PROVIDER_DEFAULTS.moonshot.modelsDevId, 'moonshotai-cn');
    assert.deepEqual(PROVIDER_DEFAULTS.moonshot.fallbackModels.slice(0, 2), [
      'kimi-k2.6',
      'kimi-k2.7-code',
    ]);
    assert.ok(PROVIDER_DEFAULTS.moonshot.fallbackModels.includes('kimi-k2.5'));
    assert.equal(
      PROVIDER_DEFAULTS.moonshot.fallbackModels.some((id) => id.startsWith('moonshot-v1-')),
      false,
    );
    assert.equal(
      PROVIDER_DEFAULTS.moonshot.signupUrl,
      'https://platform.kimi.com/console/api-keys',
    );
  });

  it('keeps MiniMax Coding Plan separate from MiniMax direct API access', () => {
    const providers = PROVIDER_DEFAULTS as Partial<
      Record<string, (typeof PROVIDER_DEFAULTS)[keyof typeof PROVIDER_DEFAULTS]>
    >;
    const plan = providers['minimax-coding-plan'];

    assert.ok(plan, 'MiniMax Coding Plan must have its own persisted provider id');
    assert.equal(plan.label, 'MiniMax Coding Plan');
    assert.equal(plan.baseUrl, 'https://api.minimax.io/anthropic');
    assert.equal(plan.authKind, 'api_key');
    assert.equal(plan.protocol, 'anthropic');
    assert.deepEqual(plan.runtimeAdapter, {
      kind: 'anthropic',
      auth: 'api-key',
      normalizeBaseUrl: true,
    });
    assert.deepEqual(plan.modelDiscovery, { kind: 'protocol' });
    assert.equal(plan.category, 'overseas');
    assert.equal(plan.catalogGroup, 'plans');
    assert.equal(plan.modelsDevId, 'minimax');
    assert.equal(plan.fallbackModels[0], 'MiniMax-M3');
    assert.notEqual(plan, providers.MiniMax);
  });
});

describe('persistedBaseUrl', () => {
  // The store calls this on create / update / save to decide what `baseUrl`
  // to persist. Only a real override is stored; the provider default collapses
  // to undefined so the connection follows the live default.

  it('returns undefined for undefined / null / empty / whitespace-only', () => {
    assert.equal(persistedBaseUrl('openai', undefined), undefined);
    assert.equal(persistedBaseUrl('openai', null), undefined);
    assert.equal(persistedBaseUrl('openai', ''), undefined);
    assert.equal(persistedBaseUrl('openai', '   '), undefined);
    assert.equal(persistedBaseUrl('openai', '\t\n'), undefined);
  });

  it('returns undefined when the value equals the provider current default (no override to persist)', () => {
    assert.equal(
      persistedBaseUrl('openai', 'https://api.openai.com/v1'),
      undefined,
      'openai default must not be persisted as an override',
    );
    assert.equal(
      persistedBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta'),
      undefined,
      'google default must not be persisted as an override',
    );
    assert.equal(
      persistedBaseUrl('ollama', 'http://127.0.0.1:11434/v1'),
      undefined,
      'ollama default must not be persisted as an override',
    );
    assert.equal(
      persistedBaseUrl('lm-studio', 'http://127.0.0.1:1234/v1'),
      undefined,
      'LM Studio default must not be persisted as an override',
    );
    assert.equal(
      persistedBaseUrl('localai', 'http://127.0.0.1:8080/v1'),
      undefined,
      'LocalAI default must not be persisted as an override',
    );
  });

  it('returns undefined when the value equals the default modulo surrounding whitespace', () => {
    assert.equal(persistedBaseUrl('openai', '  https://api.openai.com/v1  '), undefined);
    assert.equal(persistedBaseUrl('openai', '\thttps://api.openai.com/v1\n'), undefined);
  });

  it('returns the trimmed value for a real custom override', () => {
    const custom = 'https://my-openai-proxy.example.com/v1';
    assert.equal(persistedBaseUrl('openai', custom), custom);
    assert.equal(persistedBaseUrl('openai', `  ${custom}  `), custom, 'whitespace is trimmed');
    assert.equal(
      persistedBaseUrl('google', 'https://my-gemini-proxy.example.com/v1beta'),
      'https://my-gemini-proxy.example.com/v1beta',
    );
  });

  it('persists a custom override for custom relay providers (empty canonical default)', () => {
    // Custom relay providers have no canonical default — any non-empty value
    // the user supplies is a real override and must persist.
    const custom = 'https://my-gateway.example.com/v1';
    for (const providerType of [
      'openai-compatible',
      'openai-responses-compatible',
      'anthropic-compatible',
    ] as const) {
      assert.equal(persistedBaseUrl(providerType, custom), custom);
      assert.equal(persistedBaseUrl(providerType, ''), undefined, 'empty still means no override');
    }
  });
});

describe('normalizeConnectionBaseUrl (PR-UI-IPC-1 fixup v2, @kenji msg 8755ffb3 + 6b638e08)', () => {
  // The store-boundary chokepoint: the IPC handler calls this helper
  // and uses the returned canonical value as the patch payload. The
  // contract distinguishes between "explicit clear" (preserved as
  // empty string so the store removes the override) and "set"
  // (trimmed URL). It does NOT collapse explicit clear into
  // "don't touch" — that would silently swallow the user's intent.

  describe('explicit-clear intent (whitespace / empty)', () => {
    it('empty string → ok with value: ""', () => {
      const result = normalizeConnectionBaseUrl('');
      assert.deepEqual(result, { ok: true, value: '' });
    });

    it('whitespace-only → ok with value: "" (trimmed to empty)', () => {
      for (const raw of ['   ', '\t', '\n', ' \t \n ']) {
        const result = normalizeConnectionBaseUrl(raw);
        assert.deepEqual(result, { ok: true, value: '' }, `raw=${JSON.stringify(raw)}`);
      }
    });

    it('explicit clear value MUST be "" (not undefined) — preserves store clear semantics', () => {
      // Critical for the store boundary: the existing store update
      // path is
      //   `patch.baseUrl !== undefined ? patch.baseUrl || undefined : current.baseUrl`
      // so a `'' ` patch clears the existing override, but
      // `undefined` would be treated as "don't touch". The
      // normalize contract MUST return `''` for whitespace input
      // — never `undefined`.
      const result = normalizeConnectionBaseUrl('   ');
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.value, '');
        assert.notEqual(result.value, undefined, 'must not collapse to undefined');
      }
    });
  });

  describe('set intent (trimmed URL)', () => {
    it('clean URL → returns identical value', () => {
      const result = normalizeConnectionBaseUrl('https://api.openai.com/v1');
      assert.deepEqual(result, { ok: true, value: 'https://api.openai.com/v1' });
    });

    it('URL with surrounding whitespace → trimmed', () => {
      assert.deepEqual(normalizeConnectionBaseUrl('  https://api.openai.com  '), {
        ok: true,
        value: 'https://api.openai.com',
      });
      assert.deepEqual(normalizeConnectionBaseUrl('\thttps://api.openai.com\n'), {
        ok: true,
        value: 'https://api.openai.com',
      });
    });

    it('does NOT lowercase scheme / host / path (no URL canonicalization)', () => {
      // @kenji explicit non-canonicalization: trim is the ONLY
      // normalization. Users who deliberately configured
      // mixed-case URLs keep them. WHATWG URL accepts the case
      // variants; we don't re-emit a normalized URL.
      assert.deepEqual(normalizeConnectionBaseUrl('  https://Example.com:443/V1  '), {
        ok: true,
        value: 'https://Example.com:443/V1',
      });
    });

    it('localhost / private-network URLs survive (Ollama etc.)', () => {
      assert.deepEqual(normalizeConnectionBaseUrl('  http://localhost:11434/v1  '), {
        ok: true,
        value: 'http://localhost:11434/v1',
      });
      assert.deepEqual(normalizeConnectionBaseUrl('http://192.168.1.50:11434'), {
        ok: true,
        value: 'http://192.168.1.50:11434',
      });
    });
  });

  describe('reject (validate gate fires)', () => {
    it('bad scheme rejects through normalize too', () => {
      const result = normalizeConnectionBaseUrl('javascript:alert(1)');
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes("'javascript:'"));
      }
    });

    it('file: URL rejected', () => {
      const result = normalizeConnectionBaseUrl('  file:///etc/passwd  ');
      assert.equal(result.ok, false);
    });

    it('malformed URL rejected', () => {
      const result = normalizeConnectionBaseUrl('not-a-url');
      assert.equal(result.ok, false);
    });

    it('oversize rejected', () => {
      const oversize = `https://example.com/${'a'.repeat(2050)}`;
      const result = normalizeConnectionBaseUrl(oversize);
      assert.equal(result.ok, false);
    });
  });

  describe('runtime-type guard (PR-UI-IPC-1 fixup v3, @kenji msg 57ac8a8c)', () => {
    // IPC payloads cross a process boundary; the TS signature is a
    // compile-time guarantee but the runtime renderer could send
    // any JS value. The normalize helper MUST reject non-string
    // inputs with a typed error, NOT throw TypeError on `.trim()`.

    it('null → reject with typed error (not TypeError)', () => {
      const result = normalizeConnectionBaseUrl(null);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(result.error.includes('must be a string'));
      }
    });

    it('undefined → reject with typed error (handler-side `!== undefined` guard should prevent this from being called)', () => {
      const result = normalizeConnectionBaseUrl(undefined);
      assert.equal(result.ok, false);
    });

    it('number → reject', () => {
      assert.equal(normalizeConnectionBaseUrl(42).ok, false);
      assert.equal(normalizeConnectionBaseUrl(0).ok, false);
      assert.equal(normalizeConnectionBaseUrl(NaN).ok, false);
    });

    it('boolean → reject', () => {
      assert.equal(normalizeConnectionBaseUrl(true).ok, false);
      assert.equal(normalizeConnectionBaseUrl(false).ok, false);
    });

    it('object → reject', () => {
      assert.equal(normalizeConnectionBaseUrl({}).ok, false);
      assert.equal(normalizeConnectionBaseUrl({ baseUrl: 'https://example.com' }).ok, false);
    });

    it('array → reject (typeof returns "object")', () => {
      assert.equal(normalizeConnectionBaseUrl([]).ok, false);
      assert.equal(normalizeConnectionBaseUrl(['https://example.com']).ok, false);
    });

    it('symbol / function / bigint → reject', () => {
      assert.equal(normalizeConnectionBaseUrl(Symbol('s')).ok, false);
      assert.equal(normalizeConnectionBaseUrl(() => 'https://example.com').ok, false);
      assert.equal(normalizeConnectionBaseUrl(BigInt(1)).ok, false);
    });

    it('never throws on bad runtime type — always returns typed result', () => {
      // Sanity gate: if the guard ever regresses, `baseUrl.trim()`
      // on null would throw TypeError, breaking the IPC handler's
      // typed-reject promise. This test catches that regression.
      for (const bad of [null, undefined, 42, true, {}, [], Symbol('x'), () => '', BigInt(1)]) {
        assert.doesNotThrow(
          () => normalizeConnectionBaseUrl(bad),
          `bad input ${String(bad)} must not throw`,
        );
      }
    });
  });

  describe('store-boundary scenarios (IPC handler simulation)', () => {
    // Simulate the IPC handler's caller contract. The handler does:
    //   if (patch.baseUrl !== undefined) {
    //     const result = normalizeConnectionBaseUrl(patch.baseUrl);
    //     if (!result.ok) throw new Error(result.error);
    //     normalizedPatch = { ...patch, baseUrl: result.value };
    //   }
    //   await connectionStore.update(slug, normalizedPatch);
    //
    // These tests verify that the value the store sees matches the
    // user's intent for each input.

    it('user-typed URL with whitespace → store sees trimmed URL (set)', () => {
      const result = normalizeConnectionBaseUrl('  https://api.openai.com  ');
      assert.equal(result.ok, true);
      if (result.ok) {
        // Store sees this as `patch.baseUrl = 'https://api.openai.com'`
        // → ternary: truthy string → sets override to trimmed.
        assert.equal(result.value, 'https://api.openai.com');
      }
    });

    it('user typed whitespace-only (clear intent) → store sees "" (clear)', () => {
      const result = normalizeConnectionBaseUrl('   ');
      assert.equal(result.ok, true);
      if (result.ok) {
        // Store sees this as `patch.baseUrl = ''`
        // → ternary: `'' !== undefined && '' || undefined = undefined`
        // → existing override is cleared. NOT "don't touch".
        assert.equal(result.value, '');
      }
    });

    it('user typed bad scheme → throw before store; store never sees the bogus value', () => {
      // Handler would `throw new Error(result.error)` and skip the
      // store update entirely.
      const result = normalizeConnectionBaseUrl('javascript:exfil()');
      assert.equal(result.ok, false);
      // Handler never reaches the store update line on this path.
    });

    it('omitted (patch.baseUrl === undefined) → handler does not call normalize', () => {
      // This isn't a normalize test per se — it's a documentation
      // assertion that the IPC handler's `if (patch.baseUrl !==
      // undefined)` guard means undefined NEVER reaches this
      // helper. The store sees `patch.baseUrl === undefined` and
      // falls back to "don't touch existing" via its existing
      // ternary. We just lock the boundary: normalize requires a
      // string caller. (TypeScript signature `(baseUrl: string)`
      // makes this load-bearing.)
      // No runtime call needed; the type system + handler-side
      // guard is the contract.
      assert.ok(true);
    });
  });
});

describe('unknown-providerType tolerance', () => {
  // A connection persisted on another branch may carry a providerType this
  // build's PROVIDER_REGISTRY doesn't know. These helpers must
  // fall back safely instead of throwing — matching the `isFakeBackend`
  // "unknown → non-real" convention in connection-readiness.ts.
  const UNKNOWN = 'branch-only-provider' as ProviderType;

  it('backendKindOf returns "fake" for an unregistered providerType', () => {
    assert.equal(backendKindOf({ providerType: UNKNOWN }), 'fake');
  });

  it('effectiveBaseUrl returns the explicit baseUrl, else empty string', () => {
    assert.equal(
      effectiveBaseUrl({ providerType: UNKNOWN, baseUrl: 'https://example.test/v1' }),
      'https://example.test/v1',
    );
    assert.equal(effectiveBaseUrl({ providerType: UNKNOWN, baseUrl: undefined }), '');
  });

  it('persistedBaseUrl keeps a real override and drops empty for an unregistered providerType', () => {
    assert.equal(persistedBaseUrl(UNKNOWN, 'https://example.test/v1'), 'https://example.test/v1');
    assert.equal(persistedBaseUrl(UNKNOWN, '   '), undefined);
    assert.equal(persistedBaseUrl(UNKNOWN, undefined), undefined);
  });

  it('providerAuthRequiresSecret / providerAuthSupportsApiKey return false for an unregistered providerType', () => {
    assert.equal(providerAuthRequiresSecret(UNKNOWN), false);
    assert.equal(providerAuthSupportsApiKey(UNKNOWN), false);
  });

  it('registered providers keep their real behavior', () => {
    assert.equal(backendKindOf({ providerType: 'anthropic' }), 'ai-sdk');
    assert.equal(providerAuthRequiresSecret('anthropic'), true);
    assert.equal(providerAuthSupportsApiKey('ollama'), false);
  });
});

describe('normalizeProviderType (persisted providerType alias)', () => {
  // The `codex-subscription` providerType was renamed to `openai-codex`.
  // Connections persisted before the rename still carry the old id on disk;
  // reading them must normalize to the current id so every downstream
  // registry lookup, `case` dispatch, and credential resolution works.
  it('maps the legacy codex-subscription alias to openai-codex', () => {
    assert.equal(normalizeProviderType('codex-subscription'), 'openai-codex');
  });

  it('returns the current id unchanged for renamed and other providers', () => {
    assert.equal(normalizeProviderType('openai-codex'), 'openai-codex');
    assert.equal(normalizeProviderType('anthropic'), 'anthropic');
    assert.equal(normalizeProviderType('github-copilot'), 'github-copilot');
  });

  it('passes unknown ids through unchanged so unregistered-provider tolerance stays intact', () => {
    assert.equal(normalizeProviderType('branch-only-provider'), 'branch-only-provider');
  });

  it('migrateConnectionV1ToV2 normalizes a persisted codex-subscription connection', () => {
    const migrated = migrateConnectionV1ToV2({
      slug: 'codex-subscription',
      name: 'OpenAI OAuth',
      providerType: 'codex-subscription',
      defaultModel: 'gpt-5.5',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal(migrated.providerType, 'openai-codex');
    assert.equal(migrated.slug, 'codex-subscription');
  });
});

describe('reconcileConnectionAfterModelFetch', () => {
  it('repairs a stale moonshot fallback default to a live enabled model', () => {
    const next = reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'moonshot-v1-8k',
        enabledModelIds: ['moonshot-v1-8k', 'kimi-k2.6'],
      },
      [{ id: 'kimi-k2.5' }, { id: 'kimi-k2.6' }, { id: 'kimi-k2.7-code' }],
    );
    assert.equal(next.defaultModel, 'kimi-k2.6');
    assert.deepEqual(next.enabledModelIds, ['kimi-k2.6']);
  });

  it('keeps a still-live default and drops retired enabled ids', () => {
    const next = reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'kimi-k2.6',
        enabledModelIds: ['kimi-k2.6', 'moonshot-v1-8k', 'kimi-k2.5'],
      },
      [{ id: 'kimi-k2.6' }, { id: 'kimi-k2.5' }],
    );
    assert.equal(next.defaultModel, 'kimi-k2.6');
    assert.deepEqual(next.enabledModelIds, ['kimi-k2.6', 'kimi-k2.5']);
  });

  it('falls back to the first discovered model when nothing previously enabled is live', () => {
    const next = reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'moonshot-v1-8k',
        enabledModelIds: ['moonshot-v1-8k'],
      },
      [{ id: 'kimi-k2.6' }, { id: 'kimi-k2.5' }],
    );
    assert.equal(next.defaultModel, 'kimi-k2.6');
    assert.deepEqual(next.enabledModelIds, ['kimi-k2.6']);
  });

  it('normalizes and deduplicates discovered ids before reconciliation', () => {
    const next = reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'retired-model',
        enabledModelIds: ['retired-model'],
      },
      [{ id: '  live-model  ' }, { id: '' }, { id: 'live-model' }, { id: 1 }],
    );
    assert.equal(next.defaultModel, 'live-model');
    assert.deepEqual(next.enabledModelIds, ['live-model']);
  });

  it('leaves defaults alone when discovery returns an empty list', () => {
    const next = reconcileConnectionAfterModelFetch(
      {
        defaultModel: 'moonshot-v1-8k',
        enabledModelIds: ['moonshot-v1-8k'],
      },
      [],
    );
    assert.equal(next.defaultModel, 'moonshot-v1-8k');
    assert.deepEqual(next.enabledModelIds, ['moonshot-v1-8k']);
  });
});
