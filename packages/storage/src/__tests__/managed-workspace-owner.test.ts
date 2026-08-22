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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, before, test } from 'node:test';
import {
  ManagedWorkspaceOwnerError,
  openManagedWorkspaceOwner,
  type ManagedWorkspaceExecutionHandle,
  type ManagedWorkspaceExecutionScope,
} from '../managed-workspace-owner.js';
import {
  managedWorkspaceExecutionAuthorityTestSupport,
  ManagedWorkspaceExecutionAuthorityError,
} from '../managed-workspace-execution-authority-internal.js';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '../root-authority.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const {
  inspectHandle: inspectManagedWorkspaceExecutionHandleInternal,
  inspectScope: inspectManagedWorkspaceExecutionScopeInternal,
} = managedWorkspaceExecutionAuthorityTestSupport;
let gitExecutablePath: string;
let gitExecutableSha256: `sha256:${string}`;

before(async () => {
  gitExecutablePath = await findGitExecutable();
  gitExecutableSha256 = await sha256File(gitExecutablePath);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('admits exactly one managed workspace owner for an interactive root owner', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    const managedOwner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    await assert.rejects(
      openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: gitExecutableSha256,
        },
      }),
      isOwnerError('managed_workspace_owner_conflict'),
    );
    await managedOwner.close();
    await managedOwner.close();
  } finally {
    await rootOwner.close();
  }
});

test('releases a partial owner claim when pinned Git initialization fails', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  try {
    await assert.rejects(
      openManagedWorkspaceOwner({
        rootOwner,
        gitRuntime: {
          executablePath: gitExecutablePath,
          expectedSha256: `sha256:${'0'.repeat(64)}`,
        },
      }),
      isOwnerError('managed_workspace_owner_unavailable'),
    );

    const retry = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    assert.equal(retry.state, 'ready');
    await retry.close();
  } finally {
    await rootOwner.close();
  }
});

test('creates an accepted managed baseline only through the active owner', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const { binding, receipt } = inspectManagedWorkspaceExecutionHandleInternal(
      accepted.executionHandle,
    );

    assert.equal(binding.sourceTreeOid, binding.baselineTreeOid);
    assert.notEqual(binding, receipt.binding);
    assert.deepEqual(binding, receipt.binding);
    assert.equal(existsSync(join(binding.worktreePath, '.maka-workspace.json')), false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('publishes only a revocable execution scope through its accepted handle', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    assert.equal('binding' in accepted, false);
    assert.equal('receipt' in accepted, false);
    let retainedScope: unknown;
    const execution = await owner.withManagedWorkspaceExecution(
      accepted.executionHandle,
      async (scope) => {
        retainedScope = scope;
        assert.equal('cwd' in scope, false);
        assert.equal(scope.kind, 'managed_workspace_execution_scope_v1');
        await assert.rejects(
          () =>
            owner.executeReadOnlyFilesystemOperation(scope, {
              kind: 'read',
              path: 'README.md',
            }),
          (error) =>
            error instanceof ManagedWorkspaceOwnerError &&
            error.code === 'managed_workspace_worker_unavailable',
        );
        return 'admitted';
      },
    );

    assert.equal(execution, 'admitted');
    assert.deepEqual(retainedScope, { kind: 'managed_workspace_execution_scope_v1' });
    assert.throws(
      () =>
        inspectManagedWorkspaceExecutionScopeInternal({
          kind: 'managed_workspace_execution_scope_v1',
        }),
      (error) =>
        error instanceof ManagedWorkspaceExecutionAuthorityError &&
        error.code === 'managed_workspace_execution_scope_invalid',
    );
    assert.throws(
      () =>
        inspectManagedWorkspaceExecutionScopeInternal(
          retainedScope as ManagedWorkspaceExecutionScope,
        ),
      (error) =>
        error instanceof ManagedWorkspaceExecutionAuthorityError &&
        error.code === 'managed_workspace_execution_scope_expired',
    );
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('does not let caller-mutated head state or a shadowed public reader forge execution authority', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const forgedHead = {
      ...accepted.head,
      workspaceVersionId: `version_${'a'.repeat(32)}`,
      commitOid: 'a'.repeat(40),
      treeOid: 'b'.repeat(40),
      revision: accepted.head.revision + 1,
    };
    assert.throws(() => Object.assign(accepted.head, forgedHead), TypeError);
    Object.defineProperty(runtimeStore, 'readWorkspaceHead', {
      configurable: true,
      value: async () => forgedHead,
    });

    await owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
      callbackCalled = true;
      const context = inspectManagedWorkspaceExecutionScopeInternal(scope);
      assert.equal(context.head.workspaceVersionId, accepted.head.workspaceVersionId);
      assert.equal(context.head.commitOid, accepted.head.commitOid);
      assert.equal(context.head.treeOid, accepted.head.treeOid);
    });
    assert.equal(callbackCalled, true);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('quarantines drift introduced after execution artifact verification before publishing cwd', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let executionFailpointArmed = false;
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      async failpoint(point) {
        if (
          executionFailpointArmed &&
          (point as string) === 'after_execution_artifact_verification'
        ) {
          executionFailpointArmed = false;
          const acceptedEvidence = inspectManagedWorkspaceExecutionHandleInternal(
            accepted.executionHandle,
          );
          await writeFile(
            join(acceptedEvidence.binding.worktreePath, 'tracked.txt'),
            'external drift after verification\n',
            'utf8',
          );
        }
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    executionFailpointArmed = true;

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
        callbackCalled = true;
      }),
      isOwnerError('managed_workspace_quarantined'),
    );

    assert.equal(callbackCalled, false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects execution when runtime.sqlite detaches from its canonical path after verification', {
  skip:
    process.platform === 'win32'
      ? 'Open SQLite files cannot be renamed reliably on Windows'
      : false,
}, async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const databasePath = join(storageRoot, 'runtime.sqlite');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(databasePath);
  let executionFailpointArmed = false;
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      async failpoint(point) {
        if (
          executionFailpointArmed &&
          (point as string) === 'after_execution_artifact_verification'
        ) {
          executionFailpointArmed = false;
          await rename(databasePath, `${databasePath}.detached`);
        }
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    executionFailpointArmed = true;

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
        callbackCalled = true;
      }),
      /database file identity changed|belongs to a different storage root/u,
    );
    assert.equal(callbackCalled, false);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects a forged execution handle before invoking the tool callback', async () => {
  const storageRoot = await temporaryRoot();
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  let callbackCalled = false;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });

    await assert.rejects(
      owner.withManagedWorkspaceExecution(
        Object.freeze({
          kind: 'managed_workspace_execution_handle_v1',
        }) as ManagedWorkspaceExecutionHandle,
        async () => {
          callbackCalled = true;
        },
      ),
      isOwnerError('managed_workspace_execution_handle_invalid'),
    );

    assert.equal(callbackCalled, false);
    await owner.close();
  } finally {
    await rootOwner.close();
  }
});

