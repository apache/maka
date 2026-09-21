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

import type { ModelInfo, ProviderType, ProviderRuntimeAdapter } from './llm-connections.js';
import type { ThinkingOptions } from './model-thinking.js';
import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES,
} from './model-metadata.generated.js';

export interface ModelMetadata {
  displayName?: string;
  description?: string;
  lifecycle?: 'active' | 'beta' | 'alpha' | 'deprecated' | 'retired';
  contextWindow?: number;
  inputLimit?: number;
  maxOutputTokens?: number;
  knowledgeCutoff?: string;
  structuredOutput?: boolean;
  lastUpdated?: string;
  capabilities?: ModelInfo['capabilities'];
  modalities?: ModelInfo['modalities'];
  /**
   * Per-model reasoning controls, mirroring models.dev `reasoning_options`.
   * Omitted on models with no declarable thinking knob (miss → no menu).
   */
  thinkingOptions?: ThinkingOptions;
}

type ModelsDevMetadata = Partial<Record<ProviderType, Record<string, ModelMetadata>>>;

/**
 * What this build shipped, before any refresh. Read it to compare a refresh
 * against the snapshot; `lookupModelMetadata` already answers "what is true
 * now" and is what every renderer should use.
 */
export const bundledModelMetadata: ModelsDevMetadata = GENERATED_MODELS_DEV_METADATA;
let refreshedMetadata: ModelsDevMetadata | undefined;

/**
 * Replace the models.dev layer for this process, or pass `undefined` to return
 * to the snapshot this build shipped.
 *
 * Whole table, never per model: once a refresh lands, the catalog says what
 * upstream says, so a model upstream delisted stops being described here. The
 * Runtime Host installs once at startup. Other processes keep the snapshot,
 * and read Host-resolved catalog entries rather than their own merge.
 */
export function installRefreshedModelMetadata(metadata: ModelsDevMetadata | undefined): void {
  if (metadata !== undefined) assertWireTokenLimits(metadata);
  refreshedMetadata = metadata;
}

/**
 * The wire carries a token limit only as a positive integer
 * (decodeConnectionModel), so a table installed here must already be in that
 * domain: one model outside it fails the Host's own output validation and
 * takes the whole catalog page down. Refusing at install keeps the snapshot
 * this build shipped, with the offending model named.
 */
function assertWireTokenLimits(table: ModelsDevMetadata): void {
  for (const [providerType, models] of Object.entries(table)) {
    for (const [modelId, metadata] of Object.entries(models)) {
      for (const key of ['contextWindow', 'inputLimit', 'maxOutputTokens'] as const) {
        const value = metadata[key];
        if (value === undefined) continue;
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new Error(
            `model metadata ${providerType}/${modelId} has an invalid ${key}: ${String(value)}`,
          );
        }
      }
    }
  }
}

function activeMetadata(): ModelsDevMetadata {
  return refreshedMetadata ?? bundledModelMetadata;
}

/** Access paths that serve a canonical provider's model catalog. */
const GENERATED_METADATA_PROVIDER_ALIASES: Partial<Record<ProviderType, ProviderType>> = {
  'xai-oauth': 'xai',
  'opencode-free': 'opencode',
  'openai-codex': 'openai',
};

function generatedMetadataProviderType(providerType: ProviderType): ProviderType {
  return GENERATED_METADATA_PROVIDER_ALIASES[providerType] ?? providerType;
}

/** Whether discovery is the complete usable model catalog for this account. */
export function providerReportsCompleteModelCatalog(providerType: ProviderType): boolean {
  return providerType === 'github-copilot';
}

/**
 * Whether the active metadata describes this model at all. `lookupModelMetadata`
 * answers "no" with an empty object, and callers were reading that sentinel by
 * hand; the question they mean to ask is this one.
 */
export function hasModelMetadata(providerType: ProviderType, modelId: string): boolean {
  return Object.keys(lookupModelMetadata(providerType, modelId)).length > 0;
}

