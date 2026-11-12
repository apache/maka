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

import { isDeepStrictEqual as equal } from 'node:util';
import { decodeConsumerEventWaitRecord } from '@maka/core/event-wait';
import {
  decodeGoalAuthorityRecord,
  sameGoalControlLease,
  type GoalAuthorityRecord,
  type GoalState,
} from '@maka/core/goal';
import type { RootTurnAdmission } from './agent-run-store-contract.js';
import type { AnyEventWaitSnapshot } from './event-wait-authority.js';
import { acknowledgeGoalWaitingAdmission, eventWaitResultDigest } from './event-wait-consumer.js';
export { eventWaitResultDigest } from './event-wait-consumer.js';
import type { GoalAuthoritySnapshot } from './goal-authority.js';
export interface NaturalGoalWaitSnapshot {
  readonly wait: AnyEventWaitSnapshot;
  readonly goal: GoalAuthoritySnapshot;
}

/** Admission consumes the exact natural-wait outbox in the Root transaction. */
export function admitNaturalGoalWaiting(
  admission: RootTurnAdmission,
  current: GoalAuthoritySnapshot | null,
  wait: AnyEventWaitSnapshot,
): NaturalGoalWaitSnapshot {
  const record = wait.record;
  const goal = current?.record;
  const pending = goal?.pendingContinuation;
  const continuation = pending?.goalWaiting;
  if (
    record.schemaVersion !== 2 ||
    record.consumer.kind !== 'goal_waiting' ||
    !current ||
    !goal ||
    goal.goal.status !== 'active' ||
    !sameGoalControlLease(goal.controlLease, record.consumer.goalControlLease) ||
    !pending ||
    !continuation ||
    pending.observation?.waitId !== record.waitId ||
    pending.triggeringTurnId !== record.sourceTurnId ||
    continuation.waitId !== record.waitId ||
    continuation.resultDigest !== eventWaitResultDigest(record) ||
    goal.currentExecution ||
    admission.execution.kind !== 'goal' ||
    admission.execution.goalId !== goal.goal.id ||
    !equal(continuation.execution, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      runId: admission.runId,
    }) ||
    continuation.userMessageId !== admission.userMessageId ||
    admission.sourceMessages.length !== 0 ||
    !equal(admission.normalizedInput, { text: pending.prompt })
  )
    throw new Error('Natural Goal wait admission changed');
  assertGoalWaitBudget(goal.goal);
  return {
    goal: update(current, {
      ...goal,
      pendingContinuation: null,
      currentExecution: {
        execution: continuation.execution,
        checkpoint: pending.checkpoint,
        controlLease: pending.controlLease,
      },
    }),
    wait: acknowledgeGoalWaitingAdmission(
      wait,
      {
        sessionId: record.sessionId,
        waitId: record.waitId,
        turnId: admission.turnId,
        runId: admission.runId,
        at: admission.admittedAt,
      },
      { admission },
    ),
  };
}

export function retireNaturalGoalWaiting(
  wait: AnyEventWaitSnapshot,
  at: number,
): AnyEventWaitSnapshot {
  const record = wait.record;
  if (record.schemaVersion !== 2 || record.consumer.kind !== 'goal_waiting' || record.delivery)
    return wait;
  at = Math.max(at, record.updatedAt);
  const reason = 'Goal waiting continuation was superseded or its control ended';
  return {
    authorityRevision: wait.authorityRevision + 1,
    record: decodeConsumerEventWaitRecord({
      ...record,
      updatedAt: at,
      ...(record.status === 'waiting' ? { status: 'cancelled', cancelledAt: at, reason } : {}),
      delivery: { kind: 'retired', reason, at },
    }),
  };
}
function update(goal: GoalAuthoritySnapshot, record: GoalAuthorityRecord): GoalAuthoritySnapshot {
  return {
    authorityRevision: goal.authorityRevision + 1,
    record: decodeGoalAuthorityRecord(record),
  };
}
function assertGoalWaitBudget(goal: GoalState): void {
  if (
    goal.iterations >= goal.maxIterations ||
    (goal.tokenBudget !== undefined &&
      !goal.tokensBaselinePending &&
      goal.tokensNow - goal.tokensAtStart >= goal.tokenBudget)
  )
    throw new Error('Event wait Goal budget exhausted');
}
