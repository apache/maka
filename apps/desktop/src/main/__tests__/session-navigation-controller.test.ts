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
  SessionNavigationServicesProvider,
  useSessionNavigationController,
  type SessionNavigationController,
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
        { services: createFakeSessionNavigationServices() },
        createElement(ControllerProbe, input),
      ),
    }),
  );
}

function controller(): SessionNavigationController {
  assert.ok(latestController);
  return latestController;
}

function input(
  sessions: SessionNavigationSession[],
  activeSessionId: string | undefined,
  calls: string[] = [],
  targets: unknown[] = [],
): UseSessionNavigationControllerInput {
  return {
    sessions,
    activeSessionId,
    hiddenSessionIds: new Set(['hidden']),
    projects: [project],
    activateSession: (sessionId) => calls.push(`activate:${sessionId ?? 'none'}`),
    clearActiveMessages: () => calls.push('clear-messages'),
    clearSessionRendererState: (sessionId) => calls.push(`clear:${sessionId}`),
    exitWorkHub: () => calls.push('exit-workhub'),
    refreshSessions: async () => sessions,
    selectSessionSurface: () => calls.push('select-sessions'),
    setSearchTarget: (target) => targets.push(target),
    toastApi: {
      success: () => undefined,
      error: () => undefined,
      confirm: async () => true,
    },
  };
}

afterEach(() => {
  latestController = undefined;
  cleanupFakeDom();
});

describe('useSessionNavigationController', () => {
  it('projects linked, archived, hidden, Project, and Runtime Host Sessions once', async () => {
    const { root } = installReactRenderer();
    const sessions = [
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
      session('archived', { isArchived: true }),
      session('hidden'),
    ];

    await act(async () => renderController(root, input(sessions, 'child')));

    assert.deepEqual(
      controller().selectors.visibleSessions.map(({ id }) => id),
      ['root', 'remote'],
    );
    assert.equal(controller().selectors.activeRowId, 'root');
    assert.equal(controller().selectors.activeParentSession?.id, 'root');
    assert.deepEqual(controller().selectors.branchBanner, {
      parentSessionId: 'root',
      parentSessionName: 'root',
    });
    assert.deepEqual(
      controller().selectors.groups.map(({ id }) => id),
      ['project:project', 'runtime-host:remote-profile'],
    );
    assert.equal(controller().selectors.sessionMeta(sessions[2]!), 'Remote Mac');
  });

  it('owns Session jumps and preserves turn-target clearing semantics', async () => {
    const { root } = installReactRenderer();
    const calls: string[] = [];
    const targets: unknown[] = [];
    const sessions = [session('a')];
    await act(async () => renderController(root, input(sessions, undefined, calls, targets)));

    await act(async () => controller().commands.openSession('a', 'turn-2', 9));
    await act(async () => controller().commands.openSession('a'));

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
