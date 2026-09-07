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
  supersedesLatestContext,
  type AgentRunEvent,
  type AgentRunStore,
} from '@maka/core/agent-run';
import {
  decodeModelCallAttempt,
  type ModelCallAttempt,
  type PromptComposition,
  type PromptCompositionSegment,
  type PromptCompositionSegmentKind,
  type PromptCompositionTool,
} from '@maka/core/model-call-attempt';
import {
  foldPromptComposition,
  PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE,
  readPromptCompositionEvent,
} from './prompt-composition.js';
import {
  LATEST_CONTEXT_PROJECTION_TYPE,
  LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  readLatestContextSnapshot,
  type LatestContextSnapshot,
} from './latest-context-snapshot.js';
import {
  validateHistoryCompactCheckpointShape,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

export type ContextDiagnosticsUnavailableReason = 'no_completed_request' | 'trace_unavailable';

export interface ContextDiagnosticsCompaction {
  kind: 'history';
  phase: 'pre_turn' | 'mid_turn';
  eventCount: number;
  turnCount: number;
  estimatedTokens: number;
}

export type ContextDiagnostics =
  | {
      status: 'unavailable';
      reason: ContextDiagnosticsUnavailableReason;
    }
  | {
      status: 'available';
      providerId: string;
      modelId: string;
      completedAt: number;
      inputTokens?: number;
      contextWindow?: number;
      /**
       * What the latest request was made of, or absent when its canonical
       * attempt has no prepared-request observation.
       *
       * Absence is a state a reader must be able to see. Reporting the
       * composition of an *older* request under a current heading would be the
       * quiet lie this separation exists to prevent, so readers never join an
       * independent capture stream (#2323).
       */
      composition?: PromptComposition;
      compaction?: ContextDiagnosticsCompaction;
    };

type ContextRunStore = Pick<
  AgentRunStore,
  'readEvents' | 'readEventProjection' | 'readEventLedgerRevision' | 'repairEventProjection'
>;

/**
 * What the session's context is made of right now (#1580, reshaped for #2323).
 *
 * One sealed row answers this. The `latest_context` projection is written by
 * the same storage transaction that commits a completed MAIN call's canonical
 * attempt, freezing that request's identity, its provider-reported numbers,
 * the folded composition of its own observation, and the compaction boundary its
 * prompt was built under — all at one moment, so no two fields here can
 * describe different requests. It is a projection, not an event: nothing
 * appends a record under that name.
 *
 * That sealing is the whole design. The request facts live on one canonical
 * attempt; the compaction boundary remains recovery-owned. Reading "the newest
 * of each kind" and joining independent histories would recreate the retired
 * second authority and let the snapshot's parts drift apart.
 *
 * Warm reads are O(1) — one projection row. The ledger scan below is the cold
 * path, for a session written before this record existed.
 */
export async function readLatestContextDiagnostics(
  runStore: ContextRunStore,
  sessionId: string,
  /** The session-inline runs to scan on the cold path, from the event spine. */
  runIds: readonly string[],
): Promise<ContextDiagnostics> {
  try {
    let replaceProjectionId: string | undefined;
    if (runStore.readEventProjection) {
      // Three states, three answers. `undefined` is an uninitialized
      // projection — nothing has been decided about this session, so the
      // ledger must be scanned. `null` is a decided answer: a previous read
      // scanned this ledger and found nothing to report, and honouring it is
      // what keeps that scan from repeating on every panel refresh. A row
      // present but unreadable — damaged, or written by a build whose shape
      // this one cannot anchor on — is not an answer, and falls back to the
      // ledger that can still produce one.
      const projected = await runStore
        .readEventProjection(sessionId, LATEST_CONTEXT_PROJECTION_TYPE)
        .catch(() => undefined);
      if (projected === null) return { status: 'unavailable', reason: 'no_completed_request' };
      const snapshot = readLatestContextSnapshot(projected ?? undefined);
      if (snapshot) return availableFrom(snapshot);
      if (projected) replaceProjectionId = projected.id;
    }
    const ledgerRevision =
      runStore.readEventLedgerRevision && runStore.repairEventProjection
        ? await runStore.readEventLedgerRevision(sessionId)
        : undefined;
    return await rebuildContextFromLedger(
      runStore,
      sessionId,
      runIds,
      replaceProjectionId,
      ledgerRevision,
    );
  } catch {
    return { status: 'unavailable', reason: 'trace_unavailable' };
  }
}

/**
 * The cold path, and the compatibility path.
 *
 * A ledger written before sealed snapshots existed can still be reconstructed
 * from its canonical attempts (or, for legacy sessions only, provider events),
 * so the reader assembles one — but only here, only
 * once, and only when no sealed record is present at all. Nothing is repaired
 * into another owner's projection: the compaction boundary is read from the
 * events of this session's own runs, never from recovery's derived row.
 */
async function rebuildContextFromLedger(
  runStore: ContextRunStore,
  sessionId: string,
  runIds: readonly string[],
  replaceProjectionId?: string,
  ledgerRevision?: string,
): Promise<ContextDiagnostics> {
  let anchor: MeteringAnchor | undefined;
  // Only consulted when the scan finds no canonical attempt at all: a session
  // written before canonical metering existed has provider attempts and
  // nothing else, and returning "no completed request" for it would lose an
  // answer the ledger still holds (#2323).
  let legacy: LegacyProviderAnchor | undefined;
  // Whether this ledger is canonical-era AT ALL — tracked apart from `anchor`,
  // which only ever holds a completed main call. A session whose canonical
  // records are all failed, aborted, a compaction's own request, or written in
  // a shape this build cannot decode still HAS canonical metering; letting the
  // legacy provider rows answer for it would resurrect the very request the
  // canonical rule declined to report.
  let sawCanonicalRecord = false;
  // Historical provider rows never select a canonical-era request. They may
  // only restore composition for the exact physical attempt selected above
  // when that transitional canonical record predates request observations.
  const historicalAttempts: LegacyProviderAnchor[] = [];
  const checkpoints: CheckpointCandidate[] = [];

  for (const runId of runIds) {
    for (const event of await runStore.readEvents(sessionId, runId)) {
      if (event.type === METERING_EVENT_TYPE) {
        sawCanonicalRecord = true;
        const candidate = meteringAnchor(event);
        if (candidate && supersedesLatestContext(candidate, anchor)) anchor = candidate;
        continue;
      }
      if (event.type === PROVIDER_REQUEST_ATTEMPT_EVENT_TYPE) {
        const candidate = legacyProviderAnchor(event);
        if (candidate) {
          historicalAttempts.push(candidate);
          if (supersedesLatestContext(candidate, legacy)) legacy = candidate;
        }
        continue;
      }
      if (event.type !== CHECKPOINT_EVENT_TYPE) continue;
      const shape = event.data?.checkpoint;
      if (validateHistoryCompactCheckpointShape(shape, sessionId)) {
        checkpoints.push({ eventId: event.id, ts: event.ts, checkpoint: shape });
      }
    }
  }

  // The compatibility fallback is exactly that: it applies only when the scan
  // found no canonical record anywhere, so it can never become a second
  // authority for data written since canonical metering shipped.
  const resolved = anchor ?? (sawCanonicalRecord ? undefined : legacy);
  if (!resolved) {
    await repairLatestContext(runStore, sessionId, null, replaceProjectionId, ledgerRevision);
    return { status: 'unavailable', reason: 'no_completed_request' };
  }
  const boundary = latestCheckpointBefore(checkpoints, resolved);
  // Selection stays canonical. This is a one-field compatibility join, not a
  // fallback for provider/model/status/timing/usage or for a different attempt.
  const composition =
    resolved.composition ??
    (anchor && !anchor.composition
      ? exactHistoricalComposition(anchor, historicalAttempts)
      : undefined);
  const snapshot: LatestContextSnapshot = {
    schemaVersion: LATEST_CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    attemptId: resolved.attemptId,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    completedAt: resolved.completedAt,
    ...(resolved.inputTokens !== undefined ? { inputTokens: resolved.inputTokens } : {}),
    ...(resolved.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: resolved.cacheReadInputTokens }
      : {}),
    ...(resolved.contextWindow !== undefined ? { contextWindow: resolved.contextWindow } : {}),
    ...(composition ? { composition } : {}),
    ...(boundary ? { compaction: contextDiagnosticsCompactionOf(boundary.checkpoint) } : {}),
  };
  // Repair on the way out, so this scan happens once per session rather than
  // on every panel refresh. Best-effort: the caller already has its answer,
  // and a later cold read can retry the derived write.
  await repairLatestContext(runStore, sessionId, snapshot, replaceProjectionId, ledgerRevision);
  return availableFrom(snapshot);
}

