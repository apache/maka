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

import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { decodeEventWaitRecord, type EventWaitRecord } from '@maka/core/event-wait';
import {
  decodeGoalAuthorityRecord,
  sameGoalControlLease,
  type GoalAuthorityRecord,
  type GoalCurrentExecution,
  type GoalExecutionRef,
  type GoalPendingContinuation,
  type GoalState,
} from '@maka/core/goal';
import type { EventWaitProvenance } from '@maka/core/event-wait-delivery';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeContinuationAuthorityStore } from '@maka/core/runtime-event-store';
import { readLogicalRuntimeExecution } from '@maka/core/runtime-logical-execution';
import type { RootTurnAdmission } from './agent-run-store-contract.js';
import type { EventWaitSnapshot } from './event-wait-authority.js';
import type { GoalAuthoritySnapshot } from './goal-authority.js';

export interface RegisterGoalWaitInput {
  readonly record: EventWaitRecord;
  readonly sourceExecution: GoalExecutionRef;
  readonly expectedGoalRevision: number;
  readonly reason: string;
  /** Account a completed ordinary predecessor in the same commit that replaces it. */
  readonly previousTurnSettlement?: {
    readonly execution: GoalExecutionRef;
    readonly goal: GoalState;
  };
}
export interface SettleGoalWaitInput {
  readonly sessionId: string;
  readonly waitId: string;
  readonly expectedGoalRevision: number;
  readonly goal: GoalState;
}
export interface QueueGoalWaitInput {
  readonly sessionId: string;
  readonly waitId: string;
  readonly expectedGoalRevision: number;
  readonly pending: GoalPendingContinuation;
}
export interface GoalWaitSnapshot {
  readonly wait: EventWaitSnapshot;
  readonly goal: GoalAuthoritySnapshot;
}
export function eventWaitProvenance(wait: EventWaitRecord): EventWaitProvenance {
  if (wait.status !== 'resolved' && wait.status !== 'expired')
    throw new Error('Wait has no result');
  return {
    waitId: wait.waitId,
    deliveryKey: wait.deliveryKey,
    sourceTurnId: wait.sourceTurnId,
    sourceToolCallId: wait.sourceToolCallId,
    generation: wait.goalControlLease.generation,
    outcome: wait.status === 'expired' ? 'expired' : wait.resolution.outcome,
    resultDigest: `sha256:${createHash('sha256')
      .update(
        JSON.stringify(wait.status === 'expired' ? { expiredAt: wait.expiredAt } : wait.resolution),
      )
      .digest('hex')}`,
  };
}
function owningGoal(
  goal: GoalAuthoritySnapshot | null,
  wait: EventWaitRecord,
): GoalAuthoritySnapshot {
  if (
    !goal ||
    goal.record.goal.sessionId !== wait.sessionId ||
    !sameGoalControlLease(goal.record.controlLease, wait.goalControlLease) ||
    !['active', 'waiting'].includes(goal.record.goal.status)
  )
    throw new Error('Event wait Goal is unavailable');
  return goal;
}
function update(goal: GoalAuthoritySnapshot, record: GoalAuthorityRecord): GoalAuthoritySnapshot {
  return {
    authorityRevision: goal.authorityRevision + 1,
    record: decodeGoalAuthorityRecord(record),
  };
}
export type GoalWaitRuntimeReader = Pick<
  RuntimeContinuationAuthorityStore,
  | 'readRunInvocation'
  | 'listSessionInvocations'
  | 'readContinuationClaimStateByBoundary'
  | 'readImmutableRuntimeEvents'
  | 'readImmutableRuntimePrefix'
>;

/** Authenticate immutable handoff membership before the joint write. The write
 * rechecks the admission and that the physical source has not ended or sealed. */
