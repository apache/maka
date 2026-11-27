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
  familySummary,
  siblingTarget,
  sortFamilySessions,
  workspaceDifferenceLabel,
} from '../app/sessionFamilyState.ts';

test('sortFamilySessions preserves creation order even when earlier sessions are updated more recently', () => {
  const members = [
    { id: 'c', createdAt: 300, updatedAt: 400, activity: 'waiting' },
    { id: 'a', createdAt: 100, updatedAt: 950, activity: 'idle' },
    { id: 'b', createdAt: 200, updatedAt: 600, activity: 'working' },
  ];
  assert.deepEqual(
    sortFamilySessions(members).map((m) => m.id),
    ['a', 'b', 'c'],
  );
  // Updating status/recency on an earlier member must not reorder the popover list.
  const afterUpdate = members.map((m) =>
    m.id === 'a' ? { ...m, updatedAt: 2000, activity: 'waiting' } : m,
  );
  assert.deepEqual(
    sortFamilySessions(afterUpdate).map((m) => m.id),
    ['a', 'b', 'c'],
  );
});

test('siblingTarget steps cleanly across creation order and clamps at boundaries', () => {
  const siblings = [
    { id: 's3', createdAt: 30, updatedAt: 30, activity: 'idle' },
    { id: 's1', createdAt: 10, updatedAt: 50, activity: 'waiting' },
    { id: 's2', createdAt: 20, updatedAt: 40, activity: 'working' },
  ];
  assert.equal(siblingTarget(siblings, 's1', -1), null);
  assert.equal(siblingTarget(siblings, 's1', 1)?.id, 's2');
  assert.equal(siblingTarget(siblings, 's2', -1)?.id, 's1');
  assert.equal(siblingTarget(siblings, 's2', 1)?.id, 's3');
  assert.equal(siblingTarget(siblings, 's3', 1), null);
});

test('familySummary counts total, waiting, and working children', () => {
  assert.deepEqual(
    familySummary([
      { activity: 'working' },
      { activity: 'waiting' },
      { activity: 'working' },
      { activity: 'idle' },
    ]),
    { total: 4, waiting: 1, working: 2 },
  );
});

test('workspaceDifferenceLabel only names workspaces that differ from the parent', () => {
  assert.equal(workspaceDifferenceLabel('/repo/maka', '/repo/maka'), '');
  assert.equal(
    workspaceDifferenceLabel('/repo/maka/.worktrees/feat-sidebar', '/repo/maka'),
    'wt/feat-sidebar',
  );
  assert.equal(workspaceDifferenceLabel('/Users/me/notes', '/repo/maka'), 'notes');
  assert.equal(workspaceDifferenceLabel('', '/repo/maka'), '');
});
