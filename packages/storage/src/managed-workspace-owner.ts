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

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createGitWorkspaceService,
  type CreateManagedWorkspaceFromSourceInput,
  GitWorkspaceServiceError,
  type GitWorkspaceService,
  type GitWorkspaceServiceFailpoint,
  type ManagedWorkspaceBaselineReceiptV1,
  type ManagedWorkspaceBinding,
  type VerifiedGitRuntimeInput,
} from './git-workspace-service.js';
import {
  requireManagedBaselineReceiptAuthorityInternal,
  type ManagedBaselineReceiptAuthorityInternal,
} from './managed-baseline-receipt-authority-internal.js';
import {
  issueManagedWorkspaceExecutionHandleInternal,
  issueManagedWorkspaceExecutionScopeInternal,
  requireManagedWorkspaceExecutionHandleInternal,
  revokeManagedWorkspaceExecutionScopeInternal,
  type ManagedWorkspaceExecutionHandle,
  type ManagedWorkspaceExecutionScope,
} from './managed-workspace-execution-authority-internal.js';
import {
  createManagedWorkspaceWorkerBridgeInternal,
  type ManagedWorkspaceFilesystemWorker,
  type ManagedWorkspaceReadOnlyOperation,
  type ManagedWorkspaceReadOnlyResult,
  type ManagedWorkspaceWorkerBridgeInternal,
} from './managed-workspace-worker-bridge-internal.js';
import type { RuntimeWorkspaceVersionAuthorityStore } from '@maka/core/runtime-event-store';
import type { WorkspaceHeadRecordV1 } from '@maka/core/workspace-version-authority';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  createStorageRootLeaseIdentityGuard,
  runWithStorageRootLease,
  type InteractiveRootOwner,
} from './root-authority.js';
import {
  assertWorkspaceBaselineAuthorityStoreRootInternal,
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
  readWorkspaceHeadInternal,
} from './workspace-version-authority-internal.js';

// RuntimeEvent order is assigned by the SQLite authority spine. M0 therefore
// uses a protocol-fixed logical timestamp and keeps unauthenticated wall-clock
// time out of the durable Git receipt.
const MANAGED_BASELINE_LOGICAL_TIMESTAMP_V1 = 0;

export type ManagedWorkspaceOwnerErrorCode =
  | 'managed_workspace_owner_conflict'
  | 'managed_workspace_owner_unavailable'
  | 'managed_workspace_owner_closing'
  | 'managed_workspace_owner_reentrant_close'
  | 'managed_workspace_worker_unavailable'
  | 'managed_workspace_quarantined'
  | 'managed_workspace_execution_handle_invalid';

export class ManagedWorkspaceOwnerError extends Error {
  constructor(
    readonly code: ManagedWorkspaceOwnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagedWorkspaceOwnerError';
  }
}

export interface OpenManagedWorkspaceOwnerInput {
  readonly rootOwner: InteractiveRootOwner;
  readonly gitRuntime: VerifiedGitRuntimeInput;
  readonly failpoint?: (point: ManagedWorkspaceOwnerFailpoint) => void | Promise<void>;
  readonly filesystemWorker?: ManagedWorkspaceFilesystemWorker;
}

export type ManagedWorkspaceOwnerFailpoint =
  | GitWorkspaceServiceFailpoint
  | 'after_initial_store_root_validation'
  | 'after_baseline_authority_commit'
  | 'after_post_commit_artifact_verification'
  | 'after_execution_artifact_verification';

export type OpenManagedWorkspaceBaselineInput = CreateManagedWorkspaceFromSourceInput;

export interface OpenManagedWorkspaceBaselineResult {
  readonly created: boolean;
  readonly head: WorkspaceHeadRecordV1;
  readonly executionHandle: ManagedWorkspaceExecutionHandle;
}

