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
import type { RuntimeWorkspaceVersionAuthorityStore, WorkspaceHeadRecordV1 } from '@maka/core';
import {
  assertInteractiveRootOwner,
  authenticateInteractiveRootOwner,
  runWithStorageRootLease,
  type InteractiveRootOwner,
} from './root-authority.js';
import {
  assertWorkspaceBaselineAuthorityStoreRootInternal,
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
} from './workspace-version-authority-internal.js';

// RuntimeEvent order is assigned by the SQLite authority spine. M0 therefore
// uses a protocol-fixed logical timestamp and keeps unauthenticated wall-clock
// time out of the durable Git receipt.
const MANAGED_BASELINE_LOGICAL_TIMESTAMP_V1 = 0;

export type ManagedWorkspaceOwnerErrorCode =
  | 'managed_workspace_owner_conflict'
  | 'managed_workspace_owner_unavailable'
  | 'managed_workspace_owner_closing'
  | 'managed_workspace_quarantined';

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
}

export type ManagedWorkspaceOwnerFailpoint =
  | GitWorkspaceServiceFailpoint
  | 'after_initial_store_root_validation'
  | 'after_baseline_authority_commit';

export type OpenManagedWorkspaceBaselineInput = CreateManagedWorkspaceFromSourceInput;

export interface OpenManagedWorkspaceBaselineResult {
  readonly created: boolean;
  readonly binding: ManagedWorkspaceBinding;
  readonly receipt: ManagedWorkspaceBaselineReceiptV1;
  readonly head: WorkspaceHeadRecordV1;
}

export interface ManagedWorkspaceOwner {
  readonly state: 'ready' | 'closing' | 'closed';
  openManagedWorkspaceBaseline(
    store: RuntimeWorkspaceVersionAuthorityStore,
    input: OpenManagedWorkspaceBaselineInput,
  ): Promise<OpenManagedWorkspaceBaselineResult>;
  close(): Promise<void>;
}

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
  #closeTask: Promise<void> | undefined;

  constructor(
    private readonly rootOwner: InteractiveRootOwner,
    private readonly service: GitWorkspaceService,
    private readonly receiptAuthority: ManagedBaselineReceiptAuthorityInternal,
    private readonly failpoint?: (point: ManagedWorkspaceOwnerFailpoint) => void | Promise<void>,
  ) {}

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
      const existingHead = await store.readWorkspaceHead(input.workspaceId, input.workspaceEpochId);
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
      return { ...committed, binding, receipt: durableReceipt };
    });
  }

  close(): Promise<void> {
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
}
