import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ManagedWorkspaceExecutionHandle,
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

test('preserves an explicit managed dependency provisioning profile through admission', async () => {
  const calls: string[] = [];
  const admissionOptions: unknown[] = [];
  const handle = Object.freeze({ kind: 'managed_workspace_execution_handle_v1' as const });
  const scope = Object.freeze({ kind: 'managed_workspace_execution_scope_v1' as const });
  const managedOwner = fakeManagedOwner({ handle, scope, calls, admissionOptions });
  const composition = createRuntimeHostWorkspaceExecutionComposition({ managedOwner });
  const profile = createManagedWorkspaceExecutionProfile(handle, {
    provisioning: 'dependency_environment_v1',
  });

  await composition.executeReadOnly(profile, { kind: 'read', path: 'node_modules/pkg/index.js' });

  assert.deepEqual(admissionOptions, [{ provisioning: 'dependency_environment_v1' }]);
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