export function lookupModelMetadata(providerType: ProviderType, modelId: string): ModelMetadata {
  const id = modelId.trim();
  const metadataProviderType = generatedMetadataProviderType(providerType);
  const generated = activeMetadata()[metadataProviderType]?.[id];
  const providerMetadata =
    providerType === 'openai-codex' ? withoutInputLimit(generated) : generated;
  const statics = staticModelMetadata();
  const override =
    statics[providerType]?.[id] ??
    (providerType === 'xai-oauth'
      ? statics.xai?.[id]
      : providerType === 'opencode-free'
        ? statics.opencode?.[id]
        : undefined);
  if (!providerMetadata) return override ?? {};
  if (!override) return providerMetadata;
  return {
    ...providerMetadata,
    ...override,
    capabilities: { ...providerMetadata.capabilities, ...override.capabilities },
    modalities: override.modalities ?? providerMetadata.modalities,
  };
}

/**
 * All model ids a provider can resolve metadata for, under the same alias
 * rules `lookupModelMetadata` applies. Contract tests sweep this universe so
 * the declaration-to-wire invariant cannot silently shrink.
 */
export function modelMetadataIdsForProvider(providerType: ProviderType): string[] {
  const metadataProviderType = generatedMetadataProviderType(providerType);
  const statics = staticModelMetadata();
  return Array.from(
    new Set([
      ...Object.keys(activeMetadata()[metadataProviderType] ?? {}),
      ...Object.keys(statics[providerType] ?? {}),
      ...(metadataProviderType !== providerType
        ? Object.keys(statics[metadataProviderType] ?? {})
        : []),
    ]),
  );
}

export function lookupModelRuntimeOverride(
  providerType: ProviderType,
  modelId: string,
): { adapter: ProviderRuntimeAdapter; baseUrl?: string } | undefined {
  const overrides: Partial<
    Record<ProviderType, Record<string, { adapter: ProviderRuntimeAdapter; baseUrl?: string }>>
  > = GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES;
  return overrides[providerType]?.[modelId.trim()];
}

/**
 * The request wire a model served over the OpenAI adapter must use.
 *
 * Provider/model routing facts live here even when the concrete Responses SDK
 * and replay policy are declared on the provider's `ProviderRuntimeAdapter`.
 * This is the single declared source of the default protocol split, expressed
 * through the {@link ModelInfo.apiProtocol} seam.
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

function claudeSubscriptionModelMetadata(active: ModelsDevMetadata): Record<string, ModelMetadata> {
  return displayMetadataOnly(active.anthropic ?? {}, ANTHROPIC_MODEL_OVERRIDES);
}

const GOOGLE_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  // Gemini 2.5 Flash disables thinking via the budget-zero wire; newer Gemini
  // effort sets come from the models.dev snapshot directly.
  'gemini-2.5-flash': {
    thinkingOptions: { toggle: true, offBehavior: 'google-thinking-budget-zero' },
  },
};

// The OAuth path pins its own context windows over whatever the public
// catalog says. Base facts come from the active table, falling back to the
// shipped snapshot so a model upstream stops listing keeps a display name.
function openAiOAuthBase(active: ModelsDevMetadata, modelId: string): ModelMetadata {
  const metadata = active.openai?.[modelId] ?? GENERATED_MODELS_DEV_METADATA.openai[modelId];
  return withoutInputLimit(metadata) ?? {};
}

/** OAuth model metadata must not inherit public OpenAI API input limits. */
function withoutInputLimit(metadata: ModelMetadata | undefined): ModelMetadata | undefined {
  if (!metadata) return undefined;
  const { inputLimit: _inputLimit, ...withoutLimit } = metadata;
  return withoutLimit;
}

function openAiOAuthModelMetadata(active: ModelsDevMetadata): Record<string, ModelMetadata> {
  return {
    'gpt-5.6-sol': {
      ...openAiOAuthBase(active, 'gpt-5.6-sol'),
      contextWindow: 372_000,
      thinkingOptions: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
    },
    'gpt-5.5': { ...openAiOAuthBase(active, 'gpt-5.5'), contextWindow: 272_000 },
    'gpt-5.4': { ...openAiOAuthBase(active, 'gpt-5.4'), contextWindow: 272_000 },
    'gpt-5.4-mini': { ...openAiOAuthBase(active, 'gpt-5.4-mini'), contextWindow: 272_000 },
    'gpt-5.3-codex-spark': openAiOAuthBase(active, 'gpt-5.3-codex-spark'),
  };
}

