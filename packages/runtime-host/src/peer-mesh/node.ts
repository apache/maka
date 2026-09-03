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

import type { RuntimeHostPeerRouteResolution } from '../client/peer-client.js';
import type {
  RuntimeHostPeerIdentityProof,
  RuntimeHostPeerNativeStream,
  RuntimeHostPeerTransitRelayCandidate,
  RuntimeHostPeerTransitSnapshot,
} from '../transport/peer-native.js';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import {
  canonicalPeerMeshMemberAdvertisement,
  canonicalPeerMeshRoster,
  createPeerMeshInvitationSecret,
  validatePeerMeshInvitation,
  decodeSignedPeerMeshMemberAdvertisement,
  decodeSignedPeerMeshRoster,
  generatePeerMeshAuthorityKeyPair,
  matchesPeerMeshInvitationSecret,
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_MESHES,
  PEER_MESH_MAX_INVITATION_RECORDS,
  PEER_MESH_MAX_PENDING_INVITATIONS,
  PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY,
  PEER_MESH_MAX_TRANSIT_RELAY_ADDRESSES,
  peerMeshMemberAdvertisementSigningBytes,
  peerMeshId,
  peerMeshInvitationSecretDigest,
  signPeerMeshRoster,
  type SignedPeerMeshMemberAdvertisementV1,
  type SignedPeerMeshRosterV1,
} from './model.js';
import { canonicalPeerMeshDisplayName } from './display-name.js';
import type { PeerMeshInvitationV1 } from '../protocol/peer-mesh.js';
import {
  authenticateSignedPeerReachabilityLease,
  decodeSignedPeerReachabilityLease,
  isPeerReachabilityLeaseCurrent,
  PEER_REACHABILITY_MAX_CLOCK_SKEW_MS,
  peerReachabilityLeaseSigningBytes,
  peerReachabilityLeaseReceipt,
  PEER_REACHABILITY_RECOVERY_HORIZON_MS,
  verifySignedPeerReachabilityLease,
  type PeerReachabilityPublisher,
  type PeerReachabilityLeaseReceipt,
  type SignedPeerReachabilityLeaseV1,
} from '../peer-reachability/index.js';
import {
  authorityKeys,
  isActivePeerMeshMembership as isActiveMembership,
  isRetiredPeerMeshState as isRetired,
  openPeerMeshStateStore,
  type PendingPeerMeshJoin,
  type PeerMeshAuthorityStateV1,
  type PeerMeshReplicaStateV1,
  type PeerMeshStateStore,
  type PeerMeshStateV1,
  type PeerMeshStoredStateV1,
} from './store.js';

const CONTROL_FRAME_MAX_BYTES = 128 * 1024;
const DEFAULT_INVITATION_TTL_MS = 15 * 60 * 1_000;
const CONNECT_DEADLINE_MS = 30_000;
const CONTROL_REQUEST_DEADLINE_MS = 10_000;
const MAX_ACTIVE_CONTROL_STREAMS = 32;
const MAX_ACTIVE_CONTROL_STREAMS_PER_PEER = 2;
const EVIDENCE_PAGE_SIZE = 2;
const RECONCILE_CONCURRENCY = 4;
const RECONCILE_DEADLINE_MS = 60 * 1_000;
const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000;

interface RedeemInvitationRequest {
  readonly kind: 'redeem-invitation';
  readonly meshId: string;
  readonly secret: string;
  readonly reachability: SignedPeerReachabilityLeaseV1;
  readonly advertisement: SignedPeerMeshMemberAdvertisementV1;
}

type RedeemInvitationResponse =
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

type RedeemInvitationRejectionReason = 'invalid' | 'expired' | 'closed' | 'full';

interface PeerMeshEvidenceSummary {
  readonly peerId: string;
  readonly revision: number;
  readonly digest: string;
}

interface SyncPeerMeshRequest {
  readonly kind: 'sync';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
  readonly reachability: SignedPeerReachabilityLeaseV1;
  readonly advertisement: SignedPeerMeshMemberAdvertisementV1;
  readonly knownReachability: readonly PeerMeshEvidenceSummary[];
  readonly knownAdvertisements: readonly PeerMeshEvidenceSummary[];
}

type SyncPeerMeshResponse =
  | {
      readonly kind: 'sync-result';
      readonly roster: SignedPeerMeshRosterV1;
      readonly reachability: readonly SignedPeerReachabilityLeaseV1[];
      readonly advertisements: readonly SignedPeerMeshMemberAdvertisementV1[];
      readonly more: boolean;
    }
  | { readonly kind: 'sync-rejected'; readonly reason: 'unknown' };

interface LeavePeerMeshRequest {
  readonly kind: 'leave';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
}

type LeavePeerMeshResponse =
  | { readonly kind: 'left'; readonly roster: SignedPeerMeshRosterV1 }
  | { readonly kind: 'leave-rejected'; readonly reason: 'unknown' };

interface AnnouncePeerMeshRosterRequest {
  readonly kind: 'announce-roster';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
}

type AnnouncePeerMeshRosterResponse =
  | { readonly kind: 'roster-observed' }
  | { readonly kind: 'roster-rejected'; readonly reason: 'unknown' };

type PeerMeshControlRequest =
  | RedeemInvitationRequest
  | SyncPeerMeshRequest
  | LeavePeerMeshRequest
  | AnnouncePeerMeshRosterRequest;

interface LocalPeerMeshEvidence {
  readonly reachability: SignedPeerReachabilityLeaseV1;
  readonly advertisements: readonly SignedPeerMeshMemberAdvertisementV1[];
}

export interface PeerMeshNode {
  localPeerId(): string;
  displayName(): string | undefined;
  setDisplayName(displayName: string | null): Promise<void>;
  setMeshDisplayName(meshId: string, displayName: string | null): Promise<PeerMeshStatus>;
  status(): readonly PeerMeshStatus[];
  create(): Promise<PeerMeshStatus>;
  invite(meshId: string, input?: { readonly ttlMs?: number }): Promise<PeerMeshInvitationV1>;
  join(invitation: PeerMeshInvitationV1, signal?: AbortSignal): Promise<PeerMeshStatus>;
  remove(meshId: string, peerId: string): Promise<PeerMeshStatus>;
  leave(meshId: string, signal?: AbortSignal): Promise<void>;
  closeMesh(meshId: string): Promise<PeerMeshStatus>;
  setTransitMesh(meshId: string | null): Promise<void>;
  transitMeshId(): string | null;
  transitSnapshot(): RuntimeHostPeerTransitSnapshot;
  resolveRoutes(peerId: string): RuntimeHostPeerRouteResolution;
  prepareRoutes(peerId: string, signal: AbortSignal): Promise<void>;
  subscribeRoutes(peerId: string, listener: () => void): () => void;
  reconcile(signal?: AbortSignal): Promise<void>;
  serve(): Promise<void>;
  close(): Promise<void>;
}

export interface PeerMeshStatus {
  readonly role: 'authority' | 'member';
  readonly authorityPeerId: string;
  readonly roster: SignedPeerMeshRosterV1;
  readonly pendingInvitationCount: number;
  readonly memberRoutes: readonly PeerMeshMemberRouteStatus[];
}

export interface PeerMeshMemberRouteStatus {
  readonly peerId: string;
  readonly endpointKind?: 'client' | 'host';
  readonly displayName?: string;
  readonly state: 'local' | 'connecting' | 'reachable' | 'reconnecting' | 'needs_repair';
  readonly expiresAt?: number;
}

