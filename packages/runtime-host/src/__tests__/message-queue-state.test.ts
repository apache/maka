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
import { checkQueueRevision, planQueueReorder } from '../server/message-queue-state.js';

const state = {
  steering: [
    { entryId: 'steer-1', messageId: 'message-1' },
    { entryId: 'steer-2', messageId: 'message-2' },
  ],
  followup: [{ entryId: 'follow-1', messageId: 'message-3' }],
  inFlight: new Map(),
};

test('queue revision fence rejects an old client proposal', () => {
  assert.deepEqual(checkQueueRevision(8, 8), { kind: 'current', revision: 8 });
  assert.deepEqual(checkQueueRevision(9, 8), { kind: 'stale', expected: 8, actual: 9 });
});

test('reorder planning resolves the lane from the complete identity set', () => {
  assert.deepEqual(planQueueReorder(state, ['steer-2', 'steer-1']), {
    lane: 'steering',
    entries: [state.steering[1], state.steering[0]],
    changed: true,
  });
  assert.equal(planQueueReorder(state, ['steer-1', 'follow-1']), undefined);
});

test('ablation: without the revision fence an old reorder would be accepted', () => {
  const expected = 4;
  const actual = 5;
  const naiveAccept = actual >= expected;
  assert.equal(naiveAccept, true);
  assert.equal(checkQueueRevision(actual, expected).kind, 'stale');
});
