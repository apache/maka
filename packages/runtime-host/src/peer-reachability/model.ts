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

import type { RuntimeHostPeerIdentityProof } from '../transport/peer-native.js';

export const PEER_REACHABILITY_LEASE_TTL_MS = 5 * 60 * 1_000;
export const PEER_REACHABILITY_REFRESH_LEAD_MS = 60 * 1_000;
export const PEER_REACHABILITY_MAX_LIFETIME_MS = 10 * 60 * 1_000;
export const PEER_REACHABILITY_MAX_CLOCK_SKEW_MS = 2 * 60 * 1_000;
export const PEER_REACHABILITY_RECOVERY_HORIZON_MS = 24 * 60 * 60 * 1_000;
export const PEER_REACHABILITY_MAX_ROUTES_PER_CLASS = 16;
export const PEER_REACHABILITY_MAX_RECORD_BYTES = 48 * 1_024;

const PEER_ID_MAX_BYTES = 256;
const ADDRESS_MAX_BYTES = 2 * 1_024;
const PROOF_MAX_BYTES = 256;

export interface PeerReachabilityLeaseV1 {
  readonly version: 1;
  readonly peerId: string;
  readonly revision: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly directRoutes: readonly string[];
  readonly coordinationRoutes: readonly string[];
}

export interface SignedPeerReachabilityLeaseV1 {
  readonly lease: PeerReachabilityLeaseV1;
  readonly publicKey: string;
  readonly signature: string;
}

export interface PeerReachabilityLeaseReceipt {
  readonly peerId: string;
  readonly revision: number;
  readonly signature: string;
  readonly currentUntil: number;
}

export interface PeerReachabilityPeer {
  identity(): Readonly<{
    peerId: string;
  }>;
  reachability(): Readonly<{
    listenAddresses: readonly string[];
    activeCoordinationRelays: readonly string[];
  }>;
  signIdentity(payload: Buffer): Promise<RuntimeHostPeerIdentityProof>;
  verifyIdentity(peerId: string, payload: Buffer, proof: RuntimeHostPeerIdentityProof): boolean;
}

export function canonicalPeerReachabilityLease(value: unknown): PeerReachabilityLeaseV1 {
  const record = exactRecord(value, 'peer reachability lease', [
    'version',
    'peerId',
    'revision',
    'issuedAt',
    'expiresAt',
    'directRoutes',
    'coordinationRoutes',
  ]);
  if (record.version !== 1) throw new Error('Unsupported peer reachability lease version');
  const issuedAt = integer(record.issuedAt, 'issuedAt', 1);
  const expiresAt = integer(record.expiresAt, 'expiresAt', issuedAt + 1);
  if (expiresAt - issuedAt > PEER_REACHABILITY_MAX_LIFETIME_MS) {
    throw new Error('Peer reachability lease lifetime is too long');
  }
  const lease = Object.freeze({
    version: 1 as const,
    peerId: token(record.peerId, 'peerId', PEER_ID_MAX_BYTES),
    revision: integer(record.revision, 'revision', 1),
    issuedAt,
    expiresAt,
    directRoutes: Object.freeze(addresses(record.directRoutes, 'directRoutes')),
    coordinationRoutes: Object.freeze(addresses(record.coordinationRoutes, 'coordinationRoutes')),
  });
  const directRoutes = new Set(lease.directRoutes);
  if (lease.coordinationRoutes.some((route) => directRoutes.has(route))) {
    throw new Error('Peer reachability route cannot belong to more than one class');
  }
  if (peerReachabilityLeaseSigningBytes(lease).byteLength > PEER_REACHABILITY_MAX_RECORD_BYTES) {
    throw new Error('Peer reachability lease is too large');
  }
  return lease;
}

export function decodeSignedPeerReachabilityLease(value: unknown): SignedPeerReachabilityLeaseV1 {
  const record = exactRecord(value, 'signed peer reachability lease', [
    'lease',
    'publicKey',
    'signature',
  ]);
  return Object.freeze({
    lease: canonicalPeerReachabilityLease(record.lease),
    publicKey: proof(record.publicKey, 'publicKey'),
    signature: proof(record.signature, 'signature'),
  });
}

export function verifySignedPeerReachabilityLease(input: {
  readonly value: unknown;
  readonly expectedPeerId: string;
  readonly now: number;
  readonly verifyIdentity: PeerReachabilityPeer['verifyIdentity'];
  readonly allowExpired?: boolean;
}): SignedPeerReachabilityLeaseV1 {
  const signed = authenticateSignedPeerReachabilityLease(input);
  if (signed.lease.issuedAt > input.now + PEER_REACHABILITY_MAX_CLOCK_SKEW_MS) {
    throw new Error('Peer reachability lease was issued too far in the future');
  }
  if (!input.allowExpired && signed.lease.expiresAt <= input.now) {
    throw new Error('Peer reachability lease has expired');
  }
  return signed;
}

