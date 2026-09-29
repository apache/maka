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
  type StorageSessionUsageQueryResult,
  type StorageUsageQueryResult,
} from '../protocol/index.js';

const totalsSpec = HOST_OPERATION_SPECS['storage.usage.query'];
const sessionsSpec = HOST_OPERATION_SPECS['storage.usage.sessions.query'];

const totals: StorageUsageQueryResult = {
  measuredAt: 1_700_000_000_000,
  totals: [
    { kind: 'database', bytes: 4096, exact: true },
    { kind: 'artifacts', bytes: 12, exact: false },
  ],
  reclaimableBytes: 8192,
  worktreeCount: 2,
};

const sessions: StorageSessionUsageQueryResult = {
  sessions: [
    {
      sessionId: 'session-1',
      bytes: { transcript: 10, runtime: 20, artifacts: 30, context: 40 },
      worktreeCount: 1,
    },
    {
      sessionId: 'session-3',
      bytes: { transcript: 0, runtime: 0, artifacts: 0 },
      worktreeCount: 0,
    },
  ],
};

describe('storage usage protocol', () => {
  test('round-trips totals and per-Session usage through request and response frames', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-totals',
        operation: 'storage.usage.query',
        input: {},
      }),
      { requestId: 'request-totals', operation: 'storage.usage.query', input: {} },
    );
    assert.deepEqual(
      decodeHostFrame(
        JSON.parse(
          JSON.stringify({
            requestId: 'request-totals',
            operation: 'storage.usage.query',
            ok: true,
            result: totals,
          }),
        ),
      ),
      { requestId: 'request-totals', operation: 'storage.usage.query', ok: true, result: totals },
    );
    const input = { sessionIds: ['session-1', 'session-2', 'session-3'] };
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-sessions',
        operation: 'storage.usage.sessions.query',
        input,
      }),
      { requestId: 'request-sessions', operation: 'storage.usage.sessions.query', input },
    );
    assert.deepEqual(
      decodeHostFrame(
        JSON.parse(
          JSON.stringify({
            requestId: 'request-sessions',
            operation: 'storage.usage.sessions.query',
            ok: true,
            result: sessions,
          }),
        ),
      ),
      {
        requestId: 'request-sessions',
        operation: 'storage.usage.sessions.query',
        ok: true,
        result: sessions,
      },
    );
    // Unknown Sessions are omitted, so the answer is an ordered subsequence.
    assert.doesNotThrow(() => sessionsSpec.assertOutputForInput?.(input, sessions));
  });

  test('rejects unbounded, empty, duplicate, or malformed input', () => {
    const tooMany = Array.from(
      { length: STORAGE_USAGE_SESSION_MAX_ITEMS + 1 },
      (_, index) => `session-${index}`,
    );
    for (const input of [
      { sessionIds: tooMany },
      { sessionIds: [] },
      { sessionIds: ['session-1', 'session-1'] },
      { sessionIds: ['../escape'] },
      { sessionIds: 'session-1' },
      {},
    ]) {
      assert.throws(() => sessionsSpec.decodeInput(input), isInvalidFrame, JSON.stringify(input));
    }
    assert.throws(() => totalsSpec.decodeInput({ sessionIds: ['session-1'] }), isInvalidFrame);
  });

  test('rejects results with unknown kinds, open shapes, or Sessions that were not asked for', () => {
    for (const value of [
      { ...totals, totals: [{ kind: 'transcript', bytes: 1, exact: false }] },
      { ...totals, totals: [totals.totals[0], totals.totals[0]] },
      { ...totals, reclaimableBytes: -1 },
      { ...totals, sessions: [] },
    ]) {
      assert.throws(() => totalsSpec.decodeOutput(value), isInvalidFrame, JSON.stringify(value));
    }
    assert.throws(
      () =>
        sessionsSpec.decodeOutput({
          sessions: [
            { ...sessions.sessions[0], bytes: { transcript: 1, runtime: 1, artifacts: 1, x: 1 } },
          ],
        }),
      isInvalidFrame,
    );
    for (const sessionIds of [['session-3', 'session-1'], ['session-1'], ['session-2']]) {
      assert.throws(
        () => sessionsSpec.assertOutputForInput?.({ sessionIds }, sessions),
        isInvalidFrame,
        sessionIds.join(','),
      );
    }
  });
});

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
