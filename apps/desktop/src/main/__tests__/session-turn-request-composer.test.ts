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
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';
import {
  SessionCollaborationServicesProvider,
  SessionTurnRequestComposer,
  type SessionCollaborationServices,
} from '../../renderer/features/session-collaboration/testing.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  Event: globalThis.Event,
  Node: globalThis.Node,
  CSS: globalThis.CSS,
  getComputedStyle: globalThis.getComputedStyle,
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

test('keeps a newer Guest draft across remount when an old request settles later', async () => {
  let sessionOneQueryCount = 0;
  let resolveOldReconciliation: ((requests: {
    readonly canRequestTurns: boolean;
    readonly requests: readonly SessionTurnAccessRequest[];
  }) => void) | undefined;
  const oldReconciliation = new Promise<{
    readonly canRequestTurns: boolean;
    readonly requests: readonly SessionTurnAccessRequest[];
  }>((resolve) => {
    resolveOldReconciliation = resolve;
  });
  const accepted: SessionTurnAccessRequest = {
    requestId: 'request-1',
    principalId: 'guest-1',
    grantId: 'grant-1',
    intent: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      content: { text: 'submitted text' },
    },
    createdAt: '2026-09-03T00:00:00.000Z',
    state: { kind: 'pending' },
  };
  const services: SessionCollaborationServices = {
    importInvitation: async () => ({ kind: 'connected', mountId: 'unused' }),
    cancelImport: async () => 'cancelled',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    removeMount: async () => undefined,
    requestTurn: async () => {
      throw new Error('connection lost after dispatch');
    },
    getTurnRequests: async (sessionId) => {
      if (sessionId !== 'session-1') {
        return { canRequestTurns: true, requests: [] };
      }
      sessionOneQueryCount += 1;
      if (sessionOneQueryCount === 2) return oldReconciliation;
      return { canRequestTurns: true, requests: [] };
    },
    acknowledgeTurnRequest: async () => ({ acknowledged: false }),
    withdrawTurnRequest: async () => ({ withdrawn: false }),
    getPendingTurnRequests: async () => [],
    decideTurnRequest: async () => {
      throw new Error('unused');
    },
    createOperationId: () => 'turn-1',
  };
  const { document } = installDom(() => undefined);
  const container = document.querySelector('#root');
  assert.ok(container);
  mountedRoot = createRoot(container);

  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-1'));
    await Promise.resolve();
  });

  const textbox = document.querySelector<HTMLElement>('[role="textbox"]');
  assert.ok(textbox);
  await edit(textbox, 'submitted text');
  await pressEnter(textbox);
  assert.equal(sessionOneQueryCount, 2);

  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-2'));
    await Promise.resolve();
  });
  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-1'));
    await Promise.resolve();
  });
  const remountedTextbox = document.querySelector<HTMLElement>('[role="textbox"]');
  assert.ok(remountedTextbox);
  await edit(remountedTextbox, 'next draft');

  await act(async () => {
    resolveOldReconciliation?.({ canRequestTurns: true, requests: [accepted] });
    await Promise.resolve();
  });
  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-2'));
    await Promise.resolve();
  });
  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-1'));
    await Promise.resolve();
  });

  assert.equal(
    document.querySelector<HTMLElement>('[role="textbox"]')?.textContent,
    'next draft',
  );
});

test('resumes an in-flight Guest request across remount without submitting it twice', async () => {
  let sessionQueryCount = 0;
  let requestCount = 0;
  let resolveRequest: ((request: SessionTurnAccessRequest) => void) | undefined;
  const requestResult = new Promise<SessionTurnAccessRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const accepted: SessionTurnAccessRequest = {
    requestId: 'request-resumed',
    principalId: 'guest-1',
    grantId: 'grant-1',
    intent: {
      sessionId: 'session-resumed',
      turnId: 'turn-resumed',
      content: { text: 'one request only' },
    },
    createdAt: '2026-09-03T00:00:00.000Z',
    state: { kind: 'pending' },
  };
  const services: SessionCollaborationServices = {
    importInvitation: async () => ({ kind: 'connected', mountId: 'unused' }),
    cancelImport: async () => 'cancelled',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    removeMount: async () => undefined,
    requestTurn: async () => {
      requestCount += 1;
      return requestResult;
    },
    getTurnRequests: async (sessionId) => {
      if (sessionId !== 'session-resumed') {
        return { canRequestTurns: true, requests: [] };
      }
      sessionQueryCount += 1;
      return {
        canRequestTurns: true,
        requests: sessionQueryCount === 1 ? [] : [accepted],
      };
    },
    acknowledgeTurnRequest: async () => ({ acknowledged: false }),
    withdrawTurnRequest: async () => ({ withdrawn: false }),
    getPendingTurnRequests: async () => [],
    decideTurnRequest: async () => {
      throw new Error('unused');
    },
    createOperationId: () => 'turn-resumed',
  };
  const { document } = installDom(() => undefined);
  const container = document.querySelector('#root');
  assert.ok(container);
  mountedRoot = createRoot(container);

  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-resumed'));
    await Promise.resolve();
  });
  const textbox = document.querySelector<HTMLElement>('[role="textbox"]');
  assert.ok(textbox);
  await edit(textbox, 'one request only');
  await pressEnter(textbox);
  assert.equal(requestCount, 1);

  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-away'));
    await Promise.resolve();
  });
  await act(async () => {
    mountedRoot?.render(renderComposer(services, 'session-resumed'));
    await Promise.resolve();
  });

  assert.equal(
    document.querySelector<HTMLElement>('[role="textbox"]')?.textContent,
    '',
  );
  assert.equal(requestCount, 1);

  await act(async () => {
    resolveRequest?.(accepted);
    await Promise.resolve();
  });
});

function renderComposer(services: SessionCollaborationServices, sessionId: string) {
  return createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(AstryxLocaleProvider, {
      children: createElement(ToastProvider, {
        children: createElement(SessionCollaborationServicesProvider, {
          services,
          children: createElement(SessionTurnRequestComposer, { sessionId }),
        }),
      }),
    }),
  });
}

function installDom(captureRefresh: (refresh: () => void) => void): { document: Document } {
  const parsed = parseHTML('<html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const refreshTimer = 2_000_000_001;
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  const getComputedStyle = () => ({
    getPropertyValue: () => '',
  }) as unknown as CSSStyleDeclaration;
  Object.assign(window, {
    matchMedia,
    getComputedStyle,
    scrollTo() {},
    setTimeout(handler: TimerHandler, timeout?: number) {
      if (timeout === 2_000 && typeof handler === 'function') {
        captureRefresh(handler as () => void);
        return refreshTimer;
      }
      return nativeSetTimeout(handler as (...args: unknown[]) => void, timeout) as unknown as number;
    },
    clearTimeout(handle: number) {
      if (handle !== refreshTimer) nativeClearTimeout(handle);
    },
  });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    Event: window.Event,
    Node: window.Node,
    CSS: { escape: (value: string) => value },
    getComputedStyle,
    requestAnimationFrame: (callback: FrameRequestCallback) => nativeSetTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return { document };
}

async function edit(textbox: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    textbox.textContent = value;
    textbox.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function pressEnter(textbox: HTMLElement): Promise<void> {
  await act(async () => {
    const event = new Event('keydown', { bubbles: true });
    Object.defineProperty(event, 'key', { value: 'Enter' });
    textbox.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
}
