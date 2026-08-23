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
 * Session-scoped Goal continuation coordinator.
 *
 * Agent turn outcomes are settled in FIFO order per session. A continuation is
 * retained as an intent until the host atomically admits it; waiting verdicts use
 * an in-memory backoff instead of immediately spending another turn.
 */

import {
  evaluateGoal,
  type GoalEvaluation,
  type GoalEvaluatorDeps,
  type GoalEvaluatorResource,
} from './goal-evaluator.js';
import {
  goalCheckpoint,
  type GoalControlLease,
  type GoalCheckpoint,
  type GoalManager,
  type GoalState,
} from './goal-state.js';
import {
  GoalSessionCloseFence,
  type GoalSessionCloseKind,
  type GoalSessionCloseOperation,
} from './goal-session-close-fence.js';
import { GoalTaskGatePolicy, type GoalTaskGateDeps } from './goal-task-gate-policy.js';
import type { GoalTurnOutcome } from './goal-turn-lifecycle.js';
import {
  isDrivingGoal,
  sameGoalControlLease,
  type GoalCurrentExecution,
  type GoalExecutionRef,
} from '@maka/core/goal';

export type { GoalTurnOutcome } from './goal-turn-lifecycle.js';
export type { GoalSessionCloseOperation } from './goal-session-close-fence.js';
export type {
  GoalTaskGateDecision,
  GoalTaskGateDeps,
  GoalTaskGateTrace,
} from './goal-task-gate-policy.js';

export type GoalTurnAdmission =
  | {
      kind: 'prepared';
      turnId: string;
      execution: GoalExecutionRef;
      /** Start the synchronously reserved turn after coordinator ownership is registered. */
      start: () => Promise<GoalTurnOutcome>;
    }
  | { kind: 'busy'; whenIdle: Promise<void> }
  | { kind: 'unavailable'; reason: string };

/** Exactly-once settlement capability captured when a non-Goal Agent turn starts. */
export type GoalObservedTurnSettler = (outcome: GoalTurnOutcome) => Promise<void>;

export interface GoalContinuationScheduler {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface GoalDurabilityPort {
  flush(sessionId: string): Promise<void>;
  recordCurrentExecution(current: GoalCurrentExecution): Promise<void>;
  settleCurrentExecution(sessionId: string, turnId: string): Promise<void>;
}

export const volatileGoalDurability: GoalDurabilityPort = Object.freeze({
  flush: async () => {},
  recordCurrentExecution: async () => {},
  settleCurrentExecution: async () => {},
});

export interface GoalContinuationDeps {
  goalManager: GoalManager;
  evaluator: GoalEvaluatorDeps & Partial<Pick<GoalEvaluatorResource, 'close'>>;
  /** Summarized recent conversation (last ~5 messages) for the evaluator. */
  getRecentContext: (sessionId: string) => Promise<string>;
  /** Current cumulative token count for the session (for budget tracking). */
  getTokenCount?: (sessionId: string) => number;
  durability: GoalDurabilityPort;
  /** Synchronously prepare, defer, or reject a Goal-owned turn. */
  admitTurn: (
    sessionId: string,
    text: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ) => GoalTurnAdmission;
  taskGate?: GoalTaskGateDeps;
  scheduler?: GoalContinuationScheduler;
}

export const GOAL_WAIT_BACKOFF_BASE_MS = 5_000;
export const GOAL_WAIT_BACKOFF_MAX_MS = 5 * 60_000;

const CONTINUATION_PREAMBLE =
  '[Goal continuation] The goal is not yet met. Keep working toward it. ' +
  'Do not redefine success around a smaller task; match your verification to the full requirement.';

interface QueuedTurn {
  turnId: string;
  outcome: GoalTurnOutcome;
  controlLease: GoalControlLease;
  checkpoint?: GoalCheckpoint;
  resolve: () => void;
}

interface ContinuationIntent {
  checkpoint: GoalCheckpoint;
  controlLease: GoalControlLease;
  triggeringTurnId?: string;
  evaluation: GoalEvaluation;
}

interface WaitingTimer {
  handle: unknown;
}

interface TurnRegistration {
  readonly turnId: string;
  readonly lane: SessionLane;
  observedControlLease?: GoalControlLease;
  checkpoint?: GoalCheckpoint;
  controlLease?: GoalControlLease;
}

interface SessionLane {
  sessionId: string;
  queue: QueuedTurn[];
  turns: Map<string, TurnRegistration>;
  processing?: QueuedTurn;
  draining: boolean;
  intent?: ContinuationIntent;
  busyWake?: Promise<void>;
  waitingTimer?: WaitingTimer;
  evaluationAbort?: AbortController;
  consecutiveWaits: number;
}

export type GoalObservedTurnStart =
  | { kind: 'registered'; settle: GoalObservedTurnSettler }
  | { kind: 'unavailable'; reason: string };

/**
 * Why a turn does not hold the right to change its session's goal.
 *
 * Only `goal_changed` describes a race. The rest are settled facts about this
 * turn that no later call within it can change, which is the distinction a
 * refusal has to carry: telling a caller to look again and retry is only honest
 * when looking again can produce a different answer.
 *
 * `goal_already_armed` is named for the common case, not the only one. A turn
 * holds a control lease either because it armed a goal or because
 * `beginObservedTurn` bound it to a goal that was already active — the second
 * turn armed nothing, so the refusal built from this must not say it did.
 */
export type GoalControlDecline =
  | /** This turn was never registered under a Goal boundary, or its registration is gone. */
  'turn_not_registered'
  | /** Goal continuation is shutting down. */ 'coordinator_disposed'
  | /** This turn already holds a goal control lease. */ 'goal_already_armed'
  | /** This turn started before the goal it is trying to change existed. */ 'goal_not_observed'
  | /** The goal generation this turn observed is no longer the current one. */ 'goal_changed';

export type GoalControlStanding =
  | { kind: 'held' }
  | { kind: 'declined'; reason: GoalControlDecline };

function declined(reason: GoalControlDecline): GoalControlStanding {
  return { kind: 'declined', reason };
}

export class GoalContinuationCoordinator {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly activeDrains = new Set<Promise<void>>();
  private readonly sessionCloseFence: GoalSessionCloseFence;
  private readonly taskGatePolicy: GoalTaskGatePolicy;
  private readonly scheduler: GoalContinuationScheduler;
  private disposed = false;
  private closeTask?: Promise<void>;

