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
import test from 'node:test';
import { OPENCODE_FREE_DEFAULT_ENABLED_MODELS } from '@maka/core/llm-connections';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  projectHostConnections,
  projectHostConnectionTest,
  registerRuntimeHostConnectionsIpc,
} from '../runtime-host-connections-ipc-main.js';

test('registers pure Connection reads for replacement-Host retry', () => {
  const reads = new Set<string>();
  const effects = new Set<string>();
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel) => {
        effects.add(channel);
      },
      handleReconnectableRead: (channel) => {
        reads.add(channel);
      },
    },
    client: {} as never,
    emitConnectionListChanged() {},
  });

  assert.deepEqual([...reads].sort(), [
    'connections:getRequestHeaders',
    'connections:getSnapshot',
    'connections:hasSecret',
  ]);
  assert.ok(effects.has('connections:create'));
  assert.ok(effects.has('connections:test'));
});

test('retries connection delete after a stale revision instead of failing permanently', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let revision = 1;
  let removals = 0;
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async (): Promise<ConnectionCatalogSnapshot> => ({
        revision,
        defaultTarget: null,
        connections: [
          {
            connectionId: 'connection-1',
            revision,
            slug: 'openrouter',
            name: 'OpenRouter',
            providerType: 'openai-compatible',
            baseUrl: 'https://openrouter.ai/api/v1',
            enabled: true,
            enabledModelIds: ['model-1'],
            models: [{ id: 'model-1' }],
          },
        ],
      }),
      removeConnection: async (expected: { connectionId: string; revision: number }) => {
        removals += 1;
        if (expected.revision === 1) {
          revision = 2;
          return { kind: 'connection_stale' };
        }
        assert.equal(expected.revision, 2);
        return { kind: 'committed', catalogRevision: 3 };
      },
    } as never,
    emitConnectionListChanged() {},
  });

  await handlers.get('connections:delete')?.({}, 'openrouter');
  assert.equal(removals, 2);
});

test('treats a missing connection as a successful delete without calling remove', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let removals = 0;
  let listChanged = 0;
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async (): Promise<ConnectionCatalogSnapshot> => ({
        revision: 1,
        defaultTarget: null,
        connections: [],
      }),
      removeConnection: async () => {
        removals += 1;
        return { kind: 'committed', catalogRevision: 2 };
      },
    } as never,
    emitConnectionListChanged() {
      listChanged += 1;
    },
  });

  await handlers.get('connections:delete')?.({}, 'already-gone');
  assert.equal(removals, 0);
  assert.equal(listChanged, 1);
});

test('rejects invalid connection slug input instead of treating it as already deleted', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async (): Promise<ConnectionCatalogSnapshot> => ({
        revision: 1,
        defaultTarget: null,
        connections: [],
      }),
      removeConnection: async () => ({ kind: 'committed', catalogRevision: 2 }),
    } as never,
    emitConnectionListChanged() {},
  });

  await assert.rejects(
    async () => handlers.get('connections:delete')?.({}, 42),
    /Invalid connection slug|connection slug/i,
  );
});

test('reports an existing but unconfigured credential as missing', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async () => catalog(),
      queryCredential: async () => ({
        configured: false,
        locator: {
          scope: 'connection',
          connectionId: 'connection-1',
          kind: 'api_key',
        },
      }),
    } as never,
    emitConnectionListChanged() {},
  });

  assert.equal(
    await handlers.get('connections:hasSecret')?.({}, 'openrouter'),
    false,
  );
});

test('keeps saved custom header values out of the renderer and preserves them by name', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let replacedHeaders: unknown;
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async () => catalog(),
      getConnectionRequestHeaders: async () => ({
        kind: 'found',
        names: ['HTTP-Referer'],
      }),
      replaceConnectionRequestHeaders: async (_connectionId: string, headers: unknown) => {
        replacedHeaders = headers;
        return { kind: 'committed', names: ['HTTP-Referer', 'X-Title'] };
      },
    } as never,
    emitConnectionListChanged() {},
  });

  assert.deepEqual(
    await handlers.get('connections:getRequestHeaders')?.({}, 'openrouter'),
    { names: ['HTTP-Referer'] },
  );
  assert.equal(
    JSON.stringify(await handlers.get('connections:getRequestHeaders')?.({}, 'openrouter')).includes('private.example'),
    false,
  );

  assert.deepEqual(
    await handlers.get('connections:setRequestHeaders')?.({}, 'openrouter', [
      { name: 'HTTP-Referer' },
      { name: 'X-Title', value: 'Maka' },
    ]),
    { names: ['HTTP-Referer', 'X-Title'] },
  );
  assert.deepEqual(replacedHeaders, [
    { name: 'HTTP-Referer' },
    { name: 'X-Title', value: 'Maka' },
  ]);
});

