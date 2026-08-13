import { randomUUID } from 'node:crypto';
import {
  sameGoalControlLease,
  type GoalAuthorityRecord,
  type GoalControlLease as DurableGoalControlLease,
  type GoalCurrentExecution,
  type GoalState as DurableGoalState,
} from '@maka/core/goal';
import { userFacingText, type StoredMessage } from '@maka/core/session';
import {
  GoalContinuationCoordinator,
  type GoalSessionCloseOperation,
  type GoalObservedTurnStart,
  type GoalTaskGateTrace,
  type GoalTurnAdmission,
  type GoalTurnOutcome,
} from '@maka/runtime/goal-continuation';
import {
  GoalManager,
  GOAL_REASON_TEXT_LIMIT,
  TERMINAL_GOAL_STATUSES,
  truncateGoalText,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalState,
} from '@maka/runtime/goal-state';
import { buildGoalTools } from '@maka/runtime/goal-tools';
import { type GoalEvaluatorResource } from '@maka/runtime/goal-evaluator';
import { type MakaTool } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  authenticateInteractiveGoalAuthorityWriter,
  type GoalAuthoritySnapshot,
  type InteractiveGoalAuthorityWriter,
} from '@maka/storage/goal-authority';
import type { GoalControlInput, GoalProjection, OperationOutcome } from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { GoalOperationHandlerMap } from './operation-dispatcher.js';
import { projectGoalState } from './goal-projection.js';
import {
  type HostedExecutionAuthority,
  type HostedExecutionCompletion,
  type HostedExecutionCompletionObserver,
  type HostedExecutionObservation,
} from './hosted-execution-authority.js';
import { waitForHostedExecutionTerminal } from './hosted-execution-wait.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { goalTurnOutcomeFromHostedExecution } from './goal-execution-coordinator.js';

type GoalStores = Pick<ExecutionStoresWriter<'interactive'>, 'sessionStore' | 'agentRunStore'>;

export interface HostGoalCoordinatorOptions {
  readonly store: InteractiveGoalAuthorityWriter;
  readonly stores: GoalStores;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly evaluator: GoalEvaluatorResource;
  readonly executions: Pick<HostedExecutionAuthority, 'reconcile' | 'subscribe'>;
  readonly admitTurn: (
    sessionId: string,
    text: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ) => GoalTurnAdmission;
  readonly listActionableTaskKeys: (sessionId: string) => Promise<string[]>;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly onProjectionChanged: (sessionId: string) => void;
  readonly requestDrain: () => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface HostGoalSessionRetirement {
  commit(): void;
  rollback(): void;
}

/** Durable Runtime Host authority for one Goal generation per Session. */
export class HostGoalCoordinator {
  readonly handlers: GoalOperationHandlerMap = {
    'goal.query': (input) => this.#query(input.sessionId),
    'goal.control': (input) => this.#control(input),
  };

  readonly manager: GoalManager;
  readonly continuation: GoalContinuationCoordinator;
  readonly tools: readonly MakaTool[];
  readonly #store: InteractiveGoalAuthorityWriter;
  readonly #stores: GoalStores;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #residencies = new Map<string, RuntimeHostResidency>();
  readonly #onProjectionChanged: (sessionId: string) => void;
  readonly #newId: () => string;
  readonly #requestDrain: () => void;
  readonly #acquireResidency: () => RuntimeHostResidency;
  readonly #executions: Pick<HostedExecutionAuthority, 'reconcile' | 'subscribe'>;
  readonly #authorityBySession = new Map<string, GoalAuthoritySnapshot>();
  readonly #recoveryWaits = new Set<Promise<void>>();
  readonly #recoveryAbort = new AbortController();
  #persistenceLane: Promise<void> = Promise.resolve();
  #persistenceFailure: unknown;
  #prepared = false;
  #draining = false;

