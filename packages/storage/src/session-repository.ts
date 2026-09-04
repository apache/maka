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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  isNonEmptyUnicodeString,
  isSha256Digest,
  type SessionBundleArtifact,
  type Sha256Digest,
} from './session-bundle-contract.js';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_OBJECT_REF_LENGTH = 2_048;

export const SESSION_BUNDLE_OBJECT_MEDIA_TYPE =
  'application/vnd.maka.session-bundle+tar;version=1;compression=zstd' as const;
export const SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE =
  'application/vnd.maka.session-checkpoint-manifest+json;version=1' as const;

/**
 * A Repository revision is opaque to callers. Revisions are scoped to one
 * Cloud Session and must never be reused as object digests or across Sessions.
 */
export type SessionRepositoryRevision = string;

export interface SessionRevisionRef {
  readonly sessionId: string;
  readonly revision: SessionRepositoryRevision;
}

/** Trusted metadata for one immutable object. */
export interface ImmutableObjectRef {
  readonly objectRef: string;
  readonly digest: Sha256Digest;
  readonly bytes: number;
  readonly mediaType: string;
}

export type ImmutableObjectSource =
  | {
      readonly kind: 'file';
      readonly path: string;
    }
  | {
      readonly kind: 'bytes';
      readonly value: Uint8Array;
    };

export interface ImmutableObjectInput {
  readonly digest: Sha256Digest;
  readonly bytes: number;
  readonly mediaType: string;
  readonly source: ImmutableObjectSource;
}

/**
 * Large immutable bytes live behind this port. Its publication semantics are
 * deliberately distinct from the Repository's head-CAS semantics.
 */
export interface ImmutableObjectStore {
  /**
   * Publishes bytes under a non-overwritable reference. Returning an existing
   * reference for identical input is allowed, but the exact bytes and declared
   * metadata must already be durably readable before this method returns.
   */
  publish(input: ImmutableObjectInput): Promise<ImmutableObjectRef>;
  /** Verifies the exact reference, byte count, media type, and digest. */
  assertReadable(ref: ImmutableObjectRef): Promise<void>;
}

export interface SessionCheckpointManifestV1 {
  readonly schemaVersion: 1;
  readonly compatibilityBundle: ImmutableObjectRef;
}

/**
 * The value is carried with its immutable reference so a Repository can
 * validate the canonical Manifest digest without acquiring a general read API.
 */
export interface StoredSessionCheckpoint {
  readonly manifest: ImmutableObjectRef;
  readonly value: SessionCheckpointManifestV1;
}

export interface CommittedSessionRevision {
  readonly ref: SessionRevisionRef;
  readonly agentId: string;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
}

export interface CommitSessionRevisionInput {
  readonly sessionId: string;
  readonly expectedRevision: SessionRepositoryRevision;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  /**
   * Optional caller operation identity. Retrying the same identity and input
   * returns the original committed revision rather than allocating another.
   */
  readonly commitId?: string;
}

export interface CreateSessionInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
  /** Required for a Fork-created target Session. */
  readonly createdByForkId?: string;
}

export interface ClaimForkInput {
  readonly forkId: string;
  readonly source: SessionRevisionRef;
  readonly targetSessionId: string;
}

export interface CompleteForkInput {
  readonly forkId: string;
}

export interface PendingForkOperation {
  readonly state: 'pending';
  readonly forkId: string;
  readonly source: SessionRevisionRef;
  /** Captured from the verified source Session when the Fork is first claimed. */
  readonly sourceAgentId: string;
  /**
   * The exact source checkpoint admitted by the claim. V1 retains only the
   * current head, so a later source advance must not make a pending Fork
   * unable to recover its source bytes and metadata.
   */
  readonly sourceCheckpoint: StoredSessionCheckpoint;
  readonly targetSessionId: string;
}

export interface CompletedForkOperation extends Omit<PendingForkOperation, 'state'> {
  readonly state: 'completed';
  readonly target: SessionRevisionRef;
}

export type ForkOperation = PendingForkOperation | CompletedForkOperation;

/**
 * V1 never expires completed Fork identities. A production Repository must
 * retain this mapping durably; the in-memory conformance implementation does
 * so for its lifetime.
 */
export type ForkIdempotencyRetention = 'indefinite';

/**
 * Strongly consistent Session metadata and operation records live behind this
 * port. Immutable object publication remains a separate prerequisite.
 */
