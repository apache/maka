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

import type { ModelInfo, ProviderType } from './llm-connections.js';
import type { ThinkingOptions } from './model-thinking.js';
import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES,
} from './model-metadata.generated.js';

export interface ModelMetadata {
  displayName?: string;
  description?: string;
  lifecycle?: 'active' | 'beta' | 'alpha' | 'deprecated' | 'retired';
  docsUrl?: string;
  contextWindow?: number;
  inputLimit?: number;
  maxOutputTokens?: number;
  knowledgeCutoff?: string;
  structuredOutput?: boolean;
  lastUpdated?: string;
  /**
   * models.dev prices the model at zero input cost. Marks free-tier
   * candidates (e.g. opencode-free); display names are not a contract for
   * this, several free models carry no "Free" suffix.
   */
  isFree?: boolean;
  capabilities?: ModelInfo['capabilities'];
  modalities?: ModelInfo['modalities'];
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

/** Access paths that serve a canonical provider's model catalog. */
const GENERATED_METADATA_PROVIDER_ALIASES: Partial<Record<ProviderType, ProviderType>> = {
  'xai-oauth': 'xai',
  'opencode-free': 'opencode',
  'openai-codex': 'openai',
};

function generatedMetadataProviderType(providerType: ProviderType): ProviderType {
  return GENERATED_METADATA_PROVIDER_ALIASES[providerType] ?? providerType;
}

/**
 * Whether the bundled metadata describes this model at all. `lookupModelMetadata`
 * answers "no" with an empty object, and callers were reading that sentinel by
 * hand; the question they mean to ask is this one.
 */
export function hasModelMetadata(providerType: ProviderType, modelId: string): boolean {
  return Object.keys(lookupModelMetadata(providerType, modelId)).length > 0;
}

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  const id = modelId.trim();
  const metadataProviderType = generatedMetadataProviderType(providerType);
  const generated = generatedMetadata[metadataProviderType]?.[id];
  const override =
    STATIC_MODEL_METADATA[providerType]?.[id] ??
    (providerType === 'xai-oauth'
      ? STATIC_MODEL_METADATA.xai?.[id]
      : providerType === 'opencode-free'
        ? STATIC_MODEL_METADATA.opencode?.[id]
        : undefined);
  if (!generated) return override ?? {};
  if (!override) return generated;
  return {
    ...generated,
    ...override,
    capabilities: { ...generated.capabilities, ...override.capabilities },
    modalities: override.modalities ?? generated.modalities,
  };
}

/**
 * All model ids a provider can resolve metadata for, under the same alias
 * rules `lookupModelMetadata` applies. Contract tests sweep this universe so
 * the declaration-to-wire invariant cannot silently shrink.
 */
export function modelMetadataIdsForProvider(providerType: ProviderType): string[] {
  const metadataProviderType = generatedMetadataProviderType(providerType);
  return Array.from(
    new Set([
      ...Object.keys(generatedMetadata[metadataProviderType] ?? {}),
      ...Object.keys(STATIC_MODEL_METADATA[providerType] ?? {}),
      ...(metadataProviderType !== providerType
        ? Object.keys(STATIC_MODEL_METADATA[metadataProviderType] ?? {})
        : []),
    ]),
  );
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
 * Provider/model routing facts live here even when the concrete Responses SDK
 * and replay policy are delegated to a Runtime profile. This is the single
 * declared source of the default protocol split, expressed through the
 * {@link ModelInfo.apiProtocol} seam.
 */
export function openAiAdapterApiProtocol(
  modelId: string,
  providerType?: ProviderType,
): 'openai-responses' | 'openai-chat' {
  const id = modelId.trim();
  return (providerType === 'deepseek' && deepSeekModelSupportsResponses(id)) ||
    (providerType === 'opencode-go' && id === 'muse-spark-1.2-contributor') ||
    ((providerType === 'alibaba-token-plan-cn' || providerType === 'alibaba-token-plan') &&
      id === 'qwen3.8-max') ||
    /^gpt-5/i.test(id) ||
    ((providerType === 'xai' || providerType === 'xai-oauth') && id === 'grok-4.5')
    ? 'openai-responses'
    : 'openai-chat';
}

/** DeepSeek models whose first-party API contract includes the Responses wire. */
export function deepSeekModelSupportsResponses(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id === 'deepseek-v4-flash' || id === 'deepseek-v4-pro';
}

/** Vision-capable Claude families, including models newer than the generated snapshot. */
const VISION_BY_DEFAULT = /^claude-(?:[\d.]+-)*(?:opus|sonnet|haiku|fable)\b/;

/** First-party paths where a bare `claude-*` id identifies an Anthropic model. */
const VISION_BY_DEFAULT_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'claude-subscription',
]);

