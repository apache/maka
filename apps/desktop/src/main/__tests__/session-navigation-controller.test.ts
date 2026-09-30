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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import {
  LocaleProvider,
  useSessionRailData,
  type SessionRailData,
  type SessionRailSelection,
} from '@maka/ui';
import { useSessionRailSelection } from '@maka/ui/testing';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeSessionNavigationServices,
  createSessionOpenCommand,
  deriveSessionRail,
  sessionMatchesRail,
  SessionNavigationProvider,
  SessionNavigationServicesProvider,
  useSessionNavigationController,
  useSessionNavigationReads,
  type SessionNavigationController,
  type SessionNavigationPorts,
  type SessionNavigationSession,
  type UseSessionNavigationControllerInput,
} from '../../renderer/features/session-navigation/testing.js';
import { createSessionCatalogController } from '../../renderer/application/contracts/session-catalog/session-catalog-state.js';
import type { DesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import type { SnapshotReader } from '../../renderer/application/contracts/snapshot-reader.js';
import { createProductionSessionUiStateController } from '../../renderer/features/conversation/testing.js';

const EMPTY_STREAMING_SESSIONS = new Set<string>();

function session(
  id: string,
  overrides: Partial<DesktopSessionSummary> = {},
): DesktopSessionSummary {
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
    profileId: 'local',
    profileName: 'Local',
    profileKind: 'local',
    revision: 0,
    activityAt: 0,
    runtimeHostId: 'local-host',
    ...overrides,
  };
}

const project: ProjectRecord = {
  id: 'project',
  name: 'Project',
  locations: [{ path: '/repo', isWorktree: false }],
  available: true,
};

const localProjectScope = {
  key: JSON.stringify(['local-host', project.id]),
  profileId: 'local',
  hostId: 'local-host',
  profileName: 'Local',
  profileKind: 'local' as const,
  project,
  capabilities: {
    chooseClientDirectory: true,
    chooseHostDirectory: false,
    selectNoProject: true,
  },
};

function localScope(project: ProjectRecord) {
  return {
    ...localProjectScope,
    key: JSON.stringify(['local-host', project.id]),
    project,
  };
}

const hiddenSessionIds = new Set(['hidden']);

const fakeServices = createFakeSessionNavigationServices();

let latestController: SessionNavigationController | undefined;

function ControllerProbe(props: UseSessionNavigationControllerInput) {
  latestController = useSessionNavigationController(props);
  return null;
}

function renderController(
  root: ReturnType<typeof installReactRenderer>['root'],
  input: UseSessionNavigationControllerInput,
) {
  root.render(
    createElement(LocaleProvider, {
      locale: 'en',
      children: createElement(
        SessionNavigationServicesProvider,
        { services: fakeServices },
        createElement(ControllerProbe, input),
      ),
    }),
  );
}

function controller(): SessionNavigationController {
  assert.ok(latestController);
  return latestController;
}

function ports(
  sessions: SessionNavigationSession[],
  _activeSessionId: string | undefined,
  calls: string[] = [],
): SessionNavigationPorts {
  return {
    sessionsRef: { current: sessions },
    acquireAutomaticQueryBlock: () => ({ release: () => undefined }),
    activateSession: (sessionId) => calls.push(`activate:${sessionId ?? 'none'}`),
    clearSessionRendererState: (sessionId) => calls.push(`clear:${sessionId}`),
    refreshSessions: async () => sessions,
    toastApi: {
      success: () => undefined,
      error: () => undefined,
      confirm: async () => true,
    },
  };
}

function input(
  sessions: SessionNavigationSession[],
  activeSessionId: string | undefined,
  calls: string[] = [],
): UseSessionNavigationControllerInput {
  return {
    rail: deriveSessionRail(
      sessions,
      activeSessionId,
      (candidate) => !hiddenSessionIds.has(candidate.id) && sessionMatchesRail(candidate),
    ),
    projectScopes: [
      localProjectScope,
      ...sessions
        .filter((session) => session.profileKind !== 'local')
        .map((session) => ({
          key: JSON.stringify([session.runtimeHostId, project.id]),
          profileId: session.profileId,
          hostId: session.runtimeHostId,
          profileName: session.profileName,
          profileKind: session.profileKind,
          project: { ...project },
          capabilities: {
            chooseClientDirectory: false,
            chooseHostDirectory: true,
            selectNoProject: false,
          },
        })),
    ],
    ports: ports(sessions, activeSessionId, calls),
  };
}

