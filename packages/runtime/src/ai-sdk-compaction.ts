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
 * AiSdkCompaction — history-compaction / context-budget orchestrator extracted
 * from AiSdkBackend (issue #1084, runtime/compaction lane, slice 2).
 *
 * Owns the compact/synthesis-cache load and write paths that AiSdkBackend's
 * Runtime request projection drives. Behavior-neutral collaborator: methods move
 * verbatim, turn-scoped state (abortSignal, requestShapeHashBefore) is passed
 * per call, and replay/telemetry capabilities that stay on AiSdkBackend are
 * injected as host callbacks.
 */

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type {
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  BackendSendInput,
} from '@maka/core/backend-types';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';

import type { AiSdkCompactionCapabilities } from './ai-sdk-compaction-contract.js';
import {
  compactionDecisionDiagnosticPatch,
  historyCompactBlockToCompactionBoundary,
} from './compaction-boundary.js';
import {
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildContextBudgetDiagnosticShell,
  estimateRuntimeEventsTokens,
  mergeContextBudgetDiagnostic,
  mergeContextBudgetDiagnosticPatches,
  type ActiveArchivedToolResultPlaceholder,
  type ArchiveRetrievalMode,
  type ContextBudgetPolicy,
  type HistoryCompactBlock,
  type SynthesisSourceRef,
  type ToolResultArchiveRef,
} from './context-budget.js';
import {
  evaluateHistoryCompactCheckpointReplay,
  isHistoryCompactContentEvent,
} from './history-compact.js';
import { HistoryCompactSummarizerError } from './history-compact-error.js';
import { findCheckpointSummaryDefect } from './history-compact-summary-validation.js';
import {
  buildHistoryCompactCheckpoint,
  canContinueHistoryCompactCheckpointForModel,
  canReplayHistoryCompactCheckpointForModel,
  matchHistoryCompactCheckpointPrefix,
  type HistoryCompactCheckpoint,
  type HistoryCompactMemoryExtractionBoundary,
} from './history-compact-checkpoint.js';

import { createHash } from 'node:crypto';
import type { ModelMessage } from './model-protocol.js';
import type { ModelAdapter } from './model-adapter.js';
import type {
  RequestProjection,
  RequestProjectionContext,
  RequestProjectionStage,
} from './request-projection.js';
import {
  activeToolResultLineageIdentity,
  rewriteActiveToolResultsInMessages,
  type ActiveToolResultArchiveCandidate,
  type ActiveToolResultPruneDiagnosticPatch,
} from './active-tool-result-prune.js';
import type { ActiveCompactionHeadAnchor } from './active-compaction-kernel.js';
import {
  rewriteSemanticCompactInMessages,
  type SemanticCompactBlock,
  type SemanticCompactControllerState,
} from './semantic-compact.js';
import { collectStaleToolResultArchiveCandidates } from './tool-result-archive.js';

import type { ContextBudgetExhaustedDetail, SessionEvent } from '@maka/core/events';
import type { AsyncEventQueue } from './async-queue.js';
import type { MakaTool } from './tool-runtime.js';
import {
  buildRuntimeEventModelReplayPlan,
  collectToolActivityTurnIds,
  type RuntimeEventModelReplayPlan,
} from './model-history.js';
import { toolSchemaCharsForDiagnostics } from './request-shape.js';
import type { ModelCallAttempt, ModelCallKind } from '@maka/core/model-call-attempt';
import type { ProviderRequestTracker } from './provider-request-telemetry.js';
import {
  estimateNextRequestTokens,
  exceedsHighWater,
  planMidTurnCapacityCompaction,
} from './mid-turn-capacity-compact.js';
import {
  resolveContextBudgetCapacity,
  type ContextBudgetCapacity,
} from './context-budget-policy.js';
import {
  collectHistoricalImageToolResults,
  type HistoricalImageToolResult,
  omitHistoricalImageToolResults,
} from './provider-image-overflow-recovery.js';

/**
 * Image byte allowance for one turn, accumulated across its provider steps.
 *
 * Charged while a request's content is materialized, so it belongs to the turn
 * issuing that request — never to the backend, which serves several turns.
 */
export interface ProviderImageBudget {
  used: number;
  decisions: Map<string, boolean>;
}

/**
 * The turn a provider request is being built for.
 *
 * Compaction runs inside someone's turn but is owned by a Session-scoped
 * collaborator, so the issuing turn states its identity explicitly instead of
 * the collaborator reading back a shared "current" run — which, with
 * overlapping turns on one backend, can be a different run (#1990). The
 * backend's own TurnScope satisfies this structurally; nothing constructs a
 * separate origin object.
 */
export interface ProviderRequestOrigin {
  runId: string | undefined;
  imageBudget: ProviderImageBudget;
}

export interface AutomaticMemoryCompactionDispatch {
  readonly checkpoint: HistoryCompactCheckpoint;
  readonly activeTools: readonly string[];
}

export interface AutomaticMemoryCompactionDecision {
  /** Frozen into the durable checkpoint before it is recorded. */
  readonly disposition: 'eligible' | 'policy_denied';
  /** False for policy denial and transient gate unavailability. */
  readonly dispatch: boolean;
}

/** Constructor dependencies for AiSdkCompaction. */
export interface AiSdkCompactionDeps {
  input: AiSdkCompactionCapabilities;
  sessionId: string;
  now: () => number;
  modelAdapter: ModelAdapter;
  /**
   * A ready tracker for a compaction call that has none of its own. The backend
   * hands over the built tracker rather than the capture, attempt, and id sinks
   * it is made of: compaction has no business assembling metering identity.
   */
  createProviderRequestTracker: (input: {
    turnId: string;
    callKind: ModelCallKind;
    modelId: string;
    runId: string | undefined;
    historyCompactRoute?: ModelCallAttempt['historyCompactRoute'];
  }) => ProviderRequestTracker | undefined;
  /**
   * Materialize a replay plan. The image budget belongs to the turn whose
   * request this replacement is built for, so it is passed in rather than read
   * from the backend, which may be serving several turns at once.
   */
  materializeRuntimeReplayPlan: (
    plan: RuntimeEventModelReplayPlan,
    imageBudget: ProviderImageBudget,
    checkpoint?: HistoryCompactCheckpoint,
  ) => Promise<ModelMessage[]>;
  canReplayProviderNative: (plan: RuntimeEventModelReplayPlan) => boolean;
  appendTurnTailPrompt: (
    content: ModelMessage['content'],
    turnTailPrompt?: string,
  ) => ModelMessage['content'];
}

export class AiSdkCompaction {
  private readonly input: AiSdkCompactionCapabilities;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly modelAdapter: ModelAdapter;
  private readonly createProviderRequestTracker: (input: {
    turnId: string;
    callKind: ModelCallKind;
    modelId: string;
    runId: string | undefined;
    historyCompactRoute?: ModelCallAttempt['historyCompactRoute'];
  }) => ProviderRequestTracker | undefined;
  private readonly materializeRuntimeReplayPlan: (
    plan: RuntimeEventModelReplayPlan,
    imageBudget: ProviderImageBudget,
    checkpoint?: HistoryCompactCheckpoint,
  ) => Promise<ModelMessage[]>;
  private readonly canReplayProviderNative: (plan: RuntimeEventModelReplayPlan) => boolean;
  private readonly appendTurnTailPrompt: (
    content: ModelMessage['content'],
    turnTailPrompt?: string,
  ) => ModelMessage['content'];
  private historyCompactAbortController: AbortController | null = null;

  constructor(deps: AiSdkCompactionDeps) {
    this.input = deps.input;
    this.sessionId = deps.sessionId;
    this.now = deps.now;
    this.modelAdapter = deps.modelAdapter;
    this.createProviderRequestTracker = deps.createProviderRequestTracker;
    this.materializeRuntimeReplayPlan = deps.materializeRuntimeReplayPlan;
    this.canReplayProviderNative = deps.canReplayProviderNative;
    this.appendTurnTailPrompt = deps.appendTurnTailPrompt;
  }

  /** Abort an in-flight manual history compaction (called by AiSdkBackend.stop). */
  public abortHistoryCompact(): void {
    this.historyCompactAbortController?.abort();
  }

  public async loadHistoryCompactBlocks(
    policy: ContextBudgetPolicy,
  ): Promise<{ policy: ContextBudgetPolicy; diagnosticPatch?: Partial<ContextBudgetDiagnostic> }> {
    const historyCompact = policy.historyCompact;
    if (
      historyCompact?.enabled !== true ||
      (!this.input.loadHistoryCompactCheckpoint && !this.input.loadHistoryCompact)
    ) {
      return { policy };
    }
    if (historyCompact.checkpoint !== undefined || (historyCompact.blocks?.length ?? 0) > 0) {
      return { policy };
    }
    let loadFailures = 0;
    let checkpoint: HistoryCompactCheckpoint | undefined;
    try {
      checkpoint = await Promise.resolve(this.input.loadHistoryCompactCheckpoint?.());
    } catch {
      loadFailures += 1;
    }
    if (checkpoint) {
      return {
        policy: {
          ...policy,
          historyCompact: { ...historyCompact, checkpoint },
        },
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactBlocksLoaded: 1,
          historyCompactBlocksAvailable: 1,
        },
      };
    }
    if (!this.input.loadHistoryCompact) {
      return loadFailures > 0
        ? {
            policy,
            diagnosticPatch: {
              historyCompactEnabled: true,
              historyCompactMode: historyCompact.mode ?? 'deterministic',
              historyCompactLoadFailures: loadFailures,
            },
          }
        : { policy };
    }
    try {
      // No maxBytes here: the block JSON carries per-event provenance and
      // legitimately outgrows the token budget; the loader caps reads by
      // storage size, and token limits are enforced on the loaded blocks.
      const result = await Promise.resolve(
        this.input.loadHistoryCompact({
          sessionId: this.sessionId,
          maxBlocks: historyCompact.maxBlocks,
          maxEstimatedTokens: historyCompact.maxEstimatedTokens,
        }),
      );
      const blocks = result.blocks ?? [];
      return {
        policy: {
          ...policy,
          historyCompact: {
            ...historyCompact,
            blocks,
          },
        },
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactBlocksLoaded: blocks.length,
          historyCompactBlocksAvailable: blocks.length,
          ...(loadFailures > 0 ? { historyCompactLoadFailures: loadFailures } : {}),
          ...(result.skipped && result.skipped > 0
            ? { historyCompactLoadSkipped: result.skipped }
            : {}),
          ...(result.skippedReasonCounts
            ? { historyCompactLoadSkippedReasonCounts: result.skippedReasonCounts }
            : {}),
        },
      };
    } catch {
      loadFailures += 1;
      return {
        policy,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: historyCompact.mode ?? 'deterministic',
          historyCompactLoadFailures: loadFailures,
        },
      };
    }
  }

  public async loadSynthesisCacheBlocks(
    policy: ContextBudgetPolicy,
  ): Promise<{ policy: ContextBudgetPolicy; diagnosticPatch?: Partial<ContextBudgetDiagnostic> }> {
    const synthesisCache = policy.synthesisCache;
    if (synthesisCache?.enabled !== true || !this.input.loadSynthesisCache) {
      return { policy };
    }
    if ((synthesisCache.blocks?.length ?? 0) > 0) {
      return { policy };
    }
    try {
      const result = await Promise.resolve(
        this.input.loadSynthesisCache({
          sessionId: this.sessionId,
          maxBlocks: synthesisCache.maxBlocks,
          maxEstimatedTokens: synthesisCache.maxEstimatedTokens,
          maxBytes: (synthesisCache.maxEstimatedTokens ?? 2_048) * (policy.charsPerToken ?? 4),
        }),
      );
      const blocks = result.blocks ?? [];
      return {
        policy: {
          ...policy,
          synthesisCache: {
            ...synthesisCache,
            blocks,
          },
        },
        diagnosticPatch: {
          synthesisCacheEnabled: true,
          synthesisCacheMode: synthesisCache.mode ?? 'lookup',
          synthesisCacheBlocksLoaded: blocks.length,
          synthesisCacheBlocksAvailable: blocks.length,
          ...(result.skipped && result.skipped > 0
            ? { synthesisCacheLoadSkipped: result.skipped }
            : {}),
          ...(result.skippedReasonCounts
            ? { synthesisCacheLoadSkippedReasonCounts: result.skippedReasonCounts }
            : {}),
          ...(result.evicted && result.evicted > 0
            ? { synthesisCacheEvicted: result.evicted }
            : {}),
          ...(result.evictionReasonCounts
            ? { synthesisCacheEvictionReasonCounts: result.evictionReasonCounts }
            : {}),
        },
      };
    } catch {
      return {
        policy,
        diagnosticPatch: {
          synthesisCacheEnabled: true,
          synthesisCacheMode: synthesisCache.mode ?? 'lookup',
          synthesisCacheLoadFailures: 1,
        },
      };
    }
  }

  public async writeSynthesisCacheBlocks(input: {
    requestShapeHashBefore?: string;
    turnId: string;
    query: string;
    hydratedRuntimeEvents: RuntimeEvent[];
    retrievedArchiveRefs: SynthesisSourceRef[];
    archiveRetrievalMode: ArchiveRetrievalMode;
    contextBudget: ContextBudgetPolicy;
  }): Promise<Partial<ContextBudgetDiagnostic>> {
    const synthesisCache = input.contextBudget.synthesisCache;
    if (
      synthesisCache?.enabled !== true ||
      synthesisCache.mode !== 'read_write' ||
      !this.input.writeSynthesisCache
    ) {
      return {};
    }
    const limits = {
      maxBlocks: synthesisCache.maxBlocks ?? 1,
      maxBlockEstimatedTokens: synthesisCache.maxBlockEstimatedTokens ?? 1_024,
      maxEstimatedTokens: synthesisCache.maxEstimatedTokens ?? 2_048,
      charsPerToken: input.contextBudget.charsPerToken ?? 4,
    };
    try {
      const result = await Promise.resolve(
        this.input.writeSynthesisCache({
          sessionId: this.sessionId,
          turnId: input.turnId,
          source: {
            createdFrom:
              input.archiveRetrievalMode === 'history_search_gated'
                ? 'gated_archive_retrieval'
                : 'eager_archive_retrieval',
            query: input.query,
            hydratedRuntimeEvents: input.hydratedRuntimeEvents,
            retrievedArchiveRefs: input.retrievedArchiveRefs,
            archiveRetrievalMode: input.archiveRetrievalMode,
          },
          limits,
          requestShapeHashBefore: input.requestShapeHashBefore,
        }),
      );
      const blocks = result?.blocks ?? [];
      const estimatedTokens = blocks.reduce(
        (total, block) => total + (block.estimatedTokens ?? 0),
        0,
      );
      return {
        synthesisCacheEnabled: true,
        synthesisCacheMode: 'read_write',
        synthesisCacheWritesAttempted: 1,
        synthesisCacheBlocksWritten: blocks.length,
        ...(blocks.length > 0
          ? {
              synthesisCacheWrittenBlockIds: blocks.map((block) => block.blockId),
              synthesisCacheWriteEstimatedTokens: estimatedTokens,
              highWaterName: blocks[0]!.highWaterName,
              highWaterSeq: blocks[0]!.highWaterSeq,
              highWaterReason: 'synthesis_cache_write',
            }
          : {}),
        ...(result?.skipped && result.skipped > 0
          ? { synthesisCacheWriteSkipped: result.skipped }
          : {}),
        ...(result?.skippedReasonCounts
          ? { synthesisCacheWriteSkippedReasonCounts: result.skippedReasonCounts }
          : {}),
      };
    } catch {
      return {
        synthesisCacheEnabled: true,
        synthesisCacheMode: 'read_write',
        synthesisCacheWritesAttempted: 1,
        synthesisCacheWriteFailures: 1,
      };
    }
  }

  public async writeHistoryCompactCheckpoint(input: {
    requestShapeHashBefore?: string;
    automaticMemoryBoundary?: HistoryCompactMemoryExtractionBoundary;
    turnId: string;
    /**
     * The run this summarization is billed to. Always stated by the caller:
     * mid-send the backend cannot resolve it, because one backend instance
     * serves several concurrent runs (#1990). Required-but-nullable so a call
     * site cannot drop attribution by omission.
     */
    runId: string | undefined;
    contextBudget: ContextBudgetPolicy;
    priorRuntimeContext: readonly RuntimeEvent[];
    draftBlock: HistoryCompactBlock;
    abortSignal?: AbortSignal;
  }): Promise<{
    diagnosticPatch: Partial<ContextBudgetDiagnostic>;
    replacementCheckpoint?: HistoryCompactCheckpoint;
    fallbackCheckpoint?: HistoryCompactCheckpoint;
  }> {
    const summarizer = this.input.summarizeHistoryCompact;
    const recorder = this.input.recordHistoryCompactCheckpoint;
    if (!summarizer || !recorder) return { diagnosticPatch: {} };
    // One tracker for this summarization, built where every input lives.
    const historyCompactTracker = this.createProviderRequestTracker({
      turnId: input.turnId,
      callKind: 'history_compact',
      modelId: this.input.modelId,
      runId: input.runId,
      ...(this.input.historyCompactRoute
        ? { historyCompactRoute: this.input.historyCompactRoute }
        : {}),
    });
    const foldedIds = new Set(input.draftBlock.coverage.runtimeEventIds);
    const foldedRuntimeEvents = input.priorRuntimeContext.filter((event) =>
      foldedIds.has(event.id),
    );
    if (foldedRuntimeEvents.length === 0) {
      return {
        diagnosticPatch: {
          historyCompactWritesAttempted: 0,
          historyCompactWriteSkipped: 1,
          historyCompactWriteSkippedReasonCounts: { source_missing: 1 },
        },
      };
    }
    const loadedCheckpoint = input.contextBudget.historyCompact?.checkpoint;
    const checkpointMatch = loadedCheckpoint
      ? matchHistoryCompactCheckpointPrefix(loadedCheckpoint, foldedRuntimeEvents)
      : undefined;
    const previousCheckpoint =
      checkpointMatch &&
      !checkpointMatch.reason &&
      loadedCheckpoint &&
      canContinueHistoryCompactCheckpointForModel(
        loadedCheckpoint,
        this.input.connection,
        this.input.modelId,
      )
        ? loadedCheckpoint
        : undefined;
    const newlyFoldedRuntimeEvents = previousCheckpoint
      ? checkpointMatch!.successorRuntimeEvents
      : foldedRuntimeEvents;
    const retainedRuntimeEvents = input.priorRuntimeContext.filter(
      (event) => !foldedIds.has(event.id) && !event.id.startsWith('history-compact:'),
    );
    const previousCheckpointFitsCurrentLimits =
      previousCheckpoint !== undefined &&
      evaluateHistoryCompactCheckpointReplay(
        previousCheckpoint,
        retainedRuntimeEvents,
        input.contextBudget?.charsPerToken,
        input.contextBudget?.maxHistoryEstimatedTokens,
        { sourceReplayEvents: [...foldedRuntimeEvents, ...retainedRuntimeEvents] },
      ).fits;
    if (
      previousCheckpoint &&
      newlyFoldedRuntimeEvents.length === 0 &&
      previousCheckpointFitsCurrentLimits
    ) {
      return {
        fallbackCheckpoint: previousCheckpoint,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: 0,
          historyCompactWriteSkipped: 1,
          historyCompactWriteSkippedReasonCounts: { already_compacted: 1 },
          historyCompactBlocksAvailable: 1,
          historyCompactBlocksSelected: 1,
          historyCompactBlockIds: [previousCheckpoint.checkpointId],
          historyCompactedTurns: previousCheckpoint.coverage.turnCount,
          historyCompactedEvents: previousCheckpoint.coverage.eventCount,
          historyCompactedEstimatedTokensAfter: previousCheckpoint.estimatedTokens,
          historyCompactCoverageHashes: [previousCheckpoint.coverage.sourceDigest],
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'unchanged',
            boundaryKind: 'historyCompact',
            boundaryIds: [previousCheckpoint.checkpointId],
            reason: 'already_compacted',
          }),
        },
      };
    }
    try {
      const compacted = await Promise.resolve(
        summarizer({
          sessionId: this.sessionId,
          turnId: input.turnId,
          source: { foldedRuntimeEvents },
          ...(previousCheckpoint ? { previousCheckpoint } : {}),
          newlyFoldedRuntimeEvents,
          ...(input.contextBudget.maxHistoryEstimatedTokens !== undefined
            ? {
                inputBudget: {
                  maxEstimatedTokens: input.contextBudget.maxHistoryEstimatedTokens,
                  charsPerToken: input.contextBudget.charsPerToken ?? 4,
                },
              }
            : {}),
          requestShapeHashBefore: input.requestShapeHashBefore,
          abortSignal: input.abortSignal,
          ...(historyCompactTracker ? { providerRequestTracker: historyCompactTracker } : {}),
        }),
      );
      if (compacted === undefined || (typeof compacted === 'string' && !compacted.trim())) {
        return {
          ...(previousCheckpoint ? { fallbackCheckpoint: previousCheckpoint } : {}),
          diagnosticPatch: {
            historyCompactEnabled: true,
            historyCompactMode: 'read_write',
            historyCompactWritesAttempted: 1,
            historyCompactWriteFailures: 1,
            historyCompactWriteSkippedReasonCounts: { empty_summary: 1 },
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: 'empty_summary',
            }),
          },
        };
      }
      // The write gate enforces the invariant regardless of which summarizer
      // produced the text (#3029): a malformed summary must not replace
      // folded history. The default summarizer already threw with the same
      // reasons; any other producer is validated here, and the enclosing
      // catch maps the reason into the fail-open diagnostics.
      if (typeof compacted === 'string') {
        const defect = findCheckpointSummaryDefect(compacted, {
          coveredRuntimeEvents: foldedRuntimeEvents,
          ...(input.contextBudget.charsPerToken !== undefined
            ? { charsPerToken: input.contextBudget.charsPerToken }
            : {}),
        });
        if (defect) throw new HistoryCompactSummarizerError(defect);
      }
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: this.sessionId,
        coveredRuntimeEvents: foldedRuntimeEvents,
        ...(typeof compacted === 'string' ? { summary: compacted } : { providerState: compacted }),
        highWaterName: input.draftBlock.highWaterName,
        highWaterSeq: input.draftBlock.highWaterSeq,
        ...(previousCheckpoint ? { previousCheckpointId: previousCheckpoint.checkpointId } : {}),
        ...(input.automaticMemoryBoundary
          ? { memoryExtractionBoundary: input.automaticMemoryBoundary }
          : {}),
        charsPerToken: input.contextBudget.charsPerToken,
        now: this.now(),
      });
      const replayFit = evaluateHistoryCompactCheckpointReplay(
        checkpoint,
        retainedRuntimeEvents,
        input.contextBudget?.charsPerToken,
        input.contextBudget?.maxHistoryEstimatedTokens,
        { sourceReplayEvents: [...foldedRuntimeEvents, ...retainedRuntimeEvents] },
      );
      const rejectedReason = !replayFit.fits ? replayFit.reason : undefined;
      if (rejectedReason) {
        return {
          ...(previousCheckpoint ? { fallbackCheckpoint: previousCheckpoint } : {}),
          diagnosticPatch: {
            historyCompactEnabled: true,
            historyCompactMode: 'read_write',
            historyCompactWritesAttempted: 1,
            historyCompactWriteFailures: 1,
            historyCompactWriteSkippedReasonCounts: { [rejectedReason]: 1 },
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: rejectedReason,
            }),
          },
        };
      }
      await Promise.resolve(recorder(checkpoint, input.turnId));
      return {
        replacementCheckpoint: checkpoint,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: 1,
          historyCompactBlocksWritten: 1,
          historyCompactWrittenBlockIds: [checkpoint.checkpointId],
          historyCompactWriteEstimatedTokens: checkpoint.estimatedTokens,
          historyCompactBlockIds: [checkpoint.checkpointId],
          historyCompactedEstimatedTokensAfter: checkpoint.estimatedTokens,
          highWaterName: checkpoint.highWaterName,
          highWaterSeq: checkpoint.highWaterSeq,
          highWaterReason: 'history_compact',
        },
      };
    } catch (error) {
      const failureReason =
        error instanceof HistoryCompactSummarizerError ? error.reason : 'write_failed';
      return {
        ...(previousCheckpoint ? { fallbackCheckpoint: previousCheckpoint } : {}),
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: 1,
          historyCompactWriteFailures: 1,
          historyCompactWriteSkippedReasonCounts: { [failureReason]: 1 },
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            boundaryKind: 'historyCompact',
            failOpenReason: failureReason,
          }),
        },
      };
    }
  }

  public async writeHistoryCompactBlocks(input: {
    requestShapeHashBefore?: string;
    turnId: string;
    contextBudget: ContextBudgetPolicy;
    priorRuntimeContext: readonly RuntimeEvent[];
    draftBlocks: HistoryCompactBlock[];
    abortSignal?: AbortSignal;
  }): Promise<{
    diagnosticPatch: Partial<ContextBudgetDiagnostic>;
    replacementBlocks: HistoryCompactBlock[];
  }> {
    const historyCompact = input.contextBudget.historyCompact;
    if (
      historyCompact?.enabled !== true ||
      historyCompact.mode !== 'read_write' ||
      !this.input.writeHistoryCompact
    ) {
      return { diagnosticPatch: {}, replacementBlocks: [] };
    }
    const limits = {
      maxBlocks: historyCompact.maxBlocks ?? 1,
      maxBlockEstimatedTokens:
        historyCompact.maxBlockEstimatedTokens ?? historyCompact.maxSummaryEstimatedTokens ?? 1_024,
      maxEstimatedTokens: historyCompact.maxEstimatedTokens ?? 2_048,
      charsPerToken: input.contextBudget.charsPerToken ?? 4,
    };
    const replacementBlocks: HistoryCompactBlock[] = [];
    let writesAttempted = 0;
    let written = 0;
    let skipped = 0;
    const skippedReasonCounts: Record<string, number> = {};
    try {
      for (const draftBlock of input.draftBlocks.slice(0, limits.maxBlocks)) {
        const foldedIds = new Set(draftBlock.coverage.runtimeEventIds);
        const foldedRuntimeEvents = input.priorRuntimeContext.filter((event) =>
          foldedIds.has(event.id),
        );
        if (foldedRuntimeEvents.length === 0) {
          skipped += 1;
          incrementRecord(skippedReasonCounts, 'source_missing');
          continue;
        }
        writesAttempted += 1;
        const result = await Promise.resolve(
          this.input.writeHistoryCompact({
            sessionId: this.sessionId,
            turnId: input.turnId,
            source: {
              draftBlock,
              foldedRuntimeEvents,
            },
            limits,
            requestShapeHashBefore: input.requestShapeHashBefore,
            abortSignal: input.abortSignal,
          }),
        );
        const blocks = result?.blocks ?? [];
        if (result?.skipped && result.skipped > 0) {
          skipped += result.skipped;
          mergeCountsInto(skippedReasonCounts, result.skippedReasonCounts);
        }
        for (const block of blocks) {
          replacementBlocks.push(block);
          written += 1;
        }
      }
      const estimatedTokens = replacementBlocks.reduce(
        (total, block) => total + (block.estimatedTokens ?? 0),
        0,
      );
      const replacementRuntimeEventIds = new Set(
        replacementBlocks.flatMap((block) => block.coverage.runtimeEventIds),
      );
      const estimatedTokensBefore = estimateRuntimeEventsTokens(
        input.priorRuntimeContext.filter((event) => replacementRuntimeEventIds.has(event.id)),
        limits.charsPerToken,
      );
      const replacementDecisionPatch =
        replacementBlocks.length > 0
          ? compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'replaced',
              boundaryKind: 'historyCompact',
              boundaryIds: replacementBlocks.map(
                (block) => historyCompactBlockToCompactionBoundary(block).boundaryId,
              ),
              coverage: {
                turnIds: Array.from(
                  new Set(replacementBlocks.flatMap((block) => block.coverage.turnIds)),
                ),
                runtimeEventIds: Array.from(replacementRuntimeEventIds),
                contentKinds: Array.from(
                  new Set(replacementBlocks.flatMap((block) => block.coverage.contentKinds)),
                ),
                bodySha256: replacementBlocks.flatMap((block) => block.coverage.bodySha256),
              },
              estimatedTokensBefore,
              estimatedTokensAfter: estimatedTokens,
            })
          : compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              boundaryKind: 'historyCompact',
              failOpenReason: Object.keys(skippedReasonCounts)[0] ?? 'write_empty',
              ...(Object.keys(skippedReasonCounts).length > 0 ? { skippedReasonCounts } : {}),
            });
      return {
        replacementBlocks,
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: writesAttempted,
          historyCompactBlocksWritten: written,
          ...(replacementBlocks.length > 0
            ? {
                historyCompactWrittenBlockIds: replacementBlocks.map((block) => block.blockId),
                historyCompactWriteEstimatedTokens: estimatedTokens,
                historyCompactBlockIds: replacementBlocks.map((block) => block.blockId),
                historyCompactedEstimatedTokensAfter: estimatedTokens,
                highWaterName: replacementBlocks[0]!.highWaterName,
                highWaterSeq: replacementBlocks[0]!.highWaterSeq,
                highWaterReason: 'history_compact',
              }
            : {}),
          ...(skipped > 0 ? { historyCompactWriteSkipped: skipped } : {}),
          ...(Object.keys(skippedReasonCounts).length > 0
            ? { historyCompactWriteSkippedReasonCounts: skippedReasonCounts }
            : {}),
          ...replacementDecisionPatch,
        },
      };
    } catch {
      return {
        replacementBlocks: [],
        diagnosticPatch: {
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          historyCompactWritesAttempted: writesAttempted || 1,
          historyCompactWriteFailures: 1,
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            boundaryKind: 'historyCompact',
            failOpenReason: 'write_failed',
          }),
        },
      };
    }
  }

  public async compactHistory(
    input: BackendCompactHistoryInput,
    requestShapeHashBefore?: string,
  ): Promise<BackendCompactHistoryResult> {
    const historyCompactAbortController = new AbortController();
    this.historyCompactAbortController = historyCompactAbortController;
    try {
      const runtimeContext = input.runtimeContext.filter((event) => event.turnId !== input.turnId);
      const policy = this.buildManualHistoryCompactPolicy(runtimeContext, input.minRecentTurns);
      if (!policy) return {};

      const contextBudget = policy;
      const budgeted = applyRuntimeEventContextBudget(runtimeContext, contextBudget, {
        historyCompactProtocol: this.hasHistoryCompactCheckpointWriter()
          ? 'checkpoint_v2'
          : 'legacy_v1',
      });
      let contextBudgetDiagnostic = budgeted?.diagnostic;

      if (
        budgeted?.historyCompactBlocks?.length &&
        contextBudget.historyCompact?.mode === 'read_write' &&
        this.hasHistoryCompactWriter()
      ) {
        const loadedBlockIds = new Set(
          (contextBudget.historyCompact.blocks ?? []).map((block) => block.blockId),
        );
        const draftBlocks = budgeted.historyCompactBlocks.filter(
          (block) => !loadedBlockIds.has(block.blockId),
        );
        if (draftBlocks.length > 0) {
          if (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint) {
            let writeContextBudget = contextBudget;
            try {
              const checkpoint = await Promise.resolve(this.input.loadHistoryCompactCheckpoint?.());
              if (checkpoint) {
                writeContextBudget = {
                  ...contextBudget,
                  historyCompact: { ...contextBudget.historyCompact!, checkpoint },
                };
              }
            } catch {
              // A missing previous checkpoint only loses rolling reuse; the current fold remains safe to summarize.
            }
            const writePatch = await this.writeHistoryCompactCheckpoint({
              turnId: input.turnId,
              // A manual compaction names its own run: nothing else can (#1679).
              runId: input.runId,
              contextBudget: writeContextBudget,
              priorRuntimeContext: runtimeContext,
              draftBlock: draftBlocks[0]!,
              abortSignal: historyCompactAbortController.signal,
              requestShapeHashBefore,
            });
            if (historyCompactAbortController.signal.aborted) return {};
            contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
              contextBudgetDiagnostic ??
                buildContextBudgetDiagnosticShell(runtimeContext, budgeted.events, contextBudget),
              writePatch.diagnosticPatch,
            );
          } else {
            const writePatch = await this.writeHistoryCompactBlocks({
              turnId: input.turnId,
              contextBudget,
              priorRuntimeContext: runtimeContext,
              draftBlocks,
              abortSignal: historyCompactAbortController.signal,
              requestShapeHashBefore,
            });
            if (historyCompactAbortController.signal.aborted) return {};
            if (writePatch.replacementBlocks.length === 0) {
              contextBudgetDiagnostic = buildContextBudgetDiagnosticShell(
                runtimeContext,
                runtimeContext,
                contextBudget,
              );
            }
            contextBudgetDiagnostic = mergeContextBudgetDiagnostic(
              contextBudgetDiagnostic ??
                buildContextBudgetDiagnosticShell(runtimeContext, budgeted.events, contextBudget),
              writePatch.diagnosticPatch,
            );
          }
        }
      }

      return contextBudgetDiagnostic ? { contextBudget: contextBudgetDiagnostic } : {};
    } finally {
      if (this.historyCompactAbortController === historyCompactAbortController) {
        this.historyCompactAbortController = null;
      }
    }
  }

  private buildManualHistoryCompactPolicy(
    runtimeContext: readonly RuntimeEvent[],
    minRecentTurnsOverride?: number,
  ): ContextBudgetPolicy | undefined {
    if (runtimeContext.length === 0 || !this.input.contextBudget || !this.hasHistoryCompactWriter())
      return undefined;
    const base = this.input.contextBudget;
    const charsPerToken = base.charsPerToken ?? 4;
    const estimatedTokens = Math.max(1, estimateRuntimeEventsTokens(runtimeContext, charsPerToken));
    const current = base.historyCompact;
    const currentWithoutBlocks = { ...current };
    delete currentWithoutBlocks.blocks;
    delete currentWithoutBlocks.checkpoint;
    const maxHistoryEstimatedTokens =
      base.maxHistoryEstimatedTokens ?? Math.max(estimatedTokens, 32_000);
    return {
      name: base.name ?? 'manual-history-compact',
      ...(base.charsPerToken !== undefined ? { charsPerToken: base.charsPerToken } : {}),
      maxHistoryEstimatedTokens,
      minRecentTurns: minRecentTurnsOverride ?? current?.minRecentTurns ?? base.minRecentTurns ?? 1,
      historyCompact: {
        ...currentWithoutBlocks,
        enabled: true,
        mode: 'read_write',
        highWaterRatio: 0.000001,
        targetRatio: current?.targetRatio ?? 0.2,
        tailEstimatedTokens: 1,
        minRecentTurns:
          minRecentTurnsOverride ?? current?.minRecentTurns ?? base.minRecentTurns ?? 1,
        maxBlocks: current?.maxBlocks ?? 1,
        maxEstimatedTokens: current?.maxEstimatedTokens ?? 2048,
        maxBlockEstimatedTokens:
          current?.maxBlockEstimatedTokens ?? current?.maxSummaryEstimatedTokens ?? 1024,
        highWaterName: current?.highWaterName ?? `${base.name ?? 'manual'}-manual-history-compact`,
      },
    };
  }

  public hasHistoryCompactWriter(): boolean {
    return Boolean(
      this.input.writeHistoryCompact ||
        (this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint),
    );
  }

  public hasHistoryCompactCheckpointWriter(): boolean {
    return Boolean(this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint);
  }

  public async prepareContextBudgetPolicy(runtimeContext: readonly RuntimeEvent[]): Promise<{
    policy: ContextBudgetPolicy | undefined;
    diagnosticPatch?: Partial<ContextBudgetDiagnostic>;
  }> {
    const policy = this.input.contextBudget;
    if (!policy) return { policy };
    let nextPolicy = policy;

    if (policy.staleToolResultPrune?.enabled === true) {
      const candidates = collectStaleToolResultArchiveCandidates(
        runtimeContext,
        policy?.staleToolResultPrune,
        policy?.charsPerToken ?? 4,
        policy?.minRecentTurns,
      );
      if (candidates.length > 0) {
        const archiveRefs = new Map<string, ToolResultArchiveRef>();
        const existingArchiveRefs = nextPolicy.staleToolResultPrune?.archiveRefs;
        if (Array.isArray(existingArchiveRefs)) {
          for (const ref of existingArchiveRefs) archiveRefs.set(ref.runtimeEventId, ref);
        } else if (existingArchiveRefs) {
          for (const ref of Object.values(existingArchiveRefs))
            archiveRefs.set(ref.runtimeEventId, ref);
        }
        for (const candidate of candidates) {
          const bodySha256 = sha256(candidate.serializedResult);
          const archived = await Promise.resolve(
            this.input.toolResultArchive?.services.archiveToolResult({
              ...candidate,
              sessionId: this.sessionId,
              bodySha256,
            }),
          ).catch(() => undefined);
          if (!archived?.artifactId) continue;
          archiveRefs.set(candidate.runtimeEventId, {
            runtimeEventId: candidate.runtimeEventId,
            toolCallId: candidate.toolCallId,
            toolName: candidate.toolName,
            artifactId: archived.artifactId,
            bodySha256,
            originalEstimatedTokens: candidate.originalEstimatedTokens,
            originalBytes: candidate.originalBytes,
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: candidate.reason,
          });
        }

        nextPolicy = {
          ...nextPolicy,
          staleToolResultPrune: {
            ...nextPolicy.staleToolResultPrune!,
            archiveRefs: [...archiveRefs.values()],
          },
        };
      }
    }

    const compactLoadPatch = await this.loadHistoryCompactBlocks(nextPolicy);
    if (compactLoadPatch.policy !== nextPolicy) nextPolicy = compactLoadPatch.policy;
    const loadedCheckpoint = nextPolicy.historyCompact?.checkpoint;
    if (
      loadedCheckpoint &&
      !canReplayHistoryCompactCheckpointForModel(
        loadedCheckpoint,
        this.input.connection,
        this.input.modelId,
      )
    ) {
      const { checkpoint: _incompatibleCheckpoint, ...historyCompact } = nextPolicy.historyCompact!;
      nextPolicy = { ...nextPolicy, historyCompact };
    }
    const loadPatch = await this.loadSynthesisCacheBlocks(nextPolicy);
    if (loadPatch.policy !== nextPolicy) nextPolicy = loadPatch.policy;
    const diagnosticPatch = mergeContextBudgetDiagnosticPatches(
      compactLoadPatch.diagnosticPatch,
      loadPatch.diagnosticPatch,
    );
    return {
      policy: nextPolicy,
      ...(diagnosticPatch ? { diagnosticPatch } : {}),
    };
  }

  public buildActiveToolResultPruneProjection(
    turnId: string,
    includeNewestStep: boolean,
    onDiagnosticPatch?: (patch: ActiveToolResultPruneDiagnosticPatch) => void,
  ): RequestProjectionStage | undefined {
    const policy = this.input.contextBudget?.activeToolResultPrune;
    if (policy?.enabled !== true) return undefined;

    const archivedPlaceholders = new Map<string, ActiveArchivedToolResultPlaceholder>();
    return async (options) => {
      const eligibleToolCallIds = collectPrunableCompletedStepToolCallIds(
        options.completedSteps,
        includeNewestStep,
      );
      if (eligibleToolCallIds.size === 0) return undefined;
      const rewritten = await rewriteActiveToolResultsInMessages({
        messages: options.messages,
        policy,
        stepNumber: options.stepNumber,
        turnId,
        charsPerToken: this.input.contextBudget?.charsPerToken,
        eligibleToolCallIds,
        completedToolCalls: options.completedSteps.flatMap((step, stepNumber) =>
          (step.toolCalls ?? []).map((call) => ({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
            stepNumber,
          })),
        ),
        archivedPlaceholders,
        archiveToolResult: async (candidate) => {
          return await Promise.resolve(
            this.input.toolResultArchive?.services.archiveToolResult({
              ...candidate,
              sessionId: this.sessionId,
              runtimeEventId: candidate.runtimeEventId ?? activeToolResultArchiveKey(candidate),
            }),
          );
        },
      });
      if (hasActiveToolResultPruneDiagnosticPatch(rewritten.diagnosticPatch)) {
        onDiagnosticPatch?.(rewritten.diagnosticPatch);
      }
      return rewritten.rewritten > 0 ? { messages: rewritten.messages } : undefined;
    };
  }

  public buildSemanticCompactProjection(
    turnId: string,
    model: unknown,
    runtimeEvents: readonly RuntimeEvent[] | undefined,
    headAnchor: ActiveCompactionHeadAnchor | undefined,
    requestShapeHashForMessages: (
      messages: readonly ModelMessage[],
      activeToolsForStep: readonly string[] | undefined,
    ) => string,
    onDiagnosticPatch: ((patch: Partial<ContextBudgetDiagnostic>) => void) | undefined,
    origin: ProviderRequestOrigin,
    abortSignal?: AbortSignal,
  ): RequestProjectionStage | undefined {
    const policy = this.input.contextBudget?.semanticCompact;
    if (policy?.enabled !== true || policy.mode === 'off' || !headAnchor) return undefined;

    let acceptedProjection: AcceptedActiveCompactionProjection | undefined;
    const controllerState: SemanticCompactControllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
    };
    // One auxiliary trace per turn rather than per call: a step that summarizes
    // is a step of that trace, so a retried summarization is another attempt of
    // the same logical call. Built on first use — most turns never summarize,
    // and an unused trace id is a trace that never happened.
    const summarizerModelId = policy.summarizerModel ?? this.input.modelId;
    let summaryTracker: ProviderRequestTracker | undefined;
    let summaryTrackerBuilt = false;
    const resolveSummaryTracker = (): ProviderRequestTracker | undefined => {
      if (!summaryTrackerBuilt) {
        summaryTrackerBuilt = true;
        summaryTracker = this.createProviderRequestTracker({
          turnId,
          callKind: 'semantic_compact',
          modelId: summarizerModelId,
          runId: origin.runId,
        });
      }
      return summaryTracker;
    };
    return async (options) => {
      const activeToolsForStep = options.activeTools;
      const dryRun = policy.mode === 'validate_only' || policy.mode === 'prepare_step_dry_run';
      const incomingMessages = options.messages;
      const projectedMessages = dryRun
        ? undefined
        : projectAcceptedActiveCompactionMessages(incomingMessages, acceptedProjection);
      const messagesForRewrite = projectedMessages ?? incomingMessages;
      const summarizerModel = policy.summarizerModel
        ? this.input.modelFactory({
            connection: this.input.connection,
            apiKey: this.input.apiKey,
            modelId: policy.summarizerModel,
          })
        : model;
      const rewritten = await rewriteSemanticCompactInMessages({
        sessionId: this.sessionId,
        turnId,
        messages: messagesForRewrite,
        policy,
        controllerState,
        runtimeEvents: runtimeEvents?.filter((event) => event.turnId === turnId),
        stepNumber: options.stepNumber,
        now: this.now(),
        charsPerToken: this.input.contextBudget?.charsPerToken,
        requestShapeHashForMessages: (messages) =>
          requestShapeHashForMessages(messages, activeToolsForStep),
        headAnchor,
        ...(acceptedProjection?.semanticBlock
          ? { predecessorBlock: acceptedProjection.semanticBlock }
          : {}),
        abortSignal: abortSignal,
        summarizer: async (request) => {
          // The tracker settles this call itself, on the success, failure, and
          // abort paths alike, so the summarization is metered as the physical
          // provider request it is instead of a hand-built row (#1679).
          const tracker = resolveSummaryTracker();
          tracker?.setStep(options.stepNumber);
          return await this.modelAdapter.generateCompactSummary({
            model: summarizerModel,
            system: request.system,
            messages: request.messages,
            maxOutputTokens: request.maxOutputTokens,
            abortSignal: request.abortSignal,
            ...(tracker ? { providerRequestTracker: tracker } : {}),
          });
        },
      });
      onDiagnosticPatch?.({
        semanticCompactEnabled: true,
        semanticCompactMode: policy.mode ?? 'replace',
        ...rewritten.diagnosticPatch,
      });
      if (!dryRun && rewritten.decision === 'replaced') {
        if (rewritten.block) this.recordSemanticCompactBlock(rewritten.block);
        acceptedProjection = {
          sourceSignatures: incomingMessages.map(projectionSourceMessageSignature),
          sourceSignatureMode: 'active_prune_lineage',
          projectedMessages: rewritten.messages,
          ...(rewritten.block ? { semanticBlock: rewritten.block } : {}),
        };
        return {
          messages: rewritten.messages,
        };
      }
      return !dryRun && projectedMessages ? { messages: projectedMessages } : undefined;
    };
  }

  private recordSemanticCompactBlock(block: SemanticCompactBlock): void {
    const recorder = this.input.recordSemanticCompactBlock;
    if (!recorder) return;
    try {
      const result = recorder(block);
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch(() => {
          // Semantic compact persistence is diagnostic/storage-only and must
          // never perturb provider request projection or tool-loop progress.
        });
      }
    } catch {
      // Semantic compact persistence is diagnostic/storage-only and must never
      // perturb provider request projection or tool-loop progress.
    }
  }

  /**
   * Mid-turn capacity compaction eligibility (issue #882 PR 1). Explicit
   * opt-in via `historyCompact.midTurn.enabled`; requires the checkpoint
   * writer seams plus the durable turn-ledger read, the persisted head anchor
   * for this turn, and a bounded capacity window.
   */
  public buildMidTurnCapacityCompactState(
    input: BackendSendInput,
  ): MidTurnCapacityCompactState | undefined {
    const policy = this.input.contextBudget;
    if (this.input.allowMidTurnHistoryCompaction !== true) return undefined;
    if (
      policy?.historyCompact?.enabled !== true ||
      policy.historyCompact.midTurn?.enabled !== true
    ) {
      return undefined;
    }
    if (
      !this.input.summarizeHistoryCompact ||
      !this.input.recordHistoryCompactCheckpoint ||
      !this.input.loadTurnRuntimeEvents
    ) {
      return undefined;
    }
    const headAnchor = input.headAnchorRuntimeEvent;
    if (
      !headAnchor ||
      headAnchor.sessionId !== this.sessionId ||
      headAnchor.turnId !== input.turnId ||
      headAnchor.role !== 'user' ||
      headAnchor.author !== 'user' ||
      !isHistoryCompactContentEvent(headAnchor)
    ) {
      return undefined;
    }
    const capacity = resolveContextBudgetCapacity(
      this.input.connection,
      this.input.modelId,
      policy,
    );
    if (capacity === undefined) return undefined;
    const priorContentEvents = (input.runtimeContext ?? [])
      .filter((event) => event.turnId !== input.turnId)
      .filter(isHistoryCompactContentEvent);
    return new MidTurnCapacityCompactState(headAnchor, priorContentEvents, capacity);
  }

  /**
   * Request-projection stage for the mid-turn capacity invariant: between
   * steps of one turn, estimate the next provider request (last step's real
   * usage + a signed char/4 payload delta, tool schemas included) against
   * `contextWindow - reserve`; over the high-water, fold a safe completed
   * prefix into a durable mid_turn checkpoint and continue the same turn on
   * `[compact block, verbatim head anchor, preserved tail]`.
   *
   * This hook never terminates the turn: every failure fails open with a
   * diagnostic and records itself for the final-request estimate owner, which
   * re-measures the payload after ALL shaping (including active tool-result
   * pruning, which runs later and can still rescue the step) and issues the
   * context_budget_exhausted verdict only when the request that would really
   * go out exceeds the window. The trigger threshold here is deliberately
   * approximate — a missed or spurious trigger is recoverable; the verdict is
   * not, so it does not live here.
   */
  public buildMidTurnCapacityCompactProjection(
    turnId: string,
    state: MidTurnCapacityCompactState | undefined,
    queue: AsyncEventQueue<SessionEvent>,
    providerTools: readonly MakaTool[],
    fallbackActiveTools: () => readonly string[],
    turnTailPrompt: string | undefined,
    systemPromptChars: number,
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void,
    origin: ProviderRequestOrigin,
    memoryCompactionDecision?: () => AutomaticMemoryCompactionDecision,
    onMemoryCompaction?: (input: AutomaticMemoryCompactionDispatch) => void,
    abortSignal?: AbortSignal,
  ): RequestProjectionStage | undefined {
    if (!state) return undefined;
    const policy = this.input.contextBudget!;
    const compactPolicy = policy.historyCompact!;
    const midTurn = compactPolicy.midTurn!;
    const charsPerToken = policy.charsPerToken ?? 4;
    const reserveTokens = midTurn.reserveTokens ?? 16_384;
    let acceptedProjection: AcceptedActiveCompactionProjection | undefined;

    return async (options) => {
      const incomingMessages = options.messages;
      let projectedMessages = projectAcceptedActiveCompactionMessages(
        incomingMessages,
        acceptedProjection,
      );
      projectedMessages =
        projectHistoricalImageOmissions(
          projectedMessages ?? incomingMessages,
          state.omittedImageToolResults,
        ) ?? projectedMessages;
      const keepProjection = (): RequestProjection | undefined =>
        projectedMessages ? { messages: projectedMessages } : undefined;
      // Step 0 is shaped by the pre_turn path; the mid-turn trigger only runs
      // between steps, once completed-step usage and events exist.
      if (options.stepNumber < 1 || state.exhaustedDetail) return keepProjection();

      // Real usage for the last finished step, read synchronously from the
      // SDK's own step results (the same numbers the finish-step chunk
      // carries) — no coupling to how far the stream consumer has advanced.
      // Baseline = the last request's INPUT tokens only (see the state field
      // doc: the payload delta already carries the step's output). The
      // adapter fails closed on missing token counts (undefined, #972), and a
      // provider can still report a zero input outright — either way a
      // non-positive input count is unusable for estimation, so clear the
      // baseline and let the estimate fall back to the whole-payload cold
      // start instead of "0 + delta".
      //
      // The usage anchor is only meaningful PAIRED with the payload baseline
      // of the request it was reported for (`lastRequestPayloadChars`). A
      // successful overflow recovery restructures the request and resets that
      // baseline to undefined: the send-global steps view still carries the
      // dead attempt's last usage, but anchoring on it against the rejected
      // request's chars would under-estimate the retry by the whole previous
      // step growth — so a missing baseline forces the whole-payload cold
      // start, exactly like a missing usage sample.
      const lastStepInputTokens = options.completedSteps.at(-1)?.usage?.inputTokens;
      state.lastRequestInputTokens =
        state.lastRequestPayloadChars !== undefined &&
        lastStepInputTokens !== undefined &&
        Number.isFinite(lastStepInputTokens) &&
        lastStepInputTokens > 0
          ? lastStepInputTokens
          : undefined;

      // A skipped trigger is never silent: every failure-driven skip records a
      // failedOpen decision. Recorder counters are attached ONLY on the tiers
      // where the recorder was actually invoked — the diagnostics must never
      // claim a write that did not happen.
      const failOpen = (
        failOpenReason: string,
        recorderCounters: Partial<ContextBudgetDiagnostic> = {},
      ): RequestProjection | undefined => {
        onDiagnosticPatch({
          historyCompactEnabled: true,
          historyCompactMode: 'read_write',
          ...recorderCounters,
          ...compactionDecisionDiagnosticPatch({
            stage: 'activeStep',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            phase: 'mid_turn',
            boundaryKind: 'historyCompact',
            reason: 'context_limit',
            failOpenReason,
            skippedReasonCounts: { [failOpenReason]: 1 },
          }),
        });
        return keepProjection();
      };
      // A shaping failure additionally records itself for the final-request
      // estimate owner: when the final payload is still over the window, the
      // owner turns this step's failure into the terminal detail instead of
      // re-entering a shaper that already attempted and failed.
      const shapeFailure = (
        detail: ContextBudgetExhaustedDetail,
        diagnosticReason: string,
        recorderCounters: Partial<ContextBudgetDiagnostic> = {},
      ): RequestProjection | undefined => {
        state.lastShapeFailure = { stepNumber: options.stepNumber, detail, diagnosticReason };
        return failOpen(diagnosticReason, recorderCounters);
      };

      // Trigger estimate: the last request's input tokens plus a SIGNED char/4 delta of
      // this step's payload (system prompt + projected messages + active tool
      // schemas) against the previous request's measured payload. Measured synchronously from
      // the SDK's own projection — no ledger dependency — so a same-turn
      // `load_tools` schema expansion or a large tool result both count. This
      // position measures BEFORE later shapers (prune) run, so it can
      // over-trigger; that is the recoverable direction, and the verdict owner
      // re-measures the post-shaping payload.
      const measuredMessages = projectedMessages ?? incomingMessages;
      const activeToolsForStep = options.activeTools ?? fallbackActiveTools();
      const payloadChars = midTurnRequestPayloadChars(
        measuredMessages,
        providerTools,
        activeToolsForStep,
        systemPromptChars,
      );
      const forcedEstimate = state.forcedTriggerEstimate;
      state.forcedTriggerEstimate = undefined;
      const estimate =
        forcedEstimate ??
        estimateNextRequestTokens({
          ...(state.lastRequestInputTokens !== undefined
            ? { priorUsageTokens: state.lastRequestInputTokens }
            : {}),
          appendedChars: payloadChars - (state.lastRequestPayloadChars ?? payloadChars),
          charsPerToken,
          coldStartChars: payloadChars,
        });
      if (
        forcedEstimate === undefined &&
        !exceedsHighWater(estimate, state.capacity.tokens, reserveTokens)
      ) {
        return keepProjection();
      }

      // Fold a safe completed prefix of the durable turn ledger into a
      // replacement projection (validate → persist), shared with the reactive
      // overflow path. This stage maps the outcome to the request-projection contract:
      // keep the raw projection on skip/fail, apply the fold on success.
      const outcome = await this.computeMidTurnCompactionReplacement({
        turnId,
        origin,
        state,
        queue,
        minFlushedSteps: options.stepNumber,
        estimatedNextRequestTokens: estimate,
        referencePayloadChars: payloadChars,
        providerTools,
        activeToolsForStep,
        systemPromptChars,
        turnTailPrompt,
        memoryCompactionDecision,
        onMemoryCompaction,
        abortSignal,
      });
      if (outcome.decision === 'skip') return keepProjection();
      if (outcome.decision === 'fail') {
        return shapeFailure(outcome.detail, outcome.diagnosticReason, outcome.recorderCounters);
      }
      acceptedProjection = {
        sourceSignatures: incomingMessages.map(modelMessageSignature),
        sourceSignatureMode: 'exact',
        projectedMessages: outcome.replacementMessages,
      };
      state.replacedStepNumber = options.stepNumber;
      onDiagnosticPatch(
        buildMidTurnReplacedDiagnosticPatch({
          checkpoint: outcome.checkpoint,
          estimatedTokensBefore: outcome.estimatedTokensBefore,
          estimatedTokensAfter: outcome.estimatedTokensAfter,
          reason: 'context_limit',
        }),
      );
      return { messages: outcome.replacementMessages };
    };
  }

  /**
   * Fold a safe completed prefix of the durable turn ledger into a persisted
   * mid_turn checkpoint and its `[block, verbatim anchor, tail]` replacement
   * messages — the compaction core shared by the proactive projection stage
   * (issue #882 PR 1) and the reactive overflow recovery (PR 2). It waits for
   * the seq-ack durability boundary, reads the ledger, plans the fold, then
   * validates (materializable ∧ smaller than the reference request ∧
   * replay-admissible) and persists BEFORE returning the replacement, so a
   * recovery re-projection never re-injects a covered raw span. It only shapes:
   * the pass/terminate verdict and the diagnostic emission are the caller's.
   */
  public async computeMidTurnCompactionReplacement(input: {
    turnId: string;
    state: MidTurnCapacityCompactState;
    /** The turn this replacement request is built for. */
    origin: ProviderRequestOrigin;
    queue: AsyncEventQueue<SessionEvent>;
    minFlushedSteps: number;
    estimatedNextRequestTokens: number;
    referencePayloadChars: number;
    providerTools: readonly MakaTool[];
    activeToolsForStep: readonly string[];
    systemPromptChars: number;
    turnTailPrompt: string | undefined;
    memoryCompactionDecision?: () => AutomaticMemoryCompactionDecision;
    onMemoryCompaction?: (input: AutomaticMemoryCompactionDispatch) => void;
    phase?: 'pre_turn' | 'mid_turn';
    abortSignal?: AbortSignal;
  }): Promise<MidTurnCompactionOutcome> {
    const {
      turnId,
      state,
      queue,
      providerTools,
      activeToolsForStep,
      systemPromptChars,
      turnTailPrompt,
      abortSignal,
    } = input;
    const summarizer = this.input.summarizeHistoryCompact!;
    const midTurnTracker = this.createProviderRequestTracker({
      turnId,
      callKind: 'history_compact',
      modelId: this.input.modelId,
      runId: input.origin.runId,
      ...(this.input.historyCompactRoute
        ? { historyCompactRoute: this.input.historyCompactRoute }
        : {}),
    });
    const recorder = this.input.recordHistoryCompactCheckpoint!;
    const loadTurnRuntimeEvents = this.input.loadTurnRuntimeEvents!;
    const policy = this.input.contextBudget!;
    const compactPolicy = policy.historyCompact!;
    const midTurn = compactPolicy.midTurn!;
    const charsPerToken = policy.charsPerToken ?? 4;
    const reserveTokens = midTurn.reserveTokens ?? 16_384;

    // Coverage pool = the durable run ledger, read through the injected
    // seam. Covered events are persisted by construction (no crash window
    // between checkpoint and source), and their bytes are exactly what a
    // recovery re-projection replays.
    //
    // Seq-ack durability boundary. The replacement projection REPLACES the
    // whole message list, so any completed-step content event missing from
    // the durable pool is silently dropped from the next request — a
    // lagging ledger here is content loss (e.g. a step's already-emitted
    // assistant text), not a conservative under-count. No event-kind
    // predicate can close that: the wait counts the event stream itself.
    //  1. The pump has flushed every finish-step boundary the SDK reports
    //     completed (state.flushedSteps), so ALL of the completed steps'
    //     session events — tool pairs AND thinking/text completions — are
    //     enqueued with producer-stamped sequence numbers.
    //  2. The consumer has fully processed everything enqueued
    //     (consumedCount >= pushedCount). The consumer's pull is the ack
    //     (see drain()): it fires after processing, not after persisting,
    //     so deliberately-unpersisted events (non-terminal errors,
    //     partials) can never deadlock the wait.
    // After both, ONE durable read (which itself re-awaits the run's
    // serialized write queue) sees every event the projection may carry.
    // Exits: the boundary, an abort, a detached consumer, or a read failure.
    for (;;) {
      if (abortSignal?.aborted) {
        return {
          decision: 'fail',
          detail: 'no_safe_completed_span',
          diagnosticReason: 'ledger_wait_aborted',
        };
      }
      if (queue.consumerDetached) {
        return {
          decision: 'fail',
          detail: 'no_safe_completed_span',
          diagnosticReason: 'ledger_wait_aborted',
        };
      }
      if (state.flushedSteps >= input.minFlushedSteps && queue.consumedCount >= queue.pushedCount)
        break;
      await waitForQueueProgressOrAbort(queue, abortSignal);
    }
    let turnLedger: RuntimeEvent[];
    try {
      turnLedger = await loadTurnRuntimeEvents(turnId);
    } catch {
      return {
        decision: 'fail',
        detail: 'no_safe_completed_span',
        diagnosticReason: 'ledger_read_failed',
      };
    }
    const currentTurnEvents = turnLedger
      .filter((event) => event.turnId === turnId)
      .filter(isHistoryCompactContentEvent);
    // The head anchor is persisted before backend.send() is invoked, so
    // its absence is a wiring error, not replication lag — fail open now.
    if (!currentTurnEvents.some((event) => event.id === state.headAnchor.id)) {
      return {
        decision: 'fail',
        detail: 'no_safe_completed_span',
        diagnosticReason: 'head_anchor_not_durable',
      };
    }
    const orderedEvents = [...state.priorContentEvents, ...currentTurnEvents];
    const memoryDecision = input.memoryCompactionDecision?.();
    const plan = await planMidTurnCapacityCompaction({
      sessionId: this.sessionId,
      phase: input.phase ?? 'mid_turn',
      orderedEvents,
      headAnchor: { runtimeEventId: state.headAnchor.id, turnId },
      estimatedNextRequestTokens: input.estimatedNextRequestTokens,
      contextWindow: state.capacity.tokens,
      reserveTokens,
      reserveTailEvents: midTurn.reserveTailEvents ?? 1,
      charsPerToken,
      now: this.now(),
      ...(compactPolicy.highWaterName !== undefined
        ? { highWaterName: compactPolicy.highWaterName }
        : {}),
      ...(state.previousCheckpoint ? { previousCheckpoint: state.previousCheckpoint } : {}),
      ...(memoryDecision && orderedEvents.at(-1)
        ? {
            memoryExtractionBoundary: {
              runId: orderedEvents.at(-1)!.runId,
              turnId: orderedEvents.at(-1)!.turnId,
              runtimeEventId: orderedEvents.at(-1)!.id,
              disposition: memoryDecision.disposition,
            },
          }
        : {}),
      summarize: async ({ coveredRuntimeEvents, newlyFoldedRuntimeEvents, previousCheckpoint }) => {
        return await Promise.resolve(
          summarizer({
            sessionId: this.sessionId,
            turnId,
            source: { foldedRuntimeEvents: [...coveredRuntimeEvents] },
            ...(previousCheckpoint ? { previousCheckpoint } : {}),
            newlyFoldedRuntimeEvents: [...newlyFoldedRuntimeEvents],
            inputBudget: {
              maxEstimatedTokens: Math.max(1, state.capacity.tokens - reserveTokens),
              charsPerToken,
            },
            ...(abortSignal ? { abortSignal } : {}),
            ...(midTurnTracker ? { providerRequestTracker: midTurnTracker } : {}),
          }),
        );
      },
    });

    if (plan.decision === 'skip') return { decision: 'skip' };
    if (plan.decision === 'fail_open') {
      return {
        decision: 'fail',
        detail: plan.reason,
        diagnosticReason: plan.diagnosticReason ?? plan.reason,
      };
    }

    // Lifecycle order is validate → persist → apply, where validate =
    // materializable ∧ smaller ∧ replay-admissible. Replay applies the
    // session's latest checkpoint BEFORE any high-water check, so a
    // checkpoint that fails ANY of the three must never be persisted — it
    // would poison every later projection even though this step correctly
    // refused it.
    const replayPlan = buildRuntimeEventModelReplayPlan(plan.replacementEvents, {
      toolActivityTurnIds: collectToolActivityTurnIds(orderedEvents),
    });
    if (
      replayPlan.items.length === 0 ||
      hasBlockingReplayDiagnostics(replayPlan) ||
      (replayPlan.hasProviderNativeSemantics && !this.canReplayProviderNative(replayPlan))
    ) {
      return {
        decision: 'fail',
        detail: 'no_safe_completed_span',
        diagnosticReason: 'replacement_unmaterializable',
      };
    }
    // The head anchor must render exactly like the raw projection's current
    // user message: the initial request decorates it with the volatile turn
    // tail (cwd, shell context, task state — see send()), which is not part
    // of the durable anchor bytes. Reuse the same decoration owner
    // (appendTurnTailPrompt) on the anchor's replay item so a replacement
    // never silently drops that context — and never counts the drop as
    // shrinkage in the guard below.
    const replayItemsWithAnchorTail = replayPlan.items.map((item) =>
      item.kind === 'text' && item.role === 'user' && item.eventId === state.headAnchor.id
        ? { ...item, content: this.appendTurnTailPrompt(item.content, turnTailPrompt) as string }
        : item,
    );
    const replacementMessages = await this.materializeRuntimeReplayPlan(
      { ...replayPlan, items: replayItemsWithAnchorTail },
      input.origin.imageBudget,
      plan.checkpoint,
    );
    // Apply the shape only when it actually shrinks the request versus the
    // reference payload (the incoming request for the proactive hook, the
    // request that overflowed for reactive recovery): a materialized
    // replacement that is not smaller proves the summarizer's OUTPUT is
    // unusable, reported as summarizer_failed via replacement_not_smaller.
    const replacedPayloadChars = midTurnRequestPayloadChars(
      replacementMessages,
      providerTools,
      activeToolsForStep,
      systemPromptChars,
    );
    if (replacedPayloadChars >= input.referencePayloadChars) {
      return {
        decision: 'fail',
        detail: 'summarizer_failed',
        diagnosticReason: 'replacement_not_smaller',
      };
    }
    // Replay admissibility uses the same complete-prefix capacity gate as
    // recovery. Actual payload shrinkage was already checked above because
    // only this owner can measure the fully materialized provider request.
    const replayFit = evaluateHistoryCompactCheckpointReplay(
      plan.checkpoint,
      plan.checkpoint.version === 3 ? plan.replacementEvents : plan.replacementEvents.slice(1),
      policy?.charsPerToken,
      policy?.maxHistoryEstimatedTokens,
    );
    if (!replayFit.fits) {
      return {
        decision: 'fail',
        detail: 'head_anchor_exceeds_capacity',
        diagnosticReason: `replay_rejected_${replayFit.reason}`,
      };
    }

    // The replacement is valid: durably persist the checkpoint BEFORE
    // applying the projection — the same order as the pre_turn path. A
    // persistence failure keeps raw messages and records write_failed.
    try {
      await Promise.resolve(recorder(plan.checkpoint, turnId));
    } catch {
      return {
        decision: 'fail',
        detail: 'summarizer_failed',
        diagnosticReason: 'write_failed',
        recorderCounters: { historyCompactWritesAttempted: 1, historyCompactWriteFailures: 1 },
      };
    }
    if (memoryDecision?.dispatch && input.onMemoryCompaction) {
      try {
        input.onMemoryCompaction({
          checkpoint: plan.checkpoint,
          activeTools: activeToolsForStep,
        });
      } catch {
        // Memory extraction is fail-open and must never perturb Compaction.
      }
    }
    state.previousCheckpoint = plan.checkpoint;
    state.projectionCheckpoint = plan.checkpoint;
    return {
      decision: 'compacted',
      checkpoint: plan.checkpoint,
      replacementMessages,
      estimatedTokensBefore: plan.estimatedTokensBefore,
      estimatedTokensAfter: plan.estimatedTokensAfter,
    };
  }

  /**
   * Reactive overflow recovery (issue #882 PR 2): the second line of defense.
   * When a provider rejects a request with a context-length error, fold the
   * durable turn ledger once and resend once — a single compact-and-retry
   * latch (pi's `_overflowRecoveryAttempted`). Returns the compacted messages
   * to resend, or undefined when recovery is impossible or already spent, in
   * which case the caller surfaces the real provider error rather than a
   * fabricated success or a synthesized `context_budget_exhausted` (the
   * provider — not the runtime — rejected the request). Non-context-length
   * errors and turns without the mid-turn seam never reach compaction, so the
   * default (no seam) behavior is already better than the old fake end_turn.
   */
  public async recoverFromOverflowError(input: {
    error: unknown;
    retryAlreadyUsed: boolean;
    midTurnState: MidTurnCapacityCompactState | undefined;
    turnId: string;
    stepNumber: number;
    currentMessages: readonly ModelMessage[];
    providerTools: readonly MakaTool[];
    activeTools: readonly string[];
    systemPromptChars: number;
    turnTailPrompt: string | undefined;
    queue: AsyncEventQueue<SessionEvent>;
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void;
    origin: ProviderRequestOrigin;
    memoryCompactionDecision?: () => AutomaticMemoryCompactionDecision;
    onMemoryCompaction?: (input: AutomaticMemoryCompactionDispatch) => void;
    abortSignal?: AbortSignal;
  }): Promise<{ messages: ModelMessage[] } | undefined> {
    const state = input.midTurnState;
    if (input.retryAlreadyUsed || !state) return undefined;
    if (this.modelAdapter.classifyError(input.error) !== 'ContextLength') return undefined;

    const eligibleImages = collectHistoricalImageToolResults(state.priorContentEvents);
    const imageOmission = omitHistoricalImageToolResults(input.currentMessages, eligibleImages);
    if (imageOmission.omittedParts > 0) {
      state.omittedImageToolResults = new Map(
        [...imageOmission.omittedToolCallIds].flatMap((toolCallId) => {
          const image = eligibleImages.get(toolCallId);
          return image ? [[toolCallId, image] as const] : [];
        }),
      );
      state.lastRequestPayloadChars = undefined;
      state.lastRequestInputTokens = undefined;
      return { messages: imageOmission.messages };
    }

    // The shrink baseline is the request the provider actually rejected. Its
    // single owner is the verdict owner's per-request payload measure
    // (state.lastRequestPayloadChars), recorded at the end of every
    // request-projection run — the attempt-INITIAL messages undercount the rejected
    // request by every same-turn tool step, and a baseline anchored there
    // refuses folds that genuinely shrink the real request (review P1-1).
    // The cold-start fallback only covers a send whose verdict owner never
    // ran request projection (defensive; step 0 records the baseline too).
    const referencePayloadChars =
      state.lastRequestPayloadChars ??
      midTurnRequestPayloadChars(
        input.currentMessages,
        input.providerTools,
        input.activeTools,
        input.systemPromptChars,
      );
    const phase = input.stepNumber === 0 ? 'pre_turn' : 'mid_turn';
    const outcome = await this.computeMidTurnCompactionReplacement({
      turnId: input.turnId,
      phase,
      origin: input.origin,
      state,
      queue: input.queue,
      // The stream has ended, so every completed step is already flushed; wait
      // only for the consumer to drain the durable ledger up to date.
      minFlushedSteps: state.flushedSteps,
      // The provider rejected the request outright, so force the fold past the
      // high water regardless of the (evidently under-counting) estimate.
      estimatedNextRequestTokens: state.capacity.tokens + 1,
      referencePayloadChars,
      providerTools: input.providerTools,
      activeToolsForStep: input.activeTools,
      systemPromptChars: input.systemPromptChars,
      turnTailPrompt: input.turnTailPrompt,
      memoryCompactionDecision: input.memoryCompactionDecision,
      onMemoryCompaction: input.onMemoryCompaction,
      abortSignal: input.abortSignal,
    });
    if (outcome.decision !== 'compacted') {
      // Recovery attempted but could not produce a smaller, admissible
      // request; record the failed overflow attempt and let the caller surface
      // the real provider error.
      input.onDiagnosticPatch({
        historyCompactEnabled: true,
        historyCompactMode: 'read_write',
        ...(outcome.decision === 'fail' && outcome.recorderCounters
          ? outcome.recorderCounters
          : {}),
        ...compactionDecisionDiagnosticPatch({
          stage: 'activeStep',
          sourceKind: 'runtimeEvents',
          decision: 'failedOpen',
          phase,
          boundaryKind: 'historyCompact',
          reason: 'overflow',
          ...(outcome.decision === 'fail'
            ? {
                failOpenReason: outcome.diagnosticReason,
                skippedReasonCounts: { [outcome.diagnosticReason]: 1 },
              }
            : {}),
        }),
      });
      return undefined;
    }
    input.onDiagnosticPatch(
      buildMidTurnReplacedDiagnosticPatch({
        checkpoint: outcome.checkpoint,
        estimatedTokensBefore: outcome.estimatedTokensBefore,
        estimatedTokensAfter: outcome.estimatedTokensAfter,
        reason: 'overflow',
      }),
    );
    // A successful recovery restructures the request, so the rejected
    // request's payload measure no longer describes what the retry sends.
    // Reset the baseline: the capacity hook's usage anchor is only coherent
    // paired with the payload chars of the SAME request, and a missing
    // baseline forces the whole-payload cold-start estimate instead of a
    // stale pairing against the dead attempt.
    state.lastRequestPayloadChars = undefined;
    return { messages: outcome.replacementMessages };
  }

  /**
   * The single end-of-pipeline estimate owner for the mid-turn capacity
   * invariant. Every request-projection stage only shapes; this wrapper measures the
   * FINAL outgoing (messages, tools) payload — the bytes the provider will
   * actually see, after capacity compaction, active tool-result pruning, and
   * semantic/active-full compaction have all run — and issues the one
   * safety-critical verdict:
   *
   *  - estimate = the last request's real INPUT tokens + signed char/4 delta
   *    against the previous request's measured payload (recorded here on
   *    every step, including step 0's baseline); the delta already carries
   *    the step's fresh output, so an output-inclusive baseline would count
   *    it twice, and an unusable usage sample falls back to the whole-payload
   *    cold start rather than a zero baseline;
   *  - over the window with no capacity attempt this step (the approximate
   *    trigger missed, e.g. growth the trigger under-weighted), force ONE
   *    capacity re-entry — the verdict must not terminate a turn a shaper can
   *    still rescue, and one bounded re-entry preserves termination;
   *  - still over the window → context_budget_exhausted, with the terminal
   *    detail taken from this step's capacity outcome: a replacement that
   *    remains too large is head_anchor_exceeds_capacity (the irreducible
   *    remainder exceeds capacity); a recorded shaping failure keeps its own
   *    detail and diagnostic reason.
   *
   * Step 0 is shaped by the pre_turn path. It is still measured here so an
   * unshapable first request cannot bypass the capacity invariant.
   */
  public buildMidTurnFinalRequestVerdict(input: {
    shaped: RequestProjectionStage;
    reentry: RequestProjectionStage;
    state: MidTurnCapacityCompactState;
    providerTools: readonly MakaTool[];
    fallbackActiveTools: () => readonly string[];
    charsPerToken: number;
    systemPromptChars: number;
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void;
    abortController?: AbortController | null;
  }): RequestProjectionStage {
    const {
      shaped,
      reentry,
      state,
      providerTools,
      fallbackActiveTools,
      charsPerToken,
      systemPromptChars,
      onDiagnosticPatch,
      abortController,
    } = input;
    return async (options) => {
      let result = await Promise.resolve(shaped(options));
      const omissionProjection = projectHistoricalImageOmissions(
        result?.messages ?? options.messages,
        state.omittedImageToolResults,
      );
      if (omissionProjection) {
        result = { ...(result ?? {}), messages: omissionProjection };
      }
      const finalPayloadChars = (): number =>
        midTurnRequestPayloadChars(
          result?.messages ?? options.messages,
          providerTools,
          result?.activeTools ?? options.activeTools ?? fallbackActiveTools(),
          systemPromptChars,
        );
      let payloadChars = finalPayloadChars();
      if (
        (options.stepNumber >= 1 || state.capacity.source === 'policy_fallback') &&
        !state.exhaustedDetail
      ) {
        const estimateFinal = (): number =>
          estimateNextRequestTokens({
            ...(state.lastRequestInputTokens !== undefined
              ? { priorUsageTokens: state.lastRequestInputTokens }
              : {}),
            appendedChars: payloadChars - (state.lastRequestPayloadChars ?? payloadChars),
            charsPerToken,
            coldStartChars: payloadChars,
          });
        let estimate = estimateFinal();
        const capacityAttemptedThisStep =
          state.replacedStepNumber === options.stepNumber ||
          state.lastShapeFailure?.stepNumber === options.stepNumber;
        if (
          options.stepNumber >= 1 &&
          estimate > state.capacity.tokens &&
          !capacityAttemptedThisStep
        ) {
          // One bounded capacity re-entry: the trigger threshold is
          // approximate on purpose (recoverable), so a miss must become a
          // rescue attempt before it can become a terminal verdict. Re-run
          // only the capacity + prune shapers over the already-shaped
          // projection; a second attempt after a same-step failure is
          // pointless (the failure was not a trigger miss) and would double
          // recorder counters and summarizer calls.
          state.forcedTriggerEstimate = estimate;
          const reshaped = await Promise.resolve(
            reentry({
              ...options,
              messages: result?.messages ?? options.messages,
              ...(result?.activeTools ? { activeTools: result.activeTools } : {}),
            }),
          );
          state.forcedTriggerEstimate = undefined;
          if (reshaped) {
            result = {
              ...(result ?? {}),
              ...reshaped,
              activeTools: reshaped.activeTools ?? result?.activeTools,
            };
          }
          payloadChars = finalPayloadChars();
          estimate = estimateFinal();
        }
        if (estimate > state.capacity.tokens) {
          const failure =
            state.lastShapeFailure?.stepNumber === options.stepNumber
              ? state.lastShapeFailure
              : undefined;
          const replacedThisStep = state.replacedStepNumber === options.stepNumber;
          const detail: ContextBudgetExhaustedDetail = replacedThisStep
            ? 'head_anchor_exceeds_capacity'
            : (failure?.detail ?? 'no_safe_completed_span');
          const diagnosticReason = replacedThisStep
            ? 'head_anchor_exceeds_capacity'
            : (failure?.diagnosticReason ?? 'no_safe_completed_span');
          state.exhaustedDetail = detail;
          onDiagnosticPatch({
            historyCompactEnabled: true,
            historyCompactMode: 'read_write',
            ...compactionDecisionDiagnosticPatch({
              stage: 'activeStep',
              sourceKind: 'runtimeEvents',
              decision: 'unchanged',
              phase: 'mid_turn',
              boundaryKind: 'historyCompact',
              reason: 'context_budget_exhausted',
              skippedReasonCounts: { [diagnosticReason]: 1 },
            }),
          });
          abortController?.abort(new Error(`mid-turn context budget exhausted: ${detail}`));
          return result;
        }
      }
      state.lastRequestPayloadChars = payloadChars;
      return result;
    };
  }
}