export interface PeerMeshTransport {
  identity(): Readonly<{
    peerId: string;
  }>;
  signIdentity(payload: Buffer): Promise<RuntimeHostPeerIdentityProof>;
  verifyIdentity(peerId: string, payload: Buffer, proof: RuntimeHostPeerIdentityProof): boolean;
  isConnected(peerId: string): boolean;
  transitSnapshot(): RuntimeHostPeerTransitSnapshot;
  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
    readonly approvedRelayPeerIds: readonly string[];
    readonly relayCandidates: readonly RuntimeHostPeerTransitRelayCandidate[];
  }): Promise<void>;
  connectMeshControl(
    input: {
      readonly peerId: string;
      readonly routeHints: readonly string[];
      readonly coordinationRelays?: readonly string[];
      readonly transitRelayPeerIds?: readonly string[];
      readonly directDeadlineMs: number;
    },
    signal?: AbortSignal,
  ): Promise<RuntimeHostPeerNativeStream>;
  serveMeshControl(
    onStream: (stream: RuntimeHostPeerNativeStream) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export async function openPeerMeshNode(input: {
  readonly dataRoot: string;
  readonly peer: PeerMeshTransport;
  readonly reachability: PeerReachabilityPublisher;
  readonly endpointKind?: 'client' | 'host';
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly onBackgroundReconcileError?: (error: unknown) => void;
}): Promise<PeerMeshNode> {
  const store = await openPeerMeshStateStore(input.dataRoot, input.peer.identity().peerId);
  const node = new PeerMeshNodeImpl({ ...input, store });
  try {
    await node.initialize();
    return node;
  } catch (error) {
    await node.close().catch(() => undefined);
    throw error;
  }
}

class PeerMeshNodeImpl implements PeerMeshNode {
  readonly #store: PeerMeshStateStore;
  readonly #peer: PeerMeshTransport;
  readonly #reachability: PeerReachabilityPublisher;
  readonly #endpointKind: 'client' | 'host' | undefined;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #onBackgroundReconcileError: ((error: unknown) => void) | undefined;
  readonly #activeControlStreams = new Set<RuntimeHostPeerNativeStream>();
  readonly #lifetime = new AbortController();
  #admissionTail = Promise.resolve();
  #reconcileTail = Promise.resolve();
  #transitTail = Promise.resolve();
  #reconcileCursor = 0;
  #gossipCursor = 0;
  #evidenceRefreshTask: Promise<LocalPeerMeshEvidence | undefined> | undefined;
  #unsubscribeReachability: (() => void) | undefined;
  #reconcileGeneration = 0;
  readonly #reconcileWaiters = new Set<() => void>();
  readonly #reachabilityReceipts = new Map<string, PeerReachabilityLeaseReceipt>();
  readonly #completedRecoverySweeps = new Set<string>();
  readonly #routeResolutionListeners = new Map<string, Set<() => void>>();
  #serveTask: Promise<void> | undefined;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    readonly store: PeerMeshStateStore;
    readonly peer: PeerMeshTransport;
    readonly reachability: PeerReachabilityPublisher;
    readonly endpointKind?: 'client' | 'host';
    readonly now?: () => number;
    readonly monotonicNow?: () => number;
    readonly onBackgroundReconcileError?: (error: unknown) => void;
  }) {
    this.#store = input.store;
    this.#peer = input.peer;
    this.#reachability = input.reachability;
    this.#endpointKind = input.endpointKind;
    this.#now = input.now ?? Date.now;
    this.#monotonicNow = input.monotonicNow ?? (input.now ? input.now : () => performance.now());
    this.#onBackgroundReconcileError = input.onBackgroundReconcileError;
  }

  async initialize(): Promise<void> {
    const stored = this.#store.read();
    const now = this.#now();
    for (const lease of stored.reachability) {
      const signed = authenticateSignedPeerReachabilityLease({
        value: lease,
        expectedPeerId: lease.lease.peerId,
        verifyIdentity: this.#peer.verifyIdentity.bind(this.#peer),
      });
      if (
        usableHistoricalReachability(signed, now) &&
        signed.lease.issuedAt <= now + PEER_REACHABILITY_MAX_CLOCK_SKEW_MS
      ) {
        this.#recordReachabilityReceipt(signed);
      }
    }
    for (const advertisement of stored.advertisements) {
      this.#assertAdvertisementSignature(advertisement);
    }
    if (stored.reachability.some((signed) => !usableHistoricalReachability(signed, now))) {
      await this.#store.mutate((current) => ({
        state: {
          ...current,
          reachability: current.reachability.filter((signed) =>
            usableHistoricalReachability(signed, now),
          ),
        },
        result: undefined,
      }));
    }
    await this.#refreshLocalEvidence();
    this.#unsubscribeReachability = this.#reachability.subscribe(() => {
      this.#triggerReconciliation();
    });
    await this.#reconcileTransit();
  }

  localPeerId(): string {
    this.#assertOpen();
    return this.#peer.identity().peerId;
  }

  displayName(): string | undefined {
    this.#assertOpen();
    return this.#store.read().displayName ?? undefined;
  }

  setDisplayName(displayName: string | null): Promise<void> {
    return this.#admitMesh(async () => {
      const canonical = displayName === null ? null : canonicalPeerMeshDisplayName(displayName);
      await this.#store.mutate(async (current) => {
        if (current.displayName === canonical) return { state: current, result: undefined };
        const next = { ...current, displayName: canonical };
        const advertisements = await this.#localAdvertisementsFor(next);
        return {
          state: {
            ...next,
            advertisements: mergeAdvertisements(current.advertisements, advertisements),
          },
          result: undefined,
        };
      });
      this.#triggerReconciliation();
    });
  }

  setMeshDisplayName(meshId: string, displayName: string | null): Promise<PeerMeshStatus> {
    return this.#admitMesh(async () => {
      const canonical =
        displayName === null ? undefined : canonicalPeerMeshDisplayName(displayName);
      const announcement = await this.#store.mutate((current) => {
        const state = requireAuthority(current.meshes, meshId);
        if (state.roster.roster.closed) throw new Error('Peer Mesh is closed');
        if (state.roster.roster.displayName === canonical)
          return { state: current, result: undefined };
        const { displayName: _currentDisplayName, ...currentRoster } = state.roster.roster;
        const roster = signPeerMeshRoster(
          canonicalPeerMeshRoster({
            ...currentRoster,
            revision: state.roster.roster.revision + 1,
            ...(canonical ? { displayName: canonical } : {}),
          }),
          authorityKeys(state),
        );
        return {
          state: {
            ...current,
            meshes: replaceMesh(current.meshes, { ...state, roster }),
          },
          result: {
            roster,
            targets: rosterAnnouncementTargets(
              state.roster.roster.members,
              current.reachability,
              this.#peer.identity().peerId,
              this.#now(),
            ),
          },
        };
      });
      if (announcement) this.#scheduleRosterAnnouncement(announcement.roster, announcement.targets);
      const stored = this.#store.read();
      return peerMeshStatus(
        requireAuthority(stored.meshes, meshId),
        this.#peer.identity(),
        this.#endpointKind,
        stored.reachability,
        stored.advertisements,
        this.#now(),
        (peerId) => this.#peer.isConnected(peerId),
        (peerId) => this.resolveRoutes(peerId),
        (signed) => this.#isReachabilityCurrent(signed),
      );
    });
  }

  status(): readonly PeerMeshStatus[] {
    this.#assertOpen();
    const identity = this.#peer.identity();
    const stored = this.#store.read();
    return Object.freeze(
      stored.meshes
        .filter((state) => state.roster.roster.closed || isActiveMembership(state, identity.peerId))
        .map((state) =>
          peerMeshStatus(
            state,
            identity,
            this.#endpointKind,
            stored.reachability,
            stored.advertisements,
            this.#now(),
            (peerId) => this.#peer.isConnected(peerId),
            (peerId) => this.resolveRoutes(peerId),
            (signed) => this.#isReachabilityCurrent(signed),
          ),
        ),
    );
  }

  create(): Promise<PeerMeshStatus> {
    return this.#admitMesh(async () => {
      const identity = this.#peer.identity();
      const keys = generatePeerMeshAuthorityKeyPair();
      const roster = signPeerMeshRoster(
        canonicalPeerMeshRoster({
          version: 1,
          meshId: peerMeshId(keys.publicKey),
          authorityPeerId: identity.peerId,
          revision: 1,
          members: [identity.peerId],
          closed: false,
        }),
        keys,
      );
      const state: PeerMeshStateV1 = {
        role: 'authority',
        roster,
        authorityPrivateKey: keys.privateKey,
        invitations: [],
      };
      const reachability = await this.#reachability.refresh();
      const now = this.#now();
      await this.#store.mutate((current) => {
        assertMeshCapacity(current.meshes, identity.peerId, current.pendingJoins.length);
        return {
          state: {
            ...current,
            meshes: appendMesh(current.meshes, state, identity.peerId),
            reachability: mergeReachability(current.reachability, [reachability], now),
          },
          result: undefined,
        };
      });
      await this.#refreshLocalEvidence();
      const stored = this.#store.read();
      return peerMeshStatus(
        findMesh(stored.meshes, state.roster.roster.meshId)!,
        identity,
        this.#endpointKind,
        stored.reachability,
        stored.advertisements,
        now,
        (peerId) => this.#peer.isConnected(peerId),
        (peerId) => this.resolveRoutes(peerId),
        (signed) => this.#isReachabilityCurrent(signed),
      );
    });
  }

  async invite(
    meshId: string,
    input: { readonly ttlMs?: number } = {},
  ): Promise<PeerMeshInvitationV1> {
    if (this.#lifetime.signal.aborted) throw new Error('Peer Mesh node is closed');
    const now = this.#now();
    const identity = this.#peer.identity();
    const ttlMs = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error('Peer Mesh invitation TTL must be between 1 second and 1 day');
    }
    const reachability = await this.#reachability.refresh();
    return this.#store.mutate((current) => {
      const state = requireAuthority(current.meshes, meshId);
      if (state.roster.roster.closed) throw new Error('Peer Mesh is closed');
      const invitations = state.invitations.filter(
        (invitation) => invitation.status === 'redeemed' || invitation.expiresAt > now,
      );
      if (
        invitations.filter(({ status }) => status === 'pending').length >=
        PEER_MESH_MAX_PENDING_INVITATIONS
      )
        throw new Error('Peer Mesh has too many pending invitations');
      if (invitations.length >= PEER_MESH_MAX_INVITATION_RECORDS)
        throw new Error('Peer Mesh has too many recent invitations');
      const secret = createPeerMeshInvitationSecret();
      const expiresAt = now + ttlMs;
      const invitation: PeerMeshInvitationV1 = {
        version: 1,
        meshId: state.roster.roster.meshId,
        authorityPublicKey: state.roster.authorityPublicKey,
        secret,
        expiresAt,
        reachability,
      };
      return {
        state: {
          ...current,
          meshes: replaceMesh(current.meshes, {
            ...state,
            invitations: [
              ...invitations,
              {
                status: 'pending',
                secretDigest: peerMeshInvitationSecretDigest(secret),
                expiresAt,
              },
            ],
          }),
        },
        result: Object.freeze(invitation),
      };
    });
  }

  join(invitationValue: PeerMeshInvitationV1, signal?: AbortSignal): Promise<PeerMeshStatus> {
    return this.#admitMesh(async () => {
      const invitation = validatePeerMeshInvitation(invitationValue);
      const authorityReachability = this.#authenticateReachability(
        invitation.reachability,
        invitation.reachability.lease.peerId,
        true,
      );
      const current = this.#store.read();
      const existing = findMesh(current.meshes, invitation.meshId);
      const pending = current.pendingJoins.find(
        ({ invitation: candidate }) => candidate.meshId === invitation.meshId,
      );
      if (!pending && invitation.expiresAt <= this.#now()) {
        throw new Error('Peer Mesh invitation has expired');
      }
      const localPeerId = this.#peer.identity().peerId;
      if (existing?.roster.roster.closed) {
        throw new Error('Peer Mesh is closed');
      }
      if (existing?.role === 'authority') {
        throw new Error('This peer already belongs to that Peer Mesh');
      }
      if (
        existing?.role === 'replica' &&
        authorityReachability.lease.peerId !== existing.roster.roster.authorityPeerId
      ) {
        throw new Error('Peer Mesh repair invitation has the wrong authority identity');
      }
      assertRejoinSettled(existing, localPeerId);
      if (pending && pending.invitation.secret !== invitation.secret) {
        throw new Error('This Peer Mesh already has an unresolved join attempt');
      }
      if (pending?.phase === 'leave_pending') {
        throw new Error('This Peer Mesh join is still being cancelled');
      }
      if (!existing && !pending) {
        assertMeshCapacity(current.meshes, localPeerId, current.pendingJoins.length);
      }
      const operationSignal = signal
        ? AbortSignal.any([signal, this.#lifetime.signal])
        : this.#lifetime.signal;
      let stream: RuntimeHostPeerNativeStream | undefined;
      let joinIntentAdmitted = pending !== undefined;
      try {
        stream = await this.#peer.connectMeshControl(
          {
            ...dialTarget(authorityReachability),
            directDeadlineMs: CONNECT_DEADLINE_MS,
          },
          operationSignal,
        );
        if (stream.peerId !== authorityReachability.lease.peerId) {
          throw new Error('Peer Mesh control stream has the wrong peer identity');
        }
        const localReachability = await this.#reachability.refresh();
        const localAdvertisement = await this.#signLocalAdvertisement(invitation.meshId);
        await this.#store.mutate((current) => {
          const existing = findMesh(current.meshes, invitation.meshId);
          if (existing?.role === 'authority') {
            throw new Error('This peer already belongs to that Peer Mesh');
          }
          assertRejoinSettled(existing, localPeerId);
          const pending = current.pendingJoins.find(
            ({ invitation: candidate }) => candidate.meshId === invitation.meshId,
          );
          if (pending && pending.invitation.secret !== invitation.secret) {
            throw new Error('This Peer Mesh already has an unresolved join attempt');
          }
          if (pending?.phase === 'leave_pending') {
            throw new Error('This Peer Mesh join is still being cancelled');
          }
          if (!existing && !pending) {
            assertMeshCapacity(current.meshes, localPeerId, current.pendingJoins.length);
          }
          const next: PendingPeerMeshJoin = pending
            ? { ...pending, invitation }
            : { invitation, phase: 'prepared' };
          return {
            state: {
              ...current,
              pendingJoins: pending
                ? current.pendingJoins.map((candidate) =>
                    candidate === pending ? next : candidate,
                  )
                : [...current.pendingJoins, next],
            },
            result: undefined,
          };
        });
        joinIntentAdmitted = true;
        return await this.#redeemPendingJoin(
          invitation,
          localReachability,
          localAdvertisement,
          stream,
          operationSignal,
        );
      } catch (error) {
        if (signal?.aborted && joinIntentAdmitted) {
          await this.#cancelPendingJoin(invitation.meshId);
          await this.#reconcileTransit();
        }
        void this.reconcile().catch(() => undefined);
        throw error;
      } finally {
        await stream?.close().catch(() => undefined);
      }
    });
  }

  async #redeemPendingJoin(
    invitation: PeerMeshInvitationV1,
    localReachability: SignedPeerReachabilityLeaseV1,
    localAdvertisement: SignedPeerMeshMemberAdvertisementV1,
    stream: RuntimeHostPeerNativeStream,
    signal: AbortSignal,
  ): Promise<PeerMeshStatus> {
    signal.throwIfAborted();
    const authorityReachability = this.#authenticateReachability(
      invitation.reachability,
      invitation.reachability.lease.peerId,
      true,
    );
    const dispatch = await this.#store.mutate((current) => {
      const pending = current.pendingJoins.find(
        ({ invitation: candidate }) =>
          candidate.meshId === invitation.meshId && candidate.secret === invitation.secret,
      );
      if (!pending) {
        return { state: current, result: false };
      }
      if (pending.phase !== 'prepared') {
        return { state: current, result: true };
      }
      return {
        state: {
          ...current,
          pendingJoins: current.pendingJoins.map((candidate) =>
            candidate === pending ? { ...candidate, phase: 'outcome_unknown' } : candidate,
          ),
        },
        result: true,
      };
    });
    if (!dispatch) throw new Error('Peer Mesh join is no longer pending');
    signal.throwIfAborted();
    const response = await exchangeControl(
      stream,
      {
        kind: 'redeem-invitation',
        meshId: invitation.meshId,
        secret: invitation.secret,
        reachability: localReachability,
        advertisement: localAdvertisement,
      },
      decodeRedeemResponse,
      signal,
    );
    if (response.kind === 'invitation-rejected') {
      await this.#discardPendingJoin(invitation);
      throw new Error(`Peer Mesh invitation was rejected: ${response.reason}`);
    }
    const roster = decodeSignedPeerMeshRoster(response.roster);
    const identity = this.#peer.identity();
    if (
      roster.roster.meshId !== invitation.meshId ||
      roster.authorityPublicKey !== invitation.authorityPublicKey ||
      roster.roster.authorityPeerId !== stream.peerId ||
      invitation.reachability.lease.peerId !== stream.peerId ||
      !roster.roster.members.includes(identity.peerId)
    ) {
      await this.#discardPendingJoin(invitation);
      throw new Error('Peer Mesh authority returned an unrelated roster');
    }
    const reachability = this.#validateReachabilityPage(response.reachability, roster, true);
    const advertisements = this.#validateAdvertisementPage(response.advertisements, roster);
    signal.throwIfAborted();
    await this.#store.mutate((current) => {
      const pending = current.pendingJoins.find(
        ({ invitation: candidate }) =>
          candidate.meshId === invitation.meshId && candidate.secret === invitation.secret,
      );
      const existing = findMesh(current.meshes, invitation.meshId);
      if (!pending) {
        if (!existing || existing.role === 'authority') {
          throw new Error('Peer Mesh join is no longer pending');
        }
        return { state: current, result: undefined };
      }
      const selectedRoster = existing ? selectRoster(existing.roster, roster) : roster;
      if (!selectedRoster.roster.members.includes(identity.peerId)) {
        throw new Error('Peer Mesh invitation did not establish an active membership');
      }
      const state: PeerMeshReplicaStateV1 = {
        role: 'replica',
        roster: selectedRoster,
        desiredMembership: pending.phase === 'leave_pending' ? 'left' : 'active',
      };
      return {
        state: {
          ...current,
          meshes: existing
            ? replaceMesh(current.meshes, state)
            : appendMesh(current.meshes, state, identity.peerId),
          pendingJoins: current.pendingJoins.filter((candidate) => candidate !== pending),
          reachability: mergeReachability(
            current.reachability,
            [...reachability, authorityReachability, localReachability],
            this.#now(),
          ),
          advertisements: mergeAdvertisements(current.advertisements, [
            ...advertisements,
            localAdvertisement,
          ]),
        },
        result: undefined,
      };
    });
    this.#recordReachabilityReceipts([...reachability, authorityReachability, localReachability]);
    signal.throwIfAborted();
    await this.#refreshLocalEvidence();
    signal.throwIfAborted();
    await this.#reconcileTransit();
    signal.throwIfAborted();
    const stored = this.#store.read();
    const state = findMesh(stored.meshes, invitation.meshId);
    if (!state) throw new Error('Peer Mesh join was not retained');
    return peerMeshStatus(
      state,
      identity,
      this.#endpointKind,
      stored.reachability,
      stored.advertisements,
      this.#now(),
      (peerId) => this.#peer.isConnected(peerId),
      (peerId) => this.resolveRoutes(peerId),
      (signed) => this.#isReachabilityCurrent(signed),
    );
  }

  #discardPendingJoin(invitation: PeerMeshInvitationV1): Promise<void> {
    return this.#store.mutate((current) => ({
      state: {
        ...current,
        pendingJoins: current.pendingJoins.filter(
          ({ invitation: candidate }) =>
            candidate.meshId !== invitation.meshId || candidate.secret !== invitation.secret,
        ),
      },
      result: undefined,
    }));
  }

  #cancelPendingJoin(meshId: string): Promise<void> {
    return this.#store.mutate((current) => {
      const existing = findMesh(current.meshes, meshId);
      return {
        state: {
          ...current,
          meshes:
            existing?.role === 'replica'
              ? replaceMesh(current.meshes, {
                  ...existing,
                  desiredMembership: 'left',
                })
              : current.meshes,
          pendingJoins: current.pendingJoins.flatMap((pending) => {
            if (pending.invitation.meshId !== meshId) return [pending];
            return pending.phase === 'prepared' ? [] : [{ ...pending, phase: 'leave_pending' }];
          }),
        },
        result: undefined,
      };
    });
  }

  async #resumePendingJoin(pending: PendingPeerMeshJoin, signal: AbortSignal): Promise<void> {
    const authorityReachability = this.#authenticateReachability(
      pending.invitation.reachability,
      pending.invitation.reachability.lease.peerId,
      true,
    );
    const existing = findMesh(this.#store.read().meshes, pending.invitation.meshId);
    if (
      existing?.role === 'replica' &&
      authorityReachability.lease.peerId !== existing.roster.roster.authorityPeerId
    ) {
      throw new Error('Peer Mesh repair invitation has the wrong authority identity');
    }
    const stream = await this.#peer.connectMeshControl(
      {
        ...dialTarget(authorityReachability),
        directDeadlineMs: CONNECT_DEADLINE_MS,
      },
      signal,
    );
    try {
      const localReachability = await this.#reachability.refresh();
      const localAdvertisement = await this.#signLocalAdvertisement(pending.invitation.meshId);
      await this.#redeemPendingJoin(
        pending.invitation,
        localReachability,
        localAdvertisement,
        stream,
        signal,
      );
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  remove(meshId: string, peerId: string): Promise<PeerMeshStatus> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    return this.#updateAuthorityRoster(meshId, false, (state) => {
      if (peerId === this.#peer.identity().peerId) {
        throw new Error('Peer Mesh authority cannot remove itself');
      }
      const members = state.roster.roster.members.filter((member) => member !== peerId);
      if (members.length === state.roster.roster.members.length) {
        throw new Error('Peer is not a member of this Peer Mesh');
      }
      return { members, closed: false };
    });
  }

  leave(meshId: string, signal?: AbortSignal): Promise<void> {
    return this.#admitMesh(async () => {
      signal?.throwIfAborted();
      const localPeerId = this.#peer.identity().peerId;
      await this.#store.mutate((current) => {
        const state = findMesh(current.meshes, meshId);
        if (!state || !isActiveMembership(state, localPeerId)) {
          throw new Error('This peer does not belong to that Peer Mesh');
        }
        if (state.role === 'authority') {
          throw new Error('Close a Peer Mesh instead of leaving its authority');
        }
        return {
          state: {
            ...current,
            meshes: replaceMesh(current.meshes, {
              ...state,
              desiredMembership: 'left',
            }),
          },
          result: undefined,
        };
      });
      try {
        await this.#reconcileTransit();
      } finally {
        void this.reconcile().catch(() => undefined);
      }
    });
  }

  closeMesh(meshId: string): Promise<PeerMeshStatus> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    return this.#updateAuthorityRoster(meshId, true, (state) => ({
      members: state.roster.roster.members,
      closed: true,
    }));
  }

  setTransitMesh(meshId: string | null): Promise<void> {
    return this.#admitMesh(async () => {
      const localPeerId = this.#peer.identity().peerId;
      await this.#store.mutate(async (current) => {
        if (
          meshId !== null &&
          !current.meshes.some(
            (mesh) => mesh.roster.roster.meshId === meshId && isActiveMembership(mesh, localPeerId),
          )
        ) {
          throw new Error('Transit requires an active Peer Mesh membership');
        }
        if (current.transitMeshId === meshId) return { state: current, result: undefined };
        const next = { ...current, transitMeshId: meshId };
        const advertisements = await this.#localAdvertisementsFor(next);
        return {
          state: {
            ...next,
            advertisements: mergeAdvertisements(current.advertisements, advertisements),
          },
          result: undefined,
        };
      });
      try {
        await this.#reconcileTransit();
      } finally {
        this.#triggerReconciliation();
      }
    });
  }

  transitSnapshot(): RuntimeHostPeerTransitSnapshot {
    this.#assertOpen();
    return this.#peer.transitSnapshot();
  }

  transitMeshId(): string | null {
    this.#assertOpen();
    return this.#store.read().transitMeshId;
  }

  resolveRoutes(peerId: string) {
    this.#assertOpen();
    const now = this.#now();
    const stored = this.#store.read();
    const localPeerId = this.#peer.identity().peerId;
    this.#pruneCompletedRecoverySweeps(stored, localPeerId);
    const sharedMeshIds = stored.meshes
      .filter(
        (state) =>
          isActiveMembership(state, localPeerId) && state.roster.roster.members.includes(peerId),
      )
      .map(({ roster }) => roster.roster.meshId);
    const visible = sharedMeshIds.length > 0;
    if (!visible) return emptyRouteResolution('exhausted');
    const reachability = latestReachability(stored.reachability, peerId, now, true)?.lease;
    const transitRelayPeerIds = transitRelayCandidates(
      eligibleTransitEvidence(stored, localPeerId, now, (signed) =>
        this.#isReachabilityCurrent(signed),
      ).filter(
        ({ meshId, lease }) => lease.lease.peerId !== peerId && sharedMeshIds.includes(meshId),
      ),
    ).map(({ peerId: relayPeerId }) => relayPeerId);
    const routeHints = reachability?.directRoutes ?? [];
    const coordinationRelays = reachability?.coordinationRoutes ?? [];
    const hasCandidates =
      routeHints.length + coordinationRelays.length + transitRelayPeerIds.length > 0;
    const state = hasCandidates
      ? 'available'
      : hasPeerRecoverySource(stored, sharedMeshIds, peerId, localPeerId, now)
        ? 'recovering'
        : this.#completedRecoverySweeps.has(peerId)
          ? 'exhausted'
          : 'recovering';
    return Object.freeze({
      state,
      routeHints,
      coordinationRelays,
      transitRelayPeerIds: Object.freeze(transitRelayPeerIds),
    });
  }

  async prepareRoutes(peerId: string, signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    signal.throwIfAborted();
    this.#setRecoverySweepCompleted(peerId, false);
    const localPeerId = this.#peer.identity().peerId;
    const stored = this.#store.read();
    const visible = this.#pruneCompletedRecoverySweeps(stored, localPeerId).has(peerId);
    if (!visible) return;
    // A signed route can remain within its TTL after a peer restarted or
    // rotated Relay reservations. Every connection establishment therefore
    // asks the Mesh control plane for its newest record. Callers with a
    // self-contained invitation run this reconciliation in parallel with the
    // first dial; callers without usable routes wait for it.
    try {
      await this.#queueReconcile(signal, peerId);
    } finally {
      if (!signal.aborted && !this.#lifetime.signal.aborted) {
        this.#setRecoverySweepCompleted(peerId, true);
      }
    }
  }

  #pruneCompletedRecoverySweeps(
    stored = this.#store.read(),
    localPeerId = this.#peer.identity().peerId,
  ): ReadonlySet<string> {
    const visiblePeerIds = new Set<string>();
    for (const state of stored.meshes) {
      if (!isActiveMembership(state, localPeerId)) continue;
      for (const memberPeerId of state.roster.roster.members) {
        if (memberPeerId !== localPeerId) visiblePeerIds.add(memberPeerId);
      }
    }
    for (const peerId of this.#completedRecoverySweeps) {
      if (!visiblePeerIds.has(peerId)) this.#completedRecoverySweeps.delete(peerId);
    }
    return visiblePeerIds;
  }

  subscribeRoutes(peerId: string, listener: () => void): () => void {
    this.#assertOpen();
    let current = this.resolveRoutes(peerId);
    const observe = () => {
      const next = this.resolveRoutes(peerId);
      if (sameResolvedRoutes(current, next)) return;
      current = next;
      try {
        listener();
      } catch {
        // Route observers cannot control Mesh reconciliation.
      }
    };
    const listeners = this.#routeResolutionListeners.get(peerId) ?? new Set<() => void>();
    listeners.add(observe);
    this.#routeResolutionListeners.set(peerId, listeners);
    const unsubscribeStore = this.#store.subscribe(observe);
    return () => {
      unsubscribeStore();
      listeners.delete(observe);
      if (listeners.size === 0) this.#routeResolutionListeners.delete(peerId);
    };
  }

  #setRecoverySweepCompleted(peerId: string, completed: boolean): void {
    const retain = completed && this.#pruneCompletedRecoverySweeps().has(peerId);
    const changed = retain
      ? !this.#completedRecoverySweeps.has(peerId)
      : this.#completedRecoverySweeps.has(peerId);
    if (!changed) return;
    if (retain) this.#completedRecoverySweeps.add(peerId);
    else this.#completedRecoverySweeps.delete(peerId);
    for (const listener of this.#routeResolutionListeners.get(peerId) ?? []) listener();
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    return this.#queueReconcile(signal);
  }

  #queueReconcile(signal?: AbortSignal, excludedPeerId?: string): Promise<void> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    const previous = this.#reconcileTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#reconcileTail = previous.then(() => turn);
    return waitForTurn(previous, signal)
      .then(() => this.#reconcile(signal, excludedPeerId))
      .finally(release);
  }

  async serve(): Promise<void> {
    if (this.#lifetime.signal.aborted) throw new Error('Peer Mesh node is closed');
    if (this.#serveTask) throw new Error('Peer Mesh node is already serving');
    const serveLifetime = new AbortController();
    const signal = AbortSignal.any([this.#lifetime.signal, serveLifetime.signal]);
    const inbound = this.#peer.serveMeshControl((stream) => this.#acceptIncoming(stream), signal);
    const reconciliation = this.#runReconciliation(signal);
    const serving = (async () => {
      try {
        await Promise.race([inbound, this.#store.terminalFailure]);
        if (!signal.aborted) throw new Error('Peer Mesh control transport stopped unexpectedly');
      } finally {
        serveLifetime.abort();
        await reconciliation;
      }
    })();
    this.#serveTask = serving;
    try {
      await serving;
    } finally {
      if (this.#serveTask === serving) {
        this.#serveTask = undefined;
      }
    }
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#lifetime.abort();
    this.#unsubscribeReachability?.();
    this.#unsubscribeReachability = undefined;
    for (const wake of this.#reconcileWaiters) wake();
    this.#reconcileWaiters.clear();
    await this.#serveTask?.catch(() => undefined);
    for (const stream of this.#activeControlStreams) stream.abort();
    this.#activeControlStreams.clear();
    this.#routeResolutionListeners.clear();
    await Promise.all([this.#admissionTail, this.#reconcileTail, this.#transitTail]);
    return this.#store.close();
  }

  async #runReconciliation(signal: AbortSignal): Promise<void> {
    let failureReported = false;
    while (!signal.aborted) {
      const observedGeneration = this.#reconcileGeneration;
      try {
        await this.reconcile(signal);
        failureReported = false;
      } catch (error) {
        if (!signal.aborted && !failureReported) {
          failureReported = true;
          try {
            this.#onBackgroundReconcileError?.(error);
          } catch {
            // Diagnostics cannot control Peer Mesh reconciliation.
          }
        }
      }
      await this.#waitForReconciliationTrigger(observedGeneration, signal).catch(() => undefined);
    }
  }

  async #waitForReconciliationTrigger(
    observedGeneration: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#reconcileGeneration !== observedGeneration) return;
    let wake!: () => void;
    const triggered = new Promise<void>((resolve) => {
      wake = resolve;
      this.#reconcileWaiters.add(wake);
    });
    if (this.#reconcileGeneration !== observedGeneration) wake();
    try {
      await Promise.race([triggered, delay(RECONCILE_INTERVAL_MS, undefined, { signal })]);
    } finally {
      this.#reconcileWaiters.delete(wake);
    }
  }

  #triggerReconciliation(): void {
    this.#reconcileGeneration += 1;
    for (const wake of this.#reconcileWaiters) wake();
    this.#reconcileWaiters.clear();
  }

  async #reconcile(signal?: AbortSignal, excludedPeerId?: string): Promise<void> {
    const lifetimeSignal = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    lifetimeSignal.throwIfAborted();
    await this.#reconcileTransit();
    await this.#refreshLocalEvidence();
    const identity = this.#peer.identity();
    const stored = this.#store.read();
    const memberships = stored.meshes.filter(
      (state) =>
        !state.roster.roster.closed && state.roster.roster.members.includes(identity.peerId),
    );
    const pending: Array<
      | { readonly kind: 'join'; readonly join: PendingPeerMeshJoin }
      | {
          readonly kind: 'membership';
          readonly meshId: string;
          readonly target: SignedPeerReachabilityLeaseV1;
          readonly desiredMembership: 'active' | 'left';
          readonly roster: SignedPeerMeshRosterV1;
        }
    > = stored.pendingJoins
      .filter(({ invitation }) => invitation.reachability.lease.peerId !== excludedPeerId)
      .map((join) => ({ kind: 'join', join }));
    const gossipCursor = this.#gossipCursor;
    this.#gossipCursor = (this.#gossipCursor + 1) % PEER_MESH_MAX_MEMBERS;
    const now = this.#now();
    for (const [index, state] of memberships.entries()) {
      const meshId = state.roster.roster.meshId;
      const desiredMembership = state.role === 'replica' ? state.desiredMembership : 'active';
      const authority =
        state.role === 'replica'
          ? currentAuthorityTarget(state, stored.reachability, now)
          : undefined;
      if (authority && authority.lease.peerId !== excludedPeerId) {
        pending.push({
          kind: 'membership',
          meshId,
          target: authority,
          desiredMembership,
          roster: state.roster,
        });
      }
      if (desiredMembership === 'left') continue;
      const rotatingTargets = state.roster.roster.members
        .filter(
          (peerId) =>
            peerId !== identity.peerId &&
            peerId !== excludedPeerId &&
            (state.role === 'authority' || peerId !== state.roster.roster.authorityPeerId),
        )
        .flatMap((peerId) => {
          const target = peerTarget(peerId, stored.reachability, now);
          return target ? [target] : [];
        });
      if (rotatingTargets.length === 0) continue;
      pending.push({
        kind: 'membership',
        meshId,
        target: rotatingTargets[(gossipCursor + index) % rotatingTargets.length]!,
        desiredMembership,
        roster: state.roster,
      });
    }
    if (pending.length === 0) return;
    const start = this.#reconcileCursor % pending.length;
    const deadline = AbortSignal.timeout(RECONCILE_DEADLINE_MS);
    const operationSignal = AbortSignal.any([lifetimeSignal, deadline]);
    const failures: unknown[] = [];
    let next = 0;
    const worker = async () => {
      while (!operationSignal.aborted) {
        const offset = next;
        next += 1;
        if (offset >= pending.length) return;
        const operation = pending[(start + offset) % pending.length]!;
        try {
          if (operation.kind === 'join') {
            await this.#resumePendingJoin(operation.join, operationSignal);
          } else if (operation.desiredMembership === 'left') {
            await this.#notifyLeave(
              operation.meshId,
              operation.target,
              operation.roster,
              operationSignal,
            );
          } else {
            await this.#syncPeer(operation.meshId, operation.target, operationSignal);
          }
        } catch (error) {
          if (lifetimeSignal.aborted) lifetimeSignal.throwIfAborted();
          if (operation.kind === 'join' || operation.desiredMembership === 'left') {
            failures.push(error);
          }
          if (deadline.aborted) return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(RECONCILE_CONCURRENCY, pending.length) }, worker),
    );
    this.#reconcileCursor = (start + Math.min(next, pending.length)) % pending.length;
    await this.#reconcileTransit();
    lifetimeSignal.throwIfAborted();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Peer Mesh reconciliation did not reach every pending intent',
      );
    }
  }

  async #notifyLeave(
    meshId: string,
    target: SignedPeerReachabilityLeaseV1,
    roster: SignedPeerMeshRosterV1,
    signal: AbortSignal,
  ): Promise<void> {
    const stream = await this.#peer.connectMeshControl(
      {
        ...dialTarget(target),
        directDeadlineMs: CONNECT_DEADLINE_MS,
      },
      signal,
    );
    try {
      const response = await exchangeControl(
        stream,
        { kind: 'leave', meshId, roster },
        decodeLeaveResponse,
        signal,
      );
      if (response.kind === 'leave-rejected') {
        throw new Error('Peer Mesh authority rejected the leave request');
      }
      await this.#applySync(meshId, response.roster, [], []);
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  async #syncPeer(
    meshId: string,
    target: SignedPeerReachabilityLeaseV1,
    signal: AbortSignal,
  ): Promise<void> {
    const localPeerId = this.#peer.identity().peerId;
    const targetPeerId = target.lease.peerId;
    for (let page = 0; page <= PEER_MESH_MAX_MEMBERS; page += 1) {
      if (!isActiveMeshMember(this.#store.read().meshes, meshId, localPeerId, targetPeerId)) return;
      const discovered = this.resolveRoutes(targetPeerId);
      const targetRoutes = dialTarget(target);
      const stream = await this.#peer.connectMeshControl(
        {
          peerId: targetPeerId,
          routeHints: mergeAddresses(discovered?.routeHints ?? [], targetRoutes.routeHints),
          coordinationRelays: mergeAddresses(
            discovered?.coordinationRelays ?? [],
            targetRoutes.coordinationRelays,
          ),
          transitRelayPeerIds: discovered?.transitRelayPeerIds,
          directDeadlineMs: CONNECT_DEADLINE_MS,
        },
        signal,
      );
      try {
        await this.#refreshLocalEvidence();
        const stored = this.#store.read();
        if (!isActiveMeshMember(stored.meshes, meshId, localPeerId, targetPeerId)) return;
        const state = findMesh(stored.meshes, meshId)!;
        const reachability = latestReachability(
          stored.reachability,
          localPeerId,
          this.#now(),
          true,
        );
        const advertisement = findAdvertisement(stored.advertisements, meshId, localPeerId);
        if (!reachability || !advertisement) {
          throw new Error('Peer Mesh local evidence is unavailable');
        }
        const response = await exchangeControl(
          stream,
          {
            kind: 'sync',
            meshId,
            roster: state.roster,
            reachability,
            advertisement,
            knownReachability: reachabilitySummaries(
              stored.reachability,
              state.roster,
              this.#now(),
            ),
            knownAdvertisements: advertisementSummaries(stored.advertisements, state.roster),
          },
          decodeSyncResponse,
          signal,
        );
        if (response.kind === 'sync-rejected') {
          throw new Error(`Peer Mesh synchronization was rejected: ${response.reason}`);
        }
        await this.#applySync(
          meshId,
          response.roster,
          response.reachability,
          response.advertisements,
        );
        if (!response.more) return;
      } finally {
        await stream.close().catch(() => undefined);
      }
    }
    throw new Error('Peer Mesh synchronization exceeded its page bound');
  }

  #refreshLocalEvidence(): Promise<LocalPeerMeshEvidence | undefined> {
    this.#evidenceRefreshTask ??= this.#refreshLocalEvidenceOnce().finally(() => {
      this.#evidenceRefreshTask = undefined;
    });
    return this.#evidenceRefreshTask;
  }

  async #refreshLocalEvidenceOnce(): Promise<LocalPeerMeshEvidence | undefined> {
    const reachability = await this.#reachability.refresh();
    const identity = this.#peer.identity();
    const now = this.#now();
    return this.#store.mutate(async (current) => {
      const active = current.meshes.filter((state) => isActiveMembership(state, identity.peerId));
      if (active.length === 0) {
        return { state: current, result: undefined };
      }
      const advertisements = await this.#localAdvertisementsFor(current);
      return {
        state: {
          ...current,
          reachability: mergeReachability(current.reachability, [reachability], now),
          advertisements: mergeAdvertisements(current.advertisements, advertisements),
        },
        result: Object.freeze({
          reachability,
          advertisements: Object.freeze(advertisements),
        }),
      };
    });
  }

  async #localAdvertisementsFor(
    stored: PeerMeshStoredStateV1,
  ): Promise<readonly SignedPeerMeshMemberAdvertisementV1[]> {
    const identity = this.#peer.identity();
    const advertisements: SignedPeerMeshMemberAdvertisementV1[] = [];
    for (const state of stored.meshes) {
      if (!isActiveMembership(state, identity.peerId)) continue;
      const meshId = state.roster.roster.meshId;
      const existing = findAdvertisement(stored.advertisements, meshId, identity.peerId);
      advertisements.push(
        isCurrentLocalAdvertisement(existing, meshId, identity.peerId, stored, this.#endpointKind)
          ? existing
          : await this.#signLocalAdvertisement(meshId, stored),
      );
    }
    return Object.freeze(advertisements);
  }

  async #signLocalAdvertisement(
    meshId: string,
    stored: PeerMeshStoredStateV1 = this.#store.read(),
  ): Promise<SignedPeerMeshMemberAdvertisementV1> {
    const identity = this.#peer.identity();
    const maxRevision = stored.advertisements
      .filter(
        ({ advertisement }) =>
          advertisement.meshId === meshId && advertisement.peerId === identity.peerId,
      )
      .reduce((maximum, { advertisement }) => Math.max(maximum, advertisement.revision), 0);
    const advertisement = canonicalPeerMeshMemberAdvertisement({
      version: 1,
      meshId,
      peerId: identity.peerId,
      revision: maxRevision + 1,
      ...(this.#endpointKind ? { endpointKind: this.#endpointKind } : {}),
      ...(stored.displayName ? { displayName: stored.displayName } : {}),
      offersTransit: stored.transitMeshId === meshId,
    });
    const proof = await this.#peer.signIdentity(
      peerMeshMemberAdvertisementSigningBytes(advertisement),
    );
    const signed = decodeSignedPeerMeshMemberAdvertisement({
      advertisement,
      publicKey: proof.publicKey.toString('base64url'),
      signature: proof.signature.toString('base64url'),
    });
    this.#assertAdvertisementSignature(signed);
    return signed;
  }

  #validateReachabilityPage(
    values: readonly SignedPeerReachabilityLeaseV1[],
    roster: SignedPeerMeshRosterV1,
    allowExpired: boolean,
  ): readonly SignedPeerReachabilityLeaseV1[] {
    if (values.length > EVIDENCE_PAGE_SIZE) {
      throw new Error('Too many Peer Mesh reachability leases');
    }
    const reachability = values.map((value) => {
      const signed = decodeSignedPeerReachabilityLease(value);
      if (!roster.roster.members.includes(signed.lease.peerId)) {
        throw new Error('Peer Mesh reachability is outside the active roster');
      }
      return this.#authenticateReachability(signed, signed.lease.peerId, allowExpired);
    });
    if (new Set(reachability.map(({ lease }) => lease.peerId)).size !== reachability.length) {
      throw new Error('Duplicate Peer Mesh reachability leases');
    }
    return Object.freeze(reachability);
  }

  #authenticateReachability(
    value: SignedPeerReachabilityLeaseV1,
    expectedPeerId: string,
    allowExpired = false,
  ): SignedPeerReachabilityLeaseV1 {
    const signed = verifySignedPeerReachabilityLease({
      value,
      expectedPeerId,
      now: this.#now(),
      verifyIdentity: this.#peer.verifyIdentity.bind(this.#peer),
      ...(allowExpired ? { allowExpired: true } : {}),
    });
    if (
      allowExpired &&
      signed.lease.expiresAt <= this.#now() - PEER_REACHABILITY_RECOVERY_HORIZON_MS
    ) {
      throw new Error('Peer Mesh reachability is outside the recovery horizon');
    }
    return signed;
  }

  #validateAdvertisementPage(
    values: readonly SignedPeerMeshMemberAdvertisementV1[],
    roster: SignedPeerMeshRosterV1,
  ): readonly SignedPeerMeshMemberAdvertisementV1[] {
    if (values.length > EVIDENCE_PAGE_SIZE) {
      throw new Error('Too many Peer Mesh member advertisements');
    }
    const advertisements = values.map((value) => {
      const signed = decodeSignedPeerMeshMemberAdvertisement(value);
      if (
        signed.advertisement.meshId !== roster.roster.meshId ||
        !roster.roster.members.includes(signed.advertisement.peerId)
      ) {
        throw new Error('Peer Mesh member advertisement is outside the active roster');
      }
      this.#assertAdvertisementSignature(signed);
      return signed;
    });
    const keys = advertisements.map(({ advertisement }) => advertisement.peerId);
    if (new Set(keys).size !== keys.length) {
      throw new Error('Duplicate Peer Mesh member advertisements');
    }
    return Object.freeze(advertisements);
  }

  #validateAdvertisementForPeer(
    value: SignedPeerMeshMemberAdvertisementV1,
    meshId: string,
    peerId: string,
  ): SignedPeerMeshMemberAdvertisementV1 {
    const signed = decodeSignedPeerMeshMemberAdvertisement(value);
    if (signed.advertisement.meshId !== meshId || signed.advertisement.peerId !== peerId) {
      throw new Error('Peer Mesh member advertisement belongs to a different member');
    }
    this.#assertAdvertisementSignature(signed);
    return signed;
  }

  #assertAdvertisementSignature(signedValue: SignedPeerMeshMemberAdvertisementV1): void {
    const signed = decodeSignedPeerMeshMemberAdvertisement(signedValue);
    const valid = this.#peer.verifyIdentity(
      signed.advertisement.peerId,
      peerMeshMemberAdvertisementSigningBytes(signed.advertisement),
      {
        publicKey: Buffer.from(signed.publicKey, 'base64url'),
        signature: Buffer.from(signed.signature, 'base64url'),
      },
    );
    if (!valid) throw new Error('Peer Mesh member advertisement signature is invalid');
  }

  #recordReachabilityReceipt(signed: SignedPeerReachabilityLeaseV1): void {
    this.#recordReachabilityReceipts([signed]);
  }

  #recordReachabilityReceipts(values: readonly SignedPeerReachabilityLeaseV1[]): void {
    const retained = this.#retainedReachabilityReceiptPeerIds();
    for (const peerId of this.#reachabilityReceipts.keys()) {
      if (!retained.has(peerId)) this.#reachabilityReceipts.delete(peerId);
    }
    for (const signed of values) {
      if (!retained.has(signed.lease.peerId)) continue;
      const previous = this.#reachabilityReceipts.get(signed.lease.peerId);
      if (previous && previous.revision > signed.lease.revision) continue;
      if (
        previous &&
        previous.revision === signed.lease.revision &&
        previous.signature !== signed.signature
      ) {
        continue;
      }
      this.#reachabilityReceipts.set(
        signed.lease.peerId,
        peerReachabilityLeaseReceipt({
          signed,
          wallNow: this.#now(),
          monotonicNow: this.#monotonicNow(),
          ...(previous ? { previous } : {}),
        }),
      );
    }
  }

  #retainedReachabilityReceiptPeerIds(): ReadonlySet<string> {
    const stored = this.#store.read();
    const localPeerId = this.#peer.identity().peerId;
    const retained = new Set<string>();
    for (const state of stored.meshes) {
      if (!isActiveMembership(state, localPeerId)) continue;
      for (const peerId of state.roster.roster.members) {
        if (peerId !== localPeerId) retained.add(peerId);
      }
    }
    return retained;
  }

  #isReachabilityCurrent(signed: SignedPeerReachabilityLeaseV1): boolean {
    return isPeerReachabilityLeaseCurrent(
      signed,
      this.#reachabilityReceipts.get(signed.lease.peerId),
      this.#monotonicNow(),
    );
  }

  async #applySync(
    meshId: string,
    rosterValue: SignedPeerMeshRosterV1,
    reachabilityValues: readonly SignedPeerReachabilityLeaseV1[],
    advertisementValues: readonly SignedPeerMeshMemberAdvertisementV1[],
  ): Promise<void> {
    const roster = decodeSignedPeerMeshRoster(rosterValue);
    if (roster.roster.meshId !== meshId) throw new Error('Peer Mesh synchronization changed Mesh');
    const reachability = this.#validateReachabilityPage(reachabilityValues, roster, true);
    const advertisements = this.#validateAdvertisementPage(advertisementValues, roster);
    const localPeerId = this.#peer.identity().peerId;
    const accepted = await this.#store.mutate((current) => {
      const state = findMesh(current.meshes, meshId);
      if (!state || state.roster.authorityPublicKey !== roster.authorityPublicKey) {
        throw new Error('Peer Mesh synchronization has the wrong authority');
      }
      const nextRoster = selectRoster(state.roster, roster);
      const next = {
        ...state,
        roster: nextRoster,
      };
      return {
        state: {
          ...current,
          meshes: replaceMesh(current.meshes, next),
          reachability: !isActiveMembership(next, localPeerId)
            ? current.reachability
            : mergeReachability(current.reachability, reachability, this.#now()),
          advertisements: !isActiveMembership(next, localPeerId)
            ? current.advertisements
            : mergeAdvertisements(current.advertisements, advertisements),
        },
        result: isActiveMembership(next, localPeerId),
      };
    });
    if (accepted) this.#recordReachabilityReceipts(reachability);
    await this.#refreshLocalEvidence();
    await this.#reconcileTransit();
  }

  #assertOpen(): void {
    if (this.#lifetime.signal.aborted) throw new Error('Peer Mesh node is closed');
  }

  async #updateAuthorityRoster(
    meshId: string,
    closedIsSuccess: boolean,
    update: (state: PeerMeshAuthorityStateV1) => {
      readonly members: readonly string[];
      readonly closed: boolean;
    },
  ): Promise<PeerMeshStatus> {
    const announcement = await this.#store.mutate((current) => {
      const state = requireAuthority(current.meshes, meshId);
      if (state.roster.roster.closed) {
        if (closedIsSuccess) {
          return {
            state: current,
            result: undefined,
          };
        }
        throw new Error('Peer Mesh is closed');
      }
      const next = update(state);
      const roster = signPeerMeshRoster(
        {
          version: 1,
          meshId: state.roster.roster.meshId,
          authorityPeerId: state.roster.roster.authorityPeerId,
          revision: state.roster.roster.revision + 1,
          members: next.members,
          closed: next.closed,
          ...(state.roster.roster.displayName
            ? { displayName: state.roster.roster.displayName }
            : {}),
        },
        authorityKeys(state),
      );
      const updated = {
        ...state,
        roster,
        invitations: next.closed
          ? state.invitations.filter(({ status }) => status === 'redeemed')
          : state.invitations.filter(
              (invitation) =>
                invitation.status === 'pending' || next.members.includes(invitation.peerId),
            ),
      };
      return {
        state: { ...current, meshes: replaceMesh(current.meshes, updated) },
        result: {
          roster,
          targets: rosterAnnouncementTargets(
            state.roster.roster.members,
            current.reachability,
            this.#peer.identity().peerId,
            this.#now(),
          ),
        },
      };
    });
    try {
      await this.#reconcileTransit();
    } finally {
      if (announcement) {
        this.#scheduleRosterAnnouncement(announcement.roster, announcement.targets);
      }
      this.#scheduleMaintenance();
    }
    const stored = this.#store.read();
    return peerMeshStatus(
      findMesh(stored.meshes, meshId)!,
      this.#peer.identity(),
      this.#endpointKind,
      stored.reachability,
      stored.advertisements,
      this.#now(),
      (peerId) => this.#peer.isConnected(peerId),
      (peerId) => this.resolveRoutes(peerId),
      (signed) => this.#isReachabilityCurrent(signed),
    );
  }

  #scheduleRosterAnnouncement(
    roster: SignedPeerMeshRosterV1,
    targets: readonly SignedPeerReachabilityLeaseV1[],
  ): void {
    if (targets.length === 0 || this.#lifetime.signal.aborted) return;
    const signal = this.#lifetime.signal;
    void Promise.allSettled(
      targets.map(async (target) => {
        const stream = await this.#peer.connectMeshControl(
          {
            ...dialTarget(target),
            directDeadlineMs: CONNECT_DEADLINE_MS,
          },
          signal,
        );
        try {
          const response = await exchangeControl(
            stream,
            {
              kind: 'announce-roster',
              meshId: roster.roster.meshId,
              roster,
            },
            decodeAnnounceRosterResponse,
            signal,
          );
          if (response.kind === 'roster-rejected') {
            throw new Error('Peer Mesh roster announcement was rejected');
          }
        } finally {
          await stream.close().catch(() => undefined);
        }
      }),
    );
  }

  #scheduleMaintenance(): void {
    this.#triggerReconciliation();
    void this.#refreshLocalEvidence().catch(() => undefined);
    void this.#reconcileTransit().catch(() => undefined);
  }

  #acceptIncoming(stream: RuntimeHostPeerNativeStream): void {
    let peerStreams = 0;
    for (const active of this.#activeControlStreams) {
      if (active.peerId === stream.peerId) peerStreams += 1;
    }
    if (
      this.#lifetime.signal.aborted ||
      this.#activeControlStreams.size >= MAX_ACTIVE_CONTROL_STREAMS ||
      peerStreams >= MAX_ACTIVE_CONTROL_STREAMS_PER_PEER
    ) {
      stream.abort();
      return;
    }
    this.#activeControlStreams.add(stream);
    void this.#handleIncoming(stream).finally(() => {
      this.#activeControlStreams.delete(stream);
    });
  }

  #admitMesh<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    const task = this.#admissionTail.then(() => {
      if (this.#lifetime.signal.aborted) throw new Error('Peer Mesh node is closed');
      return operation();
    });
    this.#admissionTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #handleIncoming(stream: RuntimeHostPeerNativeStream): Promise<void> {
    const deadline = setTimeout(() => stream.abort(), CONTROL_REQUEST_DEADLINE_MS);
    try {
      const request = decodeControlRequest(await readFrame(stream));
      let response:
        | RedeemInvitationResponse
        | SyncPeerMeshResponse
        | LeavePeerMeshResponse
        | AnnouncePeerMeshRosterResponse;
      if (request.kind === 'redeem-invitation') {
        await this.#refreshLocalEvidence();
        response = await this.#redeem(
          request,
          stream.peerId,
          this.#authenticateReachability(request.reachability, stream.peerId),
          this.#validateAdvertisementForPeer(request.advertisement, request.meshId, stream.peerId),
        );
      } else if (request.kind === 'sync') {
        response = await this.#sync(request, stream.peerId);
      } else if (request.kind === 'leave') {
        response = await this.#leave(request, stream.peerId);
      } else {
        response = await this.#observeRoster(request);
      }
      await writeFrame(stream, response);
      await stream.close();
      this.#scheduleMaintenance();
    } catch {
      stream.abort();
    } finally {
      clearTimeout(deadline);
    }
  }

  async #observeRoster(
    request: AnnouncePeerMeshRosterRequest,
  ): Promise<AnnouncePeerMeshRosterResponse> {
    const response = await this.#store.mutate<AnnouncePeerMeshRosterResponse>((current) => {
      const state = findMesh(current.meshes, request.meshId);
      if (!state || state.roster.authorityPublicKey !== request.roster.authorityPublicKey) {
        return {
          state: current,
          result: { kind: 'roster-rejected', reason: 'unknown' },
        };
      }
      const roster = selectRoster(state.roster, request.roster);
      return {
        state: {
          ...current,
          meshes: replaceMesh(current.meshes, { ...state, roster }),
        },
        result: { kind: 'roster-observed' },
      };
    });
    if (response.kind === 'roster-observed') await this.#reconcileTransit();
    return response;
  }

  async #redeem(
    request: RedeemInvitationRequest,
    remotePeerId: string,
    remoteReachability: SignedPeerReachabilityLeaseV1,
    remoteAdvertisement: SignedPeerMeshMemberAdvertisementV1,
  ): Promise<RedeemInvitationResponse> {
    const now = this.#now();
    const response = await this.#store.mutate<RedeemInvitationResponse>((current) => {
      const state = findMesh(current.meshes, request.meshId);
      if (!state || state.role !== 'authority')
        return { state: current, result: rejected('invalid') };
      const invitation = state.invitations.find(({ secretDigest }) =>
        matchesPeerMeshInvitationSecret(request.secret, secretDigest),
      );
      if (request.meshId !== state.roster.roster.meshId || !invitation) {
        return { state: current, result: rejected('invalid') };
      }
      if (invitation.status === 'redeemed') {
        if (
          invitation.peerId !== remotePeerId ||
          !state.roster.roster.members.includes(remotePeerId)
        ) {
          return { state: current, result: rejected('invalid') };
        }
        const reachability = mergeReachability(current.reachability, [remoteReachability], now);
        const advertisements = mergeAdvertisements(current.advertisements, [remoteAdvertisement]);
        const evidence = initialEvidence(
          state,
          reachability,
          advertisements,
          this.#peer.identity().peerId,
          now,
        );
        return {
          state: { ...current, reachability, advertisements },
          result: {
            kind: 'invitation-redeemed',
            roster: state.roster,
            ...evidence,
          },
        };
      }
      const remaining = state.invitations.filter(
        (record) =>
          record !== invitation && (record.status === 'redeemed' || record.expiresAt > now),
      );
      if (invitation.expiresAt <= now) {
        return {
          state: {
            ...current,
            meshes: replaceMesh(current.meshes, {
              ...state,
              invitations: remaining,
            }),
          },
          result: rejected('expired'),
        };
      }
      if (state.roster.roster.closed) {
        return {
          state: {
            ...current,
            meshes: replaceMesh(current.meshes, {
              ...state,
              invitations: remaining,
            }),
          },
          result: rejected('closed'),
        };
      }
      if (
        !state.roster.roster.members.includes(remotePeerId) &&
        state.roster.roster.members.length >= PEER_MESH_MAX_MEMBERS
      ) {
        return {
          state: {
            ...current,
            meshes: replaceMesh(current.meshes, {
              ...state,
              invitations: remaining,
            }),
          },
          result: rejected('full'),
        };
      }
      const existingMember = state.roster.roster.members.includes(remotePeerId);
      const roster = existingMember
        ? state.roster
        : signPeerMeshRoster(
            {
              ...state.roster.roster,
              revision: state.roster.roster.revision + 1,
              members: [...state.roster.roster.members, remotePeerId].sort(),
            },
            authorityKeys(state),
          );
      const updated = {
        ...state,
        roster,
        invitations: [
          ...remaining.filter(
            (record) => record.status === 'pending' || record.peerId !== remotePeerId,
          ),
          redeemedInvitation(invitation, remotePeerId),
        ],
      };
      const reachability = mergeReachability(current.reachability, [remoteReachability], now);
      const advertisements = mergeAdvertisements(current.advertisements, [remoteAdvertisement]);
      const evidence = initialEvidence(
        updated,
        reachability,
        advertisements,
        this.#peer.identity().peerId,
        now,
      );
      return {
        state: {
          ...current,
          meshes: replaceMesh(current.meshes, updated),
          reachability,
          advertisements,
        },
        result: {
          kind: 'invitation-redeemed',
          roster,
          ...evidence,
        },
      };
    });
    if (response.kind === 'invitation-redeemed') {
      this.#recordReachabilityReceipt(remoteReachability);
      const stored = this.#store.read();
      const state = findMesh(stored.meshes, request.meshId);
      if (state) {
        this.#scheduleRosterAnnouncement(
          state.roster,
          rosterAnnouncementTargets(
            state.roster.roster.members,
            stored.reachability,
            this.#peer.identity().peerId,
            this.#now(),
          ).filter(({ lease }) => lease.peerId !== remotePeerId),
        );
      }
    }
    return response;
  }

  async #leave(
    request: LeavePeerMeshRequest,
    remotePeerId: string,
  ): Promise<LeavePeerMeshResponse> {
    const response = await this.#store.mutate<LeavePeerMeshResponse>((current) => {
      const state = findMesh(current.meshes, request.meshId);
      if (
        !state ||
        state.role !== 'authority' ||
        request.roster.roster.meshId !== request.meshId ||
        request.roster.authorityPublicKey !== state.roster.authorityPublicKey ||
        request.roster.roster.revision > state.roster.roster.revision ||
        !request.roster.roster.members.includes(remotePeerId)
      ) {
        return {
          state: current,
          result: { kind: 'leave-rejected', reason: 'unknown' },
        };
      }
      if (state.roster.roster.closed || !state.roster.roster.members.includes(remotePeerId)) {
        return {
          state: current,
          result: { kind: 'left', roster: state.roster },
        };
      }
      const roster = signPeerMeshRoster(
        {
          ...state.roster.roster,
          revision: state.roster.roster.revision + 1,
          members: state.roster.roster.members.filter((peerId) => peerId !== remotePeerId),
        },
        authorityKeys(state),
      );
      const updated = {
        ...state,
        roster,
      };
      return {
        state: { ...current, meshes: replaceMesh(current.meshes, updated) },
        result: { kind: 'left', roster },
      };
    });
    if (response.kind === 'left') {
      await this.#reconcileTransit();
      const stored = this.#store.read();
      const state = findMesh(stored.meshes, request.meshId);
      if (state) {
        this.#scheduleRosterAnnouncement(
          state.roster,
          rosterAnnouncementTargets(
            state.roster.roster.members,
            stored.reachability,
            this.#peer.identity().peerId,
            this.#now(),
          ),
        );
      }
    }
    return response;
  }

  async #sync(request: SyncPeerMeshRequest, remotePeerId: string): Promise<SyncPeerMeshResponse> {
    const remoteReachability = this.#authenticateReachability(request.reachability, remotePeerId);
    const remoteAdvertisement = this.#validateAdvertisementForPeer(
      request.advertisement,
      request.meshId,
      remotePeerId,
    );
    await this.#refreshLocalEvidence();
    const incomingRoster = decodeSignedPeerMeshRoster(request.roster);
    const response = await this.#store.mutate<SyncPeerMeshResponse>((current) => {
      const state = findMesh(current.meshes, request.meshId);
      if (!state || state.roster.authorityPublicKey !== incomingRoster.authorityPublicKey) {
        return {
          state: current,
          result: { kind: 'sync-rejected', reason: 'unknown' } as const,
        };
      }
      const roster = selectRoster(state.roster, incomingRoster);
      const localPeerId = this.#peer.identity().peerId;
      const updated = {
        ...state,
        roster,
      };
      const localMember = isActiveMembership(updated, localPeerId);
      const remoteMember = !roster.roster.closed && roster.roster.members.includes(remotePeerId);
      const reachability =
        localMember && remoteMember
          ? mergeReachability(current.reachability, [remoteReachability], this.#now())
          : current.reachability;
      const advertisements =
        localMember && remoteMember
          ? mergeAdvertisements(current.advertisements, [remoteAdvertisement])
          : current.advertisements;
      if (!localMember || !remoteMember) {
        return {
          state: {
            ...current,
            meshes: replaceMesh(current.meshes, updated),
            reachability,
            advertisements,
          },
          result: {
            kind: 'sync-result',
            roster,
            reachability: [],
            advertisements: [],
            more: false,
          } as const,
        };
      }
      const page = responseEvidence(
        updated,
        reachability,
        advertisements,
        request.knownReachability,
        request.knownAdvertisements,
        this.#now(),
      );
      return {
        state: {
          ...current,
          meshes: replaceMesh(current.meshes, updated),
          reachability,
          advertisements,
        },
        result: {
          kind: 'sync-result',
          roster,
          ...page,
        } as const,
      };
    });
    if (response.kind === 'sync-result') {
      const localPeerId = this.#peer.identity().peerId;
      if (
        !response.roster.roster.closed &&
        response.roster.roster.members.includes(localPeerId) &&
        response.roster.roster.members.includes(remotePeerId)
      ) {
        this.#recordReachabilityReceipt(remoteReachability);
      }
      await this.#reconcileTransit();
    }
    return response;
  }

  #reconcileTransit(): Promise<void> {
    const task = this.#transitTail.then(() => this.#applyTransitSnapshot());
    this.#transitTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #applyTransitSnapshot(): Promise<void> {
    const stored = this.#store.read();
    const localPeerId = this.#peer.identity().peerId;
    const now = this.#now();
    const selected = stored.meshes.find(
      (mesh) =>
        mesh.roster.roster.meshId === stored.transitMeshId && isActiveMembership(mesh, localPeerId),
    );
    const eligibleRelays = eligibleTransitEvidence(stored, localPeerId, now, (signed) =>
      this.#isReachabilityCurrent(signed),
    );
    const relayCandidates = transitRelayCandidates(eligibleRelays);
    const approvedRelayPeerIds = [
      ...new Set(
        stored.meshes
          .filter((mesh) => isActiveMembership(mesh, localPeerId))
          .flatMap((mesh) => mesh.roster.roster.members)
          .filter((peerId) => peerId !== localPeerId),
      ),
    ].sort();
    await this.#peer.configureTransit({
      allowedPeerIds: selected
        ? selected.roster.roster.members.filter((peerId) => peerId !== localPeerId)
        : [],
      approvedRelayPeerIds,
      relayCandidates,
    });
  }
}

