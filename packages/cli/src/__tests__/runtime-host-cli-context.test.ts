import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectRemoteRuntimeHostProfile,
  createClientRuntimeHostProfileCatalog,
  RuntimeHostStartupError,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
} from '@maka/runtime-host/protocol';
import { connectRuntimeHostCli, RuntimeHostCliConflictError } from '../runtime-host-cli-context.js';

test('CLI Runtime Host bootstrap launches the execution composition', async () => {
  let candidateEntrypoint: string | URL | undefined;
  let clientInstanceId: string | undefined;
  let closes = 0;
  const connection = {
    rootId: 'root-id',
    hostEpoch: 'host-epoch',
    connectionId: 'connection-id',
    selectedProtocol: 0,
    closed: new Promise<void>(() => {}),
    status: async () => ({ state: 'ready' }),
    subscribeConfigurationChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {
      closes += 1;
    },
  } as unknown as RuntimeHostConnection;

  const context = await connectRuntimeHostCli(
    {
      rootPath: '/runtime-host-root',
      surface: 'activation',
    },
    {
      connectOrSpawn: async (input) => {
        candidateEntrypoint = input.candidateEntrypoint;
        clientInstanceId = input.clientInstanceId;
        return {
          kind: 'connected',
          connection,
          registration: hostRegistration(),
        };
      },
      readConnectionCatalog: async () => ({
        revision: 1,
        defaultTarget: null,
        connections: [],
      }),
    },
  );

  assert.ok(candidateEntrypoint instanceof URL);
  assert.equal(basename(fileURLToPath(candidateEntrypoint)), 'execution-candidate-main.js');
  assert.ok(clientInstanceId);
  await context.close();
  assert.equal(closes, 1);
});

test('non-interactive CLI reports how to retire an incompatible Runtime Host', async () => {
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root', surface: 'run' },
      {
        connectOrSpawn: async () => ({
          kind: 'incompatible',
          registration: hostRegistration({
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
          }),
          handshake: {
            kind: 'incompatible',
            hostEpoch: 'host-old',
            protocolMin: 0,
            protocolMax: 0,
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
            compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
            compositionRevision: 'legacy',
            state: 'ready',
            replacement: 'blocked_by_residency',
          },
        }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostCliConflictError);
      assert.equal(error.code, 'RUNTIME_HOST_RESTART_REQUIRED');
      assert.match(error.message, /Stop the previous Maka Desktop or CLI process/);
      return true;
    },
  );
});

test('CLI reports an actionable stored-data startup failure', async () => {
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root', surface: 'run' },
      {
        connectOrSpawn: async () => ({
          kind: 'failed',
          reason: 'stored_data_incompatible',
        }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostStartupError);
      assert.equal(error.reason, 'stored_data_incompatible');
      assert.match(error.message, /STORED_DATA_INCOMPATIBLE/);
      return true;
    },
  );
});

test('remote CLI profiles pin root identity and resolve credential outside the profile', async () => {
  const rootId = 'a'.repeat(64);
  let remoteInput: Parameters<typeof connectRemoteRuntimeHostProfile>[0] | undefined;
  const connection = {
    rootId,
    hostEpoch: 'host-remote',
    connectionId: 'connection-remote',
    selectedProtocol: 0,
    closed: new Promise<void>(() => {}),
    status: async () => ({ state: 'ready' }),
    subscribeConfigurationChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {},
  } as unknown as RuntimeHostConnection;
  const context = await connectRuntimeHostCli(
    { rootPath: '/unused-local-root', surface: 'run', profileId: 'office' },
    {
      connectOrSpawn: async () => {
        throw new Error('remote profile must not use local discovery');
      },
      connectRemoteProfile: async (input) => {
        remoteInput = input;
        return connection;
      },
      profileCatalog: {
        read: async () => ({
          schemaVersion: 1,
          profiles: [
            {
              id: 'office',
              name: 'Office',
              kind: 'remote',
              transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
              rootId,
            },
          ],
        }),
        resolve: async () => ({
          profile: {
            id: 'office',
            name: 'Office',
            kind: 'remote',
            transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
            rootId,
          },
          credential: 'opaque-token',
        }),
        create: async () => {
          throw new Error('unexpected write');
        },
        save: async () => {
          throw new Error('unexpected write');
        },
        remove: async () => {
          throw new Error('unexpected write');
        },
        removeIfCurrent: async () => {
          throw new Error('unexpected write');
        },
      },
      loadClientInstanceId: async () => '11111111-1111-4111-8111-111111111111',
      readConnectionCatalog: async () => ({ revision: 1, defaultTarget: null, connections: [] }),
    },
  );

  assert.equal(context.profile.id, 'office');
  assert.equal(remoteInput?.profile.rootId, rootId);
  assert.equal(remoteInput?.credential, 'opaque-token');
  assert.equal(remoteInput?.clientInstanceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(Object.hasOwn(context.profile, 'credential'), false);
  await context.close();
});

test('remote CLI profile state and Client identity use the explicit Client Data Root', async (t) => {
  const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-cli-client-root-'));
  t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
  const rootId = 'b'.repeat(64);
  await createClientRuntimeHostProfileCatalog(clientDataRoot).save(
    {
      id: 'office',
      name: 'Office',
      kind: 'remote',
      transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
      rootId,
    },
    'opaque-token',
  );
  let identityPath: string | undefined;
  let credential: string | undefined;
  const connection = {
    rootId,
    hostEpoch: 'host-remote',
    connectionId: 'connection-remote',
    selectedProtocol: 0,
    closed: new Promise<void>(() => {}),
    status: async () => ({ state: 'ready' }),
    subscribeConfigurationChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {},
  } as unknown as RuntimeHostConnection;

  const context = await connectRuntimeHostCli(
    {
      rootPath: '/unused-local-root',
      clientDataRoot,
      surface: 'run',
      profileId: 'office',
    },
    {
      connectOrSpawn: async () => {
        throw new Error('remote profile must not use local discovery');
      },
      connectRemoteProfile: async (input) => {
        credential = input.credential;
        return connection;
      },
      loadClientInstanceId: async (path) => {
        identityPath = path;
        return '22222222-2222-4222-8222-222222222222';
      },
      readConnectionCatalog: async () => ({ revision: 1, defaultTarget: null, connections: [] }),
    },
  );

  assert.equal(credential, 'opaque-token');
  assert.equal(identityPath, join(clientDataRoot, 'runtime-host-client.json'));
  await context.close();
});

function hostRegistration(overrides: Partial<{ compatibilityEpoch: number }> = {}) {
  return {
    kind: 'maka-runtime-host' as const,
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: 'root-id',
    hostEpoch: 'host-old',
    endpoint: '/tmp/runtime-host.sock',
    protocolMin: 0,
    protocolMax: 0,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'legacy',
    state: 'ready' as const,
    pid: 42,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}
