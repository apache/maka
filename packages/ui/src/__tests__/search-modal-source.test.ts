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
import { describe, it } from 'node:test';
import type { SearchResult } from '@maka/core/search';
import { createThreadSearchSource } from '../search-modal.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function result(sessionId: string): SearchResult {
  return {
    source: 'thread',
    title: sessionId,
    target: { kind: 'thread', sessionId },
  };
}

function createHarness() {
  const requests = new Map<
    string,
    ReturnType<
      typeof deferred<
        SearchResult[] | {
          ok: false;
          reason: 'provider_error';
          message: string;
        }
      >
    >
  >();
  let visibleItemIds: string[] = [];
  let visibleError: string | null = null;
  const source = createThreadSearchSource({
    searchThread: ({ query }) => {
      const request = deferred<
        SearchResult[] | {
          ok: false;
          reason: 'provider_error';
          message: string;
        }
      >();
      requests.set(query, request);
      return request.promise;
    },
    canNavigate: true,
    resultsLabel: 'Results',
    onQueryChange: () => {},
    onErrorChange: (error) => {
      visibleError = error?.message ?? null;
    },
    onItemsChange: (items) => {
      visibleItemIds = items.map((item) => item.id);
    },
    thrownErrorMessage: () => 'Thrown error',
  });
  return {
    source,
    requests,
    getVisibleItemIds: () => visibleItemIds,
    getVisibleError: () => visibleError,
  };
}

describe('thread search source', () => {
  it('keeps the selectable mapping while a filtered follow-up is pending', async () => {
    const harness = createHarness();
    const initial = harness.source.search('current');
    harness.requests.get('current')?.resolve([result('current-session')]);
    await initial;

    harness.source.cancel?.();
    void harness.source.search('current-session');

    assert.deepEqual(harness.getVisibleItemIds(), ['current-session::0']);
  });

  it('does not let an older success replace the current item mapping', async () => {
    const harness = createHarness();
    const older = harness.source.search('older');
    harness.source.cancel?.();
    const current = harness.source.search('current');

    harness.requests.get('current')?.resolve([result('current-session')]);
    await current;
    assert.deepEqual(harness.getVisibleItemIds(), ['current-session::0']);

    harness.requests.get('older')?.resolve([result('older-session')]);
    await older;
    assert.deepEqual(harness.getVisibleItemIds(), ['current-session::0']);
  });

  it('does not let an older error replace the current successful state', async () => {
    const harness = createHarness();
    const older = harness.source.search('older');
    harness.source.cancel?.();
    const current = harness.source.search('current');

    harness.requests.get('current')?.resolve([result('current-session')]);
    await current;
    assert.equal(harness.getVisibleError(), null);

    harness.requests.get('older')?.resolve({
      ok: false,
      reason: 'provider_error',
      message: 'stale failure',
    });
    await older;
    assert.equal(harness.getVisibleError(), null);
    assert.deepEqual(harness.getVisibleItemIds(), ['current-session::0']);
  });
});
