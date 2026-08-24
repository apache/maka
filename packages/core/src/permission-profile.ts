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
 * Platform-independent permission profile model.
 *
 * This module is intentionally pure: callers pass normalized absolute paths
 * and runtime-owned context. Runtime code owns realpath, symlink, and platform
 * path preprocessing before calling these helpers.
 */

export const FILE_SYSTEM_SANDBOX_KINDS = [
  'restricted',
  'unrestricted',
  'external_sandbox',
] as const;
export type FileSystemSandboxKind = (typeof FILE_SYSTEM_SANDBOX_KINDS)[number];

export const FILE_SYSTEM_ACCESS_MODES = ['read', 'write', 'deny'] as const;
export type FileSystemAccessMode = (typeof FILE_SYSTEM_ACCESS_MODES)[number];

export const FILE_SYSTEM_PATH_MATCHES = ['exact', 'subtree'] as const;
export type FileSystemPathMatch = (typeof FILE_SYSTEM_PATH_MATCHES)[number];
export const FILE_SYSTEM_SPECIAL_PATHS = [
  ':root',
  ':workspace_roots',
  ':tmpdir',
  ':slash_tmp',
  ':minimal',
] as const;
export type FileSystemSpecialPath = (typeof FILE_SYSTEM_SPECIAL_PATHS)[number];

export type FileSystemSandboxEntry =
  | {
      kind: 'path';
      access: FileSystemAccessMode;
      path: string;
      /** Defaults to subtree for backward compatibility with profile roots. */
      match?: FileSystemPathMatch;
    }
  | {
      kind: 'special';
      access: FileSystemAccessMode;
      special: FileSystemSpecialPath;
    };

export const PROTECTED_METADATA_NAMES = ['.git', '.agents', '.codex'] as const;
export type ProtectedMetadataName = (typeof PROTECTED_METADATA_NAMES)[number];

export interface FileSystemProtectedMetadataPolicy {
  access: 'deny_write';
  names: readonly string[];
}

export interface FileSystemSandboxPolicy {
  kind: FileSystemSandboxKind;
  entries: readonly FileSystemSandboxEntry[];
  protectedMetadata?: FileSystemProtectedMetadataPolicy;
}

export const NETWORK_SANDBOX_KINDS = ['restricted', 'enabled'] as const;
export type NetworkSandboxKind = (typeof NETWORK_SANDBOX_KINDS)[number];

export interface NetworkSandboxPolicy {
  kind: NetworkSandboxKind;
}

export type PermissionProfileName =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access'
  | 'custom';

export interface PermissionProfileManaged {
  type: 'managed';
  name?: PermissionProfileName | (string & {});
  fileSystem: FileSystemSandboxPolicy;
  network: NetworkSandboxPolicy;
}

export interface PermissionProfileDisabled {
  type: 'disabled';
  name?: 'disabled' | (string & {});
}

export interface PermissionProfileExternal {
  type: 'external';
  name?: 'external' | (string & {});
  network: NetworkSandboxPolicy;
}

export type PermissionProfile =
  | PermissionProfileManaged
  | PermissionProfileDisabled
  | PermissionProfileExternal;

export interface PermissionProfileMatchContext {
  root?: string;
  workspaceRoots?: readonly string[];
  tmpdir?: string;
  slashTmp?: string;
  minimalRoots?: readonly string[];
}

export function createReadOnlyPermissionProfile(): PermissionProfileManaged {
  return {
    type: 'managed',
    name: 'read-only',
    fileSystem: {
      kind: 'restricted',
      entries: [
        {
          kind: 'special',
          access: 'read',
          special: ':workspace_roots',
        },
      ],
    },
    network: { kind: 'restricted' },
  };
}

/**
 * True when a managed profile grants nothing beyond reading: no filesystem
 * entry allows writing and the network stays restricted.
 *
 * This is the fact a permission surface needs to tell a read-only session
 * apart from a writable one (#1611). It is derived from the policy rather
 * than from `name`, so a profile widened by an approved boundary expansion
 * stops reading as read-only even when its name never changed.
 */
export function isReadOnlyPermissionProfile(profile: PermissionProfileManaged): boolean {
  return (
    profile.fileSystem.kind === 'restricted' &&
    profile.network.kind === 'restricted' &&
    !profile.fileSystem.entries.some((entry) => entry.access === 'write')
  );
}

export function createWorkspaceWritePermissionProfile(): PermissionProfileManaged {
  return {
    type: 'managed',
    name: 'workspace-write',
    fileSystem: {
      kind: 'restricted',
      entries: [
        {
          kind: 'special',
          access: 'write',
          special: ':workspace_roots',
        },
        {
          kind: 'special',
          access: 'write',
          special: ':tmpdir',
        },
        {
          kind: 'special',
          access: 'write',
          special: ':slash_tmp',
        },
      ],
    },
    network: { kind: 'restricted' },
  };
}

export function createDangerFullAccessPermissionProfile(): PermissionProfileManaged {
  return {
    type: 'managed',
    name: 'danger-full-access',
    fileSystem: {
      kind: 'unrestricted',
      entries: [],
    },
    network: { kind: 'enabled' },
  };
}

export function createExternalPermissionProfile(
  network: NetworkSandboxPolicy = { kind: 'restricted' },
): PermissionProfileExternal {
  return {
    type: 'external',
    name: 'external',
    network,
  };
}

