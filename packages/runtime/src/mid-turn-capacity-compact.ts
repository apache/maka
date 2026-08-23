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

import type { RuntimeEvent } from '@maka/core/runtime-event';
import { estimateRuntimeEventsTokens } from './context-budget-helpers.js';
import {
  HistoryCompactSummarizerError,
  type HistoryCompactSummarizerFailureReason,
} from './history-compact-error.js';
import { findCheckpointSummaryDefect } from './history-compact-summary-validation.js';
import {
  buildHistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
  type HistoryCompactMemoryExtractionBoundary,
  type HistoryCompactProviderState,
} from './history-compact-checkpoint.js';

/**
 * Mid-turn capacity compaction: the pure measurement + safe-boundary engine.
 *
 * The runtime owns one active-turn context invariant — a long single turn must
 * compact a safe completed prefix before the next provider request crosses the
 * selected model's context window. This module is turn-agnostic and side-effect
 * free, and it only SHAPES: it selects the largest safe covered prefix and
 * builds the checkpoint + replacement projection, failing open when it cannot.
 * The safety-critical pass/terminate verdict is NOT issued here — the backend's
 * final-request estimate owner measures the actual outgoing (messages, tools)
 * payload after every shaping hook has run and decides `context_budget_exhausted`
 * there, so the verdict is always about the request that really goes out.
 */

export interface EstimateNextRequestTokensInput {
  /**
   * The last request's real INPUT tokens as reported by the provider — never
   * input+output, because `appendedChars` is a delta against that request's
   * payload and already carries the step's freshly generated output.
   * Undefined on cold start or when the sample is unusable (no positive
   * input count), which falls back to a whole-payload char estimate.
   */
  priorUsageTokens?: number;
  /**
   * SIGNED char delta of the next request's payload versus the last measured
   * request payload. Negative after compaction/pruning shrank the projection —
   * the estimate must credit the shrink, or a compacted request would still be
   * judged by the pre-compaction usage sample.
   */
  appendedChars: number;
  /** Estimate conversion; defaults to 4 chars/token. */
  charsPerToken?: number;
  /** Whole-payload chars, used only when `priorUsageTokens` is undefined. */
  coldStartChars?: number;
}

/**
 * Estimate the token size of the next provider request. Anchors on the last
 * step's real usage plus a signed char/4 payload delta for content the provider
 * has not yet counted (or no longer carries); cold-start (no usage) is a pure
 * char/4 estimate of the whole payload. This mirrors how surveyed peers avoid
 * pure character guessing.
 */
export function estimateNextRequestTokens(input: EstimateNextRequestTokensInput): number {
  const charsPerToken = Math.max(1, input.charsPerToken ?? 4);
  if (input.priorUsageTokens !== undefined && Number.isFinite(input.priorUsageTokens)) {
    return Math.max(
      0,
      Math.max(0, Math.floor(input.priorUsageTokens)) +
        estimateSignedChars(input.appendedChars, charsPerToken),
    );
  }
  return Math.max(
    0,
    estimateSignedChars(input.coldStartChars ?? input.appendedChars, charsPerToken),
  );
}

/** Proactive threshold: the next request would cross `contextWindow - reserve`. */
export function exceedsHighWater(
  estimatedTokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  const highWater = Math.max(1, contextWindow - Math.max(0, reserveTokens));
  return estimatedTokens > highWater;
}

/** Hard cap: the estimate exceeds the raw context window even before the reserve. */
export function exceedsContextWindow(estimatedTokens: number, contextWindow: number): boolean {
  return estimatedTokens > contextWindow;
}

export interface MidTurnBoundaryOptions {
  /** Keep at least this many trailing events uncovered as the verbatim tail. */
  reserveTailEvents?: number;
  /**
   * Events that must stay in the verbatim tail: the boundary retreats to
   * strictly before the first pinned event, exactly like a partial. Used for
   * the current turn's steering messages — the injection accumulator re-appends
   * a folded directive anyway, so covering one only desynchronizes the
   * capacity measurement from the request that actually goes out.
   */
  isPinned?: (event: RuntimeEvent) => boolean;
}

export type MidTurnBoundary =
  | { ok: true; coveredCount: number }
  | { ok: false; reason: 'no_safe_completed_span' };

