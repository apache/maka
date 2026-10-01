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

import {
  type ArchiveRetentionDays,
  type ArchiveRetentionDeletion,
  type ArchiveRetentionSweep,
  isArchiveRetentionDays,
} from '@maka/core/archive-retention';
import { requireCount, requireShapedRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

/**
 * One Host's archived-task retention setting. Off by default; while enabled,
 * the Host deletes archived tasks whose clock has run longer than `days`.
 */
export interface StorageRetentionSetting {
  /** Moves with every setting change; `storage.retention.set` must name it. */
  readonly revision: number;
  readonly enabled: boolean;
  readonly days: ArchiveRetentionDays;
  /**
   * Host clock when the current setting took effect, present exactly while
   * enabled. No task's clock starts before it.
   */
  readonly enabledAt?: number;
}

/**
 * The archived tasks, counted as Settings › Archived tasks counts them, that
 * the policy would delete if nothing changed: archived, in a family no member
 * of which is pinned. Families a sweep leaves for review (those whose deletion
 * would reclaim a subagent worktree or archive an active subtask) are still
 * counted, so this is an upper bound.
 */
export interface StorageRetentionPreview {
  readonly count: number;
  /** The first of them becomes eligible once the Host clock passes this; absent when `count` is 0. */
  readonly eligibleAt?: number;
}

export interface StorageRetentionQueryInput {
  /**
   * Preview what enabling the setting with these days, now, would do. That is
   * also what changing the days of an enabled setting does, since any change
   * restarts the clock.
   */
  readonly previewDays?: ArchiveRetentionDays;
}

export interface StorageRetentionQueryResult extends StorageRetentionSetting {
  /** Present for an enabled setting, or when `previewDays` was asked for. */
  readonly preview?: StorageRetentionPreview;
  readonly lastSweep?: ArchiveRetentionSweep;
  readonly lastDeletion?: ArchiveRetentionDeletion;
}

export interface StorageRetentionSetInput {
  readonly expectedRevision: number;
  readonly enabled: boolean;
  readonly days: ArchiveRetentionDays;
}

export type StorageRetentionSetResult =
  | { readonly kind: 'committed'; readonly setting: StorageRetentionSetting }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'internal_failure',
] as const;

const SET_ERRORS = [...QUERY_ERRORS, 'commit_outcome_unknown'] as const;

export const STORAGE_RETENTION_OPERATION_SPECS = {
  'storage.retention.query': defineOperation<
    StorageRetentionQueryInput,
    StorageRetentionQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeStorageRetentionQueryInput,
    decodeOutput: decodeStorageRetentionQueryResult,
  }),
  'storage.retention.set': defineOperation<
    StorageRetentionSetInput,
    StorageRetentionSetResult,
    (typeof SET_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: SET_ERRORS,
    decodeInput: decodeStorageRetentionSetInput,
    decodeOutput: decodeStorageRetentionSetResult,
    assertOutputForInput: (input, output) => {
      if (output.kind === 'revision_conflict') {
        if (output.expectedRevision !== input.expectedRevision) {
          throw invalidProtocolFrame('Retention revision conflict does not match the request');
        }
        return;
      }
      if (
        output.setting.enabled !== input.enabled ||
        output.setting.days !== input.days ||
        output.setting.revision < input.expectedRevision
      ) {
        throw invalidProtocolFrame('Retention setting does not match the request');
      }
    },
  }),
} as const;

export function decodeStorageRetentionQueryInput(value: unknown): StorageRetentionQueryInput {
  const input = requireShapedRecord(value, 'storage retention input', [], ['previewDays']);
  return input.previewDays === undefined ? {} : { previewDays: requireDays(input.previewDays) };
}

export function decodeStorageRetentionQueryResult(value: unknown): StorageRetentionQueryResult {
  const result = requireShapedRecord(
    value,
    'storage retention result',
    ['revision', 'enabled', 'days'],
    ['enabledAt', 'preview', 'lastSweep', 'lastDeletion'],
  );
  return {
    ...decodeSettingFields(result),
    ...(result.preview === undefined ? {} : { preview: decodePreview(result.preview) }),
    ...(result.lastSweep === undefined ? {} : { lastSweep: decodeSweep(result.lastSweep) }),
    ...(result.lastDeletion === undefined
      ? {}
      : { lastDeletion: decodeDeletion(result.lastDeletion) }),
  };
}

