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
const MAX_BUNDLE_REF_LENGTH = 2_048;

/**
 * A Repository revision is opaque to callers. Revisions are scoped to one
 * Cloud Session and must never be reused as Bundle digests or across Sessions.
 */
export type SessionRepositoryRevision = string;

export interface SessionRevisionRef {
  readonly sessionId: string;
  readonly revision: SessionRepositoryRevision;
}

/**
 * Trusted immutable-object metadata. `bundleRef` is resolved only through the
 * Repository's configured Bundle Blob Store; it is not a local archive path.
 */
export interface StoredSessionBundle {
  readonly bundleRef: string;
  readonly archiveDigest: Sha256Digest;
  readonly compressedBytes: number;
}

export interface CommittedSessionRevision {
  readonly ref: SessionRevisionRef;
  readonly agentId: string;
  readonly bundle: StoredSessionBundle;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
}

export interface CommitSessionRevisionInput {
  readonly sessionId: string;
  readonly expectedRevision: SessionRepositoryRevision;
  readonly bundle: StoredSessionBundle;
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
  readonly bundle: StoredSessionBundle;
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
 * The Repository stores Session metadata and head CAS state. The Blob Store
 * owns immutable Bundle bytes. Keeping these ports separate lets a future
 * control plane choose an object store without weakening Repository semantics.
 */
export interface SessionBundleBlobStore {
  /**
   * Writes archive bytes under a non-overwritable reference. It may return an
   * existing reference for the identical content, but must not return until the
   * exact bytes and declared digest are durably readable.
   */
  publish(input: SessionBundleArtifact): Promise<StoredSessionBundle>;
  /**
   * Verifies that this exact immutable reference remains readable with its
   * declared byte count and archive digest. Missing or changed bytes must fail
   * with a bounded Repository error rather than substituting another object.
   */
  assertReadable(bundle: StoredSessionBundle): Promise<void>;
}

export interface SessionRepository {
  readonly forkIdempotencyRetention: ForkIdempotencyRetention;
  checkoutExact(ref: SessionRevisionRef): Promise<CommittedSessionRevision>;
  publishBundle(input: SessionBundleArtifact): Promise<StoredSessionBundle>;
  commit(input: CommitSessionRevisionInput): Promise<CommittedSessionRevision>;
  createSession(input: CreateSessionInput): Promise<CommittedSessionRevision>;
  claimFork(input: ClaimForkInput): Promise<ForkOperation>;
  completeFork(input: CompleteForkInput): Promise<CompletedForkOperation>;
}

export type SessionRepositoryErrorCode =
  | 'session_not_found'
  | 'revision_not_available'
  | 'revision_conflict'
  | 'session_already_exists'
  | 'idempotency_conflict'
  | 'bundle_not_found'
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

export interface CreateInMemorySessionRepositoryOptions {
  /** Defaults to an immutable in-memory Blob Store that verifies archive bytes. */
  readonly bundleStore?: SessionBundleBlobStore;
}

/**
 * Deterministic conformance implementation for coordinators and Fork tests.
 * It models the V1 single-current-head retention policy, but it is not a
 * durable control-plane backend.
 */
export function createInMemorySessionRepository(
  options: CreateInMemorySessionRepositoryOptions = {},
): SessionRepository {
  return new InMemorySessionRepository(options.bundleStore ?? new InMemorySessionBundleBlobStore());
}

class InMemorySessionRepository implements SessionRepository {
  readonly forkIdempotencyRetention = 'indefinite' as const;

  private readonly sessions = new Map<string, SessionState>();
  private readonly commitsBySession = new Map<string, Map<string, CommitRecord>>();
  private readonly forks = new Map<string, InternalForkOperation>();

  constructor(private readonly bundleStore: SessionBundleBlobStore) {}

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

    // Capture the exact record before the asynchronous Blob read. A later head
    // advance may make this revision non-current, but cannot substitute bytes.
    const committed = copyCommittedSessionRevision(session.head);
    await this.assertBundleReadable(committed.bundle);
    return committed;
  }

  async publishBundle(input: SessionBundleArtifact): Promise<StoredSessionBundle> {
    const artifact = admitSessionBundleArtifact(input);
    try {
      const published = admitStoredSessionBundle(await this.bundleStore.publish(artifact));
      if (
        published.archiveDigest !== artifact.archiveDigest ||
        published.compressedBytes !== artifact.compressedBytes
      ) {
        throw repositoryError(
          'integrity_mismatch',
          'Published Bundle metadata does not match archive',
        );
      }
      await this.assertBundleReadable(published);
      return published;
    } catch (error) {
      throw normalizeBlobStoreError(error);
    }
  }

