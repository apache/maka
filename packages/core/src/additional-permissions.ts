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

export const ADDITIONAL_PERMISSION_ACCESS_MODES = ['read', 'write'] as const;
export type AdditionalPermissionAccess = (typeof ADDITIONAL_PERMISSION_ACCESS_MODES)[number];

export const ADDITIONAL_PERMISSION_SCOPES = ['exact', 'subtree'] as const;
export type AdditionalPermissionScope = (typeof ADDITIONAL_PERMISSION_SCOPES)[number];

export const MAX_ADDITIONAL_FILESYSTEM_ENTRIES = 32;
export const MAX_ADDITIONAL_PERMISSION_PATH_CHARS = 4096;
export const MAX_ADDITIONAL_PERMISSION_SERIALIZED_BYTES = 64 * 1024;

export interface AdditionalFileSystemPermission {
  readonly path: string;
  readonly access: AdditionalPermissionAccess;
  readonly scope: AdditionalPermissionScope;
}

export interface AdditionalPermissionProfile {
  readonly fileSystem?: {
    readonly entries: readonly AdditionalFileSystemPermission[];
  };
  readonly network?: {
    readonly enabled: true;
  };
}

export interface AdditionalPermissionRiskSummary {
  readonly outsideWorkspace: boolean;
  readonly protectedMetadata: boolean;
  readonly networkEnabled: boolean;
}

export type AdditionalPermissionValidationFailureReason =
  | 'invalid_profile'
  | 'empty_profile'
  | 'too_many_entries'
  | 'invalid_entry'
  | 'invalid_path'
  | 'path_too_long'
  | 'payload_too_large';

export type AdditionalPermissionValidationResult =
  | { ok: true; profile: AdditionalPermissionProfile }
  | { ok: false; reason: AdditionalPermissionValidationFailureReason; message: string };

export function validateAdditionalPermissionProfile(
  input: unknown,
): AdditionalPermissionValidationResult {
  if (!isRecord(input))
    return invalid('invalid_profile', 'Additional permission profile must be an object.');
  if (hasUnexpectedKeys(input, ['fileSystem', 'network'])) {
    return invalid('invalid_profile', 'Additional permission profile contains unsupported fields.');
  }

  const entriesResult = validateFilesystem(input.fileSystem);
  if (!entriesResult.ok) return entriesResult;
  const networkResult = validateNetwork(input.network);
  if (!networkResult.ok) return networkResult;
  if (entriesResult.entries.length === 0 && !networkResult.enabled) {
    return invalid(
      'empty_profile',
      'Additional permission profile must contain at least one permission.',
    );
  }

  const profile: AdditionalPermissionProfile = {
    ...(entriesResult.entries.length > 0
      ? { fileSystem: { entries: compactAdditionalFileSystemPermissions(entriesResult.entries) } }
      : {}),
    ...(networkResult.enabled ? { network: { enabled: true as const } } : {}),
  };
  if (serializedByteLength(profile) > MAX_ADDITIONAL_PERMISSION_SERIALIZED_BYTES) {
    return invalid(
      'payload_too_large',
      'Additional permission profile exceeds the serialized size limit.',
    );
  }
  return { ok: true, profile };
}

export function compactAdditionalFileSystemPermissions(
  entries: readonly AdditionalFileSystemPermission[],
): readonly AdditionalFileSystemPermission[] {
  const sorted = [...entries]
    .map((entry) => ({ ...entry, path: trimTrailingSlashes(entry.path) }))
    .sort(compareEntries);
  const compacted: AdditionalFileSystemPermission[] = [];
  for (const entry of sorted) {
    if (compacted.some((existing) => permissionCovers(existing, entry))) continue;
    for (let index = compacted.length - 1; index >= 0; index -= 1) {
      if (permissionCovers(entry, compacted[index]!)) compacted.splice(index, 1);
    }
    compacted.push(entry);
  }
  return compacted.sort(compareEntries);
}