function siliconflowModelOverrides(active: ModelsDevMetadata): Record<string, ModelMetadata> {
  return Object.fromEntries(
    Object.entries(active.siliconflow ?? {})
      .filter(([, metadata]) => metadata.capabilities?.functionCalling)
      .map(([id]) => [id, { capabilities: { chat: true } }]),
  );
}

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
// Hand-maintained mirror of the official Agent Plan personal plan page
// (docs.volcengine.com/docs/82379/2366394) and its model release/retirement
// announcements (82379/2578669, 82379/2578673): the gateway has no
// model-list endpoint its plan key can reach and models.dev has no snapshot.
// The page's table lists windows as "1024k"/"128k"; transcribe those
// literals as 1_024_000/128_000 (its prose "1M" is the same figure rounded).
// Re-check the page before editing an entry here.
const VOLCENGINE_AGENT_PLAN_MODEL_METADATA: Record<string, ModelMetadata> = {
  'ark-code-latest': agentPlanModel('Ark Code Latest', 256_000, 32_000, { vision: true }),
  // The plan page lists "glm-5.3 (glm-latest)": thinking is on by default and
  // cannot be turned off.
  'glm-5.3': agentPlanModel('GLM-5.3', 1_024_000, 128_000),
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
  'minimax-m2.7': agentPlanModel('MiniMax-M2.7', 200_000, 128_000, {
    // Upstream retirement notice of 2026-08-04; the gateway routes to minimax-m3.
    lifecycle: 'deprecated',
  }),
  'minimax-m3': agentPlanModel('MiniMax-M3', 1_024_000, 128_000, { vision: true }),
  'glm-5.2': agentPlanModel('GLM-5.2', 1_024_000, 128_000, {
    // Upstream service ended 2026-08-31; the gateway routes to glm-5.3.
    lifecycle: 'deprecated',
  }),
  // Official alias of glm-5.3 (the plan page lists "glm-5.3 (glm-latest)").
  'glm-latest': agentPlanModel('GLM Latest', 1_024_000, 128_000),
  'glm-5.3-flash': agentPlanModel('GLM-5.3-Flash', 1_024_000, 128_000, { vision: true }),
  'kimi-k2.6': agentPlanModel('Kimi-K2.6', 256_000, 32_000, {
    // Upstream service ended 2026-08-18; migrate to kimi-k2.7-code or kimi-k3.
    lifecycle: 'deprecated',
    vision: true,
  }),
  'kimi-k2.7-code': agentPlanModel('Kimi-K2.7-Code', 256_000, 32_000, { vision: true }),
  'deepseek-v4-pro': agentPlanModel('DeepSeek-V4-Pro', 1_024_000, 384_000),
  'kimi-k3': agentPlanModel('Kimi-K3', 1_024_000, 128_000, { vision: true }),
};

// Ollama Cloud accepts reasoning_effort for every active reasoning model in its
// generated catalog, whatever knob the model declares on its own.
const OLLAMA_CLOUD_STANDARD_THINKING_OPTIONS: ThinkingOptions = {
  efforts: ['none', 'low', 'medium', 'high', 'max'],
  toggle: true,
};

function ollamaCloudThinkingModels(active: ModelsDevMetadata): Record<string, ModelMetadata> {
  return Object.fromEntries(
    Object.entries(active['ollama-cloud'] ?? {})
      .filter(
        ([id, metadata]) =>
          metadata.capabilities?.reasoning &&
          metadata.lifecycle !== 'deprecated' &&
          // GPT-OSS is the narrower exception and cannot be disabled. models.dev
          // declares that set itself, so pinning it here would only restate it.
          !id.startsWith('gpt-oss'),
      )
      .map(([id]) => [id, { thinkingOptions: OLLAMA_CLOUD_STANDARD_THINKING_OPTIONS }]),
  );
}

