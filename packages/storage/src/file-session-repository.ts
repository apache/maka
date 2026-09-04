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

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isNonEmptyUnicodeString,
  isSha256Digest,
  type Sha256Digest,
} from './session-bundle-contract.js';
import { syncDirectory, syncDirectoryChain } from './stable-storage.js';
import {
  createSessionCheckpointManifestV1,
  encodeSessionCheckpointManifestV1,
  SESSION_BUNDLE_OBJECT_MEDIA_TYPE,
  SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE,
  SessionRepositoryError,
  type ClaimForkInput,
  type CommitSessionRevisionInput,
  type CommittedSessionRevision,
  type CompleteForkInput,
  type CompletedForkOperation,
  type CreateSessionInput,
  type ForkOperation,
  type ImmutableObjectInput,
  type ImmutableObjectMaterializationInput,
  type ImmutableObjectRef,
  type ImmutableObjectStore,
  type PendingForkOperation,
  type SessionCheckpointManifestV1,
  type SessionRepository,
  type SessionRepositoryErrorCode,
  type SessionRepositoryRevision,
  type SessionRevisionRef,
  type StoredSessionCheckpoint,
} from './session-repository.js';
import { withFileUpdateLock } from './file-update-lock.js';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_OBJECT_REF_LENGTH = 2_048;
const STATE_FILE_NAME = 'session-repository-v1.json';

export interface OpenFileSessionRepositoryInput {
  /** Directory owned by this local adapter. It must not be a live Session root. */
  readonly storageRoot: string;
}

export interface FileSessionRepository extends SessionRepository {
  readonly objectStore: ImmutableObjectStore;
}

/**
 * Opens the durable local adapter. Object bytes are immutable files while the
 * small Session control plane is one atomically replaced state document.
 */
export async function openFileSessionRepository(
  input: OpenFileSessionRepositoryInput,
): Promise<FileSessionRepository> {
  if (!isRecord(input)) throw new TypeError('File Session Repository options must be an object');
  const storageRoot = requireIdentifier(input.storageRoot, 'Storage root', MAX_OBJECT_REF_LENGTH);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const objectStore = new FileImmutableObjectStore(join(storageRoot, 'objects'), storageRoot);
  return new FileSessionRepositoryAdapter(join(storageRoot, STATE_FILE_NAME), objectStore);
}

class FileSessionRepositoryAdapter implements FileSessionRepository {
  readonly forkIdempotencyRetention = 'indefinite' as const;

  constructor(
    private readonly statePath: string,
    readonly objectStore: ImmutableObjectStore,
  ) {}

