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
  TASK_LEDGER_MAX_TASKS,
  canTransitionTaskStatus,
  isSafeTaskId,
  isTaskKey,
  projectTaskLedgerEvents,
  sanitizeTaskLedgerTask,
  type Task,
  type TaskLedgerEvent,
} from '@maka/core/task-ledger';
import type { SequencedTaskLedgerEvent } from '@maka/storage/task-ledger-authority';
import type {
  TaskMutationChange,
  TaskMutationCorrelation,
  TaskMutationLookup,
  TaskMutationPresentation,
} from '../protocol/index.js';

const UPDATE_EVENT_TYPES = new Set<TaskLedgerEvent['type']>([
  'task_updated',
  'task_started',
  'task_blocked',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'task_reopened',
]);

/**
 * Derive immutable, display-safe mutation facts from the canonical Task event log.
 * Request order is preserved so every correlation occupies one deterministic slot.
 */
export function projectTaskMutationLookups(
  rows: readonly SequencedTaskLedgerEvent[],
  correlations: readonly TaskMutationCorrelation[],
): readonly TaskMutationLookup[] {
  const canonicalHistory = projectTaskLedgerEvents(rows.map(({ event }) => event));
  const historyIsCanonical = canonicalHistory.diagnostics.length === 0;
  const rowsByCorrelation = new Map<string, SequencedTaskLedgerEvent[]>();
  for (const row of rows) {
    const refs = row.event.refs;
    if (!refs?.turnId || !refs.toolCallId) continue;
    const key = correlationKey({ turnId: refs.turnId, toolCallId: refs.toolCallId });
    const matched = rowsByCorrelation.get(key) ?? [];
    matched.push(row);
    rowsByCorrelation.set(key, matched);
  }

  return correlations.map((correlation) => {
    const matched = rowsByCorrelation.get(correlationKey(correlation));
    if (!matched || matched.length === 0) return { kind: 'not_found', correlation };
    if (!historyIsCanonical) return { kind: 'incompatible', correlation };
    const presentation = projectPresentation(correlation, matched);
    return presentation
      ? { kind: 'found', correlation, presentation }
      : { kind: 'incompatible', correlation };
  });
}

function projectPresentation(
  correlation: TaskMutationCorrelation,
  rows: readonly SequencedTaskLedgerEvent[],
): TaskMutationPresentation | undefined {
  if (!isCompatibleCorrelationGroup(rows)) return undefined;
  const operation = rows[0]?.event.type === 'task_created' ? 'create' : 'update';
  if (
    (operation === 'create' && !isCompatibleCreate(rows)) ||
    (operation === 'update' && !isCompatibleUpdate(rows))
  ) {
    return undefined;
  }
  const changes: TaskMutationChange[] = [];
  for (const { event } of rows) {
    const change = projectChange(event);
    if (!change) return undefined;
    changes.push(change);
  }
  return { operation, correlation, changes };
}

function isCompatibleCorrelationGroup(rows: readonly SequencedTaskLedgerEvent[]): boolean {
  const firstRunId = rows[0]?.event.refs?.runId;
  if (!firstRunId) return false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) return false;
    if (index > 0 && row.sequence !== rows[index - 1]!.sequence + 1) return false;
    if (
      row.event.source !== 'tool' ||
      row.event.actor !== 'main_agent' ||
      row.event.refs?.runId !== firstRunId
    ) {
      return false;
    }
  }
  return true;
}

function isCompatibleCreate(rows: readonly SequencedTaskLedgerEvent[]): boolean {
  if (rows.length === 0 || rows.length > TASK_LEDGER_MAX_TASKS) return false;
  const taskIds = new Set<string>();
  const taskKeys = new Set<string>();
  for (const { event } of rows) {
    const key = event.task.key;
    if (
      event.type !== 'task_created' ||
      event.previousStatus !== undefined ||
      event.nextStatus !== 'pending' ||
      !key ||
      taskIds.has(event.taskId) ||
      taskKeys.has(key)
    ) {
      return false;
    }
    taskIds.add(event.taskId);
    taskKeys.add(key);
  }
  return true;
}

function isCompatibleUpdate(rows: readonly SequencedTaskLedgerEvent[]): boolean {
  const event = rows.length === 1 ? rows[0]?.event : undefined;
  return (
    event !== undefined &&
    UPDATE_EVENT_TYPES.has(event.type) &&
    event.previousStatus !== undefined &&
    canTransitionTaskStatus(event.previousStatus, event.nextStatus, {
      explicitReopen: event.type === 'task_reopened',
    }) &&
    isCompatibleUpdateEventType(event)
  );
}

function isCompatibleUpdateEventType(event: TaskLedgerEvent): boolean {
  switch (event.type) {
    case 'task_updated':
      return event.previousStatus === event.nextStatus;
    case 'task_started':
      return event.nextStatus === 'in_progress';
    case 'task_blocked':
      return event.nextStatus === 'blocked';
    case 'task_completed':
      return event.nextStatus === 'completed';
    case 'task_failed':
      return event.nextStatus === 'failed';
    case 'task_cancelled':
      return event.nextStatus === 'cancelled';
    case 'task_reopened':
      return (
        (event.previousStatus === 'completed' && event.nextStatus === 'in_progress') ||
        (event.previousStatus === 'cancelled' && event.nextStatus === 'pending') ||
        (event.previousStatus === 'failed' && event.nextStatus === 'pending')
      );
    default:
      return false;
  }
}

function projectChange(event: TaskLedgerEvent): TaskMutationChange | undefined {
  const key = event.task.key;
  if (!key || !isTaskKey(key) || !isSafeTaskId(event.taskId)) return undefined;
  const expectedReason =
    event.nextStatus === 'blocked'
      ? event.task.blockedReason
      : event.nextStatus === 'failed'
        ? event.task.failureReason
        : undefined;
  const expectedEvidence =
    event.nextStatus === 'completed' ? event.task.completionEvidence : undefined;
  if (
    ((event.nextStatus === 'blocked' || event.nextStatus === 'failed') && !expectedReason) ||
    (event.nextStatus === 'completed' && !expectedEvidence)
  ) {
    return undefined;
  }
  if (event.reason !== expectedReason || event.evidence !== expectedEvidence) return undefined;

  const task = sanitizeTaskLedgerTask({ ...event.task, key } as Task);
  const reason =
    event.nextStatus === 'blocked'
      ? task.blockedReason
      : event.nextStatus === 'failed'
        ? task.failureReason
        : undefined;
  const evidence = event.nextStatus === 'completed' ? task.completionEvidence : undefined;
  return {
    taskId: event.taskId,
    key,
    subject: task.subject,
    ...(event.previousStatus !== undefined ? { previousStatus: event.previousStatus } : {}),
    nextStatus: event.nextStatus,
    ...(reason !== undefined ? { reason } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

export function taskMutationCorrelationKey(correlation: TaskMutationCorrelation): string {
  return correlationKey(correlation);
}

function correlationKey(correlation: TaskMutationCorrelation): string {
  return JSON.stringify([correlation.turnId, correlation.toolCallId]);
}
