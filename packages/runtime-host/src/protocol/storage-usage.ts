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

/**
 * Sessions measured by one `storage.usage.sessions.query`. Each Session costs
 * several indexed range scans on the Host, so a request stays small and a
 * Client pages through a longer list one request at a time.
 */
export const STORAGE_USAGE_SESSION_MAX_ITEMS = 25;

/**
 * State Root parts the Host can size without scanning database rows.
 *
 * `database` is the operational SQLite file set. `artifacts` sums recorded
 * artifact sizes. `context_offload` is its SQLite file set, which holds inline
 * blobs, plus the managed value files beside it. `memory` is the long-term
 * memory SQLite file set. Worktrees are counted separately and never sized.
 */
export const STORAGE_USAGE_KINDS = ['database', 'artifacts', 'context_offload', 'memory'] as const;

export type StorageUsageKind = (typeof STORAGE_USAGE_KINDS)[number];

export interface StorageUsageTotal {
  readonly kind: StorageUsageKind;
  readonly bytes: number;
  /** False when the figure comes from recorded metadata or may overlap another figure. */
  readonly exact: boolean;
}

export type StorageUsageQueryInput = Record<string, never>;

export interface StorageUsageQueryResult {
  /** Host clock, epoch milliseconds. */
  readonly measuredAt: number;
  readonly totals: readonly StorageUsageTotal[];
  /** Free pages in the operational database that compaction could release. */
  readonly reclaimableBytes: number;
  readonly worktreeCount: number;
}

export interface SessionStorageUsage {
  readonly sessionId: string;
  /** Logical bytes stored for the Session, excluding page and index overhead. */
  readonly bytes: {
    readonly transcript: number;
    readonly runtime: number;
    /** Recorded artifact sizes. */
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

export interface StorageSessionUsageQueryInput {
  readonly sessionIds: readonly string[];
}

export interface StorageSessionUsageQueryResult {
  /**
   * The requested Sessions that exist, in request order. A Session the Host
   * does not hold is omitted rather than reported as empty.
   */
  readonly sessions: readonly SessionStorageUsage[];
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
  }),
  'storage.usage.sessions.query': defineOperation<
    StorageSessionUsageQueryInput,
    StorageSessionUsageQueryResult,
    (typeof STORAGE_USAGE_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: STORAGE_USAGE_ERRORS,
    decodeInput: decodeStorageSessionUsageQueryInput,
    decodeOutput: decodeStorageSessionUsageQueryResult,
    assertOutputForInput: (input, output) => {
      // A subsequence of the request: each id at most once, in request order.
      let next = 0;
      for (const session of output.sessions) {
        while (next < input.sessionIds.length && input.sessionIds[next] !== session.sessionId) {
          next += 1;
        }
        if (next === input.sessionIds.length) {
          throw invalidProtocolFrame('Storage usage Sessions do not match the request');
        }
        next += 1;
      }
    },
  }),
} as const;

export function decodeStorageUsageQueryInput(value: unknown): StorageUsageQueryInput {
  requireExactRecord(value, 'storage usage input', []);
  return {};
}

export function decodeStorageUsageQueryResult(value: unknown): StorageUsageQueryResult {
  const result = requireExactRecord(value, 'storage usage result', [
    'measuredAt',
    'totals',
    'reclaimableBytes',
    'worktreeCount',
  ]);
  if (!Array.isArray(result.totals) || result.totals.length > STORAGE_USAGE_KINDS.length) {
    throw invalidProtocolFrame('Invalid storage usage totals');
  }
  const totals = result.totals.map(decodeTotal);
  if (new Set(totals.map((total) => total.kind)).size !== totals.length) {
    throw invalidProtocolFrame('Duplicate storage usage kind');
  }
  return {
    measuredAt: requireCount(result.measuredAt, 'storage usage measuredAt'),
    totals,
    reclaimableBytes: requireCount(result.reclaimableBytes, 'storage usage reclaimableBytes'),
    worktreeCount: requireCount(result.worktreeCount, 'storage usage worktreeCount'),
  };
}

export function decodeStorageSessionUsageQueryInput(value: unknown): StorageSessionUsageQueryInput {
  const input = requireExactRecord(value, 'storage Session usage input', ['sessionIds']);
  if (
    !Array.isArray(input.sessionIds) ||
    input.sessionIds.length === 0 ||
    input.sessionIds.length > STORAGE_USAGE_SESSION_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid storage usage sessionIds');
  }
  const sessionIds = input.sessionIds.map((sessionId) => requireEntityId(sessionId, 'sessionId'));
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw invalidProtocolFrame('Duplicate storage usage sessionId');
  }
  return { sessionIds };
}

export function decodeStorageSessionUsageQueryResult(
  value: unknown,
): StorageSessionUsageQueryResult {
  const result = requireExactRecord(value, 'storage Session usage result', ['sessions']);
  if (!Array.isArray(result.sessions) || result.sessions.length > STORAGE_USAGE_SESSION_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid storage usage Sessions');
  }
  const sessions = result.sessions.map(decodeSessionUsage);
  if (new Set(sessions.map((session) => session.sessionId)).size !== sessions.length) {
    throw invalidProtocolFrame('Duplicate storage usage Session');
  }
  return { sessions };
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
