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
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { StoredMessage } from '@maka/core/session';
import {
  TranscriptScrollAuthorityProvider,
  useTranscriptScrollAuthority,
  type TranscriptScrollAuthority,
} from '../transcript-scroll-authority.js';
import { useChatScroll } from '../use-chat-scroll.js';
import { createTranscriptViewportNavigation } from '../transcript-viewport-navigation.js';

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
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

let mountedRoot: ReturnType<typeof createRoot> | undefined;

function wheel(target: HTMLElement, deltaY: number): void {
  const event = new window.Event('wheel', { bubbles: true });
  Object.defineProperties(event, {
    deltaY: { value: deltaY },
    composedPath: { value: () => [target] },
  });
  target.dispatchEvent(event);
}

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

/**
 * Installs the globals the scroll hook reads onto the LinkeDOM window, either
 * queueing rAF frames for explicit flushes or running them inline.
 */
const installScrollTestEnvironment = (
  document: Document,
  window: ReturnType<typeof parseHTML>['window'],
  { queueFrames = true }: { queueFrames?: boolean } = {},
): {
  frames: Map<number, FrameRequestCallback>;
  resizeCallbacks: ResizeObserverCallback[];
  /** Delivers a resize to whoever is observing `target` at this moment. */
  deliverResizeOf: (target: unknown) => void;
} => {
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const resizeCallbacks: ResizeObserverCallback[] = [];
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver {
    readonly targets = new Set<unknown>();
    constructor(readonly callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
      observers.push(this);
    }
    disconnect() { this.targets.clear(); }
    observe(target: unknown) { this.targets.add(target); }
    unobserve(target: unknown) { this.targets.delete(target); }
  }
  class TestMutationObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
    takeRecords(): MutationRecord[] { return []; }
  }
  Object.assign(window, {
    cancelAnimationFrame: (id: number) => frames.delete(id),
    requestAnimationFrame: queueFrames
      ? (callback: FrameRequestCallback) => {
          const id = ++frameId;
          frames.set(id, callback);
          return id;
        }
      : (callback: FrameRequestCallback) => {
          callback(0);
          return 0;
        },
  });
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
    requestAnimationFrame: window.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return {
    frames,
    resizeCallbacks,
    deliverResizeOf: (target: unknown): void => {
      for (const observer of [...observers]) {
        if (observer.targets.has(target)) observer.callback([], observer as unknown as ResizeObserver);
      }
    },
  };
};

function boxOf(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    height: bottom - top,
    left: 0,
    right: 800,
    width: 800,
    x: 0,
    y: top,
    toJSON: () => undefined,
  } as DOMRect;
}

/**
 * A scroller of `turnCount` equal Turns whose geometry the test drives. Turn
 * boxes are derived from the current offset, so a scroll moves every box the
 * way a real one does.
 */
function createTranscript(
  document: Document,
  window: ReturnType<typeof parseHTML>['window'],
  options: { clientHeight: number; turnHeight: number; turnCount: number },
) {
  const scroller = document.querySelector<HTMLElement>('#scroller');
  assert.ok(scroller);
  let scrollTop = 0;
  let turnCount = options.turnCount;
  let clientHeight = options.clientHeight;
  const contentHeight = (): number =>
    Math.max(clientHeight, turnCount * options.turnHeight);
  Object.defineProperties(scroller, {
    clientHeight: { get: () => clientHeight },
    scrollHeight: { get: () => contentHeight() },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, contentHeight() - clientHeight));
      },
    },
  });
  scroller.getBoundingClientRect = () => boxOf(0, clientHeight);
  const install = (): void => {
    scroller.replaceChildren();
    for (let index = 0; index < turnCount; index += 1) {
      const turn = document.createElement('article');
      turn.dataset.turnId = `turn-${index}`;
      const start = index * options.turnHeight;
      turn.getBoundingClientRect = () =>
        boxOf(start - scrollTop, start + options.turnHeight - scrollTop);
      turn.scrollIntoView = () => { scroller.scrollTop = start; };
      scroller.append(turn);
    }
  };
  install();
  return {
    scroller,
    get scrollTop(): number { return scrollTop; },
    /** The viewport alone changes; a real one re-clamps its offset too. */
    setClientHeight(next: number): void {
      clientHeight = next;
      scroller.scrollTop = scrollTop;
    },
    setTurnCount(next: number): void {
      turnCount = next;
      install();
      // A real scroller clamps its offset the moment its content shrinks.
      scroller.scrollTop = scrollTop;
    },
    /** A reader gesture and the scroll it produces, in that order. */
    readerScrollTo(top: number): void {
      const delta = top - scrollTop;
      if (delta === 0) return;
      wheel(scroller, delta);
      scroller.scrollTop = top;
      scroller.dispatchEvent(new window.Event('scroll'));
    },
  };
}

