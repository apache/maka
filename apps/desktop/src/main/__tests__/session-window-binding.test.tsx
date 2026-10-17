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
import { act, useState, type ComponentProps } from 'react';
import { deferred } from '@maka/core/test-only/async-primitives';
import { LocaleProvider, ToastProvider, type ComposerHandle } from '@maka/ui';
import type { SessionWindowCommand, SessionWindowCommandReply, SessionWindowOwnership } from '../../shared/session-window-contract.js';
import { SessionWindowBinding, SessionWindowRoot, SessionWindowServicesProvider, type SessionWindowServices, type SessionWindowProjection } from '../../renderer/features/session-windows/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

type BindingProps = ComponentProps<typeof SessionWindowBinding>;
const group = { hostId: 'host', groupId: 'a', sessionIds: ['a', 'child'] };
async function mountBinding() {
  const { root } = installReactRenderer();
  let command!: (command: SessionWindowCommand) => void;
  let ownership!: (snapshot: SessionWindowOwnership) => void;
  let deleted!: (id: string) => void;
  const replies: SessionWindowCommandReply[] = [];
  const drafts = new Map([['a', 'keep A'], ['child', 'keep child'], ['b', 'keep B']]);
  const state = { active: 'a' as string | undefined, frozen: false, inputPending: false, staged: new Set<string>(), edits: new Set<string>(), sideContent: new Set<string>(), unavailable: false };
  let select!: (id: string | undefined) => void;
  const services: SessionWindowServices = {
    context: async () => ({ kind: 'main', windowId: 'main' }), ownership: async () => ({ version: 0, sessionIds: ['a', 'child', 'b'] }),
    subscribeSessionWindowOwnership: (handler) => { ownership = handler; return () => {}; },
    routeSession: async () => {}, openSessionWindow: async () => {}, openInMainWindow: async () => {}, sessionWindowReady: async () => {},
    subscribeSessionWindowCommand: (handler) => { command = handler; return () => {}; },
    ackSessionWindowCommand: async (reply) => { replies.push(reply); },
    commandMain: async () => {}, subscribeDeleted: (handler) => { deleted = handler; return () => {}; },
  };
  const composer: ComposerHandle = {
    hasPendingAction: () => state.inputPending,
    captureDrafts: (ids) => ids.map((id) => ({ draftKey: id, text: drafts.get(id) ?? '', references: [] })),
    restoreDrafts: (items) => { if (state.unavailable) throw new Error('composer unavailable'); for (const draft of items) drafts.set(draft.draftKey, draft.text); },
    clearDraft: (id) => { drafts.delete(id); },
    setText() {}, appendText() {}, getText: () => '', setDraft() {}, getDraft: () => '', captureEmptyDraft: () => undefined, appendDraft() {}, focus() {}, openModelPicker() {},
  };
  function Harness() {
    const [active, setActive] = useState<string | undefined>('a'); const [frozen, setFrozen] = useState(false);
    select = setActive; state.active = active; state.frozen = frozen;
    const window: BindingProps['window'] = {
      frameProps: { 'data-window-kind': 'main', inert: frozen || undefined },
      titlebarProps: { standalone: false, returningToMain: false, onOpenInMainWindow() {} }, standalone: false, setFrozen,
      bootstrap: async () => {}, openSession: () => true, openInNewWindow: async () => {}, mainActions: (local) => local, requestNewTask: (local) => local(),
    };
    return <SessionWindowServicesProvider value={services}>
      <SessionWindowBinding window={window}
        staging={{ hasPendingContext: (ids) => ids.some((id) => state.staged.has(id)) }}
        submission={{ hasPendingEdit: (ids) => ids.some((id) => state.edits.has(id)) }}
        workbar={{ hasSessionContent: (ids) => ids.some((id) => state.sideContent.has(id)) }}
        conversation={{ composer: { current: composer }, readActiveSessionId: () => state.active,
          clearOwnedSessionState: (id) => { if (state.active === id) select(undefined); } }}
        openLocal={({ sessionId }) => select(sessionId)} clearLocal={() => {}} />
    </SessionWindowServicesProvider>;
  }
  await act(async () => root.render(<LocaleProvider locale="en"><Harness /></LocaleProvider>));
  return { state, drafts, replies,
    command: async (value: SessionWindowCommand) => { await act(async () => command(value)); return replies.at(-1)!; },
    ownership: async (version: number, sessionIds: string[]) => { await act(async () => ownership({ version, sessionIds })); },
    select: async (id: string) => { await act(async () => select(id)); },
    deleted: async (id: string) => { await act(async () => deleted(id)); },
  };
}
afterEach(cleanupFakeDom);