  constructor(private readonly deps: GoalContinuationDeps) {
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.taskGatePolicy = new GoalTaskGatePolicy(deps.taskGate);
    this.sessionCloseFence = new GoalSessionCloseFence({
      onReopenedAfterRollback: (sessionId, kind) => {
        const goal = this.deps.goalManager.get(sessionId);
        if (!goal || (goal.status !== 'active' && goal.status !== 'waiting')) return;
        const operation = kind === 'archive' ? 'archive' : 'removal';
        this.deps.goalManager.pause(sessionId, {
          checkpoint: goalCheckpoint(goal),
          reason: `Goal continuation paused because session ${operation} did not complete.`,
        });
      },
    });
  }

  /**
   * Register a non-Goal Agent turn before its iterator starts. The returned
   * closure is the only legal settlement path, so terminal handling never has
   * to rediscover Goal ownership from mutable current state.
   */
  beginObservedTurn(sessionId: string, turnId: string): GoalObservedTurnStart {
    if (this.disposed) {
      return { kind: 'unavailable', reason: 'Goal continuation is disposed.' };
    }
    if (this.sessionCloseFence.isClosed(sessionId)) {
      return { kind: 'unavailable', reason: 'Goal continuation session is closed.' };
    }
    const lane = this.laneFor(sessionId);
    if (lane.turns.has(turnId)) {
      return { kind: 'unavailable', reason: `Goal turn ${turnId} is already registered.` };
    }
    const goal = this.deps.goalManager.get(sessionId);
    const observedControlLease = this.deps.goalManager.getControlLease(sessionId);
    const controlLease =
      goal?.status === 'active' || goal?.status === 'waiting' ? observedControlLease : undefined;
    const registration: TurnRegistration = {
      turnId,
      lane,
      ...(observedControlLease ? { observedControlLease } : {}),
      ...(controlLease ? { controlLease } : {}),
    };
    lane.turns.set(turnId, registration);

    return {
      kind: 'registered',
      settle: (outcome) => this.settleRegisteredTurn(registration, outcome),
    };
  }

