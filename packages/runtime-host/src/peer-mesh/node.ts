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

import type {
  RuntimeHostPeerIdentityProof,
  RuntimeHostPeerNativeStream,
  RuntimeHostPeerTransitRelayCandidate,
  RuntimeHostPeerTransitSnapshot,
} from '../transport/peer-native.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalPeerMeshRoster,
  canonicalPeerMeshRouteRecord,
  createPeerMeshInvitationSecret,
  validatePeerMeshInvitation,
  decodeSignedPeerMeshRoster,
  decodeSignedPeerMeshRouteRecord,
  generatePeerMeshAuthorityKeyPair,
  matchesPeerMeshInvitationSecret,
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_MESHES,
  PEER_MESH_MAX_INVITATION_RECORDS,
  PEER_MESH_MAX_PENDING_INVITATIONS,
  PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY,
  PEER_MESH_MAX_TRANSIT_RELAY_ADDRESSES,
  peerMeshRouteRecordSigningBytes,
  peerMeshId,
  peerMeshInvitationSecretDigest,
  signPeerMeshRoster,
  type PeerMeshAuthorityTarget,
  type PeerMeshRouteRecordV1,
  type SignedPeerMeshRosterV1,
  type SignedPeerMeshRouteRecordV1,
} from './model.js';
import { canonicalPeerMeshDisplayName } from './display-name.js';
import type { PeerMeshInvitationV1 } from '../protocol/peer-mesh.js';
import {
  authorityKeys,
  openPeerMeshStateStore,
  type PeerMeshAuthorityStateV1,
  type PeerMeshReplicaStateV1,
  type PeerMeshStateStore,
  type PeerMeshStateV1,
  type PeerMeshStoredStateV1,
} from './store.js';

const CONTROL_FRAME_MAX_BYTES = 64 * 1024;
const DEFAULT_INVITATION_TTL_MS = 15 * 60 * 1_000;
const CONNECT_DEADLINE_MS = 30_000;
const CONTROL_REQUEST_DEADLINE_MS = 10_000;
const MAX_ACTIVE_CONTROL_STREAMS = 32;
const MAX_ACTIVE_CONTROL_STREAMS_PER_PEER = 2;
const ROUTE_TTL_MS = 5 * 60 * 1_000;
const ROUTE_REFRESH_LEAD_MS = 60 * 1_000;
const ROUTE_MAX_FUTURE_MS = 10 * 60 * 1_000;
const ROUTE_PAGE_SIZE = 8;
const RECONCILE_CONCURRENCY = 4;
const RECONCILE_DEADLINE_MS = 60 * 1_000;
const RECONCILE_INTERVAL_MS = 30 * 1_000;

interface RedeemInvitationRequest {
  readonly kind: 'redeem-invitation';
  readonly meshId: string;
  readonly secret: string;
  readonly route: SignedPeerMeshRouteRecordV1;
}

type RedeemInvitationResponse =
  | {
      readonly kind: 'invitation-redeemed';
      readonly roster: SignedPeerMeshRosterV1;
      readonly routes: readonly SignedPeerMeshRouteRecordV1[];
    }
  | {
      readonly kind: 'invitation-rejected';
      readonly reason: RedeemInvitationRejectionReason;
    };

type RedeemInvitationRejectionReason = 'invalid' | 'expired' | 'closed' | 'full';

interface PeerMeshRouteSequence {
  readonly peerId: string;
  readonly sequence: number;
}

interface SyncPeerMeshRequest {
  readonly kind: 'sync';
  readonly meshId: string;
  readonly roster: SignedPeerMeshRosterV1;
  readonly route: SignedPeerMeshRouteRecordV1;
  readonly knownRoutes: readonly PeerMeshRouteSequence[];
}

type SyncPeerMeshResponse =
  | {
      readonly kind: 'sync-result';
      readonly roster: SignedPeerMeshRosterV1;
      readonly routes: readonly SignedPeerMeshRouteRecordV1[];
      readonly more: boolean;
    }
  | { readonly kind: 'sync-rejected'; readonly reason: 'unknown' };

interface LeavePeerMeshRequest {
  readonly kind: 'leave';
  readonly meshId: string;
}

type LeavePeerMeshResponse =
  | { readonly kind: 'left'; readonly roster: SignedPeerMeshRosterV1 }
  | { readonly kind: 'leave-rejected'; readonly reason: 'unknown' };

type PeerMeshControlRequest = RedeemInvitationRequest | SyncPeerMeshRequest | LeavePeerMeshRequest;

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
  resolveRoutes(peerId: string):
    | {
        readonly routeHints: readonly string[];
        readonly coordinationRelays: readonly string[];
        readonly transitRelayPeerIds: readonly string[];
      }
    | undefined;
  prepareRoutes(peerId: string, signal: AbortSignal): Promise<void>;
  reconcile(signal?: AbortSignal): Promise<void>;
  serve(): Promise<void>;
  close(): Promise<void>;
}

export interface PeerMeshStatus {
  readonly role: 'authority' | 'member';
  readonly authority: PeerMeshAuthorityTarget;
  readonly roster: SignedPeerMeshRosterV1;
  readonly pendingInvitationCount: number;
  readonly memberRoutes: readonly PeerMeshMemberRouteStatus[];
}

export interface PeerMeshMemberRouteStatus {
  readonly peerId: string;
  readonly endpointKind?: 'client' | 'host';
  readonly displayName?: string;
  readonly state: 'local' | 'route_available' | 'coordination_only' | 'stale' | 'unknown';
  readonly expiresAt?: number;
}

