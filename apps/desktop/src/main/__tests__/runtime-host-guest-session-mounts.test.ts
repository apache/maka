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
  RuntimeHostPermanentReconnectError,
  RuntimeHostProfileConnectionError,
  type ResolvedRuntimeHostProfile,
} from '@maka/runtime-host/client';
import {
  encodeCollaborationInvitationCode,
  type HostPeerEndpoint,
  type SharedSessionCatalogProjection,
} from '@maka/runtime-host/protocol';
import { encodeDesktopCollaborationInvitation } from '../runtime-host-collaboration-invitation.js';
import {
  createDesktopGuestSessionMountService,
  createGuestSessionMountStore,
  type GuestSessionMount,
  type GuestSessionMountStore,
  registerDesktopGuestSessionMountIpc,
} from '../runtime-host-guest-session-mounts.js';
import { RuntimeHostPairingFinalizationInterruptedError } from '../runtime-host-desktop-manager.js';

const ROOT_ID = 'a'.repeat(64);

test('retains a successful Guest mount and rehydrates the same authority after restart', async () => {
  const store = serializedStore();
  const activated: string[] = [];
  const first = service(store, {
    mount: async (target) => {
      activated.push(`${target.profile.id}:${target.credential}`);
    },
  });

  const result = await first.importInvitation(invitation('guest-one'), false, 'import-one');
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') return;
  await first.close();

  let second: ReturnType<typeof service>;
  const rehydrated = new Promise<string>((resolve) => {
    second = service(store, {
      mount: async (target) => resolve(`${target.profile.id}:${target.credential}`),
    });
    void second.start();
  });
  assert.equal(await rehydrated, `${result.mountId}:guest-one`);
  assert.deepEqual(activated, [`${result.mountId}:guest-one`]);
  assert.deepEqual((await second!.list())[0]?.session, sharedSession());
  await second!.close();
});

test('keeps live Guest state in memory without persisting ephemeral run identities', async () => {
  const store = serializedStore();
  const live = {
    ...sharedSession(),
    liveRunState: { schemaVersion: 1 as const, runningTurnIds: ['turn-live'] },
  };
  const mounts = service(store, { getSharedSession: async () => live });

  assert.equal(
    (await mounts.importInvitation(invitation('guest-live'), false, 'live')).kind,
    'connected',
  );
  assert.deepEqual((await mounts.list())[0]?.session?.liveRunState, live.liveRunState);
  assert.equal((await store.read())[0]?.session?.liveRunState, undefined);
  await mounts.close();
});

test('collapses fresh credentials for the same authenticated shared Session', async () => {
  const store = memoryStore();
  const unmounted: string[] = [];
  const mounts = service(store, {
    unmount: async (mountId) => {
      unmounted.push(mountId);
    },
  });

  const first = await mounts.importInvitation(invitation('guest-first'), false, 'first');
  const second = await mounts.importInvitation(invitation('guest-second'), false, 'second');
  assert.equal(first.kind, 'connected');
  assert.equal(second.kind, 'connected');
  if (first.kind !== 'connected' || second.kind !== 'connected') return;

  const retained = await mounts.list();
  assert.deepEqual(
    retained.map(({ mountId }) => mountId),
    [second.mountId],
  );
  assert.deepEqual(
    (await store.read()).map(({ mountId }) => mountId),
    [second.mountId],
  );
  assert.deepEqual(unmounted, [first.mountId]);
  await mounts.close();
});

