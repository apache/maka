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

import {
  AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
  type AgentGraphSupervisorWakeRecord,
  type AgentGraphSupervisorWakeStore,
} from '@maka/core/agent-graph-supervisor-wake';
import { type AgentRunHeader } from '@maka/core/agent-run';
import { type SessionEvent } from '@maka/core/events';
import { type UserMessageInput } from '@maka/core/runtime-inputs';
import type {
  GoalTurnOutcome,
  SessionActivityLease,
  SessionActivityRegistry,
} from './goal-turn-lifecycle.js';
import { isContextOverflowErrorText } from './provider-error-classification.js';
import type { AgentGraphClientSnapshot } from './stream-graph-read-model.js';
import type { AgentGraphScheduleReconciliationResult } from './stream-graph-schedule-reconcile.js';

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;
const MAX_PARTIAL_WORK_ITEMS = 32;
const MAX_PARTIAL_RECORD_IDS = 32;

export interface AgentGraphSupervisorPartialResult {
  schemaVersion: 1;
  graphId: string;
  snapshotVersion: string;
  status: AgentGraphClientSnapshot['status'];
  closed: boolean;
  scheduleRevision: number;
  work: Array<{
    workId: string;
    status: AgentGraphClientSnapshot['work'][number]['status'];
    target: AgentGraphClientSnapshot['work'][number]['target'];
    replaces?: string;
  }>;
  terminalRecordIds: string[];
  omitted: {
    work: number;
    terminalRecordIds: number;
  };
}

export class AgentGraphSupervisorContextOverflowError extends Error {
  readonly code = 'agent_graph_supervisor_context_overflow';
  readonly partialResult: AgentGraphSupervisorPartialResult;
  readonly recoveryAttempted: boolean;
  readonly recoveryFailure?: string;

  constructor(input: {
    partialResult: AgentGraphSupervisorPartialResult;
    recoveryAttempted: boolean;
    recoveryFailure?: string;
  }) {
    const recovery = input.recoveryFailure
      ? ` Recovery failed: ${input.recoveryFailure}.`
      : input.recoveryAttempted
        ? ' Aggressive history compaction did not restore capacity.'
        : ' No overflow recovery was available.';
    super(
      `Agent graph supervisor context overflow; graph remains durable and recoverable.${recovery} Partial result: ${JSON.stringify(
        input.partialResult,
      )}`,
    );
    this.name = 'AgentGraphSupervisorContextOverflowError';
    this.partialResult = input.partialResult;
    this.recoveryAttempted = input.recoveryAttempted;
    if (input.recoveryFailure !== undefined) this.recoveryFailure = input.recoveryFailure;
  }
}

export interface AgentGraphSupervisorContextRecoveryDiagnostic {
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  droppedTurns?: number;
  droppedEvents?: number;
  historyCompactedEvents?: number;
  historyCompactBlocksWritten?: number;
}

export type AgentGraphSupervisorTurnOutcome =
  | GoalTurnOutcome
  | { kind: 'context_overflow'; turnId: string; reason: string }
  | { kind: 'superseded'; turnId: string; reason: string };

export async function recoverAgentGraphSupervisorContextOverflow(input: {
  rootSessionId: string;
  compactTurnId: string;
  abortSignal: AbortSignal;
  compactSession(
    sessionId: string,
    input: { turnId: string; minRecentTurns: number },
  ): AsyncIterable<SessionEvent>;
}): Promise<AgentGraphSupervisorContextRecoveryDiagnostic | undefined> {
  input.abortSignal.throwIfAborted();
  let recovery: AgentGraphSupervisorContextRecoveryDiagnostic | undefined;
  for await (const event of input.compactSession(input.rootSessionId, {
    turnId: input.compactTurnId,
    minRecentTurns: 0,
  })) {
    input.abortSignal.throwIfAborted();
    if (event.type !== 'token_usage' || !event.contextBudget) continue;
    const diagnostic = event.contextBudget;
    recovery = {
      estimatedTokensBefore: diagnostic.estimatedTokensBefore,
      estimatedTokensAfter: diagnostic.estimatedTokensAfter,
      droppedTurns: diagnostic.droppedTurns,
      droppedEvents: diagnostic.droppedEvents,
      ...(diagnostic.historyCompactedEvents !== undefined
        ? { historyCompactedEvents: diagnostic.historyCompactedEvents }
        : {}),
      ...(diagnostic.historyCompactBlocksWritten !== undefined
        ? { historyCompactBlocksWritten: diagnostic.historyCompactBlocksWritten }
        : {}),
    };
  }
  input.abortSignal.throwIfAborted();
  return recovery;
}

