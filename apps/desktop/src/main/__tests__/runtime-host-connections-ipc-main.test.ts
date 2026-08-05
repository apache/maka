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
