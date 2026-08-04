import type { RuntimeWorkspaceVersionAuthorityStore, WorkspaceHeadRecordV1 } from '@maka/core';
import type {
  ManagedWorkspaceBaselineReceiptV1,
  ManagedWorkspaceBinding,
} from './git-workspace-service.js';

export interface ManagedWorkspaceExecutionHandle {
  readonly kind: 'managed_workspace_execution_handle_v1';
}

export interface ManagedWorkspaceExecutionScope {
  readonly kind: 'managed_workspace_execution_scope_v1';
}

export type ManagedWorkspaceExecutionAuthorityErrorCode =
  | 'managed_workspace_execution_scope_invalid'
  | 'managed_workspace_execution_scope_expired';

export class ManagedWorkspaceExecutionAuthorityError extends Error {
  constructor(
    readonly code: ManagedWorkspaceExecutionAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedWorkspaceExecutionAuthorityError';
  }
}

export interface ManagedWorkspaceExecutionAuthorityStateInternal {
  readonly store: RuntimeWorkspaceVersionAuthorityStore;
  readonly binding: Readonly<ManagedWorkspaceBinding>;
  readonly receipt: Readonly<ManagedWorkspaceBaselineReceiptV1>;
  readonly head: Readonly<WorkspaceHeadRecordV1>;
}

const states = new WeakMap<
  object,
  ManagedWorkspaceExecutionAuthorityStateInternal & {
    readonly ownerToken: object;
  }
>();

export interface ManagedWorkspaceExecutionScopeStateInternal {
  readonly provisioning: 'canonical_tree_only_v1';
  readonly workspaceEffect: 'none';
  readonly cwd: string;
  readonly binding: Readonly<ManagedWorkspaceBinding>;
  readonly head: Readonly<WorkspaceHeadRecordV1>;
}

const scopes = new WeakMap<
  object,
  ManagedWorkspaceExecutionScopeStateInternal & {
    readonly ownerToken: object;
    active: boolean;
  }
>();

export function issueManagedWorkspaceExecutionHandleInternal(
  ownerToken: object,
  state: ManagedWorkspaceExecutionAuthorityStateInternal,
): ManagedWorkspaceExecutionHandle {
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  states.set(handle, { ...state, ownerToken });
  return handle;
}

export function requireManagedWorkspaceExecutionHandleInternal(
  ownerToken: object,
  handle: ManagedWorkspaceExecutionHandle,
): ManagedWorkspaceExecutionAuthorityStateInternal {
  const state = states.get(handle);
  if (!state || state.ownerToken !== ownerToken) {
    throw new Error('Managed workspace execution handle is invalid for this owner');
  }
  return state;
}

/** Package-internal evidence access for storage contract and crash tests. */
export function inspectManagedWorkspaceExecutionHandleInternal(
  handle: ManagedWorkspaceExecutionHandle,
): ManagedWorkspaceExecutionAuthorityStateInternal {
  const state = states.get(handle);
  if (!state) throw new Error('Managed workspace execution handle is invalid');
  return state;
}

export function issueManagedWorkspaceExecutionScopeInternal(
  ownerToken: object,
  state: ManagedWorkspaceExecutionScopeStateInternal,
): ManagedWorkspaceExecutionScope {
  const scope = Object.freeze({ kind: 'managed_workspace_execution_scope_v1' as const });
  scopes.set(scope, { ...state, ownerToken, active: true });
  return scope;
}

export function revokeManagedWorkspaceExecutionScopeInternal(
  ownerToken: object,
  scope: ManagedWorkspaceExecutionScope,
): void {
  const state = scopes.get(scope);
  if (!state || state.ownerToken !== ownerToken) {
    throw new ManagedWorkspaceExecutionAuthorityError(
      'managed_workspace_execution_scope_invalid',
      'Managed workspace execution scope is invalid for this owner',
    );
  }
  state.active = false;
}

/** Package-internal active-scope evidence access for storage contract tests. */
export function inspectManagedWorkspaceExecutionScopeInternal(
  scope: ManagedWorkspaceExecutionScope,
): ManagedWorkspaceExecutionScopeStateInternal {
  const state = scopes.get(scope);
  if (!state) {
    throw new ManagedWorkspaceExecutionAuthorityError(
      'managed_workspace_execution_scope_invalid',
      'Managed workspace execution scope is invalid',
    );
  }
  if (!state.active) {
    throw new ManagedWorkspaceExecutionAuthorityError(
      'managed_workspace_execution_scope_expired',
      'Managed workspace execution scope has expired',
    );
  }
  return state;
}
