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
  estimateTokens,
  estimateRuntimeEventsTokens,
  stableJsonLength,
  turnKey,
  groupEventsByTurn,
  finitePositive,
} from './context-budget-helpers.js';

// Public re-export surface for @maka/runtime consumers. Explicit list keeps
// the ./context-budget subpath from leaking leaf-internal collaboration symbols.
export { estimateRuntimeEventsTokens, estimateTokens } from './context-budget-helpers.js';
export {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  isArchivedToolResultPlaceholder,
  deserializeToolResultArchive,
  retrieveArchivedToolResultsForReplay,
  serializeToolResultForArchive,
} from './tool-result-archive.js';
export type {
  ArchiveRetrievalMode,
  ArchiveRetrievalPolicy,
  ArchiveRetrievalResult,
  StaleToolResultPrunePolicy,
  StaleToolResultArchiveCandidate,
  ToolResultArchiveReader,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadFailureReason,
  ToolResultArchiveReadResult,
  ToolResultArchiveRef,
  ArchivedToolResultPlaceholder,
} from './tool-result-archive.js';
export type { ArchivedToolResultReason, SynthesisSourceRef } from './context-source-ref.js';
export {
  retrieveRuntimeEventHistoryAround,
  searchRuntimeEventHistory,
} from './runtime-event-history-search.js';
export type {
  RuntimeEventHistoryAroundResult,
  RuntimeEventHistorySearchHit,
  RuntimeEventHistorySearchPolicy,
} from './runtime-event-history-search.js';
export {
  buildSynthesisCacheBlocksFromHydratedArchives,
  deriveSynthesisCoverageFromSourceRefs,
  rawEvidenceRequestReason,
  stableSynthesisBlockId,
  validateSynthesisCacheBlockShape,
} from './synthesis-cache.js';
export type {
  SynthesisCacheBlock,
  SynthesisCacheCoverage,
  SynthesisCachePolicy,
} from './synthesis-cache.js';
export {
  buildHistoryCompactBlockFromSummary,
  historyCompactBlockToRuntimeEvent,
  renderHistoryCompactBlock,
  validateHistoryCompactBlockShape,
} from './history-compact.js';
export type {
  HistoryCompactBlock,
  HistoryCompactCoverage,
  HistoryCompactMidTurnPolicy,
  HistoryCompactPolicy,
  HistoryCompactReplayResult,
  HistoryCompactSourceArchiveRef,
  HistoryRewriteGatePolicy,
} from './history-compact.js';
export { ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND } from './active-tool-result-prune.js';
export type { ActiveArchivedToolResultPlaceholder } from './active-tool-result-prune.js';

import { SynthesisCachePolicy } from './synthesis-cache.js';
import {
  searchRuntimeEventHistory,
  type RuntimeEventHistoryAroundResult,
  type RuntimeEventHistorySearchPolicy,
} from './runtime-event-history-search.js';
import {
  ArchiveRetrievalPolicy,
  collectStaleToolResultArchiveCandidates as collectStaleToolResultArchiveCandidatesNarrow,
  pruneStaleToolResultsBeforeCompact,
  type StaleToolResultPrunePolicy,
  type StaleToolResultArchiveCandidate,
} from './tool-result-archive.js';
import { isValidSynthesisSourceRef, type SynthesisSourceRef } from './context-source-ref.js';
import { type ActiveToolResultPrunePolicy } from './active-tool-result-prune.js';
import {
  applyRuntimeEventHistoryCompact as applyRuntimeEventHistoryCompactNarrow,
  evaluateHistoryCompactCheckpointReplay as evaluateHistoryCompactCheckpointReplayNarrow,
  isHistoryCompactContentEvent,
  type HistoryCompactBlock,
  type HistoryCompactPolicy,
  type HistoryCompactReplayOptions,
  type HistoryCompactReplayResult,
  type HistoryCompactCheckpointReplayFit,
  type HistoryRewriteGatePolicy,
} from './history-compact.js';

