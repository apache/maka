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
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  collectRecallResponses,
  createRecallSearchClient,
  type RecallSearchError,
  type RecallSearchPassage,
} from '../../preload/multi-host-recall-search.js';

function passage(sessionId: string, anchor: string): RecallSearchPassage {
  return {
    sessionId,
    sessionTitle: sessionId,
    anchorMessageId: anchor,
    sequence: 0,
    messages: [{ messageId: anchor, role: 'user', matchKind: 'user_message', text: anchor, timestamp: 1, isAnchor: true }],
    matchedTerms: [],
    score: 1,
  };
}

function hostResponse(passages: RecallSearchPassage[], overrides: Partial<{
  gaps: string;
  searchedEverySession: boolean;
}> = {}): unknown {
  return {
    ok: true,
    result: {
      ok: true,
      passages,
      gaps: overrides.gaps ?? '',
      searchedEverySession: overrides.searchedEverySession ?? true,
    },
  };
}

function fulfilled(value: unknown): PromiseSettledResult<unknown> {
  return { status: 'fulfilled', value };
}

function rejected(reason: unknown): PromiseSettledResult<unknown> {
  return { status: 'rejected', reason };
}

function failure(reason: string, message: string): unknown {
  return { ok: false, reason, message };
}

test('interleaves Hosts so one large corpus cannot fill the window', () => {
  const merged = collectRecallResponses(
    [
      fulfilled(hostResponse([passage('a', 'a1'), passage('a', 'a2')])),
      fulfilled(hostResponse([passage('b', 'b1'), passage('b', 'b2')])),
    ],
    3,
  );
  assert.deepEqual(
    (merged as unknown as { passages: RecallSearchPassage[] }).passages.map((it) => it.anchorMessageId),
    ['a1', 'b1', 'a2'],
  );
});

test('a Host that failed contributes nothing rather than failing the search', () => {
  // One machine being down must not hide the history on the others.
  const merged = collectRecallResponses(
    [
      rejected(new Error('Host A unavailable')),
      fulfilled(hostResponse([passage('b', 'b1')])),
    ],
    10,
  );
  assert.deepEqual((merged as unknown as { passages: RecallSearchPassage[] }).passages.map((it) => it.sessionId), ['b']);
});

test('reports a Host failure when every Host failed, without inventing a result', () => {
  assert.deepEqual(
    collectRecallResponses([fulfilled(failure('incognito_active', 'privacy'))], 10),
    { ok: false, reason: 'incognito_active', message: 'privacy' },
  );
  assert.deepEqual(collectRecallResponses([rejected(new Error('down'))], 10), {
    ok: false,
    reason: 'provider_error',
    message: 'No Runtime Host is available for search',
  });
});

test('a malformed Host payload is not mistaken for a success', () => {
  const merged = collectRecallResponses(
    [{ status: 'fulfilled', value: { ok: true, result: { ok: true } } }, { status: 'fulfilled', value: 'nonsense' }],
    10,
  );
  assert.equal((merged as RecallSearchError).ok, false);
});

test('gaps describe one corpus only, and a single Host keeps its full-scan flag', () => {
  const merged = collectRecallResponses(
    [fulfilled(hostResponse([passage('a', 'a1')], { gaps: 'Searched 2 Sessions.', searchedEverySession: false }))],
    10,
  ) as unknown as { gaps: string; searchedEverySession: boolean };
  assert.equal(merged.gaps, 'Searched 2 Sessions.');
  assert.equal(merged.searchedEverySession, false);
});

test('across several Hosts the envelope is complete only if every Host scanned fully', () => {
  const merged = collectRecallResponses(
    [
      fulfilled(hostResponse([passage('a', 'a1')], { searchedEverySession: true })),
      fulfilled(hostResponse([passage('b', 'b1')], { searchedEverySession: false })),
    ],
    10,
  ) as unknown as { gaps: string; searchedEverySession: boolean };
  assert.equal(merged.searchedEverySession, false);
  // A single Host's gap sentence would describe a corpus the user did not ask
  // about separately, so a merged envelope says nothing instead of guessing.
  assert.equal(merged.gaps, '');
});

test('cancelling before Host discovery never dispatches the abandoned search', async () => {
  const scopes = deferred<readonly string[]>();
  const calls: string[] = [];
  const client = createRecallSearchClient({
    scopes: () => scopes.promise,
    search: async (scope: string) => {
      calls.push(scope);
      return hostResponse([]);
    },
    cancel: async () => {},
  });
  const task = client.recall({ terms: ['old'] }, 'old');
  await client.cancelRecall('old');
  assert.deepEqual(await task, { ok: false, reason: 'aborted', message: 'History search was aborted.' });
  scopes.resolve(['a', 'b']);
  await Promise.resolve();
  assert.deepEqual(calls, []);
});

test('cancelling reaches every dispatched Host without waiting for results', async () => {
  const started = deferred<void>();
  const cancelled: string[] = [];
  let count = 0;
  const client = createRecallSearchClient({
    scopes: async () => ['a', 'b'],
    search: async () => {
      if ((count += 1) === 2) started.resolve();
      return new Promise<never>(() => {});
    },
    cancel: async (scope: string, requestId: string) => {
      cancelled.push(`${scope}:${requestId}`);
    },
  });
  const task = client.recall({ terms: ['old'] }, 'old');
  await started.promise;
  await client.cancelRecall('old');
  assert.equal((await task as RecallSearchError).reason, 'aborted');
  assert.deepEqual(cancelled, ['a:old', 'b:old']);
  await client.cancelRecall('old');
  assert.equal(cancelled.length, 2, 'a second cancellation must not re-dispatch');
});

test('the same request identity cannot run twice at once', async () => {
  const client = createRecallSearchClient({
    scopes: async () => ['a'],
    search: () => new Promise<never>(() => {}),
    cancel: async () => {},
  });
  void client.recall({ terms: ['x'] }, 'dup');
  await assert.rejects(() => client.recall({ terms: ['y'] }, 'dup'), /already active/);
});
