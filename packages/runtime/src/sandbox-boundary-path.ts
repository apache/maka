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

import { promises as fs } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { realpathAllowMissing } from './path-containment.js';
import {
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryAccess,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryScope,
} from '@maka/core/sandbox-boundary';

export interface NormalizedSandboxBoundaryPath {
  readonly displayPath: string;
  readonly enforcementPath: string;
  readonly access: SandboxBoundaryAccess;
  readonly scope: SandboxBoundaryScope;
  readonly targetType: 'file' | 'directory' | 'other' | 'missing';
}

/**
 * A boundary declaration the caller can correct and submit again.
 *
 * Filesystem failures are deliberately not wrapped in this error: an invalid
 * declaration is actionable model input, while realpath/stat/permission/I/O
 * failures describe an unavailable host operation and need to retain their
 * original classification.
 */
export class SandboxBoundaryDeclarationError extends Error {
  override readonly name = 'SandboxBoundaryDeclarationError';
}

export async function normalizeSandboxBoundaryPath(input: {
  path: string;
  access: SandboxBoundaryAccess;
  scope: SandboxBoundaryScope | 'auto';
  cwd: string;
}): Promise<NormalizedSandboxBoundaryPath> {
  if (
    !input.path ||
    input.path.includes('\0') ||
    input.path.length > MAX_SANDBOX_BOUNDARY_PATH_CHARS
  ) {
    throw new SandboxBoundaryDeclarationError(
      'Sandbox boundary path is invalid or exceeds the length limit.',
    );
  }
  const canonicalCwd = await fs.realpath(input.cwd);
  const displayPath = resolve(canonicalCwd, input.path);
  const enforcementPath = await realpathAllowMissing(displayPath);
  const targetType = await targetTypeFor(enforcementPath);
  const scope =
    input.scope === 'auto' ? (targetType === 'directory' ? 'subtree' : 'exact') : input.scope;
  if (scope === 'subtree' && targetType !== 'directory') {
    throw new SandboxBoundaryDeclarationError(
      'A subtree sandbox boundary must target an existing directory.',
    );
  }
  return { displayPath, enforcementPath, access: input.access, scope, targetType };
}

export async function normalizeSandboxBoundaryExpansion(
  expansion: SandboxBoundaryExpansion,
  cwd: string,
): Promise<SandboxBoundaryExpansion> {
  const validated = validateSandboxBoundaryExpansion(expansion);
  if (!validated.ok) throw new SandboxBoundaryDeclarationError(validated.message);
  const entries = await Promise.all(
    (validated.expansion.filesystem?.entries ?? []).map(async (entry) => {
      const normalized = await normalizeSandboxBoundaryPath({
        ...entry,
        cwd,
      });
      if (normalized.scope === 'exact' && normalized.targetType === 'directory') {
        throw new SandboxBoundaryDeclarationError(
          'An exact sandbox boundary cannot target a directory; use subtree for directory access.',
        );
      }
      // Reading a linked worktree's admin directory is not enough to read the repository, so a
      // read subtree widens to the shared Git directory it points at. A write boundary keeps the
      // exact path the caller asked for.
      const commonDir =
        normalized.access === 'read' && normalized.scope === 'subtree'
          ? await linkedWorktreeCommonDir(normalized.enforcementPath)
          : undefined;
      return {
        path: commonDir ?? normalized.enforcementPath,
        access: normalized.access,
        scope: normalized.scope,
      };
    }),
  );
  const normalized = validateSandboxBoundaryExpansion({
    ...(entries.length > 0 ? { filesystem: { entries } } : {}),
    ...(validated.expansion.network ? { network: validated.expansion.network } : {}),
  });
  if (!normalized.ok) throw new SandboxBoundaryDeclarationError(normalized.message);
  return normalized.expansion;
}

/** `commondir` holds one short relative path; anything larger is not a pointer we will follow. */
const MAX_GIT_COMMON_DIR_POINTER_CHARS = 1024;

/**
 * Resolve a linked worktree's admin directory to the repository's shared Git directory.
 *
 * `.git/worktrees/<name>` keeps only that worktree's HEAD, index and reflog; refs, objects,
 * `config` and `info/exclude` live in the directory named by its `commondir` file. A read boundary
 * on the admin directory alone leaves `git status` and `git log` unable to read the repository
 * they belong to, so the request is widened to that shared directory before it is approved.
 *
 * The pointer is repository-controlled text found inside a path the caller asked for, so it is
 * followed only when the target really is this repository's shared directory: it must hold
 * `objects` and `refs` as real directories, reached through no symlink, and the requested admin
 * directory must sit at `<target>/worktrees/<name>`. Anything else leaves the boundary exactly as
 * requested, rather than widening it into a temp directory, an ancestor, or another repository's
 * `.git` that only looks like a common directory.
 */
async function linkedWorktreeCommonDir(adminPath: string): Promise<string | undefined> {
  const pointer = join(adminPath, 'commondir');
  try {
    if ((await realTargetTypeFor(pointer)) !== 'file') return undefined;
    const raw = await fs.readFile(pointer, 'utf8');
    if (raw.length > MAX_GIT_COMMON_DIR_POINTER_CHARS) return undefined;
    const target = raw.trim();
    if (!target || target.includes('\0')) return undefined;
    const resolved = await realpathAllowMissing(resolve(adminPath, target));
    if (!(await isGitCommonDir(resolved))) return undefined;
    // Git's own contract for a linked worktree is that the admin directory lives at
    // `<commondir>/worktrees/<name>`. Proving that relationship is what stops a directory that
    // merely looks like a Git directory - a temp dir, an ancestor, another repository's `.git` -
    // from replacing the subtree the caller actually asked for.
    const [ownAdmin, requestedAdmin] = await Promise.all([
      fs.realpath(join(resolved, 'worktrees', basename(adminPath))),
      fs.realpath(adminPath),
    ]);
    return ownAdmin === requestedAdmin ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function isGitCommonDir(path: string): Promise<boolean> {
  if ((await realTargetTypeFor(path)) !== 'directory') return false;
  return (
    (await realTargetTypeFor(join(path, 'objects'))) === 'directory' &&
    (await realTargetTypeFor(join(path, 'refs'))) === 'directory'
  );
}

/**
 * `lstat`-backed {@link targetTypeFor}: a symlink is not proof that a repository layout is real, so
 * the `commondir` marker and the entries that qualify its target are inspected without following
 * links.
 */
async function realTargetTypeFor(
  path: string,
): Promise<NormalizedSandboxBoundaryPath['targetType']> {
  try {
    const stat = await fs.lstat(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }
}

async function targetTypeFor(path: string): Promise<NormalizedSandboxBoundaryPath['targetType']> {
  try {
    const stat = await fs.stat(path);
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (isMissingPathError(error)) return 'missing';
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
