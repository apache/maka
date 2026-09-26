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
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
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
    clickMenuItem: async (sessionId: string, label: string) => {
      const item = [...document.querySelectorAll(
        `[data-session-id="${sessionId}"] [role="menuitem"]`,
      )].find((candidate) => candidate.textContent?.trim() === label);
      assert.ok(item, `no menu item: ${label}`);
      await act(async () => {
        item.dispatchEvent(pointerEvent(window, 'click'));
      });
    },
    dispose: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
  };
}

for (const projectId of [undefined, 'missing']) {
  test('hides the move submenu when the provider has no targets: ' + String(projectId), async () => {
    const rail = await mountRail([summary('s1', { projectId })], () => []);
    try {
      await rail.openRowMenu('s1');
      const labels = rail.menuLabels('s1');
      assert.ok(!labels.includes('Remove from project'));
      assert.ok(!labels.includes('Move to project'));
    } finally {
      await rail.dispose();
    }
  });
}

test('an orphan projectId can move to a destination without an exit', async () => {
  const rail = await mountRail([summary('s1', { projectId: 'missing' })], () => [
    { groupKey: 'pB', projectId: 'pB', name: 'Beta' },
    { groupKey: 'pC', projectId: 'pC', name: 'Gamma' },
  ]);
  try {
    await rail.openRowMenu('s1');
    const labels = rail.menuLabels('s1');
    assert.ok(!labels.includes('Remove from project'));
    assert.ok(labels.includes('Beta'));
    assert.ok(labels.includes('Gamma'));
    await rail.clickMenuItem('s1', 'Beta');
    assert.deepEqual(rail.moves, [{ sessionId: 's1', projectId: 'pB' }]);
  } finally {
    await rail.dispose();
  }
});

// The provider resolves aliases and archived/unavailable membership. None of
// those cases require the current project to appear among the destinations.
for (const projectId of ['pA', 'oldA']) {
  for (const withSibling of [false, true]) {
    test('keeps a provider-approved exit: ' + projectId + ', sibling=' + withSibling, async () => {
      const targets: SessionMoveTarget[] = withSibling
        ? [{ groupKey: 'pB', projectId: 'pB', name: 'Beta' }]
        : [];
      targets.push({ groupKey: '__ungrouped__:local', projectId: null });
      const rail = await mountRail([summary('s1', { projectId })], () => targets);
      try {
        await rail.openRowMenu('s1');
        const labels = rail.menuLabels('s1');
        assert.ok(labels.includes('Move to project'));
        assert.ok(labels.includes('Remove from project'));
        assert.equal(labels.includes('Beta'), withSibling);
        await rail.clickMenuItem('s1', 'Remove from project');
        assert.deepEqual(rail.moves, [{ sessionId: 's1', projectId: null }]);
      } finally {
        await rail.dispose();
      }
    });
  }
}
