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
import { foldTimeline } from '../timeline-fold.js';
import { materializeTurns, overlayLiveTurn, type TurnTimelineItem, type TurnViewModel } from '../materialize.js';
import { createTranscriptProjection } from '../transcript-projection.js';
import { ChatView } from '../chat-view.js';
import { Composer } from '../composer.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { armLiveTurn, type LiveTurnProjection } from '../live-turn-projection.js';
import { applyLiveTurnEvent } from './live-turn-zh.js';
import type { SessionSummary, StoredMessage } from '@maka/core/session';

test('renders a thinking-only interruption as a divider without an empty answer bubble', () => {
  const messages: StoredMessage[] = [
    { type: 'user', id: 'user', turnId: 'turn', ts: 1, text: 'request' },
    { type: 'assistant', id: 'partial', turnId: 'turn', ts: 2, modelId: 'mock', text: '', interrupted: true, thinking: { text: 'partial thought' } },
  ];
  const [turn] = materializeTurns(messages, 'en');
  assert.ok(turn);
  const markup = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: 'en', children: createElement(TurnView, { turn }),
  }));
  const { document } = parseHTML(`<html><body>${markup}</body></html>`);
  assert.equal(document.querySelectorAll('.maka-chat-message-bubble-assistant').length, 0);
  assert.match(document.body.textContent, /partial thought/);
  assert.match(document.body.textContent, /Response stream ended before completion/);
});

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

test('holds steering above the composer while old output continues, then renders its real reply boundary', async () => {
  const messages: StoredMessage[] = [{ type: 'user', id: 'original', turnId: 'turn-1', ts: 1, text: 'request' }];
  const pending = { id: 'steer', hostTurnId: 'turn-1', ts: 2, text: 'inserted instruction', pendingSteering: true, transientPlacement: 'current_turn' as const };
  let live: import('../live-turn-projection.js').LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'text_delta', id: 'first', turnId: 'turn-1', messageId: 'before', ts: 2, text: 'old answer continues',
  });
  const render = async (transientMessages = [pending], durable = messages) => parseHTML(`<html><body>${await renderTranscriptMarkup(
    createElement(LocaleProvider, { locale: 'en', children: createElement(ChatSurfaceLayout, {
      composer: createElement(Composer, { streaming: true, pendingMessages: transientMessages, onSend: () => undefined, onStop: () => undefined }),
      children: createElement(ChatView, {
        messages: durable, liveTurns: live ? [live] : undefined, transientMessages,
        initialLiveContentSnapshot: { turnId: 'turn-1', entries: new Map([['text:before', 'old answer continues'], ['text:after', 'reply to new instruction']]) }, onNew: () => undefined, scrollBehavior: 'auto',
        activeSession: { id: 'session', name: 'Session', status: 'running', labels: [] } as unknown as SessionSummary,
      }),
    }) }),
  )}</body></html>`).document;
  const waiting = await render();
  assert.equal(waiting.querySelector('.maka-composer-queue-text')?.textContent, pending.text);
  assert.equal(waiting.querySelectorAll('.maka-steering-message').length, 0);
  const timeline = () => createTranscriptProjection().project({ messages, liveTurns: live ? [live] : undefined, locale: 'en' })[0]!.timeline.map((item) => item.kind === 'user' ? item.message.text : item.kind === 'text' ? item.text : item.kind);
  assert.deepEqual(timeline(), ['old answer continues']);
  live = applyLiveTurnEvent(live, { type: 'text_complete', id: 'finished', turnId: 'turn-1', messageId: 'before', ts: 3, text: 'old answer continues' });
  live = applyLiveTurnEvent(live, { type: 'steering_message', id: 'accepted', turnId: 'turn-1', messageId: pending.id, ts: 4, content: { text: pending.text } });
  live = applyLiveTurnEvent(live, { type: 'text_delta', id: 'reply', turnId: 'turn-1', messageId: 'after', ts: 5, text: 'reply to new instruction' });
  const accepted = await render([]);
  assert.equal(accepted.querySelector('.maka-composer-queue'), null);
  const text = accepted.body.textContent ?? '';
  assert.deepEqual(timeline(), ['old answer continues', pending.text, 'reply to new instruction']);
  assert.equal(text.split(pending.text).length - 1, 1);
});