  /**
   * Why this turn may not arm a Goal, or that it may.
   *
   * Split out because the refusal a model reads has to name a cause. Every
   * check below used to collapse into one `undefined`, and the sentence built
   * from it asserted the one cause that is recoverable — a concurrent change —
   * and told the caller to look and try again. For the other causes there is
   * nothing to look at: the turn is not registered, or a later turn owns the
   * lane, and no amount of re-reading changes that within this turn.
   *
   * Shutdown has to be asked about before the lane lookup, not after it.
   * `dispose()` sets the flag and clears `lanes` in the same synchronous step,
   * so a shut-down coordinator answers every `lanes.get` with `undefined`; an
   * `isCurrent` check placed below that lookup can only ever see a lane that is
   * still in the map, which makes its second clause trivially true and its
   * first one unreachable. The refusal built from the earlier answer then told
   * a turn that really had been registered under the Goal boundary that it
   * never was.
   */
  activationStanding(sessionId: string, turnId: string): GoalControlStanding {
    if (this.disposed) return declined('coordinator_disposed');
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    if (!lane || !registration) return declined('turn_not_registered');
    if (registration.controlLease !== undefined) return declined('goal_already_armed');
    if (
      !sameGoalControlLease(
        this.deps.goalManager.getControlLease(sessionId),
        registration.observedControlLease,
      )
    ) {
      return declined('goal_changed');
    }
    return { kind: 'held' };
  }

  /** The same question for a mutation of the generation this turn observed. */
  mutationStanding(sessionId: string, turnId: string): GoalControlStanding {
    if (this.disposed) return declined('coordinator_disposed');
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    if (!lane || !registration) return declined('turn_not_registered');
    const controlLease = registration.controlLease ?? registration.observedControlLease;
    if (!controlLease) return declined('goal_not_observed');
    if (!this.deps.goalManager.matchesControlLease(sessionId, controlLease)) {
      return declined('goal_changed');
    }
    return { kind: 'held' };
  }

  /** Execute and bind one Goal activation only while this exact turn owns the right to do so. */
  activateGoal(
    sessionId: string,
    turnId: string,
    activate: () => GoalState,
  ): GoalState | undefined {
    if (this.activationStanding(sessionId, turnId).kind !== 'held') return undefined;
    const registration = this.lanes.get(sessionId)?.turns.get(turnId);
    if (!registration) return undefined;
    const goal = activate();
    registration.controlLease = this.deps.goalManager.getControlLease(sessionId);
    if (registration.checkpoint) registration.checkpoint = goalCheckpoint(goal);
    return goal;
  }

  /** Mutate the exact Goal generation observed by this turn. */
  mutateGoal(sessionId: string, turnId: string, mutate: () => GoalState): GoalState | undefined {
    if (this.mutationStanding(sessionId, turnId).kind !== 'held') return undefined;
    const lane = this.lanes.get(sessionId);
    const registration = lane?.turns.get(turnId);
    const controlLease = registration?.controlLease ?? registration?.observedControlLease;
    if (!lane || !registration || !controlLease) return undefined;

    const goal = mutate();
    this.abortEvaluation(lane, 'Goal lifecycle changed during evaluation');
    this.discardIntentOwnedBy(lane, controlLease);
    registration.observedControlLease = this.deps.goalManager.getControlLease(sessionId);
    registration.controlLease = undefined;
    return goal;
  }

  private settleRegisteredTurn(
    registration: TurnRegistration,
    outcome: GoalTurnOutcome,
  ): Promise<void> {
    const { lane, turnId } = registration;
    const sessionId = lane.sessionId;
    if (!this.isCurrent(lane) || lane.turns.get(turnId) !== registration) {
      return this.settleDiscardedRegistration(registration);
    }
    const controlLease = registration.controlLease;
    const goal = this.deps.goalManager.get(sessionId);
    if (
      !controlLease ||
      !this.deps.goalManager.matchesControlLease(sessionId, controlLease) ||
      !goal ||
      (goal.status !== 'active' && goal.status !== 'waiting')
    ) {
      this.discardIntentOwnedBy(lane, controlLease);
      return this.settleDiscardedRegistration(registration);
    }
    if (
      registration.checkpoint &&
      !this.deps.goalManager.matchesActive(sessionId, registration.checkpoint)
    ) {
      return this.settleDiscardedRegistration(registration);
    }
    return this.enqueueTurn(outcome, controlLease, registration);
  }

