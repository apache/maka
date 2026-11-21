import { describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs, { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { extractReport } from '../src/extract.ts';

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(osTmpdir(), 'diffmap-test-'));
  sh('git -c init.defaultBranch=main init', dir);
  sh('git config user.email t@t.local', dir);
  sh('git config user.name t', dir);

  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'line1\nline2\nline3\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'b\n');
  writeFileSync(join(dir, 'docs', 'd.md'), 'doc line1\ndoc line2\n');
  writeFileSync(join(dir, 'bin', 'img.bin'), Buffer.from([1, 0, 1, 2]));

  sh('git add -A', dir);
  sh('git commit -m base', dir);
  return dir;
}

describe('extractReport（真实 git 仓库）', () => {
  it.each(['before-stat', 'after-stat'])('文件在指纹读取期间消失仍返回报告且不复用审查标记：%s', async (phase) => {
    const dir = makeRepo();
    const file = join(dir, 'disappears.txt');
    writeFileSync(file, 'temporary\n');
    const lstat = fs.lstatSync;
    const stat = vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof lstat>) => {
      if (String(args[0]) === file && phase === 'before-stat') unlinkSync(file);
      const value = lstat(...args);
      if (String(args[0]) === file && phase === 'after-stat') unlinkSync(file);
      return value;
    }) as typeof lstat);
    syncBuiltinESMExports();
    try {
      const report = await extractReport({ repoRoot: dir, mode: 'worktree' });
      const disappeared = report.files.find((f) => f.path === 'disappears.txt');
      expect(disappeared).toBeDefined();
      expect(disappeared!.fingerprint).toBeUndefined();
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('worktree 模式：修改/重命名/删除/未跟踪/二进制全覆盖', async () => {
    const dir = makeRepo();
    try {
      // 修改
      writeFileSync(join(dir, 'src', 'a.ts'), 'line1\nLINE2 changed\nline3\nline4\n');
      // 重命名（无内容变化）
      sh('git mv src/b.ts src/c.ts', dir);
      // 删除
      rmSync(join(dir, 'docs', 'd.md'));
      // 二进制修改
      writeFileSync(join(dir, 'bin', 'img.bin'), Buffer.from([9, 0, 8, 7]));
      // 未跟踪新文件
      mkdirSync(join(dir, 'new'), { recursive: true });
      writeFileSync(join(dir, 'new', 'u.txt'), 'u1\nu2\n');

      const report = await extractReport({ repoRoot: dir, mode: 'worktree' });

      expect(report.mode).toBe('worktree');
      expect(report.repoName).toBeTruthy();
      const byPath = new Map(report.files.map((f) => [f.path, f]));

      const a = byPath.get('src/a.ts')!;
      expect(a.kind).toBe('modified');
      expect(a.additions).toBe(2);
      expect(a.deletions).toBe(1);
      const addedTexts = a.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add');
      expect(addedTexts.map((l) => l.text)).toEqual(['LINE2 changed', 'line4']);

      const c = byPath.get('src/c.ts')!;
      expect(c.kind).toBe('renamed');
      expect(c.oldPath).toBe('src/b.ts');

      expect(byPath.get('docs/d.md')!.kind).toBe('deleted');
      expect(byPath.get('docs/d.md')!.deletions).toBe(2);

      const img = byPath.get('bin/img.bin')!;
      expect(img.binary).toBe(true);
      expect(img.hunks).toHaveLength(0);

      const u = byPath.get('new/u.txt')!;
      expect(u.kind).toBe('added');
      expect(u.untracked).toBe(true);
      expect(u.additions).toBe(2);
      expect(u.hunks[0]!.lines.map((l) => l.text)).toEqual(['u1', 'u2']);

      expect(report.totalAdditions).toBe(4); // a.ts 2 + u.txt 2，二进制不计
      expect(report.totalDeletions).toBe(3); // a.ts 1 + d.md 2
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base 模式：只算分支相对基线的变更', async () => {
    const dir = makeRepo();
    try {
      sh('git checkout -b feat', dir);
      writeFileSync(join(dir, 'src', 'a.ts'), 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n');
      sh('git add -A', dir);
      sh('git commit -m feat1', dir);
      writeFileSync(join(dir, 'feat-only.ts'), 'f1\nf2\nf3\n');
      sh('git add -A', dir);
      sh('git commit -m feat2', dir);

      const report = await extractReport({ repoRoot: dir, mode: 'base', baseRef: 'main' });

      expect(report.mode).toBe('base');
      expect(report.baseRef).toBe('main');
      const paths = report.files.map((f) => f.path).sort();
      expect(paths).toEqual(['feat-only.ts', 'src/a.ts']);
      expect(report.totalAdditions).toBe(8); // a.ts +5，feat-only.ts +3
      expect(report.totalDeletions).toBe(0);
      // merge-base 应等于 main 的 tip
      const mainTip = execSync('git rev-parse main', { cwd: dir, encoding: 'utf8' }).trim();
      expect(report.baseSha).toBe(mainTip);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('base 模式的 diff 包含未提交修改', async () => {
    const dir = makeRepo();
    try {
      sh('git checkout -b feat', dir);
      sh('git commit --allow-empty -m start', dir);
      // 不提交，直接改工作区
      writeFileSync(join(dir, 'src', 'a.ts'), 'dirty\n');
      const report = await extractReport({ repoRoot: dir, mode: 'base', baseRef: 'main' });
      const a = report.files.find((f) => f.path === 'src/a.ts')!;
      expect(a.additions).toBe(1);
      expect(a.deletions).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('中文文件名（quotepath 关闭）也能对上', async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, 'docs', '设计文档.md'), '# 标题\n内容\n');
      const report = await extractReport({ repoRoot: dir, mode: 'worktree' });
      const f = report.files.find((x) => x.path === 'docs/设计文档.md');
      expect(f).toBeTruthy();
      expect(f!.additions).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不修改原文件内容', async () => {
    const dir = makeRepo();
    try {
      const before = readFileSync(join(dir, 'src', 'a.ts'), 'utf8');
      await extractReport({ repoRoot: dir, mode: 'worktree' });
      expect(readFileSync(join(dir, 'src', 'a.ts'), 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
