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

import type {
  CacheMissInputSource,
  CompactionDecisionDiagnostic,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
} from './usage-stats/types.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalFiniteNumber,
  isOptionalString,
  isRecord,
  isStringArray,
  isStringNumberRecord,
} from './record-schema.js';

const PROMPT_SEGMENT_SHAPE = defineObjectShape<PromptSegmentEstimate>()(
  ['kind', 'chars', 'estimatedTokens'],
  ['messageCount', 'eventCount', 'toolCount'],
);

const COMPACTION_DECISION_SHAPE = defineObjectShape<CompactionDecisionDiagnostic>()(
  ['stage', 'sourceKind', 'decision'],
  [
    'phase',
    'boundaryKind',
    'boundaryIds',
    'coveredTurns',
    'coveredRuntimeEvents',
    'coveredToolCalls',
    'coveredProviderMessages',
    'coverageHashes',
    'estimatedTokensBefore',
    'estimatedTokensAfter',
    'estimatedTokensSaved',
    'candidateEstimatedTokens',
    'preservedHeadEstimatedTokens',
    'preservedTailEstimatedTokens',
    'acceptedProjectionEstimatedTokens',
    'compactCallInputTokens',
    'compactCallOutputTokens',
    'compactCallCacheReadInputTokens',
    'compactCallCacheWriteInputTokens',
    'compactCallTotalTokens',
    'reason',
    'failOpenReason',
    'skippedReasonCounts',
    'validationReasonCounts',
  ],
);

const CURRENT_CONTEXT_BUDGET_SHAPE = defineObjectShape<ContextBudgetDiagnostic>()(
  [
    'enabled',
    'estimatedTokensBefore',
    'estimatedTokensAfter',
    'keptTurns',
    'droppedTurns',
    'keptEvents',
    'droppedEvents',
  ],
  [
    'policyName',
    'maxHistoryEstimatedTokens',
    'prunedToolResults',
    'prunedToolResultEstimatedTokensBefore',
    'prunedToolResultEstimatedTokensAfter',
    'archivePlaceholders',
    'archiveWriteFailures',
    'unarchivedToolResults',
    'archivePlaceholderReasonCounts',
    'activePrunedToolResults',
    'activeSupersededToolResults',
    'activeDuplicateToolResults',
    'activeArchiveFailures',
    'activeEstimatedTokensSaved',
    'compactionDecisions',
  ],
);

/**
 * Keys written by retired context-budget implementations. They remain
 * accepted only so persisted usage records stay readable; current code cannot
 * produce them through ContextBudgetDiagnostic.
 */
const RETIRED_CONTEXT_BUDGET_KEYS = [
  'maxHistoryTurns',
  'semanticCompactEnabled',
  'semanticCompactMode',
  'archiveRetrievalMode',
  'archiveRetrievalEligibleTurns',
  'retrievedArchiveToolResults',
  'retrievedArchiveEstimatedTokens',
  'archiveRetrievalSkipped',
  'archiveRetrievalFailures',
  'archiveRetrievalSkippedReasonCounts',
  'archiveRetrievalFailureReasonCounts',
  'historySearchMatches',
  'historyAroundRetrievedEvents',
  'historyAroundEstimatedTokens',
  'historyAroundSkippedEvents',
  'synthesisCacheEnabled',
  'synthesisCacheMode',
  'synthesisCacheBlocksLoaded',
  'synthesisCacheLoadSkipped',
  'synthesisCacheLoadSkippedReasonCounts',
  'synthesisCacheLoadFailures',
  'synthesisCacheBlocksAvailable',
  'synthesisCacheBlocksSelected',
  'synthesisCacheBlockIds',
  'synthesisCacheEstimatedTokens',
  'synthesisCacheSkipped',
  'synthesisCacheSkippedReasonCounts',
  'synthesisCacheInvalidated',
  'synthesisCacheInvalidationReasonCounts',
  'synthesisCacheWritesAttempted',
  'synthesisCacheBlocksWritten',
  'synthesisCacheWrittenBlockIds',
  'synthesisCacheWriteEstimatedTokens',
  'synthesisCacheWriteSkipped',
  'synthesisCacheWriteSkippedReasonCounts',
  'synthesisCacheWriteFailures',
  'synthesisCacheEvicted',
  'synthesisCacheEvictionReasonCounts',
  'historyCompactEnabled',
  'historyCompactMode',
  'historyCompactBlocksLoaded',
  'historyCompactLoadSkipped',
  'historyCompactLoadSkippedReasonCounts',
  'historyCompactLoadFailures',
  'historyCompactBlocksAvailable',
  'historyCompactBlocksSelected',
  'historyCompactBlockIds',
  'historyCompactedTurns',
  'historyCompactedEvents',
  'historyCompactedEstimatedTokensBefore',
  'historyCompactedEstimatedTokensAfter',
  'historyCompactSkipped',
  'historyCompactSkippedReasonCounts',
  'historyCompactCoverageHashes',
  'historyCompactWritesAttempted',
  'historyCompactBlocksWritten',
  'historyCompactWrittenBlockIds',
  'historyCompactWriteEstimatedTokens',
  'historyCompactWriteSkipped',
  'historyCompactWriteSkippedReasonCounts',
  'historyCompactWriteFailures',
  'highWaterName',
  'highWaterSeq',
  'highWaterReason',
  'highWaterRequestShapeHashBefore',
  'highWaterRequestShapeHashAfter',
  'historyRewriteVersion',
  'historyRewriteResetReason',
  'historyRewriteGate',
] as const;