test('unmounts a superseded Guest when its replacement is rejected during projection commit', async () => {
  const superseded = {
    ...retainedMount('shared-superseded'),
    session: sharedSession(),
  };
  let durable: readonly GuestSessionMount[] = [superseded];
  let replacementId: string | undefined;
  let markProjectionWrite!: () => void;
  let releaseProjectionWrite!: () => void;
  const projectionWrite = new Promise<void>((resolve) => {
    markProjectionWrite = resolve;
  });
  const projectionWriteReleased = new Promise<void>((resolve) => {
    releaseProjectionWrite = resolve;
  });
  const store: GuestSessionMountStore = {
    read: async () => durable,
    write: async (next) => {
      const replacement = next.find((mount) => mount.mountId !== superseded.mountId);
      if (next.length === 1 && replacement?.session) {
        replacementId = replacement.mountId;
        markProjectionWrite();
        await projectionWriteReleased;
      }
      durable = next;
    },
  };
  const unmounted: string[] = [];
  const mounts = service(store, {
    finalizeAccess: async (_mountId, _signal, onAccessActivated) => {
      onAccessActivated?.();
      return 'ready';
    },
    unmount: async (mountId) => {
      unmounted.push(mountId);
    },
  });

  const importing = mounts.importInvitation(invitation('guest-replacement'), false, 'replace');
  await projectionWrite;
  assert.ok(replacementId);
  const rejecting = mounts.connectionChanged(
    replacementId,
    new RuntimeHostProfileConnectionError(
      'credential_rejected',
      'Shared Session access was revoked',
    ),
  );
  releaseProjectionWrite();

  assert.equal((await importing).kind, 'error');
  await rejecting;
  assert.deepEqual(durable, []);
  assert.deepEqual(new Set(unmounted), new Set([superseded.mountId, replacementId]));
  await mounts.close();
});

test('reports activated Guest access as recovering while reauthentication continues', async () => {
  const progress: string[] = [];
  const mounts = service(memoryStore(), {
    mount: async (_target, _signal, onConnectionPhase) => {
      onConnectionPhase?.('discovering');
      onConnectionPhase?.('connecting');
      onConnectionPhase?.('authenticating');
      onConnectionPhase?.('handshaking');
      onConnectionPhase?.('waiting_for_ready');
    },
    finalizeAccess: async (_mountId, _signal, onAccessActivated) => {
      onAccessActivated?.();
      return 'reconnecting';
    },
  });

  const result = await mounts.importInvitation(
    invitation('guest-progress'),
    false,
    'import-progress',
    (phase) => progress.push(phase),
  );

  assert.equal(result.kind, 'recovering');
  const visibleProgress = progress.filter((phase, index) => phase !== progress[index - 1]);
  assert.deepEqual(visibleProgress, [
    'validating_invitation',
    'discovering_host',
    'preparing_route',
    'connecting',
    'authenticating',
    'finalizing_access',
    'loading_session',
  ]);
  await mounts.close();
});

test('persists authenticated route rotation for reconnect and restart', async () => {
  const store = memoryStore();
  let observePeerEndpoint!: (endpoint: HostPeerEndpoint) => void;
  const first = service(store, {
    mount: async (target, _signal, _onConnectionPhase, onPeerEndpoint) => {
      assert.deepEqual(target.profile.kind === 'remote' ? target.profile.transport : undefined, {
        kind: 'libp2p-direct',
        reachability: guestPeerReachability(),
      });
      assert.ok(onPeerEndpoint);
      observePeerEndpoint = onPeerEndpoint;
    },
  });

  const imported = await first.importInvitation(peerInvitation('guest-routes'), false, 'routes');
  assert.equal(imported.kind, 'connected');
  const rotated = guestPeerReachability(
    2,
    ['/ip4/198.51.100.2/udp/42000/quic-v1'],
    ['/memory/fresh-relay'],
  );
  observePeerEndpoint(rotated);
  await first.close();

  let restarted!: ReturnType<typeof service>;
  const restartedTarget = new Promise<ResolvedRuntimeHostProfile>((resolve) => {
    restarted = service(store, { mount: async (target) => resolve(target) });
    void restarted.start();
  });
  const target = await restartedTarget;
  assert.deepEqual(target.profile.kind === 'remote' ? target.profile.transport : undefined, {
    kind: 'libp2p-direct',
    reachability: rotated,
  });
  await restarted.close();
});

