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

import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionManager } from '@maka/runtime/session-manager';
import { SessionConfigurationTransitionError } from '@maka/runtime/session-manager';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';
import { openFileSessionRepository } from '@maka/storage/file-session-repository';
import { openSessionCheckpointPublicationStore } from '@maka/storage/session-checkpoint-publication-store';
import { acquireProcessLifetimeOwner } from '@maka/storage/process-lifetime-owner';
import { runWithStorageRootLease } from '@maka/storage/root-authority';
import {
  assertSessionBundleLimits,
  type SessionBundleLimits,
} from '@maka/storage/session-bundle-contract';
import { createProductionSessionSnapshotService } from '@maka/storage/production-session-snapshot';
import type {
  SessionSnapshotCancellation,
  SessionSnapshotPrivateStagingRootAuthority,
  SessionSnapshotStatePreparer,
  SessionSnapshotWorkspaceConfirmationAuthority,
} from '@maka/storage/quiescent-session-snapshot';
import type { InteractiveShellRunWriter } from '@maka/storage/shell-run-authority';
import type { RuntimeHostCompositionContext } from './host-kernel.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import {
  HostCheckpointError,
  HostSessionCheckpointCoordinator,
  type HostSessionCheckpointPublication,
} from './session-checkpoint-coordinator.js';

/**
 * Trusted deployment authority, never a client/model supplied "idle" flag.
 * It must fence ALL writers (including external processes/shared workspaces)
 * before invoking operation, and hold that fence until the copy settles.
 * Ordinary externally writable directories without this authority are unsupported.
 */
export interface HostCheckpointWorkspaceAuthority {
  runExclusive<T>(
    input: {
      readonly sessionId: string;
      readonly workspaceRoot: string;
      readonly cancellation: SessionSnapshotCancellation;
    },
    operation: () => Promise<T>,
  ): Promise<T>;
}
export interface HostCheckpointPublicationOptions {
  readonly limits: SessionBundleLimits;
  readonly workspace: HostCheckpointWorkspaceAuthority;
  readonly privateStagingRootAuthority?: SessionSnapshotPrivateStagingRootAuthority;
  readonly confirmationAuthority?: SessionSnapshotWorkspaceConfirmationAuthority;
}