// -- moved helpers (defined in ai-sdk-backend, used only by cache write) -------

function incrementRecord(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCountsInto(
  target: Record<string, number>,
  source: Record<string, number> | undefined,
): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

// -- moved helpers (prepare-step / signature / prune) ------------------------

function activeToolResultArchiveKey(
  candidate: ActiveToolResultArchiveCandidate & { bodySha256: string },
): string {
  return `active:${candidate.turnId}:${candidate.toolCallId}:${candidate.bodySha256}`;
}

/**
 * Tool results from the newest completed step have not crossed the provider
 * boundary yet: projection is invoked immediately before the first request
 * that could show those results to the model. By default active pruning defers
 * the newest step and archives only older completed steps, after the model has
 * had one request in which to consume their exact output.
 *
 * `includeNewestStep` widens eligibility to every completed step, including the
 * newest. The caller sets it when mid-turn capacity compaction is active: the
 * final-payload verdict may need an oversized newest result pruned to a
 * placeholder before declaring exhaustion, and capacity/recovery rebuilds
 * re-materialize raw bodies from the ledger that must be re-archived.
 */
function collectPrunableCompletedStepToolCallIds(
  steps: RequestProjectionContext['completedSteps'],
  includeNewestStep: boolean,
): Set<string> {
  const out = new Set<string>();
  const prunableSteps = includeNewestStep ? steps : steps.slice(0, -1);
  for (const step of prunableSteps) {
    for (const call of step.toolCalls ?? []) {
      if (typeof call.toolCallId === 'string' && call.toolCallId.length > 0) {
        out.add(call.toolCallId);
      }
    }
  }
  return out;
}

interface AcceptedActiveCompactionProjection {
  sourceSignatures: readonly string[];
  sourceSignatureMode: 'exact' | 'active_prune_lineage';
  projectedMessages: readonly ModelMessage[];
  semanticBlock?: SemanticCompactBlock;
}

function projectHistoricalImageOmissions(
  messages: readonly ModelMessage[],
  omittedImageToolResults: ReadonlyMap<string, HistoricalImageToolResult>,
): ModelMessage[] | undefined {
  if (omittedImageToolResults.size === 0) return undefined;
  const omission = omitHistoricalImageToolResults(messages, omittedImageToolResults);
  return omission.omittedParts > 0 ? omission.messages : undefined;
}

function projectAcceptedActiveCompactionMessages(
  incomingMessages: readonly ModelMessage[],
  acceptedProjection: AcceptedActiveCompactionProjection | undefined,
): ModelMessage[] | undefined {
  if (!acceptedProjection) return undefined;
  const sourceSignature =
    acceptedProjection.sourceSignatureMode === 'active_prune_lineage'
      ? projectionSourceMessageSignature
      : modelMessageSignature;
  if (incomingMessages.length < acceptedProjection.sourceSignatures.length) return undefined;
  for (let index = 0; index < acceptedProjection.sourceSignatures.length; index += 1) {
    if (sourceSignature(incomingMessages[index]!) !== acceptedProjection.sourceSignatures[index]) {
      return undefined;
    }
  }
  return [
    ...acceptedProjection.projectedMessages,
    ...incomingMessages.slice(acceptedProjection.sourceSignatures.length),
  ];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function modelMessageSignature(message: ModelMessage): string {
  return sha256(stableStringifyForSignature(message));
}

/**
 * A projection source signature must survive representation-only active
 * pruning. Preserve every message field except a tool-result payload, whose
 * raw body and archive placeholder are normalized to the same stable lineage
 * identity (tool call + original body hash). Any other source mutation still
 * invalidates the accepted projection.
 */
function projectionSourceMessageSignature(message: ModelMessage): string {
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return modelMessageSignature(message);
  }
  const normalizedContent = (message.content as unknown[]).map((part) => {
    const lineage = activeToolResultLineageIdentity(part);
    if (!lineage || !part || typeof part !== 'object') return part;
    const { output: _output, result: _result, ...metadata } = part as Record<string, unknown>;
    return {
      ...metadata,
      makaProjectionToolResultLineage: lineage,
    };
  });
  return modelMessageSignature({ ...message, content: normalizedContent } as ModelMessage);
}

function stableStringifyForSignature(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableStringifyForSignature).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringifyForSignature(object[key])}`)
    .join(',')}}`;
}

