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

import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  acquireFileLifetimeOwner,
  type FileLifetimeOwner,
} from '@maka/storage/file-lifetime-owner';
import {
  decodeAuthorityTarget,
  decodeSignedPeerMeshRoster,
  decodeSignedPeerMeshRouteRecord,
  PEER_MESH_MAX_INVITATION_RECORDS,
  PEER_MESH_MAX_MEMBERS,
  PEER_MESH_MAX_MESHES,
  PEER_MESH_MAX_PENDING_INVITATIONS,
  type PeerMeshAuthorityKeyPair,
  type PeerMeshAuthorityTarget,
  type SignedPeerMeshRosterV1,
  type SignedPeerMeshRouteRecordV1,
  validatePeerMeshInvitation,
  validatePeerMeshAuthorityKeyPair,
} from './model.js';
import { canonicalPeerMeshDisplayName } from './display-name.js';
import type { PeerMeshInvitationV1 } from '../protocol/peer-mesh.js';

const STATE_FILE = 'peer-mesh.json';
const LOCK_FILE = 'peer-mesh.owner';
const MAX_STATE_BYTES = 1024 * 1024;

export type PeerMeshInvitationRecord = PendingPeerMeshInvitation | RedeemedPeerMeshInvitation;

interface PendingPeerMeshInvitation {
  readonly status: 'pending';
  readonly secretDigest: string;
  readonly expiresAt: number;
}

interface RedeemedPeerMeshInvitation {
  readonly status: 'redeemed';
  readonly secretDigest: string;
  readonly peerId: string;
}

interface PeerMeshStateBase {
  readonly roster: SignedPeerMeshRosterV1;
}

export interface PeerMeshAuthorityStateV1 extends PeerMeshStateBase {
  readonly role: 'authority';
  readonly authorityPrivateKey: string;
  readonly invitations: readonly PeerMeshInvitationRecord[];
}

export interface PeerMeshReplicaStateV1 extends PeerMeshStateBase {
  readonly role: 'replica';
  readonly authority: PeerMeshAuthorityTarget;
  readonly desiredMembership: 'active' | 'left';
}

export type PeerMeshStateV1 = PeerMeshAuthorityStateV1 | PeerMeshReplicaStateV1;

export interface PendingPeerMeshJoin {
  readonly invitation: PeerMeshInvitationV1;
  readonly phase: 'prepared' | 'outcome_unknown' | 'leave_pending';
}

export interface PeerMeshStoredStateV1 {
  readonly displayName: string | null;
  readonly meshes: readonly PeerMeshStateV1[];
  readonly pendingJoins: readonly PendingPeerMeshJoin[];
  readonly routes: readonly SignedPeerMeshRouteRecordV1[];
  readonly transitMeshId: string | null;
}

export interface PeerMeshStateStore {
  readonly terminalFailure: Promise<never>;
  read(): PeerMeshStoredStateV1;
  mutate<T>(
    operation: (state: PeerMeshStoredStateV1) =>
      | {
          readonly state: PeerMeshStoredStateV1;
          readonly result: T;
        }
      | Promise<{
          readonly state: PeerMeshStoredStateV1;
          readonly result: T;
        }>,
  ): Promise<T>;
  close(): Promise<void>;
}

export async function openPeerMeshStateStore(
  dataRoot: string,
  localPeerId: string,
): Promise<PeerMeshStateStore> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dataRoot, 0o700);
  const owner = await acquireFileLifetimeOwner(join(dataRoot, LOCK_FILE));
  try {
    const state = await readState(join(dataRoot, STATE_FILE), localPeerId);
    return new PeerMeshStateStoreImpl(dataRoot, localPeerId, owner, state);
  } catch (error) {
    await owner.close();
    throw error;
  }
}

export async function hasPeerMeshIdentityObligations(
  dataRoot: string,
  localPeerId: string,
): Promise<boolean> {
  const state = await readState(join(dataRoot, STATE_FILE), localPeerId);
  return (
    state.pendingJoins.length > 0 ||
    state.meshes.some((mesh) => !isRetiredPeerMeshState(mesh, localPeerId))
  );
}

