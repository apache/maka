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
import { roomMentionAt, roomAuthorSession, roomResult } from '../app/roomMessage.ts';

test('Room mentions target only the token at the caret and preserve Unicode prose', () => {
  const text = '一起😀 @review 后文';
  const caret = text.indexOf(' 后文');
  assert.deepEqual(roomMentionAt(text, { start: caret, end: caret }), {
    start: 5,
    end: caret,
    query: 'review',
  });
  assert.equal(roomMentionAt('user@example.com', { start: 16, end: 16 }), null);
  assert.equal(roomMentionAt('@review', { start: 0, end: 7 }), null);
  assert.deepEqual(roomMentionAt('@', { start: 1, end: 1 }), { start: 0, end: 1, query: '' });
});

test('Replying to an agent selects its session as the removable mention, while human replies add no recipient', () => {
  assert.equal(roomAuthorSession({ author: { kind: 'human' } }), null);
  assert.equal(
    roomAuthorSession({
      author: { kind: 'session', execution: { sessionId: 'review', turnId: 'turn', runId: 'run' } },
    }),
    'review',
  );
});

test('Room send receipt returns the posted message and surfaces native handler failures', () => {
  const result = { kind: 'posted', sessionId: 'room', messageId: 'message', deliveries: [] };
  assert.deepEqual(
    roomResult({
      receipt: {
        kind: 'recorded',
        outcome: { kind: 'returned', result: { kind: 'success', value: result } },
      },
    }),
    result,
  );
  assert.throws(
    () =>
      roomResult({
        receipt: {
          kind: 'recorded',
          outcome: {
            kind: 'returned',
            result: { kind: 'failure', diagnostic: 'room was removed' },
          },
        },
      }),
    /room was removed/,
  );
});
