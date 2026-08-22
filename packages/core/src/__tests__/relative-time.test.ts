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
  formatCompactTimestamp,
  formatRelativeTimestamp,
  nextRelativeRefreshDelay,
  resetRelativeTimeFormatters,
} from '../relative-time.js';

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe('relative timestamp labels', () => {
  it('holds a just-now label for the whole first minute, then switches to minutes', () => {
    resetRelativeTimeFormatters();

    for (const ageMs of [0, 1_000, 30_000, 59_999]) {
      assert.equal(formatRelativeTimestamp(NOW - ageMs, NOW, 'zh'), '刚刚');
      assert.equal(formatRelativeTimestamp(NOW - ageMs, NOW, 'en'), 'just now');
      assert.equal(formatCompactTimestamp(NOW - ageMs, NOW, 'zh'), '刚刚');
    }

    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'zh'), '1分钟前');
    assert.equal(formatRelativeTimestamp(NOW - 60_000, NOW, 'en'), '1 minute ago');
  });

  it('delays the ticker until the just-now window ends', () => {
    assert.equal(nextRelativeRefreshDelay(NOW, NOW), 60_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 30_000, NOW), 30_000);
    assert.equal(nextRelativeRefreshDelay(NOW - 60_000, NOW), 60_000);
  });

  it('treats a finite future timestamp as just now and schedules recovery', () => {
    const futureTs = NOW + THIRTY_DAYS_MS;
    const delay = nextRelativeRefreshDelay(futureTs, NOW);

    assert.equal(delay, 60_000);
    assert.equal(formatRelativeTimestamp(futureTs, NOW, 'en'), 'just now');
    assert.equal(formatCompactTimestamp(futureTs, NOW, 'en'), 'just now');
  });

  it('keeps finite timestamp refresh delays within the scheduler bound', () => {
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
});
