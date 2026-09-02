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
import { createRemoteTuiMcpPublicationTarget as createProductionRemoteTuiMcpPublicationTarget } from '../tui-mcp-remote-publication.js';
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

test('remote TUI publication fails closed while the same provider lifetime is active', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness();
  const leases = publicationLeaseHarness();
  const firstConnection = connectionHarness('connection-1');
  const secondConnection = connectionHarness('connection-2');
  let secondAttempts = 0;
  const input = {
    clientDataRoot: '/client-data',
    profile: PROFILE,
    profileIncarnationId: PROFILE_INCARNATION_ID,
    ownerClientInstanceId: 'terminal-client',
  } as const;
  const first = createRemoteTuiMcpPublicationTarget(input, {
    credentials: credentials.store,
    loadClientInstanceId: async () => 'shared-provider-client',
    connectProfile: async () => firstConnection.connection,
    acquirePublicationLease: leases.acquire,
    profiles: profiles.catalog,
    subscribeProfileChanges: profiles.subscribe,
  });
  const firstLatest = await availability(first);
  await waitFor(() => firstLatest().kind === 'connected', 'first provider companion to connect');

  const second = createRemoteTuiMcpPublicationTarget(input, {
    credentials: credentials.store,
    loadClientInstanceId: async () => 'shared-provider-client',
    connectProfile: async () => {
      secondAttempts += 1;
      return secondConnection.connection;
    },
    acquirePublicationLease: leases.acquire,
    profiles: profiles.catalog,
    subscribeProfileChanges: profiles.subscribe,
  });
  const secondLatest = await availability(second);
  await waitFor(() => {
    const current = secondLatest();
    return current.kind === 'unavailable' && current.reason === 'provider_conflict';
  }, 'competing provider companion to fail closed');
  assert.equal(secondAttempts, 0);
  assert.equal(leases.active.size, 1);

  await first.replaceClientCapabilities({ offers: () => [] });
  assert.equal(firstConnection.replacements, 1);
  await first.closePublication?.();
  assert.equal(leases.active.size, 0);

  const successor = createRemoteTuiMcpPublicationTarget(input, {
    credentials: credentials.store,
    loadClientInstanceId: async () => 'shared-provider-client',
    connectProfile: async () => secondConnection.connection,
    acquirePublicationLease: leases.acquire,
    profiles: profiles.catalog,
    subscribeProfileChanges: profiles.subscribe,
  });
  const successorLatest = await availability(successor);
  await waitFor(
    () => successorLatest().kind === 'connected',
    'successor provider companion to connect',
  );
  await successor.closePublication?.();
  await second.closePublication?.();
});

test('remote TUI publication cannot bypass a failed lifetime lease', async () => {
  const credentials = credentialHarness();
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
      acquirePublicationLease: async () => {
        throw new Error('lease storage unavailable');
      },
      connectProfile: async () => {
        attempts += 1;
        return connectionHarness('unexpected').connection;
      },
    },
  );
  const latest = await availability(target);
  await waitFor(() => {
    const current = latest();
    return current.kind === 'unavailable' && current.reason === 'host_unavailable';
  }, 'lease failure to retire provider companion');

  const setCredential = target.setCredential?.('provider-secret');
  assert.ok(setCredential);
  await assert.rejects(setCredential, /closed/u);
  assert.equal(attempts, 0);
  assert.equal(credentials.values.size, 0);
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

test('remote TUI publication revalidates its profile before publishing an initial connection', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness();
  const connection = connectionHarness('connection-1');
  const wrapperStarted = deferred();
  const allowWrapper = deferred();
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
      createReconnectingConnection: async () => {
        wrapperStarted.resolve();
        await allowWrapper.promise;
        return reconnectingConnection(connection.connection);
      },
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await wrapperStarted.promise;

  profiles.remove();
  profiles.recreate('incarnation-b');
  allowWrapper.resolve();

  await waitFor(() => {
    const current = latest();
    return current.kind === 'unavailable' && current.reason === 'target_mismatch';
  }, 'recreated profile to reject the uninstalled connection');
  assert.equal(connection.closes, 1);
  await target.closePublication?.();
});

test('remote TUI publication revalidates every reconnect result', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness();
  const initial = connectionHarness('connection-1');
  const replacement = connectionHarness('connection-2');
  const reconnectStarted = deferred();
  const allowReconnect = deferred();
  let attempts = 0;
  let reconnect: ((signal: AbortSignal) => Promise<RuntimeHostConnection>) | undefined;
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
      connectProfile: async () => {
        attempts += 1;
        if (attempts === 1) return initial.connection;
        reconnectStarted.resolve();
        await allowReconnect.promise;
        return replacement.connection;
      },
      createReconnectingConnection: async (input) => {
        reconnect = input.connect;
        return reconnectingConnection(initial.connection);
      },
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await waitFor(() => latest().kind === 'connected', 'provider companion to connect');
  assert.ok(reconnect);

  const attempt = reconnect(new AbortController().signal);
  await reconnectStarted.promise;
  profiles.remove();
  profiles.recreate('incarnation-b');
  allowReconnect.resolve();

  await assert.rejects(
    attempt,
    (error: unknown) =>
      error instanceof RuntimeHostProfileConnectionError && error.reason === 'target_mismatch',
  );
  assert.equal(replacement.closes, 1);
  await target.closePublication?.();
});

