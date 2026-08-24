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
