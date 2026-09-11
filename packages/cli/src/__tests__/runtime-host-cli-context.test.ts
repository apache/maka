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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  connectRuntimeHostProfile,
  createClientRuntimeHostProfileCatalog,
  RuntimeHostRemoteCompatibilityError,
  RuntimeHostStartupError,
  HostHandoffRequiredError,
  HostHandoffCancelledError,
  type RuntimeHostConnection,
  type RuntimeHostProfileCatalog,
  type RemoteRuntimeHostProfile,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostIncompatible,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import {
  connectRuntimeHostCli,
  connectRuntimeHostCliConnection,
} from '../runtime-host-cli-context.js';

const V0_1_11_HOST_COMPATIBILITY_EPOCH = 25;

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
    subscribeConnectionCatalogChanges: () => () => {},
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
  assert.equal(context.clientInstanceId, clientInstanceId);
  await context.close();
  assert.equal(closes, 1);
});

test('connection-only CLI bootstrap does not read the model connection catalog', async () => {
  const connection = {
    rootId: 'root-id',
    hostEpoch: 'host-epoch',
    connectionId: 'connection-id',
    selectedProtocol: 0,
    closed: new Promise<void>(() => {}),
    status: async () => ({ state: 'ready' }),
    subscribeConfigurationChanges: () => () => {},
    subscribeConnectionCatalogChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {},
  } as unknown as RuntimeHostConnection;
  const context = await connectRuntimeHostCliConnection(
    { rootPath: '/runtime-host-root' },
    {
      connectOrSpawn: async () => connectedHostResult(connection),
      readConnectionCatalog: async () => {
        throw new Error('model connection catalog unavailable');
      },
    },
  );

  assert.equal(context.connection.connectionId, connection.connectionId);
  await context.close();
});

for (const temporary of [true, false]) {
  test(`${temporary ? 'npx' : 'ordinary'} CLI preserves an existing Host and guards only npx candidate launches`, async () => {
    let closes = 0;
    const connection = {
      rootId: 'root-id',
      hostEpoch: 'host-existing',
      connectionId: 'connection-id',
      selectedProtocol: 0,
      closed: new Promise<void>(() => {}),
      status: async () => ({ state: 'ready' }),
      subscribeConfigurationChanges: () => () => {},
      subscribeConnectionCatalogChanges: () => () => {},
      subscribeProjectCatalogChanges: () => () => {},
      subscribeSessionCatalogChanges: () => () => {},
      subscribeScheduledTaskChanges: () => () => {},
      request: async () => {
        throw new Error('Disconnect must not retire the existing Host');
      },
      close: async () => {
        closes += 1;
      },
    } as unknown as RuntimeHostConnection;
    const context = await connectRuntimeHostCliConnection(
      { rootPath: '/runtime-host-root' },
      {
        isTemporaryNpxInstallation: async () => temporary,
        resolveInstallation: async () => {
          throw new Error('No deployment mutation was requested');
        },
        connectOrSpawn: async (input) => {
          assert.equal(input.closeOnLauncherExit, temporary ? true : undefined);
          assert.equal(input.generation, undefined);
          assert.equal(input.takeoverHostEpoch, undefined);
          return connectedHostResult(connection);
        },
      },
    );
    await context.close();
    assert.equal(closes, 1);
  });
}

test('CLI refuses a staged Host whose durable installation claim is missing', async () => {
  let closes = 0;
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root' },
      {
        connectOrSpawn: async () => ({
          kind: 'connected',
          registration: hostRegistration({
            generation: `npm-global-handoff:${'a'.repeat(64)}`,
          }),
          connection: {
            close: async () => {
              closes += 1;
            },
          } as RuntimeHostConnection,
        }),
        readDeploymentRecord: async () => undefined,
      },
    ),
    /RUNTIME_HOST_RECOVERY_REQUIRED/u,
  );
  assert.equal(closes, 1);
});

