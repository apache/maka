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
  transientPlacement: 'transcript',
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

test('a prompt on its way to the Host holds its Turn place beside a copy that did not send', () => {
  const failed = { ...OPTIMISTIC_BUBBLE, id: 'failed', deliveryStatus: 'Failed' };
  const render = (transientMessages: TransientUserMessageProjection[]) =>
    parseHTML(renderChatView({ transientMessages })).document;

  const document = render([failed, { ...OPTIMISTIC_BUBBLE, id: 'fresh' }]);
  const answer = document.querySelector('.maka-pending-turn[data-awaiting-host] .maka-assistant-answer');
  assert.ok(answer, 'the answer row is laid out ahead of the Host');
  assert.doesNotMatch(answer?.getAttribute('aria-label') ?? '', /1970/, 'no answer time is claimed before the Host starts one');
  assert.equal(render([failed]).querySelector('.maka-pending-turn'), null, 'nothing is on its way');
});

test('ordinary sends stay in ChatView while queued prompts stay in the composer', () => {
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

  for (const message of [
    OPTIMISTIC_BUBBLE,
    { ...OPTIMISTIC_BUBBLE, deliveryStatus: 'Saved locally' },
    { ...OPTIMISTIC_BUBBLE, deliveryStatus: 'Failed' },
    { ...OPTIMISTIC_BUBBLE, hostTurnId: 'host-turn' },
  ]) {
    const document = render(message);
    assert.equal(Boolean(document.querySelector('.maka-composer-queue')), false,
      `no pending plate during ${message.deliveryStatus ?? 'optimistic send'}`);
    assert.ok(document.querySelector('.maka-user-message')?.textContent?.includes(OPTIMISTIC_BUBBLE.text),
      'the ordinary prompt remains in the transcript');
  }

  for (const transientPlacement of ['steering', 'follow_up'] as const) {
    const document = render({ ...OPTIMISTIC_BUBBLE, transientPlacement });
    assert.ok(document.querySelector('.maka-composer-queue')?.textContent?.includes(OPTIMISTIC_BUBBLE.text));
    assert.equal(document.querySelector('.maka-user-message'), null, `${transientPlacement} stays out of the transcript`);
  }
});
