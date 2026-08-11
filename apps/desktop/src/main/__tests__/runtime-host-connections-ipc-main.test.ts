import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  projectCredentialProfileReadiness,
  projectHostConnections,
  projectHostConnectionTest,
  projectHostProfileTest,
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
    'connections:getDefault',
    'connections:getRequestHeaders',
    'connections:hasSecret',
    'connections:list',
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

test('projects Profile test outcomes without leaking secrets or provider bodies', () => {
  assert.deepEqual(
    projectHostProfileTest({
      kind: 'committed',
      verification: 'recorded',
      test: {
        kind: 'verified',
        checkedAt: '2026-08-05T00:00:00.000Z',
        modelId: 'model-1',
        latencyMs: 42,
      },
    }),
    { ok: true, modelTested: 'model-1', latencyMs: 42 },
  );
  assert.deepEqual(
    projectHostProfileTest({
      kind: 'committed',
      verification: 'not_recorded',
      test: {
        kind: 'failed',
        checkedAt: '2026-08-05T00:00:01.000Z',
        modelId: 'model-1',
        latencyMs: null,
        statusCode: 401,
        errorClass: 'auth',
      },
    }),
    { ok: false, modelTested: 'model-1', statusCode: 401, errorClass: 'auth' },
  );
  assert.deepEqual(
    projectHostProfileTest({ kind: 'rejected', reason: 'profile_not_found' }),
    { ok: false, errorMessage: 'Profile test did not run: rejected' },
  );
});

test('projects Profile readiness as a secret-free view', () => {
  const projected = projectCredentialProfileReadiness({
    kind: 'found',
    connectionId: 'connection-1',
    connectionRevision: 7,
    routingMode: 'balanced',
    readyCandidateCount: 1,
    profiles: [
      {
        profileId: 'profile-2',
        revision: 1,
        label: 'backup',
        enabled: true,
        weight: 25,
        primary: false,
        credentialConfigured: true,
        lastTest: { status: 'verified', checkedAt: '2026-08-05T00:00:00.000Z' },
        supportedModels: ['model-1'],
        circuit: { state: 'closed', blockedUntil: null, nextProbeAt: null },
      },
    ],
  });
  assert.equal(projected.routingMode, 'balanced');
  assert.equal(projected.readyCandidateCount, 1);
  assert.equal(projected.profiles[0]?.label, 'backup');
  assert.equal(projected.profiles[0]?.credentialConfigured, true);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
});

test('wires Profile CRUD, readiness and test channels against the Host client', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const readiness = {
    kind: 'found' as const,
    connectionId: 'connection-1',
    connectionRevision: 4,
    routingMode: 'legacy_primary' as const,
    readyCandidateCount: 0,
    profiles: [],
  };
  registerRuntimeHostConnectionsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadConnectionCatalog: async (): Promise<ConnectionCatalogSnapshot> => catalog(),
      queryCredentialProfileReadiness: async () => readiness,
      createCredentialProfile: async (input: { label: string; weight: number }) => {
        calls.push(`create:${input.label}:${input.weight}`);
        return { kind: 'committed', catalogRevision: 5, connection: { connectionId: 'connection-1', revision: 5 } };
      },
      setCredentialProfileEnabled: async (input: {
        expected: { profileId: string };
        enabled: boolean;
      }) => {
        calls.push(`enabled:${input.expected.profileId}:${input.enabled}`);
        return { kind: 'committed', catalogRevision: 6, connection: { connectionId: 'connection-1', revision: 6 } };
      },
      setCredentialRoutingMode: async (input: { mode: string }) => {
        calls.push(`mode:${input.mode}`);
        return { kind: 'committed', catalogRevision: 7, connection: { connectionId: 'connection-1', revision: 7 } };
      },
      setCredential: async (input: { locator: { profileId: string }; secret: string }) => {
        calls.push(`credential:${input.locator.profileId}`);
        assert.equal(input.secret, 'saved-key');
        return { kind: 'committed', snapshot: { revision: 2, entries: [] } };
      },
      queryCredential: async () => null,
      testConnectionProfile: async (connectionId: string, profileId: string) => {
        calls.push(`test:${profileId}`);
        return {
          kind: 'committed',
          verification: 'recorded' as const,
          test: {
            kind: 'verified' as const,
            checkedAt: '2026-08-05T00:00:00.000Z',
            modelId: 'model-1',
            latencyMs: 12,
          },
        };
      },
    } as never,
    emitConnectionListChanged() {},
  });

  const queried = await handlers.get('connections:profiles:query')?.({}, 'openrouter');
  assert.deepEqual(queried, {
    connectionRevision: 4,
    routingMode: 'legacy_primary',
    readyCandidateCount: 0,
    profiles: [],
  });

  await handlers.get('connections:profiles:create')?.({}, 'openrouter', { label: 'backup', weight: 30 });
  assert.ok(calls.includes('create:backup:30'));

  await handlers.get('connections:profiles:setEnabled')?.({}, 'openrouter', {
    profileId: 'profile-2',
    profileRevision: 1,
    enabled: true,
  });
  assert.ok(calls.includes('enabled:profile-2:true'));

  await handlers.get('connections:profiles:setRoutingMode')?.({}, 'openrouter', { mode: 'balanced' });
  assert.ok(calls.includes('mode:balanced'));

  await handlers.get('connections:profiles:setCredential')?.({}, 'openrouter', {
    profileId: 'profile-2',
    secret: 'saved-key',
  });
  assert.ok(calls.includes('credential:profile-2'));

  const tested = await handlers.get('connections:profiles:test')?.({}, 'openrouter', {
    profileId: 'profile-2',
  });
  assert.deepEqual(tested, { ok: true, modelTested: 'model-1', latencyMs: 12 });

  await assert.rejects(
    async () =>
      handlers.get('connections:profiles:create')?.({}, 'openrouter', { label: '', weight: 5 }),
    /Profile create input/,
  );
  await assert.rejects(
    async () =>
      handlers.get('connections:profiles:setCredential')?.({}, 'openrouter', { profileId: 'profile-2' }),
    /Profile credential input/,
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
