import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createReadOnlyPermissionProfile } from '@maka/core';
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

test('routes relative and cwd-absolute dependency paths through the owner-bound environment', async () => {
  const ownerToken = {};
  const dependencyRoot = join('/maka', 'dependency-environment', 'node_modules');
  const routedPaths: string[] = [];
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute(input) {
      routedPaths.push(input.operation.path);
      if (input.operation.kind === 'glob') {
        return { kind: 'glob', files: [join(dependencyRoot, 'fixture', 'index.js')] };
      }
      return { kind: 'read', content: 'trusted' };
    },
  });
  const scope = dependencyScopeFor(ownerToken, dependencyRoot);

  await bridge.execute(scope, { kind: 'read', path: 'node_modules/fixture/index.js' });
  await bridge.execute(scope, {
    kind: 'read',
    path: join('/managed/worktree', 'node_modules', 'fixture', 'index.js'),
  });
  const glob = await bridge.execute(scope, {
    kind: 'glob',
    path: 'node_modules',
    pattern: '**/*.js',
  });

  assert.deepEqual(routedPaths, [
    join(dependencyRoot, 'fixture', 'index.js'),
    join(dependencyRoot, 'fixture', 'index.js'),
    dependencyRoot,
  ]);
  assert.deepEqual(glob, { kind: 'glob', files: ['node_modules/fixture/index.js'] });
});

test('rejects dependency traversal before worker dispatch', async () => {
  const ownerToken = {};
  let dispatches = 0;
  const bridge = createManagedWorkspaceWorkerBridgeInternal(ownerToken, {
    async execute() {
      dispatches += 1;
      return { kind: 'read', content: 'unexpected' };
    },
  });
  const scope = dependencyScopeFor(ownerToken, join('/maka', 'environment', 'node_modules'));

  await assert.rejects(
    bridge.execute(scope, { kind: 'read', path: 'node_modules/../outside.txt' }),
    (error) =>
      error instanceof ManagedWorkspaceWorkerBridgeError &&
      error.code === 'managed_workspace_operation_denied',
  );
  assert.equal(dispatches, 0);
});
