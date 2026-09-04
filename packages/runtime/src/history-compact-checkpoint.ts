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

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { ExecutionLogCoverage } from '@maka/core/execution-log-coverage';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ModelMessage } from './model-protocol.js';
import { stableStringify } from './request-shape.js';
import {
  findCheckpointSummaryDefect,
  SECTIONED_SUMMARY_FORMAT,
  type SectionedSummaryFormat,
} from './history-compact-summary-validation.js';

// v2: coverage and source digest are taken over EFFECTIVE model history (the
// durable Tool Result projection), not raw RuntimeEvent evidence. A v1
// checkpoint's digest was computed over a different source, so it fails the
// shape check and its session re-summarizes rather than replaying a
// coverage claim this policy never made.
export const HISTORY_COMPACT_SOURCE_POLICY_VERSION =
  'maka.compactable_runtime_event_projection.v2' as const;
export interface HistoryCompactCheckpointSource {
  schemaVersion: 1;
  kind: 'runtime_event_projection';
  policyVersion: typeof HISTORY_COMPACT_SOURCE_POLICY_VERSION;
  /** Inclusive cursor range in the policy-versioned, session-scoped projection. */
  coverage: ExecutionLogCoverage;
}

export interface HistoryCompactCheckpointCoverage {
  eventCount: number;
  turnCount: number;
  through: {
    runId: string;
    turnId: string;
    runtimeEventId: string;
  };
  sourceDigest: string;
}

/**
 * Compaction phase. Absent on legacy data and defaults to `pre_turn`, the
 * turn-boundary compaction the V2 checkpoint protocol was introduced for. A
 * `mid_turn` checkpoint folds a prefix that reaches into the current turn's
 * completed steps, so its projection re-renders the covered head anchor (the
 * current turn's user message) verbatim after the compact block.
 */
export type HistoryCompactCheckpointPhase = 'pre_turn' | 'mid_turn';

/**
 * Reference to a covered RuntimeEvent that a `mid_turn` checkpoint re-renders
 * verbatim in the replay projection. Coverage still spans this event so the
 * digest math stays a contiguous prefix; the projection deterministically
 * rebuilds `[compact block, verbatim head anchor, tail]` from it.
 */
export interface HistoryCompactCheckpointHeadAnchor {
  runtimeEventId: string;
  turnId: string;
}

/** Last durable RuntimeEvent visible when an automatic Compaction triggered Memory extraction. */
export interface HistoryCompactMemoryExtractionBoundary {
  runId: string;
  turnId: string;
  runtimeEventId: string;
  /** Omitted on existing checkpoints and equivalent to `eligible`. */
  disposition?: 'eligible' | 'policy_denied';
}

interface HistoryCompactCheckpointBase {
  kind: 'maka.history_compact_checkpoint';
  checkpointId: string;
  sessionId: string;
  createdAt: number;
  highWaterName: string;
  highWaterSeq: number;
  /** Present on evidence-spine checkpoints; omitted only on legacy V2 data. */
  source?: HistoryCompactCheckpointSource;
  coverage: HistoryCompactCheckpointCoverage;
  /** Absent = `pre_turn`. `mid_turn` checkpoints carry a `headAnchor`. */
  phase?: HistoryCompactCheckpointPhase;
  /** Present only on `mid_turn` checkpoints; the covered head anchor re-rendered verbatim. */
  headAnchor?: HistoryCompactCheckpointHeadAnchor;
  /** Absent for manual/legacy checkpoints, present for automatic Memory extraction triggers. */
  memoryExtractionBoundary?: HistoryCompactMemoryExtractionBoundary;
  limitations: string[];
  estimatedTokens: number;
  previousCheckpointId?: string;
}

export interface TextHistoryCompactCheckpoint extends HistoryCompactCheckpointBase {
  version: 2;
  summary: string;
  /**
   * Durable identity of the summary contract the writer honored. Present on
   * checkpoints built under the sectioned contract (#3029), which every
   * admission seam (load/repair, copy) holds to the complete predicate;
   * absent on legacy free-form V2 data, kept loadable under the
   * truncation-only compatibility policy.
   */
  summaryFormat?: SectionedSummaryFormat;
}

