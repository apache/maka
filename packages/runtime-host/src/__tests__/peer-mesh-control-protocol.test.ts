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
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';
import {
  decodeAnnounceRosterResponse,
  decodeControlRequest,
  decodeLeaveResponse,
  decodeRedeemResponse,
  decodeSyncResponse,
} from '../peer-mesh/control-protocol.js';
import {
  canonicalPeerMeshMemberAdvertisement,
  generatePeerMeshAuthorityKeyPair,
  peerMeshId,
  peerMeshMemberAdvertisementSigningBytes,
  signPeerMeshRoster,
} from '../peer-mesh/model.js';
import {
  canonicalPeerReachabilityLease,
  peerReachabilityLeaseSigningBytes,
} from '../peer-reachability/model.js';

const keys = generatePeerMeshAuthorityKeyPair();
const privateKey = createPrivateKey({
  key: Buffer.from(keys.privateKey, 'base64url'),
  format: 'der',
  type: 'pkcs8',
});
const meshId = peerMeshId(keys.publicKey);
const roster = signPeerMeshRoster(
  {
    version: 1,
    meshId,
    authorityPeerId: 'peer-a',
    revision: 1,
    members: ['peer-a'],
    closed: false,
  },
  keys,
);
const lease = canonicalPeerReachabilityLease({
  version: 1,
  peerId: 'peer-a',
  revision: 1,
  issuedAt: 1_000,
  expiresAt: 2_000,
  directRoutes: ['/memory/peer-a'],
  coordinationRoutes: [],
});
const reachability = {
  lease,
  publicKey: keys.publicKey,
  signature: sign(null, peerReachabilityLeaseSigningBytes(lease), privateKey).toString('base64url'),
};
const memberAdvertisement = canonicalPeerMeshMemberAdvertisement({
  version: 1,
  meshId,
  peerId: 'peer-a',
  revision: 1,
  offersTransit: false,
});
const advertisement = {
  advertisement: memberAdvertisement,
  publicKey: keys.publicKey,
  signature: sign(
    null,
    peerMeshMemberAdvertisementSigningBytes(memberAdvertisement),
    privateKey,
  ).toString('base64url'),
};
const summary = { peerId: 'peer-a', revision: 1, digest: 'a'.repeat(64) };
const redeem = { kind: 'redeem-invitation', meshId, secret: 'secret', reachability, advertisement };
const sync = {
  kind: 'sync',
  meshId,
  roster,
  reachability,
  advertisement,
  knownReachability: [summary],
  knownAdvertisements: [summary],
};
const page = { roster, reachability: [reachability], advertisements: [advertisement] };
const wireCases: readonly {
  decode: (value: unknown) => unknown;
  wire: Record<string, unknown>;
}[] = [
  ...[
    redeem,
    sync,
    { kind: 'leave', meshId, roster },
    { kind: 'announce-roster', meshId, roster },
  ].map((wire) => ({ decode: decodeControlRequest, wire })),
  { decode: decodeRedeemResponse, wire: { kind: 'invitation-redeemed', ...page } },
  ...['invalid', 'expired', 'closed', 'full'].map((reason) => ({
    decode: decodeRedeemResponse,
    wire: { kind: 'invitation-rejected', reason },
  })),
  ...[false, true].map((more) => ({
    decode: decodeSyncResponse,
    wire: { kind: 'sync-result', ...page, more },
  })),
  { decode: decodeSyncResponse, wire: { kind: 'sync-rejected', reason: 'unknown' } },
  { decode: decodeLeaveResponse, wire: { kind: 'left', roster } },
  { decode: decodeLeaveResponse, wire: { kind: 'leave-rejected', reason: 'unknown' } },
  { decode: decodeAnnounceRosterResponse, wire: { kind: 'roster-observed' } },
  { decode: decodeAnnounceRosterResponse, wire: { kind: 'roster-rejected', reason: 'unknown' } },
];

test('decodes every control request and response variant after JSON transport', () => {
  for (const { decode, wire } of wireCases) {
    assert.deepEqual(decode(JSON.parse(JSON.stringify(wire))), wire);
  }
});

test('rejects extra or inherited required keys, unknown kinds, and non-object control messages', () => {
  for (const { decode, wire } of wireCases) {
    assert.throws(() => decode({ ...wire, unexpected: true }));
    const { kind, ...fields } = wire;
    const inheritedKind = Object.assign(Object.create({ kind }), fields, { unexpected: true });
    assert.equal(Object.keys(inheritedKind).length, Object.keys(wire).length);
    assert.throws(() => decode(inheritedKind));
    assert.throws(() => decode({ ...wire, kind: 'future-kind' }));
    for (const invalid of [null, [], 42]) assert.throws(() => decode(invalid));
  }
});

test('enforces control string bounds without imposing invitation authentication', () => {
  assert.equal(
    decodeControlRequest({ ...redeem, meshId: 'm'.repeat(128), secret: 's'.repeat(64) }).kind,
    'redeem-invitation',
  );
  for (const meshId of ['', 'm'.repeat(129), 42]) {
    assert.throws(() => decodeControlRequest({ ...redeem, meshId }), /control value/u);
  }
  for (const secret of ['', 's'.repeat(65), 42]) {
    assert.throws(() => decodeControlRequest({ ...redeem, secret }), /control value/u);
  }
});

