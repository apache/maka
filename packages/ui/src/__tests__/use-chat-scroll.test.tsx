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
 * Astryx owns following the tail and decides on its own when a gesture means
 * the reader has left it. What stays Maka's is the pair of moves Astryx cannot
 * see: a jump to a turn the reader picked, and the earlier history Maka loads
 * above the current position. Both have to release auto-follow, or the reader
 * is dragged back to the bottom by the next thing that arrives.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useChatScroll } from '../use-chat-scroll.js';

const originalGlobals = {
  CSS: globalThis.CSS,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
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

function mountTranscript(options: {
  scrollTop: number;
  scrollHeight?: number;
  hasOlderHistory?: boolean;
  target?: { turnId: string; nonce: number };
  onLoadEarlierHistory?(): void;
  unlockAutoFollow(): void;
}) {
  const { document, window } = parseHTML(
    '<main id="root"><div data-turn-id="turn-1"></div></main>',
  );
  const scroller = document.querySelector<HTMLElement>('#root');
  assert.ok(scroller);
  let scrollTop = options.scrollTop;
  let scrollHeight = options.scrollHeight ?? 9_000;
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value },
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-1',
      messages: [],
      behavior: 'auto',
      target: options.target,
      hasOlderHistory: options.hasOlderHistory,
      onLoadEarlierHistory: options.onLoadEarlierHistory,
      unlockAutoFollow: options.unlockAutoFollow,
    });
    return null;
  }

  return {
    scroller,
    document,
    Harness,
    grow(by: number) {
      scrollHeight += by;
    },
  };
}

test('jumping to a turn the reader picked releases auto-follow', async () => {
  let unlocked = 0;
  const { document, Harness } = mountTranscript({
    scrollTop: 8_400,
    target: { turnId: 'turn-1', nonce: 1 },
    unlockAutoFollow: () => {
      unlocked += 1;
    },
  });

  const host = document.createElement('div');
  await act(async () => {
    mountedRoot = createRoot(host);
    mountedRoot.render(<Harness />);
  });

  assert.equal(unlocked, 1);
});

test('loading earlier history releases auto-follow and keeps the anchor off the top', async () => {
  let unlocked = 0;
  let loaded = 0;
  const { scroller, document, Harness, grow } = mountTranscript({
    scrollTop: 0,
    hasOlderHistory: true,
    onLoadEarlierHistory: () => {
      loaded += 1;
    },
    unlockAutoFollow: () => {
      unlocked += 1;
    },
  });

  const host = document.createElement('div');
  await act(async () => {
    mountedRoot = createRoot(host);
    mountedRoot.render(<Harness />);
  });

  await act(async () => {
    scroller.dispatchEvent(
      Object.assign(new window.Event('wheel'), { deltaY: -120 }) as unknown as Event,
    );
  });

  assert.equal(loaded, 1);
  assert.equal(unlocked, 1);
  // Scroll anchoring does nothing while the scroller sits at the very top, so
  // the turns that land above the reader are compensated here instead — after
  // they are on screen, which is the only moment their height is known.
  grow(3_000);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(scroller.scrollTop, 3_000);
});

test('a chosen turn releases auto-follow once, not on every transcript update', async () => {
  let unlocked = 0;
  const target = { turnId: 'turn-1', nonce: 1 };
  const { document, Harness } = mountTranscript({
    scrollTop: 8_400,
    target,
    unlockAutoFollow: () => {
      unlocked += 1;
    },
  });

  const host = document.createElement('div');
  await act(async () => {
    mountedRoot = createRoot(host);
    mountedRoot.render(<Harness />);
  });

  // The effect re-runs on every transcript update so a target that arrives
  // before its turn still lands. Releasing is persistent, though: repeating it
  // would drop the reader off the tail for the rest of the session.
  for (let update = 0; update < 3; update += 1) {
    await act(async () => {
      mountedRoot?.render(<Harness />);
    });
  }

  assert.equal(unlocked, 1);
});
