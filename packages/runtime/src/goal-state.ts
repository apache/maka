/**
 * Goal execution state — session-scoped, in-memory.
 *
 * A goal is a long-running objective the agent works toward autonomously across
 * turns. After each turn, an external evaluator (CC-style) judges whether the
 * condition is met; if not, the system auto-continues.
 *
 * PERSISTENCE: this phase owns only in-process state. A restart clears every
 * Goal; persisted snapshots and restart recovery require a separate lifecycle
 * boundary and are deliberately deferred.
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
  type GoalStatus,
  type GoalTextLimit,
} from '@maka/core/goal';

export {
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_REASON_TEXT_LIMIT,
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

export interface GoalState {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly condition: string;
  readonly status: GoalStatus;
  readonly setAt: number;
  readonly iterations: number;
  readonly maxIterations: number;
  /** Consecutive turns with no progress (drives the block cap → stalled). */
  readonly consecutiveNoProgress: number;
  /** Force-stop after this many consecutive no-progress turns (CC's 8). */
  readonly blockCap: number;
  /**
   * Optional working-turn token budget; goal → budget_limited when exceeded.
   * Evaluator calls are usage-metered separately and do not spend this budget.
   */
  readonly tokenBudget?: number;
  /** Token count observed when the goal was set (baseline for spend). */
  readonly tokensAtStart: number;
  /** Latest observed token count (used to compute spend). */
  readonly tokensNow: number;
  /**
   * True until the first real token observation. The baseline captured at set
   * time can be stale/0 (the model calls GoalSet before any continuation has
   * observed the session's token count), so the first settlement re-baselines
   * to measure only tokens the goal itself spends.
   */
  readonly tokensBaselinePending: boolean;
  readonly lastReason?: string;
  readonly achievedAt?: number;
  readonly pausedAt?: number;
}

/** Immutable identity of the Goal snapshot an asynchronous operation observed. */
export interface GoalCheckpoint {
  readonly goalId: string;
  readonly revision: number;
}

/**
 * Opaque in-process ownership token for externally queued Goal evidence.
 * Ordinary turn settlements retain the lease; explicit lifecycle control
 * replaces it so queued work cannot cross a pause/resume ABA boundary.
 */
export interface GoalControlLease {
  readonly goalId: string;
}

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
  onChange?: (goal: GoalState, previous?: GoalStatus) => void;
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

  constructor(private readonly deps: GoalManagerDeps) {}

  private emit(goal: GoalState, previous?: GoalStatus): void {
    try {
      this.deps.onChange?.(goal, previous);
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
      record.controlLease = createControlLease(committed.id);
    }
    this.emit(committed, previous);
    return committed;
  }

  create(
    sessionId: string,
    condition: string,
    opts?: {
      maxIterations?: number;
      blockCap?: number;
      tokenBudget?: number;
      tokensAtStart?: number;
    },
  ): GoalCreateResult {
    if (!condition.trim() || !isGoalTextWithinLimit(condition, GOAL_CONDITION_TEXT_LIMIT)) {
      throw new RangeError('Goal condition exceeds its shared text limit');
    }
    const existing = this.goals.get(sessionId)?.state;
    if (existing && !TERMINAL_GOAL_STATUSES.has(existing.status)) {
      return { kind: 'unfinished', goal: existing };
    }

    const start = opts?.tokensAtStart ?? 0;
    const goal: GoalState = Object.freeze({
      id: this.deps.generateId(),
      revision: 0,
      sessionId,
      condition,
      status: 'active',
      setAt: this.deps.now(),
      iterations: 0,
      maxIterations: opts?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      consecutiveNoProgress: 0,
      blockCap: opts?.blockCap ?? DEFAULT_BLOCK_CAP,
      tokenBudget: opts?.tokenBudget,
      tokensAtStart: start,
      tokensNow: start,
      tokensBaselinePending: true,
    });
    const goalRecord: GoalRecord = {
      state: goal,
      controlLease: createControlLease(goal.id),
    };
    this.goals.set(sessionId, goalRecord);
    this.emit(goal);
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

  matchesControlLease(sessionId: string, lease: GoalControlLease): boolean {
    return this.goals.get(sessionId)?.controlLease === lease;
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
      { status: 'active', pausedAt: undefined },
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
    const record = this.goals.get(sessionId);
    const deleted = this.goals.delete(sessionId);
    if (record && deleted) this.emit(record.state, record.state.status);
    return deleted;
  }

  dispose(): void {
    this.goals.clear();
  }
}

function createControlLease(goalId: string): GoalControlLease {
  return Object.freeze({ goalId });
}
