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
import {
  AcpInjectInputError,
  INJECT_CAPABILITY,
  decodeInjectRequest,
  decodeRevokeRequest,
  placementFor,
} from '../acp/session-inject.js';

const text = [{ type: 'text', text: 'also check the test file' }];

test('decodes both injection modes', () => {
  assert.deepEqual(decodeInjectRequest({ sessionId: 'sess_1', mode: 'steer', content: text }), {
    sessionId: 'sess_1',
    mode: 'steer',
    content: text,
  });
  assert.deepEqual(decodeInjectRequest({ sessionId: 'sess_1', mode: 'queue', content: text }), {
    sessionId: 'sess_1',
    mode: 'queue',
    content: text,
  });
});

test('rejects a mode neither the proposal nor an implementation defines', () => {
  // Unknown values without a `_` prefix are reserved for future ACP variants;
  // accepting them would guess at delivery semantics.
  assert.throws(
    () => decodeInjectRequest({ sessionId: 'sess_1', mode: 'interrupt', content: text }),
    (error: unknown) =>
      error instanceof AcpInjectInputError &&
      error.field === 'mode' &&
      error.reason === 'unsupported',
  );
});

test('rejects a request without a session, content or mode', () => {
  for (const input of [
    { mode: 'steer', content: text },
    { sessionId: 'sess_1', content: text },
    { sessionId: 'sess_1', mode: 'steer', content: [] },
  ]) {
    assert.throws(() => decodeInjectRequest(input), AcpInjectInputError);
  }
});

test('decodes a revoke request and requires both ids', () => {
  assert.deepEqual(decodeRevokeRequest({ sessionId: 'sess_1', messageId: 'msg_1' }), {
    sessionId: 'sess_1',
    messageId: 'msg_1',
  });
  assert.throws(() => decodeRevokeRequest({ sessionId: 'sess_1' }), AcpInjectInputError);
  assert.throws(() => decodeRevokeRequest({ messageId: 'msg_1' }), AcpInjectInputError);
});

test('steer maps to the running turn and queue waits for the next one', () => {
  assert.equal(placementFor('steer'), 'current_turn');
  assert.equal(placementFor('queue'), 'next_turn');
});

test('advertises both modes and how steer behaves mid-stream', () => {
  assert.deepEqual(INJECT_CAPABILITY.modes, ['queue', 'steer']);
  // Required by the proposal whenever `steer` is advertised.
  assert.ok(INJECT_CAPABILITY.steerInStream.length > 0);
});
