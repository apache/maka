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

import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES,
  GENERATED_MODELS_DEV_PROVIDER_FACTS,
} from './model-metadata.generated.js';

export const OPENCODE_FREE_DEFAULT_MODEL = 'nemotron-3-ultra-free';

export type ProviderCategory = 'oauth' | 'domestic' | 'overseas' | 'local' | 'custom';
export type ProviderCatalogGroup = 'recommended' | 'plans' | 'api' | 'aggregators' | 'local';

export type ApplyPatchProtocol = 'openai-structured' | 'codex-v4a-freeform';

/**
 * Stable reference to provider execution policy implemented by `@maka/runtime`.
 * Core owns only this protocol-level delegation; SDK selection, replay
 * carriers, and request mutation remain Runtime implementation details.
 */
export type ProviderRuntimeProfileId = 'alibaba-token-plan';

export type ProviderResponsesContract =
  | {
      readonly adapter: 'openai';
      readonly reasoningReplay: 'encrypted-content';
    }
  | {
      readonly adapter: 'open-responses';
      readonly reasoningReplay: 'plaintext-content';
    };

type OpenAiCompatibleRuntimeAdapterBase = {
  kind: 'openai-compatible';
  name: 'provider' | 'connection';
  includeUsage?: boolean;
  requireBaseUrl?: boolean;
  replayAssistantReasoningAs?: 'reasoning';
  replayAssistantReasoningDetails?: true;
};

type OpenAiCompatibleRuntimeAdapter = OpenAiCompatibleRuntimeAdapterBase &
  (
    | {
        /** Presence enables a complete Core-owned Responses contract. */
        responses?: ProviderResponsesContract;
        runtimeProfile?: never;
      }
    | {
        responses?: never;
        /** Explicitly delegates concrete execution policy to `@maka/runtime`. */
        runtimeProfile: ProviderRuntimeProfileId;
      }
  );

type ProviderRuntimeAdapterDefinition =
  | { kind: 'anthropic'; auth: 'api-key' | 'bearer'; normalizeBaseUrl: boolean }
  /**
   * No Runtime adapter claims this provider, so nothing can be sent through it.
   * Distinct from a provider that was never wired: see `retired`.
   */
  | { kind: 'unavailable' }
  | { kind: 'openai'; apiProtocol?: 'openai-chat' | 'openai-responses' }
  | { kind: 'openai-codex' }
  | { kind: 'google'; normalizeBaseUrl?: boolean }
  | { kind: 'github-copilot' }
  | { kind: 'cohere' }
  | OpenAiCompatibleRuntimeAdapter;

export type ProviderRuntimeAdapter = ProviderRuntimeAdapterDefinition & {
  /** Provider wire contract for ApplyPatch. Model support is resolved separately. */
  readonly applyPatchProtocol?: ApplyPatchProtocol;
};

export type ProviderModelDiscovery =
  | {
      kind: 'protocol';
      auth?: 'github-copilot' | 'oauth-bearer' | 'openai-codex' | 'none';
      path?: string;
      query?: Readonly<Record<string, string>>;
      responseShape?: 'array-or-data';
      filter?: 'language-models' | 'tool-capable';
    }
  | {
      kind: 'fireworks';
      accountsPath: string;
      publicAccount: string;
      query: Readonly<Record<string, string>>;
    }
  | { kind: 'cloudflare' }
  | { kind: 'fallback'; reason: string }
  | { kind: 'ollama' }
  | { kind: 'cohere' };

export interface ProviderDefaults {
  label: string;
  /**
   * A shorter name for a dense model row, where the label's qualifier is
   * already implied by the row it sits in ("Z.AI Coding Plan" → "Z.AI"). Set
   * only where it actually differs; `providerMenuLabel` falls back to `label`.
   */
  menuLabel?: string;
  baseUrl: string;
  baseUrlTemplate?: string;
  authKind: 'api_key' | 'optional_api_key' | 'oauth_token' | 'none';
  /**
   * The baseline this provider ships: what it offers with no live list to go
   * on. Read it through `providerFallbackModelIds`, never directly — the
   * accessor subtracts `brokenModelIds`.
   */
  fallbackModels: string[];
  /**
   * A new connection to this provider starts with its whole shipped baseline
   * enabled instead of nothing. Set where a provider costs the user nothing to
   * call, so the models are on the moment the connection exists.
   */
  enableShippedModelsByDefault?: true;
  status: 'ready' | 'phase3-experimental';
  runtimeAdapter: ProviderRuntimeAdapter;
  /**
   * Maka used to offer this provider and no longer does. The entry stays
   * registered so stored connections still decode; it just cannot be used.
   */
  retired?: true;
  /** User-declared per-model capabilities are authoritative for this provider. */
  relayModelProfiles?: boolean;
  /**
   * Models with dated evidence of persistent breakage whose failure shape the
   * send itself cannot surface (e.g. empty completions that still bill).
   * Vetoed in `authorizeConnectionModel` and omitted from catalog offers —
   * the one exception to "the user's selection is the authorization".
   */
  brokenModelIds?: readonly string[];
  modelDiscovery: ProviderModelDiscovery;
  category: ProviderCategory;
  catalogGroup?: ProviderCatalogGroup;
  signupUrl?: string;
  catalogOrder?: number;
  recommendedOrder?: number;
}

const siliconflow = GENERATED_MODELS_DEV_PROVIDER_FACTS.siliconflow;
if (!siliconflow.api) throw new Error('models.dev SiliconFlow provider facts are missing api');
const siliconflowModelIds = toolCallingModelIds(
  'SiliconFlow',
  GENERATED_MODELS_DEV_METADATA.siliconflow,
  ['moonshotai/Kimi-K2.6'],
);
const minimaxPlanModelIds = toolCallingModelIds(
  'MiniMax Coding Plan',
  GENERATED_MODELS_DEV_METADATA['minimax-coding-plan'],
  ['MiniMax-M3'],
);

