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
import type { SessionStorageUsage } from '@maka/runtime-host/protocol';
import { createSessionStorageLoader } from '../../renderer/features/storage-usage/testing.js';

function usage(sessionId: string): SessionStorageUsage {
  return { sessionId, bytes: { transcript: 1, runtime: 2, artifacts: 3 }, worktreeCount: 0 };
}

test('rows that mount together share bounded queries and are measured once', async () => {
  const queries: string[][] = [];
  const loader = createSessionStorageLoader(async (sessionIds) => {
    queries.push([...sessionIds]);
    return Object.fromEntries(sessionIds.map((id) => [id, usage(id)]));
  });
  const ids = Array.from({ length: 101 }, (_, index) => `session-${index}`);
  const measured = await Promise.all([...ids, 'session-0'].map((id) => loader.load(id)));
  assert.deepEqual(
    queries.map((query) => query.length),
    [100, 1],
  );
  assert.equal(measured[0]?.sessionId, 'session-0');
  assert.equal(measured[101], measured[0]);

  await loader.load('session-5');
  assert.equal(queries.length, 2, 'a measured row is served from the list cache');
});

test('a failed or missing measurement renders nothing and is retried later', async () => {
  let fail = true;
  const queries: string[][] = [];
  const loader = createSessionStorageLoader(async (sessionIds) => {
    queries.push([...sessionIds]);
    if (fail) throw new Error('Runtime Host unavailable');
    return { 'session-a': usage('session-a') };
  });
  assert.equal(await loader.load('session-a'), undefined);
  fail = false;
  assert.equal((await loader.load('session-a'))?.sessionId, 'session-a');
  assert.equal(await loader.load('session-gone'), undefined);
  assert.equal(await loader.load('session-gone'), undefined);
  assert.deepEqual(queries, [['session-a'], ['session-a'], ['session-gone'], ['session-gone']]);
});
