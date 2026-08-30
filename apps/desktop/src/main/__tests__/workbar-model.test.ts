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
import { afterEach, describe, it } from 'node:test';
import {
  createSessionWorkbarPanelsState,
  createSessionWorkbarTabsState,
  loadWorkbarLayout,
  persistWorkbarLayout,
  persistableSessionWorkbarPanels,
  readSessionWorkbarPanels,
  reduceWorkbarLayout,
  reduceWorkbarPanels,
  SESSION_BOTTOM_PANEL_MAX_HEIGHT,
  SESSION_WORKBAR_MIN_WIDTH,
  terminalSessionWorkbarTabId,
  WORKBAR_TOOL_DEFINITIONS,
} from '../../renderer/features/workbar/testing.js';

function installMemoryLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const memory: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: memory,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };
}

describe('Workbar topology', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('routes every topology change through the pure reducer', () => {
    let state = createSessionWorkbarPanelsState();
    state = reduceWorkbarPanels(state, {
      type: 'open',
      placement: 'right',
      tab: { id: 'workbar:review', kind: 'review' },
    });
    state = reduceWorkbarPanels(state, {
      type: 'open',
      placement: 'right',
      tab: { id: 'workbar:tasks', kind: 'tasks' },
    });
    state = reduceWorkbarPanels(state, {
      type: 'move-to-panel',
      tabId: 'workbar:tasks',
      target: 'bottom',
    });
    assert.deepEqual(state.right.tabs.map((tab) => tab.id), ['workbar:review']);
    assert.deepEqual(state.bottom.tabs.map((tab) => tab.id), ['workbar:tasks']);
    assert.equal(state.focusedPanel, 'bottom');
  });

  it('routes panel visibility and dimensions through the layout reducer', () => {
    let state = {
      panels: createSessionWorkbarPanelsState(),
      rightCollapsed: true,
      bottomOpen: false,
      rightWidth: 480,
      bottomHeight: 300,
    };
    state = reduceWorkbarLayout(state, {
      type: 'open',
      placement: 'right',
      tab: { id: 'workbar:review', kind: 'review' },
    });
    assert.equal(state.rightCollapsed, false);
    state = reduceWorkbarLayout(state, {
      type: 'resize',
      placement: 'right',
      size: 12,
    });
    assert.equal(state.rightWidth, SESSION_WORKBAR_MIN_WIDTH);
    state = reduceWorkbarLayout(state, {
      type: 'open',
      placement: 'bottom',
      tab: { id: 'workbar:tasks', kind: 'tasks' },
    });
    assert.equal(state.bottomOpen, true);
    state = reduceWorkbarLayout(state, {
      type: 'resize',
      placement: 'bottom',
      size: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(state.bottomHeight, SESSION_BOTTOM_PANEL_MAX_HEIGHT);
    state = reduceWorkbarLayout(state, {
      type: 'close',
      placement: 'bottom',
      tabIds: ['workbar:tasks'],
    });
    assert.equal(state.bottomOpen, false);
  });

  it('keeps static tabs and removes dynamic metadata from persistence', () => {
    const terminalRef = 'run:1';
    const state = createSessionWorkbarPanelsState(
      createSessionWorkbarTabsState([
        { id: 'workbar:review', kind: 'review', title: 'ignored' },
        {
          id: terminalSessionWorkbarTabId(terminalRef),
          kind: 'terminal',
          resourceRef: terminalRef,
          ownerSessionId: 'session-a',
        },
        { id: 'side-chat:panel-a', kind: 'side-chat', ordinal: 2 },
        { id: 'workbar:files', kind: 'files', preview: true },
      ]),
    );
    assert.deepEqual(persistableSessionWorkbarPanels(state).right.tabs, [
      { id: 'workbar:review', kind: 'review' },
    ]);
  });

  it('uses the tool registry as the persistence authority', () => {
    const state = createSessionWorkbarPanelsState(
      createSessionWorkbarTabsState(
        WORKBAR_TOOL_DEFINITIONS.map((definition) => ({
          id: `fixture:${definition.kind}`,
          kind: definition.kind,
        })),
      ),
    );

    assert.deepEqual(
      persistableSessionWorkbarPanels(state).right.tabs.map(
        (tab) => tab.kind,
      ),
      WORKBAR_TOOL_DEFINITIONS.filter(
        (definition) => definition.persisted,
      ).map((definition) => definition.kind),
    );
  });

  it('ignores workbar storage from versions outside the support window', () => {
    cleanups.push(
      installMemoryLocalStorage({
        'maka-session-workbar-tabs-v2': JSON.stringify({
          version: 2,
          tabs: [
            { id: 'workbar:review', kind: 'review' },
            { id: 'workbar:terminal', kind: 'terminal' },
          ],
          activeTabId: 'workbar:review',
        }),
        'maka-session-workbar-tab-v1': 'browser',
      }),
    );
    assert.deepEqual(readSessionWorkbarPanels(), createSessionWorkbarPanelsState());
  });

  it('round-trips v3 layout while filtering transient tab data', () => {
    cleanups.push(installMemoryLocalStorage());
    const layout = {
      panels: createSessionWorkbarPanelsState(
        createSessionWorkbarTabsState(
          [
            { id: 'workbar:review', kind: 'review', title: 'transient title' },
            {
              id: terminalSessionWorkbarTabId('run:round-trip'),
              kind: 'terminal',
              resourceRef: 'run:round-trip',
              ownerSessionId: 'session-a',
            },
            { id: 'workbar:files', kind: 'files', preview: true },
          ],
          'workbar:review',
        ),
      ),
      rightCollapsed: false,
      bottomOpen: true,
      rightWidth: 544,
      bottomHeight: 388,
    };
    persistWorkbarLayout(layout);
    assert.deepEqual(
      JSON.parse(localStorage.getItem('maka-session-workbar-panels-v3') ?? ''),
      {
        version: 3,
        right: {
          version: 2,
          tabs: [{ id: 'workbar:review', kind: 'review' }],
          activeTabId: 'workbar:review',
        },
        bottom: { version: 2, tabs: [], activeTabId: null },
        focusedPanel: 'right',
      },
    );
    assert.deepEqual(loadWorkbarLayout(), {
      panels: createSessionWorkbarPanelsState(
        createSessionWorkbarTabsState(
          [{ id: 'workbar:review', kind: 'review' }],
          'workbar:review',
        ),
      ),
      rightCollapsed: false,
      bottomOpen: true,
      rightWidth: 544,
      bottomHeight: 388,
    });
  });

  it('falls back to an empty topology for corrupt v3 storage', () => {
    cleanups.push(
      installMemoryLocalStorage({
        'maka-session-workbar-panels-v3': '{not-json',
      }),
    );
    assert.deepEqual(readSessionWorkbarPanels(), createSessionWorkbarPanelsState());
  });
});
