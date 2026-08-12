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

const CONTEXT_BUDGET_SHAPE = defineObjectShape<ContextBudgetDiagnostic>()(
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
    'maxHistoryTurns',
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
    'semanticCompactEnabled',
    'semanticCompactMode',
    'compactionDecisions',
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
  ],
);

const PROMPT_SEGMENT_KINDS = new Set([
  'system_prompt',
  'tool_schema',
  'prior_history',
  'current_user',
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
  'archiveRetrievalEligibleTurns',
  'retrievedArchiveToolResults',
  'retrievedArchiveEstimatedTokens',
  'archiveRetrievalSkipped',
  'archiveRetrievalFailures',
  'historySearchMatches',
  'historyAroundRetrievedEvents',
  'historyAroundEstimatedTokens',
  'historyAroundSkippedEvents',
  'synthesisCacheBlocksLoaded',
  'synthesisCacheLoadSkipped',
  'synthesisCacheLoadFailures',
  'synthesisCacheBlocksAvailable',
  'synthesisCacheBlocksSelected',
  'synthesisCacheEstimatedTokens',
  'synthesisCacheSkipped',
  'synthesisCacheInvalidated',
  'synthesisCacheWritesAttempted',
  'synthesisCacheBlocksWritten',
  'synthesisCacheWriteEstimatedTokens',
  'synthesisCacheWriteSkipped',
  'synthesisCacheWriteFailures',
  'synthesisCacheEvicted',
  'historyCompactBlocksLoaded',
  'historyCompactLoadSkipped',
  'historyCompactLoadFailures',
  'historyCompactBlocksAvailable',
  'historyCompactBlocksSelected',
  'historyCompactedTurns',
  'historyCompactedEvents',
  'historyCompactedEstimatedTokensBefore',
  'historyCompactedEstimatedTokensAfter',
  'historyCompactSkipped',
  'historyCompactWritesAttempted',
  'historyCompactBlocksWritten',
  'historyCompactWriteEstimatedTokens',
  'historyCompactWriteSkipped',
  'historyCompactWriteFailures',
  'highWaterSeq',
] as const;

const CONTEXT_REASON_COUNTS = [
  'archivePlaceholderReasonCounts',
  'archiveRetrievalSkippedReasonCounts',
  'archiveRetrievalFailureReasonCounts',
  'synthesisCacheLoadSkippedReasonCounts',
  'synthesisCacheSkippedReasonCounts',
  'synthesisCacheInvalidationReasonCounts',
  'synthesisCacheWriteSkippedReasonCounts',
  'synthesisCacheEvictionReasonCounts',
  'historyCompactLoadSkippedReasonCounts',
  'historyCompactSkippedReasonCounts',
  'historyCompactWriteSkippedReasonCounts',
] as const;

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
    (value.contextBudget === undefined || isContextBudgetDiagnostic(value.contextBudget))
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
    (value.semanticCompactEnabled === undefined ||
      typeof value.semanticCompactEnabled === 'boolean') &&
    (value.semanticCompactMode === undefined ||
      ['off', 'validate_only', 'prepare_step_dry_run', 'replace'].includes(
        value.semanticCompactMode as string,
      )) &&
    (value.compactionDecisions === undefined ||
      (Array.isArray(value.compactionDecisions) &&
        value.compactionDecisions.every(isCompactionDecisionDiagnostic))) &&
    (value.archiveRetrievalMode === undefined ||
      value.archiveRetrievalMode === 'eager' ||
      value.archiveRetrievalMode === 'history_search_gated') &&
    (value.synthesisCacheEnabled === undefined ||
      typeof value.synthesisCacheEnabled === 'boolean') &&
    (value.synthesisCacheMode === undefined ||
      ['off', 'lookup', 'read_write', 'write_only', 'fallback_archive_retrieval'].includes(
        value.synthesisCacheMode as string,
      )) &&
    optionalStringArray(value.synthesisCacheBlockIds) &&
    optionalStringArray(value.synthesisCacheWrittenBlockIds) &&
    (value.historyCompactEnabled === undefined ||
      typeof value.historyCompactEnabled === 'boolean') &&
    (value.historyCompactMode === undefined ||
      ['off', 'deterministic', 'lookup', 'read_write'].includes(
        value.historyCompactMode as string,
      )) &&
    optionalStringArray(value.historyCompactBlockIds) &&
    optionalStringArray(value.historyCompactCoverageHashes) &&
    optionalStringArray(value.historyCompactWrittenBlockIds) &&
    isOptionalString(value.highWaterName) &&
    (value.highWaterReason === undefined ||
      [
        'archive_prune',
        'history_search_gated_retrieval',
        'synthesis_cache_write',
        'synthesis_cache_select',
        'history_compact',
        'manual_reset',
        'system_change',
        'tools_change',
        'log_rewrite',
      ].includes(value.highWaterReason as string)) &&
    isOptionalString(value.highWaterRequestShapeHashBefore) &&
    isOptionalString(value.highWaterRequestShapeHashAfter) &&
    isOptionalString(value.historyRewriteVersion) &&
    isOptionalString(value.historyRewriteResetReason) &&
    isOptionalString(value.historyRewriteGate)
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
