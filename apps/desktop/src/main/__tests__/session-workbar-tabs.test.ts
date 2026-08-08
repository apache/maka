import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  activateSessionWorkbarTab,
  closeSessionWorkbarTab,
  closeSessionWorkbarTabs,
  createSessionWorkbarPanelsState,
  createSessionWorkbarTabsState,
  findPreferredSideChatWorkbarTab,
  findSessionWorkbarTabPlacement,
  moveSessionWorkbarTab,
  moveSessionWorkbarTabToPanel,
  openSessionWorkbarPanelTab,
  openSessionWorkbarLauncher,
  openSessionWorkbarTab,
  openStaticSessionWorkbarTab,
  pinSessionWorkbarPanelTab,
  pinSessionWorkbarTab,
  persistableSessionWorkbarTabs,
  persistableSessionWorkbarPanels,
  readSessionWorkbarPanels,
  readSessionWorkbarTabs,
  reconcileSessionWorkbarTabs,
  reorderSessionWorkbarTab,
  sessionWorkbarTabsExcept,
  sessionWorkbarTabsToRight,
  staticSessionWorkbarTabId,
  terminalRefFromWorkbarTab,
  terminalSessionWorkbarTabId,
  titleSessionWorkbarPanelTab,
  titleSessionWorkbarTab,
} from '../../renderer/session-workbar-tabs.js';

