import type { ModelInfo, ProviderType } from './llm-connections.js';
import type { ThinkingOptions } from './model-thinking.js';
import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES,
} from './model-metadata.generated.js';

export interface ModelMetadata {
  displayName?: string;
  lifecycle?: 'active' | 'deprecated' | 'retired';
  docsUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelInfo['capabilities'];
  /**
   * Per-model reasoning controls, mirroring models.dev `reasoning_options`.
   * Omitted on models with no declarable thinking knob (miss → no menu).
   */
  thinkingOptions?: ThinkingOptions;
}

const generatedMetadata: Partial<Record<ProviderType, Record<string, ModelMetadata>>> =
  GENERATED_MODELS_DEV_METADATA;
const generatedModelProviderOverrides: Partial<
  Record<ProviderType, Record<string, { npm: string; api?: string }>>
> = GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES;

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  const id = modelId.trim();
  const metadataProviderType = providerType === 'xai-oauth' ? 'xai' : providerType;
  const generated = generatedMetadata[metadataProviderType]?.[id];
  const override =
    STATIC_MODEL_METADATA[providerType]?.[id] ??
    (providerType === 'xai-oauth' ? STATIC_MODEL_METADATA.xai?.[id] : undefined);
  if (!generated) return override ?? {};
  if (!override) return generated;
  return {
    ...generated,
    ...override,
    capabilities: { ...generated.capabilities, ...override.capabilities },
  };
}

export function lookupModelProviderOverride(
  providerType: ProviderType,
  modelId: string,
): { npm: string; api?: string } | undefined {
  return generatedModelProviderOverrides[providerType]?.[modelId.trim()];
}

/**
 * The request wire a model served over the OpenAI adapter must use.
 *
 * OpenAI's `gpt-5*` families and xAI's `grok-4.5` are served only over the
 * Responses API; every other model on the native OpenAI adapter uses Chat
 * Completions. This is the single declared source of that protocol split,
 * expressed through the {@link ModelInfo.apiProtocol} seam. It is consumed by
 * the runtime model factory and the conformance matrix.
 */
export function openAiAdapterApiProtocol(
  modelId: string,
  providerType?: ProviderType,
): 'openai-responses' | 'openai-chat' {
  const id = modelId.trim();
  return /^gpt-5/i.test(id) ||
    ((providerType === 'xai' || providerType === 'xai-oauth') && id === 'grok-4.5')
    ? 'openai-responses'
    : 'openai-chat';
}

/**
 * Resolve whether a model accepts image input for the send path.
 *
 * Stored `connection.models` win when they declare `vision` explicitly
 * (provider-fetched facts). But `model-fetcher` stores bare `{ id }` entries
 * for many providers, and older connections predate any enrichment — so when
 * `vision` is unknown we fall back to the generated models.dev snapshot and
 * access-path-specific in-repo overrides. Unknown (no stored value, no
 * metadata entry) resolves to false,
 * keeping the send path fail-closed for text-only models.
 */
export function resolveModelVisionSupport(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
): boolean {
  const stored = models?.find((entry) => entry.id === modelId);
  if (stored?.capabilities?.vision !== undefined) {
    return stored.capabilities.vision === true;
  }
  return lookupModelMetadata(providerType, modelId).capabilities?.vision === true;
}

export function curatedCatalogFallbackModelsForProvider(
  providerType: ProviderType,
): readonly string[] | undefined {
  return CURATED_CATALOG_FALLBACK_MODELS[providerType];
}

const REASONING_FUNCTION_CALLING = {
  reasoning: true,
  functionCalling: true,
} satisfies ModelInfo['capabilities'];

const ANTHROPIC_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'claude-sonnet-4-6': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'max'] } },
  'claude-opus-4-8': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-fable-5': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  // Anthropic retired Sonnet 4.5's 1M beta on 2026-04-30; the standard API limit is 200K.
  'claude-sonnet-4-5': {
    contextWindow: 200_000,
    thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' },
  },
  'claude-sonnet-4-5-20250929': {
    contextWindow: 200_000,
    thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' },
  },
  'claude-opus-4-1-20250805': {
    thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' },
  },
  'claude-haiku-4-5': {
    thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' },
  },
  'claude-haiku-4-5-20251001': {
    thinkingOptions: { toggle: true, offBehavior: 'anthropic-thinking-disabled' },
  },
};

