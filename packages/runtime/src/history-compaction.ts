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

import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import { finitePositive } from './context-budget-helpers.js';
import { estimateRuntimeEventChars, estimateRuntimeEventsTokens } from './model-history.js';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import {
  HistoryCompactSummarizerError,
  type HistoryCompactSummarizerFailureReason,
} from './history-compact-error.js';
import { findCheckpointSummaryDefect } from './history-compact-summary-validation.js';
import {
  buildHistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  midTurnHeadAnchorEvent,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
  type HistoryCompactMemoryExtractionBoundary,
  type HistoryCompactProviderState,
} from './history-compact-checkpoint.js';

/**
 * Context compaction: the pure measurement + safe-boundary engine.
 *
 * The runtime owns one active-turn context invariant — a long single turn must
 * compact a safe completed prefix before the next provider request crosses the
 * selected model's context window. This module is turn-agnostic and side-effect
 * free, and it only SHAPES: it selects the largest safe covered prefix and
 * builds the checkpoint + replacement projection, failing open when it cannot.
 * Nothing here decides whether a request fits: that answer belongs to the
 * provider, and a rejection is recovered from by compacting and retrying once.
 */

export interface SafePrefixOptions {
  /** Keep at least this many trailing events uncovered as the verbatim tail. */
  reserveTailEvents?: number;
  /** Retry a smaller prefix after the summarizer provider rejects its input. */
  maxCoveredCount?: number;
  /**
   * Events that must stay in the verbatim tail: the boundary retreats to
   * strictly before the first pinned event, exactly like a partial. Used for
   * the current turn's steering messages — the injection accumulator re-appends
   * a folded directive anyway, so covering one only desynchronizes the
   * capacity measurement from the request that actually goes out.
   */
  isPinned?: (event: RuntimeEvent) => boolean;
}

export type SafePrefixBoundary =
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
 * pool is a single atomic call/result pair); the caller then fails open and
 * sends the request unchanged.
 */