test('CLI Runtime Host bootstrap aborts a stalled catalog read and closes its connection', async () => {
  const controller = new AbortController();
  const catalogStarted = deferred<void>();
  const abortReason = new Error('ACP connection closed');
  let closes = 0;
  let connectSignal: AbortSignal | undefined;
  const connection = {
    rootId: 'root-id',
    hostEpoch: 'host-epoch',
    connectionId: 'connection-id',
    selectedProtocol: 0,
    closed: new Promise<void>(() => {}),
    status: async () => ({ state: 'ready' }),
    subscribeConfigurationChanges: () => () => {},
    subscribeConnectionCatalogChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {
      closes += 1;
    },
  } as unknown as RuntimeHostConnection;

  const connecting = connectRuntimeHostCli(
    { rootPath: '/runtime-host-root', signal: controller.signal },
    {
      connectOrSpawn: async (input) => {
        connectSignal = input.signal;
        return {
          kind: 'connected',
          connection,
          registration: hostRegistration(),
        };
      },
      readConnectionCatalog: async () => {
        catalogStarted.resolve();
        return new Promise(() => {});
      },
    },
  );
  await catalogStarted.promise;
  controller.abort(abortReason);

  await assert.rejects(connecting, (error: unknown) => error === abortReason);
  assert.equal(connectSignal, controller.signal);
  assert.equal(closes, 1);
});

test('CLI Runtime Host bootstrap closes an initial connection acquired after abort', async () => {
  const controller = new AbortController();
  const connectStarted = deferred<void>();
  const acquired = deferred<ReturnType<typeof connectedHostResult>>();
  const abortReason = new Error('ACP connection closed');
  let closes = 0;
  const connection = {
    close: async () => {
      closes += 1;
    },
  } as unknown as RuntimeHostConnection;

  const connecting = connectRuntimeHostCli(
    { rootPath: '/runtime-host-root', signal: controller.signal },
    {
      connectOrSpawn: async () => {
        connectStarted.resolve();
        return acquired.promise;
      },
    },
  );
  await connectStarted.promise;
  controller.abort(abortReason);

  await assert.rejects(connecting, (error: unknown) => error === abortReason);
  acquired.resolve(connectedHostResult(connection));
  await waitFor(() => closes === 1);
});

test('non-interactive CLI reports how to retire an incompatible Runtime Host', async () => {
  assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > V0_1_11_HOST_COMPATIBILITY_EPOCH);
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root' },
      {
        readDeploymentRecord: async () => undefined,
        resolveInstallation: async () => {
          throw new Error('Not installed globally');
        },
        connectOrSpawn: async () => ({
          kind: 'incompatible',
          registration: hostRegistration({
            compatibilityEpoch: V0_1_11_HOST_COMPATIBILITY_EPOCH,
          }),
          handshake: {
            kind: 'incompatible',
            hostEpoch: 'host-old',
            protocolMin: 0,
            protocolMax: 0,
            compatibilityEpoch: V0_1_11_HOST_COMPATIBILITY_EPOCH,
            compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
            compositionRevision: 'legacy',
            state: 'ready',
            replacement: 'blocked_by_residency',
          },
        }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HostHandoffRequiredError);
      assert.equal(error.view.reason, 'operator_required');
      assert.equal(error.view.activity, undefined);
      assert.deepEqual(error.view.actions, ['cancel', 'retry']);
      assert.match(error.message, /operator/);
      return true;
    },
  );
});

test('CLI explains a service Host without inventing resident work', async () => {
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root' },
      {
        readDeploymentRecord: async () => undefined,
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
      assert.ok(error instanceof HostHandoffRequiredError);
      assert.equal(error.view.reason, 'operator_required');
      assert.equal(error.view.mayExitNaturally, false);
      assert.match(error.message, /operator/);
      assert.doesNotMatch(error.message, /not idle/);
      return true;
    },
  );
});

