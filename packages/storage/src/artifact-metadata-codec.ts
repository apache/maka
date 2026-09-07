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

import { isAbsolute } from 'node:path';
import {
  ARTIFACT_KINDS,
  ARTIFACT_SOURCES,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactSource,
  isArtifactTurnKey,
  isCanonicalArtifactEntityId,
} from '@maka/core/artifacts';
import { isDeepResearchArtifactRole } from '@maka/core/deep-research-run';

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(ARTIFACT_KINDS);
const ARTIFACT_SOURCE_SET = new Set<ArtifactSource>(ARTIFACT_SOURCES);
const ARTIFACT_RECORD_KEYS = new Set([
  'id',
  'sessionId',
  'turnId',
  'createdAt',
  'name',
  'kind',
  'relativePath',
  'sizeBytes',
  'mimeType',
  'source',
  'summary',
  'deepResearchRole',
]);

export function decodeArtifactRecordJsons(values: readonly unknown[]): ArtifactRecord[] {
  const records: ArtifactRecord[] = [];
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (!hasSupportedArtifactSource(parsed)) continue;
    try {
      const record = decodeArtifactRecord(parsed, index + 1);
      if (ids.has(record.id)) continue;
      ids.add(record.id);
      records.push(record);
    } catch {}
  }
  return records;
}

function hasSupportedArtifactSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    ARTIFACT_SOURCE_SET.has(value.source as ArtifactSource)
  );
}

export function isSafeRelativeArtifactPath(relativePath: string): boolean {
  if (!relativePath || isAbsolute(relativePath)) return false;
  if (relativePath.includes('\0')) return false;
  if (relativePath.includes('//') || relativePath.includes('\\\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relativePath)) return false;
  const parts = relativePath.split(/[\\/]+/);
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export function validateRelativeArtifactPath(relativePath: string): void {
  if (!isSafeRelativeArtifactPath(relativePath)) {
    throw new Error('Artifact relativePath must be artifact-root-relative');
  }
}

function decodeArtifactRecord(value: unknown, index: number): ArtifactRecord {
  if (!isRecord(value)) throw invalidMetadataRecord(index);
  if (Object.keys(value).some((key) => !ARTIFACT_RECORD_KEYS.has(key))) {
    throw invalidMetadataRecord(index);
  }
  if (
    !isCanonicalArtifactEntityId(value.id) ||
    !isCanonicalArtifactEntityId(value.sessionId) ||
    !isArtifactTurnKey(value.turnId) ||
    !isNonEmptyString(value.name) ||
    typeof value.kind !== 'string' ||
    !ARTIFACT_KIND_SET.has(value.kind as ArtifactKind) ||
    !isNonEmptyString(value.relativePath) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    !isOptionalNonEmptyString(value.mimeType) ||
    !isOptionalNonEmptyString(value.summary) ||
    (value.deepResearchRole !== undefined && !isDeepResearchArtifactRole(value.deepResearchRole)) ||
    typeof value.source !== 'string'
  ) {
    throw invalidMetadataRecord(index);
  }
  validateRelativeArtifactPath(value.relativePath);
  if (!isCompatibleArtifactName(value.name)) throw invalidMetadataRecord(index);
  if (value.relativePath !== `${value.sessionId}/${value.id}-${value.name}`) {
    throw invalidMetadataRecord(index);
  }
  return value as unknown as ArtifactRecord;
}

function isCompatibleArtifactName(name: string): boolean {
  if (name.length === 0 || name.length > 120) return false;
  if (/[\\/:*?"<>|\0]/.test(name)) return false;
  if (/^\s|\s{2,}|[^\S ]/u.test(name)) return false;
  if (name.endsWith(' ') && name.length < 120) return false;
  return true;
}

function invalidMetadataRecord(index: number): Error {
  return new Error(`Invalid artifact metadata record ${index}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}
