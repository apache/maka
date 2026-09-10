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
import { act, createElement, createRef, Fragment, useRef, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { StoredMessage } from '@maka/core/session';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  TranscriptScrollAuthorityProvider,
  TranscriptScrollButton,
  useTranscriptScrollAuthority,
  useChatScroll,
  type TranscriptScrollAuthority,
} from '@maka/ui/testing';
import {
  createAppShellSessionUiStateController,
  TranscriptReadingPositionController,
  type TranscriptReadingPositionCommands,
  type TranscriptHistoryPending,
} from '../../renderer/features/conversation/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

test('preparing a send follows the new prompt and streaming growth, then lets the reader leave again', async () => {
  const fixture = viewportFixture();
  await fixture.render();
  await fixture.readAt(1000);
  assert.equal(fixture.pinned(), false);
  assert.equal(fixture.sessionUi.transcriptReadingAnchorBySessionRef.current['session-a']?.turnId, 'history');

  let prepared: boolean | undefined;
  await act(async () => { prepared = await fixture.commands.current!.prepareSend('session-a'); });
  assert.equal(prepared, true);
  assert.equal(fixture.latestReads(), 1);
  assert.equal(fixture.pinned(), true);
  assert.equal(fixture.scroller.scrollTop, 2400);

  await fixture.append('new-question', 200);
  const prompt = fixture.scroller.querySelector<HTMLElement>('[data-turn-id="new-question"]');
  assert.ok(prompt);
  assert.ok(prompt.getBoundingClientRect().top < 600, 'the newly submitted prompt enters the viewport');
  assert.equal(fixture.scroller.scrollTop, 2600);
  await fixture.append('streaming-answer', 1200);
  assert.equal(fixture.scroller.scrollTop, 3800, 'stream growth remains under the same tail pin');

  await fixture.readAt(500);
  await fixture.append('later-streaming-content', 500);
  assert.equal(fixture.pinned(), false, 'ordinary message updates must not replay the consumed send command');
  assert.equal(fixture.scroller.scrollTop, 500);
});

test('reading a live Turn without a durable sequence preserves its Turn identity', async () => {
  const fixture = viewportFixture();
  const sequenceForTurn = fixture.controller.store.sequenceForTurn;
  fixture.controller.store.sequenceForTurn = (turnId) => turnId === 'latest' ? null : sequenceForTurn(turnId);
  const readingCalls: Array<{ sequence: number | null; turnId?: string }> = [];
  fixture.controller.setReadingAnchor = async (sequence, turnId) => { readingCalls.push({ sequence, turnId }); };
  await fixture.render();
  await fixture.readAt(1900);

  assert.equal(fixture.pinned(), false);
  assert.deepEqual(fixture.sessionUi.transcriptReadingAnchorBySessionRef.current['session-a'], { turnId: 'latest' });
  assert.deepEqual(readingCalls, [{ sequence: null, turnId: 'latest' }]);
});

test('a send is accepted before latest history loads and its old completion cannot move a new Session viewport', async () => {
  const fixture = viewportFixture();
  const latest = deferred<void>();
  fixture.controller.loadLatest = () => latest.promise;
  await fixture.render();
  await fixture.readAt(1000);
  await act(async () => { assert.equal(await fixture.commands.current!.prepareSend('session-a'), true); });
  assert.equal(fixture.pinned(), true, 'local admission must not wait for the latest range');

  await fixture.switchSession('session-b');
  await fixture.readAt(900);
  await act(async () => { latest.resolve(); });

  assert.equal(fixture.pinned(), false);
  assert.equal(fixture.scroller.scrollTop, 900);
  await fixture.append('session-b-growth', 600);
  assert.equal(fixture.scroller.scrollTop, 900);
});

for (const direction of ['earlier', 'later'] as const) {
  test(`${direction} history navigation supersedes the background range load of an accepted send`, async () => {
    const fixture = viewportFixture();
    const latest = deferred<void>();
    fixture.controller.loadLatest = () => latest.promise;
    await fixture.render();
    await fixture.readAt(1000);
    await act(async () => { assert.equal(await fixture.commands.current!.prepareSend('session-a'), true); });
    await fixture.activateHistoryGap(direction);
    const readerTop = fixture.scroller.scrollTop;
    await act(async () => { latest.resolve(); });

    assert.equal(fixture.pinned(), false);
    assert.equal(fixture.scroller.scrollTop, readerTop);
  });
}