export async function migrateLegacyPeerMeshState(
  dataRoot: string,
  localPeerId: string,
): Promise<void> {
  const legacyPath = join(dataRoot, STATE_FILE);
  const targetRoot = join(dataRoot, localPeerId);
  const targetPath = join(targetRoot, STATE_FILE);
  if (await pathExists(targetPath)) {
    if (await pathExists(legacyPath)) {
      await unlink(legacyPath);
      await syncDirectory(dataRoot);
    }
    return;
  }
  if (!(await pathExists(legacyPath))) return;

  const state = await readState(legacyPath, localPeerId);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(targetRoot, 0o700);
  await writeState(targetPath, localPeerId, state);
  await unlink(legacyPath);
  await syncDirectory(dataRoot);
}

class PeerMeshStateStoreImpl implements PeerMeshStateStore {
  readonly #path: string;
  readonly terminalFailure: Promise<never>;
  readonly #rejectTerminalFailure: (error: unknown) => void;
  #state: PeerMeshStoredStateV1;
  #tail = Promise.resolve();
  #failure: Error | undefined;
  #closeTask: Promise<void> | undefined;
  #closed = false;

  constructor(
    dataRoot: string,
    private readonly localPeerId: string,
    private readonly owner: FileLifetimeOwner,
    state: PeerMeshStoredStateV1,
  ) {
    this.#path = join(dataRoot, STATE_FILE);
    this.#state = state;
    let rejectTerminalFailure!: (error: unknown) => void;
    this.terminalFailure = new Promise<never>((_resolve, reject) => {
      rejectTerminalFailure = reject;
    });
    this.#rejectTerminalFailure = rejectTerminalFailure;
    void this.terminalFailure.catch(() => undefined);
  }

  read(): PeerMeshStoredStateV1 {
    this.#assertOpen();
    return this.#state;
  }

  mutate<T>(
    operation: (state: PeerMeshStoredStateV1) =>
      | {
          readonly state: PeerMeshStoredStateV1;
          readonly result: T;
        }
      | Promise<{
          readonly state: PeerMeshStoredStateV1;
          readonly result: T;
        }>,
  ): Promise<T> {
    this.#assertOpen();
    const task = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure;
      const updated = await operation(this.#state);
      if (updated.state === this.#state) return updated.result;
      const candidate = pruneUnreferencedRoutes(updated.state, this.localPeerId);
      const canonical = decodePeerMeshStoredState(candidate, this.localPeerId);
      assertStateAdvance(this.#state.meshes, canonical.meshes, this.localPeerId);
      try {
        await writeState(this.#path, this.localPeerId, canonical);
        this.#state = canonical;
      } catch (error) {
        if (error instanceof PeerMeshPostCommitError) {
          this.#state = canonical;
          this.#failure = error;
          this.#rejectTerminalFailure(error);
          throw error;
        }
        throw new PeerMeshPersistenceError(error);
      }
      return updated.result;
    });
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    await this.owner.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Peer Mesh state store is closed');
    if (this.#failure) throw this.#failure;
  }
}

export function decodePeerMeshState(
  value: unknown,
  localPeerId: string,
  legacyReplica = false,
): PeerMeshStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Peer Mesh state');
  }
  const record = value as Record<string, unknown>;
  const expectedKeys =
    record.role === 'authority'
      ? ['role', 'roster', 'authorityPrivateKey', 'invitations']
      : legacyReplica
        ? ['role', 'roster', 'authority']
        : ['role', 'roster', 'authority', 'desiredMembership'];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error('Invalid Peer Mesh state');
  }
  if (record.role !== 'authority' && record.role !== 'replica') {
    throw new Error('Unsupported Peer Mesh state');
  }
  const roster = decodeSignedPeerMeshRoster(record.roster);
  if (record.role === 'authority') {
    if (!roster.roster.members.includes(localPeerId)) {
      throw new Error('Peer Mesh authority is not present in its roster');
    }
    const privateKey = boundedString(record.authorityPrivateKey, 'authorityPrivateKey', 256);
    validatePeerMeshAuthorityKeyPair({
      publicKey: roster.authorityPublicKey,
      privateKey,
    });
    return Object.freeze({
      role: 'authority',
      roster,
      authorityPrivateKey: privateKey,
      invitations: Object.freeze(decodeInvitations(record.invitations)),
    });
  }
  const authority = decodeAuthorityTarget(record.authority);
  if (!roster.roster.members.includes(authority.peerId)) {
    throw new Error('Peer Mesh authority is not present in its roster');
  }
  return Object.freeze({
    role: 'replica',
    authority,
    roster,
    desiredMembership: legacyReplica ? 'active' : decodeDesiredMembership(record.desiredMembership),
  });
}

