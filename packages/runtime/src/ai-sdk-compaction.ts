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
 * Owns the compaction planning and persistence paths that AiSdkBackend's
 * Runtime request projection drives. Behavior-neutral collaborator: methods
 * move verbatim, turn-scoped state (such as abortSignal) is passed per call,
 * and replay/telemetry capabilities that stay on AiSdkBackend are injected as
 * host callbacks.
 */

import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type {
  BackendCompactHistoryInput,
  BackendCompactHistoryResult,
  BackendSendInput,
} from '@maka/core/backend-types';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import type { LastRequestAnchor } from '@maka/core/usage-record-schema';

import type {
  AiSdkCompactionCapabilities,
  HistoryCompactSummarizer,
  HistoryCompactSummaryInput,
} from './ai-sdk-compaction-contract.js';
import { compactionDecisionDiagnosticPatch } from './compaction-boundary.js';
import {
  buildContextBudgetDiagnosticShell,
  estimateRuntimeEventsTokens,
  mergeContextBudgetDiagnostic,
  type ContextBudgetPolicy,
} from './context-budget.js';
import { isHistoryCompactContentEvent } from './history-compaction.js';
import {
  canContinueHistoryCompactCheckpointForModel,
  canReplayHistoryCompactCheckpointForModel,
  matchHistoryCompactCheckpointPrefix,
  projectHistoryCompactCheckpointReplay,
  type HistoryCompactCheckpoint,
  type HistoryCompactMemoryExtractionBoundary,
  type HistoryCompactProviderState,
} from './history-compact-checkpoint.js';
import {
  HistoryCompactSummarizerError,
  isMalformedHistoryCompactSummaryReason,
  type MalformedHistoryCompactSummaryReason,
} from './history-compact-error.js';
import { createHash } from 'node:crypto';
import type { ModelMessage, NormalizedUsage } from './model-protocol.js';
import type { ModelAdapter } from './model-adapter.js';
import type {
  RequestProjection,
  RequestProjectionContext,
  RequestProjectionStage,
} from './request-projection.js';
import {
  rewriteActiveToolResultsInMessages,
  type ActiveToolResultProjectionSource,
  type ActiveToolResultPruneDiagnosticPatch,
} from './active-tool-result-prune.js';
import {
  archiveToolResultAsTransition,
  collectStaleToolResultArchiveCandidates,
  serializedToolResultProjection,
  type ToolResultArchiveTransitionServices,
} from './tool-result-archive-transition.js';
import { estimateTokens } from './context-budget-helpers.js';
import {
  baseToolResultProjection,
  reduceEffectiveModelProjections,
  type LoadedModelProjectionTransitions,
} from './model-projection-transition-ledger.js';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import type { ModelProjectionTransition } from '@maka/core/model-projection-transition';

import type { SessionEvent } from '@maka/core/events';
import type { AsyncEventQueue } from './async-queue.js';
import type { MakaTool } from './tool-runtime.js';
import {
  buildRuntimeEventModelReplayPlan,
  collectToolActivityTurnIds,
  compatibleProviderReasoningReplayEventIds,
  type RuntimeEventModelReplayPlan,
} from './model-history.js';
import { toolSchemaCharsForDiagnostics } from './request-shape.js';
import type { ModelCallAttempt, ModelCallKind } from '@maka/core/model-call-attempt';
import type { ProviderRequestTracker } from './provider-request-telemetry.js';
import { planHistoryCompaction } from './history-compaction.js';
import { resolveDeclaredContextWindow } from './context-budget-policy.js';
import { lookupModelMetadata } from '@maka/core/model-metadata';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import {
  collectHistoricalImageToolResults,
  type HistoricalImageToolResult,
  isInlineImageFilePart,
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
  targetConnectionId: string | undefined;
  targetProviderStateIdentity: `sha256:${string}` | undefined;
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
    checkpoint: HistoryCompactCheckpoint | undefined,
    providerReasoningReplayEventIds: ReadonlySet<string>,
  ) => Promise<ModelMessage[]>;
  canReplayProviderNative: (plan: RuntimeEventModelReplayPlan) => boolean;
}

