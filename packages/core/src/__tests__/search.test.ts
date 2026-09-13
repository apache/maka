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
import { describe, it } from 'node:test';
import {
  SEARCH_MAX_LIMIT,
  normalizeSearchDomain,
  normalizeSearchDomainList,
  normalizeSearchLimit,
  normalizeSearchQuery,
  normalizeSearchUrl,
  rewriteSearchQueryForFreshness,
  searchDomainMatches,
} from '../search.js';

describe('search contract normalizers', () => {
  it('normalizes a query and rejects malformed input', () => {
    assert.deepEqual(normalizeSearchQuery('  最新 AI 新闻  '), {
      ok: true,
      value: '最新 AI 新闻',
    });
    for (const input of [undefined, '   ']) {
      const result = normalizeSearchQuery(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'invalid_query');
    }
  });

  it('defaults, truncates, bounds, and validates limits', () => {
    assert.deepEqual(normalizeSearchLimit(undefined), { ok: true, value: 5 });
    assert.deepEqual(normalizeSearchLimit(3.8), { ok: true, value: 3 });
    assert.deepEqual(normalizeSearchLimit(999), { ok: true, value: SEARCH_MAX_LIMIT });
    for (const input of ['5', Number.NaN, 0]) {
      assert.equal(normalizeSearchLimit(input).ok, false);
    }
  });

  it('canonicalizes, deduplicates, validates, and suffix-matches domains', () => {
    assert.deepEqual(normalizeSearchDomain(' HTTPS://WWW.Example.COM/path?q=1 '), {
      ok: true,
      value: 'example.com',
    });
    assert.deepEqual(
      normalizeSearchDomainList(['www.example.com', 'https://example.com/a', 'docs.example.com']),
      { ok: true, value: ['example.com', 'docs.example.com'] },
    );
    assert.equal(searchDomainMatches('docs.example.com', ['example.com']), true);
    assert.equal(searchDomainMatches('badexample.com', ['example.com']), false);
    assert.equal(searchDomainMatches('example.com', ['example.com']), true);

    for (const input of [undefined, '   ', 'https://']) {
      const result = normalizeSearchDomain(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'invalid_domain');
    }
    const listResult = normalizeSearchDomainList('example.com');
    assert.equal(listResult.ok, false);
    if (!listResult.ok) assert.equal(listResult.reason, 'invalid_domain');
  });

  it('keeps safe URLs, strips trackers, and blocks active or local schemes', () => {
    assert.deepEqual(
      normalizeSearchUrl('https://example.com/page?utm_source=x&keep=1&gclid=abc#hash'),
      { ok: true, value: 'https://example.com/page?keep=1#hash' },
    );
    const result = normalizeSearchUrl('javascript:alert(1)');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'blocked_scheme');
  });

  it('rewrites fresh queries without changing historical intent', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    for (const [query, expected] of [
      ['今天 AI 新闻', '今天 AI 新闻 2026'],
      ['latest OpenAI news 2024', 'latest OpenAI news 2026'],
      ['history of AI since 2019', 'history of AI since 2019'],
    ]) {
      assert.equal(rewriteSearchQueryForFreshness(query, now), expected);
    }
  });
});