function decodePeerMeshStates(
  value: unknown,
  localPeerId: string,
  legacyReplica = false,
): readonly PeerMeshStateV1[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_MESHES) {
    throw new Error('Invalid Peer Mesh state collection');
  }
  const states = value.map((state) => decodePeerMeshState(state, localPeerId, legacyReplica));
  const meshIds = states.map(({ roster }) => roster.roster.meshId);
  if (new Set(meshIds).size !== meshIds.length) {
    throw new Error('Duplicate Peer Mesh state');
  }
  return Object.freeze(states);
}

function assertStateAdvance(
  current: readonly PeerMeshStateV1[],
  next: readonly PeerMeshStateV1[],
  localPeerId: string,
): void {
  for (const previous of current) {
    const updated = next.find(
      ({ roster }) => roster.roster.meshId === previous.roster.roster.meshId,
    );
    if (!updated) {
      if (isRetiredPeerMeshState(previous, localPeerId)) continue;
      throw new Error('Active Peer Mesh state cannot be removed implicitly');
    }
    if (updated.role !== previous.role) {
      throw new Error('Peer Mesh state identity cannot change');
    }
    if (updated.roster.roster.revision < previous.roster.roster.revision) {
      throw new Error('Peer Mesh roster revision cannot roll back');
    }
    if (
      updated.roster.roster.revision === previous.roster.roster.revision &&
      JSON.stringify(updated.roster) !== JSON.stringify(previous.roster)
    ) {
      throw new Error('Peer Mesh roster revision cannot identify different facts');
    }
    if (previous.roster.roster.closed && !updated.roster.roster.closed) {
      throw new Error('Closed Peer Mesh state is terminal');
    }
  }
}

export function isRetiredPeerMeshState(state: PeerMeshStateV1, localPeerId: string): boolean {
  return (
    state.roster.roster.closed ||
    (state.role === 'replica' && !state.roster.roster.members.includes(localPeerId))
  );
}

export function isActivePeerMeshMembership(state: PeerMeshStateV1, localPeerId: string): boolean {
  return (
    !isRetiredPeerMeshState(state, localPeerId) &&
    state.roster.roster.members.includes(localPeerId) &&
    (state.role === 'authority' || state.desiredMembership === 'active')
  );
}

export function authorityKeys(state: PeerMeshStateV1): PeerMeshAuthorityKeyPair {
  if (state.role !== 'authority') {
    throw new Error('Peer Mesh operation requires the authority');
  }
  return Object.freeze({
    publicKey: state.roster.authorityPublicKey,
    privateKey: state.authorityPrivateKey,
  });
}

async function readState(
  path: string,
  expectedLocalPeerId: string,
): Promise<PeerMeshStoredStateV1> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_STATE_BYTES)
      throw new Error('Invalid Peer Mesh state file');
    const document = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('Invalid Peer Mesh state document');
    }
    const record = document as Record<string, unknown>;
    const versionOne =
      record.version === 1 &&
      Object.keys(record).length === 3 &&
      Object.hasOwn(record, 'localPeerId') &&
      Object.hasOwn(record, 'meshes');
    const versionTwo =
      record.version === 2 &&
      Object.keys(record).length === 4 &&
      Object.hasOwn(record, 'localPeerId') &&
      Object.hasOwn(record, 'meshes') &&
      Object.hasOwn(record, 'routes');
    const versionThree =
      record.version === 3 &&
      Object.keys(record).length === 5 &&
      Object.hasOwn(record, 'localPeerId') &&
      Object.hasOwn(record, 'meshes') &&
      Object.hasOwn(record, 'routes') &&
      Object.hasOwn(record, 'transitMeshId');
    const versionFour =
      record.version === 4 &&
      Object.keys(record).length === 6 &&
      Object.hasOwn(record, 'localPeerId') &&
      Object.hasOwn(record, 'displayName') &&
      Object.hasOwn(record, 'meshes') &&
      Object.hasOwn(record, 'routes') &&
      Object.hasOwn(record, 'transitMeshId');
    const versionSix =
      record.version === 6 &&
      Object.keys(record).length === 7 &&
      Object.hasOwn(record, 'localPeerId') &&
      Object.hasOwn(record, 'displayName') &&
      Object.hasOwn(record, 'meshes') &&
      Object.hasOwn(record, 'pendingJoins') &&
      Object.hasOwn(record, 'routes') &&
      Object.hasOwn(record, 'transitMeshId');
    if (!versionOne && !versionTwo && !versionThree && !versionFour && !versionSix) {
      throw new Error('Unsupported Peer Mesh state document');
    }
    if (boundedString(record.localPeerId, 'localPeerId', 256) !== expectedLocalPeerId) {
      throw new Error('Peer Mesh state belongs to a different peer identity');
    }
    return decodePeerMeshStoredState(
      {
        displayName: versionFour || versionSix ? record.displayName : null,
        meshes: record.meshes,
        pendingJoins: versionSix ? record.pendingJoins : [],
        routes: versionOne ? [] : record.routes,
        transitMeshId: versionThree || versionFour || versionSix ? record.transitMeshId : null,
      },
      expectedLocalPeerId,
      !versionSix,
    );
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return Object.freeze({
        displayName: null,
        meshes: Object.freeze([]),
        pendingJoins: Object.freeze([]),
        routes: Object.freeze([]),
        transitMeshId: null,
      });
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function writeState(
  path: string,
  localPeerId: string,
  state: PeerMeshStoredStateV1,
): Promise<void> {
  const document = `${JSON.stringify({ version: 6, localPeerId, ...state }, null, 2)}\n`;
  if (Buffer.byteLength(document) > MAX_STATE_BYTES)
    throw new Error('Peer Mesh state is too large');
  const temporary = `${path}.tmp`;
  let replaced = false;
  try {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(document, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path);
    replaced = true;
    try {
      await syncDirectory(dirname(path));
    } catch (error) {
      throw new PeerMeshPostCommitError(error);
    }
  } finally {
    if (!replaced) await unlink(temporary).catch(() => undefined);
  }
}