export interface SessionRepository {
  readonly forkIdempotencyRetention: ForkIdempotencyRetention;
  /**
   * Resolves the current head and verifies its checkpoint as one Repository
   * read. Callers that do not already hold a revision must not maintain an
   * independent current-head record.
   */
  checkoutCurrent(sessionId: string): Promise<CommittedSessionRevision>;
  checkoutExact(ref: SessionRevisionRef): Promise<CommittedSessionRevision>;
  createSession(input: CreateSessionInput): Promise<CommittedSessionRevision>;
  commit(input: CommitSessionRevisionInput): Promise<CommittedSessionRevision>;
  claimFork(input: ClaimForkInput): Promise<ForkOperation>;
  completeFork(input: CompleteForkInput): Promise<CompletedForkOperation>;
}

export type SessionRepositoryErrorCode =
  | 'session_not_found'
  | 'source_revision_not_available'
  | 'revision_not_available'
  | 'revision_conflict'
  | 'session_already_exists'
  | 'idempotency_conflict'
  | 'invalid_fork_target'
  | 'fork_agent_mismatch'
  | 'object_not_found'
  | 'integrity_mismatch'
  | 'quota_exceeded'
  | 'io_failure';

export class SessionRepositoryError extends Error {
  constructor(
    readonly code: SessionRepositoryErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionRepositoryError';
  }
}

export interface PublishSessionCheckpointV1Input {
  readonly objectStore: ImmutableObjectStore;
  readonly compatibilityBundle: SessionBundleArtifact;
}

/**
 * Publishes and verifies the compatibility Bundle before publishing and
 * verifying the immutable Manifest that names it. The returned checkpoint is
 * suitable for a later Repository create or head-CAS operation.
 */
export async function publishSessionCheckpointV1(
  input: PublishSessionCheckpointV1Input,
): Promise<StoredSessionCheckpoint> {
  if (!isRecord(input))
    throw new TypeError('Session checkpoint publication input must be an object');
  const objectStore = requireImmutableObjectStore(input.objectStore);
  const artifact = admitSessionBundleArtifact(input.compatibilityBundle);
  const compatibilityBundle = await publishVerifiedObject(objectStore, {
    digest: artifact.archiveDigest,
    bytes: artifact.compressedBytes,
    mediaType: SESSION_BUNDLE_OBJECT_MEDIA_TYPE,
    source: { kind: 'file', path: artifact.path },
  });
  const value = createSessionCheckpointManifestV1(compatibilityBundle);
  const manifestBytes = encodeSessionCheckpointManifestV1(value);
  const manifest = await publishVerifiedObject(objectStore, {
    digest: digestBytes(manifestBytes),
    bytes: manifestBytes.byteLength,
    mediaType: SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE,
    source: { kind: 'bytes', value: manifestBytes },
  });
  return storedSessionCheckpoint({ manifest, value });
}

export function createSessionCheckpointManifestV1(
  compatibilityBundle: ImmutableObjectRef,
): SessionCheckpointManifestV1 {
  const admitted = admitImmutableObjectRef(compatibilityBundle);
  if (admitted.mediaType !== SESSION_BUNDLE_OBJECT_MEDIA_TYPE) {
    throw new TypeError('V1 compatibility Bundle has an unsupported media type');
  }
  return Object.freeze({
    schemaVersion: 1,
    compatibilityBundle: copyImmutableObjectRef(admitted),
  });
}

/** RFC 8785/JCS V1 encoding used to bind a Manifest value to its object digest. */
export function encodeSessionCheckpointManifestV1(input: SessionCheckpointManifestV1): Uint8Array {
  const value = admitSessionCheckpointManifestV1(input);
  return new TextEncoder().encode(
    JSON.stringify({
      compatibilityBundle: {
        bytes: value.compatibilityBundle.bytes,
        digest: value.compatibilityBundle.digest,
        mediaType: value.compatibilityBundle.mediaType,
        objectRef: value.compatibilityBundle.objectRef,
      },
      schemaVersion: value.schemaVersion,
    }),
  );
}

export function createInMemoryImmutableObjectStore(): ImmutableObjectStore {
  return new InMemoryImmutableObjectStore();
}

export interface CreateInMemorySessionRepositoryOptions {
  readonly objectStore: ImmutableObjectStore;
}

