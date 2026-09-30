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
  /**
   * Remove only a Session archived more than this many milliseconds ago by
   * the Host's clock; otherwise it is kept and answers `too_recent`. A
   * Session whose archive time is unknown is kept too.
   */
  readonly requireArchivedForMs?: number;
}

/**
 * Sessions one `session.remove.preview` accepts. Each target expands to its
 * whole removal plan, which the Host reads and may size, so a request stays
 * as small as a per-task storage page (also 25) and a Client pages a longer
 * selection one request at a time.
 */
export const SESSION_REMOVE_PREVIEW_MAX_ITEMS = 25;

export interface SessionRemovePreviewInput {
  /** Each Session is previewed as its own `session.remove` would remove it. */
  readonly sessionIds: readonly string[];
  /** Size the removed Sessions too. Off by default: it costs range scans. */
  readonly measureBytes?: boolean;
  /** Skip targets that are not archived, as a `requireArchived` delete would. */
  readonly requireArchived?: boolean;
}

/**
 * What removing the Sessions of one request, one `session.remove` each, would
 * do, read from the same removal plans those commands execute. A Session that
 * is already gone, that cannot be removed on its own, or that a
 * `requireArchived` preview skips contributes nothing.
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
   * once per referencing Session although the blobs are shared. Absent unless
   * `measureBytes` asked for it and the measurement succeeded.
   */
  readonly bytes?: number;
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
    }
  /** Kept: `requireArchivedForMs` was not met by the Host's clock. */
  | { readonly kind: 'too_recent'; readonly sessionId: string };

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
      if (output.kind !== 'revision_conflict' && output.sessionId !== input.sessionId) {
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
  const input = requireShapedRecord(
    value,
    'Session remove input',
    ['sessionId', 'expectedRevision'],
    ['requireArchivedForMs'],
  );
  const { requireArchivedForMs } = input;
  if (
    requireArchivedForMs !== undefined &&
    (!Number.isSafeInteger(requireArchivedForMs) || (requireArchivedForMs as number) < 1)
  ) {
    throw invalidProtocolFrame('requireArchivedForMs must be a positive safe integer');
  }
  return {
    sessionId: requireEntityId(input.sessionId, 'sessionId'),
    expectedRevision: positiveRevision(input.expectedRevision),
    ...(requireArchivedForMs === undefined
      ? {}
      : { requireArchivedForMs: requireArchivedForMs as number }),
  };
}

export function decodeSessionRemovePreviewInput(value: unknown): SessionRemovePreviewInput {
  const input = requireShapedRecord(
    value,
    'Session remove preview input',
    ['sessionIds'],
    ['measureBytes', 'requireArchived'],
  );
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
  const flags: { measureBytes?: boolean; requireArchived?: boolean } = {};
  for (const flag of ['measureBytes', 'requireArchived'] as const) {
    const flagValue = input[flag];
    if (flagValue === undefined) continue;
    if (typeof flagValue !== 'boolean') {
      throw invalidProtocolFrame(`Invalid Session remove preview ${flag}`);
    }
    flags[flag] = flagValue;
  }
  return { sessionIds, ...flags };
}

export function decodeSessionRemovePreviewResult(value: unknown): SessionRemovePreviewResult {
  const result = requireShapedRecord(
    value,
    'Session remove preview result',
    ['archivableSubtaskCount', 'removedSubtaskCount', 'worktreeCount'],
    ['bytes'],
  );
  return {
    archivableSubtaskCount: requireCount(result.archivableSubtaskCount, 'archivableSubtaskCount'),
    removedSubtaskCount: requireCount(result.removedSubtaskCount, 'removedSubtaskCount'),
    worktreeCount: requireCount(result.worktreeCount, 'worktreeCount'),
    ...(result.bytes === undefined ? {} : { bytes: requireCount(result.bytes, 'bytes') }),
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
  if (result.kind === 'too_recent') {
    const exact = requireExactRecord(result, 'Too-recent Session result', ['kind', 'sessionId']);
    return { kind: 'too_recent', sessionId: requireEntityId(exact.sessionId, 'sessionId') };
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