test('retries authenticated route rotation after transient persistence failure', async () => {
  let durable: readonly GuestSessionMount[] = [];
  let writesBlocked = false;
  const store: GuestSessionMountStore = {
    read: async () => durable,
    write: async (next) => {
      if (writesBlocked) throw new Error('credential store is locked');
      durable = next;
    },
  };
  let observePeerEndpoint!: (endpoint: HostPeerEndpoint) => void;
  let markFailure!: () => void;
  const failureReported = new Promise<void>((resolve) => {
    markFailure = resolve;
  });
  const first = service(store, {
    mount: async (_target, _signal, _onConnectionPhase, onPeerEndpoint) => {
      assert.ok(onPeerEndpoint);
      observePeerEndpoint = onPeerEndpoint;
    },
    onError: () => markFailure(),
  });
  const imported = await first.importInvitation(peerInvitation('guest-routes'), false, 'routes');
  assert.equal(imported.kind, 'connected');

  const rotated = guestPeerReachability(
    2,
    ['/ip4/198.51.100.2/udp/42000/quic-v1'],
    ['/memory/fresh-relay'],
  );
  writesBlocked = true;
  observePeerEndpoint(rotated);
  await failureReported;

  writesBlocked = false;
  await first.close();

  let restarted!: ReturnType<typeof service>;
  const restartedTarget = new Promise<ResolvedRuntimeHostProfile>((resolve) => {
    restarted = service(store, { mount: async (target) => resolve(target) });
    void restarted.start();
  });
  const target = await restartedTarget;
  assert.deepEqual(target.profile.kind === 'remote' ? target.profile.transport : undefined, {
    kind: 'libp2p-direct',
    reachability: rotated,
  });
  await restarted.close();
});

test('derives retained mount readiness from the Runtime Host connection owner', async () => {
  const store = memoryStore();
  await store.write([{ ...retainedMount('shared-readiness'), session: sharedSession() }]);
  let connectionReadiness: 'ready' | 'reconnecting' | 'unavailable' = 'reconnecting';
  const mounts = service(store, {
    inspect: () => ({ readiness: connectionReadiness }),
  });

  assert.equal((await mounts.list())[0]?.readiness, 'reconnecting');
  connectionReadiness = 'ready';
  assert.equal((await mounts.list())[0]?.readiness, 'ready');
  connectionReadiness = 'unavailable';
  assert.equal((await mounts.list())[0]?.readiness, 'unavailable');
  await mounts.close();
});

test('removes failed activation desire instead of creating recoverable profile state', async () => {
  const store = memoryStore();
  const unmounted: string[] = [];
  const mounts = service(store, {
    mount: async () => {
      throw Object.assign(new Error('route missing'), {
        code: 'peer_reachability_needs_repair',
      });
    },
    unmount: async (mountId) => {
      unmounted.push(mountId);
    },
  });

  const result = await mounts.importInvitation(invitation('guest-two'), false, 'import-two');
  assert.deepEqual(result.kind === 'error' ? result.reason : result.kind, 'peer_path_unavailable');
  assert.deepEqual(await store.read(), []);
  assert.equal(unmounted.length, 1);
});

test('does not retry a startup mount whose reachability recovery is exhausted', async () => {
  const store = memoryStore();
  await store.write([{ ...retainedMount('shared-needs-repair'), session: sharedSession() }]);
  let attempts = 0;
  let waits = 0;
  let reportFailure!: () => void;
  let reportUnavailable!: () => void;
  const failureReported = new Promise<void>((resolve) => {
    reportFailure = resolve;
  });
  const unavailableReported = new Promise<void>((resolve) => {
    reportUnavailable = resolve;
  });
  let mounts!: ReturnType<typeof service>;
  mounts = service(store, {
    mount: async () => {
      attempts += 1;
      throw new RuntimeHostPermanentReconnectError('reachability recovery exhausted');
    },
    wait: async () => {
      waits += 1;
    },
    onError: () => reportFailure(),
    onMountsChanged: () => {
      void mounts.list().then(([mount]) => {
        if (mount?.readiness === 'unavailable') reportUnavailable();
      });
    },
    inspect: () => ({ readiness: 'unavailable' }),
  });

  await mounts.start();
  await failureReported;
  await unavailableReported;
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
  assert.equal((await mounts.list())[0]?.readiness, 'unavailable');
  assert.deepEqual((await store.read())[0]?.session, sharedSession());
  await mounts.close();
});

test('retires a retained Session projection only after explicit access rejection', async () => {
  const store = memoryStore();
  const retained = {
    ...retainedMount('shared-revoked'),
    session: sharedSession(),
  };
  await store.write([retained]);
  let mountChanges = 0;
  const mounts = service(store, {
    onMountsChanged: () => {
      mountChanges += 1;
    },
  });

  await mounts.connectionChanged(
    retained.mountId,
    new RuntimeHostProfileConnectionError(
      'credential_rejected',
      'Shared Session access was revoked',
    ),
  );

  const [visible] = await mounts.list();
  assert.equal(visible?.readiness, 'unavailable');
  assert.equal(visible?.session, undefined);
  assert.equal((await store.read())[0]?.session, undefined);
  assert.equal(mountChanges, 1);
  await mounts.close();
});