export interface OpenAiCodexRemoteCompactState {
  kind: 'openai_codex_remote_v2';
  connectionId: string;
  modelId: string;
  itemId: string;
  encryptedContent: string;
}

export type HistoryCompactProviderState = OpenAiCodexRemoteCompactState;

export interface ProviderHistoryCompactCheckpoint extends HistoryCompactCheckpointBase {
  version: 3;
  providerState: HistoryCompactProviderState;
}

export type HistoryCompactCheckpoint =
  | TextHistoryCompactCheckpoint
  | ProviderHistoryCompactCheckpoint;

interface BuildHistoryCompactCheckpointBaseInput {
  sessionId: string;
  coveredRuntimeEvents: readonly RuntimeEvent[];
  highWaterName?: string;
  highWaterSeq?: number;
  previousCheckpointId?: string;
  now?: number;
  charsPerToken?: number;
  /** Defaults to `pre_turn`. `mid_turn` requires a `headAnchor` inside coverage. */
  phase?: HistoryCompactCheckpointPhase;
  /** Required when `phase` is `mid_turn`; must reference a covered RuntimeEvent. */
  headAnchor?: HistoryCompactCheckpointHeadAnchor;
  memoryExtractionBoundary?: HistoryCompactMemoryExtractionBoundary;
}

export type BuildTextHistoryCompactCheckpointInput = BuildHistoryCompactCheckpointBaseInput & {
  summary: string;
  /**
   * Defaults to the sectioned contract. `legacy_freeform` builds an unmarked
   * checkpoint — only for preserving a legacy source summary across copy.
   */
  summaryFormat?: SectionedSummaryFormat | 'legacy_freeform';
  providerState?: never;
};
export type BuildProviderHistoryCompactCheckpointInput = BuildHistoryCompactCheckpointBaseInput & {
  providerState: HistoryCompactProviderState;
  summary?: never;
  summaryFormat?: never;
};
export type BuildHistoryCompactCheckpointInput =
  | BuildTextHistoryCompactCheckpointInput
  | BuildProviderHistoryCompactCheckpointInput;

export type HistoryCompactCheckpointPrefixMatch =
  | {
      coveredEventCount: number;
      coveredRuntimeEvents: RuntimeEvent[];
      successorRuntimeEvents: RuntimeEvent[];
      reason?: undefined;
    }
  | {
      coveredEventCount: 0;
      coveredRuntimeEvents: [];
      successorRuntimeEvents: [];
      reason: 'invalid_checkpoint' | 'coverage_miss' | 'source_hash_mismatch';
    };

