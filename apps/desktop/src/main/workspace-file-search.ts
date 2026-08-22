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

import { execFile, type ExecFileException } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { resolveProjectGitInfo } from '@maka/runtime/system-prompt/project-context';

/**
 * workspace-file-search.ts — local-only workspace file listing for the composer
 * `@` mention popup. Like the project git probe, we shell out to `git ls-files`
 * when
 * the project root is a git repo (so .gitignore + untracked files are honored
 * exactly as the user expects) and fall back to a bounded recursive readdir
 * walk otherwise. `execFileImpl` is injectable so unit tests can fake git.
 *
 * Returned `relativePath`s are always POSIX-style (forward slashes) and always
 * inside the project root — the git path list is repo-relative by construction,
 * and the walk never follows symlinked directories or escapes the root.
 */

export type WorkspaceFileSearchResult =
  | { ok: true; files: Array<{ relativePath: string }> }
  | { ok: false; reason: 'no_project' | 'search_failed' };

const LS_TIMEOUT_MS = 3_000;
const DEFAULT_LIMIT = 50;
/** Cap the fallback walk so a huge non-git tree can't stall the popup. */
const MAX_WALK_ENTRIES = 5_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

type ExecFileCallback = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean; maxBuffer: number },
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

/** AND-of-substring token match, case-insensitive — the same rule the composer
 *  uses client-side (kept local so the main process doesn't import @maka/ui). */
function matchesAllTokens(tokens: readonly string[], text: string): boolean {
  const haystack = text.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function runGitLsFiles(
  cwd: string,
  execFileImpl: ExecFileCallback,
): Promise<{ ok: true; files: string[] } | { ok: false }> {
  return new Promise((resolve) => {
    execFileImpl(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd, timeout: LS_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false });
          return;
        }
        const files = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        resolve({ ok: true, files });
      },
    );
  });
}

/** Bounded recursive walk. Skips node_modules/.git, never recurses into
 *  symlinked directories (dirent.isDirectory() is false for a symlink), and
 *  stops once MAX_WALK_ENTRIES files are collected. */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip rather than fail the whole walk
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_ENTRIES) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(toPosix(relative(root, join(dir, entry.name))));
      }
      // Symlinks (isDirectory()/isFile() both false) are intentionally ignored.
    }
  }
  return out;
}

export async function searchWorkspaceFiles(
  projectRoot: string,
  input: { query?: unknown; limit?: unknown; execFileImpl?: ExecFileCallback } = {},
): Promise<WorkspaceFileSearchResult> {
  if (typeof projectRoot !== 'string' || !projectRoot) {
    return { ok: false, reason: 'no_project' };
  }
  const query = typeof input.query === 'string' ? input.query : '';
  const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;
  const execFileImpl = input.execFileImpl ?? (execFile as unknown as ExecFileCallback);

  try {
    let candidates: string[];
    const info = await resolveProjectGitInfo(projectRoot);
    if (info.isGitRepo) {
      const listed = await runGitLsFiles(projectRoot, execFileImpl);
      candidates = listed.ok ? listed.files : await walkFiles(projectRoot);
    } else {
      candidates = await walkFiles(projectRoot);
    }

    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length === 0
      ? candidates
      : candidates.filter((path) => matchesAllTokens(tokens, path));
    // Rank shorter paths first (usually the closest / most relevant match),
    // then lexicographically for a stable order.
    filtered.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return { ok: true, files: filtered.slice(0, limit).map((relativePath) => ({ relativePath })) };
  } catch {
    return { ok: false, reason: 'search_failed' };
  }
}
