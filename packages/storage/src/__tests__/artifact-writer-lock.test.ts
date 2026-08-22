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
import { fork, type ChildProcess } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ArtifactRecord } from '@maka/core/artifacts';
import {
  openInteractiveArtifactStoreForWrite as openInteractiveArtifactStoreForWriteRaw,
  type InteractiveArtifactStoreWriter,
} from '../artifact-stores.js';
import {
  type ArtifactStore,
  type CreateArtifactInput,
  createSqliteArtifactStore,
} from '../artifact-store.js';
import { withArtifactWriterLock } from '../artifact-writer-lock.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '../root-authority.js';
import { exportSessionBundleState } from '../session-bundle-policy.js';
import { createSessionStore } from '../session-store.js';

const TEST_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 5_000;
const BUNDLE_EXPORT_TIMEOUT_MS = 10_000;
const COMPETING_PAYLOAD_BYTES = 4 * 1024 * 1024;
// Windows does not permit replacing or deleting a directory while SQLite has files open in it.
// These tests exercise POSIX root-replacement semantics; Windows coverage verifies cleanup after
// every owner is closed instead.
const SKIP_OPEN_SQLITE_ROOT_REPLACEMENT = process.platform === 'win32';
const artifactStoreClosersByRoot = new Map<string, Set<() => void>>();

function createArtifactStore(root: string): ArtifactStore {
  const store = createSqliteArtifactStore(root);
  const closers = artifactStoreClosersByRoot.get(root) ?? new Set<() => void>();
  closers.add(() => store.close?.());
  artifactStoreClosersByRoot.set(root, closers);
  return store;
}

async function openInteractiveArtifactStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveArtifactStoreWriter> {
  const store = await openInteractiveArtifactStoreForWriteRaw(lease);
  const root = lease.canonicalPath;
  const closers = artifactStoreClosersByRoot.get(root) ?? new Set<() => void>();
  closers.add(() => store.close());
  artifactStoreClosersByRoot.set(root, closers);
  return store;
}

function closeArtifactStoresUnder(root: string): void {
  for (const [storeRoot, closers] of artifactStoreClosersByRoot) {
    if (storeRoot !== root && !storeRoot.startsWith(`${root}${sep}`)) continue;
    artifactStoreClosersByRoot.delete(storeRoot);
    for (const close of [...closers].reverse()) close();
  }
}

test('public Store mutation waits for a child-held writer lock and preserves metadata', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    const store = createArtifactStore(stateRoot);
    await store.create(artifactInput('seed'));
    const holder = await spawnLockHolder(stateRoot);
    try {
      const mutation = store.create(artifactInput('after-lock'));
      await assertPending(mutation, 'Store mutation');
      await releaseHolder(holder);
      await withTimeout(mutation, OPERATION_TIMEOUT_MS, 'Store mutation');

      assert.deepEqual(
        (await createArtifactStore(stateRoot).list('session-1')).map((record) => record.id).sort(),
        ['after-lock', 'seed'],
      );
    } finally {
      await stopHolder(holder);
    }
  });
});

test('public Store mutations in separate processes reload and publish under one OS lock', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    const seedRecord = await createArtifactStore(stateRoot).create(artifactInput('seed'));

    const parentStore = createArtifactStore(stateRoot);
    await parentStore.list('session-1');
    const child = await spawnPublicWriter(stateRoot, 'session-1');
    const holder = await spawnLockHolder(stateRoot);
    try {
      const childInput = artifactInput('child-public', undefined, 3);
      const childPayload = repeatedPayload('child-public:', COMPETING_PAYLOAD_BYTES);
      const childMutation = startPublicWriterMutation(child, childInput, 'child-public:');
      const parentPayload = repeatedPayload('parent-public:', COMPETING_PAYLOAD_BYTES);
      const parentMutation = parentStore.create(artifactInput('parent-public', parentPayload, 2));

      await childMutation.queued;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await releaseHolder(holder);

      const [parentRecord, childCreated] = await withTimeout(
        Promise.all([parentMutation, childMutation.created]),
        OPERATION_TIMEOUT_MS,
        'competing public Store mutations',
      );
      await withTimeout(waitForExit(child), OPERATION_TIMEOUT_MS, 'public writer shutdown');

      const freshStore = createArtifactStore(stateRoot);
      const records = (await freshStore.list('session-1')).sort(compareRecordsById);
      assert.deepEqual(
        records,
        [seedRecord, parentRecord, childCreated.record].sort(compareRecordsById),
      );
      assert.deepEqual(await freshStore.readText('parent-public'), {
        ok: true,
        text: parentPayload,
      });
      assert.deepEqual(await freshStore.readText('child-public'), { ok: true, text: childPayload });
    } finally {
      await stopHolder(child);
      await stopHolder(holder);
    }
  });
});