export class PeerMeshPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Peer Mesh state could not be persisted', { cause });
  }
}

export class PeerMeshPostCommitError extends Error {
  constructor(cause: unknown) {
    super('Peer Mesh state was replaced but its durability could not be confirmed; reopen it', {
      cause,
    });
  }
}

function decodeInvitations(value: unknown): PeerMeshInvitationRecord[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_INVITATION_RECORDS) {
    throw new Error('Invalid Peer Mesh invitations');
  }
  const invitations = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid Peer Mesh invitation');
    }
    const record = entry as Record<string, unknown>;
    const base = { secretDigest: decodeSecretDigest(record.secretDigest) };
    if (
      record.status === 'pending' &&
      Object.keys(record).length === 3 &&
      Object.hasOwn(record, 'expiresAt')
    ) {
      const expiresAt = record.expiresAt;
      if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) < 1) {
        throw new Error('Invalid Peer Mesh invitation expiry');
      }
      return Object.freeze({
        status: 'pending' as const,
        ...base,
        expiresAt: expiresAt as number,
      });
    }
    if (
      record.status === 'redeemed' &&
      Object.keys(record).length === 3 &&
      Object.hasOwn(record, 'peerId')
    ) {
      return Object.freeze({
        status: 'redeemed' as const,
        ...base,
        peerId: boundedString(record.peerId, 'peerId', 256),
      });
    }
    throw new Error('Invalid Peer Mesh invitation');
  });
  if (new Set(invitations.map(({ secretDigest }) => secretDigest)).size !== invitations.length) {
    throw new Error('Duplicate Peer Mesh invitation');
  }
  if (
    invitations.filter(({ status }) => status === 'pending').length >
    PEER_MESH_MAX_PENDING_INVITATIONS
  ) {
    throw new Error('Too many pending Peer Mesh invitations');
  }
  return invitations;
}

function decodeRoutes(
  value: unknown,
  meshes: readonly PeerMeshStateV1[],
): readonly SignedPeerMeshRouteRecordV1[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_MESHES * PEER_MESH_MAX_MEMBERS) {
    throw new Error('Invalid Peer Mesh routes');
  }
  const routes = value.map(decodeSignedPeerMeshRouteRecord);
  const peerIds = routes.map(({ route }) => route.peerId);
  const knownPeers = new Set(
    meshes
      .filter(({ roster }) => !roster.roster.closed)
      .flatMap(({ roster }) => roster.roster.members),
  );
  if (
    new Set(peerIds).size !== peerIds.length ||
    peerIds.some((peerId) => !knownPeers.has(peerId))
  ) {
    throw new Error('Invalid Peer Mesh routes');
  }
  return Object.freeze(routes);
}

