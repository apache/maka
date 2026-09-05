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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BROKEN_GIT_SHAPES = [
  'head-directory',
  'head-garbage',
  'gitfile-garbage-head',
  'missing-objects-and-refs',
] as const;

export type BrokenGitShape = (typeof BROKEN_GIT_SHAPES)[number];

/** Writes structurally broken Git metadata (a `.git` entry or its target) into root. */
export async function createBrokenGitMetadata(root: string, shape: BrokenGitShape): Promise<void> {
  switch (shape) {
    case 'head-directory':
      await mkdir(join(root, '.git', 'HEAD'), { recursive: true });
      return;
    case 'head-garbage':
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'gk\n', 'utf8');
      return;
    case 'gitfile-garbage-head':
      await writeFile(join(root, '.git'), 'gitdir: stub\n', 'utf8');
      await mkdir(join(root, 'stub'), { recursive: true });
      await writeFile(join(root, 'stub', 'HEAD'), 'gk\n', 'utf8');
      return;
    case 'missing-objects-and-refs':
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), `ref: refs/heads/${'a'.repeat(40)}\n`, 'utf8');
  }
}

export async function createGitRepositoryWithWorktree(
  repository: string,
  linkedWorktree: string,
  branch: string,
): Promise<void> {
  await mkdir(repository);
  await execFileAsync('git', ['init', '--quiet'], { cwd: repository });
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repository });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '--quiet',
      '-m',
      'init',
    ],
    { cwd: repository },
  );
  await execFileAsync('git', ['worktree', 'add', '--quiet', '-b', branch, linkedWorktree], {
    cwd: repository,
  });
}