  async checkoutCurrent(sessionId: string): Promise<CommittedSessionRevision> {
    const admittedSessionId = requireIdentifier(sessionId, 'Session identity');
    const state = await this.readState();
    const session = findSession(state, admittedSessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
    const result = copyCommittedSessionRevision(session.head);
    await assertCheckpointReadable(this.objectStore, result.checkpoint);
    return result;
  }

  async checkoutExact(ref: SessionRevisionRef): Promise<CommittedSessionRevision> {
    const requested = admitRevisionRef(ref, 'Session revision reference');
    const state = await this.readState();
    const session = findSession(state, requested.sessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (session.head.ref.revision !== requested.revision) {
      throw repositoryError(
        'revision_not_available',
        'Requested Session revision is not available',
      );
    }
    const result = copyCommittedSessionRevision(session.head);
    await assertCheckpointReadable(this.objectStore, result.checkpoint);
    return result;
  }

  async createSession(input: CreateSessionInput): Promise<CommittedSessionRevision> {
    const admitted = admitCreateSessionInput(input);
    // Match the contract's linearization/error precedence: an existing Session
    // is authoritative before an unrelated candidate object is consulted.
    const beforeVerification = await this.readState();
    const existing = findSession(beforeVerification, admitted.sessionId);
    if (existing) {
      const reconciled = reconcileExistingSessionCreate(existing, admitted);
      await assertCheckpointReadable(this.objectStore, reconciled.checkpoint);
      return copyCommittedSessionRevision(reconciled);
    }
    await assertCheckpointReadable(this.objectStore, admitted.checkpoint);
    const result = await this.mutate((state) => {
      const concurrent = findSession(state, admitted.sessionId);
      if (concurrent) return reconcileExistingSessionCreate(concurrent, admitted);
      if (admitted.createdByForkId !== undefined) assertPendingForkCreate(state, admitted);
      const initial = committedRevision({
        sessionId: admitted.sessionId,
        revision: 'r1',
        agentId: admitted.agentId,
        checkpoint: admitted.checkpoint,
        lastCommittedActivationId: admitted.lastCommittedActivationId,
        forkedFrom: admitted.forkedFrom,
      });
      state.sessions.push({
        sessionId: admitted.sessionId,
        agentId: admitted.agentId,
        head: initial,
        nextRevisionNumber: 2,
        ...(admitted.forkedFrom === undefined ? {} : { forkedFrom: admitted.forkedFrom }),
        ...(admitted.createdByForkId === undefined
          ? {}
          : { createdByForkId: admitted.createdByForkId }),
        createdRevision: initial,
      });
      return initial;
    });
    await assertCheckpointReadable(this.objectStore, result.checkpoint);
    return copyCommittedSessionRevision(result);
  }

  async commit(input: CommitSessionRevisionInput): Promise<CommittedSessionRevision> {
    const admitted = admitCommitSessionRevisionInput(input);
    const existing = await this.readState();
    const prior = findCommit(existing, admitted.sessionId, admitted.commitId);
    if (prior) {
      assertSameCommitInput(prior.input, admitted);
      await assertCheckpointReadable(this.objectStore, prior.result.checkpoint);
      return copyCommittedSessionRevision(prior.result);
    }
    const session = findSession(existing, admitted.sessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (session.head.ref.revision !== admitted.expectedRevision) {
      throw repositoryError('revision_conflict', 'Cloud Session head changed before commit');
    }
    await assertCheckpointReadable(this.objectStore, admitted.checkpoint);
    const result = await this.mutate((state) => {
      const repeated = findCommit(state, admitted.sessionId, admitted.commitId);
      if (repeated) {
        assertSameCommitInput(repeated.input, admitted);
        return repeated.result;
      }
      const session = findSession(state, admitted.sessionId);
      if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
      if (session.head.ref.revision !== admitted.expectedRevision) {
        throw repositoryError('revision_conflict', 'Cloud Session head changed before commit');
      }
      const result = committedRevision({
        sessionId: session.sessionId,
        revision: `r${session.nextRevisionNumber}`,
        agentId: session.agentId,
        checkpoint: admitted.checkpoint,
        lastCommittedActivationId: admitted.lastCommittedActivationId,
        forkedFrom: session.forkedFrom,
      });
      session.nextRevisionNumber += 1;
      session.head = result;
      if (admitted.commitId !== undefined) {
        state.commits.push({
          sessionId: admitted.sessionId,
          commitId: admitted.commitId,
          input: admitted,
          result,
        });
      }
      return result;
    });
    await assertCheckpointReadable(this.objectStore, result.checkpoint);
    return copyCommittedSessionRevision(result);
  }

  async claimFork(input: ClaimForkInput): Promise<ForkOperation> {
    const admitted = admitClaimForkInput(input);
    const state = await this.readState();
    const existing = findFork(state, admitted.forkId);
    if (existing) return reconcileForkClaim(existing, admitted);
    if (admitted.targetSessionId === admitted.source.sessionId) {
      throw repositoryError(
        'invalid_fork_target',
        'Fork target Session must differ from its source Session',
      );
    }
    const source = requireCurrentForkSource(state, admitted.source);
    const sourceCheckpoint = admitStoredCheckpoint(source.head.checkpoint);
    await assertCheckpointReadable(this.objectStore, sourceCheckpoint);
    return this.mutate((latest) => {
      const raced = findFork(latest, admitted.forkId);
      if (raced) return reconcileForkClaim(raced, admitted);
      const stillCurrent = requireCurrentForkSource(latest, admitted.source);
      const pending: PersistentPendingFork = {
        state: 'pending',
        forkId: admitted.forkId,
        source: admitted.source,
        sourceAgentId: stillCurrent.agentId,
        sourceCheckpoint,
        targetSessionId: admitted.targetSessionId,
      };
      latest.forks.push(pending);
      return copyForkOperation(pending);
    });
  }

  async completeFork(input: CompleteForkInput): Promise<CompletedForkOperation> {
    const forkId = requireIdentifier(input?.forkId, 'Fork identity');
    const state = await this.readState();
    const operation = findFork(state, forkId);
    if (!operation) throw repositoryError('idempotency_conflict', 'Fork identity was not claimed');
    if (operation.state === 'completed') return copyCompletedForkOperation(operation);
    const target = requireValidForkTarget(state, operation);
    await assertCheckpointReadable(this.objectStore, target.createdRevision.checkpoint);
    return this.mutate((latest) => {
      const current = findFork(latest, forkId);
      if (!current) throw repositoryError('idempotency_conflict', 'Fork identity was not claimed');
      if (current.state === 'completed') return copyCompletedForkOperation(current);
      const target = requireValidForkTarget(latest, current);
      const completed: PersistentCompletedFork = {
        ...current,
        state: 'completed',
        target: copyRevisionRef(target.createdRevision.ref),
      };
      replaceFork(latest, completed);
      return copyCompletedForkOperation(completed);
    });
  }

  private async readState(): Promise<PersistentState> {
    try {
      const bytes = await readFile(this.statePath);
      return decodeState(bytes);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return emptyState();
      if (error instanceof SessionRepositoryError) throw error;
      throw repositoryError('io_failure', 'Local Session Repository could not read state', error);
    }
  }

  private async mutate<T>(operation: (state: PersistentState) => T): Promise<T> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    try {
      return await withFileUpdateLock(this.statePath, async () => {
        const state = await this.readState();
        const result = operation(state);
        await writeStateAtomically(this.statePath, state);
        return result;
      });
    } catch (error) {
      if (error instanceof SessionRepositoryError) throw error;
      throw repositoryError('io_failure', 'Local Session Repository could not update state', error);
    }
  }
}

class FileImmutableObjectStore implements ImmutableObjectStore {
  constructor(
    private readonly objectsRoot: string,
    private readonly storageRoot: string,
  ) {}

  async publish(input: ImmutableObjectInput): Promise<ImmutableObjectRef> {
    const admitted = admitImmutableObjectInput(input);
    const ref = immutableObjectRef({
      objectRef: localObjectRef(admitted.digest, admitted.mediaType),
      digest: admitted.digest,
      bytes: admitted.bytes,
      mediaType: admitted.mediaType,
    });
    const destination = objectPath(this.objectsRoot, ref);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writePublishedObject(admitted, temporary);
      try {
        await linkNoReplace(temporary, destination);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      // An EEXIST result means another writer published the same immutable
      // name. It is not readable until that writer's directory chain has a
      // durability barrier too, so both paths wait for one before returning.
      await syncDirectoryChain(dirname(destination), this.storageRoot);
    } catch (error) {
      throw normalizeFileError(error, 'Immutable object publication failed');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    await this.assertReadable(ref);
    return ref;
  }

  async assertReadable(input: ImmutableObjectRef): Promise<void> {
    const ref = admitImmutableObjectRef(input);
    if (ref.objectRef !== localObjectRef(ref.digest, ref.mediaType)) {
      throw repositoryError('integrity_mismatch', 'Immutable object reference is not canonical');
    }
    try {
      await assertFileMatchesImmutableRef(objectPath(this.objectsRoot, ref), ref);
    } catch (error) {
      if (error instanceof SessionRepositoryError) throw error;
      if (isNodeError(error, 'ENOENT')) {
        throw repositoryError('object_not_found', 'Immutable object was not found');
      }
      throw repositoryError('io_failure', 'Immutable object could not be read', error);
    }
  }

  async materialize(input: ImmutableObjectMaterializationInput): Promise<void> {
    const request = admitImmutableObjectMaterializationInput(input);
    if (request.ref.objectRef !== localObjectRef(request.ref.digest, request.ref.mediaType)) {
      throw repositoryError('integrity_mismatch', 'Immutable object reference is not canonical');
    }
    if (request.ref.bytes > request.maxBytes) {
      throw repositoryError(
        'quota_exceeded',
        'Immutable object exceeds materialization byte limit',
      );
    }
    try {
      // Verify the retained object before creating the caller-owned file. The
      // copy below verifies it again while streaming, so a corrupt object can
      // never be returned merely because it changed between the two reads.
      await this.assertReadable(request.ref);
      await copyImmutableFile(
        objectPath(this.objectsRoot, request.ref),
        request.destination,
        request.ref,
      );
    } catch (error) {
      if (error instanceof SessionRepositoryError) throw error;
      throw repositoryError('io_failure', 'Immutable object could not be materialized', error);
    }
  }
}

interface PersistentState {
  readonly schemaVersion: 1;
  readonly sessions: PersistentSession[];
  readonly commits: PersistentCommit[];
  readonly forks: PersistentFork[];
}

interface PersistentSession {
  readonly sessionId: string;
  readonly agentId: string;
  head: CommittedSessionRevision;
  nextRevisionNumber: number;
  readonly forkedFrom?: SessionRevisionRef;
  readonly createdByForkId?: string;
  readonly createdRevision: CommittedSessionRevision;
}

interface PersistentCommit {
  readonly sessionId: string;
  readonly commitId: string;
  readonly input: InternalCommitInput;
  readonly result: CommittedSessionRevision;
}

interface PersistentPendingFork extends PendingForkOperation {}
interface PersistentCompletedFork extends CompletedForkOperation {}
type PersistentFork = PersistentPendingFork | PersistentCompletedFork;

interface InternalCommitInput {
  readonly sessionId: string;
  readonly expectedRevision: SessionRepositoryRevision;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly commitId?: string;
}

interface InternalCreateInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
  readonly createdByForkId?: string;
}

interface InternalClaimForkInput {
  readonly forkId: string;
  readonly source: SessionRevisionRef;
  readonly targetSessionId: string;
}

function emptyState(): PersistentState {
  return { schemaVersion: 1, sessions: [], commits: [], forks: [] };
}

function findSession(state: PersistentState, sessionId: string): PersistentSession | undefined {
  return state.sessions.find((entry) => entry.sessionId === sessionId);
}

function findCommit(
  state: PersistentState,
  sessionId: string,
  commitId: string | undefined,
): PersistentCommit | undefined {
  return commitId === undefined
    ? undefined
    : state.commits.find((entry) => entry.sessionId === sessionId && entry.commitId === commitId);
}

function findFork(state: PersistentState, forkId: string): PersistentFork | undefined {
  return state.forks.find((entry) => entry.forkId === forkId);
}

function replaceFork(state: PersistentState, replacement: PersistentFork): void {
  const index = state.forks.findIndex((entry) => entry.forkId === replacement.forkId);
  if (index < 0) throw repositoryError('idempotency_conflict', 'Fork identity was not claimed');
  state.forks[index] = replacement;
}

function requireCurrentForkSource(
  state: PersistentState,
  source: SessionRevisionRef,
): PersistentSession {
  const session = findSession(state, source.sessionId);
  if (!session || session.head.ref.revision !== source.revision) {
    throw repositoryError(
      'source_revision_not_available',
      'Fork source Session revision is not available',
    );
  }
  return session;
}

function requireValidForkTarget(
  state: PersistentState,
  operation: PersistentPendingFork,
): PersistentSession {
  const target = findSession(state, operation.targetSessionId);
  if (!target) throw repositoryError('session_not_found', 'Fork target Session was not found');
  if (target.agentId !== operation.sourceAgentId) {
    throw repositoryError(
      'fork_agent_mismatch',
      'Fork target Agent does not match its source Agent',
    );
  }
  if (
    target.createdByForkId !== operation.forkId ||
    !target.forkedFrom ||
    !sameRevisionRef(target.forkedFrom, operation.source)
  ) {
    throw repositoryError('idempotency_conflict', 'Fork target was created by another operation');
  }
  return target;
}

function assertPendingForkCreate(state: PersistentState, input: InternalCreateInput): void {
  const operation =
    input.createdByForkId === undefined ? undefined : findFork(state, input.createdByForkId);
  if (
    !operation ||
    operation.state !== 'pending' ||
    operation.targetSessionId !== input.sessionId ||
    !input.forkedFrom ||
    !sameRevisionRef(operation.source, input.forkedFrom)
  ) {
    throw repositoryError(
      'idempotency_conflict',
      'Fork target does not match its claimed operation',
    );
  }
  if (operation.sourceAgentId !== input.agentId) {
    throw repositoryError('fork_agent_mismatch', 'Fork target Agent must match its source Agent');
  }
}

function reconcileExistingSessionCreate(
  existing: PersistentSession,
  input: InternalCreateInput,
): CommittedSessionRevision {
  if (
    input.createdByForkId !== undefined &&
    existing.createdByForkId === input.createdByForkId &&
    existing.agentId === input.agentId &&
    sameStoredCheckpoint(existing.createdRevision.checkpoint, input.checkpoint) &&
    existing.createdRevision.lastCommittedActivationId === input.lastCommittedActivationId &&
    sameOptionalRevisionRef(existing.forkedFrom, input.forkedFrom)
  ) {
    return existing.createdRevision;
  }
  throw repositoryError('session_already_exists', 'Cloud Session already exists');
}

function reconcileForkClaim(
  operation: PersistentFork,
  input: InternalClaimForkInput,
): ForkOperation {
  if (
    operation.targetSessionId !== input.targetSessionId ||
    !sameRevisionRef(operation.source, input.source)
  ) {
    throw repositoryError('idempotency_conflict', 'Fork identity was reused with different input');
  }
  return copyForkOperation(operation);
}

function assertSameCommitInput(left: InternalCommitInput, right: InternalCommitInput): void {
  if (
    left.sessionId !== right.sessionId ||
    left.expectedRevision !== right.expectedRevision ||
    !sameStoredCheckpoint(left.checkpoint, right.checkpoint) ||
    left.lastCommittedActivationId !== right.lastCommittedActivationId ||
    left.commitId !== right.commitId
  ) {
    throw repositoryError(
      'idempotency_conflict',
      'Commit identity was reused with different input',
    );
  }
}

async function assertCheckpointReadable(
  objectStore: ImmutableObjectStore,
  checkpoint: StoredSessionCheckpoint,
): Promise<void> {
  const admitted = admitStoredCheckpoint(checkpoint);
  try {
    await objectStore.assertReadable(admitted.manifest);
    await objectStore.assertReadable(admitted.value.compatibilityBundle);
  } catch (error) {
    if (error instanceof SessionRepositoryError) throw error;
    throw repositoryError('io_failure', 'Immutable Object Store operation failed', error);
  }
}

function admitCommitSessionRevisionInput(input: CommitSessionRevisionInput): InternalCommitInput {
  if (!isRecord(input)) throw new TypeError('Session commit input must be an object');
  return {
    sessionId: requireIdentifier(input.sessionId, 'Session identity'),
    expectedRevision: requireIdentifier(input.expectedRevision, 'Expected revision'),
    checkpoint: admitStoredCheckpoint(input.checkpoint),
    ...(input.lastCommittedActivationId === undefined
      ? {}
      : {
          lastCommittedActivationId: requireIdentifier(
            input.lastCommittedActivationId,
            'Activation identity',
          ),
        }),
    ...(input.commitId === undefined
      ? {}
      : { commitId: requireIdentifier(input.commitId, 'Commit identity') }),
  };
}

function admitCreateSessionInput(input: CreateSessionInput): InternalCreateInput {
  if (!isRecord(input)) throw new TypeError('Session creation input must be an object');
  const forkedFrom =
    input.forkedFrom === undefined ? undefined : admitRevisionRef(input.forkedFrom, 'Fork source');
  const createdByForkId =
    input.createdByForkId === undefined
      ? undefined
      : requireIdentifier(input.createdByForkId, 'Fork identity');
  if ((forkedFrom === undefined) !== (createdByForkId === undefined)) {
    throw new TypeError('Fork lineage and Fork identity must be supplied together');
  }
  if (createdByForkId !== undefined && input.lastCommittedActivationId !== undefined) {
    throw new TypeError('Fork-created Session must not carry an Activation identity');
  }
  return {
    sessionId: requireIdentifier(input.sessionId, 'Session identity'),
    agentId: requireIdentifier(input.agentId, 'Agent identity'),
    checkpoint: admitStoredCheckpoint(input.checkpoint),
    ...(input.lastCommittedActivationId === undefined
      ? {}
      : {
          lastCommittedActivationId: requireIdentifier(
            input.lastCommittedActivationId,
            'Activation identity',
          ),
        }),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    ...(createdByForkId === undefined ? {} : { createdByForkId }),
  };
}

function admitClaimForkInput(input: ClaimForkInput): InternalClaimForkInput {
  if (!isRecord(input)) throw new TypeError('Fork claim input must be an object');
  return {
    forkId: requireIdentifier(input.forkId, 'Fork identity'),
    source: admitRevisionRef(input.source, 'Fork source'),
    targetSessionId: requireIdentifier(input.targetSessionId, 'Fork target Session identity'),
  };
}

function admitStoredCheckpoint(input: StoredSessionCheckpoint): StoredSessionCheckpoint {
  if (!isRecord(input)) throw new TypeError('Stored Session checkpoint must be an object');
  const manifest = admitImmutableObjectRef(input.manifest);
  if (!isRecord(input.value) || input.value.schemaVersion !== 1) {
    throw new TypeError('Session checkpoint Manifest schema version must be 1');
  }
  const value = createSessionCheckpointManifestV1(
    admitImmutableObjectRef(input.value.compatibilityBundle),
  );
  if (manifest.mediaType !== SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE) {
    throw new TypeError('Session checkpoint Manifest has an unsupported media type');
  }
  const bytes = encodeSessionCheckpointManifestV1(value);
  if (manifest.digest !== digestBytes(bytes) || manifest.bytes !== bytes.byteLength) {
    throw repositoryError('integrity_mismatch', 'Manifest value does not match its reference');
  }
  return { manifest, value };
}

function admitImmutableObjectInput(input: ImmutableObjectInput): ImmutableObjectInput {
  if (!isRecord(input) || !isSha256Digest(input.digest) || !isByteCount(input.bytes)) {
    throw new TypeError('Immutable object input is invalid');
  }
  const mediaType = requireIdentifier(input.mediaType, 'Immutable object media type');
  if (!isRecord(input.source)) throw new TypeError('Immutable object source is invalid');
  if (input.source.kind === 'file') {
    return {
      ...input,
      mediaType,
      source: {
        kind: 'file',
        path: requireIdentifier(input.source.path, 'Object source path', MAX_OBJECT_REF_LENGTH),
      },
    };
  }
  if (input.source.kind === 'bytes' && input.source.value instanceof Uint8Array) {
    return {
      ...input,
      mediaType,
      source: { kind: 'bytes', value: Uint8Array.from(input.source.value) },
    };
  }
  throw new TypeError('Immutable object source is invalid');
}

function admitImmutableObjectMaterializationInput(
  input: ImmutableObjectMaterializationInput,
): ImmutableObjectMaterializationInput {
  if (!isRecord(input)) {
    throw new TypeError('Immutable object materialization input must be an object');
  }
  if (!isByteCount(input.maxBytes)) {
    throw new TypeError(
      'Immutable object materialization byte limit must be a non-negative safe integer',
    );
  }
  return {
    ref: admitImmutableObjectRef(input.ref),
    destination: requireIdentifier(
      input.destination,
      'Immutable object materialization destination',
      MAX_OBJECT_REF_LENGTH,
    ),
    maxBytes: input.maxBytes,
  };
}

function admitImmutableObjectRef(input: ImmutableObjectRef): ImmutableObjectRef {
  if (!isRecord(input) || !isSha256Digest(input.digest) || !isByteCount(input.bytes)) {
    throw new TypeError('Immutable object reference is invalid');
  }
  return immutableObjectRef({
    objectRef: requireIdentifier(
      input.objectRef,
      'Immutable object reference',
      MAX_OBJECT_REF_LENGTH,
    ),
    digest: input.digest,
    bytes: input.bytes,
    mediaType: requireIdentifier(input.mediaType, 'Immutable object media type'),
  });
}

function admitRevisionRef(input: SessionRevisionRef, label: string): SessionRevisionRef {
  if (!isRecord(input)) throw new TypeError(`${label} must be an object`);
  return copyRevisionRef({
    sessionId: requireIdentifier(input.sessionId, `${label} Session identity`),
    revision: requireIdentifier(input.revision, `${label} revision`),
  });
}

function committedRevision(input: {
  readonly sessionId: string;
  readonly revision: string;
  readonly agentId: string;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
}): CommittedSessionRevision {
  return {
    ref: copyRevisionRef({ sessionId: input.sessionId, revision: input.revision }),
    agentId: input.agentId,
    checkpoint: admitStoredCheckpoint(input.checkpoint),
    ...(input.lastCommittedActivationId === undefined
      ? {}
      : { lastCommittedActivationId: input.lastCommittedActivationId }),
    ...(input.forkedFrom === undefined ? {} : { forkedFrom: copyRevisionRef(input.forkedFrom) }),
  };
}

function copyCommittedSessionRevision(input: CommittedSessionRevision): CommittedSessionRevision {
  return committedRevision({
    sessionId: input.ref.sessionId,
    revision: input.ref.revision,
    agentId: input.agentId,
    checkpoint: input.checkpoint,
    ...(input.lastCommittedActivationId === undefined
      ? {}
      : { lastCommittedActivationId: input.lastCommittedActivationId }),
    ...(input.forkedFrom === undefined ? {} : { forkedFrom: input.forkedFrom }),
  });
}

function immutableObjectRef(input: ImmutableObjectRef): ImmutableObjectRef {
  return {
    objectRef: input.objectRef,
    digest: input.digest,
    bytes: input.bytes,
    mediaType: input.mediaType,
  };
}

function copyRevisionRef(input: SessionRevisionRef): SessionRevisionRef {
  return { sessionId: input.sessionId, revision: input.revision };
}

function copyForkOperation(input: PersistentFork): ForkOperation {
  return input.state === 'pending'
    ? {
        state: 'pending',
        forkId: input.forkId,
        source: copyRevisionRef(input.source),
        sourceAgentId: input.sourceAgentId,
        sourceCheckpoint: admitStoredCheckpoint(input.sourceCheckpoint),
        targetSessionId: input.targetSessionId,
      }
    : copyCompletedForkOperation(input);
}

function copyCompletedForkOperation(input: PersistentCompletedFork): CompletedForkOperation {
  return {
    state: 'completed',
    forkId: input.forkId,
    source: copyRevisionRef(input.source),
    sourceAgentId: input.sourceAgentId,
    sourceCheckpoint: admitStoredCheckpoint(input.sourceCheckpoint),
    targetSessionId: input.targetSessionId,
    target: copyRevisionRef(input.target),
  };
}

function sameStoredCheckpoint(
  left: StoredSessionCheckpoint,
  right: StoredSessionCheckpoint,
): boolean {
  return (
    sameImmutableObjectRef(left.manifest, right.manifest) &&
    sameImmutableObjectRef(left.value.compatibilityBundle, right.value.compatibilityBundle)
  );
}

function sameImmutableObjectRef(left: ImmutableObjectRef, right: ImmutableObjectRef): boolean {
  return (
    left.objectRef === right.objectRef &&
    left.digest === right.digest &&
    left.bytes === right.bytes &&
    left.mediaType === right.mediaType
  );
}

function sameRevisionRef(left: SessionRevisionRef, right: SessionRevisionRef): boolean {
  return left.sessionId === right.sessionId && left.revision === right.revision;
}

function sameOptionalRevisionRef(
  left: SessionRevisionRef | undefined,
  right: SessionRevisionRef | undefined,
): boolean {
  return left === undefined || right === undefined ? left === right : sameRevisionRef(left, right);
}

async function writePublishedObject(
  input: ImmutableObjectInput,
  destination: string,
): Promise<void> {
  if (input.source.kind === 'bytes') {
    const bytes = Uint8Array.from(input.source.value);
    assertImmutableBytesMatch(bytes, input.digest, input.bytes);
    await writeNewFile(destination, async (handle) => writeAll(handle, bytes));
    return;
  }
  await copyImmutableFile(input.source.path, destination, {
    digest: input.digest,
    bytes: input.bytes,
  });
}

/**
 * Copies and verifies in chunks. The supplied reference is deliberately the
 * bound: a malicious or changing source can never make this adapter retain an
 * unbounded in-memory buffer or publish more bytes than it declared.
 */
async function copyImmutableFile(
  source: string,
  destination: string,
  ref: Pick<ImmutableObjectRef, 'digest' | 'bytes'>,
): Promise<void> {
  await writeNewFile(destination, async (handle) => {
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const rawChunk of createReadStream(source)) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.byteLength;
      if (bytes > ref.bytes) {
        throw repositoryError(
          'integrity_mismatch',
          'Immutable object bytes exceed declared metadata',
        );
      }
      digest.update(chunk);
      await writeAll(handle, chunk);
    }
    assertImmutableDigestMatch(bytes, digest.digest('hex'), ref.bytes, ref.digest);
  });
}

