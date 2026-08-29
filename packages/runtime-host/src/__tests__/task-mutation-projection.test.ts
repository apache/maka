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

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { TaskLedgerEvent } from '@maka/core/task-ledger';
import type { SequencedTaskLedgerEvent } from '@maka/storage/task-ledger-authority';
import { projectTaskMutationLookups } from '../server/task-mutation-projection.js';

const createCorrelation = { turnId: 'turn-1', toolCallId: 'call-create' } as const;
const updateCorrelation = { turnId: 'turn-2', toolCallId: 'call-update' } as const;

describe('Task mutation projection', () => {
  test('keeps create history immutable after a later rename', () => {
    const rows = [
      row(0, event('event-1', 'task_created', createCorrelation, 'Original subject')),
      row(
        1,
        event('event-2', 'task_updated', updateCorrelation, 'Renamed subject', {
          previousStatus: 'pending',
        }),
      ),
    ];
    const lookups = projectTaskMutationLookups(rows, [createCorrelation, updateCorrelation]);
    assert.equal(lookups[0]?.kind, 'found');
    assert.equal(
      lookups[0]?.kind === 'found' ? lookups[0].presentation.changes[0]?.subject : undefined,
      'Original subject',
    );
    assert.equal(lookups[1]?.kind, 'found');
    assert.equal(
      lookups[1]?.kind === 'found' ? lookups[1].presentation.changes[0]?.subject : undefined,
      'Renamed subject',
    );
  });

  test('projects a contiguous create batch and redacts exact mutation detail', () => {
    const blocked = event('event-3', 'task_blocked', updateCorrelation, 'Blocked task', {
      previousStatus: 'in_progress',
      nextStatus: 'blocked',
      reason: 'Waiting for ghp_abcdefghijklmnopqrstuvwxyz123456',
    });
    const lookups = projectTaskMutationLookups(
      [
        row(0, event('event-1', 'task_created', createCorrelation, 'First')),
        row(1, event('event-2', 'task_created', createCorrelation, 'Second', { taskIndex: 2 })),
        row(2, blocked),
      ],
      [createCorrelation, updateCorrelation],
    );
    assert.equal(lookups[0]?.kind, 'found');
    assert.deepEqual(
      lookups[0]?.kind === 'found'
        ? lookups[0].presentation.changes.map(({ key, subject }) => ({ key, subject }))
        : [],
      [
        { key: 'T1', subject: 'First' },
        { key: 'T2', subject: 'Second' },
      ],
    );
    assert.equal(
      lookups[1]?.kind === 'found' ? lookups[1].presentation.changes[0]?.reason : undefined,
      'Waiting for [redacted]',
    );
  });

  test('returns typed unresolved results without guessing from another event', () => {
    const mismatch = event('event-1', 'task_blocked', updateCorrelation, 'Blocked task', {
      previousStatus: 'in_progress',
      nextStatus: 'blocked',
      reason: 'top-level reason',
    });
    mismatch.task.blockedReason = 'different snapshot reason';
    const missing = { turnId: 'turn-missing', toolCallId: 'call-missing' };
    assert.deepEqual(projectTaskMutationLookups([row(0, mismatch)], [updateCorrelation, missing]), [
      { kind: 'incompatible', correlation: updateCorrelation },
      { kind: 'not_found', correlation: missing },
    ]);
  });

  test('rejects non-contiguous reuse of one correlation', () => {
    const unrelated = { turnId: 'turn-other', toolCallId: 'call-other' };
    const rows = [
      row(0, event('event-1', 'task_created', createCorrelation, 'First')),
      row(1, event('event-2', 'task_created', unrelated, 'Other')),
      row(2, event('event-3', 'task_created', createCorrelation, 'Second', { taskIndex: 2 })),
    ];
    assert.deepEqual(projectTaskMutationLookups(rows, [createCorrelation]), [
      { kind: 'incompatible', correlation: createCorrelation },
    ]);
  });

  test('rejects non-canonical create keys and update transitions', () => {
    const duplicateKeyRows = [
      row(0, event('event-1', 'task_created', createCorrelation, 'First')),
      row(
        1,
        event('event-2', 'task_created', createCorrelation, 'Second', {
          taskIndex: 2,
          taskKey: 'T1',
        }),
      ),
    ];
    assert.deepEqual(projectTaskMutationLookups(duplicateKeyRows, [createCorrelation]), [
      { kind: 'incompatible', correlation: createCorrelation },
    ]);

    for (const updateEvent of [
      event('event-3', 'task_completed', updateCorrelation, 'Skipped', {
        previousStatus: 'pending',
        nextStatus: 'completed',
        evidence: 'Done',
      }),
      event('event-4', 'task_blocked', updateCorrelation, 'Mismatched type', {
        previousStatus: 'pending',
        nextStatus: 'in_progress',
      }),
    ]) {
      assert.deepEqual(projectTaskMutationLookups([row(0, updateEvent)], [updateCorrelation]), [
        { kind: 'incompatible', correlation: updateCorrelation },
      ]);
    }
  });
});

function row(sequence: number, ledgerEvent: TaskLedgerEvent): SequencedTaskLedgerEvent {
  return { sequence, event: ledgerEvent };
}

function event(
  eventId: string,
  type: TaskLedgerEvent['type'],
  correlation: { turnId: string; toolCallId: string },
  subject: string,
  options: {
    previousStatus?: TaskLedgerEvent['previousStatus'];
    nextStatus?: TaskLedgerEvent['nextStatus'];
    reason?: string;
    evidence?: string;
    taskIndex?: number;
    taskKey?: string;
  } = {},
): TaskLedgerEvent {
  const taskIndex = options.taskIndex ?? 1;
  const nextStatus = options.nextStatus ?? 'pending';
  const task = {
    id: `task-${taskIndex}`,
    key: options.taskKey ?? `T${taskIndex}`,
    subject,
    status: nextStatus,
    createdAt: 1,
    updatedAt: 2,
    ...(nextStatus === 'blocked' && options.reason ? { blockedReason: options.reason } : {}),
    ...(nextStatus === 'failed' && options.reason ? { failureReason: options.reason } : {}),
    ...(nextStatus === 'completed' && options.evidence
      ? { completionEvidence: options.evidence }
      : {}),
  };
  return {
    eventId,
    type,
    ts: 2,
    sessionId: 'session-1',
    taskId: task.id,
    ...(options.previousStatus ? { previousStatus: options.previousStatus } : {}),
    nextStatus,
    task,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
    refs: { runId: 'run-1', ...correlation },
    source: 'tool',
    actor: 'main_agent',
  };
}
