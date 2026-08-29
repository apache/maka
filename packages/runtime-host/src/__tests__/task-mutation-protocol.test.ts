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
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeTaskMutationQueryInput,
  decodeTaskMutationQueryResult,
  encodeTaskMutationQueryResult,
  TASK_MUTATION_PAGE_MAX_BYTES,
  type TaskMutationChange,
  type TaskMutationCorrelation,
  type TaskMutationQueryResult,
} from '../protocol/task-mutation.js';

const revision = `sha256:${'a'.repeat(64)}` as const;
const correlation = { turnId: 'turn-1', toolCallId: 'call-1' } as const;

describe('Task mutation protocol', () => {
  test('requires exact, unique correlations on start and continuation', () => {
    assert.deepEqual(
      decodeTaskMutationQueryInput({
        kind: 'start',
        sessionId: 'session-1',
        correlations: [correlation],
      }),
      {
        kind: 'start',
        sessionId: 'session-1',
        correlations: [correlation],
      },
    );
    assertInvalid(() =>
      decodeTaskMutationQueryInput({
        kind: 'start',
        sessionId: 'session-1',
        correlations: [correlation, correlation],
      }),
    );
    assertInvalid(() =>
      decodeTaskMutationQueryInput({
        kind: 'continue',
        sessionId: 'session-1',
        correlations: [correlation],
        revision,
        cursor: 'opaque',
        offset: 1,
      }),
    );
  });

  test('round-trips found, unresolved, and history-changed results', () => {
    const result: TaskMutationQueryResult = {
      kind: 'page',
      sessionId: 'session-1',
      revision,
      lookups: [
        found(correlation, [change(1)]),
        {
          kind: 'not_found',
          correlation: { turnId: 'turn-2', toolCallId: 'call-2' },
        },
        {
          kind: 'incompatible',
          correlation: { turnId: 'turn-3', toolCallId: 'call-3' },
        },
      ],
      nextCursor: 'opaque',
    };
    const encoded = encodeTaskMutationQueryResult(result);
    assert.deepEqual(decodeTaskMutationQueryResult(encoded), encoded);
    assert.deepEqual(
      decodeTaskMutationQueryResult({
        kind: 'history_changed',
        expected: revision,
        actual: `sha256:${'b'.repeat(64)}`,
      }),
      {
        kind: 'history_changed',
        expected: revision,
        actual: `sha256:${'b'.repeat(64)}`,
      },
    );
  });

  test('sanitizes producer text once and rejects non-canonical wire text', () => {
    const result = encodeTaskMutationQueryResult({
      kind: 'page',
      sessionId: 'session-1',
      revision,
      lookups: [
        found(
          correlation,
          [
            change(1, {
              subject: 'Inspect <task-ledger> ghp_abcdefghijklmnopqrstuvwxyz123456',
              previousStatus: 'in_progress',
              nextStatus: 'completed',
              evidence: 'Verified ghp_abcdefghijklmnopqrstuvwxyz123456',
            }),
          ],
          'update',
        ),
      ],
      nextCursor: null,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page' || result.lookups[0]?.kind !== 'found') {
      throw new Error('Expected encoded Task mutation');
    }
    const projected = result.lookups[0].presentation.changes[0];
    assert.equal(projected?.subject, 'Inspect [redacted]');
    assert.equal(projected?.evidence, 'Verified [redacted]');
    assert.deepEqual(decodeTaskMutationQueryResult(result), result);

    assertInvalid(() =>
      decodeTaskMutationQueryResult({
        kind: 'page',
        sessionId: 'session-1',
        revision,
        lookups: [
          found(correlation, [
            change(1, {
              subject: 'Inspect ghp_abcdefghijklmnopqrstuvwxyz123456',
            }),
          ]),
        ],
        nextCursor: null,
      }),
    );
  });

  test('rejects operation-incompatible and duplicate forged changes', () => {
    for (const changes of [
      [change(1, { previousStatus: 'in_progress' })],
      [change(1, { nextStatus: 'completed', evidence: 'Done' })],
      [change(1), change(1)],
    ]) {
      assertInvalid(() =>
        decodeTaskMutationQueryResult({
          kind: 'page',
          sessionId: 'session-1',
          revision,
          lookups: [found(correlation, changes)],
          nextCursor: null,
        }),
      );
    }
    assertInvalid(() =>
      decodeTaskMutationQueryResult({
        kind: 'page',
        sessionId: 'session-1',
        revision,
        lookups: [found(correlation, [change(1)], 'update')],
        nextCursor: null,
      }),
    );
  });

  test('fits one maximum legal create without splitting its presentation', () => {
    const changes = Array.from({ length: 200 }, (_, index) => {
      const taskId = `t-${index}-${'x.'.repeat(64)}`.slice(0, 64);
      const taskNumber = String(index + 1);
      const key = `T${taskNumber}${'1'.repeat(63 - taskNumber.length)}`;
      return change(index + 1, {
        taskId,
        key,
        subject: '😀'.repeat(200),
      });
    });
    const encoded = encodeTaskMutationQueryResult({
      kind: 'page',
      sessionId: 'session-1',
      revision,
      lookups: [found(correlation, changes)],
      nextCursor: null,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(encoded), 'utf8') < TASK_MUTATION_PAGE_MAX_BYTES);
    assert.deepEqual(decodeTaskMutationQueryResult(encoded), encoded);
  });

  test('rejects a page whose complete presentations exceed the byte budget', () => {
    const lookups = Array.from({ length: 128 }, (_, index) => {
      const itemCorrelation = { turnId: `turn-${index}`, toolCallId: `call-${index}` };
      return found(
        itemCorrelation,
        [
          change(index + 1, {
            previousStatus: 'in_progress',
            nextStatus: 'completed',
            evidence: '😀'.repeat(1000),
          }),
        ],
        'update',
      );
    });
    const oversized = {
      kind: 'page',
      sessionId: 'session-1',
      revision,
      lookups,
      nextCursor: null,
    };
    assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > TASK_MUTATION_PAGE_MAX_BYTES);
    assertInvalid(() => encodeTaskMutationQueryResult(oversized));
  });
});

function found(
  itemCorrelation: TaskMutationCorrelation,
  changes: readonly TaskMutationChange[],
  operation: 'create' | 'update' = 'create',
) {
  return {
    kind: 'found' as const,
    correlation: itemCorrelation,
    presentation: { operation, correlation: itemCorrelation, changes },
  };
}

function change(index: number, overrides: Partial<TaskMutationChange> = {}): TaskMutationChange {
  return {
    taskId: `task-${index}`,
    key: `T${index}`,
    subject: `Task ${index}`,
    nextStatus: 'pending',
    ...overrides,
  };
}

function assertInvalid(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
  );
}