async function assertFileMatchesImmutableRef(path: string, ref: ImmutableObjectRef): Promise<void> {
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > ref.bytes) {
      throw repositoryError(
        'integrity_mismatch',
        'Immutable object bytes no longer match metadata',
      );
    }
    digest.update(chunk);
  }
  assertImmutableDigestMatch(bytes, digest.digest('hex'), ref.bytes, ref.digest);
}

async function writeNewFile(
  path: string,
  writer: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'wx', 0o600);
    await writer(handle);
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = undefined;
      await rm(path, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function writeAll(handle: FileHandle, value: Uint8Array): Promise<void> {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) {
      throw repositoryError('io_failure', 'Immutable object write made no progress');
    }
    offset += result.bytesWritten;
  }
}

function assertImmutableBytesMatch(
  bytes: Uint8Array,
  expectedDigest: Sha256Digest,
  expectedBytes: number,
): void {
  if (bytes.byteLength !== expectedBytes || digestBytes(bytes) !== expectedDigest) {
    throw repositoryError(
      'integrity_mismatch',
      'Immutable object bytes do not match declared metadata',
    );
  }
}

function assertImmutableDigestMatch(
  actualBytes: number,
  digestHex: string,
  expectedBytes: number,
  expectedDigest: Sha256Digest,
): void {
  const actualDigest = `sha256:${digestHex}`;
  if (actualBytes !== expectedBytes || actualDigest !== expectedDigest) {
    throw repositoryError('integrity_mismatch', 'Immutable object bytes no longer match metadata');
  }
}

