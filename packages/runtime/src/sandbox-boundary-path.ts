import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  type SandboxBoundaryAccess,
  type SandboxBoundaryScope,
} from '@maka/core';

export interface NormalizedSandboxBoundaryPath {
  readonly displayPath: string;
  readonly enforcementPath: string;
  readonly access: SandboxBoundaryAccess;
  readonly scope: SandboxBoundaryScope;
  readonly targetType: 'file' | 'directory' | 'other' | 'missing';
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
    throw new Error('Sandbox boundary path is invalid or exceeds the length limit.');
  }
  const canonicalCwd = await fs.realpath(input.cwd);
  const displayPath = resolve(canonicalCwd, input.path);
  const enforcementPath = await realpathAllowMissing(displayPath);
  const targetType = await targetTypeFor(enforcementPath);
  const scope =
    input.scope === 'auto' ? (targetType === 'directory' ? 'subtree' : 'exact') : input.scope;
  if (scope === 'subtree' && targetType !== 'directory') {
    throw new Error('A subtree sandbox boundary must target an existing directory.');
  }
  return { displayPath, enforcementPath, access: input.access, scope, targetType };
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
