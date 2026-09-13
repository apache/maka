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
          liveTurns={liveTurn ? [liveTurn] : undefined}
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
    rootExecutionKind: 'context_compact',
    startedAt: 0,
    steps: [],
  }, { activeTurn: { turnId: 'turn-compact', compacting: true } });

  // Before the fix, showEmptyState hid this overlaid row behind the empty hero
  // because it keyed off chat.length (0) and never saw the synthesized turn.
  assert.match(markup, /Compacting context/);
});

test('retains tool and compaction evidence without activity after observation loss', () => {
  const messages = [{ type: 'user' as const, id: 'user', turnId: 'prior', text: 'Earlier request', ts: 1 }];
  const tool: LiveTurnProjection = { turnId: 'tool-turn', steps: [{ stepId: 'step', tools: [
    { toolUseId: 'bash', toolName: 'Bash', args: { command: 'echo retained' }, status: 'running' },
  ] }] };
  const compact: LiveTurnProjection = { turnId: 'compact', rootExecutionKind: 'context_compact', steps: [] };
  for (const observed of [true, false, true]) {
    const toolDocument = parseHTML(renderChat(tool, { messages, activeTurn: observed ? { turnId: tool.turnId } : undefined })).document;
    assert.equal(toolDocument.querySelector('.maka-tool-activity-card')?.getAttribute('data-activity-observed'), String(observed));
    assert.match(toolDocument.querySelector('.maka-tool-activity-card')?.textContent ?? '', /echo retained/);
    const compactDocument = parseHTML(renderChat(compact, { messages, activeTurn: observed ? { turnId: compact.turnId, compacting: true } : undefined })).document;
    assert.equal(compactDocument.querySelector('[data-compaction-state]')?.getAttribute('data-compaction-state'), observed ? 'running' : 'unavailable');
    assert.equal(compactDocument.querySelectorAll('.maka-compaction-status .astryx-spinner').length, observed ? 1 : 0);
  }
  assert.equal(tool.steps[0]?.tools[0]?.status, 'running', 'availability never rewrites retained execution evidence');
});

test('shows one waiting indicator before a named live Turn reaches the transcript', () => {
  const liveTurn: LiveTurnProjection = { turnId: 'pending-turn', steps: [], unconfirmed: true };
  const pending = { id: 'pending-user', hostTurnId: liveTurn.turnId, text: 'Please help', ts: 1000, transientPlacement: 'current_turn' as const };
  for (const messages of [[], [{ type: 'user' as const, id: 'old-user', turnId: 'old-turn', text: 'Earlier request', ts: 1 }]]) {
    const markup = renderChat(liveTurn, { messages, transientMessages: [pending], activeTurn: { turnId: liveTurn.turnId! } });
    assert.equal((markup.match(/class="maka-turn-processing"/g) ?? []).length, 1);
    assert.match(markup, /Waiting for model output/);
    assert.match(markup, /Please help/);
    assert.doesNotMatch(markup, /data-transcript-turn-id="pending-turn"/);
  }
  const committed = renderChat(liveTurn, {
    messages: [{ type: 'user', id: 'durable-user', turnId: liveTurn.turnId, text: pending.text, ts: pending.ts }],
    activeTurn: { turnId: liveTurn.turnId! },
  });
  assert.equal((committed.match(/class="maka-turn-processing"/g) ?? []).length, 1);
  assert.match(committed, /data-transcript-turn-id="pending-turn"/);
});

test('a new Host Turn owns its waiting footer while the previous answer remains buffered', () => {
  const oldTurn: LiveTurnProjection = {
    turnId: 'old-turn', terminal: true,
    steps: [{ stepId: 'old-answer', text: { text: 'Previous answer', complete: true, truncated: false }, tools: [] }],
  };
  const messages = [{ type: 'user' as const, id: 'old-user', turnId: 'old-turn', text: 'Earlier request', ts: 1 }];
  const transientMessages = [{ id: 'new-user', hostTurnId: 'new-turn', text: 'New request', ts: 2, transientPlacement: 'current_turn' as const }];
  for (const content of [oldTurn, undefined]) {
    const markup = renderChat(content, { messages, transientMessages, activeTurn: { turnId: 'new-turn' } });
    const { document } = parseHTML(markup);
    assert.equal(document.querySelectorAll('.maka-turn-processing').length, 1);
    assert.equal(document.querySelector('[data-transcript-turn-id="old-turn"] .maka-turn-processing'), null);
    assert.ok(markup.indexOf('New request') < markup.indexOf('maka-turn-processing'));
    if (content) assert.match(markup, /Previous answer/);
  }
  const idle = renderChat({ ...oldTurn, terminal: undefined }, { messages });
  assert.doesNotMatch(idle, /maka-turn-processing/);
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
  const liveTurn: LiveTurnProjection = { turnId: 'pending-turn', steps: [], unconfirmed: true };
  const pending = { id: 'pending-user', hostTurnId: liveTurn.turnId, text: 'Please help', ts: now, transientPlacement: 'current_turn' as const };
  const render = async (overrides: Partial<ComponentProps<typeof ChatView>>) => {
    await act(() => root.render(
      <LocaleProvider locale="en">
        <ChatSurfaceLayout composer={null}>
          <ChatView messages={[]} activeSession={activeSession} liveTurns={liveTurn ? [liveTurn] : undefined}
            activeTurn={{ turnId: liveTurn.turnId! }} transientMessages={[pending]} scrollBehavior="auto" onNew={() => undefined} {...overrides} />
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
  await render({ liveTurns: undefined, activeTurn: undefined, transientMessages: [] });
  assert.equal(container.querySelectorAll('.maka-turn-processing').length, 0);
});


test('ChatSurfaceLayout preserves the public emptyState for absent children', () => {
  for (const children of [null, undefined, false, []]) {
    const markup = renderToStaticMarkup(
      <ChatSurfaceLayout composer={null} emptyState={<p>Empty layout</p>} children={children} />,
    );
    assert.match(markup, /Empty layout/);
    assert.doesNotMatch(markup, /maka-prompt-rail-host/);
  }
});
