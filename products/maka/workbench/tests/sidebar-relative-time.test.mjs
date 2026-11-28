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
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  MONTH_MS,
  YEAR_MS,
  formatSidebarRelativeTime,
  isValidRelativeTimestamp,
  nextMinuteTickDelay,
} from '../app/sidebarRelativeTime.ts';

const NOW = 1_760_000_040_000;

test('degrades cleanly to empty string for missing, non-finite, or non-positive timestamps', () => {
  for (const invalid of [undefined, null, 0, -1, -MINUTE_MS, Number.NaN, Infinity, -Infinity]) {
    assert.equal(isValidRelativeTimestamp(invalid), false);
    assert.equal(formatSidebarRelativeTime(invalid, NOW), '');
  }
  assert.equal(formatSidebarRelativeTime(NOW - MINUTE_MS, Number.NaN), '');
  assert.equal(formatSidebarRelativeTime(NOW - MINUTE_MS, Infinity), '');
});

test('formats ages under one minute and future clock skew with the localized now label', () => {
  const cases = [
    ['en', 'now'],
    ['zh-CN', '刚刚'],
    ['zh-TW', '剛剛'],
  ];
  for (const [, label] of cases) {
    assert.equal(formatSidebarRelativeTime(NOW + 5 * MINUTE_MS, NOW, label), label);
    assert.equal(formatSidebarRelativeTime(NOW + 1, NOW, label), label);
    assert.equal(formatSidebarRelativeTime(NOW, NOW, label), label);
    assert.equal(formatSidebarRelativeTime(NOW - (MINUTE_MS - 1), NOW, label), label);
  }
});

test('formats deterministic compact buckets across minute, hour, day, month, and year boundaries', () => {
  assert.equal(formatSidebarRelativeTime(NOW - MINUTE_MS, NOW), '1m');
  assert.equal(formatSidebarRelativeTime(NOW - 5 * MINUTE_MS, NOW), '5m');
  assert.equal(formatSidebarRelativeTime(NOW - (HOUR_MS - 1), NOW), '59m');

  assert.equal(formatSidebarRelativeTime(NOW - HOUR_MS, NOW), '1h');
  assert.equal(formatSidebarRelativeTime(NOW - 2 * HOUR_MS, NOW), '2h');
  assert.equal(formatSidebarRelativeTime(NOW - (DAY_MS - 1), NOW), '23h');

  assert.equal(formatSidebarRelativeTime(NOW - DAY_MS, NOW), '1d');
  assert.equal(formatSidebarRelativeTime(NOW - 17 * DAY_MS, NOW), '17d');
  assert.equal(formatSidebarRelativeTime(NOW - (MONTH_MS - 1), NOW), '29d');

  assert.equal(formatSidebarRelativeTime(NOW - MONTH_MS, NOW), '1mo');
  assert.equal(formatSidebarRelativeTime(NOW - (YEAR_MS - 1), NOW), '11mo');

  assert.equal(formatSidebarRelativeTime(NOW - YEAR_MS, NOW), '1y');
  assert.equal(formatSidebarRelativeTime(NOW - 365 * DAY_MS, NOW), '1y');
  assert.equal(formatSidebarRelativeTime(NOW - 2 * YEAR_MS, NOW), '2y');
});

test('aligns shared clock tick delays to minute boundaries', () => {
  assert.equal(nextMinuteTickDelay(0), MINUTE_MS);
  assert.equal(nextMinuteTickDelay(MINUTE_MS), MINUTE_MS);
  assert.equal(nextMinuteTickDelay(MINUTE_MS + 1), MINUTE_MS - 1);
  assert.equal(nextMinuteTickDelay(2 * MINUTE_MS - 1), 1);
  assert.equal(nextMinuteTickDelay(Number.NaN), MINUTE_MS);
});
