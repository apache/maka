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
  modalities?: ModelInfo['modalities'];
  endpointRoles?: ModelInfo['endpointRoles'];
  transports?: ModelInfo['transports'];
  transcriptOutput?: boolean;
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
  const metadataProviderType =
    providerType === 'xai-oauth'
      ? 'xai'
      : providerType === 'opencode-free'
        ? 'opencode'
        : providerType;
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
    endpointRoles: override.endpointRoles ?? generated.endpointRoles,
    transports: override.transports ?? generated.transports,
    transcriptOutput: override.transcriptOutput ?? generated.transcriptOutput,
  };
}

/**
 * All model ids a provider can resolve metadata for, under the same alias
 * rules `lookupModelMetadata` applies. Contract tests sweep this universe so
 * the declaration-to-wire invariant cannot silently shrink.
 */
export function modelMetadataIdsForProvider(providerType: ProviderType): string[] {
  const metadataProviderType =
    providerType === 'xai-oauth'
      ? 'xai'
      : providerType === 'opencode-free'
        ? 'opencode'
        : providerType;
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
  return (providerType === 'deepseek' && id === 'deepseek-v4-flash') ||
    /^gpt-5/i.test(id) ||
    ((providerType === 'xai' || providerType === 'xai-oauth') && id === 'grok-4.5')
    ? 'openai-responses'
    : 'openai-chat';
}

/**
 * Anthropic model families whose every member reads images.
 *
 * The generated table is a snapshot of models.dev, so a Claude released after
 * that snapshot is simply absent from it — `lookupModelMetadata('anthropic',
 * 'claude-opus-5')` returns `{}` today. Absent used to resolve to "no vision",
 * which is the wrong default for this provider: every Claude in these families
 * accepts image input, and the fail-closed rule was written for text-only
 * models, not for models nobody has listed yet.
 *
 * The two mistakes are not symmetrical. Sending an image to a Claude that
 * turned out not to read it costs one turn and produces a message. Withholding
 * it silently drops the user's attachment and downgrades an image tool result
 * to a sentence, with nothing on screen to explain why, until someone
 * regenerates the table.
 *
 * Anthropic has used two id shapes, and both have to match. From Claude 4 on
 * the family comes first (`claude-opus-5`); before that the version came first
 * and the family sat behind it (`claude-3-5-sonnet-20241022`,
 * `claude-3-opus-20240229`). The pre-4 ids are the ones most likely to be
 * pinned by hand, none of them is in the generated table, and all of them read
 * images — so `(?:[\d.]+-)*` skips any leading version segments before the
 * family name.
 *
 * What must keep missing is the generation that genuinely cannot read images:
 * `claude-2.1`, `claude-2.0` and `claude-instant-*` have no family segment at
 * all, so they never reach the alternation.
 *
 * A connection that reports `vision` still wins over this, in both directions.
 */
const VISION_BY_DEFAULT = /^claude-(?:[\d.]+-)*(?:opus|sonnet|haiku|fable)\b/;

/**
 * The providers whose bare `claude-*` ids are Anthropic's own models.
 *
 * Both fetch over the Anthropic protocol and both store the bare `{ id }`
 * entries that leave `vision` unknown, and `claude-subscription` is usually
 * where a new Claude becomes usable first — it is the same table of models
 * reached through a subscription instead of an API key.
 *
 * Deliberately narrower than "speaks the Anthropic protocol". `anthropic`
 * and `claude-subscription` are the only two whose base URL is Anthropic's own;
 * `anthropic-compatible`, `kimi-coding-plan` and `minimax-coding-plan` share
 * the wire format while serving somebody else's models, and a `claude-`
 * prefixed id there says nothing about what is behind it. The same goes for
 * aggregators like OpenRouter, which do serve Claude but under ids the
 * generated table already carries.
 */
const VISION_BY_DEFAULT_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'claude-subscription',
]);

