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

export type HistoryCompactCheckpointReplayFit =
  | { fits: true; checkpointTokens: number; replayTokens: number }
  | {
      fits: false;
      checkpointTokens: number;
      replayTokens: number;
      reason: 'prefix_over_budget' | 'replacement_not_smaller';
    };

export interface HistoryCompactReplayOptions {
  charsPerToken?: number;
  maxHistoryEstimatedTokens?: number;
  sourceReplayEvents?: readonly RuntimeEvent[];
  /** Selects the continuation seam without changing the shared compaction implementation. */
  historyCompactProtocol?: 'legacy_v1' | 'checkpoint_v2';
}

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import {
  allNonEmpty,
  boundText,
  escapeAttribute,
  estimateRuntimeEventChars,
  estimateRuntimeEventsTokens,
  estimateTokens,
  finitePositive,
  finiteRatio,
  groupEventsByTurn,
  increment,
  nonEmpty,
  normalizeWhitespace,
  sha256,
  stableStringify,
  turnKey,
  uniqueSorted,
  optionalNonNegativeFiniteNumber,
  utf8ByteLength,
} from './context-budget-helpers.js';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
  type CompactionDecisionKind,
} from './compaction-boundary.js';
import {
  type HistoryCompactCheckpoint,
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  midTurnHeadAnchorEvent,
  projectHistoryCompactCheckpointReplay,
} from './history-compact-checkpoint.js';
import { isValidSynthesisSourceRef, type SynthesisSourceRef } from './context-source-ref.js';

export interface HistoryCompactSourceArchiveRef {
  runtimeEventId: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
}

export function runtimeEventArchiveBody(event: RuntimeEvent): string {
  return stableStringify(event.content ?? {});
}

export function runtimeEventBodySha256(event: RuntimeEvent): string {
  return sha256(runtimeEventArchiveBody(event));
}

export function isValidHistoryCompactSourceArchiveRef(
  value: unknown,
): value is HistoryCompactSourceArchiveRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<HistoryCompactSourceArchiveRef>;
  return (
    nonEmpty(ref.runtimeEventId) &&
    nonEmpty(ref.artifactId) &&
    nonEmpty(ref.bodySha256) &&
    Number.isFinite(ref.originalEstimatedTokens) &&
    Number.isFinite(ref.originalBytes) &&
    (ref.originalEstimatedTokens ?? 0) > 0 &&
    (ref.originalBytes ?? 0) > 0
  );
}

/** The single current-policy gate for every checkpoint entering model replay. */
export function evaluateHistoryCompactCheckpointReplay(
  checkpoint: HistoryCompactCheckpoint,
  replayTail: readonly RuntimeEvent[],
  charsPerToken: number | undefined,
  maxHistoryEstimatedTokens: number | undefined,
  options: HistoryCompactReplayOptions = {},
): HistoryCompactCheckpointReplayFit {
  const charsPerTokenResolved = options.charsPerToken ?? charsPerToken ?? 4;
  const checkpointTokens =
    checkpoint.version === 3
      ? checkpoint.estimatedTokens
      : estimateRuntimeEventsTokens(
          [historyCompactCheckpointToRuntimeEvent(checkpoint)],
          charsPerTokenResolved,
        );
  const replayTokens =
    checkpointTokens + estimateRuntimeEventsTokens(replayTail, charsPerTokenResolved);
  const maxHistoryTokens = finitePositive(
    options.maxHistoryEstimatedTokens ?? maxHistoryEstimatedTokens,
  );
  if (maxHistoryTokens !== undefined && replayTokens > maxHistoryTokens) {
    return { fits: false, checkpointTokens, replayTokens, reason: 'prefix_over_budget' };
  }
  if (options.sourceReplayEvents) {
    const sourceReplayTokens = estimateRuntimeEventsTokens(
      options.sourceReplayEvents,
      charsPerTokenResolved,
    );
    if (replayTokens >= sourceReplayTokens) {
      return { fits: false, checkpointTokens, replayTokens, reason: 'replacement_not_smaller' };
    }
  }
  return { fits: true, checkpointTokens, replayTokens };
}