interface PeerMeshTransitEvidence {
  readonly meshId: string;
  readonly lease: SignedPeerReachabilityLeaseV1;
}

function sameResolvedRoutes(
  left: ReturnType<PeerMeshNode['resolveRoutes']>,
  right: ReturnType<PeerMeshNode['resolveRoutes']>,
): boolean {
  return (
    left.state === right.state &&
    sameStringValues(left.routeHints, right.routeHints) &&
    sameStringValues(left.coordinationRelays, right.coordinationRelays) &&
    sameStringValues(left.transitRelayPeerIds, right.transitRelayPeerIds)
  );
}

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function eligibleTransitEvidence(
  stored: PeerMeshStoredStateV1,
  localPeerId: string,
  now: number,
  isCurrent: (signed: SignedPeerReachabilityLeaseV1) => boolean,
): readonly PeerMeshTransitEvidence[] {
  const evidence = new Map<string, PeerMeshTransitEvidence>();
  for (const { advertisement } of stored.advertisements) {
    if (
      advertisement.peerId === localPeerId ||
      !advertisement.offersTransit ||
      !isActiveMeshMember(stored.meshes, advertisement.meshId, localPeerId, advertisement.peerId)
    ) {
      continue;
    }
    const lease = latestReachability(stored.reachability, advertisement.peerId, now, true);
    if (
      !lease ||
      !isCurrent(lease) ||
      lease.lease.directRoutes.length + lease.lease.coordinationRoutes.length === 0
    ) {
      continue;
    }
    evidence.set(advertisement.peerId, {
      meshId: advertisement.meshId,
      lease,
    });
  }
  return Object.freeze(
    [...evidence.values()].sort((left, right) =>
      left.lease.lease.peerId.localeCompare(right.lease.lease.peerId),
    ),
  );
}

