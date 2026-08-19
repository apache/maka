import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectRemoteRuntimeHostProfile,
  createClientRuntimeHostProfileCatalog,
  RuntimeHostRemoteCompatibilityError,
  RuntimeHostStartupError,
  type RuntimeHostConnection,
  type RuntimeHostProfileCatalog,
  type RemoteRuntimeHostProfile,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type ClientSurface,
  type HostIncompatible,
} from '@maka/runtime-host/protocol';
import {
  canRestartRuntimeHostCliConflict,
  connectRuntimeHostCli,
  resolveRuntimeHostCliConflictDecision,
  RuntimeHostCliConflictError,
} from '../runtime-host-cli-context.js';

test('CLI Runtime Host bootstrap launches the execution composition', async () => {
  let candidateEntrypoint: string | URL | undefined;
  let candidateGeneration: string | undefined;
  let requiredGeneration: string | undefined;
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
        candidateGeneration = input.candidateGeneration;
        requiredGeneration = input.generation;
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
      loadInstallationContext: async () => ({
        packageRoot: '/maka-cli',
        version: '1.2.3',
        installationScope: 'persistent',
        artifactGeneration: 'maka-agent@1.2.3',
      }),
    },
  );

  assert.ok(candidateEntrypoint instanceof URL);
  assert.equal(basename(fileURLToPath(candidateEntrypoint)), 'execution-candidate-main.js');
  assert.equal(candidateGeneration, 'maka-agent@1.2.3');
  assert.equal(requiredGeneration, undefined);
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
      assert.match(
        error.message,
        new RegExp(
          `PID 42; lifecycle ephemeral; compatibility epoch ${RUNTIME_HOST_COMPATIBILITY_EPOCH - 1}`,
        ),
      );
      assert.match(
        error.message,
        /ephemeral Host still owns this State Root/,
      );
      assert.match(error.message, /previous compatible Maka build/);
      return true;
    },
  );
});

