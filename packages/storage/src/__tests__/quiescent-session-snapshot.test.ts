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
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createFileSessionSnapshotStagingCleanupAuthority,
  createFileQuiescentSessionSnapshotCoordinator,
  type SessionSnapshotCancellation,
  SessionSnapshotError,
  type SessionSnapshotQuiescenceAuthority,
  type SessionSnapshotStatePreparer,
  type SessionSnapshotStagingCleanupAuthority,
  type SessionSnapshotWorkspacePreparation,
  type SessionSnapshotWorkspacePreparer,
  SESSION_SNAPSHOT_WORKSPACE_POLICY_V1,
} from '../quiescent-session-snapshot.js';
import {
  acquireProcessLifetimeOwner,
  type ProcessLifetimeOwner,
} from '../process-lifetime-owner.js';

const roots: string[] = [];
const processLifetimeOwners: ProcessLifetimeOwner[] = [];

afterEach(async () => {
  await Promise.all(processLifetimeOwners.splice(0).map((owner) => owner.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('prepares state and workspace under one quiescence boundary, then releases live writers', async () => {
  const fixture = await createFixture();
  await writeFile(join(fixture.liveStateRoot, 'runtime.sqlite'), 'state-at-boundary', 'utf8');
  await writeFile(join(fixture.liveWorkspaceRoot, 'main.ts'), 'workspace-at-boundary', 'utf8');
  const events: string[] = [];
  let quiescent = false;

  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        assert.equal(quiescent, false);
        quiescent = true;
        events.push('enter');
        try {
          return await operation();
        } finally {
          quiescent = false;
          events.push('exit');
        }
      },
    },
    state: {
      async prepareState(input) {
        assert.equal(quiescent, true);
        events.push('state');
        await mkdir(input.destinationRoot);
        await copyFile(
          join(fixture.liveStateRoot, 'runtime.sqlite'),
          join(input.destinationRoot, 'runtime.sqlite'),
        );
        return {
          mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
          bytes: Buffer.from('{"makaSessionId":"session-1"}', 'utf8'),
        };
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        assert.equal(quiescent, true);
        assert.equal(input.policy, SESSION_SNAPSHOT_WORKSPACE_POLICY_V1);
        events.push('workspace');
        await mkdir(input.destinationRoot);
        await copyFile(
          join(fixture.liveWorkspaceRoot, 'main.ts'),
          join(input.destinationRoot, 'main.ts'),
        );
        return workspaceResult({ includedEntries: 1 });
      },
    },
  }).prepare({ makaSessionId: 'session-1' });

  assert.deepEqual(events, ['enter', 'state', 'workspace', 'exit']);
  assert.equal(quiescent, false);
  assert.notEqual(handle.snapshot.stateRoot, fixture.liveStateRoot);
  assert.notEqual(handle.snapshot.workspaceRoot, fixture.liveWorkspaceRoot);
  assert.equal(
    await readFile(join(handle.snapshot.stateRoot, 'runtime.sqlite'), 'utf8'),
    'state-at-boundary',
  );
  assert.equal(
    await readFile(join(handle.snapshot.workspaceRoot, 'main.ts'), 'utf8'),
    'workspace-at-boundary',
  );

  await writeFile(join(fixture.liveStateRoot, 'runtime.sqlite'), 'later-state', 'utf8');
  await writeFile(join(fixture.liveWorkspaceRoot, 'main.ts'), 'later-workspace', 'utf8');
  assert.equal(
    await readFile(join(handle.snapshot.stateRoot, 'runtime.sqlite'), 'utf8'),
    'state-at-boundary',
  );
  assert.equal(
    await readFile(join(handle.snapshot.workspaceRoot, 'main.ts'), 'utf8'),
    'workspace-at-boundary',
  );
  assert.deepEqual(handle.workspace, workspaceResult({ includedEntries: 1 }));

  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const cleanupRename = interceptSnapshotCleanupRename(publishedRoot, async () => {
    await mkdir(publishedRoot, { mode: 0o700 });
    await writeFile(join(publishedRoot, 'replacement.txt'), 'keep', 'utf8');
  });
  await Promise.all([handle.release(), handle.release()]);
  await cleanupRename.completed;
  assert.equal(await readFile(join(publishedRoot, 'replacement.txt'), 'utf8'), 'keep');
  await rm(publishedRoot, { recursive: true });
  await handle.release();
});