test('fails closed when a revoked Session projection cannot be persisted immediately', async () => {
  const retained = {
    ...retainedMount('shared-write-locked'),
    session: sharedSession(),
  };
  let durable: readonly GuestSessionMount[] = [retained];
  let writesBlocked = true;
  const store: GuestSessionMountStore = {
    read: async () => durable,
    write: async (next) => {
      if (writesBlocked) throw new Error('credential store is locked');
      durable = next;
    },
  };
  let mountChanges = 0;
  const mounts = service(store, {
    onMountsChanged: () => {
      mountChanges += 1;
    },
  });

  await assert.rejects(
    mounts.connectionChanged(
      retained.mountId,
      new RuntimeHostProfileConnectionError(
        'credential_rejected',
        'Shared Session access was revoked',
      ),
    ),
    /credential store is locked/u,
  );

  const [visible] = await mounts.list();
  assert.equal(visible?.readiness, 'unavailable');
  assert.equal(visible?.session, undefined);
  assert.ok(durable[0]?.session);
  assert.equal(mountChanges, 1);

  writesBlocked = false;
  await mounts.close();
  assert.equal(durable[0]?.session, undefined);
});

test('publishes a refreshed Guest projection while persistence is unavailable', async () => {
  let durable: readonly GuestSessionMount[] = [];
  let writesBlocked = false;
  let markPersisted!: () => void;
  const persisted = new Promise<void>((resolve) => {
    markPersisted = resolve;
  });
  const store: GuestSessionMountStore = {
    read: async () => durable,
    write: async (next) => {
      if (writesBlocked) throw new Error('credential store is locked');
      durable = next;
      if (durable[0]?.session?.revision === 2) markPersisted();
    },
  };
  let markRetryScheduled!: () => void;
  let releaseRetry!: () => void;
  const retryScheduled = new Promise<void>((resolve) => {
    markRetryScheduled = resolve;
  });
  const retryReleased = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let catalogChanged!: () => void;
  let projection = sharedSession();
  let mountChanges = 0;
  const errors: Error[] = [];
  let markErrorReported!: () => void;
  const errorReported = new Promise<void>((resolve) => {
    markErrorReported = resolve;
  });
  let markRefreshed: (() => void) | undefined;
  const mounts = service(store, {
    mount: async (_target, _signal, _onConnectionPhase, _onPeerEndpoint, onChanged) => {
      assert.ok(onChanged);
      catalogChanged = onChanged;
    },
    getSharedSession: async () => projection,
    onMountsChanged: () => {
      mountChanges += 1;
      markRefreshed?.();
    },
    wait: async () => {
      markRetryScheduled();
      await retryReleased;
    },
    onError: (error) => {
      errors.push(error);
      markErrorReported();
    },
  });
  const joined = await mounts.importInvitation(invitation('guest-refresh'), false, 'refresh');
  assert.equal(joined.kind, 'connected');
  if (joined.kind !== 'connected') return;
  mountChanges = 0;

  projection = {
    ...projection,
    revision: 2,
    activityAt: 3,
    name: 'Fresh task',
  };
  writesBlocked = true;
  const refreshed = new Promise<void>((resolve) => {
    markRefreshed = resolve;
  });
  catalogChanged();
  assert.equal(mountChanges, 0);
  await refreshed;

  const [visible] = await mounts.list();
  assert.equal(visible?.session?.revision, 2);
  assert.equal(durable[0]?.session?.revision, 1);
  await errorReported;
  assert.equal(errors.length, 1);
  assert.equal(mountChanges, 1);

  await retryScheduled;
  writesBlocked = false;
  releaseRetry();
  await persisted;
  assert.equal(durable[0]?.session?.revision, 2);
  await mounts.close();
});

