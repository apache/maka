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

import { constants as fsConstants, type Stats } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

import { execGitText } from './git-exec.js';

/**
 * True means Git recognized an entry, not that every repository operation will
 * succeed. False requires exhausting the ancestors; ambiguous failures throw.
 */
export async function hasEnclosingGitEntry(path: string): Promise<boolean> {
  // The git probes below anchor on entry directories, so the walk needs an
  // absolute path: a relative parent would ask Git to resolve -C against the
  // child's inherited cwd, which may be deleted or unsearchable.
  let current = resolve(path);
  while (true) {
    const gitPath = join(current, '.git');
    let entryStat: Stats | undefined;
    try {
      entryStat = await lstat(gitPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (entryStat && (await isGitEntry(gitPath, entryStat, current !== path))) {
      return true;
    }
    // Git skips invalid ancestor directories, but gitfiles can stop discovery.
    const parent = parse(current).dir;
    if (parent === current) return false;
    current = parent;
  }
}

async function isGitEntry(gitPath: string, before: Stats, ancestor: boolean): Promise<boolean> {
  try {
    // Validate the exact entry: discovery could hide a broken own marker by
    // finding an outer repository instead.
    await assertGitEntry(gitPath);
    return true;
  } catch (error) {
    if (!ancestor || !before.isDirectory() || (error as { code?: unknown }).code !== 128) {
      throw error;
    }
  }

  // Preserve Git's format verdict, but only after auditing its recognition
  // inputs. Repeat the probe inside the snapshot checks rather than applying
  // a stale rejection to metadata that may have been repaired or replaced.
  const snapshot = await assertGitDirectoryReadable(gitPath, before);
  let recognized = true;
  try {
    await assertGitEntry(gitPath);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 128) throw error;
    recognized = false;
  }
  for (const [path, stat] of snapshot) {
    assertUnchanged(path, stat, await statIfPresent(path));
  }
  return recognized;
}

async function assertGitEntry(gitPath: string): Promise<void> {
  // Let Git interpret directories and gitfiles, including linked worktrees. -C
  // only chooses where Git starts; --resolve-git-dir judges gitPath itself.
  // Anchor on the directory containing the entry (lstat proved it exists)
  // instead of the host's ambient cwd, which may have been deleted or made
  // unsearchable since the process started.
  await execGitText(parse(gitPath).dir, ['rev-parse', '--resolve-git-dir', gitPath], {
    maxBuffer: 64 * 1024,
    timeoutMs: 3_000,
  });
}

/**
 * Audit the ordinary directory layout recognized by Git's is_git_directory:
 * HEAD is read (at most 255 bytes), and objects/refs require search permission.
 * Missing members and wrong ordinary-file/directory types are format failures;
 * permission, read and unexpected filesystem errors must still surface.
 * Failed probes involving indirection remain unclassified: success for valid
 * worktrees/symlinks is handled by Git above, not by this fallback.
 */
async function assertGitDirectoryReadable(
  gitPath: string,
  before: Stats,
): Promise<Map<string, Stats | undefined>> {
  await access(gitPath, fsConstants.R_OK | fsConstants.X_OK);
  const snapshot = new Map<string, Stats | undefined>([[gitPath, before]]);
  const commonPath = join(gitPath, 'commondir');
  const commonStat = await statIfPresent(commonPath);
  if (commonStat || process.env.GIT_OBJECT_DIRECTORY !== undefined) {
    throw new Error(`Cannot classify Git metadata with redirected storage: ${gitPath}`);
  }
  snapshot.set(commonPath, commonStat);
  for (const name of ['HEAD', 'objects', 'refs']) {
    const path = join(gitPath, name);
    const stat = await statIfPresent(path);
    snapshot.set(path, stat);
    if (!stat) continue;
    if (stat.isDirectory()) {
      await access(path, fsConstants.R_OK | fsConstants.X_OK);
    } else if (stat.isFile()) {
      await access(path, fsConstants.R_OK);
      if (name === 'HEAD') await assertHeadReadable(path, stat);
    } else {
      throw new Error(`Cannot classify Git metadata with special file: ${path}`);
    }
  }
  return snapshot;
}

async function assertHeadReadable(path: string, before: Stats): Promise<void> {
  // Do not follow a replacement symlink or block opening a replacement FIFO.
  const file = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    assertUnchanged(path, before, await file.stat());
    const buffer = Buffer.alloc(255);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assertUnchanged(path, before, await file.stat());
  } finally {
    await file.close();
  }
}

async function statIfPresent(path: string): Promise<Stats | undefined> {
  try {
    // lstat distinguishes a dangling symlink from a missing member. ENOTDIR
    // here means a parent changed, not that the member was simply absent.
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function assertUnchanged(path: string, before: Stats | undefined, after: Stats | undefined): void {
  if (!before && !after) return;
  if (
    !before ||
    !after ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`Git metadata changed during discovery: ${path}`);
  }
}
