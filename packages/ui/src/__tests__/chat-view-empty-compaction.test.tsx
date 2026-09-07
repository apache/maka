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
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { TurnView } from '../chat-turn.js';
import { materializeTurns, overlayLiveTurn } from '../materialize.js';
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
  const { document } = parseHTML(markup);
  const row = document.querySelector('[data-compaction-state="running"]');
  assert.equal(row?.getAttribute('data-variant'), 'divider');
  assert.equal(row?.querySelector('.astryx-spinner')?.getAttribute('aria-hidden'), 'true');
});

test('renders the empty hero when an empty session has no live compaction row', () => {
  const markup = renderChat(undefined);

  assert.doesNotMatch(markup, /Compacting context/);
});

for (const [kind, state, variant] of [
  ['context_compacted', 'compacted', 'divider'],
  ['context_compaction_failed_open', 'failed', 'default'],
] as const) {
  test(`durable ${kind} renders the appropriate compaction state`, () => {
    const [turn] = materializeTurns(
      [{ type: 'system_note', id: 'note', turnId: 'compact', ts: 1000, kind }],
      'en',
    );
    const { document } = parseHTML(
      renderToStaticMarkup(
        <LocaleProvider locale="en">
          <TurnView turn={turn!} />
        </LocaleProvider>,
      ),
    );
    const row = document.querySelector('[data-compaction-state]');
    assert.equal(row?.getAttribute('data-compaction-state'), state);
    assert.equal(row?.getAttribute('data-variant'), variant);
    assert.equal(row?.querySelector('.astryx-spinner'), null);
  });
}

test('compaction clock uses the live Host start and disappears when the durable note takes over', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  const actGlobals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = actGlobals.IS_REACT_ACT_ENVIRONMENT;
  const { window, document } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.querySelector('#root')!;
  const root = createRoot(container);
  try {
    const [turn] = overlayLiveTurn(
      materializeTurns(
        [
          {
            type: 'turn_state',
            id: 'running',
            turnId: 'compact',
            ts: Date.now() - 60_000,
            status: 'running',
            partialOutputRetained: false,
          },
        ],
        'en',
      ),
      {
        turnId: 'compact',
        phase: 'waiting',
        steps: [],
        rootExecutionKind: 'context_compact',
        startedAt: Date.now() - 25_000,
      },
      'en',
    );
    await act(() =>
      root.render(
        <LocaleProvider locale="en">
          <TurnView turn={turn!} />
        </LocaleProvider>,
      ),
    );
    const clock = container.querySelector('.maka-turn-elapsed')!;
    assert.equal(clock.textContent, '25s');
    assert.equal(clock.getAttribute('aria-hidden'), 'true');
    await act(() => new Promise((resolve) => setTimeout(resolve, 1100)));
    assert.equal(clock.textContent, '26s');
    const [done] = materializeTurns(
      [
        {
          type: 'system_note',
          id: 'done',
          turnId: 'compact',
          ts: Date.now(),
          kind: 'context_compacted',
        },
      ],
      'en',
    );
    await act(() =>
      root.render(
        <LocaleProvider locale="en">
          <TurnView turn={done!} />
        </LocaleProvider>,
      ),
    );
    assert.equal(container.querySelector('.maka-turn-elapsed'), null);
    assert.equal(container.querySelector('.astryx-spinner'), null);
    assert.equal(
      container.querySelector('[data-compaction-state]')?.getAttribute('data-variant'),
      'divider',
    );
    container.setAttribute('data-maka-e2e-fixture', 'true');
    await act(() =>
      root.render(
        <LocaleProvider locale="en">
          <TurnView turn={turn!} />
        </LocaleProvider>,
      ),
    );
    assert.equal(container.querySelector('.maka-turn-elapsed')?.textContent, '');
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, previous, { IS_REACT_ACT_ENVIRONMENT: previousAct });
  }
});
