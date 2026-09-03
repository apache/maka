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
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isPeerReachabilityLeaseCurrent,
  peerReachabilityLeaseReceipt,
  verifySignedPeerReachabilityLease,
  type PeerReachabilityPeer,
} from '../peer-reachability/model.js';
import { openPeerReachabilityPublisher } from '../peer-reachability/publisher.js';

test('peer reachability lease is target-bound, signed, and bounded', async () => {
  const identity = new TestPeerIdentity('peer-a');
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-reachability-'));
  try {
    const publisher = await openPeerReachabilityPublisher({ dataRoot: root, peer: identity });
    const signed = publisher.current();
    assert.equal(
      verifySignedPeerReachabilityLease({
        value: signed,
        expectedPeerId: 'peer-a',
        now: Date.now(),
        verifyIdentity: identity.verifyIdentity.bind(identity),
      }).lease.peerId,
      'peer-a',
    );
    assert.throws(
      () =>
        verifySignedPeerReachabilityLease({
          value: signed,
          expectedPeerId: 'peer-b',
          now: Date.now(),
          verifyIdentity: identity.verifyIdentity.bind(identity),
        }),
      /different peer/,
    );
    assert.throws(
      () =>
        verifySignedPeerReachabilityLease({
          value: {
            ...signed,
            lease: { ...signed.lease, directRoutes: ['/memory/tampered'] },
          },
          expectedPeerId: 'peer-a',
          now: Date.now(),
          verifyIdentity: identity.verifyIdentity.bind(identity),
        }),
      /signature is invalid/,
    );
    assert.throws(
      () =>
        verifySignedPeerReachabilityLease({
          value: {
            ...signed,
            lease: {
              ...signed.lease,
              directRoutes: Array.from({ length: 17 }, (_, index) => `/memory/${index}`),
            },
          },
          expectedPeerId: 'peer-a',
          now: Date.now(),
          verifyIdentity: identity.verifyIdentity.bind(identity),
        }),
      /directRoutes/,
    );
    assert.throws(
      () =>
        verifySignedPeerReachabilityLease({
          value: {
            ...signed,
            lease: {
              ...signed.lease,
              directRoutes: ['/memory/shared'],
              coordinationRoutes: ['/memory/shared'],
            },
          },
          expectedPeerId: 'peer-a',
          now: Date.now(),
          verifyIdentity: identity.verifyIdentity.bind(identity),
        }),
      /more than one class/,
    );
    await publisher.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('peer reachability publisher persists the exact revision before exposing it', async () => {
  const identity = new TestPeerIdentity('peer-a');
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-reachability-restart-'));
  try {
    const first = await openPeerReachabilityPublisher({ dataRoot: root, peer: identity });
    const initial = first.current();
    assert.equal(initial.lease.revision, 1);
    const persisted = JSON.parse(await readFile(join(root, 'peer-reachability.json'), 'utf8')) as {
      current: typeof initial;
    };
    assert.deepEqual(persisted.current, initial);
    await first.close();

    identity.listenAddresses = ['/memory/peer-a-new'];
    const second = await openPeerReachabilityPublisher({ dataRoot: root, peer: identity });
    assert.equal(second.current().lease.revision, 2);
    assert.deepEqual(second.current().lease.directRoutes, ['/memory/peer-a-new']);
    await second.close();

    await assert.rejects(
      openPeerReachabilityPublisher({
        dataRoot: root,
        peer: new TestPeerIdentity('peer-b'),
      }),
      /different peer/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('peer reachability currentness cannot be extended by a wall-clock rollback', async () => {
  const identity = new TestPeerIdentity('peer-a');
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-reachability-clock-'));
  try {
    const wallNow = 1_000_000;
    const publisher = await openPeerReachabilityPublisher({
      dataRoot: root,
      peer: identity,
      now: () => wallNow,
    });
    const signed = publisher.current();
    const receipt = peerReachabilityLeaseReceipt({ signed, wallNow, monotonicNow: 100 });
    assert.equal(isPeerReachabilityLeaseCurrent(signed, receipt, 100), true);
    assert.equal(
      isPeerReachabilityLeaseCurrent(signed, receipt, 100 + signed.lease.expiresAt - wallNow),
      false,
    );
    assert.equal(
      peerReachabilityLeaseReceipt({
        signed,
        wallNow: wallNow - 10 * 60_000,
        monotonicNow: 200,
        previous: receipt,
      }),
      receipt,
    );
    await publisher.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publisher replaces future leases and renews them on monotonic time across restart', async () => {
  const identity = new TestPeerIdentity('peer-a');
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-reachability-publisher-clock-'));
  let wallNow = 1_000_000;
  let monotonicNow = 100;
  try {
    const first = await openPeerReachabilityPublisher({
      dataRoot: root,
      peer: identity,
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });
    assert.equal(first.current().lease.revision, 1);

    wallNow = 400_000;
    assert.equal((await first.refresh()).lease.revision, 2);
    assert.equal(first.current().lease.issuedAt, wallNow);
    await first.close();

    wallNow = 100_000;
    const second = await openPeerReachabilityPublisher({
      dataRoot: root,
      peer: identity,
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });
    assert.equal(second.current().lease.revision, 3);
    assert.equal(second.current().lease.issuedAt, wallNow);

    monotonicNow += 4 * 60_000;
    assert.equal((await second.refresh()).lease.revision, 4);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class TestPeerIdentity implements PeerReachabilityPeer {
  readonly #publicKey: KeyObject;
  readonly #privateKey: KeyObject;
  listenAddresses: readonly string[];
  coordinationRelays: readonly string[];

  constructor(readonly peerId: string) {
    const keys = generateKeyPairSync('ed25519');
    this.#publicKey = keys.publicKey;
    this.#privateKey = keys.privateKey;
    this.listenAddresses = [`/memory/${peerId}`];
    this.coordinationRelays = [];
  }

  identity() {
    return { peerId: this.peerId };
  }

  reachability() {
    return {
      listenAddresses: this.listenAddresses,
      activeCoordinationRelays: this.coordinationRelays,
    };
  }

  async signIdentity(payload: Buffer) {
    return {
      publicKey: this.#publicKey.export({ format: 'der', type: 'spki' }),
      signature: sign(null, payload, this.#privateKey),
    };
  }

  verifyIdentity(peerId: string, payload: Buffer, proof: { publicKey: Buffer; signature: Buffer }) {
    return (
      peerId === this.peerId &&
      proof.publicKey.equals(this.#publicKey.export({ format: 'der', type: 'spki' })) &&
      verify(null, payload, this.#publicKey, proof.signature)
    );
  }
}
