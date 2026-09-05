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
  decodeRuntimeHostOwnerConnectionCode,
  encodeRuntimeHostOwnerConnectionCode,
} from '../client/owner-connection-code.js';

test('owner connection code round-trips its bounded direct-peer pairing payload', () => {
  const input = {
    name: 'Office Mac',
    rootId: 'a'.repeat(64),
    transport: {
      kind: 'libp2p-direct' as const,
      reachability: reachability(['/ip4/192.0.2.1/udp/41000/quic-v1']),
    },
    credential: 'pending-credential',
  };
  assert.deepEqual(
    decodeRuntimeHostOwnerConnectionCode(encodeRuntimeHostOwnerConnectionCode(input)),
    input,
  );
});

test('owner connection code rejects unversioned and route-less payloads', () => {
  assert.throws(() => decodeRuntimeHostOwnerConnectionCode('pending-credential'));
  assert.throws(() =>
    encodeRuntimeHostOwnerConnectionCode({
      name: 'Office Mac',
      rootId: 'a'.repeat(64),
      transport: {
        kind: 'libp2p-direct',
        reachability: reachability([]),
      },
      credential: 'pending-credential',
    }),
  );
});

function reachability(directRoutes: readonly string[]) {
  return {
    lease: {
      version: 1 as const,
      peerId: '12D3KooWpeer',
      revision: 1,
      issuedAt: 1,
      expiresAt: 2,
      directRoutes,
      coordinationRoutes: [],
    },
    publicKey: Buffer.from('public').toString('base64url'),
    signature: Buffer.from('signature').toString('base64url'),
  };
}