function transitRelayCandidates(
  evidence: readonly PeerMeshTransitEvidence[],
): readonly RuntimeHostPeerTransitRelayCandidate[] {
  let remaining = PEER_MESH_MAX_TRANSIT_RELAY_ADDRESSES;
  const candidates: RuntimeHostPeerTransitRelayCandidate[] = [];
  for (const {
    lease: { lease },
  } of evidence) {
    if (remaining === 0) break;
    const routeHints = [
      ...new Set(lease.directRoutes.filter((address) => isBaseRelayFor(address, lease.peerId))),
    ].slice(0, Math.min(PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY, remaining));
    const coordinationRelays = [...new Set(lease.coordinationRoutes)].slice(
      0,
      Math.min(
        PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY - routeHints.length,
        remaining - routeHints.length,
      ),
    );
    if (routeHints.length + coordinationRelays.length === 0) continue;
    candidates.push(
      Object.freeze({
        peerId: lease.peerId,
        addresses: Object.freeze(routeHints),
        coordinationRelays: Object.freeze(coordinationRelays),
      }),
    );
    remaining -= routeHints.length + coordinationRelays.length;
  }
  return Object.freeze(candidates);
}

function isBaseRelayFor(address: string, peerId: string): boolean {
  const segments = address.split('/');
  const peerProtocol = segments.indexOf('p2p');
  return (
    !segments.includes('p2p-circuit') &&
    peerProtocol === segments.lastIndexOf('p2p') &&
    peerProtocol === segments.length - 2 &&
    segments.at(-1) === peerId
  );
}

