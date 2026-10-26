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

import { requireCount, requireEntityId, requireExactRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_EVENT_WAIT_PAGE_SIZE = 64;
export type SessionEventWaitConsumer =
  | { kind: 'tool_invocation'; runId: string; invocationId: string; operationId: string }
  | {
      kind: 'goal_waiting';
      goalId: string;
      controlGeneration: number;
      expectedGoalRevision: number;
    };
export interface SessionEventWaitCancelInput {
  sessionId: string;
  waitId: string;
  consumer: SessionEventWaitConsumer;
}
export interface SessionEventWaitProjection extends SessionEventWaitCancelInput {
  sourceTurnId: string;
  resource: { providerId: string; resourceType: string; resourceId: string };
  deadlineAt: number | null;
  phase: 'observing' | 'result_ready';
  observation: 'checking' | 'pending' | 'unknown' | null;
  reasonCode: string | null;
}
export interface SessionEventWaitsProjection {
  items: SessionEventWaitProjection[];
  nextCursor: string | null;
}
export interface SessionEventWaitQueryInput {
  sessionId: string;
  afterWaitId?: string;
}
export interface SessionEventWaitQueryResult extends SessionEventWaitsProjection {
  sessionId: string;
}
export interface SessionEventWaitCancelResult {
  sessionId: string;
  outcome: 'cancelled' | 'conflict';
}
function consumer(value: unknown): SessionEventWaitConsumer {
  const kind = value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
  if (kind === 'tool_invocation') {
    const r = requireExactRecord(value, 'Tool wait consumer', [
      'kind',
      'runId',
      'invocationId',
      'operationId',
    ]);
    return {
      kind,
      runId: requireEntityId(r.runId, 'runId'),
      invocationId: requireEntityId(r.invocationId, 'invocationId'),
      operationId: requireEntityId(r.operationId, 'operationId'),
    };
  }
  if (kind === 'goal_waiting') {
    const r = requireExactRecord(value, 'Goal waiting consumer', [
      'kind',
      'goalId',
      'controlGeneration',
      'expectedGoalRevision',
    ]);
    return {
      kind,
      goalId: requireEntityId(r.goalId, 'goalId'),
      controlGeneration: requireCount(r.controlGeneration, 'Control generation'),
      expectedGoalRevision: requireCount(r.expectedGoalRevision, 'Goal revision'),
    };
  }
  throw invalidProtocolFrame('Invalid event wait consumer');
}
export function decodeSessionEventWaitCancelInput(value: unknown): SessionEventWaitCancelInput {
  const r = requireExactRecord(value, 'Event wait cancellation', [
    'sessionId',
    'waitId',
    'consumer',
  ]);
  return {
    sessionId: requireEntityId(r.sessionId, 'sessionId'),
    waitId: requireEntityId(r.waitId, 'waitId'),
    consumer: consumer(r.consumer),
  };
}
export function decodeSessionEventWaitsProjection(value: unknown): SessionEventWaitsProjection {
  const r = requireExactRecord(value, 'Session event waits', ['items', 'nextCursor']);
  if (!Array.isArray(r.items) || r.items.length > SESSION_EVENT_WAIT_PAGE_SIZE)
    throw invalidProtocolFrame('Invalid event wait page');
  const seen = new Set<string>();
  const items = r.items.map((item): SessionEventWaitProjection => {
    const w = requireExactRecord(item, 'Event wait projection', [
      'sessionId',
      'waitId',
      'consumer',
      'sourceTurnId',
      'resource',
      'deadlineAt',
      'phase',
      'observation',
      'reasonCode',
    ]);
    const resource = requireExactRecord(w.resource, 'Event wait resource', [
      'providerId',
      'resourceType',
      'resourceId',
    ]);
    if (
      (w.phase !== 'observing' && w.phase !== 'result_ready') ||
      ![null, 'checking', 'pending', 'unknown'].includes(w.observation as never)
    )
      throw invalidProtocolFrame('Invalid event wait phase');
    if (
      (w.phase === 'result_ready' && w.observation !== null) ||
      (w.phase === 'observing' && w.observation === null)
    )
      throw invalidProtocolFrame('Inconsistent event wait phase');
    const waitId = requireEntityId(w.waitId, 'waitId');
    if (seen.has(waitId)) throw invalidProtocolFrame('Duplicate event wait');
    seen.add(waitId);
    return {
      sessionId: requireEntityId(w.sessionId, 'sessionId'),
      waitId,
      consumer: consumer(w.consumer),
      sourceTurnId: requireEntityId(w.sourceTurnId, 'sourceTurnId'),
      resource: {
        providerId: requireUtf8String(resource.providerId, 'Provider', 128),
        resourceType: requireUtf8String(resource.resourceType, 'Resource type', 128),
        resourceId: requireUtf8String(resource.resourceId, 'Resource reference', 512),
      },
      deadlineAt: w.deadlineAt === null ? null : requireCount(w.deadlineAt, 'Deadline'),
      phase: w.phase,
      observation: w.observation as SessionEventWaitProjection['observation'],
      reasonCode: w.reasonCode === null ? null : requireUtf8String(w.reasonCode, 'Reason', 128),
    };
  });
  return {
    items,
    nextCursor: r.nextCursor === null ? null : requireEntityId(r.nextCursor, 'nextCursor'),
  };
}
const errors = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'internal_failure',
] as const;
export const SESSION_EVENT_WAIT_OPERATION_SPECS = {
  'session.event-waits.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors,
    decodeInput(value): SessionEventWaitQueryInput {
      const r = requireExactRecord(value, 'Event wait query', [
        'sessionId',
        ...(value && typeof value === 'object' && Object.hasOwn(value, 'afterWaitId')
          ? ['afterWaitId']
          : []),
      ]);
      return {
        sessionId: requireEntityId(r.sessionId, 'sessionId'),
        ...(r.afterWaitId === undefined
          ? {}
          : { afterWaitId: requireEntityId(r.afterWaitId, 'afterWaitId') }),
      };
    },
    decodeOutput(value): SessionEventWaitQueryResult {
      const r = requireExactRecord(value, 'Event wait query result', [
        'sessionId',
        'items',
        'nextCursor',
      ]);
      const sessionId = requireEntityId(r.sessionId, 'sessionId');
      const page = decodeSessionEventWaitsProjection({ items: r.items, nextCursor: r.nextCursor });
      if (page.items.some((w) => w.sessionId !== sessionId))
        throw invalidProtocolFrame('Event wait belongs to another Session');
      return { sessionId, ...page };
    },
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId)
        throw invalidProtocolFrame('Event wait query Session mismatch');
    },
  }),
  'session.event-wait.cancel': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors,
    decodeInput: decodeSessionEventWaitCancelInput,
    decodeOutput(value): SessionEventWaitCancelResult {
      const r = requireExactRecord(value, 'Event wait cancellation result', [
        'sessionId',
        'outcome',
      ]);
      if (r.outcome !== 'cancelled' && r.outcome !== 'conflict')
        throw invalidProtocolFrame('Invalid event wait cancellation outcome');
      return { sessionId: requireEntityId(r.sessionId, 'sessionId'), outcome: r.outcome };
    },
    assertOutputForInput(input, output) {
      if (input.sessionId !== output.sessionId)
        throw invalidProtocolFrame('Event wait cancellation Session mismatch');
    },
  }),
} as const;
