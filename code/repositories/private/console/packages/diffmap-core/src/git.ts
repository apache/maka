import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/** 整段 diff 可能几十 MB，maxBuffer 放宽到 256MB */
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
}

export async function findRepoRoot(cwd: string): Promise<string> {
  try {
    const out = await git(['rev-parse', '--show-toplevel'], cwd);
    return path.normalize(out.trim());
  } catch {
    throw new Error(`当前目录不是 git 仓库：${cwd}`);
  }
}

export async function resolveRef(ref: string, cwd: string): Promise<string> {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).trim();
  } catch {
    throw new Error(`找不到 git 引用：${ref}`);
  }
}

export async function mergeBase(a: string, b: string, cwd: string): Promise<string> {
  try {
    return (await git(['merge-base', a, b], cwd)).trim();
  } catch {
    throw new Error(`计算 merge-base 失败：${a} 与 ${b} 没有公共祖先`);
  }
}