test('CLI explains a service Host without inventing resident work', async () => {
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root', surface: 'run' },
      {
        connectOrSpawn: async () => ({
          kind: 'incompatible',
          registration: hostRegistration({ lifecycleMode: 'service' }),
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
      assert.match(error.message, /service Host is managed by its operator/);
      assert.match(error.message, /service operator to inspect or upgrade/);
      assert.doesNotMatch(error.message, /not idle/);
      return true;
    },
  );
});

test('CLI local generation takeover is exact and remains a typed conflict while blocked', async () => {
  let connectInput:
    | {
        readonly generation?: string;
        readonly candidateGeneration?: string;
        readonly takeoverHostEpoch?: string;
      }
    | undefined;
  await assert.rejects(
    connectRuntimeHostCli(
      {
        rootPath: '/runtime-host-root',
        surface: 'tui',
        localGenerationRequest: {
          kind: 'takeover',
          expectedHostEpoch: 'host-old',
        },
      },
      {
        loadInstallationContext: async () => ({
          packageRoot: '/maka-cli',
          version: '1.2.3',
          installationScope: 'persistent',
          artifactGeneration: 'maka-agent@1.2.3',
        }),
        connectOrSpawn: async (input) => {
          connectInput = input;
          return {
            kind: 'upgrade_required',
            restartable: false,
            registration: hostRegistration({ generation: 'maka-agent@1.2.2' }),
            handshake: {
              kind: 'incompatible',
              hostEpoch: 'host-old',
              protocolMin: 0,
              protocolMax: 0,
              compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
              compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
              compositionRevision: 'current',
              generation: 'maka-agent@1.2.2',
              state: 'ready',
              replacement: 'blocked_by_residency',
              activity: {
                connections: 1,
                activeOperations: 0,
                processUptimeSeconds: 61,
                residencies: [{ label: 'scheduled-task', count: 1 }],
              },
            },
          };
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostCliConflictError);
      assert.equal(error.conflict.kind, 'upgrade_required');
      assert.equal(canRestartRuntimeHostCliConflict(error), false);
      assert.match(error.message, /1 connection\(s\), 0 active operation\(s\), uptime 61s/);
      assert.match(error.message, /scheduled-task \(1\)/);
      return true;
    },
  );

  assert.equal(connectInput?.generation, 'maka-agent@1.2.3');
  assert.equal(connectInput?.candidateGeneration, 'maka-agent@1.2.3');
  assert.equal(connectInput?.takeoverHostEpoch, 'host-old');
});

test('CLI conflict decisions require an offered restart action', () => {
  assert.equal(resolveRuntimeHostCliConflictDecision('r', true), 'restart');
  assert.equal(resolveRuntimeHostCliConflictDecision(' restart ', true), 'restart');
  assert.equal(resolveRuntimeHostCliConflictDecision('r', false), 'cancel');
  assert.equal(resolveRuntimeHostCliConflictDecision('w', true), 'wait');
  assert.equal(resolveRuntimeHostCliConflictDecision(' WAIT ', false), 'wait');
  assert.equal(resolveRuntimeHostCliConflictDecision('', true), 'cancel');
  assert.equal(resolveRuntimeHostCliConflictDecision('unexpected', true), 'cancel');
});

test('temporary npx invocation cannot turn a restartable Host fact into replacement authority', () => {
  const error = new RuntimeHostCliConflictError(
    { kind: 'upgrade_required', restartable: true },
    hostRegistration({ generation: 'maka-agent@1.2.2' }),
    false,
  );

  assert.equal(canRestartRuntimeHostCliConflict(error), false);
  assert.match(error.message, /transient CLI invocation is not a persistent installation owner/u);
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
      loadInstallationContext: async () =>
        assert.fail('remote profile must not resolve local installation'),
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

test('remote CLI profiles reject local generation intent before connecting', async (t) => {
  const clientDataRoot = await mkdtemp(join(tmpdir(), 'maka-cli-remote-generation-root-'));
  t.after(() => rm(clientDataRoot, { recursive: true, force: true }));
  await createClientRuntimeHostProfileCatalog(clientDataRoot).save(
    {
      id: 'office',
      name: 'Office',
      kind: 'remote',
      transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
      rootId: 'c'.repeat(64),
    },
    'opaque-token',
  );

  await assert.rejects(
    connectRuntimeHostCli(
      {
        rootPath: '/unused-local-root',
        clientDataRoot,
        surface: 'tui',
        profileId: 'office',
        localGenerationRequest: { kind: 'require_installed' },
      },
      {
        connectOrSpawn: async () => assert.fail('remote profile must not use local discovery'),
        connectRemoteProfile: async () => assert.fail('local generation intent must be rejected'),
        loadInstallationContext: async () =>
          assert.fail('remote profile must not resolve local installation'),
      },
    ),
    /remote Runtime Host does not accept local generation requests/u,
  );
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

test('CLI and TUI remote profiles preserve shared compatibility errors', async () => {
  const cases: readonly {
    readonly surface: Extract<ClientSurface, 'run' | 'tui'>;
    readonly handshake: HostIncompatible;
  }[] = [
    {
      surface: 'run',
      handshake: incompatibleRemoteHandshake({
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
      }),
    },
    {
      surface: 'tui',
      handshake: incompatibleRemoteHandshake({
        protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 1,
        protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 2,
      }),
    },
    {
      surface: 'run',
      handshake: incompatibleRemoteHandshake({
        compositionId: 'maka.other-composition',
        compositionRevision: 'other-revision',
      }),
    },
  ];

  for (const { surface, handshake } of cases) {
    const profile: RemoteRuntimeHostProfile = {
      id: `office-${surface}-${handshake.compositionRevision}`,
      name: 'Office',
      kind: 'remote',
      transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
      rootId: 'c'.repeat(64),
    };
    await assert.rejects(
      () =>
        connectRuntimeHostCli(
          { rootPath: '/unused-local-root', surface, profileId: profile.id },
          {
            connectRemoteProfile: (input) =>
              connectRemoteRuntimeHostProfile(input, {
                connect: async () => ({ kind: 'incompatible', handshake }),
              }),
            profileCatalog: singleRemoteProfileCatalog(profile),
            loadClientInstanceId: async () => '33333333-3333-4333-8333-333333333333',
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeHostRemoteCompatibilityError);
        assert.equal(error.code, 'RUNTIME_HOST_REMOTE_INCOMPATIBLE');
        assert.equal(
          error.message,
          new RuntimeHostRemoteCompatibilityError(profile.id, handshake).message,
        );
        assert.deepEqual(error.details, {
          profileId: profile.id,
          client: {
            compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
            protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
            protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
            compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
          },
          host: {
            compatibilityEpoch: handshake.compatibilityEpoch,
            protocolMin: handshake.protocolMin,
            protocolMax: handshake.protocolMax,
            compositionId: handshake.compositionId,
            compositionRevision: handshake.compositionRevision,
          },
        });
        return true;
      },
    );
  }
});

function hostRegistration(
  overrides: Partial<{
    compatibilityEpoch: number;
    lifecycleMode: 'ephemeral' | 'service';
    generation: string;
  }> = {},
) {
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
    lifecycleMode: 'ephemeral' as const,
    state: 'ready' as const,
    pid: 42,
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function incompatibleRemoteHandshake(overrides: Partial<HostIncompatible> = {}): HostIncompatible {
  return {
    kind: 'incompatible',
    hostEpoch: 'remote-host-epoch',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'remote-host-revision',
    state: 'ready',
    replacement: 'blocked_by_residency',
    ...overrides,
  };
}

function singleRemoteProfileCatalog(profile: RemoteRuntimeHostProfile): RuntimeHostProfileCatalog {
  return {
    read: async () => ({ schemaVersion: 1, profiles: [profile] }),
    resolve: async (profileId) => {
      assert.equal(profileId, profile.id);
      return { profile, credential: 'opaque-token' };
    },
    create: async () => assert.fail('unexpected write'),
    save: async () => assert.fail('unexpected write'),
    remove: async () => assert.fail('unexpected write'),
    removeIfCurrent: async () => assert.fail('unexpected write'),
  };
}