test('serializes concurrent preparations for the same Session through the authority contract', async () => {
  const fixture = await createFixture();
  const authority = new SerialQuiescenceAuthority();
  const firstWorkspaceEntered = deferred<void>();
  const allowFirstWorkspace = deferred<void>();
  let statePreparations = 0;

  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: authority,
    state: {
      async prepareState(input) {
        statePreparations += 1;
        await mkdir(input.destinationRoot);
        return stateIdentity(input.makaSessionId);
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        await mkdir(input.destinationRoot);
        if (statePreparations === 1) {
          firstWorkspaceEntered.resolve();
          await allowFirstWorkspace.promise;
        }
        return workspaceResult();
      },
    },
  });

  const first = coordinator.prepare({ makaSessionId: 'same-session' });
  await firstWorkspaceEntered.promise;
  const second = coordinator.prepare({ makaSessionId: 'same-session' });
  await Promise.resolve();
  assert.equal(statePreparations, 1);
  assert.deepEqual(authority.activeSessions, ['same-session']);

  allowFirstWorkspace.resolve();
  const firstHandle = await first;
  const secondHandle = await second;
  assert.equal(statePreparations, 2);
  assert.equal(authority.maximumConcurrentBySession.get('same-session'), 1);
  await Promise.all([firstHandle.release(), secondHandle.release()]);
});

test('does not globally serialize preparations for different Sessions', async () => {
  const fixture = await createFixture();
  const authority = new SerialQuiescenceAuthority();
  const firstWorkspaceEntered = deferred<void>();
  const allowFirstWorkspace = deferred<void>();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: authority,
    state: directoryStatePreparer,
    workspace: {
      async prepareWorkspace(input) {
        await mkdir(input.destinationRoot);
        if (input.makaSessionId === 'session-a') {
          firstWorkspaceEntered.resolve();
          await allowFirstWorkspace.promise;
        }
        return workspaceResult();
      },
    },
  });

  const first = coordinator.prepare({ makaSessionId: 'session-a' });
  await firstWorkspaceEntered.promise;
  const secondHandle = await coordinator.prepare({ makaSessionId: 'session-b' });
  assert.deepEqual(authority.activeSessions, ['session-a']);
  assert.equal(authority.maximumConcurrentBySession.get('session-a'), 1);
  assert.equal(authority.maximumConcurrentBySession.get('session-b'), 1);

  allowFirstWorkspace.resolve();
  const firstHandle = await first;
  await Promise.all([firstHandle.release(), secondHandle.release()]);
});

test('removes partial staging and preserves a stable policy rejection', async () => {
  const fixture = await createFixture();
  const rejection = new SessionSnapshotError(
    'policy_rejected',
    'Workspace snapshot policy rejected an entry',
    { details: { phase: 'workspace', policyCategory: 'known_secret_file' } },
  );
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: {
      async prepareState(input) {
        await mkdir(input.destinationRoot);
        await writeFile(join(input.destinationRoot, 'runtime.sqlite'), 'partial', 'utf8');
        return stateIdentity(input.makaSessionId);
      },
    },
    workspace: {
      async prepareWorkspace() {
        throw rejection;
      },
    },
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'session-secret' }),
    (error: unknown) => error === rejection,
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
  assert.equal(rejection.message.includes('.env'), false);
});