// Command Code declares no reasoning metadata over its API — the public
// `/provider/v1/models` listing carries only id/object/created/owned_by/name/
// context_length/supported_endpoints, and `/provider/v1/models/<id>` is not a
// route. The selectable `reasoning_effort` levels therefore live only in the
// official CLI's bundled model table, which the MIT `pi-commandcode-provider`
// project and its derivative `Mars-Sea/dsh-commandcode-provider`
// (`src/capabilities.ts`, `KNOWN_EFFORTS`) are the traceable extraction of.
//
// Ported from `dsh-commandcode-provider`'s `KNOWN_EFFORTS`, which was
// re-verified against `command-code@1.53.0` (`dist/cli.mjs`'s provider effort
// map). The reference keeps a running changelog of which CLI release added or
// removed each line; that history is summarized here per entry. We pin
// `command-code@1.54.0`, so a future re-sync should re-read that release's
// bundle — a wrong effort word is refused by the wire or ignored by the model,
// it is not silently mis-billed.
//
// Two rules from the reference that must survive re-syncs:
//  - Models that reason automatically under a depth Command Code chooses
//    (Tencent Hy3/Hy4 without levels, GLM-5/5.1/5.2-Fast, and the previews in
//    the reference's `KNOWN_THINKING_MODELS`) carry no selectable effort, so
//    they are absent here and the picker offers no selector for them.
//  - Only the Provider-API table is authoritative for this route. Do not add
//    levels observed on the OAuth (anthropic/openai) tables.
const COMMAND_CODE_MODEL_METADATA: Record<string, ModelMetadata> = {
  'Qwen/Qwen3.8-Max': { thinkingOptions: { efforts: ['low', 'medium', 'xhigh'] } },
  'Qwen/Qwen3.8-Max-0902': { thinkingOptions: { efforts: ['low', 'medium', 'xhigh'] } },
  'Qwen/Qwen3.8-27B': { thinkingOptions: { efforts: ['low', 'medium', 'xhigh'] } },
  'Qwen/Qwen3.8-Flash': { thinkingOptions: { efforts: ['low', 'medium', 'xhigh'] } },
  'claude-fable-5-1': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-fable-5': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-opus-4-7': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-opus-4-8': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-opus-5': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-sonnet-4-6': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'claude-sonnet-5': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  // 1.39.0 added the model; 1.39.1 dropped `medium`; 1.39.2 ships this set.
  'deepseek/deepseek-v4-flash-fast': { thinkingOptions: { efforts: ['low', 'high', 'max'] } },
  // 1.53.0 added DeepSeek V4.1 Flash with this set.
  'deepseek/deepseek-v4.1-flash': { thinkingOptions: { efforts: ['low', 'high', 'max'] } },
  'deepseek/deepseek-v4-flash': { thinkingOptions: { efforts: ['high', 'max'] } },
  'deepseek/deepseek-v4-flash-vision-exp': { thinkingOptions: { efforts: ['high', 'max'] } },
  'deepseek/deepseek-v4-pro': { thinkingOptions: { efforts: ['high', 'max'] } },
  'google/gemini-3.1-flash-lite': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'google/gemini-3.5-flash': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'google/gemini-3.5-flash-lite': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'google/gemini-3.6-flash': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'google/gemini-3.7-flash': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  // 1.43.0 added Gemini 3.8 Flash with the family's three-level set.
  'google/gemini-3.8-flash': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'gpt-5.3-codex': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  'gpt-5.4': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  'gpt-5.4-mini': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'gpt-5.5': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  'gpt-5.6-luna': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'gpt-5.6-sol': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  'gpt-5.6-terra': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  // 1.39.3 gained selectable levels (previously thought automatically).
  'moonshotai/Kimi-K3': { thinkingOptions: { efforts: ['low', 'high', 'max'] } },
  'sakana/fugu-ultra': { thinkingOptions: { efforts: ['high', 'xhigh'] } },
  // 1.38.0 gained selectable levels (previously thought automatically).
  'tencent/hy4-preview': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'xai/grok-4.5': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
  'xai/grok-4.6': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  // Successor of `stealth/ox-alpha`, removed in 1.34.0 with the same set.
  'z-ai/glm-5.3-flash': { thinkingOptions: { efforts: ['low', 'high', 'max'] } },
  'zai-org/GLM-5.2': { thinkingOptions: { efforts: ['high', 'max'] } },
  'zai-org/GLM-5.3': { thinkingOptions: { efforts: ['low', 'high', 'max'] } },
  // Muse Spark gained selectable levels in 1.45.0; 1.48.0 added `max` to 1.3
  // only, so 1.3 and 1.3-contributor now differ.
  'meta/muse-spark-1.1': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  'meta/muse-spark-1.2': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  'meta/muse-spark-1.2-contributor': {
    thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  'meta/muse-spark-1.3': {
    thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  },
  'meta/muse-spark-1.3-contributor': {
    thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh'] },
  },
  // 1.49.0 added GPT-6 Astra with the five-level set.
  'gpt-6-astra': { thinkingOptions: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
  // 1.51.3 gave MiniMax M3 selectable levels (read from the bundle; the
  // 1.51.1–1.51.3 changelog had not been published at extraction time).
  'MiniMaxAI/MiniMax-M3': { thinkingOptions: { efforts: ['low', 'medium', 'high'] } },
};

// Facts that models.dev cannot express: provider wire controls and
// access-path-specific aliases/limits. Standard model facts stay generated.
//
// Built over the active table rather than the shipped one, so the entries
// derived from a provider's catalog cover models a refresh introduced.
function buildStaticModelMetadata(active: ModelsDevMetadata): ModelsDevMetadata {
  return {
    anthropic: ANTHROPIC_MODEL_OVERRIDES,
    'claude-subscription': claudeSubscriptionModelMetadata(active),
    // The Command Code Provider-API plan rides the same effort table.
    commandcode: COMMAND_CODE_MODEL_METADATA,
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
    'openai-codex': openAiOAuthModelMetadata(active),
    siliconflow: siliconflowModelOverrides(active),
    'tencent-coding-plan': {
      'kimi-k2.5': { capabilities: { vision: false } },
    },
    'volcengine-ark': {
      'doubao-seed-2-0-pro-260215': {
        displayName: 'Doubao Seed 2.0 Pro',
        lifecycle: 'active',
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
      // console.groq.com/docs/reasoning. qwen3-32b reasons with no knob, and
      // models.dev no longer lists it at all, so this is the only thing that
      // keeps a connection carrying the id from offering an effort menu.
      'qwen/qwen3-32b': { thinkingOptions: { efforts: [] } },
    },
    openrouter: {
      // gpt-5.6-sol pins the toggle models.dev omits; every other openrouter
      // effort declaration comes from models.dev.
      'openai/gpt-5.6-sol': {
        thinkingOptions: {
          efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
          toggle: true,
        },
      },
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
    'ollama-cloud': ollamaCloudThinkingModels(active),
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
}

// Rebuilt when the active table is replaced, which happens at most once per
// process; identity is the only signal that a refresh landed.
let staticMetadataCache: { active: ModelsDevMetadata; value: ModelsDevMetadata } | undefined;

function staticModelMetadata(): ModelsDevMetadata {
  const active = activeMetadata();
  if (staticMetadataCache?.active !== active) {
    staticMetadataCache = { active, value: buildStaticModelMetadata(active) };
  }
  return staticMetadataCache.value;
}

function planModel(
  displayName: string,
  vision: boolean,
  contextWindow?: number,
  maxOutputTokens?: number,
): ModelMetadata {
  return {
    displayName,
    lifecycle: 'active',
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
 * Every target has to be an id the provider's shipped baseline
 * (`ProviderDefaults.fallbackModels`) offers; a rename pointing at nothing sends
 * reconciliation back to the fallback this table exists to prevent.
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
