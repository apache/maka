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

import { win32 } from 'node:path';

import type { FileSystemSandboxEntry, PermissionProfile } from '@maka/core/permission-profile';
import { canonicalWindowsPath as coreCanonicalWindowsPath } from '@maka/core/windows-path';

import type { SandboxCommand, SandboxPathContext } from './types.js';

export interface WindowsSandboxPolicy {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly exactReadRoots: readonly string[];
  readonly exactWriteRoots: readonly string[];
  readonly network: 'restricted' | 'enabled';
  readonly environment: Readonly<Record<string, string>>;
}

export function compileWindowsSandboxPolicy(command: SandboxCommand): WindowsSandboxPolicy {
  const { profile, pathContext } = command;
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') {
    throw new Error('Windows sandbox only accepts managed restricted profiles.');
  }
  if (profile.network.kind !== 'restricted') {
    throw new Error('Windows sandbox only implements restricted networking.');
  }

  const unavailable = new Set(
    (pathContext.unavailableProfilePaths ?? []).map((path) => canonicalWindowsPath(path)),
  );
  const readRoots: string[] = [];
  const writeRoots: string[] = [];
  const exactReadRoots: string[] = [];
  const exactWriteRoots: string[] = [];
  for (const entry of profile.fileSystem.entries) {
    if (entry.access === 'deny') {
      throw new Error('Windows sandbox deny entries are not implemented.');
    }
    const match = entry.kind === 'path' ? entry.match : undefined;
    for (const path of rootsForEntry(entry, command.cwd, pathContext)) {
      const canonical = canonicalWindowsPath(path);
      if (unavailable.has(canonical)) {
        throw new Error(`Windows sandbox profile root is unavailable: ${canonical}`);
      }
      addUnique(readRoots, canonical);
      if (match === 'exact') addUnique(exactReadRoots, canonical);
      if (entry.access === 'write') {
        addUnique(writeRoots, canonical);
        if (match === 'exact') addUnique(exactWriteRoots, canonical);
      }
    }
  }

  for (const path of [
    ...(pathContext.runtimeReadableRoots ?? []),
    ...(pathContext.executableRoots ?? []),
  ]) {
    addUnique(readRoots, canonicalWindowsPath(path));
  }
  // A write whose target does not exist yet — and directory-entry mutations
  // such as ApplyPatch create/delete — can only be represented here as
  // recursive Modify on the existing parent, a kernel boundary broader than
  // the approved exact operation. The W0/W1 preview keeps exact writes exact
  // and fails these shapes closed; precise parent-entry authority is
  // follow-up work.
  if ((pathContext.runtimeWritableRoots ?? []).length > 0) {
    throw new Error(
      'Windows sandbox cannot represent parent-entry write authority exactly; ' +
        'creating or deleting directory entries fails closed in this preview.',
    );
  }

  // The worker anchors every containment check on lstat(cwd), which the
  // AppContainer denies unless granted. An exact (non-recursive) read grant
  // exposes only the directory's own metadata and entry names, not its
  // contents — added only when no broader grant already covers cwd.
  const canonicalCwd = canonicalWindowsPath(command.cwd);
  if (!readRoots.some((root) => root.toLowerCase() === canonicalCwd.toLowerCase())) {
    readRoots.push(canonicalCwd);
    exactReadRoots.push(canonicalCwd);
  }

  return {
    readRoots,
    writeRoots,
    exactReadRoots,
    exactWriteRoots,
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
  const canonical = coreCanonicalWindowsPath(path);
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

function isValidWindowsEnvironmentName(name: string): boolean {
  // The CreateProcess environment block is `name=value\0...\0\0`, so a name
  // may not be empty, contain '=' or a control character (NUL is < 0x20 and
  // would truncate the block), or begin with '=' — that leading form is
  // Windows' hidden per-drive cwd variable (e.g. `=C:`) and is not meaningful
  // to forward. Everything else, including the parentheses in real names like
  // `CommonProgramFiles(x86)`, is a legitimate Windows environment name.
  if (name.length === 0 || name.startsWith('=')) return false;
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || character === '=') return false;
  }
  return true;
}

function windowsEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    if (!isValidWindowsEnvironmentName(name)) {
      throw new Error(`Invalid Windows sandbox environment name: ${name}`);
    }
    if (value.includes('\0')) {
      throw new Error(`Invalid Windows sandbox environment value for: ${name}`);
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