const CONTEXT_BUDGET_SHAPE = {
  required: CURRENT_CONTEXT_BUDGET_SHAPE.required,
  allowed: new Set([...CURRENT_CONTEXT_BUDGET_SHAPE.allowed, ...RETIRED_CONTEXT_BUDGET_KEYS]),
};

const PROMPT_SEGMENT_KINDS = new Set([
  'system_prompt',
  'tool_schema',
  'prior_history',
  'current_user',
  // Read compatibility for historical usage rows; current writers do not emit it.
  'turn_tail',
]);

const PREFIX_CHANGE_REASONS = new Set([
  'first_turn',
  'system_prompt_changed',
  'tool_schema_changed',
  'provider_options_changed',
  'model_or_provider_changed',
  'history_projection_changed',
  'stable',
  'unknown',
]);

const OPTIONAL_TOKEN_NUMBERS = [
  'cacheHitInput',
  'cacheMissInput',
  'cacheWriteInput',
  'reasoning',
  'total',
  'runtimeSteps',
  'cacheRead',
  'cacheCreation',
  'costUsd',
  'contextRemaining',
] as const;

const COMPACTION_NUMBERS = [
  'coveredTurns',
  'coveredRuntimeEvents',
  'coveredToolCalls',
  'coveredProviderMessages',
  'estimatedTokensBefore',
  'estimatedTokensAfter',
  'estimatedTokensSaved',
  'candidateEstimatedTokens',
  'preservedHeadEstimatedTokens',
  'preservedTailEstimatedTokens',
  'acceptedProjectionEstimatedTokens',
  'compactCallInputTokens',
  'compactCallOutputTokens',
  'compactCallCacheReadInputTokens',
  'compactCallCacheWriteInputTokens',
  'compactCallTotalTokens',
] as const;

const CONTEXT_NUMBERS = [
  'maxHistoryEstimatedTokens',
  'maxHistoryTurns',
  'prunedToolResults',
  'prunedToolResultEstimatedTokensBefore',
  'prunedToolResultEstimatedTokensAfter',
  'archivePlaceholders',
  'archiveWriteFailures',
  'unarchivedToolResults',
  'activePrunedToolResults',
  'activeSupersededToolResults',
  'activeDuplicateToolResults',
  'activeArchiveFailures',
  'activeEstimatedTokensSaved',
] as const;

const CONTEXT_REASON_COUNTS = ['archivePlaceholderReasonCounts'] as const;

/**
 * Token-usage field bundle shared by the runtime-event, message, and event
 * projections (RuntimeEventTokenUsage / TokenUsageMessage / TokenUsageEvent).
 * Single source of truth — `isTokenUsageFields` validates exactly this shape.
 */
export interface TokenUsageFields {
  input: number;
  output: number;
  cacheHitInput?: number;
  cacheMissInput?: number;
  cacheWriteInput?: number;
  cacheMissInputSource?: CacheMissInputSource;
  reasoning?: number;
  total?: number;
  rawFinishReason?: string;
  /** Number of provider runtime/tool-loop steps represented by this usage. */
  runtimeSteps?: number;
  /** Backward-compatible alias for cacheHitInput. */
  cacheRead?: number;
  /** Backward-compatible alias for cacheWriteInput. */
  cacheCreation?: number;
  costUsd?: number;
  systemPromptHash?: string;
  contextRemaining?: number;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
  /** Links this aggregate to per-physical-request AgentRun trace rows. */
  providerRequestTraceId?: string;
  /**
   * The send's LAST provider request, as a pair: the input tokens the provider
   * reported for it, and the wire payload chars the runtime measured for that
   * same request. `input` above is the send's sum across steps and cannot
   * anchor anything; this pair can, so the next turn estimates its first
   * request from real usage instead of guessing the whole payload at char/4.
   *
   * Only the pair means anything — an anchor taken from one request and a
   * baseline from another is off by a whole step's growth — so the two numbers
   * live in one object that is written and read together. Absent means no
   * anchor, and the estimate falls back to the cold start.
   */
  lastRequestAnchor?: LastRequestAnchor;
}

/** Real input tokens of one provider request, paired with its measured payload chars. */
export interface LastRequestAnchor {
  inputTokens: number;
  payloadChars: number;
}

