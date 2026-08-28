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

import type { RuntimeHostPeerNativeStream } from '../transport/peer-native.js';
import {
  canonicalPeerMeshRoster,
  createPeerMeshInvitationSecret,
  decodePeerMeshInvitation,
  decodeSignedPeerMeshRoster,
  generatePeerMeshAuthorityKeyPair,
  matchesPeerMeshInvitationSecret,
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_MESHES,
  PEER_MESH_MAX_INVITATION_RECORDS,
  PEER_MESH_MAX_PENDING_INVITATIONS,
  peerMeshId,
  peerMeshInvitationSecretDigest,
  signPeerMeshRoster,
  type PeerMeshAuthorityTarget,
  type PeerMeshInvitationV1,
  type SignedPeerMeshRosterV1,
} from './model.js';
import {
  authorityKeys,
  openPeerMeshStateStore,
  type PeerMeshAuthorityStateV1,
  type PeerMeshStateStore,
  type PeerMeshStateV1,
} from './store.js';

const CONTROL_FRAME_MAX_BYTES = 64 * 1024;
const DEFAULT_INVITATION_TTL_MS = 15 * 60 * 1_000;
const CONNECT_DEADLINE_MS = 30_000;
const CONTROL_REQUEST_DEADLINE_MS = 10_000;
const MAX_ACTIVE_CONTROL_STREAMS = 32;
const MAX_ACTIVE_CONTROL_STREAMS_PER_PEER = 2;

interface RedeemInvitationRequest {
  readonly kind: 'redeem-invitation';
  readonly meshId: string;
  readonly secret: string;
}

type RedeemInvitationResponse =
  | {
      readonly kind: 'invitation-redeemed';
      readonly roster: SignedPeerMeshRosterV1;
    }
  | {
      readonly kind: 'invitation-rejected';
      readonly reason: RedeemInvitationRejectionReason;
    };

type RedeemInvitationRejectionReason = 'invalid' | 'expired' | 'closed' | 'full';

export interface PeerMeshNode {
  status(): readonly PeerMeshStatus[];
  create(): Promise<PeerMeshStatus>;
  invite(meshId: string, input?: { readonly ttlMs?: number }): Promise<PeerMeshInvitationV1>;
  join(invitation: PeerMeshInvitationV1, signal?: AbortSignal): Promise<PeerMeshStatus>;
  remove(meshId: string, peerId: string): Promise<PeerMeshStatus>;
  closeMesh(meshId: string): Promise<PeerMeshStatus>;
  serve(): Promise<void>;
  close(): Promise<void>;
}

export interface PeerMeshStatus {
  readonly role: 'authority' | 'member';
  readonly localPeerId: string;
  readonly authority: PeerMeshAuthorityTarget;
  readonly roster: SignedPeerMeshRosterV1;
  readonly pendingInvitationCount: number;
}

