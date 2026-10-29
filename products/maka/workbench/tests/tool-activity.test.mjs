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
import { updateToolActivity, latestToolActivity } from '../app/toolActivity.ts';
import { thinkingSummary } from '../app/thinkingSummary.ts';

test('thinking summary retains the last nonempty paragraph and its Unicode text', () => {
  for (const [source, expected] of [
    ['', ''],
    [' \r\n\t\u2003', ''],
    ['**first**\nline', 'first line'],
    ['old\n\n**最新**\n 行\r\n \t', '最新 行'],
    ['old\r\n\t \r\n**最新**\r\n\t\r\n \t', '最新'],
    ['old\n\n**\n\n', ''],
    ['old\n\r \nnew', 'old new'],
    ['earlier\n\n\n **tail**\n\n\n', 'tail'],
    ['earlier\n\n'.repeat(20000) + '**尾 e\u0301**\nline', '尾 e\u0301 line'],
  ]) {
    assert.equal(thinkingSummary(source), expected);
  }
});

test('complete active tool identities survive 129 starts, updates and exact terminal removal', () => {
  let active = [];
  const event = (index, fact, invocationId = 'invocation') => ({
    invocationId,
    turnId: 'turn',
    sequence: index + 1,
    fact,
  });
  const id = (index) => 'tool_' + index.toString(16).padStart(64, '0');
  for (let index = 0; index < 129; index++) {
    active = updateToolActivity(
      active,
      event(index, {
        kind: 'executor_tool_start',
        toolUseId: id(index),
        name: 'echo',
      }),
    );
  }
  assert.deepEqual(
    active.map((tool) => tool.toolUseId),
    Array.from({ length: 129 }, (_, index) => id(index)),
  );
  assert.equal(latestToolActivity(active, 'invocation', 'turn').toolUseId, id(128));
  active = updateToolActivity(
    active,
    event(130, {
      kind: 'executor_tool_progress',
      toolUseId: id(128),
      text: 'original progress',
    }),
  );
  assert.equal(active.length, 129);
  assert.equal(active[128].detail, 'original progress');
  assert.equal(active[128].startSequence, 129);
  active = updateToolActivity(
    active,
    event(131, { kind: 'executor_tool_start', toolUseId: id(0), name: 'independent' }, 'other'),
  );
  assert.equal(active.length, 130);
  active = updateToolActivity(
    active,
    event(132, { kind: 'executor_tool_result', toolUseId: id(128) }),
  );
  assert.equal(active.length, 129);
  assert.equal(latestToolActivity(active, 'invocation', 'turn').toolUseId, id(127));
  assert.equal(latestToolActivity(active, 'other', 'turn').name, 'independent');
  active = updateToolActivity(active, event(133, { kind: 'ended' }));
  assert.deepEqual(
    active.map((tool) => [tool.invocationId, tool.toolUseId, tool.name]),
    [['other', id(0), 'independent']],
  );
});
