import type { BackendKind } from './session.js';
import {
  GENERATED_MODELS_DEV_METADATA,
  GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES,
  GENERATED_MODELS_DEV_PROVIDER_FACTS,
} from './model-metadata.generated.js';

export type ProviderCategory = 'oauth' | 'domestic' | 'overseas' | 'local' | 'custom';
export type ProviderCatalogGroup = 'recommended' | 'plans' | 'api' | 'aggregators' | 'local';

export type ProviderRuntimeAdapter =
  | { kind: 'anthropic'; auth: 'api-key' | 'bearer'; normalizeBaseUrl: boolean }
  | { kind: 'claude-subscription' }
  | { kind: 'openai'; apiProtocol?: 'openai-chat' | 'openai-responses' }
  | { kind: 'openai-codex' }
  | { kind: 'google'; normalizeBaseUrl?: boolean }
  | { kind: 'github-copilot' }
  | { kind: 'cohere' }
  | {
      kind: 'openai-compatible';
      name: 'provider' | 'connection';
      includeUsage?: boolean;
      passFetch?: boolean;
      requireBaseUrl?: boolean;
      replayAssistantReasoningAs?: 'reasoning';
      replayAssistantReasoningDetails?: true;
    }
  | { kind: 'unavailable' };

export type ProviderModelDiscovery =
  | {
      kind: 'protocol';
      auth?: 'claude-subscription' | 'github-copilot' | 'openai-codex' | 'none';
      path?: string;
      query?: Readonly<Record<string, string>>;
      responseShape?: 'array-or-data';
      filter?: 'fallback-models' | 'language-models' | 'tool-capable';
    }
  | {
      kind: 'fireworks';
      accountsPath: string;
      publicAccount: string;
      query: Readonly<Record<string, string>>;
    }
  | { kind: 'fallback' }
  | { kind: 'ollama' }
  | { kind: 'cohere' };

export interface ProviderDefaults {
  label: string;
  description: string;
  baseUrl: string;
  baseUrlTemplate?: string;
  authKind: 'api_key' | 'optional_api_key' | 'oauth_token' | 'none';
  backendKind: BackendKind;
  fallbackModels: string[];
  status: 'ready' | 'phase3-experimental';
  protocol: 'anthropic' | 'openai' | 'google' | 'cohere';
  runtimeAdapter: ProviderRuntimeAdapter;
  modelDiscovery: ProviderModelDiscovery;
  category: ProviderCategory;
  catalogGroup?: ProviderCatalogGroup;
  catalogBadge?: string;
  signupUrl?: string;
  modelsDevId?: string;
  readyOrder?: number;
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
const minimaxPlanModelIds = toolCallingModelIds('MiniMax', GENERATED_MODELS_DEV_METADATA.MiniMax, [
  'MiniMax-M3',
]);

const xai = GENERATED_MODELS_DEV_PROVIDER_FACTS.xai;
if (xai.id !== 'xai') throw new Error('models.dev xAI provider facts are missing stable id xai');
const xaiModelIds = toolCallingModelIds('xAI', GENERATED_MODELS_DEV_METADATA.xai, ['grok-4.5']);
const xiaomi = GENERATED_MODELS_DEV_PROVIDER_FACTS.xiaomi;
if (xiaomi.id !== 'xiaomi' || !xiaomi.api) {
  throw new Error('models.dev Xiaomi provider facts are missing stable id xiaomi or api');
}
const xiaomiModelIds = toolCallingModelIds('Xiaomi', GENERATED_MODELS_DEV_METADATA.xiaomi, [
  'mimo-v2.5',
]);
// Xiaomi MiMo Token Plan is a coding-only subscription whose /v1 endpoint publishes no
// /models discovery contract, so this checked-in allowlist is authoritative. models.dev's
// snapshot still carries the deprecated mimo-v2-pro and the speech-only mimo-v2-tts, which
// must never enter the chat/tool-calling fallback set — pin the two documented MiMo chat models.
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
]);

const mistral = GENERATED_MODELS_DEV_PROVIDER_FACTS.mistral;
if (mistral.id !== 'mistral')
  throw new Error('models.dev Mistral provider facts are missing stable id mistral');
