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
import {
  decodeWorkHubCoordinationAnswerInput,
  decodeWorkHubCoordinationRecordInput,
  decodeWorkHubCoordinationResolveInput,
  decodeWorkHubCoordinationResolveResult,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
} from '../protocol/index.js';

test('WorkHub Coordination resolve has a closed empty input and bounded identity result', () => {
  assert.deepEqual(decodeWorkHubCoordinationResolveInput({}), {});
  assert.deepEqual(decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination' }), {
    sessionId: 'coordination',
  });
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.resolve'].mode, 'command');
  assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 49);
  assert.throws(
    () => decodeWorkHubCoordinationResolveInput({ sessionId: 'caller-selected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () => decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination', role: 'injected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});

test('WorkHub Coordination answer and summary inputs are closed and bounded', () => {
  assert.deepEqual(
    decodeWorkHubCoordinationAnswerInput({ turnId: 'answer-turn', text: 'What changed?' }),
    { turnId: 'answer-turn', text: 'What changed?' },
  );
  assert.deepEqual(
    decodeWorkHubCoordinationRecordInput({
      turnId: 'summary-turn',
      userText: 'Continue payment work',
      assistantText: 'Submitted to Payment',
    }),
    {
      turnId: 'summary-turn',
      userText: 'Continue payment work',
      assistantText: 'Submitted to Payment',
    },
  );
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.answer'].mode, 'command');
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.record'].mode, 'command');
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.answer'), true);
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('workhub.coordination.record'), true);
  assert.throws(
    () => decodeWorkHubCoordinationAnswerInput({ turnId: 'turn', text: 'answer', extra: true }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeWorkHubCoordinationRecordInput({
        turnId: 'turn',
        userText: 'user',
        assistantText: 'x'.repeat(8 * 1024 + 1),
      }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});
