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
import { readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { resolveProjectGitInfo } from '@maka/runtime/system-prompt/project-context';

/**
 * workspace-file-search.ts — local-only workspace file listing for the composer
 * `@` mention popup. Like the project git probe, we shell out to `git ls-files`
 * when
 * the project root is a git repo (so .gitignore + untracked files are honored
 * exactly as the user expects) and fall back to a bounded recursive readdir
 * walk otherwise. A searcher owns a short-lived, bounded LRU so repeated
 * keystrokes reuse one sorted enumeration, including while its first load is
 * still in flight. `execFileImpl` is injectable so unit tests can fake git.
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
/** Short enough for newly-created files and branch switches to appear quickly. */
const DEFAULT_CACHE_TTL_MS = 5_000;
/** Host-scoped bound: project switches cannot grow the cache indefinitely. */
const DEFAULT_CACHE_MAX_ENTRIES = 8;
/** Keep cached path strings bounded even when several very large repos are open. */
const DEFAULT_CACHE_MAX_PATH_BYTES = 64 * 1024 * 1024;
/** Cap the fallback walk so a huge non-git tree can't stall the popup. */
const MAX_WALK_ENTRIES = 5_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

type ExecFileCallback = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean; maxBuffer: number },
  cb: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void;

export interface WorkspaceFileSearcher {
  search(
    projectRoot: string,
    input?: { query?: unknown; limit?: unknown },
  ): Promise<WorkspaceFileSearchResult>;
}

export interface WorkspaceFileSearcherOptions {
  /** Test seam for the Git process boundary. */
  execFileImpl?: ExecFileCallback;
  /** Test seam for canonical path resolution. */
  canonicalizeRoot?: (projectRoot: string) => Promise<string>;
  /** Test seam for TTL expiry. */
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  maxPathBytes?: number;
}

type WorkspaceFileCacheEntry =
  | { state: 'loading'; promise: Promise<readonly string[]> }
  | {
    state: 'ready';
    sortedPaths: readonly string[];
    pathBytes: number;
    expiresAt: number;
  };

type CanonicalRootCacheEntry =
  | { state: 'loading'; promise: Promise<string> }
  | { state: 'ready'; canonicalRoot: string; expiresAt: number };

/** AND-of-substring token match, case-insensitive — the same rule the composer
 *  uses client-side (kept local so the main process doesn't import @maka/ui). */
function matchesAllTokens(tokens: readonly string[], text: string): boolean {
  const haystack = text.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function compareWorkspacePaths(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}

function estimatePathBytes(paths: readonly string[]): number {
  // JavaScript strings can occupy up to two bytes per UTF-16 code unit. The
  // estimate intentionally ignores array/object overhead; the entry limit is
  // the secondary bound for that fixed per-path cost.
  return paths.reduce((total, path) => total + path.length * 2, 0);
}

function runGitLsFiles(
  cwd: string,
  execFileImpl: ExecFileCallback,
): Promise<{ ok: true; files: string[] } | { ok: false }> {
  return new Promise((resolve) => {
    execFileImpl(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd, timeout: LS_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false });
          return;
        }
        const files = stdout.split('\0').filter(Boolean);
        resolve({ ok: true, files });
      },
    );
  });
}

/** Bounded recursive walk. Skips node_modules/.git, never recurses into
 *  symlinked directories (dirent.isDirectory() is false for a symlink), and
 *  stops once MAX_WALK_ENTRIES files are collected. */
async function walkFiles(root: string): Promise<{ files: string[]; rootReadable: boolean }> {
  const out: string[] = [];
  const stack: string[] = [root];
  let rootReadable = false;
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      if (dir === root) rootReadable = true;
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
  return { files: out, rootReadable };
}

async function enumerateWorkspaceFiles(
  projectRoot: string,
  execFileImpl: ExecFileCallback,
): Promise<{ sortedPaths: readonly string[]; cacheable: boolean }> {
  const info = await resolveProjectGitInfo(projectRoot);
  if (info.isGitRepo) {
    const listed = await runGitLsFiles(projectRoot, execFileImpl);
    if (listed.ok) {
      return { sortedPaths: listed.files.sort(compareWorkspacePaths), cacheable: true };
    }
    const walked = await walkFiles(projectRoot);
    return { sortedPaths: walked.files.sort(compareWorkspacePaths), cacheable: false };
  }

  const walked = await walkFiles(projectRoot);
  return {
    sortedPaths: walked.files.sort(compareWorkspacePaths),
    cacheable: walked.rootReadable,
  };
}

/** The cache is already globally ranked, so a warm query can stop at `limit`. */
function filterSortedPaths(
  sortedPaths: readonly string[],
  query: string,
  limit: number,
): Array<{ relativePath: string }> {
  if (limit < 1) return [];
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const files: Array<{ relativePath: string }> = [];
  for (const relativePath of sortedPaths) {
    if (tokens.length > 0 && !matchesAllTokens(tokens, relativePath)) continue;
    files.push({ relativePath });
    if (files.length >= limit) break;
  }
  return files;
}