export function buildHistoryCompactCheckpoint(
  input: BuildTextHistoryCompactCheckpointInput,
): TextHistoryCompactCheckpoint;
export function buildHistoryCompactCheckpoint(
  input: BuildProviderHistoryCompactCheckpointInput,
): ProviderHistoryCompactCheckpoint;
export function buildHistoryCompactCheckpoint(
  input: BuildHistoryCompactCheckpointInput,
): HistoryCompactCheckpoint;
export function buildHistoryCompactCheckpoint(
  input: BuildHistoryCompactCheckpointInput,
): HistoryCompactCheckpoint {
  if (input.coveredRuntimeEvents.length === 0) {
    throw new Error('History compact checkpoint requires covered RuntimeEvents');
  }
  if (input.coveredRuntimeEvents.some((event) => event.sessionId !== input.sessionId)) {
    throw new Error('History compact checkpoint source events must belong to one session');
  }
  // A partial streaming snapshot is later replaced or deleted in the durable
  // ledger, so a digest over it can never replay: coverage must be immutable.
  if (input.coveredRuntimeEvents.some((event) => event.partial === true)) {
    throw new Error('History compact checkpoint coverage must not include partial events');
  }
  const providerState = 'providerState' in input ? input.providerState : undefined;
  const version = providerState ? 3 : 2;
  const summary = typeof input.summary === 'string' ? input.summary.trim() : undefined;
  if (!providerState && (!summary || summary.length === 0)) {
    throw new Error('History compact checkpoint requires a non-empty summary');
  }
  if (providerState && !validHistoryCompactProviderState(providerState)) {
    throw new Error('History compact checkpoint requires valid provider compaction state');
  }
  // The sectioned marker is proof that the complete predicate held, so only
  // this builder assigns it — and only after re-checking structure and
  // truncation at every construction seam, including copy. The size floor is
  // the summarizer's own check: it needs the provider's usage for the call,
  // which no construction seam has. A caller with unvalidated free-form text
  // must declare `legacy_freeform` instead of minting trust it did not earn.
  if (!providerState && input.summaryFormat !== 'legacy_freeform') {
    const defect = findCheckpointSummaryDefect(summary!);
    if (defect) {
      throw new Error(`History compact checkpoint summary failed validation: ${defect}`);
    }
  }
  // A mid_turn checkpoint folds a prefix that reaches into the current turn, so
  // its head anchor MUST be one of the covered events — the projection re-renders
  // that exact event verbatim after the block, and coverage stays contiguous.
  const phase: HistoryCompactCheckpointPhase | undefined =
    input.phase === 'mid_turn' ? 'mid_turn' : undefined;
  let headAnchor: HistoryCompactCheckpointHeadAnchor | undefined;
  if (phase === 'mid_turn') {
    if (!input.headAnchor) {
      throw new Error('Mid-turn history compact checkpoint requires a head anchor');
    }
    const anchored = input.coveredRuntimeEvents.find(
      (event) => event.id === input.headAnchor!.runtimeEventId,
    );
    if (!anchored) {
      throw new Error(
        'Mid-turn history compact checkpoint head anchor must be a covered RuntimeEvent',
      );
    }
    // The anchor is re-rendered verbatim as the compacted turn's user message.
    // The compacted turn is the one the coverage reaches into — the LAST
    // covered event's turn — so the anchor must be that turn's user event. A
    // self-consistent anchor resolving to some other covered user event (e.g.
    // a prior turn's prompt) would silently drop the real current prompt from
    // the replay, so the protocol fails closed at build time.
    const lastCovered = input.coveredRuntimeEvents.at(-1)!;
    if (
      anchored.turnId !== input.headAnchor.turnId ||
      anchored.turnId !== lastCovered.turnId ||
      anchored.role !== 'user' ||
      anchored.author !== 'user'
    ) {
      throw new Error(
        "Mid-turn history compact checkpoint head anchor must be the compacted turn's user event",
      );
    }
    headAnchor = {
      runtimeEventId: input.headAnchor.runtimeEventId,
      turnId: input.headAnchor.turnId,
    };
  }
  const charsPerToken = input.charsPerToken ?? 4;
  const lastEvent = input.coveredRuntimeEvents.at(-1)!;
  const createdAt = input.coveredRuntimeEvents.reduce(
    (latest, event) => Math.max(latest, event.ts),
    input.now ?? 1,
  );
  const coverage: HistoryCompactCheckpointCoverage = {
    eventCount: input.coveredRuntimeEvents.length,
    turnCount: new Set(input.coveredRuntimeEvents.map((event) => event.turnId)).size,
    through: {
      runId: lastEvent.runId,
      turnId: lastEvent.turnId,
      runtimeEventId: lastEvent.id,
    },
    sourceDigest: historyCompactSourceDigest(input.coveredRuntimeEvents),
  };
  const highWaterName = input.highWaterName ?? 'history-compact-high-water';
  const highWaterSeq = input.highWaterSeq ?? createdAt;
  const source = historyCompactCheckpointSource(input.sessionId, input.coveredRuntimeEvents);
  const checkpointId = `hcheckpoint-${sha256(
    stableStringify({
      version,
      sessionId: input.sessionId,
      highWaterName,
      highWaterSeq,
      source,
      coverage,
      ...(summary !== undefined ? { summary } : {}),
      ...(providerState ? { providerState } : {}),
      previousCheckpointId: input.previousCheckpointId,
      // Only hash the phase/anchor when set so pre_turn checkpoint ids stay stable.
      ...(phase ? { phase, headAnchor } : {}),
      ...(input.memoryExtractionBoundary
        ? { memoryExtractionBoundary: input.memoryExtractionBoundary }
        : {}),
    }),
  ).slice(0, 32)}`;
  const common = {
    kind: 'maka.history_compact_checkpoint' as const,
    checkpointId,
    sessionId: input.sessionId,
    createdAt,
    highWaterName,
    highWaterSeq,
    source,
    coverage,
    ...(phase ? { phase } : {}),
    ...(headAnchor ? { headAnchor } : {}),
    ...(input.memoryExtractionBoundary
      ? { memoryExtractionBoundary: { ...input.memoryExtractionBoundary } }
      : {}),
    limitations: providerState
      ? [
          'Provider-native replay state for the covered RuntimeEvent prefix.',
          'RuntimeEvent ledger remains the source of truth when exact wording matters.',
        ]
      : [
          'Replay-time summary of the covered RuntimeEvent prefix.',
          'RuntimeEvent ledger remains the source of truth when exact wording matters.',
        ],
    estimatedTokens: 0,
    ...(input.previousCheckpointId ? { previousCheckpointId: input.previousCheckpointId } : {}),
  };
  const checkpoint: HistoryCompactCheckpoint = providerState
    ? { ...common, version: 3, providerState }
    : {
        ...common,
        version: 2,
        summary: summary!,
        ...(input.summaryFormat === 'legacy_freeform'
          ? {}
          : { summaryFormat: SECTIONED_SUMMARY_FORMAT }),
      };
  checkpoint.estimatedTokens = estimateTokens(
    isProviderHistoryCompactCheckpoint(checkpoint)
      ? JSON.stringify(historyCompactCheckpointToModelMessage(checkpoint)).length
      : renderHistoryCompactCheckpoint(checkpoint).length,
    charsPerToken,
  );
  return checkpoint;
}