export async function readGoalWaitRootExecution(
  runtime: GoalWaitRuntimeReader,
  input: RegisterGoalWaitInput,
  source: RootTurnAdmission | undefined,
): Promise<GoalExecutionRef | undefined> {
  if (!source) return undefined;
  const root = { sessionId: source.sessionId, turnId: source.turnId, runId: source.runId };
  if (equal(root, input.sourceExecution)) return root;
  const logical = await readLogicalRuntimeExecution(runtime, root);
  if (
    !logical ||
    logical.pendingHandoff ||
    logical.tip.runId !== input.sourceExecution.runId ||
    logical.tip.sessionId !== input.sourceExecution.sessionId ||
    logical.tip.turnId !== input.sourceExecution.turnId
  )
    throw new Error('Invalid source execution for wait registration');
  return root;
}

/** A later user Turn may arrive while a completed ordinary Goal Turn awaits
 * evaluation. Authenticate its logical termination before replacing that slot;
 * a handoff seal alone does not finish the execution. */
export async function readCompletedGoalWaitExecution(
  runtime: GoalWaitRuntimeReader,
  current: GoalCurrentExecution | null | undefined,
  source: GoalExecutionRef | undefined,
): Promise<GoalExecutionRef | undefined> {
  if (!current || equal(current.execution, source)) return undefined;
  const logical = await readLogicalRuntimeExecution(runtime, current.execution);
  if (!logical || logical.pendingHandoff || logical.tip.terminalEvent?.status !== 'completed')
    return undefined;
  return current.execution;
}

/** Only a current ordinary checkpoint still owns an outstanding settlement.
 * Stale checkpoints and revoked control generations must not be charged again. */
export function goalWaitPredecessor(
  record: GoalAuthorityRecord,
  sourceTurnId: string,
): GoalCurrentExecution | undefined {
  const current = record.currentExecution;
  return record.goal.status === 'active' &&
    current &&
    current.execution.turnId !== sourceTurnId &&
    current.checkpoint.goalId === record.goal.id &&
    current.checkpoint.revision === record.goal.revision &&
    sameGoalControlLease(current.controlLease, record.controlLease)
    ? current
    : undefined;
}