export interface HistoryCompactPolicy {
  enabled: boolean;
  /** `lookup` only replays supplied blocks; `read_write` may persist a host replacement for a deterministic draft. */
  mode?: 'deterministic' | 'lookup' | 'read_write';
  /** Source-bearing compact blocks available for the current replay projection. */
  blocks?: readonly HistoryCompactBlock[];
  /** V2 checkpoint loaded from the run ledger. Preferred over legacy V1 blocks. */
  checkpoint?: HistoryCompactCheckpoint;
  /** Legacy V1 deterministic-block limit. V2 LLM checkpoints are validated as a complete replay. */
  maxBlocks?: number;
  /** Legacy V1 deterministic-block token limit. V2 LLM checkpoints use the history capacity. */
  maxEstimatedTokens?: number;
  /** Legacy V1 per-block token limit. V2 LLM checkpoints are not truncated to this size. */
  maxBlockEstimatedTokens?: number;
  /** Compact once prior history exceeds this ratio of maxHistoryEstimatedTokens. Defaults to 0.8. */
  highWaterRatio?: number;
  /** Diagnostic high-water ratio reserved for future forced compaction. Defaults to 0.9. */
  forceRatio?: number;
  /** Legacy V1 tail target. Ignored by the V2 checkpoint protocol. */
  targetRatio?: number;
  /** Legacy V1 explicit tail budget. Ignored by the V2 checkpoint protocol. */
  tailEstimatedTokens?: number;
  /**
   * Recent-turn request. V2 normally keeps exactly the latest complete turn
   * at turn boundaries; an explicit zero permits a recovery compaction to
   * fold the failed latest turn as well.
   */
  minRecentTurns?: number;
  /** Legacy V1 deterministic-summary estimate. Defaults to 768. */
  maxSummaryEstimatedTokens?: number;
  /** Current block schema version. Defaults to 1. */
  summarySchemaVersion?: 1;
  /**
   * If true, every compacted RuntimeEvent must have a matching sourceArchiveRef.
   * The default false mode remains source-bearing through RuntimeEvent refs only.
   */
  archiveRequired?: boolean;
  /** Optional archive refs keyed by RuntimeEvent id for archive-before-project validation. */
  sourceArchiveRefs?:
    | readonly HistoryCompactSourceArchiveRef[]
    | Readonly<Record<string, HistoryCompactSourceArchiveRef>>;
  highWaterName?: string;
  /**
   * Optional mid-turn capacity compaction, layered on the same V2 checkpoint
   * protocol. Omitting the field in a handwritten policy leaves it off; the
   * shared runtime default (buildDefaultContextBudgetPolicy) enables it
   * whenever history compaction is on, unless MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN
   * opts out. When enabled the backend measures the next provider request
   * between steps and folds a safe completed prefix before crossing the model
   * context window.
   */
  midTurn?: HistoryCompactMidTurnPolicy;
}

export interface HistoryCompactMidTurnPolicy {
  enabled: boolean;
  /**
   * Tokens kept free below the selected model context window. The proactive
   * high-water threshold is `contextWindow - reserveTokens`. Defaults to 16384
   * when omitted in a handwritten policy; the shared runtime default always
   * supplies a window-bounded value.
   */
  reserveTokens?: number;
  /** Trailing events kept verbatim as the continuation tail. Defaults to 1. */
  reserveTailEvents?: number;
}

export interface HistoryCompactBlock {
  kind: 'maka.history_compact_block';
  version: 1;
  blockId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  coverage: HistoryCompactCoverage;
  summary: string;
  limitations: string[];
  sourceRefs: readonly SynthesisSourceRef[];
  sourceArchiveRefs?: readonly HistoryCompactSourceArchiveRef[];
  estimatedTokens?: number;
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}

export interface HistoryCompactCoverage {
  turnIds: string[];
  runtimeEventIds: string[];
  contentKinds: string[];
  bodySha256: string[];
}

export interface HistoryCompactReplayResult {
  events: RuntimeEvent[];
  blocks: HistoryCompactBlock[];
  checkpoint?: HistoryCompactCheckpoint;
  diagnosticPatch: Partial<ContextBudgetDiagnostic>;
}

export interface HistoryRewriteGatePolicy {
  enabled: boolean;
  name?: string;
  historyRewriteVersion: string;
  resetReason: string;
}

