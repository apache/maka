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

// packages/runtime/src/file-stable-write.ts
// The fd-pinned mutation primitive enforcing the filesystem-authority contract
// (#2600). A path-based write re-opens the pathname after every check, so a
// swap between validation and the open diverts the write onto the replacement
// and the post-write check can only *report* the corruption afterwards. This
// module removes that window structurally: the approved object is opened once,
// its identity is validated on the descriptor itself (fstat, not a second
// pathname lookup), and the read/transform/write all run through that same
// descriptor — a path swap mid-operation cannot redirect the bytes.
//
// Missing targets are created with `wx` (exclusive): if the path appeared
// between authorisation and the open, EEXIST is reported as `path_changed`
// rather than truncating whatever landed there.
//
// The descriptor is validated BEFORE any truncation: an 'r+' open does not
// truncate, so a rejected validation leaves the file byte-for-byte intact —
// unlike a plain 'w' open, which truncates as part of opening.

import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  open,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FilesystemTargetIdentity } from './filesystem-authority.js';

/** The failure modes this primitive can report. */
export type StableWriteErrorCode = 'path_changed' | 'outcome_unknown' | 'is_directory';

export class StableWriteFailure extends Error {
  constructor(
    readonly code: StableWriteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StableWriteFailure';
  }
}

function pathChanged(message: string): StableWriteFailure {
  return new StableWriteFailure('path_changed', message);
}

/**
 * Open the approved target and validate its identity on the descriptor.
 *
 * - Existing target (approvedIdentity present): `open(path, 'r+' | O_NOFOLLOW)`
 *   — POSIX refuses a final symlink at open time, and 'r+' does not truncate,
 *   so a failed identity check leaves the file untouched. Windows has no
 *   O_NOFOLLOW; the link is detected with an lstat just before the open and
 *   the residual window is closed by the identity comparison on the fd.
 * - Approved-missing target (approvedIdentity undefined): `open(path, 'wx')` —
 *   atomic create-if-absent. EEXIST means something appeared in the gap.
 */
export async function openStableTarget(input: {
  path: string;
  approvedIdentity: FilesystemTargetIdentity | undefined;
}): Promise<FileHandle> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  if (input.approvedIdentity) {
    if (process.platform === 'win32') {
      const entry = await lstat(input.path).catch(() => null);
      if (entry?.isSymbolicLink()) {
        throw pathChanged(
          'The approved filesystem target is a symbolic link; refusing to follow it.',
        );
      }
    }
    let handle: FileHandle;
    try {
      handle = await open(input.path, constants.O_RDWR | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') {
        throw pathChanged('The approved filesystem target changed before execution.');
      }
      if (code === 'EACCES' || code === 'EPERM') {
        // A write-only target (e.g. mode 0o222) refuses 'r+' but is still a
        // legitimate mutation target — unlink semantics need no read
        // permission. Retry write-only (still no truncate: identity is
        // validated on the descriptor before writeThroughHandle truncates).
        // The pinned read of the previous content will fail and the caller
        // reports 'unknown' (no diff), which is the pre-existing behaviour.
        try {
          handle = await open(input.path, constants.O_WRONLY | noFollow);
        } catch (retry) {
          const retryCode = (retry as NodeJS.ErrnoException).code;
          if (retryCode === 'ELOOP' || retryCode === 'ENOTDIR' || retryCode === 'ENOENT') {
            throw pathChanged('The approved filesystem target changed before execution.');
          }
          throw retry;
        }
      } else {
        throw error;
      }
    }
    // The compare in compare-and-update, performed on the descriptor itself.
    const metadata = await handle.stat({ bigint: true });
    if (
      String(metadata.dev) !== input.approvedIdentity.dev ||
      String(metadata.ino) !== input.approvedIdentity.ino
    ) {
      await handle.close();
      throw pathChanged('The approved filesystem target changed before execution.');
    }
    return handle;
  }
  try {
    return await open(input.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw pathChanged('A file appeared at the approved missing target; re-read before writing.');
    }
    throw error;
  }
}

/**
 * Write `content` through the pinned descriptor. The truncation happens here,
 * only after the identity was validated on the fd. Write-step failures
 * (ENOSPC/EIO/EDQUOT/EFBIG) can leave the file truncated or half-written, so
 * they surface as `outcome_unknown` — the file's state is genuinely unknown.
 */
export async function writeThroughHandle(handle: FileHandle, content: string): Promise<void> {
  try {
    await handle.truncate(0);
    // Position 0 explicitly: a prior readFile leaves the fd position at EOF,
    // and a positionless write would create a NUL-prefixed sparse file.
    await handle.write(content, 0, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EIO' || code === 'EDQUOT' || code === 'EFBIG') {
      throw new StableWriteFailure(
        'outcome_unknown',
        'The write started but failed partway; the file may be truncated. ' +
          'Re-read the file before writing to it again.',
      );
    }
    throw error;
  }
}

