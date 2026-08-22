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
    operationBoundary: {
      filesystem: {
        entries: [{ path: expectedTarget.enforcementPath, access: 'write', scope: 'exact' }],
      },
    },
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
    assert.equal(
      await import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8')),
      'replacement',
    );
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
    assert.equal(
      await import('node:fs/promises').then((fs) => fs.readFile(target, 'utf8')),
      'updated',
    );
  });

  test('rejects a delete when the target inode changed after authorisation', async () => {
    const cwd = await temporaryDirectory('maka-identity-delete-');
    const target = join(cwd, 'delete-me.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement', 'utf8');

    // Capture identity of the original, then swap to a different inode.
    const identity = await captureIdentity(target);
    await rename(replacement, target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'apply_patch', cwd, path: target, action: 'delete' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'file', identity },
      ),
    );

    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'path_changed');
    // The replacement must NOT have been deleted.
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(target, 'utf8'), 'replacement');
  });

  test('rejects an edit when the target inode changed after authorisation', async () => {
    const cwd = await temporaryDirectory('maka-identity-edit-');
    const target = join(cwd, 'edit.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'line\nold\n', 'utf8');
    await writeFile(replacement, 'replacement\nold\n', 'utf8');

    const identity = await captureIdentity(target);
    await rename(replacement, target);

    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'edit', cwd, path: target, oldString: 'old', newString: 'new' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'file', identity },
      ),
    );

    assert.equal(response.ok, false);
    assert.equal(response.error?.code, 'path_changed');
    // The replacement content must be untouched (no edit applied).
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(target, 'utf8'), 'replacement\nold\n');
  });

  test('creates a missing target without requiring an identity', async () => {
    const cwd = await temporaryDirectory('maka-identity-missing-');
    const target = join(cwd, 'brand-new.txt');

    // A missing target carries no identity (there is no inode to pin); the
    // create must succeed on it. Assert success and the created content so a
    // regression that wrongly demands an identity for missing write targets
    // (e.g. an over-broad mandatory-identity check) fails loudly here.
    const response = await executeFilesystemWorkerRequest(
      requestFor(
        { kind: 'apply_patch', cwd, path: target, action: 'create', diff: '+created\n' },
        { enforcementPath: target, access: 'write', scope: 'exact', targetType: 'missing' },
      ),
    );

    assert.equal(response.ok, true);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(target, 'utf8'), 'created');
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

describe('filesystem worker post-write host-visibility check', () => {
  // Direct unit tests for hostVisibilityAfterWrite — the check that runs AFTER
  // writing through a pinned descriptor, describing whether the path still
  // resolves to the inode we wrote. The fd-pinned write itself (tested in
  // filesystem-stable-write.test.ts) is the primary defence; this describes
  // host visibility when the path was swapped despite the pinning.
  test('passes when the path still matches the written inode', async () => {
    const { openStableTarget, hostVisibilityAfterWrite } = await import('../file-stable-write.js');
    const cwd = await temporaryDirectory('maka-orphan-same-');
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'content', 'utf8');
    const identity = await captureIdentity(target);
    const handle = await openStableTarget({ path: target, approvedIdentity: identity });
    try {
      assert.equal(await hostVisibilityAfterWrite(target, handle), undefined);
    } finally {
      await handle.close();
    }
  });

  test('reports outcome_unknown when the path was replaced after the write', async () => {
    const { openStableTarget, hostVisibilityAfterWrite } = await import('../file-stable-write.js');
    const cwd = await temporaryDirectory('maka-orphan-swapped-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');
    const identity = await captureIdentity(target);

    const handle = await openStableTarget({ path: target, approvedIdentity: identity });
    try {
      // Swap the path to a different inode after the write went to the pin.
      await rename(replacement, target);
      const visibility = await hostVisibilityAfterWrite(target, handle);
      assert.equal(visibility?.code, 'outcome_unknown');
    } finally {
      await handle.close();
    }
  });

  test('reports outcome_unknown when the path disappeared after the write', async () => {
    const { openStableTarget, hostVisibilityAfterWrite } = await import('../file-stable-write.js');
    const cwd = await temporaryDirectory('maka-orphan-gone-');
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'content', 'utf8');
    const identity = await captureIdentity(target);

    const handle = await openStableTarget({ path: target, approvedIdentity: identity });
    try {
      // Remove the path entirely (the pinned inode is orphaned).
      await rm(target);
      const visibility = await hostVisibilityAfterWrite(target, handle);
      assert.equal(visibility?.code, 'outcome_unknown');
    } finally {
      await handle.close();
    }
  });
});
