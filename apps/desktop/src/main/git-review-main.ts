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
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { countDiffLineStats } from '@maka/core/unified-diff';
import {
  type GitReviewFile,
  type GitReviewFileStatus,
  type GitReviewReadResult,
  type GitReviewSource,
} from '@maka/core/git-review';
import { resolveProjectGitInfo, resolveProjectRoot } from '@maka/runtime/system-prompt/project-context';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const REVIEW_MAX_FILES = 200;
const REVIEW_MAX_DIFF_CHARS = 8 * 1024 * 1024;

export interface GitReviewCommandRunner {
  (root: string, args: readonly string[]): Promise<string>;
}

export async function readGitReview(
  cwd: string,
  source: GitReviewSource,
  runGit: GitReviewCommandRunner = runGitCommand,
  requestedBaseBranch?: string,
): Promise<GitReviewReadResult> {
  try {
    const repositoryRoot = await resolveProjectRoot([cwd]);
    if (!(await resolveProjectGitInfo(repositoryRoot)).isGitRepo) {
      return { ok: false, reason: 'not_git_repository' };
    }

    const currentBranch = cleanLine(
      await runGit(repositoryRoot, ['branch', '--show-current']),
    );
    const hasHead = await gitRefExists(repositoryRoot, 'HEAD', runGit);
    const baseBranchOptions =
      source === 'branch' && hasHead
        ? await listBaseBranches(repositoryRoot, runGit)
        : [];
    if (
      source === 'branch' &&
      requestedBaseBranch != null &&
      !baseBranchOptions.includes(requestedBaseBranch)
    ) {
      return { ok: false, reason: 'invalid_base_branch' };
    }
    const baseBranch =
      source === 'branch' && hasHead
        ? requestedBaseBranch ??
          (await resolveBaseBranch(repositoryRoot, currentBranch, runGit))
        : null;
    const branchComparison =
      source === 'branch' && baseBranch
        ? cleanLine(
            await runGit(repositoryRoot, ['merge-base', baseBranch, 'HEAD']),
          )
        : null;
    const tracked = await readTrackedChanges({
      repositoryRoot,
      source,
      branchComparison,
      hasHead,
      runGit,
    });
    const files = [...tracked.files];
    let truncated = tracked.truncated;
    let diffChars = tracked.diffChars;

    if (source !== 'staged') {
      const untracked = await readUntrackedChanges(
        repositoryRoot,
        runGit,
        REVIEW_MAX_FILES - files.length,
        REVIEW_MAX_DIFF_CHARS - diffChars,
      );
      files.push(...untracked.files);
      diffChars += untracked.diffChars;
      truncated ||= untracked.truncated;
    }

    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          source,
          repositoryRoot,
          currentBranch,
          baseBranch,
          baseBranchOptions,
          files: files.map(({ path, previousPath, status, diff }) => ({
            path,
            previousPath,
            status,
            diff,
          })),
        }),
      )
      .digest('hex');

    return {
      ok: true,
      snapshot: {
        source,
        repositoryRoot,
        currentBranch,
        baseBranch,
        baseBranchOptions,
        revision,
        files,
        additions,
        deletions,
        truncated,
      },
    };
  } catch (error) {
    if (isUnbornRepositoryError(error)) {
      return { ok: false, reason: 'unborn_repository' };
    }
    return { ok: false, reason: 'git_failed' };
  }
}

async function readTrackedChanges(input: {
  repositoryRoot: string;
  source: GitReviewSource;
  branchComparison: string | null;
  hasHead: boolean;
  runGit: GitReviewCommandRunner;
}): Promise<{ files: GitReviewFile[]; diffChars: number; truncated: boolean }> {
  const comparisons =
    input.source === 'staged'
      ? [['--cached']]
      : input.source === 'unstaged'
        ? [[]]
        : input.branchComparison
          ? [[input.branchComparison]]
          : [
              input.hasHead ? ['--cached'] : ['--cached', '--root'],
              [],
            ];
  const files: GitReviewFile[] = [];
  let diffChars = 0;
  let truncated = false;

  for (const comparison of comparisons) {
    const [nameStatus, unified] = await Promise.all([
      input.runGit(input.repositoryRoot, [
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        ...comparison,
      ]),
      input.runGit(input.repositoryRoot, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--binary',
        '--find-renames',
        '--full-index',
        ...comparison,
      ]),
    ]);
    const entries = parseNameStatus(nameStatus);
    const chunks = splitUnifiedDiff(unified);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const diff = chunks[index] ?? '';
      if (
        files.length >= REVIEW_MAX_FILES ||
        diffChars + diff.length > REVIEW_MAX_DIFF_CHARS
      ) {
        truncated = true;
        break;
      }
      const stats = countDiffLineStats(diff);
      files.push({ ...entry, diff, ...stats });
      diffChars += diff.length;
    }
    if (truncated) break;
  }

  return { files: dedupeReviewFiles(files), diffChars, truncated };
}

