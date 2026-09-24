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
import { type ComponentProps, type ReactNode, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import {
  AstryxLocaleProvider,
  ChatSurfaceLayout,
  ChatView,
  Composer,
  LocaleProvider,
  type TransientUserMessageProjection,
} from '@maka/ui';
import { mergeTransientMessageProjection } from '../../renderer/application/contracts/transient-message-projection.js';

// A side conversation forks lazily: its first send arms the optimistic bubble
// (and, after the delay, the running-status line) BEFORE the fork commits, so
// `activeSession` is still undefined. These tests pin that `ChatView` renders
// that optimistic content in its no-session branch — the render-layer half of
// #4654 that the hook-only tests could not prove. The panel wires it up:
// `activeSession={companion.companionSession}` (undefined pre-fork) and
// `transientMessages`/`runningStatus` from the same hook.
function renderChatView(
  props: Partial<ComponentProps<typeof ChatView>>,
  composer: ReactNode = null,
): string {
  const view = createElement(ChatView, {
    messages: [],
    activeSession: undefined,
    onNew: () => {},
    // A marker standing in for the empty-state content a caller supplies (the
    // side panel's placeholder, the main chat's onboarding surface / hero). It
    // must render when there is no optimistic content, and be suppressed when a
    // bubble/running turn takes over — the ChatMessageList shows `emptyState`
    // only while it has no children, so empty optimistic fragments must not
    // count as children (regression: onboarding stopped rendering otherwise).
    emptyOverride: createElement('div', { 'data-testid': 'empty-state-marker' }),
    ...props,
  } as ComponentProps<typeof ChatView>);
  const layout = createElement(ChatSurfaceLayout, {
    composer,
    children: view,
  });
  const astryx = createElement(AstryxLocaleProvider, { children: layout });
  return renderToStaticMarkup(
    createElement(LocaleProvider, { locale: 'en', children: astryx }),
  );
}

const OPTIMISTIC_BUBBLE: TransientUserMessageProjection = {
  id: 'turn-1',
  text: 'why does this fail?',
  ts: 1,
  transientPlacement: 'current_turn',
};

test('ChatView renders the optimistic bubble and running status before a session exists', () => {
  const markup = renderChatView({
    transientMessages: [OPTIMISTIC_BUBBLE],
    activeTurn: { turnId: 'turn-1' },
    turnDecorations: new Map([['turn-1', {
      header: null,
      promptStatus: createElement('span', { 'data-testid': 'prompt-status' }),
    }]]),
  });
  const { document } = parseHTML(markup);
  // The question and its running status render as the one Turn they become.
  const turn = document.querySelector('.maka-pending-turn > .maka-turn[data-turn-id="turn-1"]');
  assert.ok(turn?.querySelector('.maka-user-message')?.textContent?.includes('why does this fail?'));
  assert.ok(turn?.querySelector('.maka-user-message [data-testid="prompt-status"]'), 'the prompt keeps its Turn status');
  assert.ok(turn?.querySelector('.maka-turn-processing'));
  // The optimistic content takes over from the empty state.
  assert.doesNotMatch(markup, /empty-state-marker/);
});

test('ChatView shows the empty state when there is neither a bubble nor a running turn', () => {
  const markup = renderChatView({
    transientMessages: [],
    activeTurn: undefined,
  });
  assert.doesNotMatch(markup, /why does this fail\?/);
  assert.doesNotMatch(markup, /maka-turn-processing/);
  // The empty state (onboarding surface / hero) must still render — the empty
  // optimistic fragments must not suppress it.
  assert.match(markup, /empty-state-marker/);
});

test('ordinary sends stay in ChatView across local delivery and Host admission', () => {
  const localOutbox: TransientUserMessageProjection = {
    ...OPTIMISTIC_BUBBLE,
    transientPlacement: 'next_turn',
    deliveryStatus: 'Sending',
  };
  const sending = mergeTransientMessageProjection(OPTIMISTIC_BUBBLE, localOutbox);
  const failed = mergeTransientMessageProjection(sending, {
    ...localOutbox, deliveryStatus: 'Failed',
  });
  const admitted = mergeTransientMessageProjection(sending, {
    ...localOutbox,
    transientPlacement: 'current_turn',
    hostTurnId: 'host-turn',
    deliveryStatus: 'Accepted',
  });
  const render = (message: TransientUserMessageProjection) => parseHTML(renderChatView({
    activeSession: {
      id: 'session-1', name: 'pending', status: 'active', backend: 'ai-sdk',
      labels: [], isFlagged: false, isArchived: false, hasUnread: false,
      llmConnectionSlug: 'conn', connectionLocked: false, model: 'model', permissionMode: 'ask',
    },
    transientMessages: [message],
  }, createElement(Composer, {
    pendingMessages: [message], onSend() {}, onStop() {},
  }))).document;

  // Render every admission phase independently: a settled-only assertion
  // would miss the provisional outbox update that used to mount the plate.
  for (const message of [OPTIMISTIC_BUBBLE, sending, failed, admitted]) {
    const document = render(message);
    assert.equal(Boolean(document.querySelector('.maka-composer-queue')), false,
      `no pending plate during ${message.deliveryStatus ?? 'optimistic send'}`);
    assert.ok(document.querySelector('.maka-user-message')?.textContent?.includes(OPTIMISTIC_BUBBLE.text),
      'the ordinary prompt remains in the transcript');
  }

  // An explicit follow-up starts in the queue; local delivery keeps it there.
  const explicitFollowUp = mergeTransientMessageProjection({
    ...OPTIMISTIC_BUBBLE, transientPlacement: 'next_turn',
  }, localOutbox);
  const pendingDocument = render(explicitFollowUp);
  assert.ok(pendingDocument.querySelector('.maka-composer-queue')?.textContent
    ?.includes(OPTIMISTIC_BUBBLE.text));
  assert.equal(pendingDocument.querySelector('.maka-user-message'), null);

  // The admission reply omits deliveryStatus; the inherited local status must
  // not keep a genuine follow-up in the transcript.
  const queued = mergeTransientMessageProjection(sending, {
    ...OPTIMISTIC_BUBBLE, transientPlacement: 'next_turn', pendingSteering: false,
  });
  assert.ok(render(queued).querySelector('.maka-composer-queue')?.textContent
    ?.includes(OPTIMISTIC_BUBBLE.text));
});
