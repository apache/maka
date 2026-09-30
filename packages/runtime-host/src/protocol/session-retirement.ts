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

import { decodeSessionCatalogItem, type SessionCatalogItem } from './session-catalog.js';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { STORAGE_USAGE_SESSION_MAX_ITEMS } from './storage-usage.js';

const LIFECYCLE_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_busy',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
  'internal_failure',
] as const;

export type SessionLifecycleState = 'active' | 'archived';

export interface SessionLifecycleSetInput {
  readonly sessionId: string;
  readonly state: SessionLifecycleState;
}

export interface SessionRemoveInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
}

/**
 * Sessions previewed by one `session.remove.preview`. The preview measures
 * every Session the removals would delete with the same per-Session statements
 * as `storage.usage.sessions.query`, so it keeps that query's bound and a
 * Client pages a longer selection one request at a time.
 */
export const SESSION_REMOVE_PREVIEW_MAX_ITEMS = STORAGE_USAGE_SESSION_MAX_ITEMS;

export interface SessionRemovePreviewInput {
  /** Each Session is previewed as its own `session.remove` would remove it. */
  readonly sessionIds: readonly string[];
}

/**
 * What removing every requested Session, one `session.remove` each, would do,
 * read from the same removal plans those commands execute. A Session that is
 * already gone, or that cannot be removed on its own, contributes nothing.
 */
export interface SessionRemovePreviewResult {
  /**
   * How many ordinary linked subagent subtasks the deletes would move to the
   * archive rather than destroy, deduplicated by revision family. The Host
   * owns the removal plan, so the confirm warns off this rather than
   * re-deriving it from a catalog projection that lacks the operator marker.
   */
  readonly archivableSubtaskCount: number;
  /**
   * Child tasks deleted together with their root — Agent Graph operators —
   * deduplicated by revision family.
   */
  readonly removedSubtaskCount: number;
  /** Subagent worktrees whose checkout the deletes retire. */
  readonly worktreeCount: number;
  /**
   * Logical bytes stored for every Session the deletes remove, revisions and
   * removed child tasks included. An estimate: context-offload bytes count
   * once per referencing Session although the blobs are shared.
   */
  readonly bytes: number;
}

export type SessionRemoveResult =
  | {
      readonly kind: 'removed';
      readonly sessionId: string;
      /**
       * How many ordinary linked subagent subtasks this removal moved to the
       * archive rather than destroyed, deduplicated by revision family. Absent
       * when it archived none — the common case. This is the Host's executed
       * count, so the renderer reports it verbatim instead of estimating.
       */
      readonly archivedSubtaskCount?: number;
    }
  | {
      readonly kind: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export const SESSION_RETIREMENT_OPERATION_SPECS = {
  'session.lifecycle.set': defineOperation<
    SessionLifecycleSetInput,
    SessionCatalogItem,
    (typeof LIFECYCLE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: LIFECYCLE_ERRORS,
    decodeInput: decodeSessionLifecycleSetInput,
    decodeOutput: decodeSessionCatalogItem,
    assertOutputForInput: (input, output) => {
      if (output.id !== input.sessionId) {
        throw invalidProtocolFrame('Session lifecycle result belongs to another Session');
      }
      if ('kind' in output) return;
      const archived = input.state === 'archived';
      if (output.isArchived !== archived) {
        throw invalidProtocolFrame('Session lifecycle result does not match the requested state');
      }
    },
  }),
  'session.remove': defineOperation<
    SessionRemoveInput,
    SessionRemoveResult,
    (typeof LIFECYCLE_ERRORS)[number]
  >({
    mode: 'command',
    availability: 'ready',
    errors: LIFECYCLE_ERRORS,
    decodeInput: decodeSessionRemoveInput,
    decodeOutput: decodeSessionRemoveResult,
    assertOutputForInput: (input, output) => {
      if (output.kind === 'removed' && output.sessionId !== input.sessionId) {
        throw invalidProtocolFrame('Session remove result belongs to another Session');
      }
      if (
        output.kind === 'revision_conflict' &&
        output.expectedRevision !== input.expectedRevision
      ) {
        throw invalidProtocolFrame('Session remove conflict changed the expected revision');
      }
    },
  }),
  'session.remove.preview': defineOperation<
    SessionRemovePreviewInput,
    SessionRemovePreviewResult,
    (typeof LIFECYCLE_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: LIFECYCLE_ERRORS,
    decodeInput: decodeSessionRemovePreviewInput,
    decodeOutput: decodeSessionRemovePreviewResult,
  }),
} as const;

