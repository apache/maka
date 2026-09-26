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

import { execFile } from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function hasEnclosingGitEntry(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    const gitPath = join(current, '.git');
    let present: boolean;
    try {
      await lstat(gitPath);
      present = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      present = false;
    }
    if (present) {
      // Keep failures in the selected directory's own metadata visible.
      if (current === path) return true;
      if (await isGitEntry(gitPath)) return true;
    }
    // An ancestor Git rejected despite readable metadata is confirmed invalid;
    // Git itself skips it and keeps searching outward, so continue the walk.
    const parent = parse(current).dir;
    if (parent === current) return false;
    current = parent;
  }
}

async function isGitEntry(gitPath: string): Promise<boolean> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  try {
    // Let Git validate directories and gitfiles, including linked worktrees.
    await execFileAsync('git', ['rev-parse', '--resolve-git-dir', gitPath], {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 3_000,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    // Exit 128 is Git rejecting the entry, but it conflates an invalid format
    // with unreadable metadata; execution failures must still surface so a
    // missing Git executable cannot downgrade a repository.
    if ((error as { code?: unknown }).code === 128) {
      await assertGitMetadataReadable(gitPath);
      return false;
    }
    throw error;
  }
}

/**
 * Git's 128 verdict is trusted format interpretation only when Git could read
 * the metadata: an unreadable repository is not evidence of an ordinary
 * directory, so permission and I/O failures surface instead of taking the
 * no-repository path.
 */
async function assertGitMetadataReadable(gitPath: string): Promise<void> {
  let entryStat: Stats;
  try {
    entryStat = await lstat(gitPath);
    await access(
      gitPath,
      entryStat.isDirectory() ? fsConstants.R_OK | fsConstants.X_OK : fsConstants.R_OK,
    );
  } catch (error) {
    throw new Error(`Git metadata is not readable: ${gitPath}`, { cause: error });
  }
  if (entryStat.isDirectory()) {
    await assertGitDirectoryReadable(gitPath);
    return;
  }
  // A gitfile's target is the directory Git actually validated.
  const pointer = /^gitdir: (.+)$/m.exec(await readFile(gitPath, 'utf8'));
  if (pointer) {
    await assertGitDirectoryReadable(resolve(dirname(gitPath), pointer[1].trim()));
  }
}

async function assertGitDirectoryReadable(gitDir: string): Promise<void> {
  for (const name of ['HEAD', 'objects', 'refs']) {
    const path = join(gitDir, name);
    try {
      await access(path, fsConstants.R_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Missing members are Git's format call; unreadable ones are ours.
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw new Error(`Git metadata is not readable: ${path}`, { cause: error });
    }
  }
}
