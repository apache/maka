import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { git, findRepoRoot, resolveRef, mergeBase } from './git.ts';
import { parseNumstat } from './numstat.ts';
import { parseDiffSections, attachSections } from './diffparse.ts';
import type { DiffFile, DiffMode, DiffReport } from './types.ts';

export interface ExtractOptions {
  /** 仓库内任意目录，会先归一到仓库根 */
  cwd?: string;
  repoRoot?: string;
  mode: DiffMode;
  baseRef?: string;
}

function parseUntracked(raw: string): string[] {
  return raw
    .split('\0')
    .filter((s) => s.startsWith('?? '))
    .map((s) => s.slice(3).replaceAll('\\', '/'));
}

/** 未跟踪文件没进过 git，自己合成"整文件新增"的 diff */
function synthUntracked(repoRoot: string, relPath: string): DiffFile {
  const abs = path.join(repoRoot, relPath);
  let binary = false;
  let lines: string[] = [];
  try {
    const buf = fs.readFileSync(abs);
    binary = buf.subarray(0, 8000).includes(0);
    if (!binary) {
      lines = buf.toString('utf8').split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    }
  } catch {
    /* 读不到（竞态删除）就按空文件处理 */
  }
  return {
    path: relPath,
    kind: 'added',
    additions: binary ? 0 : lines.length,
    deletions: 0,
    binary,
    untracked: true,
    hunks: binary
      ? []
      : [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            lines: lines.map((text, i) => ({ type: 'add' as const, newNo: i + 1, text })),
          },
        ],
  };
}

export async function extractReport(opts: ExtractOptions): Promise<DiffReport> {
  const repoRoot = opts.repoRoot ?? (await findRepoRoot(opts.cwd ?? process.cwd()));
  const headSha = await resolveRef('HEAD', repoRoot);

  let baseSha: string;
  let diffBase: string;
  if (opts.mode === 'base') {
    if (!opts.baseRef) throw new Error('base 模式需要 --base <ref>');
    const baseTip = await resolveRef(opts.baseRef, repoRoot);
    baseSha = await mergeBase(baseTip, headSha, repoRoot);
    diffBase = baseSha;
  } else {
    baseSha = headSha;
    diffBase = 'HEAD';
  }

  // numstat 拿统计与文件清单；-z 保证路径无歧义
  const numstatRaw = await git(['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', '-M', diffBase], repoRoot);
  const entries = parseNumstat(numstatRaw);
  const files: DiffFile[] = entries.map((e) => ({
    path: e.path,
    oldPath: e.oldPath,
    kind: e.oldPath ? 'renamed' : 'modified',
    additions: e.additions,
    deletions: e.deletions,
    binary: e.binary,
    hunks: [],
  }));

  // 整段 diff 一次拿全，按节对回文件（避免 500 文件 500 次 spawn）
  const text = await git(
    [
      '-c', 'core.quotepath=false',
      'diff', '--no-color', '--no-ext-diff', '--no-textconv',
      '--src-prefix=a/', '--dst-prefix=b/',
      '-M', diffBase,
    ],
    repoRoot,
  );
  attachSections(files, parseDiffSections(text));

  // 未跟踪文件补进清单（git diff 看不到它们）
  const statusRaw = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot);
  for (const p of parseUntracked(statusRaw)) {
    files.push(synthUntracked(repoRoot, p));
  }

  for (const file of files) {
    const hash = createHash('sha256').update(JSON.stringify(file));
    if (file.kind !== 'deleted') {
      const abs = path.join(repoRoot, file.path);
      try {
        const stat = fs.lstatSync(abs);
        hash.update(String(stat.mode & 0o111));
        if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(abs));
        else if (stat.isFile()) hash.update(fs.readFileSync(abs));
        else continue; // 子模块等目录不能由本报告证明内容未变，不提供可复用指纹。
      } catch (error) {
        // 清单提取后竞态消失的文件保留条目，但不能复用审查标记。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
    }
    file.fingerprint = hash.digest('hex');
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    mode: opts.mode,
    baseRef: opts.mode === 'base' ? opts.baseRef : undefined,
    baseSha,
    headSha,
    generatedAt: new Date().toISOString(),
    totalAdditions,
    totalDeletions,
    files,
  };
}
