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

import { lstat, readFile, stat } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

const GITDIR_PREFIX = 'gitdir: ';
const HEAD_REF_PREFIX = 'ref: ';
// HEAD holds a 40-char SHA-1 object id, or 64 chars for SHA-256 repositories.
const HEAD_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export async function hasEnclosingGitEntry(path: string): Promise<boolean> {
  let current = path;
  while (true) {
    const gitPath = join(current, '.git');
    try {
      // lstat does not follow symlinks, so a dangling `.git` symlink still
      // counts as an existing entry. The selected directory fails closed
      // downstream when its own Git metadata is damaged; an ancestor only
      // counts when it is structurally valid.
      const entry = await lstat(gitPath);
      if (current === path) return true;
      const gitStat = entry.isSymbolicLink() ? await stat(gitPath) : entry;
      if (gitStat.isDirectory()) return isGitDirectory(gitPath);
      if (gitStat.isFile()) {
        const content = (await readFile(gitPath, 'utf8')).trim();
        if (!content.startsWith(GITDIR_PREFIX)) return false;
        const target = content.slice(GITDIR_PREFIX.length).trim();
        if (!target) return false;
        return isGitDirectory(resolve(current, target));
      }
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return current === path;
    }
    const parent = parse(current).dir;
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Checks the minimum Git directory contract git-rev-parse relies on: a
 * readable regular HEAD holding either a symref or an object id, plus the
 * objects and refs directories. Anything else would make the downstream Git
 * commands fail closed instead of being treated as an enclosing repository.
 */
async function isGitDirectory(gitDir: string): Promise<boolean> {
  try {
    // readFile fails closed on a missing, unreadable, or directory HEAD.
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const validHead = head.startsWith(HEAD_REF_PREFIX)
      ? head.slice(HEAD_REF_PREFIX.length).trim() !== ''
      : HEAD_OBJECT_ID.test(head);
    if (!validHead) return false;
  } catch {
    return false;
  }
  // Linked worktrees keep HEAD locally but share objects/refs with the
  // common dir named by their commondir file.
  return (
    (await hasGitSubdirectory(gitDir, 'objects')) && (await hasGitSubdirectory(gitDir, 'refs'))
  );
}

async function hasGitSubdirectory(gitDir: string, name: string): Promise<boolean> {
  if (await isDirectory(join(gitDir, name))) return true;
  try {
    const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
    return commonDir !== '' && (await isDirectory(resolve(gitDir, commonDir, name)));
  } catch {
    // No commondir file: a plain Git directory.
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