export function registerGoalWait(
  input: RegisterGoalWaitInput,
  current: GoalAuthoritySnapshot | null,
  existing: EventWaitSnapshot | null,
  source: RootTurnAdmission | undefined,
  logicalSource: GoalExecutionRef | undefined,
  completedExecution: GoalExecutionRef | undefined,
): GoalWaitSnapshot {
  const record = decodeEventWaitRecord(input.record);
  const goal = owningGoal(current, record);
  if (existing) {
    const a = existing.record;
    if (
      !equal(
        [
          record.waitId,
          record.sessionId,
          record.goalControlLease,
          record.sourceTurnId,
          record.sourceToolCallId,
          record.resource,
          record.condition,
          record.createdAt,
          record.deadlineAt,
        ],
        [
          a.waitId,
          a.sessionId,
          a.goalControlLease,
          a.sourceTurnId,
          a.sourceToolCallId,
          a.resource,
          a.condition,
          a.createdAt,
          a.deadlineAt,
        ],
      )
    )
      throw new Error('Conflicting wait registration');
    if (
      goal.record.activeEventWait?.waitId !== record.waitId ||
      goal.record.activeEventWait.reason !== input.reason ||
      !equal(goal.record.activeEventWait.sourceExecution, input.sourceExecution)
    )
      throw new Error('Wait no longer owns the Goal');
    return { wait: existing, goal };
  }
  if (
    record.status !== 'waiting' ||
    record.delivery ||
    record.observation ||
    goal.record.goal.revision !== input.expectedGoalRevision ||
    goal.record.activeEventWait ||
    goal.record.pendingContinuation?.eventWait ||
    !source ||
    source.sessionId !== record.sessionId ||
    source.turnId !== record.sourceTurnId ||
    input.sourceExecution.sessionId !== record.sessionId ||
    input.sourceExecution.turnId !== record.sourceTurnId ||
    !equal(logicalSource, {
      sessionId: record.sessionId,
      turnId: record.sourceTurnId,
      runId: source.runId,
    }) ||
    (goal.record.currentExecution &&
      !equal(goal.record.currentExecution.execution, logicalSource) &&
      !equal(goal.record.currentExecution.execution, completedExecution))
  )
    throw new Error('Invalid source execution for wait registration');
  const predecessor = goalWaitPredecessor(goal.record, record.sourceTurnId);
  const settlement = input.previousTurnSettlement;
  if (
    predecessor
      ? !settlement ||
        !equal(settlement.execution, predecessor.execution) ||
        settlement.goal.id !== goal.record.goal.id ||
        settlement.goal.sessionId !== record.sessionId ||
        settlement.goal.revision !== input.expectedGoalRevision + 1 ||
        settlement.goal.status !== 'active'
      : settlement !== undefined
  )
    throw new Error('Previous Goal Turn settlement does not match');
  // Explicit waiting replaces the old ordinary drive in this same transaction.
  // Wake legacy waiting without charging work or changing its control generation.
  const nextGoal: GoalState =
    settlement?.goal ??
    (goal.record.goal.status === 'waiting'
      ? { ...goal.record.goal, status: 'active', revision: goal.record.goal.revision + 1 }
      : goal.record.goal);
  const checkpoint = { goalId: nextGoal.id, revision: nextGoal.revision };
  return {
    wait: { authorityRevision: 0, record },
    goal: update(goal, {
      ...goal.record,
      goal: nextGoal,
      pendingContinuation: null,
      currentExecution: {
        execution: logicalSource!,
        checkpoint,
        controlLease: goal.record.controlLease,
      },
      activeEventWait: {
        waitId: record.waitId,
        sourceExecution: input.sourceExecution,
        controlLease: record.goalControlLease,
        reason: input.reason,
        settled: false,
      },
    }),
  };
}
export function assertSourceYield(
  wait: EventWaitRecord,
  source: GoalExecutionRef,
  events: readonly RuntimeEvent[],
): void {
  if (
    !events.some(
      (e) =>
        e.sessionId === wait.sessionId &&
        e.runId === source.runId &&
        e.turnId === wait.sourceTurnId &&
        e.status === 'completed' &&
        e.actions?.stateDelta?.stopReason === 'event_wait',
    )
  )
    throw new Error('Source Turn has no durable event-wait yield termination');
}
export function settleGoalWait(
  input: SettleGoalWaitInput,
  current: GoalAuthoritySnapshot | null,
  wait: EventWaitSnapshot,
  events: readonly RuntimeEvent[],
): GoalWaitSnapshot {
  const goal = owningGoal(current, wait.record),
    gate = goal.record.activeEventWait;
  if (!gate || gate.waitId !== input.waitId || input.sessionId !== wait.record.sessionId)
    throw new Error('Wait gate changed');
  assertSourceYield(wait.record, gate.sourceExecution, events);
  if (gate.settled) return { goal, wait };
  if (
    goal.record.goal.revision !== input.expectedGoalRevision ||
    input.goal.revision !== input.expectedGoalRevision + 1 ||
    input.goal.id !== goal.record.goal.id ||
    input.goal.sessionId !== input.sessionId
  )
    throw new Error('Wait settlement revision changed');
  if (!['active', 'waiting'].includes(input.goal.status)) {
    const { activeEventWait: _gate, ...record } = goal.record;
    return {
      wait: suppressGoalWait(wait, wait.record.updatedAt),
      goal: update(goal, {
        ...record,
        goal: input.goal,
        currentExecution: null,
        pendingContinuation: null,
      }),
    };
  }
  return {
    wait,
    goal: update(goal, {
      ...goal.record,
      goal: input.goal,
      currentExecution: null,
      pendingContinuation: null,
      activeEventWait: { ...gate, settled: true },
    }),
  };
}
export function queueGoalWait(
  input: QueueGoalWaitInput,
  current: GoalAuthoritySnapshot | null,
  wait: EventWaitSnapshot,
  events: readonly RuntimeEvent[],
): GoalWaitSnapshot {
  const goal = owningGoal(current, wait.record),
    gate = goal.record.activeEventWait;
  if (
    !gate?.settled ||
    gate.waitId !== input.waitId ||
    goal.record.currentExecution ||
    wait.record.delivery ||
    input.sessionId !== wait.record.sessionId
  )
    throw new Error('Wait is not ready for delivery');
  assertSourceYield(wait.record, gate.sourceExecution, events);
  if (goal.record.pendingContinuation) {
    if (!equal(goal.record.pendingContinuation, input.pending))
      throw new Error('Conflicting event continuation');
    return { goal, wait };
  }
  if (
    goal.record.goal.revision !== input.expectedGoalRevision ||
    !input.pending.eventWait ||
    !equal(input.pending.eventWait.provenance, eventWaitProvenance(wait.record))
  )
    throw new Error('Event continuation result changed');
  assertGoalWaitBudget(goal.record.goal);
  return { wait, goal: update(goal, { ...goal.record, pendingContinuation: input.pending }) };
}
export function assertGoalWaitBudget(goal: GoalState): void {
  if (
    goal.iterations >= goal.maxIterations ||
    (goal.tokenBudget !== undefined &&
      !goal.tokensBaselinePending &&
      goal.tokensNow - goal.tokensAtStart >= goal.tokenBudget)
  )
    throw new Error('Event wait Goal budget exhausted');
}
export function admitGoalWait(
  admission: RootTurnAdmission,
  current: GoalAuthoritySnapshot | null,
  wait: EventWaitSnapshot,
): GoalWaitSnapshot {
  const goal = owningGoal(current, wait.record),
    pending = goal.record.pendingContinuation;
  const event = pending?.eventWait;
  if (
    admission.execution.kind !== 'goal' ||
    !admission.execution.eventWait ||
    !event ||
    !pending ||
    !goal.record.activeEventWait?.settled ||
    goal.record.activeEventWait.waitId !== wait.record.waitId ||
    wait.record.delivery ||
    goal.record.currentExecution ||
    !equal(event.execution, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      runId: admission.runId,
    }) ||
    event.userMessageId !== admission.userMessageId ||
    !equal(admission.normalizedInput, { text: pending.prompt }) ||
    admission.sourceMessages.length !== 0 ||
    !equal(event.provenance, admission.execution.eventWait) ||
    !equal(event.provenance, eventWaitProvenance(wait.record)) ||
    admission.execution.goalId !== goal.record.goal.id
  )
    throw new Error('Event wait admission changed');
  assertGoalWaitBudget(goal.record.goal);
  const { activeEventWait: _gate, ...record } = goal.record;
  const at = Math.max(admission.admittedAt, wait.record.updatedAt);
  return {
    goal: update(goal, {
      ...record,
      pendingContinuation: null,
      currentExecution: {
        execution: event.execution,
        checkpoint: pending.checkpoint,
        controlLease: pending.controlLease,
      },
    }),
    wait: {
      authorityRevision: wait.authorityRevision + 1,
      record: decodeEventWaitRecord({
        ...wait.record,
        updatedAt: at,
        delivery: {
          kind: 'admitted',
          turnId: admission.turnId,
          runId: admission.runId,
          userMessageId: admission.userMessageId,
          at,
        },
      }),
    },
  };
}
export function suppressGoalWait(wait: EventWaitSnapshot, at: number): EventWaitSnapshot {
  if (wait.record.delivery) return wait;
  at = Math.max(at, wait.record.updatedAt);
  const r = wait.record;
  const reason = 'Goal wait cancelled or control generation ended';
  const record =
    r.status === 'waiting' || r.status === 'resolved'
      ? {
          ...r,
          status: 'cancelled',
          updatedAt: at,
          cancelledAt: at,
          reason,
          ...(r.status === 'resolved'
            ? { priorResolution: { resolvedAt: r.resolvedAt, resolution: r.resolution } }
            : {}),
        }
      : { ...r, updatedAt: at };
  // Remove resolved-only fields when cancelling, retaining the immutable receipt explicitly.
  if (r.status === 'resolved') {
    delete (record as Record<string, unknown>).resolvedAt;
    delete (record as Record<string, unknown>).resolution;
  }
  return {
    authorityRevision: wait.authorityRevision + 1,
    record: decodeEventWaitRecord({ ...record, delivery: { kind: 'suppressed', at, reason } }),
  };
}
