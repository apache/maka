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
 * Goal execution state for one Runtime Host epoch.
 *
 * A goal is a long-running objective the agent works toward autonomously across
 * turns. After each turn, an external evaluator (CC-style) judges whether the
 * condition is met; if not, the system auto-continues.
 *
 * The manager owns synchronous lifecycle transitions. Runtime Host owns the
 * durable Goal authority, restores it before serving, and persists every
 * accepted transition through `onChange`.
 *
 * Lifecycle (Codex-inspired):
 *   active → waiting → active
 *          → achieved / impossible / cleared / paused
 *          → stalled (block cap: N consecutive no-progress turns)
 *          → budget_limited (token budget exhausted)
 *          → max_iterations (total turn ceiling)
 */

import {
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_REASON_TEXT_LIMIT,
  sameGoalControlLease,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalState,
  type GoalStatus,
  type GoalTextLimit,
} from '@maka/core/goal';

export {
  GOAL_BLOCK_CAP_LIMIT,
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_MAX_ITERATIONS_LIMIT,
  GOAL_REASON_TEXT_LIMIT,
  GOAL_TOKEN_BUDGET_MINIMUM,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalState,
  type GoalStatus,
  type GoalTextLimit,
} from '@maka/core/goal';

/** Terminal statuses — a goal in one of these states will not continue. */
export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  'achieved',
  'impossible',
  'cleared',
  'stalled',
  'budget_limited',
  'max_iterations',
]);

export function goalCheckpoint(goal: Pick<GoalState, 'id' | 'revision'>): GoalCheckpoint {
  return Object.freeze({ goalId: goal.id, revision: goal.revision });
}

export type GoalCreateResult =
  | { kind: 'created'; goal: GoalState }
  | { kind: 'unfinished'; goal: GoalState };

interface GoalTurnSettlementBase {
  readonly checkpoint: GoalCheckpoint;
  readonly reason: string;
}

export type GoalTurnSettlementInput =
  | (GoalTurnSettlementBase & {
      readonly verdict: 'achieved';
    })
  | (GoalTurnSettlementBase & {
      readonly verdict: 'impossible';
    })
  | (GoalTurnSettlementBase &
      (
        | {
            readonly verdict: 'continue';
            readonly waiting: true;
            readonly madeProgress?: never;
            readonly tokensNow?: number;
          }
        | {
            readonly verdict: 'continue';
            readonly waiting?: false;
            /** Undefined is neutral: neither advances nor resets the no-progress streak. */
            readonly madeProgress?: boolean;
            readonly tokensNow?: number;
          }
      ));

export interface GoalManagerDeps {
  generateId: () => string;
  now: () => number;
  /**
   * Fired after every accepted goal state transition. Lets a host surface an
   * autonomous loop to the UI — a token-burning goal must never run without a
   * visible indicator and a clear affordance. This is a best-effort observer:
   * failures cannot roll back an already committed state transition.
   */
  onChange?: (goal: GoalState, controlLease: GoalControlLease, previous?: GoalStatus) => void;
}

export const DEFAULT_MAX_ITERATIONS = 50;
export const DEFAULT_BLOCK_CAP = 8;

export function isGoalTextWithinLimit(value: string, limit: GoalTextLimit): boolean {
  return value.length <= limit.codeUnits && Buffer.byteLength(value, 'utf8') <= limit.utf8Bytes;
}

export function truncateGoalText(value: string, limit: GoalTextLimit): string {
  if (isGoalTextWithinLimit(value, limit)) return value;
  let result = '';
  let codeUnits = 0;
  let utf8Bytes = 0;
  for (const character of value) {
    const nextCodeUnits = character.length;
    const nextUtf8Bytes = Buffer.byteLength(character, 'utf8');
    if (
      codeUnits + nextCodeUnits > limit.codeUnits ||
      utf8Bytes + nextUtf8Bytes > limit.utf8Bytes
    ) {
      break;
    }
    result += character;
    codeUnits += nextCodeUnits;
    utf8Bytes += nextUtf8Bytes;
  }
  return result;
}

interface GoalRecord {
  state: GoalState;
  controlLease: GoalControlLease;
}

export interface GoalPauseOptions {
  readonly checkpoint?: GoalCheckpoint;
  readonly reason?: string;
}

type GoalStatePatch = Partial<
  Omit<GoalState, 'id' | 'revision' | 'sessionId' | 'condition' | 'setAt'>
>;

export class GoalManager {
  private goals = new Map<string, GoalRecord>();
  private disposed = false;

  constructor(private readonly deps: GoalManagerDeps) {}

  private emit(record: GoalRecord, previous?: GoalStatus): void {
    try {
      this.deps.onChange?.(record.state, record.controlLease, previous);
    } catch {
      // State and control leases are already committed. A host notification
      // must not make the caller observe failure after that point.
    }
  }