const CLAUDE_SUBSCRIPTION_MODEL_METADATA = displayMetadataOnly(
  GENERATED_MODELS_DEV_METADATA.anthropic,
  ANTHROPIC_MODEL_OVERRIDES,
);

const GOOGLE_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'gemini-3.5-flash': { thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] } },
  'gemini-3.1-pro-preview': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'gemini-3-pro-preview': { thinkingOptions: { efforts: ['low', 'high'] } },
  'gemini-3-flash-preview': { thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] } },
  'gemini-2.5-flash': {
    thinkingOptions: { toggle: true, offBehavior: 'google-thinking-budget-zero' },
  },
};

const OPENAI_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'gpt-5.5': { thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] } },
  'gpt-5': { thinkingOptions: { efforts: ['minimal', 'low', 'medium', 'high'] } },
};

const OPENAI_OAUTH_MODEL_METADATA: Record<string, ModelMetadata> = {
  'gpt-5.6-sol': {
    ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.6-sol']!,
    contextWindow: 372_000,
    thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  },
  'gpt-5.5': {
    ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.5']!,
    ...OPENAI_MODEL_OVERRIDES['gpt-5.5']!,
    contextWindow: 272_000,
  },
  'gpt-5.4': { ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.4']!, contextWindow: 272_000 },
  'gpt-5.4-mini': {
    ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.4-mini']!,
    contextWindow: 272_000,
  },
  'gpt-5.3-codex-spark': GENERATED_MODELS_DEV_METADATA.openai['gpt-5.3-codex-spark']!,
};

const SILICONFLOW_MODEL_OVERRIDES: Record<string, ModelMetadata> = Object.fromEntries(
  Object.entries(GENERATED_MODELS_DEV_METADATA.siliconflow)
    .filter(([, metadata]) => metadata.capabilities?.functionCalling)
    .map(([id]) => [id, { capabilities: { chat: true } }]),
);

const VOLCENGINE_CODING_PLAN_DOCS = 'https://www.volcengine.com/docs/82379/1925114';
const VOLCENGINE_CODING_PLAN_MODEL_METADATA: Record<string, ModelMetadata> = {
  'ark-code-latest': planModel('Ark Code Latest', false),
  'doubao-seed-2.0-code': planModel('Doubao Seed 2.0 Code', true),
  'doubao-seed-2.0-pro': planModel('Doubao Seed 2.0 Pro', true),
  'doubao-seed-2.0-lite': planModel('Doubao Seed 2.0 Lite', true),
  'doubao-seed-code': planModel('Doubao Seed Code', true),
  'minimax-m2.7': planModel('MiniMax-M2.7', false, 200_000, 128_000),
  'minimax-m3': planModel('MiniMax-M3', true, 512_000, 128_000),
  'glm-5.2': planModel('GLM-5.2', false, 1_024_000, 128_000),
  'deepseek-v4-flash': planModel('DeepSeek-V4-Flash', false, 1_024_000, 384_000),
  'deepseek-v4-pro': planModel('DeepSeek-V4-Pro', false, 1_024_000, 384_000),
  'kimi-k2.6': planModel('Kimi-K2.6', true, 256_000, 32_000),
  'kimi-k2.7-code': planModel('Kimi-K2.7-Code', true, 256_000, 32_000),
};

// Ollama Cloud accepts reasoning_effort for every active reasoning model in its
// generated catalog. GPT-OSS is the narrower exception and cannot be disabled.
const OLLAMA_CLOUD_STANDARD_THINKING_OPTIONS: ThinkingOptions = {
  efforts: ['none', 'low', 'medium', 'high', 'max'],
  toggle: true,
};

const OLLAMA_CLOUD_GPT_OSS_THINKING_OPTIONS: ThinkingOptions = {
  efforts: ['low', 'medium', 'high'],
};

const ollamaCloudThinkingModels: Record<string, ModelMetadata> = Object.fromEntries(
  Object.entries(GENERATED_MODELS_DEV_METADATA['ollama-cloud'])
    .filter(
      ([, metadata]) => metadata.capabilities?.reasoning && metadata.lifecycle !== 'deprecated',
    )
    .map(([id]) => [
      id,
      {
        thinkingOptions: id.startsWith('gpt-oss')
          ? OLLAMA_CLOUD_GPT_OSS_THINKING_OPTIONS
          : OLLAMA_CLOUD_STANDARD_THINKING_OPTIONS,
      },
    ]),
);

// Facts that models.dev cannot express: provider wire controls and
// access-path-specific aliases/limits. Standard model facts stay generated.
const STATIC_MODEL_METADATA: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = {
  anthropic: ANTHROPIC_MODEL_OVERRIDES,
  'minimax-coding-plan': GENERATED_MODELS_DEV_METADATA.MiniMax,
  'stepfun-step-plan': {
    'step-3.7-flash': {
      ...GENERATED_MODELS_DEV_METADATA.stepfun['step-3.7-flash']!,
      thinkingOptions: { efforts: ['low', 'medium', 'high'] },
    },
    'step-3.5-flash-2603': {
      ...GENERATED_MODELS_DEV_METADATA.stepfun['step-3.5-flash-2603']!,
      thinkingOptions: { efforts: ['low', 'high'] },
    },
    'step-3.5-flash': GENERATED_MODELS_DEV_METADATA.stepfun['step-3.5-flash']!,
    'step-router-v1': {
      displayName: 'Step Router V1',
      lifecycle: 'active',
      docsUrl: 'https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api',
      maxOutputTokens: 384_000,
      capabilities: { vision: false, reasoning: true, functionCalling: true },
    },
  },
  'stepfun-ai-step-plan': {
    'step-3.7-flash': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
    'step-3.5-flash-2603': { thinkingOptions: { efforts: ['low', 'high'] } },
    'step-3.5-flash': { thinkingOptions: { efforts: ['low', 'high'] } },
  },
  'claude-subscription': CLAUDE_SUBSCRIPTION_MODEL_METADATA,
  openai: OPENAI_MODEL_OVERRIDES,
  google: GOOGLE_MODEL_OVERRIDES,
  cohere: {
    'command-a-plus-05-2026': {
      thinkingOptions: { toggle: true, offBehavior: 'cohere-thinking-disabled' },
    },
    'command-a-reasoning-08-2025': {
      thinkingOptions: { toggle: true, offBehavior: 'cohere-thinking-disabled' },
    },
  },
  'gemini-cli': GOOGLE_MODEL_OVERRIDES,
  'openai-codex': OPENAI_OAUTH_MODEL_METADATA,
  siliconflow: SILICONFLOW_MODEL_OVERRIDES,
  vercel: {
    'xai/grok-4.3': { thinkingOptions: { efforts: ['none', 'low', 'medium', 'high'] } },
  },
  xai: {
    // models.dev + xAI declare configurable reasoning_effort for Grok 4.5.
    'grok-4.5': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  },
  'tencent-coding-plan': {
    'kimi-k2.5': { capabilities: { vision: false } },
  },
  'volcengine-ark': {
    'doubao-seed-2-0-pro-260215': {
      displayName: 'Doubao Seed 2.0 Pro',
      lifecycle: 'active',
      docsUrl: 'https://www.volcengine.com/docs/82379',
      capabilities: { reasoning: true, functionCalling: true },
      thinkingOptions: {
        efforts: ['minimal', 'low', 'medium', 'high'],
        toggle: true,
        offBehavior: 'volcengine-thinking-disabled',
      },
    },
  },
  'volcengine-coding-plan': VOLCENGINE_CODING_PLAN_MODEL_METADATA,
  'tencent-token-plan': {
    hy3: { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
    'hy3-preview': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  },
  deepinfra: {
    'moonshotai/Kimi-K2.7-Code': {
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'high'], toggle: true },
    },
  },
  groq: {
    // Groq accepts `reasoning_effort` only for gpt-oss-120b / gpt-oss-20b, with
    // values low/medium/high (no `none`). See console.groq.com/docs/reasoning:
    // qwen/qwen3-32b does NOT accept reasoning_effort (it reasons with no knob),
    // and qwen/qwen3.6-27b accepts none/default but is not yet in the snapshot.
    // gpt-oss-safeguard-20b is a guardrail model Groq does not list as accepting
    // reasoning_effort, so it is deliberately omitted here.
    'openai/gpt-oss-120b': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
    'openai/gpt-oss-20b': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  },
  openrouter: {
    'anthropic/claude-sonnet-5': {
      thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    },
    'openai/gpt-5.6-sol': {
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], toggle: true },
    },
    'x-ai/grok-4.5': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
    'deepseek/deepseek-v4-pro': { thinkingOptions: { efforts: ['high', 'xhigh'], toggle: true } },
  },
  'cloudflare-workers-ai': {
    '@cf/moonshotai/kimi-k2.6': {
      thinkingOptions: {
        efforts: ['low', 'medium', 'high'],
        toggle: true,
        offBehavior: 'cloudflare-chat-template-thinking-false',
      },
    },
  },
  'ollama-cloud': ollamaCloudThinkingModels,
  deepseek: {
    'deepseek-v4-flash': { thinkingOptions: { efforts: ['high', 'max'], toggle: true } },
  },
  'zai-coding-plan': {
    'glm-5.2': { thinkingOptions: { efforts: ['high', 'max'] } },
    'glm-5.1': { thinkingOptions: { toggle: true } },
    'glm-5-turbo': { thinkingOptions: { toggle: true } },
    'glm-5v-turbo': { thinkingOptions: { toggle: true } },
    'glm-4.5-air': { thinkingOptions: { toggle: true } },
  },
  'kimi-coding-plan': {
    k3: {
      displayName: 'Kimi K3',
      lifecycle: 'active',
      docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      capabilities: { ...REASONING_FUNCTION_CALLING, vision: true },
      thinkingOptions: { efforts: ['max'] },
    },
    'kimi-for-coding': {
      displayName: 'Kimi for Coding',
      lifecycle: 'active',
      docsUrl: 'https://www.kimi.com/code/docs/en/',
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      capabilities: { ...REASONING_FUNCTION_CALLING, vision: true },
    },
    'kimi-for-coding-highspeed': {
      displayName: 'Kimi for Coding (HighSpeed)',
      lifecycle: 'active',
      docsUrl: 'https://www.kimi.com/code/docs/en/',
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      capabilities: { ...REASONING_FUNCTION_CALLING, vision: true },
    },
  },
};

