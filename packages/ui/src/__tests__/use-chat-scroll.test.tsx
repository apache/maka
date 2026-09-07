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
import type { StoredMessage } from '@maka/core/session';
import {
  TranscriptScrollAuthorityProvider,
  useTranscriptScrollAuthority,
  type TranscriptScrollAuthority,
} from '../transcript-scroll-authority.js';
import { useChatScroll } from '../use-chat-scroll.js';

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

test('pages only toward reader input, including wheels at a bounded edge', async () => {
  const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
  const scroller = document.querySelector<HTMLElement>('#scroller')!;
  let scrollTop = 0;
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2400 },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, 1800)); },
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600 } as DOMRect);
  for (let index = 0; index < 4; index++) {
    const turn = document.createElement('article');
    turn.dataset.turnId = `turn-${index}`;
    turn.getBoundingClientRect = () => ({
      top: index * 600 - scrollTop, bottom: (index + 1) * 600 - scrollTop,
    } as DOMRect);
    scroller.append(turn);
  }
  class Observer { disconnect() {} observe() {} }
  Object.assign(globalThis, {
    document, window, HTMLElement: window.HTMLElement, Element: window.Element,
    MutationObserver: Observer, ResizeObserver: Observer,
    getComputedStyle: () => ({ overflowY: 'auto' }),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls: Array<{ direction: string; anchor?: string }> = [];
  let authority!: TranscriptScrollAuthority;
  function Harness({ more }: { more: boolean }) {
    const scrollRef = useRef(scroller);
    authority = useTranscriptScrollAuthority();
    useChatScroll({
      scrollRef, sessionId: 'guest', messages: [], behavior: 'auto',
      hasOlderHistory: more, hasNewerHistory: more,
      onLoadEarlierHistory: (anchor) => { calls.push({ direction: 'up', anchor }); },
      onLoadLaterHistory: (anchor) => { calls.push({ direction: 'down', anchor }); },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  const render = async (more: boolean) => act(() => mountedRoot!.render(
    <TranscriptScrollAuthorityProvider><Harness more={more} /></TranscriptScrollAuthorityProvider>,
  ));
  await render(true);
  assert.deepEqual(calls, [], 'mounting at a partial tail is not a request');
  scroller.scrollTop = 900;
  scroller.dispatchEvent(new window.Event('scroll'));
  scroller.scrollTop = 1000;
  scroller.dispatchEvent(new window.Event('scroll'));
  assert.deepEqual(calls, [
    { direction: 'up', anchor: 'turn-1' },
    { direction: 'down', anchor: 'turn-2' },
  ], 'overlapping edge bands must not reverse the requested direction');

  scroller.scrollTop = 1800;
  scroller.dispatchEvent(new window.Event('scroll'));
  assert.equal(authority.getSnapshot().pinned, false, 'a partial tail must not follow a page fill');
  const wheel = (target: HTMLElement, deltaY: number) => {
    const event = new window.Event('wheel', { bubbles: true });
    Object.defineProperty(event, 'deltaY', { value: deltaY });
    target.dispatchEvent(event);
  };
  calls.length = 0;
  wheel(scroller, 100);
  assert.deepEqual(calls, [{ direction: 'down', anchor: 'turn-3' }]);

  const nested = document.createElement('div');
  Object.defineProperties(nested, {
    clientHeight: { value: 100 }, scrollHeight: { value: 500 }, scrollTop: { value: 100 },
  });
  scroller.append(nested);
  calls.length = 0;
  wheel(nested, 100);
  assert.deepEqual(calls, [], 'scrolling a nested tool output must not page the transcript');

  scroller.scrollTop = 0;
  scroller.dispatchEvent(new window.Event('scroll'));
  calls.length = 0;
  wheel(scroller, -100);
  assert.deepEqual(calls, [{ direction: 'up', anchor: 'turn-0' }]);
  assert.equal(scroller.scrollTop, 1, 'keep native anchoring enabled at the start');
  await render(false);
  calls.length = 0;
  wheel(scroller, -100);
  scroller.scrollTop = 1800;
  scroller.dispatchEvent(new window.Event('scroll'));
  wheel(scroller, 100);
  assert.deepEqual(calls, [], 'do not request beyond authoritative history edges');
});

test('a session switch restores a Turn anchor after async fill and preserves tail intent', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  const mount = document.querySelector<HTMLElement>('#mount');
  const scroller = document.querySelector<HTMLElement>('#scroller');
  assert.ok(mount);
  assert.ok(scroller);

  let scrollHeight = 600;
  let scrollTop = 0;
  let dispatchCommandScroll = true;
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const resizeCallbacks: ResizeObserverCallback[] = [];
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 600));
      },
    },
  });
  scroller.getBoundingClientRect = () => ({
    bottom: 600,
    height: 600,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  });

  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  class TestMutationObserver {
    disconnect() {}
    observe() {}
    takeRecords(): MutationRecord[] { return []; }
  }
  Object.assign(window, {
    cancelAnimationFrame: (id: number) => frames.delete(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
  });
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value },
    document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MutationObserver: TestMutationObserver,
    Node: window.Node,
    ResizeObserver: TestResizeObserver,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const installTranscript = (
    height: number,
    turns: ReadonlyArray<{ id: string; start: number; height: number }>,
  ): void => {
    scrollHeight = height;
    scroller.replaceChildren();
    for (const turn of turns) {
      const element = document.createElement('article');
      element.dataset.turnId = turn.id;
      element.getBoundingClientRect = () => ({
        bottom: turn.start + turn.height - scrollTop,
        height: turn.height,
        left: 0,
        right: 800,
        top: turn.start - scrollTop,
        width: 800,
        x: 0,
        y: turn.start - scrollTop,
        toJSON: () => undefined,
      });
      element.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
        const block = typeof options === 'object' ? options.block : undefined;
        scroller.scrollTop = block === 'center'
          ? turn.start - 300 + turn.height / 2
          : turn.start;
        if (dispatchCommandScroll) scroller.dispatchEvent(new window.Event('scroll'));
      };
      scroller.append(element);
    }
  };
  const collapseTranscript = (): void => {
    scrollHeight = 600;
    scrollTop = 0;
    scroller.replaceChildren();
  };
  const deliverResize = (): void => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  };
  const flushFrames = async (): Promise<void> => {
    await act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  };

  const anchors = new Map<string, string>();
  const handledTargets: number[] = [];
  const unavailableRestores = new Map<string, string>();
  let authority: TranscriptScrollAuthority | undefined;
  let messageRevision = 0;
  let target: { turnId: string; nonce: number } | undefined;
  function Harness({ sessionId }: { sessionId: string }) {
    const scrollRef = useRef<HTMLElement | null>(scroller);
    authority = useTranscriptScrollAuthority();
    const unavailableTurnId = unavailableRestores.get(sessionId);
    const restoreTurnId = unavailableTurnId ?? anchors.get(sessionId);
    const restoreTarget = restoreTurnId
      ? { turnId: restoreTurnId, unavailable: unavailableTurnId === restoreTurnId }
      : undefined;
    useChatScroll({
      scrollRef,
      sessionId,
      messages: [{ id: `message-${messageRevision}` }] as StoredMessage[],
      target,
      restoreTarget,
      onTargetHandled: (nonce) => handledTargets.push(nonce),
      onReadingAnchorChange: (turnId) => {
        unavailableRestores.delete(sessionId);
        if (turnId) anchors.set(sessionId, turnId);
        else anchors.delete(sessionId);
      },
      behavior: 'auto',
    });
    return null;
  }

  const renderSession = async (sessionId: string): Promise<void> => {
    messageRevision += 1;
    await act(() => mountedRoot?.render(
      <TranscriptScrollAuthorityProvider>
        <Harness sessionId={sessionId} />
      </TranscriptScrollAuthorityProvider>,
    ));
  };

  installTranscript(3_000, [
    { id: 'turn-a-1', start: 0, height: 800 },
    { id: 'turn-a-2', start: 800, height: 600 },
    { id: 'turn-a-3', start: 1_400, height: 1_600 },
  ]);
  mountedRoot = createRoot(mount);
  await renderSession('session-a');
  assert.equal(scroller.scrollTop, 2_400);

  scroller.scrollTop = 900;
  scroller.dispatchEvent(new window.Event('scroll'));
  assert.equal(anchors.get('session-a'), 'turn-a-2');

  collapseTranscript();
  await renderSession('session-b');
  installTranscript(2_000, [{ id: 'turn-b-1', start: 0, height: 2_000 }]);
  deliverResize();
  assert.equal(scroller.scrollTop, 1_400);
  assert.equal(anchors.has('session-b'), false);

  collapseTranscript();
  await renderSession('session-a');
  assert.equal(authority?.getSnapshot().pinned, false);
  installTranscript(2_000, [{ id: 'turn-a-latest', start: 0, height: 2_000 }]);
  await renderSession('session-a');
  deliverResize();
  assert.equal(anchors.get('session-a'), 'turn-a-2');
  installTranscript(3_000, [
    { id: 'turn-a-1', start: 0, height: 800 },
    { id: 'turn-a-2', start: 800, height: 600 },
    { id: 'turn-a-3', start: 1_400, height: 1_600 },
  ]);
  await renderSession('session-a');
  await flushFrames();
  assert.equal(scroller.scrollTop, 800);
  assert.equal(scroller.querySelector<HTMLElement>('[data-turn-id="turn-a-2"]')
    ?.getBoundingClientRect().top, 0);
  assert.equal(authority?.getSnapshot().pinned, false);

  collapseTranscript();
  await renderSession('session-b');
  installTranscript(2_400, [{ id: 'turn-b-1', start: 0, height: 2_400 }]);
  deliverResize();
  assert.equal(scroller.scrollTop, 1_800);
  assert.equal(authority?.getSnapshot().pinned, true);

  // The same restore key can be handled successfully on one activation and
  // become unavailable on the next. The earlier success must not swallow the
  // later terminal result.
  collapseTranscript();
  await renderSession('session-a');
  installTranscript(2_000, [{ id: 'turn-a-visible', start: 0, height: 2_000 }]);
  await renderSession('session-a');
  await flushFrames();
  assert.equal(anchors.get('session-a'), 'turn-a-2');

  unavailableRestores.set('session-a', 'turn-a-2');
  await renderSession('session-a');
  await flushFrames();
  assert.equal(anchors.get('session-a'), 'turn-a-visible');
  assert.equal(unavailableRestores.has('session-a'), false);

  collapseTranscript();
  await renderSession('session-b');
  installTranscript(2_400, [{ id: 'turn-b-1', start: 0, height: 2_400 }]);
  deliverResize();
  assert.equal(scroller.scrollTop, 1_800);
  assert.equal(authority?.getSnapshot().pinned, true);

  // A command can land without producing a scroll event when layout or native
  // anchoring already put the Turn at the requested offset. Its semantic
  // reading position must still be reported before the user switches away.
  dispatchCommandScroll = false;
  target = { turnId: 'turn-b-1', nonce: 1 };
  await renderSession('session-b');
  await flushFrames();
  assert.equal(anchors.get('session-b'), 'turn-b-1');
  assert.deepEqual(handledTargets, [1]);
  await renderSession('session-b');
  await flushFrames();
  assert.deepEqual(handledTargets, [1]);

  target = undefined;
  // With no resident Turn to re-anchor to, abandoning the restore falls back
  // to the default tail intent and clears the stale reading anchor.
  anchors.set('session-b', 'turn-b-never-renders');
  collapseTranscript();
  await renderSession('session-c');
  collapseTranscript();
  await renderSession('session-b');
  assert.equal(authority?.getSnapshot().pinned, false);
  unavailableRestores.set('session-b', 'turn-b-never-renders');
  await renderSession('session-b');
  await flushFrames();
  assert.equal(authority?.getSnapshot().pinned, true);
  assert.equal(anchors.has('session-b'), false);
});
