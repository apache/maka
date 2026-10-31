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
import { browserOrder, groupConversations } from '../app/conversationGroups.ts';

const session = (id, path, options = {}) => ({
  id,
  parentSessionId: options.parent ?? null,
  pinned: options.pinned ?? false,
  workspace: { projectId: options.project ?? null, path },
});
const project = (id, archived = false) => ({ reference: { id }, archived });

test('groups list pinned conversations, then workspaces, then empty projects', () => {
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
      ['path:/b', ['root', 'child']],
      ['project:p', ['inProject']],
      ['project:empty', []],
    ],
  );
  assert.equal(groups[0].project, null);
  assert.equal(groups[1].path, '/b');
  assert.deepEqual([...groups[1].nested], ['child']);
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