export interface PeerMeshTransport {
  identity(): Readonly<{
    peerId: string;
    listenAddresses: readonly string[];
    coordinationRelays: readonly string[];
  }>;
  signIdentity(payload: Buffer): Promise<RuntimeHostPeerIdentityProof>;
  verifyIdentity(peerId: string, payload: Buffer, proof: RuntimeHostPeerIdentityProof): boolean;
  transitSnapshot(): RuntimeHostPeerTransitSnapshot;
  configureTransit(input: {
    readonly allowedPeerIds: readonly string[];
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
  readonly endpointKind?: 'client' | 'host';
  readonly now?: () => number;
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
  readonly #endpointKind: 'client' | 'host' | undefined;
  readonly #now: () => number;
  readonly #activeControlStreams = new Set<RuntimeHostPeerNativeStream>();
  readonly #lifetime = new AbortController();
  #admissionTail = Promise.resolve();
  #reconcileTail = Promise.resolve();
  #reconcileCursor = 0;
  #gossipCursor = 0;
  #routeRefreshTask: Promise<SignedPeerMeshRouteRecordV1 | undefined> | undefined;
  #serveTask: Promise<void> | undefined;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    readonly store: PeerMeshStateStore;
    readonly peer: PeerMeshTransport;
    readonly endpointKind?: 'client' | 'host';
    readonly now?: () => number;
  }) {
    this.#store = input.store;
    this.#peer = input.peer;
    this.#endpointKind = input.endpointKind;
    this.#now = input.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    for (const route of this.#store.read().routes) this.#assertRouteSignature(route);
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
        const state = { ...current, displayName: canonical };
        const localPeerId = this.#peer.identity().peerId;
        if (!state.meshes.some((mesh) => isActiveMembership(mesh, localPeerId))) {
          return { state, result: undefined };
        }
        const route = await this.#signLocalRoute(state);
        return {
          state: {
            ...state,
            routes: mergeRoutes(state.routes, [route], this.#now()),
          },
          result: undefined,
        };
      });
      void this.reconcile().catch(() => undefined);
    });
  }

  setMeshDisplayName(meshId: string, displayName: string | null): Promise<PeerMeshStatus> {
    return this.#admitMesh(async () => {
      const canonical =
        displayName === null ? undefined : canonicalPeerMeshDisplayName(displayName);
      await this.#store.mutate((current) => {
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
          state: { ...current, meshes: replaceMesh(current.meshes, { ...state, roster }) },
          result: undefined,
        };
      });
      const stored = this.#store.read();
      return peerMeshStatus(
        requireAuthority(stored.meshes, meshId),
        this.#peer.identity(),
        this.#endpointKind,
        stored.routes,
        this.#now(),
      );
    });
  }

  status(): readonly PeerMeshStatus[] {
    this.#assertOpen();
    const identity = this.#peer.identity();
    const stored = this.#store.read();
    return Object.freeze(
      stored.meshes
        .filter((state) => isActiveMembership(state, identity.peerId))
        .map((state) =>
          peerMeshStatus(state, identity, this.#endpointKind, stored.routes, this.#now()),
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
      const signedRoute = await this.#signLocalRoute();
      const now = this.#now();
      await this.#store.mutate((current) => {
        assertMeshCapacity(current.meshes, identity.peerId);
        const currentLocalRoute = current.routes
          .filter(({ route }) => route.peerId === identity.peerId)
          .sort((left, right) => right.route.sequence - left.route.sequence)[0];
        const localRoute =
          currentLocalRoute && currentLocalRoute.route.sequence >= signedRoute.route.sequence
            ? currentLocalRoute
            : signedRoute;
        return {
          state: {
            ...current,
            meshes: appendMesh(current.meshes, state, identity.peerId),
            routes: mergeRoutes(current.routes, [localRoute], now),
          },
          result: undefined,
        };
      });
      const stored = this.#store.read();
      return peerMeshStatus(
        findMesh(stored.meshes, state.roster.roster.meshId)!,
        identity,
        this.#endpointKind,
        stored.routes,
        now,
      );
    });
  }

  invite(meshId: string, input: { readonly ttlMs?: number } = {}): Promise<PeerMeshInvitationV1> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    const now = this.#now();
    const identity = this.#peer.identity();
    const ttlMs = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      return Promise.reject(
        new Error('Peer Mesh invitation TTL must be between 1 second and 1 day'),
      );
    }
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
      const target = authorityTarget(identity);
      const invitation: PeerMeshInvitationV1 = {
        version: 1,
        meshId: state.roster.roster.meshId,
        authorityPublicKey: state.roster.authorityPublicKey,
        secret,
        expiresAt,
        ...target,
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
      if (invitation.expiresAt <= this.#now()) {
        throw new Error('Peer Mesh invitation has expired');
      }
      const current = this.#store.read();
      const existing = findMesh(current.meshes, invitation.meshId);
      const localPeerId = this.#peer.identity().peerId;
      if (existing?.role === 'authority') {
        throw new Error('This peer already belongs to that Peer Mesh');
      }
      if (!existing) assertMeshCapacity(current.meshes, localPeerId);
      const operationSignal = signal
        ? AbortSignal.any([signal, this.#lifetime.signal])
        : this.#lifetime.signal;
      const stream = await this.#peer.connectMeshControl(
        {
          peerId: invitation.peerId,
          routeHints: invitation.routeHints,
          coordinationRelays: invitation.coordinationRelays,
          directDeadlineMs: CONNECT_DEADLINE_MS,
        },
        operationSignal,
      );
      try {
        const localRoute = (await this.#refreshLocalRoute()) ?? (await this.#signLocalRoute());
        const request: RedeemInvitationRequest = {
          kind: 'redeem-invitation',
          meshId: invitation.meshId,
          secret: invitation.secret,
          route: localRoute,
        };
        const response = await exchangeControl(
          stream,
          request,
          decodeRedeemResponse,
          operationSignal,
        );
        if (response.kind === 'invitation-rejected') {
          throw new Error(`Peer Mesh invitation was rejected: ${response.reason}`);
        }
        const roster = decodeSignedPeerMeshRoster(response.roster);
        const identity = this.#peer.identity();
        if (
          roster.roster.meshId !== invitation.meshId ||
          roster.authorityPublicKey !== invitation.authorityPublicKey ||
          !roster.roster.members.includes(identity.peerId)
        ) {
          throw new Error('Peer Mesh authority returned an unrelated roster');
        }
        const routes = await this.#validateRoutes(response.routes, roster, this.#now());
        operationSignal.throwIfAborted();
        await this.#store.mutate((current) => {
          const existing = findMesh(current.meshes, invitation.meshId);
          if (existing?.role === 'authority') {
            throw new Error('This peer already belongs to that Peer Mesh');
          }
          const selectedRoster = existing ? selectRoster(existing.roster, roster) : roster;
          if (!selectedRoster.roster.members.includes(identity.peerId)) {
            throw new Error('Peer Mesh invitation did not establish an active membership');
          }
          const state: PeerMeshStateV1 = {
            role: 'replica',
            authority: {
              peerId: invitation.peerId,
              routeHints: invitation.routeHints,
              coordinationRelays: invitation.coordinationRelays,
            },
            roster: selectedRoster,
          };
          if (!existing) assertMeshCapacity(current.meshes, identity.peerId);
          const meshes = existing
            ? replaceMesh(current.meshes, state)
            : appendMesh(current.meshes, state, identity.peerId);
          return {
            state: {
              ...current,
              meshes,
              routes: mergeRoutes(current.routes, [...routes, localRoute], this.#now()),
            },
            result: undefined,
          };
        });
        await this.#refreshLocalRoute();
        await this.#reconcileTransit();
        const stored = this.#store.read();
        return peerMeshStatus(
          findMesh(stored.meshes, invitation.meshId)!,
          identity,
          this.#endpointKind,
          stored.routes,
        );
      } finally {
        await stream.close().catch(() => undefined);
      }
    });
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
      const stored = this.#store.read();
      const state = findMesh(stored.meshes, meshId);
      const localPeerId = this.#peer.identity().peerId;
      if (!state || !isActiveMembership(state, localPeerId)) {
        throw new Error('This peer does not belong to that Peer Mesh');
      }
      if (state.role === 'authority') {
        throw new Error('Close a Peer Mesh instead of leaving its authority');
      }
      const operationSignal = signal
        ? AbortSignal.any([signal, this.#lifetime.signal])
        : this.#lifetime.signal;
      const stream = await this.#peer.connectMeshControl(
        {
          ...currentAuthorityTarget(state, stored.routes),
          directDeadlineMs: CONNECT_DEADLINE_MS,
        },
        operationSignal,
      );
      try {
        const response = await exchangeControl(
          stream,
          { kind: 'leave', meshId },
          decodeLeaveResponse,
          operationSignal,
        );
        if (response.kind === 'leave-rejected') {
          throw new Error('Peer Mesh authority rejected the leave request');
        }
        await this.#applySync(meshId, response.roster, []);
      } finally {
        await stream.close().catch(() => undefined);
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
      await this.#store.mutate((current) => {
        if (
          meshId !== null &&
          !current.meshes.some(
            (mesh) => mesh.roster.roster.meshId === meshId && isActiveMembership(mesh, localPeerId),
          )
        ) {
          throw new Error('Transit requires an active Peer Mesh membership');
        }
        return {
          state: { ...current, transitMeshId: meshId },
          result: undefined,
        };
      });
      try {
        await this.#reconcileTransit();
        await this.#refreshLocalRoute();
      } catch {
        void this.reconcile().catch(() => undefined);
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
    const sharedMeshIds = stored.meshes
      .filter(
        (state) =>
          isActiveMembership(state, this.#peer.identity().peerId) &&
          state.roster.roster.members.includes(peerId),
      )
      .map(({ roster }) => roster.roster.meshId);
    const visible = sharedMeshIds.length > 0;
    if (!visible) return undefined;
    const route = stored.routes
      .filter(({ route }) => route.peerId === peerId && route.expiresAt > now)
      .sort((left, right) => right.route.sequence - left.route.sequence)[0]?.route;
    const localPeerId = this.#peer.identity().peerId;
    const transitRelayPeerIds = transitRelayCandidates(
      stored.routes
        .filter(
          ({ route: candidate }) =>
            candidate.peerId !== localPeerId &&
            candidate.peerId !== peerId &&
            candidate.expiresAt > now &&
            candidate.transitMeshId !== undefined &&
            sharedMeshIds.includes(candidate.transitMeshId) &&
            isActiveMeshMember(
              stored.meshes,
              candidate.transitMeshId,
              localPeerId,
              candidate.peerId,
            ),
        )
        .sort((left, right) => left.route.peerId.localeCompare(right.route.peerId)),
    ).map(({ peerId: relayPeerId }) => relayPeerId);
    if (!route && transitRelayPeerIds.length === 0) return undefined;
    return Object.freeze({
      routeHints: route?.routeHints ?? [],
      coordinationRelays: route?.coordinationRelays ?? [],
      transitRelayPeerIds: Object.freeze(transitRelayPeerIds),
    });
  }

  async prepareRoutes(peerId: string, signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    signal.throwIfAborted();
    const localPeerId = this.#peer.identity().peerId;
    const stored = this.#store.read();
    const visible = stored.meshes.some(
      (mesh) =>
        isActiveMembership(mesh, localPeerId) && mesh.roster.roster.members.includes(peerId),
    );
    if (!visible) return;
    if (
      stored.routes.some(({ route }) => route.peerId === peerId && route.expiresAt > this.#now())
    ) {
      return;
    }
    await this.reconcile(signal);
  }

  reconcile(signal?: AbortSignal): Promise<void> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    const previous = this.#reconcileTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#reconcileTail = previous.then(() => turn);
    return waitForTurn(previous, signal)
      .then(() => this.#reconcile(signal))
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
    await this.#serveTask?.catch(() => undefined);
    for (const stream of this.#activeControlStreams) stream.abort();
    this.#activeControlStreams.clear();
    await Promise.all([this.#admissionTail, this.#reconcileTail]);
    return this.#store.close();
  }

  async #runReconciliation(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.reconcile(signal).catch(() => undefined);
      await delay(RECONCILE_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
  }

  async #reconcile(signal?: AbortSignal): Promise<void> {
    const lifetimeSignal = signal
      ? AbortSignal.any([signal, this.#lifetime.signal])
      : this.#lifetime.signal;
    lifetimeSignal.throwIfAborted();
    await this.#reconcileTransit();
    await this.#refreshLocalRoute();
    const identity = this.#peer.identity();
    const stored = this.#store.read();
    const memberships = stored.meshes.filter(
      (state): state is PeerMeshReplicaStateV1 =>
        state.role === 'replica' && isActiveMembership(state, identity.peerId),
    );
    const pending: Array<{
      readonly meshId: string;
      readonly targets: readonly PeerMeshAuthorityTarget[];
      readonly authorityRouteExpired: boolean;
    }> = [];
    const gossipCursor = this.#gossipCursor;
    this.#gossipCursor = (this.#gossipCursor + 1) % PEER_MESH_MAX_MEMBERS;
    const now = this.#now();
    for (const [index, state] of memberships.entries()) {
      const authorityRoute = stored.routes.find(
        ({ route }) => route.peerId === state.authority.peerId,
      );
      const targets = [currentAuthorityTarget(state, stored.routes)];
      const gossipRoutes = state.roster.roster.members
        .filter((peerId) => peerId !== identity.peerId && peerId !== state.authority.peerId)
        .flatMap((peerId) => {
          const route = stored.routes.find((candidate) => candidate.route.peerId === peerId)?.route;
          return route ? [route] : [];
        });
      if (gossipRoutes.length > 0) {
        targets.push(gossipRoutes[(gossipCursor + index) % gossipRoutes.length]!);
      }
      pending.push({
        meshId: state.roster.roster.meshId,
        targets,
        authorityRouteExpired:
          authorityRoute !== undefined && authorityRoute.route.expiresAt <= now,
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
        const { meshId, targets, authorityRouteExpired } =
          pending[(start + offset) % pending.length]!;
        try {
          await this.#syncTargets(meshId, targets, authorityRouteExpired, operationSignal);
        } catch (error) {
          if (lifetimeSignal.aborted) lifetimeSignal.throwIfAborted();
          failures.push(error);
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
        'Peer Mesh synchronization did not reach every membership',
      );
    }
  }

  async #syncTargets(
    meshId: string,
    targets: readonly PeerMeshAuthorityTarget[],
    authorityRouteExpired: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!authorityRouteExpired || targets.length === 1) {
      try {
        await this.#syncPeer(meshId, targets[0]!, signal);
      } catch (authorityFailure) {
        const fallbackTargets = targets.slice(1);
        if (fallbackTargets.length === 0) throw authorityFailure;
        await Promise.any(fallbackTargets.map((target) => this.#syncPeer(meshId, target, signal)));
      }
      return;
    }
    const controllers = targets.map(() => new AbortController());
    const authorityPeerId = targets[0]!.peerId;
    const attempts = targets.map(async (target, index) => {
      await this.#syncPeer(meshId, target, AbortSignal.any([signal, controllers[index]!.signal]));
      if (index > 0 && !this.#hasFreshRoute(meshId, authorityPeerId)) {
        throw new Error('Peer Mesh gossip did not recover the authority route');
      }
    });
    try {
      await Promise.any(attempts);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(attempts);
    }
  }

  #hasFreshRoute(meshId: string, peerId: string): boolean {
    const stored = this.#store.read();
    const mesh = findMesh(stored.meshes, meshId);
    return Boolean(
      mesh &&
        isActiveMembership(mesh, this.#peer.identity().peerId) &&
        stored.routes.some(({ route }) => route.peerId === peerId && route.expiresAt > this.#now()),
    );
  }

  async #syncPeer(
    meshId: string,
    target: PeerMeshAuthorityTarget,
    signal: AbortSignal,
  ): Promise<void> {
    for (let page = 0; page <= Math.ceil(PEER_MESH_MAX_MEMBERS / ROUTE_PAGE_SIZE); page += 1) {
      await this.#refreshLocalRoute();
      const stored = this.#store.read();
      const state = findMesh(stored.meshes, meshId);
      const localPeerId = this.#peer.identity().peerId;
      if (!state || !isActiveMembership(state, localPeerId)) return;
      const route = stored.routes.find((candidate) => candidate.route.peerId === localPeerId);
      if (!route) throw new Error('Peer Mesh local route is unavailable');
      const discovered = this.resolveRoutes(target.peerId);
      const stream = await this.#peer.connectMeshControl(
        {
          peerId: target.peerId,
          routeHints: mergeAddresses(discovered?.routeHints ?? [], target.routeHints),
          coordinationRelays: mergeAddresses(
            discovered?.coordinationRelays ?? [],
            target.coordinationRelays,
          ),
          transitRelayPeerIds: discovered?.transitRelayPeerIds,
          directDeadlineMs: CONNECT_DEADLINE_MS,
        },
        signal,
      );
      try {
        const response = await exchangeControl(
          stream,
          {
            kind: 'sync',
            meshId,
            roster: state.roster,
            route,
            knownRoutes: routeSequences(stored.routes, state.roster, this.#now()),
          },
          decodeSyncResponse,
          signal,
        );
        if (response.kind === 'sync-rejected') {
          throw new Error(`Peer Mesh synchronization was rejected: ${response.reason}`);
        }
        await this.#applySync(meshId, response.roster, response.routes);
        if (!response.more) return;
      } finally {
        await stream.close().catch(() => undefined);
      }
    }
    throw new Error('Peer Mesh synchronization exceeded its page bound');
  }

  #refreshLocalRoute(): Promise<SignedPeerMeshRouteRecordV1 | undefined> {
    this.#routeRefreshTask ??= this.#refreshLocalRouteOnce().finally(() => {
      this.#routeRefreshTask = undefined;
    });
    return this.#routeRefreshTask;
  }

  async #refreshLocalRouteOnce(): Promise<SignedPeerMeshRouteRecordV1 | undefined> {
    const identity = this.#peer.identity();
    const now = this.#now();
    return this.#store.mutate(async (current) => {
      if (!current.meshes.some((state) => isActiveMembership(state, identity.peerId))) {
        return { state: current, result: undefined };
      }
      const existing = current.routes
        .filter(({ route }) => route.peerId === identity.peerId)
        .sort((left, right) => right.route.sequence - left.route.sequence)[0];
      if (
        existing &&
        existing.route.expiresAt > now + ROUTE_REFRESH_LEAD_MS &&
        sameAddresses(existing.route.routeHints, identity.listenAddresses) &&
        sameAddresses(existing.route.coordinationRelays, identity.coordinationRelays) &&
        existing.route.endpointKind === this.#endpointKind &&
        existing.route.displayName === (current.displayName ?? undefined) &&
        existing.route.transitMeshId === current.transitMeshId
      ) {
        return { state: current, result: existing };
      }
      const route = await this.#signLocalRoute(current);
      return {
        state: { ...current, routes: mergeRoutes(current.routes, [route], now) },
        result: route,
      };
    });
  }

  async #signLocalRoute(
    stored: PeerMeshStoredStateV1 = this.#store.read(),
  ): Promise<SignedPeerMeshRouteRecordV1> {
    const identity = this.#peer.identity();
    const maxSequence = stored.routes
      .filter(({ route }) => route.peerId === identity.peerId)
      .reduce((maximum, { route }) => Math.max(maximum, route.sequence), 0);
    const route = canonicalPeerMeshRouteRecord({
      version: 1,
      peerId: identity.peerId,
      sequence: maxSequence + 1,
      expiresAt: this.#now() + ROUTE_TTL_MS,
      routeHints: identity.listenAddresses,
      coordinationRelays: identity.coordinationRelays,
      ...(this.#endpointKind ? { endpointKind: this.#endpointKind } : {}),
      ...(stored.displayName ? { displayName: stored.displayName } : {}),
      ...(stored.transitMeshId ? { transitMeshId: stored.transitMeshId } : {}),
    });
    const proof = await this.#peer.signIdentity(peerMeshRouteRecordSigningBytes(route));
    const signed = decodeSignedPeerMeshRouteRecord({
      route,
      publicKey: proof.publicKey.toString('base64url'),
      signature: proof.signature.toString('base64url'),
    });
    this.#assertRouteSignature(signed);
    return signed;
  }

  #validateRoutes(
    values: readonly SignedPeerMeshRouteRecordV1[],
    roster: SignedPeerMeshRosterV1,
    now: number,
  ): readonly SignedPeerMeshRouteRecordV1[] {
    if (values.length > PEER_MESH_MAX_MEMBERS) throw new Error('Too many Peer Mesh routes');
    const routes = values.map(decodeSignedPeerMeshRouteRecord);
    if (new Set(routes.map(({ route }) => route.peerId)).size !== routes.length) {
      throw new Error('Duplicate Peer Mesh routes');
    }
    for (const signed of routes) {
      if (!roster.roster.members.includes(signed.route.peerId)) {
        throw new Error('Peer Mesh route is outside the active roster or lifetime');
      }
      this.#validateRemoteRoute(signed, signed.route.peerId, now);
    }
    return Object.freeze(routes);
  }

  #validateRemoteRoute(
    value: SignedPeerMeshRouteRecordV1,
    expectedPeerId: string,
    now = this.#now(),
  ): SignedPeerMeshRouteRecordV1 {
    const signed = decodeSignedPeerMeshRouteRecord(value);
    if (
      signed.route.peerId !== expectedPeerId ||
      signed.route.expiresAt <= now ||
      signed.route.expiresAt > now + ROUTE_MAX_FUTURE_MS
    ) {
      throw new Error('Peer Mesh route is outside the authenticated peer or lifetime');
    }
    this.#assertRouteSignature(signed);
    return signed;
  }

  #assertRouteSignature(signedValue: SignedPeerMeshRouteRecordV1): void {
    const signed = decodeSignedPeerMeshRouteRecord(signedValue);
    const valid = this.#peer.verifyIdentity(
      signed.route.peerId,
      peerMeshRouteRecordSigningBytes(signed.route),
      {
        publicKey: Buffer.from(signed.publicKey, 'base64url'),
        signature: Buffer.from(signed.signature, 'base64url'),
      },
    );
    if (!valid) throw new Error('Peer Mesh route signature is invalid');
  }

  async #applySync(
    meshId: string,
    rosterValue: SignedPeerMeshRosterV1,
    routeValues: readonly SignedPeerMeshRouteRecordV1[],
  ): Promise<void> {
    const roster = decodeSignedPeerMeshRoster(rosterValue);
    if (roster.roster.meshId !== meshId) throw new Error('Peer Mesh synchronization changed Mesh');
    const routes = this.#validateRoutes(routeValues, roster, this.#now());
    const localPeerId = this.#peer.identity().peerId;
    await this.#store.mutate((current) => {
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
          routes:
            nextRoster.roster.closed || !nextRoster.roster.members.includes(localPeerId)
              ? current.routes
              : mergeRoutes(current.routes, routes, this.#now()),
        },
        result: undefined,
      };
    });
    await this.#refreshLocalRoute();
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
    await this.#store.mutate((current) => {
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
        result: undefined,
      };
    });
    await this.#refreshLocalRoute();
    await this.#reconcileTransit();
    const stored = this.#store.read();
    return peerMeshStatus(
      findMesh(stored.meshes, meshId)!,
      this.#peer.identity(),
      this.#endpointKind,
      stored.routes,
    );
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
      let response: RedeemInvitationResponse | SyncPeerMeshResponse | LeavePeerMeshResponse;
      if (request.kind === 'redeem-invitation') {
        await this.#refreshLocalRoute();
        response = await this.#redeem(
          request,
          stream.peerId,
          this.#validateRemoteRoute(request.route, stream.peerId),
        );
      } else if (request.kind === 'sync') {
        response = await this.#sync(request, stream.peerId);
      } else {
        response = await this.#leave(request.meshId, stream.peerId);
      }
      await this.#refreshLocalRoute();
      await this.#reconcileTransit();
      await writeFrame(stream, response);
      await stream.close();
    } catch {
      stream.abort();
    } finally {
      clearTimeout(deadline);
    }
  }

  #redeem(
    request: RedeemInvitationRequest,
    remotePeerId: string,
    remoteRoute: SignedPeerMeshRouteRecordV1,
  ): Promise<RedeemInvitationResponse> {
    const now = this.#now();
    return this.#store.mutate<RedeemInvitationResponse>((current) => {
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
        const updated = {
          ...state,
        };
        const routes = mergeAuthenticatedRoute(current.routes, remoteRoute, now);
        return {
          state: { ...current, meshes: replaceMesh(current.meshes, updated), routes },
          result: {
            kind: 'invitation-redeemed',
            roster: updated.roster,
            routes: responseRoutes(
              updated,
              routes,
              [{ peerId: remotePeerId, sequence: Number.MAX_SAFE_INTEGER }],
              now,
            ).routes,
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
      if (state.roster.roster.members.includes(remotePeerId)) {
        const updated = {
          ...state,
          invitations: [
            ...remaining.filter(
              (record) => record.status === 'pending' || record.peerId !== remotePeerId,
            ),
            redeemedInvitation(invitation, remotePeerId),
          ],
        };
        const routes = mergeAuthenticatedRoute(current.routes, remoteRoute, now);
        return {
          state: { ...current, meshes: replaceMesh(current.meshes, updated), routes },
          result: {
            kind: 'invitation-redeemed',
            roster: state.roster,
            routes: responseRoutes(
              updated,
              routes,
              [{ peerId: remotePeerId, sequence: Number.MAX_SAFE_INTEGER }],
              now,
            ).routes,
          },
        };
      }
      const members = [...state.roster.roster.members, remotePeerId].sort();
      const roster = signPeerMeshRoster(
        {
          ...state.roster.roster,
          revision: state.roster.roster.revision + 1,
          members,
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
      const routes = mergeRoutes(current.routes, [remoteRoute], now);
      return {
        state: { ...current, meshes: replaceMesh(current.meshes, updated), routes },
        result: {
          kind: 'invitation-redeemed',
          roster,
          routes: responseRoutes(
            updated,
            routes,
            [{ peerId: remotePeerId, sequence: Number.MAX_SAFE_INTEGER }],
            now,
          ).routes,
        },
      };
    });
  }

  #leave(meshId: string, remotePeerId: string): Promise<LeavePeerMeshResponse> {
    return this.#store.mutate<LeavePeerMeshResponse>((current) => {
      const state = findMesh(current.meshes, meshId);
      if (
        !state ||
        state.role !== 'authority' ||
        state.roster.roster.closed ||
        (!state.roster.roster.members.includes(remotePeerId) &&
          !state.invitations.some(
            (invitation) => invitation.status === 'redeemed' && invitation.peerId === remotePeerId,
          ))
      ) {
        return {
          state: current,
          result: { kind: 'leave-rejected', reason: 'unknown' },
        };
      }
      if (!state.roster.roster.members.includes(remotePeerId)) {
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
  }

  async #sync(request: SyncPeerMeshRequest, remotePeerId: string): Promise<SyncPeerMeshResponse> {
    const remoteRoute = this.#validateRemoteRoute(request.route, remotePeerId);
    await this.#refreshLocalRoute();
    const incomingRoster = decodeSignedPeerMeshRoster(request.roster);
    return this.#store.mutate<SyncPeerMeshResponse>((current) => {
      const state = findMesh(current.meshes, request.meshId);
      if (!state || state.roster.authorityPublicKey !== incomingRoster.authorityPublicKey) {
        return {
          state: current,
          result: { kind: 'sync-rejected', reason: 'unknown' } as const,
        };
      }
      const roster = selectRoster(state.roster, incomingRoster);
      const localPeerId = this.#peer.identity().peerId;
      const localMember = !roster.roster.closed && roster.roster.members.includes(localPeerId);
      const remoteMember = !roster.roster.closed && roster.roster.members.includes(remotePeerId);
      const updated = {
        ...state,
        roster,
      };
      const routes =
        localMember && remoteMember
          ? mergeRoutes(current.routes, [remoteRoute], this.#now())
          : current.routes;
      if (!localMember || !remoteMember) {
        return {
          state: { ...current, meshes: replaceMesh(current.meshes, updated), routes },
          result: {
            kind: 'sync-result',
            roster,
            routes: [],
            more: false,
          } as const,
        };
      }
      const page = responseRoutes(updated, routes, request.knownRoutes, this.#now());
      return {
        state: { ...current, meshes: replaceMesh(current.meshes, updated), routes },
        result: {
          kind: 'sync-result',
          roster,
          routes: page.routes,
          more: page.more,
        } as const,
      };
    });
  }

  async #reconcileTransit(): Promise<void> {
    const stored = this.#store.read();
    const localPeerId = this.#peer.identity().peerId;
    const now = this.#now();
    const selected = stored.meshes.find(
      (mesh) =>
        mesh.roster.roster.meshId === stored.transitMeshId && isActiveMembership(mesh, localPeerId),
    );
    const eligibleRelays = stored.routes
      .filter(({ route }) => {
        if (
          route.peerId === localPeerId ||
          route.expiresAt <= now ||
          route.transitMeshId === undefined ||
          route.routeHints.length + route.coordinationRelays.length === 0
        ) {
          return false;
        }
        return isActiveMeshMember(stored.meshes, route.transitMeshId, localPeerId, route.peerId);
      })
      .sort((left, right) => left.route.peerId.localeCompare(right.route.peerId));
    const relayCandidates = transitRelayCandidates(eligibleRelays);
    await this.#peer.configureTransit({
      allowedPeerIds: selected
        ? selected.roster.roster.members.filter((peerId) => peerId !== localPeerId)
        : [],
      relayCandidates,
    });
  }
}