test('rejects an execution handle issued by another managed workspace owner', async () => {
  const root = await temporaryRoot();
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const leftCapability = await resolveStorageRoot({
    path: join(root, 'left-storage'),
    kind: 'interactive',
  });
  const rightCapability = await resolveStorageRoot({
    path: join(root, 'right-storage'),
    kind: 'interactive',
  });
  const leftRootOwner = await tryAcquireInteractiveRootOwner(leftCapability);
  const rightRootOwner = await tryAcquireInteractiveRootOwner(rightCapability);
  assert.ok(leftRootOwner);
  assert.ok(rightRootOwner);
  const leftStore = createSqliteRuntimeStore(join(leftCapability.canonicalPath, 'runtime.sqlite'));
  try {
    const leftOwner = await openManagedWorkspaceOwner({
      rootOwner: leftRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const rightOwner = await openManagedWorkspaceOwner({
      rootOwner: rightRootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await leftOwner.openManagedWorkspaceBaseline(
      leftStore,
      openRequest(sourceRoot),
    );

    await assert.rejects(
      rightOwner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {}),
      isOwnerError('managed_workspace_execution_handle_invalid'),
    );

    await leftOwner.close();
    await rightOwner.close();
  } finally {
    leftStore.close();
    await leftRootOwner.close();
    await rightRootOwner.close();
  }
});

test('drains an admitted managed execution before owner close completes', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseExecution!: () => void;
  const executionMayFinish = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  let executionAdmitted!: () => void;
  const executionStarted = new Promise<void>((resolve) => {
    executionAdmitted = resolve;
  });
  let executing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    executing = owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
      executionAdmitted();
      await executionMayFinish;
    });
    await executionStarted;

    let closeSettled = false;
    closing = owner.close().then(() => {
      closeSettled = true;
    });
    assert.equal(
      await Promise.race([closing.then(() => 'closed'), delay(250, 'pending')]),
      'pending',
    );
    assert.equal(closeSettled, false);
    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {}),
      isOwnerError('managed_workspace_owner_closing'),
    );

    releaseExecution();
    await executing;
    await closing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseExecution();
    await Promise.allSettled([executing, closing].filter((value) => value !== undefined));
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('routes read-only execution through the owner-bound worker bridge', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  const workerCalls: Array<{ cwd: string; operation: { kind: string } }> = [];
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        async execute(input) {
          workerCalls.push(input);
          return { kind: 'read', content: 'ok' };
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
      assert.deepEqual(
        await owner.executeReadOnlyFilesystemOperation(scope, {
          kind: 'read',
          path: 'README.md',
        }),
        { kind: 'read', content: 'ok' },
      );
    });

    assert.equal(workerCalls.length, 1);
    assert.equal(workerCalls[0]?.operation.kind, 'read');
    assert.equal(workerCalls[0]?.cwd.endsWith('worktree'), true);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('revokes the scope and releases owner residency when the filesystem worker fails', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let retainedScope: ManagedWorkspaceExecutionScope | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      filesystemWorker: {
        async execute() {
          throw new Error('simulated filesystem worker crash');
        },
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
        retainedScope = scope;
        return await owner.executeReadOnlyFilesystemOperation(scope, {
          kind: 'read',
          path: 'README.md',
        });
      }),
      /simulated filesystem worker crash/u,
    );

    if (!retainedScope) throw new Error('Execution callback did not expose its scope');
    const expiredScope = retainedScope;
    assert.throws(
      () => inspectManagedWorkspaceExecutionScopeInternal(expiredScope),
      /execution scope has expired/u,
    );
    await owner.close();
    assert.equal(owner.state, 'closed');
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects owner close reentrancy from an active execution callback', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await owner.withManagedWorkspaceExecution(accepted.executionHandle, async () => {
      const disposition = await Promise.race([
        owner.close().then(
          () => 'closed' as const,
          (error: unknown) => error,
        ),
        delay(250, 'pending' as const),
      ]);
      assert.ok(isOwnerError('managed_workspace_owner_reentrant_close')(disposition));
    });

    assert.equal(owner.state, 'ready');
    await owner.close();
    assert.equal(owner.state, 'closed');
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('allows concurrent read-only scopes for one handle and close drains both', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseSecond!: () => void;
  const secondReleased = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let bothAdmitted!: () => void;
  const bothScopesActive = new Promise<void>((resolve) => {
    bothAdmitted = resolve;
  });
  let activeScopes = 0;
  let executions: Promise<void>[] = [];
  let closing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const execute = (released: Promise<void>) =>
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
        assert.equal(inspectManagedWorkspaceExecutionScopeInternal(scope).workspaceEffect, 'none');
        activeScopes += 1;
        if (activeScopes === 2) bothAdmitted();
        await released;
        activeScopes -= 1;
      });

    executions = [execute(firstReleased), execute(secondReleased)];
    assert.equal(
      await Promise.race([bothScopesActive.then(() => 'active'), delay(20_000, 'timeout')]),
      'active',
    );
    assert.equal(activeScopes, 2);

    closing = owner.close();
    assert.equal(
      await Promise.race([closing.then(() => 'closed'), delay(250, 'pending')]),
      'pending',
    );
    releaseFirst();
    assert.equal(
      await Promise.race([closing.then(() => 'closed'), delay(250, 'pending')]),
      'pending',
    );
    releaseSecond();
    await Promise.all(executions);
    await closing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseFirst();
    releaseSecond();
    await Promise.allSettled([...executions, closing].filter((value) => value !== undefined));
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('expires the execution scope and releases owner residency when its callback rejects', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let retainedScope: ManagedWorkspaceExecutionScope | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );

    await assert.rejects(
      owner.withManagedWorkspaceExecution(accepted.executionHandle, async (scope) => {
        retainedScope = scope;
        throw new Error('simulated managed tool failure');
      }),
      /simulated managed tool failure/u,
    );
    if (!retainedScope) throw new Error('Execution callback did not expose its scope');
    const expiredScope = retainedScope;
    assert.throws(
      () => inspectManagedWorkspaceExecutionScopeInternal(expiredScope),
      /execution scope has expired/u,
    );
    await owner.close();
    assert.equal(owner.state, 'closed');
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('drains an admitted workspace operation before closing and rejects new work', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  let releaseOperation!: () => void;
  const operationMayFinish = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  let operationAdmitted!: () => void;
  const operationReachedFailpoint = new Promise<void>((resolve) => {
    operationAdmitted = resolve;
  });
  let creating:
    | ReturnType<
        Awaited<ReturnType<typeof openManagedWorkspaceOwner>>['openManagedWorkspaceBaseline']
      >
    | undefined;
  let closing: Promise<void> | undefined;
  let rootClosing: Promise<void> | undefined;
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
      failpoint: async (point) => {
        if (point !== 'after_worktree_materialized') return;
        operationAdmitted();
        await operationMayFinish;
      },
    });
    creating = owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot));
    await operationReachedFailpoint;

    let closeSettled = false;
    closing = owner.close().then(() => {
      closeSettled = true;
    });
    let rootCloseSettled = false;
    rootClosing = rootOwner.close().then(() => {
      rootCloseSettled = true;
    });
    const rootCloseDisposition = await Promise.race([
      rootClosing.then(() => 'closed' as const),
      delay(250, 'pending' as const),
    ]);

    assert.equal(owner.state, 'closing');
    assert.equal(closeSettled, false);
    assert.equal(rootCloseSettled, false);
    assert.equal(rootCloseDisposition, 'pending');
    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      isOwnerError('managed_workspace_owner_closing'),
    );

    releaseOperation();
    await creating;
    await closing;
    await rootClosing;
    assert.equal(owner.state, 'closed');
  } finally {
    releaseOperation();
    await Promise.allSettled(
      [creating, closing, rootClosing].filter((value) => value !== undefined),
    );
    runtimeStore.close();
    await rootOwner.close();
  }
});