import type { ModelMessage } from './model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  CompactionDecisionDiagnostic,
  ContextBudgetDiagnostic,
  PromptSegmentEstimate,
} from '@maka/core/usage-stats/types';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
import type { SemanticCompactPolicy } from './semantic-compact.js';
import {
  historyCompactCheckpointToRuntimeEvent,
  matchHistoryCompactCheckpointPrefix,
  midTurnHeadAnchorEvent,
  renderHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';

export interface ContextBudgetPolicy {
  name?: string;
  /**
   * Approximate max model-visible prior-history tokens. This is an estimate
   * used for shaping, not provider billing.
   */
  maxHistoryEstimatedTokens?: number;
  /** Hard cap on prior turns retained for model replay. */
  maxHistoryTurns?: number;
  /** Keep at least this many recent turns even if the token estimate exceeds the cap. */
  minRecentTurns?: number;
  /** Estimate conversion. Defaults to 4 chars/token, intentionally conservative for mixed text. */
  charsPerToken?: number;
  /** Optional replay-only pruning for stale oversized tool results before whole-turn compaction. */
  staleToolResultPrune?: StaleToolResultPrunePolicy;
  /**
   * Optional current-turn, provider-visible tool-result pruning before the next
   * AI SDK step. Defaults off and does not mutate persisted session messages.
   */
  activeToolResultPrune?: ActiveToolResultPrunePolicy;
  /**
   * Optional current-turn LLM semantic compact replacement. Runs after active
   * tool-result pruning and before the next provider step.
   */
  semanticCompact?: SemanticCompactPolicy;
  /** Optional replay-only archive hydration after pruning. Defaults off. */
  archiveRetrieval?: ArchiveRetrievalPolicy;
  /** Optional deterministic prior-history search used to re-add bounded around-context. Defaults off. */
  historySearch?: RuntimeEventHistorySearchPolicy;
  /** Optional replay-only source-bearing synthesis cache over older RuntimeEvent history. Defaults off. */
  synthesisCache?: SynthesisCachePolicy;
  /** Optional replay-only high-water compaction of older RuntimeEvent history into a source-bearing block. */
  historyCompact?: HistoryCompactPolicy;
  /** Named rewrite/compaction gate for diagnostics and explicit cache-shape resets. */
  historyRewrite?: HistoryRewriteGatePolicy;
}

export interface BudgetedRuntimeContext {
  events: RuntimeEvent[];
  diagnostic: ContextBudgetDiagnostic;
  historyCompactBlocks?: HistoryCompactBlock[];
  /**
   * The checkpoint this projection was actually replayed through — present only
   * when it passed the prefix match and the replay fit, i.e. when these events
   * really are `[block, tail]` rather than the raw prefix.
   *
   * A loaded checkpoint that failed either gate is a checkpoint the caller
   * holds and the projection ignored; the two must not be confused by anyone
   * reporting what a prompt was built from (#2323).
   */
  historyCompactCheckpoint?: HistoryCompactCheckpoint;
}

export interface PromptSegmentInput {
  systemPrompt?: string;
  toolSchemaChars: number;
  toolCount: number;
  priorMessages: readonly ModelMessage[];
  priorRuntimeEventCount?: number;
  currentUserContent: string;
  turnTailPrompt?: string;
  charsPerToken?: number;
}

export function applyRuntimeEventContextBudget(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
  options: Pick<HistoryCompactReplayOptions, 'historyCompactProtocol'> = {},
): BudgetedRuntimeContext | undefined {
  const prunePolicy = policy?.staleToolResultPrune;
  const pruneEnabled = prunePolicy?.enabled === true;
  const archiveRetrievalEnabled = policy?.archiveRetrieval?.enabled === true;
  const historySearchEnabled = policy?.historySearch?.enabled === true;
  const synthesisCacheEnabled = policy?.synthesisCache?.enabled === true;
  const historyCompactEnabled = policy?.historyCompact?.enabled === true;
  const historyRewriteEnabled = policy?.historyRewrite?.enabled === true;
  const enabled = Boolean(
    policy?.maxHistoryEstimatedTokens ||
      policy?.maxHistoryTurns ||
      pruneEnabled ||
      archiveRetrievalEnabled ||
      historySearchEnabled ||
      synthesisCacheEnabled ||
      historyCompactEnabled ||
      historyRewriteEnabled,
  );
  if (!enabled) return undefined;
  if (!policy) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const maxTokens = finitePositive(policy?.maxHistoryEstimatedTokens);
  const maxTurns = finitePositive(policy?.maxHistoryTurns);
  const minRecentTurns = Math.max(0, Math.floor(policy?.minRecentTurns ?? 1));
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);
  const pruned = pruneStaleToolResultsBeforeCompact(
    events,
    policy?.staleToolResultPrune,
    charsPerToken,
    policy?.minRecentTurns,
  );
  const compacted = applyRuntimeEventHistoryCompactNarrow(
    pruned.events,
    policy?.historyCompact,
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    {
      charsPerToken,
      maxHistoryEstimatedTokens: maxTokens,
      ...(options.historyCompactProtocol
        ? { historyCompactProtocol: options.historyCompactProtocol }
        : {}),
    },
  );
  const hasCompactedReplay = compacted.blocks.length > 0 || compacted.checkpoint !== undefined;
  const budgetEvents = hasCompactedReplay ? compacted.events : pruned.events;
  const turnGroups = groupEventsByTurn(
    budgetEvents.filter(isHistoryCompactContentEvent),
    charsPerToken,
  );

  const keptTurnIds = new Set<string>();
  let keptEvents: RuntimeEvent[];
  if (hasCompactedReplay) {
    keptEvents = budgetEvents;
    for (const event of keptEvents) keptTurnIds.add(turnKey(event));
  } else {
    let keptTokens = 0;
    for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
      const group = turnGroups[index]!;
      const nextTurnCount = keptTurnIds.size + 1;
      const mustKeep = nextTurnCount <= minRecentTurns;
      const wouldExceedTurns = maxTurns !== undefined && nextTurnCount > maxTurns;
      const wouldExceedTokens =
        maxTokens !== undefined && keptTokens > 0 && keptTokens + group.estimatedTokens > maxTokens;
      if (!mustKeep && (wouldExceedTurns || wouldExceedTokens)) break;
      keptTurnIds.add(group.turnId);
      keptTokens += group.estimatedTokens;
    }
    keptEvents = budgetEvents.filter((event) => keptTurnIds.has(turnKey(event)));
  }

  const diagnostic: ContextBudgetDiagnostic = {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(maxTokens !== undefined ? { maxHistoryEstimatedTokens: maxTokens } : {}),
    ...(maxTurns !== undefined ? { maxHistoryTurns: maxTurns } : {}),
    estimatedTokensBefore,
    estimatedTokensAfter: estimateRuntimeEventsTokens(keptEvents, charsPerToken),
    keptTurns: keptTurnIds.size,
    droppedTurns: hasCompactedReplay
      ? compacted.blocks.reduce((total, block) => total + block.coverage.turnIds.length, 0) +
        (compacted.checkpoint?.coverage.turnCount ?? 0)
      : Math.max(0, turnGroups.length - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(
      0,
      (hasCompactedReplay ? pruned.events.length : budgetEvents.length) - keptEvents.length,
    ),
    ...(policy.historyRewrite?.enabled === true
      ? {
          historyRewriteVersion: policy.historyRewrite.historyRewriteVersion,
          historyRewriteResetReason: policy.historyRewrite.resetReason,
          historyRewriteGate: policy.historyRewrite.name ?? 'history-rewrite',
        }
      : {}),
    ...compacted.diagnosticPatch,
    ...(pruned.prunedToolResults > 0
      ? {
          prunedToolResults: pruned.prunedToolResults,
          prunedToolResultEstimatedTokensBefore: pruned.estimatedTokensBefore,
          prunedToolResultEstimatedTokensAfter: pruned.estimatedTokensAfter,
          archivePlaceholders: pruned.prunedToolResults,
          archivePlaceholderReasonCounts: {
            stale_tool_result_pruned_before_compact: pruned.prunedToolResults,
          },
        }
      : {}),
    ...(pruned.archiveWriteFailures > 0
      ? {
          archiveWriteFailures: pruned.archiveWriteFailures,
          unarchivedToolResults: pruned.archiveWriteFailures,
        }
      : {}),
  };
  return {
    events: keptEvents,
    diagnostic,
    ...(compacted.blocks.length > 0 ? { historyCompactBlocks: compacted.blocks } : {}),
    ...(compacted.checkpoint ? { historyCompactCheckpoint: compacted.checkpoint } : {}),
  };
}

