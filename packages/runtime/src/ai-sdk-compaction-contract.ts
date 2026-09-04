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

import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { HistoryCompactRoute } from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { ModelProjectionTransition } from '@maka/core/model-projection-transition';
import type { LoadedModelProjectionTransitions } from './model-projection-transition-ledger.js';
import type { AgentRunHeader } from '@maka/core/agent-run';

import type { ProviderRequestTracker } from './provider-request-telemetry.js';
import type { ContextBudgetPolicy } from './context-budget.js';
import type {
  HistoryCompactCheckpoint,
  HistoryCompactProviderState,
} from './history-compact-checkpoint.js';
import type { ModelFactory } from './model-adapter.js';
import type { ToolResultArchiveCapability } from './tool-result-archive-capability.js';

/**
 * Default output cap for a compaction summary. Measured summaries land around
 * 1K tokens; the cap exists so a runaway summarizer cannot occupy the context
 * it was asked to free, not to shape the summary (#4559).
 */
export const DEFAULT_HISTORY_COMPACT_MAX_OUTPUT_TOKENS = 8_000;

export interface HistoryCompactSummaryInput {
  sessionId: string;
  turnId: string;
  /** Run issuing this compaction; its events are same-route by construction. */
  runId?: string;
  source: {
    foldedRuntimeEvents: RuntimeEvent[];
    runHeaders?: readonly AgentRunHeader[];
  };
  previousCheckpoint?: HistoryCompactCheckpoint;
  newlyFoldedRuntimeEvents?: RuntimeEvent[];
  /**
   * Output cap for the summary call. A summary is re-sent on every later
   * request, so it is bounded outright rather than estimated: the summarizer's
   * provider truncates at this cap (`finishReason: length`), and the compactor
   * then asks once for a shorter one. Whether the compaction INPUT fits the
   * summarizer's window is that provider's answer (`input_too_large`), never a
   * local estimate's (#4559).
   */
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Physical-call tracking for this summarization, built by the backend (#1679).
   *
   * A *ready* tracker, not the parts to assemble one: the products that wire a
   * summarizer cannot know the run a call belongs to, and every root that had to
   * assemble it independently eventually forgot a piece. Absent when the product
   * supplied no canonical sink, which leaves the call untracked.
   */
  providerRequestTracker?: ProviderRequestTracker;
}
/**
 * Produces the checkpoint summary that REPLACES the folded history. A string
 * result must satisfy the mandated checkpoint format — the sections, fence,
 * truncation, and size-floor rules owned by
 * `history-compact-summary-validation.ts` (its `SUMMARY_FORMAT_TEMPLATE` is
 * the shape to emit) — because every checkpoint write gate rejects a
 * defective summary and fails the compaction open (#3029). A free-form
 * plain-text summary is no longer persistable. Provider-native state objects
 * bypass text validation; `undefined`/empty falls to the `empty_summary`
 * gate.
 */
export type HistoryCompactSummarizer = (
  input: HistoryCompactSummaryInput,
) =>
  | Promise<string | HistoryCompactProviderState | undefined>
  | string
  | HistoryCompactProviderState
  | undefined;
export type HistoryCompactCheckpointLoader = () =>
  | Promise<HistoryCompactCheckpoint | undefined>
  | HistoryCompactCheckpoint
  | undefined;
export type HistoryCompactCheckpointRecorder = (
  checkpoint: HistoryCompactCheckpoint,
  turnId: string,
) => void | Promise<void>;
export type ModelProjectionTransitionLoader = () => Promise<LoadedModelProjectionTransitions>;
export type ModelProjectionTransitionLedgerRecorder = (
  transition: ModelProjectionTransition,
  turnId: string,
) => Promise<void>;
/** Provider and persistence capabilities used by the compaction collaborator. */
export interface AiSdkCompactionCapabilities {
  connection: RuntimeExecutionConnection;
  apiKey: string;
  modelId: string;
  modelFactory: ModelFactory;
  /** Optional model-visible context budget and compaction policy. */
  contextBudget?: ContextBudgetPolicy;
  /**
   * The whole tool-result archive authority (#2026): the writer that durably
   * stores a pruned body, the replay reader that hydrates it back, the
   * ref-addressed reader, and the `ArchiveRead` decoder the placeholder names.
   * Absent means this session archives nothing, which is a valid state — but
   * it can no longer mean "archives without a way back".
   */
  toolResultArchive?: ToolResultArchiveCapability;
  /** Latest checkpoint loader. */
  loadHistoryCompactCheckpoint?: HistoryCompactCheckpointLoader;
  /** Produces a checkpoint value from prior state plus newly evicted RuntimeEvents. */
  summarizeHistoryCompact?: HistoryCompactSummarizer;
  /** Actual route used by the configured history compactor, for durable diagnostics. */
  historyCompactRoute?: HistoryCompactRoute;
  /** Durable recorder for accepted checkpoints; persistence precedes projection. */
  recordHistoryCompactCheckpoint?: HistoryCompactCheckpointRecorder;
  /**
   * Session-scoped read of every committed model-projection transition (#4283).
   * Absent means this session cannot make a lossy model-history change durable,
   * and therefore must not make one at all.
   */
  loadModelProjectionTransitions?: ModelProjectionTransitionLoader;
  /** Durable append for one transition; persistence precedes model-visible loss. */
  recordModelProjectionTransition?: ModelProjectionTransitionLedgerRecorder;
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
}
