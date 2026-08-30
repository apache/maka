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
import { encodeCollaborationInvitationCode } from '@maka/runtime-host/protocol';
import { encodeDesktopCollaborationInvitation } from '../runtime-host-collaboration-invitation.js';
import {
  createDesktopGuestSessionMountService,
  type GuestSessionMount,
  type GuestSessionMountStore,
} from '../runtime-host-guest-session-mounts.js';

const ROOT_ID = 'a'.repeat(64);

test('retains a successful Guest mount and rehydrates the same authority after restart', async () => {
  const store = memoryStore();
  const activated: string[] = [];
  const first = service(store, {
    mount: async (target) => {
      activated.push(`${target.profile.id}:${target.credential}`);
    },
  });

  const result = await first.importInvitation(invitation('guest-one'), false);
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

test('removes failed activation desire instead of creating recoverable profile state', async () => {
  const store = memoryStore();
  const unmounted: string[] = [];
  const mounts = service(store, {
    mount: async () => {
      throw Object.assign(new Error('route missing'), { code: 'direct_path_unavailable' });
    },
    unmount: async (mountId) => {
      unmounted.push(mountId);
    },
  });

  const result = await mounts.importInvitation(invitation('guest-two'), false);
  assert.deepEqual(result.kind === 'error' ? result.reason : result.kind, 'peer_path_unavailable');
  assert.deepEqual(await store.read(), []);
  assert.equal(unmounted.length, 1);
});

test('commits unmount desire before best-effort connection cleanup', async () => {
  const store = memoryStore();
  const mounts = service(store, {
    unmount: async () => {
      assert.deepEqual(await store.read(), []);
      throw new Error('connection shutdown failed');
    },
  });
  const result = await mounts.importInvitation(invitation('guest-three'), false);
  assert.equal(result.kind, 'connected');
  if (result.kind !== 'connected') return;

  await mounts.remove(result.mountId);
  assert.deepEqual(await store.read(), []);
});

test('awaits durable import rollback when closing during finalization', async () => {
  const store = memoryStore();
  let started!: () => void;
  const finalizing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const mounts = service(store, {
    finalizeAccess: async (_mountId, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  const importing = mounts.importInvitation(invitation('guest-closing'), false);
  await finalizing;
  await mounts.close();

  assert.equal((await importing).kind, 'error');
  assert.deepEqual(await store.read(), []);
});

function service(
  store: GuestSessionMountStore,
  overrides: {
    readonly mount?: Parameters<typeof createDesktopGuestSessionMountService>[0]['mount'];
    readonly finalizeAccess?: Parameters<typeof createDesktopGuestSessionMountService>[0]['finalizeAccess'];
    readonly unmount?: Parameters<typeof createDesktopGuestSessionMountService>[0]['unmount'];
  } = {},
) {
  return createDesktopGuestSessionMountService({
    store,
    mount: overrides.mount ?? (async () => undefined),
    finalizeAccess: overrides.finalizeAccess ?? (async () => undefined),
    unmount: overrides.unmount ?? (async () => undefined),
    onError: () => undefined,
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
