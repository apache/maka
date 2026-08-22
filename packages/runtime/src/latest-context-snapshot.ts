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
  LATEST_CONTEXT_PROJECTION_TYPE,
  type AgentRunEvent,
  type LatestContextProjectionInput,
} from '@maka/core/agent-run';

export { LATEST_CONTEXT_PROJECTION_TYPE };
import type {
  ContextDiagnosticsCompaction,
  ContextDiagnosticsComposition,
} from './context-diagnostics.js';
import { foldPromptComposition, type SizedRequestSegment } from './prompt-composition.js';

/**
 * One request's context, frozen by the transaction that committed it (#2323).
 *
 * The reason this is a record rather than a read-time join: the facts it holds
 * are written by different appends with different guarantees, and reading "the
 * newest of each kind" separately produces a snapshot whose parts describe
 * different moments. A failed call replaces the newest metering record; a
 * capture that never matched replaces the newest capture; the compaction
 * boundary moves on its own. Each of those is correct in isolation and wrong
 * together.
 *
 * So the facts are copied into one derived row by the same storage transaction
 * that commits the canonical completed-main attempt. There is one durable
 * authority for the request — the attempt — and this is a product of it, not a
 * second record racing it. A failed or aborted attempt, or a compaction's own
 * request, never authorises a write, so the last good answer stands.
 */

export const LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface LatestContextSnapshot {
  schemaVersion: typeof LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  /** The request this describes. Frozen so every field below belongs to it. */
  attemptId: string;
  providerId: string;
  modelId: string;
  completedAt: number;
  /** Provider-reported, as metered. Absent stays absent (#1679). */
  inputTokens?: number;
  cacheReadInputTokens?: number;
  /** The window this call was metered against, frozen at call time. */
  contextWindow?: number;
  /**
   * What the prompt was made of. Absent when the best-effort capture did not
   * describe THIS attempt — a request explains itself or says nothing, never
   * borrows another request's breakdown.
   */
  composition?: ContextDiagnosticsComposition;
  /** The boundary that applied when this request was built, if any. */
  compaction?: ContextDiagnosticsCompaction;
}

/**
 * The derived row for one completed main request, ready to commit alongside
 * the attempt that authorises it.
 *
 * `orderedAt` is the request's own completion, so a row arriving late from an
 * overlapping turn cannot move the answer backwards.
 */
export function latestContextProjectionInput(
  attempt: LatestContextFacts,
  segments: readonly SizedRequestSegment[] | undefined,
  compaction: ContextDiagnosticsCompaction | undefined,
): LatestContextProjectionInput {
  const composition = segments ? foldPromptComposition(segments) : undefined;
  const snapshot: LatestContextSnapshot = {
    schemaVersion: LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    attemptId: attempt.attemptId,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    completedAt: attempt.completedAt,
    ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
    ...(attempt.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: attempt.cacheReadInputTokens }
      : {}),
    ...(attempt.contextWindow !== undefined ? { contextWindow: attempt.contextWindow } : {}),
    ...(composition ? { composition } : {}),
    ...(compaction ? { compaction } : {}),
  };
  return {
    attemptId: attempt.attemptId,
    orderedAt: attempt.completedAt,
    snapshot: snapshot as unknown as Record<string, unknown>,
  };
}

/** The metered facts a snapshot freezes, as the canonical attempt carries them. */
export interface LatestContextFacts {
  attemptId: string;
  providerId: string;
  modelId: string;
  completedAt: number;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow?: number;
}

/**
 * Reads a snapshot back off the ledger.
 *
 * Tolerant in the one direction that matters: a record written by a newer
 * build may carry fields this one does not know, and dropping the whole
 * snapshot for that would lose an answer it could still give. A record missing
 * the identity it is anchored on is a different matter, and is rejected.
 */
export function readLatestContextSnapshot(
  event: Pick<AgentRunEvent, 'type' | 'data'> | undefined,
): LatestContextSnapshot | undefined {
  if (!event) return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (
    typeof record.attemptId !== 'string' ||
    record.attemptId.length === 0 ||
    typeof record.providerId !== 'string' ||
    typeof record.modelId !== 'string' ||
    typeof record.completedAt !== 'number'
  ) {
    return undefined;
  }
  return record as unknown as LatestContextSnapshot;
}
