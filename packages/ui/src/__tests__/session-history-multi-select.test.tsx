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
 * matters is which of the two a click is — and that is decided by the modifier
 * held while clicking, nowhere else. These cases drive real clicks rather than
 * asserting markup: the branch under test is chosen inside a handler, and
 * markup cannot say which branch ran.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { act, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList } from '../session-history-list.js';
import {
  SessionRailProvider,
  type SessionRailData,
  type SessionRailSelection,
  type SessionRailSelectionCommands,
} from '../session-rail-context.js';

/**
 * What Astryx reaches for that linkedom does not ship: a computed style and
 * `matchMedia`, which SideNavItem's hover hook subscribes to, and the frame
 * callback DropdownMenu positions itself in. None is what these cases are
 * about, so each answers the least interesting truth.
 */
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

/**
 * linkedom ships no `MouseEvent`, and React reads the modifier flags straight
 * off the native event, so a plain Event carrying them is exactly as much event
 * as the handlers under test look at.
 */
function pointerEvent(
  window: ReturnType<typeof parseHTML>['window'],
  type: 'click' | 'contextmenu',
  modifiers: Record<string, unknown> = {},
): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    detail: 1,
    button: type === 'contextmenu' ? 2 : 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  });
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
    backend: 'ai-sdk',
    llmConnectionSlug: 'test-connection',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'ask',
    ...overrides,
  };
}

const ROW_ACTIONS = {
  onToggleFlag: () => undefined,
  onArchive: () => undefined,
  onUnarchive: () => undefined,
  onRename: () => undefined,
};

type PickCall = Parameters<SessionRailSelectionCommands['pick']>[0];

interface Harness {
  opened: string[];
  picks: PickCall[];
  /** The id lists the menu narrowed the set to, in the order it asked. */
  retains: string[][];
  flags: boolean[];
  clears: number;
  archives: number;
  document: Document;
  clickRow(sessionId: string, modifiers?: Record<string, unknown>): Promise<void>;
  rightClickRow(sessionId: string): Promise<boolean>;
  openRowMenu(sessionId: string): Promise<void>;
  clickMenuItem(index: number): Promise<void>;
  menuLabels(): string[];
  /** What the row says to assistive tech and nowhere else. */
  rowDescription(sessionId: string): string;
  hasRowMenu(sessionId: string): boolean;
  collapseProject(projectId: string): Promise<void>;
  pressEscape(focusedSessionId?: string): Promise<boolean>;
  pressEscapeInsideRowMenu(sessionId: string): Promise<boolean>;
  dispose(): Promise<void>;
}

