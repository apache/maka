import { buildWebFetchTool } from '@maka/runtime/web-fetch-tool';
import { createLocalWebFetchExecutor } from '@maka/runtime/local-web-fetch';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

interface HostWebFetchServiceInput {
  readonly policy: Pick<RuntimePolicyOperationCoordinator, 'resolveWebFetchExecution'>;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
}

export interface HostWebFetchService {
  fetch(input: {
    readonly url: string;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<string>;
}

export function createHostWebFetchService(input: HostWebFetchServiceInput): HostWebFetchService {
  const createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  return {
    fetch: async ({ url, sessionId, abortSignal }) => {
      const resolved = await input.policy.resolveWebFetchExecution();
      if (resolved.kind === 'privacy_mode') {
        throw new Error('WebFetch is disabled while privacy mode is active.');
      }
      if (resolved.kind === 'credential_not_configured') {
        throw new Error('Configure the network proxy credential before using WebFetch.');
      }
      const transport = createFetchTransport(
        toRuntimePolicyProxy(resolved.networkProxy, resolved.secretMaterial.networkProxy?.secret),
      );
      try {
        return await createLocalWebFetchExecutor({ fetch: transport.fetch }).fetch({
          url,
          sessionId,
          ...(abortSignal ? { abortSignal } : {}),
        });
      } finally {
        await transport.close();
      }
    },
  };
}

export function createHostWebFetchTool(input: HostWebFetchServiceInput): MakaTool {
  return createHostWebFetchToolFromService(createHostWebFetchService(input));
}

export function createHostWebFetchToolFromService(service: HostWebFetchService): MakaTool {
  return buildWebFetchTool({
    fetch: ({ url, sessionId, abortSignal }) =>
      service.fetch({ url, sessionId, ...(abortSignal ? { abortSignal } : {}) }),
  });
}
