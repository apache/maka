import type { RuntimeWorkspaceVersionAuthorityStore } from '@maka/core';

const workspaceAuthorities = new WeakMap<object, RuntimeWorkspaceVersionAuthorityStore>();

export function registerExecutionStoresWorkspaceAuthorityInternal(
  stores: object,
  authority: RuntimeWorkspaceVersionAuthorityStore,
): void {
  if (workspaceAuthorities.has(stores)) {
    throw new Error('Execution stores workspace authority is already registered');
  }
  workspaceAuthorities.set(stores, authority);
}

export function requireExecutionStoresWorkspaceAuthorityInternal(
  stores: object,
): RuntimeWorkspaceVersionAuthorityStore {
  const authority = workspaceAuthorities.get(stores);
  if (!authority) throw new Error('Execution stores workspace authority is unavailable');
  return authority;
}