async function mount(
  options: {
    selectedIds?: readonly string[];
    sessions?: SessionSummary[];
    activeId?: string;
    groupVariant?: SessionRailData['groupVariant'];
    groups?: SessionRailData['groups'];
  } = {},
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

  const sessions = options.sessions ?? ['a', 'b', 'c', 'd'].map((id) => summary(id));
  const opened: string[] = [];
  const picks: PickCall[] = [];
  const retains: string[][] = [];
  const flags: boolean[] = [];
  let clears = 0;
  let archives = 0;
  // `pick` only records, because what the app's reducer makes of a click is
  // that reducer's own test. `retain` also applies, because the menu's wording
  // and its sweep are read from the set it narrows — a stub that recorded and
  // left the set alone would let an assertion about the menu pass over rows
  // the narrowing was supposed to have removed.
  let narrow: Dispatch<SetStateAction<ReadonlySet<string>>> | undefined;
  const commands: SessionRailSelectionCommands = {
    pick: (request) => picks.push(request),
    clear: () => {
      clears += 1;
    },
    retain: (sessionIds) => {
      retains.push([...sessionIds]);
      const keep = new Set(sessionIds);
      narrow?.((current) => new Set([...current].filter((sessionId) => keep.has(sessionId))));
    },
    archiveSelected: () => {
      archives += 1;
    },
    flagSelected: (flagged) => {
      flags.push(flagged);
    },
  };

  function Rail() {
    const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
      () => new Set(options.selectedIds ?? []),
    );
    narrow = setSelectedIds;
    const selection = useMemo<SessionRailSelection>(() => ({ selectedIds, commands }), [
      selectedIds,
    ]);
    return (
      <SessionRailProvider data={data} selection={selection}>
        <SessionHistoryList />
      </SessionRailProvider>
    );
  }
  const data: SessionRailData = {
    sessions,
    activeId: options.activeId,
    groupVariant: options.groupVariant ?? 'conversation',
    groups: options.groups ?? [{ id: 'recent', label: 'Recent', sessions: [...sessions] }],
    onSelectSession: (sessionId) => opened.push(sessionId),
    rowActions: ROW_ACTIONS,
  };

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <LocaleProvider locale="en">
        <Rail />
      </LocaleProvider>,
    ),
  );

  function rowButton(sessionId: string): Element {
    const node = document.querySelector(
      `[data-session-id="${sessionId}"] button.astryx-side-nav-item`,
    );
    assert.ok(node, `no clickable row for ${sessionId}`);
    return node;
  }

  // Every row owns a MoreMenu and Astryx renders each one's items eagerly, so
  // the whole rail's items are in the document at once. Only the row whose ⋯
  // was last pressed is on screen, so that is the row these read.
  let openedMenuRow: string | undefined;

  function menuItems(): Element[] {
    assert.ok(openedMenuRow, 'no row menu has been opened');
    return [
      ...document.querySelectorAll(`[data-session-id="${openedMenuRow}"] [role="menuitem"]`),
    ];
  }

  return {
    opened,
    picks,
    retains,
    flags,
    get clears() {
      return clears;
    },
    get archives() {
      return archives;
    },
    document: document as unknown as Document,
    clickRow: async (sessionId, modifiers = {}) => {
      await act(() => {
        rowButton(sessionId).dispatchEvent(pointerEvent(window, 'click', modifiers));
      });
    },
    rightClickRow: async (sessionId) => {
      const event = pointerEvent(window, 'contextmenu');
      await act(() => {
        rowButton(sessionId).dispatchEvent(event);
      });
      // Whether the rail claimed the press. Unclaimed, it goes on to the native
      // menu, which is the whole answer for a row the rail cannot act on.
      return event.defaultPrevented;
    },
    openRowMenu: async (sessionId) => {
      const trigger = document.querySelector(
        `[data-session-id="${sessionId}"] .maka-session-row-action button`,
      );
      assert.ok(trigger, `no row menu trigger for ${sessionId}`);
      await act(() => {
        trigger.dispatchEvent(pointerEvent(window, 'click'));
      });
      // Scoping the reads below to this row is not enough on its own: the items
      // are in the document before any ⋯ is pressed, so an assertion about the
      // menu's wording would pass against a trigger that opens nothing. The
      // menu has to be observably open before this row becomes the one read.
      assert.equal(
        trigger.closest('.maka-session-row-action')?.getAttribute('data-menu-open'),
        'true',
        `⋯ on ${sessionId} did not open a menu`,
      );
      openedMenuRow = sessionId;
    },
    clickMenuItem: async (index) => {
      const item = menuItems()[index];
      assert.ok(item, `no menu item at ${index}`);
      await act(() => {
        item.dispatchEvent(pointerEvent(window, 'click'));
      });
    },
    menuLabels: () => menuItems().map((item) => (item.textContent ?? '').trim()),
    rowDescription: (sessionId) =>
      (
        document.querySelector(`[data-session-id="${sessionId}"] .maka-visually-hidden`)
          ?.textContent ?? ''
      ).trim(),
    hasRowMenu: (sessionId) =>
      document.querySelector(`[data-session-id="${sessionId}"] .maka-session-row-action`) !== null,
    collapseProject: async (projectId) => {
      const group = document.querySelector(`[data-project-id="${projectId}"]`);
      assert.ok(group, `no project row for ${projectId}`);
      const toggle = [...group.querySelectorAll('button')].find(
        (candidate) => candidate.getAttribute('aria-expanded') !== null,
      );
      assert.ok(toggle, `no disclosure on project ${projectId}`);
      await act(() => {
        toggle.dispatchEvent(pointerEvent(window, 'click'));
      });
      assert.equal(toggle.getAttribute('aria-expanded'), 'false', `${projectId} did not collapse`);
    },
    pressEscape: async (focusedSessionId = 'a') => {
      // linkedom has no focus model and reports `activeElement` as null, where a
      // browser reports <body> when nothing is focused — and here a row really
      // is focused, because the user just clicked one. The handler's first
      // guard reads it, so the test has to answer it.
      const focused = rowButton(focusedSessionId);
      return pressEscapeWith(focused);
    },
    pressEscapeInsideRowMenu: async (sessionId) => {
      const item = document.querySelector(`[data-session-id="${sessionId}"] [role="menuitem"]`);
      assert.ok(item, `no menu item under ${sessionId}`);
      return pressEscapeWith(item);
    },
    dispose: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
  };

  async function pressEscapeWith(focused: Element): Promise<boolean> {
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => focused,
    });
    const list = document.querySelector('.maka-session-list');
    assert.ok(list);
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: 'Escape' });
    await act(() => {
      list.dispatchEvent(event);
    });
    // Whether the rail claimed the press. Astryx's layer stack listens on
    // `document` — below this handler in the bubble — and stands down on a
    // press that is already defaultPrevented, so claiming one the rail does not
    // own leaves whatever is above it with no way to close.
    return event.defaultPrevented;
  }
}