/**
 * Deterministic conformance implementation for coordinators and Fork tests.
 * It models the V1 single-current-head retention policy, but it is not a
 * durable control-plane backend.
 */
export function createInMemorySessionRepository(
  options: CreateInMemorySessionRepositoryOptions,
): SessionRepository {
  if (!isRecord(options)) throw new TypeError('In-memory Repository options must be an object');
  return new InMemorySessionRepository(requireImmutableObjectStore(options.objectStore));
}

class InMemorySessionRepository implements SessionRepository {
  readonly forkIdempotencyRetention = 'indefinite' as const;

  private readonly sessions = new Map<string, SessionState>();
  private readonly commitsBySession = new Map<string, Map<string, CommitRecord>>();
  private readonly forks = new Map<string, InternalForkOperation>();

  constructor(private readonly objectStore: ImmutableObjectStore) {}

  async checkoutCurrent(sessionId: string): Promise<CommittedSessionRevision> {
    const admittedSessionId = requireIdentifier(sessionId, 'Session identity');
    const session = this.sessions.get(admittedSessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');

    // Capture exactly the current head selected by this read before awaiting
    // object verification. A subsequent writer cannot substitute its head.
    const committed = copyCommittedSessionRevision(session.head);
    await this.assertCheckpointReadable(committed.checkpoint);
    return committed;
  }

  async checkoutExact(ref: SessionRevisionRef): Promise<CommittedSessionRevision> {
    const requested = admitRevisionRef(ref, 'Session revision reference');
    const session = this.sessions.get(requested.sessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (session.head.ref.revision !== requested.revision) {
      throw repositoryError(
        'revision_not_available',
        'Requested Session revision is not available',
      );
    }

    // Capture the exact record before asynchronous object reads. A later head
    // advance may make this revision non-current, but cannot substitute bytes.
    const committed = copyCommittedSessionRevision(session.head);
    await this.assertCheckpointReadable(committed.checkpoint);
    return committed;
  }

  async commit(input: CommitSessionRevisionInput): Promise<CommittedSessionRevision> {
    const admitted = admitCommitSessionRevisionInput(input);
    const prior = this.reconcilePriorCommit(admitted);
    if (prior) {
      await this.assertCheckpointReadable(prior.checkpoint);
      return prior;
    }

    const initial = this.sessions.get(admitted.sessionId);
    if (!initial) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (initial.head.ref.revision !== admitted.expectedRevision) {
      throw repositoryError('revision_conflict', 'Cloud Session head changed before commit');
    }

    await this.assertCheckpointReadable(admitted.checkpoint);

    // Object verification may yield. Reconcile an identical concurrent retry,
    // then recheck CAS so another commit cannot be overwritten.
    const admittedWhileReading = this.reconcilePriorCommit(admitted);
    if (admittedWhileReading) return admittedWhileReading;
    const session = this.sessions.get(admitted.sessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (session.head.ref.revision !== admitted.expectedRevision) {
      throw repositoryError('revision_conflict', 'Cloud Session head changed before commit');
    }

    const result = committedRevision({
      sessionId: admitted.sessionId,
      revision: nextRevision(session),
      agentId: session.agentId,
      checkpoint: admitted.checkpoint,
      lastCommittedActivationId: admitted.lastCommittedActivationId,
      forkedFrom: session.forkedFrom,
    });
    session.head = result;
    if (admitted.commitId !== undefined) {
      let records = this.commitsBySession.get(admitted.sessionId);
      if (!records) {
        records = new Map();
        this.commitsBySession.set(admitted.sessionId, records);
      }
      records.set(admitted.commitId, { input: admitted, result });
    }
    return copyCommittedSessionRevision(result);
  }

  async createSession(input: CreateSessionInput): Promise<CommittedSessionRevision> {
    const admitted = admitCreateSessionInput(input);
    const existing = this.sessions.get(admitted.sessionId);
    if (existing) {
      const reconciled = this.reconcileExistingSessionCreate(existing, admitted);
      await this.assertCheckpointReadable(reconciled.checkpoint);
      return reconciled;
    }

    await this.assertCheckpointReadable(admitted.checkpoint);

    // Object verification may yield. Create-if-absent is decided only after it
    // returns, at this method's synchronous linearization point.
    const afterVerification = this.sessions.get(admitted.sessionId);
    if (afterVerification) {
      const reconciled = this.reconcileExistingSessionCreate(afterVerification, admitted);
      await this.assertCheckpointReadable(reconciled.checkpoint);
      return reconciled;
    }

    if (admitted.createdByForkId !== undefined) this.assertPendingForkCreate(admitted);
    const initial = committedRevision({
      sessionId: admitted.sessionId,
      revision: 'r1',
      agentId: admitted.agentId,
      checkpoint: admitted.checkpoint,
      lastCommittedActivationId: admitted.lastCommittedActivationId,
      forkedFrom: admitted.forkedFrom,
    });
    this.sessions.set(admitted.sessionId, {
      agentId: admitted.agentId,
      head: initial,
      nextRevisionNumber: 2,
      forkedFrom: admitted.forkedFrom,
      createdByForkId: admitted.createdByForkId,
      createdRevision: initial,
    });
    return copyCommittedSessionRevision(initial);
  }

  async claimFork(input: ClaimForkInput): Promise<ForkOperation> {
    const admitted = admitClaimForkInput(input);
    const existing = this.forks.get(admitted.forkId);
    if (existing) {
      if (!sameForkClaim(existing, admitted)) {
        throw repositoryError(
          'idempotency_conflict',
          'Fork identity was reused with different input',
        );
      }
      return copyForkOperation(existing);
    }
    if (admitted.targetSessionId === admitted.source.sessionId) {
      throw repositoryError(
        'invalid_fork_target',
        'Fork target Session must differ from its source Session',
      );
    }

    // The first claim is the linearization point for the source binding. It
    // must prove the named revision is still current and readable before a
    // retry can rely on this durable Fork record.
    const source = await this.resolveForkSource(admitted.source);

    // Source verification may yield. Reconcile another claimant that won while
    // it was in progress rather than overwriting its durable idempotency fact.
    const claimedWhileReading = this.forks.get(admitted.forkId);
    if (claimedWhileReading) {
      if (!sameForkClaim(claimedWhileReading, admitted)) {
        throw repositoryError(
          'idempotency_conflict',
          'Fork identity was reused with different input',
        );
      }
      return copyForkOperation(claimedWhileReading);
    }

    const pending: InternalPendingForkOperation = {
      state: 'pending',
      forkId: admitted.forkId,
      source: admitted.source,
      sourceAgentId: source.agentId,
      sourceCheckpoint: source.checkpoint,
      targetSessionId: admitted.targetSessionId,
    };
    this.forks.set(admitted.forkId, pending);
    return copyForkOperation(pending);
  }

  async completeFork(input: CompleteForkInput): Promise<CompletedForkOperation> {
    const forkId = requireIdentifier(input?.forkId, 'Fork identity');
    const operation = this.forks.get(forkId);
    if (!operation) throw repositoryError('idempotency_conflict', 'Fork identity was not claimed');
    if (operation.state === 'completed') return copyCompletedForkOperation(operation);

    const target = this.sessions.get(operation.targetSessionId);
    if (!target) throw repositoryError('session_not_found', 'Fork target Session was not found');
    if (target.agentId !== operation.sourceAgentId) {
      throw repositoryError(
        'fork_agent_mismatch',
        'Fork target Agent does not match its verified source Agent',
      );
    }
    if (
      target.createdByForkId !== operation.forkId ||
      !target.forkedFrom ||
      !sameRevisionRef(target.forkedFrom, operation.source)
    ) {
      throw repositoryError('idempotency_conflict', 'Fork target was created by another operation');
    }
    await this.assertCheckpointReadable(target.createdRevision.checkpoint);

    const completed: InternalCompletedForkOperation = {
      ...operation,
      state: 'completed',
      target: copyRevisionRef(target.createdRevision.ref),
    };
    this.forks.set(forkId, completed);
    return copyCompletedForkOperation(completed);
  }

  private reconcilePriorCommit(
    input: InternalCommitSessionRevisionInput,
  ): CommittedSessionRevision | undefined {
    if (input.commitId === undefined) return undefined;
    const prior = this.commitsBySession.get(input.sessionId)?.get(input.commitId);
    if (!prior) return undefined;
    if (!sameCommitInput(prior.input, input)) {
      throw repositoryError(
        'idempotency_conflict',
        'Commit identity was reused with different input',
      );
    }
    return copyCommittedSessionRevision(prior.result);
  }

  private reconcileExistingSessionCreate(
    existing: SessionState,
    input: InternalCreateSessionInput,
  ): CommittedSessionRevision {
    if (
      input.createdByForkId !== undefined &&
      existing.createdByForkId === input.createdByForkId &&
      sameCreateInput(existing.createdRevision, existing.agentId, existing.forkedFrom, input)
    ) {
      return copyCommittedSessionRevision(existing.createdRevision);
    }
    throw repositoryError('session_already_exists', 'Cloud Session already exists');
  }

  private assertPendingForkCreate(input: InternalCreateSessionInput): void {
    const operation = this.forks.get(input.createdByForkId!);
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
      throw repositoryError(
        'fork_agent_mismatch',
        'Fork target Agent must match its verified source Agent',
      );
    }
  }

  private async resolveForkSource(source: SessionRevisionRef): Promise<CommittedSessionRevision> {
    const initial = this.sessions.get(source.sessionId);
    if (!initial || initial.head.ref.revision !== source.revision) {
      throw repositoryError(
        'source_revision_not_available',
        'Fork source Session revision is not available',
      );
    }

    const committed = copyCommittedSessionRevision(initial.head);
    await this.assertCheckpointReadable(committed.checkpoint);

    // A source head advance while asynchronous object verification ran makes
    // this request ineligible. Later retries of an admitted fork use the
    // durable claim above and intentionally do not revalidate this condition.
    const afterVerification = this.sessions.get(source.sessionId);
    if (
      !afterVerification ||
      afterVerification.head.ref.revision !== source.revision ||
      afterVerification.agentId !== committed.agentId
    ) {
      throw repositoryError(
        'source_revision_not_available',
        'Fork source Session revision is no longer current',
      );
    }
    return committed;
  }

  private async assertCheckpointReadable(
    input: StoredSessionCheckpoint,
  ): Promise<StoredSessionCheckpoint> {
    const checkpoint = admitStoredSessionCheckpoint(input);
    try {
      await this.objectStore.assertReadable(checkpoint.manifest);
      await this.objectStore.assertReadable(checkpoint.value.compatibilityBundle);
      return checkpoint;
    } catch (error) {
      throw normalizeObjectStoreError(error);
    }
  }
}

class InMemoryImmutableObjectStore implements ImmutableObjectStore {
  private readonly objects = new Map<string, InMemoryObject>();

  async publish(input: ImmutableObjectInput): Promise<ImmutableObjectRef> {
    const admitted = admitImmutableObjectInput(input);
    let bytes: Uint8Array;
    try {
      bytes =
        admitted.source.kind === 'file'
          ? await readFile(admitted.source.path)
          : Uint8Array.from(admitted.source.value);
    } catch (error) {
      throw repositoryError(
        'io_failure',
        'Immutable object publication could not read bytes',
        error,
      );
    }
    if (bytes.byteLength !== admitted.bytes || digestBytes(bytes) !== admitted.digest) {
      throw repositoryError(
        'integrity_mismatch',
        'Immutable object bytes do not match declared metadata',
      );
    }

    const mediaTypeKey = digestBytes(new TextEncoder().encode(admitted.mediaType)).slice(
      'sha256:'.length,
      'sha256:'.length + 16,
    );
    const ref = immutableObjectRef({
      objectRef: `memory://immutable-objects/${admitted.digest.slice('sha256:'.length)}/${mediaTypeKey}`,
      digest: admitted.digest,
      bytes: admitted.bytes,
      mediaType: admitted.mediaType,
    });
    const existing = this.objects.get(ref.objectRef);
    if (existing) {
      if (!sameImmutableObjectRef(existing.ref, ref) || !sameBytes(existing.bytes, bytes)) {
        throw repositoryError(
          'integrity_mismatch',
          'Immutable object reference already contains different bytes or metadata',
        );
      }
      return copyImmutableObjectRef(existing.ref);
    }
    this.objects.set(ref.objectRef, { ref, bytes: Uint8Array.from(bytes) });
    return copyImmutableObjectRef(ref);
  }

  async assertReadable(input: ImmutableObjectRef): Promise<void> {
    const ref = admitImmutableObjectRef(input);
    const stored = this.objects.get(ref.objectRef);
    if (!stored) throw repositoryError('object_not_found', 'Immutable object was not found');
    if (
      !sameImmutableObjectRef(stored.ref, ref) ||
      stored.bytes.byteLength !== ref.bytes ||
      digestBytes(stored.bytes) !== ref.digest
    ) {
      throw repositoryError(
        'integrity_mismatch',
        'Immutable object bytes no longer match their trusted metadata',
      );
    }
  }
}

interface SessionState {
  readonly agentId: string;
  head: CommittedSessionRevision;
  nextRevisionNumber: number;
  readonly forkedFrom?: SessionRevisionRef;
  readonly createdByForkId?: string;
  readonly createdRevision: CommittedSessionRevision;
}

interface InMemoryObject {
  readonly ref: ImmutableObjectRef;
  readonly bytes: Uint8Array;
}

interface InternalCommitSessionRevisionInput {
  readonly sessionId: string;
  readonly expectedRevision: SessionRepositoryRevision;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly commitId?: string;
}

interface InternalCreateSessionInput {
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

interface CommitRecord {
  readonly input: InternalCommitSessionRevisionInput;
  readonly result: CommittedSessionRevision;
}

type InternalForkOperation = InternalPendingForkOperation | InternalCompletedForkOperation;

interface InternalPendingForkOperation extends PendingForkOperation {}

interface InternalCompletedForkOperation extends CompletedForkOperation {}

async function publishVerifiedObject(
  objectStore: ImmutableObjectStore,
  input: ImmutableObjectInput,
): Promise<ImmutableObjectRef> {
  const expected = admitImmutableObjectInput(input);
  try {
    const published = admitImmutableObjectRef(await objectStore.publish(expected));
    if (
      published.digest !== expected.digest ||
      published.bytes !== expected.bytes ||
      published.mediaType !== expected.mediaType
    ) {
      throw repositoryError(
        'integrity_mismatch',
        'Published immutable object metadata does not match its input',
      );
    }
    await objectStore.assertReadable(published);
    return copyImmutableObjectRef(published);
  } catch (error) {
    throw normalizeObjectStoreError(error);
  }
}

function admitSessionBundleArtifact(input: SessionBundleArtifact): SessionBundleArtifact {
  if (!isRecord(input)) throw new TypeError('Session Bundle artifact must be an object');
  const path = requireIdentifier(input.path, 'Bundle archive path', MAX_OBJECT_REF_LENGTH);
  if (!isSha256Digest(input.archiveDigest)) {
    throw new TypeError('Bundle archive digest must be SHA-256');
  }
  if (!isByteCount(input.compressedBytes)) {
    throw new TypeError('Bundle compressed byte count must be a non-negative safe integer');
  }
  return {
    ...input,
    path,
    archiveDigest: input.archiveDigest,
    compressedBytes: input.compressedBytes,
  };
}

function admitImmutableObjectInput(input: ImmutableObjectInput): ImmutableObjectInput {
  if (!isRecord(input)) throw new TypeError('Immutable object input must be an object');
  if (!isSha256Digest(input.digest)) throw new TypeError('Immutable object digest must be SHA-256');
  if (!isByteCount(input.bytes)) {
    throw new TypeError('Immutable object byte count must be a non-negative safe integer');
  }
  const mediaType = requireIdentifier(input.mediaType, 'Immutable object media type');
  if (!isRecord(input.source)) throw new TypeError('Immutable object source must be an object');
  if (input.source.kind === 'file') {
    return Object.freeze({
      digest: input.digest,
      bytes: input.bytes,
      mediaType,
      source: Object.freeze({
        kind: 'file' as const,
        path: requireIdentifier(
          input.source.path,
          'Immutable object source path',
          MAX_OBJECT_REF_LENGTH,
        ),
      }),
    });
  }
  if (input.source.kind === 'bytes' && input.source.value instanceof Uint8Array) {
    return Object.freeze({
      digest: input.digest,
      bytes: input.bytes,
      mediaType,
      source: Object.freeze({ kind: 'bytes' as const, value: Uint8Array.from(input.source.value) }),
    });
  }
  throw new TypeError('Immutable object source must contain file or byte content');
}

function admitImmutableObjectRef(input: ImmutableObjectRef): ImmutableObjectRef {
  if (!isRecord(input)) throw new TypeError('Immutable object reference must be an object');
  const objectRef = requireIdentifier(
    input.objectRef,
    'Immutable object reference',
    MAX_OBJECT_REF_LENGTH,
  );
  if (!isSha256Digest(input.digest)) throw new TypeError('Immutable object digest must be SHA-256');
  if (!isByteCount(input.bytes)) {
    throw new TypeError('Immutable object byte count must be a non-negative safe integer');
  }
  return immutableObjectRef({
    objectRef,
    digest: input.digest,
    bytes: input.bytes,
    mediaType: requireIdentifier(input.mediaType, 'Immutable object media type'),
  });
}

function admitSessionCheckpointManifestV1(
  input: SessionCheckpointManifestV1,
): SessionCheckpointManifestV1 {
  if (!isRecord(input)) throw new TypeError('Session checkpoint Manifest must be an object');
  if (input.schemaVersion !== 1) {
    throw new TypeError('Session checkpoint Manifest schema version must be 1');
  }
  return createSessionCheckpointManifestV1(input.compatibilityBundle);
}

function admitStoredSessionCheckpoint(input: StoredSessionCheckpoint): StoredSessionCheckpoint {
  if (!isRecord(input)) throw new TypeError('Stored Session checkpoint must be an object');
  const manifest = admitImmutableObjectRef(input.manifest);
  const value = admitSessionCheckpointManifestV1(input.value);
  if (manifest.mediaType !== SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE) {
    throw new TypeError('Session checkpoint Manifest has an unsupported media type');
  }
  const encoded = encodeSessionCheckpointManifestV1(value);
  if (manifest.digest !== digestBytes(encoded) || manifest.bytes !== encoded.byteLength) {
    throw repositoryError(
      'integrity_mismatch',
      'Session checkpoint Manifest value does not match its immutable reference',
    );
  }
  return storedSessionCheckpoint({ manifest, value });
}

function admitCommitSessionRevisionInput(
  input: CommitSessionRevisionInput,
): InternalCommitSessionRevisionInput {
  if (!isRecord(input)) throw new TypeError('Session commit input must be an object');
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, 'Session identity'),
    expectedRevision: requireIdentifier(input.expectedRevision, 'Expected revision'),
    checkpoint: admitStoredSessionCheckpoint(input.checkpoint),
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
  });
}