/**
 * Read-modify-write entirely through one descriptor. Transform errors happen
 * before any truncation and propagate unchanged (nothing was written). An
 * unchanged result skips the write entirely, preserving mtime for no-ops.
 */
export async function readModifyWriteThroughHandle(
  handle: FileHandle,
  transform: (existing: string) => string,
): Promise<string> {
  const existing = await handle.readFile('utf8');
  const replacement = transform(existing);
  if (replacement !== existing) {
    await writeThroughHandle(handle, replacement);
  }
  return replacement;
}

/**
 * After writing through the handle, describe the host-visible outcome: if the
 * path no longer resolves to the descriptor's inode, the write went to an
 * orphaned inode and the visible file is the replacement — an unknown outcome.
 * `undefined` means the path still matches and the write is host-visible.
 */
export async function hostVisibilityAfterWrite(
  path: string,
  handle: FileHandle,
): Promise<StableWriteFailure | undefined> {
  const written = await handle.stat({ bigint: true });
  let current: { dev: bigint; ino: bigint };
  try {
    current = await stat(path, { bigint: true });
  } catch {
    return new StableWriteFailure(
      'outcome_unknown',
      'The target disappeared after the write; the outcome on disk is unknown.',
    );
  }
  if (String(current.dev) !== String(written.dev) || String(current.ino) !== String(written.ino)) {
    return new StableWriteFailure(
      'outcome_unknown',
      'The target was replaced during the write; the outcome on disk is unknown.',
    );
  }
  return undefined;
}

/**
 * Compare-and-delete for directory entries (#2600). POSIX has no atomic
 * compare-and-unlink, so a bare `unlink(path)` can remove a replacement
 * installed between the identity check and the unlink — and report success.
 * Instead, atomically grab whatever the path currently names by renaming it to
 * a private tombstone in the same directory, verify the tombstone carries the
 * approved identity, and only then unlink the tombstone. A mismatch means a
 * replacement was installed in the window: it is moved back to the path
 * WITHOUT clobbering anything that reoccupied it (no-replace restore) and the
 * operation reports `path_changed`.
 *
 * rename(2) moves the directory entry itself, so this works for regular files
 * and symlinks alike, needs no permission on the file (only write+execute on
 * the parent directory, exactly like unlink), and never follows a symlink.
 * Directories are refused — up front when visible, and again after the
 * capture when a directory races into the window — because a directory cannot
 * be unlinked, only recursively removed: a different operation entirely.
 */
export async function compareAndDeleteEntry(input: {
  path: string;
  approvedIdentity: FilesystemTargetIdentity | undefined;
}): Promise<void> {
  // Fast refusal when the directory is visible up front (#2600 review): a
  // rename into the tombstone succeeds for directories, but the tombstone
  // unlink cannot (EISDIR/EPERM), which would hide the directory under a
  // stray name instead of failing cleanly. The post-capture check below is
  // the enforcement; this pre-check just avoids moving anything.
  const entryBefore = await lstat(input.path);
  if (entryBefore.isDirectory()) {
    throw new StableWriteFailure(
      'is_directory',
      'Refusing to delete a directory through the entry-delete path.',
    );
  }
  const tombstone = join(dirname(input.path), `.maka-pending-delete-${randomUUID()}`);
  // Atomically capture whatever entry the path names right now.
  await rename(input.path, tombstone);
  await deleteCapturedTombstone(tombstone, input.path, input.approvedIdentity);
}

/**
 * Verify and delete the entry held on the tombstone, restoring it on any
 * mismatch. The capture rename in the caller is the atomic step, so this is
 * where enforcement lives (#2600 review): the captured entry's TYPE is checked
 * before anything else — a directory that raced in after the caller's pre-check
 * is renamed straight back rather than identity-compared (link() cannot restore
 * a directory, so the mismatch path would strand it on the tombstone).
 *
 * @internal Exported for the forced-directory-in-tombstone regression test.
 */