export function hasActiveToolResultPruneDiagnosticPatch(
  patch: ActiveToolResultPruneDiagnosticPatch,
): boolean {
  return (
    (patch.activePrunedToolResults ?? 0) > 0 ||
    (patch.activeSupersededToolResults ?? 0) > 0 ||
    (patch.activeDuplicateToolResults ?? 0) > 0 ||
    (patch.activeArchiveFailures ?? 0) > 0 ||
    (patch.activeEstimatedTokensSaved ?? 0) > 0
  );
}

/**
 * Per-send() state for the mid-turn capacity invariant. The coverage pool is
 * NOT mirrored here: every trigger reads the current turn's persisted
 * RuntimeEvents through the injected durable-read seam, so coverage can only
 * span events the ledger already replays. This class keeps only the trigger's
 * cursor state between steps.
 */
export class MidTurnCapacityCompactState {
  /**
   * Raw serialized chars of the final provider request. Overflow recovery
   * uses this as its shrink-reference baseline because it must compare the
   * actual rejected projection with a candidate replacement.
   */
  lastRequestPayloadChars: number | undefined;
  /**
   * The last request's REAL input size: the inputTokens the provider reported
   * for the last finished step. Never input+output — the signed payload delta
   * already carries the step's freshly generated output (assistant text/tool
   * calls) and its tool results, so an output-inclusive baseline would count
   * them twice. Undefined when the last step's usage is missing or unusable
   * (no positive input count); estimates then fall back to the whole-payload
   * cold-start path — an unusable sample is unknown, never zero.
   */
  lastRequestInputTokens: number | undefined;
  /** Latest durable checkpoint (loaded or written) for roll-forward summaries. */
  previousCheckpoint: HistoryCompactCheckpoint | undefined;
  /** Checkpoint accepted during this send; pins every later durable projection. */
  projectionCheckpoint: HistoryCompactCheckpoint | undefined;
  /** Set when the turn must end with a context_budget_exhausted outcome. */
  exhaustedDetail: ContextBudgetExhaustedDetail | undefined;
  /**
   * Step whose request the capacity hook replaced. Semantic/active-full
   * compaction yields on that exact step so one step never runs two
   * summarizers or double-projects.
   */
  replacedStepNumber: number | undefined;
  /**
   * finish-step boundaries the event pump has flushed into the session-event
   * queue. The capacity hook's durability wait needs it: only after the pump
   * has flushed step N's boundary are that step's thinking/text completion
   * events enqueued at all.
   */
  flushedSteps = 0;
  /**
   * Set by the final-request estimate owner to force one capacity re-entry on
   * the current step, bypassing the (deliberately approximate) high-water
   * trigger. Consumed by the capacity hook on its next invocation.
   */
  forcedTriggerEstimate: number | undefined;
  /** Exact historical image results omitted after a provider overflow. */
  omittedImageToolResults = new Map<string, HistoricalImageToolResult>();
  /**
   * The capacity hook's most recent shaping failure. The owner reads it (for
   * the same step only) to pick the terminal detail and diagnostic reason
   * when the final payload is over the window, and to avoid re-entering a
   * shaper that already attempted and failed this step.
   */
  lastShapeFailure:
    | {
        stepNumber: number;
        detail: ContextBudgetExhaustedDetail;
        diagnosticReason: string;
      }
    | undefined;

