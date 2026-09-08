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
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView, type TransientUserMessageProjection } from '../chat-view.js';
import type { LiveTurnProjection } from '../live-turn-projection.js';
import { LocaleProvider } from '../locale-context.js';

const activeSession = {
  id: 'session-1', name: 'Session', status: 'running', labels: [],
} as unknown as SessionSummary;

const settledRound: StoredMessage[] = [
  { type: 'user', id: 'u1', turnId: 't1', ts: 1, text: 'first' },
  { type: 'assistant', id: 'a1', turnId: 't1', ts: 2, text: 'answer', modelId: 'test' },
];

const pendingSend: TransientUserMessageProjection = {
  id: 'u2', text: 'second', ts: 3, transientPlacement: 'current_turn',
};

function renderChat(props: Partial<ComponentProps<typeof ChatView>> = {}): string {
  const view = createElement(ChatView, {
    messages: settledRound,
    activeSession,
    onNew: () => undefined,
    scrollBehavior: 'auto',
    runningStatus: true,
    ...props,
  });
  return renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(ChatSurfaceLayout, { composer: null, children: view }),
  }));
}

test('places loading after a pending send whose running turn is not loaded', () => {
  const markup = renderChat({
    activeSession: { ...activeSession, runningTurnIds: ['t2'] },
    transientMessages: [pendingSend],
  });
  const pendingMessage = markup.indexOf('data-transient-message-id="u2"');
  const loading = markup.indexOf('Waiting for model output');

  assert.doesNotMatch(markup, /data-turn-id="t1"[^>]*data-live-streaming="true"/);
  assert.ok(pendingMessage >= 0 && pendingMessage < loading);
});

test('keeps loading at the boundary without a unique runtime identity', () => {
  const messages: StoredMessage[] = [
    ...settledRound,
    { type: 'user', id: 'u2', turnId: 't2', ts: 3, text: 'second' },
  ];
  const { document } = parseHTML(renderChat({
    messages,
    activeSession: { ...activeSession, runningTurnIds: ['t2', 'unloaded-turn'] },
  }));
  assert.equal(document.querySelector('section[data-turn-id][data-live-streaming]'), null);
  const status = document.querySelector('.maka-turn-processing');
  assert.ok(status);
  assert.equal(status.closest('section')?.hasAttribute('data-turn-id'), false);
});

test('a live turn outranks a conflicting directory identity', () => {
  const messages: StoredMessage[] = [
    ...settledRound,
    { type: 'user', id: 'u2', turnId: 't2', ts: 3, text: 'second' },
  ];
  const liveTurn: LiveTurnProjection = {
    turnId: 't2',
    phase: 'waiting',
    steps: [],
  };
  const markup = renderChat({
    messages,
    liveTurn,
    activeSession: { ...activeSession, runningTurnIds: ['t1'] },
  });
  const { document } = parseHTML(markup);

  assert.equal(document.querySelectorAll('.maka-turn-processing').length, 1);
  assert.equal(document.querySelector('.maka-turn-processing')?.closest('section')?.getAttribute('data-turn-id'), 't2');
  assert.equal(document.querySelector('section[data-turn-id="t1"]')?.getAttribute('data-live-streaming'), null);
});

test('keeps the newer gap after old history when the running turn is not loaded', () => {
  const markup = renderChat({
    hasNewerHistory: true,
    activeSession: { ...activeSession, runningTurnIds: ['t2'] },
  });

  assert.doesNotMatch(markup, /data-turn-id="t1"[^>]*data-live-streaming="true"/);
  const gap = markup.indexOf('data-transcript-gap="newer"');
  assert.ok(markup.indexOf('data-turn-id="t1"') < gap);
  assert.ok(gap < markup.indexOf('Waiting for model output'));
});

test('recorded terminal evidence outranks a stale runtime ID', () => {
  const markup = renderChat({
    activeSession: { ...activeSession, runningTurnIds: ['t1'] },
    messages: [
      ...settledRound,
      { type: 'turn_state', id: 'done', turnId: 't1', ts: 3, status: 'completed' },
    ],
    hasNewerHistory: true,
  });
  const { document } = parseHTML(markup);
  const settledTurn = document.querySelector('section[data-turn-id="t1"]')!;

  assert.equal(settledTurn.getAttribute('data-live-streaming'), null);
  assert.doesNotMatch(markup, /Waiting for model output/);
  assert.ok(markup.indexOf('data-turn-id="t1"') < markup.indexOf('data-transcript-gap="newer"'));
});