test('a plain click opens the task and picks exactly it', async () => {
  const harness = await mount();
  try {
    await harness.clickRow('b');
    assert.deepEqual(harness.opened, ['b']);
    assert.equal(harness.picks.length, 1);
    assert.equal(harness.picks[0]?.pick, 'replace');
    assert.equal(harness.picks[0]?.sessionId, 'b');
  } finally {
    await harness.dispose();
  }
});

test('⌘-click adds a row without opening it', async () => {
  // The whole point of the modifier: the main pane must not move away from the
  // task the user is reading while they build a set beside it.
  const harness = await mount({ selectedIds: ['a'] });
  try {
    await harness.clickRow('c', { metaKey: true });
    assert.deepEqual(harness.opened, []);
    assert.equal(harness.picks[0]?.pick, 'toggle');
    assert.equal(harness.picks[0]?.sessionId, 'c');
  } finally {
    await harness.dispose();
  }
});

test('Ctrl-click is the same gesture, for the platforms that spell it that way', async () => {
  const harness = await mount();
  try {
    await harness.clickRow('c', { ctrlKey: true });
    assert.deepEqual(harness.opened, []);
    assert.equal(harness.picks[0]?.pick, 'toggle');
  } finally {
    await harness.dispose();
  }
});

test('Shift-click asks for a range, and hands over the rendered order', async () => {
  // The order comes off the DOM rather than out of a prop, which is what keeps
  // it right across groups and off the rows entirely (#4109).
  const harness = await mount({ selectedIds: ['a'] });
  try {
    await harness.clickRow('c', { shiftKey: true });
    assert.deepEqual(harness.opened, []);
    assert.equal(harness.picks[0]?.pick, 'range');
    assert.deepEqual(harness.picks[0]?.orderedSessionIds, ['a', 'b', 'c', 'd']);
  } finally {
    await harness.dispose();
  }
});

test('a picked row says so on its ground', async () => {
  const harness = await mount({ selectedIds: ['b', 'c'] });
  try {
    const picked = [...harness.document.querySelectorAll('[data-picked="true"]')].map(
      (row) => (row as HTMLElement).dataset.sessionId,
    );
    assert.deepEqual(picked, ['b', 'c']);
  } finally {
    await harness.dispose();
  }
});

/**
 * The ground says "picked" and `isSelected` says "open", and they are the same
 * ground — so the open row has to spell out which of the two it is doing. Alone
 * in the set it is only open, and "selected" would be a second word for the
 * highlight a screen reader already reads. Inside a run it is one of several,
 * and a reader that never hears so cannot tell what the ⋯ is about to sweep.
 */
test('the open row says it is picked once the set is more than itself', async () => {
  const alone = await mount({ selectedIds: ['b'], activeId: 'b' });
  try {
    assert.equal(alone.rowDescription('b').includes('Selected'), false);
  } finally {
    await alone.dispose();
  }

  const inARun = await mount({ selectedIds: ['b', 'c'], activeId: 'b' });
  try {
    assert.equal(inARun.rowDescription('b').includes('Selected'), true);
    assert.equal(inARun.rowDescription('c').includes('Selected'), true);
  } finally {
    await inARun.dispose();
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
  const sessions = ['a', 'b'].map((id) => summary(id));
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
              sessions,
              groupVariant: 'conversation',
              groups: [{ id: 'recent', label: 'Recent', sessions }],
              onSelectSession: (sessionId) => opened.push(sessionId),
            }}
          >
            <SessionHistoryList />
          </SessionRailProvider>
        </LocaleProvider>,
      ),
    );
    const row = document.querySelector('[data-session-id="b"] button.astryx-side-nav-item');
    assert.ok(row);
    await act(() => {
      row.dispatchEvent(pointerEvent(window, 'click', { metaKey: true }));
    });
    // A modifier with nothing wired up is still a click on a task.
    assert.deepEqual(opened, ['b']);
    assert.equal(document.querySelector('[data-picked="true"]'), null);
  } finally {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
  }
});

test('Escape drops the picks', async () => {
  const harness = await mount({ selectedIds: ['b', 'c'] });
  try {
    await harness.pressEscape();
    assert.equal(harness.clears, 1);
  } finally {
    await harness.dispose();
  }
});

