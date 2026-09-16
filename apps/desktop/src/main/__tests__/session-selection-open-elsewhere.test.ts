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
 * ⌘K, the Module Hub and 新建任务 open a task without going through a row, so
 * the rail hears about it only as a new active id. The picked ground and the
 * open ground are the same ground, so a set left over from the task the user
 * walked away from would read as a set around the one they are now reading —
 * and the next ⋯ would sweep it.
 *
 * These drive the real hook rather than the reducer: what has to hold is that
 * the open task and the picked set agree, and only the hook holds both.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { SessionSummary } from '@maka/core/session';
import type { SessionRailSelection } from '@maka/ui';
import { useSessionSelection } from '../../renderer/features/session-navigation/testing.js';
import type { SessionNavigationRowActions } from '../../renderer/features/session-navigation/testing.js';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

let mountedRoot: Root | undefined;

afterEach(async () => {
  if (mountedRoot) await act(() => mountedRoot?.unmount());
  mountedRoot = undefined;
  Object.assign(globalThis, originalGlobals);
});

const ORDER = ['a', 'b', 'c'];

function summary(id: string): SessionSummary {
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
  };
}

/** A ⌘-click on a row, which is how a set is built without opening anything. */
function toggle(selection: SessionRailSelection, sessionId: string): void {
  selection.commands.pick({ sessionId, pick: 'toggle', orderedSessionIds: ORDER });
}

async function mountSelection(openId: string): Promise<{
  latest(): SessionRailSelection;
  /** A task opened from outside the rail: a new active id, and nothing else. */
  open(sessionId: string): Promise<void>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  const commands = {} as unknown as SessionNavigationRowActions;
  let latest: SessionRailSelection | undefined;
  let setActiveId: ((sessionId: string) => void) | undefined;
  function Probe(): ReactNode {
    const [activeId, setActive] = useState(openId);
    setActiveId = setActive;
    latest = useSessionSelection({ sessions: ORDER.map(summary), commands, activeId });
    return null;
  }

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  await act(() => root.render(createElement(Probe)));
  return {
    latest: () => {
      assert.ok(latest);
      return latest;
    },
    open: async (sessionId) => {
      await act(() => {
        setActiveId?.(sessionId);
      });
    },
  };
}

test('opening a task the set does not hold drops the picks', async () => {
  const probe = await mountSelection('a');
  await act(() => toggle(probe.latest(), 'a'));
  await act(() => toggle(probe.latest(), 'b'));
  assert.deepEqual([...probe.latest().selectedIds].sort(), ['a', 'b']);

  // ⌘K opens C. Nothing in the rail was clicked.
  await probe.open('c');

  // Empty, not {c}: the rail paints the open row regardless, so an empty set
  // already reads as "just this row".
  assert.deepEqual([...probe.latest().selectedIds], []);
});

test('opening a task the set already holds leaves it alone', async () => {
  // ⌘K again, and again nothing in the rail was clicked — the contrast with the
  // test above is the membership, not the way the task was opened. Every row on
  // the picked ground is still genuinely picked, so there is nothing to drop.
  // A plain click inside the rail lands here too, having already replaced the
  // set with the row it opened by the time the active id moves.
  const probe = await mountSelection('a');
  await act(() => toggle(probe.latest(), 'a'));
  await act(() => toggle(probe.latest(), 'b'));

  await probe.open('b');

  assert.deepEqual([...probe.latest().selectedIds].sort(), ['a', 'b']);
});
