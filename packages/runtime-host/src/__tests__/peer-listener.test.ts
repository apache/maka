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
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createRuntimeHostPeerListener } from '../server/peer-listener.js';
import { createRuntimeHostListenerSet } from '../server/listener-set.js';
import type { RuntimeHostPeerClient } from '../client/peer-client.js';
import type { RuntimeHostPeerNativeStream } from '../transport/peer-native.js';

test('bounds and aborts pending peer authentication', async () => {
  const streams = Array.from({ length: 17 }, (_, index) => pendingStream(`remote-peer-${index}`));
  const listener = createRuntimeHostPeerListener(peerWith([...streams]), {} as never, () => {});
  await waitForImmediate();

  assert.equal(streams.filter((stream) => stream.aborted).length, 1);
  await listener.closeAdmission();
  assert.equal(
    streams.every((stream) => stream.aborted),
    true,
  );
  await listener.cleanup();
});

test('expires a peer that does not send its credential', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = pendingStream();
  const listener = createRuntimeHostPeerListener(peerWith([stream]), {} as never, () => {});
  await waitForImmediate();

  context.mock.timers.tick(5_000);
  await waitForImmediate();
  assert.equal(stream.aborted, true);
  await listener.cleanup();
});

test('reports an explicit authentication rejection before closing the stream', async () => {
  const stream = recordingStream(Buffer.from('{"v":1,"credential":"rejected"}\n'));
  const listener = createRuntimeHostPeerListener(
    peerWith([stream]),
    { authenticate: () => null } as never,
    () => {},
  );
  await waitForImmediate();
  await waitForImmediate();

  assert.deepEqual(stream.writes, [Buffer.from('{"v":1,"accepted":false}\n')]);
  assert.equal(stream.closed, true);
  await listener.cleanup();
});

test('rechecks peer authority at admission after the authentication response is written', async () => {
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let aborted = false;
  let reads = 0;
  const stream: RuntimeHostPeerNativeStream = {
    peerId: 'remote-peer',
    read: async () => (reads++ === 0 ? Buffer.from('{"v":1,"credential":"revoked"}\n') : null),
    write: async () => writeReleased,
    close: async () => undefined,
    abort: () => {
      aborted = true;
    },
  };
  let authentications = 0;
  let accepted = false;
  const listener = createRuntimeHostPeerListener(
    peerWith([stream]),
    {
      authenticate: () => (authentications++ === 0 ? { operationGrants: 'all' } : null),
    } as never,
    () => {
      accepted = true;
    },
  );
  await waitForImmediate();

  releaseWrite();
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(authentications, 2);
  assert.equal(accepted, false);
  assert.equal(aborted, true);
  await listener.cleanup();
});

test('bounds active application streams from one authenticated peer', async () => {
  const streams = Array.from({ length: 5 }, () => authenticatedPendingStream('remote-peer'));
  let accepted = 0;
  const listener = createRuntimeHostPeerListener(
    peerWith([...streams]),
    { authenticate: () => ({ operationGrants: 'all' }) } as never,
    () => {
      accepted += 1;
    },
  );
  await waitForImmediate();
  await waitForImmediate();

  assert.equal(accepted, 4);
  assert.equal(streams[4]?.aborted, true);
  await listener.cleanup();
});

test('projects newly accepted coordination relays from the running peer endpoint', async () => {
  let coordinationRelays: readonly string[] = [];
  const peer = {
    ...peerWith([]),
    identity: () => ({
      peerId: 'peer',
      listenAddresses: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
      coordinationRelays,
    }),
  };
  const listener = createRuntimeHostPeerListener(peer, {} as never, () => {});
  const listeners = createRuntimeHostListenerSet(
    {
      kind: 'local_ipc',
      endpoint: 'local',
      closeAdmission: async () => undefined,
      cleanup: async () => undefined,
    },
    [listener],
  );

  assert.deepEqual(listeners.peerListeners[0]?.coordinationRelays, []);
  coordinationRelays = ['/dns4/relay.example/udp/443/quic-v1/p2p/12D3KooWrelay'];
  assert.deepEqual(listeners.peerListeners[0]?.coordinationRelays, coordinationRelays);
  await listeners.cleanup();
});

function peerWith(streams: RuntimeHostPeerNativeStream[]): RuntimeHostPeerClient {
  return {
    identity: () => ({ peerId: 'peer', listenAddresses: [], coordinationRelays: [] }),
    signIdentity: async () => {
      throw new Error('not used');
    },
    verifyIdentity: () => false,
    transitSnapshot: () => ({
      allowedPeerCount: 0,
      activeReservationCount: 0,
      activeCircuitCount: 0,
      maxReservationCount: 32,
      maxCircuitCount: 8,
      maxCircuitsPerPeer: 2,
      maxCircuitDurationSeconds: 7_200,
      maxCircuitBytes: 256 * 1024 * 1024,
    }),
    configureTransit: async () => undefined,
    observeAuthenticatedRoutes: () => undefined,
    connect: async () => {
      throw new Error('not used');
    },
    connectMeshControl: async () => {
      throw new Error('not used');
    },
    serveApplication: async (onStream, signal) => {
      for (const stream of streams) onStream(stream);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
    serveMeshControl: async () => {
      throw new Error('not used');
    },
    close: async () => undefined,
  };
}

function pendingStream(
  peerId = 'remote-peer',
): RuntimeHostPeerNativeStream & { readonly aborted: boolean } {
  let finish!: (value: null) => void;
  const read = new Promise<null>((resolve) => {
    finish = resolve;
  });
  let aborted = false;
  return {
    peerId,
    get aborted() {
      return aborted;
    },
    read: () => read,
    write: async () => undefined,
    close: async () => undefined,
    abort: () => {
      aborted = true;
      finish(null);
    },
  };
}

function authenticatedPendingStream(
  peerId: string,
): RuntimeHostPeerNativeStream & { readonly aborted: boolean } {
  let finish!: (value: null) => void;
  const pending = new Promise<null>((resolve) => {
    finish = resolve;
  });
  let first = true;
  let aborted = false;
  return {
    peerId,
    get aborted() {
      return aborted;
    },
    read: async () => {
      if (first) {
        first = false;
        return Buffer.from('{"v":1,"credential":"accepted"}\n');
      }
      return pending;
    },
    write: async () => undefined,
    close: async () => finish(null),
    abort: () => {
      aborted = true;
      finish(null);
    },
  };
}

function recordingStream(initial: Buffer): RuntimeHostPeerNativeStream & {
  readonly writes: readonly Buffer[];
  readonly closed: boolean;
} {
  let pending: Buffer | null = initial;
  let closed = false;
  const writes: Buffer[] = [];
  return {
    peerId: 'remote-peer',
    get writes() {
      return writes;
    },
    get closed() {
      return closed;
    },
    read: async () => {
      const value = pending;
      pending = null;
      return value;
    },
    write: async (bytes) => {
      writes.push(Buffer.from(bytes));
    },
    close: async () => {
      closed = true;
    },
    abort: () => undefined,
  };
}
