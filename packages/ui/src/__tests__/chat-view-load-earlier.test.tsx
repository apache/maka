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
 * Earlier history arrives only when the reader asks for it, and whole Turns
 * prepended above them neither move them off the Turn they are reading nor
 * change whether the transcript follows its tail.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Fragment, act, createElement, type ComponentProps, type ReactElement } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView } from '../chat-view.js';
import { LocaleProvider } from '../locale-context.js';
import {
  useTranscriptScrollAuthority,
  type TranscriptScrollAuthority,
} from '../transcript-scroll-authority.js';
import { installTranscriptDom, type TranscriptDom } from './transcript-test-dom.js';

const TURN_HEIGHT = 400;
const SCROLLPORT_HEIGHT = 600;

let dom: TranscriptDom | undefined;

afterEach(async () => {
  await dom?.cleanup();
  dom = undefined;
});

const activeSession = {
  id: 'session-earlier',
  name: 'Earlier',
  status: 'active',
  labels: [] as string[],
} as unknown as SessionSummary;

function turnMessages(from: number, to: number): StoredMessage[] {
  return Array.from({ length: to - from }, (_, offset): StoredMessage => ({
    type: 'user',
    id: `user-${from + offset}`,
    turnId: `turn-${from + offset}`,
    ts: from + offset,
    text: `Prompt ${from + offset}`,
  }));
}

