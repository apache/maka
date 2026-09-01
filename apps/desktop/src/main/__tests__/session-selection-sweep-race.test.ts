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
 * `Done` stays enabled while a sweep runs — leaving asks nothing of the Host —
 * so a person can leave the selection, re-enter it from another row's menu, and
 * mark a different task before the first request settles. What the sweep
 * unmarks on completion has to be the set it asked about, not whatever happens
 * to be marked when it lands.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
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

test('a settled sweep unmarks what it asked about, not what is marked now', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  let releaseArchive: (() => void) | undefined;
  const archived: string[][] = [];
  const commands = {
    archiveSelected: (sessionIds: readonly string[]) => {
      archived.push([...sessionIds]);
      return new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
    },
    deleteSelected: async () => undefined,
  } as unknown as SessionNavigationRowActions;

  let latest: SessionRailSelection | undefined;
  function Probe(): ReactNode {
    const { selection } = useSessionSelection({
      sessions: [summary('a'), summary('b')],
      commands,
    });
    latest = selection;
    return null;
  }

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  await act(() => root.render(createElement(Probe)));
  assert.ok(latest);

  // Mark A and start the sweep. It does not settle yet.
  await act(() => latest?.onEnter('a'));
  await act(() => {
    void latest?.onArchiveSelected();
  });
  assert.deepEqual(archived, [['a']]);

  // Leave the mode and come back on a different row, exactly as the rail
  // allows while a sweep is in flight.
  await act(() => latest?.onExit());
  await act(() => latest?.onEnter('b'));
  assert.deepEqual([...(latest?.selectedIds ?? [])], ['b']);

  // Now the first request lands.
  await act(async () => {
    releaseArchive?.();
    await Promise.resolve();
  });

  // B survives. Clearing the whole set here would answer A's completion by
  // discarding a selection the user made afterwards and never submitted.
  assert.deepEqual([...(latest?.selectedIds ?? [])], ['b']);
  assert.equal(latest?.active, true);
});

test('a settled sweep does unmark its own set when nothing else happened', async () => {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

  let releaseArchive: (() => void) | undefined;
  const commands = {
    archiveSelected: () =>
      new Promise<void>((resolve) => {
        releaseArchive = resolve;
      }),
    deleteSelected: async () => undefined,
  } as unknown as SessionNavigationRowActions;

  let latest: SessionRailSelection | undefined;
  function Probe(): ReactNode {
    const { selection } = useSessionSelection({
      sessions: [summary('a'), summary('b')],
      commands,
    });
    latest = selection;
    return null;
  }

  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoot = root;
  await act(() => root.render(createElement(Probe)));

  await act(() => latest?.onEnter('a'));
  await act(() => {
    void latest?.onArchiveSelected();
  });
  await act(async () => {
    releaseArchive?.();
    await Promise.resolve();
  });

  assert.deepEqual([...(latest?.selectedIds ?? [])], []);
  // The mode stays on: the person was tidying up, and taking the checkboxes
  // away after each sweep would make them re-enter for the next one.
  assert.equal(latest?.active, true);
});