/**
 * Select the largest contiguous covered prefix that is safe to fold:
 *
 *  - it ends on an immutable, non-partial event (a partial streaming snapshot is
 *    later replaced/deleted, so a digest over it can never replay);
 *  - it never straddles a tool call/result pair (a provider protocol unit);
 *  - it leaves at least `reserveTailEvents` trailing events as the verbatim tail.
 *
 * Returns `no_safe_completed_span` when no such cut exists (e.g. the remaining
 * pool is a single atomic call/result pair), which the caller surfaces as an
 * explicit `context_budget_exhausted` outcome rather than a provider error.
 */
export function selectMidTurnSafeBoundary(
  events: readonly RuntimeEvent[],
  options: MidTurnBoundaryOptions = {},
): MidTurnBoundary {
  const reserveTail = Math.max(0, Math.floor(options.reserveTailEvents ?? 0));
  // A partial anywhere in the covered prefix (not just at the cut) poisons the
  // digest — its snapshot is later replaced or deleted — so the boundary
  // retreats to strictly before the first partial in the pool. A pinned event
  // (see MidTurnBoundaryOptions.isPinned) bounds the cut the same way.
  const firstPartialIndex = events.findIndex((event) => event.partial === true);
  const firstPinnedIndex = options.isPinned
    ? events.findIndex((event) => options.isPinned!(event))
    : -1;
  const maxCut = Math.min(
    events.length - reserveTail,
    firstPartialIndex === -1 ? events.length : firstPartialIndex,
    firstPinnedIndex === -1 ? events.length : firstPinnedIndex,
  );
  const pairSpans = toolPairSpans(events);
  for (let cut = maxCut; cut >= 1; cut -= 1) {
    if (straddlesToolPair(pairSpans, cut)) continue;
    return { ok: true, coveredCount: cut };
  }
  return { ok: false, reason: 'no_safe_completed_span' };
}

interface ToolPairSpan {
  callIndex?: number;
  responseIndex?: number;
}

function toolPairSpans(events: readonly RuntimeEvent[]): ToolPairSpan[] {
  const byCallId = new Map<string, ToolPairSpan>();
  events.forEach((event, index) => {
    const content = event.content;
    if (content?.kind === 'function_call') {
      const span = byCallId.get(content.id) ?? {};
      span.callIndex = index;
      byCallId.set(content.id, span);
    } else if (content?.kind === 'function_response') {
      const span = byCallId.get(content.id) ?? {};
      span.responseIndex = index;
      byCallId.set(content.id, span);
    }
  });
  return [...byCallId.values()];
}

/**
 * A cut at exclusive index `cut` straddles a pair if exactly one side is
 * covered. A call whose response is not in the pool yet is an OPEN span:
 * covering it would orphan the response that arrives later (a result with no
 * call in the projection), so any cut past the call is unsafe. A response
 * without a call is inert — its call lives before the pool, so no cut inside
 * the pool can split that pair.
 */
function straddlesToolPair(spans: readonly ToolPairSpan[], cut: number): boolean {
  for (const span of spans) {
    if (span.callIndex !== undefined && span.responseIndex === undefined) {
      if (span.callIndex < cut) return true;
      continue;
    }
    if (span.callIndex === undefined || span.responseIndex === undefined) continue;
    const callCovered = span.callIndex < cut;
    const responseCovered = span.responseIndex < cut;
    if (callCovered !== responseCovered) return true;
  }
  return false;
}

function estimateSignedChars(chars: number | undefined, charsPerToken: number): number {
  const value = Math.trunc(chars ?? 0);
  if (!Number.isFinite(value) || value === 0) return 0;
  const magnitude = Math.ceil(Math.abs(value) / charsPerToken);
  return value > 0 ? magnitude : -magnitude;
}

// ============================================================================
// Orchestration: engine + checkpoint protocol + injected summarizer → decision
// ============================================================================

export type MidTurnSummarizer = (input: {
  coveredRuntimeEvents: readonly RuntimeEvent[];
  newlyFoldedRuntimeEvents: readonly RuntimeEvent[];
  previousCheckpoint?: HistoryCompactCheckpoint;
}) =>
  | Promise<string | HistoryCompactProviderState | undefined>
  | string
  | HistoryCompactProviderState
  | undefined;