/**
 * Rewrites the derived row the canonical append normally maintains.
 *
 * `null` is written deliberately for a session with nothing to report: an
 * initialized-empty projection is an answer, and it is what stops the next
 * read from scanning the whole ledger to learn the same nothing.
 */
async function repairLatestContext(
  runStore: ContextRunStore,
  sessionId: string,
  snapshot: LatestContextSnapshot | null,
  replaceProjectionId?: string,
  ledgerRevision?: string,
): Promise<void> {
  const repair = runStore.repairEventProjection;
  if (!repair || ledgerRevision === undefined) return;
  await repair
    .call(
      runStore,
      sessionId,
      LATEST_CONTEXT_PROJECTION_TYPE,
      snapshot
        ? ({
            type: LATEST_CONTEXT_PROJECTION_TYPE,
            id: `latest-context-${snapshot.attemptId}`,
            runId: '',
            sessionId,
            turnId: '',
            ts: snapshot.completedAt,
            data: snapshot as unknown as Record<string, unknown>,
          } as AgentRunEvent)
        : null,
      {
        ifLedgerRevision: ledgerRevision,
        ...(replaceProjectionId ? { replaceEventId: replaceProjectionId } : {}),
      },
    )
    .catch(() => {});
}

/**
 * A completed provider attempt, for ledgers that predate canonical metering.
 *
 * Deliberately narrower than the canonical anchor: it exists to keep old
 * sessions readable, not to describe anything written since.
 */