describe('session workbar tab controller', () => {
  it('opens dynamic tabs and activating an existing id does not duplicate it', () => {
    let state = createSessionWorkbarTabsState();
    state = openStaticSessionWorkbarTab(state, 'review');
    state = openStaticSessionWorkbarTab(state, 'terminal');
    state = openStaticSessionWorkbarTab(state, 'tasks');
    state = openStaticSessionWorkbarTab(state, 'files');
    state = openStaticSessionWorkbarTab(state, 'tasks');

    assert.deepEqual(
      state.tabs.map((tab) => tab.id),
      [
        staticSessionWorkbarTabId('review'),
        staticSessionWorkbarTabId('terminal'),
        staticSessionWorkbarTabId('tasks'),
        staticSessionWorkbarTabId('files'),
      ],
    );
    assert.equal(state.activeTabId, staticSessionWorkbarTabId('tasks'));
    assert.equal(state.launcherOpen, false);
  });

  it('closes the active tab onto its next sibling, then opens the launcher when empty', () => {
    let state = createSessionWorkbarTabsState();
    state = openStaticSessionWorkbarTab(state, 'tasks');
    state = openStaticSessionWorkbarTab(state, 'files');
    state = openStaticSessionWorkbarTab(state, 'inspector');
    state = activateSessionWorkbarTab(state, staticSessionWorkbarTabId('files'));

    state = closeSessionWorkbarTab(state, staticSessionWorkbarTabId('files'));
    assert.equal(state.activeTabId, staticSessionWorkbarTabId('inspector'));
    state = closeSessionWorkbarTab(state, staticSessionWorkbarTabId('inspector'));
    state = closeSessionWorkbarTab(state, staticSessionWorkbarTabId('tasks'));
    assert.deepEqual(state, {
      tabs: [],
      activeTabId: null,
      launcherOpen: true,
      activationHistory: [],
    });
  });

  it('opens the launcher without losing the selected tab', () => {
    const task = openStaticSessionWorkbarTab(createSessionWorkbarTabsState(), 'tasks');
    const launcher = openSessionWorkbarLauncher(task);
    assert.equal(launcher.launcherOpen, true);
    assert.equal(launcher.activeTabId, task.activeTabId);
  });

  it('returns to the most recently active tab before using array adjacency', () => {
    let state = createSessionWorkbarTabsState();
    state = openStaticSessionWorkbarTab(state, 'tasks');
    state = openStaticSessionWorkbarTab(state, 'files');
    state = openStaticSessionWorkbarTab(state, 'inspector');
    state = activateSessionWorkbarTab(state, staticSessionWorkbarTabId('tasks'));
    state = activateSessionWorkbarTab(state, staticSessionWorkbarTabId('files'));

    state = closeSessionWorkbarTab(state, staticSessionWorkbarTabId('files'));
    assert.equal(state.activeTabId, staticSessionWorkbarTabId('tasks'));
  });

  it('supports arbitrary side-chat ids but excludes them from persistence', () => {
    let state = openStaticSessionWorkbarTab(createSessionWorkbarTabsState(), 'files');
    state = openSessionWorkbarTab(state, {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
    });
    assert.equal(state.activeTabId, 'side-chat:panel-1');
    assert.deepEqual(persistableSessionWorkbarTabs(state), {
      version: 2,
      tabs: [{ id: staticSessionWorkbarTabId('files'), kind: 'files' }],
      activeTabId: staticSessionWorkbarTabId('files'),
    });
  });

  it('keeps terminal refs dynamic and excludes live process tabs from persistence', () => {
    const ref = 'maka://runtime/background-tasks/pty-1';
    const tab = {
      id: terminalSessionWorkbarTabId(ref),
      kind: 'terminal' as const,
      ordinal: 2,
      resourceRef: ref,
      ownerSessionId: 'session-1',
    };
    const state = openSessionWorkbarTab(createSessionWorkbarTabsState(), tab);

    assert.equal(terminalRefFromWorkbarTab(tab), ref);
    assert.deepEqual(persistableSessionWorkbarTabs(state), {
      version: 2,
      tabs: [],
      activeTabId: null,
    });
  });

  it('keeps repeated-tab ordinals stable when an earlier tab closes', () => {
    let state = openSessionWorkbarTab(createSessionWorkbarTabsState(), {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
      ordinal: 1,
    });
    state = openSessionWorkbarTab(state, {
      id: 'side-chat:panel-2',
      kind: 'side-chat',
      ordinal: 2,
    });
    state = closeSessionWorkbarTab(state, 'side-chat:panel-1');

    assert.deepEqual(state.tabs, [
      { id: 'side-chat:panel-2', kind: 'side-chat', ordinal: 2 },
    ]);
  });

  it('keeps a transient side-chat title without persisting it', () => {
    const state = openSessionWorkbarTab(createSessionWorkbarTabsState(), {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
      title: 'Inspect the renderer boundary',
    });
    assert.equal(state.tabs[0]?.title, 'Inspect the renderer boundary');
    assert.deepEqual(persistableSessionWorkbarTabs(state), {
      version: 2,
      tabs: [],
      activeTabId: null,
    });
  });

  it('titles only the first accepted prompt for a side chat', () => {
    const base = openSessionWorkbarTab(createSessionWorkbarTabsState(), {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
    });
    const titled = titleSessionWorkbarTab(
      base,
      'side-chat:panel-1',
      'First prompt',
    );
    assert.equal(titled.tabs[0]?.title, 'First prompt');
    assert.equal(
      titleSessionWorkbarTab(titled, 'side-chat:panel-1', 'Later prompt'),
      titled,
    );

    const panels = openSessionWorkbarPanelTab(
      createSessionWorkbarPanelsState(),
      'bottom',
      { id: 'side-chat:panel-2', kind: 'side-chat' },
    );
    assert.equal(
      titleSessionWorkbarPanelTab(
        panels,
        'side-chat:panel-2',
        'Bottom prompt',
      ).bottom.tabs[0]?.title,
      'Bottom prompt',
    );
  });

  it('replaces one preview tab and pins it on manual open or explicit pin', () => {
    let state = openSessionWorkbarTab(createSessionWorkbarTabsState(), {
      id: 'preview:one',
      kind: 'files',
      preview: true,
    });
    state = openSessionWorkbarTab(state, {
      id: 'preview:two',
      kind: 'browser',
      preview: true,
    });
    assert.deepEqual(
      state.tabs.map(({ id, preview }) => ({ id, preview })),
      [{ id: 'preview:two', preview: true }],
    );

    state = openSessionWorkbarTab(state, {
      id: 'preview:two',
      kind: 'browser',
    });
    assert.equal(state.tabs[0]?.preview, false);
    assert.equal(pinSessionWorkbarTab(state, 'preview:two'), state);

    const explicit = pinSessionWorkbarTab(
      openSessionWorkbarTab(createSessionWorkbarTabsState(), {
        id: 'preview:three',
        kind: 'files',
        preview: true,
      }),
      'preview:three',
    );
    assert.equal(explicit.tabs[0]?.preview, false);
  });

  it('reorders tabs without changing the active tab or launcher state', () => {
    let state = createSessionWorkbarTabsState();
    state = openStaticSessionWorkbarTab(state, 'tasks');
    state = openStaticSessionWorkbarTab(state, 'files');
    state = openStaticSessionWorkbarTab(state, 'inspector');

    state = reorderSessionWorkbarTab(
      state,
      staticSessionWorkbarTabId('inspector'),
      staticSessionWorkbarTabId('tasks'),
    );
    assert.deepEqual(
      state.tabs.map((tab) => tab.kind),
      ['inspector', 'tasks', 'files'],
    );
    assert.equal(state.activeTabId, staticSessionWorkbarTabId('inspector'));

    state = moveSessionWorkbarTab(
      state,
      staticSessionWorkbarTabId('tasks'),
      'right',
    );
    assert.deepEqual(
      state.tabs.map((tab) => tab.kind),
      ['inspector', 'files', 'tasks'],
    );
  });

  it('derives close-other and close-to-right candidates and closes them together', () => {
    let state = createSessionWorkbarTabsState();
    state = openStaticSessionWorkbarTab(state, 'tasks');
    state = openStaticSessionWorkbarTab(state, 'browser');
    state = openStaticSessionWorkbarTab(state, 'files');
    state = openStaticSessionWorkbarTab(state, 'inspector');
    const browserId = staticSessionWorkbarTabId('browser');

    assert.deepEqual(
      sessionWorkbarTabsToRight(state, browserId).map((tab) => tab.kind),
      ['files', 'inspector'],
    );
    assert.deepEqual(
      sessionWorkbarTabsExcept(state, browserId).map((tab) => tab.kind),
      ['tasks', 'files', 'inspector'],
    );

    state = closeSessionWorkbarTabs(
      activateSessionWorkbarTab(state, staticSessionWorkbarTabId('files')),
      sessionWorkbarTabsToRight(state, browserId).map((tab) => tab.id),
    );
    assert.deepEqual(
      state.tabs.map((tab) => tab.kind),
      ['tasks', 'browser'],
    );
    assert.equal(state.activeTabId, browserId);
  });

  it('reconciles tabs whose backing surface disappeared', () => {
    let state = openStaticSessionWorkbarTab(createSessionWorkbarTabsState(), 'tasks');
    state = openSessionWorkbarTab(state, {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
    });
    state = reconcileSessionWorkbarTabs(
      state,
      new Set([staticSessionWorkbarTabId('tasks')]),
    );
    assert.equal(state.activeTabId, staticSessionWorkbarTabId('tasks'));
    assert.equal(state.tabs.length, 1);
  });
});

