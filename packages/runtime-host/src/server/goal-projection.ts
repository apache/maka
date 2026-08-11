import {
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_REASON_TEXT_LIMIT,
  type GoalState,
} from '@maka/runtime/goal-state';
import { decodeGoalProjection, type GoalProjection } from '../protocol/index.js';

export function projectGoalState(goal: GoalState): GoalProjection {
  return decodeGoalProjection({
    goalId: goal.id,
    revision: goal.revision,
    sessionId: goal.sessionId,
    condition: goal.condition,
    status: goal.status,
    setAt: goal.setAt,
    iterations: goal.iterations,
    maxIterations: goal.maxIterations,
    consecutiveNoProgress: goal.consecutiveNoProgress,
    blockCap: goal.blockCap,
    tokenBudget: goal.tokenBudget ?? null,
    tokensSpent: Math.max(0, goal.tokensNow - goal.tokensAtStart),
    lastReason: goal.lastReason ?? null,
    achievedAt: goal.achievedAt ?? null,
    pausedAt: goal.pausedAt ?? null,
  });
}

/** Reserves Session snapshot capacity for a Goal before one is created. */
export function worstCaseGoalProjection(sessionId: string): GoalProjection {
  return {
    goalId: 'g'.repeat(128),
    revision: Number.MAX_SAFE_INTEGER,
    sessionId,
    condition: '界'.repeat(GOAL_CONDITION_TEXT_LIMIT.codeUnits),
    status: 'paused',
    setAt: Number.MAX_SAFE_INTEGER,
    iterations: Number.MAX_SAFE_INTEGER,
    maxIterations: Number.MAX_SAFE_INTEGER,
    consecutiveNoProgress: Number.MAX_SAFE_INTEGER,
    blockCap: Number.MAX_SAFE_INTEGER,
    tokenBudget: Number.MAX_SAFE_INTEGER,
    tokensSpent: Number.MAX_SAFE_INTEGER,
    lastReason: '界'.repeat(GOAL_REASON_TEXT_LIMIT.codeUnits),
    achievedAt: Number.MAX_SAFE_INTEGER,
    pausedAt: Number.MAX_SAFE_INTEGER,
  };
}