  async commit(input: CommitSessionRevisionInput): Promise<CommittedSessionRevision> {
    const admitted = admitCommitSessionRevisionInput(input);
    const prior = this.priorCommit(admitted);
    if (prior) {
      if (!sameCommitInput(prior.input, admitted)) {
        throw repositoryError(
          'idempotency_conflict',
          'Commit identity was reused with different input',
        );
      }
      return copyCommittedSessionRevision(prior.result);
    }

    const initial = this.sessions.get(admitted.sessionId);
    if (!initial) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (initial.head.ref.revision !== admitted.expectedRevision) {
      throw repositoryError('revision_conflict', 'Cloud Session head changed before commit');
    }

    await this.assertBundleReadable(admitted.bundle);

    // Blob verification may yield. Recheck the linearization precondition after
    // it returns so a concurrent commit cannot be overwritten.
    const session = this.sessions.get(admitted.sessionId);
    if (!session) throw repositoryError('session_not_found', 'Cloud Session was not found');
    if (session.head.ref.revision !== admitted.expectedRevision) {
      throw repositoryError('revision_conflict', 'Cloud Session head changed before commit');
    }

    const result = committedRevision({
      sessionId: admitted.sessionId,
      revision: nextRevision(session),
      agentId: session.agentId,
      bundle: admitted.bundle,
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
    if (existing) return this.reconcileExistingSessionCreate(existing, admitted);

    await this.assertBundleReadable(admitted.bundle);

    // Blob verification may yield. Create-if-absent is therefore decided only
    // after it returns, at this method's synchronous linearization point.
    const afterVerification = this.sessions.get(admitted.sessionId);
    if (afterVerification) return this.reconcileExistingSessionCreate(afterVerification, admitted);

    if (admitted.createdByForkId !== undefined) this.assertPendingForkCreate(admitted);
    const initial = committedRevision({
      sessionId: admitted.sessionId,
      revision: 'r1',
      agentId: admitted.agentId,
      bundle: admitted.bundle,
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
    const pending: InternalPendingForkOperation = {
      state: 'pending',
      forkId: admitted.forkId,
      source: admitted.source,
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
    if (
      target.createdByForkId !== operation.forkId ||
      !target.forkedFrom ||
      !sameRevisionRef(target.forkedFrom, operation.source)
    ) {
      throw repositoryError('idempotency_conflict', 'Fork target was created by another operation');
    }

    const completed: InternalCompletedForkOperation = {
      ...operation,
      state: 'completed',
      target: copyRevisionRef(target.createdRevision.ref),
    };
    this.forks.set(forkId, completed);
    return copyCompletedForkOperation(completed);
  }

  private priorCommit(input: InternalCommitSessionRevisionInput): CommitRecord | undefined {
    if (input.commitId === undefined) return undefined;
    return this.commitsBySession.get(input.sessionId)?.get(input.commitId);
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
  }

  private async assertBundleReadable(bundle: StoredSessionBundle): Promise<void> {
    try {
      await this.bundleStore.assertReadable(bundle);
    } catch (error) {
      throw normalizeBlobStoreError(error);
    }
  }
}

class InMemorySessionBundleBlobStore implements SessionBundleBlobStore {
  private readonly blobs = new Map<string, InMemoryBlob>();

  async publish(input: SessionBundleArtifact): Promise<StoredSessionBundle> {
    const artifact = admitSessionBundleArtifact(input);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(artifact.path);
    } catch (error) {
      throw repositoryError('io_failure', 'Bundle publication could not read archive bytes', error);
    }
    const digest = digestBytes(bytes);
    if (digest !== artifact.archiveDigest || bytes.byteLength !== artifact.compressedBytes) {
      throw repositoryError(
        'integrity_mismatch',
        'Bundle archive bytes do not match declared metadata',
      );
    }

    const stored = storedSessionBundle({
      bundleRef: `memory://session-bundles/${artifact.archiveDigest.slice('sha256:'.length)}`,
      archiveDigest: artifact.archiveDigest,
      compressedBytes: artifact.compressedBytes,
    });
    const existing = this.blobs.get(stored.bundleRef);
    if (existing) {
      if (!sameBytes(existing.bytes, bytes) || !sameStoredSessionBundle(existing.bundle, stored)) {
        throw repositoryError(
          'integrity_mismatch',
          'Immutable Bundle reference already contains other bytes',
        );
      }
      return copyStoredSessionBundle(existing.bundle);
    }
    this.blobs.set(stored.bundleRef, { bundle: stored, bytes: Uint8Array.from(bytes) });
    return copyStoredSessionBundle(stored);
  }

  async assertReadable(input: StoredSessionBundle): Promise<void> {
    const bundle = admitStoredSessionBundle(input);
    const blob = this.blobs.get(bundle.bundleRef);
    if (!blob) throw repositoryError('bundle_not_found', 'Published Bundle was not found');
    if (
      !sameStoredSessionBundle(blob.bundle, bundle) ||
      digestBytes(blob.bytes) !== bundle.archiveDigest
    ) {
      throw repositoryError(
        'integrity_mismatch',
        'Published Bundle bytes no longer match metadata',
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

interface InMemoryBlob {
  readonly bundle: StoredSessionBundle;
  readonly bytes: Uint8Array;
}

interface InternalCommitSessionRevisionInput {
  readonly sessionId: string;
  readonly expectedRevision: SessionRepositoryRevision;
  readonly bundle: StoredSessionBundle;
  readonly lastCommittedActivationId?: string;
  readonly commitId?: string;
}

interface InternalCreateSessionInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly bundle: StoredSessionBundle;
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

function admitSessionBundleArtifact(input: SessionBundleArtifact): SessionBundleArtifact {
  if (!isRecord(input)) throw new TypeError('Session Bundle artifact must be an object');
  const path = requireIdentifier(input.path, 'Bundle archive path', MAX_BUNDLE_REF_LENGTH);
  if (!isSha256Digest(input.archiveDigest))
    throw new TypeError('Bundle archive digest must be SHA-256');
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

function admitStoredSessionBundle(input: StoredSessionBundle): StoredSessionBundle {
  if (!isRecord(input)) throw new TypeError('Stored Session Bundle must be an object');
  const bundleRef = requireIdentifier(input.bundleRef, 'Bundle reference', MAX_BUNDLE_REF_LENGTH);
  if (!isSha256Digest(input.archiveDigest))
    throw new TypeError('Bundle archive digest must be SHA-256');
  if (!isByteCount(input.compressedBytes)) {
    throw new TypeError('Bundle compressed byte count must be a non-negative safe integer');
  }
  return storedSessionBundle({
    bundleRef,
    archiveDigest: input.archiveDigest,
    compressedBytes: input.compressedBytes,
  });
}

function admitCommitSessionRevisionInput(
  input: CommitSessionRevisionInput,
): InternalCommitSessionRevisionInput {
  if (!isRecord(input)) throw new TypeError('Session commit input must be an object');
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, 'Session identity'),
    expectedRevision: requireIdentifier(input.expectedRevision, 'Expected revision'),
    bundle: admitStoredSessionBundle(input.bundle),
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
  return Object.freeze({
    sessionId: requireIdentifier(input.sessionId, 'Session identity'),
    agentId: requireIdentifier(input.agentId, 'Agent identity'),
    bundle: admitStoredSessionBundle(input.bundle),
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
  readonly bundle: StoredSessionBundle;
  readonly lastCommittedActivationId?: string;
  readonly forkedFrom?: SessionRevisionRef;
}): CommittedSessionRevision {
  return Object.freeze({
    ref: copyRevisionRef({ sessionId: input.sessionId, revision: input.revision }),
    agentId: input.agentId,
    bundle: copyStoredSessionBundle(input.bundle),
    ...(input.lastCommittedActivationId === undefined
      ? {}
      : { lastCommittedActivationId: input.lastCommittedActivationId }),
    ...(input.forkedFrom === undefined ? {} : { forkedFrom: copyRevisionRef(input.forkedFrom) }),
  });
}

function storedSessionBundle(input: StoredSessionBundle): StoredSessionBundle {
  return Object.freeze({
    bundleRef: input.bundleRef,
    archiveDigest: input.archiveDigest,
    compressedBytes: input.compressedBytes,
  });
}

function copyStoredSessionBundle(input: StoredSessionBundle): StoredSessionBundle {
  return storedSessionBundle(input);
}

function copyRevisionRef(input: SessionRevisionRef): SessionRevisionRef {
  return Object.freeze({ sessionId: input.sessionId, revision: input.revision });
}

function copyCommittedSessionRevision(input: CommittedSessionRevision): CommittedSessionRevision {
  return committedRevision({
    sessionId: input.ref.sessionId,
    revision: input.ref.revision,
    agentId: input.agentId,
    bundle: input.bundle,
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
      targetSessionId: input.targetSessionId,
    });
  }
  return Object.freeze({
    state: 'completed',
    forkId: input.forkId,
    source: copyRevisionRef(input.source),
    targetSessionId: input.targetSessionId,
    target: copyRevisionRef(input.target),
  });
}

function copyCompletedForkOperation(input: InternalCompletedForkOperation): CompletedForkOperation {
  return Object.freeze({
    state: 'completed',
    forkId: input.forkId,
    source: copyRevisionRef(input.source),
    targetSessionId: input.targetSessionId,
    target: copyRevisionRef(input.target),
  });
}

function sameStoredSessionBundle(left: StoredSessionBundle, right: StoredSessionBundle): boolean {
  return (
    left.bundleRef === right.bundleRef &&
    left.archiveDigest === right.archiveDigest &&
    left.compressedBytes === right.compressedBytes
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
    sameStoredSessionBundle(left.bundle, right.bundle) &&
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
    sameStoredSessionBundle(created.bundle, input.bundle) &&
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

function normalizeBlobStoreError(error: unknown): SessionRepositoryError {
  if (error instanceof SessionRepositoryError) return error;
  return repositoryError('io_failure', 'Bundle Blob Store operation failed', error);
}

function repositoryError(
  code: SessionRepositoryErrorCode,
  message: string,
  cause?: unknown,
): SessionRepositoryError {
  return new SessionRepositoryError(code, message, cause === undefined ? {} : { cause });
}
