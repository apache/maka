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
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
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
  mergeContextBudgetDiagnosticPatches,
  type ContextBudgetPolicy,
  type ToolResultPruneStats,
} from './context-budget.js';
import { isHistoryCompactContentEvent } from './history-compaction.js';
import {
  canContinueHistoryCompactCheckpointForModel,
  canReplayHistoryCompactCheckpointForModel,
  historyCompactSourceDigest,
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
import type { ModelMessage, NormalizedUsage } from './model-protocol.js';
import type {
  RequestProjection,
  RequestProjectionContext,
  RequestProjectionStage,
} from './request-projection.js';
import {
  archiveToolResultAsTransition,
  collectToolResultArchiveCandidates,
  serializedToolResultProjection,
  type ToolResultArchiveTransitionServices,
} from './tool-result-archive-transition.js';
import { estimateTokens, sha256 } from './context-budget-helpers.js';
import {
  reduceEffectiveModelProjections,
  type LoadedModelProjectionTransitions,
} from './model-projection-transition-ledger.js';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';

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
        ...(input.runtimeContextInvocations
          ? { invocations: input.runtimeContextInvocations }
          : {}),
        acceptedRoute: {
          modelId: this.input.modelId,
          ...(this.targetConnectionId !== undefined
            ? { connectionId: this.targetConnectionId }
            : {}),
        },
        reserveTailEvents: 0,
        charsPerToken,
        now: this.now(),
        ...(policy.historyCompact?.highWaterName !== undefined
          ? { highWaterName: policy.historyCompact.highWaterName }
          : {}),
        ...(automaticMemoryBoundary ? { memoryExtractionBoundary: automaticMemoryBoundary } : {}),
        ...(previousCheckpoint ? { previousCheckpoint } : {}),
        // The planner projects the covered span to its effective view before
        // summarizing and pins its digest as coverage.effectiveSourceDigest:
        // the summary can never quote a body a durable transition removed, and
        // a later transition invalidates the checkpoint at replay (#4845).
        projectEffectiveCoverage: (covered) => this.foldEffectiveModelHistory(covered),
        summarize: async ({
          coveredRuntimeEvents,
          newlyFoldedRuntimeEvents,
          previousCheckpoint,
        }) => {
          return await this.summarizeWithFailureCircuit(summarizer, {
            sessionId: this.sessionId,
            turnId: input.turnId,
            runId: input.runId,
            source: {
              foldedRuntimeEvents: [...coveredRuntimeEvents],
              ...(input.runtimeContextInvocations
                ? { invocations: input.runtimeContextInvocations }
                : {}),
            },
            newlyFoldedRuntimeEvents: [...newlyFoldedRuntimeEvents],
            ...(previousCheckpoint ? { previousCheckpoint } : {}),
            abortSignal: historyCompactAbortController.signal,
            ...(tracker ? { providerRequestTracker: tracker } : {}),
          });
        },
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
    const sourceRunRoutes = input.source.invocations
      ?.filter((invocation) => foldedRunIds.has(invocation.runId))
      .map((invocation) => {
        const route = invocation.opening.route;
        return {
          runId: invocation.runId,
          ...(route.provenance === 'runtime' && route.backendKind !== 'plugin-executor'
            ? { connectionId: route.llmConnectionId }
            : {}),
          modelId: route.modelId,
        };
      })
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
   * not the raw one. Checkpoint validation and replay pass the same snapshot;
   * standalone callers read one here. Unreadable targets remain withheld.
   */
  public async foldEffectiveModelHistory(
    events: readonly RuntimeEvent[],
    snapshot?: LoadedModelProjectionTransitions,
  ): Promise<RuntimeEvent[]> {
    const loaded = snapshot ?? (await this.loadModelProjectionTransitions());
    if (loaded.transitions.length === 0 && loaded.unreadableTargets.size === 0) {
      return [...events];
    }
    // Forward the unreadable set: a target whose transition record this build
    // cannot decode must fold to the withholding sentinel here too, or this
    // path becomes the one consumer that replays the body a record removed.
    return reduceEffectiveModelProjections(events, loaded.transitions, loaded.unreadableTargets)
      .events;
  }

  /**
   * Whether the checkpoint's pinned effective view still is the covered
   * prefix's effective view. The raw identity match happens later in the
   * replay authority; this gate is about content currency: a projection
   * transition committed after the fold changes what the model may see of the
   * covered span without touching the raw ledger, and the checkpoint's summary
   * or provider state must not survive that drift (#4845 review).
   */
  private checkpointEffectiveCoverageMatches(
    checkpoint: HistoryCompactCheckpoint,
    effectiveEvents: readonly RuntimeEvent[],
  ): boolean {
    const pinned = checkpoint.coverage.effectiveSourceDigest;
    if (pinned === undefined) return false;
    const covered = effectiveEvents
      .filter(isHistoryCompactContentEvent)
      .slice(0, checkpoint.coverage.eventCount);
    if (covered.length !== checkpoint.coverage.eventCount) return false;
    if (covered.at(-1)?.id !== checkpoint.coverage.through.runtimeEventId) return false;
    return historyCompactSourceDigest(covered) === pinned;
  }

  /**
   * Apply the same bounded-result rule to current and prior events.
   *
   * This is the one seam where raw RuntimeEvents become effective model
   * history: the caller uses the returned events for replay, budgeting and
   * compaction alike, so no later stage can read content a transition removed.
   */
  public async pruneToolResults(
    runtimeContext: readonly RuntimeEvent[],
    turnId: string,
  ): Promise<{
    events: RuntimeEvent[];
    projectionSnapshot: LoadedModelProjectionTransitions;
    stats?: ToolResultPruneStats;
  }> {
    const policy = this.input.contextBudget;
    let loaded = await this.loadModelProjectionTransitions();
    let effective = reduceEffectiveModelProjections(
      runtimeContext,
      loaded.transitions,
      loaded.unreadableTargets,
    );
    if (!policy) return { events: effective.events, projectionSnapshot: loaded };
    let stats: ToolResultPruneStats | undefined;

    // A chain this reader cannot see in full is a chain it must not extend: a
    // successor built on a partly known state would name the wrong predecessor
    // and be permanently inert, losing the content it archived.
    const services =
      loaded.unreadableTargets.size === 0
        ? this.toolResultArchiveTransitionServices(turnId)
        : undefined;
    if (policy.toolResultPrune?.enabled === true && services) {
      // The decision is taken over EFFECTIVE history, so a result an earlier
      // Turn already replaced is never re-measured — or re-archived — at the
      // size it used to have.
      const candidates = collectToolResultArchiveCandidates(
        effective.events,
        policy.toolResultPrune,
        policy.charsPerToken ?? 4,
      );
      for (const candidate of candidates) {
        await archiveToolResultAsTransition(services, {
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
      }
      if (candidates.length > 0) {
        // Writes (including a rival winner or an uncertain commit) cannot tell
        // us what the model sees. Read once after the batch and use this same
        // snapshot for checkpoint validation, replay, and diagnostics.
        loaded = await this.loadModelProjectionTransitions();
        effective = reduceEffectiveModelProjections(
          runtimeContext,
          loaded.transitions,
          loaded.unreadableTargets,
        );
        stats = {
          prunedToolResults: 0,
          prunedToolResultEstimatedTokensBefore: 0,
          prunedToolResultEstimatedTokensAfter: 0,
          archiveWriteFailures: 0,
        };
        for (const candidate of candidates) {
          const applied = effective.applied.find(
            (transition) => transition.target.runtimeEventId === candidate.runtimeEventId,
          );
          if (!applied) {
            stats.archiveWriteFailures++;
            continue;
          }
          stats.prunedToolResults++;
          stats.prunedToolResultEstimatedTokensBefore += candidate.originalEstimatedTokens;
          stats.prunedToolResultEstimatedTokensAfter += estimateTokens(
            serializedToolResultProjection(applied.replacement).length,
            policy.charsPerToken ?? 4,
          );
        }
      }
    }

    return { events: effective.events, projectionSnapshot: loaded, ...(stats ? { stats } : {}) };
  }

  public async prepareContextBudgetPolicy(
    runtimeContext: readonly RuntimeEvent[],
    turnId: string,
  ): Promise<{
    policy: ContextBudgetPolicy | undefined;
    events: RuntimeEvent[];
    projectionSnapshot: LoadedModelProjectionTransitions;
    diagnosticPatch?: Partial<ContextBudgetDiagnostic>;
  }> {
    const policy = this.input.contextBudget;
    const prepared = await this.pruneToolResults(runtimeContext, turnId);
    const effective = { events: prepared.events };
    if (!policy)
      return { policy, events: effective.events, projectionSnapshot: prepared.projectionSnapshot };
    let nextPolicy = policy;
    let diagnosticPatch: Partial<ContextBudgetDiagnostic> | undefined = prepared.stats;

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
      // Raw identity first: a coverage miss keeps the apply-stage path, whose
      // matcher reports the real identity reason (coverage_miss and friends).
      // This gate is only for the case where the raw identity matches but a
      // projection transition committed after the fold changed the effective
      // view the summary (or provider state) was built from (#4845 review).
      const rawIdentityMatch = matchHistoryCompactCheckpointPrefix(
        loadedCheckpoint,
        runtimeContext.filter(isHistoryCompactContentEvent),
      );
      if (rawIdentityMatch.reason) {
        nextPolicy = {
          ...nextPolicy,
          historyCompact: { ...nextPolicy.historyCompact!, checkpoint: loadedCheckpoint },
        };
      } else if (this.checkpointEffectiveCoverageMatches(loadedCheckpoint, effective.events)) {
        nextPolicy = {
          ...nextPolicy,
          historyCompact: { ...nextPolicy.historyCompact!, checkpoint: loadedCheckpoint },
        };
      } else {
        // Rejecting keeps the stale block from restoring what the transition
        // removed; the next fold re-summarizes (#4845 review).
        diagnosticPatch = mergeContextBudgetDiagnosticPatches(
          diagnosticPatch,
          compactionDecisionDiagnosticPatch({
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            phase: 'pre_turn',
            boundaryKind: 'historyCompact',
            ...(loadedCheckpoint.coverage.effectiveSourceDigest !== undefined
              ? { boundaryIds: [loadedCheckpoint.checkpointId] }
              : {}),
            failOpenReason: 'effective_history_changed',
          }),
        );
      }
    }
    return {
      policy: nextPolicy,
      events: effective.events,
      projectionSnapshot: prepared.projectionSnapshot,
      ...(diagnosticPatch ? { diagnosticPatch } : {}),
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
      (headAnchor.author !== 'user' && headAnchor.author !== 'host') ||
      !isHistoryCompactContentEvent(headAnchor)
    ) {
      return undefined;
    }
    // Handoff replay is an authenticated predecessor prefix, including the
    // current logical Turn. The live reader remains physical-run scoped.
    const handoff = input.continuation?.sourceTurnId === input.turnId;
    const priorContentEvents = (input.runtimeContext ?? [])
      .filter((event) => handoff || event.turnId !== input.turnId)
      .filter(isHistoryCompactContentEvent);
    const state = new MidTurnCapacityCompactState(
      headAnchor,
      priorContentEvents,
      input.runtimeContextInvocations ?? [],
      resolveDeclaredContextWindow(this.input.connection, this.input.modelId),
    );
    // Seed the turn's FIRST request with the last request the provider
    // actually counted, so step 0 is judged by the same real number as every
    // later step. No anchor means no proactive fold on step 0; the provider
    // decides, and its rejection is recovered from.
    const persisted = persistedRequestAnchor(
      input.runtimeContext ?? [],
      state.priorInvocations,
      this.input.modelId,
      this.targetConnectionId,
    );
    if (persisted) {
      state.baselineTokens = persisted.inputTokens + (persisted.outputTokens ?? 0);
      state.lastAcceptedTotalTokens = state.baselineTokens;
      state.priorAcceptedInputTokens = persisted.inputTokens;
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
   * and the request is sent; a rejection is recovered by a reactive fold
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
      // Physical step zero may already be mid-Turn after a handoff.
      const phase = state.compactionPhase(options.stepNumber);
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
      if (!overWindow) {
        return keepProjection();
      }
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
      state.baselineTokens = undefined;
      acceptedProjection = {
        sourceSignatures: incomingMessages.map(modelMessageSignature),
        projectedMessages: outcome.replacementMessages,
      };
      state.stepShaping.add('fold');
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
   * validates (materializable ∧ replay-admissible) and persists BEFORE
   * returning the replacement, so a recovery re-projection never re-injects a
   * covered raw span. It only shapes: the pass/terminate verdict and the
   * diagnostic emission are the caller's.
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
    const orderedEvents = [...state.priorContentEvents, ...currentTurnEvents];
    // A fresh anchor belongs to the live ledger; after handoff it belongs to
    // the authenticated predecessor prefix. Neither path manufactures it.
    if (!orderedEvents.some((event) => event.id === state.headAnchor.id)) {
      return {
        decision: 'fail',
        diagnosticReason: 'head_anchor_not_durable',
      };
    }
    const memoryDecision = input.memoryCompactionDecision?.();
    const plan = await planHistoryCompaction({
      sessionId: this.sessionId,
      phase: input.phase ?? 'mid_turn',
      orderedEvents,
      headAnchor: { runtimeEventId: state.headAnchor.id, turnId },
      invocations: state.priorInvocations,
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
      projectEffectiveCoverage: (covered) => this.foldEffectiveModelHistory(covered),
      summarize: async ({ coveredRuntimeEvents, newlyFoldedRuntimeEvents, previousCheckpoint }) => {
        // Same contract as the standalone path: the planner hands the
        // effective (transition-folded) view to the summarizer and pins its
        // digest, so a summary can never quote a body a durable transition
        // removed (#4845).
        return await this.summarizeWithFailureCircuit(summarizer, {
          sessionId: this.sessionId,
          turnId,
          ...(input.origin.runId ? { runId: input.origin.runId } : {}),
          source: {
            foldedRuntimeEvents: [...coveredRuntimeEvents],
            invocations: state.priorInvocations,
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
      // one main request (#4634). The latch covers the whole Turn and only
      // fail-opens; a successful fold spends no part of it (#4559).
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
    const effectiveReplacement = await this.foldEffectiveModelHistory(plan.replacementEvents);
    const replayPlan = buildRuntimeEventModelReplayPlan(effectiveReplacement, {
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
        state.priorInvocations,
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
   * durable turn ledger and resend — once per step: a step that a fold or an
   * image omission has already reshaped gets no second recovery, so the
   * resend's own rejection is terminal, while a step the provider has since
   * accepted earns a fresh attempt. Returns the compacted messages to resend,
   * or undefined when recovery is impossible or already spent, in which case
   * the caller surfaces the real provider error rather than a fabricated
   * success or a locally synthesized verdict (the provider — not the runtime —
   * rejected the request). Non-context-length errors and turns without the
   * mid-turn seam never reach compaction, so the default (no seam) behavior is
   * already better than the old fake end_turn.
   */
  public async recoverFromOverflowError(input: {
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
    if (!state || state.stepShaping.has('fold') || state.stepShaping.has('omit_images')) {
      return undefined;
    }

    const eligibleImages = collectHistoricalImageToolResults(state.priorContentEvents);
    const imageOmission = omitHistoricalImageToolResults(input.currentMessages, eligibleImages);
    if (imageOmission.omittedParts > 0) {
      state.stepShaping.add('omit_images');
      for (const toolCallId of imageOmission.omittedToolCallIds) {
        const image = eligibleImages.get(toolCallId);
        // Earlier steps' omissions stay omitted: every later request is
        // projected through this map, so losing an entry would put its image
        // back into the very history the provider just rejected.
        if (image) state.omittedImageToolResults.set(toolCallId, image);
      }
      state.baselineTokens = undefined;
      return { messages: imageOmission.messages };
    }

    const phase = state.compactionPhase(input.stepNumber);
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
    state.stepShaping.add('fold');
    state.baselineTokens = undefined;
    return { messages: outcome.replacementMessages };
  }
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
  /** Pre-turn checkpoint the turn starts from, before any fold of its own. */
  seedCheckpoint: HistoryCompactCheckpoint | undefined;
  /** Checkpoint accepted during this send; pins every later durable projection. */
  projectionCheckpoint: HistoryCompactCheckpoint | undefined;
  /** Latest durable checkpoint (loaded or written) for roll-forward summaries. */
  get previousCheckpoint(): HistoryCompactCheckpoint | undefined {
    return this.projectionCheckpoint ?? this.seedCheckpoint;
  }
  /**
   * What has reshaped the request since the last one a provider accepted. The
   * turn clears it at that acceptance, every shaper records itself here, and
   * every consumer reads it here — an empty set is the only proof that the next
   * request is a pure append of its predecessor.
   */
  readonly stepShaping = new Set<'fold' | 'prune' | 'omit_images' | 'tools'>();
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
   * Input tokens of the last request a provider accepted before this send.
   *
   * Input against input, across the send boundary: the first request of a send
   * has no earlier step to compare with, and `baselineTokens` counts the reply
   * too, which the next request does not always carry.
   */
  priorAcceptedInputTokens: number | undefined;

  constructor(
    readonly headAnchor: RuntimeEvent,
    readonly priorContentEvents: readonly RuntimeEvent[],
    readonly priorInvocations: readonly RuntimeInvocationRecord[],
    /**
     * The Maka window: the context window the USER declared for this model,
     * a compaction target and nothing else. Absent when none is declared,
     * and then no proactive fold ever runs — the provider decides (#4559).
     */
    readonly capacity: number | undefined,
  ) {}

  compactionPhase(stepNumber: number): 'pre_turn' | 'mid_turn' {
    return stepNumber === 0 &&
      !this.priorContentEvents.some((event) => event.id === this.headAnchor.id)
      ? 'pre_turn'
      : 'mid_turn';
  }
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
  invocations: readonly RuntimeInvocationRecord[],
  modelId: string,
  connectionId: string | undefined,
): LastRequestAnchor | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const anchor = event?.actions?.tokenUsage?.lastRequestAnchor;
    if (!anchor) continue;
    const route = invocations.find((candidate) => candidate.runId === event?.runId)?.opening.route;
    if (
      route?.provenance !== 'runtime' ||
      route.backendKind === 'plugin-executor' ||
      route.modelId !== modelId ||
      route.llmConnectionId !== connectionId
    ) {
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