test('history loads follow the reader band, in both directions, once per direction', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  installScrollTestEnvironment(document, window, { queueFrames: false });
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 4,
  });

  const calls: string[] = [];
  const resolvers: Array<() => void> = [];
  const load = (direction: string) => (): Promise<boolean> => {
    calls.push(direction);
    return new Promise<boolean>((resolve) => resolvers.push(() => resolve(true)));
  };
  let history = { older: true, newer: true };
  function Harness({ older, newer }: { older: boolean; newer: boolean }) {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-band',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      behavior: 'auto',
      hasOlderHistory: older,
      hasNewerHistory: newer,
      onPrefetchHistory: (edge) => load(edge === 'older' ? 'up' : 'down')(),
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  const render = async (): Promise<void> => act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider>
      <Harness older={history.older} newer={history.newer} />
    </TranscriptScrollAuthorityProvider>,
  ));

  await render();
  // Opened at the tail: nothing lies below, so the newer edge is inside the
  // band even though the reader never moved.
  assert.equal(transcript.scrollTop, 1_800);
  assert.deepEqual(calls, ['down']);

  calls.length = 0;
  transcript.readerScrollTo(900);
  // 900px above and 900px below, both inside two screens. The downward fetch
  // is already in flight, so only the older edge is asked.
  assert.deepEqual(calls, ['up']);
  transcript.readerScrollTo(800);
  assert.deepEqual(calls, ['up'], 'a direction with a request in flight is not asked again');

  // Both pages land, and the edges they established close the transcript.
  history = { older: false, newer: false };
  await render();
  await act(async () => {
    for (const resolve of resolvers.splice(0)) resolve();
  });
  calls.length = 0;
  transcript.readerScrollTo(200);
  assert.deepEqual(calls, [], 'no request beyond an authoritative history edge');

  // Only the tail is open now: the reader moving up still asks for it,
  // because what decides is the band, not the direction of the gesture.
  history = { older: false, newer: true };
  await render();
  transcript.readerScrollTo(1_000);
  assert.deepEqual(calls, ['down']);
});

test('a failed fill is not reissued until the reader moves again', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  installScrollTestEnvironment(document, window, { queueFrames: false });
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 8,
  });

  let requests = 0;
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-failing',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      behavior: 'auto',
      hasOlderHistory: true,
      onPrefetchHistory: () => {
        requests += 1;
        return Promise.reject(new Error('the range read failed'));
      },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>,
  ));

  await act(async () => { transcript.readerScrollTo(0); });
  // A failed read leaves the geometry and the history flags exactly as they
  // were, so re-checking on its own would ask again forever.
  assert.equal(requests, 1);
  await act(async () => {});
  assert.equal(requests, 1);
});

test('a fill that issued no read is not chained into another one', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  installScrollTestEnvironment(document, window, { queueFrames: false });
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 8,
  });

  let requests = 0;
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-idle',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      behavior: 'auto',
      hasOlderHistory: true,
      // The first read issued; the window it answered is then the window the
      // next ask is made against, so the range refuses to read it again.
      onPrefetchHistory: () => Promise.resolve(++requests === 1),
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>,
  ));

  await act(async () => { transcript.readerScrollTo(0); });

  assert.equal(requests, 1, 'the landed read waits for input settlement');
  await act(() => transcript.scroller.dispatchEvent(new window.Event('scrollend')));
  assert.equal(requests, 2, 'settlement rechecks the published range, whose refusal ends it');
});