function decodePeerMeshStoredState(
  value: unknown,
  localPeerId: string,
  legacyReplica = false,
): PeerMeshStoredStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Peer Mesh state document');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    !Object.hasOwn(record, 'displayName') ||
    !Object.hasOwn(record, 'meshes') ||
    !Object.hasOwn(record, 'pendingJoins') ||
    !Object.hasOwn(record, 'routes') ||
    !Object.hasOwn(record, 'transitMeshId')
  ) {
    throw new Error('Invalid Peer Mesh state document');
  }
  const meshes = decodePeerMeshStates(record.meshes, localPeerId, legacyReplica);
  const pendingJoins = decodePendingJoins(record.pendingJoins, meshes, localPeerId);
  const displayName =
    record.displayName === null ? null : canonicalPeerMeshDisplayName(record.displayName);
  const transitMeshId =
    record.transitMeshId === null
      ? null
      : boundedString(record.transitMeshId, 'transitMeshId', 128);
  if (
    transitMeshId !== null &&
    !meshes.some(
      (mesh) =>
        mesh.roster.roster.meshId === transitMeshId &&
        isActivePeerMeshMembership(mesh, localPeerId),
    )
  ) {
    throw new Error('Peer Mesh transit selection is not an active membership');
  }
  return Object.freeze({
    displayName,
    meshes,
    pendingJoins,
    routes: decodeRoutes(record.routes, meshes),
    transitMeshId,
  });
}

function decodePendingJoins(
  value: unknown,
  meshes: readonly PeerMeshStateV1[],
  localPeerId: string,
): readonly PendingPeerMeshJoin[] {
  if (!Array.isArray(value) || value.length > PEER_MESH_MAX_MESHES) {
    throw new Error('Invalid pending Peer Mesh joins');
  }
  const joins = value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, 'invitation') ||
      !Object.hasOwn(entry, 'phase')
    ) {
      throw new Error('Invalid pending Peer Mesh join');
    }
    const record = entry as Record<string, unknown>;
    return Object.freeze({
      invitation: validatePeerMeshInvitation(record.invitation),
      phase: decodePendingJoinPhase(record.phase),
    });
  });
  const meshIds = joins.map(({ invitation }) => invitation.meshId);
  const activeMeshIds = meshes
    .filter((mesh) => isActivePeerMeshMembership(mesh, localPeerId))
    .map(({ roster }) => roster.roster.meshId);
  if (
    new Set(meshIds).size !== meshIds.length ||
    joins.some(({ invitation }) => {
      const existing = meshes.find(({ roster }) => roster.roster.meshId === invitation.meshId);
      return (
        existing !== undefined &&
        (existing.role !== 'replica' ||
          existing.roster.roster.closed ||
          existing.roster.authorityPublicKey !== invitation.authorityPublicKey)
      );
    }) ||
    new Set([...activeMeshIds, ...meshIds]).size > PEER_MESH_MAX_MESHES
  ) {
    throw new Error('Invalid pending Peer Mesh joins');
  }
  return Object.freeze(joins);
}

function decodeDesiredMembership(value: unknown): PeerMeshReplicaStateV1['desiredMembership'] {
  if (value !== 'active' && value !== 'left') {
    throw new Error('Invalid Peer Mesh desired membership');
  }
  return value;
}

function decodePendingJoinPhase(value: unknown): PendingPeerMeshJoin['phase'] {
  if (value !== 'prepared' && value !== 'outcome_unknown' && value !== 'leave_pending') {
    throw new Error('Invalid Peer Mesh join phase');
  }
  return value;
}

function pruneUnreferencedRoutes(
  state: PeerMeshStoredStateV1,
  localPeerId: string,
): PeerMeshStoredStateV1 {
  const knownPeers = new Set(
    state.meshes
      .filter(({ roster }) => !roster.roster.closed)
      .flatMap(({ roster }) => roster.roster.members),
  );
  const routes = state.routes.filter(({ route }) => knownPeers.has(route.peerId));
  const transitMeshId = state.meshes.some(
    (mesh) =>
      mesh.roster.roster.meshId === state.transitMeshId &&
      isActivePeerMeshMembership(mesh, localPeerId),
  )
    ? state.transitMeshId
    : null;
  return routes.length === state.routes.length && transitMeshId === state.transitMeshId
    ? state
    : { ...state, routes, transitMeshId };
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`Invalid Peer Mesh ${label}`);
  }
  return value;
}

function decodeSecretDigest(value: unknown): string {
  const digest = boundedString(value, 'secretDigest', 64);
  const bytes = Buffer.from(digest, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== digest) {
    throw new Error('Invalid Peer Mesh secretDigest');
  }
  return digest;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
