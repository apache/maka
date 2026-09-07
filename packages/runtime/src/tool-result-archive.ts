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

import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { createHash } from 'node:crypto';
import {
  buildToolResultArchiveResourceRef,
  TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
} from './tool-result-archive-resource.js';
import type { ActiveToolResultSupersession } from './active-tool-result-working-set.js';

export interface StaleToolResultPrunePolicy {
  enabled: boolean;
  /** Tool result payloads above this estimate are replaced with archive placeholders. Defaults to 2048. */
  maxResultEstimatedTokens?: number;
  /** Keep this many newest turns' tool results full. Defaults to 1. */
  minRecentTurnsFull?: number;
}

/**
 * Why a model-visible Tool Result was replaced by its archive placeholder.
 *
 * One placeholder kind covers both prune paths. They differ only in when the
 * decision is taken — before the next step of the current Turn, or before a
 * prior Turn is compacted — and both now record the same durable transition, so
 * a second placeholder protocol would only be a second way to spell the same
 * fact (#4283).
 */
export type ArchivedToolResultReason =
  | 'stale_tool_result_pruned_before_compact'
  | 'active_current_turn_tool_result_pruned_before_next_step';

export const ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND = 'maka.archived_tool_result';

export const ARCHIVED_TOOL_RESULT_REWRITE_VERSION = 1;

export interface ArchivedToolResultPlaceholder {
  kind: typeof ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  artifactId: string;
  /** First-class, model-readable resource URI. Optional for persisted v1 compatibility. */
  resourceRef?: string;
  /** Explicit recovery action for the provider-visible placeholder. */
  readInstructions?: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  reason: ArchivedToolResultReason;
  /** Why a newer completed step made this provider-visible result redundant. */
  supersession?: ActiveToolResultSupersession;
}

export interface StaleToolResultArchiveCandidate {
  runtimeEventId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  /** The exact projection the transition is allowed to replace. */
  sourceProjection: DurableToolResultProjection;
  serializedResult: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  rewriteVersion: typeof ARCHIVED_TOOL_RESULT_REWRITE_VERSION;
  reason: 'stale_tool_result_pruned_before_compact';
}

export type ToolResultArchiveReadFailureReason =
  | 'not_found'
  | 'deleted'
  | 'too_large'
  | 'not_allowed'
  | 'read_failed'
  | 'source_mismatch'
  | 'session_mismatch'
  | 'size_mismatch'
  | 'corrupt';

export interface ToolResultArchiveReaderInput extends ArchivedToolResultPlaceholder {
  sessionId: string;
  maxBytes?: number;
}

export type ToolResultArchiveReadResult =
  | { ok: true; serializedResult: string }
  | { ok: false; reason: ToolResultArchiveReadFailureReason };

export type ToolResultArchiveReader = (
  input: ToolResultArchiveReaderInput,
) => Promise<ToolResultArchiveReadResult> | ToolResultArchiveReadResult;

export function stableToolResultArchiveArtifactId(event: {
  sessionId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  rewriteVersion: number;
}): string {
  return `tool-result-archive-${createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: event.sessionId,
        runtimeEventId: event.runtimeEventId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        bodySha256: event.bodySha256,
        rewriteVersion: event.rewriteVersion,
      }),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

export function deserializeToolResultArchive(serialized: string): unknown {
  if (serialized === 'undefined') return undefined;
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return serialized;
  }
}

export function serializeToolResultForArchive(result: unknown): string {
  if (result === undefined) return 'undefined';
  try {
    return JSON.stringify(result) ?? 'null';
  } catch {
    return String(result);
  }
}

export function isArchivedToolResultPlaceholder(
  value: unknown,
): value is ArchivedToolResultPlaceholder {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ArchivedToolResultPlaceholder>;
  return (
    candidate.kind === ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND &&
    candidate.rewriteVersion === ARCHIVED_TOOL_RESULT_REWRITE_VERSION &&
    typeof candidate.artifactId === 'string' &&
    candidate.artifactId.length > 0 &&
    typeof candidate.runtimeEventId === 'string' &&
    candidate.runtimeEventId.length > 0 &&
    typeof candidate.toolCallId === 'string' &&
    candidate.toolCallId.length > 0 &&
    typeof candidate.toolName === 'string' &&
    candidate.toolName.length > 0 &&
    typeof candidate.bodySha256 === 'string' &&
    candidate.bodySha256.length > 0 &&
    typeof candidate.originalEstimatedTokens === 'number' &&
    Number.isFinite(candidate.originalEstimatedTokens) &&
    candidate.originalEstimatedTokens > 0 &&
    typeof candidate.originalBytes === 'number' &&
    Number.isFinite(candidate.originalBytes) &&
    candidate.originalBytes > 0 &&
    (candidate.reason === 'stale_tool_result_pruned_before_compact' ||
      candidate.reason === 'active_current_turn_tool_result_pruned_before_next_step') &&
    isValidSupersession(candidate.supersession)
  );
}

function isValidSupersession(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ActiveToolResultSupersession>;
  return (
    (candidate.reason === 'exact_duplicate' ||
      candidate.reason === 'newer_read_covers_range' ||
      candidate.reason === 'newer_snapshot' ||
      candidate.reason === 'failure_resolved') &&
    typeof candidate.supersededByToolCallId === 'string' &&
    candidate.supersededByToolCallId.length > 0 &&
    (candidate.reason === 'failure_resolved'
      ? typeof candidate.failureBodySha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(candidate.failureBodySha256)
      : candidate.failureBodySha256 === undefined)
  );
}

/** Add the canonical ArchiveRead address to persisted v1 placeholders. */
export function withToolResultArchiveResourceRef(value: unknown): unknown {
  if (!isArchivedToolResultPlaceholder(value)) return value;
  return {
    ...value,
    resourceRef: buildToolResultArchiveResourceRef({
      artifactId: value.artifactId,
      bodySha256: value.bodySha256,
      originalBytes: value.originalBytes,
    }),
    readInstructions: TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
  } satisfies ArchivedToolResultPlaceholder;
}

export function buildArchivedToolResultPlaceholder(input: {
  artifactId: string;
  runtimeEventId: string;
  toolCallId: string;
  toolName: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
  reason: ArchivedToolResultReason;
  supersession?: ActiveToolResultSupersession;
}): ArchivedToolResultPlaceholder {
  return {
    kind: ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
    artifactId: input.artifactId,
    resourceRef: buildToolResultArchiveResourceRef({
      artifactId: input.artifactId,
      bodySha256: input.bodySha256,
      originalBytes: input.originalBytes,
    }),
    readInstructions: TOOL_RESULT_ARCHIVE_READ_INSTRUCTIONS,
    runtimeEventId: input.runtimeEventId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    bodySha256: input.bodySha256,
    originalEstimatedTokens: input.originalEstimatedTokens,
    originalBytes: input.originalBytes,
    reason: input.reason,
    ...(input.supersession ? { supersession: input.supersession } : {}),
  };
}