const LAST_REQUEST_ANCHOR_SHAPE = defineObjectShape<LastRequestAnchor>()(
  ['inputTokens', 'payloadChars'],
  [],
);

export function isLastRequestAnchor(value: unknown): value is LastRequestAnchor {
  return (
    isRecord(value) &&
    hasExactShape(value, LAST_REQUEST_ANCHOR_SHAPE) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.payloadChars) &&
    value.inputTokens > 0 &&
    value.payloadChars > 0
  );
}

export function isTokenUsageFields(value: unknown): value is TokenUsageFields {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.input) || !isFiniteNumber(value.output)) return false;
  if (OPTIONAL_TOKEN_NUMBERS.some((key) => !isOptionalFiniteNumber(value[key]))) return false;
  return (
    (value.cacheMissInputSource === undefined ||
      value.cacheMissInputSource === 'explicit' ||
      value.cacheMissInputSource === 'derived') &&
    isOptionalString(value.rawFinishReason) &&
    isOptionalString(value.systemPromptHash) &&
    isOptionalString(value.prefixHash) &&
    isOptionalPrefixChangeReason(value.prefixChangeReason) &&
    isOptionalString(value.requestShapeHash) &&
    isOptionalPrefixChangeReason(value.requestShapeChangeReason) &&
    isOptionalString(value.providerRequestTraceId) &&
    (value.promptSegments === undefined ||
      (Array.isArray(value.promptSegments) &&
        value.promptSegments.every(isPromptSegmentEstimate))) &&
    (value.contextBudget === undefined || isContextBudgetDiagnostic(value.contextBudget)) &&
    (value.lastRequestAnchor === undefined || isLastRequestAnchor(value.lastRequestAnchor))
  );
}

export function isPromptSegmentEstimate(value: unknown): value is PromptSegmentEstimate {
  return (
    isRecord(value) &&
    hasExactShape(value, PROMPT_SEGMENT_SHAPE) &&
    PROMPT_SEGMENT_KINDS.has(value.kind as string) &&
    isFiniteNumber(value.chars) &&
    isFiniteNumber(value.estimatedTokens) &&
    isOptionalFiniteNumber(value.messageCount) &&
    isOptionalFiniteNumber(value.eventCount) &&
    isOptionalFiniteNumber(value.toolCount)
  );
}

export function isContextBudgetDiagnostic(value: unknown): value is ContextBudgetDiagnostic {
  if (!isRecord(value) || !hasExactShape(value, CONTEXT_BUDGET_SHAPE)) return false;
  if (
    typeof value.enabled !== 'boolean' ||
    !isFiniteNumber(value.estimatedTokensBefore) ||
    !isFiniteNumber(value.estimatedTokensAfter) ||
    !isFiniteNumber(value.keptTurns) ||
    !isFiniteNumber(value.droppedTurns) ||
    !isFiniteNumber(value.keptEvents) ||
    !isFiniteNumber(value.droppedEvents) ||
    CONTEXT_NUMBERS.some((key) => !isOptionalFiniteNumber(value[key])) ||
    CONTEXT_REASON_COUNTS.some(
      (key) => value[key] !== undefined && !isStringNumberRecord(value[key]),
    )
  ) {
    return false;
  }
  return (
    isOptionalString(value.policyName) &&
    (value.compactionDecisions === undefined ||
      (Array.isArray(value.compactionDecisions) &&
        value.compactionDecisions.every(isCompactionDecisionDiagnostic)))
  );
}

function isCompactionDecisionDiagnostic(value: unknown): value is CompactionDecisionDiagnostic {
  if (!isRecord(value) || !hasExactShape(value, COMPACTION_DECISION_SHAPE)) return false;
  return (
    (value.stage === 'priorReplay' || value.stage === 'activeStep') &&
    (value.sourceKind === 'runtimeEvents' || value.sourceKind === 'providerMessages') &&
    (value.decision === 'unchanged' ||
      value.decision === 'replaced' ||
      value.decision === 'failedOpen') &&
    (value.phase === undefined || value.phase === 'pre_turn' || value.phase === 'mid_turn') &&
    isOptionalString(value.boundaryKind) &&
    optionalStringArray(value.boundaryIds) &&
    COMPACTION_NUMBERS.every((key) => isOptionalFiniteNumber(value[key])) &&
    optionalStringArray(value.coverageHashes) &&
    isOptionalString(value.reason) &&
    isOptionalString(value.failOpenReason) &&
    (value.skippedReasonCounts === undefined || isStringNumberRecord(value.skippedReasonCounts)) &&
    (value.validationReasonCounts === undefined ||
      isStringNumberRecord(value.validationReasonCounts))
  );
}

function isOptionalPrefixChangeReason(value: unknown): boolean {
  return value === undefined || PREFIX_CHANGE_REASONS.has(value as string);
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}