  constructor(options: HostGoalCoordinatorOptions) {
    this.#store = authenticateInteractiveGoalAuthorityWriter(options.store);
    this.#stores = options.stores;
    this.#sessionAdmission = options.sessionAdmission;
    this.#onProjectionChanged = options.onProjectionChanged;
    const now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.#requestDrain = options.requestDrain;
    this.#acquireResidency = options.acquireResidency;
    this.#executions = options.executions;
    this.manager = new GoalManager({
      generateId: this.#newId,
      now,
      onChange: (goal, controlLease) => {
        this.#enqueueGoalState(goal, controlLease);
        this.#syncResidency(goal, options.acquireResidency);
        this.#onProjectionChanged(goal.sessionId);
      },
    });
    const tokenCache = new Map<string, number>();
    this.continuation = new GoalContinuationCoordinator({
      goalManager: this.manager,
      evaluator: options.evaluator,
      getRecentContext: async (sessionId) => {
        const messages = await this.#stores.sessionStore.readMessagesSnapshot(sessionId);
        tokenCache.set(sessionId, tokenCount(messages));
        return recentContext(messages);
      },
      getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
      admitTurn: options.admitTurn,
      taskGate: {
        listActionableTaskKeys: options.listActionableTaskKeys,
        recordDecision: (trace) => this.#recordTaskGateDecision(trace, now),
      },
      durability: {
        flush: (sessionId) => this.#flushGoalState(sessionId),
        recordCurrentExecution: (current) => this.#recordCurrentExecution(current),
        settleCurrentExecution: (sessionId, turnId) =>
          this.#settleCurrentExecution(sessionId, turnId),
      },
    });
    this.tools = Object.freeze(
      buildGoalTools({
        goalManager: this.manager,
        goalContinuation: this.continuation,
        getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
        isAvailable: () => !this.#draining,
        flush: (sessionId) => this.#flushGoalState(sessionId),
        now,
      }),
    );
  }