/** Trusted service capability; no protocol endpoint or model tool is added by PR2. */
export async function createHostSessionCheckpointPublication(input: {
  readonly context: RuntimeHostCompositionContext;
  readonly stores: InteractiveExecutionStoresWriter;
  readonly admission: SessionAdmissionGate;
  readonly manager: SessionManager;
  readonly shellRuns: InteractiveShellRunWriter;
  readonly isSessionIdle: (sessionId: string) => boolean;
  readonly options?: HostCheckpointPublicationOptions;
}): Promise<HostSessionCheckpointPublication> {
  const { context, stores, options } = input;
  if (!options) return unavailable('Checkpoint publication is not configured');
  if (!stores.snapshot)
    return unavailable('Selected execution persistence does not support checkpoints');
  if (!options.workspace || typeof options.workspace.runExclusive !== 'function') {
    return unavailable('A trusted workspace snapshot authority is required');
  }
  if (process.platform === 'win32' && !options.privateStagingRootAuthority) {
    return unavailable('Checkpoint staging requires a Windows ACL verification authority');
  }
  assertSessionBundleLimits(options.limits);
  // Freeze caller policy at composition, not midway through a publication.
  const limits = Object.freeze({ ...options.limits });
  const root = join(context.owner.controlDirectory, 'session-checkpoints-v1');
  const stagingParent = join(root, 'staging');
  const cleanupStateRoot = join(root, 'cleanup');
  const bundlesRoot = join(root, 'bundles');
  let owner: Awaited<ReturnType<typeof acquireProcessLifetimeOwner>> | undefined;
  try {
    await Promise.all(
      [stagingParent, cleanupStateRoot, bundlesRoot].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    const cleanupOwner = await acquireProcessLifetimeOwner(cleanupStateRoot);
    owner = cleanupOwner;
    const repository = await openFileSessionRepository({ storageRoot: join(root, 'repository') });
    const journal = await openSessionCheckpointPublicationStore({
      directory: join(root, 'operations'),
      rootId: context.owner.lease.rootId,
    });
    const coordinator = new HostSessionCheckpointCoordinator({
      journal,
      repository,
      objects: repository.objectStore,
      runAuthorized: (operation) =>
        runWithStorageRootLease(context.owner.lease, 'interactive', 'write', async () => {
          const residency = context.acquireResidency('session-checkpoint');
          try {
            return await operation();
          } finally {
            residency.release();
          }
        }),
      cleanupBundle: async (commitId) => {
        // This UUID was validated in the journal; never remove a caller path.
        if (!/^[0-9a-f-]{36}$/u.test(commitId))
          throw new Error('Invalid checkpoint bundle identity');
        await rm(join(bundlesRoot, `${commitId}.tar.zst`), { force: true });
      },
      capture: async (request) => {
        const sessionId = request.binding.makaSessionId;
        const header = await stores.sessionStore.readHeader(sessionId);
        if (!header.cwd)
          throw new HostCheckpointError('unsupported', 'Session has no snapshot-capable workspace');
        const workspaceRoot = await realpath(header.cwd);
        let statePreparer: SessionSnapshotStatePreparer | undefined;
        const service = await createProductionSessionSnapshotService({
          session: {
            makaSessionId: sessionId,
            cloudSessionId: request.binding.repositorySessionId,
          },
          sourceRoots: [context.owner.capability.canonicalPath],
          state: {
            prepareState: (stateInput) => {
              if (!statePreparer)
                throw new Error('Snapshot state requested outside its provider boundary');
              return statePreparer.prepareState(stateInput);
            },
          },
          workspaceRoot,
          stagingParent,
          cleanupStateRoot,
          processLifetimeOwner: cleanupOwner,
          limits,
          privateStagingRootAuthority: options.privateStagingRootAuthority,
          confirmationAuthority: options.confirmationAuthority,
          quiescence: {
            runQuiescent: (snapshotInput, operation) =>
              input.admission.run(sessionId, async () => {
                snapshotInput.cancellation.signal.throwIfAborted();
                try {
                  return await input.manager.runSessionSubtreeQuiescentMutation(
                    sessionId,
                    async (sessionIds) => {
                      if (sessionIds.length !== 1)
                        throw new HostCheckpointError(
                          'unsupported',
                          'Linked Session snapshot closure is not supported yet',
                        );
                      return stores.snapshot!.runExclusive(async (state) => {
                        snapshotInput.cancellation.signal.throwIfAborted();
                        const current = await stores.sessionStore.readHeaderSnapshot(sessionId);
                        if (!current.cwd || (await realpath(current.cwd)) !== workspaceRoot) {
                          throw new HostCheckpointError(
                            'conflict',
                            'Session workspace changed before capture',
                          );
                        }
                        if (
                          current.role !== undefined ||
                          current.subagentParent ||
                          current.conversationCopy?.state === 'preparing'
                        ) {
                          throw new HostCheckpointError(
                            'unsupported',
                            'Session kind is not supported for checkpoint publication',
                          );
                        }
                        const [pending, operations, approvals, boundaries, shells, sessions] =
                          await Promise.all([
                            stores.sessionStore.listMessageAdmissions(sessionId),
                            stores.runtimeEventStore.listUnsettledToolOperations(sessionId),
                            stores.interactionStore.listPending({ sessionId }),
                            stores.sessionStore.listPendingSandboxBoundaryRequests(sessionId),
                            input.shellRuns.listSessionShellRuns(sessionId),
                            stores.sessionStore.listForRecovery(),
                          ]);
                        if (
                          !input.isSessionIdle(sessionId) ||
                          pending.length ||
                          operations.length ||
                          approvals.length ||
                          boundaries.length ||
                          shells.some(
                            (shell) =>
                              shell.status === 'starting' ||
                              shell.status === 'running' ||
                              shell.status === 'orphaned',
                          )
                        ) {
                          throw new HostCheckpointError(
                            'busy',
                            'Session has pending execution or external work',
                          );
                        }
                        for (const other of sessions) {
                          if (
                            other.id !== sessionId &&
                            other.cwd &&
                            (await realpath(other.cwd).catch(() => undefined)) === workspaceRoot
                          ) {
                            throw new HostCheckpointError(
                              'unsupported',
                              'Shared workspaces require a multi-Session snapshot boundary',
                            );
                          }
                        }
                        return options.workspace.runExclusive(
                          { sessionId, workspaceRoot, cancellation: snapshotInput.cancellation },
                          async () => {
                            snapshotInput.cancellation.signal.throwIfAborted();
                            statePreparer = state;
                            try {
                              return await operation();
                            } finally {
                              statePreparer = undefined;
                            }
                          },
                        );
                      });
                    },
                  );
                } catch (error) {
                  if (
                    error instanceof SessionConfigurationTransitionError &&
                    error.code === 'session_busy'
                  ) {
                    throw new HostCheckpointError(
                      'busy',
                      'Session has an active Runtime execution',
                      { cause: error },
                    );
                  }
                  throw error;
                }
              }),
          },
        });
        return service.pack({
          destination: join(bundlesRoot, `${request.commitId}.tar.zst`),
          confirmationGrantId: request.confirmationGrantId,
          signal: request.signal,
          deadlineAt: request.deadlineAt,
        });
      },
    });
    let close: Promise<void> | undefined;
    return {
      publish: (request) => coordinator.publish(request),
      beginDrain: () => coordinator.beginDrain(),
      close: () =>
        (close ??= (async () => {
          await coordinator.close();
          await cleanupOwner.close();
        })()),
    };
  } catch (error) {
    await owner?.close();
    // Optional checkpoint metadata must not prevent live-state recovery. Fail
    // this capability closed and retain the cause for the trusted caller.
    return unavailable('Checkpoint publication initialization failed', 'publication_failed', error);
  }
}
function unavailable(
  message: string,
  code: 'unsupported' | 'publication_failed' = 'unsupported',
  cause?: unknown,
): HostSessionCheckpointPublication {
  let closed = false;
  return {
    publish: async () => {
      throw new HostCheckpointError(closed ? 'closed' : code, message, { cause });
    },
    beginDrain: () => {
      closed = true;
    },
    close: async () => {
      closed = true;
    },
  };
}
