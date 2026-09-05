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
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AstryxLocaleProvider,
  ChatSurfaceLayout,
  ChatView,
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
function renderNoSessionChatView(
  props: Partial<ComponentProps<typeof ChatView>>,
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
    scrollOwner: 'host',
    composer: null,
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
  const markup = renderNoSessionChatView({
    transientMessages: [OPTIMISTIC_BUBBLE],
    runningStatus: true,
  });
  // The user's question is on screen immediately, before the fork/session lands.
  assert.match(markup, /why does this fail\?/);
  // The running-status line rides alongside it (the no-turn bare-turn fallback).
  assert.match(markup, /data-live-streaming="true"/);
  // The optimistic content takes over from the empty state.
  assert.doesNotMatch(markup, /empty-state-marker/);
});

test('ChatView shows the empty state when there is neither a bubble nor a running turn', () => {
  const markup = renderNoSessionChatView({
    transientMessages: [],
    runningStatus: false,
  });
  assert.doesNotMatch(markup, /why does this fail\?/);
  assert.doesNotMatch(markup, /data-live-streaming="true"/);
  // The empty state (onboarding surface / hero) must still render — the empty
  // optimistic fragments must not suppress it.
  assert.match(markup, /empty-state-marker/);
});
