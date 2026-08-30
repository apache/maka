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
import {
  RuntimeHostProfileConnectionError,
  sameRemoteRuntimeHostProfileTarget,
  type RemoteRuntimeHostProfile,
  type RuntimeHostCapabilityProviderCredentialStore,
  type RuntimeHostConnection,
  type RuntimeHostPeerClient,
  type RuntimeHostProfileCatalog,
  type RuntimeHostRemoteProfileIncarnation,
} from '@maka/runtime-host/client';
import { createRemoteTuiMcpPublicationTarget } from '../tui-mcp-remote-publication.js';
import { waitFor } from './tui-terminal-mock.js';

const PROFILE: RemoteRuntimeHostProfile = {
  id: 'office',
  name: 'Office',
  kind: 'remote',
  transport: { kind: 'tls', url: 'wss://runtime.example.com/runtime-host' },
  rootId: 'a'.repeat(64),
};

const DIRECT_PROFILE: RemoteRuntimeHostProfile = {
  ...PROFILE,
  transport: {
    kind: 'libp2p-direct',
    peerId: 'peer-a',
    routeHints: ['/ip4/127.0.0.1/tcp/4001'],
    coordinationRelays: [],
  },
};

const PROFILE_INCARNATION_ID = 'incarnation-a';

test('remote TUI publication activates, rotates, and removes one profile-bound credential', async () => {
  const credentials = credentialHarness();
  const connected: Array<{ credential?: string; clientInstanceId: string }> = [];
  const connections: ConnectionHarness[] = [];
  const identityPaths: string[] = [];
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      ...profileDeps(),
      credentials: credentials.store,
      loadClientInstanceId: async (path) => {
        identityPaths.push(path);
        return 'provider-client';
      },
      connectProfile: async (input) => {
        connected.push({
          credential: input.credential,
          clientInstanceId: input.clientInstanceId,
        });
        const connection = connectionHarness(`connection-${connections.length + 1}`);
        connections.push(connection);
        return connection.connection;
      },
    },
  );
  let latest = await availability(target);
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'credential_required' });

  await target.setCredential?.('provider-secret-a');
  await waitFor(() => latest().kind === 'connected', 'provider companion to connect');
  assert.deepEqual(connected, [
    { credential: 'provider-secret-a', clientInstanceId: 'provider-client' },
  ]);
  assert.equal(
    credentials.values.get('office\0incarnation-a\0terminal-client'),
    'provider-secret-a',
  );
  assert.match(identityPaths[0] ?? '', /capability-provider-identities/u);

  await target.setCredential?.('provider-secret-b');
  await waitFor(
    () => latest().kind === 'connected' && connections.length === 2,
    'rotated provider companion to connect',
  );
  assert.equal(connections[0]?.unregisters, 0);
  assert.equal(connections[0]?.closes, 1);
  assert.equal(
    credentials.values.get('office\0incarnation-a\0terminal-client'),
    'provider-secret-b',
  );
  assert.equal(identityPaths[0], identityPaths[1]);

  await target.removeCredential?.();
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'credential_required' });
  assert.equal(connections[1]?.unregisters, 0);
  assert.equal(connections[1]?.closes, 1);
  assert.equal(credentials.values.has('office\0incarnation-a\0terminal-client'), false);
  await target.closePublication?.();
});

test('remote TUI publication surfaces rejected credentials without a retry authority', async () => {
  const credentials = credentialHarness('revoked-secret');
  let attempts = 0;
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      ...profileDeps(),
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async () => {
        attempts += 1;
        throw new RuntimeHostProfileConnectionError(
          'credential_rejected',
          'Runtime Host rejected its access credential',
        );
      },
    },
  );
  const latest = await availability(target);
  await waitFor(() => {
    const current = latest();
    return current.kind === 'unavailable' && current.reason === 'credential_rejected';
  }, 'rejected provider credential state');
  assert.equal(attempts, 1);
  await target.closePublication?.();
});

test('remote TUI publication aborts an in-flight connection before closing', async () => {
  const credentials = credentialHarness('provider-secret');
  let observedSignal: AbortSignal | undefined;
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      ...profileDeps(),
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async (input) => {
        observedSignal = input.signal;
        return new Promise<RuntimeHostConnection>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true,
          });
        });
      },
    },
  );
  await waitFor(() => observedSignal !== undefined, 'provider connection attempt to start');

  await target.closePublication?.();

  assert.equal(observedSignal?.aborted, true);
});

test('remote TUI publication retires when another process removes its profile', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness();
  const connection = connectionHarness('connection-1');
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async () => connection.connection,
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await waitFor(() => latest().kind === 'connected', 'provider companion to connect');

  profiles.remove();

  await waitFor(() => {
    const current = latest();
    return current.kind === 'unavailable' && current.reason === 'target_mismatch';
  }, 'removed profile to retire provider companion');
  assert.equal(connection.closes, 1);
  await assert.rejects(async () => {
    await target.setCredential?.('replacement-secret');
  });
});