test('public Store mutations share the rootId writer lock used by lease-bound authority', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot);
    const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    const holder = await spawnAuthorityLockHolder(stateRoot, capability.rootId);
    try {
      const mutation = createArtifactStore(stateRoot).create(artifactInput('public-marked-root'));
      await assertPending(mutation, 'public Store mutation on a marked root');

      await releaseHolder(holder);
      assert.equal(
        (
          await withTimeout(
            mutation,
            OPERATION_TIMEOUT_MS,
            'public Store mutation on a marked root',
          )
        ).id,
        'public-marked-root',
      );
    } finally {
      await stopHolder(holder);
    }
  });
});

test('mutations spanning initial root marking remain serialized by the bootstrap writer lock', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot);
    const holder = await spawnLockHolder(stateRoot);
    try {
      const firstMutation = createArtifactStore(stateRoot).create(
        artifactInput('before-root-marking'),
      );
      await assertPending(firstMutation, 'public mutation started before root marking');

      await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
      const secondMutation = createArtifactStore(stateRoot).create(
        artifactInput('after-root-marking', undefined, 2),
      );
      await assertPending(secondMutation, 'public mutation started after root marking');

      await releaseHolder(holder);
      await withTimeout(
        Promise.all([firstMutation, secondMutation]),
        OPERATION_TIMEOUT_MS,
        'mutations spanning initial root marking',
      );

      const freshStore = createArtifactStore(stateRoot);
      assert.deepEqual((await freshStore.list('session-1')).map((record) => record.id).sort(), [
        'after-root-marking',
        'before-root-marking',
      ]);
      assert.deepEqual(await freshStore.readText('before-root-marking'), {
        ok: true,
        text: 'before-root-marking',
      });
      assert.deepEqual(await freshStore.readText('after-root-marking'), {
        ok: true,
        text: 'after-root-marking',
      });
    } finally {
      await stopHolder(holder);
    }
  });
});

test('public mutation rejects an unmarked replacement installed while waiting for bootstrap', {
  timeout: TEST_TIMEOUT_MS,
  skip: SKIP_OPEN_SQLITE_ROOT_REPLACEMENT,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    const displacedRoot = join(root, 'displaced-state');
    await mkdir(stateRoot);
    const holder = await spawnLockHolder(stateRoot);
    try {
      const mutation = createArtifactStore(stateRoot).create(
        artifactInput('stale-public-replacement'),
      );
      await assertPending(mutation, 'public mutation waiting for its captured bootstrap authority');

      await rename(stateRoot, displacedRoot);
      await mkdir(stateRoot);
      await writeFile(join(stateRoot, 'replacement-sentinel'), 'replacement');
      await releaseHolder(holder);

      await assert.rejects(mutation);
      assert.deepEqual(await readdir(stateRoot), ['replacement-sentinel']);
      await assert.rejects(() => lstat(join(stateRoot, 'artifacts')), { code: 'ENOENT' });
      await assert.rejects(() => lstat(join(displacedRoot, 'artifacts')), { code: 'ENOENT' });
    } finally {
      await stopHolder(holder);
    }
  });
});