  async prepareRecovery(): Promise<void> {
    if (this.#prepared) return;
    for (const snapshot of await this.#store.list()) {
      const { goal, controlLease } = snapshot.record;
      try {
        const header = await this.#stores.sessionStore.readHeaderSnapshot(goal.sessionId);
        if (header.isArchived || header.status === 'archived') {
          await this.#deleteOrphanedAuthority(snapshot);
          continue;
        }
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
        await this.#deleteOrphanedAuthority(snapshot);
        continue;
      }
      if (this.#authorityBySession.has(goal.sessionId)) {
        throw new Error(`Session ${goal.sessionId} has duplicate durable Goal authority`);
      }
      this.#authorityBySession.set(goal.sessionId, snapshot);
      this.manager.restore(goal, controlLease);
      this.#syncResidency(goal, this.#acquireResidency);
    }
    this.#prepared = true;
  }

  async recover(): Promise<void> {
    if (!this.#prepared) throw new Error('Goal recovery was not prepared');
    for (const snapshot of this.#authorityBySession.values()) {
      if (snapshot.record.currentExecution) {
        await this.#recoverCurrentExecution(snapshot.record.currentExecution);
      } else {
        this.continuation.recoverActiveGoal(snapshot.record.goal.sessionId);
      }
    }
  }

  readProjection(sessionId: string): GoalProjection | null {
    const goal = this.manager.get(sessionId);
    return goal ? projectGoalState(goal) : null;
  }

  beginObservedTurn(sessionId: string, turnId: string): GoalObservedTurnStart {
    return this.continuation.beginObservedTurn(sessionId, turnId);
  }

  begin(input: HostedExecutionObservation): HostedExecutionCompletionObserver | undefined {
    if (input.descriptor.kind === 'goal' || input.descriptor.kind === 'context_compact') {
      return undefined;
    }
    const registration = this.continuation.beginObservedTurn(input.sessionId, input.turnId);
    if (registration.kind !== 'registered') return undefined;
    return (completion) =>
      registration.settle(goalOutcomeFromCompletion(completion)).catch((error) => {
        this.#persistenceFailure ??= error;
        this.#requestDrain();
      });
  }

  matchesActive(
    sessionId: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ): boolean {
    return (
      this.manager.matchesActive(sessionId, checkpoint) &&
      this.manager.matchesControlLease(sessionId, controlLease)
    );
  }

  hasLiveGoal(sessionId: string): boolean {
    const goal = this.manager.get(sessionId);
    return goal !== undefined && !TERMINAL_GOAL_STATUSES.has(goal.status);
  }

  async beginSessionRetirement(
    sessionIds: readonly string[],
    kind: 'archive' | 'remove',
  ): Promise<HostGoalSessionRetirement> {
    const unique = [...new Set(sessionIds)];
    if (unique.some((sessionId) => this.hasLiveGoal(sessionId))) {
      throw new Error('Session retirement cannot revoke a live Goal');
    }
    const operations = new Map<string, GoalSessionCloseOperation>();
    for (const sessionId of unique) {
      operations.set(sessionId, this.continuation.beginSessionClose(sessionId, kind));
    }
    try {
      await Promise.all(unique.map((sessionId) => this.#flushGoalState(sessionId)));
    } catch (error) {
      for (const operation of operations.values()) operation.rollback();
      throw error;
    }
    let settled = false;
    return Object.freeze({
      commit: () => {
        if (settled) return;
        settled = true;
        for (const sessionId of unique) {
          operations.get(sessionId)?.commit();
          this.#authorityBySession.delete(sessionId);
          if (this.manager.remove(sessionId)) this.#onProjectionChanged(sessionId);
        }
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        for (const operation of operations.values()) operation.rollback();
      },
    });
  }

  unarchiveSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      this.continuation.unarchiveSession(sessionId);
    }
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#recoveryAbort.abort();
    this.continuation.dispose();
    this.manager.dispose();
    for (const residency of this.#residencies.values()) residency.release();
    this.#residencies.clear();
  }

  close(): Promise<void> {
    this.beginDrain();
    return Promise.all([
      this.continuation.close(),
      this.#flushGoalState(),
      ...this.#recoveryWaits,
    ]).then(() => undefined);
  }

  #query(sessionId: string): Promise<OperationOutcome<'goal.query'>> {
    return this.#sessionAdmission.run(sessionId, async () => {
      await this.#flushGoalState(sessionId);
      try {
        await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) return notFound('Session does not exist');
        throw error;
      }
      return {
        ok: true,
        result: { sessionId, goal: this.readProjection(sessionId) },
      };
    });
  }

