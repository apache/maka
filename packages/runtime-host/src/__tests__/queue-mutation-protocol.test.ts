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
import test from 'node:test';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';

const BASE = {
  originHostEpoch: 'epoch-1',
  sessionId: 'session-1',
  entryId: 'entry-1',
} as const;

const REQUESTS = [
  {
    requestId: 'retract-request',
    operation: 'queue.entry.retract' as const,
    input: { ...BASE, retractId: 'retract-1' },
  },
  {
    requestId: 'promote-request',
    operation: 'queue.entry.promote' as const,
    input: { ...BASE, promoteId: 'promote-1' },
  },
  {
    requestId: 'update-request',
    operation: 'queue.entry.update' as const,
    input: { ...BASE, updateId: 'update-1', expectedQueueRevision: 7, text: 'updated' },
  },
  {
    requestId: 'reorder-request',
    operation: 'queue.entries.reorder' as const,
    input: {
      originHostEpoch: BASE.originHostEpoch,
      sessionId: BASE.sessionId,
      reorderId: 'reorder-1',
      expectedQueueRevision: 7,
      entryIds: ['entry-2', 'entry-1'],
    },
  },
] as const;

test('queue mutation requests decode as exact operation-specific records', () => {
  for (const request of REQUESTS) {
    assert.deepEqual(decodeClientFrame(request), request);
    assert.deepEqual(
      decodeHostFrame({
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        result: { queueRevision: 8 },
      }),
      {
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        result: { queueRevision: 8 },
      },
    );
  }
});

test('queue mutation requests reject stale, ambiguous, and non-semantic inputs', () => {
  const retract = REQUESTS[0];
  const promote = REQUESTS[1];
  const update = REQUESTS[2];
  const reorder = REQUESTS[3];
  const invalid = [
    { ...retract, input: { ...retract.input, generation: 1 } },
    { ...promote, input: { ...promote.input, entryId: 'not/a/semantic/id' } },
    { ...update, input: { ...update.input, text: '   ' } },
    { ...update, input: { ...update.input, expectedQueueRevision: -1 } },
    { ...reorder, input: { ...reorder.input, expectedQueueRevision: 1.5 } },
    { ...reorder, input: { ...reorder.input, entryIds: ['entry-1', 'entry-1'] } },
    { ...reorder, input: { ...reorder.input, entryIds: ['not/a/semantic/id'] } },
  ];
  for (const request of invalid) {
    assert.throws(() => decodeClientFrame(request), isInvalidFrame);
  }
});

test('queue mutation responses expose only the committed queue revision', () => {
  for (const request of REQUESTS) {
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: request.requestId,
          operation: request.operation,
          ok: true,
          result: { queueRevision: 8, retracted: [] },
        }),
      isInvalidFrame,
    );
  }
});

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
