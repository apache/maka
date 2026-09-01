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
  } as unknown as MakaBridge;
  const services = createDesktopConversationServices(bridge);

  await services.sessions.readSnapshot('source');
  assert.deepEqual(await services.sessions.list(), []);
  assert.deepEqual(calls, ['snapshot:source']);
});
