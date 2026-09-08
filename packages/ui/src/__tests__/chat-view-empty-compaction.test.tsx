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
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionSummary } from '@maka/core/session';
import { ChatSurfaceLayout } from '../chat-surface-layout.js';
import { ChatView } from '../chat-view.js';
import type { LiveTurnProjection } from '../live-turn-projection.js';
import { LocaleProvider } from '../locale-context.js';

const activeSession = {
  id: 'session-1',
  name: 'Session',
  status: 'running',
  labels: [] as string[],
} as unknown as SessionSummary;

function renderChat(liveTurn?: LiveTurnProjection): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <ChatSurfaceLayout composer={null}>
        <ChatView
          messages={[]}
          activeSession={activeSession}
          liveTurn={liveTurn}
          scrollBehavior="auto"
          onNew={() => undefined}
        />
      </ChatSurfaceLayout>
    </LocaleProvider>,
  );
}

test('renders the live compaction row in a session with no settled messages', () => {
  const markup = renderChat({
    turnId: 'turn-compact',
    phase: 'waiting',
    rootExecutionKind: 'context_compact',
    startedAt: 0,
    steps: [],
  });

  // Before the fix, showEmptyState hid this overlaid row behind the empty hero
  // because it keyed off chat.length (0) and never saw the synthesized turn.
  assert.match(markup, /Compacting context/);
});

test('renders the empty hero when an empty session has no live compaction row', () => {
  const markup = renderChat(undefined);

  assert.doesNotMatch(markup, /Compacting context/);
});
