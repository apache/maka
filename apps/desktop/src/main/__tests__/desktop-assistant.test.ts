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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IpcMain, WebContents } from 'electron';
import { createDefaultSettings } from '@maka/core/settings';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { createDesktopAssistant } from '../desktop-assistant.js';
import { ASSISTANT_RETENTION_MS, DesktopAssistantState } from '../desktop-assistant-state.js';

test('assistant retention removes only expired owned sessions on the connected Host', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = new DesktopAssistantState(join(directory, 'state.json'));
  const now = 2 * ASSISTANT_RETENTION_MS;
  for (const id of ['expired', 'active', 'recent-host-activity', 'renamed-label', 'protected']) await state.touch('host', id, 1);
  await state.touch('host', 'recent', now - 1);
  await state.touch('disconnected-host', 'remote', 1);
  const queried: string[] = [];
  const removed: string[] = [];
  const client = {
    hostId: 'host',
    getSession: async (id: string) => {
      queried.push(id);
      return {
        id, labels: id === 'renamed-label' ? [] : ['mode:desktop_assistant'],
        activityAt: id === 'recent-host-activity' ? now : 1,
        ...(id === 'active' ? { liveRunState: {} } : {}),
      } as unknown as SessionCatalogProjection;
    },
    removeSession: async (id: string) => { removed.push(id); return { disposition: 'removed' as const, archivedSubtaskCount: 0 }; },
  };
  assert.deepEqual(await state.cleanup(client, 'protected', now), ['expired']);
  assert.deepEqual(removed, ['expired']);
  assert.equal(queried.includes('recent'), false);
  assert.equal(queried.includes('remote'), false);
  assert.equal(queried.includes('protected'), false);
  const reopened = new DesktopAssistantState(join(directory, 'state.json'));
  assert.deepEqual(await reopened.cleanup(client, 'protected', now), []);
});

test('assistant model preferences survive restart and stay scoped to their Host', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const state = new DesktopAssistantState(path);
  const selected = { connectionId: 'connection', connectionSlug: 'provider', model: 'model' };
  await state.selectModel('host', selected);
  const reopened = new DesktopAssistantState(path);
  assert.deepEqual(await reopened.model('host'), selected);
  assert.equal(await reopened.model('another-host'), undefined);
});

test('assistant IPC rejects other renderers and its tool rejects unowned Sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let command!: Parameters<IpcMain['handle']>[1];
  const frame = {};
  const window = { mainFrame: frame } as WebContents;
  const assistant = createDesktopAssistant({
    ipcMain: { handle: (_channel: string, handler: typeof command) => { command = handler; } } as IpcMain,
    statePath: join(directory, 'state.json'),
    window: () => window,
    readSettings: async () => createDefaultSettings(),
    host: async () => { throw new Error('No Host should be contacted'); },
    clients: () => [],
    isCurrent: () => false,
  });
  t.after(() => assistant.close());
  await assert.rejects(command({ sender: {}, senderFrame: frame } as Electron.IpcMainInvokeEvent, 'snapshot'), /main window/);
  await assert.rejects(command({ sender: window, senderFrame: {} } as Electron.IpcMainInvokeEvent, 'submit', 'change language'), /main window/);
  const entry = assistant.group.tools[0]!;
  const tool = 'tool' in entry ? entry.tool : entry;
  await assert.rejects(async () => tool.impl({ operation: 'act', actions: [{ kind: 'set', target: 'language', value: 'en' }] }, {
    sessionId: 'ordinary-session', turnId: 'turn', toolCallId: 'call', cwd: directory,
    abortSignal: new AbortController().signal, emitOutput() {},
  }), /No active request owns/);
});
