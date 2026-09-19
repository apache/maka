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
import { afterEach, test } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  SessionSettingsProvider,
  SessionSettingsServicesProvider,
  useSessionSettingIntent,
  type SessionSettingsServices,
} from '../../renderer/features/session-settings/index.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';

const model = { llmConnectionId: 'connection', llmConnectionSlug: 'openai', model: 'next' };
const session = (id: string) => ({ id, revision: 1, permissionMode: 'ask', ...model } as DesktopSessionSummary);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function services(overrides: Partial<SessionSettingsServices> = {}): SessionSettingsServices {
  return {
    getPlanState: async (sessionId) => ({ schemaVersion: 1, sessionId, storeVersion: 0, proposals: [], executions: [] }),
    setModelConfiguration: async (id, input) => ({ ...session(id), ...input, thinkingLevel: input.thinkingLevel ?? undefined, revision: 2 }),
    setPermissionMode: async (id, mode) => ({ ...session(id), permissionMode: mode, revision: 2 }),
    setOrchestrationMode: async (id, mode) => ({ ...session(id), orchestrationMode: mode, revision: 2 }),
    setCollaborationMode: async (id, mode) => ({ ...session(id), collaborationMode: mode, revision: 2 }),
    abandonPlanProposal: async () => {},
    ...overrides,
  };
}

afterEach(cleanupFakeDom);

async function mount(options: {
  services?: SessionSettingsServices;
  confirmBypass?: () => Promise<boolean>;
  confirmDiscard?: (title: string) => Promise<boolean>;
  strict?: boolean;
} = {}) {
  const { root } = installReactRenderer();
  let selected: string | undefined = 'a';
  let owner: { sessionId?: string } = { sessionId: selected };
  let snapshot!: ReturnType<typeof useSessionSettingIntent>;
  let renders = 0;
  let frameRenders = 0;
  const errors: unknown[] = [];
  const service = options.services ?? services();
  function Frame() { frameRenders += 1; return null; }
  function Shell() {
    renders += 1;
    snapshot = useSessionSettingIntent(selected);
    return createElement(SessionSettingsProvider, {
      bridge: snapshot.bridge,
      input: {
        catalogRevision: 0,
        sessions: [session('a'), session('b')],
        isActiveSession: (id) => id === selected,
        newSessionPermissionMode: 'ask',
        refreshCatalog: async () => {},
        saveComposerDefaults: () => {},
        writeFailureCopy: () => ({ title: 'failed', description: 'failed' }),
        showSessionError: (...args) => { errors.push(args); },
        planMode: {
          reportExecutionActive: (id) => { errors.push(['execution-active', id]); },
          confirmDiscard: options.confirmDiscard ?? (async () => true),
        },
        captureOwner: () => owner,
        isOwnerActive: (claim) => claim === owner,
        setNewTaskPermissionMode: () => {},
        confirmBypass: options.confirmBypass ?? (async () => true),
      },
    }, createElement(Frame));
  }
  const render = () => root.render(createElement(
    SessionSettingsServicesProvider, { services: service },
    options.strict ? createElement(StrictMode, null, createElement(Shell)) : createElement(Shell),
  ));
  await act(render);
  return {
    root, errors,
    current: () => snapshot,
    renders: () => renders,
    frameRenders: () => frameRenders,
    select: async (id: string | undefined) => {
      selected = id;
      owner = { sessionId: selected };
      await act(render);
    },
  };
}

test('inactive Session writes keep the shell and frame asleep; selection reads the right overlay immediately', async () => {
  const write = deferred<DesktopSessionSummary>();
  const h = await mount({ services: services({ setModelConfiguration: () => write.promise }) });
  const commands = h.current().commands;
  const initialRenders = h.renders();
  const initialFrames = h.frameRenders();
  let completion!: Promise<boolean>;
  await act(() => { completion = commands.setSessionModel('b', model); });
  assert.equal(h.renders(), initialRenders);
  assert.equal(h.frameRenders(), initialFrames);
  assert.equal(h.current().overlay.modelConfiguration, undefined);
  await act(async () => { write.resolve({ ...session('b'), thinkingLevel: undefined, revision: 2 }); await completion; });
  assert.equal(h.renders(), initialRenders);
  assert.equal(h.frameRenders(), initialFrames);
  await h.select('b');
  assert.equal(h.current().overlay.modelConfiguration?.modelTarget.model, 'next');
  assert.equal(h.current().commands, commands);
  await h.select('a');
  assert.equal(h.current().overlay.modelConfiguration, undefined);
  await act(() => h.root.unmount());
});