export function renderHistoryCompactCheckpoint(checkpoint: TextHistoryCompactCheckpoint): string {
  return [
    `<maka_history_compact_checkpoint id="${escapeAttribute(checkpoint.checkpointId)}" high_water="${escapeAttribute(checkpoint.highWaterName)}" seq="${checkpoint.highWaterSeq}" version="${checkpoint.version}">`,
    `summary: ${checkpoint.summary}`,
    `coverage: ${checkpoint.coverage.eventCount} runtime events across ${checkpoint.coverage.turnCount} turns`,
    ...(checkpoint.source
      ? [
          `source: ${checkpoint.source.policyVersion} ${checkpoint.source.coverage.lowWater?.sequence ?? 0}-${checkpoint.source.coverage.highWater.sequence}`,
        ]
      : []),
    `limitations: ${checkpoint.limitations.join('; ')}`,
    '</maka_history_compact_checkpoint>',
  ].join('\n');
}

export function historyCompactCheckpointToModelMessage(
  checkpoint: ProviderHistoryCompactCheckpoint,
): ModelMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'custom',
        kind: 'openai.compaction',
        providerOptions: {
          openai: {
            itemId: checkpoint.providerState.itemId,
            encryptedContent: checkpoint.providerState.encryptedContent,
          },
        },
      },
    ],
  };
}

export function isProviderHistoryCompactCheckpoint(
  checkpoint: HistoryCompactCheckpoint,
): checkpoint is ProviderHistoryCompactCheckpoint {
  return checkpoint.version === 3;
}

export function isTextHistoryCompactCheckpoint(
  checkpoint: HistoryCompactCheckpoint,
): checkpoint is TextHistoryCompactCheckpoint {
  return checkpoint.version === 2;
}

export function canReplayHistoryCompactCheckpointForModel(
  checkpoint: HistoryCompactCheckpoint,
  connection: { providerType: string },
  connectionId: string | undefined,
  modelId: string,
): boolean {
  if (!isProviderHistoryCompactCheckpoint(checkpoint)) return true;
  return (
    connection.providerType === 'openai-codex' &&
    connectionId !== undefined &&
    checkpoint.providerState.connectionId === connectionId &&
    checkpoint.providerState.modelId === modelId
  );
}

