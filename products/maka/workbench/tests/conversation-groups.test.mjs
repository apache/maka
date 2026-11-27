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
  attachBubbledChildren,
  browserOrder,
  groupConversations,
  groupConversationsByTime,
  groupWorkspace,
} from '../app/conversationGroups.ts';

const session = (id, path, options = {}) => ({
  id,
  parentSessionId: options.parent ?? null,
  pinned: options.pinned ?? false,
  archived: options.archived ?? false,
  workspace: { projectId: options.project ?? null, path },
});
const project = (id, archived = false) => ({ reference: { id }, archived });

test('groups list pinned conversations, then projects in catalog order, then other workspaces', () => {
  const groups = groupConversations(
    [
      session('pin', '/a', { pinned: true, project: 'p' }),
      session('pinned-child', '/b', { pinned: true, parent: 'root' }),
      session('inProject', '/a', { project: 'p' }),
      session('root', '/b'),
    ],
    [project('p'), project('empty'), project('gone', true)],
    true,
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions]),
    [
      ['pinned', ['pin', 'pinned-child']],
      ['project:p', ['inProject']],
      ['project:empty', []],
      ['path:/b', ['root']],
    ],
  );
  assert.equal(groups[0].project, null);
  assert.equal(groups[3].path, '/b');
  assert.equal(groups[0].nested.size, 0);
});

test('waiting children bubble one level under their visible ancestor without duplicating pinned rows or adding orphans', () => {
  const base = groupConversations(
    [
      session('pinned-parent', '/a', { pinned: true, project: 'p' }),
      session('pinned-child', '/a', { pinned: true, parent: 'pinned-parent', project: 'p' }),
      session('root', '/a', { project: 'p' }),
    ],
    [project('p')],
    false,
  );
  const groups = attachBubbledChildren(base, [
    session('wait-under-pinned', '/a', { parent: 'pinned-parent' }),
    session('pinned-child', '/a', { pinned: true, parent: 'pinned-parent' }),
    session('wait-direct', '/a', { parent: 'root' }),
    session('wait-grandchild', '/a', { parent: 'wait-direct' }),
    session('wait-orphan', '/a', { parent: 'off-page-parent' }),
    session('wait-archived', '/a', { parent: 'root', archived: true }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions, [...group.nested]]),
    [
      ['pinned', ['pinned-parent', 'wait-under-pinned', 'pinned-child'], ['wait-under-pinned']],
      ['project:p', ['root', 'wait-direct', 'wait-grandchild'], ['wait-direct', 'wait-grandchild']],
    ],
  );
});

test('bubbled children do not consume the six-conversation project preview limit', () => {
  const tops = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const base = groupConversations(
    [
      session('t0', '/a', { project: 'x' }),
      ...tops.map((id) => session(id, '/a', { project: 'x' })),
    ],
    [project('x')],
    false,
  );
  const groups = attachBubbledChildren(base, [
    session('w1', '/a', { parent: 't0' }),
    session('w2', '/a', { parent: 't0' }),
  ]);
  assert.deepEqual(browserOrder(groups, new Set(), null, new Set()), [
    't0',
    'w1',
    'w2',
    't1',
    't2',
    't3',
    't4',
    't5',
  ]);
});

test('project order is independent of conversation recency and stepping follows the preview', () => {
  const recent = Array.from({ length: 8 }, (_, index) =>
    session(`b${index}`, '/b', { project: 'b' }),
  );
  const groups = groupConversations(
    [...recent, session('a', '/a', { project: 'a' })],
    [project('a'), project('b')],
    false,
  );
  assert.deepEqual(browserOrder(groups, new Set(), null, new Set()), [
    'a',
    'b0',
    'b1',
    'b2',
    'b3',
    'b4',
    'b5',
  ]);
  assert.deepEqual(browserOrder(groups, new Set(), null, new Set(['project:b'])), [
    'a',
    'b0',
    'b1',
    'b2',
    'b3',
    'b4',
    'b5',
    'b6',
    'b7',
  ]);
});

test('stepping skips collapsed groups but keeps the open conversation', () => {
  const groups = groupConversations(
    [session('a1', '/a'), session('a2', '/a'), session('b1', '/b')],
    [],
    false,
  );
  assert.deepEqual(browserOrder(groups, new Set(['path:/a']), null), ['b1']);
  assert.deepEqual(browserOrder(groups, new Set(['path:/a']), 'a2'), ['a2', 'b1']);
  assert.deepEqual(browserOrder(groups, new Set(), 'a2'), ['a1', 'a2', 'b1']);
});

test('new conversations reuse the group workspace, not the currently selected conversation', () => {
  const groups = groupConversations(
    [session('other', '/other'), session('workspace', '/work')],
    [],
    true,
  );
  assert.deepEqual(groupWorkspace(groups[1]), { kind: 'session', sessionId: 'workspace' });

  const registered = {
    reference: { id: 'project', revision: 'revision' },
    archived: false,
    available: true,
    path: '/work',
  };
  const [empty] = groupConversations([], [registered], true);
  assert.deepEqual(groupWorkspace(empty), {
    kind: 'project',
    projectId: registered.reference.id,
    path: registered.path,
  });
  for (const change of [{ archived: true }, { available: false }, { path: null }]) {
    assert.equal(groupWorkspace({ ...empty, project: { ...registered, ...change } }), null);
  }
});

test('mixed pinned groups have no creation workspace; missing projects reuse an existing session', () => {
  const groups = groupConversations(
    [
      session('pin', '/a', { pinned: true }),
      session('pin2', '/b', { pinned: true }),
      session('missing', '/c', { project: 'not-listed' }),
    ],
    [],
    true,
  );
  assert.equal(groupWorkspace(groups[0]), null);
  assert.deepEqual(groupWorkspace(groups[1]), { kind: 'session', sessionId: 'missing' });
});

test('chronological view keeps pinned first, preserves Host order, and buckets by local calendar day', () => {
  const now = new Date(2026, 10, 21, 14, 0, 0).getTime();
  const at = (dayOffset, hour, min = 0) =>
    new Date(2026, 10, 21 + dayOffset, hour, min, 0).getTime();
  const groups = groupConversationsByTime(
    [
      { ...session('pin', '/b', { pinned: true }), updatedAt: at(-5, 9) },
      { ...session('today-first', '/a'), updatedAt: at(0, 8) },
      { ...session('today-second', '/b'), updatedAt: at(0, 12) },
      { ...session('yest-early', '/a'), updatedAt: at(-1, 0, 30) },
      { ...session('older', '/a'), updatedAt: at(-3, 9) },
    ],
    now,
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions]),
    [
      ['pinned', ['pin']],
      ['time:today', ['today-first', 'today-second']],
      ['time:yesterday', ['yest-early']],
      ['time:earlier', ['older']],
    ],
  );
  assert.equal(groupWorkspace(groups[1]), null);
  assert.deepEqual(browserOrder(groups, new Set(), null, new Set()), [
    'pin',
    'today-first',
    'today-second',
    'yest-early',
    'older',
  ]);
});