export interface PlanMidTurnCapacityCompactionInput {
  sessionId: string;
  /** Step-0 overflow folds only prior history; later steps also fold the head anchor. */
  phase?: 'pre_turn' | 'mid_turn';
  /**
   * Full ordered content-event projection for the compaction pool:
   * `[...prior turns, head anchor, ...current-turn completed steps]`.
   */
  orderedEvents: readonly RuntimeEvent[];
  /** The current turn's user message; must be one of `orderedEvents`. */
  headAnchor: { runtimeEventId: string; turnId: string };
  /** Estimated size of the next provider request (see estimateNextRequestTokens). */
  estimatedNextRequestTokens: number;
  contextWindow: number;
  reserveTokens: number;
  reserveTailEvents?: number;
  charsPerToken?: number;
  now?: number;
  highWaterName?: string;
  highWaterSeq?: number;
  previousCheckpoint?: HistoryCompactCheckpoint;
  /** Present only when this automatic Compaction should create a Memory task. */
  memoryExtractionBoundary?: HistoryCompactMemoryExtractionBoundary;
  summarize: MidTurnSummarizer;
}

export type PlanMidTurnCapacityCompactionResult =
  | { decision: 'skip'; reason: 'below_high_water' }
  | {
      decision: 'fail_open';
      reason: MidTurnFailReason;
      diagnosticReason?: HistoryCompactSummarizerFailureReason;
    }
  | {
      decision: 'compacted';
      checkpoint: HistoryCompactCheckpoint;
      /** Deterministic checkpoint-block plus verbatim successor projection. */
      replacementEvents: RuntimeEvent[];
      coveredRuntimeEvents: RuntimeEvent[];
      tailRuntimeEvents: RuntimeEvent[];
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    };

export type MidTurnFailReason = 'no_safe_completed_span' | 'summarizer_failed';

/**
 * Decide, deterministically, how a long active turn compacts before the next
 * provider request. This plan is a pure shaper: when it cannot fold a safe
 * completed prefix it FAILS OPEN (keep the raw projection + diagnostic) and
 * never terminates the turn itself. The two failure tiers — fail open under
 * the window, explicit `context_budget_exhausted` over it — are applied by the
 * backend's final-request estimate owner, which re-measures the actual outgoing
 * payload after all shaping (including this fold) has been applied.
 */