function admitCreateSessionInput(input: CreateSessionInput): InternalCreateSessionInput {
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
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, 'Session identity'),
    agentId: requireIdentifier(input.agentId, 'Agent identity'),
    checkpoint: admitStoredSessionCheckpoint(input.checkpoint),
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
  });
}

function admitClaimForkInput(input: ClaimForkInput): InternalClaimForkInput {
  if (!isRecord(input)) throw new TypeError('Fork claim input must be an object');
  return Object.freeze({
    forkId: requireIdentifier(input.forkId, 'Fork identity'),
    source: admitRevisionRef(input.source, 'Fork source'),
    targetSessionId: requireIdentifier(input.targetSessionId, 'Fork target Session identity'),
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
  readonly revision: SessionRepositoryRevision;
  readonly agentId: string;
  readonly checkpoint: StoredSessionCheckpoint;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
}): CommittedSessionRevision {
  return Object.freeze({
    ref: copyRevisionRef({ sessionId: input.sessionId, revision: input.revision }),
    agentId: input.agentId,
    checkpoint: copyStoredSessionCheckpoint(input.checkpoint),
    ...(input.lastCommittedActivationId === undefined
      ? {}
      : { lastCommittedActivationId: input.lastCommittedActivationId }),
    ...(input.forkedFrom === undefined ? {} : { forkedFrom: copyRevisionRef(input.forkedFrom) }),
  });
}

function immutableObjectRef(input: ImmutableObjectRef): ImmutableObjectRef {
  return Object.freeze({
    objectRef: input.objectRef,
    digest: input.digest,
    bytes: input.bytes,
    mediaType: input.mediaType,
  });
}

function copyImmutableObjectRef(input: ImmutableObjectRef): ImmutableObjectRef {
  return immutableObjectRef(input);
}

function storedSessionCheckpoint(input: StoredSessionCheckpoint): StoredSessionCheckpoint {
  return Object.freeze({
    manifest: copyImmutableObjectRef(input.manifest),
    value: Object.freeze({
      schemaVersion: 1,
      compatibilityBundle: copyImmutableObjectRef(input.value.compatibilityBundle),
    }),
  });
}

function copyStoredSessionCheckpoint(input: StoredSessionCheckpoint): StoredSessionCheckpoint {
  return storedSessionCheckpoint(input);
}

function copyRevisionRef(input: SessionRevisionRef): SessionRevisionRef {
  return Object.freeze({ sessionId: input.sessionId, revision: input.revision });
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

function copyForkOperation(input: InternalForkOperation): ForkOperation {
  if (input.state === 'pending') {
    return Object.freeze({
      state: 'pending',
      forkId: input.forkId,
      source: copyRevisionRef(input.source),
      sourceAgentId: input.sourceAgentId,
      sourceCheckpoint: copyStoredSessionCheckpoint(input.sourceCheckpoint),
      targetSessionId: input.targetSessionId,
    });
  }
  return copyCompletedForkOperation(input);
}

function copyCompletedForkOperation(input: InternalCompletedForkOperation): CompletedForkOperation {
  return Object.freeze({
    state: 'completed',
    forkId: input.forkId,
    source: copyRevisionRef(input.source),
    sourceAgentId: input.sourceAgentId,
    sourceCheckpoint: copyStoredSessionCheckpoint(input.sourceCheckpoint),
    targetSessionId: input.targetSessionId,
    target: copyRevisionRef(input.target),
  });
}

function sameImmutableObjectRef(left: ImmutableObjectRef, right: ImmutableObjectRef): boolean {
  return (
    left.objectRef === right.objectRef &&
    left.digest === right.digest &&
    left.bytes === right.bytes &&
    left.mediaType === right.mediaType
  );
}

function sameSessionCheckpointManifestV1(
  left: SessionCheckpointManifestV1,
  right: SessionCheckpointManifestV1,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    sameImmutableObjectRef(left.compatibilityBundle, right.compatibilityBundle)
  );
}

function sameStoredSessionCheckpoint(
  left: StoredSessionCheckpoint,
  right: StoredSessionCheckpoint,
): boolean {
  return (
    sameImmutableObjectRef(left.manifest, right.manifest) &&
    sameSessionCheckpointManifestV1(left.value, right.value)
  );
}

function sameRevisionRef(left: SessionRevisionRef, right: SessionRevisionRef): boolean {
  return left.sessionId === right.sessionId && left.revision === right.revision;
}

function sameCommitInput(
  left: InternalCommitSessionRevisionInput,
  right: InternalCommitSessionRevisionInput,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.expectedRevision === right.expectedRevision &&
    sameStoredSessionCheckpoint(left.checkpoint, right.checkpoint) &&
    left.lastCommittedActivationId === right.lastCommittedActivationId &&
    left.commitId === right.commitId
  );
}

