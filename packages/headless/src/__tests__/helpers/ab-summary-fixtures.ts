import {
  FIXED_PROMPT_WAL_SCHEMA_VERSION,
  type FixedPromptTaskBudgetExhaustedEvent,
  type FixedPromptTaskCompletedEvent,
} from '../../fixed-prompt-controller.js';
import { completed } from './ab-run-fixtures.js';

export { completed };

export function withUsage(
  event: FixedPromptTaskCompletedEvent,
  usage: {
    input: number;
    cacheHitInput: number;
    cacheMissInput: number;
    cacheWriteInput: number;
    output: number;
    reasoning: number;
    total: number;
    costUsd: number;
    durationMs: number;
  },
): FixedPromptTaskCompletedEvent {
  return {
    ...event,
    tokenSummary: {
      input: usage.input,
      cachedInput: usage.cacheHitInput,
      cacheHitInput: usage.cacheHitInput,
      cacheMissInput: usage.cacheMissInput,
      cacheWriteInput: usage.cacheWriteInput,
      cacheMissInputSource: 'explicit',
      output: usage.output,
      reasoning: usage.reasoning,
      total: usage.total,
      costUsd: usage.costUsd,
      pricingSource: 'runtime',
    },
    tokenSummarySource: 'final',
    durationMs: usage.durationMs,
  };
}

export function budgetExhausted(taskId: string): FixedPromptTaskBudgetExhaustedEvent {
  return {
    schemaVersion: FIXED_PROMPT_WAL_SCHEMA_VERSION,
    type: 'task_budget_exhausted',
    id: `event-${taskId}-budget`,
    ts: 0,
    runId: 'run',
    roundId: 'round',
    taskId,
    status: 'budget_exhausted',
    passed: false,
    scored: false,
    eligible: true,
    errorClass: 'budget_exhausted',
    error: 'harbor run timed out after 600s',
    expectedPromptHash: 'hash',
  };
}

export function contextBudgetSummary(
  input: Partial<NonNullable<FixedPromptTaskCompletedEvent['contextBudgetSummary']>>,
): NonNullable<FixedPromptTaskCompletedEvent['contextBudgetSummary']> {
  return {
    diagnosticEvents: 1,
    enabledEvents: 1,
    estimatedTokensBefore: 1000,
    estimatedTokensAfter: 800,
    keptTurns: 3,
    droppedTurns: 1,
    keptEvents: 8,
    droppedEvents: 2,
    prunedToolResults: 0,
    activePrunedToolResults: 0,
    activeEstimatedTokensSaved: 0,
    activeArchiveFailures: 0,
    archivePlaceholders: 0,
    archivePlaceholderReasonCounts: {},
    archiveWriteFailures: 0,
    retrievedArchiveToolResults: 0,
    retrievedArchiveEstimatedTokens: 0,
    archiveRetrievalSkipped: 0,
    archiveRetrievalSkippedReasonCounts: {},
    archiveRetrievalFailures: 0,
    archiveRetrievalFailureReasonCounts: {},
    semanticCompactCallInputTokens: 0,
    semanticCompactCallOutputTokens: 0,
    semanticCompactCallCacheReadInputTokens: 0,
    semanticCompactCallCacheWriteInputTokens: 0,
    semanticCompactCallTotalTokens: 0,
    ...input,
  };
}
