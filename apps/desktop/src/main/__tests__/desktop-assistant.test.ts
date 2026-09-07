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
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IpcMain, WebContents } from 'electron';
import { createDefaultSettings } from '@maka/core/settings';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { createDesktopAssistant } from '../desktop-assistant.js';
import { ASSISTANT_RETENTION_MS, DesktopAssistantState } from '../desktop-assistant-state.js';
import { DesktopAssistantSurface } from '../desktop-assistant-surface.js';
import { DesktopAssistantUi } from '../desktop-assistant-ui.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';
import type { DesktopRuntimeHostClient } from '../runtime-host-client.js';

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

test('observations exclude browser, terminal and secret descendants and reject replaced or stale handles', async () => {
  const surface = new DesktopAssistantSurface();
  const metadata = { ref: 'fresh', name: 'Rename', role: '', tag: 'button', type: '', section: '', navigation: false, external: false, editable: false };
  let preparing = true;
  let backend = 2;
  const ax = (id: number, name: string, role = 'button') => ({ nodeId: String(id), backendDOMNodeId: id, name: { value: name }, role: { value: role } });
  const wc = {
    executeJavaScript: async () => preparing ? [{ ...metadata }] : true,
    debugger: { sendCommand: async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: backend } };
      return { nodes: [ax(2, 'Rename')] };
    } },
  } as unknown as WebContents;
  await surface.prepare(wc);
  const result = surface.filter({ nodeName: 'HTML', backendNodeId: 1, children: [
    { nodeName: 'BUTTON', backendNodeId: 2, attributes: ['data-maka-assistant-ref', 'fresh'] },
    { nodeName: 'DIV', backendNodeId: 3, attributes: ['data-maka-assistant-exclude', ''], children: [{ nodeName: 'BUTTON', backendNodeId: 4 }] },
    { nodeName: 'IFRAME', backendNodeId: 5, children: [{ nodeName: 'BUTTON', backendNodeId: 6 }] },
    { nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password'] },
    { nodeName: 'DIV', backendNodeId: 8, attributes: ['class', 'xterm'], children: [{ nodeName: 'BUTTON', backendNodeId: 9 }] },
  ] }, { nodes: [ax(2, 'Rename'), ...[3, 4, 5, 6, 7, 8, 9].map((id) => ax(id, 'excluded content'))] });
  assert.equal(JSON.stringify(result).includes('excluded content'), false);
  assert.deepEqual(surface.list().map((entry) => entry.name), ['Rename']);
  preparing = false;
  assert.equal((await surface.resolve(wc, 'fresh', 'click')).name, 'Rename');
  await assert.rejects(surface.resolve(wc, 'fresh', 'type'), /not an editable/);
  await assert.rejects(surface.resolve(wc, 'fresh', 'key'), /requires an editor/);
  backend = 20;
  await assert.rejects(surface.resolve(wc, 'fresh', 'click'), /replaced/);
  preparing = true;
  await surface.prepare(wc);
  await assert.rejects(surface.resolve(wc, 'fresh', 'click'), /Stale/);
});

