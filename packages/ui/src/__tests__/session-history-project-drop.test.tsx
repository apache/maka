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
 * Dragging a task onto a row is the second way to re-file it, beside the row
 * menu. What matters is which pairs a drop can produce, so these cases drive
 * real drag events rather than asserting `draggable`, which says nothing about
 * what a drop does.
 *
 * The shell answers two questions, and both are exercised here: which rows may
 * receive a task at all (`moveDropGroupKeys`, the static half the window's drop
 * guard reads through the DOM marker) and where one Session may go
 * (`moveTargets`, the per-drag half that decides the drop).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';
import { LocaleProvider } from '../locale-context.js';
import { SessionHistoryList, type SessionRowActions } from '../session-history-list.js';
import {
  SessionRailProvider,
  type SessionMoveTarget,
  type SessionRailData,
} from '../session-rail-context.js';

/** Mirrors the module-private MIME the rail advertises for a task drag. */
const SESSION_DRAG_MIME = 'application/x-maka-session';

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

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: id,
    locations: [{ path: `/${id}`, isWorktree: false }],
    available: true,
    preferredPath: `/${id}`,
    ...overrides,
  };
}

/** The smallest `DataTransfer` the handlers read, shared across one gesture. */
function transfer(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    types: [...store.keys()],
    effectAllowed: '',
    dropEffect: '',
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? '',
  };
}

function dragEvent(
  window: ReturnType<typeof parseHTML>['window'],
  type: string,
  dataTransfer: ReturnType<typeof transfer>,
): Event {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  return event;
}

type MoveAnswer = (sessionId: string) => readonly SessionMoveTarget[];

async function mountRail(
  groups: SessionRailData['groups'],
  rows: SessionSummary[],
  options: { moveDropGroupKeys?: ReadonlySet<string>; moveTargets?: MoveAnswer } = {},
) {
  const original = { document: globalThis.document, window: globalThis.window };
  const { document, window } = parseHTML('<div id="root"></div>');
  installDomStubs(window);
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  const moves: Array<{ sessionId: string; projectId: string | null }> = [];
  const rowActions: SessionRowActions = {
    onToggleFlag: () => undefined,
    onArchive: () => undefined,
    onUnarchive: () => undefined,
    onRename: () => undefined,
    onMoveToProject: (sessionId, projectId) => {
      moves.push({ sessionId, projectId });
    },
  };
  const data: SessionRailData = {
    sessions: rows,
    groupVariant: 'project',
    groups,
    onSelectSession: () => undefined,
    rowActions,
    ...(options.moveDropGroupKeys ? { moveDropGroupKeys: options.moveDropGroupKeys } : {}),
    ...(options.moveTargets ? { moveTargets: options.moveTargets } : {}),
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
    document,
    moves,
    sessionRow: (sessionId: string) => {
      const node = document.querySelector(`[data-session-id="${sessionId}"]`);
      assert.ok(node, `no row for ${sessionId}`);
      return node;
    },
    /** A row the shell marked as a possible destination. */
    projectRow: (projectId: string) => {
      const node = document.querySelector(`[data-project-id="${projectId}"]`);
      assert.ok(node, `no project row for ${projectId}`);
      // The BrowserWindow capture guard must let these drops reach React.
      assert.equal(node.getAttribute('data-maka-session-drop-target'), 'true');
      return node;
    },
    /** The same row, for the cases where it must NOT be a drop target. */
    projectRowNode: (projectId: string) => {
      const node = document.querySelector(`[data-project-id="${projectId}"]`);
      assert.ok(node, `no project row for ${projectId}`);
      return node;
    },
    /** The browser fires this on every real drag; the list relies on it. */
    endDrag: async (sessionId: string) => {
      await act(() => {
        document
          .querySelector(`[data-session-id="${sessionId}"]`)
          ?.dispatchEvent(dragEvent(window, 'dragend', transfer()));
      });
    },
    dispose: async () => {
      await act(() => root.unmount());
      Object.assign(globalThis, original);
    },
  };
}

