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
import type { RuntimeHostPeerEndpointOwner } from '../peer-reachability/owner.js';
import { attachPeerOwnerCleanup } from '../server/execution-service.js';
import type { RuntimeHostListenerSet } from '../server/listener-set.js';

test('the execution service exposes relay reservations discovered after startup', async () => {
  let coordinationRelays: readonly string[] = [];
  let listenersClosed = false;
  let ownerClosed = false;
  const peerListener = {
    peerId: '12D3KooWpeer',
    get reachability() {
      return {
        lease: {
          version: 1 as const,
          peerId: '12D3KooWpeer',
          revision: 1,
          issuedAt: 1,
          expiresAt: 2,
          directRoutes: ['/ip4/192.0.2.1/udp/41000/quic-v1'],
          coordinationRoutes: coordinationRelays,
        },
        publicKey: 'AA',
        signature: 'AA',
      };
    },
  };
  const listeners: RuntimeHostListenerSet = {
    listeners: [],
    localEndpoint: 'local',
    websocketEndpoints: [],
    peerListeners: [peerListener],
    async closeAdmission() {},
    async cleanup() {
      listenersClosed = true;
    },
  };
  const owner = {
    async close() {
      ownerClosed = true;
    },
  } as unknown as RuntimeHostPeerEndpointOwner;

  const attached = attachPeerOwnerCleanup(listeners, owner);
  assert.deepEqual(attached.peerListeners[0]?.reachability.lease.coordinationRoutes, []);

  coordinationRelays = ['/dns4/relay.example/udp/443/quic-v1/p2p/12D3KooWrelay'];
  assert.deepEqual(
    attached.peerListeners[0]?.reachability.lease.coordinationRoutes,
    coordinationRelays,
  );

  await attached.cleanup();
  assert.equal(listenersClosed, true);
  assert.equal(ownerClosed, true);
});
