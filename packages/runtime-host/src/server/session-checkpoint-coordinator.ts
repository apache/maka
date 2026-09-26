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

import { randomUUID } from 'node:crypto';
import {
  publishSessionCheckpointV1,
  SessionRepositoryError,
  type SessionRepository,
  type ImmutableObjectStore,
  type CommittedSessionRevision,
} from '@maka/storage/session-repository';
import type {
  SessionCheckpointBinding,
  SessionCheckpointPublicationStore,
  CheckpointPublicationRequest,
} from '@maka/storage/session-checkpoint-publication-store';
import type { ProductionSessionBundleArtifact } from '@maka/storage/production-session-snapshot';
import { SessionSnapshotError } from '@maka/storage/quiescent-session-snapshot';

export type HostCheckpointErrorCode =
  | 'invalid_input'
  | 'unsupported'
  | 'busy'
  | 'conflict'
  | 'cancelled'
  | 'interrupted'
  | 'closed'
  | 'publication_failed';

export class HostCheckpointError extends Error {
  constructor(
    readonly code: HostCheckpointErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'HostCheckpointError';
  }
}
export interface PublishHostSessionCheckpointInput {
  readonly sessionId: string;
  /** Stable caller identity. A new snapshot requires a new request identity. */
  readonly requestId: string;
  readonly confirmationGrantId?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}
export interface PublishedHostSessionCheckpoint {
  readonly requestId: string;
  readonly binding: SessionCheckpointBinding;
  readonly committed: CommittedSessionRevision;
  readonly stagingCleanup: 'released' | 'pending_recovery';
  readonly bundleCleanup: 'released' | 'pending_recovery';
}
export interface HostSessionCheckpointPublication {
  publish(input: PublishHostSessionCheckpointInput): Promise<PublishedHostSessionCheckpoint>;
  beginDrain(): void;
  close(): Promise<void>;
}
export interface HostSessionCheckpointCoordinatorDependencies {
  readonly journal: SessionCheckpointPublicationStore;
  readonly repository: SessionRepository;
  readonly objects: ImmutableObjectStore;
  /** Enforces the Host admission and selected-provider snapshot boundary. */
  capture(input: {
    readonly binding: SessionCheckpointBinding;
    readonly commitId: string;
    readonly confirmationGrantId?: string;
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
  }): Promise<ProductionSessionBundleArtifact>;
  cleanupBundle(commitId: string): Promise<void>;
  /** Holds the authenticated root lease and an execution residency until settlement. */
  runAuthorized<T>(operation: () => Promise<T>): Promise<T>;
}

/** Explicit management API, not a model tool, automatic live write, or second Head. */
export class HostSessionCheckpointCoordinator implements HostSessionCheckpointPublication {
  readonly #active = new Set<Promise<unknown>>();
  readonly #drain = new AbortController();
  #closed = false;

  constructor(private readonly dependencies: HostSessionCheckpointCoordinatorDependencies) {}

