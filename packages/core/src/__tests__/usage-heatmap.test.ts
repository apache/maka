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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isUsageHeatmapRange } from '../usage-heatmap.js';

const helperUrl = new URL('../usage-heatmap.js', import.meta.url).href;
function localRange(timezone: string, instant: string) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { resolveUsageHeatmapRange, isUsageHeatmapRange } from ${JSON.stringify(helperUrl)};
    const value = resolveUsageHeatmapRange(new Date(${JSON.stringify(instant)}).getTime());
    const date = (ts) => { const d = new Date(ts); return [d.getFullYear(), d.getMonth()+1, d.getDate()]; };
    console.log(JSON.stringify({valid:isUsageHeatmapRange(value), count:value.dayStarts.length,
      first:date(value.dayStarts[0]), last:date(value.dayStarts.at(-1)),
      firstHour:new Date(value.dayStarts[0]).getHours(),
      midnight:value.dayStarts.every(ts => new Date(ts).getHours() === 0),
      shifted:value.dayStarts.filter(ts => new Date(ts).getHours() !== 0).length,
      durations:value.dayStarts.slice(1).map((ts,i)=>(ts-value.dayStarts[i])/3600000),
      to:value.to}));
  `,
    ],
    { env: { ...process.env, TZ: timezone }, encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as {
    valid: boolean;
    count: number;
    first: number[];
    firstHour: number;
    last: number[];
    midnight: boolean;
    shifted: number;
    durations: number[];
    to: number;
  };
}

test('the rolling year ends today, with leap days and year boundaries retained', () => {
  for (const [instant, first, last, count] of [
    ['2026-10-13T12:00:00+08:00', [2025, 10, 14], [2026, 10, 13], 365],
    ['2024-02-29T12:00:00+08:00', [2023, 3, 1], [2024, 2, 29], 366],
    ['2025-02-28T12:00:00+08:00', [2024, 3, 1], [2025, 2, 28], 365],
    ['2026-12-31T12:00:00+08:00', [2026, 1, 1], [2026, 12, 31], 365],
  ] as const) {
    const range = localRange('Asia/Shanghai', instant);
    assert.equal(range.valid, true);
    assert.equal(range.count, count);
    assert.deepEqual(range.first, first);
    assert.deepEqual(range.last, last);
    assert.equal(range.to, Date.parse(instant));
    assert.equal(range.midnight, true);
  }
});

test('local midnights survive full-hour and half-hour daylight saving changes', () => {
  for (const [timezone, short, long] of [
    ['America/New_York', 23, 25],
    ['Australia/Lord_Howe', 23.5, 24.5],
  ] as const) {
    const range = localRange(timezone, '2026-10-13T12:00:00Z');
    assert.equal(range.valid, true);
    assert.equal(range.midnight, true);
    assert.ok(range.durations.includes(short));
    assert.ok(range.durations.includes(long));
  }
});

test('heatmap boundaries reject malformed, unbounded and noncontiguous input', () => {
  const day = 86_400_000;
  for (const value of [
    null,
    {},
    { dayStarts: [], to: 0 },
    { dayStarts: [0], to: -1 },
    { dayStarts: [0], to: Infinity },
    { dayStarts: [0, 0], to: 0 },
    { dayStarts: [0, day * 2], to: day * 2 },
    { dayStarts: [0], to: day * 2 },
    { dayStarts: [0.5], to: 1 },
    { dayStarts: [0], to: 1, extra: true },
    { dayStarts: Array.from({ length: 367 }, (_, i) => i * day), to: 366 * day },
  ])
    assert.equal(isUsageHeatmapRange(value), false, JSON.stringify(value));
  assert.equal(isUsageHeatmapRange({ dayStarts: [0, day], to: day + 1 }), true);
});

test('a skipped midnight does not shift the following dates or drop today', () => {
  const range = localRange('America/Santiago', '2026-10-13T12:00:00-03:00');
  assert.equal(range.valid, true);
  assert.equal(range.count, 365);
  assert.deepEqual(range.first, [2025, 10, 14]);
  assert.deepEqual(range.last, [2026, 10, 13]);
  assert.equal(range.shifted, 1, 'only the date without a midnight starts at 01:00');
});

test('a skipped midnight today or tomorrow does not shift the first date of the year', () => {
  for (const [timezone, instant, first] of [
    ['America/Santiago', '2026-09-05T12:00:00-04:00', [2025, 9, 6]],
    ['America/Santiago', '2028-09-03T12:00:00-03:00', [2027, 9, 4]],
    ['America/Havana', '2024-03-10T12:00:00-04:00', [2023, 3, 11]],
  ] as const) {
    const range = localRange(timezone, instant);
    assert.equal(range.valid, true);
    assert.deepEqual(range.first, first);
    assert.equal(range.firstHour, 0, `${timezone}: first date retains its own midnight`);
  }
});