/** Resolve vision support by user declaration, inventory, metadata, then first-party Claude fallback. */
export function resolveModelVisionSupport(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
  declaredVision?: boolean,
): boolean {
  if (declaredVision !== undefined) return declaredVision;
  const stored = models?.find((entry) => entry.id === modelId);
  if (stored?.capabilities?.vision !== undefined) {
    return stored.capabilities.vision === true;
  }
  const metadata = lookupModelMetadata(providerType, modelId);
  if (metadata.capabilities?.vision !== undefined) {
    return metadata.capabilities.vision === true;
  }
  return VISION_BY_DEFAULT_PROVIDERS.has(providerType) && VISION_BY_DEFAULT.test(modelId.trim());
}

/**
 * Resolve the input modalities for one model, preferring an explicit provider
 * inventory and falling back to the generated models.dev facts. An empty
 * result is intentional: unknown models must not be treated as attachment
 * capable by default.
 */
export function resolveModelInputModalities(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
): NonNullable<ModelInfo['modalities']>['input'] {
  const stored = models?.find((entry) => entry.id === modelId)?.modalities?.input;
  if (stored !== undefined) return stored;
  return lookupModelMetadata(providerType, modelId).modalities?.input ?? [];
}

export function resolveModelPdfSupport(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
): boolean {
  return resolveModelInputModalities(providerType, models, modelId).includes('pdf');
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
  // Gemini 2.5 Flash disables thinking via the budget-zero wire; newer Gemini
  // effort sets come from the models.dev snapshot directly.
  'gemini-2.5-flash': {
    thinkingOptions: { toggle: true, offBehavior: 'google-thinking-budget-zero' },
  },
};