test('rejects external drift instead of reopening a non-ready workspace', async () => {
  const root = await temporaryRoot();
  const storageRoot = join(root, 'storage');
  const sourceRoot = await createEligibleSource(join(root, 'source'));
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'interactive' });
  const rootOwner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(rootOwner);
  const runtimeStore = createSqliteRuntimeStore(join(storageRoot, 'runtime.sqlite'));
  try {
    const owner = await openManagedWorkspaceOwner({
      rootOwner,
      gitRuntime: {
        executablePath: gitExecutablePath,
        expectedSha256: gitExecutableSha256,
      },
    });
    const accepted = await owner.openManagedWorkspaceBaseline(
      runtimeStore,
      openRequest(sourceRoot),
    );
    const { binding } = inspectManagedWorkspaceExecutionHandleInternal(accepted.executionHandle);
    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'external drift\n', 'utf8');

    await assert.rejects(
      owner.openManagedWorkspaceBaseline(runtimeStore, openRequest(sourceRoot)),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'GitWorkspaceServiceError' &&
        'code' in error &&
        error.code === 'managed_workspace_drifted',
    );

    assert.equal(existsSync(binding.worktreePath), true);
    await owner.close();
  } finally {
    runtimeStore.close();
    await rootOwner.close();
  }
});

function isOwnerError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ManagedWorkspaceOwnerError && error.code === code;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-managed-workspace-owner-'));
  cleanup.push(root);
  return root;
}