test('public mutation through a retargeted alias stays bound to its verified canonical root', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    const replacementRoot = join(root, 'replacement');
    const alias = join(root, 'state-alias');
    await Promise.all([mkdir(stateRoot), mkdir(replacementRoot)]);
    await writeFile(join(replacementRoot, 'replacement-sentinel'), 'replacement');
    const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    await createArtifactStore(stateRoot).create(artifactInput('seed'));
    await symlink(stateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const store = createArtifactStore(alias);
    assert.deepEqual(
      (await store.list('session-1')).map((record) => record.id),
      ['seed'],
    );

    const holder = await spawnAuthorityLockHolder(stateRoot, capability.rootId);
    try {
      const mutation = store.create(artifactInput('alias-mutation', undefined, 2));
      await assertPending(mutation, 'public mutation through the original alias target');

      await rm(alias, { force: true });
      await symlink(replacementRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await releaseHolder(holder);
      assert.equal((await mutation).id, 'alias-mutation');

      assert.deepEqual(
        (await createArtifactStore(stateRoot).list('session-1')).map((record) => record.id).sort(),
        ['alias-mutation', 'seed'],
      );
      assert.deepEqual(await readdir(replacementRoot), ['replacement-sentinel']);
      await assert.rejects(() => lstat(join(replacementRoot, 'artifacts')), { code: 'ENOENT' });
    } finally {
      await stopHolder(holder);
    }
  });
});

test('admitted lease-bound mutations reject a replacement root without modifying it', {
  timeout: TEST_TIMEOUT_MS,
  skip: SKIP_OPEN_SQLITE_ROOT_REPLACEMENT,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot);
    const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const firstStore = await openInteractiveArtifactStoreForWrite(owner.lease);
    const holder = await spawnLockHolder(stateRoot);
    const displacedRoot = join(root, 'displaced-state');
    try {
      const firstMutation = firstStore.create(artifactInput('stale-replacement-first'));
      const secondMutation = firstStore.create(
        artifactInput('stale-replacement-second', undefined, 2),
      );
      await Promise.all([
        assertPending(firstMutation, 'first admitted lease-bound mutation'),
        assertPending(secondMutation, 'second admitted lease-bound mutation'),
      ]);

      await rename(stateRoot, displacedRoot);
      await mkdir(stateRoot, { mode: 0o750 });
      await writeFile(join(stateRoot, 'replacement-sentinel'), 'replacement');
      const replacementMode = (await stat(stateRoot)).mode & 0o777;
      await releaseHolder(holder);

      await Promise.all([assert.rejects(firstMutation), assert.rejects(secondMutation)]);
      assert.deepEqual(await readdir(stateRoot), ['replacement-sentinel']);
      assert.equal((await stat(stateRoot)).mode & 0o777, replacementMode);
      await assert.rejects(() => lstat(join(stateRoot, '.maka-artifact-writer.lock')), {
        code: 'ENOENT',
      });
      await assert.rejects(() => stat(join(stateRoot, 'artifacts')), { code: 'ENOENT' });
    } finally {
      await stopHolder(holder);
      await owner.close();
    }
  });
});

test('lease-bound mutation does not rebuild a root deleted while waiting for the writer lock', {
  timeout: TEST_TIMEOUT_MS,
  skip: SKIP_OPEN_SQLITE_ROOT_REPLACEMENT,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    await mkdir(stateRoot);
    const capability = await resolveStorageRoot({ path: stateRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    const store = await openInteractiveArtifactStoreForWrite(owner.lease);
    const holder = await spawnLockHolder(stateRoot);
    try {
      const mutation = store.create(artifactInput('stale-deleted'));
      await assertPending(mutation, 'lease-bound mutation');

      await rm(stateRoot, { recursive: true });
      await releaseHolder(holder);

      await assert.rejects(mutation);
      await assert.rejects(() => lstat(stateRoot), { code: 'ENOENT' });
    } finally {
      await stopHolder(holder);
      await owner.close();
    }
  });
});