export function applyRuntimeEventHistoryCompact(
  events: readonly RuntimeEvent[],
  compactPolicy: HistoryCompactPolicy | undefined,
  charsPerToken: number | undefined,
  maxHistoryEstimatedTokens: number | undefined,
  options: HistoryCompactReplayOptions = {},
): HistoryCompactReplayResult {
  if (compactPolicy?.enabled !== true) {
    return { events: [...events], blocks: [], diagnosticPatch: {} };
  }

  const charsPerTokenResolved = options.charsPerToken ?? charsPerToken ?? 4;
  const maxTokens = finitePositive(options.maxHistoryEstimatedTokens ?? maxHistoryEstimatedTokens);
  const skippedReasonCounts: Record<string, number> = {};
  const basePatch: Partial<ContextBudgetDiagnostic> = {
    historyCompactEnabled: true,
    historyCompactMode: compactPolicy.mode ?? 'deterministic',
  };
  if (maxTokens === undefined) {
    increment(skippedReasonCounts, 'max_history_tokens_missing');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const compactableEvents = events.filter(isHistoryCompactContentEvent);

  // A durable checkpoint is a projection boundary, not a fresh-compaction
  // optimization. Match it against the full content projection BEFORE every
  // size-based guard — including the below-high-water skip — so a later turn
  // never resurrects the raw prefix that a manual/recovery compaction already
  // replaced. A mid_turn checkpoint additionally re-renders its covered head
  // anchor verbatim after the compact block.
  const checkpoint = compactPolicy.checkpoint;
  if (checkpoint) {
    const match = matchHistoryCompactCheckpointPrefix(checkpoint, compactableEvents);
    if (match.reason) {
      increment(skippedReasonCounts, match.reason);
    } else {
      const headAnchor =
        checkpoint.phase === 'mid_turn'
          ? midTurnHeadAnchorEvent(checkpoint, match.coveredRuntimeEvents)
          : undefined;
      const replayTail = headAnchor
        ? [headAnchor, ...match.successorRuntimeEvents]
        : [...match.successorRuntimeEvents];
      const fit = evaluateHistoryCompactCheckpointReplay(
        checkpoint,
        replayTail,
        charsPerTokenResolved,
        maxTokens,
        {
          sourceReplayEvents: [...match.coveredRuntimeEvents, ...match.successorRuntimeEvents],
        },
      );
      if (!fit.fits) {
        increment(skippedReasonCounts, fit.reason);
      } else {
        return {
          events: projectHistoryCompactCheckpointReplay(
            checkpoint,
            match.coveredRuntimeEvents,
            match.successorRuntimeEvents,
          ),
          blocks: [],
          checkpoint,
          diagnosticPatch: {
            ...basePatch,
            historyCompactBlocksAvailable: 1,
            historyCompactBlocksSelected: 1,
            historyCompactBlockIds: [checkpoint.checkpointId],
            historyCompactedTurns: checkpoint.coverage.turnCount,
            historyCompactedEvents: checkpoint.coverage.eventCount,
            historyCompactedEstimatedTokensBefore: estimateRuntimeEventsTokens(
              match.coveredRuntimeEvents,
              charsPerTokenResolved,
            ),
            historyCompactedEstimatedTokensAfter: fit.checkpointTokens,
            historyCompactCoverageHashes: [checkpoint.coverage.sourceDigest],
            highWaterName: checkpoint.highWaterName,
            highWaterSeq: checkpoint.highWaterSeq,
            highWaterReason: 'history_compact',
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              ...(checkpoint.phase === 'mid_turn' ? { phase: 'mid_turn' as const } : {}),
              boundaryKind: 'historyCompact',
              boundaryIds: [checkpoint.checkpointId],
              coverage: { bodySha256: [checkpoint.coverage.sourceDigest] },
              estimatedTokensBefore: estimateRuntimeEventsTokens(
                match.coveredRuntimeEvents,
                charsPerTokenResolved,
              ),
              estimatedTokensAfter: fit.checkpointTokens,
            }),
          },
        };
      }
    }
  }

  const estimatedTokensBefore = estimateRuntimeEventsTokens(
    compactableEvents,
    charsPerTokenResolved,
  );
  const highWaterRatio = finiteRatio(compactPolicy.highWaterRatio, 0.8);
  const highWaterThreshold = Math.max(1, Math.floor(maxTokens * highWaterRatio));
  if (estimatedTokensBefore <= highWaterThreshold) {
    increment(skippedReasonCounts, 'below_high_water');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const turnGroups = groupEventsByTurn(compactableEvents, charsPerTokenResolved);
  if (turnGroups.length <= 1 && compactPolicy.minRecentTurns !== 0) {
    increment(skippedReasonCounts, 'insufficient_turns');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const usesCheckpointV2Seam =
    options.historyCompactProtocol === 'checkpoint_v2' || compactPolicy.checkpoint !== undefined;
  const tailSelection =
    compactPolicy.minRecentTurns === 0
      ? { eventIds: new Set<string>(), turnIds: new Set<string>() }
      : usesCheckpointV2Seam
        ? selectLatestCompleteTurnEvents(turnGroups)
        : selectLegacyHistoryCompactTailEvents(turnGroups, {
            tailBudget:
              finitePositive(compactPolicy.tailEstimatedTokens) ??
              Math.max(1, Math.floor(maxTokens * finiteRatio(compactPolicy.targetRatio, 0.5))),
          });
  const retainedEventIds = tailSelection.eventIds;
  const tailTurnIds = tailSelection.turnIds;
  const foldedEvents = compactableEvents.filter((event) => !retainedEventIds.has(event.id));
  const retainedEvents = compactableEvents.filter((event) => retainedEventIds.has(event.id));
  if (foldedEvents.length === 0) {
    increment(skippedReasonCounts, 'no_foldable_turns');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const loaded = selectLoadedHistoryCompactBlock(
    foldedEvents,
    compactPolicy,
    { sessionId: foldedEvents[0]?.sessionId ?? '', charsPerToken: charsPerTokenResolved },
    skippedReasonCounts,
  );
  if (loaded) {
    const { block: loadedBlock, coveredEvents } = loaded;
    const coveredEventIds = new Set(coveredEvents.map((event) => event.id));
    const uncoveredFoldedEvents = foldedEvents.filter((event) => !coveredEventIds.has(event.id));
    const estimatedTokensBeforeFold = estimateRuntimeEventsTokens(
      coveredEvents,
      charsPerTokenResolved,
    );
    const loadedBlockText = renderHistoryCompactBlock(loadedBlock);
    const estimatedTokensAfterFold =
      loadedBlock.estimatedTokens ?? estimateTokens(loadedBlockText.length, charsPerTokenResolved);
    const boundary = historyCompactBlockToCompactionBoundary(loadedBlock, {
      renderedText: loadedBlockText,
      preservedAnchor: { tailTurnIds: [...tailTurnIds] },
      validationStatus: 'valid',
    });
    const outputEvents = [
      historyCompactBlockToRuntimeEvent(loadedBlock),
      ...uncoveredFoldedEvents,
      ...retainedEvents,
    ];
    if (fitsHistoryBudget(outputEvents, maxTokens, charsPerTokenResolved)) {
      return {
        events: outputEvents,
        blocks: [loadedBlock],
        diagnosticPatch: {
          ...basePatch,
          historyCompactBlocksAvailable: compactPolicy.blocks?.length ?? 0,
          historyCompactBlocksSelected: 1,
          historyCompactBlockIds: [loadedBlock.blockId],
          historyCompactedTurns: loadedBlock.coverage.turnIds.length,
          historyCompactedEvents: loadedBlock.coverage.runtimeEventIds.length,
          historyCompactedEstimatedTokensBefore: estimatedTokensBeforeFold,
          historyCompactedEstimatedTokensAfter: estimatedTokensAfterFold,
          historyCompactCoverageHashes: loadedBlock.coverage.bodySha256,
          highWaterName: loadedBlock.highWaterName,
          highWaterSeq: loadedBlock.highWaterSeq,
          highWaterReason: 'history_compact',
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'replaced',
            boundaryKind: boundary.kind,
            boundaryIds: [boundary.boundaryId],
            coverage: boundary.coverage,
            estimatedTokensBefore: estimatedTokensBeforeFold,
            estimatedTokensAfter: estimatedTokensAfterFold,
          }),
        },
      };
    }
    increment(skippedReasonCounts, 'prefix_over_budget');
  }

  const archiveRefs = normalizeHistoryCompactSourceArchiveRefs(compactPolicy.sourceArchiveRefs);
  if (compactPolicy.archiveRequired === true) {
    const archiveValidationReason = validateHistoryCompactArchiveCoverage(
      foldedEvents,
      archiveRefs,
      charsPerTokenResolved,
    );
    if (archiveValidationReason) {
      increment(skippedReasonCounts, archiveValidationReason);
      return {
        events: [...events],
        blocks: [],
        diagnosticPatch: {
          ...basePatch,
          historyCompactSkipped: 1,
          historyCompactSkippedReasonCounts: skippedReasonCounts,
          ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
        },
      };
    }
  }

  if (compactPolicy.mode === 'lookup') {
    if (!skippedReasonCounts.prefix_over_budget) {
      increment(skippedReasonCounts, 'lookup_miss');
    }
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }

  const block = buildHistoryCompactBlock(foldedEvents, compactPolicy, {
    charsPerToken: charsPerTokenResolved,
    archiveRefs,
  });
  const estimatedTokensBeforeFold = estimateRuntimeEventsTokens(
    foldedEvents,
    charsPerTokenResolved,
  );
  const blockText = renderHistoryCompactBlock(block);
  const estimatedTokensAfterFold =
    block.estimatedTokens ?? estimateTokens(blockText.length, charsPerTokenResolved);
  const boundary = historyCompactBlockToCompactionBoundary(block, {
    renderedText: blockText,
    preservedAnchor: { tailTurnIds: [...tailTurnIds] },
    validationStatus: 'valid',
  });
  const synthetic = historyCompactBlockToRuntimeEvent(block);
  const outputEvents = [synthetic, ...retainedEvents];
  if (!fitsHistoryBudget(outputEvents, maxTokens, charsPerTokenResolved)) {
    increment(skippedReasonCounts, 'replay_over_budget');
    return {
      events: [...events],
      blocks: [],
      diagnosticPatch: {
        ...basePatch,
        historyCompactSkipped: 1,
        historyCompactSkippedReasonCounts: skippedReasonCounts,
        ...historyCompactSkippedDecisionPatch(skippedReasonCounts),
      },
    };
  }
  return {
    events: outputEvents,
    blocks: [block],
    diagnosticPatch: {
      ...basePatch,
      historyCompactBlockIds: [block.blockId],
      historyCompactBlocksSelected: 1,
      historyCompactedTurns: block.coverage.turnIds.length,
      historyCompactedEvents: block.coverage.runtimeEventIds.length,
      historyCompactedEstimatedTokensBefore: estimatedTokensBeforeFold,
      historyCompactedEstimatedTokensAfter: estimatedTokensAfterFold,
      historyCompactCoverageHashes: block.coverage.bodySha256,
      highWaterName: block.highWaterName,
      highWaterSeq: block.highWaterSeq,
      highWaterReason: 'history_compact',
      ...compactionDecisionDiagnosticPatch({
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'replaced',
        boundaryKind: boundary.kind,
        boundaryIds: [boundary.boundaryId],
        coverage: boundary.coverage,
        estimatedTokensBefore: estimatedTokensBeforeFold,
        estimatedTokensAfter: estimatedTokensAfterFold,
      }),
    },
  };
}

