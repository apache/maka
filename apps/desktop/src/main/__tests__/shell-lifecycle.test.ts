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
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import type { ConnectionEvent } from '@maka/core/connections';
import type { SessionChangedEvent } from '@maka/core/session';
import {
  createShellLifecycleHandlers,
  ShellLifecycleSourcesProvider,
  ShellLifecycleSubscriptions,
  type ShellLifecycleHandlers,
  type ShellLifecycleSources,
  type ShellRuntimeHostChange,
  type ShellWindowCommand,
} from '../../renderer/application/contracts/shell-lifecycle.js';
import {
  createSessionCatalogController,
  SessionCatalogContext,
} from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import { createDesktopShellLifecycleSources } from '../../renderer/platform/desktop/create-shell-lifecycle-sources.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

function fakeSources() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  const on = (name: string) => <E>(handler: (event: E) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler as (event: never) => void);
    listeners.set(name, set);
    return () => { set.delete(handler as (event: never) => void); };
  };
  let tagged = 0;
  let untagged = 0;
  const sources: ShellLifecycleSources = {
    tagDocumentPlatform: () => { tagged += 1; return () => { untagged += 1; }; },
    subscribeWindowCommands: on('window'),
    subscribeConnectionEvents: on('connections'),
    subscribeRuntimeHostChanges: on('hosts'),
    subscribeClientSettingsChanges: on('client'),
    subscribeExternalSettingsChanges: on('external'),
  };
  const emit = (name: string, event?: unknown) =>
    [...(listeners.get(name) ?? [])].forEach((handler) => (handler as (event?: unknown) => void)(event));
  const live = () => [...listeners.values()].reduce((total, set) => total + set.size, 0);
  return { sources, emit, live, tags: () => [tagged, untagged] };
}

test('one subscriber routes each Desktop event to the shell\'s latest handler', async () => {
  const { sources, emit, live, tags } = fakeSources();
  let sessionListener: ((event: SessionChangedEvent) => void) | undefined;
  const catalog = createSessionCatalogController({
    list: async () => [],
    subscribeChanges(handler) {
      sessionListener = handler;
      return () => { sessionListener = undefined; };
    },
  });
  const calls: string[] = [];
  const handlers = (generation: number): ShellLifecycleHandlers => ({
    onWindowCommand: (command) => calls.push(`${generation}:window:${command.id}`),
    onConnectionEvent: (event) => calls.push(`${generation}:connection:${event.type}`),
    onRuntimeHostChange: (event) => calls.push(`${generation}:host:${event.readiness}`),
    onClientSettingsChanged: () => calls.push(`${generation}:client`),
    onExternalSettingsChanged: () => calls.push(`${generation}:external`),
    onSessionChange: (event) => calls.push(`${generation}:session:${event.sessionId}`),
  });
  const render = (generation: number) => createElement(SessionCatalogContext.Provider, { value: catalog, children:
    createElement(ShellLifecycleSourcesProvider, { value: sources, children:
      createElement(ShellLifecycleSubscriptions, handlers(generation)) }) });
  const { root } = installReactRenderer();
  await act(async () => root.render(render(1)));
  assert.deepEqual([live(), Boolean(sessionListener), tags()], [5, true, [1, 0]]);
  await act(async () => root.render(render(2)));
  assert.deepEqual([live(), tags()], [5, [1, 0]], 'a new render does not resubscribe');
  emit('window', { id: 'newTask' } satisfies ShellWindowCommand);
  emit('connections', { type: 'connection_list_changed' } as ConnectionEvent);
  emit('hosts', { readiness: 'ready', isDefault: true } satisfies ShellRuntimeHostChange);
  emit('client');
  emit('external');
  sessionListener?.({ sessionId: 'a', reason: 'updated', ts: 1 } as SessionChangedEvent);
  assert.deepEqual(calls, [
    '2:window:newTask', '2:connection:connection_list_changed', '2:host:ready',
    '2:client', '2:external', '2:session:a',
  ]);
  await act(async () => root.unmount());
  assert.deepEqual([live(), Boolean(sessionListener), tags()], [0, false, [1, 1]]);
});