function isActiveMeshMember(
  meshes: readonly PeerMeshStateV1[],
  meshId: string,
  localPeerId: string,
  peerId: string,
): boolean {
  return meshes.some(
    (mesh) =>
      mesh.roster.roster.meshId === meshId &&
      isActiveMembership(mesh, localPeerId) &&
      mesh.roster.roster.members.includes(peerId),
  );
}

function peerMeshStatus(
  state: PeerMeshStateV1,
  identity: ReturnType<PeerMeshTransport['identity']>,
  endpointKind: 'client' | 'host' | undefined,
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  advertisements: readonly SignedPeerMeshMemberAdvertisementV1[],
  now: number,
  isConnected: (peerId: string) => boolean,
  resolveRoutes: (peerId: string) => RuntimeHostPeerRouteResolution,
  isCurrent: (signed: SignedPeerReachabilityLeaseV1) => boolean,
): PeerMeshStatus {
  const meshId = state.roster.roster.meshId;
  const localAdvertisement = findAdvertisement(advertisements, meshId, identity.peerId);
  return Object.freeze({
    role: state.role === 'authority' ? 'authority' : 'member',
    authorityPeerId: state.roster.roster.authorityPeerId,
    roster: state.roster,
    pendingInvitationCount:
      state.role === 'authority'
        ? state.invitations.filter(
            (invitation) => invitation.status === 'pending' && invitation.expiresAt > now,
          ).length
        : 0,
    memberRoutes: Object.freeze(
      state.roster.roster.members.map((peerId) => {
        if (peerId === identity.peerId) {
          return Object.freeze({
            peerId,
            ...(endpointKind ? { endpointKind } : {}),
            ...(localAdvertisement?.advertisement.displayName
              ? { displayName: localAdvertisement.advertisement.displayName }
              : {}),
            state: 'local' as const,
          });
        }
        const advertisement = findAdvertisement(advertisements, meshId, peerId)?.advertisement;
        const signed = latestReachability(reachability, peerId, now, true);
        const lease = signed?.lease;
        const resolution = resolveRoutes(peerId);
        const current = Boolean(signed && isCurrent(signed));
        const memberState = isConnected(peerId)
          ? ('reachable' as const)
          : resolution.state === 'exhausted'
            ? ('needs_repair' as const)
            : resolution.state === 'recovering'
              ? signed
                ? ('reconnecting' as const)
                : ('connecting' as const)
              : current
                ? ('connecting' as const)
                : ('reconnecting' as const);
        return Object.freeze({
          peerId,
          ...(advertisement?.endpointKind ? { endpointKind: advertisement.endpointKind } : {}),
          ...(advertisement?.displayName ? { displayName: advertisement.displayName } : {}),
          state: memberState,
          ...(lease ? { expiresAt: lease.expiresAt } : {}),
        });
      }),
    ),
  });
}