// Model-visible rendering stays bounded regardless of how many events the
// block folds: per-event ids, hashes, and archive refs live only in the
// persisted block JSON, where coverage validation and replay read them.
export function renderHistoryCompactBlock(block: HistoryCompactBlock): string {
  const archiveCount = block.sourceArchiveRefs?.length ?? 0;
  return [
    `<maka_history_compact_block id="${escapeAttribute(block.blockId)}" high_water="${escapeAttribute(block.highWaterName)}" seq="${block.highWaterSeq}" version="${block.version}">`,
    `summary: ${block.summary}`,
    `coverage: ${block.coverage.runtimeEventIds.length} runtime events across ${block.coverage.turnIds.length} turns, contentKinds=[${block.coverage.contentKinds.join(', ')}]${archiveCount > 0 ? `, archivedSources=${archiveCount}` : ''}`,
    `limitations: ${block.limitations.join('; ')}`,
    '</maka_history_compact_block>',
  ].join('\n');
}

export function validateHistoryCompactBlockShape(
  value: unknown,
  sessionId?: string,
): value is HistoryCompactBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Partial<HistoryCompactBlock>;
  return (
    block.kind === 'maka.history_compact_block' &&
    block.version === 1 &&
    nonEmpty(block.blockId) &&
    nonEmpty(block.sessionId) &&
    (sessionId === undefined || block.sessionId === sessionId) &&
    Number.isFinite(block.createdAt) &&
    nonEmpty(block.highWaterName) &&
    Number.isFinite(block.highWaterSeq) &&
    !!block.coverage &&
    Array.isArray(block.coverage.turnIds) &&
    Array.isArray(block.coverage.runtimeEventIds) &&
    Array.isArray(block.coverage.contentKinds) &&
    Array.isArray(block.coverage.bodySha256) &&
    allNonEmpty(block.coverage.turnIds) &&
    allNonEmpty(block.coverage.runtimeEventIds) &&
    allNonEmpty(block.coverage.contentKinds) &&
    allNonEmpty(block.coverage.bodySha256) &&
    typeof block.summary === 'string' &&
    block.summary.length > 0 &&
    Array.isArray(block.limitations) &&
    Array.isArray(block.sourceRefs) &&
    block.sourceRefs.length > 0 &&
    block.sourceRefs.every(isValidSynthesisSourceRef) &&
    optionalNonNegativeFiniteNumber(block.estimatedTokens) &&
    (block.sourceArchiveRefs === undefined ||
      (Array.isArray(block.sourceArchiveRefs) &&
        block.sourceArchiveRefs.every(isValidHistoryCompactSourceArchiveRef)))
  );
}

