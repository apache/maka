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
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, test } from 'node:test';
import { createGitWorktreeChildExecutor } from '../git-worktree-child-executor.js';
import { createGitRepositoryWithWorktree } from './fixtures/git-repository.js';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Git worktree child executor', () => {
  test('reports availability only when the source workspace is a Git project', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    const folder = join(root, 'folder');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    await writeFileAfterMkdir(folder, 'file.txt', 'plain\n');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });

    assert.equal(await executor.isAvailable({ sourceCwd: repository }), true);
    assert.equal(await executor.isAvailable({ sourceCwd: folder }), false);
    assert.equal(await executor.isAvailable({ sourceCwd: join(root, 'missing') }), false);
  });

  test('provisions deterministic isolated worktrees for concurrent child leases', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });
    const [left, right] = await Promise.all([
      executor.provision({
        leaseId: `subagent_worktree_${'1'.repeat(32)}`,
        sourceSessionId: 'parent-session',
        sourceCwd: repository,
        sourceProjectId: 'project-1',
      }),
      executor.provision({
        leaseId: `subagent_worktree_${'2'.repeat(32)}`,
        sourceSessionId: 'parent-session',
        sourceCwd: repository,
        sourceProjectId: 'project-1',
      }),
    ]);

    assert.notEqual(left.worktreePath, right.worktreePath);
    assert.notEqual(left.branch, right.branch);
    assert.equal((await stat(left.worktreePath)).isDirectory(), true);
    assert.equal((await stat(right.worktreePath)).isDirectory(), true);
    assert.equal(await git(left.worktreePath, 'branch', '--show-current'), left.branch);
    assert.equal(await git(right.worktreePath, 'branch', '--show-current'), right.branch);
    assert.equal(left.baseCommit, await git(repository, 'rev-parse', 'HEAD'));
    assert.equal(right.baseCommit, left.baseCommit);

    await writeFile(join(left.worktreePath, 'left.txt'), 'left\n', 'utf8');
    await writeFile(join(right.worktreePath, 'right.txt'), 'right\n', 'utf8');
    assert.match(await git(left.worktreePath, 'status', '--short'), /left\.txt/);
    assert.match(await git(right.worktreePath, 'status', '--short'), /right\.txt/);
    assert.equal(await git(repository, 'status', '--short'), '');
  });

  test('reuses the durable branch/path binding across executor restart and child edits', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    const storageRoot = join(root, 'storage');
    const request = {
      leaseId: `subagent_worktree_${'3'.repeat(32)}`,
      sourceSessionId: 'parent-session',
      sourceCwd: repository,
    };
    const first = await createGitWorktreeChildExecutor({ storageRoot }).provision(request);
    await writeFile(join(first.worktreePath, 'work.txt'), 'work\n', 'utf8');
    await git(first.worktreePath, 'switch', '-c', 'maka/issue-3-a-contract');

    const restarted = createGitWorktreeChildExecutor({ storageRoot });
    const second = await restarted.provision(request);
    assert.deepEqual(second, first);
    await restarted.ensure(first);
    assert.equal(
      await git(first.worktreePath, 'branch', '--show-current'),
      'maka/issue-3-a-contract',
    );
    assert.match(await git(first.worktreePath, 'status', '--short'), /work\.txt/);

    await git(
      first.worktreePath,
      'config',
      '--local',
      `branch.${first.branch}.maka-worktree-lease`,
      `subagent_worktree_${'f'.repeat(32)}`,
    );
    await assert.rejects(restarted.ensure(first), /worktree lease changed/);
  });

  test('captures committed, tracked, and untracked changes as one base-relative patch', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });
    const binding = await executor.provision({
      leaseId: `subagent_worktree_${'6'.repeat(32)}`,
      sourceSessionId: 'parent-session',
      sourceCwd: repository,
    });

    await writeFile(join(binding.worktreePath, 'tracked.txt'), 'committed change\n', 'utf8');
    await writeFile(join(binding.worktreePath, '.gitignore'), 'forced.txt\n', 'utf8');
    await writeFile(join(binding.worktreePath, 'forced.txt'), 'forced committed change\n', 'utf8');
    await git(binding.worktreePath, 'add', 'tracked.txt', '.gitignore');
    await git(binding.worktreePath, 'add', '--force', 'forced.txt');
    await git(
      binding.worktreePath,
      '-c',
      'user.name=Maka Test',
      '-c',
      'user.email=test@maka.invalid',
      'commit',
      '-m',
      'child commit',
    );
    await writeFile(join(binding.worktreePath, 'pending.txt'), 'pending change\n', 'utf8');

    const patch = Buffer.from(await executor.capturePatch(binding)).toString('utf8');
    assert.match(patch, /diff --git a\/tracked\.txt b\/tracked\.txt/);
    assert.match(patch, /\+committed change/);
    assert.match(patch, /diff --git a\/forced\.txt b\/forced\.txt/);
    assert.match(patch, /\+forced committed change/);
    assert.match(patch, /diff --git a\/pending\.txt b\/pending\.txt/);
    assert.match(patch, /\+pending change/);
  });

  test('captures complete patches larger than the former 10 MiB process buffer', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });
    const binding = await executor.provision({
      leaseId: `subagent_worktree_${'b'.repeat(32)}`,
      sourceSessionId: 'parent-session',
      sourceCwd: repository,
    });
    const formerCeiling = 10 * 1024 * 1024;
    await writeFile(
      join(binding.worktreePath, 'large-generated.txt'),
      'x'.repeat(formerCeiling + 1024),
      'utf8',
    );

    const patch = await executor.capturePatch(binding);

    assert.ok(patch.byteLength > formerCeiling);
    assert.match(Buffer.from(patch.subarray(0, 512)).toString('utf8'), /large-generated\.txt/);
  });

  test('retires only the Host lease branch after a child switches branches', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });
    const binding = await executor.provision({
      leaseId: `subagent_worktree_${'7'.repeat(32)}`,
      sourceSessionId: 'parent-session',
      sourceCwd: repository,
    });
    await git(binding.worktreePath, 'switch', '-c', 'child-owned-branch');
    await writeFile(join(binding.worktreePath, 'ignored.tmp'), 'discard me\n', 'utf8');

    await executor.retire(binding);
    await executor.retire(binding);

    await assert.rejects(stat(binding.worktreePath), { code: 'ENOENT' });
    assert.equal(await git(repository, 'branch', '--list', binding.branch), '');
    assert.equal(
      await git(repository, 'branch', '--list', 'child-owned-branch'),
      'child-owned-branch',
    );
  });

  test('recovery preserves live bindings and retires orphaned worktrees', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    const storageRoot = join(root, 'storage');
    const executor = createGitWorktreeChildExecutor({ storageRoot });
    const live = await executor.provision({
      leaseId: `subagent_worktree_${'8'.repeat(32)}`,
      sourceSessionId: 'parent-session',
      sourceCwd: repository,
    });
    const orphan = await executor.provision({
      leaseId: `subagent_worktree_${'9'.repeat(32)}`,
      sourceSessionId: 'parent-session',
      sourceCwd: repository,
    });
    const partial = join(storageRoot, 'subagent-worktrees', 'a'.repeat(32));
    await mkdir(partial);

    await createGitWorktreeChildExecutor({ storageRoot }).recover([live]);

    assert.equal((await stat(live.worktreePath)).isDirectory(), true);
    await assert.rejects(stat(orphan.worktreePath), { code: 'ENOENT' });
    await assert.rejects(stat(partial), { code: 'ENOENT' });
    assert.equal(await git(repository, 'branch', '--list', orphan.branch), '');
  });

  test('fails closed when a fresh lease would omit uncommitted parent work', async () => {
    const root = await temporaryRoot();
    const repository = join(root, 'repository');
    await createGitRepositoryWithWorktree(repository, join(root, 'existing-worktree'), 'existing');
    await writeFile(join(repository, 'dirty.txt'), 'dirty\n', 'utf8');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });

    await assert.rejects(
      executor.provision({
        leaseId: `subagent_worktree_${'4'.repeat(32)}`,
        sourceSessionId: 'parent-session',
        sourceCwd: repository,
      }),
      /no uncommitted changes/,
    );
  });

  test('rejects non-Git project roots', async () => {
    const root = await temporaryRoot();
    const source = join(root, 'folder');
    await writeFileAfterMkdir(source, 'file.txt', 'plain\n');
    const executor = createGitWorktreeChildExecutor({ storageRoot: join(root, 'storage') });

    await assert.rejects(
      executor.provision({
        leaseId: `subagent_worktree_${'5'.repeat(32)}`,
        sourceSessionId: 'parent-session',
        sourceCwd: source,
      }),
      /requires a Git project/,
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-worktree-child-'));
  cleanup.push(root);
  return root;
}

async function writeFileAfterMkdir(root: string, name: string, contents: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, name), contents, 'utf8');
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}
