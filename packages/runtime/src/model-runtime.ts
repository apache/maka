import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type ModelInfo,
  type ProviderRuntimeAdapter,
  type ProviderType,
} from '@maka/core/llm-connections';
import { lookupModelProviderOverride, openAiAdapterApiProtocol } from '@maka/core/model-metadata';

export type ModelRuntimeWire =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'google-generate'
  | 'cohere-v2'
  | 'unavailable';

export type ReasoningReplayContract =
  | { kind: 'none' }
  | { kind: 'anthropic-signed' }
  | { kind: 'openai-chat-plaintext'; requestField: 'observed' | 'reasoning' }
  | { kind: 'openai-responses-item' };

export interface ResolvedModelRuntime {
  adapter: ProviderRuntimeAdapter;
  baseUrl: string;
  /** Account-advertised request wire for adapters that route per model. */
  apiProtocol?: ModelInfo['apiProtocol'];
  /** Effective wire after account, adapter, and model defaults are resolved. */
  wire: ModelRuntimeWire;
  /** Durable reasoning replay semantics carried by that wire. */
  reasoningReplay: ReasoningReplayContract;
}

export interface ModelRuntimeConnection {
  readonly providerType: ProviderType;
  readonly baseUrl?: string;
  readonly models?: readonly ModelInfo[];
}

export function resolveModelRuntime(
  connection: ModelRuntimeConnection,
  modelId: string,
): ResolvedModelRuntime {
  const override = lookupModelProviderOverride(connection.providerType, modelId);
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType with no per-model override → can't resolve an adapter.
  // Throw a clear error rather than crashing on `.runtimeAdapter`. Mirrors
  // `isFakeBackend` in @maka/core/connection-readiness.ts.
  if (!override && !defaults) {
    throw new Error(
      `Unknown provider type "${connection.providerType}"; cannot resolve model runtime.`,
    );
  }
  const apiProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
  if (
    connection.providerType === 'kimi-coding-plan' &&
    apiProtocol !== undefined &&
    apiProtocol !== 'anthropic-messages' &&
    apiProtocol !== 'openai-chat'
  ) {
    throw new Error(
      `Kimi Coding Plan protocol must be openai-chat or anthropic-messages, received ${apiProtocol}`,
    );
  }
  const adapter =
    connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
      ? ({
          kind: 'openai-compatible',
          name: 'provider',
          includeUsage: true,
        } as const)
      : override
        ? runtimeAdapterOverride(override.npm)
        : defaults.runtimeAdapter;
  const configuredBaseUrl = connection.baseUrl?.trim();
  const resolvedBaseUrl = configuredBaseUrl
    ? effectiveBaseUrl(connection)
    : (override?.api ?? effectiveBaseUrl(connection));
  const wire = resolveModelRuntimeWire(connection.providerType, modelId, adapter, apiProtocol);
  return {
    adapter,
    baseUrl:
      connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
        ? kimiOpenAiBaseUrl(resolvedBaseUrl)
        : resolvedBaseUrl,
    ...(apiProtocol ? { apiProtocol } : {}),
    wire,
    reasoningReplay: reasoningReplayContract(adapter, wire),
  };
}

function resolveModelRuntimeWire(
  providerType: ProviderType,
  modelId: string,
  adapter: ProviderRuntimeAdapter,
  apiProtocol: ModelInfo['apiProtocol'] | undefined,
): ModelRuntimeWire {
  switch (adapter.kind) {
    case 'anthropic':
    case 'claude-subscription':
      return 'anthropic-messages';
    case 'openai-codex':
      return 'openai-responses';
    case 'github-copilot':
      return apiProtocol === 'anthropic-messages'
        ? 'anthropic-messages'
        : apiProtocol === 'openai-responses'
          ? 'openai-responses'
          : 'openai-chat';
    case 'openai':
      return (adapter.apiProtocol ??
        apiProtocol ??
        openAiAdapterApiProtocol(modelId, providerType)) === 'openai-responses'
        ? 'openai-responses'
        : 'openai-chat';
    case 'openai-compatible':
      return adapter.supportsOpenAiResponses === true &&
        (apiProtocol ?? openAiAdapterApiProtocol(modelId, providerType)) === 'openai-responses'
        ? 'openai-responses'
        : 'openai-chat';
    case 'google':
      return 'google-generate';
    case 'cohere':
      return 'cohere-v2';
    case 'unavailable':
      return 'unavailable';
  }
}

function reasoningReplayContract(
  adapter: ProviderRuntimeAdapter,
  wire: ModelRuntimeWire,
): ReasoningReplayContract {
  switch (wire) {
    case 'anthropic-messages':
      return { kind: 'anthropic-signed' };
    case 'openai-responses':
      return { kind: 'openai-responses-item' };
    case 'openai-chat':
      return adapter.kind === 'openai-compatible'
        ? {
            kind: 'openai-chat-plaintext',
            requestField:
              adapter.replayAssistantReasoningAs === 'reasoning' ? 'reasoning' : 'observed',
          }
        : { kind: 'none' };
    case 'google-generate':
    case 'cohere-v2':
    case 'unavailable':
      return { kind: 'none' };
  }
}

function kimiOpenAiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/v1`;
}

function runtimeAdapterOverride(packageName: string): ProviderRuntimeAdapter {
  switch (packageName) {
    case '@ai-sdk/anthropic':
      return { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true };
    case '@ai-sdk/google':
      return { kind: 'google', normalizeBaseUrl: false };
    case '@ai-sdk/openai':
      return { kind: 'openai' };
    case '@ai-sdk/openai-compatible':
      return { kind: 'openai-compatible', name: 'provider' };
    default:
      throw new Error(`models.dev model runtime package ${packageName} is unsupported`);
  }
}
