// Deterministic race tests for the fd-pinned mutation primitive (#2600).
// The pinning is the load-bearing defence: once the approved object is open
// and validated on the descriptor, a path swap cannot redirect the write —
// these tests prove it by swapping the path between validation and the write
// and asserting the bytes landed on the original inode, never the replacement.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  compareAndDeleteEntry,
  hostVisibilityAfterWrite,
  openStableTarget,
  restoreTombstoneNoReplace,
  writeThroughHandle,
  type StableWriteFailure,
} from '../file-stable-write.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(path);
  return path;
}

async function captureIdentity(path: string): Promise<{ dev: string; ino: string }> {
  const { stat } = await import('node:fs/promises');
  const s = await stat(path, { bigint: true });
  return { dev: String(s.dev), ino: String(s.ino) };
}

describe('fd-pinned mutation primitive', () => {
  test('a write survives a path swap between validation and the write', async () => {
    const cwd = await temporaryDirectory('maka-pin-swap-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');
    const identity = await captureIdentity(target);

    // The deterministic race: open + validate on the descriptor, THEN swap
    // the path, THEN write. A path-based write would land on the replacement;
    // the pinned write cannot.
    const handle = await openStableTarget({ path: target, approvedIdentity: identity });
    try {
      await rename(replacement, target); // the swap happens here
      await writeThroughHandle(handle, 'pinned-content');

      // The bytes went to the pinned inode: reading back through the same
      // descriptor shows the new content.
      assert.equal(await handle.readFile('utf8'), 'pinned-content');
      // The replacement file (now at the path) is untouched.
      assert.equal(await readFile(target, 'utf8'), 'replacement-body');
      // Host visibility honestly reports the orphaned write.
      const visibility = await hostVisibilityAfterWrite(target, handle);
      assert.equal(visibility?.code, 'outcome_unknown');
    } finally {
      await handle.close();
    }
  });

  test('a failed validation leaves the file byte-for-byte intact', async () => {
    const cwd = await temporaryDirectory('maka-pin-reject-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'original', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');
    const identity = await captureIdentity(target);

    // Swap before the open: the descriptor's inode will not match the approved
    // identity, and — unlike a 'w' open — the rejected 'r+' never truncated it.
    await rename(replacement, target);
    await assert.rejects(
      openStableTarget({ path: target, approvedIdentity: identity }),
      (error: StableWriteFailure) => error.code === 'path_changed',
    );
    assert.equal(await readFile(target, 'utf8'), 'replacement-body');
  });

  test('an approved-missing target rejects a file that appeared in the gap', async () => {
    const cwd = await temporaryDirectory('maka-pin-wx-');
    const target = join(cwd, 'file.txt');
    // The gap: the target was approved as missing, then something created it.
    await writeFile(target, 'external-content', 'utf8');

    await assert.rejects(
      openStableTarget({ path: target, approvedIdentity: undefined }),
      (error: StableWriteFailure) => error.code === 'path_changed',
    );
    // The interloper's content was never truncated.
    assert.equal(await readFile(target, 'utf8'), 'external-content');
  });

  test('an approved-missing target is created exclusively', async () => {
    const cwd = await temporaryDirectory('maka-pin-create-');
    const target = join(cwd, 'file.txt');

    const handle = await openStableTarget({ path: target, approvedIdentity: undefined });
    try {
      await writeThroughHandle(handle, 'created');
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(target, 'utf8'), 'created');
  });
});