test('a prepared send cancels an outstanding bookmark frame before it can scroll to history', async () => {
  const fixture = viewportFixture();
  fixture.sessionUi.setTranscriptReadingAnchor('session-a', { turnId: 'history', sequence: 0 });
  await fixture.render();
  assert.equal(fixture.pinned(), false);

  await act(async () => { assert.equal(await fixture.commands.current!.prepareSend('session-a'), true); });
  await fixture.flushFrames();
  await fixture.append('new-question', 200);

  assert.equal(fixture.pinned(), true);
  assert.equal(fixture.scroller.scrollTop, 2600);
});

test('the return-to-latest button consumes a pending bookmark frame and permits subsequent reader navigation', async () => {
  const fixture = viewportFixture({ returnButton: true });
  const latest = deferred<void>();
  fixture.controller.loadLatest = () => latest.promise;
  fixture.controller.store.range = () => ({ sessionId: 'session-a', hasNewer: true });
  fixture.sessionUi.setTranscriptReadingAnchor('session-a', { turnId: 'history', sequence: 0 });
  await fixture.render();
  assert.equal(fixture.pinned(), false);

  await fixture.clickReturnToLatest();
  await fixture.flushFrames();
  assert.equal(fixture.pinned(), true, 'the captured restore must not reclaim the explicit tail pin');
  assert.equal(fixture.scroller.scrollTop, 2400);

  await fixture.readAt(1000);
  await act(async () => { latest.resolve(); });
  await fixture.append('later-content', 200);
  assert.equal(fixture.pinned(), false, 'the reader can leave while the latest range is pending');
  assert.equal(fixture.scroller.scrollTop, 1000);
});

test('geometry changes from the latest range do not cancel the background load of an accepted send', async () => {
  const fixture = viewportFixture();
  const latest = deferred<void>();
  fixture.controller.loadLatest = () => latest.promise;
  await fixture.render();
  await fixture.readAt(1000);
  const readingCalls: Array<number | null> = [];
  fixture.controller.setReadingAnchor = async (sequence: number | null) => { readingCalls.push(sequence); };
  await act(async () => { assert.equal(await fixture.commands.current!.prepareSend('session-a'), true); });

  await fixture.replaceRangeFromHost();
  await act(async () => { latest.resolve(); });

  assert.deepEqual(fixture.visibleTurns(), ['latest-b']);
  assert.deepEqual(readingCalls, [], 'content geometry must not install a new history reading intent');
  assert.equal(fixture.pinned(), true);
  await fixture.append('new-question', 200);
  assert.equal(fixture.scroller.scrollTop, 400);
});

test('the reader can leave an accepted send while its latest range is still loading', async () => {
  const fixture = viewportFixture();
  const latest = deferred<void>();
  fixture.controller.loadLatest = () => latest.promise;
  await fixture.render();
  await fixture.readAt(1900);
  await act(async () => { assert.equal(await fixture.commands.current!.prepareSend('session-a'), true); });

  await fixture.readAt(1000);
  await act(async () => { latest.resolve(); });

  assert.equal(fixture.pinned(), false);
  assert.equal(fixture.scroller.scrollTop, 1000);
});

