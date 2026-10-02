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
  checkQueueRevision,
  commitFollowupPromotion,
  commitQueueReorder,
  locateQueuedEntry,
  planQueueReorder,
  removeQueuedEntry,
  selectQueuedEntry,
} from '../server/message-queue-state.js';

type Entry = { entryId: string; messageId: string };

function queueState() {
  return {
    steering: [
      { entryId: 'steer-1', messageId: 'message-1' },
      { entryId: 'steer-2', messageId: 'message-2' },
    ],
    followup: [{ entryId: 'follow-1', messageId: 'message-3' }],
    inFlight: new Map<string, Entry>([
      ['lease-1', { entryId: 'flight-1', messageId: 'message-4' }],
    ]),
  };
}

test('queue revision fence rejects an old client proposal', () => {
  assert.deepEqual(checkQueueRevision(8, 8), { kind: 'current', revision: 8 });
  assert.deepEqual(checkQueueRevision(9, 8), { kind: 'stale', expected: 8, actual: 9 });
});

test('reorder planning resolves the lane from the complete identity set', () => {
  const state = queueState();
  assert.deepEqual(planQueueReorder(state, ['steer-2', 'steer-1']), {
    lane: 'steering',
    entries: [state.steering[1], state.steering[0]],
    changed: true,
  });
  assert.equal(planQueueReorder(state, ['steer-1', 'follow-1']), undefined);
});

test('selection partitions queued, in-flight, wrong-lane, and missing identities', () => {
  const state = queueState();
  assert.equal(selectQueuedEntry(state, 'steer-1').kind, 'found');
  assert.deepEqual(selectQueuedEntry(state, 'steer-1', 'followup'), {
    kind: 'wrong_lane',
    lane: 'steering',
  });
  assert.equal(selectQueuedEntry(state, 'flight-1').kind, 'in_flight');
  assert.equal(selectQueuedEntry(state, 'absent').kind, 'missing');
});

test('mutation helpers preserve identity uniqueness and lane order', () => {
  const state = queueState();
  const selected = locateQueuedEntry(state, 'follow-1');
  assert.ok(selected);
  commitFollowupPromotion(state, selected, { ...selected.entry, messageId: 'promoted' });
  assert.deepEqual(state.followup, []);
  assert.deepEqual(
    state.steering.map(({ entryId }) => entryId),
    ['steer-1', 'steer-2', 'follow-1'],
  );

  const plan = planQueueReorder(state, ['follow-1', 'steer-1', 'steer-2']);
  assert.ok(plan);
  commitQueueReorder(state, plan.lane, plan.entries);
  assert.deepEqual(
    state.steering.map(({ entryId }) => entryId),
    ['follow-1', 'steer-1', 'steer-2'],
  );

  const removed = locateQueuedEntry(state, 'steer-1');
  assert.ok(removed);
  assert.equal(removeQueuedEntry(state, removed).entryId, 'steer-1');
  assert.equal(locateQueuedEntry(state, 'steer-1'), undefined);
});

test('every permutation is either an exact reorder or an unchanged identity', () => {
  const state = queueState();
  const permutations = [
    ['steer-1', 'steer-2'],
    ['steer-2', 'steer-1'],
  ] as const;
  for (const ids of permutations) {
    const plan = planQueueReorder(state, ids);
    assert.ok(plan);
    assert.deepEqual(
      plan.entries.map(({ entryId }) => entryId),
      ids,
    );
    assert.equal(plan.changed, ids[0] !== 'steer-1');
  }
});

test('ablation: without the revision fence an old reorder would be accepted', () => {
  const expected = 4;
  const actual = 5;
  const naiveAccept = actual >= expected;
  assert.equal(naiveAccept, true);
  assert.equal(checkQueueRevision(actual, expected).kind, 'stale');
});