export async function deleteCapturedTombstone(
  tombstone: string,
  path: string,
  approvedIdentity: FilesystemTargetIdentity | undefined,
): Promise<void> {
  const captured = await lstat(tombstone).catch(() => null);
  if (captured?.isDirectory()) {
    // A directory raced into the window between the caller's pre-check and
    // the capture. Restore it by rename — the only mechanism that moves a
    // directory — before any identity comparison. POSIX self-protects most
    // reoccupations (dir → existing non-directory fails ENOTDIR); if even
    // that fails, preserve the tombstone and report the location.
    try {
      await rename(tombstone, path);
    } catch {
      throw new StableWriteFailure(
        'outcome_unknown',
        `A directory was captured and could not be restored; it is preserved at ${tombstone}.`,
      );
    }
    throw new StableWriteFailure(
      'is_directory',
      'Refusing to delete a directory through the entry-delete path; it was restored to its original location.',
    );
  }
  if (approvedIdentity) {
    const entry = await lstat(tombstone, { bigint: true }).catch(() => null);
    const matches =
      entry !== null &&
      String(entry.dev) === approvedIdentity.dev &&
      String(entry.ino) === approvedIdentity.ino;
    if (!matches) {
      // A replacement was installed after the check. Restore it without
      // clobbering: if the path was reoccupied in the window, the restore
      // itself throws outcome_unknown and the tombstone is preserved.
      await restoreTombstoneNoReplace(tombstone, path);
      throw pathChanged(
        'The approved filesystem target changed before the delete; the replacement was restored. Re-check the directory before deleting again.',
      );
    }
  }
  // The tombstone is a private unpredictable name: nothing else contends
  // with this unlink.
  try {
    await unlink(tombstone);
  } catch {
    // The approved entry was moved but not removed: the delete's outcome on
    // disk is genuinely unknown, and the tombstone preserves the content.
    throw new StableWriteFailure(
      'outcome_unknown',
      `The delete may not have completed; the entry is preserved at ${tombstone}.`,
    );
  }
}

/**
 * Move the tombstone entry back to its original path WITHOUT overwriting
 * whatever may have reoccupied the path while the entry was captured (#2600
 * review: a plain rename would atomically delete the new occupant — the exact
 * class of replacement loss this module exists to prevent). Node exposes no
 * RENAME_NOREPLACE, so the no-replace mechanism depends on the entry type:
 *
 * - Regular file: `link()` is natively no-replace (EEXIST when the destination
 *   exists) and links the very inode the tombstone holds.
 * - Symlink: `link()` is unusable — POSIX leaves its treatment of a symlink
 *   source implementation-defined, and darwin dereferences it, which would
 *   plant a regular-file alias of the TARGET at the path (a foreign entry any
 *   later read/write silently edits). The link is instead recreated with
 *   `symlink(readlink(...))`, which is also natively no-replace and round-trips
 *   the target string exactly; the recreated link is a new inode, which is
 *   immaterial for a delete this call is refusing anyway.
 *
 * On EEXIST — or any creation failure — the tombstone is preserved and the
 * failure reported as `outcome_unknown` with the location, so nothing is ever
 * lost.
 *
 * @internal Exported for the no-replace restore regression tests.
 */
export async function restoreTombstoneNoReplace(tombstone: string, path: string): Promise<void> {
  const captured = await lstat(tombstone).catch(() => null);
  if (captured === null) {
    throw new StableWriteFailure(
      'outcome_unknown',
      `The captured entry could not be read; it is preserved at ${tombstone}.`,
    );
  }
  if (captured.isSymbolicLink()) {
    const target = await readlink(tombstone);
    try {
      await symlink(target, path);
    } catch {
      // EEXIST: the path was reoccupied after the capture (or symlink creation
      // failed). Preserving the tombstone is the only non-destructive option.
      throw new StableWriteFailure(
        'outcome_unknown',
        `The original path was reoccupied; the captured symlink is preserved at ${tombstone}.`,
      );
    }
    // The link semantics are restored at the path; dropping the old link name
    // is best-effort — a failure leaves a stray name, never data loss.
    await unlink(tombstone).catch(() => {});
    return;
  }
  try {
    await link(tombstone, path);
  } catch {
    // EEXIST: the path was reoccupied after the capture. Any other failure
    // (entry type / filesystem without hardlink support): preserving the
    // tombstone is the only non-destructive option. Either way nothing is
    // lost — the captured entry survives at the tombstone.
    throw new StableWriteFailure(
      'outcome_unknown',
      `The original path was reoccupied; the captured entry is preserved at ${tombstone}.`,
    );
  }
  // The restored entry must be the very inode the tombstone holds. A mismatch
  // means the path no longer carries what this call created — most plausibly a
  // concurrent rename placed a foreign entry there — and unlinking it would
  // destroy third-party data (the exact loss class this module prevents).
  // Touch nothing and report both locations.
  const restored = await lstat(path, { bigint: true }).catch(() => null);
  const held = await lstat(tombstone, { bigint: true }).catch(() => null);
  if (
    restored === null ||
    held === null ||
    restored.ino !== held.ino ||
    restored.dev !== held.dev
  ) {
    throw new StableWriteFailure(
      'outcome_unknown',
      `The entry could not be restored reliably; it is preserved at ${tombstone} (path now holds ${path}).`,
    );
  }
  // The entry is verified at the path; dropping the tombstone name is
  // best-effort — a failure here leaves a stray name, never data loss, and
  // must not turn a successful restore into a reported failure.
  await unlink(tombstone).catch(() => {});
}
