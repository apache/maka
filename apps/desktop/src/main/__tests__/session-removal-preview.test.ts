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
  SESSION_REMOVE_PREVIEW_MAX_ITEMS,
  type SessionRemovePreviewInput,
  type SessionRemovePreviewResult,
} from '@maka/runtime-host/protocol';
import { forEachHostSessionPage } from '../../preload/host-session-pages.js';
import { createSessionRemovalPreviewReader } from '../../preload/session-removal-preview.js';

/** Desktop ids read `<host>:<id>`. */
const resolve = async (sessionId: string) => {
  const [host = '', id = ''] = sessionId.split(':');
  if (host === 'gone') throw new Error('The Runtime Host for this task is unavailable');
  return { scope: host, scopeKey: host, sessionId: id };
};

test('pages each Host one bounded request at a time, Hosts side by side', async () => {
  const pages: Array<[string, readonly string[]]> = [];
  const inFlight = new Map<string, number>();
  let maxPerHost = 0;
  let maxOverall = 0;
  const ids = [
    ...Array.from({ length: 2 * 3 + 1 }, (_, index) => `a:${index}`),
    'b:x',
    'b:y',
    'a:0',
  ];
  await forEachHostSessionPage(ids, { resolve, pageSize: 3 }, async (page) => {
    pages.push([page.scopeKey, page.hostIds]);
    inFlight.set(page.scopeKey, (inFlight.get(page.scopeKey) ?? 0) + 1);
    maxPerHost = Math.max(maxPerHost, inFlight.get(page.scopeKey)!);
    maxOverall = Math.max(maxOverall, [...inFlight.values()].reduce((sum, count) => sum + count, 0));
    assert.equal(page.desktopIds.get(page.hostIds[0]!), `${page.scopeKey}:${page.hostIds[0]}`);
    await new Promise((settle) => setImmediate(settle));
    inFlight.set(page.scopeKey, inFlight.get(page.scopeKey)! - 1);
  });
  assert.deepEqual(
    pages.filter(([host]) => host === 'a').map(([, hostIds]) => hostIds),
    [['0', '1', '2'], ['3', '4', '5'], ['6']],
  );
  assert.deepEqual(
    pages.filter(([host]) => host === 'b').map(([, hostIds]) => hostIds),
    [['x', 'y']],
  );
  assert.equal(maxPerHost, 1, 'no Host has two pages in flight');
  assert.equal(maxOverall, 2, 'two Hosts are asked side by side');
});

test('rejects on any failure unless told to tolerate, then skips only that Host', async () => {
  const fail = async (page: { scopeKey: string }) => {
    if (page.scopeKey === 'b') throw new Error('persistence_failed');
  };
  await assert.rejects(
    forEachHostSessionPage(['a:1', 'b:2'], { resolve, pageSize: 3 }, fail),
    /persistence_failed/,
  );
  await assert.rejects(
    forEachHostSessionPage(['a:1', 'gone:2'], { resolve, pageSize: 3 }, async () => undefined),
    /unavailable/,
  );

  const failed: string[] = [];
  const visited: string[] = [];
  await forEachHostSessionPage(
    ['a:1', 'b:2', 'gone:3', 'c:4'],
    {
      resolve,
      pageSize: 3,
      tolerate: {
        skip: (scopeKey) => scopeKey === 'c',
        failed: (scopeKey) => failed.push(scopeKey),
      },
    },
    async (page) => {
      visited.push(page.scopeKey);
      await fail(page);
    },
  );
  assert.deepEqual(visited.sort(), ['a', 'b']);
  assert.deepEqual(failed, ['b']);
});

test('sums preview pages, forwarding the options with each page', async () => {
  const queries: SessionRemovePreviewInput[] = [];
  const preview = createSessionRemovalPreviewReader<string>({
    resolve,
    query: async (_host, input): Promise<SessionRemovePreviewResult> => {
      queries.push(input);
      const n = input.sessionIds.length;
      return {
        archivableSubtaskCount: n,
        removedSubtaskCount: 2 * n,
        worktreeCount: 3 * n,
        ...(input.measureBytes ? { bytes: 100 * n } : {}),
      };
    },
  });
  const ids = Array.from({ length: SESSION_REMOVE_PREVIEW_MAX_ITEMS + 1 }, (_, index) => `a:${index}`);

  assert.deepEqual(await preview([...ids, 'b:x'], { measureBytes: true, requireArchived: true }), {
    archivableSubtaskCount: ids.length + 1,
    removedSubtaskCount: 2 * (ids.length + 1),
    worktreeCount: 3 * (ids.length + 1),
    bytes: 100 * (ids.length + 1),
  });
  assert.deepEqual(
    queries.map((query) => [query.sessionIds.length, query.measureBytes, query.requireArchived]).sort(),
    [
      [SESSION_REMOVE_PREVIEW_MAX_ITEMS, true, true],
      [1, true, true],
      [1, true, true],
    ].sort(),
  );
  // A single delete's preview asks for no bytes, and reports none.
  queries.length = 0;
  assert.deepEqual(await preview(['a:1']), {
    archivableSubtaskCount: 1,
    removedSubtaskCount: 2,
    worktreeCount: 3,
  });
  assert.deepEqual(queries, [{ sessionIds: ['1'] }]);
});

test('reports no bytes when any page could not measure them', async () => {
  const preview = createSessionRemovalPreviewReader<string>({
    resolve,
    query: async (host) => ({
      archivableSubtaskCount: 0,
      removedSubtaskCount: 0,
      worktreeCount: 0,
      ...(host === 'a' ? { bytes: 10 } : {}),
    }),
  });
  assert.equal('bytes' in (await preview(['a:1', 'b:1'], { measureBytes: true })), false);
  assert.equal((await preview(['a:1', 'a:2'], { measureBytes: true })).bytes, 10);
});