test('bundle export excludes a mutation queued behind the same child-held writer lock', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    const configRoot = join(root, 'config');
    const destinationRoot = join(root, 'export');
    await Promise.all([mkdir(stateRoot), mkdir(configRoot)]);
    const sessions = createSessionStore(stateRoot);
    const session = await sessions.create(sessionInput());
    await sessions.close?.();
    const store = createArtifactStore(stateRoot);
    await store.create({ ...artifactInput('seed'), sessionId: session.id });

    const holder = await spawnLockHolder(stateRoot, session.id);
    try {
      const bundleExport = exportSessionBundleState({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: session.id,
      });
      await assertPending(bundleExport, 'bundle export');
      const mutation = store.create({
        ...artifactInput('after-export'),
        sessionId: session.id,
      });
      await assertPending(mutation, 'Store mutation');

      await releaseHolder(holder);
      await withTimeout(bundleExport, BUNDLE_EXPORT_TIMEOUT_MS, 'bundle export');
      await withTimeout(mutation, OPERATION_TIMEOUT_MS, 'Store mutation');

      const exportedStore = createSqliteArtifactStore(destinationRoot);
      try {
        assert.deepEqual(
          (await exportedStore.list(session.id)).map((record) => record.id),
          ['seed'],
        );
      } finally {
        exportedStore.close?.();
      }
      assert.deepEqual(
        (await createArtifactStore(stateRoot).list(session.id)).map((record) => record.id).sort(),
        ['after-export', 'seed'],
      );
    } finally {
      await stopHolder(holder);
    }
  });
});

test('bundle export holds Artifact authority through selected-session projection', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  await withTemporaryDirectory(async (root) => {
    const stateRoot = join(root, 'state');
    const configRoot = join(root, 'config');
    const destinationRoot = join(root, 'export');
    await Promise.all([mkdir(stateRoot), mkdir(configRoot)]);
    const sessions = createSessionStore(stateRoot);
    const session = await sessions.create(sessionInput());
    await sessions.appendMessage(session.id, {
      type: 'user',
      id: 'message-1',
      turnId: 'turn-1',
      ts: 1,
      text: 'portable transcript',
    });
    await sessions.close?.();
    await createArtifactStore(stateRoot).create({
      ...artifactInput('seed'),
      sessionId: session.id,
    });

    const holder = await spawnLockHolder(stateRoot, session.id);
    try {
      const bundleExport = exportSessionBundleState({
        stateRoot,
        configRoot,
        destinationRoot,
        sessionId: session.id,
      });
      await assertPending(bundleExport, 'bundle export');

      const projectedMessages = withArtifactWriterLock(stateRoot, async () => {
        const projectedSessions = createSessionStore(destinationRoot);
        try {
          return await projectedSessions.readMessagesSnapshot(session.id);
        } finally {
          await projectedSessions.close?.();
        }
      });
      await assertPending(projectedMessages, 'writer queued after bundle export');

      await releaseHolder(holder);
      assert.equal(
        (
          await withTimeout(
            projectedMessages,
            BUNDLE_EXPORT_TIMEOUT_MS,
            'selected-session projection',
          )
        ).find((message) => message.type === 'user')?.text,
        'portable transcript',
      );
      await withTimeout(bundleExport, BUNDLE_EXPORT_TIMEOUT_MS, 'bundle export');
    } finally {
      await stopHolder(holder);
    }
  });
});

function artifactInput(id: string, content = id, now = 1): CreateArtifactInput {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: `${id}.txt`,
    kind: 'file' as const,
    content,
    now,
  };
}

function sessionInput() {
  return {
    cwd: '/repo',
    backend: 'fake' as const,
    llmConnectionSlug: 'fixture',
    model: 'fixture-model',
    permissionMode: 'execute' as const,
    name: 'Selected',
  };
}

async function spawnLockHolder(
  workspaceRoot: string,
  transientResidueSessionId?: string,
): Promise<ChildProcess> {
  const child = fork(
    new URL('./fixtures/artifact-writer-lock-holder.js', import.meta.url),
    [workspaceRoot, ...(transientResidueSessionId ? [transientResidueSessionId] : [])],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await waitForChildMessage(child, 'locked');
    return child;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withTimeout(waitForExit(child), OPERATION_TIMEOUT_MS, 'failed lock holder shutdown');
    throw error;
  }
}