export function decodeStorageRetentionSetInput(value: unknown): StorageRetentionSetInput {
  const input = requireShapedRecord(
    value,
    'storage retention set input',
    ['expectedRevision', 'enabled', 'days'],
    [],
  );
  return {
    expectedRevision: requireCount(input.expectedRevision, 'retention expectedRevision'),
    enabled: requireBoolean(input.enabled, 'retention enabled'),
    days: requireDays(input.days),
  };
}

export function decodeStorageRetentionSetResult(value: unknown): StorageRetentionSetResult {
  const result = requireShapedRecord(
    value,
    'storage retention set result',
    ['kind'],
    ['setting', 'expectedRevision', 'actualRevision'],
  );
  if (result.kind === 'committed') {
    requireShapedRecord(result, 'storage retention set result', ['kind', 'setting'], []);
    const setting = requireShapedRecord(
      result.setting,
      'storage retention setting',
      ['revision', 'enabled', 'days'],
      ['enabledAt'],
    );
    return { kind: 'committed', setting: decodeSettingFields(setting) };
  }
  if (result.kind === 'revision_conflict') {
    requireShapedRecord(
      result,
      'storage retention revision conflict',
      ['kind', 'expectedRevision', 'actualRevision'],
      [],
    );
    return {
      kind: 'revision_conflict',
      expectedRevision: requireCount(result.expectedRevision, 'retention expectedRevision'),
      actualRevision: requireCount(result.actualRevision, 'retention actualRevision'),
    };
  }
  throw invalidProtocolFrame('Invalid storage retention set result');
}

function decodeSettingFields(record: Record<string, unknown>): StorageRetentionSetting {
  const enabled = requireBoolean(record.enabled, 'retention enabled');
  if (enabled !== (record.enabledAt !== undefined)) {
    throw invalidProtocolFrame('Retention enabledAt must be present exactly while enabled');
  }
  return {
    revision: requireCount(record.revision, 'retention revision'),
    enabled,
    days: requireDays(record.days),
    ...(record.enabledAt === undefined
      ? {}
      : { enabledAt: requireCount(record.enabledAt, 'retention enabledAt') }),
  };
}

function decodePreview(value: unknown): StorageRetentionPreview {
  const preview = requireShapedRecord(value, 'retention preview', ['count'], ['eligibleAt']);
  const count = requireCount(preview.count, 'retention preview count');
  if (count > 0 !== (preview.eligibleAt !== undefined)) {
    throw invalidProtocolFrame('Retention preview eligibleAt must be present exactly with tasks');
  }
  return {
    count,
    ...(preview.eligibleAt === undefined
      ? {}
      : { eligibleAt: requireCount(preview.eligibleAt, 'retention preview eligibleAt') }),
  };
}

function decodeSweep(value: unknown): ArchiveRetentionSweep {
  const sweep = requireShapedRecord(
    value,
    'retention sweep',
    ['at', 'deleted', 'skippedBusy', 'needsReview', 'failed'],
    ['paused'],
  );
  if (sweep.paused !== undefined && sweep.paused !== true) {
    throw invalidProtocolFrame('Invalid retention sweep paused');
  }
  return {
    at: requireCount(sweep.at, 'retention sweep at'),
    deleted: requireCount(sweep.deleted, 'retention sweep deleted'),
    skippedBusy: requireCount(sweep.skippedBusy, 'retention sweep skippedBusy'),
    needsReview: requireCount(sweep.needsReview, 'retention sweep needsReview'),
    failed: requireCount(sweep.failed, 'retention sweep failed'),
    ...(sweep.paused === true ? { paused: true as const } : {}),
  };
}

function decodeDeletion(value: unknown): ArchiveRetentionDeletion {
  const deletion = requireShapedRecord(value, 'retention deletion', ['at', 'count'], ['bytes']);
  return {
    at: requireCount(deletion.at, 'retention deletion at'),
    count: requireCount(deletion.count, 'retention deletion count'),
    ...(deletion.bytes === undefined
      ? {}
      : { bytes: requireCount(deletion.bytes, 'retention deletion bytes') }),
  };
}

function requireDays(value: unknown): ArchiveRetentionDays {
  if (!isArchiveRetentionDays(value)) throw invalidProtocolFrame('Invalid retention days');
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}