function transitRelayCandidates(
  routes: readonly SignedPeerMeshRouteRecordV1[],
): readonly RuntimeHostPeerTransitRelayCandidate[] {
  let remaining = PEER_MESH_MAX_TRANSIT_RELAY_ADDRESSES;
  const candidates: RuntimeHostPeerTransitRelayCandidate[] = [];
  for (const { route } of routes) {
    if (remaining === 0) break;
    const routeHints = [
      ...new Set(route.routeHints.filter((address) => isBaseRelayFor(address, route.peerId))),
    ].slice(0, Math.min(PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY, remaining));
    const coordinationRelays = [...new Set(route.coordinationRelays)].slice(
      0,
      Math.min(
        PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY - routeHints.length,
        remaining - routeHints.length,
      ),
    );
    if (routeHints.length + coordinationRelays.length === 0) continue;
    candidates.push(
      Object.freeze({
        peerId: route.peerId,
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
  routes: readonly SignedPeerMeshRouteRecordV1[] = [],
  now = Date.now(),
): PeerMeshStatus {
  const localDisplayName = routes.find(({ route }) => route.peerId === identity.peerId)?.route
    .displayName;
  return Object.freeze({
    role: state.role === 'authority' ? 'authority' : 'member',
    authority: state.role === 'authority' ? authorityTarget(identity) : state.authority,
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
            ...(localDisplayName ? { displayName: localDisplayName } : {}),
            state: 'local' as const,
          });
        }
        const route = routes.find((candidate) => candidate.route.peerId === peerId)?.route;
        if (!route) return Object.freeze({ peerId, state: 'unknown' as const });
        if (route.expiresAt <= now) {
          return Object.freeze({
            peerId,
            ...(route.endpointKind ? { endpointKind: route.endpointKind } : {}),
            ...(route.displayName ? { displayName: route.displayName } : {}),
            state: 'stale' as const,
            expiresAt: route.expiresAt,
          });
        }
        return Object.freeze({
          peerId,
          ...(route.endpointKind ? { endpointKind: route.endpointKind } : {}),
          ...(route.displayName ? { displayName: route.displayName } : {}),
          state:
            route.routeHints.length > 0
              ? ('route_available' as const)
              : ('coordination_only' as const),
          expiresAt: route.expiresAt,
        });
      }),
    ),
  });
}

