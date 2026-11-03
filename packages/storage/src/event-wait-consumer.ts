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
import { decodeConsumerEventWaitRecord, type ConsumerEventWaitRecord } from '@maka/core/event-wait';
import { sameGoalControlLease } from '@maka/core/goal';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RootTurnAdmission } from './agent-run-store-contract.js';
import type { GoalAuthoritySnapshot } from './goal-authority.js';
import type { ToolOperationRecord } from './runtime-event-store-contract.js';
import type {
  AnyEventWaitSnapshot,
  AcknowledgeInvocationWaitResultInput,
  RetireInvocationWaitInput,
  AcknowledgeGoalWaitingAdmissionInput,
} from './event-wait-authority.js';

export interface EventWaitConsumerFacts {
  /** Only this consumer's T1/T2 or named natural completion, never the whole Run. */
  readonly events: readonly RuntimeEvent[];
  readonly runTerminated: boolean;
  readonly operation?: ToolOperationRecord;
  readonly admission?: RootTurnAdmission;
  readonly goal?: GoalAuthoritySnapshot | null;
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid event wait acknowledgement time');
}
export function eventWaitResultDigest(record: ConsumerEventWaitRecord): string {
  const result =
    record.status === 'resolved'
      ? record.resolution
      : record.status === 'expired'
        ? { expiredAt: record.expiredAt }
        : record.status === 'cancelled'
          ? { cancelledAt: record.cancelledAt, reason: record.reason }
          : undefined;
  if (!result) throw new Error('Event wait has no result');
  return `sha256:${createHash('sha256').update(JSON.stringify(result)).digest('hex')}`;
}
export function assertConsumerWaitRegistration(
  record: ConsumerEventWaitRecord,
  facts: EventWaitConsumerFacts,
): void {
  const r = decodeConsumerEventWaitRecord(record),
    c = r.consumer;
  if (r.status !== 'waiting' || r.delivery || r.observation)
    throw new Error('Consumer wait must be registered waiting');
  const goal = facts.goal?.record;
  if (
    c.kind === 'goal_waiting' &&
    (!goal ||
      !sameGoalControlLease(goal.controlLease, c.goalControlLease) ||
      !['active', 'waiting'].includes(goal.goal.status))
  )
    throw new Error('Event wait Goal registration is unavailable');
  if (c.kind === 'tool_invocation') {
    const op = facts.operation;
    const call = facts.events.find((e) => e.id === op?.callEventId);
    const dispatch = facts.events.find((e) => e.id === op?.dispatchEventId);
    if (
      !op ||
      op.operationId !== c.operationId ||
      op.invocationId !== c.invocationId ||
      op.runId !== c.runId ||
      op.turnId !== r.sourceTurnId ||
      op.providerToolCallId !== c.toolCallId ||
      op.toolName !== 'WaitForEvent' ||
      op.currentState !== 'prepared' ||
      op.resultEventId ||
      !call ||
      !dispatch ||
      call.sessionId !== r.sessionId ||
      dispatch.sessionId !== r.sessionId ||
      call.invocationId !== c.invocationId ||
      dispatch.invocationId !== c.invocationId ||
      facts.runTerminated ||
      !facts.admission ||
      facts.admission.sessionId !== r.sessionId ||
      facts.admission.turnId !== r.sourceTurnId
    )
      throw new Error('Event wait requires the live admitted tool operation');
    if (
      call.content?.kind !== 'function_call' ||
      !call.content.args ||
      typeof call.content.args !== 'object'
    )
      throw new Error('Event wait tool call is missing');
    const args = call.content.args as Record<string, unknown>;
    assertInvocationWaitArguments(args, r);
  } else {
    const completion = facts.events.find((e) => e.id === c.completionEventId);
    const pending = goal?.pendingContinuation;
    if (
      !goal ||
      goal.goal.revision !== c.goalRevision ||
      goal.goal.status !== 'waiting' ||
      !completion ||
      completion.sessionId !== r.sessionId ||
      completion.turnId !== r.sourceTurnId ||
      completion.runId !== c.sourceRunId ||
      completion.status !== 'completed' ||
      !pending ||
      pending.observationPreparation !== undefined ||
      !sameGoalControlLease(pending.controlLease, c.goalControlLease) ||
      !equal(Reflect.get(pending, 'observation'), {
        waitId: r.waitId,
        resource: r.resource,
        condition: r.condition,
        deadlineAt: r.deadlineAt,
        sourceRunId: c.sourceRunId,
        completionEventId: c.completionEventId,
      })
    )
      throw new Error('Goal waiting registration has no current natural completion');
  }
}

