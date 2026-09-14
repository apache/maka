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

/**
 * The rail's current tick is the reading position the scroll authority
 * publishes — the newest Turn while pinned to the tail, otherwise the Turn
 * crossing the top of the scrollport — and nothing else. Mounted through the
 * real layout, because that is what hands the authority the scroller the
 * reader scrolls.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { AstryxLocaleProvider } from '../astryx-i18n.js';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView } from '../chat-view.js';
import { LocaleProvider } from '../locale-context.js';
import { PromptAnchorRail } from '../prompt-anchor-rail.js';
import { TranscriptScrollAuthorityProvider } from '../transcript-scroll-authority.js';

const originalGlobals = {
  CSS: globalThis.CSS,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  MutationObserver: globalThis.MutationObserver,
  Node: globalThis.Node,
  ResizeObserver: globalThis.ResizeObserver,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

let mountedRoot: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

const TURN_COUNT = 6;
const TURN_HEIGHT = 400;
const SCROLLPORT_HEIGHT = 600;

const activeSession: SessionSummary = {
  id: 'session-rail',
  name: '提问导航',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  lastMessageAt: 0,
  backend: 'ai-sdk',
  llmConnectionId: 'connection-anthropic',
  llmConnectionSlug: 'anthropic',
  connectionLocked: false,
  model: 'claude-sonnet-4-5',
  permissionMode: 'ask',
};

function turnMessages(): StoredMessage[] {
  return Array.from({ length: TURN_COUNT }, (_, index): StoredMessage[] => [
    {
      type: 'user',
      id: `user-${index}`,
      turnId: `turn-${index}`,
      ts: index * 2,
      text: `第 ${index} 个问题`,
    },
    {
      type: 'assistant',
      id: `assistant-${index}`,
      turnId: `turn-${index}`,
      ts: index * 2 + 1,
      text: '答案',
      modelId: 'claude-sonnet-4-5',
    },
  ]).flat();
}

function view(messages: StoredMessage[]): ReactElement {
  const chat = createElement(ChatView, { messages, activeSession, onNew: () => {} } as never);
  const layout = createElement(ChatSurfaceLayout, {
    composer: null,
    children: chat,
  });
  const astryx = createElement(AstryxLocaleProvider, { children: layout });
  return createElement(LocaleProvider, { locale: 'zh-CN', children: astryx });
}

/** linkedom lays nothing out, so every box this reads is stated here. */
function harness() {
  const { document, window } = parseHTML('<main id="mount"></main>');
  const viewport = { scrollTop: 0 };
  const scrollport = {
    bottom: SCROLLPORT_HEIGHT, height: SCROLLPORT_HEIGHT, left: 0, right: 800, top: 0,
    width: 800, x: 0, y: 0, toJSON: () => ({}),
  } satisfies DOMRect;
  window.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const turnId = this.getAttribute('data-turn-id');
    if (turnId === null) return scrollport;
    const top = Number(turnId.split('-')[1]) * TURN_HEIGHT - viewport.scrollTop;
    return { ...scrollport, top, bottom: top + TURN_HEIGHT, height: TURN_HEIGHT };
  };
  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.assign(globalThis, {
    CSS: { supports: () => false, escape: (value: string) => value },
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: window.MutationObserver,
    Node: window.Node,
    ResizeObserver: InertResizeObserver,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const mount = document.querySelector<HTMLElement>('#mount');
  assert.ok(mount);
  return {
    mount,
    window,
    viewport,
    /** Give the mounted scroller the geometry a scrolled transcript has. */
    scroller(): HTMLElement {
      const element = document.querySelector<HTMLElement>('[data-chat-scroll-container]');
      assert.ok(element, 'the layout publishes the scroller the authority attaches to');
      Object.defineProperties(element, {
        scrollTop: {
          get: () => viewport.scrollTop,
          set: (value: number) => { viewport.scrollTop = value; },
        },
        scrollHeight: { get: () => TURN_COUNT * TURN_HEIGHT },
        clientHeight: { get: () => SCROLLPORT_HEIGHT },
      });
      return element;
    },
  };
}

function activeTickTurnId(mount: HTMLElement): string | null {
  return mount.querySelector('.maka-prompt-rail-tick[data-active="true"]')
    ?.getAttribute('data-prompt-turn-id') ?? null;
}

test('the current tick follows the reading position the authority publishes', async () => {
  const probe = harness();
  const root = createRoot(probe.mount);
  mountedRoot = root;
  await act(() => {
    root.render(view(turnMessages()));
  });
  const scroller = probe.scroller();

  // Pinned to the tail, the reader is on the newest Turn.
  probe.viewport.scrollTop = TURN_COUNT * TURN_HEIGHT - SCROLLPORT_HEIGHT;
  assert.equal(activeTickTurnId(probe.mount), 'turn-5');

  // The reader takes the transcript to the third Turn's box. A wheel first:
  // a scroll the reader did not cause leaves the pin, and the newest Turn, alone.
  await act(() => {
    const wheel = new probe.window.Event('wheel', { bubbles: true });
    Object.defineProperty(wheel, 'deltaY', { value: -120 });
    scroller.dispatchEvent(wheel);
    probe.viewport.scrollTop = TURN_HEIGHT * 2 + 100;
    scroller.dispatchEvent(new probe.window.Event('scroll'));
  });
  assert.equal(activeTickTurnId(probe.mount), 'turn-2');

  await act(() => {
    probe.viewport.scrollTop = TURN_HEIGHT * 4;
    scroller.dispatchEvent(new probe.window.Event('scroll'));
  });
  assert.equal(activeTickTurnId(probe.mount), 'turn-4');
});

test('portals unloaded landmarks into the layout host and keeps them actionable', async () => {
  const { mount } = harness();
  const root = createRoot(mount);
  mountedRoot = root;
  const rail = createElement(PromptAnchorRail, {
    turns: [
      { turnId: 'turn-1', label: 'Prompt 1', sequence: 0 },
      { turnId: 'turn-2', label: 'Prompt 2', sequence: 2 },
      { turnId: 'turn-3', label: 'Prompt 3', sequence: 4 },
    ],
    scrollRef: { current: null },
  });
  // The rail reads its tick from the scroll authority, so the host-less render
  // still needs one — otherwise this would assert the absence of a rail that
  // threw rather than one that found no host.
  await act(() => root.render(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(TranscriptScrollAuthorityProvider, { children: rail }),
  })));
  assert.equal(mount.querySelector('.maka-prompt-rail'), null, 'no inline rail before a host exists');
  await act(() => root.render(createElement(LocaleProvider, {
    locale: 'en', children: createElement(ChatSurfaceLayout, { composer: null, children: rail }),
  })));
  assert.equal(mount.querySelectorAll('.maka-prompt-rail-host .maka-prompt-rail').length, 1);
  assert.match(mount.innerHTML, /data-prompt-turn-id="turn-2"/);
  assert.doesNotMatch(mount.innerHTML, /data-resident|Not currently loaded|aria-disabled="true"/);
  assert.match(mount.innerHTML, /aria-label="Jump to prompt: Prompt 2"/);
});
