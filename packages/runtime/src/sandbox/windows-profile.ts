import { win32 } from 'node:path';

import type { FileSystemSandboxEntry, PermissionProfile } from '@maka/core/permission-profile';

import type { SandboxCommand, SandboxPathContext } from './types.js';

export interface WindowsSandboxPolicy {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly network: 'restricted' | 'enabled';
  readonly environment: Readonly<Record<string, string>>;
}

export function compileWindowsSandboxPolicy(command: SandboxCommand): WindowsSandboxPolicy {
  const { profile, pathContext } = command;
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') {
    throw new Error('Windows sandbox only accepts managed restricted profiles.');
  }

  const unavailable = new Set(
    (pathContext.unavailableProfilePaths ?? []).map((path) => canonicalWindowsPath(path)),
  );
  const readRoots: string[] = [];
  const writeRoots: string[] = [];
  for (const entry of profile.fileSystem.entries) {
    if (entry.access === 'deny') {
      throw new Error('Windows sandbox deny entries are not implemented.');
    }
    for (const path of rootsForEntry(entry, command.cwd, pathContext)) {
      const canonical = canonicalWindowsPath(path);
      if (unavailable.has(canonical)) {
        throw new Error(`Windows sandbox profile root is unavailable: ${canonical}`);
      }
      addUnique(readRoots, canonical);
      if (entry.access === 'write') addUnique(writeRoots, canonical);
    }
  }

  for (const path of [
    ...(pathContext.runtimeReadableRoots ?? []),
    ...(pathContext.executableRoots ?? []),
  ]) {
    addUnique(readRoots, canonicalWindowsPath(path));
  }
  for (const path of pathContext.runtimeWritableRoots ?? []) {
    const canonical = canonicalWindowsPath(path);
    addUnique(readRoots, canonical);
    addUnique(writeRoots, canonical);
  }

  return {
    readRoots,
    writeRoots,
    network: profile.network.kind,
    environment: windowsEnvironment(command.env),
  };
}

function rootsForEntry(
  entry: FileSystemSandboxEntry,
  cwd: string,
  context: SandboxPathContext,
): readonly string[] {
  if (entry.kind === 'path') return [entry.path];
  switch (entry.special) {
    case ':root':
      return [cwd];
    case ':workspace_roots':
      return context.workspaceRoots;
    case ':tmpdir':
      return context.tmpdir ? [context.tmpdir] : [];
    case ':slash_tmp':
      return context.slashTmp ? [context.slashTmp] : [];
    case ':minimal':
      return context.minimalRoots ?? [];
  }
}

function canonicalWindowsPath(path: string): string {
  if (!win32.isAbsolute(path) || path.includes('/')) {
    throw new Error(`Windows sandbox path must be absolute and use backslashes: ${path}`);
  }
  const canonical = win32.resolve(path);
  if (canonical.toLowerCase() !== path.toLowerCase()) {
    throw new Error(`Windows sandbox path must be lexically canonical: ${path}`);
  }
  if (win32.parse(canonical).root.toLowerCase() === canonical.toLowerCase()) {
    throw new Error(`Windows sandbox volume roots are not supported: ${path}`);
  }
  return canonical;
}

function addUnique(target: string[], path: string): void {
  if (!target.some((existing) => existing.toLowerCase() === path.toLowerCase())) {
    target.push(path);
  }
}

function windowsEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid Windows sandbox environment name: ${name}`);
    }
    const folded = name.toLowerCase();
    if (names.has(folded)) {
      throw new Error(`Duplicate Windows sandbox environment name: ${name}`);
    }
    names.add(folded);
    result[name] = value;
  }
  return result;
}
