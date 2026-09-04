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
      if (gitStat.isDirectory()) return pathExists(join(gitPath, 'HEAD'));
      if (gitStat.isFile()) {
        const content = (await readFile(gitPath, 'utf8')).trim();
        if (!content.startsWith(GITDIR_PREFIX)) return false;
        const target = content.slice(GITDIR_PREFIX.length).trim();
        if (!target) return false;
        return pathExists(join(resolve(current, target), 'HEAD'));
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
