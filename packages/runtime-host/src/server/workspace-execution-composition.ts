import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import { createManagedExecutionBoundary } from '@maka/core/sandbox-boundary';
import type {
  OpenManagedWorkspaceBaselineInput,
  ManagedWorkspaceExecutionHandle,
  ManagedWorkspaceExecutionOptions,
  ManagedWorkspaceFilesystemWorker,
  ManagedWorkspaceOwner,
  ManagedWorkspaceReadOnlyOperation,
  ManagedWorkspaceReadOnlyResult,
} from '@maka/storage/managed-workspace-owner';
import type { InteractiveExecutionStoresWriter } from '@maka/storage/execution-stores';

export type RuntimeHostWorkspaceExecutionProfile =
  | {
      readonly kind: 'attached_checkout_v1';
      readonly cwd: string;
    }
  | {
      readonly kind: 'managed_worktree_v1';
      readonly executionHandle: ManagedWorkspaceExecutionHandle;
      readonly provisioning: NonNullable<ManagedWorkspaceExecutionOptions['provisioning']>;
    };

export type RuntimeHostWorkspaceExecutionErrorCode =
  | 'workspace_execution_draining'
  | 'filesystem_worker_unavailable'
  | 'managed_workspace_profile_unavailable'
  | 'workspace_operation_denied';

export class RuntimeHostWorkspaceExecutionError extends Error {
  constructor(
    readonly code: RuntimeHostWorkspaceExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostWorkspaceExecutionError';
  }
}

export interface RuntimeHostWorkspaceExecutionComposition {
  readonly state: 'ready' | 'draining' | 'closed';
  executeReadOnly(
    profile: RuntimeHostWorkspaceExecutionProfile,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult>;
  openManagedWorkspace(
    input: OpenManagedWorkspaceBaselineInput,
    options?: ManagedWorkspaceExecutionOptions,
  ): Promise<RuntimeHostWorkspaceExecutionProfile>;
  beginDrain(): void;
  close(): Promise<void>;
}

export interface CreateRuntimeHostWorkspaceExecutionCompositionInput {
  readonly filesystemWorker?: ManagedWorkspaceFilesystemWorker;
  readonly managedOwner?: ManagedWorkspaceOwner;
  readonly executionStores?: InteractiveExecutionStoresWriter;
}

export function createAttachedWorkspaceExecutionProfile(
  cwd: string,
): RuntimeHostWorkspaceExecutionProfile {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new RuntimeHostWorkspaceExecutionError(
      'workspace_operation_denied',
      'Attached workspace execution requires a non-empty cwd',
    );
  }
  return Object.freeze({ kind: 'attached_checkout_v1', cwd });
}

export function createManagedWorkspaceExecutionProfile(
  executionHandle: ManagedWorkspaceExecutionHandle,
  options: ManagedWorkspaceExecutionOptions = {},
): RuntimeHostWorkspaceExecutionProfile {
  return Object.freeze({
    kind: 'managed_worktree_v1',
    executionHandle,
    provisioning: normalizeManagedProvisioning(options.provisioning),
  });
}

