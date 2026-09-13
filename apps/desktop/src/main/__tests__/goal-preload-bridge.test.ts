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
import {
  invokeProjectedSessionRuntimeHost,
} from '../../preload/projected-session-runtime-host.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';

test('Goal arm preload routing preserves target scope and projects every outcome', async () => {
  const scope = { hostId: 'host-1', targetEpoch: 'epoch-2' };
  const desktopSessionId = desktopSessionKey({
    hostId: scope.hostId,
    sessionId: 'session-1',
  });
  const request = { condition: 'Finish', maxIterations: 20, tokenBudget: 1_000 };
  const scenarios = [
    {
      wire: {
        kind: 'armed',
        goal: { id: 'goal-1', sessionId: 'session-1' },
      },
      projected: {
        kind: 'armed',
        goal: { id: 'goal-1', sessionId: desktopSessionId },
      },
    },
    {
      wire: {
        kind: 'reconciled',
        currentGoal: { id: 'goal-2', sessionId: 'session-1' },
        matchesRequestedState: true,
      },
      projected: {
        kind: 'reconciled',
        currentGoal: { id: 'goal-2', sessionId: desktopSessionId },
        matchesRequestedState: true,
      },
    },
    {
      wire: { kind: 'reconciliation_unavailable' },
      projected: { kind: 'reconciliation_unavailable' },
    },
  ] as const;

  for (const scenario of scenarios) {
    const invocations: unknown[] = [];
    const result = await invokeProjectedSessionRuntimeHost(
      async (sessionId) => {
        assert.equal(sessionId, desktopSessionId);
        return { scope, sessionId: 'session-1' };
      },
      async (channel, targetScope, rawSessionId, ...args) => {
        invocations.push({ channel, targetScope, rawSessionId, args });
        return scenario.wire;
      },
      'goal:arm',
      desktopSessionId,
      request,
    );

    assert.deepEqual(invocations, [
      {
        channel: 'goal:arm',
        targetScope: scope,
        rawSessionId: 'session-1',
        args: [request],
      },
    ]);
    assert.deepEqual(result, scenario.projected);
  }
});
