import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type LlmConnection,
  type ModelInfo,
  type ProviderRuntimeAdapter,
} from '@maka/core/llm-connections';
import { lookupModelProviderOverride } from '@maka/core/model-metadata';

export interface ResolvedModelRuntime {
  adapter: ProviderRuntimeAdapter;
  baseUrl: string;
  /** Account-advertised request wire for adapters that route per model. */
  apiProtocol?: ModelInfo['apiProtocol'];
}

export function resolveModelRuntime(
  connection: LlmConnection,
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
          passFetch: true,
        } as const)
      : override
        ? runtimeAdapterOverride(override.npm)
        : defaults.runtimeAdapter;
  const configuredBaseUrl = connection.baseUrl?.trim();
  const resolvedBaseUrl = configuredBaseUrl
    ? effectiveBaseUrl(connection)
    : (override?.api ?? effectiveBaseUrl(connection));
  return {
    adapter,
    baseUrl:
      connection.providerType === 'kimi-coding-plan' && apiProtocol === 'openai-chat'
        ? kimiOpenAiBaseUrl(resolvedBaseUrl)
        : resolvedBaseUrl,
    ...(apiProtocol ? { apiProtocol } : {}),
  };
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
