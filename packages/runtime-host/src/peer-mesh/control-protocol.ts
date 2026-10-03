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
  decodeSignedPeerMeshMemberAdvertisement,
  decodeSignedPeerMeshRoster,
  PEER_MESH_MAX_MEMBERS,
  type SignedPeerMeshMemberAdvertisementV1,
  type SignedPeerMeshRosterV1,
} from './model.js';
import {
  decodeSignedPeerReachabilityLease,
  type SignedPeerReachabilityLeaseV1,
} from '../peer-reachability/model.js';

export const EVIDENCE_PAGE_SIZE = 2;

export interface RedeemInvitationRequest {
  readonly kind: 'redeem-invitation';
  readonly meshId: string;
  readonly secret: string;
  readonly reachability: SignedPeerReachabilityLeaseV1;
  readonly advertisement: SignedPeerMeshMemberAdvertisementV1;
}

export type RedeemInvitationResponse =
  | {
      readonly kind: 'invitation-redeemed';
      readonly roster: SignedPeerMeshRosterV1;
      readonly reachability: readonly SignedPeerReachabilityLeaseV1[];
      readonly advertisements: readonly SignedPeerMeshMemberAdvertisementV1[];
    }
  | {
      readonly kind: 'invitation-rejected';
      readonly reason: RedeemInvitationRejectionReason;
    };

export type RedeemInvitationRejectionReason = 'invalid' | 'expired' | 'closed' | 'full';

export interface PeerMeshEvidenceSummary {
  readonly peerId: string;
  readonly revision: number;
  readonly digest: string;
}

export interface SyncPeerMeshRequest {
  readonly kind: 'sync';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
  readonly reachability: SignedPeerReachabilityLeaseV1;
  readonly advertisement: SignedPeerMeshMemberAdvertisementV1;
  readonly knownReachability: readonly PeerMeshEvidenceSummary[];
  readonly knownAdvertisements: readonly PeerMeshEvidenceSummary[];
}

export type SyncPeerMeshResponse =
  | {
      readonly kind: 'sync-result';
      readonly roster: SignedPeerMeshRosterV1;
      readonly reachability: readonly SignedPeerReachabilityLeaseV1[];
      readonly advertisements: readonly SignedPeerMeshMemberAdvertisementV1[];
      readonly more: boolean;
    }
  | { readonly kind: 'sync-rejected'; readonly reason: 'unknown' };

export interface LeavePeerMeshRequest {
  readonly kind: 'leave';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
}

export type LeavePeerMeshResponse =
  | { readonly kind: 'left'; readonly roster: SignedPeerMeshRosterV1 }
  | { readonly kind: 'leave-rejected'; readonly reason: 'unknown' };

export interface AnnouncePeerMeshRosterRequest {
  readonly kind: 'announce-roster';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
}

export type AnnouncePeerMeshRosterResponse =
  | { readonly kind: 'roster-observed' }
  | { readonly kind: 'roster-rejected'; readonly reason: 'unknown' };

type PeerMeshControlRequest =
  | RedeemInvitationRequest
  | SyncPeerMeshRequest
  | LeavePeerMeshRequest
  | AnnouncePeerMeshRosterRequest;

export function decodeControlRequest(value: unknown): PeerMeshControlRequest {
  const record = recordValue(value);
  if (
    record.kind === 'redeem-invitation' &&
    hasExactKeys(record, ['kind', 'meshId', 'secret', 'reachability', 'advertisement'])
  ) {
    return {
      kind: 'redeem-invitation',
      meshId: requiredString(record.meshId, 128),
      secret: requiredString(record.secret, 64),
      reachability: decodeSignedPeerReachabilityLease(record.reachability),
      advertisement: decodeSignedPeerMeshMemberAdvertisement(record.advertisement),
    };
  }
  if (
    record.kind === 'sync' &&
    hasExactKeys(record, [
      'kind',
      'meshId',
      'roster',
      'reachability',
      'advertisement',
      'knownReachability',
      'knownAdvertisements',
    ])
  ) {
    return {
      kind: 'sync',
      meshId: requiredString(record.meshId, 128),
      roster: decodeSignedPeerMeshRoster(record.roster),
      reachability: decodeSignedPeerReachabilityLease(record.reachability),
      advertisement: decodeSignedPeerMeshMemberAdvertisement(record.advertisement),
      knownReachability: decodeEvidenceSummaries(record.knownReachability),
      knownAdvertisements: decodeEvidenceSummaries(record.knownAdvertisements),
    };
  }
  if (record.kind === 'leave' && hasExactKeys(record, ['kind', 'meshId', 'roster'])) {
    return {
      kind: 'leave',
      meshId: requiredString(record.meshId, 128),
      roster: decodeSignedPeerMeshRoster(record.roster),
    };
  }
  if (record.kind === 'announce-roster' && hasExactKeys(record, ['kind', 'meshId', 'roster'])) {
    return {
      kind: 'announce-roster',
      meshId: requiredString(record.meshId, 128),
      roster: decodeSignedPeerMeshRoster(record.roster),
    };
  }
  throw new Error('Unsupported Peer Mesh control request');
}