function legacyProviderAnchor(event: AgentRunEvent): MeteringAnchor | undefined {
  const data = event.data;
  if (!data || data.status !== 'completed') return undefined;
  const { attemptId, traceId, providerId, modelId, completedAt, startedAt } = data;
  if (
    typeof attemptId !== 'string' ||
    typeof traceId !== 'string' ||
    typeof providerId !== 'string' ||
    typeof modelId !== 'string' ||
    typeof completedAt !== 'number'
  ) {
    return undefined;
  }
  const composition = readPromptCompositionEvent(event)?.composition;
  return {
    attemptId,
    traceId,
    providerId,
    modelId,
    startedAt: typeof startedAt === 'number' ? startedAt : completedAt,
    completedAt,
    ...(typeof data.inputTokens === 'number' ? { inputTokens: data.inputTokens } : {}),
    ...(typeof data.contextWindow === 'number' ? { contextWindow: data.contextWindow } : {}),
    ...(composition ? { composition } : {}),
  };
}

type LegacyProviderAnchor = MeteringAnchor;

function availableFrom(snapshot: LatestContextSnapshot): ContextDiagnostics {
  return {
    status: 'available',
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    completedAt: snapshot.completedAt,
    ...(snapshot.inputTokens !== undefined ? { inputTokens: snapshot.inputTokens } : {}),
    ...(snapshot.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: snapshot.cacheReadInputTokens }
      : {}),
    ...(snapshot.contextWindow !== undefined ? { contextWindow: snapshot.contextWindow } : {}),
    ...(snapshot.composition ? { composition: snapshot.composition } : {}),
    ...(snapshot.compaction ? { compaction: snapshot.compaction } : {}),
  };
}

const METERING_EVENT_TYPE = 'model_call_attempt_recorded';
const CHECKPOINT_EVENT_TYPE = 'history_compact_checkpoint_recorded';

interface MeteringAnchor {
  attemptId: string;
  traceId: string;
  providerId: string;
  modelId: string;
  startedAt: number;
  completedAt: number;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow?: number;
  composition?: PromptComposition;
}

interface CheckpointCandidate {
  eventId: string;
  ts: number;
  checkpoint: HistoryCompactCheckpoint;
}

/** Only a completed MAIN call describes the conversation's own context. */
function meteringAnchor(event: AgentRunEvent): MeteringAnchor | undefined {
  let attempt: ModelCallAttempt;
  try {
    attempt = decodeModelCallAttempt(event.data);
  } catch {
    return undefined;
  }
  if (attempt.callKind !== 'main' || attempt.status !== 'completed') return undefined;
  // Attempts recorded before the fold moved onto the record still carry their
  // parts, and folding them here is the only way to say what those requests
  // were made of. Current attempts arrive already folded.
  const composition =
    attempt.promptComposition ??
    (attempt.requestObservation
      ? foldPromptComposition(attempt.requestObservation.segments)
      : undefined);
  return {
    attemptId: attempt.attemptId,
    traceId: attempt.traceId,
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
    ...(attempt.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: attempt.cacheReadInputTokens }
      : {}),
    ...(attempt.contextWindow !== undefined ? { contextWindow: attempt.contextWindow } : {}),
    ...(composition ? { composition } : {}),
  };
}

function exactHistoricalComposition(
  anchor: MeteringAnchor,
  candidates: readonly LegacyProviderAnchor[],
): PromptComposition | undefined {
  const matches = candidates.filter(
    (candidate) =>
      candidate.composition !== undefined &&
      candidate.attemptId === anchor.attemptId &&
      candidate.traceId === anchor.traceId &&
      candidate.providerId === anchor.providerId &&
      candidate.modelId === anchor.modelId &&
      candidate.startedAt === anchor.startedAt &&
      candidate.completedAt === anchor.completedAt,
  );
  return matches.length === 1 ? matches[0]!.composition : undefined;
}

function latestCheckpointBefore(
  candidates: readonly CheckpointCandidate[],
  anchor: MeteringAnchor,
): CheckpointCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.ts <= anchor.startedAt)
    .reduce<CheckpointCandidate | undefined>((selected, candidate) => {
      if (!selected) return candidate;
      if (candidate.ts !== selected.ts) return candidate.ts > selected.ts ? candidate : selected;
      return candidate.eventId > selected.eventId ? candidate : selected;
    }, undefined);
}

/**
 * The one rule for describing a checkpoint as a compaction boundary.
 *
 * Exported because two paths must describe the same checkpoint identically: the
 * warm path converts the boundary the prompt was built from at dispatch, the
 * cold scan converts the one it finds in the ledger. Two spellings of this would
 * make a rebuilt session disagree with a live one about the same fold (#2323).
 */
export function contextDiagnosticsCompactionOf(
  checkpoint: HistoryCompactCheckpoint,
): ContextDiagnosticsCompaction {
  return {
    kind: 'history',
    phase: checkpoint.phase === 'mid_turn' ? 'mid_turn' : 'pre_turn',
    eventCount: checkpoint.coverage.eventCount,
    turnCount: checkpoint.coverage.turnCount,
    estimatedTokens: checkpoint.estimatedTokens,
  };
}