test('failure cleanup refuses a staging root replaced by an unrelated directory', async () => {
  const fixture = await createFixture();
  let unrelatedFile = '';
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: {
      async prepareWorkspace(input) {
        const preparingRoot = dirname(input.destinationRoot);
        await rename(preparingRoot, `${preparingRoot}.displaced`);
        await mkdir(preparingRoot, { mode: 0o700 });
        unrelatedFile = join(preparingRoot, 'unrelated.txt');
        await writeFile(unrelatedFile, 'keep', 'utf8');
        throw new Error('workspace preparation failed');
      },
    },
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'failure-cleanup-owner' }),
    (error: unknown) => {
      assert.equal(error instanceof SessionSnapshotError && error.code, 'io_failure');
      assert.deepEqual(error instanceof SessionSnapshotError && error.details, {
        cleanupFailed: true,
      });
      return true;
    },
  );
  assert.equal(await readFile(unrelatedFile, 'utf8'), 'keep');
});

test('cleans a published snapshot when the authority fails while releasing quiescence', async () => {
  const fixture = await createFixture();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        await operation();
        throw new Error('authority release failed');
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'session-release-failure' }),
    (error: unknown) =>
      error instanceof SessionSnapshotError &&
      error.code === 'io_failure' &&
      error.message === 'Session snapshot preparation failed',
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('cancellation and an expired deadline stop before staging begins', async () => {
  const fixture = await createFixture();
  let authorityCalls = 0;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    now: () => 10_000,
    quiescence: {
      async runQuiescent(_input, operation) {
        authorityCalls += 1;
        return operation();
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'cancelled', signal: controller.signal }),
    isSnapshotError('snapshot_cancelled'),
  );
  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'expired', deadlineAt: 10_000 }),
    isSnapshotError('snapshot_cancelled'),
  );
  assert.equal(authorityCalls, 0);
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('a deadline beyond the Node timer limit is rescheduled until the absolute time', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const fixture = await createFixture();
  const authorityEntered = deferred<void>();
  let cancellationSignal: AbortSignal | undefined;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    now: Date.now,
    quiescence: {
      async runQuiescent(input) {
        cancellationSignal = input.cancellation.signal;
        authorityEntered.resolve();
        await waitForAbort(input.cancellation);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });
  const timerLimit = 2_147_483_647;
  const preparation = coordinator.prepare({
    makaSessionId: 'long-deadline',
    deadlineAt: timerLimit + 1_000,
  });
  await authorityEntered.promise;

  t.mock.timers.tick(timerLimit);
  assert.equal(cancellationSignal?.aborted, false);
  t.mock.timers.tick(999);
  assert.equal(cancellationSignal?.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(preparation, isSnapshotError('snapshot_cancelled'));
});