export function historyCompactBlockToRuntimeEvent(block: HistoryCompactBlock): RuntimeEvent {
  return {
    id: `history-compact:${block.blockId}`,
    sessionId: block.sessionId,
    runId: `history-compact:${block.blockId}`,
    turnId: `history-compact:${block.highWaterSeq}`,
    invocationId: `history-compact:${block.blockId}`,
    ts: block.createdAt,
    partial: false,
    role: 'user',
    author: 'system',
    content: {
      kind: 'text',
      text: renderHistoryCompactBlock(block),
    },
    ...(block.sourceArchiveRefs?.[0]
      ? { refs: { artifactId: block.sourceArchiveRefs[0].artifactId } }
      : {}),
  };
}

export function buildHistoryCompactBlockFromSummary(input: {
  sessionId: string;
  foldedRuntimeEvents: readonly RuntimeEvent[];
  summary: string;
  highWaterName?: string;
  highWaterSeq?: number;
  maxSummaryEstimatedTokens?: number;
  sourceArchiveRefs?: readonly HistoryCompactSourceArchiveRef[];
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  now?: number;
  charsPerToken?: number;
}): HistoryCompactBlock {
  const charsPerToken = input.charsPerToken ?? 4;
  const highWaterName = input.highWaterName ?? 'history-compact-high-water';
  const createdAt = Math.max(input.now ?? 1, ...input.foldedRuntimeEvents.map((event) => event.ts));
  const highWaterSeq = input.highWaterSeq ?? createdAt;
  const coverage = deriveHistoryCompactCoverage(input.foldedRuntimeEvents);
  const sourceRefs: SynthesisSourceRef[] = input.foldedRuntimeEvents.map((event) => ({
    kind: 'runtime_event',
    sessionId: event.sessionId,
    turnId: turnKey(event),
    runtimeEventId: event.id,
    role: event.role,
    contentKind: event.content?.kind ?? 'none',
  }));
  const maxSummaryTokens = finitePositive(input.maxSummaryEstimatedTokens) ?? 768;
  const summary = boundText(
    input.summary,
    Math.max(80, maxSummaryTokens * Math.max(1, charsPerToken)),
  );
  const blockDraft = {
    version: 1,
    sessionId: input.sessionId,
    highWaterName,
    highWaterSeq,
    coverage,
    summary,
  };
  const sourceArchiveRefs =
    input.sourceArchiveRefs?.filter(isValidHistoryCompactSourceArchiveRef) ?? [];
  const block: HistoryCompactBlock = {
    kind: 'maka.history_compact_block',
    version: 1,
    blockId: stableHistoryCompactBlockId(blockDraft),
    sessionId: input.sessionId,
    createdAt,
    highWaterName,
    highWaterSeq,
    coverage,
    summary,
    limitations: [
      'Host-owned replay-time summary of older RuntimeEvents.',
      'Original RuntimeEvents are not mutated; request raw evidence or history search when exact wording matters.',
      ...(sourceArchiveRefs.length === 0
        ? [
            'No archive refs are attached; source coverage is by RuntimeEvent ids and content hashes.',
          ]
        : []),
    ],
    sourceRefs,
    ...(sourceArchiveRefs.length > 0 ? { sourceArchiveRefs } : {}),
    ...(input.requestShapeHashBefore
      ? { requestShapeHashBefore: input.requestShapeHashBefore }
      : {}),
    ...(input.requestShapeHashAfter ? { requestShapeHashAfter: input.requestShapeHashAfter } : {}),
  };
  block.estimatedTokens = estimateTokens(renderHistoryCompactBlock(block).length, charsPerToken);
  return block;
}

