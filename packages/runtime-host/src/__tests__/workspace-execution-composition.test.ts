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
import type {
  ManagedWorkspaceExecutionHandle,
  ManagedWorkspaceExecutionOptions,
  ManagedWorkspaceExecutionScope,
  ManagedWorkspaceOwner,
} from '@maka/storage/managed-workspace-owner';
import {
  createAttachedWorkspaceExecutionProfile,
  createManagedWorkspaceExecutionProfile,
  createRuntimeHostWorkspaceExecutionComposition,
  RuntimeHostWorkspaceExecutionError,
} from '../server/workspace-execution-composition.js';

test('keeps attached and managed execution profiles explicit', async () => {
  const calls: string[] = [];
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  const scope = Object.freeze({ kind: 'managed_workspace_execution_scope_v1' as const });
  const managedOwner = fakeManagedOwner({ handle, scope, calls });
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    filesystemWorker: {
      async execute(input) {
        calls.push(`worker:${input.cwd}:${input.operation.kind}`);
        return { kind: 'read', content: 'attached' };
      },
    },
    managedOwner,
  });

  const attached = createAttachedWorkspaceExecutionProfile('/attached');
  assert.deepEqual(
    await composition.executeReadOnly(attached, { kind: 'read', path: 'README.md' }),
    { kind: 'read', content: 'attached' },
  );

  const managed = createManagedWorkspaceExecutionProfile(handle);
  assert.deepEqual(
    await composition.executeReadOnly(managed, { kind: 'read', path: 'README.md' }),
    { kind: 'read', content: 'managed' },
  );
  assert.deepEqual(calls, ['worker:/attached:read', 'managed:admit', 'managed:read']);

  await composition.close();
});

test('never falls back a managed profile to attached execution', async () => {
  let workerCalls = 0;
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    filesystemWorker: {
      async execute() {
        workerCalls += 1;
        return { kind: 'read', content: 'unsafe fallback' };
      },
    },
  });
  const managed = createManagedWorkspaceExecutionProfile(
    Object.freeze({ kind: 'managed_workspace_execution_handle_v1' }),
  );

  await assert.rejects(
    () => composition.executeReadOnly(managed, { kind: 'read', path: 'README.md' }),
    (error) =>
      error instanceof RuntimeHostWorkspaceExecutionError &&
      error.code === 'managed_workspace_profile_unavailable',
  );
  assert.equal(workerCalls, 0);
  await composition.close();
});

test('preserves explicit dependency provisioning through managed admission', async () => {
  const calls: string[] = [];
  const admissionOptions: unknown[] = [];
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  const scope = Object.freeze({ kind: 'managed_workspace_execution_scope_v1' as const });
  const managedOwner = fakeManagedOwner({ handle, scope, calls, admissionOptions });
  const composition = createRuntimeHostWorkspaceExecutionComposition({ managedOwner });
  const profile = createManagedWorkspaceExecutionProfile(handle, {
    provisioning: 'dependency_environment_v1',
  });
  const abort = new AbortController();

  await composition.executeReadOnly(
    profile,
    {
      kind: 'read',
      path: 'node_modules/fixture/index.js',
    },
    abort.signal,
  );

  assert.deepEqual(admissionOptions, [
    { provisioning: 'dependency_environment_v1', abortSignal: abort.signal },
  ]);
  await composition.close();
});

test('opens a managed profile through the authenticated production stores', async () => {
  const calls: string[] = [];
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  const scope = Object.freeze({ kind: 'managed_workspace_execution_scope_v1' as const });
  const managedOwner = fakeManagedOwner({ handle, scope, calls });
  const executionStores = Object.freeze({}) as never;
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    managedOwner,
    executionStores,
  });

  const profile = await composition.openManagedWorkspace(
    {
      repositoryId: 'repository_11111111111111111111111111111111',
      workspaceId: 'workspace_22222222222222222222222222222222',
      workspaceEpochId: 'epoch_33333333333333333333333333333333',
      workspaceInstanceId: 'instance_44444444444444444444444444444444',
      sourceRoot: '/source',
    },
    { provisioning: 'dependency_environment_v1' },
  );

  assert.deepEqual(profile, {
    kind: 'managed_worktree_v1',
    executionHandle: handle,
    provisioning: 'dependency_environment_v1',
  });
  assert.deepEqual(calls, ['managed:open']);
  await composition.close();
});

test('rejects forged or malformed profiles before worker dispatch', async () => {
  let workerCalls = 0;
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    filesystemWorker: {
      async execute() {
        workerCalls += 1;
        return { kind: 'read', content: 'unsafe' };
      },
    },
  });

  for (const profile of [
    { kind: 'unknown_profile', cwd: '/attached' },
    { kind: 'attached_checkout_v1', cwd: '' },
  ]) {
    await assert.rejects(
      () =>
        composition.executeReadOnly(profile as never, {
          kind: 'read',
          path: 'README.md',
        }),
      (error) =>
        error instanceof RuntimeHostWorkspaceExecutionError &&
        error.code === 'workspace_operation_denied',
    );
  }
  assert.equal(workerCalls, 0);
  await composition.close();
});