test('an older request at offset zero does not move the reader', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  installScrollTestEnvironment(document, window, { queueFrames: false });
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 8,
  });

  let requests = 0;
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-top',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      behavior: 'auto',
      hasOlderHistory: true,
      onPrefetchHistory: () => {
        requests += 1;
        return new Promise<boolean>(() => undefined);
      },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>,
  ));
  assert.equal(requests, 0, 'the tail of a deep transcript is nowhere near the older edge');

  transcript.readerScrollTo(0);
  assert.equal(requests, 1);
  assert.equal(transcript.scrollTop, 0, 'publication owns anchoring; input must not nudge the reader');
});

test('idle range admission commits the React DOM before a subsequent input can begin', async () => {
  const navigation = createTranscriptViewportNavigation();
  const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
  const { frames } = installScrollTestEnvironment(document, window);
  const transcript = createTranscript(document, window, {
    clientHeight: 400, turnHeight: 400, turnCount: 12,
  });
  let authority!: TranscriptScrollAuthority;
  let publish!: (value: string) => void;
  function Harness() {
    const [value, setValue] = useState('old');
    publish = setValue;
    authority = useTranscriptScrollAuthority();
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({ scrollRef, sessionId: 'admission', messages: [], behavior: 'auto', viewportNavigation: navigation });
    return <span>{value}</span>;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(<TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>));
  await act(async () => {
    navigation.commitRange('admission', () => publish('new'));
    await Promise.resolve();
    assert.equal(document.querySelector('#mount')!.textContent, 'new',
      'an admitted update must not remain in React scheduling after its idle check');
  });
  await act(async () => {
    navigation.commitRange('admission', () => publish('held'));
    const down = new window.Event('pointerdown');
    Object.defineProperties(down, {
      button: { value: 0 }, pointerType: { value: 'mouse' }, pointerId: { value: 1 },
    });
    transcript.scroller.dispatchEvent(down);
    await Promise.resolve();
    assert.equal(document.querySelector('#mount')!.textContent, 'new',
      'input that starts before admission must hold the queued update');
  });
  await act(() => document.dispatchEvent(new window.Event('pointerup')));
  await act(() => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  });
  assert.equal(document.querySelector('#mount')!.textContent, 'held');
});

test('a source publication survives viewport unmount without another source update', async () => {
  const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
  installScrollTestEnvironment(document, window);
  const transcript = createTranscript(document, window, { clientHeight: 400, turnHeight: 400, turnCount: 12 });
  const navigation = createTranscriptViewportNavigation();
  let publish!: (value: string) => void;
  let show!: (value: boolean) => void;
  function Surface() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({ scrollRef, sessionId: 'session', messages: [], behavior: 'auto', viewportNavigation: navigation });
    return null;
  }
  function Harness() {
    const [value, setValue] = useState('old');
    const [visible, setVisible] = useState(true);
    publish = setValue; show = setVisible;
    return <><span>{value}</span>{visible && <Surface />}</>;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(<TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>));
  await act(() => wheel(transcript.scroller, -100));
  await act(() => navigation.commitRange('session', () => publish('latest')));
  assert.equal(document.querySelector('#mount')!.textContent, 'old');
  await act(() => show(false));
  assert.equal(document.querySelector('#mount')!.textContent, 'latest');
  await act(() => show(true));
  assert.equal(document.querySelector('#mount')!.textContent, 'latest');
});

for (const hasOlder of [false, true]) {
  test(`stationary upward input ${hasOlder ? 'reads available history' : 'keeps following without history'}`, async () => {
    const navigation = createTranscriptViewportNavigation();
    const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
    const { frames, deliverResizeOf } = installScrollTestEnvironment(document, window);
    const transcript = createTranscript(document, window, {
      clientHeight: 400, turnHeight: 200, turnCount: 1,
    });
    let authority!: TranscriptScrollAuthority;
    let requests = 0;
    function Harness() {
      authority = useTranscriptScrollAuthority();
      const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
      useChatScroll({
        scrollRef, sessionId: 'short', messages: [], behavior: 'auto', viewportNavigation: navigation,
        hasOlderHistory: hasOlder,
        onPrefetchHistory: () => { requests++; return new Promise<boolean>(() => {}); },
      });
      return null;
    }
    const frame = async () => act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
    mountedRoot = createRoot(document.querySelector('#mount')!);
    await act(() => mountedRoot?.render(<TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>));
    await frame(); // Initial fill may already be in flight when the reader asks.
    await act(() => wheel(transcript.scroller, -100));
    let publications = 0;
    await act(() => navigation.commitRange('short', () => {
      publications++;
      transcript.setTurnCount(3);
      if (hasOlder) {
        [...transcript.scroller.children].forEach((turn, index) => {
          (turn as HTMLElement).dataset.turnId = `turn-${index - 2}`;
        });
      }
    }));
    assert.equal(publications, 0, 'input holds publication, including an accepted history request');
    await frame(); await frame();
    assert.equal(requests, hasOlder ? 1 : 0);
    assert.equal(publications, 1);
    assert.equal(authority.getSnapshot().pinned, !hasOlder);
    const beforeGrowth = transcript.scrollTop;
    await act(() => {
      transcript.setTurnCount(4);
      deliverResizeOf(transcript.scroller);
    });
    assert.equal(transcript.scrollTop, hasOlder ? beforeGrowth : 400);
  });
}

