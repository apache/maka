import {
  buildWebSearchTool,
  createProxiedFetchTransport,
  queryTavily,
  type MakaTool,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime';
import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

export function createHostWebSearchTool(input: {
  readonly policy: Pick<RuntimePolicyOperationCoordinator, 'resolveWebSearchExecution'>;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
}): MakaTool {
  const createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  return buildWebSearchTool({
    search: async ({ query, limit, abortSignal }) => {
      const resolved = await input.policy.resolveWebSearchExecution();
      switch (resolved.kind) {
        case 'privacy_mode':
          return {
            ok: false,
            reason: 'incognito_active',
            message: 'Web search is disabled while privacy mode is active.',
          };
        case 'disabled':
          return {
            ok: false,
            reason: 'not_configured',
            message: 'Enable web search before using this tool.',
          };
        case 'model_native_only':
          return {
            ok: false,
            reason: 'unsupported_provider',
            message: 'Provider-native web search executes inside the primary model request.',
          };
        case 'credential_not_configured':
          return {
            ok: false,
            reason: 'not_configured',
            message:
              resolved.status.locator.scope === 'network_proxy'
                ? 'Configure the network proxy credential before using web search.'
                : 'Configure a Tavily API key before using web search.',
          };
        case 'ready': {
          if (resolved.provider !== 'tavily') {
            return {
              ok: false,
              reason: 'unsupported_provider',
              message: 'The configured web search provider is not supported by this Host.',
            };
          }
          const apiKey = resolved.secretMaterial.webSearch.secret;
          const transport = createFetchTransport(
            toRuntimePolicyProxy(
              resolved.networkProxy,
              resolved.secretMaterial.networkProxy?.secret,
            ),
          );
          try {
            return await queryTavily({
              apiKey,
              query,
              limit,
              fetch: transport.fetch,
              ...(abortSignal ? { abortSignal } : {}),
            });
          } finally {
            await transport.close();
          }
        }
      }
    },
  });
}
