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
  activeSessionId: string | undefined,
  calls: string[] = [],
): SessionNavigationPorts {
  return {
    activeIdRef: { current: activeSessionId },
    sessionsRef: { current: sessions },
    pendingSessionRowActionsRef: { current: new Set<string>() },
    activateSession: (sessionId) => calls.push(`activate:${sessionId ?? 'none'}`),
    clearActiveMessages: () => calls.push('clear-messages'),
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

  it('projects linked, archived, hidden, Project, and Runtime Host Sessions once', async () => {
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
