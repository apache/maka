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
import { descendsFrom, visibleAncestor, workspaceSessions } from '../app/sessionNesting.ts';

const session = (id, parentSessionId = null, ancestorIds) => ({
  id,
  parentSessionId,
  ...(ancestorIds ? { ancestorIds } : {}),
});

test('visibleAncestor walks parent links to the nearest visible row and guards against cycles', () => {
  const parents = new Map([
    ['child', 'parent'],
    ['grandchild', 'child'],
    ['a', 'b'],
    ['b', 'a'],
    ['orphan', 'missing'],
  ]);
  const visible = new Set(['parent']);
  assert.equal(visibleAncestor('child', visible, parents), 'parent');
  assert.equal(visibleAncestor('grandchild', visible, parents), 'parent');
  assert.equal(visibleAncestor('a', visible, parents), null);
  assert.equal(visibleAncestor('orphan', visible, parents), null);
});

test('descendsFrom detects descendants across multiple levels and stops on cycles', () => {
  const parents = new Map([
    ['worker', 'bot'],
    ['helper', 'worker'],
    ['a', 'b'],
    ['b', 'a'],
  ]);
  assert.equal(descendsFrom('worker', 'bot', parents), true);
  assert.equal(descendsFrom('helper', 'bot', parents), true);
  assert.equal(descendsFrom('a', 'bot', parents), false);
  assert.equal(descendsFrom('worker', null, parents), false);
});

test("the Bot's workers and what they created leave the list; others stay", () => {
  const kept = workspaceSessions(
    [
      session('bot'),
      session('worker', 'bot'),
      session('helper', 'worker'),
      session('pinned-deep-bot', 'unlisted-worker', ['unlisted-worker', 'bot']),
      session('mine'),
      session('child', 'mine'),
      session('orphan', 'gone'),
    ],
    'bot',
    'all',
    true,
  ).map(({ id }) => id);
  assert.deepEqual(kept, ['mine', 'child', 'orphan']);
  assert.equal(workspaceSessions([session('a', 'b')], null, 'all', true).length, 1);
});

test('the inbox and archive keep Bot workers on desktop and terminal', () => {
  const rows = [session('bot'), session('worker', 'bot'), session('mine')];
  for (const desktop of [false, true])
    for (const filter of ['needs_you', 'archived'])
      assert.deepEqual(
        workspaceSessions(rows, 'bot', filter, desktop).map(({ id }) => id),
        ['worker', 'mine'],
      );
  assert.deepEqual(
    workspaceSessions(rows, 'bot', 'all', false).map(({ id }) => id),
    ['worker', 'mine'],
  );
});

test('discovery workers stay excluded from ordinary conversation lists across all filters', () => {
  const rows = [
    session('bot'),
    { ...session('worker', 'bot'), discoveryWorker: false },
    { ...session('probe', 'bot'), discoveryWorker: true },
    session('mine'),
  ];
  for (const desktop of [false, true]) {
    for (const filter of ['all', 'needs_you', 'archived']) {
      assert.equal(
        workspaceSessions(rows, 'bot', filter, desktop).some(({ id }) => id === 'probe'),
        false,
      );
    }
  }
  assert.deepEqual(
    workspaceSessions(rows, null, 'all', true).map(({ id }) => id),
    ['bot', 'worker', 'mine'],
  );
});