function viewportFixture(options: { returnButton?: boolean } = {}) {
  const original = {
    CSS: globalThis.CSS, document: globalThis.document, window: globalThis.window,
    Element: globalThis.Element, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node,
    MutationObserver: globalThis.MutationObserver, ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<main id="mount"></main><section id="scroller"></section>');
  const mount = document.querySelector<HTMLElement>('#mount')!;
  const scroller = document.querySelector<HTMLElement>('#scroller')!;
  let height = 3000;
  let top = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const resizeCallbacks = new Set<ResizeObserverCallback>();
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 600)); } },
  });
  const rectangle = (y: number, size: number): DOMRect => ({
    top: y, bottom: y + size, height: size, left: 0, right: 800, width: 800,
    x: 0, y, toJSON: () => undefined,
  });
  scroller.getBoundingClientRect = () => rectangle(0, 600);
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
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
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  Object.assign(globalThis, {
    CSS: { escape: (value: string) => value }, document, window,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node,
    MutationObserver: TestMutationObserver, ResizeObserver: TestResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const messages: StoredMessage[] = [];
  const addTurn = (id: string, start: number, size: number) => {
    const article = document.createElement('article');
    article.dataset.turnId = id;
    article.getBoundingClientRect = () => rectangle(start - top, size);
    article.scrollIntoView = () => { scroller.scrollTop = start; };
    scroller.append(article);
    messages.push({ id, type: 'user', turnId: id, ts: 1, text: id });
  };
  addTurn('history', 0, 1800);
  addTurn('latest', 1800, 1200);
  let reads = 0;
  const controller = {
    loadAround: async () => {}, loadBefore: async () => {}, loadAfter: async () => {},
    loadLatest: async () => { reads += 1; }, setReadingAnchor: async (_sequence: number | null, _turnId?: string) => {},
    store: {
      sessionId: 'session-a',
      range: () => ({ sessionId: 'session-a' }),
      sequenceForTurn: (turnId: string) => {
        const sequence = messages.findIndex((message) => message.turnId === turnId);
        return sequence < 0 ? null : sequence;
      },
      newestDurableUserSequence: () => 1,
      snapshot: () => ({ messages }),
    },
  };
  const sessionUi = createAppShellSessionUiStateController();
  const commands = createRef<TranscriptReadingPositionCommands>();
  const props: ComponentProps<typeof TranscriptReadingPositionController> = {
    commands, sessionId: 'session-a', currentSessionId: { current: 'session-a' },
    rangeController: { current: controller }, messages, sessionUi,
    searchTarget: undefined, clearSearchTarget: () => {},
    turnIndex: undefined, setTurnIndex: () => {},
    listTurnLandmarks: async () => ({ throughSequence: null, landmarks: [] }),
    setHistoryPending: () => {}, historyPageBytes: 512 * 1024,
    onRestoreError: (error) => assert.fail(String(error)), onNavigationError: (error) => assert.fail(String(error)),
  };
  let authority: TranscriptScrollAuthority | undefined;
  function Harness() {
    const scrollRef = useRef<HTMLElement | null>(scroller);
    const [, setHistoryPending] = useState<TranscriptHistoryPending | undefined>();
    props.setHistoryPending = setHistoryPending;
    authority = useTranscriptScrollAuthority();
    const anchor = sessionUi.transcriptReadingAnchorBySessionRef.current[props.sessionId!];
    useChatScroll({
      scrollRef, sessionId: props.sessionId, messages: props.messages,
      restoreTarget: anchor, viewportNavigation: sessionUi.transcriptViewportNavigation,
      onReadingAnchorChange: (turnId) => commands.current?.captureAnchor(turnId), behavior: 'auto',
    });
    return createElement(Fragment, null,
      createElement(TranscriptReadingPositionController, props),
      options.returnButton ? createElement(TranscriptScrollButton, {
        onActivate: () => commands.current?.loadHistory('latest'),
      }) : null,
    );
  }
  const root = createRoot(mount);
  cleanups.push(async () => { await act(() => root.unmount()); Object.assign(globalThis, original); });
  const render = () => act(() => root.render(createElement(TranscriptScrollAuthorityProvider, null, createElement(Harness))));
  return {
    scroller, controller, sessionUi, commands, render,
    pinned: () => authority!.getSnapshot().pinned, latestReads: () => reads,
    visibleTurns: () => props.messages.map((message) => message.turnId),
    async clickReturnToLatest() {
      const button = mount.querySelector('button');
      assert.ok(button);
      await act(() => { button.dispatchEvent(new window.Event('click', { bubbles: true })); });
    },
    async activateHistoryGap(direction: 'earlier' | 'later') {
      // ChatView releases the pin before invoking either history gap action.
      await act(async () => { authority!.releasePin(); await commands.current!.loadHistory(direction); });
    },
    async readAt(offset: number) {
      await act(() => {
        const input = new window.Event('wheel');
        Object.assign(input, { deltaY: offset - scroller.scrollTop });
        scroller.dispatchEvent(input);
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new window.Event('scroll'));
        scroller.dispatchEvent(new window.Event('scrollend'));
      });
      await render();
    },
    async append(id: string, size: number) {
      addTurn(id, height, size); height += size;
      props.messages = [...messages];
      await render();
      await act(() => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
    },
    async replaceRangeFromHost() {
      // The browser clamps the old offset when a much shorter range arrives.
      // ResizeObserver changes awayFromTail, without a reader scroll gesture.
      height = 800;
      messages.splice(0);
      scroller.replaceChildren();
      addTurn('latest-b', 0, 800);
      scroller.scrollTop = scroller.scrollTop;
      props.messages = [...messages];
      await render();
      await act(() => { for (const callback of resizeCallbacks) callback([], {} as ResizeObserver); });
    },
    async switchSession(sessionId: string) {
      props.sessionId = sessionId;
      props.currentSessionId.current = sessionId;
      props.rangeController.current = { ...controller, store: { ...controller.store, sessionId, range: () => ({ sessionId }) } };
      await render();
    },
    async flushFrames() {
      await act(() => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); });
    },
  };
}