/** Whether this model's configured compactor can roll forward from this checkpoint value. */
export function canContinueHistoryCompactCheckpointForModel(
  checkpoint: HistoryCompactCheckpoint,
  connection: { providerType: string },
  connectionId: string | undefined,
  modelId: string,
): boolean {
  if (isTextHistoryCompactCheckpoint(checkpoint)) {
    return connection.providerType !== 'openai-codex';
  }
  return canReplayHistoryCompactCheckpointForModel(checkpoint, connection, connectionId, modelId);
}

export function historyCompactCheckpointToRuntimeEvent(
  checkpoint: TextHistoryCompactCheckpoint,
): RuntimeEvent {
  return {
    id: `history-compact:${checkpoint.checkpointId}`,
    sessionId: checkpoint.sessionId,
    runId: `history-compact:${checkpoint.checkpointId}`,
    turnId: `history-compact:${checkpoint.highWaterSeq}`,
    invocationId: `history-compact:${checkpoint.checkpointId}`,
    ts: checkpoint.createdAt,
    partial: false,
    role: 'user',
    author: 'system',
    content: { kind: 'text', text: renderHistoryCompactCheckpoint(checkpoint) },
  };
}

export function validateHistoryCompactCheckpointShape(
  value: unknown,
  sessionId?: string,
): value is HistoryCompactCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<HistoryCompactCheckpoint>;
  const coverage = checkpoint.coverage as Partial<HistoryCompactCheckpointCoverage> | undefined;
  const through = coverage?.through as
    | Partial<HistoryCompactCheckpointCoverage['through']>
    | undefined;
  return (
    checkpoint.kind === 'maka.history_compact_checkpoint' &&
    (checkpoint.version === 2 || checkpoint.version === 3) &&
    nonEmpty(checkpoint.checkpointId) &&
    nonEmpty(checkpoint.sessionId) &&
    (sessionId === undefined || checkpoint.sessionId === sessionId) &&
    Number.isFinite(checkpoint.createdAt) &&
    nonEmpty(checkpoint.highWaterName) &&
    Number.isFinite(checkpoint.highWaterSeq) &&
    Number.isInteger(coverage?.eventCount) &&
    (coverage?.eventCount ?? 0) > 0 &&
    Number.isInteger(coverage?.turnCount) &&
    (coverage?.turnCount ?? 0) > 0 &&
    nonEmpty(through?.runId) &&
    nonEmpty(through?.turnId) &&
    nonEmpty(through?.runtimeEventId) &&
    nonEmpty(coverage?.sourceDigest) &&
    (checkpoint.source === undefined ||
      validHistoryCompactCheckpointSource(checkpoint.source, checkpoint.sessionId, coverage)) &&
    (checkpoint.phase === undefined ||
      checkpoint.phase === 'pre_turn' ||
      checkpoint.phase === 'mid_turn') &&
    (checkpoint.phase !== 'mid_turn' ||
      (!!checkpoint.headAnchor &&
        nonEmpty(checkpoint.headAnchor.runtimeEventId) &&
        nonEmpty(checkpoint.headAnchor.turnId))) &&
    (checkpoint.headAnchor === undefined ||
      (nonEmpty(checkpoint.headAnchor.runtimeEventId) && nonEmpty(checkpoint.headAnchor.turnId))) &&
    (checkpoint.memoryExtractionBoundary === undefined ||
      (nonEmpty(checkpoint.memoryExtractionBoundary.runId) &&
        nonEmpty(checkpoint.memoryExtractionBoundary.turnId) &&
        nonEmpty(checkpoint.memoryExtractionBoundary.runtimeEventId) &&
        (checkpoint.memoryExtractionBoundary.disposition === undefined ||
          checkpoint.memoryExtractionBoundary.disposition === 'eligible' ||
          checkpoint.memoryExtractionBoundary.disposition === 'policy_denied'))) &&
    Array.isArray(checkpoint.limitations) &&
    checkpoint.limitations.every(nonEmpty) &&
    Number.isFinite(checkpoint.estimatedTokens) &&
    (checkpoint.estimatedTokens ?? -1) >= 0 &&
    (checkpoint.previousCheckpointId === undefined || nonEmpty(checkpoint.previousCheckpointId)) &&
    (checkpoint.version === 2
      ? typeof checkpoint.summary === 'string' &&
        checkpoint.summary.trim().length > 0 &&
        // Absent = legacy free-form; a present marker must be one this code
        // understands, so an unknown future format fails closed to the
        // canonical-events repair path instead of replaying unvalidated.
        ((checkpoint as Partial<TextHistoryCompactCheckpoint>).summaryFormat === undefined ||
          (checkpoint as Partial<TextHistoryCompactCheckpoint>).summaryFormat ===
            SECTIONED_SUMMARY_FORMAT) &&
        !('providerState' in checkpoint)
      : !('summary' in checkpoint) &&
        validHistoryCompactProviderState(
          (checkpoint as Partial<ProviderHistoryCompactCheckpoint>).providerState,
        ))
  );
}