test('serves a published Guest projection while its durable write is pending', async () => {
  let durable: readonly GuestSessionMount[] = [];
  let projection = sharedSession();
  let blockFreshProjection = false;
  let markWriteStarted!: () => void;
  let releaseWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve;
  });
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const store: GuestSessionMountStore = {
    read: async () => durable,
    write: async (next) => {
      if (blockFreshProjection && next[0]?.session?.revision === 2) {
        markWriteStarted();
        await writeReleased;
      }
      durable = next;
    },
  };
  const mounts = service(store, {
    getSharedSession: async () => projection,
  });
  const joined = await mounts.importInvitation(invitation('guest-pending'), false, 'pending');
  assert.equal(joined.kind, 'connected');
  if (joined.kind !== 'connected') return;

  projection = { ...projection, revision: 2, activityAt: 3, name: 'Fresh task' };
  blockFreshProjection = true;
  const refreshing = mounts.connectionChanged(joined.mountId);
  await writeStarted;

  assert.equal((await mounts.list())[0]?.session?.revision, 2);
  assert.equal(durable[0]?.session?.revision, 1);

  releaseWrite();
  await refreshing;
  assert.equal(durable[0]?.session?.revision, 2);
  await mounts.close();
});

test('cancels an admitted Guest projection refresh during shutdown', async () => {
  const store = memoryStore();
  const retained = { ...retainedMount('shared-close-refresh'), session: sharedSession() };
  await store.write([retained]);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const mounts = service(store, {
    getSharedSession: async () => {
      markReadStarted();
      return new Promise<never>(() => undefined);
    },
  });

  const refreshOutcome = mounts.connectionChanged(retained.mountId).catch((error: unknown) => error);
  await readStarted;
  await settlePromptly(mounts.close());

  assert.match(String(await refreshOutcome), /closed/);
  assert.deepEqual((await store.read())[0]?.session, sharedSession());
});

test('retains activated Guest access when shutdown cancels initial projection hydration', async () => {
  const store = memoryStore();
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const mounts = service(store, {
    getSharedSession: async () => {
      markReadStarted();
      return new Promise<never>(() => undefined);
    },
  });

  const importing = mounts.importInvitation(invitation('guest-close'), false, 'close');
  await readStarted;
  const [result] = await Promise.all([
    settlePromptly(importing),
    settlePromptly(mounts.close()),
  ]);

  assert.equal(result.kind, 'recovering');
  assert.equal((await store.read()).length, 1);
});

test('does not lose a catalog invalidation that races Guest activation', async () => {
  const store = memoryStore();
  let catalogChanged!: () => void;
  let releaseInitialRead!: () => void;
  let markInitialRead!: () => void;
  let markProjectionCleared!: () => void;
  const initialRead = new Promise<void>((resolve) => {
    markInitialRead = resolve;
  });
  const initialReadReleased = new Promise<void>((resolve) => {
    releaseInitialRead = resolve;
  });
  const projectionCleared = new Promise<void>((resolve) => {
    markProjectionCleared = resolve;
  });
  let reads = 0;
  const mounts = service(store, {
    mount: async (_target, _signal, _onConnectionPhase, _onPeerEndpoint, onChanged) => {
      assert.ok(onChanged);
      catalogChanged = onChanged;
    },
    getSharedSession: async () => {
      reads += 1;
      if (reads === 1) {
        markInitialRead();
        await initialReadReleased;
        return sharedSession();
      }
      return null;
    },
    inspect: () => ({ readiness: 'ready' }),
    onMountsChanged: () => {
      void mounts.list().then(([mount]) => {
        if (reads >= 2 && mount && mount.session === undefined) markProjectionCleared();
      });
    },
  });

  const importing = mounts.importInvitation(invitation('guest-removed'), false, 'removed');
  await initialRead;
  catalogChanged();
  releaseInitialRead();
  assert.equal((await importing).kind, 'connected');
  await projectionCleared;

  const [visible] = await mounts.list();
  assert.equal(visible?.readiness, 'unavailable');
  assert.equal(visible?.session, undefined);
  assert.equal((await store.read())[0]?.session, undefined);
  assert.equal(reads, 2);
  await mounts.close();
});