export type AgentGraphSupervisorWakeDiagnostic =
  | {
      event: 'context_overflow_detected';
      graphId: string;
      wakeId: string;
      attemptId: string;
      attempt: number;
      maxAttempts: number;
      recoveryAvailable: boolean;
      recoveryAlreadyAttempted: boolean;
    }
  | {
      event: 'context_overflow_recovery_completed';
      graphId: string;
      wakeId: string;
      attemptId: string;
      recovery?: AgentGraphSupervisorContextRecoveryDiagnostic;
    }
  | {
      event: 'context_overflow_recovery_failed';
      graphId: string;
      wakeId: string;
      attemptId: string;
      failureReason: string;
    }
  | {
      event: 'context_overflow_exhausted';
      graphId: string;
      wakeId: string;
      recoveryAttempted: boolean;
      partial: {
        status: AgentGraphSupervisorPartialResult['status'];
        workItems: number;
        terminalRecordIds: number;
        omittedWorkItems: number;
        omittedTerminalRecordIds: number;
      };
    };

export interface AgentGraphSupervisorWakeInput {
  activityRegistry: SessionActivityRegistry;
  wakeStore: AgentGraphSupervisorWakeStore;
  readSnapshot(rootSessionId: string): Promise<AgentGraphClientSnapshot>;
  startTurn(
    sessionId: string,
    input: UserMessageInput,
    activity: SessionActivityLease,
    abortSignal: AbortSignal,
    isCurrent: () => Promise<boolean>,
  ): Promise<AgentGraphSupervisorTurnOutcome>;
  inspectAttempt(
    rootSessionId: string,
    attemptId: string,
    turnId: string,
  ): Promise<AgentRunHeader['status'] | 'missing'>;
  shouldWake?(
    rootSessionId: string,
    result: AgentGraphScheduleReconciliationResult | undefined,
    snapshot: AgentGraphClientSnapshot,
  ): boolean | undefined | Promise<boolean | undefined>;
  renderWake?(
    rootSessionId: string,
    snapshot: AgentGraphClientSnapshot,
    result?: AgentGraphScheduleReconciliationResult,
  ):
    | {
        text: string;
        displayText: string;
        orchestrationMode: 'graph' | 'swarm';
      }
    | undefined
    | Promise<
        | {
            text: string;
            displayText: string;
            orchestrationMode: 'graph' | 'swarm';
          }
        | undefined
      >;
  recoverContextOverflow?(
    rootSessionId: string,
    input: {
      graphId: string;
      wakeId: string;
      attemptId: string;
      turnId: string;
      failureReason: string;
      abortSignal: AbortSignal;
    },
  ): Promise<AgentGraphSupervisorContextRecoveryDiagnostic | void>;
  newId(): string;
  isSessionDeliverable?(rootSessionId: string): Promise<boolean>;
  /** Keep an external host alive while a durable wake is admitted or delivered. */
  acquireResidency?(rootSessionId: string): SessionActivityLease;
  maxDeliveryAttempts?: number;
  onDiagnostic?(diagnostic: AgentGraphSupervisorWakeDiagnostic): void | Promise<void>;
  onError?(rootSessionId: string, error: unknown): void | Promise<void>;
}

/**
 * Host-side control-plane bridge from graph quiescence back to the root
 * supervisor Agent.
 *
 * SQLite owns wake admission and delivery state. A persisted prompt or Run is
 * only an attempt: the wake becomes delivered after the host observes a
 * completed root turn. Interrupted attempts remain retryable across callbacks
 * and process recovery.
 */
export class AgentGraphSupervisorWakeCoordinator {
  readonly #input: AgentGraphSupervisorWakeInput;
  readonly #tasks = new Set<Promise<void>>();
  readonly #tasksBySession = new Map<string, Set<Promise<void>>>();
  readonly #pendingWakeIds = new Set<string>();
  readonly #abortController = new AbortController();
  readonly #sessionAbortControllers = new Map<string, AbortController>();
  readonly #sessionWakeSuppressions = new Map<string, number>();
  readonly #maxDeliveryAttempts: number;
  #closed = false;

