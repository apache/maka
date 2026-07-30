import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { LlmCallRecord } from '@maka/core/usage-stats/types';

import type { ActiveFullCompactBlock } from './active-full-compact.js';
import type { ActiveToolResultArchiveCandidate } from './active-tool-result-prune.js';
import type {
  ArchiveRetrievalMode,
  ContextBudgetPolicy,
  HistoryCompactBlock,
  StaleToolResultArchiveCandidate,
  SynthesisCacheBlock,
  SynthesisSourceRef,
} from './context-budget.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import type { ModelFactory } from './model-adapter.js';
import type { SemanticCompactBlock } from './semantic-compact.js';

export type LlmTelemetryRecorder = (record: LlmCallRecord) => void;

export type ToolResultArchiveRecorderInput = (
  | StaleToolResultArchiveCandidate
  | (ActiveToolResultArchiveCandidate & { runtimeEventId: string })
) & {
  sessionId: string;
  bodySha256: string;
};
export type ToolResultArchiveRecorder = (
  input: ToolResultArchiveRecorderInput,
) => Promise<{ artifactId: string } | void> | { artifactId: string } | void;

export interface SynthesisCacheLoadInput {
  sessionId: string;
  maxBlocks?: number;
  maxBytes?: number;
  maxEstimatedTokens?: number;
}
export interface SynthesisCacheLoadResult {
  blocks: SynthesisCacheBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
  evicted?: number;
  evictionReasonCounts?: Record<string, number>;
}
export interface SynthesisCacheWriteInput {
  sessionId: string;
  turnId: string;
  source: {
    createdFrom: 'gated_archive_retrieval' | 'eager_archive_retrieval';
    query: string;
    hydratedRuntimeEvents: RuntimeEvent[];
    retrievedArchiveRefs: SynthesisSourceRef[];
    archiveRetrievalMode: ArchiveRetrievalMode;
  };
  limits: {
    maxBlocks: number;
    maxBlockEstimatedTokens: number;
    maxEstimatedTokens: number;
    charsPerToken: number;
  };
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
}
export interface SynthesisCacheWriteResult {
  blocks: SynthesisCacheBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
}
export type SynthesisCacheLoader = (
  input: SynthesisCacheLoadInput,
) => Promise<SynthesisCacheLoadResult> | SynthesisCacheLoadResult;
export type SynthesisCacheWriter = (
  input: SynthesisCacheWriteInput,
) => Promise<SynthesisCacheWriteResult | void> | SynthesisCacheWriteResult | void;

export interface HistoryCompactLoadInput {
  sessionId: string;
  maxBlocks?: number;
  maxBytes?: number;
  maxEstimatedTokens?: number;
}
export interface HistoryCompactLoadResult {
  blocks: HistoryCompactBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
}
export interface HistoryCompactWriteInput {
  sessionId: string;
  turnId: string;
  source: {
    draftBlock: HistoryCompactBlock;
    foldedRuntimeEvents: RuntimeEvent[];
  };
  limits: {
    maxBlocks: number;
    maxBlockEstimatedTokens: number;
    maxEstimatedTokens: number;
    charsPerToken: number;
  };
  requestShapeHashBefore?: string;
  requestShapeHashAfter?: string;
  abortSignal?: AbortSignal;
}
export interface HistoryCompactWriteResult {
  blocks: HistoryCompactBlock[];
  skipped?: number;
  skippedReasonCounts?: Record<string, number>;
}
export type HistoryCompactLoader = (
  input: HistoryCompactLoadInput,
) => Promise<HistoryCompactLoadResult> | HistoryCompactLoadResult;
export type HistoryCompactWriter = (
  input: HistoryCompactWriteInput,
) => Promise<HistoryCompactWriteResult | void> | HistoryCompactWriteResult | void;
export interface HistoryCompactSummaryInput {
  sessionId: string;
  turnId: string;
  source: { foldedRuntimeEvents: RuntimeEvent[] };
  previousCheckpoint?: HistoryCompactCheckpoint;
  newlyFoldedRuntimeEvents?: RuntimeEvent[];
  requestShapeHashBefore?: string;
  abortSignal?: AbortSignal;
}
export type HistoryCompactSummarizer = (
  input: HistoryCompactSummaryInput,
) => Promise<string | undefined> | string | undefined;
export type HistoryCompactCheckpointLoader = () =>
  | Promise<HistoryCompactCheckpoint | undefined>
  | HistoryCompactCheckpoint
  | undefined;
export type HistoryCompactCheckpointRecorder = (
  checkpoint: HistoryCompactCheckpoint,
  turnId: string,
) => void | Promise<void>;
export type ActiveFullCompactBlockRecorder = (
  block: ActiveFullCompactBlock,
) => void | Promise<void>;
export type SemanticCompactBlockRecorder = (block: SemanticCompactBlock) => void | Promise<void>;

/** Provider and persistence capabilities used by the compaction collaborator. */
export interface AiSdkCompactionCapabilities {
  connection: RuntimeExecutionConnection;
  apiKey: string;
  modelId: string;
  modelFactory: ModelFactory;
  /** Optional prior-history budget. Keeps whole turns to preserve tool-call/result pairs. */
  contextBudget?: ContextBudgetPolicy;
  /** Optional fire-and-forget LLM telemetry hook. */
  recordLlmCall?: LlmTelemetryRecorder;
  /**
   * Optional archive writer for replay-only stale tool-result pruning. The
   * runtime rewrites only candidates whose original body has been durably
   * archived by this callback.
   */
  archiveToolResult?: ToolResultArchiveRecorder;
  /** Optional best-effort source-bearing synthesis cache loader. */
  loadSynthesisCache?: SynthesisCacheLoader;
  /** Optional best-effort source-bearing synthesis cache writer. */
  writeSynthesisCache?: SynthesisCacheWriter;
  /** Optional best-effort source-bearing history compact block loader. */
  loadHistoryCompact?: HistoryCompactLoader;
  /** Optional best-effort source-bearing history compact block writer. */
  writeHistoryCompact?: HistoryCompactWriter;
  /** Preferred bounded V2 checkpoint loader. Legacy artifact blocks remain a read-only fallback. */
  loadHistoryCompactCheckpoint?: HistoryCompactCheckpointLoader;
  /** Produces a checkpoint summary from the prior summary plus newly evicted RuntimeEvents. */
  summarizeHistoryCompact?: HistoryCompactSummarizer;
  /** Best-effort durable recorder for accepted V2 checkpoints. */
  recordHistoryCompactCheckpoint?: HistoryCompactCheckpointRecorder;
  /**
   * Durable read of the given turn's persisted RuntimeEvents from the
   * authoritative run ledger. Mid-turn capacity compaction derives its
   * coverage pool from this read after its seq-ack durability boundary. A
   * lagging read is not fail-safe because the replacement projection replaces
   * the whole message list and could otherwise drop a completed-step event.
   */
  loadTurnRuntimeEvents?: (turnId: string) => Promise<RuntimeEvent[]>;
  /** Explicit capability for folding current-run events into session-scoped history. */
  allowMidTurnHistoryCompaction?: boolean;
  /** Optional best-effort durable recorder for accepted active full compact blocks. */
  recordActiveFullCompactBlock?: ActiveFullCompactBlockRecorder;
  /** Optional best-effort durable recorder for accepted semantic compact blocks. */
  recordSemanticCompactBlock?: SemanticCompactBlockRecorder;
}