function localObjectRef(digest: Sha256Digest, mediaType: string): string {
  return `maka-local-object://v1/${createHash('sha256').update(`${digest}\u0000${mediaType}`).digest('hex')}`;
}

function objectPath(objectsRoot: string, ref: ImmutableObjectRef): string {
  const id = ref.objectRef.slice('maka-local-object://v1/'.length);
  return join(objectsRoot, id.slice(0, 2), id);
}

async function linkNoReplace(source: string, destination: string): Promise<void> {
  const { link } = await import('node:fs/promises');
  await link(source, destination);
}

async function writeStateAtomically(path: string, state: PersistentState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  try {
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function decodeState(bytes: Uint8Array): PersistentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw repositoryError(
      'integrity_mismatch',
      'Local Session Repository state is invalid JSON',
      error,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.sessions) ||
    !Array.isArray(parsed.commits) ||
    !Array.isArray(parsed.forks)
  ) {
    throw repositoryError('integrity_mismatch', 'Local Session Repository state schema is invalid');
  }
  try {
    const state: PersistentState = {
      schemaVersion: 1,
      sessions: parsed.sessions.map(decodeSession),
      commits: parsed.commits.map(decodeCommit),
      forks: parsed.forks.map(decodeFork),
    };
    assertUnique(state.sessions, (entry) => entry.sessionId, 'Session identity');
    assertUnique(
      state.commits,
      (entry) => `${entry.sessionId}\u0000${entry.commitId}`,
      'Commit identity',
    );
    assertUnique(state.forks, (entry) => entry.forkId, 'Fork identity');
    assertPersistentStateConsistency(state);
    return state;
  } catch (error) {
    if (error instanceof SessionRepositoryError) throw error;
    throw repositoryError('integrity_mismatch', 'Local Session Repository state is invalid', error);
  }
}