export interface ManagedWorkspaceOwner {
  readonly state: 'ready' | 'closing' | 'closed';
  openManagedWorkspaceBaseline(
    store: RuntimeWorkspaceVersionAuthorityStore,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult>;
  withManagedWorkspaceExecution<T>(
    handle: ManagedWorkspaceExecutionHandle,
    operation: (scope: ManagedWorkspaceExecutionScope) => Promise<T>,
  ): Promise<T>;
  executeReadOnlyFilesystemOperation(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult>;
  close(): Promise<void>;
}

export type {
  ManagedWorkspaceExecutionHandle,
  ManagedWorkspaceExecutionScope,
  ManagedWorkspaceFilesystemWorker,
  ManagedWorkspaceReadOnlyOperation,
  ManagedWorkspaceReadOnlyResult,
  VerifiedGitRuntimeInput,
};

const owners = new WeakMap<InteractiveRootOwner, object>();

export async function openManagedWorkspaceOwner(
  input: OpenManagedWorkspaceOwnerInput,
): Promise<ManagedWorkspaceOwner> {
  const rootOwner = authenticateInteractiveRootOwner(input.rootOwner);
  await assertInteractiveRootOwner(rootOwner);
  if (owners.has(rootOwner)) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_conflict',
      'This storage root owner already has a managed workspace owner',
    );
  }

  const claim = {};
  owners.set(rootOwner, claim);
  try {
    const service = createGitWorkspaceService({
      storageRoot: rootOwner.capability.canonicalPath,
      gitRuntime: input.gitRuntime,
      ...(input.failpoint ? { failpoint: input.failpoint } : {}),
    });
    await runWithStorageRootLease(rootOwner.lease, 'interactive', 'write', () =>
      service.assertAvailable(),
    );
    // The root owner may begin closing while capability initialization is in
    // flight. Revalidate after the lease-bound operation so a stale lifecycle
    // owner is never published as ready.
    await assertInteractiveRootOwner(rootOwner);
    const owner = new ManagedWorkspaceOwnerImpl(
      rootOwner,
      service,
      requireManagedBaselineReceiptAuthorityInternal(service),
      input.failpoint,
      input.filesystemWorker,
    );
    owners.set(rootOwner, owner);
    return owner;
  } catch (error) {
    if (owners.get(rootOwner) === claim) owners.delete(rootOwner);
    if (error instanceof ManagedWorkspaceOwnerError) throw error;
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Unable to initialize the managed workspace owner',
      { cause: error },
    );
  }
}

class ManagedWorkspaceOwnerImpl implements ManagedWorkspaceOwner {
  #state: 'ready' | 'closing' | 'closed' = 'ready';
  #activeOperations = 0;
  readonly #drainWaiters = new Set<() => void>();
  readonly #assertCurrentRootIdentity: () => Promise<void>;
  readonly #executionContext = new AsyncLocalStorage<object>();
  #closeTask: Promise<void> | undefined;
  readonly #executionOwnerToken = {};
  readonly #workerBridge: ManagedWorkspaceWorkerBridgeInternal | undefined;

  constructor(
    private readonly rootOwner: InteractiveRootOwner,
    private readonly service: GitWorkspaceService,
    private readonly receiptAuthority: ManagedBaselineReceiptAuthorityInternal,
    private readonly failpoint?: (point: ManagedWorkspaceOwnerFailpoint) => void | Promise<void>,
    filesystemWorker?: ManagedWorkspaceFilesystemWorker,
  ) {
    // Capture the identity guard while the lease is active. Unlike a fresh
    // admission check, this guard remains valid for an already-admitted
    // operation while owner.close() waits for that operation to drain.
    this.#assertCurrentRootIdentity = createStorageRootLeaseIdentityGuard(
      rootOwner.lease,
      'interactive',
      'write',
    );
    this.#workerBridge = filesystemWorker
      ? createManagedWorkspaceWorkerBridgeInternal(this.#executionOwnerToken, filesystemWorker)
      : undefined;
  }

  get state(): 'ready' | 'closing' | 'closed' {
    return this.#state;
  }