export function selectSafeCompactionPrefix(
  events: readonly RuntimeEvent[],
  options: SafePrefixOptions = {},
): SafePrefixBoundary {
  const reserveTail = Math.max(0, Math.floor(options.reserveTailEvents ?? 0));
  // A partial anywhere in the covered prefix (not just at the cut) poisons the
  // digest — its snapshot is later replaced or deleted — so the boundary
  // retreats to strictly before the first partial in the pool. A pinned event
  // (see SafePrefixOptions.isPinned) bounds the cut the same way.
  const firstPartialIndex = events.findIndex((event) => event.partial === true);
  const firstPinnedIndex = options.isPinned
    ? events.findIndex((event) => options.isPinned!(event))
    : -1;
  const maxCut = Math.min(
    events.length - reserveTail,
    Math.max(0, Math.floor(options.maxCoveredCount ?? events.length)),
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

// ============================================================================
// Orchestration: engine + checkpoint protocol + injected summarizer → decision
// ============================================================================

export type HistoryCompactionSummarizer = (input: {
  coveredRuntimeEvents: readonly RuntimeEvent[];
  newlyFoldedRuntimeEvents: readonly RuntimeEvent[];
  previousCheckpoint?: HistoryCompactCheckpoint;
}) =>
  | Promise<string | HistoryCompactProviderState | undefined>
  | string
  | HistoryCompactProviderState
  | undefined;

export interface PlanHistoryCompactionInput {
  sessionId: string;
  /** Standalone/manual folds completed history; active turns preserve their head anchor. */
  phase?: 'standalone' | 'pre_turn' | 'mid_turn';
  /**
   * Full ordered content-event projection for the compaction pool:
   * `[...prior turns, head anchor, ...current-turn completed steps]`.
   */
  orderedEvents: readonly RuntimeEvent[];
  /** The current turn's user message; required for pre_turn and mid_turn. */
  headAnchor?: { runtimeEventId: string; turnId: string };
  reserveTailEvents?: number;
  charsPerToken?: number;
  now?: number;
  highWaterName?: string;
  highWaterSeq?: number;
  previousCheckpoint?: HistoryCompactCheckpoint;
  /**
   * Run headers for the ordered events, and the route this fold is dispatched
   * on. Together they name the newest reply this route produced, which is the
   * only span a retreat may target: a rejection of a larger one says nothing
   * about a span another model accepted.
   */
  runHeaders?: readonly AgentRunHeader[];
  acceptedRoute?: { modelId: string; connectionId?: string };
  /** Present only when this automatic Compaction should create a Memory task. */
  memoryExtractionBoundary?: HistoryCompactMemoryExtractionBoundary;
  summarize: HistoryCompactionSummarizer;
}

export type PlanHistoryCompactionResult =
  | {
      decision: 'fail_open';
      reason: HistoryCompactionFailReason;
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

export type HistoryCompactionFailReason = 'no_safe_completed_span' | 'summarizer_failed';

/**
 * Execute a triggered compaction command by deterministically folding the
 * largest safe prefix. Trigger policy is owned by callers; once this function
 * is called it always attempts the transaction. This plan is a pure shaper:
 * when it cannot fold a safe completed prefix it FAILS OPEN (keep the raw
 * projection + diagnostic) and the request goes out unchanged.
 */
/**
 * How many ordered events the last request THIS ROUTE had accepted covered.
 *
 * A span is only proven for the model and connection that accepted it: a token
 * count is a number in one tokenizer, and a session's history can span runs on
 * several routes. So the newest reply produced on the summarizer's own route
 * ends the span, found through the run headers rather than by role alone —
 * everything before its first event was in a request that route accepted.
 * A ledger with no reply from this route has nothing proven, and the caller
 * must not invent a boundary.
 */
function acceptedInputBoundary(
  events: readonly RuntimeEvent[],
  runHeaders: readonly AgentRunHeader[],
  route: { modelId: string; connectionId?: string } | undefined,
): number | undefined {
  if (!route) return undefined;
  const onRoute = (event: RuntimeEvent | undefined): boolean => {
    if (event?.role !== 'model') return false;
    const header = runHeaders.find((candidate) => candidate.runId === event.runId);
    if (!header || header.modelId !== route.modelId) return false;
    return header.llmConnectionId === route.connectionId;
  };
  let index = -1;
  for (let cursor = events.length - 1; cursor >= 0; cursor -= 1) {
    if (onRoute(events[cursor])) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return undefined;
  while (index > 0 && onRoute(events[index - 1])) index -= 1;
  return index;
}

export async function planHistoryCompaction(
  input: PlanHistoryCompactionInput,
): Promise<PlanHistoryCompactionResult> {
  const phase = input.phase ?? 'mid_turn';
  const charsPerToken = Math.max(1, input.charsPerToken ?? 4);

  // The current turn's steering messages are pinned out of the foldable span:
  // the backend's injection accumulator re-appends a live directive to every
  // request of this send, so folding one never shrinks the outgoing payload —
  // it only hides the directive from the final capacity measurement.
  const headAnchorIndex = input.orderedEvents.findIndex(
    (event) => event.id === input.headAnchor?.runtimeEventId,
  );
  if (phase !== 'standalone' && headAnchorIndex < 0) {
    return { decision: 'fail_open', reason: 'no_safe_completed_span' };
  }
  let maxCoveredCount = input.orderedEvents.length;
  while (maxCoveredCount > 0) {
    const boundary = selectSafeCompactionPrefix(input.orderedEvents, {
      reserveTailEvents: input.reserveTailEvents ?? (phase === 'standalone' ? 0 : 1),
      maxCoveredCount,
      isPinned: (event) =>
        (phase === 'pre_turn' && event.id === input.headAnchor?.runtimeEventId) ||
        (event.turnId === input.headAnchor?.turnId &&
          event.content?.kind === 'text' &&
          event.content.steering === true),
    });
    // Mid-turn coverage includes the head anchor and at least one other event;
    // the anchor is re-rendered verbatim, so folding only it saves nothing.
    // Step-0 recovery is a pre-turn fold: the anchor is pinned in the successor
    // tail and at least one prior event must be covered.
    const hasSafeCoverage =
      phase === 'standalone'
        ? boundary.ok && boundary.coveredCount > 0
        : phase === 'mid_turn'
          ? boundary.ok && boundary.coveredCount > headAnchorIndex && boundary.coveredCount >= 2
          : boundary.ok && boundary.coveredCount > 0 && boundary.coveredCount <= headAnchorIndex;
    if (!boundary.ok || !hasSafeCoverage) {
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
        if (error.reason === 'input_too_large') {
          // The summarizer's provider said this span does not fit its own
          // window; that is the only fit signal the fold listens to. Retreat to
          // the span the last accepted request's input covered: that span was
          // accepted by this model on this connection, so it is provably within
          // capacity, where halving the range is a guess that can overshoot
          // (throwing away verbatim history for nothing) or undershoot (paying
          // another round trip). Only one retreat is available, because there
          // is only one proven boundary; a rejection of that span too is the
          // provider saying this fold cannot be made, and the fold fails open
          // (#4559).
          const proven = acceptedInputBoundary(
            input.orderedEvents,
            input.runHeaders ?? [],
            input.acceptedRoute,
          );
          if (proven === undefined || proven >= boundary.coveredCount) {
            return {
              decision: 'fail_open',
              reason: 'summarizer_failed',
              diagnosticReason: error.reason,
            };
          }
          maxCoveredCount = proven;
          continue;
        }
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
      // An external producer reports no usage; only the structural checks apply.
      const defect = findCheckpointSummaryDefect(compacted);
      if (defect) {
        return { decision: 'fail_open', reason: 'summarizer_failed', diagnosticReason: defect };
      }
    }

    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: input.sessionId,
      coveredRuntimeEvents,
      ...(typeof compacted === 'string' ? { summary: compacted } : { providerState: compacted }),
      ...(phase === 'mid_turn'
        ? { phase: 'mid_turn' as const, headAnchor: input.headAnchor! }
        : {}),
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
  return { decision: 'fail_open', reason: 'no_safe_completed_span' };
}

export interface HistoryCompactionPolicy {
  enabled: boolean;
  checkpoint?: HistoryCompactCheckpoint;
  highWaterName?: string;
  midTurn?: { enabled: true };
}

export interface HistoryCompactionReplayResult {
  events: RuntimeEvent[];
  checkpoint?: HistoryCompactCheckpoint;
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

/** Replay the latest durable checkpoint when it exactly covers the ledger prefix. */
export function applyRuntimeEventHistoryCompact(
  events: readonly RuntimeEvent[],
  policy: HistoryCompactionPolicy | undefined,
  charsPerToken = 4,
): HistoryCompactionReplayResult {
  const checkpoint = policy?.enabled === true ? policy.checkpoint : undefined;
  if (!checkpoint) return { events: [...events], diagnosticPatch: {} };
  const compactableEvents = events.filter(isHistoryCompactContentEvent);
  const match = matchHistoryCompactCheckpointPrefix(checkpoint, compactableEvents);
  if (match.reason) {
    return {
      events: [...events],
      diagnosticPatch: compactionDecisionDiagnosticPatch({
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'failedOpen',
        boundaryKind: 'historyCompact',
        failOpenReason: match.reason,
      }),
    };
  }
  // A matching checkpoint always replays as `[block, tail]`: the fold chose
  // the boundary structurally, and whether the result fits is the provider's
  // answer, not a local estimate's (#4559). The token figures below are
  // diagnostics only.
  const checkpointTokens =
    checkpoint.version === 3
      ? checkpoint.estimatedTokens
      : estimateRuntimeEventsTokens(
          [historyCompactCheckpointToRuntimeEvent(checkpoint)],
          charsPerToken,
        );
  return {
    events: projectHistoryCompactCheckpointReplay(
      checkpoint,
      match.coveredRuntimeEvents,
      match.successorRuntimeEvents,
    ),
    checkpoint,
    diagnosticPatch: compactionDecisionDiagnosticPatch({
      stage: 'priorReplay',
      sourceKind: 'runtimeEvents',
      decision: 'replaced',
      ...(checkpoint.phase === 'mid_turn' ? { phase: 'mid_turn' as const } : {}),
      boundaryKind: 'historyCompact',
      boundaryIds: [checkpoint.checkpointId],
      coverage: {
        turnIds: Array.from(new Set(match.coveredRuntimeEvents.map((event) => event.turnId))),
        runtimeEventIds: match.coveredRuntimeEvents.map((event) => event.id),
        bodySha256: [checkpoint.coverage.sourceDigest],
      },
      estimatedTokensBefore: estimateRuntimeEventsTokens(match.coveredRuntimeEvents, charsPerToken),
      estimatedTokensAfter: checkpointTokens,
    }),
  };
}

/** True when the event carries model-visible content the compact projection counts. */
export function isHistoryCompactContentEvent(event: RuntimeEvent): boolean {
  return event.modelVisibility !== 'hidden' && estimateRuntimeEventChars(event) > 0;
}
