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

/**
 * Stored model-call kinds. `semantic_compact` is decode-only for historical
 * usage records; the Runtime no longer has a writer or execution path for it.
 */
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
  sessionId?: string;
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
  /**
   * Recorded model-call time, summed over the same rows as `totalTokens`.
   *
   * Every summary writes it, and the protocol epoch refuses peers that predate
   * it at the handshake, so a total without a time basis cannot cross the wire.
   */
  totalDurationMs: number;
  /**
   * Recorded tool executions behind the same query, from the tool-invocation
   * ledger — the model-call ledger does not describe them, so there is no
   * canonical source to merge and this comes from the store alone.
   *
   * Optional because tool rows that predate connection attribution cannot
   * answer a `connectionSlug` filter honestly: the Host omits the split for
   * that query rather than drawing a ring from rows it cannot scope.
   */
  toolUsage?: { requests: number; durationMs: number };
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
 * turn, produced by `ToolAvailabilityRuntime`. A "source" id here is a catalog
 * group id; the historical field names remain stable for telemetry readers.
 */
export interface ToolAvailabilityDiagnostic {
  /**
   * `'search'` is the current provider-independent lazy-loading policy.
   * `'economy'` remains readable for historical telemetry.
   */
  mode: 'economy' | 'search';
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
  /** Historical usage rows only; no current request builder emits this segment. */
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
  compactionDecisions?: CompactionDecisionDiagnostic[];
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