function decodeSession(value: unknown): PersistentSession {
  if (!isRecord(value)) throw new TypeError('Session state is invalid');
  const sessionId = requireIdentifier(value.sessionId, 'Session identity');
  const agentId = requireIdentifier(value.agentId, 'Agent identity');
  const forkedFrom =
    value.forkedFrom === undefined
      ? undefined
      : admitRevisionRef(value.forkedFrom as SessionRevisionRef, 'Fork source');
  const createdByForkId =
    value.createdByForkId === undefined
      ? undefined
      : requireIdentifier(value.createdByForkId, 'Fork identity');
  if ((forkedFrom === undefined) !== (createdByForkId === undefined)) {
    throw new TypeError('Session Fork lineage and Fork identity must be supplied together');
  }
  const head = decodeCommitted(value.head);
  const createdRevision = decodeCommitted(value.createdRevision);
  if (
    head.ref.sessionId !== sessionId ||
    head.agentId !== agentId ||
    createdRevision.ref.sessionId !== sessionId ||
    createdRevision.agentId !== agentId
  ) {
    throw new TypeError('Session state identity binding is invalid');
  }
  return {
    sessionId,
    agentId,
    head,
    nextRevisionNumber: requireRevisionNumber(value.nextRevisionNumber),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    ...(createdByForkId === undefined ? {} : { createdByForkId }),
    createdRevision,
  };
}

