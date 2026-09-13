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
import { canonicalPeerMeshDisplayName } from '../peer-mesh/display-name.js';
import { PEER_MESH_MAX_MEMBERS, PEER_MESH_MAX_MESHES } from '../peer-mesh/limits.js';
import {
  decodeSignedPeerReachabilityLease,
  type SignedPeerReachabilityLeaseV1,
} from '../peer-reachability/model.js';

const PEER_ID_MAX_BYTES = 256;
const MESH_ID_MAX_BYTES = 128;

export interface PeerMeshInvitationV1 {
  readonly version: 1;
  readonly meshId: string;
  readonly authorityPublicKey: string;
  readonly secret: string;
  readonly expiresAt: number;
  readonly reachability: SignedPeerReachabilityLeaseV1;
}

export interface PeerMeshProjection {
  readonly meshId: string;
  readonly displayName?: string;
  readonly role: 'authority' | 'member';
  readonly authorityPeerId: string;
  readonly revision: number;
  readonly closed: boolean;
  readonly members: readonly PeerMeshMemberProjection[];
  readonly pendingInvitationCount: number;
}

export interface PeerMeshMemberProjection {
  readonly peerId: string;
  readonly endpointKind?: 'client' | 'host';
  readonly displayName?: string;
  readonly state: 'local' | 'connecting' | 'reachable' | 'reconnecting' | 'needs_repair';
  readonly expiresAt?: number;
}

export interface PeerMeshQueryResult {
  readonly available: boolean;
  readonly localPeerId?: string;
  readonly localDisplayName?: string;
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

export interface PeerMeshDisplayNameSetInput {
  readonly displayName: string | null;
}

export interface PeerMeshRenameInput extends PeerMeshTargetInput {
  readonly displayName: string | null;
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
  'peer.mesh.display-name.set': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshDisplayNameSetInput,
    decodeOutput: decodePeerMeshQueryResult,
  }),
  'peer.mesh.rename': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: MUTATION_ERRORS,
    decodeInput: decodePeerMeshRenameInput,
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

function decodePeerMeshDisplayNameSetInput(value: unknown): PeerMeshDisplayNameSetInput {
  const record = requireExactRecord(value, 'Peer Mesh display name input', ['displayName']);
  return {
    displayName:
      record.displayName === null ? null : canonicalPeerMeshDisplayName(record.displayName),
  };
}

function decodePeerMeshRenameInput(value: unknown): PeerMeshRenameInput {
  const record = requireExactRecord(value, 'Peer Mesh rename input', ['meshId', 'displayName']);
  return {
    meshId: requireString(record.meshId, 'Peer Mesh meshId', MESH_ID_MAX_BYTES),
    displayName:
      record.displayName === null ? null : canonicalPeerMeshDisplayName(record.displayName),
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
    'reachability',
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
    reachability: decodeSignedPeerReachabilityLease(record.reachability),
  };
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
      : [
          'available',
          'localPeerId',
          ...(record.localDisplayName === undefined ? [] : ['localDisplayName']),
          'meshes',
          'transit',
        ],
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
          ...(record.localDisplayName === undefined
            ? {}
            : {
                localDisplayName: canonicalPeerMeshDisplayName(record.localDisplayName),
              }),
          transit: decodePeerMeshTransitProjection(record.transit),
        }),
    meshes: Object.freeze(record.meshes.map(decodePeerMeshProjection)),
  };
}

export function decodePeerMeshProjection(value: unknown): PeerMeshProjection {
  const valueRecord = requireRecord(value, 'Peer Mesh projection');
  const record = requireExactRecord(value, 'Peer Mesh projection', [
    'meshId',
    ...(valueRecord.displayName === undefined ? [] : ['displayName']),
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
    ...(record.displayName === undefined
      ? {}
      : { displayName: canonicalPeerMeshDisplayName(record.displayName) }),
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
  assertExactKeys(record, 'Peer Mesh member route', [
    'peerId',
    'state',
    ...(record.endpointKind === undefined ? [] : ['endpointKind']),
    ...(record.displayName === undefined ? [] : ['displayName']),
    ...(record.expiresAt === undefined ? [] : ['expiresAt']),
  ]);
  if (
    record.state !== 'local' &&
    record.state !== 'connecting' &&
    record.state !== 'reachable' &&
    record.state !== 'reconnecting' &&
    record.state !== 'needs_repair'
  ) {
    throw new Error('Invalid Peer Mesh member route state');
  }
  if (
    record.endpointKind !== undefined &&
    record.endpointKind !== 'client' &&
    record.endpointKind !== 'host'
  ) {
    throw new Error('Invalid Peer Mesh member endpoint kind');
  }
  return {
    peerId: requireString(record.peerId, 'Peer Mesh member route peerId', PEER_ID_MAX_BYTES),
    ...(record.endpointKind === undefined ? {} : { endpointKind: record.endpointKind }),
    ...(record.displayName === undefined
      ? {}
      : { displayName: canonicalPeerMeshDisplayName(record.displayName) }),
    state: record.state,
    ...(record.expiresAt === undefined
      ? {}
      : {
          expiresAt: requireCount(record.expiresAt, 'Peer Mesh member route expiry'),
        }),
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