const timelineOrder = (timeline: readonly TurnTimelineItem[]): string[] =>
  timeline.map((item) =>
    item.kind === 'user'
      ? `user:${item.message.text}`
      : item.kind === 'tools'
        ? `tools:${item.items.map((tool) => tool.toolUseId).join('+')}`
        : `${item.kind}:${item.text}`,
  );

test('keeps post-steering work below the steering row even when it continues the same step', () => {
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'thinking_delta', id: 'e1', turnId: 'turn-1', messageId: 'm1', ts: 1, text: 'pre-steer reasoning',
  });
  live = applyLiveTurnEvent(live, {
    type: 'tool_start', id: 'e2', turnId: 'turn-1', stepId: 'm1', toolUseId: 'tool-1', toolName: 'Read', args: {}, ts: 2,
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 'steer-event', turnId: 'turn-1', messageId: 'steer-1', ts: 3, content: { text: 'steer' },
  });
  // A late result for a row that already exists updates that row in place; it
  // does not claim the steering because its position was fixed at tool_start.
  live = applyLiveTurnEvent(live, {
    type: 'tool_result', id: 'e3', turnId: 'turn-1', toolUseId: 'tool-1', isError: false, ts: 4,
    content: { kind: 'text', text: 'done' },
  });
  // While the steering awaits its boundary it must already render as one.
  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), [
    'thinking:pre-steer reasoning', 'tools:tool-1', 'user:steer',
  ]);
  live = applyLiveTurnEvent(live, {
    type: 'thinking_delta', id: 'e4', turnId: 'turn-1', messageId: 'm1', ts: 5, text: 'post-steer reasoning',
  });
  live = applyLiveTurnEvent(live, {
    type: 'tool_start', id: 'e5', turnId: 'turn-1', stepId: 'm1', toolUseId: 'tool-2', toolName: 'Bash', args: {}, ts: 6,
  });
  live = applyLiveTurnEvent(live, {
    type: 'text_delta', id: 'e6', turnId: 'turn-1', messageId: 'm1', ts: 7, text: 'answer continues',
  });

  const timeline = overlayLiveTurn([], live, 'en')[0]!.timeline;
  assert.deepEqual(timelineOrder(timeline), [
    'thinking:pre-steer reasoning',
    'tools:tool-1',
    'user:steer',
    'thinking:post-steer reasoning',
    'tools:tool-2',
    'text:answer continues',
  ]);
  const folded = foldTimeline(timeline).entries.map((entry) =>
    entry.kind === 'processing'
      ? `fold:${entry.children.map((child) => child.kind).join('+')}`
      : entry.kind === 'user'
        ? `user:${entry.message.text}`
        : `text:${entry.text}`,
  );
  assert.deepEqual(folded, [
    'fold:thinking+tools',
    'user:steer',
    'fold:thinking+tools',
    'text:answer continues',
  ]);
});

test('anchors a persisted steering row ahead of live work the stream seeded after it', () => {
  const settled = materializeTurns([
    { type: 'user', id: 'original', turnId: 't1', ts: 1, text: 'request' },
    { type: 'user', id: 'steer-1', turnId: 't1', ts: 3, text: 'steer', steeringEventId: 'steer-event' },
  ], 'en');
  const live = applyLiveTurnEvent(armLiveTurn('t1'), {
    type: 'thinking_delta', id: 'e1', turnId: 't1', messageId: 'm2', ts: 5, text: 'in-flight after the steer',
  });

  const [overlaid] = overlayLiveTurn(settled, live, 'en');
  assert.deepEqual(timelineOrder(overlaid!.timeline), [
    'user:steer',
    'thinking:in-flight after the steer',
  ]);
});

test('keeps pre-steering content in place when its completion lands after the boundary', () => {
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'text_delta', id: 'e1', turnId: 'turn-1', messageId: 'm1', ts: 1, text: 'answer before',
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 'steer-event', turnId: 'turn-1', messageId: 'steer-1', ts: 2, content: { text: 'steer' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'text_complete', id: 'e2', turnId: 'turn-1', messageId: 'm1', ts: 3, text: 'answer before',
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), [
    'text:answer before',
    'user:steer',
  ]);
});