function decodeCommit(value: unknown): PersistentCommit {
  if (!isRecord(value)) throw new TypeError('Commit state is invalid');
  const input = admitCommitSessionRevisionInput(value.input as CommitSessionRevisionInput);
  if (input.commitId === undefined) throw new TypeError('Commit state lacks identity');
  const sessionId = requireIdentifier(value.sessionId, 'Session identity');
  const commitId = requireIdentifier(value.commitId, 'Commit identity');
  const result = decodeCommitted(value.result);
  if (
    input.sessionId !== sessionId ||
    input.commitId !== commitId ||
    result.ref.sessionId !== sessionId
  ) {
    throw new TypeError('Commit state identity binding is invalid');
  }
  return {
    sessionId,
    commitId,
    input,
    result,
  };
}

function decodeFork(value: unknown): PersistentFork {
  if (!isRecord(value)) throw new TypeError('Fork state is invalid');
  const base = {
    forkId: requireIdentifier(value.forkId, 'Fork identity'),
    source: admitRevisionRef(value.source as SessionRevisionRef, 'Fork source'),
    sourceAgentId: requireIdentifier(value.sourceAgentId, 'Fork source Agent identity'),
    sourceCheckpoint: admitStoredCheckpoint(value.sourceCheckpoint as StoredSessionCheckpoint),
    targetSessionId: requireIdentifier(value.targetSessionId, 'Fork target Session identity'),
  };
  if (value.state === 'pending') return { state: 'pending', ...base };
  if (value.state === 'completed') {
    return {
      state: 'completed',
      ...base,
      target: admitRevisionRef(value.target as SessionRevisionRef, 'Fork target'),
    };
  }
  throw new TypeError('Fork state is invalid');
}