export class AiSdkCompaction {
  private readonly input: AiSdkCompactionCapabilities;
  private readonly sessionId: string;
  private readonly targetConnectionId: string | undefined;
  private readonly targetProviderStateIdentity: `sha256:${string}` | undefined;
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
    checkpoint: HistoryCompactCheckpoint | undefined,
    providerReasoningReplayEventIds: ReadonlySet<string>,
  ) => Promise<ModelMessage[]>;
  private readonly canReplayProviderNative: (plan: RuntimeEventModelReplayPlan) => boolean;
  private historyCompactAbortController: AbortController | null = null;
  /**
   * Session-scoped circuit for exact malformed compaction inputs. A retry or
   * regeneration on the same backend must not dispatch the same doomed call;
   * changed source/configuration fingerprints remain eligible.
   */
  private readonly malformedSummaryFailures = new Map<
    string,
    MalformedHistoryCompactSummaryReason
  >();

  constructor(deps: AiSdkCompactionDeps) {
    this.input = deps.input;
    this.sessionId = deps.sessionId;
    this.targetConnectionId = deps.targetConnectionId;
    this.targetProviderStateIdentity = deps.targetProviderStateIdentity;
    this.now = deps.now;
    this.modelAdapter = deps.modelAdapter;
    this.createProviderRequestTracker = deps.createProviderRequestTracker;
    this.materializeRuntimeReplayPlan = deps.materializeRuntimeReplayPlan;
    this.canReplayProviderNative = deps.canReplayProviderNative;
  }

  /**
   * Every transition this session has committed.
   *
   * Read from the durable ledger rather than remembered: a Turn that pruned and
   * a Turn that replays it may be different processes. A read that fails or that
   * this build cannot fully decode is reported, never smoothed into "there are
   * no transitions" — a caller that cannot see the whole chain may still show
   * what it folded, but it may not append a successor onto a state it only
   * partly knows.
   */
  private async loadModelProjectionTransitions(): Promise<LoadedModelProjectionTransitions> {
    const loaded = await this.input.loadModelProjectionTransitions?.();
    const resolved = {
      transitions: [],
      unreadableTargets: new Set<string>(),
      unscopedUnreadable: 0,
      ...loaded,
    };
    if (resolved.unscopedUnreadable > 0) {
      // The record names no target, so nothing can be confined and nothing can
      // be shown: replaying raw history here would show whatever that record
      // removed. Failing is recoverable; showing it again is not.
      throw new Error('model projection transition ledger contains an unscoped unreadable record');
    }
    return resolved;
  }

  /**
   * The archive-and-commit writer, or `undefined` when this session cannot make
   * a lossy model-history change durable. Without both halves — an archive to
   * put the body in and a ledger to record the replacement — no prune may run.
   */
  private toolResultArchiveTransitionServices(
    turnId: string,
  ): ToolResultArchiveTransitionServices | undefined {
    const archive = this.input.toolResultArchive?.services.archiveToolResult;
    const record = this.input.recordModelProjectionTransition;
    if (!archive || !record) return undefined;
    return {
      sessionId: this.sessionId,
      archiveToolResult: (candidate) => archive(candidate),
      recordTransition: (transition) => record(transition, turnId),
      loadTransitions: () => this.loadModelProjectionTransitions(),
      now: this.now,
    };
  }

  /** Abort an in-flight manual history compaction (called by AiSdkBackend.stop). */
  public abortHistoryCompact(): void {
    this.historyCompactAbortController?.abort();
  }

  public async compactHistory(
    input: Omit<BackendCompactHistoryInput, 'runId'> & { runId: string | undefined },
    automaticMemoryBoundary?: HistoryCompactMemoryExtractionBoundary,
  ): Promise<AiSdkCompactHistoryResult> {
    const historyCompactAbortController = new AbortController();
    this.historyCompactAbortController = historyCompactAbortController;
    try {
      const policy = this.input.contextBudget;
      const summarizer = this.input.summarizeHistoryCompact;
      const recorder = this.input.recordHistoryCompactCheckpoint;
      const runtimeContext = input.runtimeContext
        .filter((event) => event.turnId !== input.turnId)
        .filter(isHistoryCompactContentEvent);
      if (!policy || !summarizer || !recorder) {
        return { outcome: { kind: 'unchanged', reason: 'operation_unavailable' } };
      }
      if (runtimeContext.length === 0) {
        return { outcome: { kind: 'unchanged', reason: 'empty_history' } };
      }

      const charsPerToken = policy.charsPerToken ?? 4;
      let previousCheckpoint: HistoryCompactCheckpoint | undefined;
      try {
        const loaded = await Promise.resolve(this.input.loadHistoryCompactCheckpoint?.());
        if (
          loaded &&
          canContinueHistoryCompactCheckpointForModel(
            loaded,
            this.input.connection,
            this.targetConnectionId,
            this.input.modelId,
          )
        ) {
          previousCheckpoint = loaded;
        }
      } catch {
        // The current durable RuntimeEvents remain sufficient for a fresh checkpoint.
      }

      if (previousCheckpoint) {
        const match = matchHistoryCompactCheckpointPrefix(previousCheckpoint, runtimeContext);
        if (!match.reason && match.successorRuntimeEvents.length === 0) {
          {
            const projectedEvents = projectHistoryCompactCheckpointReplay(
              previousCheckpoint,
              match.coveredRuntimeEvents,
              [],
            );
            return {
              outcome: { kind: 'unchanged', reason: 'already_compacted' },
              contextBudget: mergeContextBudgetDiagnostic(
                buildContextBudgetDiagnosticShell(runtimeContext, projectedEvents, policy),
                {
                  ...compactionDecisionDiagnosticPatch({
                    stage: 'priorReplay',
                    sourceKind: 'runtimeEvents',
                    decision: 'unchanged',
                    phase: 'pre_turn',
                    boundaryKind: 'historyCompact',
                    boundaryIds: [previousCheckpoint.checkpointId],
                    reason: 'already_compacted',
                  }),
                },
              ),
            };
          }
        }
      }

      const tracker = this.createProviderRequestTracker({
        turnId: input.turnId,
        callKind: 'history_compact',
        modelId: this.input.modelId,
        runId: input.runId,
        ...(this.input.historyCompactRoute
          ? { historyCompactRoute: this.input.historyCompactRoute }
          : {}),
      });
      const plan = await planHistoryCompaction({
        sessionId: this.sessionId,
        phase: 'standalone',
        orderedEvents: runtimeContext,
        reserveTailEvents: 0,
        charsPerToken,
        now: this.now(),
        ...(policy.historyCompact?.highWaterName !== undefined
          ? { highWaterName: policy.historyCompact.highWaterName }
          : {}),
        ...(automaticMemoryBoundary ? { memoryExtractionBoundary: automaticMemoryBoundary } : {}),
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        summarize: async ({ coveredRuntimeEvents, newlyFoldedRuntimeEvents, previousCheckpoint }) =>
          await this.summarizeWithFailureCircuit(summarizer, {
            sessionId: this.sessionId,
            turnId: input.turnId,
            runId: input.runId,
            source: {
              foldedRuntimeEvents: [...coveredRuntimeEvents],
              ...(input.runtimeContextRunHeaders
                ? { runHeaders: input.runtimeContextRunHeaders }
                : {}),
            },
            newlyFoldedRuntimeEvents: [...newlyFoldedRuntimeEvents],
            ...(previousCheckpoint ? { previousCheckpoint } : {}),
            abortSignal: historyCompactAbortController.signal,
            ...(tracker ? { providerRequestTracker: tracker } : {}),
          }),
      });
      if (historyCompactAbortController.signal.aborted) {
        return { outcome: { kind: 'failed', reason: 'aborted' } };
      }

      const diagnosticShell = (events: readonly RuntimeEvent[]) =>
        buildContextBudgetDiagnosticShell(runtimeContext, events, policy);
      if (plan.decision !== 'compacted') {
        const failureReason = plan.diagnosticReason ?? plan.reason;
        return {
          outcome: { kind: 'failed', reason: failureReason },
          contextBudget: mergeContextBudgetDiagnostic(diagnosticShell(runtimeContext), {
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              phase: 'pre_turn',
              boundaryKind: 'historyCompact',
              failOpenReason: failureReason,
            }),
          }),
        };
      }

      try {
        await Promise.resolve(recorder(plan.checkpoint, input.turnId));
      } catch {
        return {
          outcome: { kind: 'failed', reason: 'write_failed' },
          contextBudget: mergeContextBudgetDiagnostic(diagnosticShell(runtimeContext), {
            ...compactionDecisionDiagnosticPatch({
              stage: 'priorReplay',
              sourceKind: 'runtimeEvents',
              decision: 'failedOpen',
              phase: 'pre_turn',
              boundaryKind: 'historyCompact',
              failOpenReason: 'write_failed',
            }),
          }),
        };
      }

      return {
        outcome: { kind: 'compacted', checkpointId: plan.checkpoint.checkpointId },
        checkpoint: plan.checkpoint,
        contextBudget: mergeContextBudgetDiagnostic(diagnosticShell(plan.replacementEvents), {
          ...compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'replaced',
            phase: 'pre_turn',
            boundaryKind: 'historyCompact',
            boundaryIds: [plan.checkpoint.checkpointId],
            coverage: {
              turnIds: Array.from(new Set(plan.coveredRuntimeEvents.map((event) => event.turnId))),
              runtimeEventIds: plan.coveredRuntimeEvents.map((event) => event.id),
              contentKinds: Array.from(
                new Set(plan.coveredRuntimeEvents.flatMap((event) => event.content?.kind ?? [])),
              ),
              bodySha256: [],
            },
            estimatedTokensBefore: plan.estimatedTokensBefore,
            estimatedTokensAfter: plan.estimatedTokensAfter,
          }),
        }),
      };
    } finally {
      if (this.historyCompactAbortController === historyCompactAbortController) {
        this.historyCompactAbortController = null;
      }
    }
  }

  public hasHistoryCompactCheckpointWriter(): boolean {
    return Boolean(this.input.summarizeHistoryCompact && this.input.recordHistoryCompactCheckpoint);
  }

  private async summarizeWithFailureCircuit(
    summarizer: HistoryCompactSummarizer,
    input: HistoryCompactSummaryInput,
  ): Promise<string | HistoryCompactProviderState | undefined> {
    const foldedRunIds = new Set(input.source.foldedRuntimeEvents.map((event) => event.runId));
    const sourceRunRoutes = input.source.runHeaders
      ?.filter((run) => foldedRunIds.has(run.runId))
      .map((run) => ({
        runId: run.runId,
        connectionId: run.llmConnectionId,
        modelId: run.modelId,
      }))
      .sort((left, right) => left.runId.localeCompare(right.runId));
    const fingerprint = sha256(
      stableStringifyForSignature({
        version: 2,
        connection: this.input.connection,
        modelId: this.input.modelId,
        historyCompactRoute: this.input.historyCompactRoute,
        contextBudget: this.input.contextBudget,
        maxOutputTokens: input.maxOutputTokens,
        previousCheckpoint: input.previousCheckpoint,
        currentRunEventIds: input.runId
          ? input.source.foldedRuntimeEvents
              .filter((event) => event.runId === input.runId)
              .map((event) => event.id)
          : [],
        sourceRunRoutes,
        foldedRuntimeEvents: input.source.foldedRuntimeEvents,
        newlyFoldedRuntimeEvents: input.newlyFoldedRuntimeEvents,
      }),
    );
    const priorFailure = this.malformedSummaryFailures.get(fingerprint);
    if (priorFailure) throw new HistoryCompactSummarizerError(priorFailure);

    try {
      return await Promise.resolve(summarizer(input));
    } catch (error) {
      if (
        error instanceof HistoryCompactSummarizerError &&
        isMalformedHistoryCompactSummaryReason(error.reason)
      ) {
        this.malformedSummaryFailures.delete(fingerprint);
        this.malformedSummaryFailures.set(fingerprint, error.reason);
        while (this.malformedSummaryFailures.size > 16) {
          const oldest = this.malformedSummaryFailures.keys().next().value;
          if (oldest === undefined) break;
          this.malformedSummaryFailures.delete(oldest);
        }
      }
      throw error;
    }
  }

  /**
   * Fold the durable transition ledger onto any slice of model-visible history.
   *
   * The current Turn's own events go through here on every provider step, for
   * the same reason prior Turns do: what the model sees is the folded ledger,
   * not the raw one. A ledger this build cannot read in full leaves the slice
   * untouched — the content is then merely unpruned, never wrongly replaced.
   */
  public async foldEffectiveModelHistory(events: readonly RuntimeEvent[]): Promise<RuntimeEvent[]> {
    const loaded = await this.loadModelProjectionTransitions();
    if (loaded.transitions.length === 0) return [...events];
    return reduceEffectiveModelProjections(events, loaded.transitions).events;
  }

  /**
   * Fold the durable transition ledger onto this session's prior history, and
   * commit any new stale-result transition the prune policy calls for.
   *
   * This is the one seam where raw RuntimeEvents become effective model
   * history: the caller uses the returned events for replay, budgeting and
   * compaction alike, so no later stage can read content a transition removed.
   */
  public async prepareContextBudgetPolicy(
    runtimeContext: readonly RuntimeEvent[],
    turnId: string,
  ): Promise<{
    policy: ContextBudgetPolicy | undefined;
    events: RuntimeEvent[];
    diagnosticPatch?: Partial<ContextBudgetDiagnostic>;
  }> {
    const policy = this.input.contextBudget;
    const loaded = await this.loadModelProjectionTransitions();
    let transitions = loaded.transitions;
    let effective = reduceEffectiveModelProjections(
      runtimeContext,
      transitions,
      loaded.unreadableTargets,
    );
    if (!policy) return { policy, events: effective.events };
    let nextPolicy = policy;
    let diagnosticPatch: Partial<ContextBudgetDiagnostic> | undefined;

    // A chain this reader cannot see in full is a chain it must not extend: a
    // successor built on a partly known state would name the wrong predecessor
    // and be permanently inert, losing the content it archived.
    const services =
      loaded.unreadableTargets.size === 0
        ? this.toolResultArchiveTransitionServices(turnId)
        : undefined;
    if (policy.staleToolResultPrune?.enabled === true && services) {
      // The decision is taken over EFFECTIVE history, so a result an earlier
      // Turn already replaced is never re-measured — or re-archived — at the
      // size it used to have.
      const candidates = collectStaleToolResultArchiveCandidates(
        effective.events,
        policy.staleToolResultPrune,
        policy.charsPerToken ?? 4,
      );
      const committed: ModelProjectionTransition[] = [];
      let archiveFailures = 0;
      let estimatedTokensBefore = 0;
      let estimatedTokensAfter = 0;
      for (const candidate of candidates) {
        const outcome = await archiveToolResultAsTransition(services, {
          runtimeEventId: candidate.runtimeEventId,
          turnId: candidate.turnId,
          toolCallId: candidate.toolCallId,
          toolName: candidate.toolName,
          sourceProjection: candidate.sourceProjection,
          serializedResult: candidate.serializedResult,
          originalBytes: candidate.originalBytes,
          originalEstimatedTokens: candidate.originalEstimatedTokens,
          reason: candidate.reason,
          result: candidate.result,
        });
        if (!outcome) {
          archiveFailures += 1;
          continue;
        }
        committed.push(outcome.transition);
        estimatedTokensBefore += candidate.originalEstimatedTokens;
        estimatedTokensAfter += estimateTokens(
          serializedToolResultProjection(outcome.transition.replacement).length,
          policy.charsPerToken ?? 4,
        );
      }
      if (committed.length > 0) {
        transitions = [...transitions, ...committed];
        effective = reduceEffectiveModelProjections(
          runtimeContext,
          transitions,
          loaded.unreadableTargets,
        );
      }
      if (committed.length > 0 || archiveFailures > 0) {
        diagnosticPatch = {
          ...(committed.length > 0
            ? {
                prunedToolResults: committed.length,
                prunedToolResultEstimatedTokensBefore: estimatedTokensBefore,
                prunedToolResultEstimatedTokensAfter: estimatedTokensAfter,
                archivePlaceholders: committed.length,
                archivePlaceholderReasonCounts: {
                  stale_tool_result_pruned_before_compact: committed.length,
                },
              }
            : {}),
          ...(archiveFailures > 0
            ? { archiveWriteFailures: archiveFailures, unarchivedToolResults: archiveFailures }
            : {}),
        };
      }
    }

    let loadedCheckpoint: HistoryCompactCheckpoint | undefined;
    try {
      loadedCheckpoint = await Promise.resolve(this.input.loadHistoryCompactCheckpoint?.());
    } catch {
      loadedCheckpoint = undefined;
    }
    if (
      loadedCheckpoint &&
      canReplayHistoryCompactCheckpointForModel(
        loadedCheckpoint,
        this.input.connection,
        this.targetConnectionId,
        this.input.modelId,
      )
    ) {
      nextPolicy = {
        ...nextPolicy,
        historyCompact: { ...nextPolicy.historyCompact!, checkpoint: loadedCheckpoint },
      };
    }
    return {
      policy: nextPolicy,
      events: effective.events,
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
    const services = this.toolResultArchiveTransitionServices(turnId);
    // No durable ledger, no lossy rewrite. The old per-Turn placeholder map let
    // this run prune content that the NEXT request would have shown again.
    if (!services || !this.input.loadTurnRuntimeEvents) return undefined;

    // The current Turn reads the same folded history as every other consumer.
    // Nothing here remembers what this run already archived: the ledger says it,
    // and a step that measures the raw body again would archive it again.
    let effective: { events: RuntimeEvent[]; lastApplied: Map<string, string> } | undefined;
    const loadEffectiveTurnEvents = async (): Promise<typeof effective> => {
      if (effective) return effective;
      const loaded = await this.loadModelProjectionTransitions();
      if (loaded.unreadableTargets.size > 0) return undefined;
      let turnEvents: RuntimeEvent[];
      try {
        turnEvents = await this.input.loadTurnRuntimeEvents!(turnId);
      } catch {
        return undefined;
      }
      const reduction = reduceEffectiveModelProjections(turnEvents, loaded.transitions);
      const lastApplied = new Map<string, string>();
      for (const transition of reduction.applied) {
        lastApplied.set(transition.target.runtimeEventId, transition.transitionId);
      }
      effective = { events: reduction.events, lastApplied };
      return effective;
    };

    const resolveProjection = async (
      toolCallId: string,
    ): Promise<ActiveToolResultProjectionSource | undefined> => {
      const current = await loadEffectiveTurnEvents();
      if (!current) return undefined;
      const event = current.events.find(
        (candidate) =>
          candidate.partial !== true &&
          candidate.content?.kind === 'function_response' &&
          candidate.content.id === toolCallId,
      );
      if (!event || event.content?.kind !== 'function_response') return undefined;
      const projection = baseToolResultProjection(event);
      if (!projection) return undefined;
      const previousTransitionId = current.lastApplied.get(event.id);
      return {
        runtimeEventId: event.id,
        turnId: event.turnId,
        toolName: event.content.name,
        projection,
        ...(previousTransitionId ? { previousTransitionId } : {}),
      };
    };

    return async (options) => {
      const eligibleToolCallIds = collectPrunableCompletedStepToolCallIds(
        options.completedSteps,
        includeNewestStep,
      );
      if (eligibleToolCallIds.size === 0) return undefined;
      // Each provider step rebuilds its messages from the durable Turn ledger,
      // so each step must re-fold it too.
      effective = undefined;
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
        resolveProjection,
        transitions: services,
      });
      if (hasActiveToolResultPruneDiagnosticPatch(rewritten.diagnosticPatch)) {
        onDiagnosticPatch?.(rewritten.diagnosticPatch);
      }
      return rewritten.rewritten > 0 ? { messages: rewritten.messages } : undefined;
    };
  }

  /**
   * Mid-turn capacity compaction eligibility (issue #882 PR 1). Explicit
   * opt-in via `historyCompact.midTurn.enabled`; requires the checkpoint
   * writer seams plus the durable turn-ledger read, the persisted head anchor
   * for this turn. A model that declares no context window still gets this
   * state: reactive recovery runs off a real provider rejection and needs no
   * window at all.
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
    const priorContentEvents = (input.runtimeContext ?? [])
      .filter((event) => event.turnId !== input.turnId)
      .filter(isHistoryCompactContentEvent);
    const state = new MidTurnCapacityCompactState(
      headAnchor,
      priorContentEvents,
      input.runtimeContextRunHeaders ?? [],
      resolveDeclaredContextWindow(this.input.connection, this.input.modelId),
    );
    // Seed the turn's FIRST request with the last request the provider
    // actually counted, so step 0 is judged by the same real number as every
    // later step. No anchor means no proactive fold on step 0; the provider
    // decides, and its rejection is recovered from.
    const persisted = persistedRequestAnchor(
      input.runtimeContext ?? [],
      state.priorRunHeaders,
      this.input.modelId,
      this.targetConnectionId,
    );
    if (persisted) {
      state.baselineTokens = persisted.inputTokens + (persisted.outputTokens ?? 0);
      state.lastAcceptedTotalTokens = state.baselineTokens;
    }
    if (persisted) state.replyReserveTokens = replyReserveTokens(persisted.outputTokens);
    return state;
  }

  /**
   * Request-projection stage for proactive compaction: before each request of
   * one turn, compare the baseline — the last provider-accepted request's real
   * input plus real output tokens — against the context window the user
   * declared, and over it fold a safe completed prefix into a durable
   * checkpoint, continuing the turn on `[compact block, verbatim head anchor]`.
   *
   * Nothing here estimates whether a request fits: the baseline is the
   * provider's own count, the window is the user's own number, and the part of
   * the next request neither describes (tool results, user text, images
   * appended since) is judged by the provider when the request goes out. This
   * hook never terminates the turn: every failure fails open with a diagnostic
   * and the request is sent; a rejection is recovered by one reactive fold
   * (#4559).
   */
  public buildMidTurnCapacityCompactProjection(
    turnId: string,
    state: MidTurnCapacityCompactState | undefined,
    queue: AsyncEventQueue<SessionEvent>,
    providerTools: readonly MakaTool[],
    onDiagnosticPatch: (patch: Partial<ContextBudgetDiagnostic>) => void,
    origin: ProviderRequestOrigin,
    memoryCompactionDecision?: () => AutomaticMemoryCompactionDecision,
    onMemoryCompaction?: (input: AutomaticMemoryCompactionDispatch) => void,
    abortSignal?: AbortSignal,
  ): RequestProjectionStage | undefined {
    if (!state) return undefined;
    let acceptedProjection: AcceptedMidTurnCompactionProjection | undefined;

    return async (options) => {
      const incomingMessages = options.messages;
      let projectedMessages = projectAcceptedMidTurnCompactionMessages(
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
      // Baseline = the last accepted request's REAL input tokens plus its REAL
      // output tokens, read synchronously from the SDK's own step results.
      // Everything the model produced last step is re-sent as input this step,
      // so both halves are already in the next request; the only part no
      // number describes yet is what was appended from outside the model,
      // and that part is the provider's to judge. A missing or non-positive
      // input count is no baseline at all — unknown, never zero.
      if (options.completedSteps.length > 0) {
        const lastUsage = options.completedSteps.at(-1)?.usage;
        state.baselineTokens = usageBaselineTokens(lastUsage);
        if (state.baselineTokens !== undefined) {
          state.lastAcceptedTotalTokens = state.baselineTokens;
          state.replyReserveTokens = replyReserveTokens(lastUsage?.outputTokens);
        }
      }
      // The turn's first request folds as a pre_turn boundary, like the
      // reactive step-0 recovery; later steps fold mid_turn.
      const phase = options.stepNumber === 0 ? 'pre_turn' : 'mid_turn';
      // A skipped trigger is never silent: every failure-driven skip records a
      // failedOpen decision.
      const failOpen = (failOpenReason: string): RequestProjection | undefined => {
        onDiagnosticPatch({
          ...compactionDecisionDiagnosticPatch({
            stage: 'activeStep',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            phase,
            boundaryKind: 'historyCompact',
            reason: 'context_limit',
            failOpenReason,
            skippedReasonCounts: { [failOpenReason]: 1 },
          }),
        });
        return keepProjection();
      };
      // One trigger, one real signal: the baseline plus the room the next reply
      // needs crossed the window the user declared. A cut reply is deliberately
      // not a trigger — see the note on `finishReason: length` in the backend.
      // The next request is at least the baseline, and its reply needs room on
      // top of it. The room is measured from the last reply the model actually
      // wrote, not from the largest one it could write: on a model whose
      // output limit is a large fraction of its window (k3-256k reports
      // 131,072 against 262,144) reserving the limit would fold at half the
      // declared window, while a reply twice the size of the last one is the
      // margin the session's own behaviour supports (#4634).
      const overWindow =
        state.capacity !== undefined &&
        state.baselineTokens !== undefined &&
        state.baselineTokens + state.replyReserveTokens >= state.capacity;
      if (!overWindow || state.compactionAttemptedThisSend) {
        return keepProjection();
      }
      state.compactionAttemptedThisSend = true;
      const activeToolsForStep = options.resolveDispatch(options.activeTools).activeTools;
      // Fold a safe completed prefix of the durable turn ledger into a
      // replacement projection (validate → persist), shared with the reactive
      // overflow path. This stage maps the outcome to the request-projection contract:
      // keep the raw projection on skip/fail, apply the fold on success.
      const outcome = await this.compactActiveRequestHistory({
        turnId,
        phase,
        origin,
        state,
        queue,
        minFlushedSteps: options.stepNumber,
        activeToolsForStep,
        memoryCompactionDecision,
        onMemoryCompaction,
        abortSignal,
      });
      if (outcome.decision === 'fail') {
        return failOpen(outcome.diagnosticReason);
      }
      // The fold replaced the request; the baseline described the old one.
      // The next accepted request is the first measurement of the new shape.
      state.compactionAppliedThisSend = true;
      state.baselineTokens = undefined;
      acceptedProjection = {
        sourceSignatures: incomingMessages.map(modelMessageSignature),
        projectedMessages: outcome.replacementMessages,
      };
      state.replacedStepNumber = options.stepNumber;
      onDiagnosticPatch(
        buildActiveRequestCompactionDiagnosticPatch({
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
  public async compactActiveRequestHistory(input: {
    turnId: string;
    state: MidTurnCapacityCompactState;
    /** The turn this replacement request is built for. */
    origin: ProviderRequestOrigin;
    queue: AsyncEventQueue<SessionEvent>;
    minFlushedSteps: number;
    activeToolsForStep: readonly string[];
    memoryCompactionDecision?: () => AutomaticMemoryCompactionDecision;
    onMemoryCompaction?: (input: AutomaticMemoryCompactionDispatch) => void;
    phase?: 'pre_turn' | 'mid_turn';
    abortSignal?: AbortSignal;
  }): Promise<ActiveRequestCompactionOutcome> {
    const { turnId, state, queue, activeToolsForStep, abortSignal } = input;
    if (state.summarizerFailure) {
      return {
        decision: 'fail',
        diagnosticReason: state.summarizerFailure,
      };
    }
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
    const charsPerToken = policy.charsPerToken ?? 4;

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
          diagnosticReason: 'ledger_wait_aborted',
        };
      }
      if (queue.consumerDetached) {
        return {
          decision: 'fail',
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
        diagnosticReason: 'head_anchor_not_durable',
      };
    }
    const orderedEvents = [...state.priorContentEvents, ...currentTurnEvents];
    const memoryDecision = input.memoryCompactionDecision?.();
    const plan = await planHistoryCompaction({
      sessionId: this.sessionId,
      phase: input.phase ?? 'mid_turn',
      orderedEvents,
      headAnchor: { runtimeEventId: state.headAnchor.id, turnId },
      runHeaders: state.priorRunHeaders,
      acceptedRoute: {
        modelId: this.input.modelId,
        ...(this.targetConnectionId !== undefined ? { connectionId: this.targetConnectionId } : {}),
      },
      reserveTailEvents: 1,
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
        return await this.summarizeWithFailureCircuit(summarizer, {
          sessionId: this.sessionId,
          turnId,
          ...(input.origin.runId ? { runId: input.origin.runId } : {}),
          source: {
            foldedRuntimeEvents: [...coveredRuntimeEvents],
            runHeaders: state.priorRunHeaders,
          },
          ...(previousCheckpoint ? { previousCheckpoint } : {}),
          newlyFoldedRuntimeEvents: [...newlyFoldedRuntimeEvents],
          ...(abortSignal ? { abortSignal } : {}),
          ...(midTurnTracker ? { providerRequestTracker: midTurnTracker } : {}),
        });
      },
    });

    if (plan.decision === 'fail_open') {
      const diagnosticReason = plan.diagnosticReason ?? plan.reason;
      // Latch every fail-open reason, not only the malformed ones. The baseline
      // that fired this trigger survives a fail-open, so without the latch the
      // next step evaluates the same condition and dispatches the same doomed
      // summarizer call: a provider that answers slowly and fails (kimi's HTTP
      // 200 with an error body) produced 15 such calls over 47 minutes before
      // one main request (#4634). One attempt per send, then fail open (#4559).
      state.summarizerFailure = diagnosticReason;
      return {
        decision: 'fail',
        diagnosticReason,
      };
    }

    // Lifecycle order is validate → persist → apply, where validate is
    // materializable and replay-admissible. A checkpoint that fails either
    // check must never be persisted because it would poison every later
    // projection.
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
        diagnosticReason: 'replacement_unmaterializable',
      };
    }
    const replacementMessages = await this.materializeRuntimeReplayPlan(
      replayPlan,
      input.origin.imageBudget,
      plan.checkpoint,
      compatibleProviderReasoningReplayEventIds(
        plan.replacementEvents,
        state.priorRunHeaders,
        this.targetProviderStateIdentity,
        this.input.modelId,
        input.origin.runId,
      ),
    );
    // Whether the replacement fits is the provider's answer once it goes out;
    // no local measure stands between a materializable fold and dispatch
    // (#4559).
    // The replacement is valid: durably persist the checkpoint BEFORE
    // applying the projection — the same order as the pre_turn path. A
    // persistence failure keeps raw messages and records write_failed.
    try {
      await Promise.resolve(recorder(plan.checkpoint, turnId));
    } catch {
      return {
        decision: 'fail',
        diagnosticReason: 'write_failed',
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
   * fabricated success or a locally synthesized verdict (the provider — not the
   * runtime — rejected the request). Non-context-length
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
    activeTools: readonly string[];
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
      state.baselineTokens = undefined;
      return { messages: imageOmission.messages };
    }

    const phase = input.stepNumber === 0 ? 'pre_turn' : 'mid_turn';
    // Entering the module spends the send's one attempt whether or not a fold
    // comes out of it; only a selected projection sets `applied`.
    state.compactionAttemptedThisSend = true;
    const outcome = await this.compactActiveRequestHistory({
      turnId: input.turnId,
      phase,
      origin: input.origin,
      state,
      queue: input.queue,
      // The stream has ended, so every completed step is already flushed; wait
      // only for the consumer to drain the durable ledger up to date.
      minFlushedSteps: state.flushedSteps,
      activeToolsForStep: input.activeTools,
      memoryCompactionDecision: input.memoryCompactionDecision,
      onMemoryCompaction: input.onMemoryCompaction,
      abortSignal: input.abortSignal,
    });
    if (outcome.decision !== 'compacted') {
      // Recovery attempted but could not produce a smaller, admissible
      // request; record the failed overflow attempt and let the caller surface
      // the real provider error.
      input.onDiagnosticPatch({
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
      buildActiveRequestCompactionDiagnosticPatch({
        checkpoint: outcome.checkpoint,
        estimatedTokensBefore: outcome.estimatedTokensBefore,
        estimatedTokensAfter: outcome.estimatedTokensAfter,
        reason: 'overflow',
      }),
    );
    // The fold replaced the request; the baseline described the rejected one.
    state.compactionAppliedThisSend = true;
    state.baselineTokens = undefined;
    return { messages: outcome.replacementMessages };
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

interface AcceptedMidTurnCompactionProjection {
  sourceSignatures: readonly string[];
  projectedMessages: readonly ModelMessage[];
}

function projectHistoricalImageOmissions(
  messages: readonly ModelMessage[],
  omittedImageToolResults: ReadonlyMap<string, HistoricalImageToolResult>,
): ModelMessage[] | undefined {
  if (omittedImageToolResults.size === 0) return undefined;
  const omission = omitHistoricalImageToolResults(messages, omittedImageToolResults);
  return omission.omittedParts > 0 ? omission.messages : undefined;
}

function projectAcceptedMidTurnCompactionMessages(
  incomingMessages: readonly ModelMessage[],
  acceptedProjection: AcceptedMidTurnCompactionProjection | undefined,
): ModelMessage[] | undefined {
  if (!acceptedProjection) return undefined;
  if (incomingMessages.length < acceptedProjection.sourceSignatures.length) return undefined;
  for (let index = 0; index < acceptedProjection.sourceSignatures.length; index += 1) {
    if (
      modelMessageSignature(incomingMessages[index]!) !== acceptedProjection.sourceSignatures[index]
    ) {
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
   * The last provider-accepted request's real input tokens plus its real
   * output tokens, as the provider counted them — everything already in the
   * next request that a number describes. Seeded from the previous turn's
   * persisted anchor, refreshed at every step boundary, and cleared by any
   * fold (the checkpoint changed the request; the next accepted one is the
   * first measurement). Undefined is "no baseline", never zero.
   */
  baselineTokens: number | undefined;
  /**
   * Input plus output of the last request the provider accepted, as it
   * counted them. Unlike `baselineTokens` it survives a fold: it is not a
   * trigger input but the number a rejected user can declare as their window,
   * proven to fit because the provider already accepted it (#4559).
   */
  lastAcceptedTotalTokens: number | undefined;
  /**
   * Room the next reply may need: the model's declared output limit when the
   * connection or metadata states one, else 0. A provider fact, never an
   * estimate; it lets the trigger fire before a request that would otherwise
   * be accepted but leave the reply no room (#4559).
   */
  replyReserveTokens = 0;
  /** Latest durable checkpoint (loaded or written) for roll-forward summaries. */
  previousCheckpoint: HistoryCompactCheckpoint | undefined;
  /** Checkpoint accepted during this send; pins every later durable projection. */
  projectionCheckpoint: HistoryCompactCheckpoint | undefined;
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
  /** Exact historical image results omitted after a provider overflow. */
  omittedImageToolResults = new Map<string, HistoricalImageToolResult>();
  /** Malformed summaries spend one bounded repair budget for this whole Turn. */
  summarizerFailure: string | undefined;
  /**
   * The compaction module has been entered in this send.
   *
   * One attempt per send, whatever its outcome: the summarizer's own failure
   * circuit already latches for the rest of the send, so a second entry would
   * dispatch nothing new. This is the budget, and only the budget (#4559).
   */
  compactionAttemptedThisSend = false;
  /**
   * A folded projection was actually selected in this send.
   *
   * Distinct from the attempt: a fold that fails open leaves the request
   * carrying its full raw history, so nothing may be concluded from a later
   * rejection about what remains in it.
   */
  compactionAppliedThisSend = false;

  constructor(
    readonly headAnchor: RuntimeEvent,
    readonly priorContentEvents: readonly RuntimeEvent[],
    readonly priorRunHeaders: readonly AgentRunHeader[],
    /**
     * The Maka window: the context window the USER declared for this model,
     * a compaction target and nothing else. Absent when none is declared,
     * and then no proactive fold ever runs — the provider decides (#4559).
     */
    readonly capacity: number | undefined,
  ) {}
}

/**
 * The baseline one accepted request leaves for the next: its real input plus
 * its real output tokens. Output is counted whole, reasoning included — a wire
 * that does not resend reasoning makes this err high, and high is the safe
 * direction for a trigger that can only ask for a compaction (#4559).
 */
/**
 * Room to leave for the next reply, from the size of the last real one.
 *
 * Two real numbers and one bound: twice the last reply absorbs an answer that
 * grows, and the cap keeps a single long reply from turning the reserve into
 * the window. No previous reply means no reserve, never a guessed one.
 */
const MAX_REPLY_RESERVE_TOKENS = 8_000;

function replyReserveTokens(lastReplyTokens: number | undefined): number {
  if (lastReplyTokens === undefined || !Number.isFinite(lastReplyTokens) || lastReplyTokens <= 0) {
    return 0;
  }
  return Math.min(lastReplyTokens * 2, MAX_REPLY_RESERVE_TOKENS);
}

function usageBaselineTokens(usage: NormalizedUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens;
  if (!Number.isFinite(input) || input <= 0) return undefined;
  const output = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0;
  return input + output;
}

/**
 * The newest `LastRequestAnchor` persisted in the prior context.
 *
 * Reverse scan, and the FIRST anchor-bearing usage record decides — an older
 * anchor describes a request further from the one about to go out, so a
 * rejected newest anchor means cold start, never a fallback to an older one.
 * The synthetic `token_usage` a manual `/compact` writes carries no anchor and
 * is skipped for free.
 *
 * The anchor is a token count in the anchoring model's tokenizer, so it only
 * transfers to a request going to the same model over the same connection.
 */
function persistedRequestAnchor(
  events: readonly RuntimeEvent[],
  runHeaders: readonly AgentRunHeader[],
  modelId: string,
  connectionId: string | undefined,
): LastRequestAnchor | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const anchor = event?.actions?.tokenUsage?.lastRequestAnchor;
    if (!anchor) continue;
    const header = runHeaders.find((candidate) => candidate.runId === event?.runId);
    if (!header || header.modelId !== modelId || header.llmConnectionId !== connectionId) {
      return undefined;
    }
    return anchor;
  }
  return undefined;
}

/**
 * Outcome of folding the durable turn ledger into a replacement projection.
 * Shared by the proactive projection stage (which maps it to keepProjection /
 * shapeFailure / a `context_limit` replacement) and the reactive overflow
 * recovery (which maps it to a retry / a real error terminal, with an
 * `overflow` reason). The verdict/diagnostic is the caller's; this only shapes.
 */
type ActiveRequestCompactionOutcome =
  | {
      decision: 'fail';
      diagnosticReason: string;
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
function buildActiveRequestCompactionDiagnosticPatch(input: {
  checkpoint: HistoryCompactCheckpoint;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  reason: string;
}): Partial<ContextBudgetDiagnostic> {
  const { checkpoint, estimatedTokensBefore, estimatedTokensAfter, reason } = input;
  return {
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
type AiSdkCompactHistoryResult = BackendCompactHistoryResult & {
  checkpoint?: HistoryCompactCheckpoint;
};
