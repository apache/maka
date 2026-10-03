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

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { normalizeSandboxBoundaryExpansion } from '../sandbox-boundary-path.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('normalizeSandboxBoundaryExpansion', () => {
  test('normalizes a linked-worktree gitdir read subtree to its commondir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-linked-worktree-'));
    roots.push(root);
    const commonDir = join(root, 'repository', '.git');
    const gitDir = join(commonDir, 'worktrees', 'linked');
    const worktree = join(root, 'linked');
    await mkdir(gitDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(gitDir, 'commondir'), '../..\n', 'utf8');

    const normalized = await normalizeSandboxBoundaryExpansion(
      {
        filesystem: {
          entries: [{ path: gitDir, access: 'read', scope: 'subtree' }],
        },
      },
      worktree,
    );

    assert.deepEqual(normalized.filesystem?.entries, [
      { path: await realpath(commonDir), access: 'read', scope: 'subtree' },
    ]);
  });

  test('leaves a linked-worktree gitdir write subtree unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-linked-worktree-write-'));
    roots.push(root);
    const commonDir = join(root, 'repository', '.git');
    const gitDir = join(commonDir, 'worktrees', 'linked');
    const worktree = join(root, 'linked');
    await mkdir(gitDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(gitDir, 'commondir'), '../..\n', 'utf8');

    const normalized = await normalizeSandboxBoundaryExpansion(
      {
        filesystem: {
          entries: [{ path: gitDir, access: 'write', scope: 'subtree' }],
        },
      },
      worktree,
    );

    assert.deepEqual(normalized.filesystem?.entries, [
      { path: await realpath(gitDir), access: 'write', scope: 'subtree' },
    ]);
  });

  test('leaves an ordinary directory containing a commondir file unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-boundary-ordinary-'));
    roots.push(root);
    const requested = join(root, 'ordinary');
    const target = join(root, 'target');
    await mkdir(requested, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(requested, 'commondir'), '../target\n', 'utf8');

    const normalized = await normalizeSandboxBoundaryExpansion(
      {
        filesystem: {
          entries: [{ path: requested, access: 'read', scope: 'subtree' }],
        },
      },
      root,
    );

    assert.deepEqual(normalized.filesystem?.entries, [
      { path: await realpath(requested), access: 'read', scope: 'subtree' },
    ]);
  });
});
