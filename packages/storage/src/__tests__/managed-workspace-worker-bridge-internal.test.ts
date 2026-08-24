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
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import {
  issueManagedWorkspaceExecutionScopeInternal,
  revokeManagedWorkspaceExecutionScopeInternal,
} from '../managed-workspace-execution-authority-internal.js';
import {
  createManagedWorkspaceWorkerBridgeInternal,
  ManagedWorkspaceWorkerBridgeError,
} from '../managed-workspace-worker-bridge-internal.js';

function scopeFor(ownerToken: object) {
  return issueManagedWorkspaceExecutionScopeInternal(ownerToken, {
    provisioning: 'canonical_tree_only_v1',
    workspaceEffect: 'none',
    cwd: '/managed/worktree',
    binding: Object.freeze({}) as never,
    head: Object.freeze({}) as never,
  });
}

test('injects the owner-bound cwd and read-only boundary for allowed operations', async () => {
  const ownerToken = {};
  const calls: unknown[] = [];
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute(input) {
      calls.push(input);
      switch (input.operation.kind) {
        case 'read':
          return { kind: 'read', content: 'ok' };
        case 'glob':
          return { kind: 'glob', files: [] };
        case 'grep':
          return { kind: 'grep', matches: [] };
      }
    },
  });
  const scope = scopeFor(ownerToken);

  assert.deepEqual(await bridge.execute(scope, { kind: 'read', path: 'README.md' }), {
    kind: 'read',
    content: 'ok',
  });
  assert.deepEqual(await bridge.execute(scope, { kind: 'glob', path: '.', pattern: '**/*.ts' }), {
    kind: 'glob',
    files: [],
  });
  assert.deepEqual(
    await bridge.execute(scope, {
      kind: 'grep',
      path: '.',
      pattern: 'TODO',
      maxCountPerFile: 10,
      limit: 100,
      timeoutMs: 1_000,
    }),
    { kind: 'grep', matches: [] },
  );

  for (const call of calls as Array<{
    cwd: string;
    executionBoundary: unknown;
  }>) {
    assert.equal(call.cwd, '/managed/worktree');
    assert.deepEqual(call.executionBoundary, {
      kind: 'managed',
      profile: createReadOnlyPermissionProfile(),
      revision: 0,
    });
  }
});

test('rejects foreign, expired, mutating, and unknown operations before worker dispatch', async () => {
  const ownerToken = {};
  let dispatches = 0;
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute() {
      dispatches += 1;
      return { kind: 'read', content: 'unexpected' };
    },
  });
  const foreignScope = scopeFor({});
  await assert.rejects(() => bridge.execute(foreignScope, { kind: 'read', path: 'README.md' }));

  const expiredScope = scopeFor(ownerToken);
  revokeManagedWorkspaceExecutionScopeInternal(ownerToken, expiredScope);
  await assert.rejects(() => bridge.execute(expiredScope, { kind: 'read', path: 'README.md' }));

  const activeScope = scopeFor(ownerToken);
  for (const operation of [
    { kind: 'write', path: 'a.txt', content: 'unsafe' },
    { kind: 'edit', path: 'a.txt', oldString: 'a', newString: 'b' },
    { kind: 'format_json', path: 'a.json', sortKeys: true },
    { kind: 'unknown', path: '.' },
  ]) {
    await assert.rejects(
      () => bridge.execute(activeScope, operation as never),
      (error) =>
        error instanceof ManagedWorkspaceWorkerBridgeError &&
        error.code === 'managed_workspace_operation_denied',
    );
  }
  assert.equal(dispatches, 0);
});