const mistralModelIds = toolCallingModelIds('Mistral', GENERATED_MODELS_DEV_METADATA.mistral, [
  'mistral-large-latest',
]);
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
]);
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
for (const id of stepfunStepPlanModelIds.slice(0, 3)) {
  if (!GENERATED_MODELS_DEV_METADATA.stepfun[id]?.capabilities?.functionCalling) {
    throw new Error(`models.dev StepFun snapshot is missing documented Step Plan model ${id}`);
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
);
const deepinfra = GENERATED_MODELS_DEV_PROVIDER_FACTS.deepinfra;
if (deepinfra.id !== 'deepinfra') {
  throw new Error('models.dev DeepInfra provider facts are missing stable id deepinfra');
}
const deepinfraModelIds = toolCallingModelIds(
  'DeepInfra',
  GENERATED_MODELS_DEV_METADATA.deepinfra,
  ['moonshotai/Kimi-K2.7-Code', 'moonshotai/Kimi-K2.6'],
);
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
    description: 'Claude API key access for production agents.',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
      'claude-haiku-4-5-20251001',
      'claude-3-5-haiku-20241022',
    ],
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    readyOrder: 1,
    catalogOrder: 9,
    recommendedOrder: 2,
  },
  'kimi-coding-plan': {
    label: 'Kimi Coding Plan',
    description: 'Kimi for Coding over selectable Anthropic- or OpenAI-compatible protocol.',
    baseUrl: 'https://api.kimi.com/coding/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['k3', 'kimi-for-coding'],
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://www.kimi.com/code/console',
    readyOrder: 15,
    catalogOrder: 1,
    recommendedOrder: 5,
  },
  'minimax-coding-plan': {
    label: 'MiniMax Coding Plan',
    description: 'MiniMax Token Plan over Anthropic-compatible protocol.',
    baseUrl: 'https://api.minimax.io/anthropic',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: minimaxPlanModelIds,
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://platform.minimax.io/subscribe/coding-plan',
    modelsDevId: GENERATED_MODELS_DEV_PROVIDER_FACTS.MiniMax.id,
    readyOrder: 17,
    catalogOrder: 2,
  },
  'tencent-coding-plan': {
    label: tencentCodingPlan.name,
    description: 'Tencent Cloud Coding Plan for interactive coding agents.',
    baseUrl: tencentCodingPlan.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...tencentCodingPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://console.cloud.tencent.com/lkeap/coding-plan',
    modelsDevId: tencentCodingPlan.id,
    readyOrder: 23,
    catalogOrder: 23,
  },
  'volcengine-coding-plan': {
    label: 'Volcengine Ark Coding Plan (China)',
    description: 'Volcengine Ark subscription for interactive AI coding tools.',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...volcengineCodingPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://www.volcengine.com/activity/codingplan',
    readyOrder: 26,
    catalogOrder: 26,
  },
  'tencent-token-plan': {
    label: tencentTokenPlan.name,
    description: 'Tencent Cloud Token Plan for interactive personal agents and coding tools.',
    baseUrl: tencentTokenPlan.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...tencentTokenPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Token',
    signupUrl: 'https://console.cloud.tencent.com/tokenhub/tokenplan/common',
    modelsDevId: tencentTokenPlan.id,
    readyOrder: 27,
    catalogOrder: 27,
  },
  openai: {
    label: 'OpenAI',
    description: 'GPT API key access, including Responses API models.',
    baseUrl: 'https://api.openai.com/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-5'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.openai.com/api-keys',
    readyOrder: 2,
    catalogOrder: 10,
    recommendedOrder: 3,
  },
  google: {
    label: 'Google Gemini',
    description: 'Gemini API key access from Google AI Studio.',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    status: 'ready',
    protocol: 'google',
    runtimeAdapter: { kind: 'google' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    readyOrder: 3,
    catalogOrder: 11,
    recommendedOrder: 4,
  },
  deepseek: {
    label: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models.',
    baseUrl: 'https://api.deepseek.com',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['deepseek-chat', 'deepseek-reasoner'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.deepseek.com/api_keys',
    readyOrder: 4,
    catalogOrder: 3,
    recommendedOrder: 6,
  },
  moonshot: {
    label: 'Moonshot',
    description: 'Moonshot Kimi API key access.',
    baseUrl: moonshot.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: moonshotModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.kimi.com/console/api-keys',
    modelsDevId: moonshot.id,
    readyOrder: 5,
    catalogOrder: 4,
  },
  'zai-coding-plan': {
    label: 'Z.AI Coding Plan',
    description: 'GLM coding plan over OpenAI-compatible protocol.',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['glm-4.7', 'glm-4.6', 'glm-4.5-air'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Coding',
    signupUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    readyOrder: 6,
    catalogOrder: 5,
  },
  MiniMax: {
    label: 'MiniMax',
    description: 'MiniMax M-series over Anthropic-compatible protocol.',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['MiniMax-M3'],
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    readyOrder: 7,
    catalogOrder: 6,
  },
  'MiniMax-cn': {
    label: 'MiniMax 中国站',
    description: 'MiniMax M-series (China) over Anthropic-compatible protocol.',
    baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['MiniMax-M3'],
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    readyOrder: 8,
    catalogOrder: 7,
  },
  siliconflow: {
    label: siliconflow.name,
    description: 'Hosted multi-model API with exact upstream model ids.',
    baseUrl: siliconflow.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: siliconflowModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider', passFetch: true },
    modelDiscovery: { kind: 'protocol', query: { sub_type: 'chat' } },
    category: 'domestic',
    catalogGroup: 'aggregators',
    catalogBadge: 'Aggregator',
    signupUrl: siliconflow.doc,
    modelsDevId: siliconflow.id,
    readyOrder: 9,
    catalogOrder: 8,
    recommendedOrder: 1,
  },
  vercel: {
    label: vercel.name,
    description: 'One API key for hosted models with exact creator/model ids.',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: vercelModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', auth: 'none', filter: 'language-models' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    catalogBadge: 'Gateway',
    signupUrl: 'https://vercel.com/ai-gateway',
    modelsDevId: vercel.id,
    readyOrder: 31,
    catalogOrder: 31,
  },
  xai: {
    label: xai.name,
    description: 'Grok models for chat, reasoning, vision, and tool use.',
    baseUrl: 'https://api.x.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: xaiModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.x.ai/',
    modelsDevId: xai.id,
    readyOrder: 10,
    catalogOrder: 12,
  },
  zai: {
    label: zai.name,
    description: 'GLM models for reasoning, vision, coding, and tool use.',
    baseUrl: zai.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: zaiModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    modelsDevId: zai.id,
    readyOrder: 10.1,
    catalogOrder: 12.1,
  },
  xiaomi: {
    label: xiaomi.name,
    description: 'MiMo models for multimodal reasoning, coding, and tool use.',
    baseUrl: xiaomi.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: xiaomiModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.xiaomimimo.com/',
    modelsDevId: xiaomi.id,
    readyOrder: 10.2,
    catalogOrder: 12.2,
  },
  'xiaomi-token-plan-cn': {
    label: xiaomiTokenPlanCn.name,
    description:
      'Xiaomi MiMo Token Plan (China) subscription for interactive coding agents and tools.',
    baseUrl: xiaomiTokenPlanCn.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...xiaomiTokenPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Token',
    signupUrl: 'https://platform.xiaomimimo.com/token-plan',
    modelsDevId: xiaomiTokenPlanCn.id,
    readyOrder: 10.3,
    catalogOrder: 12.3,
  },
  'xiaomi-token-plan-sgp': {
    label: xiaomiTokenPlanSgp.name,
    description:
      'Xiaomi MiMo Token Plan (Singapore) subscription for interactive coding agents and tools.',
    baseUrl: xiaomiTokenPlanSgp.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...xiaomiTokenPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Token',
    signupUrl: 'https://platform.xiaomimimo.com/token-plan',
    modelsDevId: xiaomiTokenPlanSgp.id,
    readyOrder: 10.4,
    catalogOrder: 12.4,
  },
  'xiaomi-token-plan-ams': {
    label: xiaomiTokenPlanAms.name,
    description:
      'Xiaomi MiMo Token Plan (Europe) subscription for interactive coding agents and tools.',
    baseUrl: xiaomiTokenPlanAms.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...xiaomiTokenPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Token',
    signupUrl: 'https://platform.xiaomimimo.com/token-plan',
    modelsDevId: xiaomiTokenPlanAms.id,
    readyOrder: 10.5,
    catalogOrder: 12.5,
  },
  cerebras: {
    label: cerebras.name,
    description: 'Fast hosted open-model inference with reasoning and tool use.',
    baseUrl: 'https://api.cerebras.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: cerebrasModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://cloud.cerebras.ai/',
    modelsDevId: cerebras.id,
    readyOrder: 11,
    catalogOrder: 13,
  },
  mistral: {
    label: mistral.name,
    description: 'Mistral chat, coding, vision, reasoning, and tool-use models.',
    baseUrl: 'https://api.mistral.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: mistralModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', responseShape: 'array-or-data' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.mistral.ai/api-keys/',
    modelsDevId: mistral.id,
    readyOrder: 12,
    catalogOrder: 14,
  },
  cohere: {
    label: cohere.name,
    description: 'Cohere native Chat API for reasoning, vision, and tool-use models.',
    baseUrl: 'https://api.cohere.com/v2',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: cohereModelIds,
    status: 'ready',
    protocol: 'cohere',
    runtimeAdapter: { kind: 'cohere' },
    modelDiscovery: { kind: 'cohere' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    modelsDevId: cohere.id,
    readyOrder: 30,
    catalogOrder: 30,
  },
  huggingface: {
    label: huggingface.name,
    description:
      'Inference Providers router for chat, reasoning, and tool use across hosted models.',
    baseUrl: huggingface.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: huggingfaceModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'tool-capable' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    catalogBadge: 'Router',
    signupUrl: 'https://huggingface.co/settings/tokens',
    modelsDevId: huggingface.id,
    readyOrder: 34,
    catalogOrder: 34,
  },
  zenmux: {
    label: zenmux.name,
    description: 'One API key for routed models with exact creator/model ids.',
    baseUrl: zenmux.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: zenmuxModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      replayAssistantReasoningAs: 'reasoning',
      replayAssistantReasoningDetails: true,
    },
    modelDiscovery: { kind: 'protocol', auth: 'none', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    catalogBadge: 'Gateway',
    signupUrl: 'https://zenmux.ai/settings/keys',
    modelsDevId: zenmux.id,
    readyOrder: 36,
    catalogOrder: 36,
  },
  opencode: {
    label: opencode.name,
    description: 'Curated pay-as-you-go models for coding agents, with model-specific protocols.',
    baseUrl: opencode.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: opencodeModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Plan',
    signupUrl: 'https://opencode.ai/zen',
    modelsDevId: opencode.id,
    readyOrder: 37,
    catalogOrder: 37,
  },
  'opencode-go': {
    label: opencodeGo.name,
    description: 'Low-cost subscription access to curated open coding models.',
    baseUrl: opencodeGo.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: opencodeGoModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Plan',
    signupUrl: 'https://opencode.ai/go',
    modelsDevId: opencodeGo.id,
    readyOrder: 38,
    catalogOrder: 38,
  },
  togetherai: {
    label: together.name,
    description: 'Hosted open models for chat, reasoning, vision, and tool use.',
    baseUrl: 'https://api.together.ai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: togetherModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://api.together.ai/settings/projects/~current/api-keys',
    modelsDevId: together.id,
    readyOrder: 18,
    catalogOrder: 15,
  },
  'fireworks-ai': {
    label: fireworks.name,
    description: 'Serverless open models with exact Fireworks model paths.',
    baseUrl: fireworks.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: fireworksModelIds,
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
    modelsDevId: fireworks.id,
    readyOrder: 19,
    catalogOrder: 19,
  },
  nvidia: {
    label: 'NVIDIA',
    description: 'NVIDIA-hosted models for reasoning, vision, and tool use.',
    baseUrl: nvidia.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: nvidiaModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://build.nvidia.com/',
    modelsDevId: nvidia.id,
    readyOrder: 20,
    catalogOrder: 20,
  },
  'tencent-tokenhub': {
    label: tencentTokenHub.name,
    description: 'Tencent TokenHub models for reasoning and tool-use agents.',
    baseUrl: tencentTokenHub.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: tencentTokenHubModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://cloud.tencent.com/document/product/1823/130090',
    modelsDevId: tencentTokenHub.id,
    readyOrder: 21,
    catalogOrder: 21,
  },
  stepfun: {
    label: stepfun.name,
    description: 'StepFun China models for multimodal reasoning and tool-use agents.',
    baseUrl: stepfun.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: stepfunModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.stepfun.com/interface-key',
    modelsDevId: stepfun.id,
    readyOrder: 22,
    catalogOrder: 22,
  },
  'stepfun-step-plan': {
    label: 'StepFun Step Plan (China)',
    description: 'StepFun subscription access for interactive coding and agent tools in China.',
    baseUrl: 'https://api.stepfun.com/step_plan/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...stepfunStepPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Plan',
    signupUrl: 'https://platform.stepfun.com/interface-key',
    modelsDevId: stepfun.id,
    readyOrder: 28,
    catalogOrder: 28,
  },
  'stepfun-ai-step-plan': {
    label: stepfunGlobalStepPlan.name,
    description: 'StepFun Global subscription access for interactive coding and agent tools.',
    baseUrl: stepfunGlobalStepPlan.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...stepfunGlobalStepPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Plan',
    signupUrl: 'https://platform.stepfun.ai/interface-key',
    modelsDevId: stepfunGlobalStepPlan.id,
    readyOrder: 32,
    catalogOrder: 32,
  },
  'stepfun-ai': {
    label: stepfunGlobal.name,
    description: 'StepFun Global models for multimodal reasoning and tool-use agents.',
    baseUrl: stepfunGlobal.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: stepfunGlobalModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://platform.stepfun.ai/interface-key',
    modelsDevId: stepfunGlobal.id,
    readyOrder: 24,
    catalogOrder: 24,
  },
  'volcengine-ark': {
    label: 'Volcengine Ark (China)',
    description: 'Volcengine Ark direct API for reasoning and tool-use agents in China.',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['doubao-seed-2-0-pro-260215'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/model',
    readyOrder: 25,
    catalogOrder: 25,
  },
  deepinfra: {
    label: deepinfra.name,
    description: 'Hosted open models for multimodal reasoning and tool-use agents.',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: deepinfraModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', path: '/v1/models', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://deepinfra.com/dash/api_keys',
    modelsDevId: deepinfra.id,
    readyOrder: 29,
    catalogOrder: 29,
  },
  groq: {
    label: groq.name,
    description: 'Ultra-fast LPU-hosted open models with reasoning and tool use.',
    baseUrl: 'https://api.groq.com/openai/v1',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: groqModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://console.groq.com/keys',
    modelsDevId: groq.id,
    readyOrder: 39,
    catalogOrder: 39,
  },
  openrouter: {
    label: openrouter.name,
    description: 'One API key across all major model labs — an OpenAI-compatible aggregator.',
    baseUrl: openrouter.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: openrouterModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'aggregators',
    catalogBadge: '聚合',
    signupUrl: 'https://openrouter.ai/settings/keys',
    modelsDevId: openrouter.id,
    readyOrder: 40,
    catalogOrder: 40,
  },
  alibaba: {
    label: alibaba.name,
    description: 'Alibaba Cloud Qwen models for multimodal reasoning, coding, and tool use.',
    baseUrl: alibaba.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: alibabaModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol', filter: 'fallback-models' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://modelstudio.console.alibabacloud.com/',
    modelsDevId: alibaba.id,
    readyOrder: 41,
    catalogOrder: 41,
  },
  'alibaba-coding-plan-cn': {
    label: alibabaCodingPlanCn.name,
    description: 'Alibaba Cloud Model Studio Coding Plan (China) for interactive AI coding tools.',
    baseUrl: alibabaCodingPlanCn.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...alibabaCodingPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Plan',
    signupUrl: 'https://www.aliyun.com/benefit/scene/codingplan',
    modelsDevId: alibabaCodingPlanCn.id,
    readyOrder: 41.1,
    catalogOrder: 41.1,
  },
  'alibaba-coding-plan': {
    label: alibabaCodingPlanGlobal.name,
    description: 'Alibaba Cloud Model Studio Coding Plan for interactive AI coding tools.',
    baseUrl: alibabaCodingPlanGlobal.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...alibabaCodingPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Plan',
    signupUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    modelsDevId: alibabaCodingPlanGlobal.id,
    readyOrder: 41.2,
    catalogOrder: 41.2,
  },
  'alibaba-token-plan-cn': {
    label: alibabaTokenPlanCn.name,
    description:
      'Alibaba Cloud Model Studio Token Plan (Team Edition) for interactive agents and coding tools, Beijing region.',
    baseUrl: alibabaTokenPlanCn.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...alibabaTokenPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'domestic',
    catalogGroup: 'plans',
    catalogBadge: 'Token',
    signupUrl: 'https://bailian.console.aliyun.com/',
    modelsDevId: alibabaTokenPlanCn.id,
    readyOrder: 41.3,
    catalogOrder: 41.3,
  },
  'alibaba-token-plan': {
    label: alibabaTokenPlanGlobal.name,
    description:
      'Alibaba Cloud Model Studio Token Plan (Team Edition) for interactive agents and coding tools, Singapore region.',
    baseUrl: alibabaTokenPlanGlobal.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [...alibabaTokenPlanModelIds],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'fallback' },
    category: 'overseas',
    catalogGroup: 'plans',
    catalogBadge: 'Token',
    signupUrl: 'https://modelstudio.console.alibabacloud.com/',
    modelsDevId: alibabaTokenPlanGlobal.id,
    readyOrder: 41.4,
    catalogOrder: 41.4,
  },
  'cloudflare-workers-ai': {
    label: cloudflareWorkersAi.name,
    description: 'Cloudflare-hosted models over the account-scoped Workers AI API.',
    baseUrl: '',
    baseUrlTemplate: cloudflareWorkersAi.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: cloudflareWorkersAiModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      requireBaseUrl: true,
      replayAssistantReasoningAs: 'reasoning',
    },
    modelDiscovery: { kind: 'fallback' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    modelsDevId: cloudflareWorkersAi.id,
    readyOrder: 33,
    catalogOrder: 33,
  },
  'ollama-cloud': {
    label: ollamaCloud.name,
    description: 'Ollama-hosted cloud models over the official remote API.',
    baseUrl: ollamaCloud.api,
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ollamaCloudModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: {
      kind: 'openai-compatible',
      name: 'provider',
      includeUsage: true,
      replayAssistantReasoningAs: 'reasoning',
    },
    modelDiscovery: { kind: 'protocol' },
    category: 'overseas',
    catalogGroup: 'api',
    catalogBadge: 'API',
    signupUrl: 'https://ollama.com/settings/keys',
    modelsDevId: ollamaCloud.id,
    readyOrder: 35,
    catalogOrder: 35,
  },
  ollama: {
    label: 'Ollama',
    description: 'Local models from Ollama on this machine.',
    baseUrl: 'http://127.0.0.1:11434/v1',
    authKind: 'none',
    backendKind: 'ai-sdk',
    fallbackModels: ['llama3.2', 'qwen2.5-coder', 'gemma3'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'ollama' },
    category: 'local',
    catalogGroup: 'local',
    catalogBadge: 'Local',
    readyOrder: 13,
    catalogOrder: 16,
    recommendedOrder: 7,
  },
  'lm-studio': {
    label: 'LM Studio',
    description: 'Local models served by LM Studio on this machine.',
    baseUrl: 'http://127.0.0.1:1234/v1',
    authKind: 'none',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'local',
    catalogGroup: 'local',
    catalogBadge: 'Local',
    readyOrder: 14,
    catalogOrder: 17,
  },
  localai: {
    label: 'LocalAI',
    description: 'Local models served by LocalAI with optional API-key protection.',
    baseUrl: 'http://127.0.0.1:8080/v1',
    authKind: 'optional_api_key',
    backendKind: 'ai-sdk',
    fallbackModels: ['qwen3-8b'],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'provider' },
    modelDiscovery: { kind: 'protocol' },
    category: 'local',
    catalogGroup: 'local',
    catalogBadge: 'Local',
    readyOrder: 14.5,
    catalogOrder: 17.5,
  },
  'openai-compatible': {
    label: 'Custom relay (OpenAI Chat-compatible)',
    description: 'Custom OpenAI Chat Completions-compatible relay, proxy, or self-hosted gateway.',
    baseUrl: '',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-compatible', name: 'connection', requireBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogBadge: 'Relay',
    readyOrder: 16,
    catalogOrder: 18,
    recommendedOrder: 7.5,
  },
  'openai-responses-compatible': {
    label: 'Custom relay (OpenAI Responses)',
    description: 'Custom OpenAI Responses-compatible relay, proxy, or self-hosted gateway.',
    baseUrl: '',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai', apiProtocol: 'openai-responses' },
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogBadge: 'Responses',
    readyOrder: 16.1,
    catalogOrder: 18.1,
    recommendedOrder: 7.6,
  },
  'anthropic-compatible': {
    label: 'Custom relay (Anthropic)',
    description: 'Custom Anthropic Messages-compatible relay, proxy, or self-hosted gateway.',
    baseUrl: '',
    authKind: 'api_key',
    backendKind: 'ai-sdk',
    fallbackModels: [],
    status: 'ready',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true },
    modelDiscovery: { kind: 'protocol' },
    category: 'custom',
    catalogGroup: 'aggregators',
    catalogBadge: 'Anthropic',
    readyOrder: 16.2,
    catalogOrder: 18.2,
    recommendedOrder: 7.7,
  },
  'github-copilot': {
    label: githubCopilot.name,
    description: 'GitHub Copilot subscription access using an existing supported GitHub login.',
    baseUrl: githubCopilot.api,
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: githubCopilotModelIds,
    status: 'ready',
    protocol: 'openai',
    runtimeAdapter: { kind: 'github-copilot' },
    modelDiscovery: { kind: 'protocol', auth: 'github-copilot' },
    category: 'oauth',
    catalogBadge: 'Account',
    signupUrl: 'https://github.com/features/copilot/plans',
    modelsDevId: githubCopilot.id,
  },
  'claude-subscription': {
    label: 'Claude Subscription (Pro / Max OAuth)',
    description: 'Claude app subscription auth path, hidden behind the internal experimental gate.',
    baseUrl: 'https://api.anthropic.com',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: [
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-1-20250805',
      'claude-haiku-4-5-20251001',
    ],
    status: 'phase3-experimental',
    protocol: 'anthropic',
    runtimeAdapter: { kind: 'claude-subscription' },
    modelDiscovery: { kind: 'protocol', auth: 'claude-subscription' },
    category: 'oauth',
    catalogBadge: 'Experimental',
  },
  'openai-codex': {
    label: 'OpenAI OAuth (ChatGPT / Codex)',
    description: 'ChatGPT/Codex account OAuth path for OpenAI Responses models.',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
    status: 'phase3-experimental',
    protocol: 'openai',
    runtimeAdapter: { kind: 'openai-codex' },
    modelDiscovery: { kind: 'protocol', auth: 'openai-codex' },
    category: 'oauth',
    catalogBadge: 'Account',
  },
  'gemini-cli': {
    label: 'Gemini CLI OAuth',
    description: 'Google account path is tracked separately from ready API-key providers.',
    baseUrl: '',
    authKind: 'oauth_token',
    backendKind: 'ai-sdk',
    fallbackModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    status: 'phase3-experimental',
    protocol: 'google',
    runtimeAdapter: { kind: 'unavailable' },
    modelDiscovery: { kind: 'protocol' },
    category: 'oauth',
    catalogBadge: 'Account',
  },
} satisfies Record<string, ProviderDefaults>;

export type ProviderType = keyof typeof providerRegistry;
export const PROVIDER_REGISTRY: Readonly<Record<ProviderType, ProviderDefaults>> = providerRegistry;

function providerTypesByOrder(
  field: 'readyOrder' | 'catalogOrder' | 'recommendedOrder',
): ProviderType[] {
  return (Object.entries(PROVIDER_REGISTRY) as Array<[ProviderType, ProviderDefaults]>)
    .filter(([, provider]) => provider[field] !== undefined)
    .sort(([, left], [, right]) => left[field]! - right[field]!)
    .map(([providerType]) => providerType);
}

export const READY_PROVIDER_TYPES = providerTypesByOrder('readyOrder');
export const CATALOG_PROVIDER_TYPES = providerTypesByOrder('catalogOrder');
export const RECOMMENDED_PROVIDER_TYPES = providerTypesByOrder('recommendedOrder');

/**
 * Persisted providerType aliases renamed away in the current registry. Each
 * entry maps a legacy persisted id to its current id so connections stored
 * before a rename keep working without a destructive on-disk migration.
 *
 * The alias normalizes the `providerType` field only. Persisted connection
 * slugs and credential-store keys (e.g. the `codex-subscription` slug used by
 * the OpenAI Codex OAuth service) are intentionally left untouched so existing
 * OAuth tokens remain reachable.
 */
const PROVIDER_TYPE_ALIASES: Readonly<Record<string, ProviderType>> = {
  'codex-subscription': 'openai-codex',
};

export function normalizeProviderType(type: string): ProviderType {
  return PROVIDER_TYPE_ALIASES[type] ?? (type as ProviderType);
}
