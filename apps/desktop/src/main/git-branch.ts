import { execFile, type ExecFileException } from 'node:child_process';
import { resolveProjectGitInfo } from '@maka/runtime';

/**
 * git-branch.ts — local-only git branch listing and checkout for the
 * desktop main process. We deliberately shell out to `git` here (unlike
 * build-info.ts, which reads `.git` metadata directly to avoid coupling
 * the build-time module to a `git` binary). Branch switching needs the
 * real git CLI to honor worktrees, hooks, and conflict semantics.
 *
 * The injectable `execFileImpl` lets unit tests fake the child process.
 */

export type GitBranchReason = 'missing-git' | 'not-a-repo' | 'failed' | 'timeout' | 'dirty';

export interface GitBranchListResult {
  ok: boolean;
  branches?: string[];
  current?: string;
  reason?: GitBranchReason;
  message?: string;
}

export interface GitCheckoutResult {
  ok: boolean;
  branch?: string;
  reason?: GitBranchReason;
  message?: string;
}

const LIST_TIMEOUT_MS = 3_000;
const CHECKOUT_TIMEOUT_MS = 10_000;

type ExecFileCallback = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean },
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

function classifyError(error: ExecFileException | null): GitBranchReason | undefined {
  if (!error) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'missing-git';
  if (code === 'ETIMEDOUT' || (error as { killed?: boolean }).killed) return 'timeout';
  return 'failed';
}

function runGit(
  input: {
    cwd: string;
    args: readonly string[];
    timeoutMs: number;
    execFileImpl?: ExecFileCallback;
  },
): Promise<{ stdout: string; stderr: string; error: ExecFileException | null }> {
  const execFileImpl = input.execFileImpl ?? (execFile as unknown as ExecFileCallback);
  return new Promise((resolve) => {
    execFileImpl(
      'git',
      input.args,
      { cwd: input.cwd, timeout: input.timeoutMs, windowsHide: true },
      (error, stdout, stderr) => resolve({ stdout, stderr, error }),
    );
  });
}

export async function listLocalBranches(
  projectRoot: string,
  input: { execFileImpl?: ExecFileCallback } = {},
): Promise<GitBranchListResult> {
  // Guard against non-repos so we never spawn `git` inside an unrelated
  // ancestor (currentProjectRoot can fall back to process.cwd()).
  const info = await resolveProjectGitInfo(projectRoot);
  if (!info.isGitRepo) return { ok: false, reason: 'not-a-repo' };

  const { stdout, stderr, error } = await runGit({
    cwd: projectRoot,
    args: ['branch', '--list'],
    timeoutMs: LIST_TIMEOUT_MS,
    execFileImpl: input.execFileImpl,
  });
  if (error) {
    const reason = classifyError(error);
    return { ok: false, reason, message: stderr.trim() || error.message };
  }

  const branches: string[] = [];
  let current: string | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const isCurrent = line.startsWith('* ');
    const name = (isCurrent ? line.slice(2) : line).trim();
    if (!name || name.startsWith('(')) continue; // skip detached `(HEAD detached at …)`
    if (!branches.includes(name)) branches.push(name);
    if (isCurrent) current = name;
  }
  return { ok: true, branches, current };
}

export async function checkoutBranch(
  projectRoot: string,
  branch: string,
  input: { execFileImpl?: ExecFileCallback } = {},
): Promise<GitCheckoutResult> {
  if (!branch || typeof branch !== 'string' || /[\s`$&;|<>]/.test(branch)) {
    return { ok: false, reason: 'failed', message: '无效的分支名' };
  }

  const info = await resolveProjectGitInfo(projectRoot);
  if (!info.isGitRepo) return { ok: false, reason: 'not-a-repo' };

  // Guard against dirty worktree: refuse checkout when there are
  // uncommitted changes the user could lose or mix up.
  const { stdout: statusOutput, stderr: statusErrorOutput, error: statusError } = await runGit({
    cwd: projectRoot,
    args: ['status', '--porcelain'],
    timeoutMs: LIST_TIMEOUT_MS,
    execFileImpl: input.execFileImpl,
  });
  if (statusError) {
    const reason = classifyError(statusError);
    return { ok: false, reason, message: statusErrorOutput.trim() || statusError.message };
  }
  if (statusOutput.trim()) {
    return { ok: false, reason: 'dirty', message: '工作区有未提交的更改，请先提交或暂存。' };
  }

  const { stderr, error } = await runGit({
    cwd: projectRoot,
    args: ['checkout', branch],
    timeoutMs: CHECKOUT_TIMEOUT_MS,
    execFileImpl: input.execFileImpl,
  });
  if (error) {
    const reason = classifyError(error);
    return { ok: false, reason, message: stderr.trim() || error.message };
  }

  // Re-read HEAD to confirm the switch actually landed (handles race
  // conditions where another process moved HEAD between checkout and now).
  const after = await resolveProjectGitInfo(projectRoot);
  return { ok: true, branch: after.branch ?? branch };
}
