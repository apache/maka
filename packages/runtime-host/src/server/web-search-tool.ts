/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { buildWebSearchTool } from '@maka/runtime/web-search-tool';
import {
  createProxiedFetchTransport,
  type ProxiedFetchProxy,
  type ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import { queryTavily } from '@maka/runtime/tavily-search';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import type { WebSearchResponse } from '@maka/core/web-search';
import type { RuntimePolicy } from '@maka/core/runtime-policy';
import type {
  ResolveWebSearchExecutionInput,
  RuntimePolicyOperationCoordinator,
} from '@maka/storage/runtime-policy-stores';
import { toRuntimePolicyProxy } from './runtime-policy-proxy.js';

interface HostWebSearchServiceInput {
  readonly policy: Pick<RuntimePolicyOperationCoordinator, 'resolveWebSearchExecution'>;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
}

export interface HostWebSearchService {
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly abortSignal?: AbortSignal;
    readonly policy?: ResolveWebSearchExecutionInput;
  }): Promise<WebSearchResponse>;
}

export function shouldResolveHostTavilyWebSearchReadiness(
  policy: Pick<RuntimePolicy, 'privacy' | 'webSearch'>,
): boolean {
  return (
    policy.webSearch.enabled &&
    policy.webSearch.defaultProvider === 'tavily' &&
    policy.privacy.incognitoActive !== true
  );
}

export async function resolveHostTavilyWebSearchReadiness(
  policy: Pick<RuntimePolicyOperationCoordinator, 'resolveWebSearchExecution'>,
): Promise<boolean> {
  return (await policy.resolveWebSearchExecution({ provider: 'tavily' })).kind === 'ready';
}

export function createHostWebSearchService(input: HostWebSearchServiceInput): HostWebSearchService {
  const createFetchTransport = input.createFetchTransport ?? createProxiedFetchTransport;
  return {
    search: async ({ query, limit, abortSignal, policy }) => {
      const resolved = await input.policy.resolveWebSearchExecution(policy);
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
  };
}

export function createHostWebSearchTool(input: HostWebSearchServiceInput): MakaTool {
  return createHostWebSearchToolFromService(createHostWebSearchService(input));
}

export function createHostWebSearchToolFromService(service: HostWebSearchService): MakaTool {
  return buildWebSearchTool({
    search: ({ query, limit, abortSignal }) =>
      service.search({
        query,
        limit,
        ...(abortSignal ? { abortSignal } : {}),
      }),
  });
}
