import { randomUUID } from 'node:crypto';
import { userFacingText, type StoredMessage } from '@maka/core/session';
import {
  GoalContinuationCoordinator,
  GoalManager,
  GOAL_REASON_TEXT_LIMIT,
  TERMINAL_GOAL_STATUSES,
  buildGoalTools,
  truncateGoalText,
  type GoalEvaluatorResource,
  type GoalSessionCloseOperation,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalObservedTurnStart,
  type GoalState,
  type GoalTaskGateTrace,
  type GoalTurnAdmission,
  type MakaTool,
} from '@maka/runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { GoalControlInput, GoalProjection, OperationOutcome } from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { GoalOperationHandlerMap } from './operation-dispatcher.js';
import { projectGoalState } from './goal-projection.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

type GoalStores = Pick<ExecutionStoresWriter<'interactive'>, 'sessionStore' | 'agentRunStore'>;

export interface HostGoalCoordinatorOptions {
  readonly stores: GoalStores;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly evaluator: GoalEvaluatorResource;
  readonly admitTurn: (
    sessionId: string,
    text: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ) => GoalTurnAdmission;
  readonly listActionableTaskKeys: (sessionId: string) => Promise<string[]>;
  readonly acquireResidency: () => RuntimeHostResidency;
  readonly onProjectionChanged: (sessionId: string) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface HostGoalSessionRetirement {
  commit(): void;
  rollback(): void;
}

/** In-memory Runtime Host authority for one Goal generation per Session. */
export class HostGoalCoordinator {
  readonly handlers: GoalOperationHandlerMap = {
    'goal.query': (input) => this.#query(input.sessionId),
    'goal.control': (input) => this.#control(input),
  };

  readonly manager: GoalManager;
  readonly continuation: GoalContinuationCoordinator;
  readonly tools: readonly MakaTool[];
  readonly #stores: GoalStores;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #residencies = new Map<string, RuntimeHostResidency>();
  readonly #onProjectionChanged: (sessionId: string) => void;
  readonly #newId: () => string;
  #draining = false;

  constructor(options: HostGoalCoordinatorOptions) {
    this.#stores = options.stores;
    this.#sessionAdmission = options.sessionAdmission;
    this.#onProjectionChanged = options.onProjectionChanged;
    const now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
    this.manager = new GoalManager({
      generateId: this.#newId,
      now,
      onChange: (goal) => {
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
    });
    this.tools = Object.freeze(
      buildGoalTools({
        goalManager: this.manager,
        goalContinuation: this.continuation,
        getTokenCount: (sessionId) => tokenCache.get(sessionId) ?? 0,
        isAvailable: () => !this.#draining,
        now,
      }),
    );
  }

  readProjection(sessionId: string): GoalProjection | null {
    const goal = this.manager.get(sessionId);
    return goal ? projectGoalState(goal) : null;
  }

  beginObservedTurn(sessionId: string, turnId: string): GoalObservedTurnStart {
    return this.continuation.beginObservedTurn(sessionId, turnId);
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

  beginSessionRetirement(
    sessionIds: readonly string[],
    kind: 'archive' | 'remove',
  ): HostGoalSessionRetirement {
    const unique = [...new Set(sessionIds)];
    if (unique.some((sessionId) => this.hasLiveGoal(sessionId))) {
      throw new Error('Session retirement cannot revoke a live Goal');
    }
    const operations = new Map<string, GoalSessionCloseOperation>();
    for (const sessionId of unique) {
      operations.set(sessionId, this.continuation.beginSessionClose(sessionId, kind));
    }
    let settled = false;
    return Object.freeze({
      commit: () => {
        if (settled) return;
        settled = true;
        for (const sessionId of unique) {
          operations.get(sessionId)?.commit();
          this.manager.remove(sessionId);
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
    this.continuation.dispose();
    this.manager.dispose();
    for (const residency of this.#residencies.values()) residency.release();
    this.#residencies.clear();
  }

  close(): Promise<void> {
    this.beginDrain();
    return this.continuation.close();
  }

  #query(sessionId: string): Promise<OperationOutcome<'goal.query'>> {
    return this.#sessionAdmission.run(sessionId, async () => {
      try {
        await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) return notFound('Session does not exist');
        throw error;
      }
      return { ok: true, result: { sessionId, goal: this.readProjection(sessionId) } };
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
      return {
        ok: true,
        result: { sessionId: input.sessionId, goal: projectGoalState(changed) },
      };
    });
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
  return { ok: false as const, error: { code: 'session_archived' as const, message } };
}

function operationConflict(message: string) {
  return { ok: false as const, error: { code: 'operation_conflict' as const, message } };
}
