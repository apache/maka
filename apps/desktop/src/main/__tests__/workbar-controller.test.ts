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

import { WorkHubWorkspaceServicesProvider, type WorkHubWorkspaceServices } from '../../renderer/application/contracts/workhub-workspace/use-workhub-workspace.js';
import { deferred } from '@maka/core/test-only/async-primitives';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import type { ShellRunUpdate } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import type { WorkBoardActiveItem, WorkBoardItem, WorkBoardLinkedSession } from '@maka/core/work-board';
import { LocaleProvider, type ToastApi } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { TerminalCloseIntents } from '../terminal-close-intents.js';
import { desktopSessionKey, type TerminalCloseChange } from '../../shared/runtime-host-identity.js';
import {
  createFakeWorkbarServices,
  projectWorkbarPanelsForSession,
  useWorkbarController,
  WorkbarServicesProvider,
  type UseWorkbarControllerInput,
  type WorkbarController,
  type WorkbarServices,
} from '../../renderer/features/workbar/testing.js';
import {
  createFakeTaskEntryServices,
  TaskEntryServicesProvider,
  useTaskEntryController,
  type TaskEntryController,
  type TaskEntryHost,
  type TaskEntryServices,
} from '../../renderer/features/task-entry/testing.js';

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test-model',
    permissionMode: 'ask',
  };
}

function shellUpdate(sessionId: string, ref: string): ShellRunUpdate {
  return {
    sessionId,
    ownership: { kind: 'local' },
    sourceTurnId: 'turn',
    sourceToolCallId: 'tool',
    result: { ref },
  } as ShellRunUpdate;
}
let latestController: WorkbarController | undefined;
let latestTaskEntryController: TaskEntryController | undefined;
let controllerRenderSnapshots: Array<{
  activeId: string | undefined;
  terminalOwnerIds: Array<string | undefined>;
}> = [];

type ControllerProbeInput = UseWorkbarControllerInput & { openOnActivation?: boolean };

function ControllerProbe(props: ControllerProbeInput) {
  const workbar = useWorkbarController(props);
  latestController = workbar;
  const visiblePanels = projectWorkbarPanelsForSession(
    workbar.host.panelsState, workbar.host.activeId,
    new Set(workbar.host.quotes?.map((quote) => `side-chat:${quote.id}`)),
  );
  useLayoutEffect(() => {
    if (props.openOnActivation) workbar.host.onOpenLauncher('right');
  }, [props.activeSession?.id, props.openOnActivation]);
  controllerRenderSnapshots.push({
    activeId: latestController.host.activeId,
    terminalOwnerIds: [
      ...visiblePanels.right.tabs,
      ...visiblePanels.bottom.tabs,
    ]
      .filter((tab) => tab.kind === 'terminal')
      .map((tab) => tab.ownerSessionId),
  });
  return null;
}

const connectedServices = new WeakSet<WorkbarServices>();

function renderController(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: WorkbarServices,
  input: ControllerProbeInput,
  strictMode = false,
) {
  if (!connectedServices.has(services)) {
    connectedServices.add(services);
    const listeners = new Set<(change: TerminalCloseChange) => void>();
    const closes = new TerminalCloseIntents((change) => listeners.forEach((listener) => listener(change)));
    const { stop, recover } = services.terminal;
    services.terminal.stop = (identity) => closes.stop(identity, () => stop(identity));
    services.terminal.recover = (id) => closes.recover(id, async () => (await recover(id)).resources);
    services.terminal.subscribeCloseChanges = (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
  }
  const probe = createElement(
    LocaleProvider,
    {
      locale: 'en',
      children: createElement(
        WorkbarServicesProvider,
        { services },
        createElement(ControllerProbe, input),
      ),
    },
  );
  root.render(
    strictMode
      ? createElement(StrictMode, { children: probe })
      : probe,
  );
}

function controller(): WorkbarController {
  assert.ok(latestController);
  return latestController;
}

function taskEntryController(): TaskEntryController {
  assert.ok(latestTaskEntryController);
  return latestTaskEntryController;
}

function createFakeToastApi(errors: string[] = []): ToastApi {
  return {
    toast: () => '',
    success: () => '',
    error: (title, description) => {
      errors.push(description ? `${title}: ${description}` : title);
      return '';
    },
    info: () => '',
    warning: () => '',
    confirm: async () => false,
    dismiss: () => {},
  };
}

function input(
  activeSession: SessionSummary | undefined,
  toastApi: ToastApi = createFakeToastApi(),
): UseWorkbarControllerInput {
  return {
    available: true,
    layoutSessionId: activeSession?.id,
    activeSession,
    projectId: activeSession?.projectId,
    projectAliases: [],
    authoritativeSessionIds: new Set(['a', 'b', ...(activeSession ? [activeSession.id] : [])]),
    shellObscured: false,
    modelChoices: [],
    toastApi,
  };
}

function workBoardItem(id: string): WorkBoardActiveItem {
  return {
    schemaVersion: 1,
    id,
    revision: 1,
    scope: { kind: 'project', projectId: `project-${id}` },
    title: id,
    state: 'todo',
    archived: false,
    creator: { kind: 'user' },
    provenance: { kind: 'manual' },
    createdAt: 1,
    updatedAt: 1,
  };
}

function workBoardDraftKey(target: {
  profileId: string;
  hostId: string;
  projectId: string;
}): string {
  return `draft:${target.profileId}:${target.hostId}:${target.projectId}`;
}

function workBoardItemDraftKey(itemId: string): string {
  return workBoardDraftKey({
    profileId: 'profile-1',
    hostId: 'host-1',
    projectId: `project-${itemId}`,
  });
}

function workBoardInput(
  activeSession: SessionSummary | undefined,
  toastApi: ToastApi = createFakeToastApi(),
  overrides: Partial<UseWorkbarControllerInput> = {},
  ownerRef: { current: number } = { current: 0 },
): UseWorkbarControllerInput {
  return {
    ...input(activeSession, toastApi),
    resolveWorkBoardTarget: (item) => ({
      ok: true as const,
      target: {
        profileId: 'profile-1',
        hostId: 'host-1',
        projectId: `project-${item.id}`,
      },
    }),
    prepareWorkBoardDraft: (target, draft) => workBoardDraftKey(target),
    openNewTaskSurface: () => {
      ownerRef.current += 1;
      return ownerRef.current;
    },
    composerRef: { current: { setDraft: () => undefined, focus: () => undefined } },
    ...overrides,
  };
}

function taskEntryProject(id: string) {
  return {
    id,
    name: id,
    locations: [{ path: `/tmp/${id}`, isWorktree: false }],
    available: true,
    preferredPath: `/tmp/${id}`,
  };
}

function taskEntryHost(): Extract<TaskEntryHost, { state: 'available' }> {
  return {
    profile: { id: 'profile-1', name: 'Local', kind: 'local' },
    hostId: 'host-1',
    readiness: 'ready',
    state: 'available',
    projects: [taskEntryProject('project-A'), taskEntryProject('project-B')],
    capabilities: {
      chooseClientDirectory: true,
      chooseHostDirectory: false,
      selectNoProject: false,
    },
    selectedProjectId: 'project-A',
    chatDefaults: { permissionMode: 'ask', thinkingLevel: 'high' },
  };
}

function WorkBoardCompositionProbe(props: { ownerRef: { current: number } }) {
  const taskEntry = useTaskEntryController({
    reportError() {},
    manageProjects() {},
  });
  latestTaskEntryController = taskEntry;
  latestController = useWorkbarController(workBoardInput(
    session('active'),
    createFakeToastApi(),
    {
      resolveWorkBoardTarget: taskEntry.commands.resolveWorkBoardTarget,
      prepareWorkBoardDraft: taskEntry.commands.prepareWorkBoardDraft,
      openNewTaskSurface: () => {
        props.ownerRef.current += 1;
        return props.ownerRef.current;
      },
    },
    props.ownerRef,
  ));
  return null;
}

function renderWorkBoardComposition(
  root: ReturnType<typeof installReactRenderer>['root'],
  taskEntryServices: TaskEntryServices,
  workbarServices: WorkbarServices,
  ownerRef: { current: number },
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        TaskEntryServicesProvider,
        { services: taskEntryServices },
        createElement(
          WorkbarServicesProvider,
          { services: workbarServices },
          createElement(WorkBoardCompositionProbe, { ownerRef }),
        ),
      ),
    }),
  );
}

