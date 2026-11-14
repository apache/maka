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
  browserOrder,
  foldableFamilies,
  groupConversations,
  groupWorkspace,
  unfoldedSessions,
} from '../app/conversationGroups.ts';

const session = (id, path, options = {}) => ({
  id,
  parentSessionId: options.parent ?? null,
  pinned: options.pinned ?? false,
  workspace: { projectId: options.project ?? null, path },
});
const project = (id, archived = false) => ({ reference: { id }, archived });

test('groups list pinned conversations, then projects in catalog order, then other workspaces', () => {
  const groups = groupConversations(
    [
      session('pin', '/a', { pinned: true, project: 'p' }),
      session('child', '/b', { parent: 'root' }),
      session('inProject', '/a', { project: 'p' }),
      session('root', '/b'),
    ],
    [project('p'), project('empty'), project('gone', true)],
    true,
  );
  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions]),
    [
      ['pinned', ['pin']],
      ['project:p', ['inProject']],
      ['project:empty', []],
      ['path:/b', ['root', 'child']],
    ],
  );
  assert.equal(groups[0].project, null);
  assert.equal(groups[3].path, '/b');
  assert.deepEqual([...groups[3].nested], ['child']);
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
    project: registered.reference,
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

test('a conversation that created three or more can fold them', () => {
  const [group] = groupConversations(
    [
      session('big', '/a'),
      session('b1', '/a', { parent: 'big' }),
      session('b2', '/a', { parent: 'b1' }),
      session('b3', '/a', { parent: 'big' }),
      session('small', '/a'),
      session('s1', '/a', { parent: 'small' }),
      session('s2', '/a', { parent: 'small' }),
    ],
    [],
    false,
  );
  assert.deepEqual([...foldableFamilies(group)], [['big', ['b1', 'b2', 'b3']]]);
  assert.deepEqual(unfoldedSessions(group, new Set()), group.sessions);
  assert.deepEqual(unfoldedSessions(group, new Set(['big', 'small'])), [
    'big',
    'small',
    's1',
    's2',
  ]);
  // Stepping skips a folded family but starts from a folded current row.
  assert.deepEqual(browserOrder([group], new Set(), null, undefined, new Set(['big'])), [
    'big',
    'small',
    's1',
    's2',
  ]);
  assert.deepEqual(browserOrder([group], new Set(), 'b2', undefined, new Set(['big'])), [
    'big',
    'b2',
    'small',
    's1',
    's2',
  ]);
  // Without fold state, as in the terminal, nothing folds.
  assert.deepEqual(browserOrder([group], new Set(), null), group.sessions);
});

test('a project counts only unfolded conversations toward its limit', () => {
  const groups = groupConversations(
    [
      session('p', '/a', { project: 'x' }),
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) =>
        session(id, '/a', { project: 'x', parent: 'p' }),
      ),
      session('q', '/a', { project: 'x' }),
    ],
    [project('x')],
    false,
  );
  assert.deepEqual(browserOrder(groups, new Set(), null, new Set(), new Set(['p'])), ['p', 'q']);
});