const OPENAI_OAUTH_MODEL_METADATA: Record<string, ModelMetadata> = {
  'gpt-5.6-sol': {
    ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.6-sol']!,
    contextWindow: 372_000,
    thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  },
  'gpt-5.5': {
    ...GENERATED_MODELS_DEV_METADATA.openai['gpt-5.5']!,
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
const VOLCENGINE_AGENT_PLAN_DOCS = 'https://www.volcengine.com/docs/82379/2366394';
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
const VOLCENGINE_AGENT_PLAN_MODEL_METADATA: Record<string, ModelMetadata> = {
  'ark-code-latest': agentPlanModel('Ark Code Latest', 256_000, 32_000, { vision: true }),
  // Agent Plan currently exposes GLM-5.3 in its ark-code-latest routing catalog.
  // The underlying model's published limits are 1M context and 128K output.
  'glm-5.3': agentPlanModel('GLM-5.3', 1_000_000, 131_072),
  'doubao-seed-2.0-mini': agentPlanModel('Doubao Seed 2.0 Mini', 256_000, 128_000, {
    vision: true,
  }),
  'doubao-seed-2.0-lite': agentPlanModel('Doubao Seed 2.0 Lite', 256_000, 128_000, {
    vision: true,
  }),
  'deepseek-v4-flash': agentPlanModel('DeepSeek-V4-Flash', 1_024_000, 384_000),
  'doubao-seed-2.1-turbo': agentPlanModel('Doubao Seed 2.1 Turbo', 256_000, 256_000, {
    vision: true,
  }),
  'doubao-seed-evolving': agentPlanModel('Doubao Seed Evolving', 1_024_000, 256_000, {
    vision: true,
  }),
  'doubao-seed-2.0-code': agentPlanModel('Doubao Seed 2.0 Code', 256_000, 128_000, {
    lifecycle: 'deprecated',
  }),
  'doubao-seed-2.0-pro': agentPlanModel('Doubao Seed 2.0 Pro', 256_000, 128_000, {
    lifecycle: 'deprecated',
  }),
  'minimax-m2.7': agentPlanModel('MiniMax-M2.7', 200_000, 128_000),
  'minimax-m3': agentPlanModel('MiniMax-M3', 512_000, 128_000, { vision: true }),
  'glm-5.2': agentPlanModel('GLM-5.2', 1_024_000, 128_000),
  'glm-latest': agentPlanModel('GLM Latest', 1_024_000, 128_000),
  'kimi-k2.6': agentPlanModel('Kimi-K2.6', 256_000, 32_000, { vision: true }),
  'kimi-k2.7-code': agentPlanModel('Kimi-K2.7-Code', 256_000, 32_000, { vision: true }),
  'deepseek-v4-pro': agentPlanModel('DeepSeek-V4-Pro', 1_024_000, 384_000),
  'kimi-k3': agentPlanModel('Kimi-K3', 1_024_000, 128_000, { vision: true }),
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
  'claude-subscription': CLAUDE_SUBSCRIPTION_MODEL_METADATA,
  'alibaba-token-plan-cn': {
    'qwen3.8-max': {
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'xhigh'], toggle: true },
    },
  },
  'alibaba-token-plan': {
    'qwen3.8-max': {
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'xhigh'], toggle: true },
    },
  },
  google: GOOGLE_MODEL_OVERRIDES,
  cohere: {
    'command-a-plus-05-2026': {
      thinkingOptions: { toggle: true, offBehavior: 'cohere-thinking-disabled' },
    },
    'command-a-reasoning-08-2025': {
      thinkingOptions: { toggle: true, offBehavior: 'cohere-thinking-disabled' },
    },
  },
  'openai-codex': OPENAI_OAUTH_MODEL_METADATA,
  siliconflow: SILICONFLOW_MODEL_OVERRIDES,
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
  'volcengine-agent-plan': VOLCENGINE_AGENT_PLAN_MODEL_METADATA,
  'tencent-token-plan': {
    // hy3-preview is absent from the current snapshot; hy3's effort set now
    // comes from the models.dev snapshot.
    'hy3-preview': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  },
  deepinfra: {
    'moonshotai/Kimi-K2.7-Code': {
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'high'], toggle: true },
    },
  },
  groq: {
    // Groq documents reasoning_effort only for the gpt-oss family
    // (low/medium/high) and qwen3.6-27b (none/default); see
    // console.groq.com/docs/reasoning. models.dev currently declares
    // ['none','default'] for qwen/qwen3-32b, which is qwen3.6's value set
    // misapplied — qwen3-32b reasons with no knob, so it is pinned to no
    // options until a live check proves otherwise. The gpt-oss family's
    // effort sets now come from the models.dev snapshot.
    'qwen/qwen3-32b': { thinkingOptions: { efforts: [] } },
  },
  openrouter: {
    // gpt-5.6-sol and deepseek-v4-pro pin Maka-verified effort sets; the rest
    // of openrouter's effort declarations come from the models.dev snapshot.
    'openai/gpt-5.6-sol': {
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], toggle: true },
    },
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
    'deepseek-v4-flash': {
      capabilities: { ...REASONING_FUNCTION_CALLING, webSearch: true },
      lastUpdated: '2026-08-24',
      thinkingOptions: { efforts: ['low', 'high', 'max'], toggle: true },
    },
    'deepseek-v4-flash-vision-exp': {
      capabilities: { vision: true, ...REASONING_FUNCTION_CALLING, webSearch: true },
      thinkingOptions: { efforts: ['low', 'high', 'max'], toggle: true },
      modalities: { input: ['text', 'image'], output: ['text'] },
      displayName: 'DeepSeek-V4-Flash-Vision-Exp',
      description:
        'Experimental DeepSeek V4 Flash model for image understanding and multimodal agent tasks',
      docsUrl: 'https://api-docs.deepseek.com/guides/vision/',
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      structuredOutput: true,
      lastUpdated: '2026-08-21',
    },
    'deepseek-v4-pro': {
      capabilities: { ...REASONING_FUNCTION_CALLING, webSearch: true },
      lastUpdated: '2026-08-13',
      thinkingOptions: { efforts: ['low', 'high', 'max'], toggle: true },
    },
  },
  'zai-coding-plan': {
    // glm-5.1 / glm-5v-turbo / glm-4.5-air are absent from the current
    // snapshot; their toggle facts are preserved here until they return.
    'glm-5.1': { thinkingOptions: { toggle: true } },
    'glm-5v-turbo': { thinkingOptions: { toggle: true } },
    'glm-4.5-air': { thinkingOptions: { toggle: true } },
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

function agentPlanModel(
  displayName: string,
  contextWindow: number,
  maxOutputTokens: number,
  options: {
    lifecycle?: ModelMetadata['lifecycle'];
    vision?: true;
  } = {},
): ModelMetadata {
  return {
    displayName,
    lifecycle: options.lifecycle ?? 'active',
    docsUrl: VOLCENGINE_AGENT_PLAN_DOCS,
    contextWindow,
    maxOutputTokens,
    capabilities: {
      ...REASONING_FUNCTION_CALLING,
      ...(options.vision ? { vision: true } : {}),
    },
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
        ...(metadata.description !== undefined ? { description: metadata.description } : {}),
        lifecycle: metadata.lifecycle,
        docsUrl: metadata.docsUrl,
        ...(metadata.knowledgeCutoff !== undefined
          ? { knowledgeCutoff: metadata.knowledgeCutoff }
          : {}),
        ...(metadata.structuredOutput !== undefined
          ? { structuredOutput: metadata.structuredOutput }
          : {}),
        ...(metadata.lastUpdated !== undefined ? { lastUpdated: metadata.lastUpdated } : {}),
        capabilities: metadata.capabilities,
        ...(metadata.modalities !== undefined ? { modalities: metadata.modalities } : {}),
        thinkingOptions: overrides[id]?.thinkingOptions ?? metadata.thinkingOptions,
      },
    ]),
  ) as Record<string, ModelMetadata>;
}