function navigationTree(
  catalog: ReturnType<typeof createSessionCatalogController>,
  shell: { activeSessionId: string; workHubActive: boolean },
  sibling: ReactNode,
  child: ReactNode,
  streamingSessions: SnapshotReader<ReadonlySet<string>> = {
    getSnapshot: () => EMPTY_STREAMING_SESSIONS,
    subscribe: () => () => undefined,
  },
) {
  return createElement(LocaleProvider, {
    locale: 'en',
    children: createElement(
      SessionNavigationServicesProvider,
      { services: fakeServices },
      sibling,
      createElement(
        SessionNavigationProvider,
        {
          ...shell,
          catalog,
          hiddenSessionIds,
          projectScopes: [localProjectScope],
          streamingSessions,
          sessionSendOutcomes: {},
          ports: ports(linkedCatalog, shell.activeSessionId),
          commandsRef: { current: null },
          selection: { section: 'sessions' },
          onSelect: () => undefined,
          onOpenSettings: () => undefined,
          onNew: () => undefined,
          onExitWorkHub: () => undefined,
          onSelectSession: () => undefined,
        },
        child,
      ),
    ),
  });
}

const linkedCatalog = [
  session('root', { projectId: 'project', cwd: '/repo' }),
  session('child', {
    subagentParent: {
      kind: 'subagent',
      parentSessionId: 'root',
      spawnedBy: {
        parentRunId: 'run',
        parentTurnId: 'turn',
        toolCallId: 'tool',
      },
      lifecycle: 'foreground',
    },
  }),
  session('remote', {
    runtimeHostId: 'remote-host',
    profileId: 'remote-profile',
    profileName: 'Remote Mac',
    profileKind: 'remote',
    projectId: 'project',
    cwd: '/srv/project',
  }),
  session('environment', {
    runtimeHostId: 'wsl-host',
    profileId: 'wsl-ubuntu',
    profileName: 'Ubuntu',
    profileKind: 'environment',
    projectId: 'project',
    cwd: '/home/user/project',
  }),
  session('side-conversation', {
    parentSessionId: 'root',
    labels: ['mode:side_conversation'],
  }),
  session('archived', { isArchived: true }),
  session('hidden'),
];

afterEach(() => {
  latestController = undefined;
  cleanupFakeDom();
});