test('remote TUI publication cannot write into a recreated profile incarnation', async () => {
  const credentials = credentialHarness();
  const profiles = profileHarness();
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'credential_required' });

  const heldMutation = profiles.holdNextMutation();
  const setCredential = target.setCredential?.('replacement-secret');
  assert.ok(setCredential);
  await heldMutation.started;
  profiles.remove();
  profiles.recreate('incarnation-b');
  heldMutation.release();

  await assert.rejects(setCredential, /profile is no longer current/u);
  assert.equal(credentials.values.has('office\0incarnation-a\0terminal-client'), false);
  assert.equal(credentials.values.has('office\0incarnation-b\0terminal-client'), false);
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'target_mismatch' });
  await target.closePublication?.();
});

test('remote TUI publication retires across a coalesced same-target recreation', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness();
  const connection = connectionHarness('connection-1');
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async () => connection.connection,
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await waitFor(() => latest().kind === 'connected', 'provider companion to connect');

  const heldValidation = profiles.holdNextValidation();
  profiles.invalidate();
  await heldValidation.started;
  profiles.remove();
  profiles.recreate('incarnation-b');
  heldValidation.release();

  await waitFor(() => {
    const current = latest();
    return current.kind === 'unavailable' && current.reason === 'target_mismatch';
  }, 'later profile invalidation to retire provider companion');
  assert.equal(connection.closes, 1);
  await target.closePublication?.();
});

test('remote TUI publication close waits for concurrent profile retirement cleanup', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness(DIRECT_PROFILE);
  const connectionCloseStarted = deferred();
  const allowConnectionClose = deferred();
  const peerCloseStarted = deferred();
  const allowPeerClose = deferred();
  let peerCloses = 0;
  const connection = connectionHarness('connection-1', async () => {
    connectionCloseStarted.resolve();
    await allowConnectionClose.promise;
  });
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: DIRECT_PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async () => connection.connection,
      createPeerClient: () =>
        ({
          close: async () => {
            peerCloses += 1;
            peerCloseStarted.resolve();
            await allowPeerClose.promise;
          },
        }) as RuntimeHostPeerClient,
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await waitFor(() => latest().kind === 'connected', 'provider companion to connect');

  profiles.remove();
  await connectionCloseStarted.promise;
  let closeSettled = false;
  const close = target.closePublication?.().then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  allowConnectionClose.resolve();
  await peerCloseStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  allowPeerClose.resolve();
  await close;
  assert.equal(closeSettled, true);
  assert.equal(connection.closes, 1);
  assert.equal(peerCloses, 1);
});