describe('useWorkbarController', () => {
  afterEach(() => {
    latestController = undefined;
    latestTaskEntryController = undefined;
    controllerRenderSnapshots = [];
    cleanupFakeDom();
    delete (globalThis as { window?: unknown }).window;
  });

  it('preserves an expansion requested before the Host-backed Session arrives', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    await act(async () => renderController(root, services, {
      ...input(undefined), layoutSessionId: 'pending',
    }));
    await act(async () => controller().commands.toggleRight());
    assert.equal(controller().host.rightCollapsed, false);
    assert.equal(controller().host.activeId, undefined);
    await act(async () => renderController(root, services, input(session('pending'))));
    assert.equal(controller().host.activeId, 'pending');
    assert.equal(controller().host.rightCollapsed, false);
  });

  it('toggles the visible tool, reveals a different one, and retains its placement', async () => {
    const { root } = installReactRenderer();
    await act(async () => renderController(root, createFakeWorkbarServices(), input(session('a'))));
    await act(async () => controller().commands.toggleTool('files'));
    assert.equal(controller().host.rightCollapsed, false);
    const filesId = controller().host.panelsState.right.activeTabId;
    await act(async () => controller().commands.toggleTool('files'));
    assert.equal(controller().host.rightCollapsed, true);
    await act(async () => controller().commands.toggleTool('files'));
    assert.equal(controller().host.rightCollapsed, false);
    assert.equal(controller().host.panelsState.right.activeTabId, filesId);
    await act(async () => controller().commands.toggleTool('browser'));
    assert.equal(controller().host.rightCollapsed, false);
    assert.equal(controller().host.panelsState.right.activeTabId, 'workbar:browser');
    await act(async () => controller().commands.toggleTool('files'));
    assert.equal(controller().host.rightCollapsed, false);
    assert.equal(controller().host.panelsState.right.activeTabId, filesId);
    await act(async () => controller().commands.openTool('inspector', 'bottom'));
    assert.equal(controller().host.bottomOpen, true);
    await act(async () => controller().commands.toggleTool('inspector'));
    assert.equal(controller().host.bottomOpen, false);
    assert.equal(controller().host.rightCollapsed, false);
    await act(async () => controller().commands.toggleTool('inspector'));
    assert.equal(controller().host.bottomOpen, true);
    assert.equal(controller().host.panelsState.bottom.activeTabId, 'workbar:inspector');
  });

  it('keeps right-panel visibility independent across Session navigation', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    const authoritativeSessionIds = new Set(['a', 'b']);
    const show = (id: string | undefined) => renderController(root, services, {
      ...input(id ? session(id) : undefined),
      authoritativeSessionIds,
    });

    await act(async () => show('a'));
    await act(async () => controller().commands.toggleRight());
    assert.equal(controller().host.rightCollapsed, false);
    await act(async () => show(undefined));
    await act(async () => show('b'));
    assert.equal(controller().host.rightCollapsed, true);
    await act(async () => show('a'));
    assert.equal(controller().host.rightCollapsed, false);
  });

  it('keeps an open requested in the activation commit bound to the new Session', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    const authoritativeSessionIds = new Set(['a', 'b']);
    await act(async () => renderController(root, services, {
      ...input(session('a')), authoritativeSessionIds,
    }, true));
    await act(async () => renderController(root, services, {
      ...input(session('b')), authoritativeSessionIds, openOnActivation: true,
    }, true));
    assert.equal(controller().host.rightCollapsed, false);
    await act(async () => renderController(root, services, {
      ...input(session('a')), authoritativeSessionIds,
    }, true));
    assert.equal(controller().host.rightCollapsed, true);
    await act(async () => renderController(root, services, {
      ...input(session('b')), authoritativeSessionIds,
    }, true));
    assert.equal(controller().host.rightCollapsed, false);
  });

  it("preserves visibility while hiding, rather than removing, another Session's Terminal", async () => {
    const { root } = installReactRenderer();
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) => shellUpdate(sessionId, 'terminal-a'),
      },
    });
    const authoritativeSessionIds = new Set(['a', 'b']);
    const show = (id: string) => renderController(root, services, {
      ...input(session(id)),
      authoritativeSessionIds,
    });

    await act(async () => show('b'));
    await act(async () => controller().commands.toggleRight());
    assert.equal(controller().host.rightCollapsed, false);
    await act(async () => show('a'));
    await act(async () => controller().commands.openTool('terminal'));
    assert.equal(controller().host.panelsState.right.tabs.length, 1);
    await act(async () => show('b'));

    assert.equal(controller().host.panelsState.right.tabs.length, 1);
    assert.equal(projectWorkbarPanelsForSession(
      controller().host.panelsState, 'b', new Set(),
    ).right.tabs.length, 0);
    assert.equal(controller().host.rightCollapsed, false);
  });

  it('projects the canonical project and absorbed aliases into the host model', async () => {
    const { root } = installReactRenderer();
    const controllerInput = input(session('a'));
    controllerInput.projectId = 'project-canonical';
    controllerInput.projectAliases = ['project-absorbed'];

    await act(async () =>
      renderController(root, createFakeWorkbarServices(), controllerInput),
    );

    assert.equal(controller().host.projectId, 'project-canonical');
    assert.deepEqual(controller().host.projectAliases, ['project-absorbed']);
  });

  it('routes Client Capability decisions to the active Session', async () => {
    const { root } = installReactRenderer();
    const responses: Array<{ sessionId: string; requestId: string; decision: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      sideChat: {
        ...defaults.sideChat,
        respondToClientCapability: async (sessionId, response) => {
          responses.push({ sessionId, ...response });
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () =>
      controller().commands.respondToClientCapability({
        requestId: 'capability-1',
        decision: 'allow',
      }),
    );

    assert.deepEqual(responses, [
      { sessionId: 'a', requestId: 'capability-1', decision: 'allow' },
    ]);
  });

  it('keeps the initial Session active after StrictMode replays mount effects', async () => {
    const { root } = installReactRenderer();
    const starts: string[] = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) => {
          starts.push(sessionId);
          return shellUpdate(sessionId, 'terminal-strict-mode');
        },
      },
    });

    await act(async () =>
      renderController(root, services, input(session('a')), true),
    );
    await act(async () => controller().commands.openTool('terminal'));

    assert.deepEqual(starts, ['a']);
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (tab) => tab.kind === 'terminal',
      ),
      true,
    );
  });

  it('blocks task-specific tools and side-chat commands in WorkHub', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    const coordinationId = desktopSessionKey({ hostId: 'local', sessionId: 'maka_workhub_coordination' });
    const coordination: WorkHubWorkspaceServices = {
      resolve: async () => coordinationId,
      subscribeHosts: () => () => {},
      subscribeAvailability: () => () => {},
    };
    const ordinary = input(session('ordinary'));
    const render = (active: boolean) => root.render(createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(WorkbarServicesProvider, { services },
        createElement(WorkHubWorkspaceServicesProvider, { value: coordination },
          createElement(ControllerProbe, { ...ordinary, workHub: { enabled: true, active } }))),
    }));
    await act(async () => render(true));
    assert.equal(controller().host.activeId, coordinationId);
    await act(async () => {
      for (const kind of ['review', 'terminal', 'files', 'side-chat'] as const) controller().commands.openTool(kind);
    });
    assert.deepEqual(controller().host.panelsState.right.tabs, []);
    await act(async () => controller().commands.openTool('browser'));
    assert.deepEqual(controller().host.panelsState.right.tabs.map((tab) => tab.kind), ['browser']);
    await act(async () => render(false));
    assert.equal(controller().host.activeId, 'ordinary');
    await act(async () => controller().commands.openTool('review'));
    assert.ok(controller().host.panelsState.right.tabs.some((tab) => tab.kind === 'review'));
    await act(async () => render(true));
    assert.equal(controller().host.activeId, coordinationId);
    assert.ok(controller().host.panelsState.right.tabs.some((tab) => tab.kind === 'browser'));
  });

  it('opens registry singletons once and dynamic tools as separate instances', async () => {
    const { root } = installReactRenderer();
    const defaults = createFakeWorkbarServices();
    let terminalOrdinal = 0;
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) =>
          shellUpdate(sessionId, `terminal-${++terminalOrdinal}`),
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => {
      controller().commands.openTool('review');
      controller().commands.openTool('review');
    });
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => {
      controller().commands.openTool('side-chat');
      controller().commands.openTool('side-chat');
    });

    const tabs = controller().host.panelsState.right.tabs;
    assert.equal(tabs.filter((tab) => tab.kind === 'review').length, 1);
    assert.equal(tabs.filter((tab) => tab.kind === 'terminal').length, 2);
    assert.equal(tabs.filter((tab) => tab.kind === 'side-chat').length, 2);
    assert.deepEqual(
      tabs
        .filter((tab) => tab.kind === 'terminal')
        .map((tab) => tab.ordinal),
      [1, 2],
    );
    assert.deepEqual(
      tabs
        .filter((tab) => tab.kind === 'side-chat')
        .map((tab) => tab.ordinal),
      [1, 2],
    );
  });

  it('retains a Terminal whose start resolves after navigation without revealing it in the new Session', async () => {
    const { root } = installReactRenderer();
    const start = deferred<ShellRunUpdate>();
    const starts: string[] = [];
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: (sessionId) => {
          starts.push(sessionId);
          return start.promise;
        },
        stop: async (request) => {
          stops.push(request);
          return;
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    assert.deepEqual(starts, ['a']);

    await act(async () => renderController(root, services, input(session('b'))));
    await act(async () => start.resolve(shellUpdate('a', 'terminal-a')));

    assert.deepEqual(stops, []);
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (tab) => tab.kind === 'terminal',
      ),
      true,
    );
    assert.equal(controller().host.rightCollapsed, true);
    await act(async () => renderController(root, services, input(session('a'))));
    const owned = controller().host.panelsState.right.tabs.find((tab) => tab.kind === 'terminal');
    assert.equal(owned?.ownerSessionId, 'a');
    assert.equal(owned?.resourceRef, 'terminal-a');
  });

  it('stops only explicitly closed Terminals and retains the same resource across navigation', async () => {
    const { root } = installReactRenderer();
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    let ordinal = 0;
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) =>
          shellUpdate(sessionId, `terminal-${++ordinal}`),
        stop: async (request) => {
          stops.push(request);
          return;
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    const first = controller().host.panelsState.right.tabs.find(
      (tab) => tab.kind === 'terminal',
    );
    assert.ok(first);
    await act(async () => controller().host.onCloseTab('right', first));
    assert.deepEqual(stops, [{ sessionId: 'a', ref: 'terminal-1' }]);

    await act(async () => controller().commands.openTool('terminal'));
    const sessionSwitchSnapshot = controllerRenderSnapshots.length;
    await act(async () => renderController(root, services, input(session('b'))));
    assert.deepEqual(stops, [
      { sessionId: 'a', ref: 'terminal-1' },
    ]);
    assert.equal(
      controllerRenderSnapshots
        .slice(sessionSwitchSnapshot)
        .some(
          (snapshot) =>
            snapshot.activeId === 'b' &&
            snapshot.terminalOwnerIds.includes('a'),
        ),
      false,
    );
    await act(async () => renderController(root, services, input(session('a'))));
    const retained = controller().host.panelsState.right.tabs.find((tab) => tab.kind === 'terminal');
    assert.equal(retained?.resourceRef, 'terminal-2');
    assert.deepEqual(stops, [{ sessionId: 'a', ref: 'terminal-1' }]);
  });

  it('retains a failed Terminal close for visible retry and removes it only after Stop succeeds', async () => {
    const { root } = installReactRenderer();
    const firstStop = deferred<void>();
    const retryStop = deferred<void>();
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) => shellUpdate(sessionId, 'terminal-retry'),
        stop: (request) => {
          stops.push(request);
          return stops.length === 1 ? firstStop.promise : retryStop.promise;
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    const tab = controller().host.panelsState.right.tabs.find(
      (candidate) => candidate.kind === 'terminal',
    );
    assert.ok(tab);
    await act(async () => controller().host.onCloseTab('right', tab));
    await act(async () => controller().host.onCloseTab('right', tab));
    assert.deepEqual(stops, [{ sessionId: 'a', ref: 'terminal-retry' }]);
    assert.ok(controller().host.panelsState.right.tabs.includes(tab));

    await act(async () => {
      firstStop.reject(new Error('Host disconnected'));
      await Promise.resolve();
    });
    await act(async () => renderController(root, services, input(session('b'))));
    assert.equal(stops.length, 1);
    await act(async () => renderController(root, services, input(session('a'))));
    assert.ok(controller().host.panelsState.right.tabs.includes(tab));
    await act(async () => controller().host.onCloseTab('right', tab));
    await act(async () => renderController(root, services, input(session('b'))));
    await act(async () => controller().commands.toggleRight());
    assert.equal(controller().host.rightCollapsed, false);
    await act(async () => retryStop.resolve());
    assert.equal(controller().host.panelsState.right.tabs.includes(tab), false);
    assert.equal(controller().host.rightCollapsed, false);
    assert.deepEqual(stops, [
      { sessionId: 'a', ref: 'terminal-retry' },
      { sessionId: 'a', ref: 'terminal-retry' },
    ]);

    await act(async () => root.unmount());
    assert.equal(stops.length, 2);
  });

  it('releases a retired owner’s terminal topology without stopping Host resources', async () => {
    const { root } = installReactRenderer();
    const lateStart = deferred<ShellRunUpdate>();
    const stops: string[] = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({ terminal: {
      ...defaults.terminal,
      start: async (id) => id === 'c' ? lateStart.promise : shellUpdate(id, `terminal-${id}`),
      stop: async ({ ref }) => { stops.push(ref); return; },
    } });
    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => renderController(root, services, input(session('b'))));
    await act(async () => controller().commands.openTool('terminal'));
    // Host admits retirement only after A's resource is terminal. Its catalog
    // removal is authoritative; the renderer does not issue another Stop.
    await act(async () => renderController(root, services, {
      ...input(session('b')), authoritativeSessionIds: new Set(['b']),
    }));
    assert.deepEqual(controller().host.panelsState.right.tabs.map((tab) => tab.ownerSessionId), ['b']);
    await act(async () => renderController(root, services, input(session('c'))));
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => renderController(root, services, {
      ...input(session('b')), authoritativeSessionIds: new Set(['b']),
    }));
    // A delayed response cannot resurrect a terminal whose owner has retired.
    await act(async () => lateStart.resolve(shellUpdate('c', 'terminal-c')));
    assert.deepEqual(controller().host.panelsState.right.tabs.map((tab) => tab.ownerSessionId), ['b']);
    assert.deepEqual(stops, []);
    await act(async () => root.unmount());
    assert.deepEqual(stops, []);
  });

  it('leaves a late Terminal start with its Host Session after view disposal', async () => {
    const { root } = installReactRenderer();
    const start = deferred<ShellRunUpdate>();
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: () => start.promise,
        stop: async (request) => {
          stops.push(request);
          return;
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => {
      start.resolve(shellUpdate('a', 'terminal-before-commit'));
      await Promise.resolve();
      root.unmount();
    });

    assert.deepEqual(stops, []);
  });

  it('recovers a live Terminal after Stop rejects following controller unmount', async () => {
    const { root } = installReactRenderer();
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    const pendingStop = deferred<void>();
    let live = true;
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        recover: async (sessionId) => ({ resources: live ? [shellUpdate(sessionId, 'terminal-unmount')] : [], closes: [] }),
        start: async (sessionId) => shellUpdate(sessionId, 'terminal-unmount'),
        stop: (request) => {
          stops.push(request);
          if (stops.length === 1) return pendingStop.promise;
          live = false;
          return Promise.resolve();
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    const tab = controller().host.panelsState.right.tabs[0]!;
    assert.equal(tab.resourceRef, 'terminal-unmount');
    await act(async () => controller().host.onCloseTab('right', tab));
    await act(async () => root.unmount());
    await act(async () => pendingStop.reject(new Error('disconnected after unmount')));

    assert.deepEqual(stops, [
      { sessionId: 'a', ref: 'terminal-unmount' },
    ]);
    const reopened = installReactRenderer();
    await act(async () => renderController(reopened.root, services, input(session('a'))));
    const restored = controller().host.panelsState.right.tabs[0]!;
    assert.equal(restored.resourceRef, tab.resourceRef);
    assert.equal(controller().host.panelsState.right.launcherOpen, false);
    await act(async () => controller().host.onCloseTab('right', restored));
    assert.equal(controller().host.panelsState.right.tabs.length, 0);
    assert.equal(stops.length, 2);
  });

  it('delivers an old pending Close to the rebuilt view', async () => {
    const { root } = installReactRenderer();
    const stop = deferred<void>();
    let live = true;
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({ terminal: {
      ...defaults.terminal,
      recover: async (id) => ({ resources: live ? [shellUpdate(id, 'pending-close')] : [], closes: [] }),
      stop: async () => { await stop.promise; live = false; },
    } });
    await act(async () => renderController(root, services, input(session('a'))));
    const tab = controller().host.panelsState.right.tabs[0]!;
    await act(async () => controller().host.onCloseTab('right', tab));
    await act(async () => root.unmount());
    const reopened = installReactRenderer();
    await act(async () => renderController(reopened.root, services, input(session('a'))));
    assert.equal(controller().host.panelsState.right.tabs[0]?.resourceRef, 'pending-close');
    await act(async () => stop.resolve());
    assert.equal(controller().host.panelsState.right.tabs.length, 0);
  });

  it('retries a failed inventory without needing output, navigation or reconnect', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { root } = installReactRenderer();
    let reads = 0;
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({ terminal: {
      ...defaults.terminal,
      recover: async (id) => {
        if (++reads === 1) throw new Error('catalog changed during pagination');
        return { resources: [shellUpdate(id, 'quiet-terminal')], closes: [] };
      },
    } });
    await act(async () => renderController(root, services, input(session('a'))));
    assert.equal(controller().host.panelsState.right.tabs.length, 0);
    await act(async () => context.mock.timers.tick(100));
    assert.equal(controller().host.panelsState.right.tabs[0]?.resourceRef, 'quiet-terminal');
    await act(async () => root.unmount());
    context.mock.timers.tick(10_000);
    assert.equal(reads, 2);
  });

  it('restores on reconnect without stealing selection or resurrecting a closed tab from an older read', async () => {
    const { root } = installReactRenderer();
    const defaults = createFakeWorkbarServices();
    const staleRead = deferred<ShellRunUpdate[]>();
    let resync: ((event: { sessionId: string }) => void) | undefined;
    let reads = 0;
    const services = createFakeWorkbarServices({ terminal: {
      ...defaults.terminal,
      recover: async (id) => ({ resources: ++reads === 1 ? [] : reads === 2
        ? [shellUpdate(id, 'recovered')] : reads === 3 ? await staleRead.promise : [], closes: [] }),
      subscribeResync: (handler) => { resync = handler; return () => { resync = undefined; }; },
    } });
    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('files'));
    const selected = controller().host.panelsState.right.activeTabId;
    await act(async () => controller().commands.toggleRight());
    await act(async () => resync?.({ sessionId: 'a' }));
    assert.equal(controller().host.panelsState.right.activeTabId, selected);
    assert.equal(controller().host.rightCollapsed, true);
    const tab = controller().host.panelsState.right.tabs.find((tab) => tab.resourceRef === 'recovered');
    assert.ok(tab);
    await act(async () => resync?.({ sessionId: 'a' }));
    await act(async () => { for (let i = 0; i < 100; i++) resync?.({ sessionId: 'a' }); });
    assert.equal(reads, 3);
    await act(async () => controller().host.onCloseTab('right', tab));
    await act(async () => staleRead.resolve([shellUpdate('a', 'recovered')]));
    assert.equal(controller().host.panelsState.right.tabs.includes(tab), false);
    assert.equal(reads, 4);
    await act(async () => root.unmount());
    assert.equal(resync, undefined);
  });

  for (const recoverySessionId of ['a', 'b']) {
    it(`completes ${recoverySessionId === 'a' ? 'same' : 'another'} Session recovery when Stop is the only invalidator`, async () => {
      const { root } = installReactRenderer();
      const defaults = createFakeWorkbarServices();
      const stop = deferred<void>();
      const inventory = deferred<ShellRunUpdate[]>();
      let recovering = false;
      let reads = 0;
      let resync: ((event: { sessionId: string }) => void) | undefined;
      const other = shellUpdate(recoverySessionId, 'other-live-terminal');
      const services = createFakeWorkbarServices({ terminal: {
        ...defaults.terminal,
        start: async () => shellUpdate('a', 'closing-terminal'),
        stop: () => stop.promise,
        recover: async () => ({ resources: !recovering ? [] : ++reads === 1 ? await inventory.promise : [other], closes: [] }),
        subscribeResync: (handler) => { resync = handler; return () => { resync = undefined; }; },
      } });
      await act(async () => renderController(root, services, input(session('a'))));
      await act(async () => controller().commands.openTool('terminal'));
      const closing = controller().host.panelsState.right.tabs[0]!;
      await act(async () => controller().host.onCloseTab('right', closing));
      recovering = true;
      await act(async () => {
        if (recoverySessionId === 'a') resync?.({ sessionId: 'a' });
        else renderController(root, services, input(session('b')));
      });
      await act(async () => stop.resolve());
      await act(async () => inventory.resolve([other]));
      assert.deepEqual(controller().host.panelsState.right.tabs.map((tab) => tab.resourceRef), ['other-live-terminal']);
      assert.equal(reads, recoverySessionId === 'a' ? 2 : 1);
    });
  }

  it('reports only a Terminal start failure that still belongs to the active Session', async () => {
    const { root } = installReactRenderer();
    const currentErrors: string[] = [];
    const staleErrors: string[] = [];
    const currentStart = deferred<ShellRunUpdate>();
    const staleStart = deferred<ShellRunUpdate>();
    const defaults = createFakeWorkbarServices();
    let attempt = 0;
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: () => (++attempt === 1 ? currentStart.promise : staleStart.promise),
      },
    });

    await act(async () =>
      renderController(root, services, input(session('a'), createFakeToastApi(currentErrors))),
    );
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => currentStart.reject(new Error('current failure')));
    assert.equal(currentErrors.length, 1);

    await act(async () =>
      renderController(root, services, input(session('a'), createFakeToastApi(staleErrors))),
    );
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () =>
      renderController(root, services, input(session('b'), createFakeToastApi(staleErrors))),
    );
    await act(async () => staleStart.reject(new Error('stale failure')));
    assert.deepEqual(staleErrors, []);
  });

  it('keeps Side Chat through collapse, confirms content close, and removes it on source switch', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    await act(async () => renderController(root, services, input(session('a'))));

    await act(async () => controller().commands.openTool('side-chat'));
    const panelId = controller().host.quotes?.[0]?.id;
    assert.ok(panelId);
    await act(async () => controller().commands.toggleRight());
    assert.equal(controller().host.quotes?.some((panel) => panel.id === panelId), true);

    await act(async () => controller().host.onContentStateChange?.(panelId, true));
    const tab = controller().host.panelsState.right.tabs.find(
      (candidate) => candidate.id === `side-chat:${panelId}`,
    );
    assert.ok(tab);
    await act(async () => controller().host.onCloseTab('right', tab));
    assert.equal(controller().host.closeConfirmation.open, true);
    await act(async () => controller().host.closeConfirmation.onCancel());
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (candidate) => candidate.id === tab.id,
      ),
      true,
    );

    await act(async () => controller().host.onCloseTab('right', tab));
    await act(async () => controller().host.closeConfirmation.onConfirm(false));
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (candidate) => candidate.id === tab.id,
      ),
      false,
    );

    await act(async () => controller().commands.openTool('side-chat'));
    await act(async () => renderController(root, services, input(session('b'))));
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (candidate) => candidate.kind === 'side-chat',
      ),
      false,
    );
  });

  it('keeps a newly created companion hidden through panel changes and stale catalogs until cleanup', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    const firstInput = input(session('a'));
    firstInput.authoritativeSessionIds = new Set(['a']);
    await act(async () => renderController(root, services, firstInput));

    await act(async () =>
      controller().host.onForkVisibilityChange?.({
        type: 'fork-created',
        sessionId: 'fork',
      }),
    );
    assert.equal(controller().selectors.hiddenSessionIds.has('fork'), true);
    await act(async () => controller().commands.openTool('files'));
    assert.equal(controller().selectors.hiddenSessionIds.has('fork'), true);

    const reconciled = input(session('a'));
    reconciled.authoritativeSessionIds = new Set(['a', 'fork']);
    await act(async () => renderController(root, services, reconciled));
    assert.equal(controller().selectors.hiddenSessionIds.has('fork'), true);
    await act(async () => controller().host.onForkVisibilityChange?.({ type: 'cleanup-succeeded', sessionId: 'fork' }));
    assert.equal(controller().selectors.hiddenSessionIds.has('fork'), false);
  });

  it('binds Browser ownership to the selected Session', async () => {
    const { root } = installReactRenderer();
    const activeSessions: Array<string | null> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      browser: {
        ...defaults.browser,
        setActiveSession: (sessionId) => activeSessions.push(sessionId),
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => renderController(root, services, input(session('b'))));
    await act(async () => root.unmount());

    assert.deepEqual(activeSessions, ['a', 'b']);
  });

  it('opens Browser once when the active Session gains a live browser view', async () => {
    const { root } = installReactRenderer();
    let publishState:
      | Parameters<WorkbarServices['browser']['subscribeState']>[0]
      | undefined;
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      browser: {
        ...defaults.browser,
        subscribeState: (handler) => {
          publishState = handler;
          return () => {
            publishState = undefined;
          };
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    assert.equal(controller().host.rightCollapsed, true);

    const liveState = {
      url: 'https://example.com',
      title: 'Example',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      secure: true,
      hasPage: true,
    };
    await act(async () =>
      publishState?.({
        sessionId: 'a',
        state: liveState,
      }),
    );
    assert.equal(controller().host.rightCollapsed, false);
    assert.equal(controller().host.panelsState.right.activeTabId, 'workbar:browser');

    await act(async () => controller().commands.openTool('files'));
    const browserTab = controller().host.panelsState.right.tabs.find(
      (tab) => tab.kind === 'browser',
    );
    assert.ok(browserTab);
    await act(async () => controller().host.onCloseTab('right', browserTab));
    assert.equal(controller().host.panelsState.right.activeTabId, 'workbar:files');
    await act(async () =>
      publishState?.({
        sessionId: 'a',
        state: {
          ...liveState,
          url: 'https://example.com/redirected',
          title: 'Redirected',
          canGoBack: true,
        },
      }),
    );
    assert.equal(controller().host.panelsState.right.activeTabId, 'workbar:files');
    assert.equal(
      controller().host.panelsState.right.tabs.some((tab) => tab.kind === 'browser'),
      false,
    );

    await act(async () =>
      publishState?.({
        sessionId: 'a',
        state: {
          ...liveState,
          url: '',
          title: '',
          secure: false,
          hasPage: false,
        },
      }),
    );
    await act(async () =>
      publishState?.({
        sessionId: 'a',
        state: {
          ...liveState,
          url: 'https://example.org',
          title: 'Example again',
        },
      }),
    );
    assert.equal(controller().host.panelsState.right.activeTabId, 'workbar:browser');
  });

  it('links a Session produced on the surface that owns the claim', async () => {
    const { root } = installReactRenderer();
    const links: Array<{ id: string; sessionId: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          links.push({ id, sessionId: link.sessionId });
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const ownerRef = { current: 0 };
    const opened: number[] = [];
    const controllerInput = workBoardInput(session('a'), createFakeToastApi(), {
      openNewTaskSurface: () => {
        ownerRef.current += 1;
        opened.push(1);
        return ownerRef.current;
      },
    }, ownerRef);

    await act(async () => renderController(root, services, controllerInput));
    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    assert.equal(opened.length, 1);
    assert.equal(ownerRef.current, 1);

    // The synchronous owner handoff links without an intervening render.
    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(ownerRef.current)(
        JSON.stringify(['host-1', 'session-1']),
        workBoardItemDraftKey('A'),
      ),
    );
    assert.deepEqual(links, [{ id: 'A', sessionId: 'session-1' }]);
  });

  it('does not let a New Task reopened on the same Host/project consume the claim', async () => {
    // Regression for the review: the draft key is derived only from
    // (profileId, hostId, projectId), so two surfaces on the same target share
    // a draft key. The claim must be bound to the surface owner token instead.
    const { root } = installReactRenderer();
    const links: Array<{ id: string; sessionId: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          links.push({ id, sessionId: link.sessionId });
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const ownerRef = { current: 0 };
    const opened: number[] = [];
    const controllerInput = workBoardInput(session('a'), createFakeToastApi(), {
      openNewTaskSurface: () => {
        ownerRef.current += 1;
        opened.push(1);
        return ownerRef.current;
      },
    }, ownerRef);

    await act(async () => renderController(root, services, controllerInput));
    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    assert.equal(ownerRef.current, 1);

    // The user abandons that surface and opens a fresh New Task on the SAME
    // Host/project (a new owner token, identical draft key).
    ownerRef.current += 1;
    // A first send there must not consume the claim or link item A.
    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(ownerRef.current)(
        'session-B',
        workBoardItemDraftKey('A'),
      ),
    );
    assert.deepEqual(links, []);

    // The mismatched send abandoned the claim, so a later send on the
    // original surface must not resurrect it either.
    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(1)(
        'session-A',
        workBoardItemDraftKey('A'),
      ),
    );
    assert.deepEqual(links, []);
  });

  it('ignores an older surface callback without clearing a newer claim', async () => {
    const { root } = installReactRenderer();
    const links: Array<{ id: string; sessionId: string }> = [];
    const services = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          links.push({ id, sessionId: link.sessionId });
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const ownerRef = { current: 0 };

    await act(async () =>
      renderController(root, services, workBoardInput(session('a'), createFakeToastApi(), {}, ownerRef)),
    );
    await act(async () => controller().host.onStartWorkBoardTask?.(workBoardItem('A')));
    const olderOwner = ownerRef.current;
    await act(async () => controller().host.onStartWorkBoardTask?.(workBoardItem('A')));
    const currentOwner = ownerRef.current;
    assert.equal(olderOwner, 1);
    assert.equal(currentOwner, 2);

    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(olderOwner)(
        'session-old',
        workBoardItemDraftKey('A'),
      ),
    );
    assert.deepEqual(links, []);

    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(currentOwner)(
        'session-current',
        workBoardItemDraftKey('A'),
      ),
    );
    assert.deepEqual(links, [{ id: 'A', sessionId: 'session-current' }]);
  });

  it('does not link a first send from a different project surface', async () => {
    const { root } = installReactRenderer();
    const links: Array<{ id: string; sessionId: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          links.push({ id, sessionId: link.sessionId });
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const ownerRef = { current: 0 };
    const controllerInput = workBoardInput(session('a'), createFakeToastApi(), {
      openNewTaskSurface: () => {
        ownerRef.current += 1;
        return ownerRef.current;
      },
    }, ownerRef);

    await act(async () => renderController(root, services, controllerInput));
    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    // A different New Task surface (project B) is opened and sends first.
    ownerRef.current += 1;
    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(ownerRef.current)(
        'session-B',
        workBoardItemDraftKey('B'),
      ),
    );
    assert.deepEqual(links, []);
  });

  it('drops a claim when Task Entry changes project within the same surface', async () => {
    const { root } = installReactRenderer();
    const ownerRef = { current: 0 };
    const links: Array<{ id: string; sessionId: string }> = [];
    const workbarServices = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          links.push({ id, sessionId: link.sessionId });
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const taskEntryServices = createFakeTaskEntryServices({
      catalog: {
        ...createFakeTaskEntryServices().catalog,
        getCatalog: async () => ({
          defaultProfileId: 'profile-1',
          hosts: [taskEntryHost()],
        }),
      },
    });

    await act(async () =>
      renderWorkBoardComposition(root, taskEntryServices, workbarServices, ownerRef),
    );
    assert.equal(taskEntryController().selectors.target?.projectId, 'project-A');

    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    const surfaceOwnerToken = ownerRef.current;
    assert.equal(surfaceOwnerToken, 1);

    await act(async () =>
      taskEntryController().selectors.workspacePicker.groups[0]?.onSelectProject?.(
        'project-B',
      ),
    );
    assert.equal(taskEntryController().selectors.target?.projectId, 'project-B');
    const projectBDraftKey = taskEntryController().selectors.draftKey;

    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(surfaceOwnerToken)(
        'session-B',
        projectBDraftKey,
      ),
    );
    assert.deepEqual(links, []);

    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    assert.equal(ownerRef.current, 2);
    assert.equal(taskEntryController().selectors.target?.projectId, 'project-A');
  });

  it('retries a failed link against the same Session instead of creating a duplicate', async () => {
    const { root } = installReactRenderer();
    let attempts = 0;
    const linkCalls: Array<{ id: string; sessionId: string }> = [];
    const errors: string[] = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          attempts += 1;
          linkCalls.push({ id, sessionId: link.sessionId });
          if (attempts === 1) return { ok: false, message: 'transient SQLite busy' };
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const ownerRef = { current: 0 };
    const opened: number[] = [];
    const controllerInput = workBoardInput(session('a'), createFakeToastApi(errors), {
      openNewTaskSurface: () => {
        ownerRef.current += 1;
        opened.push(1);
        return ownerRef.current;
      },
    }, ownerRef);

    await act(async () => renderController(root, services, controllerInput));
    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(ownerRef.current)(
        JSON.stringify(['host-1', 'session-1']),
        workBoardItemDraftKey('A'),
      ),
    );
    // First attempt fails; the claim (with its Session id) must be retained.
    assert.equal(linkCalls.length, 1);
    assert.ok(errors.some((message) => message.includes('SQLite')));

    // Retry by pressing Start on the same item: reuse the same Session and do
    // not open a new surface (which would create a duplicate Session).
    await act(async () =>
      controller().host.onStartWorkBoardTask?.(workBoardItem('A')),
    );
    assert.equal(linkCalls.length, 2);
    assert.equal(opened.length, 1);
    assert.deepEqual(
      linkCalls.map((call) => call.sessionId),
      ['session-1', 'session-1'],
    );
  });

  it('starts a new Session when an item target changes after link failure', async () => {
    const { root } = installReactRenderer();
    let attempts = 0;
    const linkCalls: Array<{ id: string; sessionId: string }> = [];
    const resolvedProjectIds: string[] = [];
    const services = createFakeWorkbarServices({
      workBoard: {
        linkSession: async (id, link) => {
          attempts += 1;
          linkCalls.push({ id, sessionId: link.sessionId });
          if (attempts === 1) return { ok: false, message: 'transient SQLite busy' };
          return { ok: true, value: workBoardItem(id) };
        },
      },
    });
    const ownerRef = { current: 0 };
    const opened: number[] = [];
    const resolveWorkBoardTarget: NonNullable<UseWorkbarControllerInput['resolveWorkBoardTarget']> =
      (item) => {
        const projectId = item.scope.kind === 'project' ? item.scope.projectId : 'unavailable';
        resolvedProjectIds.push(projectId);
        return {
          ok: true,
          target: {
            profileId: 'profile-1',
            hostId: 'host-1',
            projectId,
          },
        };
      };
    const controllerInput = workBoardInput(session('a'), createFakeToastApi(), {
      resolveWorkBoardTarget,
      openNewTaskSurface: () => {
        ownerRef.current += 1;
        opened.push(ownerRef.current);
        return ownerRef.current;
      },
    }, ownerRef);

    await act(async () => renderController(root, services, controllerInput));
    await act(async () => controller().host.onStartWorkBoardTask?.(workBoardItem('A')));
    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(ownerRef.current)(
        'session-1',
        workBoardItemDraftKey('A'),
      ),
    );
    assert.equal(linkCalls.length, 1);

    const movedItem: WorkBoardActiveItem = {
      ...workBoardItem('A'),
      revision: 2,
      scope: { kind: 'project', projectId: 'project-B' },
    };
    await act(async () => controller().host.onStartWorkBoardTask?.(movedItem));
    assert.deepEqual(opened, [1, 2]);
    assert.equal(linkCalls.length, 1);

    await act(async () =>
      controller().commands.bindNewTaskSessionResolver(ownerRef.current)(
        'session-2',
        workBoardDraftKey({
          profileId: 'profile-1',
          hostId: 'host-1',
          projectId: 'project-B',
        }),
      ),
    );
    assert.deepEqual(linkCalls, [
      { id: 'A', sessionId: 'session-1' },
      { id: 'A', sessionId: 'session-2' },
    ]);
    assert.deepEqual(resolvedProjectIds, ['project-A', 'project-B']);
  });

  it('opens a previously linked Session from a board item', async () => {
    const { root } = installReactRenderer();
    const opened: string[] = [];
    const controllerInput = workBoardInput(session('a'), createFakeToastApi(), {
      openSessionInChat: (key) => opened.push(key),
    });

    await act(async () =>
      renderController(root, createFakeWorkbarServices(), controllerInput),
    );
    const link: WorkBoardLinkedSession = {
      profileId: 'profile-1',
      hostId: 'host-1',
      sessionId: 'session-1',
      linkedAt: 1,
    };
    await act(async () =>
      controller().host.onOpenWorkBoardSession?.(link),
    );

    assert.deepEqual(opened, [JSON.stringify(['host-1', 'session-1'])]);
  });
});