/** Accept forward progress, or a compare-and-swap rewrite of the exact same source coverage. */
/**
 * A recorded checkpoint that this Runtime no longer holds to its own contract
 * because it was minted under an older source policy — not a corrupt record.
 * Every consumer already fails open on it (compaction re-summarizes, copy
 * drops it); diagnostics use this to say so instead of crying corruption.
 */
export function isSupersededHistoryCompactCheckpoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<HistoryCompactCheckpoint>;
  const policyVersion = checkpoint.source?.policyVersion as unknown;
  return (
    checkpoint.kind === 'maka.history_compact_checkpoint' &&
    typeof policyVersion === 'string' &&
    policyVersion !== HISTORY_COMPACT_SOURCE_POLICY_VERSION
  );
}

export function canReplaceHistoryCompactCheckpoint(
  current: HistoryCompactCheckpoint | undefined,
  candidate: HistoryCompactCheckpoint,
): boolean {
  if (current?.source && !candidate.source) return false;
  if (
    current?.source &&
    candidate.source &&
    !sameHistoryCompactSourceStream(current.source, candidate.source)
  ) {
    return false;
  }
  if (!current || candidate.coverage.eventCount > current.coverage.eventCount) return true;
  if (
    candidate.coverage.eventCount !== current.coverage.eventCount ||
    candidate.previousCheckpointId !== current.checkpointId
  ) {
    return false;
  }
  return (
    candidate.coverage.turnCount === current.coverage.turnCount &&
    candidate.coverage.sourceDigest === current.coverage.sourceDigest &&
    candidate.coverage.through.runId === current.coverage.through.runId &&
    candidate.coverage.through.turnId === current.coverage.through.turnId &&
    candidate.coverage.through.runtimeEventId === current.coverage.through.runtimeEventId &&
    (!current.source || sameHistoryCompactSourceCoverage(current.source, candidate.source))
  );
}

