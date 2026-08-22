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
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';
import { readGitReview } from '../git-review-main.js';

const execFileAsync = promisify(execFile);
const roots = new Set<string>();

after(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Git Review snapshot authority', () => {
  it('separates branch, unstaged, staged, and untracked changes', async () => {
    const root = await repository();
    await git(root, 'checkout', '-b', 'feature/review');
    await writeFile(join(root, 'feature.txt'), 'feature\n', 'utf8');
    await git(root, 'add', 'feature.txt');
    await git(root, 'commit', '-m', 'feature');

    await writeFile(join(root, 'base.txt'), 'base\nunstaged\n', 'utf8');
    await writeFile(join(root, 'staged.txt'), 'staged\n', 'utf8');
    await git(root, 'add', 'staged.txt');
    await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');

    const branch = await readGitReview(root, 'branch');
    assert.equal(branch.ok, true);
    if (!branch.ok) return;
    assert.equal(branch.snapshot.baseBranch, 'main');
    assert.equal(branch.snapshot.currentBranch, 'feature/review');
    assert.deepEqual(branch.snapshot.baseBranchOptions, [
      'feature/review',
      'main',
    ]);
    assert.deepEqual(
      branch.snapshot.files.map((file) => file.path).sort(),
      ['base.txt', 'feature.txt', 'staged.txt', 'untracked.txt'],
    );
    assert.ok(branch.snapshot.additions >= 4);

    const currentBranchOnly = await readGitReview(
      root,
      'branch',
      undefined,
      'feature/review',
    );
    assert.equal(currentBranchOnly.ok, true);
    if (currentBranchOnly.ok) {
      assert.equal(currentBranchOnly.snapshot.baseBranch, 'feature/review');
      assert.equal(
        currentBranchOnly.snapshot.files.some((file) => file.path === 'feature.txt'),
        false,
      );
    }
    assert.deepEqual(
      await readGitReview(root, 'branch', undefined, 'missing-branch'),
      { ok: false, reason: 'invalid_base_branch' },
    );

    const unstaged = await readGitReview(root, 'unstaged');
    assert.equal(unstaged.ok, true);
    if (!unstaged.ok) return;
    assert.deepEqual(
      unstaged.snapshot.files.map((file) => file.path).sort(),
      ['base.txt', 'untracked.txt'],
    );

    const staged = await readGitReview(root, 'staged');
    assert.equal(staged.ok, true);
    if (!staged.ok) return;
    assert.deepEqual(
      staged.snapshot.files.map((file) => file.path),
      ['staged.txt'],
    );
  });

  it('returns an explicit non-repository outcome', async () => {
    const root = await temporaryRoot();
    assert.deepEqual(await readGitReview(root, 'branch'), {
      ok: false,
      reason: 'not_git_repository',
    });
  });

  it('includes staged and unstaged changes when the current branch is the base', async () => {
    const root = await repository();
    await writeFile(join(root, 'base.txt'), 'base\nchanged\n', 'utf8');
    await writeFile(join(root, 'staged.txt'), 'staged\n', 'utf8');
    await git(root, 'add', 'staged.txt');

    const result = await readGitReview(root, 'branch');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.baseBranch, null);
    assert.deepEqual(
      result.snapshot.files.map((file) => file.path).sort(),
      ['base.txt', 'staged.txt'],
    );
  });

  it('compares a branch from its merge base when the base branch has advanced', async () => {
    const root = await repository();
    await git(root, 'checkout', '-b', 'feature/review');
    await writeFile(join(root, 'feature.txt'), 'feature\n', 'utf8');
    await git(root, 'add', 'feature.txt');
    await git(root, 'commit', '-m', 'feature');

    await git(root, 'checkout', 'main');
    await writeFile(join(root, 'main-only.txt'), 'main only\n', 'utf8');
    await git(root, 'add', 'main-only.txt');
    await git(root, 'commit', '-m', 'advance main');
    await git(root, 'checkout', 'feature/review');

    const result = await readGitReview(root, 'branch');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.snapshot.files.map((file) => file.path),
      ['feature.txt'],
    );
  });

});

async function repository(): Promise<string> {
  const root = await temporaryRoot();
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Maka Test');
  await git(root, 'config', 'user.email', 'maka@example.invalid');
  await writeFile(join(root, 'base.txt'), 'base\n', 'utf8');
  await git(root, 'add', 'base.txt');
  await git(root, 'commit', '-m', 'base');
  return root;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-git-review-'));
  roots.add(root);
  return root;
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
}
