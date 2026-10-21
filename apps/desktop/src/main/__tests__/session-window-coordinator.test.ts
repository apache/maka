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
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import { createSessionWindowCoordinator, registerSessionWindowIpc } from '../session-window-coordinator.js';
import { createWorkspaceWindowRegistry } from '../workspace-window-registry.js';
import { createSessionWindowCommandHandler } from '../../renderer/features/session-windows/testing.js';
import type { SessionWindowCommand, SessionWindowContext, SessionWindowGroup, SessionWindowOwnership } from '../../shared/session-window-contract.js';

const group: SessionWindowGroup = { hostId: 'local', groupId: 'A', sessionIds: ['A', 'A-child', 'A-version'] };
const single = (id: string): SessionWindowGroup => ({ hostId: 'local', groupId: id, sessionIds: [id] });
function harness() {
  const registry = createWorkspaceWindowRegistry();
  const commands: { windowId: string; kind: SessionWindowCommand['kind'] }[] = [];
  const errors: unknown[] = [];
  const resources: string[] = [];
  const known = [group, single('B')];
  let nextId = 0;
  let failCreation = false;
  let failReceive: 'main' | 'session' | undefined;
  let failResources = false;
  let dropReply: SessionWindowCommand['kind'] | undefined;
  let transferGate: { entered(): void; wait: Promise<void> } | undefined;
  let confirmation: boolean | Error = false;
  let confirmations = 0;
  let quitting = false;
  let coordinator: ReturnType<typeof createSessionWindowCoordinator>;
  class FakeWindow extends EventEmitter {
    readonly id = String(++nextId);
    destroyed = false;
    focused = false;
    revealed = false;
    frozen = false;
    unsupported = false;
    active: string | undefined;
    readonly drafts = new Map<string, string>();
    readonly context: SessionWindowContext;
    handler = this.createHandler();
    private createHandler() { return createSessionWindowCommandHandler({
      activeSessionId: () => this.active,
      freeze: (value) => { this.frozen = value; },
      capture: (ids) => {
        if (this.unsupported) throw new Error('Send or clear staged content');
        return ids.map((sessionId) => ({ sessionId, text: this.drafts.get(sessionId) ?? '', references: [] }));
      },
      hasUnsent: (ids) => this.unsupported || ids.some((id) => Boolean(this.drafts.get(id)?.trim())),
      restore: (drafts) => { for (const draft of drafts) this.drafts.set(draft.sessionId, draft.text); },
      clear: (ids) => { for (const id of ids) this.drafts.delete(id); },
      navigate: ({ sessionId }) => { this.active = sessionId; },
      suspend: (ids) => { if (ids.includes(this.active ?? '')) this.active = undefined; },
    }); }
    resetRenderer() { this.drafts.clear(); this.active = undefined; this.handler = this.createHandler(); }
    readonly contents = Object.assign(new EventEmitter(), {
      id: Number(this.id), isDestroyed: () => this.destroyed,
      send: (channel: string, payload: SessionWindowCommand | SessionWindowOwnership) => {
        if (channel === 'session-window:ownership') {
          this.handler.ownershipChanged(new Set((payload as SessionWindowOwnership).sessionIds));
          return;
        }
        if (channel !== 'session-window:command') return;
        const command = payload as SessionWindowCommand;
        commands.push({ windowId: this.id, kind: command.kind });
        queueMicrotask(() => {
          if (this.destroyed) return;
          try {
            if (command.kind === 'receive' && this.context.kind === failReceive) {
              failReceive = undefined;
              throw new Error('receive failed');
            }
            const result = this.handler.execute(command);
            if (command.kind === dropReply) { dropReply = undefined; return; }
            coordinator.reply(this.contents as never, { requestId: command.requestId, ok: true, result });
          } catch (error) {
            coordinator.reply(this.contents as never, { requestId: command.requestId, ok: false, error: String(error) });
          }
        });
      },
    });
    get webContents() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }
    constructor(context: Omit<Extract<SessionWindowContext, { kind: 'session' }>, 'windowId'> | { kind: 'main' }) {
      super();
      this.context = { ...context, windowId: this.id };
      this.active = context.kind === 'main' ? 'A' : undefined;
    }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
    }
  }
  const windows: FakeWindow[] = [];
  function add(context: Omit<Extract<SessionWindowContext, { kind: 'session' }>, 'windowId'> | { kind: 'main' }) {
    const window = new FakeWindow(context);
    const controller = { browserWindow: () => window, reveal: () => { window.revealed = true; }, focus: () => { window.focused = true; } };
    registry.register({ context: window.context, window: window as never, controller: controller as never });
    windows.push(window);
    if (coordinator) coordinator.sessionWindowReady(window.contents as never);
    return { window, controller };
  }
  const main = add({ kind: 'main' }).window;
  coordinator = createSessionWindowCoordinator({
    windows: { registry, createSessionWindow: async (context: Parameters<typeof add>[0]) => {
      if (failCreation) throw new Error('creation failed');
      return add(context).controller;
    } } as never,
    signal: new AbortController().signal,
    ensureMainWindow: async () => { if (!registry.main()) add({ kind: 'main' }); },
    resolveGroup: async (id) => known.find((item) => item.sessionIds.includes(id)) ?? single(id),
    knownGroups: () => known,
    confirmClose: async () => { confirmations += 1; if (confirmation instanceof Error) throw confirmation; return confirmation; },
    transferResources: async ({ source, target }) => {
      resources.push(`${source?.id}->${target.id}`);
      if (transferGate) { const gate = transferGate; transferGate = undefined; gate.entered(); await gate.wait; }
      if (failResources) { failResources = false; throw new Error('resource transfer failed'); }
    },
    releaseResources: (sender) => { resources.push(`release:${sender.id}`); },
    isQuitting: () => quitting, onError: (error) => { errors.push(error); }, commandTimeoutMs: 30,
  });
  coordinator.sessionWindowReady(main.contents as never);
  return {
    coordinator, main, windows, commands, resources, errors, known,
    open: (id = 'A') => coordinator.openSessionWindow(main.contents as never, id),
    returnToMain: (window = windows.at(-1)!) => coordinator.openInMainWindow(window.contents as never),
    failCreation: () => { failCreation = true; },
    failReceive: (kind: 'main' | 'session') => { failReceive = kind; },
    failResources: () => { failResources = true; },
    dropReply: (kind: SessionWindowCommand['kind']) => { dropReply = kind; },
    gate: (value: NonNullable<typeof transferGate>) => { transferGate = value; },
    confirm: (value: boolean | Error) => { confirmation = value; },
    confirmations: () => confirmations,
    quit: () => { quitting = true; },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('opening a family parks its source, moves all drafts and admits only one owner', async () => {
  const h = harness();
  h.main.drafts.set('A', 'root draft'); h.main.drafts.set('A-child', 'child draft');
  await h.open();
  const child = h.windows[1]!;
  assert.equal(h.main.active, undefined);
  assert.equal(h.main.drafts.has('A'), false);
  assert.equal(child.active, 'A');
  assert.equal(child.drafts.get('A-child'), 'child draft');
  assert.equal(child.revealed, true);
  assert.equal(child.frozen, false);
  for (const id of group.sessionIds) {
    assert.equal(h.coordinator.canUseSession(child.contents as never, id), true);
    assert.equal(h.coordinator.canUseSession(h.main.contents as never, id), false);
  }
  h.coordinator.dispose();
});

test('an inactive family leaves the main selection and unrelated drafts untouched', async () => {
  const h = harness(); h.main.active = 'B'; h.main.drafts.set('B', 'keep B'); h.main.drafts.set('A', 'move A');
  await h.open();
  assert.equal(h.main.active, 'B'); assert.equal(h.main.drafts.get('B'), 'keep B');
  const child = h.windows[1]!; child.active = 'A-child'; child.drafts.set('A-child', 'edited child');
  await h.returnToMain();
  assert.equal(h.main.active, 'A-child'); assert.equal(h.main.drafts.get('B'), 'keep B');
  assert.equal(h.main.drafts.get('A-child'), 'edited child'); assert.equal(child.destroyed, true);
  h.coordinator.dispose();
});

test('repeated and simultaneous opens focus the existing owner instead of creating duplicates', async () => {
  const h = harness(); await Promise.all([h.open(), h.open('A-child'), h.open('A-version')]);
  assert.equal(h.windows.length, 2); assert.equal(h.windows[1]!.active, 'A-version');
  const child = h.windows[1]!;
  child.focused = false; child.revealed = false;
  await h.open();
  assert.equal(h.windows.length, 2); assert.equal(child.focused, true); assert.equal(child.revealed, true);
  child.focused = false; child.revealed = false;
  await h.coordinator.routeSession(h.main.contents as never, { sessionId: 'A-child' });
  assert.equal(child.active, 'A-child'); assert.equal(h.main.active, undefined);
  assert.equal(child.focused, true); assert.equal(child.revealed, true);
  h.coordinator.dispose();
});

for (const failure of ['creation', 'prepare', 'receive', 'resources', 'prepare-timeout', 'receive-timeout'] as const) {
  test(`${failure} failure retains the source draft and releases the failed child`, async () => {
    const h = harness(); h.main.drafts.set('A', 'keep me');
    if (failure === 'creation') h.failCreation();
    if (failure === 'prepare') h.main.unsupported = true;
    if (failure === 'receive') h.failReceive('session');
    if (failure === 'resources') h.failResources();
    if (failure === 'prepare-timeout') h.dropReply('prepare');
    if (failure === 'receive-timeout') h.dropReply('receive');
    await assert.rejects(h.open());
    assert.equal(h.main.active, 'A'); assert.equal(h.main.drafts.get('A'), 'keep me'); assert.equal(h.main.frozen, false);
    assert.equal(h.windows.filter((window) => !window.destroyed).length, 1);
    assert.equal(h.coordinator.canUseSession(h.main.contents as never, 'A'), true);
    h.coordinator.dispose();
  });
}

for (const failure of ['receive', 'resources', 'receive-timeout'] as const) {
  test(`return ${failure} preserves the source child and the main window's unrelated B`, async () => {
    const h = harness(); await h.open(); const child = h.windows[1]!;
    h.main.active = 'B'; h.main.drafts.set('B', 'keep B'); child.drafts.set('A', 'keep A');
    if (failure === 'receive') h.failReceive('main');
    if (failure === 'resources') h.failResources();
    if (failure === 'receive-timeout') h.dropReply('receive');
    await assert.rejects(h.returnToMain());
    assert.equal(h.main.active, 'B'); assert.equal(h.main.drafts.get('B'), 'keep B'); assert.equal(h.main.destroyed, false);
    assert.equal(child.active, 'A'); assert.equal(child.drafts.get('A'), 'keep A'); assert.equal(child.frozen, false);
    assert.equal(h.coordinator.canUseSession(child.contents as never, 'A'), true);
    h.coordinator.dispose();
  });
}

test('resource handoff holds both windows inactive and source drafts until the receiver commits', async () => {
  const h = harness(); h.main.drafts.set('A', 'still owned');
  const entered = deferred(); const release = deferred(); h.gate({ entered: () => entered.resolve(), wait: release.promise });
  const opening = h.open(); await entered.promise;
  assert.equal(h.main.active, undefined); assert.equal(h.main.drafts.get('A'), 'still owned');
  assert.equal(h.windows[1]!.active, undefined); assert.equal(h.windows[1]!.revealed, false);
  assert.equal(h.coordinator.canUseSession(h.main.contents as never, 'A'), false);
  release.resolve(); await opening;
  assert.equal(h.main.drafts.has('A'), false); assert.equal(h.windows[1]!.active, 'A');
  h.coordinator.dispose();
});

test('new descendants inherit the family owner before they can use session resources', async () => {
  const h = harness(); await h.open();
  assert.equal(h.coordinator.canUseSession(h.main.contents as never, 'new-child'), false);
  h.known[0] = { ...group, sessionIds: [...group.sessionIds, 'new-child'] };
  h.coordinator.refreshOwnership();
  assert.equal(h.coordinator.canUseSession(h.windows[1]!.contents as never, 'new-child'), true);
  assert.equal(h.coordinator.canUseSession(h.main.contents as never, 'new-child'), false);
  h.coordinator.dispose();
});

test('cancel close keeps every member draft, while confirmed close releases its owner and browser', async () => {
  const h = harness(); await h.open(); const child = h.windows[1]!;
  child.drafts.set('A-child', 'hidden unsent text'); child.close(); await settle(); await settle();
  assert.equal(h.confirmations(), 1); assert.equal(child.destroyed, false); assert.equal(child.frozen, false);
  assert.equal(child.drafts.get('A-child'), 'hidden unsent text');
  h.confirm(true); child.close(); await settle(); await settle();
  assert.equal(child.destroyed, true); assert.ok(h.resources.includes(`release:${child.id}`));
  assert.equal(h.coordinator.canUseSession(h.main.contents as never, 'A'), true);
  h.coordinator.dispose();
});

test('an unreadable composer still allows an explicitly confirmed discard close', async () => {
  const h = harness(); await h.open(); h.dropReply('check-close'); h.confirm(true);
  const child = h.windows[1]!; child.close();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(h.confirmations(), 1); assert.equal(child.destroyed, true);
  h.coordinator.dispose();
});

test('a failed confirmation cancels close and unfreezes the child', async () => {
  const h = harness(); await h.open(); const child = h.windows[1]!; child.unsupported = true;
  h.confirm(new Error('dialog failed')); child.close(); await settle(); await settle();
  assert.equal(child.destroyed, false); assert.equal(child.frozen, false); assert.equal(h.errors.length, 1);
  h.coordinator.dispose();
});

test('closing Main leaves children alive and returning can recreate Main', async () => {
  const h = harness(); await h.open(); const child = h.windows[1]!;
  h.main.close(); await settle(); await settle();
  assert.equal(h.main.destroyed, true); assert.equal(child.destroyed, false);
  await h.returnToMain(child); assert.equal(h.windows[2]!.active, 'A'); assert.equal(child.destroyed, true);
  h.coordinator.dispose();
});

test('IPC rejects auxiliary senders and subframes and validates routing input', async () => {
  const h = harness();
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSessionWindowIpc(h.coordinator, { handle: (key, handler) => { handlers.set(key, handler); } });
  const frame = {}; Object.assign(h.main.contents, { mainFrame: frame });
  const event = { sender: h.main.contents, senderFrame: frame };
  assert.throws(() => handlers.get('session-window:context')!({ ...event, senderFrame: {} }), /main frame/);
  assert.throws(() => handlers.get('session-window:context')!({ sender: { mainFrame: frame, isDestroyed: () => false }, senderFrame: frame }), /workspace window/);
  assert.throws(() => handlers.get('session-window:route')!(event, { sessionId: 'A', sequence: -1 }), /sequence/);
  assert.throws(() => handlers.get('session-window:open')!(event, ''), /identity/);
  h.coordinator.dispose();
});

for (const change of ['crash', 'reload', 'reload-ready', 'destroy'] as const) {
  test(`receiver ${change} after receipt rejects transfer and preserves the source`, async () => {
    const h = harness(); h.main.drafts.set('A', 'surviving draft');
    const entered = deferred(); const release = deferred();
    h.gate({ entered: () => entered.resolve(), wait: release.promise });
    const moving = h.open(); const rejected = assert.rejects(moving);
    await entered.promise;
    const target = h.windows[1]!;
    if (change === 'destroy') target.destroy();
    else {
      if (change === 'crash') target.contents.emit('render-process-gone');
      else target.contents.emit('did-start-navigation', {}, 'reload', false, true);
      target.resetRenderer();
      if (change === 'reload-ready') h.coordinator.sessionWindowReady(target.contents as never);
    }
    release.resolve(); await rejected;
    assert.equal(h.main.drafts.get('A'), 'surviving draft');
    assert.equal(h.main.active, 'A'); assert.equal(h.main.frozen, false);
    assert.equal(h.coordinator.canUseSession(h.main.contents as never, 'A'), true);
    assert.equal(target.destroyed, true);
    h.coordinator.dispose();
  });
}
