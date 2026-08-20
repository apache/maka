import type {
  ProviderResponsesContract,
  ProviderRuntimeAdapter,
  ProviderType,
} from '@maka/core/llm-connections';
import { openAiAdapterApiProtocol } from '@maka/core/model-metadata';

export type OpenResponsesCompatibilityProfile = 'alibaba-token-plan';

export type RuntimeProviderResponsesContract =
  | Extract<ProviderResponsesContract, { adapter: 'openai' }>
  | {
      readonly adapter: 'open-responses';
      readonly reasoningReplay: 'plaintext-content' | 'plaintext-summary';
      readonly compatibility?: OpenResponsesCompatibilityProfile;
    };

type OpenAiCompatibleRuntimeAdapter = Omit<
  Extract<ProviderRuntimeAdapter, { kind: 'openai-compatible' }>,
  'responses'
> & {
  readonly responses?: RuntimeProviderResponsesContract;
};

export type RuntimeProviderAdapter =
  | Exclude<ProviderRuntimeAdapter, { kind: 'openai-compatible' }>
  | OpenAiCompatibleRuntimeAdapter;

interface RuntimeProviderIdentity {
  readonly providerType: ProviderType;
  readonly slug?: string;
}

const ALIBABA_TOKEN_PLAN_RESPONSES = {
  adapter: 'open-responses',
  // The pinned SDK streams `response.reasoning_text.delta` as reasoning text,
  // then reads durable summary boundaries from `output_item.done.item.summary`.
  // Keep the raw-SSE contract test in sync if either channel changes.
  reasoningReplay: 'plaintext-summary',
  compatibility: 'alibaba-token-plan',
} as const satisfies RuntimeProviderResponsesContract;

export function resolveRuntimeProviderAdapter(
  providerType: ProviderType,
  adapter: ProviderRuntimeAdapter,
): RuntimeProviderAdapter {
  if (!isAlibabaTokenPlanProvider(providerType)) return adapter;
  if (adapter.kind !== 'openai-compatible') {
    throw new Error(`${providerType} Runtime policy requires an OpenAI-compatible adapter`);
  }
  return { ...adapter, responses: ALIBABA_TOKEN_PLAN_RESPONSES };
}

/**
 * Runtime execution policy layered over Core's catalog-level OpenAI adapter
 * default. Account-declared `ModelInfo.apiProtocol` remains authoritative in
 * `resolveModelRuntimeWire`; this only supplies the otherwise-missing default.
 */
export function defaultOpenAiApiProtocol(
  modelId: string,
  providerType: ProviderType,
): 'openai-responses' | 'openai-chat' {
  return isAlibabaTokenPlanProvider(providerType) && modelId.trim() === 'qwen3.8-max'
    ? 'openai-responses'
    : openAiAdapterApiProtocol(modelId, providerType);
}

/** Raw provider identity passed to open-responses and used as its provider-options key. */
export function runtimeProviderName(
  adapter: RuntimeProviderAdapter,
  connection: RuntimeProviderIdentity,
): string {
  return adapter.kind === 'openai-compatible' && adapter.name === 'connection'
    ? (connection.slug ?? connection.providerType)
    : connection.providerType;
}

function isAlibabaTokenPlanProvider(providerType: ProviderType): boolean {
  return providerType === 'alibaba-token-plan-cn' || providerType === 'alibaba-token-plan';
}