  constructor(
    readonly headAnchor: RuntimeEvent,
    readonly priorContentEvents: readonly RuntimeEvent[],
    readonly capacity: ContextBudgetCapacity,
  ) {}
}

/**
 * Char measure of the FULL provider-visible request input: the system prompt
 * (sent through the separate `system` field), the (projected) messages, and
 * the serialized schemas of the active tool subset. The capacity trigger and
 * the final-request estimate owner both measure with this ONE function, so
 * their raw payload comparisons against `lastRequestPayloadChars` are
 * commensurable and
 * same-turn tool-schema growth (a `load_tools` activation) is counted like
 * any other payload growth. The system prompt is constant between adjacent
 * requests — signed deltas cancel it — but the cold-start estimate (no usable
 * usage sample) is the whole payload, so omitting it would under-estimate by
 * exactly the system prompt and let an over-window request stream.
 */
function midTurnRequestPayloadChars(
  messages: readonly ModelMessage[],
  providerTools: readonly MakaTool[],
  activeTools: readonly string[],
  systemPromptChars: number,
): number {
  return (
    Math.max(0, Math.floor(systemPromptChars)) +
    JSON.stringify(messages).length +
    toolSchemaCharsForDiagnostics(providerTools, activeTools)
  );
}

/**
 * Outcome of folding the durable turn ledger into a replacement projection.
 * Shared by the proactive projection stage (which maps it to keepProjection /
 * shapeFailure / a `context_limit` replacement) and the reactive overflow
 * recovery (which maps it to a retry / a real error terminal, with an
 * `overflow` reason). The verdict/diagnostic is the caller's; this only shapes.
 */
