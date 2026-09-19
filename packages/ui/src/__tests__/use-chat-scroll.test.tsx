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
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { VirtualizerHandle } from 'virtua';
import {
  TranscriptScrollAuthorityProvider,
  useTranscriptScrollAuthority,
  type TranscriptScrollAuthority,
} from '../transcript-scroll-authority.js';
import { useChatScroll } from '../use-chat-scroll.js';
import { createTranscriptViewportNavigation } from '../transcript-viewport-navigation.js';

const TURN_HEIGHT = 500;
const CLIENT_HEIGHT = 600;

const originalGlobals = {
  CSS: globalThis.CSS,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  getComputedStyle: globalThis.getComputedStyle,
  MutationObserver: globalThis.MutationObserver,
  Node: globalThis.Node,
  ResizeObserver: globalThis.ResizeObserver,
  window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
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

interface ScrollCall { index: number; align?: string; smooth?: boolean }

/**
 * A scroller whose Turns are `TURN_HEIGHT` tall rows of `turnIds`, addressed
 * through a virtualizer handle. Row elements exist only for `mounted` Turns, the
 * way a virtualizer mounts rows around the viewport.
 */
function setup(turnIds: string[]) {
  const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const resizeCallbacks = new Set<() => void>();
  class TestResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() { resizeCallbacks.add(this.callback); }
    unobserve() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
  }
  class TestMutationObserver {
    observe() {}
    disconnect() {}
  }
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  };
  const cancelFrame = (id: number) => { frames.delete(id); };
  Object.assign(window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame });
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value },
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    MutationObserver: TestMutationObserver,
    Node: window.Node,
    ResizeObserver: TestResizeObserver,
    window,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const scroller = document.querySelector<HTMLElement>('#scroller')!;
  let scrollTop = 0;
  const transcript = { turnIds };
  const contentHeight = (): number => Math.max(CLIENT_HEIGHT, transcript.turnIds.length * TURN_HEIGHT);
  Object.defineProperties(scroller, {
    clientHeight: { get: () => CLIENT_HEIGHT },
    scrollHeight: { get: contentHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, contentHeight() - CLIENT_HEIGHT)); },
    },
  });
  const calls: ScrollCall[] = [];
  const handle = {
    findItemIndex: (offset: number) => Math.max(0, Math.floor(offset / TURN_HEIGHT)),
    getItemOffset: (index: number) => index * TURN_HEIGHT,
    scrollToIndex: (index: number, options: { align?: string; smooth?: boolean } = {}) => {
      calls.push({ index, ...options });
      scroller.scrollTop = options.align === 'center'
        ? index * TURN_HEIGHT - (CLIENT_HEIGHT - TURN_HEIGHT) / 2
        : index * TURN_HEIGHT;
    },
  } as unknown as VirtualizerHandle;

  const focused: string[] = [];
  const mountRows = (mounted: readonly string[]): void => {
    scroller.replaceChildren();
    for (const turnId of mounted) {
      const row = document.createElement('section');
      row.dataset.turnId = turnId;
      row.focus = () => { focused.push(turnId); };
      scroller.append(row);
    }
  };

  return {
    document,
    window,
    scroller,
    transcript,
    calls,
    focused,
    handle,
    mountRows,
    resize(): void { for (const callback of [...resizeCallbacks]) callback(); },
    async flushFrames(count = 1): Promise<void> {
      for (let frame = 0; frame < count; frame += 1) {
        await act(() => {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(0);
        });
      }
    },
    readerScrollTo(top: number): void {
      const event = new window.Event('wheel', { bubbles: true });
      Object.defineProperties(event, {
        deltaY: { value: top < scrollTop ? -100 : 100 },
        composedPath: { value: () => [scroller] },
      });
      scroller.dispatchEvent(event);
      scroller.scrollTop = top;
      scroller.dispatchEvent(new window.Event('scroll'));
    },
  };
}

type Env = ReturnType<typeof setup>;