/**
 * Resolve whether a model accepts image input for the send path.
 *
 * Stored `connection.models` win when they declare `vision` explicitly
 * (provider-fetched facts). But `model-fetcher` stores bare `{ id }` entries
 * for many providers, and older connections predate any enrichment — so when
 * `vision` is unknown we fall back to the generated models.dev snapshot and
 * access-path-specific in-repo overrides.
 *
 * Unknown then resolves to false — the send path stays fail-closed for
 * text-only models — with one exception: an unlisted Claude on one of
 * Anthropic's own providers resolves to true, because there absent means
 * "newer than the snapshot" rather than "text-only". See
 * {@link VISION_BY_DEFAULT}.
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
  const metadata = lookupModelMetadata(providerType, modelId);
  if (metadata.capabilities?.vision !== undefined) {
    return metadata.capabilities.vision === true;
  }
  return VISION_BY_DEFAULT_PROVIDERS.has(providerType) && VISION_BY_DEFAULT.test(modelId.trim());
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

const OPENAI_MODEL_OVERRIDES: Record<string, ModelMetadata> = {
  'gpt-audio': openAiAudioChatModel(),
  'gpt-audio-mini': openAiAudioChatModel(),
  'gpt-4o-audio-preview': openAiAudioChatModel(),
  'gpt-4o-mini-audio-preview': openAiAudioChatModel(),
  'gpt-4o-transcribe': openAiTranscriptionModel(),
  'gpt-4o-mini-transcribe': openAiTranscriptionModel(),
  'gpt-4o-mini-transcribe-2025-12-15': openAiTranscriptionModel(),
  'whisper-1': openAiTranscriptionModel(),
  'gpt-realtime': openAiRealtimeModel(),
  'gpt-realtime-mini': openAiRealtimeModel(),
  'gpt-realtime-1.5': openAiRealtimeModel(),
  'gpt-realtime-2': openAiRealtimeModel(),
  'gpt-realtime-2.1': openAiRealtimeModel(),
};

function openAiAudioChatModel(): ModelMetadata {
  return {
    modalities: { input: ['text', 'audio'], output: ['text', 'audio'] },
    endpointRoles: ['agent_chat', 'audio_chat'],
    transports: ['openai_chat_audio'],
    transcriptOutput: true,
  };
}

function openAiTranscriptionModel(): ModelMetadata {
  return {
    modalities: { input: ['audio'], output: ['text'] },
    endpointRoles: ['transcription'],
    transports: ['openai_audio_transcriptions'],
    transcriptOutput: true,
  };
}

function openAiRealtimeModel(): ModelMetadata {
  return {
    modalities: { input: ['text', 'audio'], output: ['text', 'audio'] },
    endpointRoles: ['realtime_voice'],
    transports: ['openai_realtime'],
    transcriptOutput: true,
  };
}

export function resolveModelVoiceMetadata(
  providerType: ProviderType,
  models: readonly ModelInfo[] | undefined,
  modelId: string,
): Pick<ModelInfo, 'modalities' | 'endpointRoles' | 'transports' | 'transcriptOutput'> {
  const stored = models?.find((entry) => entry.id === modelId);
  const metadata = lookupModelMetadata(providerType, modelId);
  return {
    ...((stored?.modalities ?? metadata.modalities)
      ? { modalities: stored?.modalities ?? metadata.modalities }
      : {}),
    ...((stored?.endpointRoles ?? metadata.endpointRoles)
      ? { endpointRoles: stored?.endpointRoles ?? metadata.endpointRoles }
      : {}),
    ...((stored?.transports ?? metadata.transports)
      ? { transports: stored?.transports ?? metadata.transports }
      : {}),
    ...((stored?.transcriptOutput ?? metadata.transcriptOutput)
      ? { transcriptOutput: stored?.transcriptOutput ?? metadata.transcriptOutput }
      : {}),
  };
}

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
      thinkingOptions: { efforts: ['high', 'max'], toggle: true },
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
        lifecycle: metadata.lifecycle,
        docsUrl: metadata.docsUrl,
        capabilities: metadata.capabilities,
        thinkingOptions: overrides[id]?.thinkingOptions ?? metadata.thinkingOptions,
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