export function hasOversizedRetainedHistoryTurn(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): boolean {
  const maxTokens = finitePositive(policy?.maxHistoryEstimatedTokens);
  if (maxTokens === undefined) return false;
  const charsPerToken = policy?.charsPerToken ?? 4;
  return groupEventsByTurn(events.filter(isHistoryCompactContentEvent), charsPerToken).some(
    (turn) => turn.estimatedTokens > maxTokens,
  );
}

export function buildPromptSegmentEstimates(input: PromptSegmentInput): PromptSegmentEstimate[] {
  const charsPerToken = input.charsPerToken ?? 4;
  return [
    segment('system_prompt', input.systemPrompt?.length ?? 0, charsPerToken),
    {
      ...segment('tool_schema', input.toolSchemaChars, charsPerToken),
      toolCount: input.toolCount,
    },
    {
      ...segment('prior_history', estimateModelMessagesChars(input.priorMessages), charsPerToken),
      messageCount: input.priorMessages.length,
      ...(input.priorRuntimeEventCount !== undefined
        ? { eventCount: input.priorRuntimeEventCount }
        : {}),
    },
    segment('current_user', input.currentUserContent.length, charsPerToken),
    segment('turn_tail', input.turnTailPrompt?.length ?? 0, charsPerToken),
  ];
}