export function matchHistoryCompactCheckpointPrefix(
  checkpoint: HistoryCompactCheckpoint,
  events: readonly RuntimeEvent[],
): HistoryCompactCheckpointPrefixMatch {
  if (!validateHistoryCompactCheckpointShape(checkpoint)) {
    return {
      coveredEventCount: 0,
      coveredRuntimeEvents: [],
      successorRuntimeEvents: [],
      reason: 'invalid_checkpoint',
    };
  }
  const coveredRuntimeEvents = events.slice(0, checkpoint.coverage.eventCount);
  const successorRuntimeEvents = events.slice(checkpoint.coverage.eventCount);
  const firstEvent = coveredRuntimeEvents[0];
  const lastEvent = coveredRuntimeEvents.at(-1);
  if (
    coveredRuntimeEvents.length !== checkpoint.coverage.eventCount ||
    coveredRuntimeEvents.some((event) => event.sessionId !== checkpoint.sessionId) ||
    !firstEvent ||
    !lastEvent ||
    lastEvent.runId !== checkpoint.coverage.through.runId ||
    lastEvent.turnId !== checkpoint.coverage.through.turnId ||
    lastEvent.id !== checkpoint.coverage.through.runtimeEventId
  ) {
    return {
      coveredEventCount: 0,
      coveredRuntimeEvents: [],
      successorRuntimeEvents: [],
      reason: 'coverage_miss',
    };
  }
  if (
    checkpoint.source &&
    (checkpoint.source.coverage.lowWater?.eventId !== firstEvent.id ||
      checkpoint.source.coverage.highWater.eventId !== lastEvent.id)
  ) {
    return {
      coveredEventCount: 0,
      coveredRuntimeEvents: [],
      successorRuntimeEvents: [],
      reason: 'coverage_miss',
    };
  }
  // A mid_turn checkpoint's replay re-renders the head anchor verbatim, so a
  // corrupted anchor reference must fail the match closed here — otherwise the
  // projection would silently drop the compacted turn's user message.
  // The compacted turn is the coverage's `through` turn, so the anchor must be
  // THAT turn's user event — not merely any self-consistent covered user event
  // (e.g. a prior turn's prompt).
  if (checkpoint.phase === 'mid_turn') {
    const anchor = coveredRuntimeEvents.find(
      (event) => event.id === checkpoint.headAnchor!.runtimeEventId,
    );
    if (
      !anchor ||
      anchor.turnId !== checkpoint.headAnchor!.turnId ||
      anchor.turnId !== checkpoint.coverage.through.turnId ||
      anchor.role !== 'user' ||
      anchor.author !== 'user'
    ) {
      return {
        coveredEventCount: 0,
        coveredRuntimeEvents: [],
        successorRuntimeEvents: [],
        reason: 'coverage_miss',
      };
    }
  }
  if (historyCompactSourceDigest(coveredRuntimeEvents) !== checkpoint.coverage.sourceDigest) {
    return {
      coveredEventCount: 0,
      coveredRuntimeEvents: [],
      successorRuntimeEvents: [],
      reason: 'source_hash_mismatch',
    };
  }
  return {
    coveredEventCount: coveredRuntimeEvents.length,
    coveredRuntimeEvents,
    successorRuntimeEvents,
  };
}

/**
 * Deterministic RuntimeEvent projection for a checkpoint. V2 prepends its
 * text block; V3 stays out of the event list and is materialized directly at
 * the provider boundary. A `mid_turn` checkpoint re-inserts the covered head
 * anchor verbatim so the current user message stays exact. `coveredRuntimeEvents`
 * are the raw events matched by `matchHistoryCompactCheckpointPrefix`.
 */
export function projectHistoryCompactCheckpointReplay(
  checkpoint: HistoryCompactCheckpoint,
  coveredRuntimeEvents: readonly RuntimeEvent[],
  replayTail: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const anchor = midTurnHeadAnchorEvent(checkpoint, coveredRuntimeEvents);
  const tail = anchor ? [anchor, ...replayTail] : [...replayTail];
  return isTextHistoryCompactCheckpoint(checkpoint)
    ? [historyCompactCheckpointToRuntimeEvent(checkpoint), ...tail]
    : tail;
}

/** The covered head anchor event for a mid_turn checkpoint, or undefined. */
export function midTurnHeadAnchorEvent(
  checkpoint: HistoryCompactCheckpoint,
  coveredRuntimeEvents: readonly RuntimeEvent[],
): RuntimeEvent | undefined {
  if (checkpoint.phase !== 'mid_turn' || !checkpoint.headAnchor) return undefined;
  return coveredRuntimeEvents.find((event) => event.id === checkpoint.headAnchor!.runtimeEventId);
}

function historyCompactCheckpointSource(
  sessionId: string,
  events: readonly RuntimeEvent[],
): HistoryCompactCheckpointSource {
  const first = events[0]!;
  const last = events.at(-1)!;
  return {
    schemaVersion: 1,
    kind: 'runtime_event_projection',
    policyVersion: HISTORY_COMPACT_SOURCE_POLICY_VERSION,
    coverage: {
      lowWater: {
        ledger: 'runtime_event_projection',
        streamId: sessionId,
        sequence: 0,
        eventId: first.id,
      },
      highWater: {
        ledger: 'runtime_event_projection',
        streamId: sessionId,
        sequence: events.length - 1,
        eventId: last.id,
      },
      eventCount: events.length,
    },
  };
}