  #control(input: GoalControlInput): Promise<OperationOutcome<'goal.control'>> {
    return this.#sessionAdmission.run(input.sessionId, async () => {
      let header;
      try {
        header = await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) return notFound('Session does not exist');
        throw error;
      }
      if (header.isArchived || header.status === 'archived') {
        return sessionArchived('Archived Session Goal state cannot be controlled');
      }
      const current = this.manager.get(input.sessionId);
      if (!current) return notFound('Session has no Goal in this Host Epoch');
      if (current.id !== input.goalId || current.revision !== input.expectedRevision) {
        return operationConflict('Goal generation or revision no longer matches');
      }

      let changed: GoalState | undefined;
      if (input.action === 'pause') {
        changed = this.manager.pause(input.sessionId);
        if (changed) this.continuation.invalidateSession(input.sessionId);
      } else if (input.action === 'resume') {
        changed = this.continuation.resumeFromControl(input.sessionId, {
          goalId: current.id,
          revision: current.revision,
        });
      } else {
        changed = this.manager.clear(input.sessionId);
        if (changed) this.continuation.invalidateSession(input.sessionId);
      }
      if (!changed) {
        return operationConflict(`Goal cannot ${input.action} from status ${current.status}`);
      }
      await this.#flushGoalState(input.sessionId);
      return {
        ok: true,
        result: { sessionId: input.sessionId, goal: projectGoalState(changed) },
      };
    });
  }

  #enqueueGoalState(goal: DurableGoalState, controlLease: DurableGoalControlLease): void {
    const current = this.#authorityBySession.get(goal.sessionId);
    this.#enqueueAuthorityCommit(goal.sessionId, {
      schemaVersion: 1,
      goal,
      controlLease,
      currentExecution:
        current?.record.goal.id === goal.id && goal.revision >= current.record.goal.revision
          ? current.record.currentExecution
          : null,
    });
  }

  async #recordCurrentExecution(current: GoalCurrentExecution): Promise<void> {
    const authority = this.#authorityBySession.get(current.execution.sessionId);
    if (
      !authority ||
      authority.record.goal.id !== current.checkpoint.goalId ||
      !sameGoalControlLease(authority.record.controlLease, current.controlLease)
    ) {
      throw new Error('Goal execution no longer matches its durable authority');
    }
    this.#enqueueAuthorityCommit(current.execution.sessionId, {
      ...authority.record,
      currentExecution: current,
    });
    await this.#flushGoalState(current.execution.sessionId);
  }

  async #recoverCurrentExecution(current: GoalCurrentExecution): Promise<void> {
    const durableAdmission = await this.#stores.agentRunStore.readRootTurnAdmission(
      current.execution.sessionId,
      current.execution.turnId,
    );
    if (!durableAdmission) {
      await this.#settleCurrentExecution(current.execution.sessionId, current.execution.turnId);
      this.continuation.recoverActiveGoal(current.execution.sessionId);
      return;
    }
    const registration = this.continuation.recoverCurrentExecution(current);
    if (registration.kind !== 'registered') {
      await this.#settleCurrentExecution(current.execution.sessionId, current.execution.turnId);
      this.continuation.recoverActiveGoal(current.execution.sessionId);
      return;
    }
    let markReconciled!: () => void;
    const firstReconciliation = new Promise<void>((resolve) => {
      markReconciled = resolve;
    });
    const settlement = waitForHostedExecutionTerminal(
      this.#executions,
      current.execution,
      { ...current.execution, status: 'admitted' },
      {
        abortSignal: this.#recoveryAbort.signal,
        onReconciled: markReconciled,
      },
    ).then((terminal) => registration.settle(goalTurnOutcomeFromHostedExecution(terminal)));
    this.#trackRecoveryWait(settlement);
    await Promise.race([firstReconciliation, settlement]);
  }

  #trackRecoveryWait(wait: Promise<void>): void {
    const tracked = wait
      .catch((error) => {
        if (this.#draining && isAbortError(error)) return;
        this.#persistenceFailure ??= error;
        this.#requestDrain();
      })
      .finally(() => this.#recoveryWaits.delete(tracked));
    this.#recoveryWaits.add(tracked);
  }

  async #settleCurrentExecution(sessionId: string, turnId: string): Promise<void> {
    const authority = this.#authorityBySession.get(sessionId);
    if (!authority || authority.record.currentExecution?.execution.turnId !== turnId) return;
    this.#enqueueAuthorityCommit(sessionId, {
      ...authority.record,
      currentExecution: null,
    });
    await this.#flushGoalState(sessionId);
  }

  #enqueueAuthorityCommit(sessionId: string, record: GoalAuthorityRecord | null): void {
    const current = this.#authorityBySession.get(sessionId);
    const expectedAuthorityRevision = current?.authorityRevision ?? null;
    const nextAuthorityRevision = (expectedAuthorityRevision ?? -1) + 1;
    if (record === null) {
      this.#authorityBySession.delete(sessionId);
    } else {
      this.#authorityBySession.set(sessionId, {
        authorityRevision: nextAuthorityRevision,
        record,
      });
    }
    const commit = this.#persistenceLane.then(async () => {
      let result;
      try {
        result = await this.#store.commit({
          sessionId,
          expectedAuthorityRevision,
          record,
        });
      } catch (error) {
        const currentExecution = record?.currentExecution;
        throw new Error(
          `Unable to persist Goal authority for Session ${sessionId}, Goal revision ${String(record?.goal.revision)}, execution checkpoint ${String(currentExecution?.checkpoint.revision)}, control generations ${String(currentExecution?.controlLease.generation)}/${String(record?.controlLease.generation)}`,
          { cause: error },
        );
      }
      if (result.kind === 'revision_conflict') {
        throw new Error(
          `Goal authority revision conflict for Session ${sessionId}: expected ${String(expectedAuthorityRevision)}, actual ${String(result.actualAuthorityRevision)}`,
        );
      }
      if (record === null) {
        if (result.snapshot !== null) {
          throw new Error(`Goal authority deletion retained Session ${sessionId}`);
        }
      } else if (result.snapshot?.authorityRevision !== nextAuthorityRevision) {
        throw new Error(`Goal authority changed its committed revision for Session ${sessionId}`);
      }
    });
    this.#persistenceLane = commit.catch((error) => {
      this.#persistenceFailure ??= error;
      this.#requestDrain();
    });
  }

  async #deleteOrphanedAuthority(snapshot: GoalAuthoritySnapshot): Promise<void> {
    const result = await this.#store.commit({
      sessionId: snapshot.record.goal.sessionId,
      expectedAuthorityRevision: snapshot.authorityRevision,
      record: null,
    });
    if (result.kind === 'revision_conflict') {
      throw new Error(
        `Goal authority changed during recovery for Session ${snapshot.record.goal.sessionId}`,
      );
    }
  }

  async #flushGoalState(_sessionId?: string): Promise<void> {
    await this.#persistenceLane;
    if (this.#persistenceFailure !== undefined) throw this.#persistenceFailure;
  }

  #syncResidency(goal: GoalState, acquire: () => RuntimeHostResidency): void {
    const retained = this.#residencies.get(goal.sessionId);
    if (!TERMINAL_GOAL_STATUSES.has(goal.status)) {
      if (!retained && !this.#draining) this.#residencies.set(goal.sessionId, acquire());
      return;
    }
    retained?.release();
    this.#residencies.delete(goal.sessionId);
  }

  async #recordTaskGateDecision(trace: GoalTaskGateTrace, now: () => number): Promise<void> {
    const admission = await this.#stores.agentRunStore.readRootTurnAdmission(
      trace.sessionId,
      trace.turnId,
    );
    if (!admission) return;
    await this.#stores.agentRunStore.appendEvent(trace.sessionId, admission.runId, {
      type: 'task_gate_decided',
      id: this.#newId(),
      runId: admission.runId,
      sessionId: trace.sessionId,
      turnId: trace.turnId,
      ts: now(),
      message: `Task gate: ${trace.decision}`,
      data: {
        goalId: trace.goalId,
        decision: trace.decision,
        taskKeys: trace.taskKeys,
      },
    });
  }
}