test('hiding keeps ownership; recovery is bounded, reports dispatched input, and stops on takeover', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-assistant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let command!: Parameters<IpcMain['handle']>[1];
  let sessionId = '';
  let stops = 0;
  let attempts = 0;
  let observations = 0;
  let mode: 'before' | 'after' | 'success' = 'before';
  const outcomes: ('before' | 'after' | 'success')[] = [];
  const frame = {};
  const window = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: () => false, send() {} }) as unknown as WebContents;
  const client = {
    hostId: 'host',
    loadConnectionCatalog: async () => ({ revision: 1, defaultTarget: { connectionId: 'c', modelId: 'm' }, connections: [{ connectionId: 'c', revision: 1, slug: 'provider', name: 'Provider', providerType: 'openai-compatible', enabled: true, enabledModelIds: ['m'], models: [{ id: 'm' }], catalogEntries: [{ id: 'm', canUseAsChatDefault: true, isDefault: true, thinkingLevels: [] }] }] }),
    createSession: async (input: { sessionId: string }) => { sessionId = input.sessionId; },
    submitMessage: async () => ({ disposition: 'accepted' }),
  } as unknown as DesktopRuntimeHostClient;
  t.mock.method(DesktopAssistantUi.prototype, 'observe', async () => { observations++; return { section: null, language: 'en', theme: 'light', accessibility: '', controls: [] }; });
  t.mock.method(DesktopAssistantUi.prototype, 'begin', async () => {});
  t.mock.method(RuntimeHostSessionObserver.prototype, 'observe', async () => {});
  t.mock.method(DesktopAssistantUi.prototype, 'execute', async function(this: DesktopAssistantUi) {
    attempts++;
    const outcome = outcomes.shift() ?? mode;
    if (outcome === 'after') this.dispatchedInputs++;
    if (outcome !== 'success') throw new Error('Control changed');
    return { verified: false, dispatched: true };
  });
  const assistant = createDesktopAssistant({
    ipcMain: { handle: (_channel: string, handler: typeof command) => { command = handler; } } as IpcMain,
    statePath: join(directory, 'state.json'), window: () => window, readSettings: async () => createDefaultSettings(),
    host: async () => ({ client, workspace: { kind: 'host_path', path: directory }, stop: async () => { stops++; } }), clients: () => [], isCurrent: () => true,
  });
  t.after(() => assistant.close());
  const event = { sender: window, senderFrame: frame } as Electron.IpcMainInvokeEvent;
  await command(event, 'submit', 'Operate the app');
  assert.ok(sessionId);
  await command(event, 'close');
  assert.equal(stops, 0);
  const entry = assistant.group.tools[0]!;
  const tool = 'tool' in entry ? entry.tool : entry;
  const act = async (refs = ['current']) => await tool.impl({ operation: 'act', actions: refs.map((ref) => ({ kind: 'click', ref })) }, { sessionId, turnId: 'turn', toolCallId: 'call', cwd: directory, abortSignal: new AbortController().signal, emitOutput() {} }) as { completed: unknown[]; recoverable?: boolean; inputDispatched?: boolean; requiresNewRequest?: boolean };
  outcomes.push('success', 'before');
  const partial = await act(['first', 'changed', 'last']);
  assert.equal(partial.completed.length, 1);
  assert.equal(partial.recoverable, true);
  assert.equal(attempts, 2, 'a changed control stops the remainder of a batch');
  mode = 'success';
  const beforeBatchObservation = observations;
  assert.equal((await act(['changed', 'last'])).completed.length, 2);
  assert.equal(attempts, 4, 'recovery does not repeat the completed first action');
  assert.equal(observations, beforeBatchObservation + 1, 'a successful batch needs one result observation');
  mode = 'before';
  const beforeFailure = attempts;
  assert.deepEqual(await act().then(({ recoverable, inputDispatched }) => ({ recoverable, inputDispatched })), { recoverable: true, inputDispatched: false });
  assert.equal(attempts, beforeFailure + 1, 'the controller must not blindly repeat an action');
  mode = 'after';
  assert.equal((await act()).inputDispatched, true);
  mode = 'success';
  await act();
  mode = 'before';
  assert.equal((await act()).recoverable, true);
  assert.equal((await act()).recoverable, true);
  assert.equal((await act()).recoverable, false);
  const exhausted = attempts;
  assert.equal((await act()).requiresNewRequest, true);
  assert.equal(attempts, exhausted);
  assert.equal((await command(event, 'snapshot')).open, false);
  await command(event, 'stop');
  assert.equal(stops, 1);
  await assert.rejects(act(), /No active request owns/);
  await command(event, 'submit', 'Wait for the task reply');
  const waiting = assert.rejects(async () => tool.impl({ operation: 'observe', waitMs: 5000 }, { sessionId, turnId: 'turn', toolCallId: 'wait', cwd: directory, abortSignal: new AbortController().signal, emitOutput() {} }), /abort/i);
  await command(event, 'stop');
  await waiting;
  assert.equal(attempts, exhausted, 'waiting and cancellation must not dispatch more input');
});

test('native input passes through only the assistant and restores hit testing after failure', async () => {
  let passing = false;
  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      if (script.includes('getBoundingClientRect')) return { x: 20, y: 20 };
      if (script.startsWith('!!document.querySelector')) return true;
      if (script.includes("classList.add('desktopAssistantInput')")) passing = true;
      if (script.includes("classList.remove('desktopAssistantInput')")) passing = false;
    },
    sendInputEvent: (event: { type: string }) => {
      assert.equal(passing, true);
      if (event.type === 'mouseDown') throw new Error('Injected input failure');
    },
  } as unknown as WebContents;
  const ui = new DesktopAssistantUi(() => wc, async () => createDefaultSettings(), () => {}, async () => '');
  await assert.rejects(ui.execute({ kind: 'navigate', section: 'general' }, new AbortController().signal), /Injected input failure/);
  assert.equal(passing, false);
});
