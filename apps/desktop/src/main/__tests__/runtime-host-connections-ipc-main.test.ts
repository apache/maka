import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  projectHostConnections,
  projectHostConnectionTest,
  registerRuntimeHostConnectionsIpc,
} from '../runtime-host-connections-ipc-main.js';

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

  assert.deepEqual(createdModels, [
    'nemotron-3-ultra-free',
    'mimo-v2.5-free',
    'deepseek-v4-flash-free',
  ]);
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