  constructor(input: AgentGraphSupervisorWakeInput) {
    this.#input = input;
    this.#maxDeliveryAttempts = input.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    if (!Number.isSafeInteger(this.#maxDeliveryAttempts) || this.#maxDeliveryAttempts < 1) {
      throw new Error('Agent graph supervisor wake attempts must be a positive safe integer');
    }
  }

  notify(
    rootSessionId: string,
    result?: AgentGraphScheduleReconciliationResult,
  ): Promise<void> | undefined {
    if (
      this.#closed ||
      this.#sessionWakesSuppressed(rootSessionId) ||
      (!this.#input.shouldWake && (!result || !isAgentGraphSupervisorMilestone(result)))
    ) {
      return undefined;
    }
    return this.#runTracked(rootSessionId, async (abortSignal) => {
      try {
        await this.#wake(rootSessionId, abortSignal, result);
      } catch (error) {
        if (!this.#closed && !isAbortError(error)) {
          await notifyError(this.#input.onError, rootSessionId, error);
        }
      }
    });
  }

  /**
   * Reconciles a parked wake after the user answers a permission prompt.
   *
   * A live waiter keeps the original startTurn activity lease until the same
   * attempt settles. If the stream already ended suspended, admission here
   * proves that waiter is gone and makes the wake eligible for a fresh turn.
   */
  notifyPermissionResponse(rootSessionId: string): Promise<void> | undefined {
    if (this.#closed || this.#sessionWakesSuppressed(rootSessionId)) return undefined;
    return this.#runTracked(rootSessionId, async (abortSignal) => {
      try {
        await this.#settlePermissionResponse(rootSessionId, abortSignal);
      } catch (error) {
        if (!this.#closed && !isAbortError(error)) {
          await notifyError(this.#input.onError, rootSessionId, error);
        }
      }
    });
  }

  /** Converges persisted wakes from AgentRun facts and resumes only safe retries. */
  async recover(): Promise<number> {
    if (this.#closed) return 0;
    let recovered = await this.#input.wakeStore.recoverAgentGraphSupervisorWakes();
    for (const wake of await this.#input.wakeStore.listUnsettledAgentGraphSupervisorWakes()) {
      if (this.#closed) return recovered;
      recovered += await this.#recoverUnsettledWake(wake);
    }
    if (this.#closed) return recovered;
    for (const wake of await this.#input.wakeStore.listRetryableAgentGraphSupervisorWakes()) {
      this.#scheduleRecoveredWake(wake);
    }
    return recovered;
  }

  async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks]);
  }

  /** Prevent supervisor retries while one client stop owns the root graph. */
  async runWithSessionWakesSuppressed<T>(
    rootSessionId: string,
    operation: () => Promise<T>,
    reason = 'agent_graph_stopped',
  ): Promise<T> {
    this.#beginSessionWakeSuppression(rootSessionId);
    try {
      return await operation();
    } finally {
      try {
        await this.#waitForSessionIdle(rootSessionId);
        await this.#supersedeSession(rootSessionId, reason);
      } finally {
        this.#endSessionWakeSuppression(rootSessionId);
      }
    }
  }

  hasLiveSessionState(rootSessionId: string): boolean {
    return this.#input.activityRegistry.whenIdle(rootSessionId) !== undefined;
  }

  async retireSessions(rootSessionIds: readonly string[]): Promise<number> {
    return this.#input.wakeStore.supersedeAgentGraphSupervisorWakes({
      rootSessionIds,
      reason: 'session_retired',
    });
  }

  beginDrain(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController.abort();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.waitForIdle();
    this.#sessionAbortControllers.clear();
    this.#tasksBySession.clear();
  }

  async #wake(
    rootSessionId: string,
    abortSignal: AbortSignal,
    result?: AgentGraphScheduleReconciliationResult,
  ): Promise<void> {
    abortSignal.throwIfAborted();
    if (!(await this.#isSessionDeliverable(rootSessionId))) return;
    const snapshot = await this.#input.readSnapshot(rootSessionId);
    abortSignal.throwIfAborted();
    const wakeDecision = await this.#input.shouldWake?.(rootSessionId, result, snapshot);
    abortSignal.throwIfAborted();
    if (
      wakeDecision === false ||
      (wakeDecision === undefined && (!result || !isAgentGraphSupervisorMilestone(result)))
    ) {
      return;
    }
    if (this.#closed || snapshot.closed || snapshot.scheduleRevision === 0) return;
    const wakeId = `${snapshot.graphId}:${snapshot.snapshotVersion}`;
    if (this.#pendingWakeIds.has(wakeId)) return;
    this.#pendingWakeIds.add(wakeId);
    try {
      const claimed = await this.#input.wakeStore.claimAgentGraphSupervisorWake({
        schemaVersion: AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION,
        graphId: snapshot.graphId,
        wakeId,
        snapshotVersion: snapshot.snapshotVersion,
        rootSessionId,
      });
      if (this.#closed || claimed.wake.status === 'delivered') return;
      abortSignal.throwIfAborted();
      await this.#deliverWake(claimed.wake, snapshot, abortSignal, result);
    } finally {
      this.#pendingWakeIds.delete(wakeId);
    }
  }

  #scheduleRecoveredWake(wake: AgentGraphSupervisorWakeRecord): void {
    if (this.#closed || this.#pendingWakeIds.has(wake.wakeId)) return;
    this.#pendingWakeIds.add(wake.wakeId);
    void this.#runTracked(wake.rootSessionId, async (abortSignal) => {
      try {
        await this.#resumeWake(wake, abortSignal);
      } catch (error) {
        if (!this.#closed && !isAbortError(error)) {
          await notifyError(this.#input.onError, wake.rootSessionId, error);
        }
      } finally {
        this.#pendingWakeIds.delete(wake.wakeId);
      }
    });
  }

  #runTracked(
    rootSessionId: string,
    operation: (abortSignal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const residency = this.#input.acquireResidency?.(rootSessionId);
    const abortSignal = this.#sessionAbortSignal(rootSessionId);
    const task = Promise.resolve()
      .then(() => operation(abortSignal))
      .finally(() => residency?.release());
    this.#tasks.add(task);
    const sessionTasks = this.#tasksBySession.get(rootSessionId) ?? new Set<Promise<void>>();
    sessionTasks.add(task);
    this.#tasksBySession.set(rootSessionId, sessionTasks);
    void task.then(
      () => this.#forgetTask(rootSessionId, task),
      () => this.#forgetTask(rootSessionId, task),
    );
    return task;
  }

  async #resumeWake(wake: AgentGraphSupervisorWakeRecord, abortSignal: AbortSignal): Promise<void> {
    abortSignal.throwIfAborted();
    if (!(await this.#isSessionDeliverable(wake.rootSessionId))) {
      await this.#supersedeSession(wake.rootSessionId, 'session_unavailable');
      return;
    }
    const snapshot = await this.#input.readSnapshot(wake.rootSessionId);
    if (snapshot.graphId !== wake.graphId) {
      await this.#input.wakeStore.supersedeAgentGraphSupervisorWakes({
        rootSessionIds: [wake.rootSessionId],
        graphIds: [wake.graphId],
        reason: 'agent_graph_epoch_advanced',
      });
      return;
    }
    if (this.#closed || snapshot.closed || snapshot.scheduleRevision === 0) {
      return;
    }
    abortSignal.throwIfAborted();
    await this.#deliverWake(wake, snapshot, abortSignal);
  }

  async #deliverWake(
    wake: AgentGraphSupervisorWakeRecord,
    snapshot: AgentGraphClientSnapshot,
    abortSignal: AbortSignal,
    result?: AgentGraphScheduleReconciliationResult,
  ): Promise<void> {
    const presentation = (await this.#input.renderWake?.(wake.rootSessionId, snapshot, result)) ?? {
      text: renderAgentGraphSupervisorWakePrompt(snapshot, result),
      displayText: 'Agent graph reached a supervisor checkpoint.',
      orchestrationMode: 'graph' as const,
    };
    let lastFailure: string | undefined;
    let overflowRecoveryAttempted = false;
    for (let index = 0; index < this.#maxDeliveryAttempts; index += 1) {
      abortSignal.throwIfAborted();
      if (!(await this.#isSessionDeliverable(wake.rootSessionId))) {
        await this.#supersedeSession(wake.rootSessionId, 'session_unavailable');
        return;
      }
      let overflowAttempt: { attemptId: string; turnId: string; failureReason: string } | undefined;
      const activity = await this.#input.activityRegistry.acquire(wake.rootSessionId, abortSignal);
      try {
        if (this.#closed || this.#sessionWakesSuppressed(wake.rootSessionId)) return;
        const attemptId = this.#input.newId();
        const turnId = this.#input.newId();
        const admission = await this.#input.wakeStore.beginAgentGraphSupervisorWakeAttempt({
          graphId: wake.graphId,
          wakeId: wake.wakeId,
          attemptId,
          turnId,
        });
        if (!admission.acquired) return;
        if (this.#sessionWakesSuppressed(wake.rootSessionId)) return;
        if (this.#closed) {
          await this.#markRetryable(wake.graphId, wake.wakeId, attemptId, 'host_shutdown');
          return;
        }

        try {
          const outcome = await this.#input.startTurn(
            wake.rootSessionId,
            {
              turnId,
              text: presentation.text,
              displayText: presentation.displayText,
              turnOrchestration: { mode: presentation.orchestrationMode, source: 'host_api' },
              origin: {
                kind: 'agent_graph',
                graphId: wake.graphId,
                wakeId: wake.wakeId,
                attemptId,
              },
            },
            activity,
            abortSignal,
            () => this.#isWakeCurrent(wake),
          );
          if (this.#sessionWakesSuppressed(wake.rootSessionId)) return;
          if (outcome.kind === 'completed') {
            await this.#input.wakeStore.completeAgentGraphSupervisorWakeAttempt({
              graphId: wake.graphId,
              wakeId: wake.wakeId,
              attemptId,
              status: 'delivered',
            });
            return;
          }
          if (outcome.kind === 'superseded') {
            await this.#input.wakeStore.completeAgentGraphSupervisorWakeAttempt({
              graphId: wake.graphId,
              wakeId: wake.wakeId,
              attemptId,
              status: 'superseded',
              failureReason: outcome.reason,
            });
            return;
          }
          if (outcome.kind === 'suspended') {
            await this.#input.wakeStore.completeAgentGraphSupervisorWakeAttempt({
              graphId: wake.graphId,
              wakeId: wake.wakeId,
              attemptId,
              status: 'waiting_permission',
            });
            return;
          }
          lastFailure = wakeOutcomeFailure(outcome);
          await this.#markRetryable(wake.graphId, wake.wakeId, attemptId, lastFailure);
          if (outcome.kind === 'context_overflow' || isSupervisorContextOverflow(lastFailure)) {
            overflowAttempt = { attemptId, turnId, failureReason: lastFailure };
          }
        } catch (error) {
          if (this.#sessionWakesSuppressed(wake.rootSessionId)) return;
          lastFailure = errorMessage(error);
          await this.#markRetryable(wake.graphId, wake.wakeId, attemptId, lastFailure);
          if (isSupervisorContextOverflow(lastFailure)) {
            overflowAttempt = { attemptId, turnId, failureReason: lastFailure };
          }
        }
      } finally {
        activity.release();
      }
      if (this.#closed || this.#sessionWakesSuppressed(wake.rootSessionId)) return;
      if (overflowAttempt) {
        const canRecover =
          !overflowRecoveryAttempted &&
          index + 1 < this.#maxDeliveryAttempts &&
          this.#input.recoverContextOverflow !== undefined;
        await emitWakeDiagnostic(this.#input.onDiagnostic, {
          event: 'context_overflow_detected',
          graphId: wake.graphId,
          wakeId: wake.wakeId,
          attemptId: overflowAttempt.attemptId,
          attempt: index + 1,
          maxAttempts: this.#maxDeliveryAttempts,
          recoveryAvailable: this.#input.recoverContextOverflow !== undefined,
          recoveryAlreadyAttempted: overflowRecoveryAttempted,
        });
        if (!canRecover) {
          const overflowError = await this.#contextOverflowError(wake.rootSessionId, snapshot, {
            recoveryAttempted: overflowRecoveryAttempted,
          });
          await emitWakeDiagnostic(
            this.#input.onDiagnostic,
            exhaustedDiagnostic(wake, overflowError),
          );
          throw overflowError;
        }
        overflowRecoveryAttempted = true;
        try {
          const recovery = await this.#input.recoverContextOverflow!(wake.rootSessionId, {
            graphId: wake.graphId,
            wakeId: wake.wakeId,
            ...overflowAttempt,
            abortSignal,
          });
          await emitWakeDiagnostic(this.#input.onDiagnostic, {
            event: 'context_overflow_recovery_completed',
            graphId: wake.graphId,
            wakeId: wake.wakeId,
            attemptId: overflowAttempt.attemptId,
            ...(recovery ? { recovery } : {}),
          });
        } catch (error) {
          if (this.#closed || isAbortError(error)) return;
          const failureReason = errorMessage(error);
          await emitWakeDiagnostic(this.#input.onDiagnostic, {
            event: 'context_overflow_recovery_failed',
            graphId: wake.graphId,
            wakeId: wake.wakeId,
            attemptId: overflowAttempt.attemptId,
            failureReason: failureReason.slice(0, 1_000),
          });
          const overflowError = await this.#contextOverflowError(wake.rootSessionId, snapshot, {
            recoveryAttempted: true,
            recoveryFailure: failureReason,
          });
          await emitWakeDiagnostic(
            this.#input.onDiagnostic,
            exhaustedDiagnostic(wake, overflowError),
          );
          throw overflowError;
        }
      }
      if (this.#closed) return;
    }
    throw new Error(
      `Agent graph supervisor wake was not delivered after ${this.#maxDeliveryAttempts} attempts: ${
        lastFailure ?? 'unknown failure'
      }`,
    );
  }

  async #contextOverflowError(
    rootSessionId: string,
    fallbackSnapshot: AgentGraphClientSnapshot,
    input: { recoveryAttempted: boolean; recoveryFailure?: string },
  ): Promise<AgentGraphSupervisorContextOverflowError> {
    let currentSnapshot = fallbackSnapshot;
    try {
      currentSnapshot = await this.#input.readSnapshot(rootSessionId);
    } catch {
      // The checkpoint snapshot is already durable and sufficient for a bounded fallback.
    }
    return new AgentGraphSupervisorContextOverflowError({
      partialResult: projectAgentGraphSupervisorPartialResult(currentSnapshot),
      ...input,
    });
  }

  async #markRetryable(
    graphId: string,
    wakeId: string,
    attemptId: string,
    failureReason: string,
  ): Promise<AgentGraphSupervisorWakeRecord> {
    return this.#input.wakeStore.completeAgentGraphSupervisorWakeAttempt({
      graphId,
      wakeId,
      attemptId,
      status: 'retryable_failed',
      failureReason: failureReason.slice(0, 4_000) || 'unknown failure',
    });
  }

  async #isSessionDeliverable(rootSessionId: string): Promise<boolean> {
    return (await this.#input.isSessionDeliverable?.(rootSessionId)) ?? true;
  }

  async #isWakeCurrent(wake: AgentGraphSupervisorWakeRecord): Promise<boolean> {
    if (this.#sessionWakesSuppressed(wake.rootSessionId)) return false;
    if (!(await this.#isSessionDeliverable(wake.rootSessionId))) return false;
    const snapshot = await this.#input.readSnapshot(wake.rootSessionId);
    return (
      !snapshot.closed &&
      snapshot.graphId === wake.graphId &&
      `${snapshot.graphId}:${snapshot.snapshotVersion}` === wake.wakeId
    );
  }

  #supersedeSession(rootSessionId: string, reason: string): Promise<number> {
    return this.#input.wakeStore.supersedeAgentGraphSupervisorWakes({
      rootSessionIds: [rootSessionId],
      reason,
    });
  }

  async #recoverUnsettledWake(wake: AgentGraphSupervisorWakeRecord): Promise<number> {
    const attemptId = wake.currentAttemptId;
    const turnId = wake.currentTurnId;
    if (!attemptId || !turnId) {
      throw new Error(
        `Unsettled Agent graph supervisor wake ${wake.graphId}/${wake.wakeId} has no current attempt`,
      );
    }
    const runStatus = await this.#input.inspectAttempt(wake.rootSessionId, attemptId, turnId);
    if (runStatus === 'completed') {
      await this.#input.wakeStore.completeAgentGraphSupervisorWakeAttempt({
        graphId: wake.graphId,
        wakeId: wake.wakeId,
        attemptId,
        status: 'delivered',
      });
      return 1;
    }
    await this.#markRetryable(
      wake.graphId,
      wake.wakeId,
      attemptId,
      runStatus === 'failed' || runStatus === 'cancelled'
        ? `agent_run_${runStatus}`
        : `host_restart:${runStatus}`,
    );
    return 1;
  }

  async #settlePermissionResponse(rootSessionId: string, abortSignal: AbortSignal): Promise<void> {
    const activity = await this.#input.activityRegistry.acquire(rootSessionId, abortSignal);
    const retryable: AgentGraphSupervisorWakeRecord[] = [];
    try {
      if (this.#closed || this.#sessionWakesSuppressed(rootSessionId)) return;
      const unsettled = (
        await this.#input.wakeStore.listUnsettledAgentGraphSupervisorWakes()
      ).filter((wake) => wake.rootSessionId === rootSessionId);
      for (const wake of unsettled) {
        const attemptId = wake.currentAttemptId;
        const turnId = wake.currentTurnId;
        if (!attemptId || !turnId) {
          throw new Error(
            `Parked Agent graph supervisor wake ${wake.graphId}/${wake.wakeId} has no current attempt`,
          );
        }
        const runStatus = await this.#input.inspectAttempt(rootSessionId, attemptId, turnId);
        if (runStatus === 'completed') {
          await this.#input.wakeStore.completeAgentGraphSupervisorWakeAttempt({
            graphId: wake.graphId,
            wakeId: wake.wakeId,
            attemptId,
            status: 'delivered',
          });
          continue;
        }
        retryable.push(
          await this.#markRetryable(
            wake.graphId,
            wake.wakeId,
            attemptId,
            `permission_waiter_lost:${runStatus}`,
          ),
        );
      }
    } finally {
      activity.release();
    }
    for (const wake of retryable) this.#scheduleRecoveredWake(wake);
  }

  #beginSessionWakeSuppression(rootSessionId: string): void {
    const count = this.#sessionWakeSuppressions.get(rootSessionId) ?? 0;
    this.#sessionWakeSuppressions.set(rootSessionId, count + 1);
    if (count === 0) {
      const controller = this.#sessionAbortControllers.get(rootSessionId) ?? new AbortController();
      this.#sessionAbortControllers.set(rootSessionId, controller);
      controller.abort();
    }
  }

  #endSessionWakeSuppression(rootSessionId: string): void {
    const count = this.#sessionWakeSuppressions.get(rootSessionId);
    if (count === undefined) return;
    if (count > 1) {
      this.#sessionWakeSuppressions.set(rootSessionId, count - 1);
      return;
    }
    this.#sessionWakeSuppressions.delete(rootSessionId);
    if (!this.#tasksBySession.has(rootSessionId)) {
      this.#sessionAbortControllers.delete(rootSessionId);
    }
  }

  #sessionWakesSuppressed(rootSessionId: string): boolean {
    return this.#sessionWakeSuppressions.has(rootSessionId);
  }

  #sessionAbortSignal(rootSessionId: string): AbortSignal {
    let controller = this.#sessionAbortControllers.get(rootSessionId);
    if (!controller) {
      controller = new AbortController();
      this.#sessionAbortControllers.set(rootSessionId, controller);
    }
    return AbortSignal.any([this.#abortController.signal, controller.signal]);
  }

  async #waitForSessionIdle(rootSessionId: string): Promise<void> {
    while (this.#tasksBySession.has(rootSessionId)) {
      await Promise.all([...this.#tasksBySession.get(rootSessionId)!]);
    }
  }

  #forgetTask(rootSessionId: string, task: Promise<void>): void {
    this.#tasks.delete(task);
    const sessionTasks = this.#tasksBySession.get(rootSessionId);
    sessionTasks?.delete(task);
    if (sessionTasks?.size === 0) this.#tasksBySession.delete(rootSessionId);
    if (!this.#sessionWakesSuppressed(rootSessionId) && !this.#tasksBySession.has(rootSessionId)) {
      this.#sessionAbortControllers.delete(rootSessionId);
    }
  }
}