const xai = GENERATED_MODELS_DEV_PROVIDER_FACTS.xai;
if (xai.id !== 'xai') throw new Error('models.dev xAI provider facts are missing stable id xai');
const xaiModelIds = toolCallingModelIds('xAI', GENERATED_MODELS_DEV_METADATA.xai, ['grok-4.5']);
const xiaomi = GENERATED_MODELS_DEV_PROVIDER_FACTS.xiaomi;
if (xiaomi.id !== 'xiaomi' || !xiaomi.api) {
  throw new Error('models.dev Xiaomi provider facts are missing stable id xiaomi or api');
}
const xiaomiModelIds = toolCallingModelIds('Xiaomi', GENERATED_MODELS_DEV_METADATA.xiaomi, [
  'mimo-v2.5',
]).filter((id) => GENERATED_MODELS_DEV_METADATA.xiaomi[id]?.lifecycle !== 'deprecated');
// Keep the bootstrap snapshot limited to the two documented MiMo chat models. The remote
// /models response becomes authoritative as soon as the user saves a working plan credential.
const xiaomiTokenPlanModelIds = ['mimo-v2.5-pro', 'mimo-v2.5'] as const;
const xiaomiTokenPlanCn = GENERATED_MODELS_DEV_PROVIDER_FACTS['xiaomi-token-plan-cn'];
if (xiaomiTokenPlanCn.id !== 'xiaomi-token-plan-cn' || !xiaomiTokenPlanCn.api) {
  throw new Error(
    'models.dev Xiaomi Token Plan (China) provider facts are missing stable id or api',
  );
}
const xiaomiTokenPlanSgp = GENERATED_MODELS_DEV_PROVIDER_FACTS['xiaomi-token-plan-sgp'];
if (xiaomiTokenPlanSgp.id !== 'xiaomi-token-plan-sgp' || !xiaomiTokenPlanSgp.api) {
  throw new Error(
    'models.dev Xiaomi Token Plan (Singapore) provider facts are missing stable id or api',
  );
}
const xiaomiTokenPlanAms = GENERATED_MODELS_DEV_PROVIDER_FACTS['xiaomi-token-plan-ams'];
if (xiaomiTokenPlanAms.id !== 'xiaomi-token-plan-ams' || !xiaomiTokenPlanAms.api) {
  throw new Error(
    'models.dev Xiaomi Token Plan (Europe) provider facts are missing stable id or api',
  );
}
for (const region of [
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-ams',
] as const) {
  for (const id of xiaomiTokenPlanModelIds) {
    if (!GENERATED_MODELS_DEV_METADATA[region][id]?.capabilities?.functionCalling) {
      throw new Error(
        `models.dev Xiaomi Token Plan snapshot ${region} is missing tool-capable model ${id}`,
      );
    }
  }
}
const zai = GENERATED_MODELS_DEV_PROVIDER_FACTS.zai;
if (zai.id !== 'zai' || !zai.api) {
  throw new Error('models.dev Z.AI provider facts are missing stable id zai or api');
}
const zaiModelIds = toolCallingModelIds('Z.AI', GENERATED_MODELS_DEV_METADATA.zai, ['glm-5.2']);
const cerebras = GENERATED_MODELS_DEV_PROVIDER_FACTS.cerebras;
if (cerebras.id !== 'cerebras')
  throw new Error('models.dev Cerebras provider facts are missing stable id cerebras');
const cerebrasModelIds = toolCallingModelIds('Cerebras', GENERATED_MODELS_DEV_METADATA.cerebras, [
  'gpt-oss-120b',
]);
const nvidia = GENERATED_MODELS_DEV_PROVIDER_FACTS.nvidia;
if (nvidia.id !== 'nvidia')
  throw new Error('models.dev NVIDIA provider facts are missing stable id nvidia');
if (!nvidia.api) throw new Error('models.dev NVIDIA provider facts are missing api');
const nvidiaModelIds = toolCallingModelIds('NVIDIA', GENERATED_MODELS_DEV_METADATA.nvidia, [
  'nvidia/nemotron-3-super-120b-a12b',
]).filter((id) => GENERATED_MODELS_DEV_METADATA.nvidia[id]?.lifecycle !== 'deprecated');

const mistral = GENERATED_MODELS_DEV_PROVIDER_FACTS.mistral;
if (mistral.id !== 'mistral')
  throw new Error('models.dev Mistral provider facts are missing stable id mistral');
const mistralModelIds = toolCallingModelIds('Mistral', GENERATED_MODELS_DEV_METADATA.mistral, [
  'mistral-large-latest',
]).filter((id) => GENERATED_MODELS_DEV_METADATA.mistral[id]?.lifecycle !== 'deprecated');
const cohere = GENERATED_MODELS_DEV_PROVIDER_FACTS.cohere;
if (cohere.id !== 'cohere')
  throw new Error('models.dev Cohere provider facts are missing stable id cohere');
const cohereModelIds = toolCallingModelIds('Cohere', GENERATED_MODELS_DEV_METADATA.cohere, [
  'command-a-plus-05-2026',
]);
const huggingface = GENERATED_MODELS_DEV_PROVIDER_FACTS.huggingface;
if (huggingface.id !== 'huggingface') {
  throw new Error('models.dev Hugging Face provider facts are missing stable id huggingface');
}
if (!huggingface.api) throw new Error('models.dev Hugging Face provider facts are missing api');
const huggingfaceModelIds = toolCallingModelIds(
  'Hugging Face',
  GENERATED_MODELS_DEV_METADATA.huggingface,
  ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct'],
);
const ollamaCloud = GENERATED_MODELS_DEV_PROVIDER_FACTS['ollama-cloud'];
if (ollamaCloud.id !== 'ollama-cloud') {
  throw new Error('models.dev Ollama Cloud provider facts are missing stable id ollama-cloud');
}
if (!ollamaCloud.api) throw new Error('models.dev Ollama Cloud provider facts are missing api');
const ollamaCloudActiveMetadata = Object.fromEntries(
  Object.entries(GENERATED_MODELS_DEV_METADATA['ollama-cloud']).filter(
    ([, model]) => model.lifecycle !== 'deprecated',
  ),
);
const ollamaCloudModelIds = toolCallingModelIds('Ollama Cloud', ollamaCloudActiveMetadata, [
  'qwen3.5:397b',
  'gpt-oss:120b',
]);
const zenmux = GENERATED_MODELS_DEV_PROVIDER_FACTS.zenmux;
if (zenmux.id !== 'zenmux')
  throw new Error('models.dev ZenMux provider facts are missing stable id zenmux');
if (zenmux.api !== 'https://zenmux.ai/api/v1') {
  throw new Error(
    'models.dev ZenMux provider facts are missing the official OpenAI-compatible API',
  );
}
const zenmuxModelProviderOverrides = GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES.zenmux;
if (
  zenmuxModelProviderOverrides['anthropic/claude-sonnet-4.6']?.npm !== '@ai-sdk/anthropic' ||
  zenmuxModelProviderOverrides['anthropic/claude-sonnet-4.6']?.api !==
    'https://zenmux.ai/api/anthropic/v1'
) {
  throw new Error(
    'models.dev ZenMux snapshot is missing its Anthropic model-level protocol override',
  );
}
if (zenmuxModelProviderOverrides['openai/gpt-5.4']?.npm !== '@ai-sdk/openai') {
  throw new Error(
    'models.dev ZenMux snapshot is missing its native OpenAI model-level protocol override',
  );
}
const zenmuxOpenAICompatibleMetadata = Object.fromEntries(
  Object.entries(GENERATED_MODELS_DEV_METADATA.zenmux).filter(
    ([id]) => zenmuxModelProviderOverrides[id] === undefined,
  ),
);
const zenmuxModelIds = toolCallingModelIds('ZenMux', zenmuxOpenAICompatibleMetadata, [
  'moonshotai/kimi-k2.5',
]).filter((id) => GENERATED_MODELS_DEV_METADATA.zenmux[id]?.lifecycle !== 'deprecated');
const fireworks = GENERATED_MODELS_DEV_PROVIDER_FACTS['fireworks-ai'];
if (fireworks.id !== 'fireworks-ai') {
  throw new Error('models.dev Fireworks AI provider facts are missing stable id fireworks-ai');
}
if (!fireworks.api) throw new Error('models.dev Fireworks AI provider facts are missing api');
const fireworksModelIds = toolCallingModelIds(
  'Fireworks AI',
  GENERATED_MODELS_DEV_METADATA['fireworks-ai'],
  ['accounts/fireworks/models/kimi-k2p6'],
);
const tencentTokenHub = GENERATED_MODELS_DEV_PROVIDER_FACTS['tencent-tokenhub'];
if (tencentTokenHub.id !== 'tencent-tokenhub') {
  throw new Error(
    'models.dev Tencent TokenHub provider facts are missing stable id tencent-tokenhub',
  );
}
if (!tencentTokenHub.api)
  throw new Error('models.dev Tencent TokenHub provider facts are missing api');
