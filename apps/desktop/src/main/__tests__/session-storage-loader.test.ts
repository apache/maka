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
import { test } from 'node:test';
import {
  STORAGE_USAGE_SESSION_MAX_ITEMS,
  type SessionStorageUsage,
} from '@maka/runtime-host/protocol';
import {
  createSessionStorageLoader,
  SESSION_STORAGE_FAILURE_COOLDOWN_MS,
  SESSION_STORAGE_RESULT_TTL_MS,
} from '../../renderer/features/storage-usage/testing.js';
import { loadSessionStorageUsage } from '../../preload/session-storage-usage.js';

function usage(sessionId: string): SessionStorageUsage {
  return { sessionId, bytes: { transcript: 1, runtime: 2, artifacts: 3 }, worktreeCount: 0 };
}

test('rows that mount together are measured in bounded requests, one at a time', async () => {
  const queries: string[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const loader = createSessionStorageLoader(async (sessionIds) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    queries.push([...sessionIds]);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return Object.fromEntries(sessionIds.map((id) => [id, usage(id)]));
  });
  const count = STORAGE_USAGE_SESSION_MAX_ITEMS * 2 + 1;
  const ids = Array.from({ length: count }, (_, index) => `session-${index}`);
  const measured = await Promise.all([...ids, 'session-0'].map((id) => loader.load(id)));
  assert.deepEqual(
    queries.map((query) => query.length),
    [STORAGE_USAGE_SESSION_MAX_ITEMS, STORAGE_USAGE_SESSION_MAX_ITEMS, 1],
  );
  assert.equal(maxInFlight, 1);
  assert.equal(measured[count], measured[0]);
  await loader.load('session-5');
  assert.equal(queries.length, 3, 'a fresh measurement is served from the cache');
});

test('failures and unknown tasks wait out a cooldown; measured sizes expire', async () => {
  let now = 0;
  let fail = true;
  const queries: string[][] = [];
  const loader = createSessionStorageLoader(
    async (sessionIds) => {
      queries.push([...sessionIds]);
      if (fail) throw new Error('Runtime Host unavailable');
      return { 'session-a': usage('session-a') };
    },
    { now: () => now },
  );
  assert.equal(await loader.load('session-a'), undefined);
  fail = false;
  assert.equal(await loader.load('session-a'), undefined, 'a remount inside the cooldown waits');
  now += SESSION_STORAGE_FAILURE_COOLDOWN_MS;
  assert.equal((await loader.load('session-a'))?.sessionId, 'session-a');
  assert.equal(await loader.load('session-gone'), undefined);
  assert.equal(await loader.load('session-gone'), undefined);
  now += SESSION_STORAGE_RESULT_TTL_MS;
  await loader.load('session-a');
  assert.deepEqual(queries, [['session-a'], ['session-a'], ['session-gone'], ['session-a']]);
});

test('preload keeps one Host’s task sizes when another Host fails', async () => {
  const routes: Record<string, { scope: string; sessionId: string }> = {
    'desktop-a1': { scope: 'host-a', sessionId: 'a1' },
    'desktop-a2': { scope: 'host-a', sessionId: 'a2' },
    'desktop-b1': { scope: 'host-b', sessionId: 'b1' },
  };
  const result = await loadSessionStorageUsage(
    ['desktop-a1', 'desktop-b1', 'desktop-a2', 'desktop-missing'],
    {
      resolve: async (sessionId) => {
        const route = routes[sessionId];
        if (!route) throw new Error('The Runtime Host for this task is unavailable');
        return { ...route, scopeKey: route.scope };
      },
      query: async (scope, sessionIds) => {
        if (scope === 'host-b') throw new Error('Runtime Host disconnected');
        // `a2` is not on its Host, so the Host omits it.
        return sessionIds.filter((id) => id !== 'a2').map(usage);
      },
    },
  );
  assert.deepEqual(result, { 'desktop-a1': usage('a1') });
});