export function estimateModelMessagesChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateModelMessageChars(message), 0);
}

function estimateModelMessageChars(message: ModelMessage): number {
  const raw = message as unknown as { content?: unknown };
  return estimateContentChars(raw.content);
}

function estimateContentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + estimatePartChars(part), 0);
  }
  return stableJsonLength(content);
}

function estimatePartChars(part: unknown): number {
  if (!part || typeof part !== 'object') return stableJsonLength(part);
  const value = part as Record<string, unknown>;
  let total = 0;
  for (const key of ['text', 'toolName', 'toolCallId'] as const) {
    if (typeof value[key] === 'string') total += value[key].length;
  }
  for (const key of ['input', 'output'] as const) {
    if (value[key] !== undefined) total += stableJsonLength(value[key]);
  }
  return total;
}

function segment(
  kind: PromptSegmentEstimate['kind'],
  chars: number,
  charsPerToken: number,
): PromptSegmentEstimate {
  return {
    kind,
    chars,
    estimatedTokens: estimateTokens(chars, charsPerToken),
  };
}

// finiteRatio / normalizeWhitespace / boundText relocated to context-budget-helpers.ts

// ============================================================================
// Replay ordering + context-budget diagnostic merge helpers.
// Relocated from ai-sdk-backend.ts: these are pure functions over
// RuntimeEvent / ContextBudgetDiagnostic and belong to this budgeting domain.
// ============================================================================

