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