test('cancellation while waiting for quiescence is propagated as snapshot_cancelled', async () => {
  const fixture = await createFixture();
  const authorityEntered = deferred<void>();
  const controller = new AbortController();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(input) {
        authorityEntered.resolve();
        await waitForAbort(input.cancellation);
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  const preparation = coordinator.prepare({ makaSessionId: 'waiting', signal: controller.signal });
  await authorityEntered.promise;
  controller.abort();
  await assert.rejects(preparation, isSnapshotError('snapshot_cancelled'));
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('cancellation while leaving quiescence cleans the published snapshot', async () => {
  const fixture = await createFixture();
  const controller = new AbortController();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        const result = await operation();
        controller.abort();
        return result;
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'cancel-after-publish', signal: controller.signal }),
    isSnapshotError('snapshot_cancelled'),
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('an I/O failure racing cancellation remains an I/O failure', async () => {
  const fixture = await createFixture();
  const controller = new AbortController();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: {
      async prepareWorkspace(input) {
        await mkdir(input.destinationRoot);
        controller.abort();
        throw Object.assign(new Error('workspace disk failed'), { code: 'EIO' });
      },
    },
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'io-racing-cancel', signal: controller.signal }),
    (error: unknown) =>
      error instanceof SessionSnapshotError &&
      error.code === 'io_failure' &&
      error.cause instanceof Error &&
      error.cause.message === 'workspace disk failed',
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('release refuses a replacement directory and remains retryable for its owned root', async () => {
  const fixture = await createFixture();
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  }).prepare({ makaSessionId: 'release-owner' });
  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const displacedRoot = `${publishedRoot}.displaced`;
  await rename(publishedRoot, displacedRoot);
  await mkdir(publishedRoot, { mode: 0o700 });
  const unrelated = join(publishedRoot, 'unrelated.txt');
  await writeFile(unrelated, 'keep', 'utf8');

  await assert.rejects(handle.release(), isSnapshotError('cleanup_failed'));
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');

  await rm(publishedRoot, { recursive: true });
  await rename(displacedRoot, publishedRoot);
  await handle.release();
  await assert.rejects(readdir(publishedRoot), isCode('ENOENT'));
});

test('release resumes an interrupted partial cleanup using the external ownership record', async () => {
  const fixture = await createFixture();
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  }).prepare({ makaSessionId: 'partial-release-retry' });
  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const snapshotId = basename(publishedRoot).slice('snapshot-'.length);
  const ownerFile = join(fixture.stagingParent, `.snapshot-${snapshotId}.owner.json`);
  const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as { ownerToken: string };
  const cleanupRoot = join(
    fixture.stagingParent,
    `.snapshot-${snapshotId}.${owner.ownerToken}.cleanup`,
  );

  await rename(publishedRoot, cleanupRoot);
  await rm(join(cleanupRoot, 'state'), { recursive: true });
  await handle.release();

  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('a successor process recovers staging owned by a released process lifetime', async () => {
  const fixture = await createFixture();
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  }).prepare({ makaSessionId: 'orphan-recovery' });
  const publishedRoot = dirname(handle.snapshot.stateRoot);
  const snapshotId = basename(publishedRoot).slice('snapshot-'.length);

  await fixture.processLifetimeOwner.close();
  const successorOwner = await acquireProcessLifetimeOwner(join(fixture.root, 'cleanup-owners'));
  processLifetimeOwners.push(successorOwner);
  const successor = createFileSessionSnapshotStagingCleanupAuthority({
    cleanupStateRoot: join(fixture.root, 'snapshot-cleanup-state'),
    stagingParent: fixture.stagingParent,
    processLifetimeOwner: successorOwner,
    privateStagingRootAuthority,
  });

  assert.deepEqual(await successor.recover(), { removed: [snapshotId], failed: [] });
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('recovery removes an exact preparing root left before its owner record was written', async () => {
  const fixture = await createFixture();
  const lease = {
    snapshotId: '00000000-0000-4000-8000-000000000002',
    ownerToken: '00000000-0000-4000-8000-000000000003',
    makaSessionId: 'orphaned-preparing-root',
  };
  const preparingRoot = join(fixture.stagingParent, `.snapshot-${lease.snapshotId}.preparing`);
  await assert.rejects(
    fixture.stagingCleanup.ownCreation(lease, async () => {
      await mkdir(preparingRoot, { mode: 0o700 });
      throw new Error('simulated process exit before owner record');
    }),
    /simulated process exit/u,
  );

  await fixture.processLifetimeOwner.close();
  const successorOwner = await acquireProcessLifetimeOwner(join(fixture.root, 'cleanup-owners'));
  processLifetimeOwners.push(successorOwner);
  const successor = createFileSessionSnapshotStagingCleanupAuthority({
    cleanupStateRoot: join(fixture.root, 'snapshot-cleanup-state'),
    stagingParent: fixture.stagingParent,
    processLifetimeOwner: successorOwner,
    privateStagingRootAuthority,
  });

  assert.deepEqual(await successor.recover(), {
    removed: [lease.snapshotId],
    failed: [],
  });
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('creation failure cleans only the inode it created and preserves a colliding owner file', async () => {
  const fixture = await createFixture();
  const snapshotId = '00000000-0000-4000-8000-000000000001';
  const ownerFile = join(fixture.stagingParent, `.snapshot-${snapshotId}.owner.json`);
  await writeFile(ownerFile, 'unrelated', 'utf8');
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    newSnapshotId: () => snapshotId,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'create-failure-cleanup' }),
    isSnapshotError('io_failure'),
  );
  assert.equal(await readFile(ownerFile, 'utf8'), 'unrelated');
  assert.deepEqual(await readdir(fixture.stagingParent), [basename(ownerFile)]);
});

