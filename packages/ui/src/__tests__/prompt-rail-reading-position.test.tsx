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
 * The rail's current tick is the reading position the scroll authority
 * publishes — the newest Turn while pinned to the tail, otherwise the Turn the
 * virtualizer places under the top of the scrollport — and a tick navigates by
 * that same index. Mounted through the real layout, because that is what hands
 * the authority and the virtualizer the scroller the reader scrolls.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, type ReactElement } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView } from '../chat-view.js';
import { LocaleProvider } from '../locale-context.js';
import { PromptAnchorRail, type PromptAnchorRailTurn } from '../prompt-anchor-rail.js';
import { TranscriptScrollAuthorityProvider } from '../transcript-scroll-authority.js';
import { installTranscriptDom, type TranscriptDom } from './transcript-test-dom.js';

const TURN_COUNT = 6;
const TURN_HEIGHT = 400;
const SCROLLPORT_HEIGHT = 600;

let dom: TranscriptDom | undefined;

afterEach(async () => {
  await dom?.cleanup();
  dom = undefined;
});

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

function view(messages: StoredMessage[], extra: Partial<Parameters<typeof ChatView>[0]> = {}): ReactElement {
  const chat = createElement(ChatView, { messages, activeSession, onNew: () => {}, scrollBehavior: 'auto', ...extra });
  const layout = createElement(ChatSurfaceLayout, { composer: null, children: chat });
  return createElement(LocaleProvider, { locale: 'zh-CN', children: layout });
}

async function mountTranscript(): Promise<{ dom: TranscriptDom; scroller: HTMLElement }> {
  dom = installTranscriptDom({ viewportHeight: SCROLLPORT_HEIGHT, boxHeight: TURN_HEIGHT });
  await dom.render(view(turnMessages()));
  const scroller = dom.container.querySelector<HTMLElement>('[data-chat-scroll-container]');
  assert.ok(scroller, 'the layout publishes the scroller the authority attaches to');
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => TURN_COUNT * TURN_HEIGHT },
    clientHeight: { get: () => SCROLLPORT_HEIGHT },
  });
  scroller.scrollTop = TURN_COUNT * TURN_HEIGHT - SCROLLPORT_HEIGHT;
  return { dom, scroller };
}

function activeTickTurnId(mount: HTMLElement): string | null {
  return mount.querySelector('.maka-prompt-rail-tick[data-active="true"]')
    ?.getAttribute('data-prompt-turn-id') ?? null;
}

test('the current tick follows the reading position the virtualizer maps', async () => {
  const { dom, scroller } = await mountTranscript();
  assert.equal(activeTickTurnId(dom.container), 'turn-5', 'pinned to the tail, the reader is on the newest Turn');

  await act(() => {
    const wheel = new dom.window.Event('wheel', { bubbles: true });
    Object.defineProperty(wheel, 'deltaY', { value: -120 });
    scroller.dispatchEvent(wheel);
    scroller.scrollTop = TURN_HEIGHT * 2 + 100;
    scroller.dispatchEvent(new dom.window.Event('scroll'));
  });
  assert.equal(activeTickTurnId(dom.container), 'turn-2');

  await act(() => {
    scroller.scrollTop = TURN_HEIGHT * 4;
    scroller.dispatchEvent(new dom.window.Event('scroll'));
  });
  assert.equal(activeTickTurnId(dom.container), 'turn-4');
});