test("Escape with nothing picked is not this handler's business", async () => {
  const harness = await mount();
  try {
    await harness.pressEscape();
    assert.equal(harness.clears, 0);
  } finally {
    await harness.dispose();
  }
});

test('right-clicking a pickable row opens its menu', async () => {
  // The whole point of claiming the press: the row's own ⋯ menu opens, so ⋯ and
  // right-click cannot drift into two lists of items that disagree.
  const harness = await mount({ selectedIds: ['b'] });
  try {
    const prevented = await harness.rightClickRow('b');
    assert.equal(prevented, true);
    assert.equal(
      harness.document
        .querySelector('[data-session-id="b"] .maka-session-row-action')
        ?.getAttribute('data-menu-open'),
      'true',
    );
  } finally {
    await harness.dispose();
  }
});

test('right-clicking a row outside the set replaces it', async () => {
  // A menu is about a set, and one opened on a row the user never picked must
  // not silently be about the rows they did.
  const harness = await mount({ selectedIds: ['a', 'b'] });
  try {
    await harness.rightClickRow('d');
    assert.equal(harness.picks[0]?.pick, 'replace');
    assert.equal(harness.picks[0]?.sessionId, 'd');
    assert.deepEqual(harness.opened, []);
  } finally {
    await harness.dispose();
  }
});

test('right-clicking inside the set keeps it', async () => {
  // A run built by dragging has to survive the gesture that asks what to do
  // with it.
  const harness = await mount({ selectedIds: ['a', 'b'] });
  try {
    await harness.rightClickRow('b');
    assert.deepEqual(harness.picks, []);
    assert.deepEqual(harness.opened, []);
  } finally {
    await harness.dispose();
  }
});

test('clicking ⋯ on a row outside the set replaces it, and never opens the task', async () => {
  const harness = await mount({ selectedIds: ['a'] });
  try {
    await harness.openRowMenu('d');
    assert.deepEqual(harness.opened, []);
    assert.equal(harness.picks[0]?.pick, 'replace');
    assert.equal(harness.picks[0]?.sessionId, 'd');
  } finally {
    await harness.dispose();
  }
});

test('the menu counts the set once more than one row is picked', async () => {
  const harness = await mount({ selectedIds: ['a', 'b', 'c'] });
  try {
    await harness.openRowMenu('b');
    assert.deepEqual(harness.menuLabels(), ['Pin 3 tasks', 'Archive 3 tasks']);
    await harness.clickMenuItem(1);
    assert.equal(harness.archives, 1);
  } finally {
    await harness.dispose();
  }
});

test('the menu is about the one row when only that row is picked', async () => {
  const harness = await mount({ selectedIds: ['b'] });
  try {
    await harness.openRowMenu('b');
    assert.deepEqual(harness.menuLabels(), ['Pin', 'Rename', 'Archive']);
  } finally {
    await harness.dispose();
  }
});

test('a set that is pinned throughout offers to unpin it', async () => {
  // Every row pinned means the verb unpins; a mixed set pins. Without that rule
  // one label would mean something different for each row under it.
  const harness = await mount({
    sessions: [summary('a', { isFlagged: true }), summary('b', { isFlagged: true }), summary('c')],
    selectedIds: ['a', 'b'],
  });
  try {
    await harness.openRowMenu('a');
    assert.deepEqual(harness.menuLabels(), ['Unpin 2 tasks', 'Archive 2 tasks']);
    await harness.clickMenuItem(0);
    assert.deepEqual(harness.flags, [false]);
  } finally {
    await harness.dispose();
  }
});

test('a mixed set pins, including the rows already pinned', async () => {
  const harness = await mount({
    sessions: [summary('a', { isFlagged: true }), summary('b'), summary('c')],
    selectedIds: ['a', 'b'],
  });
  try {
    await harness.openRowMenu('a');
    assert.deepEqual(harness.menuLabels(), ['Pin 2 tasks', 'Archive 2 tasks']);
    await harness.clickMenuItem(0);
    assert.deepEqual(harness.flags, [true]);
  } finally {
    await harness.dispose();
  }
});

/**
 * A project group collapses by grid track — `SideNavItem` keeps the rows
 * mounted and marks the subtree `inert` — so the rail renders more rows than
 * the user can see. What a range may cross is the visible ones.
 */