test('rejects a caller-supplied workspace policy override instead of downgrading V1 safety', async () => {
  const fixture = await createFixture();
  assert.throws(
    () =>
      createFileQuiescentSessionSnapshotCoordinator({
        stagingParent: fixture.stagingParent,
        stagingCleanup: fixture.stagingCleanup,
        privateStagingRootAuthority,
        quiescence: immediateAuthority,
        state: directoryStatePreparer,
        workspace: directoryWorkspacePreparer,
        policy: {
          version: 1,
          classify: () => ({ kind: 'include' }),
        },
      } as Parameters<typeof createFileQuiescentSessionSnapshotCoordinator>[0]),
    /cannot be overridden/u,
  );
});

test('binds private-root verification to the exact canonical staging path', async () => {
  const fixture = await createFixture();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority: {
      async verifyPrivateStagingRoot() {
        return { canonicalPath: fixture.root };
      },
    },
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'wrong-private-root-attestation' }),
    isSnapshotError('unsafe_source'),
  );
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('verifies and cleans each newly created snapshot directory when platform privacy fails', async () => {
  const fixture = await createFixture();
  let verificationCalls = 0;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority: {
      async verifyPrivateStagingRoot(input) {
        verificationCalls += 1;
        return {
          canonicalPath: verificationCalls === 1 ? input.canonicalPath : fixture.stagingParent,
        };
      },
    },
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'unsafe-created-staging-root' }),
    isSnapshotError('unsafe_source'),
  );
  assert.equal(verificationCalls, 2);
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('requires a caller-provided Windows ACL verifier', {
  skip: process.platform !== 'win32',
}, async () => {
  const fixture = await createFixture();
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'missing-windows-acl-verifier' }),
    isSnapshotError('unsafe_source'),
  );
});

test('requires a private staging parent on POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-snapshot-public-'));
  roots.push(root);
  const stagingParent = join(root, 'staging');
  await mkdir(stagingParent, { mode: 0o755 });
  const processLifetimeOwner = await acquireProcessLifetimeOwner(join(root, 'cleanup-owners'));
  processLifetimeOwners.push(processLifetimeOwner);
  const stagingCleanup = createFileSessionSnapshotStagingCleanupAuthority({
    cleanupStateRoot: join(root, 'snapshot-cleanup-state'),
    stagingParent,
    processLifetimeOwner,
  });
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent,
    stagingCleanup,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'unsafe-parent' }),
    isSnapshotError('unsafe_source'),
  );
  assert.deepEqual(await readdir(stagingParent), []);
});