test('rejects unsupported response reasons and non-boolean pagination flags', () => {
  for (const { decode, wire } of wireCases.filter(({ wire }) => 'reason' in wire)) {
    assert.throws(() => decode({ ...wire, reason: 'future-reason' }));
  }
  for (const more of [undefined, 0, 'false']) {
    assert.throws(
      () => decodeSyncResponse({ kind: 'sync-result', ...page, more }),
      /synchronization response/u,
    );
  }
});

test('validates evidence summary identities, revisions, and digests on both sync inputs', () => {
  const invalidSummaries = [
    { ...summary, unexpected: true },
    ...['', 'p'.repeat(257), 42].map((peerId) => ({ ...summary, peerId })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map((revision) => ({ ...summary, revision })),
    ...['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 42].map((digest) => ({
      ...summary,
      digest,
    })),
  ];
  for (const field of ['knownReachability', 'knownAdvertisements'] as const) {
    assert.doesNotThrow(() =>
      decodeControlRequest({
        ...sync,
        [field]: [{ ...summary, peerId: 'p'.repeat(256), revision: Number.MAX_SAFE_INTEGER }],
      }),
    );
    for (const invalid of invalidSummaries) {
      assert.throws(() => decodeControlRequest({ ...sync, [field]: [invalid] }));
    }
  }
});

test('bounds sync summaries and rejects duplicate peers even when their revisions differ', () => {
  const summaries = Array.from({ length: 64 }, (_, index) => ({
    ...summary,
    peerId: `peer-${index}`,
  }));
  for (const field of ['knownReachability', 'knownAdvertisements'] as const) {
    assert.doesNotThrow(() => decodeControlRequest({ ...sync, [field]: summaries }));
    assert.throws(
      () =>
        decodeControlRequest({
          ...sync,
          [field]: [...summaries, { ...summary, peerId: 'one-too-many' }],
        }),
      /evidence revisions/u,
    );
    assert.throws(
      () => decodeControlRequest({ ...sync, [field]: [summary, { ...summary, revision: 2 }] }),
      /Duplicate Peer Mesh evidence revision/u,
    );
    assert.throws(() => decodeControlRequest({ ...sync, [field]: null }), /evidence revisions/u);
  }
});

test('keeps each evidence page and the combined response within two records', () => {
  for (const { decode, wire } of wireCases.filter(({ wire }) => 'advertisements' in wire)) {
    for (const field of ['reachability', 'advertisements'] as const) {
      const other = field === 'reachability' ? 'advertisements' : 'reachability';
      const value = field === 'reachability' ? reachability : advertisement;
      const error =
        field === 'reachability'
          ? /Invalid Peer Mesh reachability page/u
          : /Invalid Peer Mesh advertisement page/u;
      assert.doesNotThrow(() => decode({ ...wire, [field]: [value, value], [other]: [] }));
      assert.throws(() => decode({ ...wire, [field]: [value, value, value], [other]: [] }), error);
      assert.throws(() => decode({ ...wire, [field]: null, [other]: [] }), error);
      assert.throws(
        () => decode({ ...wire, [field]: [value, value] }),
        /evidence page exceeds its bound/u,
      );
    }
  }
});

test('retains signed-record validation while decoding control envelopes', () => {
  assert.throws(
    () =>
      decodeControlRequest({
        ...sync,
        reachability: { ...reachability, lease: { ...lease, version: 2 } },
      }),
    /reachability lease version/u,
  );
  assert.throws(
    () =>
      decodeControlRequest({
        ...redeem,
        advertisement: { ...advertisement, advertisement: { ...memberAdvertisement, version: 2 } },
      }),
    /advertisement version/u,
  );
  assert.throws(
    () =>
      decodeLeaveResponse({
        kind: 'left',
        roster: { ...roster, roster: { ...roster.roster, closed: true } },
      }),
    /roster signature is invalid/u,
  );
});

test('reconstructs frozen evidence and summary collections without retaining wire objects', () => {
  const rawRequest = JSON.parse(JSON.stringify(sync));
  const request = decodeControlRequest(rawRequest);
  assert.equal(request.kind, 'sync');
  if (request.kind !== 'sync') throw new Error('Expected sync request');
  for (const field of ['knownReachability', 'knownAdvertisements'] as const) {
    assert.ok(Object.isFrozen(request[field]));
    assert.ok(Object.isFrozen(request[field][0]));
    rawRequest[field][0].digest = 'changed';
    assert.equal(request[field][0]?.digest, summary.digest);
  }
  for (const { decode, wire } of wireCases.filter(({ wire }) => 'advertisements' in wire)) {
    const rawResponse = JSON.parse(JSON.stringify(wire));
    const result = decode(rawResponse) as typeof page;
    assert.ok(Object.isFrozen(result.reachability));
    assert.ok(Object.isFrozen(result.advertisements));
    assert.ok(Object.isFrozen(result.reachability[0]));
    assert.ok(Object.isFrozen(result.advertisements[0]));
    rawResponse.reachability[0].lease.peerId = 'changed';
    rawResponse.advertisements[0].advertisement.peerId = 'changed';
    assert.equal(result.reachability[0]?.lease.peerId, 'peer-a');
    assert.equal(result.advertisements[0]?.advertisement.peerId, 'peer-a');
  }
});