function fitsHistoryBudget(
  events: readonly RuntimeEvent[],
  maxTokens: number | undefined,
  charsPerToken: number,
): boolean {
  return maxTokens === undefined || estimateRuntimeEventsTokens(events, charsPerToken) <= maxTokens;
}

function selectLatestCompleteTurnEvents(
  turnGroups: ReadonlyArray<{
    turnId: string;
    estimatedTokens: number;
    events: readonly RuntimeEvent[];
  }>,
): { eventIds: Set<string>; turnIds: Set<string> } {
  const eventIds = new Set<string>();
  const turnIds = new Set<string>();
  const latest = turnGroups.at(-1);
  if (!latest) return { eventIds, turnIds };
  turnIds.add(latest.turnId);
  for (const event of latest.events) eventIds.add(event.id);
  return { eventIds, turnIds };
}

function selectLegacyHistoryCompactTailEvents(
  turnGroups: ReadonlyArray<{
    turnId: string;
    estimatedTokens: number;
    events: readonly RuntimeEvent[];
  }>,
  options: { tailBudget: number },
): { eventIds: Set<string>; turnIds: Set<string> } {
  const eventIds = new Set<string>();
  const turnIds = new Set<string>();
  let selectedTokens = 0;
  for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
    const group = turnGroups[index]!;
    if (selectedTokens + group.estimatedTokens > options.tailBudget) {
      if (eventIds.size === 0) {
        const fallbackIds = latestCompleteStepEventIds(group.events);
        for (const id of fallbackIds) eventIds.add(id);
        if (fallbackIds.length > 0) turnIds.add(group.turnId);
      }
      break;
    }
    turnIds.add(group.turnId);
    for (const event of group.events) eventIds.add(event.id);
    selectedTokens += group.estimatedTokens;
  }
  return { eventIds, turnIds };
}

function latestCompleteStepEventIds(events: readonly RuntimeEvent[]): string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.content?.kind !== 'function_response') continue;
    for (let callIndex = index - 1; callIndex >= 0; callIndex -= 1) {
      const call = events[callIndex]!;
      if (call.content?.kind === 'function_call' && call.content.id === event.content.id) {
        return [call.id, event.id];
      }
    }
  }
  const latest = events.at(-1);
  return latest ? [latest.id] : [];
}

