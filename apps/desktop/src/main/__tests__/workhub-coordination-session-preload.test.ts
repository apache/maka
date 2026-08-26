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
import { parseDesktopSessionKey } from '../../shared/runtime-host-identity.js';
import {
  resolveDesktopWorkHubCoordinationCreateScope,
  resolveDesktopWorkHubCoordinationSession,
} from '../../preload/workhub-coordination-session.js';

test('resolves the Coordination Session through the currently active Runtime Host scope', async () => {
  const scopes = [
    { hostId: 'host-a', targetEpoch: 'epoch-a' },
    { hostId: 'host-b', targetEpoch: 'epoch-b' },
  ];
  let active = 0;
  const seen: typeof scopes = [];
  const resolve = () =>
    resolveDesktopWorkHubCoordinationSession(
      async () => scopes[active]!,
      async (scope) => {
        seen.push(scope);
        return { sessionId: 'maka_workhub_coordination' };
      },
    );

  const first = await resolve();
  active = 1;
  const second = await resolve();

  assert.deepEqual(seen, scopes);
  assert.deepEqual(parseDesktopSessionKey(first), {
    hostId: 'host-a',
    sessionId: 'maka_workhub_coordination',
  });
  assert.deepEqual(parseDesktopSessionKey(second), {
    hostId: 'host-b',
    sessionId: 'maka_workhub_coordination',
  });
});

test('creates against the Coordination Session Host instead of later UI focus', async () => {
  const coordination = JSON.stringify(['host-a', 'maka_workhub_coordination']);
  const scopeA = { hostId: 'host-a', targetEpoch: 'epoch-a' };
  const scope = await resolveDesktopWorkHubCoordinationCreateScope(
    coordination,
    async (sessionId) => {
      assert.equal(sessionId, coordination);
      return { scope: scopeA, sessionId: 'maka_workhub_coordination' };
    },
  );

  assert.equal(scope, scopeA);
  await assert.rejects(
    resolveDesktopWorkHubCoordinationCreateScope(
      JSON.stringify(['host-a', 'ordinary']),
      async () => ({ scope: scopeA, sessionId: 'ordinary' }),
    ),
    /Invalid WorkHub Coordination Session identity/,
  );
});