export function decodeSessionLifecycleSetInput(value: unknown): SessionLifecycleSetInput {
  const input = requireExactRecord(value, 'Session lifecycle input', ['sessionId', 'state']);
  if (input.state !== 'active' && input.state !== 'archived') {
    throw invalidProtocolFrame('Invalid Session lifecycle state');
  }
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    state: input.state,
  };
}

export function decodeSessionRemoveInput(value: unknown): SessionRemoveInput {
  const input = requireExactRecord(value, 'Session remove input', [
    'sessionId',
    'expectedRevision',
  ]);
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    expectedRevision: positiveRevision(input.expectedRevision),
  };
}

export function decodeSessionRemovePreviewInput(value: unknown): SessionRemovePreviewInput {
  const input = requireExactRecord(value, 'Session remove preview input', ['sessionIds']);
  if (
    !Array.isArray(input.sessionIds) ||
    input.sessionIds.length === 0 ||
    input.sessionIds.length > SESSION_REMOVE_PREVIEW_MAX_ITEMS
  ) {
    throw invalidProtocolFrame('Invalid Session remove preview sessionIds');
  }
  const sessionIds = input.sessionIds.map((sessionId) => requireEntityId(sessionId, 'sessionId'));
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw invalidProtocolFrame('Duplicate Session remove preview sessionId');
  }
  return { sessionIds };
}

export function decodeSessionRemovePreviewResult(value: unknown): SessionRemovePreviewResult {
  const result = requireExactRecord(value, 'Session remove preview result', [
    'archivableSubtaskCount',
    'removedSubtaskCount',
    'worktreeCount',
    'bytes',
  ]);
  return {
    archivableSubtaskCount: requireCount(result.archivableSubtaskCount, 'archivableSubtaskCount'),
    removedSubtaskCount: requireCount(result.removedSubtaskCount, 'removedSubtaskCount'),
    worktreeCount: requireCount(result.worktreeCount, 'worktreeCount'),
    bytes: requireCount(result.bytes, 'bytes'),
  };
}

export function decodeSessionRemoveResult(value: unknown): SessionRemoveResult {
  const result = requireRecord(value, 'Session remove result');
  if (result.kind === 'removed') {
    const exact = requireShapedRecord(
      result,
      'Removed Session result',
      ['kind', 'sessionId'],
      ['archivedSubtaskCount'],
    );
    return {
      kind: 'removed',
      sessionId: requireEntityId(exact.sessionId, 'sessionId'),
      ...(exact.archivedSubtaskCount === undefined
        ? {}
        : {
            archivedSubtaskCount: requireCount(exact.archivedSubtaskCount, 'archivedSubtaskCount'),
          }),
    };
  }
  if (result.kind !== 'revision_conflict') {
    throw invalidProtocolFrame('Invalid Session remove result kind');
  }
  const exact = requireExactRecord(result, 'Session remove revision conflict', [
    'kind',
    'expectedRevision',
    'actualRevision',
  ]);
  return {
    kind: 'revision_conflict',
    expectedRevision: positiveRevision(exact.expectedRevision),
    actualRevision: positiveRevision(exact.actualRevision),
  };
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidProtocolFrame('Session revision must be a positive safe integer');
  }
  return value as number;
}
