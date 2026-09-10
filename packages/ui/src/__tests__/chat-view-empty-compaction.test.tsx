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
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
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

function renderChat(liveTurn?: LiveTurnProjection, overrides: Partial<ComponentProps<typeof ChatView>> = {}): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <ChatSurfaceLayout composer={null}>
        <ChatView
          messages={[]}
          activeSession={activeSession}
          liveTurn={liveTurn}
          scrollBehavior="auto"
          onNew={() => undefined}
          {...overrides}
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

test('shows one waiting indicator before a named live Turn reaches the transcript', () => {
  const liveTurn: LiveTurnProjection = { turnId: 'pending-turn', phase: 'waiting', steps: [], unconfirmed: true };
  const pending = { id: 'pending-user', hostTurnId: liveTurn.turnId, text: 'Please help', ts: 1000, transientPlacement: 'current_turn' as const };
  for (const messages of [[], [{ type: 'user' as const, id: 'old-user', turnId: 'old-turn', text: 'Earlier request', ts: 1 }]]) {
    const markup = renderChat(liveTurn, { messages, transientMessages: [pending], runningStatus: true });
    assert.equal((markup.match(/class="maka-turn-processing"/g) ?? []).length, 1);
    assert.match(markup, /Waiting for model output/);
    assert.match(markup, /Please help/);
    assert.doesNotMatch(markup, /data-transcript-turn-id="pending-turn"/);
  }
  const committed = renderChat(liveTurn, {
    messages: [{ type: 'user', id: 'durable-user', turnId: liveTurn.turnId, text: pending.text, ts: pending.ts }],
    runningStatus: true,
  });
  assert.equal((committed.match(/class="maka-turn-processing"/g) ?? []).length, 1);
  assert.match(committed, /data-transcript-turn-id="pending-turn"/);
});

test('prefers a recorded failed tail over a stale running witness for that turn', () => {
  const turnId = 'failed-turn';
  const markup = renderChat(
    { turnId, phase: 'waiting', startedAt: 1, steps: [] },
    {
      messages: [
        { type: 'user', id: 'user-1', turnId, text: 'Run this', ts: 1 },
        { type: 'turn_state', id: 'state-1', turnId, status: 'failed', ts: 2 },
      ],
      runningStatus: true,
      deriveTurnPresentation: () => ({
        footerActionsByTurn: {},
        failedReasonLabels: { [turnId]: 'The turn failed' },
        failedSeverities: {},
        failedExecutionStateLabels: {},
        lineageBadgesByTurn: {},
      }),
    },
  );

  assert.match(markup, /The turn failed/);
  assert.doesNotMatch(markup, /Waiting for model output/);
  const { document } = parseHTML(markup);
  assert.equal(document.querySelector('.maka-turn')?.getAttribute('data-live-streaming'), null);
});

test('keeps a genuinely running sibling visible after a failed turn', () => {
  const failedTurnId = 'failed-turn';
  const runningTurnId = 'running-turn';
  const markup = renderChat(
    { turnId: runningTurnId, phase: 'waiting', startedAt: 3, steps: [] },
    {
      messages: [
        { type: 'user', id: 'user-1', turnId: failedTurnId, text: 'First', ts: 1 },
        {
          type: 'turn_state',
          id: 'failed-state',
          turnId: failedTurnId,
          status: 'failed',
          ts: 2,
        },
        { type: 'user', id: 'user-2', turnId: runningTurnId, text: 'Second', ts: 3 },
        {
          type: 'turn_state',
          id: 'running-state',
          turnId: runningTurnId,
          status: 'running',
          ts: 4,
        },
      ],
      runningStatus: true,
      deriveTurnPresentation: () => ({
        footerActionsByTurn: {},
        failedReasonLabels: { [failedTurnId]: 'The first turn failed' },
        failedSeverities: {},
        failedExecutionStateLabels: {},
        lineageBadgesByTurn: {},
      }),
    },
  );

  assert.match(markup, /The first turn failed/);
  assert.equal(parseHTML(markup).document.querySelectorAll('.maka-turn-processing').length, 1);
});

test('renders the empty hero when an empty session has no live compaction row', () => {
  const markup = renderChat(undefined);

  assert.doesNotMatch(markup, /Compacting context/);
});

test('the pending Turn clock ticks from send time and hands over without a duplicate status', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const original = {
    document: globalThis.document, window: globalThis.window,
    matchMedia: globalThis.matchMedia, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    MutationObserver: globalThis.MutationObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document, window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  const container = document.querySelector('#root')!;
  const root = createRoot(container);
  t.after(async () => { await act(() => root.unmount()); Object.assign(globalThis, original); });
  const liveTurn: LiveTurnProjection = { turnId: 'pending-turn', phase: 'waiting', steps: [], unconfirmed: true };
  const pending = { id: 'pending-user', hostTurnId: liveTurn.turnId, text: 'Please help', ts: now, transientPlacement: 'current_turn' as const };
  const render = async (overrides: Partial<ComponentProps<typeof ChatView>>) => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <ChatSurfaceLayout composer={null}>
          <ChatView messages={[]} activeSession={activeSession} liveTurn={liveTurn}
            runningStatus transientMessages={[pending]} scrollBehavior="auto" onNew={() => undefined} {...overrides} />
        </ChatSurfaceLayout>
      </LocaleProvider>,
    ));
  };
  await render({});
  assert.equal(container.querySelectorAll('.maka-turn-processing').length, 1);
  assert.match(container.querySelector('.maka-turn-elapsed')?.textContent ?? '', /0s/);
  await act(() => t.mock.timers.tick(2_000));
  assert.match(container.querySelector('.maka-turn-elapsed')?.textContent ?? '', /2s/);
  await render({
    transientMessages: [],
    messages: [{ type: 'user', id: 'durable-user', turnId: liveTurn.turnId, text: pending.text, ts: pending.ts }],
  });
  assert.equal(container.querySelectorAll('.maka-turn-processing').length, 1);
  assert.match(container.querySelector('.maka-turn-elapsed')?.textContent ?? '', /2s/);
  await render({ liveTurn: undefined, runningStatus: false, transientMessages: [] });
  assert.equal(container.querySelectorAll('.maka-turn-processing').length, 0);
});