  private settleDiscardedRegistration(registration: TurnRegistration): Promise<void> {
    this.consumeTurnRegistration(registration);
    return registration.checkpoint
      ? this.deps.durability.settleCurrentExecution(
          registration.lane.sessionId,
          registration.turnId,
        )
      : Promise.resolve();
  }

  /** Revoke the current lane while allowing later turns in the same session. */
  invalidateSession(sessionId: string): void {
    const lane = this.lanes.get(sessionId);
    if (!lane) return;
    this.invalidateLane(lane);
    this.lanes.delete(sessionId);
  }

  /**
   * Fence admission synchronously before an archive/removal crosses an async
   * boundary. Each operation owns an independent holder, so one rollback can
   * never reopen a session still closed by another operation.
   */
  beginSessionClose(sessionId: string, kind: GoalSessionCloseKind): GoalSessionCloseOperation {
    const operation = this.sessionCloseFence.begin(sessionId, kind);
    this.invalidateSession(sessionId);
    return operation;
  }

  /** Clear only a committed archive fence; removal and pending holders remain. */
  unarchiveSession(sessionId: string): void {
    this.sessionCloseFence.unarchive(sessionId);
  }

  recoverCurrentExecution(current: GoalCurrentExecution): GoalObservedTurnStart {
    const { sessionId, turnId } = current.execution;
    if (this.disposed) {
      return { kind: 'unavailable', reason: 'Goal continuation is disposed.' };
    }
    if (
      !this.deps.goalManager.matchesActive(sessionId, current.checkpoint) ||
      !this.deps.goalManager.matchesControlLease(sessionId, current.controlLease)
    ) {
      return { kind: 'unavailable', reason: 'Durable Goal execution no longer owns the Goal.' };
    }
    const lane = this.laneFor(sessionId);
    if (lane.turns.has(turnId)) {
      return { kind: 'unavailable', reason: `Goal turn ${turnId} is already registered.` };
    }
    const registration: TurnRegistration = {
      turnId,
      lane,
      observedControlLease: current.controlLease,
      checkpoint: current.checkpoint,
      controlLease: current.controlLease,
    };
    lane.turns.set(turnId, registration);
    return {
      kind: 'registered',
      settle: (outcome) => this.settleRegisteredTurn(registration, outcome),
    };
  }

  /**
   * Put back the drive this Goal already has, and only that.
   *
   * Neither caller may start a loop the Goal is not in: a restart would
   * otherwise begin one for an armed Goal that `goal.arm` deliberately left
   * for the user's next Turn. Resume is not an exception to that rule but a
   * satisfier of it — resuming is the user asking for continuation, so the
   * Goal is already driving by the time it arrives here. Two callers must obey
   * this and a third would inherit it, so it is stated once here rather than
   * at each door.
   */
  private restoreDrive(
    lane: SessionLane,
    goal: GoalState,
    controlLease: GoalControlLease,
    evaluation: GoalEvaluation,
  ): void {
    if (!isDrivingGoal(goal)) return;
    lane.intent = { checkpoint: goalCheckpoint(goal), controlLease, evaluation };
    this.scheduleDrain(lane);
  }

  recoverActiveGoal(sessionId: string): void {
    if (this.disposed || this.sessionCloseFence.isClosed(sessionId)) return;
    const goal = this.deps.goalManager.get(sessionId);
    const controlLease = this.deps.goalManager.getControlLease(sessionId);
    if (!goal || !controlLease || (goal.status !== 'active' && goal.status !== 'waiting')) return;
    const lane = this.laneFor(sessionId);
    if (lane.intent || lane.turns.size > 0) return;
    this.restoreDrive(lane, goal, controlLease, {
      met: false,
      impossible: false,
      progress: false,
      waiting: goal.status === 'waiting',
      evaluatorFailed: true,
      reason: goal.lastReason ?? 'Goal continuation recovered after Host restart.',
    });
  }

