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
  GOAL_MAX_ITERATIONS_LIMIT,
  GOAL_REASON_TEXT_LIMIT,
  GOAL_TOKEN_BUDGET_MINIMUM,
  isGoalStatus,
  type GoalStatus,
} from '@maka/core/goal';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const GOAL_RESULT_MAX_BYTES = 8 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'internal_failure',
] as const;
const CONTROL_ERRORS = [...QUERY_ERRORS, 'session_archived', 'operation_conflict'] as const;
const ARM_ERRORS = CONTROL_ERRORS;

export type GoalControlAction = 'pause' | 'resume' | 'clear';

export interface GoalProjection {
  readonly goalId: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly condition: string;
  readonly status: GoalStatus;
  readonly setAt: number;
  readonly iterations: number;
  readonly maxIterations: number;
  readonly consecutiveNoProgress: number;
  readonly blockCap: number;
  readonly tokenBudget: number | null;
  readonly tokensSpent: number;
  readonly lastReason: string | null;
  readonly achievedAt: number | null;
  readonly pausedAt: number | null;
}

export interface GoalQueryInput {
  readonly sessionId: string;
}

export interface GoalQueryResult {
  readonly sessionId: string;
  readonly goal: GoalProjection | null;
}

/**
 * Arm a Goal for a Session from outside a Turn.
 *
 * The model arms its own Goal with the GoalSet tool, inside the Turn that owns
 * the control lease. A user arming one has no Turn to speak from, so this is
 * the Host's own entry point for it — same authority, same durable record, no
 * second implementation of what a Goal is.
 *
 * `maxIterations` and `tokenBudget` are nullable rather than optional: the
 * frame carries an exact key set, and "the caller did not choose" has to be a
 * value on the wire rather than an absent field. Null means the Goal takes the
 * Runtime default (and, for the budget, no budget at all).
 */
export interface GoalArmInput {
  readonly sessionId: string;
  readonly condition: string;
  readonly maxIterations: number | null;
  readonly tokenBudget: number | null;
}

export interface GoalArmResult {
  readonly sessionId: string;
  readonly goal: GoalProjection;
}

export interface GoalControlInput {
  readonly sessionId: string;
  readonly goalId: string;
  readonly expectedRevision: number;
  readonly action: GoalControlAction;
}

export interface GoalControlResult {
  readonly sessionId: string;
  readonly goal: GoalProjection;
}

export const GOAL_OPERATION_SPECS = {
  'goal.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeGoalQueryInput,
    decodeOutput: decodeGoalQueryResult,
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId) {
        throw invalidProtocolFrame('Goal query result belongs to a different Session');
      }
    },
  }),
  'goal.arm': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: ARM_ERRORS,
    decodeInput: decodeGoalArmInput,
    decodeOutput: decodeGoalArmResult,
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId) {
        throw invalidProtocolFrame('Goal arm result belongs to a different Session');
      }
    },
  }),
  'goal.control': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: CONTROL_ERRORS,
    decodeInput: decodeGoalControlInput,
    decodeOutput: decodeGoalControlResult,
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId || input.goalId !== output.goal.goalId) {
        throw invalidProtocolFrame('Goal control result belongs to a different Goal');
      }
    },
  }),
} as const;

