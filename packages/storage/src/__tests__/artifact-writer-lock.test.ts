import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createArtifactStore } from '../artifact-store.js';
import { exportSessionBundleState } from '../session-bundle-policy.js';
import { createSessionStore } from '../session-store.js';

const TEST_TIMEOUT_MS = 15_000;
const OPERATION_TIMEOUT_MS = 5_000;

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
      await withTimeout(bundleExport, OPERATION_TIMEOUT_MS, 'bundle export');
      await withTimeout(mutation, OPERATION_TIMEOUT_MS, 'Store mutation');

      assert.deepEqual(
        (await createArtifactStore(destinationRoot).list(session.id)).map((record) => record.id),
        ['seed'],
      );
      assert.deepEqual(
        (await createArtifactStore(stateRoot).list(session.id)).map((record) => record.id).sort(),
        ['after-export', 'seed'],
      );
    } finally {
      await stopHolder(holder);
    }
  });
});

function artifactInput(id: string) {
  return {
    id,
    sessionId: 'session-1',
    turnId: 'turn-1',
    name: `${id}.txt`,
    kind: 'file' as const,
    content: id,
    now: 1,
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

async function waitForChildMessage(child: ChildProcess, expected: 'locked' | 'released') {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
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
        if (!isHolderMessage(message)) return;
        if (message.type === 'error') {
          cleanup();
          reject(new Error(`Lock holder failed: ${message.message}`));
        } else if (message.type === expected) {
          cleanup();
          resolve();
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

function isHolderMessage(
  message: unknown,
): message is { type: 'locked' | 'released' } | { type: 'error'; message: string } {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  const type = message.type;
  return type === 'locked' || type === 'released' || type === 'error';
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
    await rm(root, { recursive: true, force: true });
  }
}
