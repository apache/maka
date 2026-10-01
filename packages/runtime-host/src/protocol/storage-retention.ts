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

import { requireCount, requireExactRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
export const RETENTION_DAYS = [30, 60, 90] as const;
export type RetentionDays = (typeof RETENTION_DAYS)[number];
export interface StorageRetentionPolicy {
  readonly enabled: boolean;
  readonly days: RetentionDays;
  readonly enabledAt: number | null;
  readonly revision: number;
}
export interface StorageRetentionSetInput {
  readonly enabled: boolean;
  readonly days: RetentionDays;
  readonly expectedRevision: number;
}
export interface StorageRetentionSweep {
  readonly at: number;
  readonly deleted: number;
  readonly busy: number;
  readonly needsReview: number;
  readonly failed: number;
}
export interface StorageRetentionQueryResult {
  readonly policy: StorageRetentionPolicy;
  readonly preview: { readonly count: number; readonly eligibleAt: number | null };
  readonly lastSweep: StorageRetentionSweep | null;
  readonly lastDeletion: {
    readonly at: number;
    readonly count: number;
    readonly estimatedBytes: number | null;
  } | null;
}
const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'operation_conflict',
  'internal_failure',
] as const;
export const STORAGE_RETENTION_OPERATION_SPECS = {
  'storage.retention.query': defineOperation<
    Record<string, never>,
    StorageRetentionQueryResult,
    (typeof ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: (value) => {
      requireExactRecord(value, 'retention query', []);
      return {};
    },
    decodeOutput: decodeStorageRetentionQueryResult,
  }),
  'storage.retention.set': defineOperation<
    StorageRetentionSetInput,
    StorageRetentionPolicy,
    (typeof ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: (value) => {
      const item = requireExactRecord(value, 'retention set', [
        'expectedRevision',
        'enabled',
        'days',
      ]);
      return {
        enabled: bool(item.enabled),
        days: days(item.days),
        expectedRevision: requireCount(item.expectedRevision, 'retention revision'),
      };
    },
    decodeOutput: decodeStorageRetentionPolicy,
  }),
} as const;
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame('Invalid retention enabled');
  return value;
}
function days(value: unknown): RetentionDays {
  if (!RETENTION_DAYS.includes(value as RetentionDays))
    throw invalidProtocolFrame('Invalid retention days');
  return value as RetentionDays;
}
function nullableCount(value: unknown): number | null {
  return value === null ? null : requireCount(value, 'retention count');
}
export function decodeStorageRetentionPolicy(value: unknown): StorageRetentionPolicy {
  const item = requireExactRecord(value, 'retention policy', [
    'enabled',
    'days',
    'enabledAt',
    'revision',
  ]);
  const enabled = bool(item.enabled);
  const enabledAt = nullableCount(item.enabledAt);
  if (enabled !== (enabledAt !== null)) throw invalidProtocolFrame('Invalid retention timestamp');
  return {
    enabled,
    enabledAt,
    days: days(item.days),
    revision: requireCount(item.revision, 'retention revision'),
  };
}
export function decodeStorageRetentionQueryResult(value: unknown): StorageRetentionQueryResult {
  const item = requireExactRecord(value, 'retention result', [
    'policy',
    'preview',
    'lastSweep',
    'lastDeletion',
  ]);
  const preview = requireExactRecord(item.preview, 'retention preview', ['count', 'eligibleAt']);
  const sweep =
    item.lastSweep === null
      ? null
      : requireExactRecord(item.lastSweep, 'retention sweep', [
          'at',
          'deleted',
          'busy',
          'needsReview',
          'failed',
        ]);
  const deletion =
    item.lastDeletion === null
      ? null
      : requireExactRecord(item.lastDeletion, 'retention deletion', [
          'at',
          'count',
          'estimatedBytes',
        ]);
  return {
    policy: decodeStorageRetentionPolicy(item.policy),
    preview: {
      count: requireCount(preview.count, 'preview count'),
      eligibleAt: nullableCount(preview.eligibleAt),
    },
    lastSweep:
      sweep === null
        ? null
        : {
            at: requireCount(sweep.at, 'sweep time'),
            deleted: requireCount(sweep.deleted, 'deleted'),
            busy: requireCount(sweep.busy, 'busy'),
            needsReview: requireCount(sweep.needsReview, 'needs review'),
            failed: requireCount(sweep.failed, 'failed'),
          },
    lastDeletion:
      deletion === null
        ? null
        : {
            at: requireCount(deletion.at, 'deletion time'),
            count: requireCount(deletion.count, 'deletion count'),
            estimatedBytes: nullableCount(deletion.estimatedBytes),
          },
  };
}