function sameCreateInput(
  created: CommittedSessionRevision,
  agentId: string,
  forkedFrom: SessionRevisionRef | undefined,
  input: InternalCreateSessionInput,
): boolean {
  return (
    created.agentId === agentId &&
    created.agentId === input.agentId &&
    sameStoredSessionCheckpoint(created.checkpoint, input.checkpoint) &&
    created.lastCommittedActivationId === input.lastCommittedActivationId &&
    sameOptionalRevisionRef(forkedFrom, input.forkedFrom)
  );
}

function sameOptionalRevisionRef(
  left: SessionRevisionRef | undefined,
  right: SessionRevisionRef | undefined,
): boolean {
  return left === undefined || right === undefined ? left === right : sameRevisionRef(left, right);
}

function sameForkClaim(operation: InternalForkOperation, input: InternalClaimForkInput): boolean {
  return (
    operation.targetSessionId === input.targetSessionId &&
    sameRevisionRef(operation.source, input.source)
  );
}

function nextRevision(session: SessionState): SessionRepositoryRevision {
  const revision = `r${session.nextRevisionNumber}`;
  session.nextRevisionNumber += 1;
  return revision;
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

function requireImmutableObjectStore(value: unknown): ImmutableObjectStore {
  if (
    !isRecord(value) ||
    typeof value.publish !== 'function' ||
    typeof value.assertReadable !== 'function'
  ) {
    throw new TypeError('Immutable Object Store must implement publish and assertReadable');
  }
  return value as unknown as ImmutableObjectStore;
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeObjectStoreError(error: unknown): SessionRepositoryError {
  if (error instanceof SessionRepositoryError) return error;
  return repositoryError('io_failure', 'Immutable Object Store operation failed', error);
}

function repositoryError(
  code: SessionRepositoryErrorCode,
  message: string,
  cause?: unknown,
): SessionRepositoryError {
  return new SessionRepositoryError(code, message, cause === undefined ? {} : { cause });
}
