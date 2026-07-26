import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Task } from '@maka/core/task-ledger';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeTaskLedgerQueryInput,
  decodeTaskLedgerQueryResult,
  encodeTaskLedgerTask,
  encodeTaskLedgerQueryResult,
  TASK_LEDGER_CURSOR_MAX_BYTES,
  TASK_LEDGER_OPERATION_SPECS,
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type TaskLedgerQueryResult,
} from '../protocol/task-ledger.js';

const revision = `sha256:${'a'.repeat(64)}` as const;
const nextRevision = `sha256:${'b'.repeat(64)}` as const;

describe('Task Ledger protocol', () => {
  test('declares the closed ready query and decodes all input branches', () => {
    const spec = TASK_LEDGER_OPERATION_SPECS['task.ledger.query'];
    assert.equal(spec.mode, 'query');
    assert.equal(spec.availability, 'ready');
    assert.deepEqual(spec.errors, [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'invalid_request',
      'internal_failure',
    ]);

    for (const input of [
      { kind: 'list_start', sessionId: 'session-1' },
      { kind: 'list_continue', sessionId: 'session-1', revision, cursor: 'opaque:2' },
      { kind: 'get', sessionId: 'session-1', taskRef: 'T1.2' },
    ] as const) {
      assert.deepEqual(decodeTaskLedgerQueryInput(input), input);
    }
  });

  test('round-trips every result branch and the current child-session owner', () => {
    const task = validTask(0, {
      owner: {
        actor: 'child_agent',
        sessionId: 'child-session-1',
        agentId: 'child-1',
        runId: 'run-1',
        turnId: 'turn-1',
      },
      resumeTrust: 'needs_revalidation',
    });
    const results: TaskLedgerQueryResult[] = [
      {
        kind: 'page',
        sessionId: 'session-1',
        revision,
        tasks: [task],
        nextCursor: 'opaque:2',
      },
      { kind: 'revision_changed', expected: revision, actual: nextRevision },
      { kind: 'task', sessionId: 'session-1', revision, task },
      { kind: 'task', sessionId: 'session-1', revision, task: null },
    ];

    for (const result of results) {
      const encoded = encodeTaskLedgerQueryResult(result);
      assert.deepEqual(decodeTaskLedgerQueryResult(encoded), encoded);
    }
  });

  test('rejects unknown fields and invalid current Task DTO values', () => {
    const task = validTask();
    for (const invalid of [
      { ...task, rawEventPath: '/private/task-events.jsonl' },
      { ...task, id: '../task' },
      { ...task, key: 'task-1' },
      { ...task, subject: ' Task 0 ' },
      { ...task, status: 'done' },
      { ...task, blockedReason: ' blocked ' },
      { ...task, resumeTrust: 'probably_ok' },
      { ...task, createdAt: Number.NaN },
      { ...task, updatedAt: Number.POSITIVE_INFINITY },
      {
        ...task,
        owner: { actor: 'child_agent', sessionId: 'child-session-1', socketPath: '/tmp/a' },
      },
    ]) {
      assertInvalid(() =>
        decodeTaskLedgerQueryResult({
          kind: 'task',
          sessionId: 'session-1',
          revision,
          task: invalid,
        }),
      );
    }

    assertInvalid(() =>
      decodeTaskLedgerQueryInput({ kind: 'list_start', sessionId: 'session-1', cursor: '0' }),
    );
    assertInvalid(() =>
      decodeTaskLedgerQueryResult({
        kind: 'revision_changed',
        expected: revision,
        actual: nextRevision,
        cursor: '0',
      }),
    );
  });

  test('projects legacy evidence-incomplete tasks to conservative resume trust', () => {
    for (const task of [
      validTask(0, { status: 'blocked' }),
      validTask(1, { status: 'failed' }),
      validTask(2, { status: 'completed' }),
    ]) {
      assert.equal(encodeTaskLedgerTask(task).resumeTrust, 'needs_revalidation');
    }

    const task = validTask(3, {
      status: 'completed',
      resumeTrust: 'needs_revalidation',
    });
    const result = {
      kind: 'task' as const,
      sessionId: 'session-1',
      revision,
      task,
    };
    assert.deepEqual(decodeTaskLedgerQueryResult(encodeTaskLedgerQueryResult(result)), result);

    const untrustedTask = validTask(4, {
      status: 'completed',
      resumeTrust: 'untrusted',
    });
    const untrustedResult = {
      kind: 'task' as const,
      sessionId: 'session-1',
      revision,
      task: untrustedTask,
    };
    assert.deepEqual(encodeTaskLedgerTask(untrustedTask), untrustedTask);
    assert.deepEqual(
      decodeTaskLedgerQueryResult(encodeTaskLedgerQueryResult(untrustedResult)),
      untrustedResult,
    );

    for (const resumeTrust of [undefined, 'trusted'] as const) {
      const result = {
        kind: 'task' as const,
        sessionId: 'session-1',
        revision,
        task: validTask(5, {
          status: 'completed',
          ...(resumeTrust === undefined ? {} : { resumeTrust }),
        }),
      };
      assertInvalid(() => decodeTaskLedgerQueryResult(result));
    }
  });

  test('projects producer text once and accepts only wire-canonical DTOs', () => {
    const producerTasks = [
      validTask(0, { subject: 'A <task-ledger> B' }),
      validTask(1, {
        subject: '<task-ledger>',
        status: 'completed',
        completionEvidence: 'Verified <task-ledger> ghp_abcdefghijklmnopqrstuvwxyz123456',
        resumeTrust: 'trusted',
      }),
      validTask(2, {
        status: 'failed',
        failureReason: '<task-ledger>',
        resumeTrust: 'trusted',
      }),
      validTask(3, {
        status: 'blocked',
        blockedReason: '<task-ledger>',
        resumeTrust: 'untrusted',
      }),
    ];
    const encoded = encodeTaskLedgerQueryResult({
      kind: 'page',
      sessionId: 'session-1',
      revision,
      tasks: producerTasks,
      nextCursor: null,
    });
    assert.equal(encoded.kind, 'page');
    assert.equal(encoded.kind === 'page' && encoded.tasks[0]?.subject, 'A B');
    assert.equal(encoded.kind === 'page' && encoded.tasks[1]?.subject, '[redacted]');
    assert.equal(
      encoded.kind === 'page' && encoded.tasks[1]?.completionEvidence,
      'Verified [redacted]',
    );
    assert.equal(encoded.kind === 'page' && encoded.tasks[2]?.failureReason, undefined);
    assert.equal(encoded.kind === 'page' && encoded.tasks[2]?.resumeTrust, 'needs_revalidation');
    assert.equal(encoded.kind === 'page' && encoded.tasks[3]?.blockedReason, undefined);
    assert.equal(encoded.kind === 'page' && encoded.tasks[3]?.resumeTrust, 'untrusted');
    assert.deepEqual(
      encoded.kind === 'page' ? encoded.tasks : [],
      producerTasks.map(encodeTaskLedgerTask),
    );
    assert.deepEqual(decodeTaskLedgerQueryResult(encoded), encoded);

    for (const task of producerTasks) {
      assertInvalid(() =>
        decodeTaskLedgerQueryResult({
          kind: 'task',
          sessionId: 'session-1',
          revision,
          task,
        }),
      );
    }
  });

  test('enforces revision and UTF-8 cursor bounds', () => {
    for (const invalidRevision of [
      'a'.repeat(64),
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
    ]) {
      assertInvalid(() =>
        decodeTaskLedgerQueryInput({
          kind: 'list_continue',
          sessionId: 'session-1',
          revision: invalidRevision,
          cursor: 'opaque',
        }),
      );
    }

    for (const cursor of ['', '界'.repeat(Math.floor(TASK_LEDGER_CURSOR_MAX_BYTES / 3) + 1)]) {
      assertInvalid(() =>
        decodeTaskLedgerQueryInput({
          kind: 'list_continue',
          sessionId: 'session-1',
          revision,
          cursor,
        }),
      );
      assertInvalid(() =>
        decodeTaskLedgerQueryResult({
          kind: 'page',
          sessionId: 'session-1',
          revision,
          tasks: [],
          nextCursor: cursor,
        }),
      );
    }
  });

  test('enforces item and encoded UTF-8 page bounds in both codec directions', () => {
    const tooMany = Array.from({ length: TASK_LEDGER_PAGE_MAX_ITEMS + 1 }, (_, index) =>
      validTask(index),
    );
    const byteHeavy = Array.from({ length: 48 }, (_, index) =>
      validTask(index, {
        status: 'completed',
        subject: 'subject '.repeat(25).trim(),
        completionEvidence: 'evidence '.repeat(125).trim(),
        endedAt: 3,
      }),
    );
    const oversizedByItems = page(tooMany);
    const oversizedByBytes = page(byteHeavy);
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversizedByBytes), 'utf8') > TASK_LEDGER_PAGE_MAX_BYTES,
    );

    for (const result of [oversizedByItems, oversizedByBytes]) {
      assertInvalid(() => encodeTaskLedgerQueryResult(result));
      assertInvalid(() => decodeTaskLedgerQueryResult(result));
    }
  });
});

function validTask(index = 0, overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${index}`,
    key: `T${index + 1}`,
    subject: `Task ${index}`,
    status: 'in_progress',
    createdAt: 1,
    updatedAt: 2,
    owner: { actor: 'main_agent', runId: 'run-1' },
    ...overrides,
  };
}

function page(tasks: readonly unknown[]) {
  return {
    kind: 'page',
    sessionId: 'session-1',
    revision,
    tasks,
    nextCursor: null,
  };
}

function assertInvalid(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
  );
}