export function canReadPath(
  profile: PermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  const policy = fileSystemPolicy(profile);
  if (!policy) return true;
  if (isDeniedPath(profile, path, context)) return false;
  if (policy.kind === 'unrestricted' || policy.kind === 'external_sandbox') return true;
  return hasMatchingAccess(policy, path, context, ['read', 'write']);
}

export function canWritePath(
  profile: PermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  const policy = fileSystemPolicy(profile);
  if (!policy) return true;
  if (isDeniedPath(profile, path, context)) return false;
  if (isProtectedWriteDenied(policy, path, context) && !hasExplicitPathWrite(policy, path, context))
    return false;
  if (policy.kind === 'unrestricted' || policy.kind === 'external_sandbox') return true;
  return hasMatchingAccess(policy, path, context, ['write']);
}

export function isDeniedPath(
  profile: PermissionProfile,
  path: string,
  context: PermissionProfileMatchContext = {},
): boolean {
  const policy = fileSystemPolicy(profile);
  if (!policy) return false;
  return policy.entries.some(
    (entry) => entry.access === 'deny' && entryMatchesPath(entry, path, context),
  );
}

export function isProtectedMetadataPath(
  path: string,
  workspaceRoots: readonly string[],
  names: readonly string[] = PROTECTED_METADATA_NAMES,
): boolean {
  for (const workspaceRoot of workspaceRoots) {
    const segments = relativeSegments(path, workspaceRoot);
    if (!segments) continue;
    // Windows filesystems and pathWithinRoot are case-insensitive, so the
    // metadata names must match case-insensitively there too — otherwise a
    // write to `.GIT\config` bypasses a `.git` deny and still lands in the
    // real metadata directory.
    const foldCase = isWindowsDrivePathRoot(workspaceRoot);
    const matchesName = foldCase
      ? (segment: string) => names.some((name) => name.toLowerCase() === segment.toLowerCase())
      : (segment: string) => names.includes(segment);
    if (segments.some(matchesName)) return true;
  }
  return false;
}

function isWindowsDrivePathRoot(root: string): boolean {
  return /^[A-Za-z]:\\/.test(root);
}

function fileSystemPolicy(profile: PermissionProfile): FileSystemSandboxPolicy | undefined {
  if (profile.type !== 'managed') return undefined;
  return profile.fileSystem;
}

function hasMatchingAccess(
  policy: FileSystemSandboxPolicy,
  path: string,
  context: PermissionProfileMatchContext,
  accessModes: readonly FileSystemAccessMode[],
): boolean {
  return policy.entries.some(
    (entry) => accessModes.includes(entry.access) && entryMatchesPath(entry, path, context),
  );
}

function entryMatchesPath(
  entry: FileSystemSandboxEntry,
  path: string,
  context: PermissionProfileMatchContext,
): boolean {
  if (entry.kind === 'path' && entry.match === 'exact') {
    return samePath(path, entry.path);
  }
  return entryRoots(entry, context).some((root) => pathWithinRoot(path, root));
}

function hasExplicitPathWrite(
  policy: FileSystemSandboxPolicy,
  path: string,
  context: PermissionProfileMatchContext,
): boolean {
  return policy.entries.some(
    (entry) =>
      entry.kind === 'path' && entry.access === 'write' && entryMatchesPath(entry, path, context),
  );
}
function entryRoots(
  entry: FileSystemSandboxEntry,
  context: PermissionProfileMatchContext,
): readonly string[] {
  if (entry.kind === 'path') return [entry.path];
  switch (entry.special) {
    case ':root':
      return [context.root ?? '/'];
    case ':workspace_roots':
      return context.workspaceRoots ?? [];
    case ':tmpdir':
      return context.tmpdir ? [context.tmpdir] : [];
    case ':slash_tmp':
      return [context.slashTmp ?? '/tmp'];
    case ':minimal':
      return context.minimalRoots ?? [];
  }
}

function isProtectedWriteDenied(
  policy: FileSystemSandboxPolicy,
  path: string,
  context: PermissionProfileMatchContext,
): boolean {
  if (policy.protectedMetadata?.access !== 'deny_write') return false;
  return isProtectedMetadataPath(
    path,
    context.workspaceRoots ?? [],
    policy.protectedMetadata.names,
  );
}

function relativeSegments(path: string, root: string): string[] | undefined {
  const normalizedPath = trimTrailingSlashes(path);
  const normalizedRoot = trimTrailingSlashes(root);
  if (!pathWithinRoot(normalizedPath, normalizedRoot)) return undefined;
  if (normalizedPath === normalizedRoot) return [];
  const separator = normalizedRoot.includes('\\') ? '\\' : '/';
  const relative =
    normalizedRoot === '/'
      ? normalizedPath.slice(1)
      : normalizedPath.slice(normalizedRoot.length + (normalizedRoot.endsWith(separator) ? 0 : 1));
  return relative.split(separator).filter(Boolean);
}

function trimTrailingSlashes(value: string): string {
  if (!value) return '';
  const trimmed = trimTrailingPathSeparators(value);
  return trimmed || '/';
}
import { pathWithinRoot, samePath, trimTrailingPathSeparators } from './absolute-path.js';
