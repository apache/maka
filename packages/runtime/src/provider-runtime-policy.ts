import type {
  ProviderResponsesContract,
  ProviderRuntimeAdapter,
  ProviderType,
} from '@maka/core/llm-connections';
import { openAiAdapterApiProtocol } from '@maka/core/model-metadata';

export type ProviderResponsesCompatibilityModule =
  | 'force-store-false'
  | 'reject-forced-tool-choice';

export type RuntimeProviderResponsesContract =
  | Extract<ProviderResponsesContract, { adapter: 'openai' }>
  | {
      readonly adapter: 'open-responses';
      readonly reasoningReplay: 'plaintext-content' | 'plaintext-summary';
      readonly compatibility?: readonly ProviderResponsesCompatibilityModule[];
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

const ALIBABA_TOKEN_PLAN_RESPONSES = {
  adapter: 'open-responses',
  reasoningReplay: 'plaintext-summary',
  compatibility: ['force-store-false', 'reject-forced-tool-choice'],
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

export function defaultOpenAiApiProtocol(
  modelId: string,
  providerType: ProviderType,
): 'openai-responses' | 'openai-chat' {
  return isAlibabaTokenPlanProvider(providerType) && modelId.trim() === 'qwen3.8-max'
    ? 'openai-responses'
    : openAiAdapterApiProtocol(modelId, providerType);
}

function isAlibabaTokenPlanProvider(providerType: ProviderType): boolean {
  return providerType === 'alibaba-token-plan-cn' || providerType === 'alibaba-token-plan';
}