  private commit(
    record: GoalRecord,
    patch: GoalStatePatch,
    options?: { renewControlLease?: boolean },
  ): GoalState {
    const previous = record.state.status;
    const boundedPatch =
      patch.lastReason === undefined
        ? patch
        : { ...patch, lastReason: truncateGoalText(patch.lastReason, GOAL_REASON_TEXT_LIMIT) };
    const committed = Object.freeze({
      ...record.state,
      ...boundedPatch,
      revision: record.state.revision + 1,
    });
    record.state = committed;
    if (options?.renewControlLease) {
      record.controlLease = createControlLease(committed.id, record.controlLease.generation + 1);
    }
    this.emit(record, previous);
    return committed;
  }

  create(
    sessionId: string,
    condition: string,
    opts?: {
      maxIterations?: number;
      blockCap?: number;
      tokenBudget?: number;
      /**
       * Whether this Goal is being armed from outside a Turn rather than set
       * by the model inside one. Recorded on the Goal because nothing else
       * survives a restart to say which of the two it was.
       */
      armed?: boolean;
    },
  ): GoalCreateResult {
    // A disposed manager has no Goals, which is not the same as being able to
    // start one. Reads after disposal answer honestly by finding nothing;
    // this is the only entry that would answer by conjuring a Goal into a
    // composition that is already shutting down, so it refuses instead of
    // repopulating the map its owner just emptied.
    if (this.disposed) throw new Error('Goal manager is disposed');
    // Every caller reaches the Goal through here, so the stored condition is
    // trimmed once here rather than by each caller in its own way.
    const trimmed = condition.trim();
    if (!trimmed || !isGoalTextWithinLimit(trimmed, GOAL_CONDITION_TEXT_LIMIT)) {
      throw new RangeError('Goal condition exceeds its shared text limit');
    }
    const existing = this.goals.get(sessionId)?.state;
    if (existing && !TERMINAL_GOAL_STATUSES.has(existing.status)) {
      return { kind: 'unfinished', goal: existing };
    }

    // The token baseline is not knowable here. `GoalSet` runs inside a Turn
    // whose own spend predates the Goal, and `goal.arm` runs outside every
    // Turn, so neither caller can name the count the budget should measure
    // from. Both start at zero and `settleTurn` writes the real baseline when
    // the first Turn carrying the Goal settles: the budget bounds what the
    // Goal goes on to drive, not the Turn it was born beside.
    const setAt = this.deps.now();
    const goal: GoalState = Object.freeze({
      id: this.deps.generateId(),
      revision: 0,
      sessionId,
      condition: trimmed,
      status: 'active',
      setAt,
      ...(opts?.armed ? { armedAt: setAt } : {}),
      iterations: 0,
      maxIterations: opts?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      consecutiveNoProgress: 0,
      blockCap: opts?.blockCap ?? DEFAULT_BLOCK_CAP,
      tokenBudget: opts?.tokenBudget,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
    });
    const goalRecord: GoalRecord = {
      state: goal,
      controlLease: createControlLease(goal.id),
    };
    this.goals.set(sessionId, goalRecord);
    this.emit(goalRecord);
    return { kind: 'created', goal };
  }

  get(sessionId: string): GoalState | undefined {
    return this.goals.get(sessionId)?.state;
  }

  getActive(sessionId: string): GoalState | undefined {
    const goal = this.goals.get(sessionId)?.state;
    return goal?.status === 'active' ? goal : undefined;
  }

  getControlLease(sessionId: string): GoalControlLease | undefined {
    return this.goals.get(sessionId)?.controlLease;
  }

  restore(goal: GoalState, controlLease: GoalControlLease): void {
    if (goal.sessionId.length === 0 || goal.id !== controlLease.goalId) {
      throw new Error('Durable Goal identity is invalid');
    }
    if (this.goals.has(goal.sessionId)) {
      throw new Error(`Session ${goal.sessionId} already has a restored Goal`);
    }
    this.goals.set(goal.sessionId, {
      state: Object.freeze({ ...goal }),
      controlLease: Object.freeze({ ...controlLease }),
    });
  }

  matchesControlLease(sessionId: string, lease: GoalControlLease): boolean {
    return sameGoalControlLease(this.goals.get(sessionId)?.controlLease, lease);
  }

  matchesActive(sessionId: string, checkpoint: GoalCheckpoint): boolean {
    const goal = this.goals.get(sessionId)?.state;
    return (
      goal?.status === 'active' &&
      goal.id === checkpoint.goalId &&
      goal.revision === checkpoint.revision
    );
  }

  matches(sessionId: string, checkpoint: GoalCheckpoint): boolean {
    const goal = this.goals.get(sessionId)?.state;
    return goal?.id === checkpoint.goalId && goal.revision === checkpoint.revision;
  }

