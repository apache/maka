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

/**
 * The "move to project" row menu answers one question per task: which of its
 * projects are places this task can land — and is "leave every project" one of
 * them?
 *
 * The second half tripped once. A task whose `projectId` had outlived its
 * project (deleted, archived, relocated upstream — anything that empties the
 * scopes the rail can see) used to be offered only the exit row, because the
 * guard that gates it asked "is `projectId` truthy?" instead of "is this
 * `projectId` a project the rail can still name?". The user-surface read
 * "this task has no project", and the menu read "want to leave it?", and the
 * only way to keep both honest is to ask the same question.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList } from '../session-history-list.js';
import {
  SessionRailProvider,
  type SessionMoveTarget,
  type SessionRailData,
} from '../session-rail-context.js';

/** Same stubs the rail's other tests install: what Astryx asks of a real DOM. */
function installDomStubs(window: ReturnType<typeof parseHTML>['window']): void {
  Object.assign(globalThis, {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
  });
  window.getComputedStyle = () =>
    ({
      direction: 'ltr',
      writingMode: 'horizontal-tb',
      getPropertyValue: () => '',
    }) as unknown as CSSStyleDeclaration;
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}

function pointerEvent(
  window: ReturnType<typeof parseHTML>['window'],
  type: 'click' | 'pointerdown' | 'pointerup',
): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { detail: 1, button: 0 });
  return event as unknown as Event;
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    ...overrides,
  };
}

async function mountRail(
  sessions: readonly SessionSummary[],
  moveTargets: (sessionId: string) => readonly SessionMoveTarget[],
) {
  const original = { document: globalThis.document, window: globalThis.window };
  const { document, window } = parseHTML('<div id="root"></div>');
  installDomStubs(window);
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  const moves: Array<{ sessionId: string; projectId: string | null }> = [];
  const data: SessionRailData = {
    sessions,
    groupVariant: 'conversation',
    groups: [{ id: 'recent', label: 'Recent', sessions: [...sessions] }],
    onSelectSession: () => undefined,
    rowActions: {
      onToggleFlag: () => undefined,
      onArchive: () => undefined,
      onUnarchive: () => undefined,
      onRename: () => undefined,
      onMoveToProject: (sessionId, projectId) => {
        moves.push({ sessionId, projectId });
      },
    },
    moveTargets,
  };

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <LocaleProvider locale="en">
        <SessionRailProvider data={data} selection={undefined}>
          <SessionHistoryList />
        </SessionRailProvider>
      </LocaleProvider>,
    ),
  );

  return {
    window,
    moves,
    openRowMenu: async (sessionId: string) => {
      const trigger = document.querySelector(
        `[data-session-id="${sessionId}"] .maka-session-row-action button`,
      );
      assert.ok(trigger, `no row menu trigger for ${sessionId}`);
      await act(() => {
        trigger.dispatchEvent(pointerEvent(window, 'click'));
      });
      assert.equal(
        trigger.closest('.maka-session-row-action')?.getAttribute('data-menu-open'),
        'true',
        `⋯ on ${sessionId} did not open a menu`,
      );
    },
    menuLabels: (sessionId: string): string[] =>
      [...document.querySelectorAll(`[data-session-id="${sessionId}"] [role="menuitem"]`)].map(
        (item) => (item.textContent ?? '').trim(),
      ),
    dispose: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
  };
}

test('a task with no project is not offered "Remove from project"', async () => {
  // The provider's answer for such a task is "no targets": nothing below can
  // move it. But the guard that hides "Remove from project" has to live in
  // the row itself too, because the row is where `projectId` and the targets
  // meet.
  const rail = await mountRail([summary('s1')], () => []);
  try {
    await rail.openRowMenu('s1');
    const labels = rail.menuLabels('s1');
    assert.ok(
      !labels.some((label) => /remove from project/i.test(label)),
      `expected no "Remove from project", got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      !labels.some((label) => /move to project/i.test(label)),
      `with nowhere to go the submenu itself should read as nothing, got ${JSON.stringify(labels)}`,
    );
  } finally {
    await rail.dispose();
  }
});

test('a task in a project is offered every other project and the exit', async () => {
  const rail = await mountRail([summary('s1', { projectId: 'pA' })], () => [
    { groupKey: 'pA', projectId: 'pA', name: 'Alpha' },
    { groupKey: 'pB', projectId: 'pB', name: 'Beta' },
    { groupKey: '__ungrouped__:local', projectId: null },
  ]);
  try {
    await rail.openRowMenu('s1');
    const labels = rail.menuLabels('s1');
    assert.ok(
      labels.some((label) => /beta/i.test(label)),
      `sibling project should be reachable, got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      !labels.some((label) => /alpha/i.test(label)),
      `the project the task already lives in is not a destination, got ${JSON.stringify(labels)}`,
    );
    assert.ok(
      labels.some((label) => /remove from project/i.test(label)),
      `expected "Remove from project", got ${JSON.stringify(labels)}`,
    );
  } finally {
    await rail.dispose();
  }
});

test('a task whose projectId no longer names a real project is not offered the exit either', async () => {
  // Regression. The task carries a truthy `projectId` — orphaned by a project
  // deletion/archive upstream — and the rail's scopes no longer know it. From
  // the user's side this row reads as a task with no project, so offering only
  // "Remove from project" was exactly the lie. The targets the shell can name
  // are pB and pC here; pA is the one that disappeared.
  const rail = await mountRail([summary('s1', { projectId: 'pA' })], () => [
    { groupKey: 'pB', projectId: 'pB', name: 'Beta' },
    { groupKey: 'pC', projectId: 'pC', name: 'Gamma' },
    { groupKey: '__ungrouped__:local', projectId: null },
  ]);
  try {
    await rail.openRowMenu('s1');
    const labels = rail.menuLabels('s1');
    assert.ok(
      !labels.some((label) => /remove from project/i.test(label)),
      `an orphaned projectId must not summon the exit, got ${JSON.stringify(labels)}`,
    );
    // Moving into a real project remains the honest one-way door.
    assert.ok(labels.some((label) => /beta/i.test(label)));
    assert.ok(labels.some((label) => /gamma/i.test(label)));
  } finally {
    await rail.dispose();
  }
});

test('clicking a real destination forwards its projectId', async () => {
  const rail = await mountRail([summary('s1', { projectId: 'pA' })], () => [
    { groupKey: 'pA', projectId: 'pA', name: 'Alpha' },
    { groupKey: 'pB', projectId: 'pB', name: 'Beta' },
    { groupKey: '__ungrouped__:local', projectId: null },
  ]);
  try {
    await rail.openRowMenu('s1');
    const items = [
      ...rail.window.document.querySelectorAll(
        '[data-session-id="s1"] [role="menuitem"]',
      ),
    ] as HTMLElement[];
    const beta = items.find((item) => /beta/i.test(item.textContent ?? ''));
    assert.ok(beta, 'no Beta item in the menu');
    await act(() => {
      beta.dispatchEvent(pointerEvent(rail.window, 'click'));
    });
    assert.deepEqual(rail.moves, [{ sessionId: 's1', projectId: 'pB' }]);
  } finally {
    await rail.dispose();
  }
});