async function spawnAuthorityLockHolder(
  workspaceRoot: string,
  rootId: string,
): Promise<ChildProcess> {
  const child = fork(
    new URL('./fixtures/artifact-writer-lock-holder.js', import.meta.url),
    [workspaceRoot, '--authority-holder', rootId],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await waitForChildMessage(child, 'locked');
    return child;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withTimeout(waitForExit(child), OPERATION_TIMEOUT_MS, 'failed lock holder shutdown');
    throw error;
  }
}

async function spawnPublicWriter(workspaceRoot: string, sessionId: string): Promise<ChildProcess> {
  const child = fork(
    new URL('./fixtures/artifact-writer-lock-holder.js', import.meta.url),
    [workspaceRoot, '--public-writer', sessionId],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  try {
    await waitForChildMessage(child, 'ready');
    return child;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withTimeout(waitForExit(child), OPERATION_TIMEOUT_MS, 'failed public writer shutdown');
    throw error;
  }
}

function startPublicWriterMutation(
  child: ChildProcess,
  input: CreateArtifactInput,
  payloadUnit: string,
): {
  queued: Promise<FixtureMessageOfType<'queued'>>;
  created: Promise<FixtureMessageOfType<'created'>>;
} {
  const queued = waitForChildMessage(child, 'queued');
  const created = waitForChildMessage(child, 'created');
  const { content: _content, ...inputWithoutContent } = input;
  child.send({
    type: 'create',
    input: inputWithoutContent,
    payloadUnit,
    payloadBytes: COMPETING_PAYLOAD_BYTES,
  });
  return { queued, created };
}

async function releaseHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error('Artifact writer lock holder exited before release');
  }
  const released = waitForChildMessage(child, 'released');
  child.send({ type: 'release' });
  await released;
  await waitForExit(child);
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await withTimeout(waitForExit(child), OPERATION_TIMEOUT_MS, 'lock holder shutdown');
}

async function waitForChildMessage<T extends FixtureMessage['type']>(
  child: ChildProcess,
  expected: T,
): Promise<FixtureMessageOfType<T>> {
  return withTimeout(
    new Promise<FixtureMessageOfType<T>>((resolve, reject) => {
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
        child.off('message', onMessage);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`Lock holder exited before ${expected}: ${code ?? signal}`));
      };
      const onMessage = (message: unknown) => {
        if (!isFixtureMessage(message)) return;
        if (message.type === 'error') {
          cleanup();
          reject(new Error(`Lock holder failed: ${message.message}`));
        } else if (message.type === expected) {
          cleanup();
          resolve(message as FixtureMessageOfType<T>);
        }
      };
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('message', onMessage);
    }),
    OPERATION_TIMEOUT_MS,
    `lock holder ${expected}`,
  );
}

type FixtureMessage =
  | { type: 'locked' | 'released' | 'ready' | 'queued' }
  | { type: 'created'; record: ArtifactRecord }
  | { type: 'error'; message: string };

type FixtureMessageOfType<T extends FixtureMessage['type']> = Extract<FixtureMessage, { type: T }>;

function isFixtureMessage(message: unknown): message is FixtureMessage {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  const type = message.type;
  return (
    type === 'locked' ||
    type === 'released' ||
    type === 'ready' ||
    type === 'queued' ||
    type === 'created' ||
    type === 'error'
  );
}

async function assertPending(operation: Promise<unknown>, label: string): Promise<void> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await delay(100);
  assert.equal(settled, false, `${label} did not wait for the child-held writer lock`);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTemporaryDirectory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-artifact-writer-lock-'));
  try {
    await run(root);
  } finally {
    closeArtifactStoresUnder(root);
    await rm(root, { recursive: true, force: true });
  }
}

function repeatedPayload(unit: string, bytes: number): string {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function compareRecordsById(left: ArtifactRecord, right: ArtifactRecord): number {
  return left.id.localeCompare(right.id);
}
