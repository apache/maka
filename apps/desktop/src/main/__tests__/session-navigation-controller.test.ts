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
import { act, createElement } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import { LocaleProvider } from '@maka/ui';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  createFakeSessionNavigationServices,
  createSessionOpenCommand,
  deriveSessionRail,
  sessionMatchesRail,
  SessionNavigationServicesProvider,
  useSessionNavigationController,
  useSessionNavigationReads,
  type SessionNavigationController,
  type SessionNavigationPorts,
  type SessionNavigationSession,
  type UseSessionNavigationControllerInput,
} from '../../renderer/features/session-navigation/testing.js';

function session(
  id: string,
  overrides: Partial<SessionNavigationSession> = {},
): SessionNavigationSession {
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
    ...overrides,
  };
}

const project: ProjectRecord = {
  id: 'project',
  name: 'Project',
  locations: [{ path: '/repo', isWorktree: false }],
  available: true,
};

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
    pendingSessionRowActionsRef: { current: new Set<string>() },
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
    projects: [project],
    ports: ports(sessions, activeSessionId, calls),
  };
}

const linkedCatalog = [
  session('root', { projectId: 'project', cwd: '/repo' }),
  session('child', {
    parentSessionId: 'root',
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
    profileId: 'remote-profile',
    profileName: 'Remote Mac',
    profileKind: 'remote',
  }),
  session('environment', {
    profileId: 'wsl-ubuntu',
    profileName: 'Ubuntu',
    profileKind: 'environment',
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
  it('groups the rail by Project and Runtime Host, and names Host-workspace rows', async () => {
    const { root } = installReactRenderer();
    await act(async () => renderController(root, input(linkedCatalog, 'child')));

    assert.deepEqual(
      controller().selectors.groups.map(({ id }) => id),
      ['project:project', 'runtime-host:remote-profile', 'runtime-host:wsl-ubuntu'],
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
        projects: [linked, project],
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
      renderController(root, { ...input(catalog, 'main'), projects: [windows] }),
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
      renderController(root, { ...input(catalog, 'root'), projects: [windows] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), 'C:\\');
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
        projectId: 'linked',
        cwd: '/repo-feature',
        profileId: 'remote-profile',
        profileName: 'Remote Mac',
        profileKind: 'remote',
      }),
    ];
    await act(async () =>
      renderController(root, { ...input(catalog, 'remote'), projects: [linked] }),
    );

    assert.equal(controller().selectors.sessionLocation(catalog[0]!), undefined);
  });
});

describe('useSessionNavigationReads', () => {
  let latestReads: ReturnType<typeof useSessionNavigationReads> | undefined;

  function ReadsProbe(props: Parameters<typeof useSessionNavigationReads>[0]) {
    latestReads = useSessionNavigationReads(props);
    return null;
  }

  afterEach(() => {
    latestReads = undefined;
  });

  it('projects linked, archived, hidden, side-conversation, Project, and Runtime Host Sessions once', async () => {
    const { root } = installReactRenderer();
    await act(async () =>
      root.render(
        createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(ReadsProbe, {
            sessions: linkedCatalog,
            activeSessionId: 'child',
            activeSession: linkedCatalog[1],
            hiddenSessionIds,
          }),
        }),
      ),
    );

    assert.ok(latestReads);
    assert.deepEqual(
      latestReads.rail.sessions.map(({ id }) => id),
      ['root', 'remote', 'environment'],
    );
    assert.equal(latestReads.rail.activeRowId, 'root');
    assert.equal(latestReads.rail.activeParentSession?.id, 'root');
    assert.deepEqual(latestReads.branchBanner, {
      parentSessionId: 'root',
      parentSessionName: 'root',
    });
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