export async function planMidTurnCapacityCompaction(
  input: PlanMidTurnCapacityCompactionInput,
): Promise<PlanMidTurnCapacityCompactionResult> {
  const phase = input.phase ?? 'mid_turn';
  const charsPerToken = Math.max(1, input.charsPerToken ?? 4);
  const highWater = Math.max(1, input.contextWindow - Math.max(0, input.reserveTokens));
  if (input.estimatedNextRequestTokens <= highWater) {
    return { decision: 'skip', reason: 'below_high_water' };
  }

  // The current turn's steering messages are pinned out of the foldable span:
  // the backend's injection accumulator re-appends a live directive to every
  // request of this send, so folding one never shrinks the outgoing payload —
  // it only hides the directive from the final capacity measurement.
  const boundary = selectMidTurnSafeBoundary(input.orderedEvents, {
    reserveTailEvents: input.reserveTailEvents ?? 1,
    isPinned: (event) =>
      (phase === 'pre_turn' && event.id === input.headAnchor.runtimeEventId) ||
      (event.turnId === input.headAnchor.turnId &&
        event.content?.kind === 'text' &&
        event.content.steering === true),
  });
  const headAnchorIndex = input.orderedEvents.findIndex(
    (event) => event.id === input.headAnchor.runtimeEventId,
  );
  // Mid-turn coverage includes the head anchor and at least one other event;
  // the anchor is re-rendered verbatim, so folding only it saves nothing.
  // Step-0 recovery is a pre-turn fold: the anchor is pinned in the successor
  // tail and at least one prior event must be covered.
  const hasSafeCoverage =
    phase === 'mid_turn'
      ? boundary.ok && boundary.coveredCount > headAnchorIndex && boundary.coveredCount >= 2
      : boundary.ok && boundary.coveredCount > 0 && boundary.coveredCount <= headAnchorIndex;
  if (headAnchorIndex < 0 || !hasSafeCoverage) {
    return { decision: 'fail_open', reason: 'no_safe_completed_span' };
  }

  // Narrowing above proves the boundary is safe.
  if (!boundary.ok) {
    return { decision: 'fail_open', reason: 'no_safe_completed_span' };
  }
  const coveredRuntimeEvents = input.orderedEvents.slice(0, boundary.coveredCount);
  const tailRuntimeEvents = input.orderedEvents.slice(boundary.coveredCount);

  // Roll forward from a previous checkpoint when it is an exact prefix of the
  // covered events, so the summary only re-reads the newly folded span.
  const checkpointMatch = input.previousCheckpoint
    ? matchHistoryCompactCheckpointPrefix(input.previousCheckpoint, coveredRuntimeEvents)
    : undefined;
  const previousCheckpoint =
    checkpointMatch && !checkpointMatch.reason ? input.previousCheckpoint : undefined;
  const newlyFoldedRuntimeEvents = previousCheckpoint
    ? checkpointMatch!.successorRuntimeEvents
    : coveredRuntimeEvents;

  let compacted: string | HistoryCompactProviderState | undefined;
  try {
    compacted = await Promise.resolve(
      input.summarize({
        coveredRuntimeEvents,
        newlyFoldedRuntimeEvents,
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
      }),
    );
    if (typeof compacted === 'string') compacted = compacted.trim();
  } catch (error) {
    if (error instanceof HistoryCompactSummarizerError) {
      return {
        decision: 'fail_open',
        reason: 'summarizer_failed',
        diagnosticReason: error.reason,
      };
    }
    compacted = undefined;
  }
  if (!compacted) {
    return { decision: 'fail_open', reason: 'summarizer_failed' };
  }
  // The write gate enforces the invariant regardless of which summarizer
  // produced the text (#3029): a malformed summary must not replace folded
  // history. The default summarizer already threw with the same reasons; any
  // other producer is validated here.
  if (typeof compacted === 'string') {
    const defect = findCheckpointSummaryDefect(compacted, { coveredRuntimeEvents, charsPerToken });
    if (defect) {
      return { decision: 'fail_open', reason: 'summarizer_failed', diagnosticReason: defect };
    }
  }

  const checkpoint = buildHistoryCompactCheckpoint({
    sessionId: input.sessionId,
    coveredRuntimeEvents,
    ...(typeof compacted === 'string' ? { summary: compacted } : { providerState: compacted }),
    ...(phase === 'mid_turn' ? { phase: 'mid_turn' as const, headAnchor: input.headAnchor } : {}),
    ...(input.memoryExtractionBoundary
      ? { memoryExtractionBoundary: input.memoryExtractionBoundary }
      : {}),
    ...(input.highWaterName !== undefined ? { highWaterName: input.highWaterName } : {}),
    ...(input.highWaterSeq !== undefined ? { highWaterSeq: input.highWaterSeq } : {}),
    ...(previousCheckpoint ? { previousCheckpointId: previousCheckpoint.checkpointId } : {}),
    charsPerToken,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const replacementEvents = projectHistoryCompactCheckpointReplay(
    checkpoint,
    coveredRuntimeEvents,
    tailRuntimeEvents,
  );
  const estimatedTokensBefore = estimateRuntimeEventsTokens(coveredRuntimeEvents, charsPerToken);
  const estimatedTokensAfter =
    checkpoint.version === 3
      ? checkpoint.estimatedTokens
      : estimateRuntimeEventsTokens(
          [historyCompactCheckpointToRuntimeEvent(checkpoint)],
          charsPerToken,
        );

  // No post-fold verdict here: any re-estimate over the raw ledger span is
  // wrong once the previous request was itself a compacted projection (the
  // raw covered span was never in that request, so subtracting it
  // over-credits the fold). The backend applies the shape only when the
  // materialized replacement payload actually shrinks the request, and its
  // final-request estimate owner measures the outgoing payload for the
  // window verdict.
  return {
    decision: 'compacted',
    checkpoint,
    replacementEvents,
    coveredRuntimeEvents,
    tailRuntimeEvents,
    estimatedTokensBefore,
    estimatedTokensAfter,
  };
}