const tencentTokenHubModelIds = toolCallingModelIds(
  'Tencent TokenHub',
  GENERATED_MODELS_DEV_METADATA['tencent-tokenhub'],
  ['hy3', 'hy3-preview'],
);
const tencentCodingPlan = GENERATED_MODELS_DEV_PROVIDER_FACTS['tencent-coding-plan'];
if (tencentCodingPlan.id !== 'tencent-coding-plan') {
  throw new Error(
    'models.dev Tencent Coding Plan provider facts are missing stable id tencent-coding-plan',
  );
}
if (!tencentCodingPlan.api)
  throw new Error('models.dev Tencent Coding Plan provider facts are missing api');
const tencentCodingPlanModelIds = ['tc-code-latest', 'glm-5', 'minimax-m2.5', 'kimi-k2.5'] as const;
for (const id of tencentCodingPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['tencent-coding-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev Tencent Coding Plan snapshot is missing tool-capable model ${id}`);
  }
}
const volcengineCodingPlanModelIds = [
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
] as const;
const volcengineAgentPlanModelIds = [
  'ark-code-latest',
  'glm-5.3',
  'glm-5.3-flash',
  'doubao-seed-2.0-mini',
  'doubao-seed-2.0-lite',
  'deepseek-v4-flash',
  'doubao-seed-2.1-turbo',
  'doubao-seed-evolving',
  'doubao-seed-2.0-code',
  'doubao-seed-2.0-pro',
  'minimax-m2.7',
  'minimax-m3',
  'glm-5.2',
  'glm-latest',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'deepseek-v4-pro',
  'kimi-k3',
] as const;
const tencentTokenPlan = GENERATED_MODELS_DEV_PROVIDER_FACTS['tencent-token-plan'];
if (tencentTokenPlan.id !== 'tencent-token-plan') {
  throw new Error(
    'models.dev Tencent Token Plan provider facts are missing stable id tencent-token-plan',
  );
}
if (!tencentTokenPlan.api)
  throw new Error('models.dev Tencent Token Plan provider facts are missing api');
if (!GENERATED_MODELS_DEV_METADATA['tencent-token-plan'].hy3?.capabilities?.functionCalling) {
  throw new Error('models.dev Tencent Token Plan snapshot is missing tool-capable model hy3');
}
// Tencent's personal-plan docs are authoritative for this access-path allowlist.
// The inference endpoint does not publish a /models discovery contract.
const tencentTokenPlanModelIds = [
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
] as const;
const stepfun = GENERATED_MODELS_DEV_PROVIDER_FACTS.stepfun;
if (stepfun.id !== 'stepfun')
  throw new Error('models.dev StepFun provider facts are missing stable id stepfun');
if (!stepfun.api) throw new Error('models.dev StepFun provider facts are missing api');
const stepfunModelIds = toolCallingModelIds('StepFun', GENERATED_MODELS_DEV_METADATA.stepfun, [
  'step-3.7-flash',
  'step-3.5-flash-2603',
  'step-3.5-flash',
]);
const stepfunStepPlanModelIds = [
  'step-3.7-flash',
  'step-3.5-flash-2603',
  'step-3.5-flash',
  'step-router-v1',
] as const;
const stepfunStepPlan = GENERATED_MODELS_DEV_PROVIDER_FACTS['stepfun-step-plan'];
if (stepfunStepPlan.id !== 'stepfun-step-plan') {
  throw new Error(
    'models.dev StepFun Step Plan provider facts are missing stable id stepfun-step-plan',
  );
}
for (const id of stepfunStepPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['stepfun-step-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(
      `models.dev StepFun Step Plan snapshot is missing documented Step Plan model ${id}`,
    );
  }
}
const kimiCodingPlanModelIds = ['k3', 'kimi-for-coding'] as const;
for (const id of kimiCodingPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['kimi-coding-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev Kimi Coding Plan snapshot is missing documented model ${id}`);
  }
}
const stepfunGlobal = GENERATED_MODELS_DEV_PROVIDER_FACTS['stepfun-ai'];
if (stepfunGlobal.id !== 'stepfun-ai') {
  throw new Error('models.dev StepFun Global provider facts are missing stable id stepfun-ai');
}
if (!stepfunGlobal.api) throw new Error('models.dev StepFun Global provider facts are missing api');
const stepfunGlobalModelIds = ['step-3.7-flash', 'step-3.5-flash-2603', 'step-3.5-flash'];
for (const id of stepfunGlobalModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['stepfun-ai'][id]?.capabilities?.functionCalling) {
    throw new Error(
      `models.dev StepFun Global snapshot is missing documented tool-capable model ${id}`,
    );
  }
}
const stepfunGlobalStepPlan = GENERATED_MODELS_DEV_PROVIDER_FACTS['stepfun-ai-step-plan'];
if (stepfunGlobalStepPlan.id !== 'stepfun-ai-step-plan') {
  throw new Error(
    'models.dev StepFun Global Step Plan provider facts are missing stable id stepfun-ai-step-plan',
  );
}
if (!stepfunGlobalStepPlan.api) {
  throw new Error('models.dev StepFun Global Step Plan provider facts are missing api');
}
const stepfunGlobalStepPlanModelIds = [
  'step-3.7-flash',
  'step-3.5-flash-2603',
  'step-3.5-flash',
] as const;
for (const id of stepfunGlobalStepPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['stepfun-ai-step-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(
      `models.dev StepFun Global Step Plan snapshot is missing documented tool-capable model ${id}`,
    );
  }
}