export function mergeRuntimeEventsInOriginalOrder(
  original: readonly RuntimeEvent[],
  current: readonly RuntimeEvent[],
  extra: readonly RuntimeEvent[],
): RuntimeEvent[] {
  const wantedIds = new Set<string>();
  const byId = new Map<string, RuntimeEvent>();
  for (const event of current) {
    wantedIds.add(event.id);
    byId.set(event.id, event);
  }
  for (const event of extra) {
    wantedIds.add(event.id);
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  const out: RuntimeEvent[] = [];
  for (const event of original) {
    if (!wantedIds.has(event.id)) continue;
    out.push(byId.get(event.id) ?? event);
  }
  return out;
}

export function buildContextBudgetDiagnosticShell(
  before: readonly RuntimeEvent[],
  after: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): ContextBudgetDiagnostic {
  const charsPerToken = policy?.charsPerToken ?? 4;
  const turnCountBefore = new Set(before.map((event) => runtimeEventTurnKey(event))).size;
  const turnCountAfter = new Set(after.map((event) => runtimeEventTurnKey(event))).size;
  return {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(policy?.maxHistoryEstimatedTokens !== undefined
      ? { maxHistoryEstimatedTokens: policy.maxHistoryEstimatedTokens }
      : {}),
    ...(policy?.maxHistoryTurns !== undefined ? { maxHistoryTurns: policy.maxHistoryTurns } : {}),
    estimatedTokensBefore: estimateRuntimeEventsTokens(before, charsPerToken),
    estimatedTokensAfter: estimateRuntimeEventsTokens(after, charsPerToken),
    keptTurns: turnCountAfter,
    droppedTurns: Math.max(0, turnCountBefore - turnCountAfter),
    keptEvents: after.length,
    droppedEvents: Math.max(0, before.length - after.length),
    ...(policy?.historyRewrite?.enabled === true
      ? {
          historyRewriteVersion: policy.historyRewrite.historyRewriteVersion,
          historyRewriteResetReason: policy.historyRewrite.resetReason,
          historyRewriteGate: policy.historyRewrite.name ?? 'history-rewrite',
        }
      : {}),
  };
}

export function runtimeEventTurnKey(event: RuntimeEvent): string {
  return event.turnId || '<unknown-turn>';
}

export function retrieveReplayHistoryAroundSearchSource(
  replayEvents: readonly RuntimeEvent[],
  searchEvents: readonly RuntimeEvent[],
  query: string,
  policy: RuntimeEventHistorySearchPolicy | undefined,
  options: { charsPerToken?: number } = {},
): RuntimeEventHistoryAroundResult {
  if (policy?.enabled !== true) {
    return { events: [], hits: [], diagnosticPatch: {} };
  }
  const charsPerToken = options.charsPerToken ?? 4;
  const around = Math.max(0, Math.floor(policy.around ?? 1));
  const maxEstimatedTokens =
    typeof policy.maxEstimatedTokens === 'number' &&
    Number.isFinite(policy.maxEstimatedTokens) &&
    policy.maxEstimatedTokens > 0
      ? Math.floor(policy.maxEstimatedTokens)
      : 4_096;
  const hits = searchRuntimeEventHistory(searchEvents, policy.query ?? query, policy);
  const selectedIndexes = new Set<number>();
  const indexesByEventId = new Map(replayEvents.map((event, index) => [event.id, index]));
  let skipped = 0;
  for (const hit of hits) {
    const index = indexesByEventId.get(hit.eventId);
    if (index === undefined) {
      skipped += 1;
      continue;
    }
    for (
      let cursor = Math.max(0, index - around);
      cursor <= Math.min(replayEvents.length - 1, index + around);
      cursor += 1
    ) {
      selectedIndexes.add(cursor);
    }
  }

  const selectedEvents: RuntimeEvent[] = [];
  let selectedTokens = 0;
  for (const index of [...selectedIndexes].sort((a, b) => a - b)) {
    const event = replayEvents[index]!;
    const estimate = estimateRuntimeEventsTokens([event], charsPerToken);
    if (selectedTokens + estimate > maxEstimatedTokens) {
      skipped += 1;
      continue;
    }
    selectedEvents.push(event);
    selectedTokens += estimate;
  }

  return {
    events: selectedEvents,
    hits,
    diagnosticPatch: {
      historySearchMatches: hits.length,
      historyAroundRetrievedEvents: selectedEvents.length,
      historyAroundEstimatedTokens: selectedTokens,
      ...(skipped > 0 ? { historyAroundSkippedEvents: skipped } : {}),
    },
  };
}

export function buildHistorySearchSource(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): readonly RuntimeEvent[] {
  if (policy?.staleToolResultPrune?.enabled !== true) return events;
  return (
    applyRuntimeEventContextBudget(events, {
      ...policy,
      maxHistoryEstimatedTokens: undefined,
      maxHistoryTurns: undefined,
      archiveRetrieval: undefined,
      historySearch: undefined,
      historyRewrite: undefined,
    })?.events ?? events
  );
}

export function mergeContextBudgetDiagnostic(
  base: ContextBudgetDiagnostic,
  patch: Partial<ContextBudgetDiagnostic>,
): ContextBudgetDiagnostic {
  return {
    ...base,
    ...patch,
    ...mergeCountRecordField(
      'archiveRetrievalFailureReasonCounts',
      base.archiveRetrievalFailureReasonCounts,
      patch.archiveRetrievalFailureReasonCounts,
    ),
    ...mergeCountRecordField(
      'archiveRetrievalSkippedReasonCounts',
      base.archiveRetrievalSkippedReasonCounts,
      patch.archiveRetrievalSkippedReasonCounts,
    ),
    ...mergeCountRecordField(
      'synthesisCacheSkippedReasonCounts',
      base.synthesisCacheSkippedReasonCounts,
      patch.synthesisCacheSkippedReasonCounts,
    ),
    ...mergeCountRecordField(
      'synthesisCacheInvalidationReasonCounts',
      base.synthesisCacheInvalidationReasonCounts,
      patch.synthesisCacheInvalidationReasonCounts,
    ),
    ...mergeCountRecordField(
      'synthesisCacheLoadSkippedReasonCounts',
      base.synthesisCacheLoadSkippedReasonCounts,
      patch.synthesisCacheLoadSkippedReasonCounts,
    ),
    ...mergeCountRecordField(
      'synthesisCacheWriteSkippedReasonCounts',
      base.synthesisCacheWriteSkippedReasonCounts,
      patch.synthesisCacheWriteSkippedReasonCounts,
    ),
    ...mergeCountRecordField(
      'synthesisCacheEvictionReasonCounts',
      base.synthesisCacheEvictionReasonCounts,
      patch.synthesisCacheEvictionReasonCounts,
    ),
    ...mergeCountRecordField(
      'historyCompactSkippedReasonCounts',
      base.historyCompactSkippedReasonCounts,
      patch.historyCompactSkippedReasonCounts,
    ),
    ...mergeCountRecordField(
      'historyCompactLoadSkippedReasonCounts',
      base.historyCompactLoadSkippedReasonCounts,
      patch.historyCompactLoadSkippedReasonCounts,
    ),
    ...mergeCountRecordField(
      'historyCompactWriteSkippedReasonCounts',
      base.historyCompactWriteSkippedReasonCounts,
      patch.historyCompactWriteSkippedReasonCounts,
    ),
    ...mergeCompactionDecisionDiagnostics(base.compactionDecisions, patch.compactionDecisions),
  };
}

export function mergeContextBudgetDiagnosticPatches(
  left: Partial<ContextBudgetDiagnostic> | undefined,
  right: Partial<ContextBudgetDiagnostic> | undefined,
): Partial<ContextBudgetDiagnostic> | undefined {
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  return mergeContextBudgetDiagnostic(left as ContextBudgetDiagnostic, right);
}

export function shouldAppendContextCompactedNote(
  contextBudget: ContextBudgetDiagnostic | undefined,
): boolean {
  if ((contextBudget?.historyCompactBlocksWritten ?? 0) <= 0) return false;
  return (
    contextBudget?.compactionDecisions?.some(
      (decision) =>
        decision.stage === 'priorReplay' &&
        decision.boundaryKind === 'historyCompact' &&
        decision.decision === 'replaced',
    ) === true
  );
}

export function shouldAppendContextCompactionFailedOpenNote(
  contextBudget: ContextBudgetDiagnostic | undefined,
): boolean {
  return (
    (contextBudget?.historyCompactWriteFailures ?? 0) > 0 &&
    contextBudget?.compactionDecisions?.some(
      (decision) =>
        decision.stage === 'priorReplay' &&
        decision.boundaryKind === 'historyCompact' &&
        decision.decision === 'failedOpen',
    ) === true
  );
}

export function minimalContextBudgetDiagnostic(): ContextBudgetDiagnostic {
  return {
    enabled: true,
    estimatedTokensBefore: 0,
    estimatedTokensAfter: 0,
    keptTurns: 0,
    droppedTurns: 0,
    keptEvents: 0,
    droppedEvents: 0,
  };
}

function mergeCountRecords(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!left && !right) return undefined;
  const out: Record<string, number> = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function mergeCountRecordField<K extends keyof ContextBudgetDiagnostic>(
  key: K,
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): Pick<ContextBudgetDiagnostic, K> | Record<string, never> {
  const merged = mergeCountRecords(left, right);
  return merged === undefined ? {} : ({ [key]: merged } as Pick<ContextBudgetDiagnostic, K>);
}

function mergeCompactionDecisionDiagnostics(
  left: readonly CompactionDecisionDiagnostic[] | undefined,
  right: readonly CompactionDecisionDiagnostic[] | undefined,
): { compactionDecisions: CompactionDecisionDiagnostic[] } | Record<string, never> {
  if (!left && !right) return {};
  if (!right || right.length === 0) return { compactionDecisions: [...(left ?? [])] };
  const replacesHistoryCompact = right.some(
    (decision) => decision.stage === 'priorReplay' && decision.boundaryKind === 'historyCompact',
  );
  const retainedLeft = replacesHistoryCompact
    ? (left ?? []).filter(
        (decision) =>
          !(decision.stage === 'priorReplay' && decision.boundaryKind === 'historyCompact'),
      )
    : (left ?? []);
  return { compactionDecisions: [...retainedLeft, ...right] };
}

// Public compat wrappers: preserve the pre-split `(events, policy, options)`
// signature for @maka/runtime consumers. Internal callers (this module and
// ai-sdk-backend) import the narrow leaf API directly from the leaf modules.
export function collectStaleToolResultArchiveCandidates(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): StaleToolResultArchiveCandidate[] {
  return collectStaleToolResultArchiveCandidatesNarrow(
    events,
    policy?.staleToolResultPrune,
    policy?.charsPerToken ?? 4,
    policy?.minRecentTurns,
  );
}

export function applyRuntimeEventHistoryCompact(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
  options: HistoryCompactReplayOptions = {},
): HistoryCompactReplayResult {
  return applyRuntimeEventHistoryCompactNarrow(
    events,
    policy?.historyCompact,
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    options,
  );
}

export function evaluateHistoryCompactCheckpointReplay(
  checkpoint: HistoryCompactCheckpoint,
  replayTail: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
  options: HistoryCompactReplayOptions = {},
): HistoryCompactCheckpointReplayFit {
  return evaluateHistoryCompactCheckpointReplayNarrow(
    checkpoint,
    replayTail,
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    options,
  );
}