function harness() {
  dom = installTranscriptDom({ viewportHeight: SCROLLPORT_HEIGHT, boxHeight: TURN_HEIGHT });
  let authority: TranscriptScrollAuthority | undefined;
  let turnCount = 0;
  const anchors: Array<string | undefined> = [];
  const Probe = (): ReactElement => {
    authority = useTranscriptScrollAuthority();
    return createElement(Fragment);
  };
  const current = dom;
  return {
    anchors,
    get authority(): TranscriptScrollAuthority {
      assert.ok(authority);
      return authority;
    },
    async render(props: Partial<ComponentProps<typeof ChatView>> & { messages: StoredMessage[] }) {
      turnCount = new Set(props.messages.map((message) => message.turnId)).size;
      await current.render(createElement(LocaleProvider, {
        locale: 'en',
        children: createElement(ChatSurfaceLayout, {
          composer: null,
          children: createElement(Fragment, null, createElement(ChatView, {
            activeSession,
            onNew: () => {},
            scrollBehavior: 'auto',
            onReadingAnchorChange: (turnId?: string) => { anchors.push(turnId); },
            ...props,
          }), createElement(Probe)),
        }),
      }));
      const scroller = current.container.querySelector<HTMLElement>('[data-chat-scroll-container]');
      assert.ok(scroller);
      if (!Object.hasOwn(scroller, 'scrollHeight')) {
        Object.defineProperties(scroller, {
          scrollHeight: { get: () => turnCount * TURN_HEIGHT },
          clientHeight: { get: () => SCROLLPORT_HEIGHT },
        });
      }
      return scroller;
    },
    loadButton(): HTMLButtonElement | null {
      return [...current.container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Load earlier history') ?? null;
    },
    readerScrollTo(scroller: HTMLElement, top: number): void {
      const wheel = new current.window.Event('wheel', { bubbles: true });
      Object.defineProperty(wheel, 'deltaY', { value: top < scroller.scrollTop ? -120 : 120 });
      scroller.dispatchEvent(wheel);
      scroller.scrollTop = top;
      scroller.dispatchEvent(new current.window.Event('scroll'));
    },
    click(element: Element): void {
      element.dispatchEvent(new current.window.Event('click', { bubbles: true }));
    },
  };
}

test('the load-earlier button exists only while earlier history does, and waits for its load', async () => {
  const view = harness();
  await view.render({ messages: turnMessages(4, 8), onLoadEarlierHistory: () => {} });
  assert.equal(view.loadButton(), null, 'no button without earlier history');

  let loads = 0;
  let finish!: () => void;
  const onLoadEarlierHistory = () => {
    loads += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  };
  await view.render({ messages: turnMessages(4, 8), hasEarlierHistory: true, onLoadEarlierHistory });
  const button = view.loadButton();
  assert.ok(button);
  await act(async () => { view.click(button); });
  assert.equal(loads, 1);
  assert.equal(view.loadButton()?.disabled, true, 'a pending load cannot be requested again');

  await act(async () => { finish(); });
  assert.equal(view.loadButton()?.disabled, false);
});

/**
 * A visible transcript with nothing in it is exactly when the reader most needs
 * the control: WorkHub filters the list to one Work, and a Work whose Turns are
 * all in unloaded history filters it down to nothing. The control is the only
 * way to load those Turns, so it cannot be inside the non-empty branch.
 */
test('offers to load earlier history even with nothing to show', async () => {
  const view = harness();
  await view.render({ messages: [], hasEarlierHistory: true, onLoadEarlierHistory: () => {} });
  assert.ok(view.loadButton(), 'an empty message list hid the only way to load the rest');
});

test('prepended Turns keep a released reader on their Turn without re-pinning', async () => {
  const view = harness();
  const scroller = await view.render({ messages: turnMessages(4, 8), hasEarlierHistory: true, onLoadEarlierHistory: () => {} });
  scroller.scrollTop = 4 * TURN_HEIGHT - SCROLLPORT_HEIGHT;
  await act(() => { view.readerScrollTo(scroller, TURN_HEIGHT + 100); });
  assert.equal(view.authority.getSnapshot().pinned, false);
  assert.equal(view.anchors.at(-1), 'turn-5');

  // The reader asks for history, which is the only way it arrives.
  const button = view.loadButton();
  assert.ok(button);
  await act(async () => { view.click(button); });
  await view.render({ messages: turnMessages(2, 8), hasEarlierHistory: false, onLoadEarlierHistory: () => {} });
  await act(() => { scroller.dispatchEvent(new dom!.window.Event('scroll')); });
  assert.equal(view.loadButton(), null);
  assert.equal(view.authority.getSnapshot().pinned, false, 'arriving history is not reader input');
  // Where the prepend leaves the reader in pixels is a browser story
  // (`PrependedHistoryKeepsMeasuredHeights`); this fake DOM has no measurement
  // cache to get wrong.
  assert.equal(view.anchors.at(-1), 'turn-5');
});

test('a selection from outside every Turn keeps every Turn it spans mounted', async () => {
  const view = harness();
  const scroller = await view.render({ messages: turnMessages(0, 20), hasEarlierHistory: true, onLoadEarlierHistory: () => {} });
  const mounted = () => [...dom!.container.querySelectorAll('[data-transcript-turn-id]')]
    .map((row) => row.getAttribute('data-transcript-turn-id'));
  const rows = mounted();
  assert.ok(rows.length < 20, 'the fixture mounts only some of the Turns');

  const button = view.loadButton();
  const last = dom!.container.querySelector(`[data-transcript-turn-id="${rows.at(-1)}"]`);
  assert.ok(button && last);
  const selection = { isCollapsed: false, anchorNode: button, focusNode: last };
  dom!.document.getSelection = () => selection as unknown as Selection;
  await act(async () => { dom!.document.dispatchEvent(new dom!.window.Event('selectionchange')); });
  await act(() => { view.readerScrollTo(scroller, 16 * TURN_HEIGHT); });
  assert.ok(mounted().includes('turn-19'), 'the reader reached the tail');
  assert.ok(mounted().includes('turn-0'), 'the selection starts above the first Turn, so it keeps that Turn mounted');
});

test('prepended Turns do not release a pinned transcript', async () => {
  const view = harness();
  await view.render({ messages: turnMessages(4, 8), hasEarlierHistory: true, onLoadEarlierHistory: () => {} });
  assert.equal(view.authority.getSnapshot().pinned, true);
  const scroller = await view.render({ messages: turnMessages(0, 8) });
  await act(() => { scroller.dispatchEvent(new dom!.window.Event('scroll')); });
  assert.equal(view.authority.getSnapshot().pinned, true);
  assert.equal(view.anchors.at(-1), undefined);
});
