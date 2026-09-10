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
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { test } from 'node:test';
import { openPeerMeshNode, type PeerMeshTransport } from '../peer-mesh/node.js';
import { openPeerReachabilityPublisher } from '../peer-reachability/publisher.js';

const INTERVAL_MS = 300_000;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'reconciliation did not reach the expected state');
    await immediate();
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maka-mesh-reconciliation-timer-'));
  const peerId = 'peer-timer-test';
  let routeVersion = 0;
  let configurations = 0;
  let serveSignal: AbortSignal | undefined;
  const errors: unknown[] = [];
  const signature = (id: string, payload: Buffer) =>
    createHash('sha256').update(id).update(payload).digest();
  const peer: PeerMeshTransport & {
    reachability(): { listenAddresses: string[]; activeCoordinationRelays: string[] };
  } = {
    identity: () => ({ peerId }),
    reachability: () => ({
      listenAddresses: [`/memory/${routeVersion}/p2p/${peerId}`],
      activeCoordinationRelays: [],
    }),
    signIdentity: async (payload) => ({
      publicKey: Buffer.from(peerId),
      signature: signature(peerId, payload),
    }),
    verifyIdentity: (id, payload, proof) =>
      proof.publicKey.toString() === id && proof.signature.equals(signature(id, payload)),
    isConnected: () => false,
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
    configureTransit: async () => {
      configurations++;
    },
    connectMeshControl: async () => {
      throw new Error('Unexpected outbound connection');
    },
    serveMeshControl: (_onStream, signal) => {
      serveSignal = signal;
      return new Promise<void>((resolve) => {
        const stop = () => {
          signal.removeEventListener('abort', stop);
          resolve();
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
    },
  };
  const publisher = await openPeerReachabilityPublisher({
    dataRoot: join(root, 'publisher'),
    peer,
  });
  const node = await openPeerMeshNode({
    dataRoot: join(root, 'mesh'),
    peer,
    reachability: publisher,
    onBackgroundReconcileError: (error) => errors.push(error),
  });
  return {
    node,
    configurations: () => configurations,
    listeners: () => (serveSignal ? getEventListeners(serveSignal, 'abort').length : 0),
    changeRoutes: async () => {
      routeVersion++;
      await publisher.refresh();
    },
    close: async () => {
      await node.close();
      await publisher.close();
      await rm(root, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    },
  };
}

test('early reconciliation triggers retain only the current timer and abort listener', async (context) => {
  const timers = new Set<number>();
  let created = 0;
  const hook = createHook({
    init(id, type, _trigger, resource: { _idleTimeout?: number }) {
      if (type === 'Timeout' && resource._idleTimeout === INTERVAL_MS) {
        timers.add(id);
        created++;
      }
    },
    destroy(id) {
      timers.delete(id);
    },
  }).enable();
  context.after(() => hook.disable());
  const owner = await fixture();
  const serving = owner.node.serve();
  try {
    await until(() => created === 1);
    assert.equal(owner.listeners(), 2);
    for (let i = 0; i < 100; i++) {
      for (const trigger of [
        () => owner.node.setDisplayName('Timer test'),
        () => owner.changeRoutes(),
      ]) {
        const before = created;
        await trigger();
        await until(() => created > before);
        await immediate();
        assert.equal(timers.size, 1);
        assert.equal(owner.listeners(), 2);
      }
    }
    await owner.close();
    await serving;
    await immediate();
    assert.equal(timers.size, 0);
    assert.equal(owner.listeners(), 0);
  } finally {
    await owner.close();
    await serving;
  }
});

test('the reconciliation interval still wakes an idle node', async (context) => {
  const owner = await fixture();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const serving = owner.node.serve();
  try {
    await until(() => owner.configurations() >= 2 && owner.listeners() === 2);
    const before = owner.configurations();
    context.mock.timers.tick(INTERVAL_MS - 1);
    await immediate();
    assert.equal(owner.configurations(), before);
    context.mock.timers.tick(1);
    await until(() => owner.configurations() > before && owner.listeners() === 2);
    assert.equal(owner.configurations(), before + 1);
    await owner.close();
    await serving;
    assert.equal(owner.listeners(), 0);
  } finally {
    await owner.close();
    await serving;
  }
});
