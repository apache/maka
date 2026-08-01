import type { WorkspaceBaselineAuthorityInput, WorkspaceBaselineCommitResult } from '@maka/core';

type WorkspaceBaselineAuthorityWriter = (
  input: WorkspaceBaselineAuthorityInput,
) => Promise<WorkspaceBaselineCommitResult>;

const workspaceBaselineAuthorityWriters = new WeakMap<object, WorkspaceBaselineAuthorityWriter>();

export function registerWorkspaceBaselineAuthorityWriterInternal(
  store: object,
  writer: WorkspaceBaselineAuthorityWriter,
): void {
  if (workspaceBaselineAuthorityWriters.has(store)) {
    throw new Error('Workspace baseline authority writer is already registered');
  }
  workspaceBaselineAuthorityWriters.set(store, writer);
}

/**
 * Storage-internal seam for persistence/crash tests. This module is deliberately
 * absent from @maka/storage package exports. Production composition must use a
 * future verified-receipt API instead of accepting caller-supplied Git OIDs.
 */
export function commitWorkspaceBaselineInternal(
  store: object,
  input: WorkspaceBaselineAuthorityInput,
): Promise<WorkspaceBaselineCommitResult> {
  const writer = workspaceBaselineAuthorityWriters.get(store);
  if (!writer) throw new Error('Workspace baseline authority writer is unavailable');
  return writer(input);
}