function currentAuthorityTarget(
  state: PeerMeshReplicaStateV1,
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  now: number,
): SignedPeerReachabilityLeaseV1 | undefined {
  return latestReachability(reachability, state.roster.roster.authorityPeerId, now, true);
}

function rosterAnnouncementTargets(
  memberPeerIds: readonly string[],
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  localPeerId: string,
  now: number,
): readonly SignedPeerReachabilityLeaseV1[] {
  const members = new Set(memberPeerIds);
  return Object.freeze(
    reachability.filter(
      (signed) =>
        signed.lease.peerId !== localPeerId &&
        members.has(signed.lease.peerId) &&
        usableHistoricalReachability(signed, now),
    ),
  );
}

function requireAuthority(
  states: readonly PeerMeshStateV1[],
  meshId: string,
): PeerMeshAuthorityStateV1 {
  const state = findMesh(states, meshId);
  if (!state || state.role !== 'authority')
    throw new Error('Peer Mesh operation requires authority');
  return state;
}

function findMesh(states: readonly PeerMeshStateV1[], meshId: string): PeerMeshStateV1 | undefined {
  return states.find(({ roster }) => roster.roster.meshId === meshId);
}

function replaceMesh(
  states: readonly PeerMeshStateV1[],
  next: PeerMeshStateV1,
): readonly PeerMeshStateV1[] {
  return states.map((state) =>
    state.roster.roster.meshId === next.roster.roster.meshId ? next : state,
  );
}