test('drains tool operations before closing the managed owner', async () => {
  const calls: string[] = [];
  let releaseWorker!: () => void;
  const workerBlocked = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  const scope = Object.freeze({ kind: 'managed_workspace_execution_scope_v1' as const });
  const managedOwner = fakeManagedOwner({ handle, scope, calls, workerBlocked });
  const composition = createRuntimeHostWorkspaceExecutionComposition({ managedOwner });
  const profile = createManagedWorkspaceExecutionProfile(handle);

  const executing = composition.executeReadOnly(profile, { kind: 'read', path: 'README.md' });
  await waitFor(() => calls.includes('managed:read'));
  const closing = composition.close();
  await assert.rejects(
    () => composition.executeReadOnly(profile, { kind: 'read', path: 'other.md' }),
    (error) =>
      error instanceof RuntimeHostWorkspaceExecutionError &&
      error.code === 'workspace_execution_draining',
  );
  assert.equal(calls.includes('managed:close'), false);

  releaseWorker();
  await executing;
  await closing;
  assert.deepEqual(calls, ['managed:admit', 'managed:read', 'managed:close']);
});

test('caller cancellation releases a provisioning operation so drain can close', async () => {
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  let acknowledgeProvision!: () => void;
  const provisionStarted = new Promise<void>((resolve) => {
    acknowledgeProvision = resolve;
  });
  let closed = false;
  const managedOwner: ManagedWorkspaceOwner = {
    state: 'ready',
    async openManagedWorkspaceBaseline() {
      throw new Error('not used');
    },
    async openManagedWorkspaceBaselineFromExecutionStores() {
      throw new Error('not used');
    },
    async withManagedWorkspaceExecution<T>(
      _handle: ManagedWorkspaceExecutionHandle,
      _operation: (scope: ManagedWorkspaceExecutionScope) => Promise<T>,
      options?: ManagedWorkspaceExecutionOptions,
    ): Promise<T> {
      acknowledgeProvision();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(
            options?.abortSignal?.reason ??
              new DOMException('Managed execution cancelled', 'AbortError'),
          );
        if (options?.abortSignal?.aborted) abort();
        else options?.abortSignal?.addEventListener('abort', abort, { once: true });
      });
    },
    async executeReadOnlyFilesystemOperation() {
      throw new Error('worker must not run while provisioning is pending');
    },
    async close() {
      closed = true;
    },
  };
  const composition = createRuntimeHostWorkspaceExecutionComposition({ managedOwner });
  const profile = createManagedWorkspaceExecutionProfile(handle, {
    provisioning: 'dependency_environment_v1',
  });
  const abort = new AbortController();
  const execution = composition.executeReadOnly(
    profile,
    { kind: 'read', path: 'node_modules/fixture/index.js' },
    abort.signal,
  );
  await provisionStarted;

  composition.beginDrain();
  const closing = composition.close();
  abort.abort(new DOMException('User cancelled managed execution', 'AbortError'));

  await assert.rejects(execution, { name: 'AbortError' });
  await closing;
  assert.equal(closed, true);
});

test('caller cancellation releases baseline admission so drain can close', async () => {
  let acknowledgeAdmission!: () => void;
  const admissionStarted = new Promise<void>((resolve) => {
    acknowledgeAdmission = resolve;
  });
  let closed = false;
  const managedOwner: ManagedWorkspaceOwner = {
    state: 'ready',
    async openManagedWorkspaceBaseline() {
      throw new Error('not used');
    },
    async openManagedWorkspaceBaselineFromExecutionStores(_stores, _input, options) {
      acknowledgeAdmission();
      return await new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(
            options?.abortSignal?.reason ??
              new DOMException('Managed baseline admission cancelled', 'AbortError'),
          );
        if (options?.abortSignal?.aborted) abort();
        else options?.abortSignal?.addEventListener('abort', abort, { once: true });
      });
    },
    async withManagedWorkspaceExecution() {
      throw new Error('not used');
    },
    async executeReadOnlyFilesystemOperation() {
      throw new Error('not used');
    },
    async close() {
      closed = true;
    },
  };
  const composition = createRuntimeHostWorkspaceExecutionComposition({
    managedOwner,
    executionStores: Object.freeze({}) as never,
  });
  const abort = new AbortController();
  const admission = composition.openManagedWorkspace(
    {
      repositoryId: 'repository_11111111111111111111111111111111',
      workspaceId: 'workspace_22222222222222222222222222222222',
      workspaceEpochId: 'epoch_33333333333333333333333333333333',
      workspaceInstanceId: 'instance_44444444444444444444444444444444',
      sourceRoot: '/source',
    },
    { provisioning: 'dependency_environment_v1', abortSignal: abort.signal },
  );
  await admissionStarted;

  const closing = composition.close();
  abort.abort(new DOMException('User cancelled baseline admission', 'AbortError'));

  await assert.rejects(admission, { name: 'AbortError' });
  await closing;
  assert.equal(closed, true);
});

function fakeManagedOwner(input: {
  handle: ManagedWorkspaceExecutionHandle;
  scope: ManagedWorkspaceExecutionScope;
  calls: string[];
  workerBlocked?: Promise<void>;
  admissionOptions?: unknown[];
}): ManagedWorkspaceOwner {
  return {
    state: 'ready',
    async openManagedWorkspaceBaseline() {
      throw new Error('not used');
    },
    async openManagedWorkspaceBaselineFromExecutionStores() {
      input.calls.push('managed:open');
      return {
        created: true,
        head: Object.freeze({}) as never,
        executionHandle: input.handle,
      };
    },
    async withManagedWorkspaceExecution(handle, operation, options) {
      assert.equal(handle, input.handle);
      input.admissionOptions?.push(options);
      input.calls.push('managed:admit');
      return await operation(input.scope);
    },
    async executeReadOnlyFilesystemOperation(scope) {
      assert.equal(scope, input.scope);
      input.calls.push('managed:read');
      await input.workerBlocked;
      return { kind: 'read', content: 'managed' };
    },
    async close() {
      input.calls.push('managed:close');
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
