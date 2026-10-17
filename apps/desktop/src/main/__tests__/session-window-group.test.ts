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
import { SessionWindowGroups, type WindowGroupSession } from '../session-window-group.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
const key = (id: string, hostId = 'host') => desktopSessionKey({ hostId, sessionId: id });
const parent = (parentSessionId: string): WindowGroupSession['subagentParent'] => ({ kind: 'subagent', parentSessionId, lifecycle: 'foreground', spawnedBy: { parentRunId: 'run', parentTurnId: 'turn', toolCallId: 'call' } });
const row = (id: string, extra: Partial<WindowGroupSession> = {}): WindowGroupSession => ({ id, labels: [], ...extra });

test('session windows group nested subagents, revisions and side conversations while keeping ordinary branches separate', () => {
  const groups = new SessionWindowGroups();
  const sessions = [row('root'), row('root-v2', { revisionRootSessionId: 'root' }),
    row('child', { subagentParent: parent('root-v2') }),
    row('grandchild', { subagentParent: parent('child') }),
    row('side', { parentSessionId: 'root', labels: ['mode:side_conversation'] }),
    row('branch', { parentSessionId: 'root' })];
  const group = groups.resolve(key('grandchild'), sessions);
  assert.equal(group.groupId, key('root'));
  assert.deepEqual(group.sessionIds, ['child', 'grandchild', 'root', 'root-v2', 'side'].map((id) => key(id)));
  assert.deepEqual(groups.resolve(key('branch'), sessions).sessionIds, [key('branch')]);
});

test('deleting a root preserves its open family and equal IDs on different Hosts remain independent', () => {
  const groups = new SessionWindowGroups();
  const child = row('child', { subagentParent: parent('root') });
  const original = groups.resolve(key('child'), [row('root'), child]);
  assert.deepEqual(groups.resolve(key('child'), [child]), original);
  assert.equal(groups.resolve(key('child', 'other'), [row('child')]).groupId, key('child', 'other'));
});

test('missing parents retain a stable family and corrupt cyclic ancestry terminates deterministically', () => {
  const groups = new SessionWindowGroups();
  const rows = [row('a', { subagentParent: parent('b') }), row('b', { subagentParent: parent('a') })];
  assert.deepEqual(groups.resolve(key('a'), rows), groups.resolve(key('b'), rows));
  assert.throws(() => groups.resolve(key('unknown'), []), /unavailable/);
});