function rejected(reason: RedeemInvitationRejectionReason) {
  return { kind: 'invitation-rejected', reason } as const;
}

function redeemedInvitation(invitation: { readonly secretDigest: string }, peerId: string) {
  return {
    status: 'redeemed' as const,
    secretDigest: invitation.secretDigest,
    peerId,
  };
}

function assertMeshCapacity(
  states: readonly PeerMeshStateV1[],
  localPeerId: string,
  pendingJoinCount = 0,
): void {
  if (
    states.filter((state) => !isRetired(state, localPeerId)).length + pendingJoinCount >=
    PEER_MESH_MAX_MESHES
  ) {
    throw new Error('This peer belongs to too many Peer Meshes');
  }
}

function appendMesh(
  states: readonly PeerMeshStateV1[],
  state: PeerMeshStateV1,
  localPeerId: string,
): readonly PeerMeshStateV1[] {
  if (states.length < PEER_MESH_MAX_MESHES) return [...states, state];
  const retired = states.findIndex((candidate) => isRetired(candidate, localPeerId));
  if (retired < 0) throw new Error('This peer belongs to too many Peer Meshes');
  return [...states.slice(0, retired), ...states.slice(retired + 1), state];
}

function assertRejoinSettled(state: PeerMeshStateV1 | undefined, localPeerId: string): void {
  if (
    state?.role === 'replica' &&
    state.desiredMembership === 'left' &&
    state.roster.roster.members.includes(localPeerId)
  ) {
    throw new Error('This Peer Mesh leave is still being reconciled');
  }
}

function selectRoster(
  current: SignedPeerMeshRosterV1,
  candidate: SignedPeerMeshRosterV1,
): SignedPeerMeshRosterV1 {
  if (
    current.roster.meshId !== candidate.roster.meshId ||
    current.authorityPublicKey !== candidate.authorityPublicKey ||
    current.roster.authorityPeerId !== candidate.roster.authorityPeerId
  ) {
    throw new Error('Peer Mesh roster has the wrong authority');
  }
  if (candidate.roster.revision < current.roster.revision) return current;
  if (candidate.roster.revision === current.roster.revision) {
    if (JSON.stringify(candidate) !== JSON.stringify(current)) {
      throw new Error('Peer Mesh roster revision identifies conflicting facts');
    }
    return current;
  }
  return candidate;
}

function mergeReachability(
  current: readonly SignedPeerReachabilityLeaseV1[],
  candidates: readonly SignedPeerReachabilityLeaseV1[],
  now: number,
): readonly SignedPeerReachabilityLeaseV1[] {
  const leases = new Map(
    current
      .filter((signed) => usableHistoricalReachability(signed, now))
      .map((signed) => [signed.lease.peerId, signed] as const),
  );
  for (const candidate of candidates) {
    if (!usableHistoricalReachability(candidate, now)) continue;
    const existing = leases.get(candidate.lease.peerId);
    if (!existing || candidate.lease.revision > existing.lease.revision) {
      leases.set(candidate.lease.peerId, candidate);
      continue;
    }
    if (
      candidate.lease.revision === existing.lease.revision &&
      reachabilityFactDigest(candidate) !== reachabilityFactDigest(existing)
    ) {
      throw new Error('Peer reachability revision identifies conflicting facts');
    }
  }
  return Object.freeze(
    [...leases.values()].sort((left, right) => left.lease.peerId.localeCompare(right.lease.peerId)),
  );
}

