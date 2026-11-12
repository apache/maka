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

import test from 'node:test';
import assert from 'node:assert/strict';
import { replyReceipt } from '../../../../src/assistant/proactive-matters/delivery.js';
test('reply receipt requires visible assistant text after exact task marker, not tool output or later unrelated chat', () => {
  const input = { type: 'user', text: 'Task notification ID: abc', turnId: 't' };
  const receipt = (rows: any[]) => replyReceipt(rows, 'Task notification ID: abc', 't');
  assert.deepEqual(receipt([input]), { seen: true, replied: false });
  assert.equal(receipt([input, { type: 'tool_result', text: 'success' }]).replied, false);
  assert.equal(
    receipt([input, { type: 'assistant', text: 'thinking', channel: 'analysis' }]).replied,
    false,
  );
  assert.equal(
    receipt([
      input,
      { type: 'user', text: 'other question' },
      { type: 'assistant', text: 'answer' },
    ]).replied,
    false,
  );
  assert.equal(
    receipt([
      input,
      {
        type: 'assistant',
        text: 'Investigating',
        providerOptions: { openai: { phase: 'commentary' } },
      },
    ]).replied,
    false,
  );
  assert.equal(
    receipt([input, { type: 'assistant', turnId: 'other', text: 'other answer' }]).replied,
    false,
  );
  assert.equal(
    receipt([input, { type: 'assistant', turnId: 't', text: 'The task finished.' }]).replied,
    true,
  );
  assert.equal(
    receipt([
      input,
      { type: 'tool_result', text: 'failure' },
      input,
      { type: 'assistant', text: 'Recovered reply' },
    ]).replied,
    true,
  );
});
