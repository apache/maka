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
import type { Task } from '@maka/core/task-ledger';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeTaskLedgerQueryInput,
  decodeTaskLedgerQueryResult,
  encodeTaskLedgerTask,
  encodeTaskLedgerQueryResult,
  TASK_LEDGER_CURSOR_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_BYTES,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type TaskLedgerQueryResult,
} from '../protocol/task-ledger.js';

const revision = `sha256:${'a'.repeat(64)}` as const;
const nextRevision = `sha256:${'b'.repeat(64)}` as const;

describe('Task Ledger protocol', () => {
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
