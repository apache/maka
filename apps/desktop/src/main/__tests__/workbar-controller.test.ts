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

import { deferred } from '@maka/core/test-only/async-primitives';
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import type { ShellRunUpdate } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import type { WorkBoardActiveItem, WorkBoardItem, WorkBoardLinkedSession } from '@maka/core/work-board';
import { LocaleProvider, type ToastApi } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeWorkbarServices,
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

function ControllerProbe(props: UseWorkbarControllerInput) {
  latestController = useWorkbarController(props);
  controllerRenderSnapshots.push({
    activeId: latestController.host.activeId,
    terminalOwnerIds: [
      ...latestController.host.panelsState.right.tabs,
      ...latestController.host.panelsState.bottom.tabs,
    ]
      .filter((tab) => tab.kind === 'terminal')
      .map((tab) => tab.ownerSessionId),
  });
  return null;
}

function renderController(
  root: ReturnType<typeof installReactRenderer>['root'],
  services: WorkbarServices,
  input: UseWorkbarControllerInput,
  strictMode = false,
) {
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
    activeSession,
    projectId: activeSession?.projectId,
    projectAliases: [],
    authoritativeSessionIds: new Set(activeSession ? [activeSession.id] : []),
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
    let browserSubscriptions = 0;
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      browser: {
        ...defaults.browser,
        subscribeLive: () => {
          browserSubscriptions += 1;
          return () => undefined;
        },
      },
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

    assert.equal(browserSubscriptions, 2);
    assert.deepEqual(starts, ['a']);
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (tab) => tab.kind === 'terminal',
      ),
      true,
    );
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

  it('stops a Terminal whose start resolves after the owner Session changes', async () => {
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
          return null;
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    assert.deepEqual(starts, ['a']);

    await act(async () => renderController(root, services, input(session('b'))));
    await act(async () => start.resolve(shellUpdate('a', 'terminal-a')));

    assert.deepEqual(stops, [{ sessionId: 'a', ref: 'terminal-a' }]);
    assert.equal(
      controller().host.panelsState.right.tabs.some(
        (tab) => tab.kind === 'terminal',
      ),
      false,
    );
  });

  it('stops an opened Terminal exactly once on close and on Session switch', async () => {
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
          return null;
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
      { sessionId: 'a', ref: 'terminal-2' },
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
  });

  it('retries a failed Terminal stop during later Session cleanup', async () => {
    const { root } = installReactRenderer();
    const firstStop = deferred<ShellRunUpdate | null>();
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) => shellUpdate(sessionId, 'terminal-retry'),
        stop: (request) => {
          stops.push(request);
          return stops.length === 1 ? firstStop.promise : Promise.resolve(null);
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
    assert.deepEqual(stops, [{ sessionId: 'a', ref: 'terminal-retry' }]);

    await act(async () => {
      firstStop.reject(new Error('Host disconnected'));
      await Promise.resolve();
    });
    await act(async () => renderController(root, services, input(session('b'))));
    assert.deepEqual(stops, [
      { sessionId: 'a', ref: 'terminal-retry' },
      { sessionId: 'a', ref: 'terminal-retry' },
    ]);

    await act(async () => renderController(root, services, input(session('c'))));
    assert.equal(stops.length, 2);
  });

  it('owns a resolved Terminal before its tab state commits', async () => {
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
          return null;
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

    assert.deepEqual(stops, [
      { sessionId: 'a', ref: 'terminal-before-commit' },
    ]);
  });

  it('stops an opened Terminal exactly once when the controller unmounts', async () => {
    const { root } = installReactRenderer();
    const stops: Array<{ sessionId: string; ref: string }> = [];
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      terminal: {
        ...defaults.terminal,
        start: async (sessionId) => shellUpdate(sessionId, 'terminal-unmount'),
        stop: async (request) => {
          stops.push(request);
          return null;
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => controller().commands.openTool('terminal'));
    await act(async () => root.unmount());

    assert.deepEqual(stops, [
      { sessionId: 'a', ref: 'terminal-unmount' },
    ]);
  });

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

  it('hides created companion Sessions until cleanup or reconciliation', async () => {
    const { root } = installReactRenderer();
    const services = createFakeWorkbarServices();
    const firstInput = input(session('a'));
    firstInput.authoritativeSessionIds = new Set(['a', 'fork']);
    await act(async () => renderController(root, services, firstInput));

    await act(async () =>
      controller().host.onForkVisibilityChange?.({
        type: 'fork-created',
        sessionId: 'fork',
      }),
    );
    assert.equal(controller().selectors.hiddenSessionIds.has('fork'), true);

    const reconciled = input(session('a'));
    reconciled.authoritativeSessionIds = new Set(['a']);
    await act(async () => renderController(root, services, reconciled));
    assert.equal(controller().selectors.hiddenSessionIds.has('fork'), false);
  });

  it('binds Browser ownership and disposes its live subscription once', async () => {
    const { root } = installReactRenderer();
    const activeSessions: Array<string | null> = [];
    let subscriptions = 0;
    let disposals = 0;
    const defaults = createFakeWorkbarServices();
    const services = createFakeWorkbarServices({
      browser: {
        ...defaults.browser,
        setActiveSession: (sessionId) => activeSessions.push(sessionId),
        subscribeLive: () => {
          subscriptions += 1;
          return () => {
            disposals += 1;
          };
        },
      },
    });

    await act(async () => renderController(root, services, input(session('a'))));
    await act(async () => renderController(root, services, input(session('b'))));
    await act(async () => root.unmount());

    assert.equal(subscriptions, 1);
    assert.equal(disposals, 1);
    assert.deepEqual(activeSessions, ['a', 'b']);
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
