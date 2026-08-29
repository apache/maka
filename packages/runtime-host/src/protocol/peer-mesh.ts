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
  assertExactKeys,
  requireCount,
  requireExactRecord,
  requireRecord,
  requireString,
} from './codec.js';
import { defineOperation } from './operation-spec.js';
import {
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_MESHES,
  PEER_MESH_MAX_ROUTE_HINTS,
} from '../peer-mesh/limits.js';

const PEER_ID_MAX_BYTES = 256;
const MESH_ID_MAX_BYTES = 128;
const MESH_ADDRESS_MAX_LENGTH = 1024;

export interface PeerMeshInvitationV1 {
  readonly version: 1;
  readonly meshId: string;
  readonly authorityPublicKey: string;
  readonly secret: string;
  readonly expiresAt: number;
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
}

export interface PeerMeshProjection {
  readonly meshId: string;
  readonly role: 'authority' | 'member';
  readonly authorityPeerId: string;
  readonly revision: number;
  readonly closed: boolean;
  readonly members: readonly PeerMeshMemberProjection[];
  readonly pendingInvitationCount: number;
}

export interface PeerMeshMemberProjection {
  readonly peerId: string;
  readonly state: 'local' | 'route_available' | 'coordination_only' | 'stale' | 'unknown';
  readonly expiresAt?: number;
}

export interface PeerMeshQueryResult {
  readonly available: boolean;
  readonly localPeerId?: string;
  readonly meshes: readonly PeerMeshProjection[];
  readonly transit?: PeerMeshTransitProjection;
}

export interface PeerMeshTransitProjection {
  readonly meshId: string | null;
  readonly allowedMemberCount: number;
  readonly activeReservationCount: number;
  readonly activeCircuitCount: number;
  readonly maxReservationCount: number;
  readonly maxCircuitCount: number;
  readonly maxCircuitsPerPeer: number;
  readonly maxCircuitDurationSeconds: number;
  readonly maxCircuitBytes: number;
}

export interface PeerMeshTargetInput {
  readonly meshId: string;
}

export type PeerMeshInviteInput = PeerMeshTargetInput;

export interface PeerMeshJoinInput {
  readonly invitation: PeerMeshInvitationV1;
}

export interface PeerMeshRemoveInput extends PeerMeshTargetInput {
  readonly peerId: string;
}

export interface PeerMeshTransitSetInput {
  readonly meshId: string | null;
}

export interface PeerMeshInvitationResult {
  readonly invitation: PeerMeshInvitationV1;
  readonly snapshot: PeerMeshQueryResult;
}

const MUTATION_ERRORS = [
  'invalid_request',
  'operation_unavailable',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export const PEER_MESH_OPERATION_SPECS = {
  'peer.mesh.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: ['operation_unavailable', 'internal_failure'] as const,
    decodeInput: decodeEmptyInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.create': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeEmptyInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.invite': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshInviteInput,
    decodeOutput: decodePeerMeshInvitationResult,
  }),
  'peer.mesh.join': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshJoinInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.remove': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshRemoveInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.leave': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshTargetInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.close': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshTargetInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.reconcile': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodeEmptyInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.transit.set': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshTransitSetInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
} as const;

function decodeEmptyInput(value: unknown): Record<string, never> {
  requireExactRecord(value, 'Peer Mesh operation input', []);
  return {};
}

function decodePeerMeshTargetInput(value: unknown): PeerMeshTargetInput {
  const record = requireExactRecord(value, 'Peer Mesh target input', ['meshId']);
  return {
    meshId: requireString(record.meshId, 'Peer Mesh meshId', MESH_ID_MAX_BYTES),
  };
}

function decodePeerMeshInviteInput(value: unknown): PeerMeshInviteInput {
  return decodePeerMeshTargetInput(value);
}

function decodePeerMeshJoinInput(value: unknown): PeerMeshJoinInput {
  const record = requireExactRecord(value, 'Peer Mesh join input', ['invitation']);
  return { invitation: decodePeerMeshInvitation(record.invitation) };
}

