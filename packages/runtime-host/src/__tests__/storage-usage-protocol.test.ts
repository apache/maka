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
  decodeClientFrame,
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  STORAGE_USAGE_SESSION_MAX_ITEMS,
  type StorageUsageQueryResult,
} from '../protocol/index.js';

const spec = HOST_OPERATION_SPECS['storage.usage.query'];

const result: StorageUsageQueryResult = {
  measuredAt: 1_700_000_000_000,
  totals: [
    { kind: 'database', bytes: 4096, exact: false },
    { kind: 'artifacts', bytes: 12, exact: true },
  ],
  reclaimableBytes: 8192,
  worktreeCount: 2,
  sessions: [
    {
      sessionId: 'session-1',
      bytes: { transcript: 10, runtime: 20, artifacts: 30, context: 40 },
      worktreeCount: 1,
    },
    {
      sessionId: 'session-2',
      bytes: { transcript: 0, runtime: 0, artifacts: 0 },
      worktreeCount: 0,
    },
  ],
};

describe('storage usage protocol', () => {
  test('round-trips totals and per-Session usage through request and response frames', () => {
    const request = decodeClientFrame({
      requestId: 'request-storage',
      operation: 'storage.usage.query',
      input: { sessionIds: ['session-1', 'session-2'] },
    });
    assert.deepEqual(request, {
      requestId: 'request-storage',
      operation: 'storage.usage.query',
      input: { sessionIds: ['session-1', 'session-2'] },
    });
    assert.deepEqual(
      decodeHostFrame(
        JSON.parse(
          JSON.stringify({
            requestId: 'request-storage',
            operation: 'storage.usage.query',
            ok: true,
            result,
          }),
        ),
      ),
      { requestId: 'request-storage', operation: 'storage.usage.query', ok: true, result },
    );
    assert.deepEqual(spec.decodeInput({}), {});
  });

  test('rejects unbounded, duplicate, or malformed input', () => {
    const tooMany = Array.from(
      { length: STORAGE_USAGE_SESSION_MAX_ITEMS + 1 },
      (_, index) => `session-${index}`,
    );
    for (const input of [
      { sessionIds: tooMany },
      { sessionIds: ['session-1', 'session-1'] },
      { sessionIds: ['../escape'] },
      { sessionIds: 'session-1' },
      { sessionId: 'session-1' },
    ]) {
      assert.throws(() => spec.decodeInput(input), isInvalidFrame, JSON.stringify(input));
    }
  });

  test('rejects results with unknown kinds, open shapes, or Sessions that were not asked for', () => {
    const malformed: unknown[] = [
      { ...result, totals: [{ kind: 'worktrees', bytes: 1, exact: true }] },
      { ...result, totals: [result.totals[0], result.totals[0]] },
      { ...result, reclaimableBytes: -1 },
      { ...result, extra: true },
      {
        ...result,
        sessions: [
          { ...result.sessions![0], bytes: { transcript: 1, runtime: 1, artifacts: 1, other: 1 } },
        ],
      },
    ];
    for (const value of malformed) {
      assert.throws(() => spec.decodeOutput(value), isInvalidFrame, JSON.stringify(value));
    }
    const { sessions: _sessions, ...totalsOnly } = result;
    assert.throws(
      () => spec.assertOutputForInput?.({ sessionIds: ['session-2', 'session-1'] }, result),
      isInvalidFrame,
    );
    assert.throws(
      () => spec.assertOutputForInput?.({ sessionIds: ['session-1', 'session-2'] }, totalsOnly),
      isInvalidFrame,
    );
    assert.throws(() => spec.assertOutputForInput?.({}, result), isInvalidFrame);
    assert.doesNotThrow(() => spec.assertOutputForInput?.({}, totalsOnly));
  });
});

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
