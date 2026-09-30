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
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, type ComposerHandle, LocaleProvider, ToastProvider } from '@maka/ui';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import { ChatComposerRegion } from '../../renderer/chat-composer-region.js';
import {
  GuestTurnRequests,
  SessionCollaborationServicesProvider,
  createFakeSessionCollaborationServices,
  type SessionCollaborationServices,
} from '../../renderer/features/session-collaboration/testing.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  HTMLBRElement: globalThis.HTMLBRElement,
  Element: globalThis.Element,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
  getComputedStyle: globalThis.getComputedStyle,
  sessionStorage: globalThis.sessionStorage,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

const OWNED = 'owned-session';
const SHARED = 'shared-session';

function request(turnId: string, text: string): SessionTurnAccessRequest {
  return {
    requestId: `request:${turnId}`,
    principalId: 'guest-1',
    grantId: 'grant-1',
    intent: { sessionId: SHARED, turnId, content: { text } },
    createdAt: '2026-09-03T00:00:00.000Z',
    state: { kind: 'pending' },
  };
}

function guestServices(overrides: Partial<SessionCollaborationServices>): SessionCollaborationServices {
  return createFakeSessionCollaborationServices({
    getTurnRequests: async () => ({ canRequestTurns: true, requests: [] }),
    createOperationId: () => 'turn-1',
    ...overrides,
  });
}

async function mountShell(services: SessionCollaborationServices) {
  const { document, window } = parseHTML('<div id="root"></div>');
  const storage = new Map<string, string>();
  const getSelection = () =>
    ({
      rangeCount: 0,
      isCollapsed: true,
      anchorNode: null,
      focusNode: null,
      removeAllRanges() {},
      addRange() {},
      getRangeAt: () => {
        throw new Error('no range');
      },
    }) as unknown as Selection;
  const getComputedStyle = () =>
    ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
  const matchMedia = () =>
    ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList;
  const refreshes: Array<() => void> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  Object.assign(document, { getSelection });
  Object.assign(window, {
    getSelection,
    getComputedStyle,
    matchMedia,
    scrollTo() {},
    // The Guest projection refreshes on a 2s loop; tests advance it by hand.
    setTimeout(handler: TimerHandler, timeout?: number) {
      if (timeout === 2_000 && typeof handler === 'function') {
        refreshes.push(handler as () => void);
        return 0;
      }
      return nativeSetTimeout(handler as () => void, timeout) as unknown as number;
    },
    clearTimeout(handle: number) {
      if (handle !== 0) nativeClearTimeout(handle);
    },
  });
  document.createRange = () =>
    ({ selectNodeContents() {}, collapse() {}, cloneRange() { return this; } }) as unknown as Range;
  Object.assign(globalThis, {
    document,
    window,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    HTMLBRElement: window.HTMLBRElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    CSS: { escape: (value: string) => value },
    getComputedStyle,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    matchMedia,
    requestAnimationFrame: (callback: FrameRequestCallback) => nativeSetTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => nativeClearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.querySelector('#root')!);
  mountedRoot = root;
  const composer = createRef<ComposerHandle>();
  const flush = () => new Promise((resolve) => nativeSetTimeout(resolve, 0));

  // Mirrors AppShell: the Guest projection wraps the one ChatComposerRegion,
  // and only its `sessionId` says whether the active Session is shared.
  async function open(sessionId: string, shared: boolean) {
    await act(async () => {
      root.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(AstryxLocaleProvider, {
          children: createElement(ToastProvider, {
            children: createElement(SessionCollaborationServicesProvider, {
              services,
              children: createElement(GuestTurnRequests, {
                sessionId: shared ? sessionId : undefined,
                composerRef: composer,
                children: (guest) => createElement(ChatComposerRegion, {
                  composerRef: composer,
                  guest,
                  onOpenContextUsage: () => undefined,
                  directoryComposerProps: {},
                  directoryPickerEnabled: false,
                  active: true,
                  onboardingComposerHidden: false,
                  activeInteraction: undefined,
                  activeId: sessionId,
                  contextUsageSessionId: sessionId,
                  newTaskDraftKey: 'new-task:local',
                  newTaskSendPending: false,
                  stopPending: false,
                  respondToSandboxBoundary: () => {},
                  respondToClientCapability: () => {},
                  respondToUserQuestion: () => {},
                  respondToUserForm: () => {},
                  stop: () => {},
                  onSend: () => {
                    throw new Error('an owner send must not run for a Guest Session');
                  },
                  onStop: () => {},
                  onPickAttachments: () => {},
                }),
              }),
            }),
          }),
        }),
      }));
      await flush();
    });
  }

  return {
    composer,
    document,
    open,
    buttons: () => [...document.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')),
    async send(text: string) {
      await act(async () => composer.current!.setText(text));
      await act(async () => {
        document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        await flush();
        await flush();
      });
    },
    async refresh() {
      await act(async () => {
        refreshes.shift()?.();
        await flush();
      });
    },
  };
}