test('preserves the provider default inventory beside the recommended model', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let createdModels: readonly string[] = [];
  const emptyCatalog: ConnectionCatalogSnapshot = {
    revision: 0,
    defaultTarget: null,
    connections: [],
  };
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async () =>
        createdModels.length === 0
          ? emptyCatalog
          : {
              revision: 1,
              defaultTarget: null,
              connections: [
                {
                  connectionId: 'connection-free',
                  revision: 1,
                  slug: 'opencode-free',
                  name: 'OpenCode Free',
                  providerType: 'opencode-free',
                  enabled: true,
                  enabledModelIds: createdModels,
                  models: [],
                },
              ],
            },
      createConnection: async (
        _revision: number,
        draft: { readonly enabledModelIds: readonly string[] },
      ) => {
        createdModels = draft.enabledModelIds;
        return {
          kind: 'committed',
          connection: { connectionId: 'connection-free', revision: 1 },
        };
      },
    } as never,
    emitConnectionListChanged() {},
  });

  await handlers.get('connections:create')?.({}, {
    slug: 'opencode-free',
    name: 'OpenCode Free',
    providerType: 'opencode-free',
    defaultModel: 'nemotron-3-ultra-free',
  });

  // Snapshot-derived set; assert the contract, not today's ids.
  assert.deepEqual(createdModels, [...OPENCODE_FREE_DEFAULT_ENABLED_MODELS]);
});

test('projects the Host default target without inventing a second Connection authority', () => {
  const connections = projectHostConnections(catalog());

  assert.deepEqual(connections, [
    {
      slug: 'openrouter',
      name: 'OpenRouter',
      providerType: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      enabled: true,
      defaultModel: 'model-1',
      enabledModelIds: ['model-1', 'model-2'],
      models: [{ id: 'model-1' }, { id: 'model-2' }],
      createdAt: 0,
      updatedAt: 4,
    },
  ]);
});

test('does not invent a per-Connection default when the Host target is unset', () => {
  const snapshot = catalog();
  const connections = projectHostConnections({ ...snapshot, defaultTarget: null });

  assert.equal(connections[0]?.defaultModel, '');
  assert.deepEqual(connections[0]?.enabledModelIds, ['model-1', 'model-2']);
});

test('preserves the Host-tested model and diagnostics for the existing Desktop UI', () => {
  assert.deepEqual(
    projectHostConnectionTest({
      kind: 'committed',
      catalogRevision: 8,
      connection: { connectionId: 'connection-1', revision: 5 },
      test: {
        kind: 'verified',
        checkedAt: '2026-08-05T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 125,
      },
    }),
    { ok: true, modelTested: 'model-1', latencyMs: 125 },
  );
  assert.deepEqual(
    projectHostConnectionTest({
      kind: 'committed',
      catalogRevision: 9,
      connection: { connectionId: 'connection-1', revision: 6 },
      test: {
        kind: 'failed',
        checkedAt: '2026-08-05T00:00:01.000Z',
        modelId: 'model-1',
        latencyMs: 250,
        statusCode: 503,
        errorClass: 'provider_unavailable',
      },
    }),
    {
      ok: false,
      modelTested: 'model-1',
      latencyMs: 250,
      statusCode: 503,
      errorClass: 'provider_unavailable',
    },
  );
});

function catalog(): ConnectionCatalogSnapshot {
  return {
    revision: 7,
    defaultTarget: { connectionId: 'connection-1', modelId: 'model-1' },
    connections: [
      {
        connectionId: 'connection-1',
        revision: 4,
        slug: 'openrouter',
        name: 'OpenRouter',
        providerType: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        enabled: true,
        enabledModelIds: ['model-1', 'model-2'],
        models: [{ id: 'model-1' }, { id: 'model-2' }],
      },
    ],
  };
}