test('remote TUI publication reconnects through current direct-peer routes', async () => {
  const credentials = credentialHarness('provider-secret');
  const profiles = profileHarness(DIRECT_PROFILE);
  const connectedProfiles: RemoteRuntimeHostProfile[] = [];
  const initial = connectionHarness('connection-1');
  const replacement = connectionHarness('connection-2');
  let reconnect: ((signal: AbortSignal) => Promise<RuntimeHostConnection>) | undefined;
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
      connectProfile: async (input) => {
        assert.equal(input.profile.kind, 'remote');
        if (input.profile.kind !== 'remote') throw new Error('expected a remote profile');
        connectedProfiles.push(input.profile);
        return connectedProfiles.length === 1 ? initial.connection : replacement.connection;
      },
      createPeerClient: () => ({ close: async () => undefined }) as RuntimeHostPeerClient,
      createReconnectingConnection: async (input) => {
        reconnect = input.connect;
        return reconnectingConnection(initial.connection);
      },
      profiles: profiles.catalog,
      subscribeProfileChanges: profiles.subscribe,
    },
  );
  const latest = await availability(target);
  await waitFor(() => latest().kind === 'connected', 'direct provider companion to connect');
  assert.ok(reconnect);

  const moved: RemoteRuntimeHostProfile = {
    ...DIRECT_PROFILE,
    transport: {
      kind: 'libp2p-direct',
      peerId: 'peer-a',
      routeHints: ['/ip6/2001:db8::10/udp/4001/quic-v1'],
      coordinationRelays: ['/dns4/relay.example.com/tcp/443/wss/p2p/relay-a'],
    },
  };
  profiles.update(moved);
  await reconnect(new AbortController().signal);

  assert.deepEqual(connectedProfiles, [DIRECT_PROFILE, moved]);
  await target.closePublication?.();
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

test('remote TUI publication cannot register capabilities after profile recreation', async () => {
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

  const heldMutation = profiles.holdNextMutation();
  const replace = target.replaceClientCapabilities({ offers: () => [] });
  await heldMutation.started;
  profiles.remove();
  profiles.recreate('incarnation-b');
  heldMutation.release();

  await assert.rejects(
    replace,
    (error: unknown) =>
      error instanceof RuntimeHostProfileConnectionError && error.reason === 'target_mismatch',
  );
  assert.equal(connection.replacements, 0);
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

function createRemoteTuiMcpPublicationTarget(
  input: Parameters<typeof createProductionRemoteTuiMcpPublicationTarget>[0],
  overrides: NonNullable<Parameters<typeof createProductionRemoteTuiMcpPublicationTarget>[1]> = {},
) {
  return createProductionRemoteTuiMcpPublicationTarget(input, {
    acquirePublicationLease: async () => ({ close: async () => undefined }),
    ...overrides,
  });
}

function publicationLeaseHarness() {
  const active = new Set<string>();
  return {
    active,
    acquire: async (path: string) => {
      if (active.has(path)) return undefined;
      active.add(path);
      let closed = false;
      return {
        close: async () => {
          if (closed) return;
          closed = true;
          active.delete(path);
        },
      };
    },
  };
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
    'readRemoteProfileIfCurrent' | 'mutateRemoteProfileIfCurrent'
  > = {
    readRemoteProfileIfCurrent: async (expected) => {
      const snapshot = current;
      const held = heldValidation;
      heldValidation = undefined;
      if (held) {
        held.started.resolve();
        await held.release.promise;
      }
      return snapshot !== undefined &&
        snapshot.profileIncarnationId === expected.profileIncarnationId &&
        sameRemoteRuntimeHostProfileTarget(snapshot.profile, expected.profile)
        ? snapshot.profile
        : undefined;
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
    update: (profile: RemoteRuntimeHostProfile) => {
      assert.ok(current);
      current = { profile, profileIncarnationId: current.profileIncarnationId };
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
  replacements: number;
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
    replacements: 0,
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
    replaceClientCapabilities: async () => {
      harness.replacements += 1;
      return { registrationId: 'registration-a', revision: harness.replacements };
    },
    unregisterClientCapabilities: async () => {
      harness.unregisters += 1;
      return { registrationId: 'registration-a', revision: harness.unregisters };
    },
    subscribeConfigurationChanges: () => () => undefined,
    subscribeConnectionCatalogChanges: () => () => undefined,
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
