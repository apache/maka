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

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { runProcessWithBoundedTail, runShellWithBoundedTail } from '@maka/runtime/shell-exec';
import type { WorktreeInfo, WorktreeProjectConfig } from '@maka/core/worktree';
const exec = promisify(execFile);
export const WORKTREE_LOG_LIMIT = 24_000;
const LOG_LIMIT = WORKTREE_LOG_LIMIT;

export function projectDirectoryName(name: string): string {
  const folder =
    name
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .slice(0, 50)
      .replace(/^\.+|\.+$/g, '') || 'project';
  // Windows device names are reserved even when followed by an extension.
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(folder) ? `_${folder}` : folder;
}

export function validateConfig(config: WorktreeProjectConfig): WorktreeProjectConfig {
  if ('rootDirectory' in config)
    throw new Error('Project worktree root overrides are not supported');
  if (
    config.defaultMode !== undefined &&
    config.defaultMode !== 'main' &&
    config.defaultMode !== 'new'
  )
    throw new Error('Invalid default worktree mode');
  for (const script of [config.setupScript, config.cleanupScript])
    if (script && (script.length > 32_000 || script.includes('\0')))
      throw new Error('Invalid worktree script');
  return { ...config };
}
export async function git(
  cwd: string,
  args: string[],
  options: {
    /** Defaults to 30 seconds. Zero disables the timeout for long operations. */
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (timeoutMs === 0 || options.abortSignal) {
    // Long/cancellable operations may spawn LFS, filters or hooks. Own their
    // entire process tree and wait for termination before releasing the lane.
    const result = await runProcessWithBoundedTail('git', ['-C', cwd, ...args], {
      cwd,
      timeoutMs,
      maxRetainedChars: 4 * 1024 * 1024,
      abortSignal: options.abortSignal,
    });
    options.abortSignal?.throwIfAborted();
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      throw Object.assign(new Error(result.stderr || 'Git command failed'), {
        code: result.exitCode,
        killed: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    return result.stdout;
  }
  return (
    await exec('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    })
  ).stdout;
}
export async function commonDirectory(cwd: string): Promise<string> {
  return realpath(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).trim()));
}
export async function listGitWorktrees(
  cwd: string,
): Promise<Array<Pick<WorktreeInfo, 'path' | 'head' | 'branch' | 'isMain' | 'locked'>>> {
  return Promise.all(
    (await git(cwd, ['worktree', 'list', '--porcelain', '-z']))
      .split('\0\0')
      .filter(Boolean)
      .map(async (block, index) => {
        const lines = block.split('\0');
        const field = (key: string) =>
          lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
        const path = field('worktree');
        if (!path || lines.includes('bare')) throw new Error('Bare repositories are not supported');
        const branch = field('branch')?.replace(/^refs\/heads\//, '');
        return {
          path: await realpath(path).catch(() => resolve(path)),
          head: field('HEAD') ?? '',
          ...(branch ? { branch } : {}),
          isMain: index === 0,
          locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
        };
      }),
  );
}

/** Git discovery alone can walk from a deleted nested checkout into its parent repository. */
export async function assertGitWorktree(path: string, expectedCommonDir: string): Promise<void> {
  const canonical = await realpath(path);
  const root = await realpath((await git(path, ['rev-parse', '--show-toplevel'])).trim());
  if (
    root !== canonical ||
    (await commonDirectory(path)) !== expectedCommonDir ||
    !(await listGitWorktrees(path)).some((entry) => entry.path === canonical)
  )
    throw new Error('Session worktree identity has changed');
}

export async function runScript(
  script: string,
  cwd: string,
  abortSignal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; log: string }> {
  try {
    const result = await runShellWithBoundedTail(script, {
      cwd,
      timeoutMs: 600_000,
      maxRetainedChars: LOG_LIMIT,
      env,
      abortSignal,
    });
    const detail = result.timedOut
      ? '\nScript timed out.'
      : result.aborted
        ? '\nScript was interrupted.'
        : result.exitCode !== 0
          ? `\nScript exited with code ${result.exitCode}.`
          : '';
    return {
      ok: result.exitCode === 0 && !result.aborted && !result.timedOut,
      log: `${result.stdout}${result.stderr}${detail}`.slice(-LOG_LIMIT),
    };
  } catch (error) {
    return {
      ok: false,
      log: (error instanceof Error ? error.message : String(error)).slice(-LOG_LIMIT),
    };
  }
}
