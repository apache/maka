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
import test from 'node:test';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { scopeWorkHubSessionsToCoordinationHost } from '../../renderer/workhub-coordination-host-scope.js';
import {
  startWorkHubCoordinationLifecycle,
  type WorkHubCoordinationHostChange,
} from '../../renderer/workhub-coordination-lifecycle.js';
import type { WorkHubDesktopSessionBridge } from '../../renderer/workhub-session-port.js';

test('WorkHub projections follow the resolved Coordination Session Host only', async () => {
  const sessionA = desktopSessionKey({ hostId: 'host-a', sessionId: 'ordinary-a' });
  const sessionB = desktopSessionKey({ hostId: 'host-b', sessionId: 'ordinary-b' });
  let coordinationSessionId: string | undefined;
  let coordinationGeneration = 0;
  let activeHostId = 'host-a';
  let hostChange: ((event: WorkHubCoordinationHostChange) => void) | undefined;
  const baseSessions: WorkHubDesktopSessionBridge = {
    list: async () => [ordinarySession(sessionA), ordinarySession(sessionB)],
    listWithCoverage: async () => ({
      sessions: [ordinarySession(sessionA), ordinarySession(sessionB)],
      completeHostIds: ['host-a', 'host-b'],
    }),
    listTurns: async () => [],
    queryMessageExecutions: async () => ({ resolutions: [] }),
    subscribeChanges: () => () => undefined,
  };
  const scopeSessions = () => {
    const generation = coordinationGeneration;
    return scopeWorkHubSessionsToCoordinationHost(
      baseSessions,
      {
        sessionId: coordinationSessionId,
        isCurrent: () => generation === coordinationGeneration,
      },
    );
  };
  let sessions = scopeSessions();
  const stop = startWorkHubCoordinationLifecycle({
    resolve: async () =>
      desktopSessionKey({
        hostId: activeHostId,
        sessionId: 'maka_workhub_coordination',
      }),
    subscribeHostChanges(handler) {
      hostChange = handler;
      return () => undefined;
    },
    subscribeAvailabilityChanges: () => () => undefined,
    onResolving: () => {
      coordinationGeneration += 1;
      coordinationSessionId = undefined;
      sessions = scopeSessions();
    },
    onResolved: (sessionId) => {
      coordinationSessionId = sessionId;
      sessions = scopeSessions();
    },
    reportFailure: (error) => assert.fail(error instanceof Error ? error.message : String(error)),
  });

  const unresolvedList = sessions.list();
  assert.deepEqual(await unresolvedList, []);
  await Promise.resolve();
  assert.deepEqual((await sessions.list()).map((session) => session.id), [sessionA]);
  await assert.rejects(
    () => sessions.listTurns(sessionB),
    /another Runtime Host/,
  );
  assert.deepEqual(await sessions.listWithCoverage?.(), {
    sessions: [ordinarySession(sessionA)],
    completeHostIds: ['host-a'],
  });
  const staleHostAScope = sessions;

  activeHostId = 'host-b';
  hostChange?.({ isDefault: true, readiness: 'ready' });
  assert.deepEqual(await sessions.list(), []);
  await Promise.resolve();
  assert.deepEqual((await sessions.list()).map((session) => session.id), [sessionB]);
  await assert.rejects(staleHostAScope.listTurns(sessionA), /scope is revoked/);
  stop();
});

function ordinarySession(id: string): Awaited<ReturnType<WorkHubDesktopSessionBridge['list']>>[number] {
  return {
    id,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
  };
}