describe('compare-and-delete (tombstone verification)', () => {
  // POSIX has no atomic compare-and-unlink, so delete cannot PREVENT a
  // same-directory swap — but the tombstone rename makes it atomic to CAPTURE
  // whatever the path names, verify it, and RESTORE a replacement instead of
  // silently deleting it (#2600 review: "delete can remove replacement").
  test('removes the approved entry', async () => {
    const cwd = await temporaryDirectory('maka-delete-plain-');
    const target = join(cwd, 'file.txt');
    await writeFile(target, 'bye', 'utf8');
    const identity = await captureIdentity(target);

    await compareAndDeleteEntry({ path: target, approvedIdentity: identity });

    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(cwd), []); // gone, and no tombstone leaked
  });

  test('restores a replacement installed after the check instead of deleting it', async () => {
    const cwd = await temporaryDirectory('maka-delete-swap-');
    const target = join(cwd, 'file.txt');
    const replacement = join(cwd, 'replacement.txt');
    await writeFile(target, 'approved', 'utf8');
    await writeFile(replacement, 'replacement-body', 'utf8');
    const identity = await captureIdentity(target);

    // The race: after the check captured the approved identity, an external
    // process renames a replacement over the path.
    await rename(replacement, target);

    await assert.rejects(
      compareAndDeleteEntry({ path: target, approvedIdentity: identity }),
      (error: StableWriteFailure) => error.code === 'path_changed',
    );
    // The replacement was restored, not deleted — content intact at the path.
    assert.equal(await readFile(target, 'utf8'), 'replacement-body');
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(cwd), ['file.txt']); // no tombstone leaked
  });

  test('deletes a symlink entry by its own identity without following it', async () => {
    const cwd = await temporaryDirectory('maka-delete-symlink-');
    const pointed = join(cwd, 'pointed.txt');
    const link = join(cwd, 'link.txt');
    await writeFile(pointed, 'keep', 'utf8');
    await symlink(pointed, link);
    const { lstat } = await import('node:fs/promises');
    const meta = await lstat(link, { bigint: true });
    const identity = { dev: String(meta.dev), ino: String(meta.ino) };

    await compareAndDeleteEntry({ path: link, approvedIdentity: identity });

    await assert.rejects(readFile(link, 'utf8'), { code: 'ENOENT' }); // link gone
    assert.equal(await readFile(pointed, 'utf8'), 'keep'); // target untouched
  });

  // #2600 review P1: after the tombstone captured replacement C, another
  // process created B at the original path; a rename-based restore would
  // atomically overwrite and DELETE B — the exact loss class this module
  // prevents. The no-replace restore must preserve both.
  test('a no-replace restore preserves a path reoccupied during the capture', async () => {
    const cwd = await temporaryDirectory('maka-delete-reoccupied-');
    const target = join(cwd, 'file.txt');
    const { writeFile: wf } = await import('node:fs/promises');
    // C sits on the tombstone; B has reoccupied the original path.
    const tombstone = join(cwd, 'tombstone');
    await wf(tombstone, 'captured-C', 'utf8');
    await wf(target, 'newcomer-B', 'utf8');

    await assert.rejects(
      restoreTombstoneNoReplace(tombstone, target),
      (error: StableWriteFailure) => error.code === 'outcome_unknown',
    );
    // Both survive, byte-for-byte, at their own names.
    assert.equal(await readFile(target, 'utf8'), 'newcomer-B');
    assert.equal(await readFile(tombstone, 'utf8'), 'captured-C');
  });

  test('a no-replace restore moves the captured entry back when the path is free', async () => {
    const cwd = await temporaryDirectory('maka-delete-restore-');
    const target = join(cwd, 'file.txt');
    const { writeFile: wf, readdir } = await import('node:fs/promises');
    const tombstone = join(cwd, 'tombstone');
    await wf(tombstone, 'captured', 'utf8');

    await restoreTombstoneNoReplace(tombstone, target);

    assert.equal(await readFile(target, 'utf8'), 'captured');
    assert.deepEqual(await readdir(cwd), ['file.txt']); // no tombstone left
  });

  // #2600 review P2: renaming a directory into the tombstone succeeds while
  // the tombstone unlink cannot (EISDIR/EPERM) — the directory would vanish
  // from its path and hide under the tombstone name. Reject up front instead.
  test('rejects a directory before touching it', async () => {
    const cwd = await temporaryDirectory('maka-delete-directory-');
    const dir = join(cwd, 'subdir');
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(dir);
    const { stat: st } = await import('node:fs/promises');
    const meta = await st(dir, { bigint: true });

    await assert.rejects(
      compareAndDeleteEntry({
        path: dir,
        approvedIdentity: { dev: String(meta.dev), ino: String(meta.ino) },
      }),
      /directory/i,
    );
    // The directory is untouched at its original path — not hidden anywhere.
    assert.deepEqual(await readdir(cwd), ['subdir']);
  });
});