function selectLoadedHistoryCompactBlock(
  foldedEvents: readonly RuntimeEvent[],
  policy: HistoryCompactPolicy,
  options: {
    sessionId: string;
    charsPerToken: number;
  },
  skippedReasonCounts: Record<string, number>,
): { block: HistoryCompactBlock; coveredEvents: RuntimeEvent[] } | undefined {
  const blocks = policy.blocks ?? [];
  if (blocks.length === 0) return undefined;
  const maxBlocks = finitePositive(policy.maxBlocks) ?? 1;
  const maxEstimatedTokens = finitePositive(policy.maxEstimatedTokens) ?? 2_048;
  const maxBlockEstimatedTokens =
    finitePositive(policy.maxBlockEstimatedTokens) ??
    finitePositive(policy.maxSummaryEstimatedTokens) ??
    1_024;
  let selectedTokens = 0;
  let selected = 0;
  for (const block of blocks) {
    if (selected >= maxBlocks) {
      increment(skippedReasonCounts, 'max_blocks');
      continue;
    }
    const validation = validateHistoryCompactBlockForEvents(block, foldedEvents, options.sessionId);
    if (validation.reason) {
      increment(skippedReasonCounts, validation.reason);
      continue;
    }
    const blockTokens =
      block.estimatedTokens ??
      estimateTokens(renderHistoryCompactBlock(block).length, options.charsPerToken);
    if (blockTokens > maxBlockEstimatedTokens) {
      increment(skippedReasonCounts, 'max_block_tokens');
      continue;
    }
    if (selectedTokens + blockTokens > maxEstimatedTokens) {
      increment(skippedReasonCounts, 'max_total_tokens');
      continue;
    }
    selected += 1;
    selectedTokens += blockTokens;
    return {
      block: { ...block, estimatedTokens: blockTokens },
      coveredEvents: validation.coveredEvents,
    };
  }
  return undefined;
}

function validateHistoryCompactBlockForEvents(
  block: HistoryCompactBlock,
  foldedEvents: readonly RuntimeEvent[],
  sessionId: string,
): {
  reason?: 'invalid_schema_version' | 'session_mismatch' | 'coverage_miss' | 'source_hash_mismatch';
  coveredEvents: RuntimeEvent[];
} {
  if (!validateHistoryCompactBlockShape(block, sessionId || undefined))
    return { reason: 'invalid_schema_version', coveredEvents: [] };
  if (sessionId.length > 0 && block.sessionId !== sessionId)
    return { reason: 'session_mismatch', coveredEvents: [] };
  const coverageIds = new Set(block.coverage.runtimeEventIds);
  const coveredEvents: RuntimeEvent[] = [];
  for (const event of foldedEvents) {
    if (!coverageIds.has(event.id)) break;
    if (!block.coverage.turnIds.includes(turnKey(event)))
      return { reason: 'coverage_miss', coveredEvents: [] };
    if (!block.coverage.contentKinds.includes(event.content?.kind ?? 'none'))
      return { reason: 'coverage_miss', coveredEvents: [] };
    if (!block.coverage.bodySha256.includes(runtimeEventBodySha256(event)))
      return { reason: 'source_hash_mismatch', coveredEvents: [] };
    coveredEvents.push(event);
  }
  if (coveredEvents.length === 0 || coveredEvents.length !== coverageIds.size) {
    return { reason: 'coverage_miss', coveredEvents: [] };
  }
  return { coveredEvents };
}

function buildHistoryCompactBlock(
  foldedEvents: readonly RuntimeEvent[],
  policy: HistoryCompactPolicy,
  options: {
    charsPerToken: number;
    archiveRefs: ReadonlyMap<string, HistoryCompactSourceArchiveRef>;
  },
): HistoryCompactBlock {
  const sourceArchiveRefs: HistoryCompactSourceArchiveRef[] = [];
  for (const event of foldedEvents) {
    const ref = options.archiveRefs.get(event.id);
    if (ref && historyCompactArchiveRefMatches(event, ref, options.charsPerToken)) {
      sourceArchiveRefs.push(ref);
    }
  }
  return buildHistoryCompactBlockFromSummary({
    sessionId: foldedEvents[0]?.sessionId ?? 'unknown-session',
    foldedRuntimeEvents: foldedEvents,
    summary: buildDeterministicHistoryCompactSummary(foldedEvents, policy, options.charsPerToken),
    highWaterName: policy.highWaterName,
    maxSummaryEstimatedTokens: policy.maxSummaryEstimatedTokens,
    sourceArchiveRefs,
    charsPerToken: options.charsPerToken,
  });
}

function deriveHistoryCompactCoverage(events: readonly RuntimeEvent[]): HistoryCompactCoverage {
  return {
    turnIds: uniqueSorted(events.map((event) => turnKey(event))),
    runtimeEventIds: uniqueSorted(events.map((event) => event.id)),
    contentKinds: uniqueSorted(events.map((event) => event.content?.kind ?? 'none')),
    bodySha256: uniqueSorted(events.map(runtimeEventBodySha256)),
  };
}

