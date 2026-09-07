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
 * The prompt rail observes every mounted Turn in the transcript. What that
 * observer is for is Turn identity and order, and a streaming answer delivers
 * several deltas a second that change neither — so a delta must not tear the
 * observer down and rebuild it over the whole conversation.
 *
 * Two things hold that in series: ChatView hands the rail the previous entry
 * array back when no persisted prompt or answer text moved, and the rail keys
 * the observer's lifetime on the Turn id list rather than on its props. Either
 * one alone keeps the count at 1, which is why this asserts the composed
 * outcome the way the deleted E2E case did rather than probing one of them.
 *
 * A probe, not a story: this counts constructions and reads the init a
 * constructor was handed, and both are only observable from before the rail's
 * own observer exists. Installing `IntersectionObserver` on the global here is
 * what makes the positive control real — a story mounting the rail first can
 * only watch the observer it already has, so the `rootMargin` assertion below
 * would pass against any literal.
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
import { READING_BAND_TOP_PERCENT } from '../prompt-anchor-rail.js';

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

const TURN_COUNT = 6;

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

function turnMessages(answerText: (index: number) => string): StoredMessage[] {
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
      text: answerText(index),
      modelId: 'claude-sonnet-4-5',
    },
  ]).flat();
}

interface ObservedInit {
  root: unknown;
  rootMargin?: string;
  threshold?: number | number[];
}

function harness() {
  const { document, window } = parseHTML('<main id="mount"></main>');
  const inits: ObservedInit[] = [];
  class CountingIntersectionObserver {
    constructor(_callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
      inits.push({
        root: init?.root,
        rootMargin: init?.rootMargin,
        threshold: init?.threshold as number | number[] | undefined,
      });
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // linkedom lays nothing out, so every box is zero-sized. The rail reads
  // geometry only to pick which tick is current; the observer it builds to do
  // that is what this test is about, and a constructor call does not need a
  // layout to be counted.
  const rect = {
    bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0,
    toJSON: () => ({}),
  } satisfies DOMRect;
  window.Element.prototype.getBoundingClientRect = () => rect;
  Object.assign(globalThis, {
    CSS: { supports: () => false },
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    IntersectionObserver: CountingIntersectionObserver,
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
  return { inits, mount };
}

function view(messages: StoredMessage[]): ReactElement {
  const chat = createElement(ChatView, { messages, activeSession, onNew: () => {} } as never);
  const layout = createElement(ChatSurfaceLayout, {
    scrollOwner: 'host',
    composer: null,
    children: chat,
  });
  const astryx = createElement(AstryxLocaleProvider, { children: layout });
  return createElement(LocaleProvider, { locale: 'zh-CN', children: astryx });
}

test('streaming deltas do not reconstruct the prompt rail observer', async () => {
  const { inits, mount } = harness();
  const root = createRoot(mount);
  mountedRoot = root;

  await act(() => {
    root.render(view(turnMessages(() => '答案')));
  });
  assert.equal(inits.length, 1, 'the rail observes the transcript once on mount');

  // Ten deltas on the tail answer. Every one of them hands ChatView a fresh
  // message array and fresh turn records — which is exactly the shape that
  // used to rebuild the observer over the whole transcript per frame.
  for (let delta = 1; delta <= 10; delta += 1) {
    await act(() => {
      root.render(
        view(
          turnMessages((index) =>
            index === TURN_COUNT - 1 ? `答案${'。'.repeat(delta)}` : '答案',
          ),
        ),
      );
    });
  }
  assert.equal(inits.length, 1, `the observer was rebuilt ${inits.length - 1} times`);
});

test('the rail observes its reading band, not the whole scrollport', async () => {
  const { inits, mount } = harness();
  const root = createRoot(mount);
  mountedRoot = root;
  await act(() => {
    root.render(view(turnMessages(() => '答案')));
  });

  const init = inits[0];
  assert.ok(init);
  // The band is the top slice of the scrollport, so the bottom inset is its
  // complement. Both spellings come from one constant; a rail that observed
  // the whole scrollport would call every Turn on screen "being read".
  assert.equal(init.rootMargin, `0px 0px -${100 - READING_BAND_TOP_PERCENT}% 0px`);
  assert.ok(READING_BAND_TOP_PERCENT > 0 && READING_BAND_TOP_PERCENT < 100);
  // Zero alone reports a boundary touch as an intersection; the second,
  // positive threshold is what distinguishes real overlap from that.
  assert.deepEqual(init.threshold, [0, 0.000_001]);
});
