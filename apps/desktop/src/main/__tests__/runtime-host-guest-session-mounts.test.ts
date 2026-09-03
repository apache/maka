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
  type ResolvedRuntimeHostProfile,
} from '@maka/runtime-host/client';
import {
  encodeCollaborationInvitationCode,
  type HostPeerEndpoint,
} from '@maka/runtime-host/protocol';
import { encodeDesktopCollaborationInvitation } from '../runtime-host-collaboration-invitation.js';
import {
  createDesktopGuestSessionMountService,
  type GuestSessionMount,
  type GuestSessionMountStore,
  registerDesktopGuestSessionMountIpc,
} from '../runtime-host-guest-session-mounts.js';
import { RuntimeHostPairingFinalizationInterruptedError } from '../runtime-host-desktop-manager.js';

const ROOT_ID = 'a'.repeat(64);

test('retains a successful Guest mount and rehydrates the same authority after restart', async () => {
  const store = memoryStore();
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
  await second!.close();
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
      assert.deepEqual(
        target.profile.kind === 'remote' ? target.profile.transport : undefined,
        {
          kind: 'libp2p-direct',
          reachability: guestPeerReachability(),
        },
      );
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
  await store.write([retainedMount('shared-needs-repair')]);
  let attempts = 0;
  let waits = 0;
  let reportFailure!: () => void;
  const failureReported = new Promise<void>((resolve) => {
    reportFailure = resolve;
  });
  const mounts = service(store, {
    mount: async () => {
      attempts += 1;
      throw new RuntimeHostPermanentReconnectError('reachability recovery exhausted');
    },
    wait: async () => {
      waits += 1;
    },
    onError: () => reportFailure(),
  });

  await mounts.start();
  await failureReported;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
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

  const result = await mounts.importInvitation(invitation('guest-unknown'), false, 'import-unknown');
  assert.equal(result.kind, 'recovering');
  assert.equal((await store.read()).length, 1);
  await reconciled;
  assert.equal(attempts, 2);
  assert.equal((await store.read()).length, 1);
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
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
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
    readonly finalizeAccess?: Parameters<typeof createDesktopGuestSessionMountService>[0]['finalizeAccess'];
    readonly unmount?: Parameters<typeof createDesktopGuestSessionMountService>[0]['unmount'];
    readonly wait?: Parameters<typeof createDesktopGuestSessionMountService>[0]['wait'];
    readonly onError?: Parameters<typeof createDesktopGuestSessionMountService>[0]['onError'];
  } = {},
) {
  return createDesktopGuestSessionMountService({
    store,
    mount: overrides.mount ?? (async () => undefined),
    finalizeAccess: overrides.finalizeAccess ?? (async () => 'ready'),
    unmount: overrides.unmount ?? (async () => undefined),
    ...(overrides.wait ? { wait: overrides.wait } : {}),
    onError: overrides.onError ?? (() => undefined),
  });
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