function buildDeterministicHistoryCompactSummary(
  events: readonly RuntimeEvent[],
  policy: HistoryCompactPolicy,
  charsPerToken: number,
): string {
  const maxSummaryTokens = finitePositive(policy.maxSummaryEstimatedTokens) ?? 768;
  const maxChars = Math.max(80, maxSummaryTokens * Math.max(1, charsPerToken));
  const coverage = deriveHistoryCompactCoverage(events);
  const lines = [
    `Compacted ${coverage.turnIds.length} older turns and ${coverage.runtimeEventIds.length} RuntimeEvents.`,
    `Content kinds: ${coverage.contentKinds.join(', ')}.`,
    'Ordered excerpts:',
  ];
  for (const event of events) {
    const excerpt = historyCompactEventExcerpt(event);
    if (!excerpt) continue;
    lines.push(
      `- ${turnKey(event)}/${event.id}/${event.role}/${event.content?.kind ?? 'none'}: ${excerpt}`,
    );
  }
  return boundText(lines.join('\n'), maxChars);
}

function historyCompactEventExcerpt(event: RuntimeEvent): string | undefined {
  const content = event.content;
  if (!content) return undefined;
  switch (content.kind) {
    case 'text':
    case 'thinking':
      return normalizeWhitespace(content.text).slice(0, 220);
    case 'function_call':
      return normalizeWhitespace(`${content.name} ${stableStringify(content.args)}`).slice(0, 220);
    case 'function_response':
      return normalizeWhitespace(`${content.name} ${stableStringify(content.result)}`).slice(
        0,
        220,
      );
    case 'error':
      return normalizeWhitespace(
        `${content.code ?? ''} ${content.reason ?? ''} ${content.message}`,
      ).slice(0, 220);
  }
}

function stableHistoryCompactBlockId(value: unknown): string {
  return `hcompact-${sha256(stableStringify(value)).slice(0, 32)}`;
}

function normalizeHistoryCompactSourceArchiveRefs(
  refs: HistoryCompactPolicy['sourceArchiveRefs'],
): Map<string, HistoryCompactSourceArchiveRef> {
  const map = new Map<string, HistoryCompactSourceArchiveRef>();
  if (!refs) return map;
  if (Array.isArray(refs)) {
    for (const ref of refs) map.set(ref.runtimeEventId, ref);
    return map;
  }
  for (const [runtimeEventId, ref] of Object.entries(refs)) map.set(runtimeEventId, ref);
  return map;
}

function validateHistoryCompactArchiveCoverage(
  events: readonly RuntimeEvent[],
  refs: ReadonlyMap<string, HistoryCompactSourceArchiveRef>,
  charsPerToken: number,
): 'archive_missing' | 'archive_mismatch' | undefined {
  for (const event of events) {
    const ref = refs.get(event.id);
    if (!ref) return 'archive_missing';
    if (!historyCompactArchiveRefMatches(event, ref, charsPerToken)) return 'archive_mismatch';
  }
  return undefined;
}

function historyCompactSkippedDecisionPatch(
  skippedReasonCounts: Readonly<Record<string, number>>,
): Partial<ContextBudgetDiagnostic> {
  const reason = Object.keys(skippedReasonCounts)[0];
  const decision: CompactionDecisionKind =
    reason === 'archive_missing' || reason === 'archive_mismatch' ? 'failedOpen' : 'unchanged';
  return compactionDecisionDiagnosticPatch({
    stage: 'priorReplay',
    sourceKind: 'runtimeEvents',
    decision,
    boundaryKind: 'historyCompact',
    ...(reason ? { reason } : {}),
    ...(decision === 'failedOpen' && reason ? { failOpenReason: reason } : {}),
    skippedReasonCounts,
  });
}

function historyCompactArchiveRefMatches(
  event: RuntimeEvent,
  ref: HistoryCompactSourceArchiveRef,
  charsPerToken: number,
): boolean {
  const body = runtimeEventArchiveBody(event);
  return (
    ref.runtimeEventId === event.id &&
    nonEmpty(ref.artifactId) &&
    ref.bodySha256 === sha256(body) &&
    ref.originalEstimatedTokens === estimateTokens(body.length, charsPerToken) &&
    ref.originalBytes === utf8ByteLength(body)
  );
}

/** True when the event carries model-visible content the compact projection counts. */
export function isHistoryCompactContentEvent(event: RuntimeEvent): boolean {
  return event.modelVisibility !== 'hidden' && estimateRuntimeEventChars(event) > 0;
}

export function replaceHistoryCompactReplayBlocks(
  events: readonly RuntimeEvent[],
  blocks: readonly HistoryCompactBlock[],
): RuntimeEvent[] {
  if (blocks.length === 0) return [...events];
  return [
    ...blocks.map((block) => historyCompactBlockToRuntimeEvent(block)),
    ...events.filter((event) => !event.id.startsWith('history-compact:')),
  ];
}