export function isAgentGraphSupervisorMilestone(
  result: AgentGraphScheduleReconciliationResult,
): boolean {
  if (
    result.status === 'cancelled' ||
    result.status === 'stale' ||
    result.status === 'limit_reached'
  ) {
    return false;
  }
  return result.dispatches.length > 0 || result.failures.length > 0;
}

function wakeOutcomeFailure(
  outcome: Exclude<AgentGraphSupervisorTurnOutcome, { kind: 'completed' | 'superseded' }>,
): string {
  if (outcome.kind === 'context_overflow') return outcome.reason;
  if (outcome.kind === 'errored' || outcome.kind === 'suspended') {
    return `${outcome.kind}: ${outcome.reason}`;
  }
  return 'aborted';
}

function isSupervisorContextOverflow(failureReason: string): boolean {
  const normalized = failureReason.toLowerCase();
  return (
    normalized.includes('context_overflow') ||
    normalized.includes('context window exceeded') ||
    normalized.includes('context budget exhausted') ||
    isContextOverflowErrorText(failureReason)
  );
}

function projectAgentGraphSupervisorPartialResult(
  snapshot: AgentGraphClientSnapshot,
): AgentGraphSupervisorPartialResult {
  const work = snapshot.work.slice(0, MAX_PARTIAL_WORK_ITEMS).map((item) => ({
    workId: item.workId,
    status: item.status,
    target: item.target,
    ...(item.replaces !== undefined ? { replaces: item.replaces } : {}),
  }));
  const allTerminalRecordIds = [
    ...(snapshot.finish?.resultIds ?? []),
    ...snapshot.terminalHistory.records.map((record) => record.recordId),
  ].filter((recordId, index, recordIds) => recordIds.indexOf(recordId) === index);
  const terminalRecordIds = allTerminalRecordIds.slice(0, MAX_PARTIAL_RECORD_IDS);
  return {
    schemaVersion: 1,
    graphId: snapshot.graphId,
    snapshotVersion: snapshot.snapshotVersion,
    status: snapshot.status,
    closed: snapshot.closed,
    scheduleRevision: snapshot.scheduleRevision,
    work,
    terminalRecordIds,
    omitted: {
      work: snapshot.omitted.work + Math.max(0, snapshot.work.length - work.length),
      terminalRecordIds: Math.max(0, allTerminalRecordIds.length - terminalRecordIds.length),
    },
  };
}

