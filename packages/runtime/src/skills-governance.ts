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

import { isRecord, isSafeSkillId } from './path-containment.js';
import {
  BUNDLED_SKILL_CATALOG,
  type BundledSkillSource,
} from './bundled-skill-catalog.generated.js';

export type SkillSourceType = 'workspace' | 'bundled' | 'managed' | 'unknown';
export type SkillValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type ManagedSkillUpdateStatus =
  | 'not_managed'
  | 'source_missing'
  | 'up_to_date'
  | 'update_available'
  | 'local_modified'
  | 'metadata_error';
export type SkillLockValidationCode =
  | 'missing_lock'
  | 'modified'
  | 'invalid_json'
  | 'id_mismatch'
  | 'unsupported_schema'
  | 'invalid_hash'
  | 'write_failed'
  | 'lock_symlink';

export interface SkillLockFile {
  schemaVersion: 1;
  id: string;
  sourceType: 'bundled' | 'managed';
  sourceName: string;
  sourceVersion: string;
  contentSha256: string;
  installedAt: string;
  sourceId?: string;
  sourceContentSha256?: string;
}

export interface SkillGovernanceStatus {
  sourceType: SkillSourceType;
  sourceName?: string;
  sourceVersion?: string;
  contentSha256?: string;
  installedAt?: string;
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  validationCodes: SkillLockValidationCode[];
  validationMessages?: string[];
  managedSourceId?: string;
  managedUpdateStatus: ManagedSkillUpdateStatus;
  sourceContentSha256?: string;
}

export type ManagedSourceSnapshot =
  | { status: 'available'; contentSha256: string }
  | { status: 'missing' };

export const MANAGED_SKILL_BASELINE_RELATIVE_PATH = '.maka/baseline/SKILL.md';

const bundledById = new Map(BUNDLED_SKILL_CATALOG.map((skill) => [skill.id, skill]));

export function getBundledSkillSource(id: string): BundledSkillSource | undefined {
  return bundledById.get(id);
}

export function createBundledSkillLock(
  source: BundledSkillSource,
  installedAt = new Date().toISOString(),
): SkillLockFile {
  return {
    schemaVersion: 1,
    id: source.id,
    sourceType: 'bundled',
    sourceName: source.sourceName,
    sourceVersion: source.sourceVersion,
    contentSha256: source.contentSha256,
    installedAt,
  };
}

export function createManagedSkillLock(
  id: string,
  contentSha256: string,
  sourceContentSha256: string,
  sourceId = id,
  installedAt = new Date().toISOString(),
): SkillLockFile {
  return {
    schemaVersion: 1,
    id,
    sourceType: 'managed',
    sourceName: 'local-library',
    sourceVersion: '1',
    contentSha256,
    installedAt,
    sourceId,
    sourceContentSha256,
  };
}

export function validateSkillLock(input: {
  lock: unknown;
  skillId: string;
  currentContentSha256: string;
  managedSource?: ManagedSourceSnapshot;
}): SkillGovernanceStatus {
  const { lock, skillId, currentContentSha256 } = input;
  if (!isRecord(lock)) return metadataError('invalid_json', 'Skill lock JSON must be an object.');
  if (lock.schemaVersion !== 1) {
    return metadataError('unsupported_schema', 'Skill lock schema is unsupported.');
  }
  if (lock.id !== skillId) {
    return metadataError('id_mismatch', 'Skill lock id does not match the skill directory.');
  }
  if (lock.sourceType !== 'bundled' && lock.sourceType !== 'managed') {
    return metadataError('unsupported_schema', 'Skill lock source type is unsupported.');
  }
  if (!isSha256(lock.contentSha256)) {
    return metadataError('invalid_hash', 'Skill lock hash is invalid.');
  }
  if (lock.sourceType === 'bundled' && !isTrustedBundledLock(lock, skillId)) {
    return metadataError(
      'unsupported_schema',
      'Skill lock source is not trusted in this Maka version.',
    );
  }

  const userModified = lock.contentSha256.toLowerCase() !== currentContentSha256.toLowerCase();
  if (lock.sourceType === 'managed') {
    return validateManagedLock(lock, userModified, input.managedSource);
  }
  return {
    sourceType: 'bundled',
    ...(typeof lock.sourceName === 'string' && lock.sourceName
      ? { sourceName: lock.sourceName }
      : {}),
    ...(typeof lock.sourceVersion === 'string' && lock.sourceVersion
      ? { sourceVersion: lock.sourceVersion }
      : {}),
    ...(typeof lock.installedAt === 'string' && lock.installedAt
      ? { installedAt: lock.installedAt }
      : {}),
    contentSha256: lock.contentSha256,
    userModified,
    validationStatus: userModified ? 'modified' : 'ok',
    validationCodes: userModified ? ['modified'] : [],
    managedUpdateStatus: 'not_managed',
  };
}