// The harness below mirrors AppShell's wiring; this pins AppShell to it, since
// app-shell.tsx is not in the node test build.
test('AppShell mounts the one ChatComposerRegion inside GuestTurnRequests with no owner/Guest remount', () => {
  const source = readFileSync(new URL('../../../src/renderer/app-shell.tsx', import.meta.url), 'utf8');
  const regions = [...source.matchAll(/<ChatComposerRegion\b/g)];
  assert.equal(regions.length, 1);
  const open = source.indexOf('<SessionCollaboration.GuestTurnRequests');
  const close = source.indexOf('</SessionCollaboration.GuestTurnRequests>');
  assert.ok(open !== -1 && open < regions[0]!.index && regions[0]!.index < close);
  const slot = source.slice(open, close);
  assert.doesNotMatch(slot, /\bkey=/);
  assert.deepEqual(slot.match(/sharedSessionActive[^}]*/g), ['sharedSessionActive ? activeId : undefined'],
    'only the Guest projection\'s sessionId distinguishes a shared Session');
});

test('switching to a shared Session and back keeps the one Composer and its owned draft', async () => {
  const shell = await mountShell(guestServices({}));
  await shell.open(OWNED, false);
  const handle = shell.composer.current;
  assert.ok(shell.buttons().includes('Add context'));
  await act(async () => shell.composer.current!.setText('owned draft'));

  await shell.open(SHARED, true);
  assert.equal(shell.composer.current, handle, 'a shared Session must not replace the Composer');
  assert.equal(shell.composer.current!.getText(), '');
  assert.deepEqual(shell.buttons(), ['Send'], 'owner controls and pickers do not reach a Guest');

  await shell.open(OWNED, false);
  assert.equal(shell.composer.current, handle);
  assert.equal(shell.composer.current!.getText(), 'owned draft');
});

test('a Guest send creates one Turn request and lists it in the staging drawer', async () => {
  const sent: Array<{ turnId: string; text: string }> = [];
  let requests: SessionTurnAccessRequest[] = [];
  const shell = await mountShell(guestServices({
    getTurnRequests: async () => ({ canRequestTurns: true, requests }),
    requestTurn: async (_sessionId, intent) => {
      if (intent.kind !== 'start') throw new Error('unexpected intent');
      sent.push({ turnId: intent.turnId, text: intent.text });
      requests = [request(intent.turnId, intent.text)];
      return requests[0]!;
    },
  }));
  await shell.open(SHARED, true);
  await shell.send('please review the retry plan');

  assert.deepEqual(sent, [{ turnId: 'turn-1', text: 'please review the retry plan' }]);
  assert.equal(shell.composer.current!.getText(), '');
  const row = shell.document.querySelector('.maka-composer-queue-text');
  assert.equal(row?.textContent, 'please review the retry plan');
  assert.ok(shell.document.querySelector('.maka-composer-queue [aria-label="Withdraw"]'));
});

test('a lost response the Host already accepted counts as sent instead of being resent', async () => {
  let dispatched = 0;
  let requests: SessionTurnAccessRequest[] = [];
  const shell = await mountShell(guestServices({
    getTurnRequests: async () => ({ canRequestTurns: true, requests }),
    requestTurn: async (_sessionId, intent) => {
      dispatched += 1;
      if (intent.kind === 'start') requests = [request(intent.turnId, intent.text)];
      throw new Error('connection lost after dispatch');
    },
  }));
  await shell.open(SHARED, true);
  await shell.send('one request only');

  assert.equal(dispatched, 1);
  assert.equal(shell.composer.current!.getText(), '');
  assert.equal(shell.document.querySelector('.maka-composer-queue-text')?.textContent, 'one request only');
});

test('an unreachable Host keeps the draft and a retry reuses the same Turn id', async () => {
  const turnIds: string[] = [];
  let hostReachable = true;
  let nextId = 0;
  const shell = await mountShell(guestServices({
    createOperationId: () => `turn-${++nextId}`,
    getTurnRequests: async () => {
      if (!hostReachable) throw new Error('Runtime Host is reconnecting');
      return { canRequestTurns: true, requests: [] };
    },
    requestTurn: async (_sessionId, intent) => {
      turnIds.push(intent.turnId);
      if (!hostReachable) throw new Error('Runtime Host is reconnecting');
      return request(intent.turnId, intent.kind === 'start' ? intent.text : '');
    },
  }));
  await shell.open(SHARED, true);
  hostReachable = false;
  await shell.send('keep this draft');
  assert.equal(shell.composer.current!.getText(), 'keep this draft');

  hostReachable = true;
  await shell.refresh();
  await shell.send('keep this draft');
  assert.deepEqual(turnIds, ['turn-1', 'turn-1']);
  assert.equal(shell.composer.current!.getText(), '');
});

test('a Guest without Turn access sees the notice instead of the composer', async () => {
  const shell = await mountShell(guestServices({
    getTurnRequests: async () => ({ canRequestTurns: false, requests: [] }),
  }));
  await shell.open(SHARED, true);
  assert.equal(
    shell.document.querySelector('.sessionCollaborationReadOnly')?.textContent,
    'Read the full history and live updates',
  );
  assert.equal(shell.document.querySelector('form.maka-composer')?.hasAttribute('hidden'), true);
});