function mountHook(env: Env) {
  const state: {
    authority?: TranscriptScrollAuthority;
    highlighted: string | null;
    revealTurnAtStart?: (turnId: string, arrival: PromiseLike<unknown>) => void;
    measurement?: { shift: boolean; generation: number };
    anchors: Map<string, string | undefined>;
  } = { highlighted: null, anchors: new Map() };
  const viewportNavigation = createTranscriptViewportNavigation();
  function Harness(props: {
    sessionId: string;
    target?: { turnId: string; nonce: number; preserveFocus?: boolean };
    restoreTarget?: { turnId: string; unavailable?: boolean };
  }) {
    const scrollRef = useRef<HTMLElement | null>(env.scroller);
    const virtualizerRef = useRef<VirtualizerHandle | null>(env.handle);
    state.authority = useTranscriptScrollAuthority();
    const result = useChatScroll({
      scrollRef,
      virtualizerRef,
      sessionId: props.sessionId,
      turnIds: env.transcript.turnIds,
      measureStartMargin: () => 0,
      target: props.target,
      restoreTarget: props.restoreTarget,
      viewportNavigation,
      onReadingAnchorChange: (turnId) => { state.anchors.set(props.sessionId, turnId); },
      behavior: 'smooth',
    });
    state.highlighted = result.highlightedTurnId;
    state.revealTurnAtStart = result.revealTurnAtStart;
    state.measurement = result.measurement;
    return null;
  }
  mountedRoot = createRoot(env.document.querySelector('#mount')!);
  return {
    state,
    viewportNavigation,
    async render(props: Parameters<typeof Harness>[0]): Promise<void> {
      await act(() => mountedRoot?.render(
        <TranscriptScrollAuthorityProvider><Harness {...props} /></TranscriptScrollAuthorityProvider>,
      ));
    },
  };
}

const turns = (count: number, prefix = 'turn'): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

test('the reading anchor is the Turn the virtualizer maps under the offset', async () => {
  const env = setup(turns(6));
  const hook = mountHook(env);
  await hook.render({ sessionId: 's' });
  assert.equal(env.scroller.scrollTop, 6 * TURN_HEIGHT - CLIENT_HEIGHT);
  assert.equal(hook.state.anchors.get('s'), undefined, 'a pinned reader has no anchor');

  // No row is mounted at all: the mapping, not DOM measurement, names the Turn.
  await act(() => { env.readerScrollTo(2 * TURN_HEIGHT + 10); });
  assert.equal(hook.state.anchors.get('s'), 'turn-2');

  // Earlier Turns prepended above the reader, who stays on their Turn.
  env.transcript.turnIds = [...turns(2, 'earlier'), ...env.transcript.turnIds];
  await hook.render({ sessionId: 's' });
  assert.equal(env.scroller.scrollTop, 4 * TURN_HEIGHT + 10);
  await env.flushFrames(30);
  env.resize();
  assert.equal(hook.state.anchors.get('s'), 'turn-2');
  assert.equal(hook.state.authority?.getSnapshot().pinned, false);
});

test('the measurement cache moves with a prepend and starts over when the list is rearranged', async () => {
  const env = setup(turns(3));
  const hook = mountHook(env);
  await hook.render({ sessionId: 's' });
  assert.deepEqual(hook.state.measurement, { shift: false, generation: 0 });

  env.transcript.turnIds = [...env.transcript.turnIds, 'turn-3'];
  await hook.render({ sessionId: 's' });
  assert.deepEqual(hook.state.measurement, { shift: false, generation: 0 }, 'a Turn at the tail moves nothing');

  env.transcript.turnIds = ['earlier-0', ...env.transcript.turnIds];
  await hook.render({ sessionId: 's' });
  assert.deepEqual(hook.state.measurement, { shift: true, generation: 0 });

  // A filter cleared: Turns come back between the ones already there.
  env.transcript.turnIds = ['earlier-0', 'turn-0', 'filtered', 'turn-1', 'turn-2', 'turn-3'];
  await hook.render({ sessionId: 's' });
  assert.deepEqual(hook.state.measurement, { shift: false, generation: 1 });
});

test('a search target is revealed by index once per nonce, then focused and highlighted', async () => {
  const env = setup(turns(3));
  const hook = mountHook(env);
  await hook.render({ sessionId: 's', target: { turnId: 'turn-5', nonce: 1 } });
  await env.flushFrames();
  assert.deepEqual(env.calls, [], 'a Turn that is not loaded cannot be revealed yet');
  assert.equal(hook.state.highlighted, null);

  env.transcript.turnIds = turns(8);
  await hook.render({ sessionId: 's', target: { turnId: 'turn-5', nonce: 1 } });
  assert.deepEqual(env.calls, [{ index: 5, align: 'center', smooth: true }]);
  assert.equal(hook.state.authority?.getSnapshot().pinned, false);

  // The row mounts while the reveal settles; it is focused once it has.
  await env.flushFrames();
  assert.equal(hook.state.highlighted, null);
  env.mountRows(['turn-4', 'turn-5']);
  await env.flushFrames(30);
  assert.equal(hook.state.highlighted, 'turn-5');
  assert.deepEqual(env.focused, ['turn-5']);
  assert.equal(hook.state.anchors.get('s'), 'turn-4');

  env.scroller.scrollTop = 100;
  await hook.render({ sessionId: 's', target: { turnId: 'turn-5', nonce: 1 } });
  await env.flushFrames();
  assert.equal(env.calls.length, 1, 'a landed command does not repeat on render');
  assert.equal(env.scroller.scrollTop, 100);

  await hook.render({ sessionId: 's', target: { turnId: 'turn-5', nonce: 2 } });
  assert.equal(env.calls.length, 2, 'a new nonce is a new command');
});