export function decodeGoalProjection(value: unknown): GoalProjection {
  const record = requireExactRecord(value, 'Goal projection', [
    'goalId',
    'revision',
    'sessionId',
    'condition',
    'status',
    'setAt',
    'iterations',
    'maxIterations',
    'consecutiveNoProgress',
    'blockCap',
    'tokenBudget',
    'tokensSpent',
    'lastReason',
    'achievedAt',
    'pausedAt',
  ]);
  const condition = requireUtf8String(
    record.condition,
    'Goal condition',
    GOAL_CONDITION_TEXT_LIMIT.utf8Bytes,
  );
  if (condition.length > GOAL_CONDITION_TEXT_LIMIT.codeUnits) {
    throw invalidProtocolFrame('Invalid Goal condition');
  }
  const lastReason = requireNullableGoalReason(record.lastReason);
  return {
    goalId: requireEntityId(record.goalId, 'goalId'),
    revision: requireCount(record.revision, 'Goal revision'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    condition,
    status: requireGoalStatus(record.status),
    setAt: requireCount(record.setAt, 'Goal setAt'),
    iterations: requireCount(record.iterations, 'Goal iterations'),
    maxIterations: requirePositiveCount(record.maxIterations, 'Goal maxIterations'),
    consecutiveNoProgress: requireCount(record.consecutiveNoProgress, 'Goal consecutiveNoProgress'),
    blockCap: requirePositiveCount(record.blockCap, 'Goal blockCap'),
    tokenBudget: requireNullablePositiveCount(record.tokenBudget, 'Goal tokenBudget'),
    tokensSpent: requireCount(record.tokensSpent, 'Goal tokensSpent'),
    lastReason,
    achievedAt: requireNullableCount(record.achievedAt, 'Goal achievedAt'),
    pausedAt: requireNullableCount(record.pausedAt, 'Goal pausedAt'),
  };
}

function decodeGoalQueryInput(value: unknown): GoalQueryInput {
  const record = requireExactRecord(value, 'goal.query input', ['sessionId']);
  return { sessionId: requireEntityId(record.sessionId, 'sessionId') };
}

function decodeGoalQueryResult(value: unknown): GoalQueryResult {
  requireEncodedByteLimit(value, 'Goal query result', GOAL_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'goal.query result', ['sessionId', 'goal']);
  const sessionId = requireEntityId(record.sessionId, 'sessionId');
  const goal = record.goal === null ? null : decodeGoalProjection(record.goal);
  if (goal && goal.sessionId !== sessionId) {
    throw invalidProtocolFrame('Goal query result contains a Goal from another Session');
  }
  return { sessionId, goal };
}

function decodeGoalArmInput(value: unknown): GoalArmInput {
  const record = requireExactRecord(value, 'goal.arm input', [
    'sessionId',
    'condition',
    'maxIterations',
    'tokenBudget',
  ]);
  const condition = requireUtf8String(
    record.condition,
    'Goal condition',
    GOAL_CONDITION_TEXT_LIMIT.utf8Bytes,
  );
  if (!condition.trim() || condition.length > GOAL_CONDITION_TEXT_LIMIT.codeUnits) {
    throw invalidProtocolFrame('Invalid Goal condition');
  }
  const maxIterations = requireNullablePositiveCount(record.maxIterations, 'Goal maxIterations');
  if (maxIterations !== null && maxIterations > GOAL_MAX_ITERATIONS_LIMIT) {
    throw invalidProtocolFrame('Goal maxIterations exceeds its limit');
  }
  const tokenBudget = requireNullablePositiveCount(record.tokenBudget, 'Goal tokenBudget');
  if (tokenBudget !== null && tokenBudget < GOAL_TOKEN_BUDGET_MINIMUM) {
    throw invalidProtocolFrame('Goal tokenBudget is below its minimum');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    condition,
    maxIterations,
    tokenBudget,
  };
}

function decodeGoalArmResult(value: unknown): GoalArmResult {
  requireEncodedByteLimit(value, 'Goal arm result', GOAL_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'goal.arm result', ['sessionId', 'goal']);
  const sessionId = requireEntityId(record.sessionId, 'sessionId');
  const goal = decodeGoalProjection(record.goal);
  if (goal.sessionId !== sessionId) {
    throw invalidProtocolFrame('Goal arm result contains a Goal from another Session');
  }
  return { sessionId, goal };
}

function decodeGoalControlInput(value: unknown): GoalControlInput {
  const record = requireExactRecord(value, 'goal.control input', [
    'sessionId',
    'goalId',
    'expectedRevision',
    'action',
  ]);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    goalId: requireEntityId(record.goalId, 'goalId'),
    expectedRevision: requireCount(record.expectedRevision, 'expectedRevision'),
    action: requireGoalControlAction(record.action),
  };
}

function decodeGoalControlResult(value: unknown): GoalControlResult {
  requireEncodedByteLimit(value, 'Goal control result', GOAL_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'goal.control result', ['sessionId', 'goal']);
  const sessionId = requireEntityId(record.sessionId, 'sessionId');
  const goal = decodeGoalProjection(record.goal);
  if (goal.sessionId !== sessionId) {
    throw invalidProtocolFrame('Goal control result contains a Goal from another Session');
  }
  return { sessionId, goal };
}

function requireGoalStatus(value: unknown): GoalStatus {
  if (!isGoalStatus(value)) {
    throw invalidProtocolFrame('Invalid Goal status');
  }
  return value;
}

function requireGoalControlAction(value: unknown): GoalControlAction {
  if (value !== 'pause' && value !== 'resume' && value !== 'clear') {
    throw invalidProtocolFrame('Invalid Goal control action');
  }
  return value;
}

function requireNullableGoalReason(value: unknown): string | null {
  if (value === null) return null;
  const reason = requireUtf8String(value, 'Goal lastReason', GOAL_REASON_TEXT_LIMIT.utf8Bytes);
  if (reason.length > GOAL_REASON_TEXT_LIMIT.codeUnits) {
    throw invalidProtocolFrame('Invalid Goal lastReason');
  }
  return reason;
}

function requirePositiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

function requireNullablePositiveCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  return requirePositiveCount(value, label);
}

function requireNullableCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  return requireCount(value, label);
}
