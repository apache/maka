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

import { requireCount, requireEntityId, requireExactRecord, requireShapedRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

/** Upper bound on Sessions measured by one query; a page of visible rows fits well inside it. */
export const STORAGE_USAGE_SESSION_MAX_ITEMS = 100;

/**
 * Non-overlapping parts of the Host's State Root footprint.
 *
 * `transcript`, `runtime` and `usage_history` are logical payload bytes inside
 * the operational database; `database` is the rest of that database's files
 * (other records, indexes, free pages). `context_offload` is deduplicated blob
 * bytes. Worktrees are counted separately and never sized.
 */
export const STORAGE_USAGE_KINDS = [
  'database',
  'transcript',
  'runtime',
  'usage_history',
  'artifacts',
  'context_offload',
  'memory',
] as const;

export type StorageUsageKind = (typeof STORAGE_USAGE_KINDS)[number];

export interface StorageUsageTotal {
  readonly kind: StorageUsageKind;
  readonly bytes: number;
  /** False when the figure is a logical payload size rather than bytes on disk. */
  readonly exact: boolean;
}

export interface SessionStorageUsage {
  readonly sessionId: string;
  readonly bytes: {
    readonly transcript: number;
    readonly runtime: number;
    readonly artifacts: number;
    /**
     * Logical context-offload bytes referenced by the Session. Blobs are shared
     * across Sessions, so this is not what deleting the Session would free.
     * Absent when the Host has no context-offload Store.
     */
    readonly context?: number;
  };
  /** Worktrees bound to the Session or to its direct Subagent children. */
  readonly worktreeCount: number;
}

export interface StorageUsageQueryInput {
  /** Also measure these Sessions. Omit to read the State Root totals only. */
  readonly sessionIds?: readonly string[];
}

export interface StorageUsageQueryResult {
  /** Host clock, epoch milliseconds. */
  readonly measuredAt: number;
  readonly totals: readonly StorageUsageTotal[];
  /** Free pages in the operational database that compaction could release. */
  readonly reclaimableBytes: number;
  readonly worktreeCount: number;
  /** Present exactly when the input named Sessions, in input order. */
  readonly sessions?: readonly SessionStorageUsage[];
}

const STORAGE_USAGE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'persistence_failed',
  'internal_failure',
] as const;

export const STORAGE_USAGE_OPERATION_SPECS = {
  'storage.usage.query': defineOperation<
    StorageUsageQueryInput,
    StorageUsageQueryResult,
    (typeof STORAGE_USAGE_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: STORAGE_USAGE_ERRORS,
    decodeInput: decodeStorageUsageQueryInput,
    decodeOutput: decodeStorageUsageQueryResult,
    assertOutputForInput: (input, output) => {
      const requested = input.sessionIds;
      const measured = output.sessions;
      if (requested === undefined) {
        if (measured !== undefined) {
          throw invalidProtocolFrame('Storage usage returned Sessions that were not requested');
        }
        return;
      }
      if (
        measured === undefined ||
        measured.length !== requested.length ||
        measured.some((session, index) => session.sessionId !== requested[index])
      ) {
        throw invalidProtocolFrame('Storage usage Sessions do not match the request');
      }
    },
  }),
} as const;

export function decodeStorageUsageQueryInput(value: unknown): StorageUsageQueryInput {
  const input = requireShapedRecord(value, 'storage usage input', [], ['sessionIds']);
  if (input.sessionIds === undefined) return {};
  return { sessionIds: decodeSessionIds(input.sessionIds) };
}

export function decodeStorageUsageQueryResult(value: unknown): StorageUsageQueryResult {
  const result = requireShapedRecord(
    value,
    'storage usage result',
    ['measuredAt', 'totals', 'reclaimableBytes', 'worktreeCount'],
    ['sessions'],
  );
  if (!Array.isArray(result.totals) || result.totals.length > STORAGE_USAGE_KINDS.length) {
    throw invalidProtocolFrame('Invalid storage usage totals');
  }
  const totals = result.totals.map(decodeTotal);
  if (new Set(totals.map((total) => total.kind)).size !== totals.length) {
    throw invalidProtocolFrame('Duplicate storage usage kind');
  }
  let sessions: SessionStorageUsage[] | undefined;
  if (result.sessions !== undefined) {
    if (
      !Array.isArray(result.sessions) ||
      result.sessions.length > STORAGE_USAGE_SESSION_MAX_ITEMS
    ) {
      throw invalidProtocolFrame('Invalid storage usage Sessions');
    }
    sessions = result.sessions.map(decodeSessionUsage);
    if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length) {
      throw invalidProtocolFrame('Duplicate storage usage Session');
    }
  }
  return {
    measuredAt: requireCount(result.measuredAt, 'storage usage measuredAt'),
    totals,
    reclaimableBytes: requireCount(result.reclaimableBytes, 'storage usage reclaimableBytes'),
    worktreeCount: requireCount(result.worktreeCount, 'storage usage worktreeCount'),
    ...(sessions === undefined ? {} : { sessions }),
  };
}

function decodeSessionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > STORAGE_USAGE_SESSION_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid storage usage sessionIds');
  }
  const sessionIds = value.map((sessionId) => requireEntityId(sessionId, 'sessionId'));
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw invalidProtocolFrame('Duplicate storage usage sessionId');
  }
  return sessionIds;
}

function decodeTotal(value: unknown): StorageUsageTotal {
  const total = requireExactRecord(value, 'storage usage total', ['kind', 'bytes', 'exact']);
  if (!STORAGE_USAGE_KINDS.includes(total.kind as StorageUsageKind)) {
    throw invalidProtocolFrame('Invalid storage usage kind');
  }
  if (typeof total.exact !== 'boolean') {
    throw invalidProtocolFrame('Invalid storage usage exactness');
  }
  return {
    kind: total.kind as StorageUsageKind,
    bytes: requireCount(total.bytes, 'storage usage bytes'),
    exact: total.exact,
  };
}

function decodeSessionUsage(value: unknown): SessionStorageUsage {
  const session = requireExactRecord(value, 'storage usage Session', [
    'sessionId',
    'bytes',
    'worktreeCount',
  ]);
  const bytes = requireShapedRecord(
    session.bytes,
    'storage usage Session bytes',
    ['transcript', 'runtime', 'artifacts'],
    ['context'],
  );
  return {
    sessionId: requireEntityId(session.sessionId, 'sessionId'),
    bytes: {
      transcript: requireCount(bytes.transcript, 'storage usage transcript bytes'),
      runtime: requireCount(bytes.runtime, 'storage usage runtime bytes'),
      artifacts: requireCount(bytes.artifacts, 'storage usage artifact bytes'),
      ...(bytes.context === undefined
        ? {}
        : { context: requireCount(bytes.context, 'storage usage context bytes') }),
    },
    worktreeCount: requireCount(session.worktreeCount, 'storage usage worktreeCount'),
  };
}
