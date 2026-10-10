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
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopConversationServices } from '../../renderer/platform/desktop/create-conversation-services.js';

test('Desktop conversation adapter keeps snapshot reads and catalog access on the bridge', async () => {
  const calls: string[] = [];
  const bridge = {
    sessionLocal: {
      listMessages: async () => [],
      cancelMessage: async () => undefined,
      reconcileMessage: async () => undefined,
      subscribeChanges: () => () => undefined,
    },
    sessions: {
      list: async () => [],
      subscribeChanges: () => () => undefined,
      readSnapshot: async (sessionId: string) => {
        calls.push(`snapshot:${sessionId}`);
        return {};
      },
    },
    skills: { listInvocable: async () => [] },
    workspace: { searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }) },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false as const, reason: 'no_project' as const }),
    },
    mcp: { subscribeChanges: () => () => undefined },
    runtimeHostProfiles: {
      subscribeChanges: () => {
        calls.push('host-changes');
        return () => undefined;
      },
    },
  } as unknown as MakaBridge;
  const services = createDesktopConversationServices(bridge);

  await services.sessions.readSnapshot('source');
  services.runtimeHosts.subscribeChanges(() => undefined);
  assert.deepEqual(calls, ['snapshot:source', 'host-changes']);
});


test('prompt suggestion preferences observe cross-renderer changes and unsubscribe', () => {
  const events = new EventTarget();
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    const port = createDesktopConversationServices({} as MakaBridge).promptSuggestions!;
    let observed = false;
    let updates = 0;
    const unsubscribe = port.subscribeEnabled!(() => { observed = port.readEnabled(); updates++; });
    const notify = (key: string | null) => {
      const event = new Event('storage'); Object.defineProperty(event, 'key', { value: key }); events.dispatchEvent(event);
    };
    port.writeEnabled(true); notify('maka.promptSuggestions.enabled');
    assert.equal(observed, true);
    port.writeEnabled(false); notify('maka.promptSuggestions.enabled');
    assert.equal(observed, false);
    notify('unrelated'); assert.equal(updates, 2);
    notify(null); assert.equal(updates, 3);
    unsubscribe(); notify(null); assert.equal(updates, 3);
  } finally {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