  async openManagedWorkspaceBaseline(
    store: RuntimeWorkspaceVersionAuthorityStore,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult> {
    return this.#run(async () => {
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(store, this.rootOwner.capability.rootId);
      await this.failpoint?.('after_initial_store_root_validation');
      const existingHead = await readWorkspaceHeadInternal(
        store,
        input.workspaceId,
        input.workspaceEpochId,
      );
      const receipt = existingHead ? await this.receiptAuthority.require(input) : undefined;
      const binding = receipt
        ? await this.#openReadyBinding(receipt.binding)
        : await this.#requireReady(await this.service.createManagedWorkspaceFromSource(input));
      const durableReceipt = receipt ?? (await this.receiptAuthority.issue(binding));
      if (
        existingHead &&
        (existingHead.workspaceVersionId !== durableReceipt.workspaceVersionId ||
          existingHead.acceptedEventId !== durableReceipt.baselineAcceptedEventId ||
          existingHead.commitOid !== binding.baselineCommitOid ||
          existingHead.treeOid !== binding.baselineTreeOid)
      ) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_unavailable',
          'Canonical workspace head does not match its durable Git baseline receipt',
        );
      }
      const committed = await commitWorkspaceBaselineInternal(store, {
        epochOpenedEventId: durableReceipt.epochOpenedEventId,
        baselineAcceptedEventId: durableReceipt.baselineAcceptedEventId,
        committedAt: MANAGED_BASELINE_LOGICAL_TIMESTAMP_V1,
        epoch: {
          repositoryId: binding.repositoryId,
          workspaceId: binding.workspaceId,
          workspaceEpochId: binding.workspaceEpochId,
          workspaceInstanceId: binding.workspaceInstanceId,
          mode: 'managed_worktree',
          objectFormat: binding.objectFormat,
          sourceCommitOid: binding.sourceHeadCommitOid,
          sourceTreeOid: binding.sourceTreeOid,
          materializationProfileDigest: binding.materializationProfileDigest,
          materializationSemantics: binding.materializationSemantics,
          policyHash: durableReceipt.policyHash,
        },
        baseline: {
          workspaceVersionId: durableReceipt.workspaceVersionId,
          commitOid: binding.baselineCommitOid,
          treeOid: binding.baselineTreeOid,
          treeDeltaDigest: durableReceipt.treeDeltaDigest,
          changedFileCount: durableReceipt.changedFileCount,
          deletedFileCount: durableReceipt.deletedFileCount,
        },
      });
      await this.failpoint?.('after_baseline_authority_commit');
      // The transaction writes through the already-open SQLite handle. Rebind
      // that handle to the canonical pathname after COMMIT so an external
      // rename/replacement cannot make an orphan database look accepted.
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(store, this.rootOwner.capability.rootId);
      // Canonical acceptance never makes a missing Git artifact acceptable.
      // Reverify after the SQLite transaction so post-accept artifact loss is
      // reported fail-closed instead of returning a usable workspace head.
      await this.receiptAuthority.verify(durableReceipt);
      await this.failpoint?.('after_post_commit_artifact_verification');
      // The root marker is mutable host state and is not covered by receipt
      // verification. Revalidate its identity at the final return gate without
      // rejecting an operation that owner.close() is legitimately draining.
      await this.#assertCurrentRootIdentity();
      const internalHead = freezeWorkspaceHead(committed.head);
      const internalBinding = freezeManagedWorkspaceBinding(binding);
      const internalReceipt = freezeManagedWorkspaceReceipt(durableReceipt);
      return {
        created: committed.created,
        head: freezeWorkspaceHead(committed.head),
        executionHandle: issueManagedWorkspaceExecutionHandleInternal(this.#executionOwnerToken, {
          store,
          binding: internalBinding,
          receipt: internalReceipt,
          head: internalHead,
        }),
      };
    });
  }

  async withManagedWorkspaceExecution<T>(
    handle: ManagedWorkspaceExecutionHandle,
    operation: (scope: ManagedWorkspaceExecutionScope) => Promise<T>,
  ): Promise<T> {
    return this.#run(async () => {
      let accepted;
      try {
        accepted = requireManagedWorkspaceExecutionHandleInternal(
          this.#executionOwnerToken,
          handle,
        );
      } catch (error) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_execution_handle_invalid',
          'Managed workspace execution handle is invalid for this owner',
          { cause: error },
        );
      }
      assertExecutionCrossPlaneIdentity(accepted.binding, accepted.receipt, accepted.head);
      // Test builds with a failpoint retain a preliminary proof so crash tests
      // can stop after a real, completed artifact verification. The ordinary
      // production path performs only the final proof below.
      if (this.failpoint) {
        await this.#verifyExecutionArtifactOrQuarantine(accepted.binding, accepted.receipt);
        await this.failpoint('after_execution_artifact_verification');
      }

      // The root write lease excludes cooperating Maka writers across this
      // proof bundle. Verify the durable Git artifact first, then make the
      // immutable workspace head the final durable reread before scope issue.
      await this.#assertCurrentRootIdentity();
      await this.#verifyExecutionArtifactOrQuarantine(accepted.binding, accepted.receipt);
      const currentHead = await readWorkspaceHeadInternal(
        accepted.store,
        accepted.binding.workspaceId,
        accepted.binding.workspaceEpochId,
      );
      // Rebind only after the head read. This catches a database pathname
      // detach at the admission boundary without putting a mutable DB guard
      // ahead of the durable head evidence it protects.
      await assertWorkspaceBaselineAuthorityStoreRootInternal(
        accepted.store,
        this.rootOwner.capability.canonicalPath,
      );
      bindWorkspaceBaselineAuthorityStoreRootInternal(
        accepted.store,
        this.rootOwner.capability.rootId,
      );
      if (!currentHead || !sameWorkspaceHead(currentHead, accepted.head)) {
        throw new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_unavailable',
          'Managed workspace execution handle no longer matches the canonical workspace head',
        );
      }
      assertExecutionCrossPlaneIdentity(accepted.binding, accepted.receipt, currentHead);
      const binding = accepted.binding;
      const scope = issueManagedWorkspaceExecutionScopeInternal(this.#executionOwnerToken, {
        provisioning: 'canonical_tree_only_v1',
        workspaceEffect: 'none',
        cwd: binding.worktreePath,
        binding: Object.freeze({ ...binding }),
        head: freezeWorkspaceHead(currentHead),
      });
      try {
        return await this.#executionContext.run(this.#executionOwnerToken, () => operation(scope));
      } finally {
        revokeManagedWorkspaceExecutionScopeInternal(this.#executionOwnerToken, scope);
      }
    });
  }

  async executeReadOnlyFilesystemOperation(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult> {
    if (!this.#workerBridge) {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_worker_unavailable',
        'Managed workspace filesystem worker is unavailable',
      );
    }
    return await this.#workerBridge.execute(scope, operation, abortSignal);
  }

  close(): Promise<void> {
    if (this.#executionContext.getStore() === this.#executionOwnerToken) {
      return Promise.reject(
        new ManagedWorkspaceOwnerError(
          'managed_workspace_owner_reentrant_close',
          'Managed workspace owner cannot close from its own execution callback',
        ),
      );
    }
    this.#closeTask ??= (async () => {
      this.#state = 'closing';
      await this.#waitForDrain();
      this.#state = 'closed';
    })();
    return this.#closeTask;
  }

  #assertReady(): void {
    if (this.#state !== 'ready') {
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_owner_closing',
        'Managed workspace owner is closing or closed',
      );
    }
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertReady();
    this.#activeOperations += 1;
    try {
      return await runWithStorageRootLease(this.rootOwner.lease, 'interactive', 'write', operation);
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        for (const resolve of this.#drainWaiters) resolve();
        this.#drainWaiters.clear();
      }
    }
  }

  #waitForDrain(): Promise<void> {
    if (this.#activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  async #requireReady(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBinding> {
    const inspection = await this.service.inspectManagedWorkspace(binding);
    if (inspection.state === 'ready') return binding;
    const quarantine = await this.service.quarantineManagedWorkspace(
      binding,
      'external_workspace_drift',
    );
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_quarantined',
      `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
    );
  }

  async #openReadyBinding(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBinding> {
    try {
      return await this.#requireReady(await this.service.openManagedWorkspaceFromBinding(binding));
    } catch (error) {
      if (
        !(error instanceof GitWorkspaceServiceError) ||
        error.code !== 'managed_workspace_drifted'
      ) {
        throw error;
      }
      const quarantine = await this.service.quarantineManagedWorkspace(
        binding,
        'external_workspace_drift',
      );
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_quarantined',
        `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
        { cause: error },
      );
    }
  }

  async #verifyExecutionArtifactOrQuarantine(
    binding: ManagedWorkspaceBinding,
    receipt: ManagedWorkspaceBaselineReceiptV1,
  ): Promise<void> {
    try {
      await this.receiptAuthority.verify(receipt);
    } catch (error) {
      if (
        !(error instanceof GitWorkspaceServiceError) ||
        error.code !== 'managed_workspace_drifted'
      ) {
        throw error;
      }
      const quarantine = await this.service.quarantineManagedWorkspace(
        binding,
        'external_workspace_drift',
      );
      throw new ManagedWorkspaceOwnerError(
        'managed_workspace_quarantined',
        `Managed workspace drift was quarantined at ${quarantine.quarantinePath}`,
        { cause: error },
      );
    }
  }
}

