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
 * Nothing blocks the rail while a sweep is with the Host — there is no mode to
 * be held in — so a person can go on picking rows before the first request
 * settles.
 *
 * The selection follows the CATALOG, and nothing else: rows leave the set by
 * leaving the rail. A sweep that also unmarked what it swept would be that rule
 * stated twice — right for archive, which removes the rows, and wrong for pin,
 * which leaves them exactly where they are. So these cases drive the catalog,
 * not just the hook: a fixture whose session list never changes cannot tell the
 * two apart.
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

const ORDER = ['a', 'b'];

/** A ⌘-click on a row, which is how a set is built without opening anything. */
function toggle(selection: SessionRailSelection | undefined, sessionId: string): void {
  selection?.commands.pick({ sessionId, pick: 'toggle', orderedSessionIds: ORDER });
}

async function mountSelection(commands: SessionNavigationRowActions): Promise<{
  latest(): SessionRailSelection;
  /** What the rail lists, as a refresh would leave it. */
  relist(sessionIds: readonly string[]): Promise<void>;
}> {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  let latest: SessionRailSelection | undefined;
  let listed: readonly string[] = ORDER;
  let rerender: (() => void) | undefined;
  function Probe(): ReactNode {
    const [, bump] = useState(0);
    rerender = () => bump((count) => count + 1);
    latest = useSessionSelection({ sessions: listed.map(summary), commands });
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
    relist: async (sessionIds) => {
      listed = sessionIds;
      await act(async () => {
        rerender?.();
      });
    },
  };
}

test('an archive drops its rows by way of the catalog, keeping later picks', async () => {
  let releaseArchive: (() => void) | undefined;
  const archived: string[][] = [];
  const commands = {
    archiveSelected: (sessionIds: readonly string[]) => {
      archived.push([...sessionIds]);
      return new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
    },
  } as unknown as SessionNavigationRowActions;

  const probe = await mountSelection(commands);

  // Pick A and start the sweep. It does not settle yet.
  await act(() => toggle(probe.latest(), 'a'));
  await act(() => {
    void probe.latest().commands.archiveSelected();
  });
  assert.deepEqual(archived, [['a']]);

  // Go on picking, exactly as the rail allows while a sweep is in flight.
  await act(() => toggle(probe.latest(), 'b'));
  assert.deepEqual([...probe.latest().selectedIds].sort(), ['a', 'b']);

  // The request lands, and the refresh it awaited takes A off the rail.
  await act(async () => {
    releaseArchive?.();
    await Promise.resolve();
  });
  await probe.relist(['b']);

  // B survives. Answering A's completion by clearing the set would discard a
  // pick the user made afterwards and never submitted.
  assert.deepEqual([...probe.latest().selectedIds], ['b']);
});

test('a pin sweep leaves the set exactly as it was', async () => {
  // Pinning does not remove a row, it moves it into the pinned group. A set
  // that emptied itself here would make "pin these, then archive them" two
  // selections instead of one, which is the whole point of holding a set.
  const asked: Array<{ sessionIds: string[]; flagged: boolean }> = [];
  const commands = {
    flagSelected: async (sessionIds: readonly string[], flagged: boolean) => {
      asked.push({ sessionIds: [...sessionIds], flagged });
    },
  } as unknown as SessionNavigationRowActions;

  const probe = await mountSelection(commands);
  await act(() => toggle(probe.latest(), 'a'));
  await act(() => toggle(probe.latest(), 'b'));
  await act(async () => {
    await probe.latest().commands.flagSelected(true);
  });

  assert.deepEqual(asked, [{ sessionIds: ['a', 'b'], flagged: true }]);
  assert.deepEqual([...probe.latest().selectedIds].sort(), ['a', 'b']);
});

test('a second sweep is refused while the first is still out', async () => {
  // Two archive requests over overlapping sets would report two counts for one
  // set of tasks, and the second would name rows the first has already taken.
  let releaseArchive: (() => void) | undefined;
  const asked: string[][] = [];
  const commands = {
    archiveSelected: (sessionIds: readonly string[]) => {
      asked.push([...sessionIds]);
      return new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
    },
  } as unknown as SessionNavigationRowActions;

  const probe = await mountSelection(commands);
  await act(() => toggle(probe.latest(), 'a'));
  await act(() => {
    void probe.latest().commands.archiveSelected();
  });
  await act(() => {
    void probe.latest().commands.archiveSelected();
  });
  assert.deepEqual(asked, [['a']]);

  await act(async () => {
    releaseArchive?.();
    await Promise.resolve();
  });
  await probe.relist(['b']);
  assert.deepEqual([...probe.latest().selectedIds], []);
});

test('a sweep over nothing asks nothing', async () => {
  const asked: string[][] = [];
  const commands = {
    flagSelected: async (sessionIds: readonly string[]) => {
      asked.push([...sessionIds]);
    },
  } as unknown as SessionNavigationRowActions;

  const probe = await mountSelection(commands);
  await act(async () => {
    await probe.latest().commands.flagSelected(true);
  });
  assert.deepEqual(asked, []);
});
