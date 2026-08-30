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
} from './context-budget-helpers.js';

// Public re-export surface for @maka/runtime consumers. Explicit list keeps
// the ./context-budget subpath from leaking leaf-internal collaboration symbols.
export { estimateRuntimeEventsTokens, estimateTokens } from './context-budget-helpers.js';
export {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  isArchivedToolResultPlaceholder,
  deserializeToolResultArchive,
  serializeToolResultForArchive,
} from './tool-result-archive.js';
export type {
  StaleToolResultPrunePolicy,
  StaleToolResultArchiveCandidate,
  ToolResultArchiveReader,
  ToolResultArchiveReaderInput,
  ToolResultArchiveReadFailureReason,
  ToolResultArchiveReadResult,
  ToolResultArchiveRef,
  ArchivedToolResultPlaceholder,
} from './tool-result-archive.js';
export type { ArchivedToolResultReason } from './tool-result-archive.js';
export type {
  HistoryCompactionPolicy,
  HistoryCompactionReplayResult,
} from './history-compaction.js';
export { ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND } from './active-tool-result-prune.js';
export type { ActiveArchivedToolResultPlaceholder } from './active-tool-result-prune.js';

import {
  collectStaleToolResultArchiveCandidates as collectStaleToolResultArchiveCandidatesNarrow,
  pruneStaleToolResultsBeforeCompact,
  type StaleToolResultPrunePolicy,
  type StaleToolResultArchiveCandidate,
} from './tool-result-archive.js';
import { type ActiveToolResultPrunePolicy } from './active-tool-result-prune.js';
import {
  applyRuntimeEventHistoryCompact as applyRuntimeEventHistoryCompactNarrow,
  evaluateHistoryCompactCheckpointReplay as evaluateHistoryCompactCheckpointReplayNarrow,
  isHistoryCompactContentEvent,
  type HistoryCompactionPolicy,
  type HistoryCompactionReplayOptions,
  type HistoryCompactionReplayResult,
  type HistoryCompactionCheckpointReplayFit,
} from './history-compaction.js';

import type { ModelMessage } from './model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  CompactionDecisionDiagnostic,
  ContextBudgetDiagnostic,
  PromptSegmentEstimate,
} from '@maka/core/usage-stats/types';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';

export interface ContextBudgetPolicy {
  name?: string;
  /**
   * Approximate max model-visible prior-history tokens. This is an estimate
   * used for shaping, not provider billing.
   */
  maxHistoryEstimatedTokens?: number;
  /** Estimate conversion. Defaults to 4 chars/token, intentionally conservative for mixed text. */
  charsPerToken?: number;
  /** Optional replay-only pruning for stale oversized tool results before whole-turn compaction. */
  staleToolResultPrune?: StaleToolResultPrunePolicy;
  /**
   * Optional current-turn, provider-visible tool-result pruning before the next
   * AI SDK step. Defaults off and does not mutate persisted session messages.
   */
  activeToolResultPrune?: ActiveToolResultPrunePolicy;
  /** Latest checkpoint projection and automatic capacity settings. */
  historyCompact?: HistoryCompactionPolicy;
}

export interface BudgetedRuntimeContext {
  events: RuntimeEvent[];
  diagnostic: ContextBudgetDiagnostic;
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
  charsPerToken?: number;
}

export function applyRuntimeEventContextBudget(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): BudgetedRuntimeContext | undefined {
  const prunePolicy = policy?.staleToolResultPrune;
  const pruneEnabled = prunePolicy?.enabled === true;
  const historyCompactEnabled = policy?.historyCompact?.enabled === true;
  const enabled = Boolean(
    policy?.maxHistoryEstimatedTokens || pruneEnabled || historyCompactEnabled,
  );
  if (!enabled) return undefined;
  if (!policy) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);
  const compacted = applyRuntimeEventHistoryCompactNarrow(
    events,
    policy?.historyCompact,
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    { charsPerToken },
  );
  const pruned = pruneStaleToolResultsBeforeCompact(
    compacted.events,
    policy?.staleToolResultPrune,
    charsPerToken,
  );
  const keptEvents = pruned.events;
  const keptTurnIds = new Set(keptEvents.map((event) => runtimeEventTurnKey(event)));
  const originalTurnIds = new Set(events.map((event) => runtimeEventTurnKey(event)));

  const diagnostic: ContextBudgetDiagnostic = {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    ...(policy.maxHistoryEstimatedTokens !== undefined
      ? { maxHistoryEstimatedTokens: policy.maxHistoryEstimatedTokens }
      : {}),
    estimatedTokensBefore,
    estimatedTokensAfter: estimateRuntimeEventsTokens(keptEvents, charsPerToken),
    keptTurns: keptTurnIds.size,
    droppedTurns: Math.max(0, originalTurnIds.size - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(0, events.length - keptEvents.length),
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
    ...(compacted.checkpoint ? { historyCompactCheckpoint: compacted.checkpoint } : {}),
  };
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
    estimatedTokensBefore: estimateRuntimeEventsTokens(before, charsPerToken),
    estimatedTokensAfter: estimateRuntimeEventsTokens(after, charsPerToken),
    keptTurns: turnCountAfter,
    droppedTurns: Math.max(0, turnCountBefore - turnCountAfter),
    keptEvents: after.length,
    droppedEvents: Math.max(0, before.length - after.length),
  };
}

export function runtimeEventTurnKey(event: RuntimeEvent): string {
  return event.turnId || '<unknown-turn>';
}

export function mergeContextBudgetDiagnostic(
  base: ContextBudgetDiagnostic,
  patch: Partial<ContextBudgetDiagnostic>,
): ContextBudgetDiagnostic {
  return {
    ...base,
    ...patch,
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
  );
}

export function applyRuntimeEventHistoryCompact(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
  options: HistoryCompactionReplayOptions = {},
): HistoryCompactionReplayResult {
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
  options: HistoryCompactionReplayOptions = {},
): HistoryCompactionCheckpointReplayFit {
  return evaluateHistoryCompactCheckpointReplayNarrow(
    checkpoint,
    replayTail,
    policy?.charsPerToken,
    policy?.maxHistoryEstimatedTokens,
    options,
  );
}
