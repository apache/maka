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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type { ProxiedFetchProxy } from '@maka/runtime/network/scoped-fetch-transport';
import type {
  ResolveWebSearchExecutionResult,
  RuntimePolicyOperationCoordinator,
} from '@maka/storage/runtime-policy-stores';
import {
  createHostWebSearchTool,
  resolveHostTavilyWebSearchReadiness,
  shouldResolveHostTavilyWebSearchReadiness,
} from '../server/web-search-tool.js';

test('Host only resolves Tavily readiness when that execution path can be exposed', () => {
  const policy = createDefaultRuntimePolicy();
  assert.equal(shouldResolveHostTavilyWebSearchReadiness(policy), false);
  assert.equal(
    shouldResolveHostTavilyWebSearchReadiness({
      ...policy,
      webSearch: { enabled: true, defaultProvider: 'tavily' },
    }),
    true,
  );
  assert.equal(
    shouldResolveHostTavilyWebSearchReadiness({
      ...policy,
      privacy: { incognitoActive: true },
      webSearch: { enabled: true, defaultProvider: 'tavily' },
    }),
    false,
  );
});

test('Host Tavily readiness follows the canonical execution resolver', async () => {
  assert.equal(
    await resolveHostTavilyWebSearchReadiness(
      resolver({
        kind: 'credential_not_configured',
        status: {
          locator: { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
          configured: false,
          credentialId: null,
          revision: null,
          updatedAt: null,
        },
      }),
    ),
    false,
  );
  assert.equal(await resolveHostTavilyWebSearchReadiness(resolver(readyDirectExecution())), true);
});

test('Host WebSearch fails closed before transport creation for unavailable policy states', async () => {
  const states: readonly ResolveWebSearchExecutionResult[] = [
    { kind: 'privacy_mode' },
    { kind: 'disabled', provider: 'tavily' },
    {
      kind: 'credential_not_configured',
      status: {
        locator: { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
        configured: false,
        credentialId: null,
        revision: null,
        updatedAt: null,
      },
    },
  ];

  for (const state of states) {
    let transportCreated = false;
    const tool = createHostWebSearchTool({
      policy: resolver(state),
      createFetchTransport: () => {
        transportCreated = true;
        throw new Error('transport must not be created');
      },
    });
    const result = (await tool.impl({ query: 'current result' }, context())) as {
      kind: string;
      reason: string;
    };
    assert.equal(result.kind, 'web_search_error');
    assert.equal(
      result.reason,
      state.kind === 'privacy_mode' ? 'incognito_active' : 'not_configured',
    );
    assert.equal(transportCreated, false);
  }
});

test('Host WebSearch consumes one canonical credential/proxy snapshot and closes transport', async () => {
  const networkProxy = {
    ...createDefaultRuntimePolicy().networkProxy,
    enabled: true,
    protocol: 'https' as const,
    host: 'proxy.example',
    port: 8443,
    authEnabled: true,
    username: 'proxy-user',
    bypassList: ['one.example'],
    autoBypassDomains: ['two.example'],
  };
  let proxy: ProxiedFetchProxy | null | undefined;
  let closed = 0;
  let providerBody: Record<string, unknown> | undefined;
  const tool = createHostWebSearchTool({
    policy: resolver({
      kind: 'ready',
      provider: 'tavily',
      networkProxy,
      secretMaterial: {
        webSearch: {
          locator: { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
          credentialId: 'web-search-credential',
          revision: 3,
          secret: 'tavily-secret',
        },
        networkProxy: {
          locator: { scope: 'network_proxy', kind: 'password' },
          credentialId: 'proxy-credential',
          revision: 4,
          secret: 'proxy-secret',
        },
      },
    }),
    createFetchTransport: (candidate) => {
      proxy = candidate;
      return {
        fetch: async (_input, init) => {
          providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            results: [
              {
                title: 'Maka',
                url: 'https://maka.example/current',
                content: 'Current information.',
              },
            ],
          });
        },
        close: async () => {
          closed += 1;
        },
      };
    },
  });

  const result = await tool.impl({ query: ' latest Maka ', limit: 1 }, context());
  assert.deepEqual(proxy, {
    enabled: true,
    type: 'https',
    host: 'proxy.example',
    port: 8443,
    username: 'proxy-user',
    password: 'proxy-secret',
    bypassList: ['one.example', 'two.example'],
  });
  assert.deepEqual(providerBody, {
    api_key: 'tavily-secret',
    query: 'latest Maka',
    max_results: 1,
    search_depth: 'basic',
  });
  assert.equal(closed, 1);
  assert.deepEqual(result, {
    kind: 'web_search',
    provider: 'tavily',
    query: 'latest Maka',
    rows: [
      {
        title: 'Maka',
        url: 'https://maka.example/current',
        snippet: 'Current information.',
        source: 'maka.example',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /tavily-secret|proxy-secret/);
});

test('Host WebSearch closes its transport when the owning turn is cancelled', async () => {
  const abort = new AbortController();
  let closed = false;
  const tool = createHostWebSearchTool({
    policy: resolver(readyDirectExecution()),
    createFetchTransport: () => ({
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      close: async () => {
        closed = true;
      },
    }),
  });
  const running = Promise.resolve(
    tool.impl(
      { query: 'cancel me' },
      {
        ...context(),
        abortSignal: abort.signal,
      },
    ),
  );
  const reason = new DOMException('Turn stopped', 'AbortError');
  abort.abort(reason);
  await assert.rejects(running, (error: unknown) => error === reason);
  assert.equal(closed, true);
});

test('Host client WebSearch refuses provider-native execution outside the primary request', async () => {
  let transportCreated = false;
  const tool = createHostWebSearchTool({
    policy: resolver({ kind: 'model_native_only', provider: 'model' }),
    createFetchTransport: () => ({
      fetch: async () => {
        transportCreated = true;
        throw new Error('provider-native search must not create a client transport');
      },
      close: async () => {},
    }),
  });

  const result = await tool.impl({ query: 'DeepSeek current news', limit: 1 }, context());
  assert.equal((result as { reason?: string }).reason, 'unsupported_provider');
  assert.equal(transportCreated, false);
});

function resolver(
  result: ResolveWebSearchExecutionResult,
): Pick<RuntimePolicyOperationCoordinator, 'resolveWebSearchExecution'> {
  return { resolveWebSearchExecution: async () => result };
}

function readyDirectExecution(): ResolveWebSearchExecutionResult {
  return {
    kind: 'ready',
    provider: 'tavily',
    networkProxy: createDefaultRuntimePolicy().networkProxy,
    secretMaterial: {
      webSearch: {
        locator: { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
        credentialId: 'web-search-credential',
        revision: 1,
        secret: 'tavily-secret',
      },
    },
  };
}

function context(): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}