function mergeAdvertisements(
  current: readonly SignedPeerMeshMemberAdvertisementV1[],
  candidates: readonly SignedPeerMeshMemberAdvertisementV1[],
): readonly SignedPeerMeshMemberAdvertisementV1[] {
  const advertisements = new Map(
    current.map((signed) => [advertisementKey(signed.advertisement), signed] as const),
  );
  for (const candidate of candidates) {
    const key = advertisementKey(candidate.advertisement);
    const existing = advertisements.get(key);
    if (!existing || candidate.advertisement.revision > existing.advertisement.revision) {
      advertisements.set(key, candidate);
      continue;
    }
    if (
      candidate.advertisement.revision === existing.advertisement.revision &&
      advertisementFactDigest(candidate) !== advertisementFactDigest(existing)
    ) {
      throw new Error('Peer Mesh advertisement revision identifies conflicting facts');
    }
  }
  return Object.freeze(
    [...advertisements.values()].sort((left, right) =>
      advertisementKey(left.advertisement).localeCompare(advertisementKey(right.advertisement)),
    ),
  );
}

function reachabilitySummaries(
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  roster: SignedPeerMeshRosterV1,
  now: number,
): readonly PeerMeshEvidenceSummary[] {
  return Object.freeze(
    reachability
      .filter(
        (signed) =>
          usableHistoricalReachability(signed, now) &&
          roster.roster.members.includes(signed.lease.peerId),
      )
      .map((signed) =>
        Object.freeze({
          peerId: signed.lease.peerId,
          revision: signed.lease.revision,
          digest: reachabilityFactDigest(signed),
        }),
      )
      .sort((left, right) => left.peerId.localeCompare(right.peerId)),
  );
}

function advertisementSummaries(
  advertisements: readonly SignedPeerMeshMemberAdvertisementV1[],
  roster: SignedPeerMeshRosterV1,
): readonly PeerMeshEvidenceSummary[] {
  return Object.freeze(
    advertisements
      .filter(
        ({ advertisement }) =>
          advertisement.meshId === roster.roster.meshId &&
          roster.roster.members.includes(advertisement.peerId),
      )
      .map((signed) =>
        Object.freeze({
          peerId: signed.advertisement.peerId,
          revision: signed.advertisement.revision,
          digest: advertisementFactDigest(signed),
        }),
      )
      .sort((left, right) => left.peerId.localeCompare(right.peerId)),
  );
}

function responseEvidence(
  state: PeerMeshStateV1,
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  advertisements: readonly SignedPeerMeshMemberAdvertisementV1[],
  knownReachability: readonly PeerMeshEvidenceSummary[],
  knownAdvertisements: readonly PeerMeshEvidenceSummary[],
  now: number,
): {
  readonly reachability: readonly SignedPeerReachabilityLeaseV1[];
  readonly advertisements: readonly SignedPeerMeshMemberAdvertisementV1[];
  readonly more: boolean;
} {
  const knownLeases = new Map(knownReachability.map((summary) => [summary.peerId, summary]));
  const knownAds = new Map(knownAdvertisements.map((summary) => [summary.peerId, summary]));
  const missing = [
    ...reachability
      .filter(
        (signed) =>
          usableHistoricalReachability(signed, now) &&
          state.roster.roster.members.includes(signed.lease.peerId) &&
          evidenceRequiresTransfer(
            {
              peerId: signed.lease.peerId,
              revision: signed.lease.revision,
              digest: reachabilityFactDigest(signed),
            },
            knownLeases.get(signed.lease.peerId),
            'Peer reachability',
          ),
      )
      .map((value) => ({
        kind: 'reachability' as const,
        peerId: value.lease.peerId,
        value,
      })),
    ...advertisements
      .filter(
        (signed) =>
          signed.advertisement.meshId === state.roster.roster.meshId &&
          state.roster.roster.members.includes(signed.advertisement.peerId) &&
          evidenceRequiresTransfer(
            {
              peerId: signed.advertisement.peerId,
              revision: signed.advertisement.revision,
              digest: advertisementFactDigest(signed),
            },
            knownAds.get(signed.advertisement.peerId),
            'Peer Mesh advertisement',
          ),
      )
      .map((value) => ({
        kind: 'advertisement' as const,
        peerId: value.advertisement.peerId,
        value,
      })),
  ].sort((left, right) =>
    left.peerId === right.peerId
      ? left.kind.localeCompare(right.kind)
      : left.peerId.localeCompare(right.peerId),
  );
  const page = missing.slice(0, EVIDENCE_PAGE_SIZE);
  return Object.freeze({
    reachability: Object.freeze(
      page.flatMap((entry) => (entry.kind === 'reachability' ? [entry.value] : [])),
    ),
    advertisements: Object.freeze(
      page.flatMap((entry) => (entry.kind === 'advertisement' ? [entry.value] : [])),
    ),
    more: missing.length > EVIDENCE_PAGE_SIZE,
  });
}

function evidenceRequiresTransfer(
  local: PeerMeshEvidenceSummary,
  remote: PeerMeshEvidenceSummary | undefined,
  label: string,
): boolean {
  if (!remote || local.revision > remote.revision) return true;
  if (local.revision < remote.revision) return false;
  if (local.digest !== remote.digest) {
    throw new Error(`${label} revision identifies conflicting facts`);
  }
  return false;
}

function reachabilityFactDigest(signed: SignedPeerReachabilityLeaseV1): string {
  return evidenceDigest(peerReachabilityLeaseSigningBytes(signed.lease));
}

function advertisementFactDigest(signed: SignedPeerMeshMemberAdvertisementV1): string {
  return evidenceDigest(peerMeshMemberAdvertisementSigningBytes(signed.advertisement));
}

function evidenceDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function initialEvidence(
  state: PeerMeshStateV1,
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  advertisements: readonly SignedPeerMeshMemberAdvertisementV1[],
  localPeerId: string,
  now: number,
): {
  readonly reachability: readonly SignedPeerReachabilityLeaseV1[];
  readonly advertisements: readonly SignedPeerMeshMemberAdvertisementV1[];
} {
  const lease = latestReachability(reachability, localPeerId, now, true);
  const advertisement = findAdvertisement(advertisements, state.roster.roster.meshId, localPeerId);
  if (!lease || !advertisement) throw new Error('Peer Mesh authority evidence is unavailable');
  return Object.freeze({
    reachability: Object.freeze([lease]),
    advertisements: Object.freeze([advertisement]),
  });
}

function isCurrentLocalAdvertisement(
  existing: SignedPeerMeshMemberAdvertisementV1 | undefined,
  meshId: string,
  peerId: string,
  current: Pick<PeerMeshStoredStateV1, 'displayName' | 'transitMeshId'>,
  endpointKind: 'client' | 'host' | undefined,
): existing is SignedPeerMeshMemberAdvertisementV1 {
  return Boolean(
    existing &&
      existing.advertisement.meshId === meshId &&
      existing.advertisement.peerId === peerId &&
      existing.advertisement.endpointKind === endpointKind &&
      existing.advertisement.displayName === (current.displayName ?? undefined) &&
      existing.advertisement.offersTransit === (current.transitMeshId === meshId),
  );
}

function latestReachability(
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  peerId: string,
  now: number,
  includeHistorical: boolean,
): SignedPeerReachabilityLeaseV1 | undefined {
  const signed = reachability.find(({ lease }) => lease.peerId === peerId);
  if (!signed) return undefined;
  if (signed.lease.expiresAt > now) return signed;
  return includeHistorical && usableHistoricalReachability(signed, now) ? signed : undefined;
}

function emptyRouteResolution(state: 'recovering' | 'exhausted'): RuntimeHostPeerRouteResolution {
  return Object.freeze({
    state,
    routeHints: Object.freeze([]),
    coordinationRelays: Object.freeze([]),
    transitRelayPeerIds: Object.freeze([]),
  });
}

function hasPeerRecoverySource(
  stored: PeerMeshStoredStateV1,
  sharedMeshIds: readonly string[],
  targetPeerId: string,
  localPeerId: string,
  now: number,
): boolean {
  const shared = new Set(sharedMeshIds);
  const sourcePeerIds = new Set(
    stored.meshes
      .filter(({ roster }) => shared.has(roster.roster.meshId))
      .flatMap(({ roster }) => roster.roster.members)
      .filter((peerId) => peerId !== localPeerId && peerId !== targetPeerId),
  );
  for (const sourcePeerId of sourcePeerIds) {
    const signed = latestReachability(stored.reachability, sourcePeerId, now, true);
    if (signed && hasReachabilityRoutes(signed)) return true;
  }
  return false;
}

function hasReachabilityRoutes(signed: SignedPeerReachabilityLeaseV1): boolean {
  return signed.lease.directRoutes.length + signed.lease.coordinationRoutes.length > 0;
}

function usableHistoricalReachability(signed: SignedPeerReachabilityLeaseV1, now: number): boolean {
  return signed.lease.expiresAt > now - PEER_REACHABILITY_RECOVERY_HORIZON_MS;
}

function peerTarget(
  peerId: string,
  reachability: readonly SignedPeerReachabilityLeaseV1[],
  now: number,
): SignedPeerReachabilityLeaseV1 | undefined {
  return latestReachability(reachability, peerId, now, true);
}

function dialTarget(reachability: SignedPeerReachabilityLeaseV1): {
  readonly peerId: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
} {
  return Object.freeze({
    peerId: reachability.lease.peerId,
    routeHints: reachability.lease.directRoutes,
    coordinationRelays: reachability.lease.coordinationRoutes,
  });
}

function findAdvertisement(
  advertisements: readonly SignedPeerMeshMemberAdvertisementV1[],
  meshId: string,
  peerId: string,
): SignedPeerMeshMemberAdvertisementV1 | undefined {
  return advertisements.find(
    ({ advertisement }) => advertisement.meshId === meshId && advertisement.peerId === peerId,
  );
}

function advertisementKey(advertisement: {
  readonly meshId: string;
  readonly peerId: string;
}): string {
  return `${advertisement.meshId}\n${advertisement.peerId}`;
}

function mergeAddresses(
  primary: readonly string[],
  fallback: readonly string[],
): readonly string[] {
  return Object.freeze([...new Set([...primary, ...fallback])].slice(0, 32));
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

async function exchangeControl<Request, Response>(
  stream: RuntimeHostPeerNativeStream,
  request: Request,
  decode: (value: unknown) => Response,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(CONTROL_REQUEST_DEADLINE_MS);
  const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const abort = () => stream.abort();
  operationSignal.addEventListener('abort', abort, { once: true });
  if (operationSignal.aborted) abort();
  try {
    operationSignal.throwIfAborted();
    await writeFrame(stream, request);
    const response = decode(await readFrame(stream));
    operationSignal.throwIfAborted();
    return response;
  } catch (error) {
    operationSignal.throwIfAborted();
    throw error;
  } finally {
    operationSignal.removeEventListener('abort', abort);
  }
}

function decodeControlRequest(value: unknown): PeerMeshControlRequest {
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

function decodeRedeemResponse(value: unknown): RedeemInvitationResponse {
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

function decodeSyncResponse(value: unknown): SyncPeerMeshResponse {
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

function decodeLeaveResponse(value: unknown): LeavePeerMeshResponse {
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

function decodeAnnounceRosterResponse(value: unknown): AnnouncePeerMeshRosterResponse {
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

async function writeFrame(stream: RuntimeHostPeerNativeStream, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > CONTROL_FRAME_MAX_BYTES)
    throw new Error('Peer Mesh control frame is too large');
  await stream.write(bytes);
}

async function readFrame(stream: RuntimeHostPeerNativeStream): Promise<unknown> {
  let buffered = Buffer.alloc(0);
  for (;;) {
    const chunk = await stream.read();
    if (!chunk) throw new Error('Peer Mesh control stream ended before a frame arrived');
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > CONTROL_FRAME_MAX_BYTES)
      throw new Error('Peer Mesh control frame is too large');
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) continue;
    if (buffered.subarray(newline + 1).some((byte) => byte > 0x20)) {
      throw new Error('Peer Mesh control stream contained multiple frames');
    }
    return JSON.parse(buffered.subarray(0, newline).toString('utf8')) as unknown;
  }
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
