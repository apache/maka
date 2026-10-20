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
  GOAL_CONDITION_TEXT_LIMIT,
  GOAL_REASON_TEXT_LIMIT,
  type GoalState,
} from '@maka/runtime/goal-state';
import { GOAL_EVENT_WAIT_SUMMARY_LIMITS } from '../protocol/goal.js';
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
    eventWait: null,
  });
}

/** Reserves encoded snapshot capacity, including worst-case JSON escaping. */
export function worstCaseGoalProjection(sessionId: string): GoalProjection {
  return {
    goalId: 'g'.repeat(128),
    revision: Number.MAX_SAFE_INTEGER,
    sessionId,
    condition: '\u0000'.repeat(GOAL_CONDITION_TEXT_LIMIT.codeUnits),
    status: 'paused',
    setAt: Number.MAX_SAFE_INTEGER,
    iterations: Number.MAX_SAFE_INTEGER,
    maxIterations: Number.MAX_SAFE_INTEGER,
    consecutiveNoProgress: Number.MAX_SAFE_INTEGER,
    blockCap: Number.MAX_SAFE_INTEGER,
    tokenBudget: Number.MAX_SAFE_INTEGER,
    tokensSpent: Number.MAX_SAFE_INTEGER,
    lastReason: '\u0000'.repeat(GOAL_REASON_TEXT_LIMIT.codeUnits),
    achievedAt: Number.MAX_SAFE_INTEGER,
    pausedAt: Number.MAX_SAFE_INTEGER,
    eventWait: {
      waitId: 'w'.repeat(128),
      controlGeneration: Number.MAX_SAFE_INTEGER,
      waitRevision: Number.MAX_SAFE_INTEGER,
      resource: {
        providerId: 'p'.repeat(128),
        resourceType: 't'.repeat(128),
        resourceId: '\u0000'.repeat(GOAL_EVENT_WAIT_SUMMARY_LIMITS.resourceIdBytes),
      },
      reason: '\u0000'.repeat(GOAL_REASON_TEXT_LIMIT.codeUnits),
      deadlineAt: Number.MAX_SAFE_INTEGER,
      phase: 'observing',
      observation: {
        state: 'unknown',
        lastObservedAt: Number.MAX_SAFE_INTEGER,
        reasonCode: '\u0000'.repeat(GOAL_EVENT_WAIT_SUMMARY_LIMITS.reasonCodeBytes),
      },
      outcome: null,
    },
  };
}