export function createWorkspaceFileSearcher(
  options: WorkspaceFileSearcherOptions = {},
): WorkspaceFileSearcher {
  const execFileImpl = options.execFileImpl ?? (execFile as unknown as ExecFileCallback);
  const canonicalizeRoot = options.canonicalizeRoot
    ?? (async (projectRoot: string) => realpath(projectRoot).catch(() => projectRoot));
  const now = options.now ?? Date.now;
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_CACHE_TTL_MS;
  const maxEntries = typeof options.maxEntries === 'number' && options.maxEntries > 0
    ? Math.floor(options.maxEntries)
    : DEFAULT_CACHE_MAX_ENTRIES;
  const maxPathBytes = typeof options.maxPathBytes === 'number' && options.maxPathBytes > 0
    ? Math.floor(options.maxPathBytes)
    : DEFAULT_CACHE_MAX_PATH_BYTES;
  const cache = new Map<string, WorkspaceFileCacheEntry>();
  const canonicalRoots = new Map<string, CanonicalRootCacheEntry>();
  let cachedPathBytes = 0;

  const touch = (key: string, entry: WorkspaceFileCacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
  };

  const evictLeastRecentlyUsed = (): void => {
    while (cache.size > maxEntries || cachedPathBytes > maxPathBytes) {
      // In-flight loads stay deduplicated even during a burst across projects;
      // completed entries are the only safe eviction candidates.
      let oldestReady: [string, Extract<WorkspaceFileCacheEntry, { state: 'ready' }>]
        | undefined;
      for (const [key, entry] of cache) {
        if (entry.state === 'ready') {
          oldestReady = [key, entry];
          break;
        }
      }
      if (!oldestReady) break;
      cache.delete(oldestReady[0]);
      cachedPathBytes -= oldestReady[1].pathBytes;
    }
  };

  const removeCacheEntry = (key: string, entry: WorkspaceFileCacheEntry): void => {
    cache.delete(key);
    if (entry.state === 'ready') cachedPathBytes -= entry.pathBytes;
  };

  const evictCanonicalRoots = (): void => {
    while (canonicalRoots.size > maxEntries) {
      const oldestReady = Array.from(canonicalRoots).find(
        ([, entry]) => entry.state === 'ready',
      );
      if (!oldestReady) break;
      canonicalRoots.delete(oldestReady[0]);
    }
  };

  const canonicalRootFor = (projectRoot: string): Promise<string> => {
    const lexicalRoot = resolve(projectRoot);
    const cached = canonicalRoots.get(lexicalRoot);
    if (cached?.state === 'loading') return cached.promise;
    if (cached?.state === 'ready' && now() < cached.expiresAt) {
      canonicalRoots.delete(lexicalRoot);
      canonicalRoots.set(lexicalRoot, cached);
      return Promise.resolve(cached.canonicalRoot);
    }
    canonicalRoots.delete(lexicalRoot);

    const promise = canonicalizeRoot(lexicalRoot).then(
      (canonicalRoot) => {
        const current = canonicalRoots.get(lexicalRoot);
        if (current?.state === 'loading' && current.promise === promise) {
          canonicalRoots.delete(lexicalRoot);
          canonicalRoots.set(lexicalRoot, {
            state: 'ready',
            canonicalRoot,
            expiresAt: now() + ttlMs,
          });
          evictCanonicalRoots();
        }
        return canonicalRoot;
      },
      (error: unknown) => {
        const current = canonicalRoots.get(lexicalRoot);
        if (current?.state === 'loading' && current.promise === promise) {
          canonicalRoots.delete(lexicalRoot);
        }
        throw error;
      },
    );
    canonicalRoots.set(lexicalRoot, { state: 'loading', promise });
    return promise;
  };

  const load = (canonicalRoot: string): Promise<readonly string[]> => {
    const promise = enumerateWorkspaceFiles(canonicalRoot, execFileImpl).then(
      ({ sortedPaths, cacheable }) => {
        const current = cache.get(canonicalRoot);
        if (current?.state === 'loading' && current.promise === promise) {
          if (cacheable) {
            const pathBytes = estimatePathBytes(sortedPaths);
            touch(canonicalRoot, {
              state: 'ready',
              sortedPaths,
              pathBytes,
              expiresAt: now() + ttlMs,
            });
            cachedPathBytes += pathBytes;
            evictLeastRecentlyUsed();
          } else {
            removeCacheEntry(canonicalRoot, current);
          }
        }
        return sortedPaths;
      },
      (error: unknown) => {
        const current = cache.get(canonicalRoot);
        if (current?.state === 'loading' && current.promise === promise) {
          removeCacheEntry(canonicalRoot, current);
        }
        throw error;
      },
    );
    touch(canonicalRoot, { state: 'loading', promise });
    evictLeastRecentlyUsed();
    return promise;
  };

  const candidatesFor = async (canonicalRoot: string): Promise<readonly string[]> => {
    const cached = cache.get(canonicalRoot);
    if (cached?.state === 'loading') {
      touch(canonicalRoot, cached);
      return cached.promise;
    }
    if (cached?.state === 'ready') {
      if (now() < cached.expiresAt) {
        touch(canonicalRoot, cached);
        return cached.sortedPaths;
      }
      removeCacheEntry(canonicalRoot, cached);
    }
    return load(canonicalRoot);
  };

  return {
    async search(projectRoot, input = {}) {
      if (typeof projectRoot !== 'string' || !projectRoot) {
        return { ok: false, reason: 'no_project' };
      }
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' && input.limit > 0
        ? Math.floor(input.limit)
        : DEFAULT_LIMIT;

      try {
        const canonicalRoot = await canonicalRootFor(projectRoot);
        const sortedPaths = await candidatesFor(canonicalRoot);
        return { ok: true, files: filterSortedPaths(sortedPaths, query, limit) };
      } catch {
        return { ok: false, reason: 'search_failed' };
      }
    },
  };
}

export async function searchWorkspaceFiles(
  projectRoot: string,
  input: { query?: unknown; limit?: unknown; execFileImpl?: ExecFileCallback } = {},
): Promise<WorkspaceFileSearchResult> {
  return createWorkspaceFileSearcher({ execFileImpl: input.execFileImpl }).search(projectRoot, input);
}