for (const blocked of ['inputPending', 'staged', 'edits', 'sideContent'] as const) {
  test(`handoff refuses ${blocked}, including content on a non-displayed family member`, async () => {
    const h = await mountBinding();
    if (blocked === 'inputPending') h.state.inputPending = true; else h.state[blocked].add('child');
    const reply = await h.command({ kind: 'prepare', requestId: '1', transferId: 'move', group });
    assert.equal(reply.ok, false); assert.equal(h.state.active, 'a'); assert.equal(h.state.frozen, false);
    assert.equal(h.drafts.get('a'), 'keep A'); assert.equal(h.drafts.get('child'), 'keep child');
    const closing = await h.command({ kind: 'check-close', requestId: '2', group });
    assert.equal(closing.ok && closing.result?.hasUnsent, true);
    await h.command({ kind: 'cancel-close', requestId: '3' });
    assert.equal(h.state.frozen, false);
  });
}

test('prepare parks the display while retaining drafts, abort restores it, and committed ownership releases only this family', async () => {
  const h = await mountBinding();
  assert.equal((await h.command({ kind: 'prepare', requestId: '1', transferId: 'first', group })).ok, true);
  assert.equal(h.state.active, undefined); assert.equal(h.state.frozen, true); assert.equal(h.drafts.get('a'), 'keep A');
  await h.command({ kind: 'abort', requestId: '2', transferId: 'first' });
  assert.equal(h.state.active, 'a'); assert.equal(h.state.frozen, false);
  await h.command({ kind: 'prepare', requestId: '3', transferId: 'second', group });
  await h.ownership(2, ['b']);
  assert.equal(h.drafts.has('a'), false); assert.equal(h.drafts.get('b'), 'keep B'); assert.equal(h.state.frozen, false);
});

test('target stages text without replacing B, rejects stale ownership, and activates only after commitment', async () => {
  const h = await mountBinding(); await h.select('b');
  await h.ownership(5, ['b']);
  await h.command({ kind: 'receive', requestId: '1', transferId: 'move', group,
    navigation: { sessionId: 'child' }, drafts: [{ sessionId: 'child', text: 'arriving', references: [] }] });
  assert.equal(h.state.active, 'b'); assert.equal(h.drafts.get('b'), 'keep B'); assert.equal(h.state.frozen, true);
  await h.ownership(4, ['a', 'child', 'b']); assert.equal(h.state.active, 'b');
  await h.ownership(6, ['a', 'child', 'b']);
  assert.equal(h.state.active, 'child'); assert.equal(h.drafts.get('child'), 'arriving'); assert.equal(h.state.frozen, false);
});

test('failed target adoption does not navigate, clear B or leave the main window frozen', async () => {
  const h = await mountBinding(); await h.select('b'); h.state.unavailable = true;
  const reply = await h.command({ kind: 'receive', requestId: '1', transferId: 'move', group,
    navigation: { sessionId: 'a' }, drafts: [{ sessionId: 'a', text: 'arriving', references: [] }] });
  assert.equal(reply.ok, false); assert.equal(h.state.active, 'b'); assert.equal(h.state.frozen, false); assert.equal(h.drafts.get('b'), 'keep B');
});

test('close detects hidden unsent content and cancellation leaves the original selection and drafts', async () => {
  const h = await mountBinding(); h.drafts.delete('a');
  const reply = await h.command({ kind: 'check-close', requestId: '1', group });
  assert.equal(reply.ok && reply.result?.hasUnsent, true); assert.equal(h.state.frozen, true);
  await h.command({ kind: 'cancel-close', requestId: '2' });
  assert.equal(h.state.active, 'a'); assert.equal(h.state.frozen, false); assert.equal(h.drafts.get('child'), 'keep child');
});