export function decodeRedeemResponse(value: unknown): RedeemInvitationResponse {
  const record = recordValue(value);
  if (
    record.kind === 'invitation-redeemed' &&
    hasExactKeys(record, ['kind', 'roster', 'reachability', 'advertisements'])
  ) {
    const reachability = decodeReachabilityPage(record.reachability);
    const advertisements = decodeAdvertisementPage(record.advertisements);
    assertEvidencePageSize(reachability, advertisements);
    return {
      kind: 'invitation-redeemed',
      roster: decodeSignedPeerMeshRoster(record.roster),
      reachability,
      advertisements,
    };
  }
  if (
    record.kind === 'invitation-rejected' &&
    hasExactKeys(record, ['kind', 'reason']) &&
    (record.reason === 'invalid' ||
      record.reason === 'expired' ||
      record.reason === 'closed' ||
      record.reason === 'full')
  ) {
    return { kind: 'invitation-rejected', reason: record.reason };
  }
  throw new Error('Invalid Peer Mesh control response');
}

export function decodeSyncResponse(value: unknown): SyncPeerMeshResponse {
  const record = recordValue(value);
  if (
    record.kind === 'sync-result' &&
    hasExactKeys(record, ['kind', 'roster', 'reachability', 'advertisements', 'more']) &&
    typeof record.more === 'boolean'
  ) {
    const reachability = decodeReachabilityPage(record.reachability);
    const advertisements = decodeAdvertisementPage(record.advertisements);
    assertEvidencePageSize(reachability, advertisements);
    return {
      kind: 'sync-result',
      roster: decodeSignedPeerMeshRoster(record.roster),
      reachability,
      advertisements,
      more: record.more,
    };
  }
  if (
    record.kind === 'sync-rejected' &&
    hasExactKeys(record, ['kind', 'reason']) &&
    record.reason === 'unknown'
  ) {
    return { kind: 'sync-rejected', reason: record.reason };
  }
  throw new Error('Invalid Peer Mesh synchronization response');
}

export function decodeLeaveResponse(value: unknown): LeavePeerMeshResponse {
  const record = recordValue(value);
  if (record.kind === 'left' && hasExactKeys(record, ['kind', 'roster'])) {
    return { kind: 'left', roster: decodeSignedPeerMeshRoster(record.roster) };
  }
  if (
    record.kind === 'leave-rejected' &&
    hasExactKeys(record, ['kind', 'reason']) &&
    record.reason === 'unknown'
  ) {
    return { kind: 'leave-rejected', reason: 'unknown' };
  }
  throw new Error('Invalid Peer Mesh leave response');
}

export function decodeAnnounceRosterResponse(value: unknown): AnnouncePeerMeshRosterResponse {
  const record = recordValue(value);
  if (record.kind === 'roster-observed' && hasExactKeys(record, ['kind'])) {
    return { kind: 'roster-observed' };
  }
  if (
    record.kind === 'roster-rejected' &&
    hasExactKeys(record, ['kind', 'reason']) &&
    record.reason === 'unknown'
  ) {
    return { kind: 'roster-rejected', reason: 'unknown' };
  }
  throw new Error('Invalid Peer Mesh roster announcement response');
}

function decodeReachabilityPage(value: unknown): readonly SignedPeerReachabilityLeaseV1[] {
  if (!Array.isArray(value) || value.length > EVIDENCE_PAGE_SIZE) {
    throw new Error('Invalid Peer Mesh reachability page');
  }
  return Object.freeze(value.map(decodeSignedPeerReachabilityLease));
}

function decodeAdvertisementPage(value: unknown): readonly SignedPeerMeshMemberAdvertisementV1[] {
  if (!Array.isArray(value) || value.length > EVIDENCE_PAGE_SIZE) {
    throw new Error('Invalid Peer Mesh advertisement page');
  }
  return Object.freeze(value.map(decodeSignedPeerMeshMemberAdvertisement));
}

function assertEvidencePageSize(
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  advertisements: readonly SignedPeerMeshMemberAdvertisementV1[],
): void {
  if (reachability.length + advertisements.length > EVIDENCE_PAGE_SIZE) {
    throw new Error('Peer Mesh evidence page exceeds its bound');
  }
}

function decodeEvidenceSummaries(value: unknown): readonly PeerMeshEvidenceSummary[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_MEMBERS) {
    throw new Error('Invalid Peer Mesh evidence revisions');
  }
  const revisions = value.map((entry) => {
    const record = recordValue(entry);
    if (!hasExactKeys(record, ['peerId', 'revision', 'digest'])) {
      throw new Error('Invalid Peer Mesh evidence revision');
    }
    const revision = record.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw new Error('Invalid Peer Mesh evidence revision');
    }
    if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(record.digest)) {
      throw new Error('Invalid Peer Mesh evidence digest');
    }
    return Object.freeze({
      peerId: requiredString(record.peerId, 256),
      revision: revision as number,
      digest: record.digest,
    });
  });
  if (new Set(revisions.map(({ peerId }) => peerId)).size !== revisions.length) {
    throw new Error('Duplicate Peer Mesh evidence revision');
  }
  return Object.freeze(revisions);
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Peer Mesh control frame');
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  );
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error('Invalid Peer Mesh control value');
  }
  return value;
}
