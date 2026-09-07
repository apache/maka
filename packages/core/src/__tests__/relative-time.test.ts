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
import {
  formatAbsoluteTimestamp,
  formatCompactTimestamp,
  formatRelativeTimestamp,
  formatSidebarTimestamp,
  nextRelativeRefreshDelay,
  nextSidebarRefreshDelay,
  resetRelativeTimeFormatters,
} from '../relative-time.js';

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('relative timestamp labels', () => {
  it('holds a just-now label for the whole first minute, then switches to minutes', () => {
    resetRelativeTimeFormatters();

    for (const ageMs of [0, 1_000, 30_000, 59_999]) {
      assert.equal(formatRelativeTimestamp(NOW - ageMs, NOW, 'zh-CN'), '刚刚');
      assert.equal(formatRelativeTimestamp(NOW - ageMs, NOW, 'en'), 'just now');
      assert.equal(formatCompactTimestamp(NOW - ageMs, NOW, 'zh-CN'), '刚刚');
      assert.equal(formatSidebarTimestamp(NOW - ageMs, NOW, 'zh-CN'), '刚刚');
    }

    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'zh-CN'), '1分钟前');
    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'en'), '1 minute ago');
  });

  it('delays the ticker until the just-now window ends', () => {
    assert.equal(nextRelativeRefreshDelay(NOW, NOW), 60_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 30_000, NOW), 30_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 60_000, NOW), 60_000);
  });

  it('uses scan-friendly units for sidebar timestamps', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const [ageMs, expected] of [
        [60_000, '1min'],
        [46 * 60_000, '46min'],
        [13 * 60 * 60_000, '13h'],
        [3 * 24 * 60 * 60_000, '3d'],
        [17 * 24 * 60 * 60_000, '17d'],
        [29 * 24 * 60 * 60_000, '29d'],
        [30 * 24 * 60 * 60_000, '1mo'],
        [60 * 24 * 60 * 60_000, '2mo'],
        [365 * 24 * 60 * 60_000, '1y'],
      ] as const) {
        assert.equal(formatSidebarTimestamp(NOW - ageMs, NOW, locale), expected);
      }
    }
  });

  it('keeps the existing compact date fallback outside the sidebar', () => {
    const ts = NOW - 17 * 24 * 60 * 60_000;
    const expected = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(new Date(ts));

    assert.equal(formatCompactTimestamp(ts, NOW, 'en'), expected);
  });

  it('refreshes sidebar timestamps at the next visible bucket', () => {
    const nearRoundedDayBucketBoundary = NOW - (17 * 24 * 60 + 11 * 60 + 58) * 60_000;

    assert.equal(formatSidebarTimestamp(nearRoundedDayBucketBoundary, NOW, 'en'), '17d');
    assert.equal(nextSidebarRefreshDelay(nearRoundedDayBucketBoundary, NOW), 2 * 60_000);
    assert.equal(nextSidebarRefreshDelay(NOW - 17 * 24 * 60 * 60_000, NOW), 12 * 60 * 60_000);
    assert.equal(nextSidebarRefreshDelay(NOW - THIRTY_DAYS_MS, NOW), 15 * 24 * 60 * 60_000);
    assert.equal(nextSidebarRefreshDelay(NOW - 365 * 24 * 60 * 60_000, NOW), 24 * 24 * 60 * 60_000);
  });

  it('treats a finite future timestamp as just now and schedules recovery', () => {
    const futureTs = NOW + THIRTY_DAYS_MS;
    const delay = nextRelativeRefreshDelay(futureTs, NOW);

    assert.equal(delay, 60_000);
    assert.equal(formatRelativeTimestamp(futureTs, NOW, 'en'), 'just now');
    assert.equal(formatCompactTimestamp(futureTs, NOW, 'en'), 'just now');
    assert.equal(formatSidebarTimestamp(futureTs, NOW, 'en'), 'just now');
  });

  it('keeps timestamp refresh delays within the scheduler bound', () => {
    for (const ts of [
      NOW - 60_000,
      NOW - 60 * 60_000,
      NOW,
      NOW + THIRTY_DAYS_MS,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
    ]) {
      const delay = nextRelativeRefreshDelay(ts, NOW);
      assert.ok(delay === null || (Number.isFinite(delay) && delay > 0 && delay <= 10 * 60_000));
    }
  });

  it('reuses both formatters when relative and absolute readings alternate', () => {
    resetRelativeTimeFormatters();
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const OriginalRelativeTimeFormat = Intl.RelativeTimeFormat;
    let constructions = 0;
    function countConstructions(name: 'DateTimeFormat' | 'RelativeTimeFormat'): void {
      const Original = Intl[name] as unknown as new (...args: unknown[]) => unknown;
      function Counting(...args: unknown[]): unknown {
        constructions += 1;
        return new Original(...args);
      }
      Object.defineProperty(Intl, name, { value: Counting, configurable: true, writable: true });
    }
    countConstructions('DateTimeFormat');
    countConstructions('RelativeTimeFormat');
    try {
      for (let round = 0; round < 5; round += 1) {
        // The sidebar reads both per row: the relative label and, for the
        // accessible name and the tooltip, the absolute one.
        formatRelativeTimestamp(NOW - 60_000, NOW, 'en');
        formatAbsoluteTimestamp(NOW - 60_000, 'en');
      }
      assert.equal(constructions, 2, 'one formatter of each kind for one locale');
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        value: OriginalDateTimeFormat,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Intl, 'RelativeTimeFormat', {
        value: OriginalRelativeTimeFormat,
        configurable: true,
        writable: true,
      });
      resetRelativeTimeFormatters();
    }
  });
});