describe('useSessionNavigationController', () => {
  it('keeps same-named Projects from each Runtime Host at the same level', async () => {
    const { root } = installReactRenderer();
    await act(async () => renderController(root, input(linkedCatalog, 'child')));

    assert.deepEqual(
      controller().selectors.groups.map(({ id }) => id),
      [
        'project:["local-host","project"]',
        'project:["remote-host","project"]',
        'project:["wsl-host","project"]',
      ],
    );
    assert.deepEqual(
      controller().selectors.groups.map(({ label }) => label),
      ['Project · Local', 'Project · Remote Mac', 'Project · Ubuntu'],
    );
    assert.equal(
      controller().selectors.sessionMeta(linkedCatalog[2]!),
      'Remote Mac',
    );
    assert.equal(
      controller().selectors.sessionMeta(linkedCatalog[3]!),
      'Ubuntu',
    );
    assert.equal(controller().selectors.sessionMeta(linkedCatalog[2]!), 'Remote Mac');
    assert.equal(controller().selectors.sessionMeta(linkedCatalog[3]!), 'Ubuntu');
  });

  it('builds row mutations once, so the rail below it is not rebuilt per render', async () => {
    const { root } = installReactRenderer();
    const stableInput = input(linkedCatalog, 'child');
    await act(async () => renderController(root, stableInput));
    const first = controller().commands;
    await act(async () => renderController(root, { ...stableInput }));

    assert.equal(controller().commands, first);
  });

  it('names a session location only for a project that has more than one', async () => {
    const { root } = installReactRenderer();
    const linked: ProjectRecord = {
      id: 'linked',
      name: 'Linked',
      locations: [
        { path: '/repo', isWorktree: false },
        { path: '/repo-feature', isWorktree: true },
      ],
      available: true,
    };
    const catalog = [
      session('main', { projectId: 'linked', cwd: '/repo' }),
      session('feature', { projectId: 'linked', cwd: '/repo-feature' }),
      session('elsewhere', { projectId: 'linked', cwd: '/elsewhere' }),
      session('single', { projectId: 'project', cwd: '/repo' }),
    ];
    await act(async () =>
      renderController(root, {
        ...input(catalog, 'main'),
        projectScopes: [localScope(linked), localProjectScope],
      }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), '/repo');
    assert.equal(controller().selectors.sessionLocation(catalog[1]!), '/repo-feature');
    assert.equal(controller().selectors.sessionLocation(catalog[2]!), undefined);
    assert.equal(controller().selectors.sessionLocation(catalog[3]!), undefined);
  });

  it('matches Windows locations across mixed separators and case', async () => {
    const { root } = installReactRenderer();
    const windows: ProjectRecord = {
      id: 'windows',
      name: 'Windows',
      locations: [
        { path: 'C:\\Repo', isWorktree: false },
        { path: 'C:\\Repo-Feature', isWorktree: true },
      ],
      available: true,
    };
    const catalog = [
      session('main', { projectId: 'windows', cwd: 'c:/repo' }),
      session('feature', { projectId: 'windows', cwd: 'c:/repo-feature' }),
    ];
    await act(async () =>
      renderController(root, { ...input(catalog, 'main'), projectScopes: [localScope(windows)] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), 'C:\\Repo');
    assert.equal(controller().selectors.sessionLocation(catalog[1]!), 'C:\\Repo-Feature');
    // The worktree mark reads the same comparison, so a forward-slash cwd must
    // still find the backslash location it names.
    assert.equal(controller().selectors.worktreeSessionIds.has('feature'), true);
  });

  it('matches a Windows drive root across case and separators', async () => {
    const { root } = installReactRenderer();
    const windows: ProjectRecord = {
      id: 'windows',
      name: 'Windows',
      locations: [
        { path: 'C:\\', isWorktree: false },
        { path: 'C:\\Feature', isWorktree: true },
      ],
      available: true,
    };
    const catalog = [session('root', { projectId: 'windows', cwd: 'c:/' })];
    await act(async () =>
      renderController(root, { ...input(catalog, 'root'), projectScopes: [localScope(windows)] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), 'C:\\');
  });

  it('keeps double-slash POSIX locations case-sensitive', async () => {
    const { root } = installReactRenderer();
    const posix: ProjectRecord = {
      id: 'posix',
      name: 'POSIX',
      locations: [
        { path: '//Repo', isWorktree: false },
        { path: '//Repo-Feature', isWorktree: true },
      ],
      available: true,
    };
    const catalog = [
      session('different-case', { projectId: 'posix', cwd: '//repo-feature' }),
      session('exact-case', { projectId: 'posix', cwd: '//Repo-Feature' }),
    ];
    await act(async () =>
      renderController(root, { ...input(catalog, 'exact-case'), projectScopes: [localScope(posix)] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), undefined);
    assert.equal(controller().selectors.worktreeSessionIds.has('different-case'), false);
    assert.equal(controller().selectors.sessionLocation(catalog[1]!), '//Repo-Feature');
    assert.equal(controller().selectors.worktreeSessionIds.has('exact-case'), true);
  });

  it('matches explicit UNC locations against forward-slash session paths', async () => {
    const { root } = installReactRenderer();
    const windows: ProjectRecord = {
      id: 'windows-unc',
      name: 'Windows UNC',
      locations: [
        { path: '\\\\Server\\Repo', isWorktree: false },
        { path: '\\\\Server\\Repo-Feature', isWorktree: true },
      ],
      available: true,
    };
    const catalog = [
      session('unc-feature', { projectId: 'windows-unc', cwd: '//server/repo-feature' }),
    ];
    await act(async () =>
      renderController(root, { ...input(catalog, 'unc-feature'), projectScopes: [localScope(windows)] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), '\\\\Server\\Repo-Feature');
    assert.equal(controller().selectors.worktreeSessionIds.has('unc-feature'), true);
  });

  it('does not match a Host-workspace session against local project locations', async () => {
    const { root } = installReactRenderer();
    const linked: ProjectRecord = {
      id: 'linked',
      name: 'Linked',
      locations: [
        { path: '/repo', isWorktree: false },
        { path: '/repo-feature', isWorktree: true },
      ],
      available: true,
    };
    const catalog = [
      session('remote', {
        runtimeHostId: 'remote-host',
        projectId: 'linked',
        cwd: '/repo-feature',
        profileId: 'remote-profile',
        profileName: 'Remote Mac',
        profileKind: 'remote',
      }),
    ];
    await act(async () =>
      renderController(root, { ...input(catalog, 'remote'), projectScopes: [localScope(linked)] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), undefined);
  });
});

describe('useSessionNavigationReads', () => {
  let latestReads: ReturnType<typeof useSessionNavigationReads> | undefined;
  let latestRail: SessionRailData | undefined;

  function ReadsProbe(props: Parameters<typeof useSessionNavigationReads>[0]) {
    latestReads = useSessionNavigationReads(props);
    return null;
  }

  function RailProbe() {
    latestRail = useSessionRailData();
    return null;
  }

  afterEach(() => {
    latestReads = undefined;
    latestRail = undefined;
  });

  it('projects linked, archived, hidden, side-conversation, Project, and Runtime Host Sessions once', async () => {
    const { root } = installReactRenderer();
    const catalog = createSessionCatalogController();
    catalog.commitSessions(linkedCatalog);
    await act(async () =>
      root.render(
        navigationTree(
          catalog,
          { activeSessionId: 'child', workHubActive: false },
          createElement(ReadsProbe, { catalog, activeSessionId: 'child' }),
          createElement(RailProbe),
        ),
      ),
    );

    assert.ok(latestReads);
    assert.ok(latestRail);
    assert.deepEqual(
      latestRail.sessions.map(({ id }) => id),
      ['root', 'remote', 'environment'],
    );
    assert.equal(latestRail.activeId, 'root');
    assert.equal(latestReads.activeParentSession?.id, 'root');

    await act(async () =>
      root.render(
        navigationTree(
          catalog,
          { activeSessionId: 'side-conversation', workHubActive: false },
          createElement(ReadsProbe, { catalog, activeSessionId: 'side-conversation' }),
          null,
        ),
      ),
    );
    assert.equal(latestReads.activeParentSession?.id, 'root');
  });
});

describe('SessionNavigationProvider selection', () => {
  it('subscribes to streaming membership inside the rail without waking its parent', async () => {
    const { root } = installReactRenderer();
    const catalog = createSessionCatalogController();
    catalog.commitSessions(linkedCatalog);
    const sessionUi = createProductionSessionUiStateController();
    let parentRenders = 0;
    let railRenders = 0;
    let rail!: SessionRailData;
    function Rail() {
      railRenders += 1;
      rail = useSessionRailData();
      return null;
    }
    function Parent() {
      parentRenders += 1;
      return navigationTree(catalog, { activeSessionId: 'root', workHubActive: false },
        null, createElement(Rail), sessionUi.reads.streaming);
    }
    await act(async () => root.render(createElement(Parent)));
    const initialParent = parentRenders;
    const initialRail = railRenders;
    await act(async () => sessionUi.setExecution('remote', {
      type: 'host_execution', available: true,
      rootTurn: { sessionId: 'remote', turnId: 'turn', runId: 'run', status: 'running' },
    }));
    assert.equal(rail.streamingSessionIds?.has('remote'), false);
    assert.equal(railRenders, initialRail);
    assert.equal(parentRenders, initialParent);
    await act(async () => sessionUi.setLiveTurnBySession((state) => ({
      ...state,
      remote: [{ turnId: 'turn', steps: [{ stepId: 'message', tools: [],
        text: { text: 'a token', complete: false, truncated: false } }] }],
    })));
    assert.equal(rail.streamingSessionIds?.has('remote'), true);
    assert.equal(railRenders, initialRail + 1);
    await act(async () => sessionUi.setLiveTurnBySession((state) => ({
      ...state,
      remote: [{ turnId: 'turn', steps: [{ stepId: 'message', tools: [],
        text: { text: 'another token', complete: false, truncated: false } }] }],
    })));
    assert.equal(railRenders, initialRail + 1);
    await act(async () => sessionUi.clearSessionUiState('remote'));
    assert.equal(rail.streamingSessionIds?.has('remote'), false);
    assert.equal(railRenders, initialRail + 2);
    assert.equal(parentRenders, initialParent);
    await act(async () => root.unmount());
  });

  it('drops the picks when WorkHub stops painting the open row', async () => {
    let latest: SessionRailSelection | null = null;
    function SelectionProbe() {
      latest = useSessionRailSelection();
      return null;
    }
    const { root } = installReactRenderer();
    const catalog = createSessionCatalogController();
    catalog.commitSessions(linkedCatalog);
    const render = (workHubActive: boolean) =>
      act(async () =>
        root.render(
          navigationTree(
            catalog,
            { activeSessionId: 'root', workHubActive },
            null,
            createElement(SelectionProbe),
          ),
        ),
      );
    const selection = () => {
      assert.ok(latest);
      return latest;
    };

    await render(false);
    await act(async () =>
      selection().commands.pick({
        sessionId: 'root',
        pick: 'replace',
        orderedSessionIds: ['root', 'remote', 'environment'],
      }),
    );
    assert.deepEqual([...selection().selectedIds], ['root']);

    await render(true);

    assert.deepEqual([...selection().selectedIds], []);
  });
});

describe('createSessionOpenCommand', () => {
  it('distinguishes successive jumps even when the clock does not advance', (t) => {
    t.mock.method(Date, 'now', () => 1);
    const targets: Array<{ nonce: number } | null> = [];
    const deps = {
      activateSession() {}, exitWorkHub() {}, selectSessionSurface() {},
      setSearchTarget: (target: { nonce: number } | null) => targets.push(target),
    };
    const open = createSessionOpenCommand(deps);
    open('a', 'turn-1', 1);
    open('a', 'turn-1', 1);
    createSessionOpenCommand(deps)('a', 'turn-1', 1);
    assert.equal(new Set(targets.map((target) => target!.nonce)).size, 3);
  });

  it('orders the jump and preserves turn-target clearing semantics', () => {
    const calls: string[] = [];
    const targets: unknown[] = [];
    const openSession = createSessionOpenCommand({
      activateSession: (sessionId) => calls.push(`activate:${sessionId}`),
      exitWorkHub: () => calls.push('exit-workhub'),
      selectSessionSurface: () => calls.push('select-sessions'),
      setSearchTarget: (target) => targets.push(target),
    });

    openSession('a', 'turn-2', 9);
    openSession('a');

    assert.deepEqual(calls, [
      'exit-workhub',
      'select-sessions',
      'activate:a',
      'exit-workhub',
      'select-sessions',
      'activate:a',
    ]);
    assert.equal(typeof (targets[0] as { nonce: unknown }).nonce, 'number');
    assert.deepEqual(
      { ...(targets[0] as Record<string, unknown>), nonce: 0 },
      { sessionId: 'a', turnId: 'turn-2', sequence: 9, nonce: 0 },
    );
    assert.equal(targets[1], null);
  });
});