describe('session workbar tab persistence', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('reads a v2 dynamic tab snapshot', () => {
    const value = JSON.stringify({
      version: 2,
      tabs: [
        { id: 'workbar:files', kind: 'files' },
        { id: 'side-chat:stale', kind: 'side-chat' },
        { id: 'workbar:inspector', kind: 'inspector' },
      ],
      activeTabId: 'workbar:inspector',
    });
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => (key === 'maka-session-workbar-tabs-v2' ? value : null),
    };

    const state = readSessionWorkbarTabs();
    assert.deepEqual(state.tabs, [
      { id: 'workbar:files', kind: 'files' },
      { id: 'workbar:inspector', kind: 'inspector' },
    ]);
    assert.equal(state.activeTabId, 'workbar:inspector');
  });

  it('migrates the legacy active tab and otherwise starts on the New Tab page', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) =>
        key === 'maka-session-workbar-tab-v1' ? 'browser' : null,
    };
    assert.deepEqual(readSessionWorkbarTabs().tabs, [
      { id: 'workbar:browser', kind: 'browser' },
    ]);

    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
    };
    assert.deepEqual(readSessionWorkbarTabs(), {
      tabs: [],
      activeTabId: null,
      launcherOpen: true,
      activationHistory: [],
    });
  });
});

