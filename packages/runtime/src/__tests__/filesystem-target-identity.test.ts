// Red-line tests for the T0 target identity CAS (issue #2600 concern #1).
// A mutation whose target was replaced while the call waited for the write
// lock must be detected and rejected, not silently written to the replacement.
// These tests exercise the worker's assertTargetUnchanged identity check
// directly against a real filesystem.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { executeFilesystemWorkerRequest } from '../filesystem-worker/operations.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  type FilesystemWorkerRequest,
  type FilesystemWorkerTarget,
} from '../filesystem-worker/protocol.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(path);
  return path;
}

function requestFor(
  operation: FilesystemWorkerRequest['operation'],
  expectedTarget: FilesystemWorkerTarget,
): FilesystemWorkerRequest {
  return {
    version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
    requestId: 'test',
    operation,
    operationBoundary: { filesystem: { entries: [{ path: expectedTarget.enforcementPath, access: 'write', scope: 'exact' }] } },
    expectedTarget,
  };
}

async function captureIdentity(path: string): Promise<{ dev: string; ino: string }> {
  const { stat } = await import('node:fs/promises');
  const s = await stat(path, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino) };
}

describe('filesystem worker target identity CAS', () => {
  test('rejects a write when the target inode changed after authorisation', async () => {
    const cwd = await temporaryDirectory('maka-identity-replace-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement', 'utf8');

    // Capture the identity of the original target (T0).
    const identity = await captureIdentity(target);

    // Swap the path to a different inode while "queued" (before the worker runs).
    await rename(replacement, target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'write', cwd, path: target, content: 'new' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'file', identity },
      ),
    );

    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'path_changed');
    // The write must NOT have landed on the replacement file.
    assert.equal(await import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8')), 'replacement');
  });

  test('allows a write when the target inode is unchanged', async () => {
    const cwd = await temporaryDirectory('maka-identity-same-');
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'original', 'utf8');

    const identity = await captureIdentity(target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'write', cwd, path: target, content: 'updated' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'file', identity },
      ),
    );

    assert.equal(response.ok, true);
    assert.equal(await import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8')), 'updated');
  });

  test('skips the identity check for a missing target (create)', async () => {
    const cwd = await temporaryDirectory('maka-identity-missing-');
    const target = join(cwd, 'brand-new.txt');

    // Missing target has no identity; the create proceeds and lands.
    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'apply_patch', cwd, path: target, action: 'create', diff: '*** Begin Patch\n*** End Patch' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'missing' },
      ),
    );

    // Whether it succeeds or fails on the diff, it must not be path_changed
    // for identity reasons (there was no identity to compare).
    if (!response.ok) {
      assert.notEqual(response.error?.code, 'path_changed');
    }
  });

  test('reports path_changed when the target is replaced before the write (pre-write CAS)', async () => {
    const cwd = await temporaryDirectory('maka-identity-prewrite-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');

    const identity = await captureIdentity(target);

    // Swap the path to a different inode BEFORE the request (simulates a
    // replacement during the lock-wait window). The pre-write CAS catches it.
    await rename(replacement, target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'write', cwd, path: target, content: 'new' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'file', identity },
      ),
    );

    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'path_changed');
  });
});

describe('filesystem worker post-write orphan inode check', () => {
  // Direct unit test for assertPathStillMatchesIdentity — the secondary defence
  // that fires AFTER the write, when the path may have been swapped mid-write.
  // The pre-write CAS (tested above) is the primary defence; this covers the
  // residual window between the write and the check.
  test('passes when the path still matches the written inode', async () => {
    const { assertPathStillMatchesIdentity } = await import('../filesystem-worker/operations.js');
    const cwd = await temporaryDirectory('maka-orphan-same-');
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'content', 'utf8');
    const identity = await captureIdentity(target);
    // No throw when the inode matches.
    await assertPathStillMatchesIdentity(target, identity);
  });

  test('throws outcome_unknown when the path was replaced after the write', async () => {
    const { assertPathStillMatchesIdentity } = await import('../filesystem-worker/operations.js');
    const cwd = await temporaryDirectory('maka-orphan-swapped-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');

    // Capture the identity of what we "wrote to" (the original target).
    const identity = await captureIdentity(target);
    // Then swap the path to a different inode (simulates a mid-write replacement).
    await rename(replacement, target);

    // The post-write check sees the path now names a different inode → unknown.
    await assert.rejects(
      assertPathStillMatchesIdentity(target, identity),
      (error: { code?: string }) => error.code === 'outcome_unknown',
    );
  });

  test('throws outcome_unknown when the path disappeared after the write', async () => {
    const { assertPathStillMatchesIdentity } = await import('../filesystem-worker/operations.js');
    const cwd = await temporaryDirectory('maka-orphan-gone-');
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'content', 'utf8');
    const identity = await captureIdentity(target);
    // Remove the path entirely (simulates the inode being orphaned and unlinked).
    await rm(target);

    await assert.rejects(
      assertPathStillMatchesIdentity(target, identity),
      (error: { code?: string }) => error.code === 'outcome_unknown',
    );
  });
});
