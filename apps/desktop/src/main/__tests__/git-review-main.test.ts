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
    assert.equal(branch.snapshot.baseBranch, 'refs/heads/main');
    assert.equal(branch.snapshot.currentBranch, 'feature/review');
    assert.deepEqual(branch.snapshot.baseBranchOptions, [
      { label: 'main', value: 'refs/heads/main' },
      { label: 'feature/review', value: 'refs/heads/feature/review' },
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
      assert.equal(currentBranchOnly.snapshot.baseBranch, 'refs/heads/feature/review');
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

  it('lists the remote default branch before the branches it resolves from', async () => {
    const origin = await repository();
    await git(origin, 'branch', 'release/0.1');
    const root = await temporaryRoot();
    await git(root, 'clone', origin, '.');

    const result = await readGitReview(root, 'branch');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.baseBranch, 'refs/remotes/origin/main');
    assert.deepEqual(result.snapshot.baseBranchOptions, [
      { label: 'origin/HEAD', value: 'refs/remotes/origin/HEAD' },
      { label: 'origin/main', value: 'refs/remotes/origin/main' },
      { label: 'main', value: 'refs/heads/main' },
      { label: 'origin/release/0.1', value: 'refs/remotes/origin/release/0.1' },
    ]);
  });

  it('compares the branch rather than a same-named tag, including legacy selections', async () => {
    const root = await repository();
    await git(root, 'tag', 'release');
    await git(root, 'checkout', '-b', 'release');
    await writeFile(join(root, 'release.txt'), 'release\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'release');
    await git(root, 'checkout', '-b', 'feature');
    await writeFile(join(root, 'feature.txt'), 'feature\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature');

    for (const selection of ['refs/heads/release', 'release']) {
      const result = await readGitReview(root, 'branch', undefined, selection);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.snapshot.baseBranch, 'refs/heads/release');
      assert.deepEqual(result.snapshot.files.map((file) => file.path), ['feature.txt']);
      assert.ok(result.snapshot.baseBranchOptions.every((option) =>
        option.value.startsWith('refs/heads/') || option.value.startsWith('refs/remotes/')));
    }
    assert.deepEqual(await readGitReview(root, 'branch', undefined, 'refs/tags/release'),
      { ok: false, reason: 'invalid_base_branch' });
    await git(root, 'tag', 'tag-only');
    assert.deepEqual(await readGitReview(root, 'branch', undefined, 'tag-only'),
      { ok: false, reason: 'invalid_base_branch' });
  });

  it('keeps local and remote refs with the same label distinct and rejects ambiguous legacy names', async () => {
    const root = await repository();
    await git(root, 'update-ref', 'refs/remotes/origin/release', 'HEAD');
    await git(root, 'checkout', '-b', 'origin/release');
    await writeFile(join(root, 'local.txt'), 'local\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'local');
    const local = await readGitReview(root, 'branch', undefined, 'refs/heads/origin/release');
    const remote = await readGitReview(root, 'branch', undefined, 'refs/remotes/origin/release');
    assert.equal(local.ok, true);
    assert.equal(remote.ok, true);
    if (!local.ok || !remote.ok) return;
    assert.equal(local.snapshot.files.length, 0);
    assert.deepEqual(remote.snapshot.files.map((file) => file.path), ['local.txt']);
    assert.equal(local.snapshot.baseBranchOptions.filter((option) => option.label === 'origin/release').length, 2);
    assert.deepEqual(await readGitReview(root, 'branch', undefined, 'origin/release'),
      { ok: false, reason: 'invalid_base_branch' });
  });

  it('resolves the default branch without following a same-named tag', async () => {
    const root = await repository();
    await git(root, 'tag', 'main');
    await writeFile(join(root, 'main.txt'), 'main\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'advance main');
    await git(root, 'checkout', '-b', 'feature');
    const result = await readGitReview(root, 'branch');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.baseBranch, 'refs/heads/main');
    assert.equal(result.snapshot.files.length, 0);
  });

  it('returns branch choices when unrelated history prevents a diff, including on repeated reads', async () => {
    const root = await repository();
    await git(root, 'checkout', '--orphan', 'gh-pages');
    await git(root, 'rm', '-rf', '.');
    await writeFile(join(root, 'index.html'), 'site\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'independent site history');
    await git(root, 'checkout', 'main');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await readGitReview(root, 'branch', undefined, 'refs/heads/gh-pages');
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'git_failed');
      assert.deepEqual(result.branches, {
        currentBranch: 'main',
        baseBranchOptions: [
          { label: 'main', value: 'refs/heads/main' },
          { label: 'gh-pages', value: 'refs/heads/gh-pages' },
        ],
      });
    }
    const recovered = await readGitReview(root, 'branch', undefined, 'refs/heads/main');
    assert.equal(recovered.ok, true);
    if (recovered.ok) assert.equal(recovered.snapshot.files.length, 0);
  });

  it('degrades a diff that overflows the git buffer to a truncated review', async () => {
    const root = await repository();
    await git(root, 'checkout', '-b', 'feature');
    await writeFile(join(root, 'feature.txt'), 'feature\n', 'utf8');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'feature');

    const result = await readGitReview(root, 'branch', async (gitRoot, args) => {
      if (args.includes('--binary')) {
        // Node rejects an over-limit child buffer, handing back what it read.
        throw Object.assign(new Error('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout: [
            'diff --git a/feature.txt b/feature.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/feature.txt',
            '@@ -0,0 +1 @@',
            '+feature',
            '',
          ].join('\n'),
        });
      }
      const { stdout } = await execFileAsync('git', ['-C', gitRoot, ...args], {
        encoding: 'utf8',
      });
      return stdout;
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.truncated, true);
    assert.deepEqual(result.snapshot.files.map((file) => file.path), ['feature.txt']);
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
