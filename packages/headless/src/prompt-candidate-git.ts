import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PromptCandidateGit {
  gitRootPath: string;
  systemPromptGitPath: string;
  assertSystemPromptClean(): Promise<void>;
  changedFiles(): Promise<readonly string[]>;
  commit(message: string): Promise<string>;
  rollbackCommit(commitSha: string): Promise<void>;
  restoreSystemPrompt(): Promise<void>;
}

export interface CreateCliPromptCandidateGitInput {
  cwd: string;
  systemPromptPath: string;
}

export function assertOnlySystemPromptChanged(
  changedFiles: readonly string[],
  systemPromptGitPath: string,
): void {
  const allowed = normalizeGitPath(systemPromptGitPath);
  const unexpected = changedFiles.filter((file) => normalizeGitPath(file) !== allowed);
  if (unexpected.length > 0) {
    throw new Error(`only ${allowed} may change; unexpected files: ${unexpected.join(', ')}`);
  }
}

export async function assertRegularSystemPromptFile(
  systemPromptPath: string,
  gitRootPath: string,
): Promise<void> {
  const stat = await lstat(systemPromptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('system_prompt.md must be a regular file');
  }
  const [promptRealPath, gitRootRealPath] = await Promise.all([
    realpath(systemPromptPath),
    realpath(gitRootPath),
  ]);
  if (!isPathInside(gitRootRealPath, promptRealPath)) {
    throw new Error('system_prompt.md must stay inside the git cwd');
  }
}

export function createCliPromptCandidateGit(
  input: CreateCliPromptCandidateGitInput,
): PromptCandidateGit {
  const gitRootPath = realpathSync(findGitRoot(input.cwd));
  const systemPromptPath = isAbsolute(input.systemPromptPath)
    ? realpathSync(input.systemPromptPath)
    : realpathSync(resolve(input.cwd, input.systemPromptPath));
  const systemPromptGitPath = toGitRelativePath(gitRootPath, systemPromptPath);
  let statusBaseline: ReadonlyMap<string, string> | undefined;
  let headBaseline: string | undefined;
  return {
    gitRootPath,
    systemPromptGitPath,
    async assertSystemPromptClean(): Promise<void> {
      if (!(await isGitTracked(gitRootPath, systemPromptGitPath))) {
        throw new Error('system_prompt.md must be tracked before candidate round');
      }
      const [worktreeDirty, indexDirty] = await Promise.all([
        hasGitDiff(gitRootPath, ['diff', '--quiet', '--', systemPromptGitPath]),
        hasGitDiff(gitRootPath, ['diff', '--cached', '--quiet', '--', systemPromptGitPath]),
      ]);
      if (worktreeDirty || indexDirty) {
        throw new Error('system_prompt.md must be clean before candidate round');
      }
      [statusBaseline, headBaseline] = await Promise.all([
        gitStatusSnapshot(gitRootPath),
        gitHeadSha(gitRootPath),
      ]);
    },
    async changedFiles(): Promise<readonly string[]> {
      await assertGitHeadUnchanged(gitRootPath, headBaseline);
      const baseline = statusBaseline ?? new Map<string, string>();
      const current = await gitStatusSnapshot(gitRootPath);
      const paths = new Set([...baseline.keys(), ...current.keys()]);
      return [...paths].filter((path) => baseline.get(path) !== current.get(path));
    },
    async commit(message: string): Promise<string> {
      await assertGitHeadUnchanged(gitRootPath, headBaseline);
      await execFileAsync('git', ['add', '--', systemPromptGitPath], { cwd: gitRootPath });
      await execFileAsync('git', ['commit', '-m', message, '--', systemPromptGitPath], {
        cwd: gitRootPath,
      });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: gitRootPath });
      return stdout.trim();
    },
    async rollbackCommit(commitSha: string): Promise<void> {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: gitRootPath });
      if (stdout.trim() !== commitSha) {
        throw new Error('candidate prompt commit cannot be rolled back because HEAD moved');
      }
      await execFileAsync('git', ['reset', '--soft', `${commitSha}^`], { cwd: gitRootPath });
      await execFileAsync('git', ['restore', '--staged', '--worktree', '--', systemPromptGitPath], {
        cwd: gitRootPath,
      });
    },
    async restoreSystemPrompt(): Promise<void> {
      await execFileAsync('git', ['restore', '--staged', '--worktree', '--', systemPromptGitPath], {
        cwd: gitRootPath,
      });
    },
  };
}

async function assertGitHeadUnchanged(cwd: string, baseline: string | undefined): Promise<void> {
  if (baseline === undefined) return;
  const current = await gitHeadSha(cwd);
  if (current !== baseline) {
    throw new Error('candidate round HEAD moved before prompt commit');
  }
}

async function gitHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

async function isGitTracked(cwd: string, path: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', path], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function hasGitDiff(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd });
    return false;
  } catch {
    return true;
  }
}

async function gitStatusFiles(cwd: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd },
  );
  return stdout
    .split('\n')
    .map((line) => statusPath(line))
    .filter((path): path is string => path !== undefined);
}

async function gitStatusSnapshot(cwd: string): Promise<ReadonlyMap<string, string>> {
  const snapshot = new Map<string, string>();
  for (const path of await gitStatusFiles(cwd)) {
    snapshot.set(path, await gitStatusFingerprint(cwd, path));
  }
  return snapshot;
}

async function gitStatusFingerprint(cwd: string, path: string): Promise<string> {
  const [fileHash, worktreeDiff, indexDiff] = await Promise.all([
    fileFingerprint(resolve(cwd, path)),
    gitDiffFingerprint(cwd, ['diff', '--binary', '--', path]),
    gitDiffFingerprint(cwd, ['diff', '--cached', '--binary', '--', path]),
  ]);
  return [fileHash, worktreeDiff, indexDiff].join('\0');
}

async function fileFingerprint(path: string): Promise<string> {
  try {
    const content = await readFile(path);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    if (isNotFound(error)) return 'missing';
    throw error;
  }
}

async function gitDiffFingerprint(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'buffer' });
  return createHash('sha256').update(stdout).digest('hex');
}

function statusPath(line: string): string | undefined {
  const path = line.slice(3).trim();
  if (path.length === 0) return undefined;
  const renameSeparator = ' -> ';
  const renameIndex = path.indexOf(renameSeparator);
  return renameIndex === -1 ? path : path.slice(renameIndex + renameSeparator.length);
}

function findGitRoot(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath).split('\\').join('/');
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !isAbsolute(relativePath)
  );
}

function toGitRelativePath(cwd: string, path: string): string {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath).split('\\').join('/');
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error('system_prompt.md must be inside the git cwd');
  }
  return relativePath;
}

export function normalizeGitPath(path: string): string {
  let current = path;
  current = current.split('\\').join('/');
  while (current.startsWith('./')) current = current.slice(2);
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
