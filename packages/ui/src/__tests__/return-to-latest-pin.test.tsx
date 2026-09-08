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
 * The return-to-latest command must pin before it loads. An unpinned scroller
 * reports the Turn it is leaving as the reading anchor, and the restore effect
 * would pull the arriving range straight back — the bug the 60-run E2E guard
 * covers, held here as a fast unit so reverting the two-line order goes red
 * without a browser.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Fragment, act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { AstryxLocaleProvider } from '../astryx-i18n.js';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView } from '../chat-view.js';
import { LocaleProvider } from '../locale-context.js';
import {
  useTranscriptScrollAuthority,
  type TranscriptScrollAuthority,
} from '../transcript-scroll-authority.js';

const originalGlobals = {
  CSS: globalThis.CSS,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  IntersectionObserver: globalThis.IntersectionObserver,
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

const activeSession: SessionSummary = {
  id: 'session-return',
  name: '回到最新',
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

const TURN_COUNT = 6;

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

function deferredClick(): { onClick: () => Promise<void>; release: () => void } {
  let release!: (value: void) => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    onClick: () => promise,
    release: () => {
      release();
    },
  };
}


interface ReturnToLatestHarness {
  readonly anchors: Array<string | undefined>;
  /** The authority `ChatSurfaceLayout` provided, read through a probe child. */
  readonly authority: TranscriptScrollAuthority;
  readonly scrollRoot: HTMLElement;
  readonly scrollButton: HTMLElement;
  readonly clickEvent: Event;
  readerScroll(): void;
  geometryScroll(): void;
}

/**
 * Renders `ChatView` with a deferred return-to-latest load inside the same
 * linkedom + act harness `prompt-rail-observer-identity.test.tsx` established.
 * A probe child publishes the authority so the test can read the pin.
 */
function harness(options: { readonly onClick: () => Promise<void> | void }): ReturnToLatestHarness {
  const { document, window } = parseHTML('<main id="mount"></main>');
  // linkedom lays nothing out, so every box is zero-sized. The geometry this
  // test needs is a scroller away from its tail with a Turn visible, which a
  // constant viewport rectangle plus scrollTop and scrollHeight fields give.
  const rect = {
    bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0,
    toJSON: () => ({}),
  } satisfies DOMRect;
  window.Element.prototype.getBoundingClientRect = () => rect;
  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  class InertIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.assign(globalThis, {
    CSS: { supports: () => false },
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IntersectionObserver: InertIntersectionObserver,
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
  const anchors: Array<string | undefined> = [];
  let authority: TranscriptScrollAuthority | undefined;
  const AuthorityProbe = (): ReactElement => {
    authority = useTranscriptScrollAuthority();
    return createElement(Fragment, null);
  };
  const view = (): ReactElement => {
    const chat = createElement(ChatView, {
      messages: turnMessages(),
      activeSession,
      onNew: () => {},
      scrollBehavior: 'auto' as const,
      hasOlderHistory: true,
      hasNewerHistory: true,
      onLoadEarlierHistory: () => undefined,
      onLoadLaterHistory: () => undefined,
      onReadingAnchorChange: (turnId?: string) => {
        anchors.push(turnId);
      },
    } as never);
    const layout = createElement(ChatSurfaceLayout, {
      scrollOwner: 'host',
      scrollToBottomLabel: '回到最新',
      onReturnToTail: options.onClick,
      composer: null,
      children: createElement(Fragment, null, chat, createElement(AuthorityProbe)),
    });
    const astryx = createElement(AstryxLocaleProvider, { children: layout });
    return createElement(LocaleProvider, {
      locale: 'zh-CN',
      children: astryx,
    });
  };
  const mount = document.querySelector<HTMLElement>('#mount');
  assert.ok(mount);
  const root = createRoot(mount);
  mountedRoot = root;
  act(() => {
    root.render(view());
  });
  const scrollRoot = mount.querySelector<HTMLElement>('[data-chat-scroll-container]');
  assert.ok(scrollRoot, 'the layout mounts a scroll container');
  const scrollButton = mount.querySelector<HTMLElement>('button[aria-label="回到最新"]');
  assert.ok(scrollButton, 'the return-to-latest affordance is rendered');
  // LinkeDOM has no layout. Start at the tail; readerScroll supplies input and
  // its resulting offset, whereas geometryScroll supplies no reading intent.
  Object.assign(scrollRoot, { scrollHeight: 2_400, clientHeight: 600 });
  scrollRoot.scrollTop = 1_800;
  // linkedom ships Event but not MouseEvent; a bubbling Event still reaches
  // React's root listener, which reads only the type for onClick.
  const clickEvent = new window.Event('click', { bubbles: true });
  return {
    anchors,
    get authority(): TranscriptScrollAuthority {
      assert.ok(authority, 'the layout provided a scroll authority');
      return authority;
    },
    scrollRoot,
    scrollButton,
    clickEvent,
    readerScroll() {
      const event = new window.Event('wheel', { bubbles: true });
      Object.defineProperty(event, 'deltaY', { value: -120 });
      scrollRoot.dispatchEvent(event);
      scrollRoot.scrollTop = 600;
      scrollRoot.dispatchEvent(new window.Event('scroll'));
    },
    geometryScroll() {
      scrollRoot.dispatchEvent(new window.Event('scroll'));
    },
  };
}

test('returning to latest pins before it loads, so the anchor reports nothing', async () => {
  const click = deferredClick();
  const view = harness({ onClick: click.onClick });

  // Mount reports the pinned (cleared) anchor once; the reader scroll that
  // parks away from the tail then reports the Turn being left.
  view.readerScroll();
  assert.deepEqual(view.anchors, [undefined, 'turn-0'], 'an unpinned scroller reports the left Turn');

  view.scrollButton.dispatchEvent(view.clickEvent);
  await act(async () => {});
  assert.equal(
    view.authority.getSnapshot().pinned,
    true,
    'the click pinned synchronously, before the load settled',
  );
  assert.deepEqual(
    view.anchors,
    [undefined, 'turn-0', undefined],
    'the pin cleared the reading anchor while the load was in flight',
  );

  click.release();
  await act(async () => {});
});

test('the anchor stays cleared while the range is still loading', async () => {
  const click = deferredClick();
  const view = harness({ onClick: click.onClick });
  view.readerScroll();
  view.scrollButton.dispatchEvent(view.clickEvent);
  await act(async () => {});

  // The arriving range is what used to re-report the anchor; whatever moves
  // the scroller while the load is pending must not hand the shell a Turn.
  view.geometryScroll();
  assert.deepEqual(view.anchors, [undefined, 'turn-0', undefined]);

  click.release();
  await act(async () => {});
});
