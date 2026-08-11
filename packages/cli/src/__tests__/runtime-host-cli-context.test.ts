import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
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