test('a held fill publishes before trimming or chaining from the new geometry', async () => {
  const navigation = createTranscriptViewportNavigation();
  const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
  const { frames } = installScrollTestEnvironment(document, window);
  const transcript = createTranscript(document, window, {
    clientHeight: 400, turnHeight: 400, turnCount: 12,
  });
  let authority!: TranscriptScrollAuthority;
  let finishRead!: () => void;
  let requests = 0;
  let publications = 0;
  const retained: string[] = [];
  function Harness() {
    authority = useTranscriptScrollAuthority();
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef, sessionId: 'held-fill', messages: [], behavior: 'auto', viewportNavigation: navigation,
      hasOlderHistory: true,
      onPrefetchHistory: () => {
        requests++;
        return new Promise<boolean>((resolve) => {
          finishRead = () => {
            navigation.commitRange('held-fill', () => {
              publications++;
              transcript.setTurnCount(14);
              [...transcript.scroller.children].forEach((turn, index) => {
                (turn as HTMLElement).dataset.turnId = `turn-${index - 2}`;
              });
            });
            resolve(true);
          };
        });
      },
      onRetainWindow: (range) => { retained.push(range.firstTurnId); },
    });
    return null;
  }
  const frame = async () => act(() => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(0);
  });
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(<TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>));
  await frame();
  retained.length = 0;
  await act(() => {
    const down = new window.Event('pointerdown');
    Object.defineProperties(down, {
      button: { value: 0 }, pointerType: { value: 'mouse' }, pointerId: { value: 1 },
    });
    transcript.scroller.dispatchEvent(down);
    transcript.scroller.scrollTop = 0;
    transcript.scroller.dispatchEvent(new window.Event('scroll'));
  });
  assert.equal(requests, 1);
  await act(() => finishRead());
  assert.equal(publications, 0);
  assert.deepEqual(retained, [], 'published IDs cannot trim source while its new page is held');
  assert.equal(requests, 1, 'a held response must not chain reads using stale geometry');
  await act(() => document.dispatchEvent(new window.Event('pointerup')));
  await frame(); await frame();
  assert.equal(publications, 1);
  assert.equal(retained.at(-1), 'turn--2', 'the new published band includes the older page');
});

test('a transcript change re-reads the band while the reader stays at the tail', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  installScrollTestEnvironment(document, window, { queueFrames: false });
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 8,
  });

  let requests = 0;
  function Harness({ messages }: { messages: readonly StoredMessage[] }) {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-tail',
      messages,
      behavior: 'auto',
      hasOlderHistory: true,
      onPrefetchHistory: () => {
        requests += 1;
        return new Promise<boolean>(() => undefined);
      },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  const render = async (messages: readonly StoredMessage[]): Promise<void> =>
    act(() => mountedRoot?.render(
      <TranscriptScrollAuthorityProvider><Harness messages={messages} /></TranscriptScrollAuthorityProvider>,
    ));

  await render([{ id: 'message-1' }] as StoredMessage[]);
  assert.equal(requests, 0);
  assert.equal(transcript.scrollTop, 4_200);

  // A trim leaves the reader pinned at a tail with barely a screen above it.
  // Nobody scrolled, so only the transcript itself can report the band.
  transcript.setTurnCount(2);
  transcript.scroller.scrollTop = transcript.scroller.scrollHeight;
  await render([{ id: 'message-2' }] as StoredMessage[]);
  assert.equal(requests, 1);
});