  publish(input: PublishHostSessionCheckpointInput): Promise<PublishedHostSessionCheckpoint> {
    if (this.#closed)
      return Promise.reject(new HostCheckpointError('closed', 'Checkpoint publication is closed'));
    const accepted = { ...input };
    if (
      !validId(accepted.sessionId) ||
      !validId(accepted.requestId) ||
      (accepted.signal !== undefined && !(accepted.signal instanceof AbortSignal)) ||
      (accepted.confirmationGrantId !== undefined &&
        !/^[A-Za-z0-9_-]{1,128}$/u.test(accepted.confirmationGrantId)) ||
      (accepted.deadlineAt !== undefined && !Number.isSafeInteger(accepted.deadlineAt))
    ) {
      return Promise.reject(
        new HostCheckpointError('invalid_input', 'Invalid checkpoint publication request'),
      );
    }
    // Cooperative deadline for the whole attempt, not part of commit identity.
    const deadlineAt = Math.min(accepted.deadlineAt ?? Infinity, Date.now() + 60_000);
    if (deadlineAt <= Date.now())
      return Promise.reject(
        new HostCheckpointError('cancelled', 'Checkpoint deadline has expired'),
      );
    const timer = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
    const signal = AbortSignal.any([
      timer,
      this.#drain.signal,
      ...(accepted.signal ? [accepted.signal] : []),
    ]);
    const task = this.dependencies
      .runAuthorized(() => this.#publish(accepted, signal, deadlineAt))
      .catch((error: unknown) => {
        throw normalizeError(error);
      });
    this.#active.add(task);
    void task.finally(() => this.#active.delete(task)).catch(() => {});
    return task;
  }

  beginDrain(): void {
    this.#closed = true;
    this.#drain.abort();
  }
  async close(): Promise<void> {
    this.beginDrain();
    await Promise.allSettled([...this.#active]);
  }

  async #publish(
    input: PublishHostSessionCheckpointInput,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<PublishedHostSessionCheckpoint> {
    const deps = this.dependencies;
    signal.throwIfAborted();
    return deps.journal.withSession(input.sessionId, async (document, save) => {
      signal.throwIfAborted();
      const releaseBundle = async (position: number): Promise<'released' | 'pending_recovery'> => {
        const pending = document.requests[position]!;
        if (!pending.bundleCleanupPending) return 'released';
        try {
          await deps.cleanupBundle(pending.commitId);
          const { bundleCleanupPending: _pending, ...released } = pending;
          document.requests[position] = released;
          try {
            await save();
          } catch (error) {
            document.requests[position] = pending;
            throw error;
          }
          return 'released';
        } catch {
          // The terminal outcome is already durable. Retain cleanup ownership
          // for the next request/restart, without changing that outcome.
          return 'pending_recovery';
        }
      };
      let index = document.requests.findIndex((request) => request.requestId === input.requestId);
      let request = document.requests[index];
      if (request && request.confirmationGrantId !== input.confirmationGrantId) {
        throw new HostCheckpointError(
          'conflict',
          'Checkpoint request identity was reused with different input',
        );
      }
      // Holding this process-safe lock proves no earlier capture is still running.
      // Its bytes were never durably fixed, so the identity can only be aborted.
      for (let position = 0; position < document.requests.length; position++) {
        const previous = document.requests[position]!;
        if (previous.phase === 'capturing') {
          document.requests[position] = { ...previous, phase: 'aborted' };
          await save();
        }
        if (previous.phase !== 'prepared') await releaseBundle(position);
      }
      request = document.requests[index];
      if (request?.phase === 'aborted') {
        throw new HostCheckpointError(
          'interrupted',
          'Snapshot capture did not complete; use a new request identity',
        );
      }
      if (request?.phase === 'conflicted')
        throw new HostCheckpointError('conflict', 'Checkpoint publication previously conflicted');
      if (!request) {
        if (document.requests.some((record) => record.phase === 'prepared')) {
          throw new HostCheckpointError(
            'busy',
            'A prepared checkpoint must be reconciled using its original request identity',
          );
        }
        let current: CommittedSessionRevision | undefined;
        try {
          current = await deps.repository.checkoutCurrent(document.binding.repositorySessionId);
        } catch (error) {
          if (!(error instanceof SessionRepositoryError) || error.code !== 'session_not_found')
            throw error;
        }
        if (current && current.agentId !== document.binding.agentId) {
          throw new HostCheckpointError(
            'conflict',
            'Repository Session binding does not match this Host',
          );
        }
        request = {
          requestId: input.requestId,
          commitId: randomUUID(),
          ...(input.confirmationGrantId ? { confirmationGrantId: input.confirmationGrantId } : {}),
          expectedRevision: current?.ref.revision ?? null,
          bundleCleanupPending: true,
          phase: 'capturing',
        };
        index = document.requests.length;
        document.requests.push(request);
        await save();
        signal.throwIfAborted();
        const artifact = await deps.capture({
          binding: document.binding,
          commitId: request.commitId,
          confirmationGrantId: input.confirmationGrantId,
          signal,
          deadlineAt,
        });
        signal.throwIfAborted();
        const checkpoint = await publishSessionCheckpointV1({
          objectStore: deps.objects,
          compatibilityBundle: artifact,
        });
        request = {
          ...request,
          phase: 'prepared',
          checkpoint,
          ...(artifact.snapshotCleanup.state === 'pending_recovery'
            ? { snapshotCleanupPending: true as const }
            : {}),
        };
        document.requests[index] = request;
        // On an uncertain journal write, leave recovery to a fresh read. Never
        // overwrite a possibly prepared record with a fabricated failure.
        await save();
      }
      if (request.phase === 'committed') {
        await deps.objects.assertReadable(request.checkpoint.manifest);
        await deps.objects.assertReadable(request.checkpoint.value.compatibilityBundle);
        return structuredClone({
          requestId: request.requestId,
          binding: document.binding,
          committed: request.result,
          stagingCleanup: request.snapshotCleanupPending ? 'pending_recovery' : 'released',
          bundleCleanup: request.bundleCleanupPending ? 'pending_recovery' : 'released',
        });
      }
      if (request.phase !== 'prepared')
        throw new Error('Invalid checkpoint publication transition');
      signal.throwIfAborted();
      // No cancellation point between CAS and receipt persistence: after CAS
      // succeeds, reporting cancellation would falsely suggest nothing committed.
      let committed: CommittedSessionRevision;
      try {
        committed =
          request.expectedRevision === null
            ? await deps.repository
                .createSession({
                  sessionId: document.binding.repositorySessionId,
                  agentId: document.binding.agentId,
                  checkpoint: request.checkpoint,
                })
                .catch(async (error: unknown) => {
                  if (
                    !(error instanceof SessionRepositoryError) ||
                    error.code !== 'session_already_exists'
                  )
                    throw error;
                  const existing = await deps.repository.checkoutCurrent(
                    document.binding.repositorySessionId,
                  );
                  if (
                    existing.agentId !== document.binding.agentId ||
                    existing.forkedFrom !== undefined ||
                    existing.lastCommittedActivationId !== undefined ||
                    JSON.stringify(existing.checkpoint) !== JSON.stringify(request.checkpoint)
                  )
                    throw error;
                  return existing;
                })
            : await deps.repository.commit({
                sessionId: document.binding.repositorySessionId,
                expectedRevision: request.expectedRevision,
                checkpoint: request.checkpoint,
                commitId: request.commitId,
              });
      } catch (error) {
        if (
          error instanceof SessionRepositoryError &&
          ['revision_conflict', 'session_already_exists', 'idempotency_conflict'].includes(
            error.code,
          )
        ) {
          document.requests[index] = { ...request, phase: 'conflicted' };
          await save();
          await releaseBundle(index);
        }
        throw error;
      }
      const completed: CheckpointPublicationRequest = {
        ...request,
        phase: 'committed',
        result: committed,
      };
      document.requests[index] = completed;
      await save();
      const bundleCleanup = await releaseBundle(index);
      return structuredClone({
        requestId: request.requestId,
        binding: document.binding,
        committed,
        stagingCleanup: request.snapshotCleanupPending ? 'pending_recovery' : 'released',
        bundleCleanup,
      });
    });
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function normalizeError(error: unknown): HostCheckpointError {
  if (error instanceof HostCheckpointError) return error;
  // The generic snapshot layer wraps Host eligibility failures. Preserve their
  // bounded public classification without exposing arbitrary provider errors.
  if (error instanceof SessionSnapshotError && error.cause instanceof HostCheckpointError)
    return error.cause;
  if (error instanceof SessionRepositoryError) {
    const code = ['revision_conflict', 'session_already_exists', 'idempotency_conflict'].includes(
      error.code,
    )
      ? 'conflict'
      : 'publication_failed';
    return new HostCheckpointError(code, 'Checkpoint Repository rejected publication', {
      cause: error,
    });
  }
  if (error instanceof SessionSnapshotError) {
    if (error.code === 'snapshot_busy' || error.code === 'session_not_quiescent') {
      return new HostCheckpointError('busy', 'Session is not quiescent', { cause: error });
    }
  }
  if (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof SessionSnapshotError && error.code === 'snapshot_cancelled')
  ) {
    return new HostCheckpointError('cancelled', 'Checkpoint publication attempt was cancelled', {
      cause: error,
    });
  }
  return new HostCheckpointError(
    'publication_failed',
    'Checkpoint publication failed; retry the same request to reconcile',
    { cause: error },
  );
}