export function decodePeerMeshInvitation(value: unknown): PeerMeshInvitationV1 {
  const record = requireExactRecord(value, 'Peer Mesh invitation', [
    'version',
    'meshId',
    'authorityPublicKey',
    'secret',
    'expiresAt',
    'peerId',
    'routeHints',
    'coordinationRelays',
  ]);
  if (record.version !== 1) throw new Error('Unsupported Peer Mesh invitation version');
  return {
    version: 1,
    meshId: requireString(record.meshId, 'Peer Mesh meshId', MESH_ID_MAX_BYTES),
    authorityPublicKey: requireString(
      record.authorityPublicKey,
      'Peer Mesh authority public key',
      PEER_ID_MAX_BYTES,
    ),
    secret: requireString(record.secret, 'Peer Mesh invitation secret', 64),
    expiresAt: requireCount(record.expiresAt, 'Peer Mesh invitation expiry'),
    peerId: requireMeshToken(record.peerId, 'Peer Mesh authority peerId'),
    routeHints: requireMeshAddresses(record.routeHints, 'Peer Mesh route hints'),
    coordinationRelays: requireMeshAddresses(
      record.coordinationRelays,
      'Peer Mesh coordination relays',
    ),
  };
}

function requireMeshToken(value: unknown, label: string): string {
  const result = requireString(value, label, PEER_ID_MAX_BYTES);
  if (/\s|[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`Invalid ${label}`);
  return result;
}

function requireMeshAddresses(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_ROUTE_HINTS) {
    throw new Error(`Invalid ${label}`);
  }
  const addresses = value.map((address) => requireString(address, label, MESH_ADDRESS_MAX_LENGTH));
  if (
    addresses.some(
      (address) => !address.startsWith('/') || /\s|[\u0000-\u001f\u007f]/u.test(address),
    ) ||
    new Set(addresses).size !== addresses.length
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return Object.freeze(addresses);
}

function decodePeerMeshRemoveInput(value: unknown): PeerMeshRemoveInput {
  const record = requireExactRecord(value, 'Peer Mesh remove input', ['meshId', 'peerId']);
  return {
    meshId: requireString(record.meshId, 'Peer Mesh meshId', MESH_ID_MAX_BYTES),
    peerId: requireString(record.peerId, 'Peer Mesh peerId', PEER_ID_MAX_BYTES),
  };
}

function decodePeerMeshTransitSetInput(value: unknown): PeerMeshTransitSetInput {
  const record = requireExactRecord(value, 'Peer Mesh transit input', ['meshId']);
  return {
    meshId:
      record.meshId === null
        ? null
        : requireString(record.meshId, 'Peer Mesh meshId', MESH_ID_MAX_BYTES),
  };
}

export function decodePeerMeshQueryResult(value: unknown): PeerMeshQueryResult {
  const record = requireRecord(value, 'Peer Mesh query result');
  assertExactKeys(
    record,
    'Peer Mesh query result',
    record.localPeerId === undefined
      ? ['available', 'meshes']
      : ['available', 'localPeerId', 'meshes', 'transit'],
  );
  if (
    typeof record.available !== 'boolean' ||
    !Array.isArray(record.meshes) ||
    record.meshes.length > PEER_MESH_MAX_MESHES
  ) {
    throw new Error('Invalid Peer Mesh query result');
  }
  const localPeerId = record.localPeerId;
  if (record.available !== (localPeerId !== undefined)) {
    throw new Error('Invalid Peer Mesh availability result');
  }
  return {
    available: record.available,
    ...(localPeerId === undefined
      ? {}
      : {
          localPeerId: requireString(localPeerId, 'Peer Mesh localPeerId', PEER_ID_MAX_BYTES),
          transit: decodePeerMeshTransitProjection(record.transit),
        }),
    meshes: Object.freeze(record.meshes.map(decodePeerMeshProjection)),
  };
}

export function decodePeerMeshProjection(value: unknown): PeerMeshProjection {
  const record = requireExactRecord(value, 'Peer Mesh projection', [
    'meshId',
    'role',
    'authorityPeerId',
    'revision',
    'closed',
    'members',
    'pendingInvitationCount',
  ]);
  if (
    (record.role !== 'authority' && record.role !== 'member') ||
    typeof record.closed !== 'boolean' ||
    !Array.isArray(record.members) ||
    record.members.length > PEER_MESH_MAX_MEMBERS
  ) {
    throw new Error('Invalid Peer Mesh projection');
  }
  const members = record.members.map(decodePeerMeshMemberProjection);
  if (new Set(members.map(({ peerId }) => peerId)).size !== members.length) {
    throw new Error('Duplicate Peer Mesh member');
  }
  return {
    meshId: requireString(record.meshId, 'Peer Mesh meshId', MESH_ID_MAX_BYTES),
    role: record.role,
    authorityPeerId: requireString(
      record.authorityPeerId,
      'Peer Mesh authorityPeerId',
      PEER_ID_MAX_BYTES,
    ),
    revision: requireCount(record.revision, 'Peer Mesh revision'),
    closed: record.closed,
    members: Object.freeze(members),
    pendingInvitationCount: requireCount(
      record.pendingInvitationCount,
      'Peer Mesh pendingInvitationCount',
    ),
  };
}

function decodePeerMeshTransitProjection(value: unknown): PeerMeshTransitProjection {
  const record = requireExactRecord(value, 'Peer Mesh transit projection', [
    'meshId',
    'allowedMemberCount',
    'activeReservationCount',
    'activeCircuitCount',
    'maxReservationCount',
    'maxCircuitCount',
    'maxCircuitsPerPeer',
    'maxCircuitDurationSeconds',
    'maxCircuitBytes',
  ]);
  return {
    meshId:
      record.meshId === null
        ? null
        : requireString(record.meshId, 'Peer Mesh transit meshId', MESH_ID_MAX_BYTES),
    allowedMemberCount: requireCount(record.allowedMemberCount, 'allowedMemberCount'),
    activeReservationCount: requireCount(record.activeReservationCount, 'activeReservationCount'),
    activeCircuitCount: requireCount(record.activeCircuitCount, 'activeCircuitCount'),
    maxReservationCount: requireCount(record.maxReservationCount, 'maxReservationCount'),
    maxCircuitCount: requireCount(record.maxCircuitCount, 'maxCircuitCount'),
    maxCircuitsPerPeer: requireCount(record.maxCircuitsPerPeer, 'maxCircuitsPerPeer'),
    maxCircuitDurationSeconds: requireCount(
      record.maxCircuitDurationSeconds,
      'maxCircuitDurationSeconds',
    ),
    maxCircuitBytes: requireCount(record.maxCircuitBytes, 'maxCircuitBytes'),
  };
}

function decodePeerMeshMemberProjection(value: unknown): PeerMeshMemberProjection {
  const record = requireRecord(value, 'Peer Mesh member route');
  assertExactKeys(
    record,
    'Peer Mesh member route',
    record.expiresAt === undefined ? ['peerId', 'state'] : ['peerId', 'state', 'expiresAt'],
  );
  if (
    record.state !== 'local' &&
    record.state !== 'route_available' &&
    record.state !== 'coordination_only' &&
    record.state !== 'stale' &&
    record.state !== 'unknown'
  ) {
    throw new Error('Invalid Peer Mesh member route state');
  }
  return {
    peerId: requireString(record.peerId, 'Peer Mesh member route peerId', PEER_ID_MAX_BYTES),
    state: record.state,
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: requireCount(record.expiresAt, 'Peer Mesh member route expiry') }),
  };
}

export function decodePeerMeshInvitationResult(value: unknown): PeerMeshInvitationResult {
  const record = requireExactRecord(value, 'Peer Mesh invitation result', [
    'invitation',
    'snapshot',
  ]);
  return {
    invitation: decodePeerMeshInvitation(record.invitation),
    snapshot: decodePeerMeshQueryResult(record.snapshot),
  };
}