async function findGitExecutable(): Promise<string> {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFileAsync(command, ['git'], { encoding: 'utf8' });
  const first = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error('Git executable is unavailable for integration tests');
  return realpath(first);
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function createEligibleSource(sourceRoot: string): Promise<string> {
  await mkdir(sourceRoot, { recursive: true });
  await git(sourceRoot, 'init', '--quiet');
  await writeFile(join(sourceRoot, 'tracked.txt'), 'tracked\n', 'utf8');
  await writeFile(join(sourceRoot, '.gitignore'), '.maka-workspace.json\n', 'utf8');
  await writeFile(join(sourceRoot, '.maka-workspace.json'), '{"host":"metadata"}\n', 'utf8');
  await git(sourceRoot, 'add', 'tracked.txt', '.gitignore');
  await git(
    sourceRoot,
    '-c',
    'user.name=Maka Test',
    '-c',
    'user.email=test@maka.invalid',
    'commit',
    '--quiet',
    '-m',
    'source baseline',
  );
  return realpath(sourceRoot);
}

function openRequest(sourceRoot: string) {
  return {
    repositoryId: 'repository_11111111111111111111111111111111',
    workspaceId: 'workspace_22222222222222222222222222222222',
    workspaceEpochId: 'epoch_33333333333333333333333333333333',
    workspaceInstanceId: 'instance_44444444444444444444444444444444',
    sourceRoot,
  } as const;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}
