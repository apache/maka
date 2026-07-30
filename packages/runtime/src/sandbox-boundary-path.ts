import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryAccess,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryScope,
} from '@maka/core';

export interface NormalizedSandboxBoundaryPath {
  readonly displayPath: string;
  readonly enforcementPath: string;
  readonly access: SandboxBoundaryAccess;
  readonly scope: SandboxBoundaryScope;
  readonly targetType: 'file' | 'directory' | 'symlink' | 'other' | 'missing';
}

export async function normalizeSandboxBoundaryPath(input: {
  path: string;
  access: SandboxBoundaryAccess;
  scope: SandboxBoundaryScope | 'auto';
  cwd: string;
  /** Delete/lstat address a directory entry and must not follow its final link. */
  followFinalSymlink?: boolean;
}): Promise<NormalizedSandboxBoundaryPath> {
  if (
    !input.path ||
    input.path.includes('\0') ||
    input.path.length > MAX_SANDBOX_BOUNDARY_PATH_CHARS
  ) {
    throw new Error('Sandbox boundary path is invalid or exceeds the length limit.');
  }
  const canonicalCwd = await fs.realpath(input.cwd);
  const displayPath = resolve(canonicalCwd, input.path);
  const followFinalSymlink = input.followFinalSymlink ?? true;
  const enforcementPath = followFinalSymlink
    ? await realpathAllowMissing(displayPath)
    : await canonicalDirectoryEntryPath(displayPath);
  const targetType = await targetTypeFor(enforcementPath, followFinalSymlink);
  const scope =
    input.scope === 'auto' ? (targetType === 'directory' ? 'subtree' : 'exact') : input.scope;
  if (scope === 'subtree' && targetType !== 'directory') {
    throw new Error('A subtree sandbox boundary must target an existing directory.');
  }
  return { displayPath, enforcementPath, access: input.access, scope, targetType };
}

export async function normalizeSandboxBoundaryExpansion(
  expansion: SandboxBoundaryExpansion,
  cwd: string,
): Promise<SandboxBoundaryExpansion> {
  const validated = validateSandboxBoundaryExpansion(expansion);
  if (!validated.ok) throw new Error(validated.message);
  const entries = await Promise.all(
    (validated.expansion.filesystem?.entries ?? []).map(async (entry) => {
      const normalized = await normalizeSandboxBoundaryPath({
        ...entry,
        cwd,
      });
      if (normalized.scope === 'exact' && normalized.targetType === 'directory') {
        throw new Error(
          'An exact sandbox boundary cannot target a directory; use subtree for directory access.',
        );
      }
      return {
        path: normalized.enforcementPath,
        access: normalized.access,
        scope: normalized.scope,
      };
    }),
  );
  const normalized = validateSandboxBoundaryExpansion({
    ...(entries.length > 0 ? { filesystem: { entries } } : {}),
    ...(validated.expansion.network ? { network: validated.expansion.network } : {}),
  });
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.expansion;
}

async function realpathAllowMissing(target: string): Promise<string> {
  let cursor = target;
  const missing: string[] = [];
  while (true) {
    try {
      const realParent = await fs.realpath(cursor);
      return resolve(realParent, ...missing.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(cursor.slice(parent.length + (parent === '/' ? 0 : 1)));
      cursor = parent;
    }
  }
}

async function canonicalDirectoryEntryPath(path: string): Promise<string> {
  const parent = dirname(path);
  return resolve(await realpathAllowMissing(parent), path.slice(parent.length + 1));
}

async function targetTypeFor(
  path: string,
  followFinalSymlink: boolean,
): Promise<NormalizedSandboxBoundaryPath['targetType']> {
  try {
    const stat = followFinalSymlink ? await fs.stat(path) : await fs.lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
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
