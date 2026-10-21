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
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { createSessionWindowCommandHandler, createSessionWindowNavigator, bootstrapSessionWindow } from '../../renderer/features/session-windows/testing.js';
import { markNewTaskReloadIntent, clearNewTaskReloadIntent } from '../../renderer/application/contracts/new-task-reload-intent.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { createConversationWorkspace, stubConversationServices } from '../../renderer/features/conversation/testing.js';

const group = { hostId: 'host', groupId: 'A', sessionIds: ['A', 'child'] };
function readableSessions() {
  return ['A', 'B', 'child'].map((id) => ({ id, name: id, isFlagged: false, isArchived: false, labels: [], lastMessageAt: 1,
    hasUnread: false, status: 'active' as const, backend: 'ai-sdk' as const, revision: 1, runtimeHostId: 'local', profileId: 'local', profileName: 'Local',
    llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' as const, profileKind: 'local' as const }));
}

test('local ownership navigates synchronously; unknown or foreign sessions never mount locally', () => {
  const routed: string[] = []; const selected: string[] = [];
  let blocked = false;
  const open = createSessionWindowNavigator({ owns: (id) => id === 'A', route: ({ sessionId }) => { routed.push(sessionId); }, blocked: () => blocked });
  assert.equal(open({ sessionId: 'A' }, () => selected.push('A')), true);
  assert.deepEqual(selected, ['A']);
  assert.equal(open({ sessionId: 'child' }, () => selected.push('child')), false);
  assert.deepEqual(routed, ['child']); assert.deepEqual(selected, ['A']);
  blocked = true; assert.equal(open({ sessionId: 'A' }, () => selected.push('A')), false);
  assert.deepEqual(selected, ['A']);
});

test('suspending the family cancels a pending source publication without removing unrelated B', () => {
  const catalog = createSessionCatalogController(); catalog.commitSessions(readableSessions());
  const workspace = createConversationWorkspace(catalog, stubConversationServices().observation, false);
  workspace.commands.setActiveId('B');
  const messages = [{ id: 'b', type: 'user' as const, text: 'B', ts: 1, turnId: 'b' }];
  workspace.commitTranscript('B', messages);
  workspace.commands.setActiveId('A'); const ownsA = workspace.commands.captureSelection();
  const handler = createSessionWindowCommandHandler({
    freeze() {}, activeSessionId: () => workspace.activeIdRef.current,
    capture: () => [], hasUnsent: () => false, clear() {}, restore() {}, navigate() {},
    suspend: (ids) => { for (const id of ids) workspace.commands.clearOwnedSessionState(id); },
  });
  handler.execute({ kind: 'prepare', requestId: '1', transferId: 'transfer', group });
  assert.equal(ownsA(), false); assert.equal(catalog.getState().activeSessionId, 'B');
  assert.equal(workspace.commitTranscript('A', []), false); assert.deepEqual(workspace.messages.getSnapshot(), messages);
});

test('stale aborts cannot cancel a later transfer, and deletion cannot resurrect a parked source', () => {
  let active: string | undefined = 'A'; const cleared: string[] = [];
  const handler = createSessionWindowCommandHandler({ freeze() {}, activeSessionId: () => active,
    capture: () => [], hasUnsent: () => false, clear: (ids) => { cleared.push(...ids); }, restore() {},
    navigate: ({ sessionId }) => { active = sessionId; }, suspend: () => { active = undefined; },
  });
  handler.execute({ kind: 'prepare', requestId: '1', transferId: 'current', group });
  handler.execute({ kind: 'abort', requestId: '2', transferId: 'old' }); assert.equal(active, undefined);
  handler.deleted('A'); handler.execute({ kind: 'abort', requestId: '3', transferId: 'current' });
  assert.equal(active, undefined); assert.deepEqual(cleared, ['A']);
});

test('window bootstrap preserves an explicit new-task reload intent before and during catalog loading', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    const selected: string[] = [];
    const input = { kind: 'main' as const, refresh: async () => readableSessions(), revision: () => 0, open: (id: string) => { selected.push(id); } };
    markNewTaskReloadIntent();
    await bootstrapSessionWindow(input);
    assert.deepEqual(selected, []);
    clearNewTaskReloadIntent();
    const refresh = deferred<ReturnType<typeof readableSessions>>();
    const boot = bootstrapSessionWindow({ ...input, refresh: () => refresh.promise });
    markNewTaskReloadIntent();
    refresh.resolve(readableSessions());
    await boot;
    assert.deepEqual(selected, []);
    clearNewTaskReloadIntent();
    await bootstrapSessionWindow(input);
    assert.deepEqual(selected, ['A'], 'cold main windows still select history');
    await bootstrapSessionWindow({ ...input, kind: 'session' });
    assert.deepEqual(selected, ['A'], 'session windows never choose recent history');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