function planModel(
  displayName: string,
  vision: boolean,
  contextWindow?: number,
  maxOutputTokens?: number,
): ModelMetadata {
  return {
    displayName,
    lifecycle: 'active',
    docsUrl: VOLCENGINE_CODING_PLAN_DOCS,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: { ...REASONING_FUNCTION_CALLING, vision },
  };
}

function displayMetadataOnly(
  source: Record<string, ModelMetadata>,
  overrides: Record<string, ModelMetadata>,
): Record<string, ModelMetadata> {
  return Object.fromEntries(
    Object.entries(source).map(([id, metadata]) => [
      id,
      {
        displayName: metadata.displayName,
        lifecycle: metadata.lifecycle,
        docsUrl: metadata.docsUrl,
        capabilities: metadata.capabilities,
        thinkingOptions: overrides[id]?.thinkingOptions,
      },
    ]),
  ) as Record<string, ModelMetadata>;
}

const CURATED_CATALOG_FALLBACK_MODELS: Partial<Record<ProviderType, readonly string[]>> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1-20250805',
  ],
  'claude-subscription': [
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'claude-sonnet-4-5-20250929',
  ],
  openai: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner', 'deepseek-chat'],
  google: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'gemini-cli': [
    'gemini-3.5-flash',
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
  'zai-coding-plan': ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
  MiniMax: ['MiniMax-M3'],
  'MiniMax-cn': ['MiniMax-M3'],
};