const alphaOnly: MoveAnswer = () => [{ groupKey: 'pA', projectId: 'pA', name: 'Alpha' }];

test('dropping a task on a project row re-files it under that project', async () => {
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [{ id: 'pA', label: 'Alpha', project: project('pA'), sessions }],
    sessions,
    { moveDropGroupKeys: new Set(['pA']), moveTargets: alphaOnly },
  );
  try {
    const dragging = transfer();
    await act(() => {
      rail.sessionRow('s1').dispatchEvent(dragEvent(rail.window, 'dragstart', dragging));
    });
    assert.equal(dragging.getData(SESSION_DRAG_MIME), 's1');

    await act(() => {
      rail.projectRow('pA').dispatchEvent(dragEvent(rail.window, 'dragover', dragging));
    });
    assert.equal(
      rail.projectRowNode('pA').getAttribute('data-drop-target'),
      'true',
      'the row under the drag should read as the target',
    );
    await act(() => {
      rail.projectRow('pA').dispatchEvent(dragEvent(rail.window, 'drop', dragging));
    });

    assert.deepEqual(rail.moves, [{ sessionId: 's1', projectId: 'pA' }]);
    await rail.endDrag('s1');
  } finally {
    await rail.dispose();
  }
});

test('dropping a task on the row that leaves every project clears its project', async () => {
  const sessions = [summary('s1', { projectId: 'pA' })];
  const rail = await mountRail(
    [
      { id: 'pA', label: 'Alpha', project: project('pA'), sessions },
      { id: '__ungrouped__:local', label: 'No project · Local', sessions: [] },
    ],
    sessions,
    {
      moveDropGroupKeys: new Set(['pA', '__ungrouped__:local']),
      moveTargets: () => [{ groupKey: '__ungrouped__:local', projectId: null, name: 'No project' }],
    },
  );
  try {
    const dragging = transfer();
    await act(() => {
      rail.sessionRow('s1').dispatchEvent(dragEvent(rail.window, 'dragstart', dragging));
    });
    await act(() => {
      rail
        .projectRow('__ungrouped__:local')
        .dispatchEvent(dragEvent(rail.window, 'dragover', dragging));
    });
    await act(() => {
      rail
        .projectRow('__ungrouped__:local')
        .dispatchEvent(dragEvent(rail.window, 'drop', dragging));
    });

    assert.deepEqual(rail.moves, [{ sessionId: 's1', projectId: null }]);
    await rail.endDrag('s1');
  } finally {
    await rail.dispose();
  }
});

test('a task can be dropped on a project that has no tasks yet', async () => {
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [
      { id: 'pA', label: 'Alpha', project: project('pA'), sessions },
      { id: 'pB', label: 'Beta', project: project('pB'), sessions: [] },
    ],
    sessions,
    {
      moveDropGroupKeys: new Set(['pA', 'pB']),
      moveTargets: () => [{ groupKey: 'pB', projectId: 'pB', name: 'Beta' }],
    },
  );
  try {
    const dragging = transfer();
    await act(() => {
      rail.sessionRow('s1').dispatchEvent(dragEvent(rail.window, 'dragstart', dragging));
    });
    await act(() => {
      rail.projectRow('pB').dispatchEvent(dragEvent(rail.window, 'dragover', dragging));
    });
    await act(() => {
      rail.projectRow('pB').dispatchEvent(dragEvent(rail.window, 'drop', dragging));
    });

    assert.deepEqual(rail.moves, [{ sessionId: 's1', projectId: 'pB' }]);
    await rail.endDrag('s1');
  } finally {
    await rail.dispose();
  }
});

test('the row marks its own button as the drag source', async () => {
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [{ id: 'pA', label: 'Alpha', project: project('pA'), sessions }],
    sessions,
    { moveDropGroupKeys: new Set(['pA']), moveTargets: alphaOnly },
  );
  try {
    // Chromium will not start a drag from a button, and the row IS one, so the
    // wrapper's `draggable` alone would never be reached.
    const button = rail.document.querySelector(
      '[data-session-id="s1"] button.astryx-side-nav-item',
    );
    assert.ok(button, 'no row button');
    assert.equal(button.getAttribute('draggable'), 'true');
  } finally {
    await rail.dispose();
  }
});

