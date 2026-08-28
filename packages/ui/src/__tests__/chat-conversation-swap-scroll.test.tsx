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
 * Covers the conversation-swap path added to the vendored ChatLayout patch.
 *
 * Switching sessions clears the transcript in the same update that changes the
 * key, so the scroller the swap sees is empty and cannot be jumped anywhere.
 * The content lands a few frames later. Astryx positions a first fill in one
 * frame and springs everything after it, so the swap has to leave that first
 * fill armed — otherwise the arriving transcript flies down from the top.
 *
 * Driven through useChatStreamScroll rather than ChatLayout because the
 * assertion is about which of the hook's two paths the arrival takes, and the
 * hook is where the patch put resetInitialFill.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useChatStreamScroll } from '@astryxdesign/core/Chat';

const originalGlobals = {
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  matchMedia: globalThis.matchMedia,
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

test('a conversation swap against an empty scroller still lands the arriving transcript at the bottom', async () => {
  const { document, window } = parseHTML('<main id="root"></main>');
  const scroller = document.querySelector<HTMLElement>('#root');
  assert.ok(scroller);

  let scrollTop = 0;
  // The loading placeholder is shorter than the viewport, so the swap has
  // nothing to scroll; the transcript that replaces it is taller than it.
  let scrollHeight = 400;
  Object.defineProperties(scroller, {
    clientHeight: { value: 1_000 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 1_000));
      },
    },
  });

  let frames = 0;
  Object.assign(globalThis, {
    document,
    window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    // Counted, never run: a spring would schedule here, and the point of the
    // first fill is that the arrival does not need a frame at all.
    requestAnimationFrame: () => {
      frames += 1;
      return frames;
    },
    cancelAnimationFrame: () => {},
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  let controller: ReturnType<typeof useChatStreamScroll> | undefined;
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(scroller);
    controller = useChatStreamScroll({ scrollRef });
    return null;
  }

  const host = document.createElement('div');
  await act(async () => {
    mountedRoot = createRoot(host);
    mountedRoot.render(<Harness />);
  });
  assert.ok(controller);

  // The swap: ChatLayout's conversationKey effect, against a scroller holding
  // only the loading placeholder.
  await act(async () => {
    controller?.scrollToBottom({ behavior: 'instant' });
    controller?.resetInitialFill();
  });
  assert.equal(scroller.scrollTop, 0, 'nothing to scroll while the transcript is still loading');

  // The transcript arrives; ChatLayout's resize observer reports it.
  const framesBeforeArrival = frames;
  scrollHeight = 5_000;
  await act(async () => {
    controller?.scrollIfLocked();
  });

  assert.equal(scroller.scrollTop, 4_000, 'the arriving transcript is at the bottom');
  assert.equal(
    frames,
    framesBeforeArrival,
    'it got there in the same frame, without entering the spring',
  );
});
