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
import { test } from 'node:test';
import {
  decodeSessionTodoQueryInput,
  decodeSessionTodoQueryResult,
  HOST_OPERATION_SPECS,
} from '../protocol/index.js';

test('SessionTodo protocol accepts one whole bounded snapshot', () => {
  assert.deepEqual(decodeSessionTodoQueryInput({ sessionId: 'session-1' }), {
    sessionId: 'session-1',
  });
  assert.deepEqual(
    decodeSessionTodoQueryResult({
      sessionId: 'session-1',
      items: [{ content: 'one', status: 'pending' }],
    }),
    { sessionId: 'session-1', items: [{ content: 'one', status: 'pending' }] },
  );
  assert.ok(HOST_OPERATION_SPECS['session.todo.query']);
  assert.equal(Object.hasOwn(HOST_OPERATION_SPECS, 'task.ledger.query'), false);
});

test('SessionTodo protocol rejects extra fields and invalid items', () => {
  assert.throws(() => decodeSessionTodoQueryInput({ sessionId: 'session-1', cursor: 'x' }));
  assert.throws(() =>
    decodeSessionTodoQueryResult({
      sessionId: 'session-1',
      items: [{ content: 'one', status: 'blocked' }],
    }),
  );
});
