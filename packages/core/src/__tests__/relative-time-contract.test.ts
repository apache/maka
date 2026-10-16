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
const DAY = 24 * 60 * 60_000;
const MONTH = 30 * DAY;

describe('relative-time contract', () => {
  it('keeps all surfaces on just now until the minute boundary', () => {
    resetRelativeTimeFormatters();
    for (const age of [0, 1_000, 30_000, 59_999]) {
      assert.equal(formatRelativeTimestamp(NOW - age, NOW, 'zh-CN'), '刚刚');
      assert.equal(formatRelativeTimestamp(NOW - age, NOW, 'en'), 'just now');
      assert.equal(formatCompactTimestamp(NOW - age, NOW, 'zh-CN'), '刚刚');
      assert.equal(formatSidebarTimestamp(NOW - age, NOW, 'zh-CN'), '刚刚');
    }
    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'zh-CN'), '1分钟前');
    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'en'), '1 minute ago');
  });

  it('returns the next visible refresh boundary', () => {
    assert.deepEqual(
      [nextRelativeRefreshDelay(NOW, NOW), nextRelativeRefreshDelay(NOW - 30_000, NOW)],
      [60_000, 30_000],
    );
    assert.equal(nextRelativeRefreshDelay(NOW - 60_000, NOW), 60_000);

    const nearDayBoundary = NOW - (17 * 24 * 60 + 11 * 60 + 58) * 60_000;
    assert.equal(formatSidebarTimestamp(nearDayBoundary, NOW, 'en'), '17d');
    assert.equal(nextSidebarRefreshDelay(nearDayBoundary, NOW), 2 * 60_000);
    assert.equal(nextSidebarRefreshDelay(NOW - 17 * DAY, NOW), 12 * 60 * 60_000);
    assert.equal(nextSidebarRefreshDelay(NOW - MONTH, NOW), 15 * DAY);
  });

  it('uses stable abbreviated sidebar buckets and a date-only compact fallback', () => {
    const cases = [
      [60_000, '1min'],
      [46 * 60_000, '46min'],
      [13 * 60 * 60_000, '13h'],
      [3 * DAY, '3d'],
      [29 * DAY, '29d'],
      [MONTH, '1mo'],
      [2 * MONTH, '2mo'],
      [365 * DAY, '1y'],
    ] as const;
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const [age, expected] of cases) {
        assert.equal(formatSidebarTimestamp(NOW - age, NOW, locale), expected);
      }
    }

    const old = NOW - 17 * DAY;
    const expected = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(old),
    );
    assert.equal(formatCompactTimestamp(old, NOW, 'en'), expected);
  });

  it('clamps future timestamps and bounds refresh delays', () => {
    const future = NOW + MONTH;
    assert.equal(nextRelativeRefreshDelay(future, NOW), 60_000);
    assert.equal(formatRelativeTimestamp(future, NOW, 'en'), 'just now');
    assert.equal(formatCompactTimestamp(future, NOW, 'en'), 'just now');
    assert.equal(formatSidebarTimestamp(future, NOW, 'en'), 'just now');

    for (const timestamp of [
      NOW - 60_000,
      NOW - 60 * 60_000,
      NOW,
      future,
      Infinity,
      NaN,
      -Infinity,
    ]) {
      const delay = nextRelativeRefreshDelay(timestamp, NOW);
      assert.ok(delay === null || (Number.isFinite(delay) && delay > 0 && delay <= 10 * 60_000));
    }
  });

  it('reuses relative and absolute Intl formatters independently', () => {
    resetRelativeTimeFormatters();
    const originalDate = Intl.DateTimeFormat;
    const originalRelative = Intl.RelativeTimeFormat;
    let constructions = 0;
    const count = (name: 'DateTimeFormat' | 'RelativeTimeFormat', original: unknown) => {
      function Counting(...args: unknown[]) {
        constructions += 1;
        return new (original as new (...params: unknown[]) => unknown)(...args);
      }
      Object.defineProperty(Intl, name, { value: Counting, configurable: true, writable: true });
    };
    count('DateTimeFormat', originalDate);
    count('RelativeTimeFormat', originalRelative);
    try {
      for (let index = 0; index < 5; index += 1) {
        formatRelativeTimestamp(NOW - 60_000, NOW, 'en');
        formatAbsoluteTimestamp(NOW - 60_000, 'en');
      }
      assert.equal(constructions, 2);
    } finally {
      Object.defineProperty(Intl, 'DateTimeFormat', {
        value: originalDate,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Intl, 'RelativeTimeFormat', {
        value: originalRelative,
        configurable: true,
        writable: true,
      });
      resetRelativeTimeFormatters();
    }
  });
});