function decodeCommitted(value: unknown): CommittedSessionRevision {
  if (!isRecord(value)) throw new TypeError('Committed revision is invalid');
  return committedRevision({
    sessionId: admitRevisionRef(value.ref as SessionRevisionRef, 'Session revision reference')
      .sessionId,
    revision: admitRevisionRef(value.ref as SessionRevisionRef, 'Session revision reference')
      .revision,
    agentId: requireIdentifier(value.agentId, 'Agent identity'),
    checkpoint: admitStoredCheckpoint(value.checkpoint as StoredSessionCheckpoint),
    ...(value.lastCommittedActivationId === undefined
      ? {}
      : {
          lastCommittedActivationId: requireIdentifier(
            value.lastCommittedActivationId,
            'Activation identity',
          ),
        }),
    ...(value.forkedFrom === undefined
      ? {}
      : { forkedFrom: admitRevisionRef(value.forkedFrom as SessionRevisionRef, 'Fork source') }),
  });
}

function requireRevisionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 2)
    throw new TypeError('Next revision number is invalid');
  return value;
}

/**
 * JSON syntax and individual field validation are not sufficient for the
 * control document: the records must describe one non-contradictory Session
 * history before any writer derives a new revision from it.
 */
function assertPersistentStateConsistency(state: PersistentState): void {
  for (const session of state.sessions) {
    assertPersistentSessionConsistency(session);
    assertPersistentCreatedForkTarget(state, session);
  }

  const committedRevisions = new Set<string>();
  for (const commit of state.commits) {
    const session = findSession(state, commit.sessionId);
    if (!session) throw new TypeError('Commit receipt references an unknown Session');
    const expectedRevision = revisionNumber(
      commit.input.expectedRevision,
      'Commit expected revision',
    );
    const resultRevision = revisionNumber(commit.result.ref.revision, 'Commit result revision');
    const headRevision = revisionNumber(session.head.ref.revision, 'Session head revision');
    if (
      resultRevision < 2 ||
      resultRevision > headRevision ||
      expectedRevision + 1 !== resultRevision ||
      commit.result.agentId !== session.agentId ||
      !sameStoredCheckpoint(commit.input.checkpoint, commit.result.checkpoint) ||
      commit.input.lastCommittedActivationId !== commit.result.lastCommittedActivationId ||
      !sameOptionalRevisionRef(commit.result.forkedFrom, session.forkedFrom) ||
      (resultRevision === headRevision &&
        !sameCommittedSessionRevision(commit.result, session.head))
    ) {
      throw new TypeError('Commit receipt contradicts Session state');
    }
    const key = `${commit.sessionId}\u0000${commit.result.ref.revision}`;
    if (committedRevisions.has(key)) throw new TypeError('Commit result revision is duplicated');
    committedRevisions.add(key);
  }

  for (const fork of state.forks) assertPersistentForkConsistency(state, fork);
}

