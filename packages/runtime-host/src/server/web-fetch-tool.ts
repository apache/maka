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