  tokensSpent(sessionId: string): number {
    const goal = this.goals.get(sessionId)?.state;
    if (!goal) return 0;
    return Math.max(0, goal.tokensNow - goal.tokensAtStart);
  }

  settleTurn(sessionId: string, input: GoalTurnSettlementInput): GoalState | undefined {
    const record = this.goals.get(sessionId);
    if (!record) return undefined;
    const current = record.state;
    if (current.id !== input.checkpoint.goalId) return undefined;
    if (current.revision !== input.checkpoint.revision) return undefined;
    if (current.status !== 'active') return undefined;

    let patch: GoalStatePatch;
    if (input.verdict === 'achieved') {
      patch = {
        status: 'achieved',
        lastReason: input.reason,
        achievedAt: this.deps.now(),
      };
    } else if (input.verdict === 'impossible') {
      patch = { status: 'impossible', lastReason: input.reason };
    } else {
      let tokensAtStart = current.tokensAtStart;
      let tokensNow = current.tokensNow;
      let tokensBaselinePending = current.tokensBaselinePending;
      let iterations = current.iterations;
      let consecutiveNoProgress = current.consecutiveNoProgress;
      let status: GoalStatus = current.status;
      let lastReason = input.reason;

      if (input.tokensNow !== undefined) {
        if (tokensBaselinePending) {
          tokensAtStart = input.tokensNow;
          tokensNow = input.tokensNow;
          tokensBaselinePending = false;
        } else {
          tokensNow = Math.max(tokensNow, input.tokensNow);
          if (
            current.tokenBudget !== undefined &&
            tokensNow - tokensAtStart >= current.tokenBudget
          ) {
            status = 'budget_limited';
            lastReason = `Token budget exhausted (${current.tokenBudget} tokens)`;
          }
        }
      }

      if (status === 'active') {
        iterations++;
        if (iterations >= current.maxIterations) {
          status = 'max_iterations';
          lastReason = `Reached maximum iterations (${current.maxIterations})`;
        }
      }

      if (status === 'active' && input.madeProgress !== undefined) {
        if (input.madeProgress) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
          if (consecutiveNoProgress >= current.blockCap) {
            status = 'stalled';
            lastReason = `No progress for ${current.blockCap} consecutive turns`;
          }
        }
      }

      if (status === 'active' && input.waiting === true) {
        status = 'waiting';
      }

      patch = {
        status,
        iterations,
        consecutiveNoProgress,
        tokensAtStart,
        tokensNow,
        tokensBaselinePending,
        lastReason,
        // A Turn carried this Goal all the way into a continuation, so
        // whatever it was armed to wait for has happened.
        armedAt: undefined,
      };
    }

    return this.commit(record, patch);
  }

  pause(sessionId: string, options?: GoalPauseOptions): GoalState | undefined {
    const record = this.goals.get(sessionId);
    if (!record || (record.state.status !== 'active' && record.state.status !== 'waiting')) {
      return undefined;
    }
    if (options?.checkpoint && !this.matches(sessionId, options.checkpoint)) return undefined;
    return this.commit(
      record,
      {
        status: 'paused',
        pausedAt: this.deps.now(),
        ...(options?.reason !== undefined ? { lastReason: options.reason } : {}),
      },
      { renewControlLease: true },
    );
  }

  resume(sessionId: string, checkpoint?: GoalCheckpoint): GoalState | undefined {
    const record = this.goals.get(sessionId);
    if (!record || record.state.status !== 'paused') return undefined;
    if (checkpoint && !this.matches(sessionId, checkpoint)) return undefined;
    return this.commit(
      record,
      // Resume is a request for continuation, not a return to whatever the
      // Goal was doing before. A Goal armed and never carried has been waiting
      // for a Turn to take hold of it; this is one.
      { status: 'active', pausedAt: undefined, armedAt: undefined },
      { renewControlLease: true },
    );
  }

  wakeWaiting(sessionId: string, checkpoint: GoalCheckpoint): GoalState | undefined {
    const record = this.goals.get(sessionId);
    if (!record || record.state.status !== 'waiting' || !this.matches(sessionId, checkpoint)) {
      return undefined;
    }
    return this.commit(record, { status: 'active' });
  }

  clear(sessionId: string): GoalState | undefined {
    const record = this.goals.get(sessionId);
    if (!record || TERMINAL_GOAL_STATUSES.has(record.state.status)) return undefined;
    return this.commit(record, { status: 'cleared' }, { renewControlLease: true });
  }

  remove(sessionId: string): boolean {
    return this.goals.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.goals.clear();
  }
}

function createControlLease(goalId: string, generation = 0): GoalControlLease {
  return Object.freeze({ goalId, generation });
}
