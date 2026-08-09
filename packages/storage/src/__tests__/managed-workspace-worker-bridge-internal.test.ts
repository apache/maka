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
import { join } from 'node:path';
import test from 'node:test';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import {
  issueManagedWorkspaceExecutionScopeInternal,
  revokeManagedWorkspaceExecutionScopeInternal,
} from '../managed-workspace-execution-authority-internal.js';
import {
  createManagedWorkspaceWorkerBridgeInternal,
  ManagedWorkspaceWorkerBridgeError,
  type ManagedWorkspaceReadOnlyOperation,
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

function dependencyScopeFor(ownerToken: object, dependencyRoot: string) {
  return issueManagedWorkspaceExecutionScopeInternal(ownerToken, {
    provisioning: 'dependency_environment_v1',
    workspaceEffect: 'none',
    cwd: '/managed/worktree',
    dependencyRoot,
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

test('routes logical node_modules reads through the leased dependency root', async () => {
  const ownerToken = {};
  const dependencyRoot = join('/maka', 'dependencies', 'environment', 'node_modules');
  const calls: Array<{ operation: ManagedWorkspaceReadOnlyOperation; cwd: string }> = [];
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute(input) {
      calls.push({ operation: input.operation, cwd: input.cwd });
      return input.operation.kind === 'glob'
        ? { kind: 'glob', files: [join('fixture-package', 'index.js')] }
        : { kind: 'read', content: 'maka-owned' };
    },
  });
  const scope = dependencyScopeFor(ownerToken, dependencyRoot);

  assert.deepEqual(
    await bridge.execute(scope, {
      kind: 'read',
      path: 'node_modules/fixture-package/index.js',
    }),
    { kind: 'read', content: 'maka-owned' },
  );
  assert.deepEqual(
    await bridge.execute(scope, {
      kind: 'glob',
      path: 'node_modules',
      pattern: '**/*.js',
    }),
    { kind: 'glob', files: ['node_modules/fixture-package/index.js'] },
  );
  assert.equal(calls[0]?.cwd, '/managed/worktree');
  assert.equal(
    calls[0]?.operation.kind === 'read' ? calls[0].operation.path : undefined,
    join(dependencyRoot, 'fixture-package', 'index.js'),
  );
  assert.equal(
    calls[1]?.operation.kind === 'glob' ? calls[1].operation.path : undefined,
    dependencyRoot,
  );
});

test('rejects non-canonical dependency paths before worker dispatch', async () => {
  const ownerToken = {};
  let dispatches = 0;
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute() {
      dispatches += 1;
      return { kind: 'read', content: 'unexpected' };
    },
  });
  const scope = dependencyScopeFor(ownerToken, join('/maka', 'dependencies', 'node_modules'));

  for (const path of [
    'node_modules/../outside.txt',
    'node_modules/./fixture.js',
    'foo/../node_modules/rogue.js',
    'node_modules/fixture.js:alternate-stream',
    'node_modules/fixture\0.js',
  ]) {
    await assert.rejects(
      () => bridge.execute(scope, { kind: 'read', path }),
      (error) =>
        error instanceof ManagedWorkspaceWorkerBridgeError &&
        error.code === 'managed_workspace_operation_denied',
    );
  }
  assert.equal(dispatches, 0);
});

test('routes Windows node_modules casing through the dependency lease', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows path identity is case insensitive');
    return;
  }
  const ownerToken = {};
  const dependencyRoot = join('C:\\maka', 'dependencies', 'node_modules');
  let dispatchedPath: string | undefined;
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute(input) {
      dispatchedPath = input.operation.path;
      return { kind: 'read', content: 'maka-owned' };
    },
  });
  const scope = issueManagedWorkspaceExecutionScopeInternal(ownerToken, {
    provisioning: 'dependency_environment_v1',
    workspaceEffect: 'none',
    cwd: 'C:\\managed\\worktree',
    dependencyRoot,
    binding: Object.freeze({}) as never,
    head: Object.freeze({}) as never,
  });

  await bridge.execute(scope, { kind: 'read', path: 'NODE_MODULES/fixture/index.js' });

  assert.equal(dispatchedPath, join(dependencyRoot, 'fixture', 'index.js'));
});

test('never falls back a dependency scope without an exact leased root', async () => {
  const ownerToken = {};
  let dispatches = 0;
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute() {
      dispatches += 1;
      return { kind: 'read', content: 'unexpected' };
    },
  });
  const missingRoot = issueManagedWorkspaceExecutionScopeInternal(ownerToken, {
    provisioning: 'dependency_environment_v1',
    workspaceEffect: 'none',
    cwd: '/managed/worktree',
    binding: Object.freeze({}) as never,
    head: Object.freeze({}) as never,
  });
  const unexpectedRoot = issueManagedWorkspaceExecutionScopeInternal(ownerToken, {
    provisioning: 'canonical_tree_only_v1',
    workspaceEffect: 'none',
    cwd: '/managed/worktree',
    dependencyRoot: '/maka/dependencies/node_modules',
    binding: Object.freeze({}) as never,
    head: Object.freeze({}) as never,
  });

  for (const scope of [missingRoot, unexpectedRoot]) {
    await assert.rejects(
      () => bridge.execute(scope, { kind: 'read', path: 'node_modules/a.js' }),
      (error) =>
        error instanceof ManagedWorkspaceWorkerBridgeError &&
        error.code === 'managed_workspace_operation_denied',
    );
  }
  assert.equal(dispatches, 0);
});