  /** Resume an exact paused Goal generation from Host control without a model-owned Turn. */
  resumeFromControl(sessionId: string, checkpoint: GoalCheckpoint): GoalState | undefined {
    if (this.disposed || this.sessionCloseFence.isClosed(sessionId)) return undefined;
    const resumed = this.deps.goalManager.resume(sessionId, checkpoint);
    if (!resumed) return undefined;
    const controlLease = this.deps.goalManager.getControlLease(sessionId);
    if (!controlLease) return undefined;
    const lane = this.laneFor(sessionId);
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
    this.restoreDrive(lane, resumed, controlLease, {
      met: false,
      impossible: false,
      progress: false,
      waiting: false,
      evaluatorFailed: false,
      reason: 'Goal resumed by a connected client.',
    });
    return resumed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const lane of this.lanes.values()) this.invalidateLane(lane);
    this.lanes.clear();
    this.sessionCloseFence.dispose();
  }

  close(): Promise<void> {
    this.dispose();
    this.closeTask ??= Promise.all([
      ...this.activeDrains,
      Promise.resolve().then(() => this.deps.evaluator.close?.()),
    ]).then(() => undefined);
    return this.closeTask;
  }

  private enqueueTurn(
    outcome: GoalTurnOutcome,
    controlLease: GoalControlLease,
    registration: TurnRegistration,
  ): Promise<void> {
    const lane = registration.lane;
    // New evidence always outranks an older, not-yet-admitted continuation.
    lane.intent = undefined;
    this.clearWaitingTimer(lane);
    return new Promise<void>((resolve) => {
      lane.queue.push({
        turnId: registration.turnId,
        outcome,
        controlLease,
        ...(registration.checkpoint ? { checkpoint: registration.checkpoint } : {}),
        resolve,
      });
      this.consumeTurnRegistration(registration);
      this.scheduleDrain(lane);
    });
  }

  private laneFor(sessionId: string): SessionLane {
    const existing = this.lanes.get(sessionId);
    if (existing) return existing;
    const lane: SessionLane = {
      sessionId,
      queue: [],
      turns: new Map(),
      draining: false,
      consecutiveWaits: 0,
    };
    this.lanes.set(sessionId, lane);
    return lane;
  }

  private isCurrent(lane: SessionLane): boolean {
    return !this.disposed && this.lanes.get(lane.sessionId) === lane;
  }

  private consumeTurnRegistration(registration: TurnRegistration): void {
    const lane = registration.lane;
    const turnId = registration.turnId;
    if (lane.turns.get(turnId) === registration) {
      lane.turns.delete(turnId);
    }
    this.dropIdleLane(lane);
  }

  private dropIdleLane(lane: SessionLane): void {
    if (
      !this.isCurrent(lane) ||
      lane.turns.size > 0 ||
      lane.queue.length > 0 ||
      lane.draining ||
      lane.intent ||
      lane.busyWake ||
      lane.waitingTimer
    ) {
      return;
    }
    this.lanes.delete(lane.sessionId);
  }

  private discardIntentOwnedBy(
    lane: SessionLane,
    controlLease: GoalControlLease | undefined,
  ): void {
    if (!controlLease || !sameGoalControlLease(lane.intent?.controlLease, controlLease)) return;
    lane.intent = undefined;
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
  }

  private scheduleDrain(lane: SessionLane): void {
    if (!this.isCurrent(lane) || lane.draining) return;
    const task = this.drainLane(lane).catch((error) => {
      if (!this.isCurrent(lane)) return;
      this.pauseCurrentGoal(lane, `Goal continuation coordinator failed: ${errorMessage(error)}`);
    });
    this.activeDrains.add(task);
    void task.finally(() => this.activeDrains.delete(task));
  }