test('V1 workspace policy includes portable inputs, excludes rebuildable data, and rejects secrets', () => {
  const cases = [
    ['package.json', 'file', { kind: 'include' }],
    ['pnpm-lock.yaml', 'file', { kind: 'include' }],
    ['.maka-workspace.json', 'file', { kind: 'include' }],
    ['.git/config', 'file', { kind: 'exclude', category: 'source_control' }],
    [
      'packages/app/node_modules/pkg/index.js',
      'file',
      { kind: 'exclude', category: 'dependency_tree' },
    ],
    ['.turbo/cache.bin', 'file', { kind: 'exclude', category: 'cache' }],
    ['logs/agent.txt', 'file', { kind: 'exclude', category: 'log' }],
    ['debug.log', 'file', { kind: 'exclude', category: 'log' }],
    ['secrets.log', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.env.log', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/private-key.log', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.maka-runtime/input.json', 'file', { kind: 'exclude', category: 'runtime_scratch' }],
    ['.env.local', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.env.example', 'file', { kind: 'include' }],
    ['.env.template', 'file', { kind: 'include' }],
    ['.env.example.local', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/id_ed25519', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/id_ed25519.pub', 'file', { kind: 'include' }],
    ['keys/id_rsa.pub', 'file', { kind: 'include' }],
    ['credentials.yaml', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['secrets.json', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['src/secrets.ts', 'file', { kind: 'include' }],
    ['docs/secrets.md', 'file', { kind: 'include' }],
    ['private', 'file', { kind: 'include' }],
    ['.terraformrc', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.git-credentials.lock', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/client-private-key.pem', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['certs/client.p12', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['certs/client.crt', 'file', { kind: 'include' }],
    ['certs/client.cer', 'file', { kind: 'include' }],
    ['certs/client.csr', 'file', { kind: 'include' }],
    ['certs/client.pem', 'file', { kind: 'include' }],
    ['certs/client.der', 'file', { kind: 'include' }],
    ['privkey.pem', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['private.pem', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['keys/service-account.json', 'file', { kind: 'reject', category: 'known_secret_file' }],
    [
      'secrets',
      'directory',
      { kind: 'confirm', category: 'suspected_secret_path', confirmationPath: 'secrets' },
    ],
    [
      'secrets/token',
      'file',
      { kind: 'confirm', category: 'suspected_secret_path', confirmationPath: 'secrets' },
    ],
    [
      'credentials/oauth.json',
      'file',
      { kind: 'confirm', category: 'suspected_secret_path', confirmationPath: 'credentials' },
    ],
    [
      'private/token',
      'file',
      { kind: 'confirm', category: 'suspected_secret_path', confirmationPath: 'private' },
    ],
    [
      'config/credentials/production.yml.enc',
      'file',
      {
        kind: 'confirm',
        category: 'suspected_secret_path',
        confirmationPath: 'config/credentials',
      },
    ],
    [
      'include/private/header.h',
      'file',
      {
        kind: 'confirm',
        category: 'suspected_secret_path',
        confirmationPath: 'include/private',
      },
    ],
    ['include/private/id_ed25519', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.ssh/config', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.aws/credentials', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.cargo/credentials', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.docker/config.json', 'file', { kind: 'reject', category: 'known_secret_file' }],
    ['.kube/config', 'file', { kind: 'reject', category: 'known_secret_file' }],
    [
      '.config/gcloud/application_default_credentials.json',
      'file',
      { kind: 'reject', category: 'known_secret_file' },
    ],
    ['../escape', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['a\\b', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['CON', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['nested/LPT1.txt', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['foo:bar', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['name.', 'file', { kind: 'reject', category: 'unsafe_path' }],
    ['name ', 'directory', { kind: 'reject', category: 'unsafe_path' }],
  ] as const;

  for (const [relativePath, kind, expected] of cases) {
    assert.deepEqual(
      SESSION_SNAPSHOT_WORKSPACE_POLICY_V1.classify({ relativePath, kind }),
      expected,
    );
  }
});

test('binds explicit control-plane confirmation to the Session, policy and subtree', async () => {
  const fixture = await createFixture();
  const requests: Array<{
    makaSessionId: string;
    confirmationGrantId: string;
    policyVersion: number;
    category: string;
    confirmationPath: string;
  }> = [];
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    confirmationAuthority: {
      async resolveConfirmation(input) {
        requests.push({
          makaSessionId: input.makaSessionId,
          confirmationGrantId: input.confirmationGrantId,
          policyVersion: input.policyVersion,
          category: input.category,
          confirmationPath: input.confirmationPath,
        });
        return { action: 'include' };
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        assert.deepEqual(
          await input.confirmation.resolve({
            relativePath: 'config/credentials',
            kind: 'directory',
          }),
          { kind: 'include' },
        );
        assert.deepEqual(
          await input.confirmation.resolve({
            relativePath: 'config/credentials/production.yml.enc',
            kind: 'file',
          }),
          { kind: 'include' },
        );
        await mkdir(input.destinationRoot);
        return workspaceResult({ includedEntries: 2 });
      },
    },
  }).prepare({ makaSessionId: 'confirmed-session', confirmationGrantId: 'grant-1' });

  assert.deepEqual(requests, [
    {
      makaSessionId: 'confirmed-session',
      confirmationGrantId: 'grant-1',
      policyVersion: 1,
      category: 'suspected_secret_path',
      confirmationPath: 'config/credentials',
    },
  ]);
  await handle.release();
});

test('rejects a malformed control-plane confirmation grant before quiescence', async () => {
  const fixture = await createFixture();
  let enteredQuiescence = false;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: {
      async runQuiescent(_input, operation) {
        enteredQuiescence = true;
        return operation();
      },
    },
    state: directoryStatePreparer,
    workspace: directoryWorkspacePreparer,
  });

  await assert.rejects(
    coordinator.prepare({ makaSessionId: 'confirmed-session', confirmationGrantId: '../grant' }),
    isSnapshotError('invalid_input'),
  );
  assert.equal(enteredQuiescence, false);
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('fails closed and cleans staging when a suspected path has no explicit confirmation', async () => {
  const fixture = await createFixture();
  let authorityCalls = 0;
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    confirmationAuthority: {
      async resolveConfirmation() {
        authorityCalls += 1;
        return { action: 'include' };
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        await input.confirmation.resolve({ relativePath: 'include/private', kind: 'directory' });
        throw new Error('unreachable');
      },
    },
  });

  await assert.rejects(coordinator.prepare({ makaSessionId: 'unconfirmed-session' }), (error) => {
    assert.equal(error instanceof SessionSnapshotError && error.code, 'policy_rejected');
    assert.deepEqual(error instanceof SessionSnapshotError && error.details, {
      phase: 'workspace',
      policyCategory: 'suspected_secret_path',
    });
    return true;
  });
  assert.equal(authorityCalls, 0);
  assert.deepEqual(await readdir(fixture.stagingParent), []);
});

test('applies an explicit control-plane exclusion with bounded diagnostics', async () => {
  const fixture = await createFixture();
  const handle = await createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: fixture.stagingParent,
    stagingCleanup: fixture.stagingCleanup,
    privateStagingRootAuthority,
    quiescence: immediateAuthority,
    state: directoryStatePreparer,
    confirmationAuthority: {
      async resolveConfirmation() {
        return { action: 'exclude' };
      },
    },
    workspace: {
      async prepareWorkspace(input) {
        assert.deepEqual(
          await input.confirmation.resolve({ relativePath: 'secrets', kind: 'directory' }),
          { kind: 'exclude', category: 'confirmed_secret_path' },
        );
        await mkdir(input.destinationRoot);
        return workspaceResult({
          excludedEntries: 1,
          excludedEntriesByCategory: {
            ...workspaceResult().excludedEntriesByCategory,
            confirmed_secret_path: 1,
          },
        });
      },
    },
  }).prepare({ makaSessionId: 'excluded-session', confirmationGrantId: 'grant-2' });

  assert.deepEqual(
    handle.workspace.excludedEntriesByCategory,
    workspaceResult({
      excludedEntries: 1,
      excludedEntriesByCategory: {
        ...workspaceResult().excludedEntriesByCategory,
        confirmed_secret_path: 1,
      },
    }).excludedEntriesByCategory,
  );
  await handle.release();
});

const immediateAuthority: SessionSnapshotQuiescenceAuthority = {
  async runQuiescent(_input, operation) {
    return operation();
  },
};

const privateStagingRootAuthority = {
  async verifyPrivateStagingRoot(input: { canonicalPath: string }) {
    return { canonicalPath: await realpath(input.canonicalPath) };
  },
};

const directoryStatePreparer: SessionSnapshotStatePreparer = {
  async prepareState(input) {
    await mkdir(input.destinationRoot);
    return stateIdentity(input.makaSessionId);
  },
};

const directoryWorkspacePreparer: SessionSnapshotWorkspacePreparer = {
  async prepareWorkspace(input) {
    await mkdir(input.destinationRoot);
    return workspaceResult();
  },
};

function stateIdentity(makaSessionId: string) {
  return {
    mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
    bytes: Buffer.from(JSON.stringify({ makaSessionId }), 'utf8'),
  };
}

function workspaceResult(
  overrides: Partial<SessionSnapshotWorkspacePreparation> = {},
): SessionSnapshotWorkspacePreparation {
  return {
    includedEntries: 0,
    excludedEntries: 0,
    excludedEntriesByCategory: {
      dependency_tree: 0,
      source_control: 0,
      cache: 0,
      log: 0,
      runtime_scratch: 0,
      confirmed_secret_path: 0,
    },
    payloadBytes: 0,
    ...overrides,
  };
}

async function createFixture(): Promise<{
  root: string;
  stagingParent: string;
  stagingCleanup: SessionSnapshotStagingCleanupAuthority;
  processLifetimeOwner: ProcessLifetimeOwner;
  liveStateRoot: string;
  liveWorkspaceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-snapshot-'));
  roots.push(root);
  const stagingParent = join(root, 'staging');
  const liveStateRoot = join(root, 'live-state');
  const liveWorkspaceRoot = join(root, 'live-workspace');
  await Promise.all([
    mkdir(stagingParent, { mode: 0o700 }),
    mkdir(liveStateRoot),
    mkdir(liveWorkspaceRoot),
  ]);
  const processLifetimeOwner = await acquireProcessLifetimeOwner(join(root, 'cleanup-owners'));
  processLifetimeOwners.push(processLifetimeOwner);
  const stagingCleanup = createFileSessionSnapshotStagingCleanupAuthority({
    cleanupStateRoot: join(root, 'snapshot-cleanup-state'),
    stagingParent,
    processLifetimeOwner,
    privateStagingRootAuthority,
  });
  return {
    root,
    stagingParent,
    stagingCleanup,
    processLifetimeOwner,
    liveStateRoot,
    liveWorkspaceRoot,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class SerialQuiescenceAuthority implements SessionSnapshotQuiescenceAuthority {
  readonly activeSessions: string[] = [];
  readonly maximumConcurrentBySession = new Map<string, number>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #activeBySession = new Map<string, number>();

  async runQuiescent<T>(
    input: { makaSessionId: string; cancellation: SessionSnapshotCancellation },
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.#tails.get(input.makaSessionId) ?? Promise.resolve();
    const release = deferred<void>();
    const tail = predecessor.catch(() => {}).then(() => release.promise);
    this.#tails.set(input.makaSessionId, tail);
    await predecessor;
    if (input.cancellation.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });

    const active = (this.#activeBySession.get(input.makaSessionId) ?? 0) + 1;
    this.#activeBySession.set(input.makaSessionId, active);
    this.maximumConcurrentBySession.set(
      input.makaSessionId,
      Math.max(this.maximumConcurrentBySession.get(input.makaSessionId) ?? 0, active),
    );
    this.activeSessions.push(input.makaSessionId);
    try {
      return await operation();
    } finally {
      this.activeSessions.splice(this.activeSessions.indexOf(input.makaSessionId), 1);
      this.#activeBySession.set(input.makaSessionId, active - 1);
      release.resolve();
      if (this.#tails.get(input.makaSessionId) === tail) this.#tails.delete(input.makaSessionId);
    }
  }
}

async function waitForAbort(cancellation: SessionSnapshotCancellation): Promise<void> {
  if (cancellation.signal.aborted) return;
  await new Promise<void>((resolve) => {
    cancellation.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function isSnapshotError(code: SessionSnapshotError['code']): (error: unknown) => boolean {
  return (error) => error instanceof SessionSnapshotError && error.code === code;
}

function isCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function interceptSnapshotCleanupRename(
  publishedRoot: string,
  afterRename: () => Promise<void>,
): { completed: Promise<void> } {
  const stagingParent = dirname(publishedRoot);
  const expectedName = basename(publishedRoot);
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const observer = async () => {
    try {
      while (true) {
        const names = await readdir(stagingParent);
        if (!names.includes(expectedName)) {
          await afterRename();
          resolveCompleted();
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      rejectCompleted(error);
    }
  };
  void observer();
  return { completed };
}