export function serializeAdditionalPermissionProfile(profile: AdditionalPermissionProfile): string {
  const validated = validateAdditionalPermissionProfile(profile);
  if (!validated.ok) throw new Error(validated.message);
  return JSON.stringify(validated.profile);
}

function validateFilesystem(
  input: unknown,
):
  | { ok: true; entries: AdditionalFileSystemPermission[] }
  | Extract<AdditionalPermissionValidationResult, { ok: false }> {
  if (input === undefined) return { ok: true, entries: [] };
  if (!isRecord(input) || hasUnexpectedKeys(input, ['entries']) || !Array.isArray(input.entries)) {
    return invalid('invalid_profile', 'fileSystem must contain an entries array.');
  }
  if (input.entries.length > MAX_ADDITIONAL_FILESYSTEM_ENTRIES) {
    return invalid(
      'too_many_entries',
      `Additional filesystem permissions are limited to ${MAX_ADDITIONAL_FILESYSTEM_ENTRIES} entries.`,
    );
  }
  const entries: AdditionalFileSystemPermission[] = [];
  for (const candidate of input.entries) {
    if (!isRecord(candidate) || hasUnexpectedKeys(candidate, ['path', 'access', 'scope'])) {
      return invalid(
        'invalid_entry',
        'Additional filesystem permission contains unsupported fields.',
      );
    }
    if (
      typeof candidate.path !== 'string' ||
      !ADDITIONAL_PERMISSION_ACCESS_MODES.includes(
        candidate.access as AdditionalPermissionAccess,
      ) ||
      !ADDITIONAL_PERMISSION_SCOPES.includes(candidate.scope as AdditionalPermissionScope)
    ) {
      return invalid(
        'invalid_entry',
        'Additional filesystem permission must contain path, access, and scope.',
      );
    }
    if (!isNormalizedAbsolutePath(candidate.path)) {
      return invalid(
        'invalid_path',
        'Additional filesystem permission path must be a normalized absolute path.',
      );
    }
    if (candidate.path.length > MAX_ADDITIONAL_PERMISSION_PATH_CHARS) {
      return invalid(
        'path_too_long',
        'Additional filesystem permission path exceeds the length limit.',
      );
    }
    entries.push({
      path: trimTrailingSlashes(candidate.path),
      access: candidate.access as AdditionalPermissionAccess,
      scope: candidate.scope as AdditionalPermissionScope,
    });
  }
  return { ok: true, entries };
}

function validateNetwork(
  input: unknown,
): { ok: true; enabled: boolean } | Extract<AdditionalPermissionValidationResult, { ok: false }> {
  if (input === undefined) return { ok: true, enabled: false };
  if (!isRecord(input) || hasUnexpectedKeys(input, ['enabled']) || input.enabled !== true) {
    return invalid('invalid_profile', 'network additional permission only supports enabled: true.');
  }
  return { ok: true, enabled: true };
}

function permissionCovers(
  existing: AdditionalFileSystemPermission,
  candidate: AdditionalFileSystemPermission,
): boolean {
  if (candidate.access === 'write' && existing.access !== 'write') return false;
  if (existing.scope === 'exact') {
    return candidate.scope === 'exact' && samePath(existing.path, candidate.path);
  }
  return pathWithinRoot(candidate.path, existing.path);
}

function compareEntries(
  a: AdditionalFileSystemPermission,
  b: AdditionalFileSystemPermission,
): number {
  return (
    a.path.localeCompare(b.path) ||
    (a.scope === b.scope ? 0 : a.scope === 'subtree' ? -1 : 1) ||
    (a.access === b.access ? 0 : a.access === 'write' ? -1 : 1)
  );
}

function trimTrailingSlashes(value: string): string {
  return trimTrailingPathSeparators(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function invalid(
  reason: AdditionalPermissionValidationFailureReason,
  message: string,
): Extract<AdditionalPermissionValidationResult, { ok: false }> {
  return { ok: false, reason, message };
}
import {
  isNormalizedAbsolutePath,
  pathWithinRoot,
  samePath,
  trimTrailingPathSeparators,
} from './absolute-path.js';
import { serializedByteLength } from './serialized-byte-length.js';