test('settles admitted finalization before committing unmount desire', async () => {
  const store = memoryStore();
  let started!: () => void;
  let finish!: () => void;
  const finalizing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finalized = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mounts = service(store, {
    finalizeAccess: async () => {
      started();
      await finalized;
      return 'ready';
    },
    unmount: async () => {
      assert.deepEqual(await store.read(), []);
      throw new Error('connection shutdown failed');
    },
  });
  const importing = mounts.importInvitation(invitation('guest-three'), false, 'import-three');
  await finalizing;
  const [retained] = await store.read();
  assert.ok(retained);
  const removing = mounts.remove(retained.mountId);
  await Promise.resolve();
  assert.equal((await store.read()).length, 1);
  finish();
  const result = await importing;
  assert.equal(result.kind, 'connected');
  await removing;
  assert.deepEqual(await store.read(), []);
});

test('removal fences a connecting startup mount before credential finalization', async () => {
  const retained = retainedMount('shared-connecting');
  let stored: readonly GuestSessionMount[] = [retained];
  let releaseWrite!: () => void;
  let releaseMount!: () => void;
  let markConnecting!: () => void;
  let markDeleting!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const mountReleased = new Promise<void>((resolve) => {
    releaseMount = resolve;
  });
  const connecting = new Promise<void>((resolve) => {
    markConnecting = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    markDeleting = resolve;
  });
  const store: GuestSessionMountStore = {
    read: async () => stored,
    write: async (next) => {
      markDeleting();
      await writeReleased;
      stored = next;
    },
  };
  let finalizations = 0;
  const mounts = service(store, {
    mount: async () => {
      markConnecting();
      await mountReleased;
    },
    finalizeAccess: async () => {
      finalizations += 1;
      return 'ready';
    },
  });

  await mounts.start();
  await connecting;
  const removing = mounts.remove(retained.mountId);
  await deleting;
  releaseMount();
  releaseWrite();
  await removing;
  assert.equal(finalizations, 0);
  assert.deepEqual(await store.read(), []);
  await mounts.close();
});

test('removal settles one admitted startup finalization without waiting through retries', async () => {
  const retained = retainedMount('shared-finalizing');
  const store = memoryStore();
  await store.write([retained]);
  let markFinalizing!: () => void;
  let failFinalization!: (error: unknown) => void;
  const finalizing = new Promise<void>((resolve) => {
    markFinalizing = resolve;
  });
  const finalization = new Promise<void>((_resolve, reject) => {
    failFinalization = reject;
  });
  const mounts = service(store, {
    finalizeAccess: async () => {
      markFinalizing();
      await finalization;
      return 'ready';
    },
  });

  await mounts.start();
  await finalizing;
  const removing = mounts.remove(retained.mountId);
  failFinalization(new RuntimeHostPairingFinalizationInterruptedError());
  await removing;

  assert.deepEqual(await store.read(), []);
  await mounts.close();
});

test('settles admitted finalization before closing and retains the mount', async () => {
  const store = memoryStore();
  let started!: () => void;
  let finish!: () => void;
  const finalizing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finalized = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const mounts = service(store, {
    finalizeAccess: async () => {
      started();
      await finalized;
      return 'ready';
    },
  });

  const importing = mounts.importInvitation(invitation('guest-closing'), false, 'import-closing');
  await finalizing;
  assert.equal(mounts.cancelImport('import-closing'), 'settling');
  let closed = false;
  const closing = mounts.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.deepEqual(await store.read().then((retained) => retained.length), 1);
  finish();
  await closing;

  assert.equal((await importing).kind, 'connected');
  assert.equal((await store.read()).length, 1);
});

test('does not enter startup retry backoff after closing during finalization', async () => {
  const store = memoryStore();
  await store.write([retainedMount('shared-closing-startup')]);
  let markFinalizing!: () => void;
  let finishFinalizing!: () => void;
  const finalizing = new Promise<void>((resolve) => {
    markFinalizing = resolve;
  });
  const finalizationReleased = new Promise<void>((resolve) => {
    finishFinalizing = resolve;
  });
  let waits = 0;
  const mounts = service(store, {
    finalizeAccess: async () => {
      markFinalizing();
      await finalizationReleased;
      return 'reconnecting';
    },
    wait: async () => {
      waits += 1;
    },
  });

  await mounts.start();
  await finalizing;
  const closing = mounts.close();
  finishFinalizing();
  await closing;

  assert.equal(waits, 0);
});