function currentAuthorityTarget(
  state: PeerMeshReplicaStateV1,
  routes: readonly SignedPeerMeshRouteRecordV1[],
): PeerMeshAuthorityTarget {
  const learned = routes.find(({ route }) => route.peerId === state.authority.peerId)?.route;
  return learned ? mergeTargets(learned, state.authority) : state.authority;
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

function authorityTarget(
  identity: ReturnType<PeerMeshTransport['identity']>,
): PeerMeshAuthorityTarget {
  return Object.freeze({
    peerId: identity.peerId,
    routeHints: identity.listenAddresses,
    coordinationRelays: identity.coordinationRelays,
  });
}

function assertMeshCapacity(states: readonly PeerMeshStateV1[], localPeerId: string): void {
  if (
    states.filter((state) => isActiveMembership(state, localPeerId)).length >= PEER_MESH_MAX_MESHES
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
  const retired = states.findIndex((candidate) => !isActiveMembership(candidate, localPeerId));
  if (retired < 0) throw new Error('This peer belongs to too many Peer Meshes');
  return [...states.slice(0, retired), ...states.slice(retired + 1), state];
}

function isActiveMembership(state: PeerMeshStateV1, localPeerId: string): boolean {
  return !state.roster.roster.closed && state.roster.roster.members.includes(localPeerId);
}

function selectRoster(
  current: SignedPeerMeshRosterV1,
  candidate: SignedPeerMeshRosterV1,
): SignedPeerMeshRosterV1 {
  if (
    current.roster.meshId !== candidate.roster.meshId ||
    current.authorityPublicKey !== candidate.authorityPublicKey
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

function mergeRoutes(
  current: readonly SignedPeerMeshRouteRecordV1[],
  candidates: readonly SignedPeerMeshRouteRecordV1[],
  now: number,
): readonly SignedPeerMeshRouteRecordV1[] {
  const routes = new Map(current.map((route) => [route.route.peerId, route] as const));
  for (const candidate of candidates) {
    if (candidate.route.expiresAt <= now) continue;
    const existing = routes.get(candidate.route.peerId);
    if (
      !existing ||
      existing.route.expiresAt <= now ||
      candidate.route.sequence > existing.route.sequence
    ) {
      routes.set(candidate.route.peerId, candidate);
      continue;
    }
    if (
      candidate.route.sequence === existing.route.sequence &&
      JSON.stringify(candidate) !== JSON.stringify(existing)
    ) {
      throw new Error('Peer Mesh route sequence identifies conflicting facts');
    }
  }
  return Object.freeze(
    [...routes.values()].sort((left, right) => left.route.peerId.localeCompare(right.route.peerId)),
  );
}

function mergeAuthenticatedRoute(
  current: readonly SignedPeerMeshRouteRecordV1[],
  candidate: SignedPeerMeshRouteRecordV1,
  now: number,
): readonly SignedPeerMeshRouteRecordV1[] {
  const existing = current.find(({ route }) => route.peerId === candidate.route.peerId);
  if (
    existing &&
    existing.route.expiresAt > now &&
    existing.route.sequence > candidate.route.sequence
  ) {
    return current;
  }
  return mergeRoutes(
    current.filter(({ route }) => route.peerId !== candidate.route.peerId),
    [candidate],
    now,
  );
}

function routeSequences(
  routes: readonly SignedPeerMeshRouteRecordV1[],
  roster: SignedPeerMeshRosterV1,
  now: number,
): readonly PeerMeshRouteSequence[] {
  return Object.freeze(
    routes
      .filter(({ route }) => route.expiresAt > now && roster.roster.members.includes(route.peerId))
      .map(({ route }) => Object.freeze({ peerId: route.peerId, sequence: route.sequence }))
      .sort((left, right) => left.peerId.localeCompare(right.peerId)),
  );
}

function responseRoutes(
  state: PeerMeshStateV1,
  routes: readonly SignedPeerMeshRouteRecordV1[],
  knownRoutes: readonly PeerMeshRouteSequence[],
  now: number,
): {
  readonly routes: readonly SignedPeerMeshRouteRecordV1[];
  readonly more: boolean;
} {
  const known = new Map(knownRoutes.map(({ peerId, sequence }) => [peerId, sequence]));
  const missing = routes.filter(
    ({ route }) =>
      route.expiresAt > now &&
      state.roster.roster.members.includes(route.peerId) &&
      route.sequence > (known.get(route.peerId) ?? 0),
  );
  return Object.freeze({
    routes: Object.freeze(missing.slice(0, ROUTE_PAGE_SIZE)),
    more: missing.length > ROUTE_PAGE_SIZE,
  });
}

function sameAddresses(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index]);
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

function mergeTargets(
  primary: PeerMeshAuthorityTarget,
  fallback: PeerMeshAuthorityTarget,
): PeerMeshAuthorityTarget {
  return Object.freeze({
    peerId: primary.peerId,
    routeHints: Object.freeze([...new Set([...primary.routeHints, ...fallback.routeHints])]),
    coordinationRelays: Object.freeze([
      ...new Set([...primary.coordinationRelays, ...fallback.coordinationRelays]),
    ]),
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
    hasExactKeys(record, ['kind', 'meshId', 'secret', 'route'])
  ) {
    return {
      kind: 'redeem-invitation',
      meshId: requiredString(record.meshId, 128),
      secret: requiredString(record.secret, 64),
      route: decodeSignedPeerMeshRouteRecord(record.route),
    };
  }
  if (
    record.kind === 'sync' &&
    hasExactKeys(record, ['kind', 'meshId', 'roster', 'route', 'knownRoutes'])
  ) {
    return {
      kind: 'sync',
      meshId: requiredString(record.meshId, 128),
      roster: decodeSignedPeerMeshRoster(record.roster),
      route: decodeSignedPeerMeshRouteRecord(record.route),
      knownRoutes: decodeRouteSequences(record.knownRoutes),
    };
  }
  if (record.kind === 'leave' && hasExactKeys(record, ['kind', 'meshId'])) {
    return { kind: 'leave', meshId: requiredString(record.meshId, 128) };
  }
  throw new Error('Unsupported Peer Mesh control request');
}

function decodeRedeemResponse(value: unknown): RedeemInvitationResponse {
  const record = recordValue(value);
  if (record.kind === 'invitation-redeemed' && hasExactKeys(record, ['kind', 'roster', 'routes'])) {
    return {
      kind: 'invitation-redeemed',
      roster: decodeSignedPeerMeshRoster(record.roster),
      routes: decodeRoutePage(record.routes),
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
    hasExactKeys(record, ['kind', 'roster', 'routes', 'more']) &&
    typeof record.more === 'boolean'
  ) {
    return {
      kind: 'sync-result',
      roster: decodeSignedPeerMeshRoster(record.roster),
      routes: decodeRoutePage(record.routes),
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

function decodeRoutePage(value: unknown): readonly SignedPeerMeshRouteRecordV1[] {
  if (!Array.isArray(value) || value.length > ROUTE_PAGE_SIZE) {
    throw new Error('Invalid Peer Mesh route page');
  }
  return Object.freeze(value.map(decodeSignedPeerMeshRouteRecord));
}

function decodeRouteSequences(value: unknown): readonly PeerMeshRouteSequence[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_MEMBERS) {
    throw new Error('Invalid Peer Mesh route sequences');
  }
  const sequences = value.map((entry) => {
    const record = recordValue(entry);
    if (!hasExactKeys(record, ['peerId', 'sequence'])) {
      throw new Error('Invalid Peer Mesh route sequence');
    }
    const sequence = record.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
      throw new Error('Invalid Peer Mesh route sequence');
    }
    return Object.freeze({
      peerId: requiredString(record.peerId, 256),
      sequence: sequence as number,
    });
  });
  if (new Set(sequences.map(({ peerId }) => peerId)).size !== sequences.length) {
    throw new Error('Duplicate Peer Mesh route sequence');
  }
  return Object.freeze(sequences);
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
