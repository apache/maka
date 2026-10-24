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

import type { StoredMessage, TurnStatus } from './session.js';

export type CompactionTimelineState = 'running' | 'compacted' | 'failed' | 'interrupted';

export interface CompactionTimelineMarker {
  compactionId: string;
  state: CompactionTimelineState;
  ts: number;
  /** Present only when `state === 'failed'`; cancellation uses `interrupted`. */
  reason?: string;
}

/** A cancelled attempt is a distinct outcome from a compaction that failed. */
export function compactionStateForFailure(reason: string | undefined): 'failed' | 'interrupted' {
  // `aborted` is how the explicit compaction path names a stopped run; both
  // spellings mean the reader cancelled, not that folding failed.
  return reason === 'interrupted' || reason === 'aborted' ? 'interrupted' : 'failed';
}

/** A failed Turn ends a running attempt as failed; any other terminal Turn cuts it off. */
export function compactionStateForTurnStatus(
  status: Exclude<TurnStatus, 'running'>,
): 'failed' | 'interrupted' {
  return status === 'failed' ? 'failed' : 'interrupted';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readCompactionFailureReason(value: unknown): string | undefined {
  const data = recordValue(value);
  return typeof data?.failOpenReason === 'string'
    ? data.failOpenReason
    : typeof data?.reason === 'string'
      ? data.reason
      : undefined;
}

/**
 * Reads one durable marker of an in-Turn compaction lifecycle.
 *
 * A timeline row is an attempt, so it requires an explicit `compactionId`.
 * Rows written before the lifecycle existed have no attempt identity and stay
 * in the transcript as their original notes (`context_compacted` or a visible
 * failure note); they never become timeline attempts. Do not fall back to
 * `turnId` or turn order: one Turn may contain several compaction attempts.
 */
export function readCompactionTimelineMarker(
  message: StoredMessage,
): CompactionTimelineMarker | undefined {
  if (message.type !== 'system_note') return undefined;
  if (
    message.kind !== 'context_compaction_started' &&
    message.kind !== 'context_compaction_applied' &&
    message.kind !== 'context_compaction_failed_open'
  )
    return undefined;
  const data = recordValue(message.data);
  const scope = data?.scope === 'step' ? 'step' : data?.scope === 'turn' ? 'turn' : undefined;
  const compactionId =
    typeof data?.compactionId === 'string' && data.compactionId.length > 0
      ? data.compactionId
      : undefined;
  // A marker without an attempt identity cannot be paired with its terminal
  // event and must not become a timeline row.
  if (compactionId === undefined) return undefined;
  const reason = readCompactionFailureReason(message.data);
  if (message.kind === 'context_compaction_started') {
    if (scope !== 'step') return undefined;
    return { compactionId, state: 'running', ts: message.ts };
  }
  if (message.kind === 'context_compaction_applied') {
    if (scope !== 'step') return undefined;
    return { compactionId, state: 'compacted', ts: message.ts };
  }
  // Legacy failed_open rows were written at settlement; do not move them into
  // the timeline with a misleading position. Only the new step-scoped marker
  // carries an attempt identity and an apply-time position.
  if (scope !== 'step') return undefined;
  const state = compactionStateForFailure(reason);
  return {
    compactionId,
    state,
    ts: message.ts,
    ...(state === 'failed' && reason !== undefined ? { reason } : {}),
  };
}