const together = GENERATED_MODELS_DEV_PROVIDER_FACTS.togetherai;
if (together.id !== 'togetherai') {
  throw new Error('models.dev Together AI provider facts are missing stable id togetherai');
}
const togetherModelIds = toolCallingModelIds(
  'Together AI',
  GENERATED_MODELS_DEV_METADATA.togetherai,
  ['MiniMaxAI/MiniMax-M3'],
).filter((id) => GENERATED_MODELS_DEV_METADATA.togetherai[id]?.lifecycle !== 'deprecated');
const deepinfra = GENERATED_MODELS_DEV_PROVIDER_FACTS.deepinfra;
if (deepinfra.id !== 'deepinfra') {
  throw new Error('models.dev DeepInfra provider facts are missing stable id deepinfra');
}
const deepinfraModelIds = toolCallingModelIds(
  'DeepInfra',
  GENERATED_MODELS_DEV_METADATA.deepinfra,
  ['moonshotai/Kimi-K2.7-Code', 'moonshotai/Kimi-K2.6'],
).filter((id) => GENERATED_MODELS_DEV_METADATA.deepinfra[id]?.lifecycle !== 'deprecated');
const groq = GENERATED_MODELS_DEV_PROVIDER_FACTS.groq;
if (groq.id !== 'groq') {
  throw new Error('models.dev Groq provider facts are missing stable id groq');
}
const groqModelIds = toolCallingModelIds('Groq', GENERATED_MODELS_DEV_METADATA.groq, [
  'llama-3.3-70b-versatile',
]);
const openrouter = GENERATED_MODELS_DEV_PROVIDER_FACTS.openrouter;
if (openrouter.id !== 'openrouter' || openrouter.api !== 'https://openrouter.ai/api/v1') {
  throw new Error('models.dev OpenRouter provider facts are missing the stable id or API');
}
const openrouterModelIds = toolCallingModelIds(
  'OpenRouter',
  GENERATED_MODELS_DEV_METADATA.openrouter,
  ['anthropic/claude-sonnet-5', 'openai/gpt-5.6-sol', 'x-ai/grok-4.5', 'deepseek/deepseek-v4-pro'],
).filter((id) => GENERATED_MODELS_DEV_METADATA.openrouter[id]?.lifecycle !== 'deprecated');
const alibaba = GENERATED_MODELS_DEV_PROVIDER_FACTS.alibaba;
if (
  alibaba.id !== 'alibaba' ||
  alibaba.api !== 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
) {
  throw new Error('models.dev Alibaba provider facts are missing the stable id or API');
}
const alibabaModelIds = toolCallingModelIds('Alibaba', GENERATED_MODELS_DEV_METADATA.alibaba, [
  'qwen3.7-plus',
]);
const alibabaCn = GENERATED_MODELS_DEV_PROVIDER_FACTS['alibaba-cn'];
if (
  alibabaCn.id !== 'alibaba-cn' ||
  alibabaCn.api !== 'https://dashscope.aliyuncs.com/compatible-mode/v1'
) {
  throw new Error('models.dev Alibaba (China) provider facts are missing the stable id or API');
}
const alibabaCnModelIds = toolCallingModelIds(
  'Alibaba (China)',
  GENERATED_MODELS_DEV_METADATA['alibaba-cn'],
  ['qwen3.8-max'],
);
const alibabaCodingPlanCn = GENERATED_MODELS_DEV_PROVIDER_FACTS['alibaba-coding-plan-cn'];
if (
  alibabaCodingPlanCn.id !== 'alibaba-coding-plan-cn' ||
  alibabaCodingPlanCn.api !== 'https://coding.dashscope.aliyuncs.com/v1'
) {
  throw new Error(
    'models.dev Alibaba Coding Plan (China) provider facts are missing the stable id or API',
  );
}
const alibabaCodingPlanGlobal = GENERATED_MODELS_DEV_PROVIDER_FACTS['alibaba-coding-plan'];
if (
  alibabaCodingPlanGlobal.id !== 'alibaba-coding-plan' ||
  alibabaCodingPlanGlobal.api !== 'https://coding-intl.dashscope.aliyuncs.com/v1'
) {
  throw new Error('models.dev Alibaba Coding Plan provider facts are missing the stable id or API');
}
// Alibaba's Coding Plan docs are authoritative for this subscription allowlist; the
// plan endpoint does not publish a /models discovery contract. China and global share
// an identical tool-calling text-model snapshot (image models are excluded).
const alibabaCodingPlanModelIds = [
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
] as const;
for (const id of alibabaCodingPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['alibaba-coding-plan-cn'][id]?.capabilities?.functionCalling) {
    throw new Error(
      `models.dev Alibaba Coding Plan (China) snapshot is missing tool-capable model ${id}`,
    );
  }
  if (!GENERATED_MODELS_DEV_METADATA['alibaba-coding-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev Alibaba Coding Plan snapshot is missing tool-capable model ${id}`);
  }
}
const alibabaTokenPlanCn = GENERATED_MODELS_DEV_PROVIDER_FACTS['alibaba-token-plan-cn'];
if (alibabaTokenPlanCn.id !== 'alibaba-token-plan-cn') {
  throw new Error(
    'models.dev Alibaba Token Plan (China) provider facts are missing stable id alibaba-token-plan-cn',
  );
}
if (!alibabaTokenPlanCn.api) {
  throw new Error('models.dev Alibaba Token Plan (China) provider facts are missing api');
}
const alibabaTokenPlanGlobal = GENERATED_MODELS_DEV_PROVIDER_FACTS['alibaba-token-plan'];
if (alibabaTokenPlanGlobal.id !== 'alibaba-token-plan') {
  throw new Error(
    'models.dev Alibaba Token Plan provider facts are missing stable id alibaba-token-plan',
  );
}
if (!alibabaTokenPlanGlobal.api) {
  throw new Error('models.dev Alibaba Token Plan provider facts are missing api');
}
// Alibaba's Token Plan (Team Edition) docs are authoritative for this access-path
// allowlist. The subscription endpoint publishes no /models discovery contract, and
// the plan's image models (qwen-image / wan) are not tool-callable, so only the
// tool-calling text models are pinned here. China and global share one model list.
const alibabaTokenPlanModelIds = [
  // qwen3.8-max-preview is a retired compatibility alias which the service
  // routes to this formal id. New selections must use the billed model id.
  'qwen3.8-max',
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
] as const;
for (const id of alibabaTokenPlanModelIds) {
  if (!GENERATED_MODELS_DEV_METADATA['alibaba-token-plan-cn'][id]?.capabilities?.functionCalling) {
    throw new Error(
      `models.dev Alibaba Token Plan (China) snapshot is missing tool-capable model ${id}`,
    );
  }
  if (!GENERATED_MODELS_DEV_METADATA['alibaba-token-plan'][id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev Alibaba Token Plan snapshot is missing tool-capable model ${id}`);
  }
}
const vercel = GENERATED_MODELS_DEV_PROVIDER_FACTS.vercel;
if (vercel.id !== 'vercel') {
  throw new Error('models.dev Vercel AI Gateway provider facts are missing stable id vercel');
}
const vercelModelIds = toolCallingModelIds(
  'Vercel AI Gateway',
  GENERATED_MODELS_DEV_METADATA.vercel,
  ['anthropic/claude-opus-4.8'],
).filter((id) => GENERATED_MODELS_DEV_METADATA.vercel[id]?.lifecycle !== 'deprecated');
const moonshot = GENERATED_MODELS_DEV_PROVIDER_FACTS.moonshot;
if (moonshot.id !== 'moonshotai-cn' || moonshot.api !== 'https://api.moonshot.cn/v1') {
  throw new Error('models.dev Moonshot provider facts are missing the China platform id or API');
}
const moonshotModelIds = toolCallingModelIds('Moonshot', GENERATED_MODELS_DEV_METADATA.moonshot, [
  'kimi-k2.6',
  'kimi-k2.7-code',
]).filter((id) => GENERATED_MODELS_DEV_METADATA.moonshot[id]?.lifecycle !== 'deprecated');
const cloudflareWorkersAi = GENERATED_MODELS_DEV_PROVIDER_FACTS['cloudflare-workers-ai'];
if (cloudflareWorkersAi.id !== 'cloudflare-workers-ai') {
  throw new Error(
    'models.dev Cloudflare Workers AI provider facts are missing stable id cloudflare-workers-ai',
  );
}
if (
  cloudflareWorkersAi.api !==
  'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1'
) {
  throw new Error(
    'models.dev Cloudflare Workers AI provider facts are missing the account-scoped API',
  );
}
const cloudflareWorkersAiModelIds = toolCallingModelIds(
  'Cloudflare Workers AI',
  GENERATED_MODELS_DEV_METADATA['cloudflare-workers-ai'],
  ['@cf/moonshotai/kimi-k2.6', '@cf/moonshotai/kimi-k2.7-code'],
);
const opencode = GENERATED_MODELS_DEV_PROVIDER_FACTS.opencode;
if (opencode.id !== 'opencode' || opencode.api !== 'https://opencode.ai/zen/v1') {
  throw new Error('models.dev OpenCode Zen provider facts are missing the stable id or API');
}
const opencodeModelIds = toolCallingModelIds(
  'OpenCode Zen',
  GENERATED_MODELS_DEV_METADATA.opencode,
  ['gpt-5.5'],
).filter((id) => GENERATED_MODELS_DEV_METADATA.opencode[id]?.lifecycle !== 'deprecated');
const opencodeGo = GENERATED_MODELS_DEV_PROVIDER_FACTS['opencode-go'];
if (opencodeGo.id !== 'opencode-go' || opencodeGo.api !== 'https://opencode.ai/zen/go/v1') {
  throw new Error('models.dev OpenCode Go provider facts are missing the stable id or API');
}
const opencodeGoModelIds = toolCallingModelIds(
  'OpenCode Go',
  GENERATED_MODELS_DEV_METADATA['opencode-go'],
  ['minimax-m3'],
).filter((id) => GENERATED_MODELS_DEV_METADATA['opencode-go'][id]?.lifecycle !== 'deprecated');
// opencode-free is Maka's first-class free anonymous default. It shares the
// OpenCode Zen endpoint and model ids, exposing the active tool-capable
// models the models.dev snapshot marks `isFree` (zero input cost). Deriving
// the set from the snapshot lets routine metadata refreshes rotate free
// models in and out instead of letting a hardcoded pin rot (#3409).
//
// Persistently broken free models, excluded with dated evidence. Deny-only:
// a stale entry hides at most one healthy model, the opposite failure mode of
// the allow-list pin this replaced. Entries should be re-probed on snapshot
// refreshes and removed once the model produces content again.
// 2026-08-21 muse-spark-1.2-contributor-free: anonymous completions return
// 200 with an empty message and bill the full token budget (4 consecutive
// probes, max_tokens 8–200) — a failure shape that even "the send settles it"
// cannot surface, which is why these ids are also vetoed in
// `authorizeConnectionModel` rather than merely dropped from this derivation.
// 2026-08-30 x-preview-f-free (Ox Alpha Free): retired upstream — dropped from
// the anonymous /models listing and every completion returns HTTP 401
// {"type":"ModelError","message":"Model x-preview-f-free is not supported"}.
// models.dev still snapshots it as free+active, so the derivation kept offering
// it as a default-enabled, picker-visible row until this quarantine. Remove
// once the snapshot marks it deprecated (or upstream serves it again).
const OPENCODE_FREE_BROKEN_MODEL_IDS = new Set([
  'muse-spark-1.2-contributor-free',
  'x-preview-f-free',
]);
const opencodeFreeModelIds = toolCallingModelIds(
  'OpenCode Free',
  Object.fromEntries(
    Object.entries(GENERATED_MODELS_DEV_METADATA.opencode).filter(
      ([id, model]) =>
        model.isFree === true &&
        model.lifecycle !== 'deprecated' &&
        !OPENCODE_FREE_BROKEN_MODEL_IDS.has(id),
    ),
  ),
  [OPENCODE_FREE_DEFAULT_MODEL],
);
if (opencodeFreeModelIds[0] !== OPENCODE_FREE_DEFAULT_MODEL) {
  throw new Error(
    `models.dev opencode snapshot no longer serves ${OPENCODE_FREE_DEFAULT_MODEL} as an active tool-capable free model; pick a new OPENCODE_FREE_DEFAULT_MODEL`,
  );
}
const githubCopilot = GENERATED_MODELS_DEV_PROVIDER_FACTS['github-copilot'];
if (githubCopilot.id !== 'github-copilot') {
  throw new Error('models.dev GitHub Copilot provider facts are missing stable id github-copilot');
}
if (githubCopilot.api !== 'https://api.githubcopilot.com') {
  throw new Error(
    'models.dev GitHub Copilot provider facts are missing the Copilot subscription API',
  );
}
const githubCopilotModelIds = toolCallingModelIds(
  'GitHub Copilot',
  GENERATED_MODELS_DEV_METADATA['github-copilot'],
  ['gpt-5.4'],
);

function toolCallingModelIds(
  providerLabel: string,
  models: Readonly<Record<string, { capabilities?: { functionCalling?: boolean } }>>,
  recommendedIds: readonly string[],
): string[] {
  const entries = Object.entries(models);
  const modelsById = new Map(entries);
  return [
    ...recommendedIds.map((id) => {
      const model = modelsById.get(id);
      if (!model)
        throw new Error(`models.dev ${providerLabel} snapshot is missing recommended model ${id}`);
      return [id, model] as const;
    }),
    ...entries.filter(([id]) => !recommendedIds.includes(id)),
  ]
    .filter(([, model]) => model.capabilities?.functionCalling)
    .map(([id]) => id);
}

const providerRegistry = {
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'api_key',
    fallbackModels: [
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
    ],
    status: 'ready',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    catalogOrder: 9,
    recommendedOrder: 3,
  },
  'kimi-coding-plan': {
    label: 'Kimi Coding Plan',
    menuLabel: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    authKind: 'api_key',
    // kimi-for-coding / -highspeed intentionally have no thinking knob:
    // models.dev declares no reasoning_options for them, so the effort
    // control only appears for k3 / k3-256k. Not a sync gap.
    fallbackModels: [...kimiCodingPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://www.kimi.com/code/console',
    catalogOrder: 1,
    recommendedOrder: 5,
  },
  'minimax-coding-plan': {
    label: 'MiniMax Coding Plan',
    baseUrl: 'https://api.minimax.io/anthropic',
    authKind: 'api_key',
    fallbackModels: minimaxPlanModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://platform.minimax.io/subscribe/coding-plan',
    catalogOrder: 2,
  },
  'tencent-coding-plan': {
    label: tencentCodingPlan.name,
    baseUrl: tencentCodingPlan.api,
    authKind: 'api_key',
    fallbackModels: [...tencentCodingPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://console.cloud.tencent.com/lkeap/coding-plan',
    catalogOrder: 23,
  },
  'volcengine-coding-plan': {
    label: 'Volcengine Ark Coding Plan (China)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    authKind: 'api_key',
    fallbackModels: [...volcengineCodingPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://www.volcengine.com/activity/codingplan',
    catalogOrder: 26,
  },
  'volcengine-agent-plan': {
    label: 'Volcengine Ark Agent Plan (China)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    authKind: 'api_key',
    fallbackModels: [...volcengineAgentPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai', apiProtocol: 'openai-responses' },
    modelDiscovery: {
      kind: 'fallback',
      reason:
        'Agent Plan model discovery is a control-plane API that requires AK/SK signing; the plan API key reaches only the inference data plane',
    },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://console.volcengine.com/ark/agent-plan',
    catalogOrder: 26.5,
  },
  'tencent-token-plan': {
    label: tencentTokenPlan.name,
    baseUrl: tencentTokenPlan.api,
    authKind: 'api_key',
    fallbackModels: [...tencentTokenPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://console.cloud.tencent.com/tokenhub/tokenplan/common',
    catalogOrder: 27,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authKind: 'api_key',
    fallbackModels: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5'],
    status: 'ready',
    runtimeAdapter: { kind: 'openai', applyPatchProtocol: 'openai-structured' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://platform.openai.com/api-keys',
    catalogOrder: 10,
    recommendedOrder: 2,
  },
  google: {
    label: 'Google Gemini',
    menuLabel: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authKind: 'api_key',
    fallbackModels: [
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
    status: 'ready',
    runtimeAdapter: { kind: 'google' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    catalogOrder: 11,
    recommendedOrder: 4,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    authKind: 'api_key',
    fallbackModels: [
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
      'deepseek-reasoner',
      'deepseek-chat',
    ],
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      applyPatchProtocol: 'codex-v4a-freeform',
      responses: { adapter: 'open-responses', reasoningReplay: 'plaintext-content' },
    },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    catalogOrder: 3,
    recommendedOrder: 6,
  },
  moonshot: {
    label: 'Moonshot',
    baseUrl: moonshot.api,
    authKind: 'api_key',
    fallbackModels: moonshotModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://platform.kimi.com/console/api-keys',
    catalogOrder: 4,
  },
  'zai-coding-plan': {
    label: 'Z.AI Coding Plan',
    menuLabel: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    authKind: 'api_key',
    fallbackModels: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.5-air'],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    catalogOrder: 5,
  },
  MiniMax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    authKind: 'api_key',
    fallbackModels: ['MiniMax-M3'],
    status: 'ready',
    runtimeAdapter: { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    catalogOrder: 6,
  },
  'MiniMax-cn': {
    label: 'MiniMax 中国站',
    baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    authKind: 'api_key',
    fallbackModels: ['MiniMax-M3'],
    status: 'ready',
    runtimeAdapter: { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    catalogOrder: 7,
  },
  siliconflow: {
    label: siliconflow.name,
    baseUrl: siliconflow.api,
    authKind: 'api_key',
    fallbackModels: siliconflowModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', query: { sub_type: 'chat' } },
    category: 'domestic',
    catalogGroup: 'aggregators',
    signupUrl: siliconflow.doc,
    catalogOrder: 8,
  },
  vercel: {
    label: vercel.name,
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    authKind: 'api_key',
    fallbackModels: vercelModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', auth: 'none', filter: 'language-models' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    signupUrl: 'https://vercel.com/ai-gateway',
    catalogOrder: 31,
  },
  xai: {
    label: xai.name,
    baseUrl: 'https://api.x.ai/v1',
    authKind: 'api_key',
    fallbackModels: xaiModelIds,
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      responses: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
    },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://console.x.ai/',
    catalogOrder: 12,
  },
  'xai-oauth': {
    label: 'xAI OAuth (SuperGrok / X Premium)',
    baseUrl: 'https://api.x.ai/v1',
    authKind: 'oauth_token',
    fallbackModels: xaiModelIds,
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      responses: { adapter: 'openai', reasoningReplay: 'encrypted-content' },
    },
    modelDiscovery: {
      kind: 'protocol',
      auth: 'oauth-bearer',
    },
    category: 'oauth',
    signupUrl: 'https://x.ai/grok',
  },
  zai: {
    label: zai.name,
    baseUrl: zai.api,
    authKind: 'api_key',
    fallbackModels: zaiModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    catalogOrder: 12.1,
  },
  xiaomi: {
    label: xiaomi.name,
    baseUrl: xiaomi.api,
    authKind: 'api_key',
    fallbackModels: xiaomiModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://platform.xiaomimimo.com/',
    catalogOrder: 12.2,
  },
  'xiaomi-token-plan-cn': {
    label: xiaomiTokenPlanCn.name,
    baseUrl: xiaomiTokenPlanCn.api,
    authKind: 'api_key',
    fallbackModels: [...xiaomiTokenPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://platform.xiaomimimo.com/token-plan',
    catalogOrder: 12.3,
  },
  'xiaomi-token-plan-sgp': {
    label: xiaomiTokenPlanSgp.name,
    baseUrl: xiaomiTokenPlanSgp.api,
    authKind: 'api_key',
    fallbackModels: [...xiaomiTokenPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://platform.xiaomimimo.com/token-plan',
    catalogOrder: 12.4,
  },
  'xiaomi-token-plan-ams': {
    label: xiaomiTokenPlanAms.name,
    baseUrl: xiaomiTokenPlanAms.api,
    authKind: 'api_key',
    fallbackModels: [...xiaomiTokenPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://platform.xiaomimimo.com/token-plan',
    catalogOrder: 12.5,
  },
  cerebras: {
    label: cerebras.name,
    baseUrl: 'https://api.cerebras.ai/v1',
    authKind: 'api_key',
    fallbackModels: cerebrasModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://cloud.cerebras.ai/',
    catalogOrder: 13,
  },
  mistral: {
    label: mistral.name,
    baseUrl: 'https://api.mistral.ai/v1',
    authKind: 'api_key',
    fallbackModels: mistralModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', responseShape: 'array-or-data' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://console.mistral.ai/api-keys/',
    catalogOrder: 14,
  },
  cohere: {
    label: cohere.name,
    baseUrl: 'https://api.cohere.com/v2',
    authKind: 'api_key',
    fallbackModels: cohereModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'cohere' },
    modelDiscovery: { kind: 'cohere' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    catalogOrder: 30,
  },
  huggingface: {
    label: huggingface.name,
    baseUrl: huggingface.api,
    authKind: 'api_key',
    fallbackModels: huggingfaceModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'tool-capable' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    signupUrl: 'https://huggingface.co/settings/tokens',
    catalogOrder: 34,
  },
  zenmux: {
    label: zenmux.name,
    baseUrl: zenmux.api,
    authKind: 'api_key',
    fallbackModels: zenmuxModelIds,
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      replayAssistantReasoningAs: 'reasoning',
      replayAssistantReasoningDetails: true,
    },
    modelDiscovery: { kind: 'protocol', auth: 'none' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    signupUrl: 'https://zenmux.ai/settings/keys',
    catalogOrder: 36,
  },
  opencode: {
    label: opencode.name,
    baseUrl: opencode.api,
    authKind: 'api_key',
    fallbackModels: opencodeModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://opencode.ai/zen',
    catalogOrder: 37,
  },
  'opencode-go': {
    label: opencodeGo.name,
    baseUrl: opencodeGo.api,
    authKind: 'api_key',
    fallbackModels: opencodeGoModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://opencode.ai/go',
    catalogOrder: 38,
    recommendedOrder: 1,
  },
  'opencode-free': {
    label: 'OpenCode Free',
    baseUrl: opencode.api,
    authKind: 'none',
    fallbackModels: [...opencodeFreeModelIds],
    // Free and keyless: nothing is spent by having every shipped model on, and
    // a user who just added the connection can send immediately.
    enableShippedModelsByDefault: true,
    brokenModelIds: [...OPENCODE_FREE_BROKEN_MODEL_IDS],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: {
      kind: 'fallback',
      reason:
        'The anonymous /models listing describes the full Zen catalog with no cost facts; which models are FREE is a models.dev fact, so the derived candidates are the inventory and the send settles availability.',
    },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://opencode.ai/zen',
    catalogOrder: 0,
    recommendedOrder: 0,
  },
  togetherai: {
    label: together.name,
    baseUrl: 'https://api.together.ai/v1',
    authKind: 'api_key',
    fallbackModels: togetherModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://api.together.ai/settings/projects/~current/api-keys',
    catalogOrder: 15,
  },
  'fireworks-ai': {
    label: fireworks.name,
    baseUrl: fireworks.api,
    authKind: 'api_key',
    fallbackModels: fireworksModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: {
      kind: 'fireworks',
      accountsPath: '/v1/accounts',
      publicAccount: 'accounts/fireworks',
      query: { filter: 'supports_serverless=true', pageSize: '200' },
    },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    catalogOrder: 19,
  },
  nvidia: {
    label: 'NVIDIA',
    baseUrl: nvidia.api,
    authKind: 'api_key',
    fallbackModels: nvidiaModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://build.nvidia.com/',
    catalogOrder: 20,
  },
  'tencent-tokenhub': {
    label: tencentTokenHub.name,
    baseUrl: tencentTokenHub.api,
    authKind: 'api_key',
    fallbackModels: tencentTokenHubModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://cloud.tencent.com/document/product/1823/130090',
    catalogOrder: 21,
  },
  stepfun: {
    label: stepfun.name,
    baseUrl: stepfun.api,
    authKind: 'api_key',
    fallbackModels: stepfunModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://platform.stepfun.com/interface-key',
    catalogOrder: 22,
  },
  'stepfun-step-plan': {
    label: 'StepFun Step Plan (China)',
    baseUrl: 'https://api.stepfun.com/step_plan/v1',
    authKind: 'api_key',
    fallbackModels: [...stepfunStepPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://platform.stepfun.com/interface-key',
    catalogOrder: 28,
  },
  'stepfun-ai-step-plan': {
    label: stepfunGlobalStepPlan.name,
    baseUrl: stepfunGlobalStepPlan.api,
    authKind: 'api_key',
    fallbackModels: [...stepfunGlobalStepPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://platform.stepfun.ai/interface-key',
    catalogOrder: 32,
  },
  'stepfun-ai': {
    label: stepfunGlobal.name,
    baseUrl: stepfunGlobal.api,
    authKind: 'api_key',
    fallbackModels: stepfunGlobalModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://platform.stepfun.ai/interface-key',
    catalogOrder: 24,
  },
  'volcengine-ark': {
    label: 'Volcengine Ark (China)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authKind: 'api_key',
    fallbackModels: ['doubao-seed-2-0-pro-260215'],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: {
      kind: 'fallback',
      reason:
        'Ark model discovery is a control-plane API that requires AK/SK signing; inference API keys cannot call it',
    },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/model',
    catalogOrder: 25,
  },
  deepinfra: {
    label: deepinfra.name,
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    authKind: 'api_key',
    fallbackModels: deepinfraModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', path: '/v1/models' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://deepinfra.com/dash/api_keys',
    catalogOrder: 29,
  },
  groq: {
    label: groq.name,
    baseUrl: 'https://api.groq.com/openai/v1',
    authKind: 'api_key',
    fallbackModels: groqModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://console.groq.com/keys',
    catalogOrder: 39,
  },
  openrouter: {
    label: openrouter.name,
    baseUrl: openrouter.api,
    authKind: 'api_key',
    fallbackModels: openrouterModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    signupUrl: 'https://openrouter.ai/settings/keys',
    catalogOrder: 40,
  },
  alibaba: {
    label: alibaba.name,
    baseUrl: alibaba.api,
    authKind: 'api_key',
    fallbackModels: alibabaModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://modelstudio.console.alibabacloud.com/',
    catalogOrder: 41,
  },
  'alibaba-cn': {
    label: alibabaCn.name,
    baseUrl: alibabaCn.api,
    authKind: 'api_key',
    fallbackModels: alibabaCnModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    signupUrl: 'https://bailian.console.aliyun.com/',
    catalogOrder: 41.05,
  },
  'alibaba-coding-plan-cn': {
    label: alibabaCodingPlanCn.name,
    baseUrl: alibabaCodingPlanCn.api,
    authKind: 'api_key',
    fallbackModels: [...alibabaCodingPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://www.aliyun.com/benefit/scene/codingplan',
    catalogOrder: 41.1,
  },
  'alibaba-coding-plan': {
    label: alibabaCodingPlanGlobal.name,
    baseUrl: alibabaCodingPlanGlobal.api,
    authKind: 'api_key',
    fallbackModels: [...alibabaCodingPlanModelIds],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    catalogOrder: 41.2,
  },
  'alibaba-token-plan-cn': {
    label: alibabaTokenPlanCn.name,
    baseUrl: alibabaTokenPlanCn.api,
    authKind: 'api_key',
    fallbackModels: [...alibabaTokenPlanModelIds],
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      runtimeProfile: 'alibaba-token-plan',
    },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    signupUrl: 'https://bailian.console.aliyun.com/',
    catalogOrder: 41.3,
  },
  'alibaba-token-plan': {
    label: alibabaTokenPlanGlobal.name,
    baseUrl: alibabaTokenPlanGlobal.api,
    authKind: 'api_key',
    fallbackModels: [...alibabaTokenPlanModelIds],
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      runtimeProfile: 'alibaba-token-plan',
    },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    signupUrl: 'https://modelstudio.console.alibabacloud.com/',
    catalogOrder: 41.4,
  },
  'cloudflare-workers-ai': {
    label: cloudflareWorkersAi.name,
    baseUrl: '',
    baseUrlTemplate: cloudflareWorkersAi.api,
    authKind: 'api_key',
    fallbackModels: cloudflareWorkersAiModelIds,
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      requireBaseUrl: true,
      replayAssistantReasoningAs: 'reasoning',
    },
    modelDiscovery: { kind: 'cloudflare' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    catalogOrder: 33,
  },
  'ollama-cloud': {
    label: ollamaCloud.name,
    baseUrl: ollamaCloud.api,
    authKind: 'api_key',
    fallbackModels: ollamaCloudModelIds,
    status: 'ready',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      includeUsage: true,
      replayAssistantReasoningAs: 'reasoning',
    },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    signupUrl: 'https://ollama.com/settings/keys',
    catalogOrder: 35,
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    authKind: 'none',
    fallbackModels: ['llama3.2', 'qwen2.5-coder', 'gemma3'],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'ollama' },
    category: 'local',
    catalogGroup: 'local',
    catalogOrder: 16,
    recommendedOrder: 7,
  },
  'lm-studio': {
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    authKind: 'none',
    fallbackModels: [],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'local',
    catalogGroup: 'local',
    catalogOrder: 17,
  },
  localai: {
    label: 'LocalAI',
    baseUrl: 'http://127.0.0.1:8080/v1',
    authKind: 'optional_api_key',
    fallbackModels: ['qwen3-8b'],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'local',
    catalogGroup: 'local',
    catalogOrder: 17.5,
  },
  'openai-compatible': {
    label: 'Custom relay (OpenAI Chat-compatible)',
    baseUrl: '',
    authKind: 'api_key',
    fallbackModels: [],
    status: 'ready',
    runtimeAdapter: { kind: 'openai-compatible', name: 'connection', requireBaseUrl: true },
    relayModelProfiles: true,
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogOrder: 18,
    recommendedOrder: 7.5,
  },
  'openai-responses-compatible': {
    label: 'Custom relay (OpenAI Responses)',
    baseUrl: '',
    authKind: 'api_key',
    fallbackModels: [],
    status: 'ready',
    runtimeAdapter: { kind: 'openai', apiProtocol: 'openai-responses' },
    relayModelProfiles: true,
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogOrder: 18.1,
    recommendedOrder: 7.6,
  },
  'anthropic-compatible': {
    label: 'Custom relay (Anthropic)',
    baseUrl: '',
    authKind: 'api_key',
    fallbackModels: [],
    status: 'ready',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogOrder: 18.2,
    recommendedOrder: 7.7,
  },
  'github-copilot': {
    label: githubCopilot.name,
    baseUrl: githubCopilot.api,
    authKind: 'oauth_token',
    fallbackModels: githubCopilotModelIds,
    status: 'ready',
    runtimeAdapter: { kind: 'github-copilot' },
    modelDiscovery: { kind: 'protocol', auth: 'github-copilot' },
    category: 'oauth',
    signupUrl: 'https://github.com/features/copilot/plans',
  },
  'claude-subscription': {
    label: 'Claude Subscription (Pro / Max OAuth)',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'oauth_token',
    fallbackModels: [
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-haiku-4-5',
      'claude-sonnet-4-5-20250929',
    ],
    status: 'phase3-experimental',
    runtimeAdapter: { kind: 'unavailable' },
    retired: true,
    modelDiscovery: {
      kind: 'fallback',
      reason:
        'Subscription OAuth tokens are session-scoped (user:sessions:claude_code, no user:inference), so GET /v1/models rejects them with 401',
    },
    category: 'oauth',
  },
  'openai-codex': {
    label: 'OpenAI OAuth (ChatGPT / Codex)',
    menuLabel: 'OpenAI OAuth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authKind: 'oauth_token',
    fallbackModels: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
    status: 'phase3-experimental',
    runtimeAdapter: { kind: 'openai-codex' },
    modelDiscovery: { kind: 'protocol', auth: 'openai-codex' },
    category: 'oauth',
  },
} satisfies Record<string, ProviderDefaults>;

export type ProviderType = keyof typeof providerRegistry;
export const PROVIDER_REGISTRY: Readonly<Record<ProviderType, ProviderDefaults>> = providerRegistry;

function providerTypesByOrder(field: 'catalogOrder' | 'recommendedOrder'): ProviderType[] {
  return (Object.entries(PROVIDER_REGISTRY) as Array<[ProviderType, ProviderDefaults]>)
    .filter(([, provider]) => provider[field] !== undefined)
    .sort(([, left], [, right]) => left[field]! - right[field]!)
    .map(([providerType]) => providerType);
}

/**
 * The registry entry for a provider, or `undefined` when this build does not
 * register one.
 *
 * Sole owner of the question "is this `providerType` one we know". Plain
 * indexing cannot answer it: `providerRegistry` is an object literal, so
 * `PROVIDER_REGISTRY['__proto__']` and `['toString']` resolve to inherited
 * members and read as registered providers. Every recognition site goes
 * through here rather than repeating the own-property check.
 */
export function providerDefaultsOf(providerType: string): ProviderDefaults | undefined {
  return Object.hasOwn(PROVIDER_REGISTRY, providerType)
    ? PROVIDER_REGISTRY[providerType as ProviderType]
    : undefined;
}

/**
 * The models a provider offers with no live list to go on: the baseline it
 * ships, minus anything quarantined. This is the only reader of
 * `fallbackModels` — a provider's offline offer has exactly one authority.
 *
 * `brokenModelIds` subtracts here rather than being pruned from the baseline at
 * the source because the ids it names are ones a stored connection may still
 * carry from an older shipped list.
 */
export function providerFallbackModelIds(
  defaults: Pick<ProviderDefaults, 'fallbackModels' | 'brokenModelIds'>,
): string[] {
  const broken = new Set(defaults.brokenModelIds ?? []);
  return defaults.fallbackModels.filter((id) => !broken.has(id));
}

/**
 * The provider's name as a model row shows it, or `undefined` when this build
 * does not register the provider.
 *
 * The one answer for a picker. Clients used to keep their own tables — the
 * model menu carried ten overrides of which six restated `label` verbatim, and
 * the TUI read `label` directly — so the same provider was named three ways
 * depending on which surface the user was looking at.
 */
export function providerMenuLabel(providerType: string): string | undefined {
  const defaults = providerDefaultsOf(providerType);
  return defaults && (defaults.menuLabel ?? defaults.label);
}

/**
 * A provider Maka used to offer and no longer does. Read this rather than
 * inferring retirement from an unavailable adapter: a provider that was never
 * wired looks identical from there and is not the same thing.
 */
export function isRetiredProvider(providerType: string): boolean {
  return providerDefaultsOf(providerType)?.retired === true;
}

export const CATALOG_PROVIDER_TYPES = providerTypesByOrder('catalogOrder');
export const RECOMMENDED_PROVIDER_TYPES = providerTypesByOrder('recommendedOrder');