test('remote TUI publication closes its direct peer after a permanent reconnect failure', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness(DIRECT_PROFILE);
  const initial = connectionHarness('connection-1');
  let peerCloses = 0;
  let fatal: ((error: Error) => void) | undefined;
  const target = createRemoteTuiMcpPublicationTarget(
    {
      clientDataRoot: '/client-data',
      profile: DIRECT_PROFILE,
      profileIncarnationId: PROFILE_INCARNATION_ID,
      ownerClientInstanceId: 'terminal-client',
    },
    {
      credentials: credentials.store,
      loadClientInstanceId: async () => 'provider-client',
      connectProfile: async () => initial.connection,
      createPeerClient: () =>
        ({ close: async () => void (peerCloses += 1) }) as RuntimeHostPeerClient,
      createReconnectingConnection: async (input) => {
        fatal = input.onFatalError;
        return reconnectingConnection(initial.connection);
      },
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await waitFor(() => latest().kind === 'connected', 'direct provider companion to connect');

  fatal?.(new RuntimeHostProfileConnectionError('credential_rejected', 'revoked'));

  await waitFor(() => peerCloses === 1, 'direct peer endpoint to close');
  assert.deepEqual(latest(), { kind: 'unavailable', reason: 'credential_rejected' });
  await target.closePublication?.();
  assert.equal(peerCloses, 1);
});

async function availability(target: ReturnType<typeof createRemoteTuiMcpPublicationTarget>) {
  let current: Parameters<Parameters<typeof target.subscribeConnectionAvailability>[0]>[0] = {
    kind: 'unavailable',
  };
  target.subscribeConnectionAvailability((next) => {
    current = next;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return () => current;
}

function credentialHarness(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set('office\0incarnation-a\0terminal-client', initial);
  const key = (target: RuntimeHostRemoteProfileIncarnation, ownerClientInstanceId: string) =>
    `${target.profile.id}\0${target.profileIncarnationId}\0${ownerClientInstanceId}`;
  const store: RuntimeHostCapabilityProviderCredentialStore = {
    get: async (target, ownerClientInstanceId) =>
      values.get(key(target, ownerClientInstanceId)) ?? null,
    set: async (target, ownerClientInstanceId, credential) => {
      values.set(key(target, ownerClientInstanceId), credential);
    },
    delete: async (target, ownerClientInstanceId) => {
      values.delete(key(target, ownerClientInstanceId));
    },
  };
  return { store, values };
}

function profileDeps(profile: RemoteRuntimeHostProfile = PROFILE) {
  const profiles = profileHarness(profile);
  return { profiles: profiles.catalog, subscribeProfileChanges: profiles.subscribe };
}

function profileHarness(initial: RemoteRuntimeHostProfile = PROFILE) {
  let current:
    | { readonly profile: RemoteRuntimeHostProfile; readonly profileIncarnationId: string }
    | undefined = { profile: initial, profileIncarnationId: PROFILE_INCARNATION_ID };
  const listeners = new Set<(error?: Error) => void>();
  let heldValidation:
    | {
        readonly started: ReturnType<typeof deferred>;
        readonly release: ReturnType<typeof deferred>;
      }
    | undefined;
  let heldMutation:
    | {
        readonly started: ReturnType<typeof deferred>;
        readonly release: ReturnType<typeof deferred>;
      }
    | undefined;
  const catalog: Pick<
    RuntimeHostProfileCatalog,
    'isRemoteProfileIncarnationCurrent' | 'mutateRemoteProfileIfCurrent'
  > = {
    isRemoteProfileIncarnationCurrent: async (expected) => {
      const snapshot = current;
      const held = heldValidation;
      heldValidation = undefined;
      if (held) {
        held.started.resolve();
        await held.release.promise;
      }
      return (
        snapshot !== undefined &&
        snapshot.profileIncarnationId === expected.profileIncarnationId &&
        sameRemoteRuntimeHostProfileTarget(snapshot.profile, expected.profile)
      );
    },
    mutateRemoteProfileIfCurrent: async (expected, mutation) => {
      const held = heldMutation;
      heldMutation = undefined;
      if (held) {
        held.started.resolve();
        await held.release.promise;
      }
      if (
        !current ||
        current.profileIncarnationId !== expected.profileIncarnationId ||
        !sameRemoteRuntimeHostProfileTarget(current.profile, expected.profile)
      ) {
        return false;
      }
      await mutation(current.profile);
      return true;
    },
  };
  const invalidate = () => {
    for (const listener of listeners) listener();
  };
  return {
    catalog,
    subscribe: (listener: (error?: Error) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate,
    remove: () => {
      current = undefined;
      invalidate();
    },
    recreate: (profileIncarnationId: string) => {
      current = { profile: initial, profileIncarnationId };
      invalidate();
    },
    holdNextValidation: () => {
      const started = deferred();
      const release = deferred();
      heldValidation = { started, release };
      return { started: started.promise, release: release.resolve };
    },
    holdNextMutation: () => {
      const started = deferred();
      const release = deferred();
      heldMutation = { started, release };
      return { started: started.promise, release: release.resolve };
    },
  };
}

interface ConnectionHarness {
  connection: RuntimeHostConnection;
  unregisters: number;
  closes: number;
}

function connectionHarness(
  connectionId: string,
  beforeClose: () => Promise<void> = async () => undefined,
): ConnectionHarness {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const harness: ConnectionHarness = {
    connection: undefined as unknown as RuntimeHostConnection,
    unregisters: 0,
    closes: 0,
  };
  harness.connection = {
    rootId: PROFILE.rootId,
    hostEpoch: 'host-epoch',
    connectionId,
    selectedProtocol: 0,
    compositionId: 'maka.interactive',
    compositionRevision: 'composition-revision',
    closed,
    replaceClientCapabilities: async () => ({ registrationIds: [] }),
    unregisterClientCapabilities: async () => {
      harness.unregisters += 1;
      return { registrationIds: [] };
    },
    subscribeConfigurationChanges: () => () => undefined,
    subscribeProjectCatalogChanges: () => () => undefined,
    subscribeSessionCatalogChanges: () => () => undefined,
    subscribeScheduledTaskChanges: () => () => undefined,
    close: async () => {
      harness.closes += 1;
      await beforeClose();
      resolveClosed();
    },
  } as unknown as RuntimeHostConnection;
  return harness;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function reconnectingConnection(connection: RuntimeHostConnection) {
  return {
    ...connection,
    reconnecting: true as const,
    subscribeConnectionAvailability: (
      listener: (availability: {
        kind: 'connected';
        hostEpoch: string;
        connectionId: string;
      }) => void,
    ) => {
      listener({
        kind: 'connected',
        hostEpoch: connection.hostEpoch,
        connectionId: connection.connectionId,
      });
      return () => undefined;
    },
  };
}