type MidTurnCompactionOutcome =
  | { decision: 'skip' }
  | {
      decision: 'fail';
      detail: ContextBudgetExhaustedDetail;
      diagnosticReason: string;
      recorderCounters?: Partial<ContextBudgetDiagnostic>;
    }
  | {
      decision: 'compacted';
      checkpoint: HistoryCompactCheckpoint;
      replacementMessages: ModelMessage[];
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
    };

/**
 * The `decision: 'replaced'` diagnostic patch for a durable active-send fold,
 * shared by the proactive (`reason: 'context_limit'`) and reactive
 * (`reason: 'overflow'`) triggers so both report the fold identically.
 */
function buildMidTurnReplacedDiagnosticPatch(input: {
  checkpoint: HistoryCompactCheckpoint;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reason: string;
}): Partial<ContextBudgetDiagnostic> {
  const { checkpoint, estimatedTokensBefore, estimatedTokensAfter, reason } = input;
  return {
    historyCompactEnabled: true,
    historyCompactMode: 'read_write',
    historyCompactWritesAttempted: 1,
    historyCompactBlocksWritten: 1,
    historyCompactWrittenBlockIds: [checkpoint.checkpointId],
    historyCompactWriteEstimatedTokens: checkpoint.estimatedTokens,
    historyCompactBlockIds: [checkpoint.checkpointId],
    historyCompactedTurns: checkpoint.coverage.turnCount,
    historyCompactedEvents: checkpoint.coverage.eventCount,
    historyCompactedEstimatedTokensBefore: estimatedTokensBefore,
    historyCompactedEstimatedTokensAfter: estimatedTokensAfter,
    highWaterName: checkpoint.highWaterName,
    highWaterSeq: checkpoint.highWaterSeq,
    highWaterReason: 'history_compact',
    ...compactionDecisionDiagnosticPatch({
      stage: 'activeStep',
      sourceKind: 'runtimeEvents',
      decision: 'replaced',
      phase: checkpoint.phase ?? 'pre_turn',
      boundaryKind: 'historyCompact',
      boundaryIds: [checkpoint.checkpointId],
      coverage: { bodySha256: [checkpoint.coverage.sourceDigest] },
      reason,
      estimatedTokensBefore,
      estimatedTokensAfter,
    }),
  };
}

/**
 * Event-driven wait for seq-ack progress: resolves when the queue reports any
 * push/ack/close/wake, or immediately on abort. The caller loops and re-checks
 * its condition — a condition variable, not a poll.
 */
function waitForQueueProgressOrAbort(
  queue: AsyncEventQueue<SessionEvent>,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', settle);
      resolve();
    };
    abortSignal?.addEventListener('abort', settle, { once: true });
    void queue.waitForProgress().then(settle);
  });
}

export function hasBlockingReplayDiagnostics(plan: RuntimeEventModelReplayPlan): boolean {
  // `unmatched_tool_result` is deliberately NOT blocking: the materializer
  // drops an orphan tool result (its call sliced away or the ledger corrupt)
  // on its own — see pushToolResults — so one orphan must not degrade the
  // whole ledger to stored-message projection.
  return plan.diagnostics.some(
    (diagnostic) =>
      diagnostic.code === 'unsupported_role' ||
      diagnostic.code === 'unsupported_content' ||
      diagnostic.code === 'tool_id_mismatch',
  );
}