test('retains and reconciles a mount when finalization outcome is unknown', async () => {
  const store = memoryStore();
  let attempts = 0;
  let resolveReconciled!: () => void;
  const reconciled = new Promise<void>((resolve) => {
    resolveReconciled = resolve;
  });
  const mounts = service(store, {
    finalizeAccess: async () => {
      attempts += 1;
      if (attempts === 1) throw new RuntimeHostPairingFinalizationInterruptedError();
      resolveReconciled();
      return 'ready';
    },
  });

  const result = await mounts.importInvitation(
    invitation('guest-unknown'),
    false,
    'import-unknown',
  );
  assert.equal(result.kind, 'recovering');
  assert.equal((await store.read()).length, 1);
  await reconciled;
  assert.equal(attempts, 2);
  assert.equal((await store.read()).length, 1);
  await mounts.close();
});

test('finishes a committed credential reconnect and records its Session projection', async () => {
  const store = memoryStore();
  let attempts = 0;
  let markAvailable!: () => void;
  const available = new Promise<void>((resolve) => {
    markAvailable = resolve;
  });
  const mounts = service(store, {
    finalizeAccess: async () => {
      attempts += 1;
      return attempts === 1 ? 'reconnecting' : 'ready';
    },
    onMountsChanged: () => {
      void store.read().then(([mount]) => {
        if (mount?.session) markAvailable();
      });
    },
    wait: async () => undefined,
  });

  const result = await mounts.importInvitation(invitation('guest-rotated'), false, 'rotated');
  assert.equal(result.kind, 'recovering');
  await available;

  assert.equal(attempts, 2);
  assert.equal((await mounts.list())[0]?.readiness, 'ready');
  assert.deepEqual((await store.read())[0]?.session, sharedSession());
  await mounts.close();
});

test('retains a finalized mount when its first Session projection read is interrupted', async () => {
  const store = memoryStore();
  let reads = 0;
  let markAvailable!: () => void;
  const available = new Promise<void>((resolve) => {
    markAvailable = resolve;
  });
  const mounts = service(store, {
    getSharedSession: async () => {
      reads += 1;
      if (reads === 1) throw new Error('connection changed after credential finalization');
      return sharedSession();
    },
    onMountsChanged: () => {
      void store.read().then(([mount]) => {
        if (mount?.session) markAvailable();
      });
    },
    wait: async () => undefined,
  });

  const result = await mounts.importInvitation(invitation('guest-finalized'), false, 'finalized');
  assert.equal(result.kind, 'recovering');
  assert.equal((await store.read()).length, 1);
  await available;

  assert.equal(reads, 2);
  assert.deepEqual((await store.read())[0]?.session, sharedSession());
  await mounts.close();
});

