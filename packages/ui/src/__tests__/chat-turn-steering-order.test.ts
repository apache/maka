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

test('marks only the waiting steering bubble pending without duplicating its text', () => {
  const messages = [{ type: 'user' as const, id: 'original', turnId: 'turn-1', ts: 1, text: 'request' }];
  const pending = { id: 'steer', hostTurnId: 'turn-1', ts: 2, text: 'inserted instruction', displayAfter: null, transientPlacement: 'current_turn' as const };
  const projection = createTranscriptProjection();
  const render = (turn: TurnViewModel) => parseHTML(`<html><body>${renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'en', children: createElement(TurnView, { turn }) }),
  )}</body></html>`).document;
  const waiting = render(projection.project({ messages, locale: 'en', transientMessages: [pending] })[0]!);
  assert.equal(waiting.querySelectorAll('[data-steering-pending="true"]').length, 1);
  assert.equal(waiting.body.textContent.split(pending.text).length - 1, 1);
  const accepted = render(projection.project({ messages: [
    ...messages, { type: 'user', id: pending.id, turnId: 'turn-1', ts: 3, text: pending.text, displayAfter: null },
  ], locale: 'en', transientMessages: [pending] })[0]!);
  assert.equal(accepted.querySelectorAll('[data-steering-pending]').length, 0);
  assert.equal(accepted.body.textContent.split(pending.text).length - 1, 1);
});
