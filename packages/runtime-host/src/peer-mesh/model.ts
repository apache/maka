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

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import {
  decodePeerMeshInvitation as decodePeerMeshInvitationWire,
  type PeerMeshInvitationV1,
} from '../protocol/peer-mesh.js';
import {
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_ROUTE_HINTS,
  PEER_MESH_ROUTE_RECORD_MAX_BYTES,
} from './limits.js';
import { canonicalPeerMeshDisplayName } from './display-name.js';

export {
  PEER_MESH_MAX_INVITATION_RECORDS,
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_MESHES,
  PEER_MESH_MAX_PENDING_INVITATIONS,
  PEER_MESH_MAX_ROUTE_HINTS,
  PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY,
  PEER_MESH_MAX_TRANSIT_RELAY_ADDRESSES,
  PEER_MESH_ROUTE_RECORD_MAX_BYTES,
} from './limits.js';

export interface PeerMeshRosterV1 {
  readonly version: 1;
  readonly meshId: string;
  readonly revision: number;
  readonly members: readonly string[];
  readonly closed: boolean;
  readonly displayName?: string;
}

export interface SignedPeerMeshRosterV1 {
  readonly roster: PeerMeshRosterV1;
  readonly authorityPublicKey: string;
  readonly signature: string;
}

export interface PeerMeshAuthorityTarget {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
}

export interface PeerMeshAuthorityKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface PeerMeshRouteRecordV1 extends PeerMeshAuthorityTarget {
  readonly version: 1;
  readonly sequence: number;
  readonly expiresAt: number;
  readonly endpointKind?: 'client' | 'host';
  readonly displayName?: string;
  readonly transitMeshId?: string;
}

export interface SignedPeerMeshRouteRecordV1 {
  readonly route: PeerMeshRouteRecordV1;
  readonly publicKey: string;
  readonly signature: string;
}

export function generatePeerMeshAuthorityKeyPair(): PeerMeshAuthorityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  });
}

export function peerMeshId(authorityPublicKey: string): string {
  decodePublicKey(authorityPublicKey);
  return `mesh_${createHash('sha256').update(authorityPublicKey).digest('base64url')}`;
}

