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
import { projectProcessGroups } from '../app/processGroups.ts';
import { historyTurnKey } from '../app/history.ts';

const row = (messageId, text, sequence, changes = {}) => ({
  key: messageId,
  messageId,
  text,
  field: 'body',
  role: 'assistant',
  turnId: 'run',
  position: { kind: 'live', sequence, fact: '00000000-0000-4000-8000-000000000003', itemIndex: 0 },
  order: { path: [sequence], itemIndex: 0 },
  ...changes,
});

test('a turn has work to fold only beside its final answer', () => {
  const worked = (rows) =>
    projectProcessGroups({ rows, toolActivity: [], activeTurnId: null }).turns.get('run').worked;
  const request = row('request', 'Summarize', 1, { role: 'user' });
  const answer = row('answer', 'Done', 4, { finalOutput: true });
  assert.equal(worked([request, answer]), false);
  assert.equal(worked([request, row('draft', 'Reading first', 2), answer]), true);
  assert.equal(
    worked([request, row('thought', 'Checking', 2, { role: 'thinking', field: 'thinking' })]),
    true,
  );
  assert.equal(worked([request, row('draft', 'Streaming', 2)]), true, 'a running reply is work');
  assert.equal(
    worked([request, row('limit', 'Rate limited', 2, { role: 'failure' }), answer]),
    true,
    'a recovered failure folds away',
  );
});

test('recovered snapshot failures mark only their source-aware turn as having work', () => {
  const failure = row('failed', 'Rate limited', 2, {
    role: 'failure',
    position: {
      kind: 'snapshot',
      path: ['fork'],
      snapshot: 'snapshot',
      sequence: 2,
      fact: '00000000-0000-4000-8000-000000000003',
      itemIndex: 0,
    },
  });
  const projection = projectProcessGroups({
    rows: [failure],
    toolActivity: [],
    activeTurnId: null,
  });
  assert.equal(projection.turns.size, 1);
  assert.equal(projection.turns.get(historyTurnKey(failure)).worked, true);
  assert.equal(projection.turns.has('run'), false);
});