test('cancels an in-flight import and removes its durable mount desire', async () => {
  const store = memoryStore();
  let connecting!: () => void;
  const started = new Promise<void>((resolve) => {
    connecting = resolve;
  });
  const mounts = service(store, {
    mount: async (_target, signal) => {
      connecting();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });

  const importing = mounts.importInvitation(
    invitation('guest-cancelled'),
    false,
    'import-cancelled',
  );
  await started;
  assert.equal(mounts.cancelImport('import-cancelled'), 'cancelled');

  assert.equal((await importing).kind, 'error');
  assert.deepEqual(await store.read(), []);
  await mounts.close();
});

test('reads an invitation from the clipboard only on explicit IPC invocation', async () => {
  type IpcHandler = Parameters<Pick<Electron.IpcMain, 'handle'>['handle']>[1];
  const handlers = new Map<string, IpcHandler>();
  let clipboardReads = 0;
  const clipboardInvitation = invitation('guest-clipboard');
  let clipboardText = `  ${clipboardInvitation}  `;
  const mounts = service(memoryStore());
  const dispose = registerDesktopGuestSessionMountIpc(
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    mounts,
    () => {
      clipboardReads += 1;
      return clipboardText;
    },
  );

  assert.equal(clipboardReads, 0);
  const handler = handlers.get('session-collaboration:invitation:read-clipboard');
  assert.ok(handler);
  assert.equal(await handler({} as never), clipboardInvitation);
  assert.equal(clipboardReads, 1);

  clipboardText = 'an unrelated clipboard secret';
  assert.throws(() => handler({} as never), /Invalid Desktop collaboration invitation/);

  clipboardText = '   ';
  assert.equal(await handler({} as never), '');

  clipboardText = 'x'.repeat(32 * 1024 + 1);
  assert.throws(
    () => handler({} as never),
    /Clipboard content is too large to be a shared Session invitation/,
  );

  dispose();
  assert.equal(handlers.size, 0);
  await mounts.close();
});

function service(
  store: GuestSessionMountStore,
  overrides: {
    readonly mount?: Parameters<typeof createDesktopGuestSessionMountService>[0]['mount'];
    readonly finalizeAccess?: Parameters<
      typeof createDesktopGuestSessionMountService
    >[0]['finalizeAccess'];
    readonly getSharedSession?: Parameters<
      typeof createDesktopGuestSessionMountService
    >[0]['getSharedSession'];
    readonly inspect?: Parameters<typeof createDesktopGuestSessionMountService>[0]['inspect'];
    readonly onMountsChanged?: Parameters<
      typeof createDesktopGuestSessionMountService
    >[0]['onMountsChanged'];
    readonly unmount?: Parameters<typeof createDesktopGuestSessionMountService>[0]['unmount'];
    readonly wait?: Parameters<typeof createDesktopGuestSessionMountService>[0]['wait'];
    readonly onError?: Parameters<typeof createDesktopGuestSessionMountService>[0]['onError'];
  } = {},
) {
  return createDesktopGuestSessionMountService({
    store,
    mount: overrides.mount ?? (async () => undefined),
    finalizeAccess: overrides.finalizeAccess ?? (async () => 'ready'),
    getSharedSession: overrides.getSharedSession ?? (async () => sharedSession()),
    inspect: overrides.inspect ?? (() => ({ readiness: 'ready' })),
    onMountsChanged: overrides.onMountsChanged ?? (() => undefined),
    unmount: overrides.unmount ?? (async () => undefined),
    ...(overrides.wait ? { wait: overrides.wait } : {}),
    onError: overrides.onError ?? (() => undefined),
  });
}

function sharedSession(id = 'session-shared'): SharedSessionCatalogProjection {
  return {
    kind: 'shared_session',
    id,
    revision: 1,
    createdAt: 1,
    activityAt: 2,
    name: 'Shared task',
    status: 'active',
  };
}

function memoryStore(): GuestSessionMountStore {
  let mounts: readonly GuestSessionMount[] = [];
  return {
    read: async () => mounts.map((mount) => ({ ...mount })),
    write: async (next) => {
      mounts = next.map((mount) => ({ ...mount }));
    },
  };
}

function serializedStore(): GuestSessionMountStore {
  let secret: string | null = null;
  return createGuestSessionMountStore({
    getSecret: async () => secret,
    setSecret: async (_slug, _kind, value) => {
      secret = value;
    },
  });
}

function settlePromptly<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Operation did not settle after cancellation')),
      1_000,
    );
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function invitation(credential: string): string {
  return encodeDesktopCollaborationInvitation({
    invitationCode: encodeCollaborationInvitationCode({
      schemaVersion: 1,
      rootId: ROOT_ID,
      credential,
    }),
    target: {
      name: 'Shared Host',
      transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
    },
  });
}

function peerInvitation(credential: string): string {
  return encodeDesktopCollaborationInvitation({
    invitationCode: encodeCollaborationInvitationCode({
      schemaVersion: 1,
      rootId: ROOT_ID,
      credential,
    }),
    target: {
      name: 'Shared Host',
      transport: {
        kind: 'libp2p-direct',
        reachability: guestPeerReachability(),
      },
    },
  });
}

function guestPeerReachability(
  revision = 1,
  directRoutes: readonly string[] = ['/ip4/192.0.2.1/udp/41000/quic-v1'],
  coordinationRoutes: readonly string[] = ['/memory/stale-relay'],
) {
  return {
    lease: {
      version: 1 as const,
      peerId: '12D3KooWpeer',
      revision,
      issuedAt: 1,
      expiresAt: 2,
      directRoutes,
      coordinationRoutes,
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from('signature').toString('base64url'),
  };
}

function retainedMount(mountId: string): GuestSessionMount {
  return {
    mountId,
    name: 'Shared Host',
    rootId: ROOT_ID,
    transport: { kind: 'tls', url: 'wss://runtime.example.com/' },
    credential: 'guest-startup',
  };
}
