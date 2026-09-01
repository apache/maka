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
 * The rail is a navigation surface that also has to be selectable, so what
 * matters is which of the two a click is. These cases drive real clicks rather
 * than asserting markup: the branch under test is chosen inside the row's
 * handler, and markup cannot say which branch ran.
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
  type SessionRailData,
  type SessionRailRowSelection,
  type SessionRailSelection,
} from '../session-rail-context.js';

/**
 * What Astryx's SideNavItem reaches for that linkedom does not ship: a computed
 * style and `matchMedia`, which its hover hook subscribes to. Neither is what
 * these cases are about, so both answer the least interesting truth.
 */
/**
 * linkedom ships no `MouseEvent`, and React reads the modifier flags straight
 * off the native event, so a plain Event carrying them is exactly as much event
 * as the handler under test looks at.
 */
function clickEvent(
  window: ReturnType<typeof parseHTML>['window'],
  modifiers: Partial<MouseEventInit>,
): Event {
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  Object.assign(event, {
    detail: 1,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  });
  return event as unknown as Event;
}

function installDomStubs(window: ReturnType<typeof parseHTML>['window']): void {
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

function summary(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
  };
}

const SESSIONS = ['a', 'b', 'c'].map(summary);

type Harness = {
  opened: string[];
  toggles: Array<[string, boolean]>;
  toggleAll: boolean[];
  entered: Array<string | undefined>;
  exits: number;
  deleteRequests: number;
  pressKey(key: string, focusedSessionId?: string): Promise<void>;
  dispose(): Promise<void>;
  clickRow(sessionId: string, modifiers?: Partial<MouseEventInit>): Promise<void>;
  clickCheckbox(sessionId: string, checked: boolean): Promise<void>;
  document: Document;
};

async function mount(
  options: { selectedIds?: readonly string[]; active?: boolean } = {},
): Promise<Harness> {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  installDomStubs(window);
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  const opened: string[] = [];
  const toggles: Array<[string, boolean]> = [];
  const toggleAll: boolean[] = [];
  const entered: Array<string | undefined> = [];
  let exits = 0;
  let deleteRequests = 0;
  const rowSelection: SessionRailRowSelection = {
    active: options.active ?? false,
    selectedIds: new Set(options.selectedIds ?? []),
    onToggleRow: (sessionId, selected) => toggles.push([sessionId, selected]),
    onEnter: (sessionId) => entered.push(sessionId),
  };
  const selection: SessionRailSelection = {
    ...rowSelection,
    listedSessionIds: SESSIONS.map((session) => session.id),
    onExit: () => {
      exits += 1;
    },
    onToggleAll: (selected) => toggleAll.push(selected),
    onArchiveSelected: () => undefined,
    onDeleteSelected: () => {
      deleteRequests += 1;
    },
  };
  const data: SessionRailData = {
    sessions: SESSIONS,
    groupVariant: 'conversation',
    groups: [{ id: 'recent', label: 'Recent', sessions: [...SESSIONS] }],
    onSelectSession: (sessionId) => opened.push(sessionId),
  };

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <LocaleProvider locale="en">
        <SessionRailProvider data={data} selection={selection} rowSelection={rowSelection}>
          <SessionHistoryList />
        </SessionRailProvider>
      </LocaleProvider>,
    ),
  );

  const harness: Harness = {
    opened,
    toggles,
    toggleAll,
    entered,
    get exits() {
      return exits;
    },
    get deleteRequests() {
      return deleteRequests;
    },
    pressKey: async (key: string, focusedSessionId = 'a') => {
      // linkedom has no focus model and reports `activeElement` as null, where a
      // browser reports <body> when nothing is focused — and here a row really
      // is focused, because the user just clicked one. The handler's first
      // guard reads it, so the test has to answer it.
      const focused = document.querySelector(`[data-session-id="${focusedSessionId}"] button`);
      assert.ok(focused);
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get: () => focused,
      });
      const list = document.querySelector('.maka-session-list');
      assert.ok(list);
      await act(() => {
        const event = new window.Event('keydown', { bubbles: true, cancelable: true });
        Object.assign(event, { key });
        list.dispatchEvent(event);
      });
    },
    document: document as unknown as Document,
    clickRow: async (sessionId, modifiers = {}) => {
      const row = document.querySelector(`[data-session-id="${sessionId}"] button`);
      assert.ok(row, `no clickable row for ${sessionId}`);
      await act(() => {
        row.dispatchEvent(clickEvent(window, modifiers));
      });
    },
    clickCheckbox: async (sessionId, checked) => {
      const box = document.querySelector(
        `[data-session-id="${sessionId}"] .maka-session-row-check input`,
      ) as HTMLInputElement | null;
      assert.ok(box, `no checkbox for ${sessionId}`);
      // React's checkbox `onChange` is driven by the native CLICK, not by a
      // `change` event, and its value tracker swallows a programmatic
      // `.checked` write that is not followed by one.
      await act(() => {
        box.checked = checked;
        box.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
      });
    },
    dispose: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
  };
  return harness;
}