function renderAgentGraphSupervisorWakePrompt(
  snapshot: AgentGraphClientSnapshot,
  result?: AgentGraphScheduleReconciliationResult,
): string {
  return [
    '<agent-graph-supervisor-checkpoint>',
    `Graph ${snapshot.graphId} reached a durable supervisor checkpoint.`,
    `Reconciliation status: ${result?.status ?? 'recovered'}. Snapshot: ${snapshot.snapshotVersion}.`,
    'Inspect the graph with view_agent_graph. Read child results with agent_output view=result; use raw event views only for narrow diagnostics.',
    'Then either schedule the next work with update_agent_graph or finish the graph with the selected result record IDs.',
    'If you schedule more work and no immediate supervisor decision remains, call yield_agent_graph. Do not poll or sleep while operators execute.',
    'Report the useful outcome to the user when the graph is complete.',
    '</agent-graph-supervisor-checkpoint>',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function notifyError(
  observer: AgentGraphSupervisorWakeInput['onError'],
  rootSessionId: string,
  error: unknown,
): Promise<void> {
  try {
    await observer?.(rootSessionId, error);
  } catch {
    // Wake diagnostics must not become graph data-path failures.
  }
}

function exhaustedDiagnostic(
  wake: AgentGraphSupervisorWakeRecord,
  error: AgentGraphSupervisorContextOverflowError,
): AgentGraphSupervisorWakeDiagnostic {
  return {
    event: 'context_overflow_exhausted',
    graphId: wake.graphId,
    wakeId: wake.wakeId,
    recoveryAttempted: error.recoveryAttempted,
    partial: {
      status: error.partialResult.status,
      workItems: error.partialResult.work.length,
      terminalRecordIds: error.partialResult.terminalRecordIds.length,
      omittedWorkItems: error.partialResult.omitted.work,
      omittedTerminalRecordIds: error.partialResult.omitted.terminalRecordIds,
    },
  };
}

async function emitWakeDiagnostic(
  observer: AgentGraphSupervisorWakeInput['onDiagnostic'],
  diagnostic: AgentGraphSupervisorWakeDiagnostic,
): Promise<void> {
  try {
    await observer?.(diagnostic);
  } catch {
    // Wake diagnostics must never alter delivery or recovery correctness.
  }
}
