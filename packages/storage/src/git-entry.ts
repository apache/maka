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
import { lstat } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function hasEnclosingGitEntry(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    const gitPath = join(current, '.git');
    try {
      await lstat(gitPath);
      // Keep failures in the selected directory's own metadata visible.
      if (current === path) return true;
      return isGitEntry(gitPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
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
    // This probe exits 128 for invalid Git metadata. Execution failures must
    // still surface so a missing Git executable cannot downgrade a repository.
    if ((error as { code?: unknown }).code === 128) return false;
    throw error;
  }
}