export function authenticateSignedPeerReachabilityLease(input: {
  readonly value: unknown;
  readonly expectedPeerId: string;
  readonly verifyIdentity: PeerReachabilityPeer['verifyIdentity'];
}): SignedPeerReachabilityLeaseV1 {
  const signed = decodeSignedPeerReachabilityLease(input.value);
  if (signed.lease.peerId !== input.expectedPeerId) {
    throw new Error('Peer reachability lease belongs to a different peer');
  }
  if (
    !input.verifyIdentity(signed.lease.peerId, peerReachabilityLeaseSigningBytes(signed.lease), {
      publicKey: Buffer.from(signed.publicKey, 'base64url'),
      signature: Buffer.from(signed.signature, 'base64url'),
    })
  ) {
    throw new Error('Peer reachability lease signature is invalid');
  }
  return signed;
}

export function peerReachabilityLeaseSigningBytes(lease: PeerReachabilityLeaseV1): Buffer {
  return Buffer.from(
    `maka.peer-reachability.lease.v1\n${JSON.stringify({
      coordinationRoutes: lease.coordinationRoutes,
      directRoutes: lease.directRoutes,
      expiresAt: lease.expiresAt,
      issuedAt: lease.issuedAt,
      peerId: lease.peerId,
      revision: lease.revision,
      version: lease.version,
    })}`,
  );
}

export function samePeerReachabilityRoutes(
  lease: PeerReachabilityLeaseV1,
  reachability: ReturnType<PeerReachabilityPeer['reachability']>,
): boolean {
  return (
    sameStrings(lease.directRoutes, reachability.listenAddresses) &&
    sameStrings(lease.coordinationRoutes, reachability.activeCoordinationRelays)
  );
}

export function peerReachabilityLeaseReceipt(input: {
  readonly signed: SignedPeerReachabilityLeaseV1;
  readonly wallNow: number;
  readonly monotonicNow: number;
  readonly previous?: PeerReachabilityLeaseReceipt;
}): PeerReachabilityLeaseReceipt {
  const { signed, previous } = input;
  if (
    previous?.peerId === signed.lease.peerId &&
    previous.revision === signed.lease.revision &&
    previous.signature === signed.signature
  ) {
    return previous;
  }
  if (!Number.isFinite(input.wallNow) || !Number.isFinite(input.monotonicNow)) {
    throw new Error('Invalid peer reachability receipt clock');
  }
  const signedLifetime = signed.lease.expiresAt - signed.lease.issuedAt;
  const wallRemaining = Math.max(0, signed.lease.expiresAt - input.wallNow);
  return Object.freeze({
    peerId: signed.lease.peerId,
    revision: signed.lease.revision,
    signature: signed.signature,
    currentUntil: input.monotonicNow + Math.min(signedLifetime, wallRemaining),
  });
}

export function isPeerReachabilityLeaseCurrent(
  signed: SignedPeerReachabilityLeaseV1,
  receipt: PeerReachabilityLeaseReceipt | undefined,
  monotonicNow: number,
): boolean {
  return Boolean(
    receipt &&
      receipt.peerId === signed.lease.peerId &&
      receipt.revision === signed.lease.revision &&
      receipt.signature === signed.signature &&
      receipt.currentUntil > monotonicNow,
  );
}

export function isPeerReachabilityLeaseRecoverable(
  lease: PeerReachabilityLeaseV1,
  now: number,
): boolean {
  return lease.expiresAt > now - PEER_REACHABILITY_RECOVERY_HORIZON_MS;
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return record;
}

function token(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /\s|[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid peer reachability ${label}`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Invalid peer reachability ${label}`);
  }
  return value as number;
}

function addresses(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > PEER_REACHABILITY_MAX_ROUTES_PER_CLASS) {
    throw new Error(`Invalid peer reachability ${label}`);
  }
  const result = value.map((address) => {
    if (
      typeof address !== 'string' ||
      address.length === 0 ||
      Buffer.byteLength(address, 'utf8') > ADDRESS_MAX_BYTES ||
      !address.startsWith('/') ||
      /\s|[\u0000-\u001f\u007f]/u.test(address)
    ) {
      throw new Error(`Invalid peer reachability ${label}`);
    }
    return address;
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`Duplicate peer reachability ${label}`);
  }
  return result;
}

function proof(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid peer reachability ${label}`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.length === 0 ||
    bytes.length > PROOF_MAX_BYTES ||
    bytes.toString('base64url') !== value
  ) {
    throw new Error(`Invalid peer reachability ${label}`);
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
