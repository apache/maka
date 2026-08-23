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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

export const GOAL_STATUSES = [
  'active',
  'waiting',
  'achieved',
  'impossible',
  'cleared',
  'paused',
  'stalled',
  'budget_limited',
  'max_iterations',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === 'string' && (GOAL_STATUSES as readonly string[]).includes(value);
}

export interface GoalTextLimit {
  readonly codeUnits: number;
  readonly utf8Bytes: number;
}

export interface GoalState {
  readonly id: string;
  readonly revision: number;
  readonly sessionId: string;
  readonly condition: string;
  readonly status: GoalStatus;
  readonly setAt: number;
  readonly iterations: number;
  readonly maxIterations: number;
  readonly consecutiveNoProgress: number;
  readonly blockCap: number;
  readonly tokenBudget?: number;
  readonly tokensAtStart: number;
  readonly tokensNow: number;
  readonly tokensBaselinePending: boolean;
  readonly lastReason?: string;
  readonly achievedAt?: number;
  readonly pausedAt?: number;
  /**
   * When `goal.arm` created this Goal, and absent once the Goal drives itself.
   *
   * A Goal the model sets drives from the moment it exists: the Turn that set
   * it is already bound to it and settles into its first continuation. Arming
   * happens outside every Turn and deliberately starts nothing, so an armed
   * Goal waits — for a Turn to carry it into a continuation, or for the user
   * to resume it — and this records that wait. Both events clear it, so its
   * absence is the whole fact `isDrivingGoal` reads. Absence is also what
   * every Goal written before arming existed carries, which is what those
   * Goals mean.
   */
  readonly armedAt?: number;
}

/**
 * Whether this Goal admits its own continuation Turns, which a restart or a
 * resume has to put back.
 *
 * `status` cannot answer this: `active` covers both a Goal between
 * continuations and an armed one still waiting for its first Turn. Neither
 * can `iterations`, which only rises once a carried Turn settles into an
 * evaluation — leaving the whole first Turn, and any pause taken during it,
 * indistinguishable from a Goal nothing ever took hold of.
 */
export function isDrivingGoal(goal: Pick<GoalState, 'armedAt'>): boolean {
  return goal.armedAt === undefined;
}

export interface GoalCheckpoint {
  readonly goalId: string;
  readonly revision: number;
}

export interface GoalControlLease {
  readonly goalId: string;
  readonly generation: number;
}

export function sameGoalControlLease(
  left: GoalControlLease | undefined,
  right: GoalControlLease | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.goalId === right.goalId && left.generation === right.generation;
}