test('Desktop supplies the lifecycle events and tags the document; the effects reach no bridge', async () => {
  const subscribed: string[] = [];
  const attributes: Array<[string, string]> = [];
  const listen = (name: string) => () => { subscribed.push(name); return () => {}; };
  const sources = createDesktopShellLifecycleSources({
    app: { info: async () => ({ platform: 'darwin' }) },
    appWindow: { subscribeCommand: listen('window') },
    connections: { subscribeEvents: listen('connections') },
    runtimeHostProfiles: { subscribeChanges: listen('hosts') },
    settings: { subscribeClientChanged: listen('client'), subscribeExternalChanged: listen('external') },
  } as unknown as Parameters<typeof createDesktopShellLifecycleSources>[0], {
    setAttribute: (name: string, value: string) => { attributes.push([name, value]); },
  });
  sources.subscribeWindowCommands(() => {});
  sources.subscribeConnectionEvents(() => {});
  sources.subscribeRuntimeHostChanges(() => {});
  sources.subscribeClientSettingsChanges(() => {});
  sources.subscribeExternalSettingsChanges(() => {});
  assert.deepEqual(subscribed, ['window', 'connections', 'hosts', 'client', 'external']);
  sources.tagDocumentPlatform();
  sources.tagDocumentPlatform()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attributes, [['data-os', 'darwin']], 'a cancelled tag never writes');
  const effects = readFileSync(fileURLToPath(new URL('../../../src/renderer/app-shell-effects.ts', import.meta.url)), 'utf8');
  assert.deepEqual(effects.split('\n').filter((line) => /\bwindow\.maka\b/.test(line)), []);
});

test('AppShell itself reaches no Desktop bridge path', () => {
  const shell = readFileSync(fileURLToPath(new URL('../../../src/renderer/app-shell.tsx', import.meta.url)), 'utf8');
  assert.deepEqual(shell.split('\n').filter((line) => /\bwindow\.maka\b/.test(line)), []);
});

test('the shell reacts to each lifecycle event with the same refreshes as before', async () => {
  const calls: string[] = [];
  const record = (name: string) => () => { calls.push(name); return Promise.resolve(); };
  const handlers = createShellLifecycleHandlers({
    uiLocale: 'en',
    activeIdRef: { current: undefined },
    clearPendingTurnActionsForSession: () => {},
    createSession: () => { calls.push('createSession'); },
    handleConnectionEvent: (event) => { calls.push(`connection:${event.type}`); },
    openHelp: () => { calls.push('openHelp'); },
    openSettings: () => { calls.push('openSettings'); },
    refreshConnections: record('refreshConnections'),
    refreshMemoryActive: record('refreshMemoryActive'),
    refreshMessages: async () => true,
    refreshProjects: record('refreshProjects'),
    refreshShellSettings: record('refreshShellSettings'),
    refreshSessions: async () => { calls.push('refreshSessions'); return []; },
    refreshChangedSession: async (sessionId) => { calls.push(`refreshChangedSession:${sessionId}`); },
    retireSession: (sessionId) => { calls.push(`retire:${sessionId}`); },
    retiredSessionIds: () => ['gone'],
    isSessionRemoved: () => false,
    sessionsRef: { current: [] },
    recordSessionChange: () => {},
    toastApi: { info() {} },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  for (const id of ['newTask', 'openSettings', 'openHelp'] as const) handlers.onWindowCommand({ id });
  handlers.onConnectionEvent({ type: 'connection_list_changed' } as ConnectionEvent);
  handlers.onClientSettingsChanged();
  handlers.onExternalSettingsChanged();
  handlers.onSessionChange({ sessionId: 'a', reason: 'updated', ts: 1 } as SessionChangedEvent);
  await settle();
  assert.deepEqual(calls.splice(0), [
    'createSession', 'openSettings', 'openHelp', 'connection:connection_list_changed',
    'refreshShellSettings', 'refreshShellSettings', 'refreshConnections', 'refreshChangedSession:a',
  ]);
  handlers.onRuntimeHostChange({ readiness: 'connecting', isDefault: true });
  await settle();
  assert.deepEqual(calls.splice(0), ['refreshSessions', 'retire:gone'], 'a Host that is not ready only refreshes Sessions');
  handlers.onRuntimeHostChange({ readiness: 'ready', isDefault: true });
  await settle();
  assert.deepEqual(calls.splice(0), [
    'refreshSessions', 'refreshShellSettings', 'refreshConnections', 'refreshProjects', 'refreshMemoryActive', 'retire:gone',
  ]);
});

test('a composition without the lifecycle sources fails instead of going quiet', () => {
  const { root } = installReactRenderer();
  const handler = () => {};
  const catalog = createSessionCatalogController({ list: async () => [], subscribeChanges: () => () => {} });
  assert.throws(() => act(() => root.render(createElement(SessionCatalogContext.Provider, { value: catalog, children:
    createElement(ShellLifecycleSubscriptions, {
      onWindowCommand: handler, onConnectionEvent: handler, onRuntimeHostChange: handler,
      onClientSettingsChanged: handler, onExternalSettingsChanged: handler, onSessionChange: handler,
    }) }))), /ShellLifecycleSourcesProvider is missing/);
});