export function missingSkillLockStatus(): SkillGovernanceStatus {
  return {
    sourceType: 'workspace',
    userModified: false,
    validationStatus: 'missing_lock',
    validationCodes: ['missing_lock'],
    managedUpdateStatus: 'not_managed',
  };
}

export function invalidSkillLockStatus(
  code: SkillLockValidationCode,
  message: string,
): SkillGovernanceStatus {
  return metadataError(code, message);
}

export function isCurrentBundledSkillLock(lock: unknown, source: BundledSkillSource): boolean {
  return (
    isRecord(lock) &&
    lock.schemaVersion === 1 &&
    lock.id === source.id &&
    lock.sourceType === 'bundled' &&
    lock.sourceName === source.sourceName &&
    lock.sourceVersion === source.sourceVersion &&
    typeof lock.installedAt === 'string' &&
    lock.installedAt.length > 0 &&
    isSha256(lock.contentSha256) &&
    lock.contentSha256.toLowerCase() === source.contentSha256.toLowerCase()
  );
}

function validateManagedLock(
  lock: Record<string, unknown>,
  userModified: boolean,
  managedSource: ManagedSourceSnapshot | undefined,
): SkillGovernanceStatus {
  if (lock.sourceName !== 'local-library' || lock.sourceVersion !== '1') {
    return metadataError('unsupported_schema', 'Managed skill lock source metadata is invalid.');
  }
  const sourceId =
    typeof lock.sourceId === 'string' && isSafeSkillId(lock.sourceId) ? lock.sourceId : undefined;
  const sourceContentSha256 = isSha256(lock.sourceContentSha256)
    ? lock.sourceContentSha256
    : undefined;
  if (
    !sourceId ||
    !sourceContentSha256 ||
    lock.contentSha256?.toString().toLowerCase() !== sourceContentSha256.toLowerCase()
  ) {
    return metadataError('unsupported_schema', 'Managed skill lock source metadata is invalid.');
  }

  const managedUpdateStatus: ManagedSkillUpdateStatus = userModified
    ? 'local_modified'
    : managedSource?.status !== 'available'
      ? 'source_missing'
      : managedSource.contentSha256.toLowerCase() === sourceContentSha256.toLowerCase()
        ? 'up_to_date'
        : 'update_available';
  return {
    sourceType: 'managed',
    sourceName: 'local-library',
    sourceVersion: '1',
    ...(typeof lock.installedAt === 'string' && lock.installedAt
      ? { installedAt: lock.installedAt }
      : {}),
    contentSha256: lock.contentSha256 as string,
    userModified,
    validationStatus: userModified ? 'modified' : 'ok',
    validationCodes: userModified ? ['modified'] : [],
    managedSourceId: sourceId,
    managedUpdateStatus,
    sourceContentSha256,
  };
}

function isTrustedBundledLock(lock: Record<string, unknown>, id: string): boolean {
  const source = bundledById.get(id);
  if (!source || !isSha256(lock.contentSha256)) return false;
  if (lock.sourceName !== source.sourceName || lock.sourceVersion !== source.sourceVersion) {
    return false;
  }
  const trustedHashes = new Set([
    source.contentSha256.toLowerCase(),
    ...source.legacyContentSha256.map((hash) => hash.toLowerCase()),
  ]);
  return trustedHashes.has(lock.contentSha256.toLowerCase());
}

function metadataError(code: SkillLockValidationCode, message: string): SkillGovernanceStatus {
  return {
    sourceType: 'unknown',
    userModified: false,
    validationStatus: 'metadata_error',
    validationCodes: [code],
    validationMessages: [message],
    managedUpdateStatus: 'metadata_error',
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}
