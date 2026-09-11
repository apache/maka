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

import { exportSessionBundle } from '@maka/runtime/session-export';
import { importSessionBundle } from '@maka/runtime/session-import';
import { createHash } from 'node:crypto';
import { SessionQuiescentMutationBusyError } from '@maka/runtime/runtime-kernel';
import { SessionConfigurationTransitionError } from '@maka/runtime/session-manager';
import { runWithStorageRootLease, type StorageRootLease } from '@maka/storage/root-authority';
import type { SessionBundleOperationHandlerMap } from './operation-dispatcher.js';
import type { OperationOutcome } from '../protocol/operations.js';

export interface HostSessionBundleCoordinatorOptions {
  /**
   * The authority this Host took at startup.
   *
   * A bundle is prepared and accepted under it rather than by electing a new
   * owner: the owner lock is an election taken with `tryLock`, and it refuses a
   * second exclusive hold even inside the process that already has one. So the
   * Host cannot reach these operations by calling them -- it can only lend what
   * it holds, which is what lets the app offer this while it is running.
   */
  readonly lease: StorageRootLease<'interactive', 'write'>;
  /**
   * Fences the named Sessions for the duration.
   *
   * Refuses while any of them has an active execution claim and serialises
   * against other Session mutations, so no Turn starts while a bundle is being
   * prepared. This is not the same check the export makes on its own private
   * copy: that one catches state already in flight, this one stops new state
   * from arriving.
   */
  readonly fenceSubtree: <T>(
    sessionId: string,
    operation: (fencedSessionIds: readonly string[]) => Promise<T>,
  ) => Promise<T>;
  /**
   * Republish the catalog so imported Sessions appear without a reload.
   *
   * The ROOT only, not every Session. One frame per id is a queue as long as
   * the subtree, and the writer's is bounded: a large enough import fills it
   * after the rows are committed and the connection closes before the success
   * response ever leaves -- the caller is told the import failed while all of
   * it landed. One invalidation is what a client needs to re-read anyway.
   */
  readonly onImported: (rootSessionId: string) => void;
}

export class HostSessionBundleCoordinator {
  readonly handlers: SessionBundleOperationHandlerMap = {
    'session-bundle.export': (input) => this.export(input),
    'session-bundle.import': (input) => this.import(input),
  };

  readonly #options: HostSessionBundleCoordinatorOptions;

  constructor(options: HostSessionBundleCoordinatorOptions) {
    this.#options = options;
  }

  async export(input: {
    readonly sessionId: string;
    readonly destination: string;
    readonly expectedSubtreeDigest?: string;
  }): Promise<OperationOutcome<'session-bundle.export'>> {
    const workspaceRoot = this.#options.lease.canonicalPath;
    // The fence refuses a running subtree by throwing, and an exception that
    // leaves here is reported as `internal_failure` -- the one code that says
    // "something is broken" about the one outcome that is expected.
    return this.#fenced(input.sessionId, async (fencedSessionIds) => {
      // What the caller confirmed against what is actually here. A child that
      // finished between the two would otherwise land in the file without
      // anybody having been asked about it, and a digest says that for a
      // membership change as well as a size change.
      const fencedDigest = subtreeDigest(fencedSessionIds);
      if (
        input.expectedSubtreeDigest !== undefined &&
        input.expectedSubtreeDigest !== fencedDigest
      ) {
        return {
          ok: false,
          error: {
            code: 'candidate_set_stale',
            message: 'The subtree changed after it was confirmed',
          },
        };
      }
      const result = await runWithStorageRootLease(
        this.#options.lease,
        'interactive',
        'write',
        () =>
          exportSessionBundle({
            workspaceRoot,
            sessionId: input.sessionId,
            destination: input.destination,
            lease: this.#options.lease,
          }),
      );
      if (!result.ok) return { ok: false, error: exportFailure(result.reason) };
      return {
        ok: true,
        result: {
          sessionCount: result.export.sessionIds.length,
          compressedBytes: result.artifact.compressedBytes,
        },
      };
    });
  }

  async #fenced(
    sessionId: string,
    operation: (
      fencedSessionIds: readonly string[],
    ) => Promise<OperationOutcome<'session-bundle.export'>>,
  ): Promise<OperationOutcome<'session-bundle.export'>> {
    try {
      return await this.#options.fenceSubtree(sessionId, operation);
    } catch (error) {
      // Two types, because the Session manager translates on the way out: the
      // kernel raises `SessionQuiescentMutationBusyError` and the manager
      // re-throws it as a configuration transition. Catching only the first is
      // catching the one production never delivers.
      if (
        error instanceof SessionQuiescentMutationBusyError ||
        (error instanceof SessionConfigurationTransitionError && error.code === 'session_busy')
      ) {
        return {
          ok: false,
          error: { code: 'session_busy', message: 'Session is running' },
        };
      }
      // The subtree changed while the fence was being taken, so what was held
      // still is not what would be read.
      if (
        error instanceof SessionConfigurationTransitionError &&
        error.code === 'operation_conflict'
      ) {
        return {
          ok: false,
          error: { code: 'candidate_set_stale', message: error.message },
        };
      }
      throw error;
    }
  }

  async import(input: {
    readonly source: string;
  }): Promise<OperationOutcome<'session-bundle.import'>> {
    // No Session fence: the Sessions being imported do not exist here yet, so
    // there is nothing to fence by id. What has to be exclusive is the context
    // store, and the import takes that turn itself.
    const result = await runWithStorageRootLease(this.#options.lease, 'interactive', 'write', () =>
      importSessionBundle({
        workspaceRoot: this.#options.lease.canonicalPath,
        source: input.source,
        lease: this.#options.lease,
      }),
    );
    if (!result.ok) return { ok: false, error: importFailure(result.reason) };
    const root = result.sessionIds[0];
    if (root !== undefined) this.#options.onImported(root);
    return {
      ok: true,
      result: { sessionCount: result.sessionIds.length, artifactFiles: result.artifactFiles },
    };
  }
}

/**
 * The identity of a subtree, bounded.
 *
 * Sorted so the order a walk happened to produce cannot change it, and hashed
 * so it stays one field however large the subtree grows.
 */
export function subtreeDigest(sessionIds: readonly string[]): string {
  return createHash('sha256')
    .update([...sessionIds].sort().join('\n'))
    .digest('hex');
}

function exportFailure(reason: { kind: string; message?: string }): {
  code:
    | 'not_found'
    | 'session_busy'
    | 'operation_conflict'
    | 'source_unreadable'
    | 'persistence_failed';
  message: string;
} {
  const message = reason.message ?? reason.kind;
  switch (reason.kind) {
    case 'session_not_found':
    case 'workspace_not_found':
      return { code: 'not_found', message };
    case 'session_active':
      return { code: 'session_busy', message };
    case 'destination_exists':
      return { code: 'operation_conflict', message };
    case 'schema_unsupported':
    case 'artifact_missing':
    case 'artifact_unsafe':
      return { code: 'source_unreadable', message };
    default:
      return { code: 'persistence_failed', message };
  }
}

function importFailure(reason: { kind: string; message?: string }): {
  code: 'not_found' | 'operation_conflict' | 'source_unreadable' | 'persistence_failed';
  message: string;
} {
  const message = reason.message ?? reason.kind;
  switch (reason.kind) {
    case 'workspace_not_found':
      return { code: 'not_found', message };
    case 'session_exists':
    case 'conflict':
      return { code: 'operation_conflict', message };
    case 'bundle_unreadable':
    case 'schema_unsupported':
      return { code: 'source_unreadable', message };
    default:
      return { code: 'persistence_failed', message };
  }
}