test('the initial ownership read cannot overwrite a newer pushed membership', async () => {
  const { root } = installReactRenderer(); const initial = deferred<SessionWindowOwnership>();
  let update!: (snapshot: SessionWindowOwnership) => void;
  let projection: SessionWindowProjection | undefined;
  const routes: string[] = []; const activated: string[] = [];
  const services: SessionWindowServices = {
    context: async () => ({ kind: 'main', windowId: 'main' }), ownership: () => initial.promise,
    subscribeSessionWindowOwnership: (handler) => { update = handler; return () => {}; },
    routeSession: async ({ sessionId }) => { routes.push(sessionId); },
    openSessionWindow: async () => {}, openInMainWindow: async () => {}, sessionWindowReady: async () => {},
    subscribeSessionWindowCommand: () => () => {}, ackSessionWindowCommand: async () => {}, commandMain: async () => {}, subscribeDeleted: () => () => {},
  };
  await act(async () => root.render(<LocaleProvider locale="en"><ToastProvider><SessionWindowServicesProvider value={services}>
    <SessionWindowRoot>{(value) => { projection = value; return null; }}</SessionWindowRoot>
  </SessionWindowServicesProvider></ToastProvider></LocaleProvider>));
  await act(async () => { update({ version: 2, sessionIds: ['b'] }); initial.resolve({ version: 1, sessionIds: ['a', 'b'] }); });
  assert.ok(projection);
  projection.openSession({ sessionId: 'a' }, () => activated.push('a'));
  assert.deepEqual(routes, ['a']); assert.equal(activated.length, 0);
  assert.equal(projection.openSession({ sessionId: 'b' }, () => activated.push('b')), true);
  assert.deepEqual(activated, ['b']);
});

for (const kind of ['main', 'session'] as const) {
  test(`${kind} window routes global actions and exposes its own frame controls`, async () => {
    const { root } = installReactRenderer();
    let projection!: SessionWindowProjection;
    const calls: string[] = [];
    const returning = deferred<void>();
    const services: SessionWindowServices = {
      context: async () => kind === 'main' ? { kind, windowId: 'main' } : { kind, windowId: 'child', group, initialSessionId: 'a' },
      ownership: async () => ({ version: 1, sessionIds: ['a', 'child'] }),
      subscribeSessionWindowOwnership: () => () => {},
      routeSession: async () => {}, openSessionWindow: async () => {}, openInMainWindow: () => returning.promise,
      sessionWindowReady: async () => {}, subscribeSessionWindowCommand: () => () => {},
      ackSessionWindowCommand: async () => {}, commandMain: async (command) => { calls.push(`main:${command}`); }, subscribeDeleted: () => () => {},
    };
    await act(async () => root.render(<LocaleProvider locale="en"><ToastProvider><SessionWindowServicesProvider value={services}>
      <SessionWindowRoot>{(value) => { projection = value; return null; }}</SessionWindowRoot>
    </SessionWindowServicesProvider></ToastProvider></LocaleProvider>));
    const actions = projection.mainActions({
      openHelp: () => calls.push('help'), openSettings: () => calls.push('settings'),
      openSettingsSection: (section) => calls.push(`section:${section}`), openExternalAgentSettings: () => calls.push('external-agent'),
    });
    await act(async () => {
      actions.openHelp(); actions.openSettings(); actions.openSettingsSection(); actions.openExternalAgentSettings();
      projection.requestNewTask(() => calls.push('new-task'));
    });
    assert.deepEqual(calls, kind === 'main' ? ['help', 'settings', 'section:undefined', 'external-agent', 'new-task']
      : ['main:openHelp', 'main:openSettings', 'main:openSettings', 'main:openSettings', 'main:newTask']);
    assert.equal(projection.frameProps['data-window-kind'], kind);
    assert.equal(projection.titlebarProps.standalone, kind === 'session');
    await act(() => projection.setFrozen(true)); assert.equal(projection.frameProps.inert, true);
    await act(() => projection.setFrozen(false)); assert.equal(projection.frameProps.inert, undefined);
    await act(() => projection.titlebarProps.onOpenInMainWindow()); assert.equal(projection.titlebarProps.returningToMain, true);
    await act(async () => returning.resolve()); assert.equal(projection.titlebarProps.returningToMain, false);
  });
}