function sameWorkspaceHead(left: WorkspaceHeadRecordV1, right: WorkspaceHeadRecordV1): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.repositoryId === right.repositoryId &&
    left.workspaceEpochId === right.workspaceEpochId &&
    left.workspaceVersionId === right.workspaceVersionId &&
    left.acceptedEventId === right.acceptedEventId &&
    left.commitOid === right.commitOid &&
    left.treeOid === right.treeOid &&
    left.revision === right.revision
  );
}

function freezeWorkspaceHead(head: WorkspaceHeadRecordV1): Readonly<WorkspaceHeadRecordV1> {
  return Object.freeze({ ...head });
}

function freezeManagedWorkspaceBinding(
  binding: ManagedWorkspaceBinding,
): Readonly<ManagedWorkspaceBinding> {
  return Object.freeze({ ...binding });
}

function freezeManagedWorkspaceReceipt(
  receipt: ManagedWorkspaceBaselineReceiptV1,
): Readonly<ManagedWorkspaceBaselineReceiptV1> {
  return Object.freeze({ ...receipt, binding: freezeManagedWorkspaceBinding(receipt.binding) });
}

function assertExecutionCrossPlaneIdentity(
  binding: ManagedWorkspaceBinding,
  receipt: ManagedWorkspaceBaselineReceiptV1,
  head: Readonly<WorkspaceHeadRecordV1>,
): void {
  if (
    !sameManagedWorkspaceBinding(binding, receipt.binding) ||
    head.repositoryId !== binding.repositoryId ||
    head.workspaceId !== binding.workspaceId ||
    head.workspaceEpochId !== binding.workspaceEpochId ||
    head.workspaceVersionId !== receipt.workspaceVersionId ||
    head.acceptedEventId !== receipt.baselineAcceptedEventId ||
    head.commitOid !== binding.baselineCommitOid ||
    head.treeOid !== binding.baselineTreeOid
  ) {
    throw new ManagedWorkspaceOwnerError(
      'managed_workspace_owner_unavailable',
      'Managed workspace execution evidence does not identify one exact accepted boundary',
    );
  }
}

function sameManagedWorkspaceBinding(
  left: ManagedWorkspaceBinding,
  right: ManagedWorkspaceBinding,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.protocol === right.protocol &&
    left.repositoryId === right.repositoryId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceEpochId === right.workspaceEpochId &&
    left.workspaceInstanceId === right.workspaceInstanceId &&
    left.sourceRoot === right.sourceRoot &&
    left.sourceGitCommonDir === right.sourceGitCommonDir &&
    left.sourceHeadCommitOid === right.sourceHeadCommitOid &&
    left.sourceTreeOid === right.sourceTreeOid &&
    left.repositoryPath === right.repositoryPath &&
    left.worktreePath === right.worktreePath &&
    left.hooksPath === right.hooksPath &&
    left.baselineCommitOid === right.baselineCommitOid &&
    left.baselineTreeOid === right.baselineTreeOid &&
    left.headRef === right.headRef &&
    left.gitRuntimeSha256 === right.gitRuntimeSha256 &&
    left.objectFormat === right.objectFormat &&
    left.materializationProfileDigest === right.materializationProfileDigest &&
    left.materializationSemantics === right.materializationSemantics
  );
}