export function createRuntimeHostWorkspaceExecutionComposition(
  input: CreateRuntimeHostWorkspaceExecutionCompositionInput,
): RuntimeHostWorkspaceExecutionComposition {
  let state: RuntimeHostWorkspaceExecutionComposition['state'] = 'ready';
  let activeOperations = 0;
  const drainWaiters = new Set<() => void>();
  let closeTask: Promise<void> | undefined;

  const beginDrain = () => {
    if (state === 'ready') state = 'draining';
  };
  const waitForDrain = () => {
    if (activeOperations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => drainWaiters.add(resolve));
  };
  const finishOperation = () => {
    activeOperations -= 1;
    if (activeOperations !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  return {
    get state() {
      return state;
    },
    async openManagedWorkspace(baselineInput, options = {}) {
      if (state !== 'ready') {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_execution_draining',
          'Runtime Host workspace execution is draining',
        );
      }
      if (!input.managedOwner || !input.executionStores) {
        throw new RuntimeHostWorkspaceExecutionError(
          'managed_workspace_profile_unavailable',
          'Managed workspace execution is not composed for this Runtime Host',
        );
      }
      const provisioning = normalizeManagedProvisioning(options.provisioning);
      activeOperations += 1;
      try {
        const opened = await input.managedOwner.openManagedWorkspaceBaselineFromExecutionStores(
          input.executionStores,
          baselineInput,
        );
        return createManagedWorkspaceExecutionProfile(opened.executionHandle, { provisioning });
      } finally {
        finishOperation();
      }
    },
    async executeReadOnly(profile, operation, abortSignal) {
      if (state !== 'ready') {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_execution_draining',
          'Runtime Host workspace execution is draining',
        );
      }
      if (!isReadOnlyOperation(operation)) {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_operation_denied',
          'Runtime Host workspace execution permits only Read, Glob, and Grep',
        );
      }
      if (!isWorkspaceExecutionProfile(profile)) {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_operation_denied',
          'Runtime Host workspace execution profile is invalid',
        );
      }
      activeOperations += 1;
      try {
        if (profile.kind === 'managed_worktree_v1') {
          if (!input.managedOwner) {
            throw new RuntimeHostWorkspaceExecutionError(
              'managed_workspace_profile_unavailable',
              'Managed workspace execution is not composed for this Runtime Host',
            );
          }
          return await input.managedOwner.withManagedWorkspaceExecution(
            profile.executionHandle,
            (scope) =>
              input.managedOwner!.executeReadOnlyFilesystemOperation(scope, operation, abortSignal),
            {
              provisioning: profile.provisioning,
              ...(abortSignal ? { abortSignal } : {}),
            },
          );
        }
        if (!input.filesystemWorker) {
          throw new RuntimeHostWorkspaceExecutionError(
            'filesystem_worker_unavailable',
            'Attached workspace filesystem worker is unavailable',
          );
        }
        return await input.filesystemWorker.execute({
          operation,
          cwd: profile.cwd,
          executionBoundary: createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0),
          ...(abortSignal ? { abortSignal } : {}),
        });
      } finally {
        finishOperation();
      }
    },
    beginDrain,
    close() {
      closeTask ??= (async () => {
        beginDrain();
        await waitForDrain();
        await input.managedOwner?.close();
        state = 'closed';
      })();
      return closeTask;
    },
  };
}

function normalizeManagedProvisioning(
  provisioning: ManagedWorkspaceExecutionOptions['provisioning'],
): NonNullable<ManagedWorkspaceExecutionOptions['provisioning']> {
  const value = provisioning ?? 'canonical_tree_only_v1';
  if (value !== 'canonical_tree_only_v1' && value !== 'dependency_environment_v1') {
    throw new RuntimeHostWorkspaceExecutionError(
      'workspace_operation_denied',
      'Managed workspace provisioning profile is invalid',
    );
  }
  return value;
}

function isReadOnlyOperation(input: unknown): input is ManagedWorkspaceReadOnlyOperation {
  if (!input || typeof input !== 'object') return false;
  const kind = (input as { kind?: unknown }).kind;
  return kind === 'read' || kind === 'glob' || kind === 'grep';
}

function isWorkspaceExecutionProfile(
  input: unknown,
): input is RuntimeHostWorkspaceExecutionProfile {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as {
    kind?: unknown;
    cwd?: unknown;
    executionHandle?: { kind?: unknown };
    provisioning?: unknown;
  };
  if (candidate.kind === 'attached_checkout_v1') {
    return typeof candidate.cwd === 'string' && candidate.cwd.length > 0;
  }
  return (
    candidate.kind === 'managed_worktree_v1' &&
    candidate.executionHandle?.kind === 'managed_workspace_execution_handle_v1' &&
    (candidate.provisioning === 'canonical_tree_only_v1' ||
      candidate.provisioning === 'dependency_environment_v1')
  );
}
