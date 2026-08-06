import { PROVIDER_DEFAULTS, type ModelInfo, type ProviderType } from '@maka/core/llm-connections';
import { type ModelRuntimeWire, resolveModelRuntime } from '@maka/runtime/model-runtime';
import type { ProviderAuthProxyMode, ProviderUsageProtocol } from './provider-auth-proxy.js';
import { modelApiProtocolFromEnv, selectedModelApiProtocol } from './provider-env.js';

export type HarnessAgentId =
  | 'maka'
  | 'opencode'
  | 'kimi-code'
  | 'codex'
  | 'claude-code'
  | 'reasonix';

const HARNESS_AGENT_IMPORT_PATHS: Readonly<Record<HarnessAgentId, string>> = {
  maka: 'maka_agent:MakaAgent',
  opencode: 'opencode_agent:MakaOpenCodeAgent',
  'kimi-code': 'kimi_code_agent:MakaKimiCodeAgent',
  codex: 'codex_agent:MakaCodexAgent',
  'claude-code': 'claude_code_agent:MakaClaudeCodeAgent',
  reasonix: 'reasonix_agent:MakaReasonixAgent',
};

export function harnessAgentImportPath(agent: HarnessAgentId): string {
  return HARNESS_AGENT_IMPORT_PATHS[agent];
}

export function providerProxyClientBaseUrl(
  baseUrl: string,
  agent: HarnessAgentId,
  provider: string,
): string {
  if (agent !== 'claude-code' || provider !== 'deepseek') return baseUrl;
  return `${baseUrl.replace(/\/$/, '')}/anthropic`;
}

export function providerProxyUpstreamBaseUrl(
  baseUrl: string,
  provider: string,
  apiProtocol?: string,
): string {
  if (provider !== 'kimi-coding-plan' || apiProtocol !== 'openai-chat') return baseUrl;
  const upstream = new URL(baseUrl);
  if (!/\/v1\/?$/i.test(upstream.pathname)) return baseUrl;
  upstream.pathname = upstream.pathname.replace(/\/v1\/?$/i, '') || '/';
  return upstream.toString();
}

export function providerProxyClientAuthMode(
  agent: HarnessAgentId,
  provider: string,
  apiProtocol?: string,
): ProviderAuthProxyMode {
  if (agent === 'claude-code') return 'x-api-key';
  if (agent === 'kimi-code') return 'bearer';
  return providerProxyUpstreamAuthMode(agent, provider, apiProtocol);
}

export function providerProxyUpstreamAuthMode(
  agent: HarnessAgentId,
  provider: string,
  apiProtocol?: string,
): ProviderAuthProxyMode {
  if (agent === 'kimi-code') return 'bearer';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'openai-chat') return 'bearer';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'anthropic-messages') return 'x-api-key';
  const definition = providerDefinition(provider);
  return definition?.runtimeAdapter.kind === 'anthropic' &&
    definition.runtimeAdapter.auth === 'api-key'
    ? 'x-api-key'
    : 'bearer';
}

/**
 * The model id as the provider itself spells it, with the catalog's `provider/`
 * prefix removed. This is what the runtime dials with, so it is also the only
 * spelling any provider-facing decision may be made on.
 */
export function modelIdForProvider(model: string, provider: string): string {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

export function providerProxyUsageProtocol(
  agent: HarnessAgentId,
  provider: string,
  apiProtocol?: string,
  modelId?: string,
): ProviderUsageProtocol | undefined {
  if (agent === 'codex') return 'openai-responses-sse';
  if (agent === 'claude-code') return 'anthropic-sse';
  if (agent === 'kimi-code') return 'openai-chat-sse';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'openai-chat') return 'openai-chat-sse';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'anthropic-messages')
    return 'anthropic-sse';
  // The Maka arm dials whatever wire its own runtime resolves, so that runtime
  // is the authority here — the adapter kind is a guess, and a guess that
  // drifts is not a gap but a wrong number: when deepseek-v4-flash moved to
  // Responses, a proxy still parsing Chat SSE never saw `[DONE]`, recorded
  // every request `interrupted` with no usage, and the runner threw each
  // graded cell away as an infra failure.
  //
  // Which model is not optional information for the Maka arm: without it there
  // is nothing to ask the runtime and the answer silently degrades back to the
  // guess. Say so rather than returning a plausible wrong number. The id is
  // normalized here so a caller passing the catalog spelling cannot resolve a
  // different wire than the one the runtime dials — `resolveModelRuntime`
  // does not recognize `deepseek/deepseek-v4-flash` and falls back to Chat.
  if (agent === 'maka') {
    if (!modelId) throw new Error('providerProxyUsageProtocol: the maka arm requires a model id');
    const wire = makaRuntimeWire(provider, modelIdForProvider(modelId, provider), apiProtocol);
    if (wire) return usageProtocolForWire(wire);
  }
  const definition = providerDefinition(provider);
  if (definition?.runtimeAdapter.kind === 'anthropic') return 'anthropic-sse';
  if (definition?.runtimeAdapter.kind === 'openai-compatible') return 'openai-chat-sse';
  return undefined;
}

function makaRuntimeWire(
  provider: string,
  modelId: string,
  apiProtocol?: string,
): ModelRuntimeWire | null {
  if (!providerDefinition(provider)) return null;
  // The connection the runtime will actually build, not one this side invents:
  // an advertised protocol only reaches the model entry for the providers whose
  // connections carry it, and `selectedModelApiProtocol` is where that is
  // decided. Honouring it here where the runtime drops it would resolve a wire
  // nothing dials — the wrong-number failure this whole path exists to remove.
  const advertised = selectedModelApiProtocol(
    provider as ProviderType,
    modelApiProtocolFromEnv(apiProtocol),
  );
  return resolveModelRuntime(
    {
      providerType: provider as ProviderType,
      ...(advertised ? { models: [{ id: modelId, apiProtocol: advertised }] } : {}),
    },
    modelId,
  ).wire;
}

function usageProtocolForWire(wire: ModelRuntimeWire): ProviderUsageProtocol | undefined {
  if (wire === 'anthropic-messages') return 'anthropic-sse';
  if (wire === 'openai-chat') return 'openai-chat-sse';
  if (wire === 'openai-responses') return 'openai-responses-sse';
  return undefined;
}

function providerDefinition(provider: string) {
  return (PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>)[
    provider
  ];
}
