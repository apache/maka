import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type ModelInfo,
  type ProviderResponsesContract,
  type ProviderRuntimeAdapter,
  type ProviderType,
} from '@maka/core/llm-connections';
import {
  lookupModelProviderOverride,
  openAiAdapterApiProtocol,
  resolveModelPdfSupport,
} from '@maka/core/model-metadata';
import { resolveApplyPatchProfile, type ApplyPatchProfile } from './apply-patch-profile.js';

export type ModelRuntimeWire =
  | 'anthropic-messages'
  | 'openai-chat'
  | 'openai-responses'
  | 'google-generate'
  | 'cohere-v2';

export type ReasoningReplayContract =
  | { kind: 'none' }
  | { kind: 'anthropic-signed' }
  | { kind: 'openai-chat-plaintext'; requestField: 'observed' | 'reasoning' }
  | { kind: 'responses'; contract: ProviderResponsesContract };

export interface ResolvedModelRuntime {
  adapter: ProviderRuntimeAdapter;
  baseUrl: string;
  /** Account-advertised request wire for adapters that route per model. */
  apiProtocol?: ModelInfo['apiProtocol'];
  /** Effective wire after account, adapter, and model defaults are resolved. */
  wire: ModelRuntimeWire;
  /** Durable reasoning replay semantics carried by that wire. */
  reasoningReplay: ReasoningReplayContract;
  /** Effective ApplyPatch contract after provider, model, and request wire are resolved. */
  applyPatchProfile: ApplyPatchProfile | null;
}

/**
 * Provider/wire combinations whose native API contract has been verified to
 * accept an AI SDK PDF file part. Provider identity is intentional: a relay
 * using the same adapter or wire does not inherit first-party PDF support.
 */
export type ModelPdfInputContract =
  | { providerType: 'anthropic'; wire: 'anthropic-messages' }
  | { providerType: 'openai'; wire: 'openai-chat' | 'openai-responses' };

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
  // `isRealConnection` in @maka/core/connection-readiness.ts.
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
  const adapter: ProviderRuntimeAdapter =
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
    applyPatchProfile: resolveApplyPatchProfile(
      {
        wire,
        applyPatchProtocol: adapter.applyPatchProtocol,
      },
      modelId,
    ),
  };
}

/**
 * Resolve native PDF materialization only when both model metadata and the
 * first-party provider wire authorize it. Unknown models and compatible
 * relays fail closed even if their wire happens to use an SDK file encoding.
 */
export function resolveModelPdfInputContract(
  connection: ModelRuntimeConnection,
  modelId: string,
): ModelPdfInputContract | null {
  if (!resolveModelPdfSupport(connection.providerType, connection.models, modelId)) return null;
  const { wire } = resolveModelRuntime(connection, modelId);
  if (connection.providerType === 'anthropic' && wire === 'anthropic-messages') {
    return { providerType: 'anthropic', wire };
  }
  if (
    connection.providerType === 'openai' &&
    (wire === 'openai-chat' || wire === 'openai-responses')
  ) {
    return { providerType: 'openai', wire };
  }
  return null;
}

export function modelUsesAnthropicMessages(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  return resolveModelRuntime(connection, modelId).wire === 'anthropic-messages';
}

/** Native OpenAI lanes keep mutable continuation state inside ModelAdapter. */
export function modelUsesNativeOpenAiResponses(
  connection: ModelRuntimeConnection,
  modelId: string,
): boolean {
  return (
    connection.providerType === 'openai' &&
    resolveModelRuntime(connection, modelId).wire === 'openai-responses'
  );
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
      return adapter.responses !== undefined &&
        (apiProtocol ?? openAiAdapterApiProtocol(modelId, providerType)) === 'openai-responses'
        ? 'openai-responses'
        : 'openai-chat';
    case 'google':
      return 'google-generate';
    case 'cohere':
      return 'cohere-v2';
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
      return { kind: 'responses', contract: responsesContract(adapter) };
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
      return { kind: 'none' };
  }
}

function responsesContract(adapter: ProviderRuntimeAdapter): ProviderResponsesContract {
  if (adapter.kind === 'openai-compatible' && adapter.responses) return adapter.responses;
  return { adapter: 'openai', reasoningReplay: 'encrypted-content' };
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