function validHistoryCompactCheckpointSource(
  source: HistoryCompactCheckpointSource,
  sessionId: string | undefined,
  legacyCoverage: Partial<HistoryCompactCheckpointCoverage> | undefined,
): boolean {
  const low = source.coverage?.lowWater;
  const high = source.coverage?.highWater;
  return (
    source.schemaVersion === 1 &&
    source.kind === 'runtime_event_projection' &&
    source.policyVersion === HISTORY_COMPACT_SOURCE_POLICY_VERSION &&
    low?.ledger === 'runtime_event_projection' &&
    high?.ledger === 'runtime_event_projection' &&
    low.streamId === sessionId &&
    high.streamId === sessionId &&
    low.sequence === 0 &&
    Number.isSafeInteger(high.sequence) &&
    high.sequence === (legacyCoverage?.eventCount ?? 0) - 1 &&
    source.coverage.eventCount === legacyCoverage?.eventCount &&
    nonEmpty(low.eventId) &&
    nonEmpty(high.eventId) &&
    high.eventId === legacyCoverage?.through?.runtimeEventId
  );
}

function sameHistoryCompactSourceStream(
  current: HistoryCompactCheckpointSource,
  candidate: HistoryCompactCheckpointSource,
): boolean {
  return (
    current.policyVersion === candidate.policyVersion &&
    current.coverage.highWater.ledger === candidate.coverage.highWater.ledger &&
    current.coverage.highWater.streamId === candidate.coverage.highWater.streamId
  );
}

function sameHistoryCompactSourceCoverage(
  current: HistoryCompactCheckpointSource,
  candidate: HistoryCompactCheckpointSource | undefined,
): boolean {
  return Boolean(
    candidate &&
      sameHistoryCompactSourceStream(current, candidate) &&
      current.coverage.lowWater?.sequence === candidate.coverage.lowWater?.sequence &&
      current.coverage.lowWater?.eventId === candidate.coverage.lowWater?.eventId &&
      current.coverage.highWater.sequence === candidate.coverage.highWater.sequence &&
      current.coverage.highWater.eventId === candidate.coverage.highWater.eventId &&
      current.coverage.eventCount === candidate.coverage.eventCount,
  );
}

/**
 * A checkpoint replaces a contiguous prefix of EFFECTIVE model history, so its
 * source digest must pin exactly that: raw execution evidence a durable
 * projection already bounded or redacted is not part of what was folded, and
 * changing it must not invalidate a valid checkpoint. Conversely, replacing a
 * response's effective projection does change the digest, so a checkpoint can
 * never be replayed over content it never covered.
 */
function historyCompactSourceDigest(events: readonly RuntimeEvent[]): string {
  const hash = createHash('sha256');
  for (const event of events) {
    const serialized = stableStringify(effectiveDigestEvent(event));
    hash.update(String(Buffer.byteLength(serialized, 'utf8')));
    hash.update(':');
    hash.update(serialized);
    hash.update(';');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Selects the persisted field that carries a response's model-visible content,
 * dropping the others. This is a structural choice over durable data only —
 * never a code-derived materialization — so the digest of an already-persisted
 * checkpoint cannot drift when a projector, a codec bound, or a placeholder
 * string changes. A response with no durable projection (legacy, or
 * provider-native) keeps the raw field its effective content is still derived
 * from, which is what the pre-projection digest already hashed.
 */
function effectiveDigestEvent(event: RuntimeEvent): unknown {
  const content = event.content;
  if (content?.kind !== 'function_response') return event;
  const { result, providerOutput, modelProjection, ...identity } = content;
  if (content.providerExecuted && providerOutput !== undefined) {
    return { ...event, content: { ...identity, providerOutput } };
  }
  if (modelProjection !== undefined) {
    return { ...event, content: { ...identity, modelProjection } };
  }
  return { ...event, content: { ...identity, result } };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validHistoryCompactProviderState(value: unknown): value is HistoryCompactProviderState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<HistoryCompactProviderState>;
  return (
    state.kind === 'openai_codex_remote_v2' &&
    nonEmpty(state.connectionId) &&
    nonEmpty(state.modelId) &&
    nonEmpty(state.itemId) &&
    nonEmpty(state.encryptedContent)
  );
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function estimateTokens(charCount: number, charsPerToken: number): number {
  if (charCount <= 0) return 0;
  return Math.max(1, Math.ceil(charCount / Math.max(1, charsPerToken)));
}
