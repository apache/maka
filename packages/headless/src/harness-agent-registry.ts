import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core/llm-connections';
import type { ProviderAuthProxyMode, ProviderUsageProtocol } from './provider-auth-proxy.js';

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

export function providerProxyUsageProtocol(
  agent: HarnessAgentId,
  provider: string,
  apiProtocol?: string,
): ProviderUsageProtocol | undefined {
  if (agent === 'codex') return 'openai-responses-sse';
  if (agent === 'claude-code') return 'anthropic-sse';
  if (agent === 'kimi-code') return 'openai-chat-sse';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'openai-chat') return 'openai-chat-sse';
  if (provider === 'kimi-coding-plan' && apiProtocol === 'anthropic-messages')
    return 'anthropic-sse';
  const definition = providerDefinition(provider);
  if (definition?.runtimeAdapter.kind === 'anthropic') return 'anthropic-sse';
  if (definition?.runtimeAdapter.kind === 'openai-compatible') return 'openai-chat-sse';
  return undefined;
}

function providerDefinition(provider: string) {
  return (PROVIDER_DEFAULTS as Partial<Record<string, (typeof PROVIDER_DEFAULTS)[ProviderType]>>)[
    provider
  ];
}