test('the retained window is the band around the reader, and an unmounted bookmark cannot freeze it', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  installScrollTestEnvironment(document, window, { queueFrames: false });
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 20,
  });

  const retained: Array<{ firstTurnId: string; lastTurnId: string }> = [];
  function Harness({
    messages,
    unavailable,
  }: { messages: readonly StoredMessage[]; unavailable: boolean }) {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-window',
      messages,
      restoreTarget: { turnId: 'turn-never-mounted', unavailable },
      behavior: 'auto',
      onRetainWindow: (value) => { retained.push(value); },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  const render = async (
    messages: readonly StoredMessage[],
    unavailable: boolean,
  ): Promise<void> => act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider>
      <Harness messages={messages} unavailable={unavailable} />
    </TranscriptScrollAuthorityProvider>,
  ));

  // A bookmark whose Turn is not mounted cannot be trimmed away, so waiting
  // for it would only let the window grow without a bound. The window is four
  // screens of Turns around a scrollport 20 screens deep.
  await render([{ id: 'message-1' }] as StoredMessage[], false);
  assert.equal(transcript.scrollTop, 11_400);
  assert.deepEqual(retained.at(-1), { firstTurnId: 'turn-14', lastTurnId: 'turn-19' });

  retained.length = 0;
  await render([{ id: 'message-2' }] as StoredMessage[], true);
  assert.deepEqual(retained.at(-1), { firstTurnId: 'turn-14', lastTurnId: 'turn-19' });

  retained.length = 0;
  transcript.readerScrollTo(6_000);
  assert.deepEqual(retained, [], 'trim waits for the input to finish');
  transcript.scroller.dispatchEvent(new window.Event('scrollend'));
  assert.deepEqual(retained.at(-1), { firstTurnId: 'turn-5', lastTurnId: 'turn-15' });

  // Six screens is the threshold: with less than that beyond the scrollport in
  // both directions there is nothing worth dropping.
  transcript.setTurnCount(8);
  transcript.readerScrollTo(2_000);
  retained.length = 0;
  transcript.readerScrollTo(2_100);
  assert.deepEqual(retained, []);
});

test('a viewport that grows fills the band it just widened, without a reader gesture', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  const { deliverResizeOf } = installScrollTestEnvironment(document, window, {
    queueFrames: false,
  });
  const transcript = createTranscript(document, window, {
    clientHeight: 400, turnHeight: 600, turnCount: 10,
  });

  const edges: string[] = [];
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-grow',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      behavior: 'auto',
      hasOlderHistory: true,
      onPrefetchHistory: (edge) => {
        edges.push(edge);
        return new Promise<boolean>(() => undefined);
      },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>,
  ));

  transcript.readerScrollTo(1_000);
  assert.deepEqual(edges, [], '1000px above is outside two 400px screens');

  transcript.setClientHeight(800);
  await act(async () => { deliverResizeOf(transcript.scroller); });
  assert.deepEqual(edges, ['older'], 'the same 1000px is inside two 800px screens');

  await act(async () => { deliverResizeOf(transcript.scroller); });
  assert.deepEqual(edges, ['older'], 'the in-flight guard still holds across resizes');
});