test('a tick releases the pin and scrolls its Turn to the top by index', async () => {
  const { dom, scroller } = await mountTranscript();
  const tick = dom.container.querySelector('[data-prompt-turn-id="turn-3"]');
  assert.ok(tick);
  await act(async () => { tick.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  assert.equal(scroller.scrollTop, TURN_HEIGHT * 3);
  await act(() => { scroller.dispatchEvent(new dom.window.Event('scroll')); });
  assert.equal(activeTickTurnId(dom.container), 'turn-3');
});

test('a tick for an indexed Turn outside the loaded range asks for history down to it', async () => {
  const { dom } = await mountTranscript();
  const loaded = turnMessages().filter((message) => message.turnId !== 'turn-0' && message.turnId !== 'turn-1');
  const requests: { turnId: string; sequence: number }[] = [];
  const extra = {
    transcriptTurnIndex: [{ turnId: 'turn-0', sequence: 8, label: '第 0 个问题' }],
    onLoadTranscriptTurn: (turn: { turnId: string; sequence: number }) => { requests.push(turn); },
  };
  await dom.render(view(loaded, extra));
  const tick = dom.container.querySelector('[data-prompt-turn-id="turn-0"]');
  assert.ok(tick, 'the indexed Turn has a tick before it is loaded');
  await act(async () => { tick.dispatchEvent(new dom.window.Event('click', { bubbles: true })); });
  assert.deepEqual(requests, [{ turnId: 'turn-0', sequence: 8 }]);
  // Landing it at the top after the prepend is measured in the browser
  // (`partial-history-notice` E2E); this fake DOM runs no frames.
});

test('portals landmarks into the layout host and keeps them actionable', async () => {
  dom = installTranscriptDom();
  const rail = createElement(PromptAnchorRail, {
    turns: [
      { turnId: 'turn-1', label: 'Prompt 1' },
      { turnId: 'turn-2', label: 'Prompt 2' },
      { turnId: 'turn-3', label: 'Prompt 3' },
    ],
    scrollRef: { current: null },
    onNavigateTurn: () => {},
  });
  // The rail reads its tick from the scroll authority, so the host-less render
  // still needs one — otherwise this would assert the absence of a rail that
  // threw rather than one that found no host.
  await dom.render(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(TranscriptScrollAuthorityProvider, { children: rail }),
  }));
  assert.equal(dom.container.querySelector('.maka-prompt-rail'), null, 'no inline rail before a host exists');
  await dom.render(createElement(LocaleProvider, {
    locale: 'en', children: createElement(ChatSurfaceLayout, { composer: null, children: rail }),
  }));
  assert.equal(dom.container.querySelectorAll('.maka-prompt-rail-host .maka-prompt-rail').length, 1);
  assert.match(dom.container.innerHTML, /data-prompt-turn-id="turn-2"/);
  assert.match(dom.container.innerHTML, /aria-label="Jump to prompt: Prompt 2"/);
});

test('a retained tick uses updated content, decoration, and navigation callbacks', async () => {
  dom = installTranscriptDom();
  const scrollRef = { current: null };
  const turns: PromptAnchorRailTurn[] = Array.from({ length: 3 }, (_, index) => ({
    turnId: `turn-${index}`, label: `Prompt ${index}`,
  }));
  const calls: string[] = [];
  const render = (items: PromptAnchorRailTurn[], navigate: (turn: PromptAnchorRailTurn) => void) =>
    createElement(LocaleProvider, {
      locale: 'en', children: createElement(ChatSurfaceLayout, {
        composer: null, children: createElement(PromptAnchorRail, {
          turns: items, scrollRef, onNavigateTurn: navigate,
        }),
      }),
    });
  await dom.render(render(turns, () => calls.push('old')));
  const tick = dom.container.querySelector('[data-prompt-turn-id="turn-1"]')!;
  const updated = turns.map((turn, index) => index === 1
    ? { ...turn, label: 'Updated prompt', reply: 'Updated answer', highlighted: true }
    : turn);
  await dom.render(render(updated, (turn) => {
    assert.equal(turn, updated[1]);
    calls.push(`new:${turn.turnId}`);
  }));
  assert.equal(dom.container.querySelector('[data-prompt-turn-id="turn-1"]'), tick);
  assert.equal(tick.getAttribute('aria-label'), 'Jump to prompt: Updated prompt');
  assert.equal(tick.getAttribute('data-highlighted'), 'true');
  await act(() => { tick.dispatchEvent(new dom!.window.Event('click', { bubbles: true })); });
  assert.deepEqual(calls, ['new:turn-1']);
});