test('active optimistic state rolls back on failure through the same stable command port', async () => {
  const write = deferred<DesktopSessionSummary>();
  const h = await mount({ services: services({ setModelConfiguration: () => write.promise }) });
  const commands = h.current().commands;
  let completion!: Promise<boolean>;
  await act(() => { completion = commands.setSessionModel('a', model); });
  assert.equal(h.current().overlay.modelConfiguration?.modelTarget.model, 'next');
  let result = true;
  await act(async () => { write.reject(new Error('Host unavailable')); result = await completion; });
  assert.equal(result, false);
  assert.equal(h.current().overlay.modelConfiguration, undefined);
  assert.equal(h.current().commands, commands);
  assert.deepEqual(h.errors, [['a', 'failed', 'failed']]);
  await act(() => h.root.unmount());
});

test('a bypass confirmation cannot write after its captured selection owner changes', async () => {
  const confirmation = deferred<boolean>();
  const writes: unknown[] = [];
  const h = await mount({
    confirmBypass: () => confirmation.promise,
    services: services({ setPermissionMode: async (...args) => { writes.push(args); return session(args[0]); } }),
  });
  let completion!: Promise<boolean>;
  await act(() => { completion = h.current().commands.setPermissionMode('bypass'); });
  await h.select('b');
  let result = true;
  await act(async () => { confirmation.resolve(true); result = await completion; });
  assert.equal(result, false);
  assert.deepEqual(writes, []);
  await act(() => h.root.unmount());
});

test('clear retires an in-flight intent, and StrictMode cleanup disconnects retained commands', async () => {
  const write = deferred<DesktopSessionSummary>();
  let writes = 0;
  const h = await mount({ strict: true, services: services({ setModelConfiguration: () => { writes += 1; return write.promise; } }) });
  const commands = h.current().commands;
  let completion!: Promise<boolean>;
  await act(() => { completion = commands.setSessionModel('a', model); });
  assert.equal(writes, 1);
  await act(() => commands.clear('a'));
  assert.equal(await completion, false);
  assert.equal(h.current().overlay.modelConfiguration, undefined);
  await act(() => h.root.unmount());
  assert.equal(await commands.setSessionModel('b', model), false);
  await act(async () => write.resolve({ ...session('a'), thinkingLevel: undefined, revision: 2 }));
  assert.equal(writes, 1);
});

test('Plan discard remains bound to the requested Session while the user switches away', async () => {
  const confirmation = deferred<boolean>();
  const writes: unknown[] = [];
  const h = await mount({
    confirmDiscard: () => confirmation.promise,
    services: services({
      getPlanState: async (sessionId) => ({
        schemaVersion: 1, sessionId, storeVersion: 1, executions: [], latestProposalId: 'proposal-a',
        proposals: [{ proposalId: 'proposal-a', title: 'Original plan', status: 'pending_approval' } as never],
      }),
      abandonPlanProposal: async (...args) => { writes.push(args); },
      setCollaborationMode: async () => { assert.fail('abandon already leaves Plan'); },
    }),
  });
  let completion!: Promise<boolean>;
  await act(() => { completion = h.current().commands.setPlanMode('a', false); });
  await h.select('b');
  let result = false;
  await act(async () => { confirmation.resolve(true); result = await completion; });
  assert.equal(result, true);
  assert.deepEqual(writes, [['a', 'proposal-a']]);
  assert.equal(h.current().overlay.planMode, undefined);
  await act(() => h.root.unmount());
});