function assertPersistentSessionConsistency(session: PersistentSession): void {
  const createdRevision = revisionNumber(
    session.createdRevision.ref.revision,
    'Session creation revision',
  );
  const headRevision = revisionNumber(session.head.ref.revision, 'Session head revision');
  if (
    createdRevision !== 1 ||
    headRevision >= Number.MAX_SAFE_INTEGER ||
    session.nextRevisionNumber !== headRevision + 1 ||
    !sameOptionalRevisionRef(session.createdRevision.forkedFrom, session.forkedFrom) ||
    !sameOptionalRevisionRef(session.head.forkedFrom, session.forkedFrom) ||
    (session.createdByForkId !== undefined &&
      session.createdRevision.lastCommittedActivationId !== undefined)
  ) {
    throw new TypeError('Session revision sequence is inconsistent');
  }
  if (headRevision === 1 && !sameCommittedSessionRevision(session.head, session.createdRevision)) {
    throw new TypeError('Session initial head contradicts creation revision');
  }
}

function assertPersistentForkConsistency(state: PersistentState, fork: PersistentFork): void {
  if (fork.source.sessionId === fork.targetSessionId) {
    throw new TypeError('Fork target Session must differ from its source Session');
  }
  const source = findSession(state, fork.source.sessionId);
  if (!source || source.agentId !== fork.sourceAgentId) {
    throw new TypeError('Fork source Agent binding is inconsistent');
  }
  const target = findSession(state, fork.targetSessionId);
  if (fork.state === 'completed') {
    if (
      !target ||
      target.agentId !== fork.sourceAgentId ||
      target.createdByForkId !== fork.forkId ||
      !target.forkedFrom ||
      !sameRevisionRef(target.forkedFrom, fork.source) ||
      !sameRevisionRef(fork.target, target.createdRevision.ref)
    ) {
      throw new TypeError('Completed Fork target is inconsistent');
    }
  }
}

function assertPersistentCreatedForkTarget(
  state: PersistentState,
  session: PersistentSession,
): void {
  if (session.createdByForkId === undefined || session.forkedFrom === undefined) return;
  const fork = findFork(state, session.createdByForkId);
  if (
    !fork ||
    fork.targetSessionId !== session.sessionId ||
    fork.sourceAgentId !== session.agentId ||
    !sameRevisionRef(fork.source, session.forkedFrom)
  ) {
    throw new TypeError('Fork-created Session does not match its claimed operation');
  }
}

function revisionNumber(revision: string, label: string): number {
  const match = /^r([1-9][0-9]*)$/u.exec(revision);
  if (!match) throw new TypeError(`${label} is not a canonical revision`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} is outside the safe range`);
  return value;
}

function sameCommittedSessionRevision(
  left: CommittedSessionRevision,
  right: CommittedSessionRevision,
): boolean {
  return (
    sameRevisionRef(left.ref, right.ref) &&
    left.agentId === right.agentId &&
    sameStoredCheckpoint(left.checkpoint, right.checkpoint) &&
    left.lastCommittedActivationId === right.lastCommittedActivationId &&
    sameOptionalRevisionRef(left.forkedFrom, right.forkedFrom)
  );
}

function assertUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const current = key(value);
    if (seen.has(current)) throw new TypeError(`${label} is duplicated`);
    seen.add(current);
  }
}

function requireIdentifier(
  value: unknown,
  label: string,
  maximumLength = MAX_IDENTIFIER_LENGTH,
): string {
  if (!isNonEmptyUnicodeString(value) || value.length > maximumLength) {
    throw new TypeError(`${label} must be a bounded non-empty Unicode string`);
  }
  return value;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest;
}

function repositoryError(
  code: SessionRepositoryErrorCode,
  message: string,
  cause?: unknown,
): SessionRepositoryError {
  return new SessionRepositoryError(code, message, cause === undefined ? {} : { cause });
}

function normalizeFileError(error: unknown, message: string): SessionRepositoryError {
  if (error instanceof SessionRepositoryError) return error;
  return repositoryError('io_failure', message, error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
