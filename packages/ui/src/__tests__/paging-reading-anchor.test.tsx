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
 * A bookmark left on a Turn the last range evicted makes the restore effect
 * load around it over the range paging just published, and the transcript
 * stops advancing — the stall the E2E paging guard sees as a timeout.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { StoredMessage } from '@maka/core/session';
import { TranscriptScrollAuthorityProvider } from '../transcript-scroll-authority.js';
import { useChatScroll } from '../use-chat-scroll.js';

const originalGlobals = {
  CSS: globalThis.CSS,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  MutationObserver: globalThis.MutationObserver,
  Node: globalThis.Node,
  ResizeObserver: globalThis.ResizeObserver,
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

test('a wheel at the top edge reports its anchor before it loads earlier history', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  const mount = document.querySelector<HTMLElement>('#mount');
  const scroller = document.querySelector<HTMLElement>('#scroller');
  assert.ok(mount);
  assert.ok(scroller);

  let scrollHeight = 1_600;
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      // No scroll event follows a write: that is the edge under test.
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 600));
      },
    },
  });
  scroller.getBoundingClientRect = () => ({
    bottom: 600, height: 600, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0,
    toJSON: () => undefined,
  });

  class Inert {
    disconnect() {}
    observe() {}
    unobserve() {}
    takeRecords(): MutationRecord[] { return []; }
  }
  Object.assign(window, {
    cancelAnimationFrame: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  });
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value },
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: Inert,
    Node: window.Node,
    ResizeObserver: Inert,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const installTurns = (ids: readonly string[]): void => {
    scrollHeight = ids.length * 800;
    scroller.replaceChildren();
    ids.forEach((id, index) => {
      const element = document.createElement('article');
      element.dataset.turnId = id;
      const start = index * 800;
      element.getBoundingClientRect = () => ({
        bottom: start + 800 - scrollTop,
        height: 800,
        left: 0, right: 800, width: 800, x: 0,
        top: start - scrollTop,
        y: start - scrollTop,
        toJSON: () => undefined,
      });
      element.scrollIntoView = () => {
        scroller.scrollTop = start;
      };
      scroller.append(element);
    });
  };
  let anchor: string | undefined;
  const loads: Array<{ anchorTurnId?: string; anchorWhenAsked?: string }> = [];
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-paging',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      // A remembered position leaves the hook unpinned, as paging back does.
      restoreTarget: { turnId: 'turn-0' },
      onReadingAnchorChange: (turnId) => {
        anchor = turnId;
      },
      behavior: 'auto',
      hasOlderHistory: true,
      onLoadEarlierHistory: (anchorTurnId) => {
        loads.push({ anchorTurnId, anchorWhenAsked: anchor });
      },
    });
    return null;
  }

  installTurns(['turn-0', 'turn-1']);
  mountedRoot = createRoot(mount);
  await act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider>
      <Harness />
    </TranscriptScrollAuthorityProvider>,
  ));
  // Settle the authority on "unpinned, away from the tail", where the wheel's
  // own release publishes nothing and so refreshes no anchor.
  scroller.dispatchEvent(new window.Event('scroll'));
  assert.equal(anchor, 'turn-0', 'the restored position is the reading anchor');

  installTurns(['turn-earlier', 'turn-0']);
  scroller.scrollTop = 0;

  const wheel = new window.Event('wheel');
  Object.assign(wheel, { deltaY: -120, composedPath: () => [scroller] });
  scroller.dispatchEvent(wheel);

  assert.deepEqual(
    loads.at(-1),
    { anchorTurnId: 'turn-earlier', anchorWhenAsked: 'turn-earlier' },
    'the wheel bookmarks the Turn it anchors the load to',
  );
});
