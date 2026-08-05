import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueManagedWorkspaceExecutionScopeInternal,
  ManagedWorkspaceExecutionAuthorityError,
  requireManagedWorkspaceExecutionScopeInternal,
  revokeManagedWorkspaceExecutionScopeInternal,
} from '../managed-workspace-execution-authority-internal.js';

test('resolves an active execution scope only for its issuing owner', () => {
  const issuer = {};
  const otherOwner = {};
  const scope = issueManagedWorkspaceExecutionScopeInternal(issuer, {
    provisioning: 'canonical_tree_only_v1',
    workspaceEffect: 'none',
    cwd: '/managed/worktree',
    binding: Object.freeze({}) as never,
    head: Object.freeze({}) as never,
  });

  assert.equal(
    requireManagedWorkspaceExecutionScopeInternal(issuer, scope).cwd,
    '/managed/worktree',
  );
  assert.throws(
    () => requireManagedWorkspaceExecutionScopeInternal(otherOwner, scope),
    (error) =>
      error instanceof ManagedWorkspaceExecutionAuthorityError &&
      error.code === 'managed_workspace_execution_scope_invalid',
  );

  revokeManagedWorkspaceExecutionScopeInternal(issuer, scope);
  assert.throws(
    () => requireManagedWorkspaceExecutionScopeInternal(issuer, scope),
    (error) =>
      error instanceof ManagedWorkspaceExecutionAuthorityError &&
      error.code === 'managed_workspace_execution_scope_expired',
  );
});