/** Ordinary waits retain the exact logical request committed in T1. */
function assertInvocationWaitArguments(
  args: Record<string, unknown>,
  record: ConsumerEventWaitRecord,
): void {
  if (!equal(args.resource, record.resource) || !equal(args.condition, record.condition))
    throw new Error('Event wait tool arguments changed');
}

function readEventWaitToolResult(event: RuntimeEvent): Record<string, unknown> | undefined {
  if (event.content?.kind !== 'function_response') return undefined;
  const content = event.content.result as { kind?: unknown; value?: unknown } | undefined;
  return content?.kind === 'json' &&
    content.value &&
    typeof content.value === 'object' &&
    !Array.isArray(content.value)
    ? (content.value as Record<string, unknown>)
    : undefined;
}

export function acknowledgeInvocationWait(
  snapshot: AnyEventWaitSnapshot,
  input: AcknowledgeInvocationWaitResultInput,
  facts: EventWaitConsumerFacts,
): AnyEventWaitSnapshot {
  time(input.at);
  const r = snapshot.record;
  if (
    r.schemaVersion !== 2 ||
    r.consumer.kind !== 'tool_invocation' ||
    r.sessionId !== input.sessionId ||
    r.waitId !== input.waitId ||
    r.consumer.operationId !== input.operationId
  )
    throw new Error('Event wait consumer mismatch');
  const c = r.consumer,
    op = facts.operation;
  const event = facts.events.find((e) => e.id === input.resultEventId);
  if (
    !op ||
    op.operationId !== c.operationId ||
    op.resultEventId !== input.resultEventId ||
    op.toolName !== 'WaitForEvent' ||
    op.invocationId !== c.invocationId ||
    !event ||
    event.sessionId !== r.sessionId ||
    event.runId !== c.runId ||
    event.turnId !== r.sourceTurnId ||
    event.invocationId !== c.invocationId ||
    event.content?.kind !== 'function_response'
  )
    throw new Error('Event wait acknowledgement requires its durable tool outcome');
  const output = readEventWaitToolResult(event);
  if (
    !output ||
    output.kind !== 'event_wait_result' ||
    output.waitId !== r.waitId ||
    output.deadlineAt !== r.deadlineAt
  )
    throw new Error('Event wait tool outcome does not match');
  const resolution =
    r.status === 'resolved'
      ? r.resolution
      : r.status === 'cancelled'
        ? r.priorResolution?.resolution
        : undefined;
  const matches =
    resolution &&
    output.outcome === resolution.outcome &&
    output.observedAt === resolution.observedAt &&
    equal(output.evidenceRefs, resolution.evidenceRefs);
  if (
    !matches &&
    !(
      r.status === 'expired' &&
      output.outcome === 'expired' &&
      output.observedAt === r.expiredAt &&
      equal(output.evidenceRefs, [])
    ) &&
    !(
      r.status === 'cancelled' &&
      output.outcome === (r.reason === 'user_input' ? 'interrupted' : 'cancelled') &&
      output.observedAt === r.cancelledAt &&
      output.reason === r.reason &&
      equal(output.evidenceRefs, [])
    )
  )
    throw new Error('Event wait result lacks matching observation evidence');
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(output)).digest('hex')}`;
  if (r.delivery) {
    if (
      r.delivery.kind === 'consumed' &&
      r.delivery.operationId === input.operationId &&
      r.delivery.resultEventId === input.resultEventId &&
      r.delivery.resultDigest === digest
    )
      return snapshot;
    throw new Error('Event wait delivery already settled');
  }
  const at = Math.max(input.at, r.updatedAt, event.ts);
  return {
    authorityRevision: snapshot.authorityRevision + 1,
    record: decodeConsumerEventWaitRecord({
      ...r,
      updatedAt: at,
      delivery: {
        kind: 'consumed',
        operationId: input.operationId,
        resultEventId: input.resultEventId,
        resultDigest: digest,
        at,
      },
    }),
  };
}
export function retireInvocationWait(
  snapshot: AnyEventWaitSnapshot,
  input: RetireInvocationWaitInput,
  facts: EventWaitConsumerFacts,
): AnyEventWaitSnapshot {
  time(input.at);
  const r = snapshot.record;
  if (
    r.schemaVersion !== 2 ||
    r.consumer.kind !== 'tool_invocation' ||
    r.sessionId !== input.sessionId ||
    r.waitId !== input.waitId ||
    r.consumer.operationId !== input.operationId
  )
    throw new Error('Event wait consumer mismatch');
  const operation = facts.operation;
  const response = facts.events.find((e) => e.id === operation?.resultEventId);
  let failedOutcome = false;
  if (operation?.resultEventId) {
    if (
      operation.operationId !== r.consumer.operationId ||
      operation.invocationId !== r.consumer.invocationId ||
      operation.runId !== r.consumer.runId ||
      operation.turnId !== r.sourceTurnId ||
      operation.toolName !== 'WaitForEvent' ||
      !response ||
      response.sessionId !== r.sessionId ||
      response.invocationId !== r.consumer.invocationId ||
      response.content?.kind !== 'function_response'
    )
      throw new Error('Invalid retired operation outcome');
    const eventWaitResult = readEventWaitToolResult(response)?.kind === 'event_wait_result';
    failedOutcome = response.content.isError === true && !eventWaitResult;
    if (!failedOutcome)
      return acknowledgeInvocationWait(
        snapshot,
        {
          sessionId: input.sessionId,
          waitId: input.waitId,
          operationId: input.operationId,
          resultEventId: operation.resultEventId,
          at: input.at,
        },
        facts,
      );
  }
  if (r.delivery) return snapshot;
  if (!failedOutcome && !facts.runTerminated)
    throw new Error('Live event wait receiver cannot be retired');
  const at = Math.max(input.at, r.updatedAt);
  const { status: _status, ...base } = r;
  const record =
    r.status === 'waiting'
      ? { ...base, status: 'cancelled', cancelledAt: at, reason: input.reason }
      : r;
  return {
    authorityRevision: snapshot.authorityRevision + 1,
    record: decodeConsumerEventWaitRecord({
      ...record,
      updatedAt: at,
      delivery: { kind: 'retired', reason: input.reason, at },
    }),
  };
}
export function acknowledgeGoalWaitingAdmission(
  snapshot: AnyEventWaitSnapshot,
  input: AcknowledgeGoalWaitingAdmissionInput,
  facts: Pick<EventWaitConsumerFacts, 'admission'>,
): AnyEventWaitSnapshot {
  time(input.at);
  const r = snapshot.record,
    admission = facts.admission;
  if (
    r.schemaVersion !== 2 ||
    r.consumer.kind !== 'goal_waiting' ||
    r.sessionId !== input.sessionId ||
    r.waitId !== input.waitId ||
    !admission ||
    admission.turnId !== input.turnId ||
    admission.runId !== input.runId ||
    admission.sessionId !== input.sessionId ||
    admission.execution.kind !== 'goal'
  )
    throw new Error('Goal wait admission mismatch');
  const proof = Reflect.get(admission.execution, 'goalWaiting');
  if (
    !equal(proof, {
      waitId: r.waitId,
      sourceTurnId: r.sourceTurnId,
      generation: r.consumer.goalControlLease.generation,
      resultDigest: eventWaitResultDigest(r),
    })
  )
    throw new Error('Goal wait admission has no matching result provenance');
  if (r.delivery) {
    if (
      r.delivery.kind === 'admitted' &&
      r.delivery.turnId === input.turnId &&
      r.delivery.runId === input.runId
    )
      return snapshot;
    throw new Error('Goal wait delivery already settled');
  }
  const at = Math.max(input.at, r.updatedAt, admission.admittedAt);
  return {
    authorityRevision: snapshot.authorityRevision + 1,
    record: decodeConsumerEventWaitRecord({
      ...r,
      updatedAt: at,
      delivery: {
        kind: 'admitted',
        turnId: input.turnId,
        runId: input.runId,
        userMessageId: admission.userMessageId,
        at,
      },
    }),
  };
}
