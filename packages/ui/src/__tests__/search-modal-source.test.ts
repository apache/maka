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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SearchErrorReason, SearchResult } from '@maka/core/search';
import { runThreadSearch } from '@maka/core/thread-search';
import { UI_LOCALES, type UiCatalog } from '@maka/core/ui-locale';
import { createThreadSearchSource, searchErrorText } from '../search-modal.js';
import { getShellControlsCopy } from '../shell-controls-copy.js';
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
      visibleError = error?.reason ?? null;
    },
    onItemsChange: (items) => {
      visibleItemIds = items.map((item) => item.id);
    },
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

describe('search error copy', () => {
  it('maps the reasons thread search emits per locale and falls back for the rest', () => {
    const zh = getShellControlsCopy('zh-CN').search;
    const en = getShellControlsCopy('en').search;
    const mapped = ['incognito_active', 'invalid_query', 'aborted', 'disabled', 'provider_error'];
    assert.deepEqual(Object.keys(zh.errorByReason).sort(), [...mapped].sort());
    assert.deepEqual(Object.keys(en.errorByReason).sort(), [...mapped].sort());
    assert.equal(searchErrorText('incognito_active', zh), '关闭隐私模式后可以继续按关键词查找历史任务。');
    assert.equal(searchErrorText('invalid_query', zh), '搜索词无效，请缩短内容或移除凭据后重试。');
    assert.equal(searchErrorText('disabled', zh), '搜索当前不可用。');
    assert.equal(searchErrorText('aborted', en), 'Search was canceled.');
    assert.equal(searchErrorText('provider_error', en), 'Search failed. Try again.');
    assert.equal(searchErrorText('timeout', en), 'Search needs to be refreshed. Try again.');
    assert.equal(searchErrorText('timeout', zh), '搜索服务需要刷新，请重试。');
    assert.equal(
      searchErrorText('constructor' as SearchErrorReason, en),
      'Search needs to be refreshed. Try again.',
    );
  });

  it('presents both overlong and credential queries without assuming the rejection cause', async (context) => {
    context.mock.method(console, 'error', () => {});
    const expected = {
      'zh-CN': '搜索词无效，请缩短内容或移除凭据后重试。',
      'zh-TW': '搜尋詞無效，請縮短內容或移除憑證後重試。',
      en: 'Invalid search query. Shorten it or remove credential material and try again.',
    } satisfies UiCatalog<string>;
    for (const locale of UI_LOCALES) {
      for (const query of ['a'.repeat(501), 'password=supersecret']) {
        let visibleError: string | undefined;
        const source = createThreadSearchSource({
          searchThread: async (request) => {
            const fail = async (): Promise<never> => assert.fail('Rejected queries must not read history');
            const response = await runThreadSearch(request, {
              listSessions: fail,
              readMessages: fail,
              getPrivacyContext: fail,
            });
            assert.equal(response.ok, false);
            if (response.ok) assert.fail('Expected invalid query');
            assert.equal(response.reason, 'invalid_query');
            return response;
          },
          canNavigate: true,
          resultsLabel: 'Results',
          onQueryChange: () => {},
          onItemsChange: (items) => assert.deepEqual(items, []),
          onErrorChange: (error) => {
            if (error) visibleError = searchErrorText(error.reason, getShellControlsCopy(locale).search);
          },
        });
        await source.search(query);
        assert.equal(visibleError, expected[locale], `${locale}: ${query.length} characters`);
      }
    }
  });
});