test('CLI reports an actionable stored-data startup failure', async () => {
  await assert.rejects(
    connectRuntimeHostCli(
      { rootPath: '/runtime-host-root' },
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
  let remoteInput: Parameters<typeof connectRuntimeHostProfile>[0] | undefined;
  const connection = {
    rootId,
    hostEpoch: 'host-remote',
    connectionId: 'connection-remote',
    selectedProtocol: 0,
    closed: new Promise<void>(() => {}),
    status: async () => ({ state: 'ready' }),
    subscribeConfigurationChanges: () => () => {},
    subscribeConnectionCatalogChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {},
  } as unknown as RuntimeHostConnection;
  const context = await connectRuntimeHostCli(
    { rootPath: '/unused-local-root', profileId: 'office' },
    {
      connectOrSpawn: async () => {
        throw new Error('remote profile must not use local discovery');
      },
      isTemporaryNpxInstallation: async () => {
        throw new Error('A remote connection must not inspect local invocation provenance');
      },
      connectProfile: async (input) => {
        remoteInput = input;
        return connection;
      },
      profileCatalog: {
        read: async () => ({
          schemaVersion: 5,
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
          profileIncarnationId: 'incarnation-a',
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
        rebindIfCurrent: async () => {
          throw new Error('unexpected write');
        },
        updateRemoteProfileIfCurrent: async () => {
          throw new Error('unexpected write');
        },
        mutateRemoteProfileIfCurrent: async () => {
          throw new Error('unexpected write');
        },
        readRemoteProfileIfCurrent: async () => {
          throw new Error('unexpected read');
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
  assert.equal(context.clientInstanceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(context.profileIncarnationId, 'incarnation-a');
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
    subscribeConnectionCatalogChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
    close: async () => {},
  } as unknown as RuntimeHostConnection;

  const context = await connectRuntimeHostCli(
    {
      rootPath: '/unused-local-root',
      clientDataRoot,
      profileId: 'office',
    },
    {
      connectOrSpawn: async () => {
        throw new Error('remote profile must not use local discovery');
      },
      connectProfile: async (input) => {
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

test('remote CLI enables SSH prompts only for an explicitly interactive TTY', async (t) => {
  const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  t.after(() => {
    if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdoutIsTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

  const rootId = 'd'.repeat(64);
  const profile: RemoteRuntimeHostProfile = {
    id: 'office',
    name: 'Office',
    kind: 'remote',
    transport: {
      kind: 'ssh',
      destination: 'operator@runtime.example.com',
      remotePort: 7443,
      websocketPath: '/runtime-host',
    },
    rootId,
  };
  const sshInteractions: string[] = [];
  const connect = async (interactiveSsh?: boolean) =>
    connectRuntimeHostCli(
      {
        rootPath: '/unused-local-root',
        profileId: profile.id,
        ...(interactiveSsh === undefined ? {} : { interactiveSsh }),
      },
      {
        connectProfile: async (input) => {
          assert.ok(input.sshInteraction);
          sshInteractions.push(input.sshInteraction);
          return {
            rootId,
            hostEpoch: 'host-remote',
            connectionId: `connection-${sshInteractions.length}`,
            selectedProtocol: 0,
            closed: new Promise<void>(() => {}),
            status: async () => ({ state: 'ready' }),
            subscribeConfigurationChanges: () => () => {},
            subscribeConnectionCatalogChanges: () => () => {},
            subscribeProjectCatalogChanges: () => () => {},
            subscribeSessionCatalogChanges: () => () => {},
            subscribeScheduledTaskChanges: () => () => {},
            close: async () => {},
          } as unknown as RuntimeHostConnection;
        },
        profileCatalog: singleRemoteProfileCatalog(profile),
        loadClientInstanceId: async () => '44444444-4444-4444-8444-444444444444',
        readConnectionCatalog: async () => ({ revision: 1, defaultTarget: null, connections: [] }),
      },
    );

  const interactive = await connect(true);
  await interactive.close();
  const nonInteractive = await connect();
  await nonInteractive.close();

  assert.deepEqual(sshInteractions, ['inherit', 'batch']);
});

test('remote profiles preserve shared compatibility errors', async () => {
  const cases: readonly {
    readonly handshake: HostIncompatible;
  }[] = [
    {
      handshake: incompatibleRemoteHandshake({
        compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH - 1,
      }),
    },
    {
      handshake: incompatibleRemoteHandshake({
        protocolMin: RUNTIME_HOST_PROTOCOL_VERSION + 1,
        protocolMax: RUNTIME_HOST_PROTOCOL_VERSION + 2,
      }),
    },
    {
      handshake: incompatibleRemoteHandshake({
        compositionId: 'maka.other-composition',
        compositionRevision: 'other-revision',
      }),
    },
  ];

  for (const [index, { handshake }] of cases.entries()) {
    const profile: RemoteRuntimeHostProfile = {
      id: `office-${index}-${handshake.compositionRevision}`,
      name: 'Office',
      kind: 'remote',
      transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
      rootId: 'c'.repeat(64),
    };
    await assert.rejects(
      () =>
        connectRuntimeHostCli(
          { rootPath: '/unused-local-root', profileId: profile.id },
          {
            connectProfile: (input) =>
              connectRuntimeHostProfile(input, {
                connect: async () => ({ kind: 'incompatible', handshake }),
              }),
            profileCatalog: singleRemoteProfileCatalog(profile),
            loadClientInstanceId: async () => '33333333-3333-4333-8333-333333333333',
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof HostHandoffRequiredError);
        assert.deepEqual(error.view.actions, ['cancel', 'retry']);
        assert.equal(error.view.target.hostEpoch, handshake.hostEpoch);
        assert.equal(
          error.view.diagnostic,
          new RuntimeHostRemoteCompatibilityError(profile.id, handshake).message,
        );
        assert.equal(error.view.target.rootId, profile.rootId);
        return true;
      },
    );
  }
});

function hostRegistration(overrides: Partial<HostRegistration> = {}): HostRegistration {
  return {
    kind: 'maka-runtime-host' as const,
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: 'a'.repeat(64),
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

function connectedHostResult(connection: RuntimeHostConnection) {
  return {
    kind: 'connected' as const,
    connection,
    registration: hostRegistration(),
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
    read: async () => ({ schemaVersion: 5, profiles: [profile] }),
    resolve: async (profileId) => {
      assert.equal(profileId, profile.id);
      return {
        profile,
        credential: 'opaque-token',
        profileIncarnationId: 'incarnation-a',
      };
    },
    create: async () => assert.fail('unexpected write'),
    save: async () => assert.fail('unexpected write'),
    remove: async () => assert.fail('unexpected write'),
    removeIfCurrent: async () => assert.fail('unexpected write'),
    rebindIfCurrent: async () => assert.fail('unexpected write'),
    updateRemoteProfileIfCurrent: async () => assert.fail('unexpected write'),
    mutateRemoteProfileIfCurrent: async () => assert.fail('unexpected write'),
    readRemoteProfileIfCurrent: async () => assert.fail('unexpected read'),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

test('local CLI delegates a managed cold start once and reconnects without a launch claim', async () => {
  const calls: string[] = [];
  const connection = {
    rootId: 'root-id',
    hostEpoch: 'host-epoch',
    connectionId: 'connection-id',
    closed: new Promise<void>(() => {}),
    close: async () => {},
    subscribeConfigurationChanges: () => () => {},
    subscribeConnectionCatalogChanges: () => () => {},
    subscribeProjectCatalogChanges: () => () => {},
    subscribeSessionCatalogChanges: () => () => {},
    subscribeScheduledTaskChanges: () => () => {},
  } as unknown as RuntimeHostConnection;
  const context = await connectRuntimeHostCliConnection(
    { rootPath: '/managed-root' },
    {
      connectOrSpawn: async (input) => {
        assert.equal(input.managedLaunchClaim, undefined);
        calls.push('connect');
        return calls.length === 1
          ? { kind: 'failed', reason: 'managed_root_requires_operator' }
          : connectedHostResult(connection);
      },
      connectActivatedHost: async () => {
        calls.push('connect');
        return connectedHostResult(connection);
      },
      activateLocalManagedHost: async (input) => {
        assert.equal(input.rootPath, '/managed-root');
        calls.push('operator');
      },
    },
  );
  assert.deepEqual(calls, ['connect', 'operator', 'connect']);
  await context.close();
});

test('local CLI does not loop if operator activation fails to make the Host available', async () => {
  let activations = 0;
  await assert.rejects(
    connectRuntimeHostCliConnection(
      { rootPath: '/managed-root' },
      {
        connectOrSpawn: async () => ({ kind: 'failed', reason: 'managed_root_requires_operator' }),
        connectActivatedHost: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
        activateLocalManagedHost: async () => {
          activations += 1;
        },
      },
    ),
    /could not join it \(not_registered\)/,
  );
  assert.equal(activations, 1);
});

test('local CLI propagates operator failure without attempting unmanaged recovery', async () => {
  let connections = 0;
  const failure = new Error('operator failed');
  await assert.rejects(
    connectRuntimeHostCliConnection(
      { rootPath: '/managed-root' },
      {
        connectOrSpawn: async () => {
          connections += 1;
          return { kind: 'failed', reason: 'managed_root_requires_operator' };
        },
        activateLocalManagedHost: async () => {
          throw failure;
        },
      },
    ),
    (error) => error === failure,
  );
  assert.equal(connections, 1);
});

test('activated managed Host incompatibility stays operator-owned', async () => {
  await assert.rejects(
    connectRuntimeHostCliConnection(
      { rootPath: '/managed-root' },
      {
        connectOrSpawn: async () => ({ kind: 'failed', reason: 'managed_root_requires_operator' }),
        activateLocalManagedHost: async () => {},
        connectActivatedHost: async () => ({
          kind: 'incompatible',
          registration: hostRegistration(),
          handshake: incompatibleRemoteHandshake(),
        }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof HostHandoffRequiredError);
      assert.equal(error.view.reason, 'operator_required');
      assert.deepEqual(error.view.actions, ['cancel', 'retry']);
      assert.match(error.message, /operator/);
      return true;
    },
  );
});

for (const action of ['cancel', 'interrupt', 'retry'] as const) {
  test(`source CLI observed-process recovery requires explicit interruption: ${action}`, async () => {
    let stopped = 0;
    let attention = 0;
    const registration = hostRegistration({ compatibilityEpoch: 121 });
    const processIdentity = { startIdentity: 'linux:42:123' };
    const connection = {
      rootId: registration.rootId,
      hostEpoch: 'new-host',
      connectionId: 'new-connection',
      selectedProtocol: 0,
      closed: new Promise<void>(() => {}),
      status: async () => ({ state: 'ready' }),
      subscribeConfigurationChanges: () => () => {},
      subscribeConnectionCatalogChanges: () => () => {},
      subscribeProjectCatalogChanges: () => () => {},
      subscribeSessionCatalogChanges: () => () => {},
      subscribeScheduledTaskChanges: () => () => {},
      close: async () => {},
    } as unknown as RuntimeHostConnection;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error('handoff did not settle')), 3000);
    try {
      const running = connectRuntimeHostCliConnection(
        {
          rootPath: '/source-root',
          signal: abort.signal,
          handoffSurface: (submit) => ({
            update(view) {
              if (view.state !== 'attention') return;
              assert.equal(view.reason, 'activity_unknown');
              assert.deepEqual(view.actions, ['cancel', 'retry', 'interrupt']);
              assert.equal(stopped, 0);
              submit(view.revision, attention++ === 0 ? action : 'cancel');
            },
            close() {},
          }),
        },
        {
          isTemporaryNpxInstallation: async () => false,
          resolveManagedAuthority: async () => undefined,
          readDeploymentRecord: async () => undefined,
          resolveInstallation: async () => {
            throw new Error('development checkout');
          },
          connectOrSpawn: async () =>
            stopped
              ? connectedHostResult(connection)
              : {
                  kind: 'incompatible',
                  registration,
                  processIdentity,
                  handshake: incompatibleRemoteHandshake({ hostEpoch: registration.hostEpoch }),
                },
          terminateObservedHost: async (observed, authority) => {
            assert.equal(observed.registration, registration);
            assert.equal(authority.processIdentity, processIdentity);
            assert.equal(authority.isCurrent(), true);
            stopped++;
            return true;
          },
        },
      );
      if (action === 'interrupt') {
        const context = await running;
        await context.close();
        assert.equal(stopped, 1);
      } else {
        // Retry preserves the same view; cancellation is a separate user action.
        if (action === 'retry') setTimeout(() => abort.abort(new HostHandoffCancelledError()), 30);
        await assert.rejects(running, HostHandoffCancelledError);
        assert.equal(stopped, 0);
      }
    } finally {
      clearTimeout(timeout);
    }
  });
}

for (const blocker of ['managed', 'owner', 'temporary', 'identity'] as const) {
  test(`CLI never offers unowned process recovery for ${blocker}`, async () => {
    await assert.rejects(
      connectRuntimeHostCliConnection(
        { rootPath: '/source-root' },
        {
          isTemporaryNpxInstallation: async () => blocker === 'temporary',
          resolveManagedAuthority: async () =>
            blocker === 'managed' ? ({ record: {} } as never) : undefined,
          readDeploymentRecord: async () =>
            blocker === 'owner'
              ? ({
                  state: { kind: 'owned', owner: { kind: 'desktop', installationId: 'other' } },
                } as never)
              : undefined,
          resolveInstallation: async () => {
            throw new Error('development checkout');
          },
          connectOrSpawn: async () => ({
            kind: 'incompatible',
            registration: hostRegistration(),
            ...(blocker === 'identity' ? {} : { processIdentity: { startIdentity: 'observed' } }),
            handshake: incompatibleRemoteHandshake(),
          }),
          terminateObservedHost: async () => {
            throw new Error('must not terminate');
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof HostHandoffRequiredError);
        assert.deepEqual(error.view.actions, ['cancel', 'retry']);
        assert.equal(
          error.view.recoveryBlocker,
          blocker === 'temporary' ? 'installation' : blocker,
        );
        return true;
      },
    );
  });
}

for (const changed of ['managed', 'owner'] as const) {
  test(`CLI rechecks ${changed} authority after interruption consent`, async () => {
    let inspections = 0;
    let attention = 0;
    let terminated = false;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error('handoff did not settle')), 3000);
    try {
      await assert.rejects(
        connectRuntimeHostCliConnection(
          {
            rootPath: '/source-root',
            signal: abort.signal,
            handoffSurface: (submit) => ({
              update(view) {
                if (view.state !== 'attention') return;
                if (attention++ === 0) {
                  assert.ok(view.actions.includes('interrupt'));
                  submit(view.revision, 'interrupt');
                } else {
                  assert.equal(view.reason, 'operator_required');
                  assert.ok(!view.actions.includes('interrupt'));
                  submit(view.revision, 'cancel');
                }
              },
              close() {},
            }),
          },
          {
            isTemporaryNpxInstallation: async () => false,
            resolveInstallation: async () => {
              throw new Error('source installation');
            },
            resolveManagedAuthority: async () => {
              inspections++;
              return changed === 'managed' && inspections >= 3
                ? ({ record: {} } as never)
                : undefined;
            },
            readDeploymentRecord: async () =>
              changed === 'owner' && inspections >= 3
                ? ({
                    state: {
                      kind: 'owned',
                      owner: { kind: 'desktop', installationId: 'new-owner' },
                    },
                  } as never)
                : undefined,
            connectOrSpawn: async () => ({
              kind: 'incompatible',
              registration: hostRegistration(),
              processIdentity: { startIdentity: 'observed-process' },
              handshake: incompatibleRemoteHandshake(),
            }),
            terminateObservedHost: async () => {
              terminated = true;
              return true;
            },
          },
        ),
        HostHandoffCancelledError,
      );
      assert.equal(terminated, false);
    } finally {
      clearTimeout(timeout);
    }
  });
}
