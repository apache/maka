import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SessionSummary } from '@maka/core/session';

const execFileAsync = promisify(execFile);

export async function resolveMoveCwd(rawCwd: string, currentCwd: string): Promise<string> {
  const input = rawCwd.trim();
  if (!input) throw new Error('Working directory cannot be empty.');
  const unquoted =
    input.length >= 2 &&
    ((input.startsWith('"') && input.endsWith('"')) ||
      (input.startsWith("'") && input.endsWith("'")))
      ? input.slice(1, -1)
      : input;
  const expanded =
    unquoted === '~'
      ? homedir()
      : unquoted.startsWith('~/')
        ? resolve(homedir(), unquoted.slice(2))
        : unquoted;
  const candidate = resolve(currentCwd, expanded);
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Working directory does not exist: ${candidate}`);
    }
    throw error;
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Working directory is not a directory: ${canonical}`);
  }
  return canonical;
}

export async function inspectGitCwdChanges(cwd: string): Promise<boolean | undefined> {
  try {
    const result = await execFileAsync(
      'git',
      ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=normal'],
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      },
    );
    return result.stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}

export function cwdRank(session: SessionSummary, cwd: string): number {
  return session.cwd === cwd ? 0 : 1;
}

export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '(empty prompt)'
  );
}
