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

/**
 * PR-BUILD-HYGIENE-0: surface a build-info stamp (mode + short commit
 * sha) so dev builds can clearly distinguish themselves from a
 * packaged release in the About page and in bug reports.
 *
 * Detection rules:
 *   - `mode`:
 *       'packaged' if Electron reports `app.isPackaged`,
 *       otherwise 'dev'.
 *   - `commit`: resolve `.git/HEAD` synchronously at startup. If HEAD
 *     points to a ref, dereference once. Returns null on any failure
 *     (no `.git`, detached state in a packaged tarball, permission
 *     error). We never spawn `git` to avoid coupling the desktop main
 *     process to a shell tool.
 *
 * One-shot — captured at module load and cached.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface BuildInfo {
  readonly mode: 'dev' | 'packaged';
  /** Short commit sha (7 hex chars) or `null` if unresolvable. */
  readonly commit: string | null;
}

function findRepoRoot(start: string): string | null {
  let cur = start;
  // Walk up at most 10 levels — repo is at the workspace root, not
  // deeper than that. Bound the loop so we don't traverse to '/'.
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * The directory holding this checkout's Git metadata.
 *
 * `.git` is a directory in an ordinary clone and a **file** in a linked
 * worktree, where it holds `gitdir: <path>` pointing at
 * `<main>/.git/worktrees/<name>`. Reading `<root>/.git/HEAD` therefore finds
 * nothing in a worktree — and a worktree is exactly the checkout whose commit
 * a developer most needs to see, since it is the one that differs from the
 * tree they think they are running.
 *
 * A relative `gitdir:` is resolved against the checkout, which is how Git
 * writes it for a worktree created inside the repository.
 */
function resolveGitDir(repoRoot: string): string | null {
  const dotGit = join(repoRoot, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  try {
    const pointer = readFileSync(dotGit, 'utf8').trim();
    if (!pointer.startsWith('gitdir:')) return null;
    const target = pointer.slice('gitdir:'.length).trim();
    if (!target) return null;
    return isAbsolute(target) ? target : resolve(repoRoot, target);
  } catch {
    return null;
  }
}

/**
 * The Git directory holding refs for this checkout.
 *
 * A linked worktree splits its Git directory in two: the private admin
 * directory named by `.git` holds that worktree's own `HEAD` and index, while
 * loose refs and `packed-refs` stay in the *common* directory shared with the
 * main checkout. `commondir` inside the admin directory names it, relative to
 * the admin directory itself.
 *
 * Reading a branch ref from the admin directory therefore finds nothing on a
 * real branch-linked worktree, and the build stamp loses its commit.
 */
function resolveCommonDir(gitDir: string): string {
  try {
    const pointer = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    if (!pointer) return gitDir;
    return isAbsolute(pointer) ? pointer : resolve(gitDir, pointer);
  } catch {
    // An ordinary clone has no `commondir`; its own directory is the common one.
    return gitDir;
  }
}

function resolveCommit(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) return null;
  // HEAD is per-worktree; refs are shared.
  const commonDir = resolveCommonDir(gitDir);
  try {
    const headPath = join(gitDir, 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(commonDir, head.slice(5).trim());
      if (!existsSync(refPath)) {
        // Packed refs path — read packed-refs and match the ref name.
        const packed = join(commonDir, 'packed-refs');
        if (!existsSync(packed)) return null;
        const target = head.slice(5).trim();
        const lines = readFileSync(packed, 'utf8').split('\n');
        for (const line of lines) {
          if (line.startsWith('#') || line.startsWith('^')) continue;
          const [sha, ref] = line.split(' ');
          if (ref?.trim() === target && sha) return sha.slice(0, 7);
        }
        return null;
      }
      const sha = readFileSync(refPath, 'utf8').trim();
      return sha.length >= 7 ? sha.slice(0, 7) : null;
    }
    // Detached HEAD — already a sha.
    return head.length >= 7 ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

export function resolveBuildInfo(isPackaged: boolean, startDir: string): BuildInfo {
  if (isPackaged) {
    return { mode: 'packaged', commit: null };
  }
  const repoRoot = findRepoRoot(resolve(startDir));
  const commit = repoRoot ? resolveCommit(repoRoot) : null;
  return { mode: 'dev', commit };
}
