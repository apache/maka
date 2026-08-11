import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import {
  decodeScheduledTaskQueryResult,
  decodeClientFrame,
  decodeHostFrame,
  SCHEDULED_TASK_PAGE_MAX_ITEMS,
  SCHEDULED_TASK_OPERATION_SPECS,
} from '../protocol/index.js';

describe('ScheduledTask protocol', () => {
  test('declares one bounded query and mutation surface', () => {
    assert.equal(SCHEDULED_TASK_OPERATION_SPECS['scheduled-task.query'].mode, 'query');
    assert.equal(SCHEDULED_TASK_OPERATION_SPECS['scheduled-task.mutate'].mode, 'command');
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'list-1',
        operation: 'scheduled-task.query',
        input: { kind: 'list', cursor: '2', expectedRevision: 4 },
      }),
      {
        requestId: 'list-1',
        operation: 'scheduled-task.query',
        input: { kind: 'list', cursor: '2', expectedRevision: 4 },
      },
    );
  });

  test('accepts signal-only catalog changes', () => {
    const frame = {
      kind: 'scheduled-task.changed' as const,
      revision: 3,
      reason: 'fired' as const,
      taskId: 'task-1',
    };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assert.throws(() => decodeHostFrame({ ...frame, runtimePayload: { secret: true } }));
  });

  test('bounds catalog pages by item count and encoded bytes', () => {
    const tasks = Array.from({ length: SCHEDULED_TASK_PAGE_MAX_ITEMS }, (_, index) =>
      scheduledTask(`task-${index}`),
    );
    const page = { kind: 'page' as const, revision: 1, tasks, nextCursor: null };
    assert.equal(decodeScheduledTaskQueryResult(page).kind, 'page');
    assert.throws(
      () =>
        decodeScheduledTaskQueryResult({
          ...page,
          tasks: [...tasks, scheduledTask('task-overflow')],
        }),
      /item limit/,
    );
    assert.throws(
      () =>
        decodeScheduledTaskQueryResult({
          ...page,
          tasks: Array.from({ length: 12 }, (_, index) =>
            scheduledTask(`large-${index}`, '"'.repeat(8_000)),
          ),
        }),
      /byte limit/,
    );
  });
});

function scheduledTask(id: string, intentBody = ''): ScheduledTask {
  return {
    id,
    title: id,
    intent: { kind: 'text', body: intentBody },
    schedule: { kind: 'once', runAt: 1 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    nextFireAt: 1,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    lastError: null,
  };
}