export function signPeerMeshRoster(
  roster: PeerMeshRosterV1,
  keys: PeerMeshAuthorityKeyPair,
): SignedPeerMeshRosterV1 {
  const canonical = canonicalPeerMeshRoster(roster);
  if (canonical.meshId !== peerMeshId(keys.publicKey)) {
    throw new Error('Peer Mesh roster does not belong to the authority key');
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(keys.privateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Peer Mesh authority key must be Ed25519');
  }
  return Object.freeze({
    roster: canonical,
    authorityPublicKey: keys.publicKey,
    signature: sign(null, encodeRoster(canonical), privateKey).toString('base64url'),
  });
}

export function validatePeerMeshAuthorityKeyPair(keys: PeerMeshAuthorityKeyPair): void {
  let privateKey;
  try {
    privateKey = createPrivateKey({
      key: decodeCanonicalBase64Url(keys.privateKey, 'authority private key'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (error) {
    throw new Error('Invalid Peer Mesh authority private key', { cause: error });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Peer Mesh authority key must be Ed25519');
  }
  const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (derived.toString('base64url') !== keys.publicKey) {
    throw new Error('Peer Mesh authority private key does not match its public key');
  }
}

export function decodeSignedPeerMeshRoster(value: unknown): SignedPeerMeshRosterV1 {
  const record = exactObject(value, 'signed Peer Mesh roster', [
    'roster',
    'authorityPublicKey',
    'signature',
  ]);
  const authorityPublicKey = string(record.authorityPublicKey, 'authorityPublicKey', 256);
  const roster = canonicalPeerMeshRoster(record.roster);
  if (roster.meshId !== peerMeshId(authorityPublicKey)) {
    throw new Error('Peer Mesh roster has the wrong authority');
  }
  const signature = string(record.signature, 'signature', 128);
  const signatureBytes = decodeCanonicalBase64Url(signature, 'roster signature');
  if (signatureBytes.length !== 64) throw new Error('Invalid Peer Mesh roster signature');
  const verified = verify(
    null,
    encodeRoster(roster),
    decodePublicKey(authorityPublicKey),
    signatureBytes,
  );
  if (!verified) throw new Error('Peer Mesh roster signature is invalid');
  return Object.freeze({ roster, authorityPublicKey, signature });
}

export function createPeerMeshInvitationSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function peerMeshInvitationSecretDigest(secret: string): string {
  return createHash('sha256').update(decodeSecret(secret)).digest('base64url');
}

export function matchesPeerMeshInvitationSecret(secret: string, expectedDigest: string): boolean {
  const actual = Buffer.from(peerMeshInvitationSecretDigest(secret), 'base64url');
  const expected = Buffer.from(expectedDigest, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validatePeerMeshInvitation(value: unknown): PeerMeshInvitationV1 {
  const invitation = decodePeerMeshInvitationWire(value);
  const authorityPublicKey = invitation.authorityPublicKey;
  const meshId = invitation.meshId;
  if (meshId !== peerMeshId(authorityPublicKey)) {
    throw new Error('Peer Mesh invitation has the wrong authority');
  }
  return Object.freeze({
    ...invitation,
    secret: validateSecret(invitation.secret),
  });
}

export function canonicalPeerMeshRoster(value: unknown): PeerMeshRosterV1 {
  const keys = ['version', 'meshId', 'revision', 'members', 'closed'];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'displayName')) keys.push('displayName');
  }
  const record = exactObject(value, 'Peer Mesh roster', keys);
  if (record.version !== 1) throw new Error('Unsupported Peer Mesh roster version');
  const members = stringArray(record.members, 'members', PEER_MESH_MAX_MEMBERS, 256)
    .map((member) => token(member, 'member', 256))
    .sort();
  if (members.length === 0 || new Set(members).size !== members.length) {
    throw new Error('Peer Mesh roster members must be unique and non-empty');
  }
  if (typeof record.closed !== 'boolean') throw new Error('Invalid Peer Mesh roster closed');
  return Object.freeze({
    version: 1,
    meshId: string(record.meshId, 'meshId', 128),
    revision: integer(record.revision, 'revision', 1),
    members: Object.freeze(members),
    closed: record.closed,
    ...(record.displayName === undefined
      ? {}
      : { displayName: canonicalPeerMeshDisplayName(record.displayName) }),
  });
}

export function decodeAuthorityTarget(value: unknown): PeerMeshAuthorityTarget {
  const record = exactObject(value, 'Peer Mesh authority target', [
    'peerId',
    'routeHints',
    'coordinationRelays',
  ]);
  return Object.freeze({
    peerId: token(record.peerId, 'peerId', 256),
    routeHints: Object.freeze(addressArray(record.routeHints, 'routeHints')),
    coordinationRelays: Object.freeze(
      addressArray(record.coordinationRelays, 'coordinationRelays'),
    ),
  });
}

export function canonicalPeerMeshRouteRecord(value: unknown): PeerMeshRouteRecordV1 {
  const keys = ['version', 'peerId', 'sequence', 'expiresAt', 'routeHints', 'coordinationRelays'];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'endpointKind')) keys.push('endpointKind');
    if (Object.hasOwn(value, 'displayName')) keys.push('displayName');
    if (Object.hasOwn(value, 'transitMeshId')) keys.push('transitMeshId');
  }
  const record = exactObject(value, 'Peer Mesh route record', keys);
  if (record.version !== 1) throw new Error('Unsupported Peer Mesh route record version');
  if (
    record.endpointKind !== undefined &&
    record.endpointKind !== 'client' &&
    record.endpointKind !== 'host'
  ) {
    throw new Error('Invalid Peer Mesh endpoint kind');
  }
  const route = Object.freeze({
    version: 1 as const,
    peerId: token(record.peerId, 'peerId', 256),
    sequence: integer(record.sequence, 'route sequence', 1),
    expiresAt: integer(record.expiresAt, 'route expiry', 1),
    routeHints: Object.freeze(addressArray(record.routeHints, 'routeHints')),
    coordinationRelays: Object.freeze(
      addressArray(record.coordinationRelays, 'coordinationRelays'),
    ),
    ...(record.endpointKind === undefined ? {} : { endpointKind: record.endpointKind }),
    ...(record.displayName === undefined
      ? {}
      : { displayName: canonicalPeerMeshDisplayName(record.displayName) }),
    ...(record.transitMeshId === undefined
      ? {}
      : { transitMeshId: string(record.transitMeshId, 'transitMeshId', 128) }),
  });
  if (peerMeshRouteRecordSigningBytes(route).byteLength > PEER_MESH_ROUTE_RECORD_MAX_BYTES) {
    throw new Error('Peer Mesh route record is too large');
  }
  return route;
}

export function decodeSignedPeerMeshRouteRecord(value: unknown): SignedPeerMeshRouteRecordV1 {
  const record = exactObject(value, 'signed Peer Mesh route record', [
    'route',
    'publicKey',
    'signature',
  ]);
  const publicKey = canonicalProof(record.publicKey, 'route public key', 256);
  const signature = canonicalProof(record.signature, 'route signature', 256);
  return Object.freeze({
    route: canonicalPeerMeshRouteRecord(record.route),
    publicKey,
    signature,
  });
}

export function peerMeshRouteRecordSigningBytes(route: PeerMeshRouteRecordV1): Buffer {
  return Buffer.from(
    `maka.peer-mesh.route.v1\n${JSON.stringify({
      coordinationRelays: route.coordinationRelays,
      ...(route.displayName ? { displayName: route.displayName } : {}),
      ...(route.endpointKind ? { endpointKind: route.endpointKind } : {}),
      expiresAt: route.expiresAt,
      peerId: route.peerId,
      routeHints: route.routeHints,
      sequence: route.sequence,
      ...(route.transitMeshId ? { transitMeshId: route.transitMeshId } : {}),
      version: route.version,
    })}`,
  );
}

function encodeRoster(roster: PeerMeshRosterV1): Buffer {
  return Buffer.from(
    `maka.peer-mesh.roster.v1\n${JSON.stringify({
      closed: roster.closed,
      ...(roster.displayName ? { displayName: roster.displayName } : {}),
      members: roster.members,
      meshId: roster.meshId,
      revision: roster.revision,
      version: roster.version,
    })}`,
  );
}

function decodePublicKey(encoded: string) {
  try {
    const key = createPublicKey({
      key: decodeCanonicalBase64Url(encoded, 'authority public key'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Peer Mesh authority key must be Ed25519');
    }
    return key;
  } catch (error) {
    throw new Error('Invalid Peer Mesh authority public key', { cause: error });
  }
}

function validateSecret(value: unknown): string {
  const secret = string(value, 'secret', 64);
  decodeSecret(secret);
  return secret;
}

function decodeSecret(secret: string): Buffer {
  const bytes = decodeCanonicalBase64Url(secret, 'invitation secret');
  if (bytes.length !== 32) {
    throw new Error('Invalid Peer Mesh invitation secret');
  }
  return bytes;
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return bytes;
}

function canonicalProof(value: unknown, label: string, maxBytes: number): string {
  const encoded = string(value, label, Math.ceil((maxBytes * 4) / 3));
  const bytes = decodeCanonicalBase64Url(encoded, label);
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return encoded;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = object(value, label);
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return record;
}

function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return value;
}

function token(value: unknown, label: string, max: number): string {
  const result = string(value, label, max);
  if (/\s|[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return result;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return value.map((item) => string(item, label, maxLength));
}

function addressArray(value: unknown, label: string): string[] {
  const addresses = stringArray(value, label, PEER_MESH_MAX_ROUTE_HINTS, 1024);
  if (
    addresses.some(
      (address) => !address.startsWith('/') || /\s|[\u0000-\u001f\u007f]/u.test(address),
    ) ||
    new Set(addresses).size !== addresses.length
  ) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return addresses;
}