test('a row the shell does not offer is not a drop target', async () => {
  // What a Runtime Host header, an unavailable project and a project whose
  // session lives elsewhere have in common: the shell leaves them out, so the
  // row carries no marker and the window guard blocks the drop before React.
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [
      { id: 'pA', label: 'Alpha', project: project('pA'), sessions },
      { id: 'runtime-host:remote', label: 'Remote', sessions: [] },
    ],
    sessions,
    { moveDropGroupKeys: new Set(['pA']), moveTargets: alphaOnly },
  );
  try {
    assert.equal(
      rail
        .projectRowNode('runtime-host:remote')
        .getAttribute('data-maka-session-drop-target'),
      null,
    );

    const dragging = transfer();
    await act(() => {
      rail.sessionRow('s1').dispatchEvent(dragEvent(rail.window, 'dragstart', dragging));
    });
    await act(() => {
      rail
        .projectRowNode('runtime-host:remote')
        .dispatchEvent(dragEvent(rail.window, 'dragover', dragging));
    });
    await act(() => {
      rail
        .projectRowNode('runtime-host:remote')
        .dispatchEvent(dragEvent(rail.window, 'drop', dragging));
    });

    assert.deepEqual(rail.moves, []);
    await rail.endDrag('s1');
  } finally {
    await rail.dispose();
  }
});

test('a row that is not one of this task’s destinations refuses the drop', async () => {
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [
      { id: 'pA', label: 'Alpha', project: project('pA'), sessions },
      { id: 'pB', label: 'Beta', project: project('pB'), sessions: [] },
    ],
    sessions,
    // pB is a potential destination for some task, but not for this one.
    { moveDropGroupKeys: new Set(['pA', 'pB']), moveTargets: alphaOnly },
  );
  try {
    const dragging = transfer();
    await act(() => {
      rail.sessionRow('s1').dispatchEvent(dragEvent(rail.window, 'dragstart', dragging));
    });
    await act(() => {
      rail.projectRow('pB').dispatchEvent(dragEvent(rail.window, 'dragover', dragging));
    });
    await act(() => {
      rail.projectRow('pB').dispatchEvent(dragEvent(rail.window, 'drop', dragging));
    });

    assert.deepEqual(rail.moves, []);
    await rail.endDrag('s1');
  } finally {
    await rail.dispose();
  }
});

test('a drag that is not one of our tasks is refused', async () => {
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [{ id: 'pA', label: 'Alpha', project: project('pA'), sessions }],
    sessions,
    { moveDropGroupKeys: new Set(['pA']), moveTargets: alphaOnly },
  );
  try {
    // A file or text drag the OS hands the window carries none of our payload,
    // and no task of ours is in the air.
    const foreign = transfer({ 'text/plain': 'C:\\photo.png' });
    await act(() => {
      rail.projectRow('pA').dispatchEvent(dragEvent(rail.window, 'dragover', foreign));
    });
    await act(() => {
      rail.projectRow('pA').dispatchEvent(dragEvent(rail.window, 'drop', foreign));
    });

    assert.deepEqual(rail.moves, []);
  } finally {
    await rail.dispose();
  }
});

test('a task with nowhere to go is neither draggable nor offered a menu', async () => {
  const sessions = [summary('s1')];
  const rail = await mountRail(
    [{ id: 'pA', label: 'Alpha', project: project('pA'), sessions }],
    sessions,
    { moveDropGroupKeys: new Set(['pA']), moveTargets: () => [] },
  );
  try {
    assert.equal(rail.sessionRow('s1').getAttribute('draggable'), null);
    assert.equal(
      rail
        .sessionRow('s1')
        .querySelector('button.astryx-side-nav-item')
        ?.getAttribute('draggable'),
      null,
    );
  } finally {
    await rail.dispose();
  }
});
