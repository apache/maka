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
  type ArchiveRetentionHold,
  type ArchiveRetentionSweep,
  decodeArchiveRetentionDeletion,
  decodeArchiveRetentionHold,
  decodeArchiveRetentionSweep,
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
 * The archived tasks the policy covers now, counted as Settings › Archived
 * tasks counts them: archived, not an Agent Graph operator, in a family no
 * member of which is pinned. It is neither bound: families a sweep leaves for
 * review are counted, and subtasks a deletion orphans into the archive are
 * not.
 */
export interface StorageRetentionPreview {
  readonly count: number;
  /**
   * When the first of them becomes eligible: after this Host instant. Present
   * exactly while the setting is enabled and `count` is above 0. Enabling or
   * changing the days restarts every clock, so a Client previews that change
   * as `count` tasks eligible after its own now plus the new days.
   */
  readonly eligibleAt?: number;
}

export type StorageRetentionQueryInput = Record<string, never>;

export interface StorageRetentionQueryResult extends StorageRetentionSetting {
  readonly preview: StorageRetentionPreview;
  readonly lastSweep?: ArchiveRetentionSweep;
  readonly lastDeletion?: ArchiveRetentionDeletion;
  /**
   * Present while deletions are held because the wall clock moved ahead
   * further than a sweep expects; they resume once the Host clock reaches
   * `until`, and any setting change clears it.
   */
  readonly hold?: ArchiveRetentionHold;
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
  requireShapedRecord(value, 'storage retention input', [], []);
  return {};
}

export function decodeStorageRetentionQueryResult(value: unknown): StorageRetentionQueryResult {
  const result = requireShapedRecord(
    value,
    'storage retention result',
    ['revision', 'enabled', 'days', 'preview'],
    ['enabledAt', 'lastSweep', 'lastDeletion', 'hold'],
  );
  const setting = decodeSettingFields(result);
  return {
    ...setting,
    preview: decodePreview(result.preview, setting.enabled),
    ...(result.lastSweep === undefined
      ? {}
      : { lastSweep: decodeArchiveRetentionSweep(result.lastSweep, invalidProtocolFrame) }),
    ...(result.lastDeletion === undefined
      ? {}
      : {
          lastDeletion: decodeArchiveRetentionDeletion(result.lastDeletion, invalidProtocolFrame),
        }),
    ...(result.hold === undefined
      ? {}
      : { hold: decodeArchiveRetentionHold(result.hold, invalidProtocolFrame) }),
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

function decodePreview(value: unknown, enabled: boolean): StorageRetentionPreview {
  const preview = requireShapedRecord(value, 'retention preview', ['count'], ['eligibleAt']);
  const count = requireCount(preview.count, 'retention preview count');
  if ((enabled && count > 0) !== (preview.eligibleAt !== undefined)) {
    throw invalidProtocolFrame('Retention preview eligibleAt must be present exactly when due');
  }
  return {
    count,
    ...(preview.eligibleAt === undefined
      ? {}
      : { eligibleAt: requireCount(preview.eligibleAt, 'retention preview eligibleAt') }),
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
