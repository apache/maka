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
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';
import type { TurnViewModel } from '../materialize.js';
import { createTranscriptProjection } from '../transcript-projection.js';
import { ChatView } from '../chat-view.js';
import { Composer } from '../composer.js';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { armLiveTurn } from '../live-turn-projection.js';
import { applyLiveTurnEvent } from './live-turn-zh.js';
import type { SessionSummary, StoredMessage } from '@maka/core/session';

test('renders steering where it arrived in the assistant timeline', () => {
  const turn: TurnViewModel = {
    turnId: 'turn-1',
    status: 'failed',
    user: { id: 'original', role: 'user', text: 'original request', ts: 1 },
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [
      { kind: 'text', text: 'output visible before steering', messageId: 'before-steer', ts: 2 },
      {
        kind: 'user',
        message: { id: 'steer-1', role: 'user', text: 'inserted instruction', ts: 3 },
        messageId: 'steer-1',
      },
      { kind: 'text', text: 'output visible after steering', messageId: 'after-steer', ts: 4 },
    ],
  };

  const markup = renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(TurnView, {
        turn,
        failedReasonLabel: 'failure detail',
      }),
    }),
  );
  const texts = [
    'output visible before steering',
    'inserted instruction',
    'output visible after steering',
  ];
  const [before, steering, after] = texts.map((text) => markup.indexOf(text));
  assert.equal(before < steering && steering < after, true);
  // The failure banner is the turn's outcome, so it must follow the work it
  // concludes. Without this the assertions above pass for either layout, and
  // the banner could drift back to the head of the timeline unnoticed.
  assert.equal(after < markup.indexOf('failure detail'), true);
  const visibleText = parseHTML(`<html><body>${markup}</body></html>`).document.body.textContent;
  for (const text of [...texts, 'failure detail']) {
    assert.equal(visibleText.split(text).length - 1, 1, `${text} should render exactly once`);
  }
});

test('holds steering above the composer while old output continues, then renders its real reply boundary', () => {
  const messages: StoredMessage[] = [{ type: 'user', id: 'original', turnId: 'turn-1', ts: 1, text: 'request' }];
  const pending = { id: 'steer', hostTurnId: 'turn-1', ts: 2, text: 'inserted instruction', pendingSteering: true, transientPlacement: 'current_turn' as const };
  let live: import('../live-turn-projection.js').LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'text_delta', id: 'first', turnId: 'turn-1', messageId: 'before', ts: 2, text: 'old answer continues',
  });
  const render = (transientMessages = [pending], durable = messages) => parseHTML(`<html><body>${renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'en', children: createElement(ChatSurfaceLayout, {
      composer: createElement(Composer, { streaming: true, pendingMessages: transientMessages, onSend: () => undefined, onStop: () => undefined }),
      children: createElement(ChatView, {
        messages: durable, liveTurn: live, transientMessages,
        initialLiveContentSnapshot: { turnId: 'turn-1', entries: new Map([['text:before', 'old answer continues'], ['text:after', 'reply to new instruction']]) }, onNew: () => undefined, scrollBehavior: 'auto',
        activeSession: { id: 'session', name: 'Session', status: 'running', labels: [] } as unknown as SessionSummary,
      }),
    }) }),
  )}</body></html>`).document;
  const waiting = render();
  assert.equal(waiting.querySelector('.maka-composer-queue-text')?.textContent, pending.text);
  assert.equal(waiting.querySelectorAll('.maka-steering-message').length, 0);
  const timeline = () => createTranscriptProjection().project({ messages, liveTurn: live, locale: 'en' })[0]!.timeline.map((item) => item.kind === 'user' ? item.message.text : item.kind === 'text' ? item.text : item.kind);
  assert.deepEqual(timeline(), ['old answer continues']);
  live = applyLiveTurnEvent(live, { type: 'text_complete', id: 'finished', turnId: 'turn-1', messageId: 'before', ts: 3, text: 'old answer continues' });
  live = applyLiveTurnEvent(live, { type: 'steering_message', id: 'accepted', turnId: 'turn-1', messageId: pending.id, ts: 4, content: { text: pending.text } });
  live = applyLiveTurnEvent(live, { type: 'text_delta', id: 'reply', turnId: 'turn-1', messageId: 'after', ts: 5, text: 'reply to new instruction' });
  const accepted = render([]);
  assert.equal(accepted.querySelector('.maka-composer-queue'), null);
  const text = accepted.body.textContent ?? '';
  assert.deepEqual(timeline(), ['old answer continues', pending.text, 'reply to new instruction']);
  assert.equal(text.split(pending.text).length - 1, 1);
});
