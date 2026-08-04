import type { RuntimeWorkspaceVersionAuthorityStore, WorkspaceHeadRecordV1 } from '@maka/core';
import type {
  ManagedWorkspaceBaselineReceiptV1,
  ManagedWorkspaceBinding,
} from './git-workspace-service.js';

export interface ManagedWorkspaceExecutionHandle {
  readonly kind: 'managed_workspace_execution_handle_v1';
}

export interface ManagedWorkspaceExecutionAuthorityStateInternal {
  readonly store: RuntimeWorkspaceVersionAuthorityStore;
  readonly binding: ManagedWorkspaceBinding;
  readonly receipt: ManagedWorkspaceBaselineReceiptV1;
  readonly head: WorkspaceHeadRecordV1;
}

const states = new WeakMap<
  object,
  ManagedWorkspaceExecutionAuthorityStateInternal & {
    readonly ownerToken: object;
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