describe('session workbar panel topology', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('moves a live tab between independent right and bottom controllers', () => {
    let state = createSessionWorkbarPanelsState();
    state = openSessionWorkbarPanelTab(state, 'right', {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
      ordinal: 1,
    });
    state = openSessionWorkbarPanelTab(state, 'right', {
      id: 'workbar:files',
      kind: 'files',
    });
    state = moveSessionWorkbarTabToPanel(state, 'side-chat:panel-1', 'bottom');

    assert.equal(findSessionWorkbarTabPlacement(state, 'side-chat:panel-1'), 'bottom');
    assert.deepEqual(state.right.tabs.map((tab) => tab.id), ['workbar:files']);
    assert.deepEqual(state.bottom.tabs, [
      { id: 'side-chat:panel-1', kind: 'side-chat', ordinal: 1 },
    ]);
    assert.equal(state.bottom.activeTabId, 'side-chat:panel-1');
    assert.equal(state.focusedPanel, 'bottom');
  });

  it('prefers an active right side chat, then the first right chat, before bottom', () => {
    let state = createSessionWorkbarPanelsState();
    state = openSessionWorkbarPanelTab(state, 'right', {
      id: 'workbar:files',
      kind: 'files',
    });
    state = openSessionWorkbarPanelTab(state, 'right', {
      id: 'side-chat:right-1',
      kind: 'side-chat',
    });
    state = openSessionWorkbarPanelTab(state, 'right', {
      id: 'side-chat:right-2',
      kind: 'side-chat',
    });
    state = openSessionWorkbarPanelTab(state, 'bottom', {
      id: 'side-chat:bottom-1',
      kind: 'side-chat',
    });

    assert.equal(
      findPreferredSideChatWorkbarTab(state)?.tab.id,
      'side-chat:right-2',
    );

    state = {
      ...state,
      right: {
        ...state.right,
        activeTabId: 'workbar:files',
      },
    };
    assert.equal(
      findPreferredSideChatWorkbarTab(state)?.tab.id,
      'side-chat:right-1',
    );

    state = {
      ...state,
      right: createSessionWorkbarTabsState([
        { id: 'workbar:files', kind: 'files' },
      ]),
    };
    assert.equal(
      findPreferredSideChatWorkbarTab(state)?.tab.id,
      'side-chat:bottom-1',
    );
  });

  it('pins a preview tab through the panel controller before persistence', () => {
    const preview = openSessionWorkbarPanelTab(
      createSessionWorkbarPanelsState(),
      'right',
      { id: 'workbar:files', kind: 'files', preview: true },
    );
    assert.deepEqual(persistableSessionWorkbarPanels(preview).right.tabs, []);
    const pinned = pinSessionWorkbarPanelTab(preview, 'workbar:files');
    assert.deepEqual(persistableSessionWorkbarPanels(pinned).right.tabs, [
      { id: 'workbar:files', kind: 'files' },
    ]);
  });

  it('persists static topology while excluding ephemeral side chats', () => {
    let state = createSessionWorkbarPanelsState();
    state = openSessionWorkbarPanelTab(state, 'right', {
      id: 'workbar:tasks',
      kind: 'tasks',
    });
    state = openSessionWorkbarPanelTab(state, 'bottom', {
      id: 'workbar:files',
      kind: 'files',
    });
    state = openSessionWorkbarPanelTab(state, 'bottom', {
      id: 'side-chat:panel-1',
      kind: 'side-chat',
      ordinal: 1,
    });

    assert.deepEqual(persistableSessionWorkbarPanels(state), {
      version: 3,
      right: {
        version: 2,
        tabs: [{ id: 'workbar:tasks', kind: 'tasks' }],
        activeTabId: 'workbar:tasks',
      },
      bottom: {
        version: 2,
        tabs: [{ id: 'workbar:files', kind: 'files' }],
        activeTabId: 'workbar:files',
      },
      focusedPanel: 'bottom',
    });
  });

  it('reads v3 topology and migrates v2 tabs into the right panel', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) =>
        key === 'maka-session-workbar-panels-v3'
          ? JSON.stringify({
              version: 3,
              right: {
                version: 2,
                tabs: [{ id: 'workbar:tasks', kind: 'tasks' }],
                activeTabId: 'workbar:tasks',
              },
              bottom: {
                version: 2,
                tabs: [{ id: 'workbar:files', kind: 'files' }],
                activeTabId: 'workbar:files',
              },
              focusedPanel: 'bottom',
            })
          : null,
    };
    assert.deepEqual(readSessionWorkbarPanels().bottom.tabs, [
      { id: 'workbar:files', kind: 'files' },
    ]);
    assert.equal(readSessionWorkbarPanels().focusedPanel, 'bottom');

    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) =>
        key === 'maka-session-workbar-tabs-v2'
          ? JSON.stringify({
              version: 2,
              tabs: [{ id: 'workbar:tasks', kind: 'tasks' }],
              activeTabId: 'workbar:tasks',
            })
          : null,
    };
    const migrated = readSessionWorkbarPanels();
    assert.deepEqual(migrated.right.tabs, [
      { id: 'workbar:tasks', kind: 'tasks' },
    ]);
    assert.deepEqual(migrated.bottom.tabs, []);
  });
});
