export const MODEL_CALL_KINDS = [
  'main',
  'semantic_compact',
  'history_compact',
  'goal_evaluation',
  'session_title',
  'session_recap',
  'daily_review',
  'memory_extraction',
] as const;
export type ModelCallKind = (typeof MODEL_CALL_KINDS)[number];

export type TimeRange = '24h' | '7d' | '30d' | 'all' | { from: number; to: number };

export type UsageGroupBy = 'provider' | 'model' | 'tool' | 'day' | 'hour';

export interface UsageQuery {
  range: TimeRange;
  connectionSlug?: string;
  providerId?: string;
  modelId?: string;
  toolName?: string;
  status?: 'success' | 'error' | 'aborted' | 'all';
}

export interface UsageSummaryV2 {
  range: { from: number; to: number };
  totalRequests: number;
  totalCostUsd: number;
  totalTokens: {
    input: number;
    output: number;
    cacheMiss: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
  };
  cacheHitRequests: number;
  cacheCreateRequests: number;
  errorRequests: number;
}

export interface UsageBucket {
  key: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissInputSource?: CacheMissInputSource;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface UsageLogRow {
  id: string;
  ts: number;
  callKind?: ModelCallKind;
  callId?: string;
  connectionSlug?: string;
  providerId: string;
  modelId: string;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /**
   * Absent when `costBasis` is `'unpriced'`. Zero means the call was genuinely
   * free — it must never stand in for a price that could not be resolved.
   */
  costUsd?: number;
  /**
   * Whether a price could be resolved for this row. Rows from the frozen
   * pre-cutover table have no recorded basis and leave this undefined, which is
   * itself the honest answer for them.
   */
  costBasis?: 'priced' | 'unpriced';
  latencyMs: number;
  status: 'success' | 'error' | 'aborted';
  errorClass?: string;
  sessionId?: string;
  turnId?: string;
  systemPromptHash?: string;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  toolSchemaChangeReason?: ToolSchemaChangeReason;
  toolAvailability?: ToolAvailabilityDiagnostic;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
}

export interface PricingConfig {
  modelKey: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
}

export interface LlmCallRecord {
  sessionId?: string;
  turnId?: string;
  /**
   * Distinguishes the main agent stream from auxiliary model calls such as
   * semantic or history compaction. Omitted means the historical main stream call.
   */
  callKind?: ModelCallKind;
  /** Stable id for auxiliary calls so multiple records in one turn do not collide. */
  callId?: string;
  connectionSlug?: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  /** Backward-compatible alias for cacheHitInputTokens. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  rawFinishReason?: string;
  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
  latencyMs: number;
  status: 'success' | 'error' | 'aborted';
  errorClass?: string;
  costUsd?: number;
  startedAt: number;
  systemPromptHash?: string;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  toolSchemaChangeReason?: ToolSchemaChangeReason;
  toolAvailability?: ToolAvailabilityDiagnostic;
  cacheMissInputSource?: CacheMissInputSource;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
}

export type ToolSourceId = string;

export type PrefixChangeReason =
  | 'first_turn'
  | 'system_prompt_changed'
  | 'tool_schema_changed'
  | 'provider_options_changed'
  | 'model_or_provider_changed'
  | 'history_projection_changed'
  | 'stable'
  | 'unknown';

export type ToolSchemaChangeReason =
  | 'tool_schema_changed'
  | 'tool_source_enabled'
  | 'tool_source_state_changed';

/**
 * Diagnostic shell describing the provider-visible (active) tool subset for a
 * turn, produced by the unified `ToolAvailabilityRuntime`. A "source" id here is
 * a catalog *group* id — the shell retains the historical `*SourceIds` field
 * names while the config-side vocabulary is `groups`.
 */
export interface ToolAvailabilityDiagnostic {
  /**
   * Always `'economy'`: a diagnostic is only produced when economy gates the
   * tool surface. The full-surface case emits no diagnostic at all.
   */
  mode: 'economy';
  enabledSourceIds: ToolSourceId[];
  availableSourceIds?: ToolSourceId[];
  connectorToolName?: string;
  visibleToolNamesBySource?: Record<ToolSourceId, string[]>;
  visibleToolCount?: number;
  fullToolCount?: number;
  hiddenToolCount?: number;
  visibleToolSchemaChars?: number;
  fullToolSchemaChars?: number;
  toolSchemaCharReduction?: number;
  estimatedToolSchemaTokenReduction?: number;
}

export type CacheMissInputSource = 'explicit' | 'derived';

export type PromptSegmentKind =
  | 'system_prompt'
  | 'tool_schema'
  | 'prior_history'
  | 'current_user'
  | 'turn_tail';

export interface PromptSegmentEstimate {
  kind: PromptSegmentKind;
  chars: number;
  estimatedTokens: number;
  messageCount?: number;
  eventCount?: number;
  toolCount?: number;
}

export type CompactionStageDiagnostic = 'priorReplay' | 'activeStep';
export type CompactionSourceDiagnosticKind = 'runtimeEvents' | 'providerMessages';
export type CompactionDecisionDiagnosticKind = 'unchanged' | 'replaced' | 'failedOpen';

export interface CompactionDecisionDiagnostic {
  stage: CompactionStageDiagnostic;
  sourceKind: CompactionSourceDiagnosticKind;
  decision: CompactionDecisionDiagnosticKind;
  /** Compaction phase; absent on legacy data = pre_turn. */
  phase?: 'pre_turn' | 'mid_turn';
  boundaryKind?: string;
  boundaryIds?: string[];
  coveredTurns?: number;
  coveredRuntimeEvents?: number;
  coveredToolCalls?: number;
  coveredProviderMessages?: number;
  coverageHashes?: string[];
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  estimatedTokensSaved?: number;
  candidateEstimatedTokens?: number;
  preservedHeadEstimatedTokens?: number;
  preservedTailEstimatedTokens?: number;
  acceptedProjectionEstimatedTokens?: number;
  compactCallInputTokens?: number;
  compactCallOutputTokens?: number;
  compactCallCacheReadInputTokens?: number;
  compactCallCacheWriteInputTokens?: number;
  compactCallTotalTokens?: number;
  reason?: string;
  failOpenReason?: string;
  skippedReasonCounts?: Record<string, number>;
  validationReasonCounts?: Record<string, number>;
}

export interface ContextBudgetDiagnostic {
  enabled: boolean;
  policyName?: string;
  maxHistoryEstimatedTokens?: number;
  maxHistoryTurns?: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  keptTurns: number;
  droppedTurns: number;
  keptEvents: number;
  droppedEvents: number;
  prunedToolResults?: number;
  prunedToolResultEstimatedTokensBefore?: number;
  prunedToolResultEstimatedTokensAfter?: number;
  archivePlaceholders?: number;
  archiveWriteFailures?: number;
  unarchivedToolResults?: number;
  archivePlaceholderReasonCounts?: Record<string, number>;
  activePrunedToolResults?: number;
  activeSupersededToolResults?: number;
  activeDuplicateToolResults?: number;
  activeArchiveFailures?: number;
  activeEstimatedTokensSaved?: number;
  semanticCompactEnabled?: boolean;
  semanticCompactMode?: 'off' | 'validate_only' | 'prepare_step_dry_run' | 'replace';
  compactionDecisions?: CompactionDecisionDiagnostic[];
  archiveRetrievalMode?: 'eager' | 'history_search_gated';
  archiveRetrievalEligibleTurns?: number;
  retrievedArchiveToolResults?: number;
  retrievedArchiveEstimatedTokens?: number;
  archiveRetrievalSkipped?: number;
  archiveRetrievalFailures?: number;
  archiveRetrievalSkippedReasonCounts?: Record<string, number>;
  archiveRetrievalFailureReasonCounts?: Record<string, number>;
  historySearchMatches?: number;
  historyAroundRetrievedEvents?: number;
  historyAroundEstimatedTokens?: number;
  historyAroundSkippedEvents?: number;
  synthesisCacheEnabled?: boolean;
  synthesisCacheMode?:
    | 'off'
    | 'lookup'
    | 'read_write'
    | 'write_only'
    | 'fallback_archive_retrieval';
  synthesisCacheBlocksLoaded?: number;
  synthesisCacheLoadSkipped?: number;
  synthesisCacheLoadSkippedReasonCounts?: Record<string, number>;
  synthesisCacheLoadFailures?: number;
  synthesisCacheBlocksAvailable?: number;
  synthesisCacheBlocksSelected?: number;
  synthesisCacheBlockIds?: string[];
  synthesisCacheEstimatedTokens?: number;
  synthesisCacheSkipped?: number;
  synthesisCacheSkippedReasonCounts?: Record<string, number>;
  synthesisCacheInvalidated?: number;
  synthesisCacheInvalidationReasonCounts?: Record<string, number>;
  synthesisCacheWritesAttempted?: number;
  synthesisCacheBlocksWritten?: number;
  synthesisCacheWrittenBlockIds?: string[];
  synthesisCacheWriteEstimatedTokens?: number;
  synthesisCacheWriteSkipped?: number;
  synthesisCacheWriteSkippedReasonCounts?: Record<string, number>;
  synthesisCacheWriteFailures?: number;
  synthesisCacheEvicted?: number;
  synthesisCacheEvictionReasonCounts?: Record<string, number>;
  historyCompactEnabled?: boolean;
  historyCompactMode?: 'off' | 'deterministic' | 'lookup' | 'read_write';
  historyCompactBlocksLoaded?: number;
  historyCompactLoadSkipped?: number;
  historyCompactLoadSkippedReasonCounts?: Record<string, number>;
  historyCompactLoadFailures?: number;
  historyCompactBlocksAvailable?: number;
  historyCompactBlocksSelected?: number;
  historyCompactBlockIds?: string[];
  historyCompactedTurns?: number;
  historyCompactedEvents?: number;
  historyCompactedEstimatedTokensBefore?: number;
  historyCompactedEstimatedTokensAfter?: number;
  historyCompactSkipped?: number;
  historyCompactSkippedReasonCounts?: Record<string, number>;
  historyCompactCoverageHashes?: string[];
  historyCompactWritesAttempted?: number;
  historyCompactBlocksWritten?: number;
  historyCompactWrittenBlockIds?: string[];
  historyCompactWriteEstimatedTokens?: number;
  historyCompactWriteSkipped?: number;
  historyCompactWriteSkippedReasonCounts?: Record<string, number>;
  historyCompactWriteFailures?: number;
  highWaterName?: string;
  highWaterSeq?: number;
  highWaterReason?:
    | 'archive_prune'
    | 'history_search_gated_retrieval'
    | 'synthesis_cache_write'
    | 'synthesis_cache_select'
    | 'history_compact'
    | 'manual_reset'
    | 'system_change'
    | 'tools_change'
    | 'log_rewrite';
  highWaterRequestShapeHashBefore?: string;
  highWaterRequestShapeHashAfter?: string;
  historyRewriteVersion?: string;
  historyRewriteResetReason?: string;
  historyRewriteGate?: string;
}

export interface ToolInvocationResultSummary {
  kind: string;
  status?: string;
  itemCount?: number;
  startedItemCount?: number;
  completedItemCount?: number;
  failedItemCount?: number;
  cancelledItemCount?: number;
  artifactCount?: number;
}

export interface ToolInvocationRecord {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName: string;
  providerId?: string;
  modelId?: string;
  durationMs: number;
  status: 'success' | 'error' | 'aborted';
  errorClass?: string;
  argsSummary?: string;
  /** Bounded structured-result projection for diagnostics; never raw output. */
  resultSummary?: ToolInvocationResultSummary;
  bytesIn?: number;
  bytesOut?: number;
  startedAt: number;
}
