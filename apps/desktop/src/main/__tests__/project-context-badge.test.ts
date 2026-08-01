import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectGitInfo, resolveProjectRoot } from '@maka/runtime';



describe('project context workspace picker', () => {
  it('resolves git branch from normal and worktree-style .git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-project-context-'));
    const worktree = await mkdtemp(join(tmpdir(), 'maka-project-context-worktree-'));
    const gitDir = await mkdtemp(join(tmpdir(), 'maka-project-context-gitdir-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      assert.deepEqual(await resolveProjectGitInfo(root), { isGitRepo: true, branch: 'main' });

      await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/sidebar\n', 'utf8');
      assert.deepEqual(await resolveProjectGitInfo(worktree), { isGitRepo: true, branch: 'feature/sidebar' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(gitDir, { recursive: true, force: true });
    }
  });

  it('resolves the project root by walking upward from nested app paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-project-root-'));
    const nested = join(root, 'apps', 'desktop');
    const fallback = await mkdtemp(join(tmpdir(), 'maka-project-root-fallback-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(nested, { recursive: true });

      assert.equal(await resolveProjectRoot(['/', nested]), root);
      assert.equal(await resolveProjectRoot([fallback]), fallback);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fallback, { recursive: true, force: true });
    }
  });







});