export interface PeerMeshTransport {
  identity(): Readonly<{
    peerId: string;
    listenAddresses: readonly string[];
    coordinationRelays: readonly string[];
  }>;
  connectMeshControl(
    input: {
      readonly peerId: string;
      readonly routeHints: readonly string[];
      readonly coordinationRelays?: readonly string[];
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
  readonly now?: () => number;
}): Promise<PeerMeshNode> {
  const store = await openPeerMeshStateStore(input.dataRoot, input.peer.identity().peerId);
  return new PeerMeshNodeImpl({ ...input, store });
}

class PeerMeshNodeImpl implements PeerMeshNode {
  readonly #store: PeerMeshStateStore;
  readonly #peer: PeerMeshTransport;
  readonly #now: () => number;
  readonly #activeControlStreams = new Set<RuntimeHostPeerNativeStream>();
  readonly #lifetime = new AbortController();
  #admissionTail = Promise.resolve();
  #serveTask: Promise<void> | undefined;
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    readonly store: PeerMeshStateStore;
    readonly peer: PeerMeshTransport;
    readonly now?: () => number;
  }) {
    this.#store = input.store;
    this.#peer = input.peer;
    this.#now = input.now ?? Date.now;
  }

  status(): readonly PeerMeshStatus[] {
    this.#assertOpen();
    const identity = this.#peer.identity();
    return Object.freeze(
      this.#store
        .read()
        .filter(
          (state) =>
            state.role === 'authority' || state.roster.roster.members.includes(identity.peerId),
        )
        .map((state) => peerMeshStatus(state, identity)),
    );
  }

  create(): Promise<PeerMeshStatus> {
    return this.#admitMesh(async () => {
      const identity = this.#peer.identity();
      const state = await this.#store.mutate((current) => {
        assertMeshCapacity(current, identity.peerId);
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
        return { state: appendMesh(current, state, identity.peerId), result: state };
      });
      return peerMeshStatus(state, identity);
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
      const state = requireAuthority(current, meshId);
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
        ...target,
      };
      return {
        state: replaceMesh(current, {
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
        result: Object.freeze(invitation),
      };
    });
  }

  join(invitationValue: PeerMeshInvitationV1, signal?: AbortSignal): Promise<PeerMeshStatus> {
    return this.#admitMesh(async () => {
      const invitation = decodePeerMeshInvitation(invitationValue);
      const current = this.#store.read();
      const existing = findMesh(current, invitation.meshId);
      const localPeerId = this.#peer.identity().peerId;
      if (existing?.role === 'authority') {
        throw new Error('This peer already belongs to that Peer Mesh');
      }
      if (!existing) assertMeshCapacity(current, localPeerId);
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
        const request: RedeemInvitationRequest = {
          kind: 'redeem-invitation',
          meshId: invitation.meshId,
          secret: invitation.secret,
        };
        const response = await exchangeControl(stream, request, operationSignal);
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
        const state: PeerMeshStateV1 = {
          role: 'replica',
          authority: {
            peerId: invitation.peerId,
            routeHints: invitation.routeHints,
            coordinationRelays: invitation.coordinationRelays,
          },
          roster,
        };
        const joined = await this.#store.mutate((current) => {
          const existing = findMesh(current, invitation.meshId);
          if (existing?.role === 'authority') {
            throw new Error('This peer already belongs to that Peer Mesh');
          }
          if (
            existing &&
            (existing.roster.authorityPublicKey !== roster.authorityPublicKey ||
              roster.roster.revision <= existing.roster.roster.revision)
          ) {
            throw new Error('Peer Mesh invitation did not advance the existing membership');
          }
          if (!existing) assertMeshCapacity(current, identity.peerId);
          return {
            state: existing
              ? replaceMesh(current, state)
              : appendMesh(current, state, identity.peerId),
            result: state,
          };
        });
        return peerMeshStatus(joined, identity);
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

  closeMesh(meshId: string): Promise<PeerMeshStatus> {
    if (this.#lifetime.signal.aborted) return Promise.reject(new Error('Peer Mesh node is closed'));
    return this.#updateAuthorityRoster(meshId, true, (state) => ({
      members: state.roster.roster.members,
      closed: true,
    }));
  }

  async serve(): Promise<void> {
    if (this.#lifetime.signal.aborted) throw new Error('Peer Mesh node is closed');
    if (this.#serveTask) throw new Error('Peer Mesh node is already serving');
    const serving = this.#peer.serveMeshControl(
      (stream) => this.#acceptIncoming(stream),
      this.#lifetime.signal,
    );
    this.#serveTask = serving;
    try {
      await serving;
      if (!this.#lifetime.signal.aborted)
        throw new Error('Peer Mesh control transport stopped unexpectedly');
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
    await this.#admissionTail;
    return this.#store.close();
  }

  #assertOpen(): void {
    if (this.#lifetime.signal.aborted) throw new Error('Peer Mesh node is closed');
  }

  #updateAuthorityRoster(
    meshId: string,
    closedIsSuccess: boolean,
    update: (state: PeerMeshAuthorityStateV1) => {
      readonly members: readonly string[];
      readonly closed: boolean;
    },
  ): Promise<PeerMeshStatus> {
    return this.#store.mutate((current) => {
      const state = requireAuthority(current, meshId);
      if (state.roster.roster.closed) {
        if (closedIsSuccess) {
          return { state: current, result: peerMeshStatus(state, this.#peer.identity()) };
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
        state: replaceMesh(current, updated),
        result: peerMeshStatus(updated, this.#peer.identity()),
      };
    });
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
      const request = decodeRedeemRequest(await readFrame(stream));
      const response = await this.#redeem(request, stream.peerId);
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
  ): Promise<RedeemInvitationResponse> {
    const now = this.#now();
    return this.#store.mutate<RedeemInvitationResponse>((current) => {
      const state = findMesh(current, request.meshId);
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
        return {
          state: current,
          result: { kind: 'invitation-redeemed', roster: state.roster },
        };
      }
      const remaining = state.invitations.filter(
        (record) =>
          record !== invitation && (record.status === 'redeemed' || record.expiresAt > now),
      );
      if (invitation.expiresAt <= now) {
        return {
          state: replaceMesh(current, { ...state, invitations: remaining }),
          result: rejected('expired'),
        };
      }
      if (state.roster.roster.closed) {
        return {
          state: replaceMesh(current, { ...state, invitations: remaining }),
          result: rejected('closed'),
        };
      }
      if (
        !state.roster.roster.members.includes(remotePeerId) &&
        state.roster.roster.members.length >= PEER_MESH_MAX_MEMBERS
      ) {
        return {
          state: replaceMesh(current, { ...state, invitations: remaining }),
          result: rejected('full'),
        };
      }
      if (state.roster.roster.members.includes(remotePeerId)) {
        return {
          state: replaceMesh(current, {
            ...state,
            invitations: [
              ...remaining.filter(
                (record) => record.status === 'pending' || record.peerId !== remotePeerId,
              ),
              redeemedInvitation(invitation, remotePeerId),
            ],
          }),
          result: { kind: 'invitation-redeemed', roster: state.roster },
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
      return {
        state: replaceMesh(current, {
          ...state,
          roster,
          invitations: [
            ...remaining.filter(
              (record) => record.status === 'pending' || record.peerId !== remotePeerId,
            ),
            redeemedInvitation(invitation, remotePeerId),
          ],
        }),
        result: { kind: 'invitation-redeemed', roster },
      };
    });
  }
}

function peerMeshStatus(
  state: PeerMeshStateV1,
  identity: ReturnType<PeerMeshTransport['identity']>,
): PeerMeshStatus {
  return Object.freeze({
    role: state.role === 'authority' ? 'authority' : 'member',
    localPeerId: identity.peerId,
    authority: state.role === 'authority' ? authorityTarget(identity) : state.authority,
    roster: state.roster,
    pendingInvitationCount:
      state.role === 'authority'
        ? state.invitations.filter(({ status }) => status === 'pending').length
        : 0,
  });
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

async function exchangeControl(
  stream: RuntimeHostPeerNativeStream,
  request: RedeemInvitationRequest,
  signal?: AbortSignal,
): Promise<RedeemInvitationResponse> {
  const timeout = AbortSignal.timeout(CONTROL_REQUEST_DEADLINE_MS);
  const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const abort = () => stream.abort();
  operationSignal.addEventListener('abort', abort, { once: true });
  if (operationSignal.aborted) abort();
  try {
    operationSignal.throwIfAborted();
    await writeFrame(stream, request);
    const response = decodeRedeemResponse(await readFrame(stream));
    operationSignal.throwIfAborted();
    return response;
  } catch (error) {
    operationSignal.throwIfAborted();
    throw error;
  } finally {
    operationSignal.removeEventListener('abort', abort);
  }
}

function decodeRedeemRequest(value: unknown): RedeemInvitationRequest {
  const record = recordValue(value);
  if (record.kind !== 'redeem-invitation' || !hasExactKeys(record, ['kind', 'meshId', 'secret'])) {
    throw new Error('Unsupported Peer Mesh control request');
  }
  return {
    kind: 'redeem-invitation',
    meshId: requiredString(record.meshId, 128),
    secret: requiredString(record.secret, 64),
  };
}

function decodeRedeemResponse(value: unknown): RedeemInvitationResponse {
  const record = recordValue(value);
  if (record.kind === 'invitation-redeemed' && hasExactKeys(record, ['kind', 'roster'])) {
    return {
      kind: 'invitation-redeemed',
      roster: decodeSignedPeerMeshRoster(record.roster),
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
