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
import type { SearchError, SearchResult } from '@maka/core/search';
import { deferred } from '@maka/core/test-only/async-primitives';
import { collectThreadSearchResponses, createThreadSearchClient } from '../../preload/multi-host-thread-search.js';

const RESULT: SearchResult = {
  source: 'thread',
  title: 'Match',
};
const ERROR: SearchError = {
  ok: false,
  reason: 'provider_error',
  message: 'Host A failed',
};

function result(title: string): SearchResult {
  return { source: 'thread', title };
}

test('preserves total multi-Host search failure without discarding partial success', async () => {
  await assert.rejects(
    collectThreadSearchResponses(
      [
        Promise.reject(new Error('Host A unavailable')),
        Promise.reject(new Error('Host B unavailable')),
      ],
      10,
    ),
    /Host A unavailable/,
  );

  assert.deepEqual(
    await collectThreadSearchResponses(
      [Promise.reject(new Error('Host A unavailable')), Promise.resolve([RESULT])],
      10,
    ),
    [RESULT],
  );

  assert.deepEqual(
    await collectThreadSearchResponses([Promise.resolve(ERROR)], 10),
    ERROR,
  );
});

test('shares a bounded result window across ready Hosts', async () => {
  assert.deepEqual(
    await collectThreadSearchResponses(
      [
        Promise.resolve([result('A1'), result('A2')]),
        Promise.resolve([result('B1'), result('B2')]),
      ],
      3,
    ),
    [result('A1'), result('B1'), result('A2')],
  );
});

test('canceling before Host discovery finishes never dispatches the abandoned search', async () => {
  const scopes = deferred<readonly string[]>();
  const calls: string[] = [];
  const client = createThreadSearchClient({
    scopes: () => scopes.promise,
    search: async (scope: string) => { calls.push(scope); return []; },
    cancel: async () => {},
  });
  const task = client.thread({ source: 'thread', query: 'old', limit: 10 }, 'old');
  await client.cancelThread('old');
  assert.deepEqual(await task, { ok: false, reason: 'aborted', message: 'History search was aborted.' });
  scopes.resolve(['a', 'b']);
  await Promise.resolve();
  assert.deepEqual(calls, []);
});

test('canceling a multi-Host query reaches every dispatched Host without waiting for search results', async () => {
  const started = deferred<void>();
  const cancelled: string[] = [];
  let count = 0;
  const client = createThreadSearchClient({
    scopes: async () => ['a', 'b'],
    search: async () => { if (++count === 2) started.resolve(); return new Promise<never>(() => {}); },
    cancel: async (scope, requestId) => { cancelled.push(`${scope}:${requestId}`); },
  });
  const task = client.thread({ source: 'thread', query: 'old', limit: 10 }, 'old');
  await started.promise;
  await client.cancelThread('old');
  assert.equal((await task as SearchError).reason, 'aborted');
  assert.deepEqual(cancelled, ['a:old', 'b:old']);
  await client.cancelThread('old');
  assert.equal(cancelled.length, 2);
});