  private async drainLane(lane: SessionLane): Promise<void> {
    if (!this.isCurrent(lane) || lane.draining) return;
    lane.draining = true;
    try {
      while (this.isCurrent(lane) && lane.queue.length > 0) {
        const item = lane.queue.shift();
        if (!item) break;
        lane.processing = item;
        try {
          await this.processQueuedTurn(lane, item);
        } catch (error) {
          this.pauseCurrentGoal(
            lane,
            `Goal continuation coordinator failed: ${errorMessage(error)}`,
          );
        } finally {
          if (lane.processing === item) lane.processing = undefined;
        }
        await this.deps.durability.flush(lane.sessionId);
        if (item.checkpoint) {
          await this.deps.durability.settleCurrentExecution(lane.sessionId, item.turnId);
        }
        item.resolve();
      }

      if (!this.isCurrent(lane) || lane.queue.length > 0) return;
      const goal = this.deps.goalManager.get(lane.sessionId);
      if (goal?.status === 'waiting' && lane.intent) {
        this.scheduleWaitingRetry(lane, goal);
      } else if (goal?.status === 'active' && lane.intent && !lane.busyWake) {
        await this.tryAdmitIntent(lane, lane.intent);
      }
    } finally {
      lane.draining = false;
      if (!this.isCurrent(lane)) return;
      const goal = this.deps.goalManager.get(lane.sessionId);
      if (
        lane.queue.length > 0 ||
        (lane.intent && goal?.status === 'active' && !lane.busyWake && !lane.waitingTimer)
      ) {
        this.scheduleDrain(lane);
      } else {
        this.dropIdleLane(lane);
      }
    }
  }

  private async processQueuedTurn(lane: SessionLane, item: QueuedTurn): Promise<void> {
    if (!this.deps.goalManager.matchesControlLease(lane.sessionId, item.controlLease)) {
      return;
    }
    const goal = this.deps.goalManager.get(lane.sessionId)!;
    if (item.checkpoint && !this.deps.goalManager.matchesActive(lane.sessionId, item.checkpoint)) {
      return;
    }
    if (item.outcome.kind !== 'completed') {
      if (goal.status !== 'active' && goal.status !== 'waiting') return;
      this.pauseAtCheckpoint(
        lane,
        item.checkpoint ?? goalCheckpoint(goal),
        turnFailureReason(item.outcome),
      );
      return;
    }
    await this.processCompletion(lane, item.controlLease, goal, item.turnId);
  }