export interface GoalExecutionRef {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface GoalCurrentExecution {
  readonly execution: GoalExecutionRef;
  readonly checkpoint: GoalCheckpoint;
  readonly controlLease: GoalControlLease;
}

export interface GoalAuthorityRecord {
  readonly schemaVersion: 1;
  readonly goal: GoalState;
  readonly controlLease: GoalControlLease;
  readonly currentExecution: GoalCurrentExecution | null;
}

const GOAL_STATE_SHAPE = defineObjectShape<GoalState>()(
  [
    'id',
    'revision',
    'sessionId',
    'condition',
    'status',
    'setAt',
    'iterations',
    'maxIterations',
    'consecutiveNoProgress',
    'blockCap',
    'tokensAtStart',
    'tokensNow',
    'tokensBaselinePending',
  ],
  ['tokenBudget', 'lastReason', 'achievedAt', 'pausedAt', 'armedAt'],
);
const GOAL_CONTROL_LEASE_SHAPE = defineObjectShape<GoalControlLease>()(
  ['goalId', 'generation'],
  [],
);
const GOAL_EXECUTION_REF_SHAPE = defineObjectShape<GoalExecutionRef>()(
  ['sessionId', 'turnId', 'runId'],
  [],
);
const GOAL_CHECKPOINT_SHAPE = defineObjectShape<GoalCheckpoint>()(['goalId', 'revision'], []);
const GOAL_CURRENT_EXECUTION_SHAPE = defineObjectShape<GoalCurrentExecution>()(
  ['execution', 'checkpoint', 'controlLease'],
  [],
);
const GOAL_AUTHORITY_RECORD_SHAPE = defineObjectShape<GoalAuthorityRecord>()(
  ['schemaVersion', 'goal', 'controlLease', 'currentExecution'],
  [],
);
const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function decodeGoalAuthorityRecord(value: unknown): GoalAuthorityRecord {
  if (!isRecord(value) || !hasExactShape(value, GOAL_AUTHORITY_RECORD_SHAPE)) {
    throw new TypeError('Invalid Goal authority record');
  }
  if (value.schemaVersion !== 1) throw new TypeError('Unsupported Goal authority schema');
  const goal = decodeGoalState(value.goal);
  const controlLease = decodeGoalControlLease(value.controlLease);
  const currentExecution =
    value.currentExecution === null
      ? null
      : decodeGoalCurrentExecution(value.currentExecution, goal, controlLease);
  if (controlLease.goalId !== goal.id) {
    throw new TypeError('Goal control lease does not match Goal identity');
  }
  return Object.freeze({
    schemaVersion: 1,
    goal,
    controlLease,
    currentExecution,
  });
}

function decodeGoalState(value: unknown): GoalState {
  if (!isRecord(value) || !hasExactShape(value, GOAL_STATE_SHAPE)) {
    throw new TypeError('Invalid Goal state');
  }
  if (
    !isGoalId(value.id) ||
    !isGoalId(value.sessionId) ||
    typeof value.condition !== 'string' ||
    !value.condition.trim() ||
    !isGoalTextWithinLimit(value.condition, GOAL_CONDITION_TEXT_LIMIT) ||
    !isGoalStatus(value.status) ||
    !isNonnegativeInteger(value.revision) ||
    !isNonnegativeInteger(value.setAt) ||
    !isNonnegativeInteger(value.iterations) ||
    !isPositiveInteger(value.maxIterations) ||
    !isNonnegativeInteger(value.consecutiveNoProgress) ||
    !isPositiveInteger(value.blockCap) ||
    !isOptionalPositiveInteger(value.tokenBudget) ||
    !isNonnegativeInteger(value.tokensAtStart) ||
    !isNonnegativeInteger(value.tokensNow) ||
    typeof value.tokensBaselinePending !== 'boolean' ||
    !isOptionalBoundedReason(value.lastReason) ||
    !isOptionalNonnegativeInteger(value.achievedAt) ||
    !isOptionalNonnegativeInteger(value.pausedAt) ||
    !isOptionalNonnegativeInteger(value.armedAt)
  ) {
    throw new TypeError('Invalid Goal state');
  }
  return Object.freeze({ ...value }) as unknown as GoalState;
}

function decodeGoalControlLease(value: unknown): GoalControlLease {
  if (
    !isRecord(value) ||
    !hasExactShape(value, GOAL_CONTROL_LEASE_SHAPE) ||
    !isGoalId(value.goalId) ||
    !isNonnegativeInteger(value.generation)
  ) {
    throw new TypeError('Invalid Goal control lease');
  }
  return Object.freeze({ goalId: value.goalId, generation: value.generation });
}

function decodeGoalCheckpoint(value: unknown): GoalCheckpoint {
  if (
    !isRecord(value) ||
    !hasExactShape(value, GOAL_CHECKPOINT_SHAPE) ||
    !isGoalId(value.goalId) ||
    !isNonnegativeInteger(value.revision)
  ) {
    throw new TypeError('Invalid Goal checkpoint');
  }
  return Object.freeze({ goalId: value.goalId, revision: value.revision });
}

function decodeGoalCurrentExecution(
  value: unknown,
  goal: GoalState,
  authorityLease: GoalControlLease,
): GoalCurrentExecution {
  if (!isRecord(value) || !hasExactShape(value, GOAL_CURRENT_EXECUTION_SHAPE)) {
    throw new TypeError('Invalid Goal current execution');
  }
  const execution = decodeGoalExecutionRef(value.execution);
  const checkpoint = decodeGoalCheckpoint(value.checkpoint);
  const controlLease = decodeGoalControlLease(value.controlLease);
  if (
    execution.sessionId !== goal.sessionId ||
    checkpoint.goalId !== goal.id ||
    checkpoint.revision > goal.revision ||
    controlLease.goalId !== authorityLease.goalId ||
    controlLease.generation > authorityLease.generation
  ) {
    throw new TypeError('Goal current execution does not match Goal authority');
  }
  return Object.freeze({ execution, checkpoint, controlLease });
}

function decodeGoalExecutionRef(value: unknown): GoalExecutionRef {
  if (
    !isRecord(value) ||
    !hasExactShape(value, GOAL_EXECUTION_REF_SHAPE) ||
    !isGoalId(value.sessionId) ||
    !isGoalId(value.turnId) ||
    !isGoalId(value.runId)
  ) {
    throw new TypeError('Invalid Goal execution reference');
  }
  return Object.freeze({ sessionId: value.sessionId, turnId: value.turnId, runId: value.runId });
}

function isGoalId(value: unknown): value is string {
  return typeof value === 'string' && GOAL_ID_PATTERN.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isOptionalNonnegativeInteger(value: unknown): boolean {
  return value === undefined || isNonnegativeInteger(value);
}

function isOptionalBoundedReason(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && isGoalTextWithinLimit(value, GOAL_REASON_TEXT_LIMIT))
  );
}

function isGoalTextWithinLimit(value: string, limit: GoalTextLimit): boolean {
  return value.length <= limit.codeUnits && Buffer.byteLength(value, 'utf8') <= limit.utf8Bytes;
}

/** Shared boundary for a Goal condition in model tools and Host projections. */
export const GOAL_CONDITION_TEXT_LIMIT: GoalTextLimit = Object.freeze({
  codeUnits: 500,
  utf8Bytes: 1_500,
});

/**
 * Shared ceilings for the two Goal budgets a caller may choose.
 *
 * They were literals inside the GoalSet tool's schema until the Host grew an
 * operation that arms a Goal too — two callers validating the same field
 * against two copies of a number is how the copies drift apart.
 */
export const GOAL_MAX_ITERATIONS_LIMIT = 200;
export const GOAL_BLOCK_CAP_LIMIT = 50;
/** Below this a budget stops the Goal before it can do anything with it. */
export const GOAL_TOKEN_BUDGET_MINIMUM = 1_000;

/** Shared boundary for evaluator and lifecycle diagnostics. */
export const GOAL_REASON_TEXT_LIMIT: GoalTextLimit = Object.freeze({
  codeUnits: 500,
  utf8Bytes: 1_500,
});