test('a bookmark restores its Turn at the top edge, and an unavailable one falls back to the tail', async () => {
  const env = setup(turns(6, 'a'));
  const hook = mountHook(env);
  await hook.render({ sessionId: 'a', restoreTarget: { turnId: 'a-2' } });
  assert.equal(env.scroller.scrollTop, 2 * TURN_HEIGHT);
  assert.equal(hook.state.anchors.get('a'), undefined, 'a landing reader has not chosen a position yet');
  await env.flushFrames(30);
  assert.equal(hook.state.anchors.get('a'), 'a-2');
  assert.equal(hook.state.highlighted, null, 'a restore is not a search result');
  assert.equal(hook.state.authority?.getSnapshot().pinned, false);

  env.transcript.turnIds = turns(2, 'b');
  env.mountRows([]);
  await hook.render({ sessionId: 'b', restoreTarget: { turnId: 'b-gone' } });
  assert.equal(hook.state.authority?.getSnapshot().pinned, false, 'a bookmark waits for its Turn');
  await hook.render({ sessionId: 'b', restoreTarget: { turnId: 'b-gone', unavailable: true } });
  assert.equal(hook.state.authority?.getSnapshot().positioning, false);
  assert.equal(hook.state.anchors.get('b'), 'b-1', 'the Turn under the offset replaces the lost bookmark');
});

test('following the latest cancels a bookmark that has not landed', async () => {
  const env = setup(turns(1, 'a'));
  const hook = mountHook(env);
  await hook.render({ sessionId: 'a', restoreTarget: { turnId: 'a-9' } });
  assert.equal(hook.state.authority?.getSnapshot().pinned, false);
  await act(() => hook.viewportNavigation.followLatest('a'));
  env.transcript.turnIds = turns(10, 'a');
  await hook.render({ sessionId: 'a', restoreTarget: { turnId: 'a-9' } });
  env.resize();
  assert.deepEqual(env.calls, []);
  assert.equal(hook.state.authority?.getSnapshot().pinned, true);
  assert.equal(env.scroller.scrollTop, 10 * TURN_HEIGHT - CLIENT_HEIGHT);
});

test('a rail navigation releases the pin and scrolls its Turn to the top by index', async () => {
  const env = setup(turns(6));
  const hook = mountHook(env);
  await hook.render({ sessionId: 's' });
  assert.equal(hook.state.authority?.getSnapshot().pinned, true);
  await act(() => { hook.state.revealTurnAtStart?.('turn-3', Promise.resolve()); });
  assert.equal(env.scroller.scrollTop, 3 * TURN_HEIGHT);
  assert.equal(hook.state.authority?.getSnapshot().pinned, false);

  env.resize();
  assert.equal(env.scroller.scrollTop, 3 * TURN_HEIGHT, 'growth does not take a navigated reader back to the tail');
});

test('returning to the tail during a prepend landing is not undone by it', async () => {
  const env = setup(turns(4));
  const hook = mountHook(env);
  await hook.render({ sessionId: 's' });
  await act(() => { env.readerScrollTo(TURN_HEIGHT + 100); });
  assert.equal(hook.state.authority?.getSnapshot().pinned, false);

  env.transcript.turnIds = [...turns(2, 'earlier'), ...env.transcript.turnIds];
  await hook.render({ sessionId: 's' });
  assert.equal(env.scroller.scrollTop, 3 * TURN_HEIGHT + 100, 'the prepend left the reader on turn-1');

  // The landing repeats for several frames. A reader who asks for the tail in
  // that window is asking for a position of their own.
  await act(() => { hook.state.authority?.pinToTail(); });
  const tail = 6 * TURN_HEIGHT - CLIENT_HEIGHT;
  assert.equal(env.scroller.scrollTop, tail);
  await env.flushFrames();
  assert.equal(env.scroller.scrollTop, tail, 'the landing took the reader back off the tail');
});

test('a reader who moves while earlier history is on its way stays where they went', async () => {
  const env = setup(turns(6));
  const hook = mountHook(env);
  await hook.render({ sessionId: 's' });
  // Earlier history is asked for from the top, and the reader moves on before it arrives.
  await act(() => { env.readerScrollTo(0); });
  await act(() => { env.readerScrollTo(3 * TURN_HEIGHT + 100); });

  env.transcript.turnIds = [...turns(2, 'earlier'), ...env.transcript.turnIds];
  await hook.render({ sessionId: 's' });
  await env.flushFrames(4);
  assert.equal(env.scroller.scrollTop, 5 * TURN_HEIGHT + 100, 'the arriving history carried the reader back to the top');
});