  private async processCompletion(
    lane: SessionLane,
    controlLease: GoalControlLease,
    initialGoal: GoalState,
    turnId: string,
  ): Promise<void> {
    let goal = initialGoal;
    if (goal.status === 'waiting') {
      const woken = this.deps.goalManager.wakeWaiting(lane.sessionId, goalCheckpoint(goal));
      if (!woken) return;
      goal = woken;
    }
    if (goal.status !== 'active') return;

    const checkpoint = goalCheckpoint(goal);
    let context: string;
    try {
      context = await this.deps.getRecentContext(lane.sessionId);
    } catch (error) {
      this.pauseAtCheckpoint(
        lane,
        checkpoint,
        `Unable to read Goal evaluation context: ${errorMessage(error)}`,
      );
      return;
    }
    if (!this.isCurrent(lane) || !this.deps.goalManager.matchesActive(lane.sessionId, checkpoint)) {
      return;
    }

    const evaluationAbort = new AbortController();
    lane.evaluationAbort = evaluationAbort;
    let evaluation: GoalEvaluation;
    try {
      evaluation = await evaluateGoal(
        this.deps.evaluator,
        goal.condition,
        context,
        lane.sessionId,
        evaluationAbort.signal,
      );
    } finally {
      if (lane.evaluationAbort === evaluationAbort) lane.evaluationAbort = undefined;
    }
    if (!this.isCurrent(lane) || !this.deps.goalManager.matchesActive(lane.sessionId, checkpoint)) {
      return;
    }

    const tokensNow = this.deps.getTokenCount?.(lane.sessionId);

    const settlementBase = {
      checkpoint,
      reason: evaluation.reason,
    };
    let settled: GoalState | undefined;
    if (evaluation.met || evaluation.impossible) {
      settled = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: evaluation.met ? 'achieved' : 'impossible',
      });
    } else if (evaluation.waiting) {
      settled = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: 'continue',
        waiting: true,
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    } else {
      settled = this.deps.goalManager.settleTurn(lane.sessionId, {
        ...settlementBase,
        verdict: 'continue',
        ...(!evaluation.evaluatorFailed ? { madeProgress: evaluation.progress } : {}),
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    }
    if (!settled) return;
    if (settled.status === 'achieved' || settled.status === 'impossible') {
      lane.intent = undefined;
      this.resetWaitingBackoff(lane);
      this.taskGatePolicy.record({
        sessionId: lane.sessionId,
        turnId,
        goalId: goal.id,
        decision: 'evaluator_terminal',
        taskKeys: [],
      });
      return;
    }
    if (settled.status !== 'active' && settled.status !== 'waiting') {
      lane.intent = undefined;
      this.resetWaitingBackoff(lane);
      const taskKeys = await this.taskGatePolicy.listActionable(lane.sessionId);
      this.taskGatePolicy.record({
        sessionId: lane.sessionId,
        turnId,
        goalId: goal.id,
        decision: 'goal_stopped',
        taskKeys,
      });
      return;
    }

    lane.intent = {
      checkpoint: goalCheckpoint(settled),
      controlLease,
      triggeringTurnId: turnId,
      evaluation,
    };
    if (settled.status === 'waiting') {
      lane.consecutiveWaits++;
      return;
    }
    this.resetWaitingBackoff(lane);
  }

  private async tryAdmitIntent(lane: SessionLane, intent: ContinuationIntent): Promise<void> {
    if (!this.isCurrent(lane) || lane.queue.length > 0 || lane.intent !== intent) {
      return;
    }
    if (!this.ownedGoal(lane, intent)) {
      lane.intent = undefined;
      return;
    }

    const taskPlan = await this.taskGatePolicy.planAdmission(
      lane.sessionId,
      intent.checkpoint.goalId,
    );
    if (!this.isCurrent(lane) || lane.queue.length > 0 || lane.intent !== intent) {
      return;
    }
    const goal = this.ownedGoal(lane, intent);
    if (!goal) {
      lane.intent = undefined;
      return;
    }

    const prompt = buildContinuationPrompt(goal, intent.evaluation, taskPlan.reminder);
    const admission = this.deps.admitTurn(
      lane.sessionId,
      prompt,
      intent.checkpoint,
      intent.controlLease,
    );

    if (admission.kind === 'busy') {
      this.watchBusyLane(lane, admission.whenIdle);
      return;
    }
    if (admission.kind === 'unavailable') {
      this.pauseAtCheckpoint(lane, intent.checkpoint, admission.reason);
      await this.deps.durability.flush(lane.sessionId);
      return;
    }

    const registration: TurnRegistration = {
      turnId: admission.turnId,
      lane,
      observedControlLease: intent.controlLease,
      checkpoint: intent.checkpoint,
      controlLease: intent.controlLease,
    };
    lane.turns.set(admission.turnId, registration);

    await this.deps.durability.recordCurrentExecution({
      execution: admission.execution,
      checkpoint: intent.checkpoint,
      controlLease: intent.controlLease,
    });

    let completion: Promise<GoalTurnOutcome>;
    try {
      completion = admission.start();
    } catch (error) {
      void this.settleRegisteredTurn(registration, {
        kind: 'errored',
        turnId: admission.turnId,
        reason: errorMessage(error),
      }).catch(() => undefined);
      return;
    }
    void completion.then(
      (outcome) => {
        void this.settleRegisteredTurn(registration, outcome).catch(() => undefined);
      },
      (error) => {
        void this.settleRegisteredTurn(registration, {
          kind: 'errored',
          turnId: admission.turnId,
          reason: errorMessage(error),
        }).catch(() => undefined);
      },
    );

    lane.intent = undefined;
    this.taskGatePolicy.markStarted(intent.checkpoint.goalId, taskPlan);
    if (intent.triggeringTurnId) {
      this.taskGatePolicy.record({
        sessionId: lane.sessionId,
        turnId: intent.triggeringTurnId,
        goalId: intent.checkpoint.goalId,
        decision: taskPlan.decision,
        taskKeys: taskPlan.taskKeys,
      });
    }
  }

  private watchBusyLane(lane: SessionLane, whenIdle: Promise<void>): void {
    if (!this.isCurrent(lane) || lane.busyWake === whenIdle) return;
    lane.busyWake = whenIdle;
    const wake = () => {
      if (!this.isCurrent(lane) || lane.busyWake !== whenIdle) return;
      lane.busyWake = undefined;
      this.scheduleDrain(lane);
    };
    void whenIdle.then(wake);
  }

  private ownedGoal(lane: SessionLane, intent: ContinuationIntent): GoalState | undefined {
    if (
      !this.deps.goalManager.matchesControlLease(lane.sessionId, intent.controlLease) ||
      !this.deps.goalManager.matchesActive(lane.sessionId, intent.checkpoint)
    ) {
      return undefined;
    }
    return this.deps.goalManager.get(lane.sessionId);
  }

  private scheduleWaitingRetry(lane: SessionLane, goal: GoalState): void {
    if (!this.isCurrent(lane) || lane.waitingTimer || !lane.intent) return;
    if (!this.deps.goalManager.matches(lane.sessionId, lane.intent.checkpoint)) {
      lane.intent = undefined;
      this.resetWaitingBackoff(lane);
      return;
    }
    const checkpoint = goalCheckpoint(goal);
    const delayMs = waitBackoffMs(lane.consecutiveWaits);
    const handle = this.scheduler.setTimeout(() => {
      lane.waitingTimer = undefined;
      if (!this.isCurrent(lane)) return;
      if (lane.queue.length > 0) {
        this.scheduleDrain(lane);
        return;
      }
      const woken = this.deps.goalManager.wakeWaiting(lane.sessionId, checkpoint);
      if (!woken || !lane.intent) return;
      lane.intent = { ...lane.intent, checkpoint: goalCheckpoint(woken) };
      void this.deps.durability
        .flush(lane.sessionId)
        .then(() => this.scheduleDrain(lane))
        .catch(() => undefined);
    }, delayMs);
    lane.waitingTimer = { handle };
  }

  private pauseCurrentGoal(lane: SessionLane, reason: string): void {
    const current = this.deps.goalManager.get(lane.sessionId);
    if (!current || (current.status !== 'active' && current.status !== 'waiting')) {
      return;
    }
    this.pauseAtCheckpoint(lane, goalCheckpoint(current), reason);
  }

  private pauseAtCheckpoint(lane: SessionLane, checkpoint: GoalCheckpoint, reason: string): void {
    const paused = this.deps.goalManager.pause(lane.sessionId, { checkpoint, reason });
    if (!paused) return;
    lane.intent = undefined;
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    this.resetWaitingBackoff(lane);
  }

  private clearWaitingTimer(lane: SessionLane): void {
    const timer = lane.waitingTimer;
    if (!timer) return;
    lane.waitingTimer = undefined;
    this.scheduler.clearTimeout(timer.handle);
  }

  private resetWaitingBackoff(lane: SessionLane): void {
    lane.consecutiveWaits = 0;
  }

  private invalidateLane(lane: SessionLane): void {
    this.abortEvaluation(lane, 'Goal continuation lane was invalidated');
    lane.intent = undefined;
    lane.busyWake = undefined;
    this.clearWaitingTimer(lane);
    for (const registration of [...lane.turns.values()]) {
      this.consumeTurnRegistration(registration);
    }
    lane.processing?.resolve();
    for (const item of lane.queue.splice(0)) {
      item.resolve();
    }
  }

  private abortEvaluation(lane: SessionLane, reason: string): void {
    lane.evaluationAbort?.abort(new Error(reason));
    lane.evaluationAbort = undefined;
  }
}

