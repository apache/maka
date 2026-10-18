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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSessionMessages } from '../plugin-session-query-service.js';

test('history query preserves all fields/types unless requested; filters before paging', () => {
  const messages = [
    { id: 'a', type: 'user', text: 'A', ts: 1 },
    { id: 'b', type: 'assistant', text: '', thinking: 'Internal', ts: 2 },
    { id: 'c', type: 'tool_result', text: 'Evidence', ts: 3 },
    {
      id: 'd',
      type: 'assistant',
      text: 'Working',
      providerOptions: { openai: { phase: 'commentary' } },
      ts: 4,
    },
    { id: 'e', type: 'assistant', text: 'Answer', ts: 5 },
  ];
  assert.deepEqual(
    selectSessionMessages(messages).items.map((i) => i.message),
    messages,
  );
  assert.equal(selectSessionMessages(messages, { types: [] }).items.length, 0);
  const first = selectSessionMessages(messages, { types: ['assistant'], limit: 1 });
  assert.equal(first.next, 1);
  assert.equal(
    selectSessionMessages(messages, { types: ['assistant'], after: first.next!, limit: 1 }).items[0]
      .position,
    3,
  );
  assert.deepEqual(
    selectSessionMessages(messages, { view: 'conversation' }).items.map((i) => i.message.id),
    ['a', 'e'],
  );
  assert.equal(
    selectSessionMessages(messages, { since: 3, until: 4, query: 'evidence' }).items[0].message.id,
    'c',
  );
  assert.throws(() => selectSessionMessages(messages, { limit: 0 }), /limit/);
});
