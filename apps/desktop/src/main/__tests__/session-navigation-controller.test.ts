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
import { LocaleProvider, useSessionRailData, type SessionRailData } from '@maka/ui';
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
        createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(
            SessionNavigationServicesProvider,
            { services: fakeServices },
            createElement(ReadsProbe, { catalog, activeSessionId: 'child' }),
            createElement(
              SessionNavigationProvider,
              {
                catalog,
                activeSessionId: 'child',
                hiddenSessionIds,
                projectScopes: [localProjectScope],
                streamingSessionIds: new Set<string>(),
                sessionSendOutcomes: {},
                ports: ports(linkedCatalog, 'child'),
                commandsRef: { current: null },
                selection: { section: 'sessions' },
                workHubActive: false,
                onSelect: () => undefined,
                onOpenSettings: () => undefined,
                onNew: () => undefined,
                onExitWorkHub: () => undefined,
                onSelectSession: () => undefined,
              },
              createElement(RailProbe),
            ),
          ),
        }),
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