async function readUntrackedChanges(
  repositoryRoot: string,
  runGit: GitReviewCommandRunner,
  maxFiles: number,
  maxDiffChars: number,
): Promise<{
  files: GitReviewFile[];
  diffChars: number;
  truncated: boolean;
}> {
  const output = await runGit(repositoryRoot, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ]);
  const paths = output.split('\0').filter(Boolean);
  const files: GitReviewFile[] = [];
  let diffChars = 0;
  let truncated = paths.length > maxFiles;
  for (const path of paths.slice(0, Math.max(0, maxFiles))) {
    const target = resolve(repositoryRoot, path);
    const child = relative(repositoryRoot, target);
    if (!child || child.startsWith('..') || isAbsolute(child)) {
      truncated = true;
      continue;
    }
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.size > maxDiffChars - diffChars) {
      truncated = true;
      continue;
    }
    const diff = untrackedFileDiff(path, await readFile(target));
    if (diffChars + diff.length > maxDiffChars) {
      truncated = true;
      break;
    }
    files.push({
        path,
        status: 'untracked',
        diff,
        ...countDiffLineStats(diff),
    });
    diffChars += diff.length;
  }
  return { files, diffChars, truncated };
}

function untrackedFileDiff(path: string, bytes: Buffer): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
  ];
  if (bytes.includes(0)) {
    return [...header, `Binary files /dev/null and b/${path} differ`, ''].join(
      '\n',
    );
  }
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  if (text.includes('\uFFFD')) {
    return [...header, `Binary files /dev/null and b/${path} differ`, ''].join(
      '\n',
    );
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) {
    return [...header, '--- /dev/null', `+++ b/${path}`, ''].join('\n');
  }
  return [
    ...header,
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    ...(text.endsWith('\n') ? [] : ['\\ No newline at end of file']),
    '',
  ].join('\n');
}

function parseNameStatus(output: string): Array<
  Pick<GitReviewFile, 'path' | 'previousPath' | 'status'>
> {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const entries: Array<Pick<GitReviewFile, 'path' | 'previousPath' | 'status'>> = [];
  for (let index = 0; index < fields.length; ) {
    const code = fields[index++] ?? '';
    const kind = code.charAt(0);
    if (kind === 'R' || kind === 'C') {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (!previousPath || !path) break;
      entries.push({
        path,
        previousPath,
        status: kind === 'R' ? 'renamed' : 'copied',
      });
      continue;
    }
    const path = fields[index++];
    if (!path) break;
    entries.push({ path, status: gitStatus(kind) });
  }
  return entries;
}

function gitStatus(code: string): GitReviewFileStatus {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
    case 'T':
      return 'modified';
    case 'D':
      return 'deleted';
    default:
      return 'unknown';
  }
}

function splitUnifiedDiff(diff: string): string[] {
  if (!diff.trim()) return [];
  const starts: number[] = [];
  const pattern = /^diff --git /gm;
  for (let match = pattern.exec(diff); match; match = pattern.exec(diff)) {
    starts.push(match.index);
  }
  if (starts.length === 0) return [diff];
  return starts.map((start, index) =>
    diff.slice(start, starts[index + 1] ?? diff.length),
  );
}

function dedupeReviewFiles(files: readonly GitReviewFile[]): GitReviewFile[] {
  const byPath = new Map<string, GitReviewFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
      continue;
    }
    const diff = `${existing.diff}${file.diff}`;
    byPath.set(file.path, {
      ...file,
      previousPath: file.previousPath ?? existing.previousPath,
      diff,
      ...countDiffLineStats(diff),
    });
  }
  return [...byPath.values()];
}

async function resolveBaseBranch(
  repositoryRoot: string,
  currentBranch: string | null,
  runGit: GitReviewCommandRunner,
): Promise<string | null> {
  const remoteHead = cleanLine(
    await runGit(repositoryRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]).catch(() => ''),
  );
  const candidates = [
    remoteHead,
    'origin/main',
    'origin/master',
    'main',
    'master',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (candidate === currentBranch) continue;
    if (await gitRefExists(repositoryRoot, candidate, runGit)) return candidate;
  }
  return null;
}

async function listBaseBranches(
  repositoryRoot: string,
  runGit: GitReviewCommandRunner,
): Promise<string[]> {
  const output = await runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  return [...new Set(output.split('\n').map((line) => line.trim()).filter(Boolean))]
    .filter((branch) => !branch.endsWith('/HEAD'))
    .sort((left, right) => left.localeCompare(right));
}

async function gitRefExists(
  repositoryRoot: string,
  ref: string,
  runGit: GitReviewCommandRunner,
): Promise<boolean> {
  try {
    await runGit(repositoryRoot, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

async function runGitCommand(
  root: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
  });
  return stdout;
}

function cleanLine(value: string): string | null {
  const line = value.trim();
  return line.length > 0 ? line : null;
}

function isUnbornRepositoryError(error: unknown): boolean {
  return (error instanceof Error && /unknown revision|bad revision|ambiguous argument|does not have any commits/i.test(
    error.message,
  ));
}