function buildContinuationPrompt(
  goal: GoalState,
  evaluation: GoalEvaluation,
  taskReminder: string | undefined,
): string {
  const noProgress =
    goal.consecutiveNoProgress > 0
      ? `, ${goal.consecutiveNoProgress}/${goal.blockCap} no-progress`
      : '';
  return (
    `${CONTINUATION_PREAMBLE}${taskReminder ? `\n\n${taskReminder}` : ''}` +
    `\n\nEvaluation: ${evaluation.reason}${evaluation.waiting ? ' (scheduled external-event re-check)' : ''}\n` +
    `Goal: "${goal.condition}" (turn ${goal.iterations}/${goal.maxIterations}${noProgress})`
  );
}

function waitBackoffMs(consecutiveWaits: number): number {
  return Math.min(
    GOAL_WAIT_BACKOFF_MAX_MS,
    GOAL_WAIT_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveWaits - 1),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnFailureReason(outcome: Exclude<GoalTurnOutcome, { kind: 'completed' }>): string {
  if (outcome.kind === 'aborted') return 'Goal-associated turn was aborted.';
  if (outcome.kind === 'suspended') return `Goal-associated turn suspended: ${outcome.reason}`;
  return `Goal-associated turn failed: ${outcome.reason}`;
}

const defaultScheduler: GoalContinuationScheduler = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