test('a Shift range does not reach into a collapsed project', async () => {
  const project = (id: string) => ({
    id,
    name: id,
    path: `/${id}`,
    createdAt: 1,
    updatedAt: 1,
    available: true,
    locations: [],
  });
  const sessions = ['a1', 'a2', 'b1', 'b2', 'b3', 'c1'].map((id) => summary(id));
  const harness = await mount({
    sessions,
    selectedIds: ['a1'],
    groupVariant: 'project',
    groups: [
      { id: 'pA', label: 'A', project: project('pA'), sessions: sessions.slice(0, 2) },
      { id: 'pB', label: 'B', project: project('pB'), sessions: sessions.slice(2, 5) },
      { id: 'pC', label: 'C', project: project('pC'), sessions: sessions.slice(5) },
    ],
  });
  try {
    await harness.collapseProject('pB');
    await harness.clickRow('c1', { shiftKey: true });
    assert.equal(harness.picks[0]?.pick, 'range');
    // Not a1..c1 across all six. B's rows are still in the document; they are
    // just not on screen, and a set the user cannot see is a set they cannot
    // check before the menu acts on it.
    assert.deepEqual(harness.picks[0]?.orderedSessionIds, ['a1', 'a2', 'c1']);
  } finally {
    await harness.dispose();
  }
});

/**
 * The other half of the same rule, at the other end of the gesture. A menu is
 * the one entrance to the sweeps, so opening one fixes the set at the rows on
 * screen: a pick that has been folded away leaves it there and does not come
 * back. Narrowing here rather than at the collapse itself is not a softer rule
 * — it is the only place the rail holds both the set and the DOM that knows
 * which rows are showing.
 */
test('a menu sweeps only the picked rows still on screen', async () => {
  const project = (id: string) => ({
    id,
    name: id,
    path: `/${id}`,
    createdAt: 1,
    updatedAt: 1,
    available: true,
    locations: [],
  });
  const sessions = ['a1', 'a2', 'b1', 'b2'].map((id) => summary(id));
  const harness = await mount({
    sessions,
    selectedIds: ['a1', 'b1'],
    groupVariant: 'project',
    groups: [
      { id: 'pA', label: 'A', project: project('pA'), sessions: sessions.slice(0, 2) },
      { id: 'pB', label: 'B', project: project('pB'), sessions: sessions.slice(2) },
    ],
  });
  try {
    await harness.collapseProject('pB');
    await harness.openRowMenu('a1');
    // b1 is still mounted, but it is not among the rows the menu was handed —
    // so it leaves the set here, and stays out of it.
    assert.deepEqual(harness.retains.at(-1), ['a1', 'a2']);
    // And the menu says so: one row, with the single-row wording.
    assert.deepEqual(harness.menuLabels(), ['Pin', 'Rename', 'Archive']);
  } finally {
    await harness.dispose();
  }
});

/**
 * A session shared from someone else's Host is projected read-only: the rail
 * hands its row no actions. A row with nothing that can be done to it has no
 * business in a set whose only purpose is to be acted on.
 */
test('a shared row is not picked, and is still a plain navigation item', async () => {
  const shared = { ...summary('shared'), shared: true } as SessionSummary;
  const harness = await mount({ sessions: [summary('a'), shared, summary('c')] });
  try {
    assert.equal(harness.hasRowMenu('shared'), false);

    await harness.clickRow('shared', { metaKey: true });
    assert.equal(harness.picks.length, 0);
    // Not a dead click: with no set to join, the modifier means nothing and the
    // row does what it has always done.
    assert.deepEqual(harness.opened, ['shared']);

    await harness.clickRow('c', { shiftKey: true });
    assert.deepEqual(harness.picks.at(-1)?.orderedSessionIds, ['a', 'c']);
  } finally {
    await harness.dispose();
  }
});

test('right-clicking a shared row leaves the press, and the set, alone', async () => {
  const shared = { ...summary('shared'), shared: true } as SessionSummary;
  const harness = await mount({
    sessions: [summary('a'), shared, summary('c')],
    selectedIds: ['a', 'c'],
  });
  try {
    const prevented = await harness.rightClickRow('shared');
    // Claiming it would take the native menu away and open nothing in its
    // place, and adopting the row would discard the set on the way.
    assert.equal(prevented, false);
    assert.equal(harness.picks.length, 0);
  } finally {
    await harness.dispose();
  }
});

/**
 * Escape belongs to whatever is on top. An open menu — and the rename dialog
 * built on the same layer stack — is above the rail and owns the press, and the
 * stack stands down on one that is already defaultPrevented: a rail that
 * claimed it would clear the set AND leave the layer with no way to close.
 */
test('Escape inside a layer above the rail is not the rail\'s to take', async () => {
  const harness = await mount({ selectedIds: ['a', 'b'] });
  try {
    const prevented = await harness.pressEscapeInsideRowMenu('a');
    assert.equal(prevented, false);
    assert.equal(harness.clears, 0);
  } finally {
    await harness.dispose();
  }
});