test('splits a completion across the boundary instead of duplicating the sealed portion', () => {
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'thinking_delta', id: 'e1', turnId: 'turn-1', messageId: 'm1', ts: 1, text: 'pre-',
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 'steer-event', turnId: 'turn-1', messageId: 'steer-1', ts: 2, content: { text: 'steer' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'thinking_delta', id: 'e2', turnId: 'turn-1', messageId: 'm1', ts: 3, text: 'post',
  });
  live = applyLiveTurnEvent(live, {
    type: 'thinking_complete', id: 'e3', turnId: 'turn-1', messageId: 'm1', ts: 4, text: 'pre-post',
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), [
    'thinking:pre-',
    'user:steer',
    'thinking:post',
  ]);
});

test('lands a divergent completion whole instead of slicing at the delta offset', () => {
  // thinking_complete may carry a provider summary that replaces the streamed
  // deltas outright — the accumulated delta length is not a safe cut point.
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'thinking_delta', id: 'e1', turnId: 'turn-1', messageId: 'm1', ts: 1, text: 'AAAA',
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 's1', turnId: 'turn-1', messageId: 'steer-1', ts: 2, content: { text: 'steer' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'thinking_delta', id: 'e2', turnId: 'turn-1', messageId: 'm1', ts: 3, text: 'BBBB',
  });
  live = applyLiveTurnEvent(live, {
    type: 'thinking_complete', id: 'e3', turnId: 'turn-1', messageId: 'm1', ts: 4, text: 'Short summary.',
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), [
    'thinking:AAAA',
    'user:steer',
    'thinking:Short summary.',
  ]);
});

test('lands a completion shorter than the delta offset whole', () => {
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'thinking_delta', id: 'e1', turnId: 'turn-1', messageId: 'm1', ts: 1, text: 'AAAA',
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 's1', turnId: 'turn-1', messageId: 'steer-1', ts: 2, content: { text: 'steer' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'thinking_delta', id: 'e2', turnId: 'turn-1', messageId: 'm1', ts: 3, text: 'BBBB',
  });
  live = applyLiveTurnEvent(live, {
    type: 'thinking_complete', id: 'e3', turnId: 'turn-1', messageId: 'm1', ts: 4, text: 'ABC',
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), [
    'thinking:AAAA',
    'user:steer',
    'thinking:ABC',
  ]);
});

test('keeps consecutive steering rows in arrival order', () => {
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'text_delta', id: 'e1', turnId: 'turn-1', messageId: 'm1', ts: 1, text: 'before',
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 's1', turnId: 'turn-1', messageId: 'steer-1', ts: 2, content: { text: 'one' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 's2', turnId: 'turn-1', messageId: 'steer-2', ts: 3, content: { text: 'two' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'text_delta', id: 'e2', turnId: 'turn-1', messageId: 'm2', ts: 4, text: 'after',
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), [
    'text:before',
    'user:one',
    'user:two',
    'text:after',
  ]);
});

test('renders a repeated steering event once', () => {
  let live: LiveTurnProjection | undefined = applyLiveTurnEvent(armLiveTurn('turn-1'), {
    type: 'steering_message', id: 's1', turnId: 'turn-1', messageId: 'steer-1', ts: 1, content: { text: 'steer' },
  });
  live = applyLiveTurnEvent(live, {
    type: 'steering_message', id: 's1-echo', turnId: 'turn-1', messageId: 'steer-1', ts: 2, content: { text: 'steer' },
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([], live, 'en')[0]!.timeline), ['user:steer']);
});

test('trails a settled steering that carries no ts behind live work', () => {
  const turn: TurnViewModel = {
    turnId: 't1',
    status: 'running',
    tools: [],
    notes: [],
    startedAt: 1,
    timeline: [
      { kind: 'text', text: 'persisted answer', messageId: 'm1', ts: 1 },
      { kind: 'user', message: { id: 'steer-1', role: 'user', text: 'steer' }, messageId: 'steer-1', steeringEventId: 'steer-event' },
    ],
  };
  const live = applyLiveTurnEvent(armLiveTurn('t1'), {
    type: 'text_delta', id: 'e1', turnId: 't1', messageId: 'm2', ts: 5, text: 'in-flight',
  });

  assert.deepEqual(timelineOrder(overlayLiveTurn([turn], live, 'en')[0]!.timeline), [
    'text:persisted answer',
    'text:in-flight',
    'user:steer',
  ]);
});