test('a plain click still opens the task', async () => {
  const harness = await mount();
  try {
    await harness.clickRow('b');
    assert.deepEqual(harness.opened, ['b']);
  } finally {
    await harness.dispose();
  }
});

test('a marked row says so in the DOM', async () => {
  const harness = await mount({ selectedIds: ['b'] });
  try {
    const marked = harness.document.querySelectorAll('[data-selected="true"]');
    assert.equal(marked.length, 1);
    assert.equal((marked[0] as HTMLElement).dataset.sessionId, 'b');
  } finally {
    await harness.dispose();
  }
});

test('a rail with no selection wired up behaves exactly as before', async () => {
  // The context is optional so a surface that never adopts multi-select — or a
  // story that renders rows alone — keeps plain clicks and gains no chrome.
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { document, window } = parseHTML('<div id="root"></div>');
  installDomStubs(window);
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  const opened: string[] = [];
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <LocaleProvider locale="en">
          <SessionRailProvider
            data={{
              sessions: SESSIONS,
              groupVariant: 'conversation',
              groups: [{ id: 'recent', label: 'Recent', sessions: [...SESSIONS] }],
              onSelectSession: (sessionId) => opened.push(sessionId),
            }}
          >
            <SessionHistoryList />
          </SessionRailProvider>
        </LocaleProvider>,
      ),
    );
    const row = document.querySelector('[data-session-id="b"] button');
    assert.ok(row);
    await act(() => {
      row.dispatchEvent(clickEvent(window, { metaKey: true }));
    });
    // A modifier with nothing wired up is still a click on a task.
    assert.deepEqual(opened, ['b']);
    assert.equal(document.querySelector('[data-selected="true"]'), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});

test('Escape leaves the mode', async () => {
  const harness = await mount({ active: true, selectedIds: ['b'] });
  try {
    await harness.pressKey('Escape');
    assert.equal(harness.exits, 1);
  } finally {
    await harness.dispose();
  }
});

test('Escape outside the mode is not this handler\'s business', async () => {
  const harness = await mount();
  try {
    await harness.pressKey('Escape');
    assert.equal(harness.exits, 0);
  } finally {
    await harness.dispose();
  }
});

test('Delete asks for the marked set, not the focused row', async () => {
  // Deleting the focused row while several are marked is the shape of an
  // unrecoverable surprise: the user sees N marked and loses one they did not
  // single out.
  const harness = await mount({ active: true, selectedIds: ['a', 'c'] });
  try {
    await harness.pressKey('Delete');
    assert.equal(harness.deleteRequests, 1);
  } finally {
    await harness.dispose();
  }
});

test('no checkbox exists until the mode is on', async () => {
  const harness = await mount();
  try {
    assert.equal(harness.document.querySelector('.maka-session-row-check'), null);
  } finally {
    await harness.dispose();
  }
});

test('in the mode every row carries a box, ticked to match', async () => {
  const harness = await mount({ active: true, selectedIds: ['b'] });
  try {
    const boxes = [...harness.document.querySelectorAll('.maka-session-row-check input')];
    assert.equal(boxes.length, 3);
    assert.deepEqual(
      boxes.map((box) => (box as HTMLInputElement).checked),
      [false, true, false],
    );
  } finally {
    await harness.dispose();
  }
});

test('ticking a box reports the row and the direction', async () => {
  const harness = await mount({ active: true });
  try {
    await harness.clickCheckbox('c', true);
    assert.deepEqual(harness.toggles, [['c', true]]);
  } finally {
    await harness.dispose();
  }
});

test('a row click still opens the task while the mode is on', async () => {
  // The box is the selection affordance; the row keeps its job. Making the
  // whole row toggle would cost the rail the one thing it is for.
  const harness = await mount({ active: true });
  try {
    await harness.clickRow('b');
    assert.deepEqual(harness.opened, ['b']);
    assert.deepEqual(harness.toggles, []);
  } finally {
    await harness.dispose();
  }
});