test('a viewport that shrinks trims what it just pushed beyond the band', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  const { deliverResizeOf } = installScrollTestEnvironment(document, window, {
    queueFrames: false,
  });
  const transcript = createTranscript(document, window, {
    clientHeight: 1_000, turnHeight: 600, turnCount: 18,
  });

  const retained: Array<{ firstTurnId: string; lastTurnId: string }> = [];
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    useChatScroll({
      scrollRef,
      sessionId: 'session-shrink',
      messages: [{ id: 'message-1' }] as StoredMessage[],
      behavior: 'auto',
      onRetainWindow: (value) => { retained.push(value); },
    });
    return null;
  }
  mountedRoot = createRoot(document.querySelector('#mount')!);
  await act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>,
  ));

  transcript.readerScrollTo(4_000);
  retained.length = 0;
  transcript.readerScrollTo(4_100);
  transcript.scroller.dispatchEvent(new window.Event('scrollend'));
  assert.deepEqual(retained, [], 'nothing lies six 1000px screens away');

  transcript.setClientHeight(400);
  await act(async () => { deliverResizeOf(transcript.scroller); });
  assert.deepEqual(retained.at(-1), { firstTurnId: 'turn-4', lastTurnId: 'turn-10' });
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
  scroller.getBoundingClientRect = () => boxOf(0, 600);

  const { frames, resizeCallbacks } = installScrollTestEnvironment(document, window);

  const installTranscript = (
    height: number,
    turns: ReadonlyArray<{ id: string; start: number; height: number }>,
  ): void => {
    scrollHeight = height;
    scroller.replaceChildren();
    for (const turn of turns) {
      const element = document.createElement('article');
      element.dataset.turnId = turn.id;
      element.getBoundingClientRect = () =>
        boxOf(turn.start - scrollTop, turn.start + turn.height - scrollTop);
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
  const viewportNavigation = createTranscriptViewportNavigation();
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
      viewportNavigation,
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

  wheel(scroller, -100);
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

  // A send/return-to-latest clears a pending bookmark. Its old frame must not
  // scroll to the historical Turn if that Turn arrives in a later batch.
  anchors.set('session-a', 'turn-a-2');
  collapseTranscript();
  await renderSession('session-a');
  assert.equal(authority?.getSnapshot().pinned, false);
  anchors.delete('session-a');
  await renderSession('session-a');
  assert.equal(authority?.getSnapshot().pinned, false, 'clearing a bookmark is not a viewport command');
  await act(() => viewportNavigation.followLatest('session-a'));
  installTranscript(3_000, [
    { id: 'turn-a-2', start: 0, height: 800 },
    { id: 'turn-a-latest', start: 800, height: 2_200 },
  ]);
  await renderSession('session-a');
  deliverResize();
  await flushFrames();
  assert.equal(authority?.getSnapshot().pinned, true);
  assert.equal(scroller.scrollTop, 2_400);
  assert.equal(anchors.has('session-a'), false);

  wheel(scroller, -100);
  scroller.scrollTop = 1_000;
  scroller.dispatchEvent(new window.Event('scroll'));
  assert.equal(anchors.get('session-a'), 'turn-a-latest');
  scroller.dispatchEvent(new window.Event('scrollend'));
  installTranscript(800, [{ id: 'geometry-resident', start: 0, height: 800 }]);
  scroller.scrollTop = scroller.scrollTop;
  await renderSession('session-a');
  deliverResize();
  assert.equal(authority?.getSnapshot().pinned, false);
  assert.equal(authority?.getSnapshot().awayFromTail, false);
  assert.equal(anchors.get('session-a'), 'turn-a-latest', 'range geometry does not report a new reading intent');
});

test('a target lands on the render that mounts its Turn, whatever moved the range', async () => {
  const { document, window } = parseHTML(
    '<main id="mount"></main><section id="scroller"></section>',
  );
  const { frames } = installScrollTestEnvironment(document, window);
  const transcript = createTranscript(document, window, {
    clientHeight: 600, turnHeight: 600, turnCount: 3,
  });

  // The Renderer owns the window now: a jump to an unloaded Turn changes the
  // resident range without touching the message list the shell passes down.
  const messages = [{ id: 'message-1' }] as StoredMessage[];
  const handledTargets: number[] = [];
  let highlighted: string | null = null;
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(transcript.scroller);
    const result = useChatScroll({
      scrollRef,
      sessionId: 'session-jump',
      messages,
      target: { turnId: 'turn-5', nonce: 7 },
      onTargetHandled: (nonce) => handledTargets.push(nonce),
      behavior: 'auto',
    });
    highlighted = result.highlightedTurnId;
    return null;
  }
  const render = async (): Promise<void> => act(() => mountedRoot?.render(
    <TranscriptScrollAuthorityProvider><Harness /></TranscriptScrollAuthorityProvider>,
  ));
  const flushFrames = async (): Promise<void> => {
    await act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  };

  mountedRoot = createRoot(document.querySelector('#mount')!);
  await render();
  await flushFrames();
  assert.equal(highlighted, null, 'a Turn that is not mounted cannot be revealed yet');
  assert.deepEqual(handledTargets, []);

  transcript.setTurnCount(8);
  await render();
  await flushFrames();
  assert.equal(highlighted, 'turn-5');
  assert.deepEqual(handledTargets, [7]);
  assert.equal(transcript.scrollTop, 3_000, 'the reveal puts the Turn at the top edge');
});
