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

import { estimateTokens, stableJsonLength } from './context-budget-helpers.js';
import { estimateRuntimeEventsTokens } from './model-history.js';

// Public re-export surface for @maka/runtime consumers. Explicit list keeps
// the ./context-budget subpath from leaking leaf-internal collaboration symbols.
export { estimateTokens } from './context-budget-helpers.js';
export { estimateRuntimeEventsTokens } from './model-history.js';
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
  ArchivedToolResultPlaceholder,
} from './tool-result-archive.js';
export type { ArchivedToolResultReason } from './tool-result-archive.js';
export type {
  HistoryCompactionPolicy,
  HistoryCompactionReplayResult,
} from './history-compaction.js';
import type { StaleToolResultPrunePolicy } from './tool-result-archive.js';
import { type ActiveToolResultPrunePolicy } from './active-tool-result-prune.js';
import {
  applyRuntimeEventHistoryCompact as applyRuntimeEventHistoryCompactNarrow,
  isHistoryCompactContentEvent,
  type HistoryCompactionPolicy,
  type HistoryCompactionReplayResult,
} from './history-compaction.js';

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  CompactionDecisionDiagnostic,
  ContextBudgetDiagnostic,
} from '@maka/core/usage-stats/types';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';

export interface ContextBudgetPolicy {
  name?: string;
  /**
   * Chars-per-token conversion for the CONTENT policies below (how large one
   * Tool Result may be before it is archived) and for diagnostics. It takes
   * part in no context-fit decision: whether a request fits is the provider's
   * answer (#4559). Defaults to 4.
   */
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
   * when the prefix matched and these events really are `[block, tail]` rather
   * than the raw prefix. Whether the resulting request fits is the provider's
   * decision.
   *
   * A loaded checkpoint whose prefix does not match is a checkpoint the caller
   * holds and the projection ignored; the two must not be confused by anyone
   * reporting what a prompt was built from (#2323).
   */
  historyCompactCheckpoint?: HistoryCompactCheckpoint;
}

export function applyRuntimeEventContextBudget(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): BudgetedRuntimeContext | undefined {
  const prunePolicy = policy?.staleToolResultPrune;
  const pruneEnabled = prunePolicy?.enabled === true;
  const historyCompactEnabled = policy?.historyCompact?.enabled === true;
  const enabled = pruneEnabled || historyCompactEnabled;
  if (!enabled) return undefined;
  if (!policy) return undefined;
  const charsPerToken = policy?.charsPerToken ?? 4;
  const estimatedTokensBefore = estimateRuntimeEventsTokens(events, charsPerToken);
  const compacted = applyRuntimeEventHistoryCompactNarrow(
    events,
    policy?.historyCompact,
    charsPerToken,
  );
  // Stale Tool Result pruning is no longer a step of the budget: it is a
  // durable projection transition committed before this projection runs, and
  // the events arriving here have already been folded through the reducer
  // (#4283). A second rewrite here could only disagree with the ledger about
  // what the model is allowed to see.
  const keptEvents = compacted.events;
  const keptTurnIds = new Set(keptEvents.map((event) => runtimeEventTurnKey(event)));
  const originalTurnIds = new Set(events.map((event) => runtimeEventTurnKey(event)));

  const diagnostic: ContextBudgetDiagnostic = {
    enabled: true,
    ...(policy?.name ? { policyName: policy.name } : {}),
    estimatedTokensBefore,
    estimatedTokensAfter: estimateRuntimeEventsTokens(keptEvents, charsPerToken),
    keptTurns: keptTurnIds.size,
    droppedTurns: Math.max(0, originalTurnIds.size - keptTurnIds.size),
    keptEvents: keptEvents.length,
    droppedEvents: Math.max(0, events.length - keptEvents.length),
    ...compacted.diagnosticPatch,
  };
  return {
    events: keptEvents,
    diagnostic,
    ...(compacted.checkpoint ? { historyCompactCheckpoint: compacted.checkpoint } : {}),
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

// A history fold reaches the user as one note per send, whichever stage
// performed it: the replay of an existing checkpoint at turn start
// (`priorReplay`) or a fold the request-projection hook made before a request
// of this send (`activeStep`, pre_turn or mid_turn). Since #4486 every new fold
// happens in the hook, so a note keyed on replay alone would arrive one turn
// late — the turn that was compacted would show nothing (#4559).
function hasHistoryCompactDecision(
  contextBudget: ContextBudgetDiagnostic | undefined,
  decision: 'replaced' | 'failedOpen',
): boolean {
  return (
    contextBudget?.compactionDecisions?.some(
      (candidate) =>
        (candidate.stage === 'priorReplay' || candidate.stage === 'activeStep') &&
        candidate.boundaryKind === 'historyCompact' &&
        candidate.decision === decision,
    ) === true
  );
}

export function shouldAppendContextCompactedNote(
  contextBudget: ContextBudgetDiagnostic | undefined,
): boolean {
  return hasHistoryCompactDecision(contextBudget, 'replaced');
}

export function shouldAppendContextCompactionFailedOpenNote(
  contextBudget: ContextBudgetDiagnostic | undefined,
): boolean {
  return hasHistoryCompactDecision(contextBudget, 'failedOpen');
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
export function applyRuntimeEventHistoryCompact(
  events: readonly RuntimeEvent[],
  policy: ContextBudgetPolicy | undefined,
): HistoryCompactionReplayResult {
  return applyRuntimeEventHistoryCompactNarrow(
    events,
    policy?.historyCompact,
    policy?.charsPerToken,
  );
}