/**
 * Anthropic ids the subscription catalog now lists under a different name.
 *
 * This is renaming, not retirement: Anthropic publishes a pinned dated id and a
 * shorter "latest" alias for one model, so a catalog listing the alias still
 * offers a selection stored as the dated id. Reconciliation compares ids
 * literally, so without this a stored `claude-haiku-4-5-20251001` reads as a
 * model the catalog dropped and repair falls through to the first live id —
 * moving a Haiku user onto Opus, across model family and price tier, silently.
 *
 * Membership rule: only ids that name the *same* model as their target. A model
 * that was genuinely withdrawn does NOT belong here — repairing that one onto a
 * different model is correct, because the original is gone.
 *
 * Lives beside CURATED_CATALOG_FALLBACK_MODELS because every target has to be an
 * id that list offers; a rename pointing at nothing sends reconciliation back to
 * the fallback this table exists to prevent.
 */
export const CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
};

/** Token Plan's retired preview id remains a server-side alias of the formal model. */
export const ALIBABA_TOKEN_PLAN_MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  'qwen3.8-max-preview': 'qwen3.8-max',
};

/**
 * The rename table that applies to one provider's inventory, or undefined when
 * its ids carry no such guarantee.
 *
 * Reconciliation is shared by every provider that commits a fetched inventory,
 * so the table has to be selected by provider rather than assumed: a relay may
 * serve `claude-*` ids as opaque identifiers of its own, where the same string
 * is a different model — the rule connection storage states where it prunes
 * relay profiles across endpoints.
 */
export function modelIdAliasesForProvider(
  providerType: ProviderType,
): Readonly<Record<string, string>> | undefined {
  if (providerType === 'claude-subscription') return CLAUDE_SUBSCRIPTION_MODEL_ID_ALIASES;
  if (providerType === 'alibaba-token-plan-cn' || providerType === 'alibaba-token-plan') {
    return ALIBABA_TOKEN_PLAN_MODEL_ID_ALIASES;
  }
  return undefined;
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
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-sonnet-4-6',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'claude-sonnet-4-5-20250929',
  ],
  openai: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5'],
  deepseek: [
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-v4-pro',
    'deepseek-reasoner',
    'deepseek-chat',
  ],
  google: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  'zai-coding-plan': ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
  MiniMax: ['MiniMax-M3'],
  'MiniMax-cn': ['MiniMax-M3'],
};