function recentContext(messages: readonly StoredMessage[]): string {
  return messages
    .filter(
      (message): message is Extract<StoredMessage, { type: 'user' | 'assistant' }> =>
        message.type === 'user' || message.type === 'assistant',
    )
    .slice(-6)
    .map((message) => {
      const text = message.type === 'user' ? userFacingText(message) : message.text;
      return `[${message.type}]: ${truncateGoalText(text, GOAL_REASON_TEXT_LIMIT)}`;
    })
    .join('\n');
}

function tokenCount(messages: readonly StoredMessage[]): number {
  return messages.reduce((total, message) => {
    if (message.type !== 'token_usage') return total;
    return total + (message.total ?? message.input + message.output);
  }, 0);
}

function notFound(message: string) {
  return { ok: false as const, error: { code: 'not_found' as const, message } };
}

function sessionArchived(message: string) {
  return {
    ok: false as const,
    error: { code: 'session_archived' as const, message },
  };
}

function operationConflict(message: string) {
  return {
    ok: false as const,
    error: { code: 'operation_conflict' as const, message },
  };
}

function goalOutcomeFromCompletion(completion: HostedExecutionCompletion): GoalTurnOutcome {
  return completion.kind === 'terminal'
    ? goalTurnOutcomeFromHostedExecution(completion.snapshot)
    : {
        kind: 'errored',
        turnId: completion.execution.turnId,
        reason: completion.reason,
      };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
