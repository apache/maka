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
import { basename, dirname, join, resolve } from 'node:path';
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
      const linkedWorktreeCommonDir =
        normalized.access === 'read' && normalized.scope === 'subtree'
          ? await linkedWorktreeCommonDirForBoundary(normalized.enforcementPath)
          : undefined;
      return {
        path: linkedWorktreeCommonDir ?? normalized.enforcementPath,
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

/**
 * A linked worktree's admin directory is only the worktree-specific half of
 * Git's metadata authority. Git reads refs, objects, config, and hooks through
 * the sibling `commondir`; approving only `.git/worktrees/<name>` can therefore
 * make `git status` report a false unborn tree and make `git log` call the
 * branch broken. Normalize a read-scoped linked-worktree admin shape to the
 * common metadata root before the user sees and approves the expansion. Write
 * requests retain their exact path so shared metadata writes require their own
 * approval.
 *
 * The structural check keeps an unrelated directory containing a file named
 * `commondir` from widening its boundary. Any unreadable or malformed marker
 * stays on the ordinary path-normalization route.
 */
async function linkedWorktreeCommonDirForBoundary(path: string): Promise<string | undefined> {
  const worktreesDir = dirname(path);
  if (basename(worktreesDir) !== 'worktrees') return undefined;
  const expectedCommonDir = dirname(worktreesDir);

  let declaration: string;
  try {
    declaration = (await fs.readFile(join(path, 'commondir'), 'utf8')).trim();
  } catch {
    return undefined;
  }
  if (!declaration || declaration.includes('\0') || declaration.includes('\n')) return undefined;

  try {
    const commonDir = await fs.realpath(resolve(path, declaration));
    if (commonDir !== expectedCommonDir) return undefined;
    if (!(await fs.stat(commonDir)).isDirectory()) return undefined;
    return commonDir;
  } catch {
    return undefined;
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
