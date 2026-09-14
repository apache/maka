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
import { test } from 'node:test';
import type { ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import {
  filterHistoryEntries, groupHistoryEntries, type HistoryGranularity, type HistoryViewGroup,
} from '../../renderer/features/module-hub/testing.js';

function leaf(start: string, overrides: Partial<ComputerHistoryTimelineEntry> = {}): ComputerHistoryTimelineEntry {
  return {
    id: `10min-${Date.parse(start)}`, start,
    end: new Date(Date.parse(start) + 10 * 60 * 1_000).toISOString(),
    title: 'Edited source', description: '', applications: ['com.example.Editor'],
    eventCount: 1, suppressedEventCount: 0, contextMarkdown: '',
    summaryLevel: '10min', ...overrides,
  };
}

function rollup(
  start: string, children?: readonly ComputerHistoryTimelineEntry[],
  overrides: Partial<ComputerHistoryTimelineEntry> = {},
): ComputerHistoryTimelineEntry {
  return leaf(start, {
    id: `6h-${Date.parse(start)}`, end: new Date(Date.parse(start) + 6 * 60 * 60 * 1_000).toISOString(),
    title: 'Session overview', summaryLevel: '6h',
    ...(children ? { summaryChildren: children.map(({ id }) => id) } : {}), ...overrides,
  });
}

const memberIds = (group: HistoryViewGroup) => group.entries.map(({ id }) => id);
const day = (value: number, hour = 12) => new Date(2026, 8, value, hour).toISOString();

function inTimezone(zone: string, run: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('10min groups only matching leaves by local start day without mutating or copying documents', () => {
  const older = Object.freeze(leaf(day(12)));
  const a = Object.freeze(leaf(day(13), { id: 'a' }));
  const b = Object.freeze(leaf(day(13), { id: 'b' }));
  const parent = Object.freeze(rollup(day(13), [a, b]));
  const raw = Object.freeze(leaf(day(14), { id: 'raw', summaryLevel: undefined }));
  const all = Object.freeze([b, older, raw, parent, a, b]);
  const before = structuredClone(all);
  const groups = groupHistoryEntries(all, all, '10min');
  assert.deepEqual(groups.map(({ day }) => day), ['2026-09-13', '2026-09-12']);
  assert.deepEqual(groups.map(memberIds), [['a', 'b'], [older.id]]);
  assert.ok(groups.every(({ summary, kind }) => !summary && kind === '10min'));
  assert.equal(groups[0].entries[0], a);
  assert.deepEqual(all, before);
  assert.deepEqual(groupHistoryEntries(all, [parent, raw], '10min'), []);
});

test('UTC+8 cross-midnight leaves use their start day in 10min and every intersected date in day', () => {
  inTimezone('Asia/Shanghai', () => {
    const crossing = leaf('2026-09-13T15:55:00Z');
    const atMidnight = leaf('2026-09-13T16:00:00Z');
    const endsAtMidnight = leaf('2026-09-13T15:50:00Z');
    const all = [crossing, atMidnight, endsAtMidnight];
    const tenMinute = groupHistoryEntries(all, all, '10min');
    assert.deepEqual(tenMinute.map(memberIds), [[atMidnight.id], [crossing.id, endsAtMidnight.id]]);
    const daily = groupHistoryEntries(all, all, 'day');
    assert.deepEqual(daily.map(({ day }) => day), ['2026-09-14', '2026-09-13']);
    assert.deepEqual(daily.map(memberIds), [[atMidnight.id, crossing.id], [crossing.id, endsAtMidnight.id]]);
    assert.equal(daily[0].start, '2026-09-13T16:00:00.000Z');
    assert.equal(daily[0].end, '2026-09-14T16:00:00.000Z');
  });
});

test('day collections contain leaves and genuinely orphaned rollups, never a synthesized daily summary', () => {
  const child = leaf(day(13));
  const parent = rollup(day(13), [child]);
  const orphan = rollup(day(13, 0), [], { title: 'Older saved document' });
  const all = [parent, orphan, child];
  const groups = groupHistoryEntries(all, all, 'day');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].entries, [child, orphan]);
  assert.equal(groups[0].summary, undefined);
  assert.equal(groups[0].kind, 'day');
});

test('parent-only search and application matches remain saved day documents for canonical and legacy parents', () => {
  inTimezone('Asia/Shanghai', () => {
    const child = leaf('2026-09-13T06:10:00Z');
    for (const children of [[child], undefined]) {
      const parent = rollup('2026-09-13T06:00:00Z', children, {
        title: 'Parent-only phrase', applications: ['com.example.Browser'],
      });
      const all = [child, parent];
      const full = groupHistoryEntries(all, all, 'day');
      assert.deepEqual(full[0].entries, [child]);
      for (const [query, source] of [['parent-only', ''], ['', 'com.example.Browser']]) {
        const filtered = filterHistoryEntries(all, '', query, source);
        assert.deepEqual(filtered, [parent]);
        const groups = groupHistoryEntries(all, filtered, 'day');
        assert.equal(groups.length, 1);
        assert.equal(groups[0].id, full[0].id);
        assert.deepEqual(groups[0].entries, [parent]);
        assert.equal(groups[0].entries[0], parent);
        assert.equal(groups[0].summary, undefined);
        assert.deepEqual(groupHistoryEntries(all, filtered, '10min'), []);
      }
      assert.deepEqual(groupHistoryEntries(all, [], 'day'), []);
    }
  });
});

test('partially orphaned UTC+8 rollups fall back only on dates without a retained child', () => {
  inTimezone('Asia/Shanghai', () => {
    const firstDay = leaf('2026-09-13T12:10:00Z');
    const secondDay = leaf('2026-09-13T16:10:00Z');
    for (const children of [[firstDay, secondDay], undefined]) {
      const parent = rollup('2026-09-13T12:00:00Z', children);
      const complete = [parent, firstDay, secondDay];
      const full = groupHistoryEntries(complete, complete, 'day');
      assert.deepEqual(full.map(({ day }) => day), ['2026-09-14', '2026-09-13']);
      assert.deepEqual(full.map(memberIds), [[secondDay.id], [firstDay.id]]);
      for (const [retained, orphanDay] of [
        [firstDay, '2026-09-14'], [secondDay, '2026-09-13'],
      ] as const) {
        const all = [retained, parent];
        const daily = groupHistoryEntries(all, all, 'day');
        assert.deepEqual(daily.map(({ id }) => id), full.map(({ id }) => id));
        assert.deepEqual(daily.find(({ day }) => day === orphanDay)?.entries, [parent]);
        assert.deepEqual(daily.find(({ day }) => day !== orphanDay)?.entries, [retained]);
        const filtered = filterHistoryEntries(all, orphanDay, '', '');
        const selected = groupHistoryEntries(all, filtered, 'day').find(({ day }) => day === orphanDay)!;
        assert.equal(selected.id, daily.find(({ day }) => day === orphanDay)!.id);
        assert.equal(selected.entries[0], parent);
        assert.equal(selected.summary, undefined);
        assert.deepEqual(groupHistoryEntries(all, filtered, '10min'), []);
      }
    }
  });
});

test('day fallback considers matching canonical children per date, not unrelated matching leaves', () => {
  inTimezone('Asia/Shanghai', () => {
    const firstDay = leaf('2026-09-13T12:10:00Z', { title: 'Matching work' });
    const secondDay = leaf('2026-09-13T16:10:00Z');
    const unrelated = leaf('2026-09-13T16:20:00Z', { title: 'Matching independent work' });
    const parent = rollup('2026-09-13T12:00:00Z', [firstDay, secondDay], { title: 'Matching overview' });
    const all = [unrelated, parent, secondDay, firstDay, parent, unrelated];
    const filtered = filterHistoryEntries(all, '', 'matching', '');
    const daily = groupHistoryEntries(all, filtered, 'day');
    assert.deepEqual(daily.map(({ day }) => day), ['2026-09-14', '2026-09-13']);
    assert.deepEqual(daily.map(memberIds), [[unrelated.id, parent.id], [firstDay.id]]);
    assert.ok(daily.every(({ summary }) => summary === undefined));
    assert.deepEqual(groupHistoryEntries([...all].reverse(), filtered, 'day'), daily);
    const childOnly = filterHistoryEntries(all, '', 'independent', '');
    assert.deepEqual(groupHistoryEntries(all, childOnly, 'day').map(memberIds), [[unrelated.id]]);
  });
});

test('a matching child intersecting two local dates suppresses parent fallback on both dates', () => {
  inTimezone('Asia/Kathmandu', () => {
    const child = leaf('2026-09-13T18:10:00Z');
    const parent = rollup('2026-09-13T18:00:00Z', [child]);
    const all = [parent, child];
    const daily = groupHistoryEntries(all, all, 'day');
    assert.deepEqual(daily.map(({ day }) => day), ['2026-09-14', '2026-09-13']);
    assert.deepEqual(daily.map(memberIds), [[child.id], [child.id]]);
  });
});

test('a rollup whose leaves are gone remains available on every intersected UTC+8 date', () => {
  inTimezone('Asia/Shanghai', () => {
    const child = leaf('2026-09-13T12:10:00Z');
    const parent = rollup('2026-09-13T12:00:00Z', [child]);
    const all = [parent];
    const daily = groupHistoryEntries(all, all, 'day');
    assert.deepEqual(daily.map(({ day }) => day), ['2026-09-14', '2026-09-13']);
    assert.ok(daily.every((group) => group.entries.length === 1 && group.entries[0] === parent && !group.summary));
    const filtered = filterHistoryEntries(all, '2026-09-14', '', '');
    assert.deepEqual(groupHistoryEntries(all, filtered, 'day'), daily);
    assert.deepEqual(groupHistoryEntries(all, filtered, '10min'), []);
    const sixHour = groupHistoryEntries(all, filtered, '6h');
    assert.equal(sixHour.length, 1);
    assert.equal(sixHour[0].summary, parent);
    assert.deepEqual(sixHour[0].entries, []);
  });
});

test('UTC-aligned six-hour boundaries split pending leaves and keep identity when a rollup arrives', () => {
  inTimezone('Asia/Shanghai', () => {
    const before = leaf('2026-09-13T05:50:00Z');
    const boundary = leaf('2026-09-13T06:00:00Z');
    const last = leaf('2026-09-13T11:50:00Z');
    const next = leaf('2026-09-13T12:00:00Z');
    const all = [last, before, next, boundary];
    const pending = groupHistoryEntries(all, all, '6h');
    assert.deepEqual(pending.map(({ start }) => start), [
      '2026-09-13T12:00:00.000Z', '2026-09-13T06:00:00.000Z', '2026-09-13T00:00:00.000Z',
    ]);
    assert.deepEqual(pending.map(memberIds), [[next.id], [last.id, boundary.id], [before.id]]);
    assert.ok(pending.every(({ summary, start, end }) => !summary && Date.parse(end) - Date.parse(start) === 21_600_000));
    const parent = rollup('2026-09-13T06:00:00Z', [boundary, last]);
    const arrived = groupHistoryEntries([parent, ...all], [parent, ...all], '6h');
    assert.equal(arrived[1].id, pending[1].id);
    assert.equal(arrived[1].start, pending[1].start);
    assert.equal(arrived[1].end, pending[1].end);
    assert.equal(arrived[1].summary, parent);
    assert.deepEqual(arrived[1].entries, pending[1].entries);
    assert.ok(!arrived[1].entries.includes(parent));
  });
});

test('matching a child keeps parent context but includes only matching children', () => {
  const matching = leaf('2026-09-13T06:10:00Z', { title: 'Unique finding' });
  const other = leaf('2026-09-13T06:20:00Z');
  const parent = rollup('2026-09-13T06:00:00Z', [matching, other]);
  const all = [other, parent, matching];
  const filtered = filterHistoryEntries(all, '', 'unique finding', '');
  const groups = groupHistoryEntries(all, filtered, '6h');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].summary, parent);
  assert.deepEqual(groups[0].entries, [matching]);
  const full = groupHistoryEntries(all, all, '6h').find(({ id }) => id === groups[0].id);
  assert.deepEqual(full?.entries, [other, matching]);
});

test('a parent-only match stays visible without admitting nonmatching children', () => {
  const child = leaf('2026-09-13T06:10:00Z');
  const parent = rollup('2026-09-13T06:00:00Z', [child], { title: 'Parent-only phrase' });
  const all = [child, parent];
  const groups = groupHistoryEntries(all, filterHistoryEntries(all, '', 'parent-only', ''), '6h');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].summary, parent);
  assert.deepEqual(groups[0].entries, []);
  assert.deepEqual(groupHistoryEntries(all, [], '6h'), []);
});

test('canonical children exclude unrelated same-window leaves without hiding them', () => {
  const child = leaf('2026-09-13T06:10:00Z');
  const unrelated = leaf('2026-09-13T06:20:00Z', { title: 'Later independent work' });
  const parent = rollup('2026-09-13T06:00:00Z', [child]);
  const all = [parent, child, unrelated];
  const groups = groupHistoryEntries(all, all, '6h');
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find(({ summary }) => summary)?.entries, [child]);
  const pending = groups.find(({ summary }) => !summary)!;
  assert.deepEqual(pending.entries, [unrelated]);
  assert.equal(new Set(groups.map(({ id }) => id)).size, 2);
  const filtered = groupHistoryEntries(all, [unrelated], '6h');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].summary, undefined);
  assert.equal(filtered[0].id, pending.id);
  assert.deepEqual(filtered[0].entries, [unrelated]);
});

test('distinct canonical windows keep their own children and stable pending identities across filters', () => {
  const earlier = leaf('2026-09-13T06:10:00Z');
  const later = leaf('2026-09-13T12:10:00Z');
  const unrelated = leaf('2026-09-13T12:20:00Z');
  const next = leaf('2026-09-13T18:00:00Z');
  const legacy = rollup('2026-09-13T06:00:00Z');
  const parent = rollup('2026-09-13T12:00:00Z', [later]);
  const all = [earlier, parent, next, legacy, unrelated, later];
  const full = groupHistoryEntries(all, all, '6h');
  assert.deepEqual(full.map(memberIds), [[next.id], [later.id], [unrelated.id], [earlier.id]]);
  assert.deepEqual(full.map(({ summary }) => summary?.id), [undefined, parent.id, undefined, legacy.id]);
  assert.equal(new Set(full.map(({ id }) => id)).size, full.length);
  for (const child of [earlier, later, unrelated, next]) {
    const filtered = groupHistoryEntries(all, [child], '6h');
    assert.equal(filtered.length, 1);
    const original = full.find(({ entries }) => entries.includes(child))!;
    assert.equal(filtered[0].id, original.id);
    assert.equal(filtered[0].summary, original.summary);
    assert.deepEqual(filtered[0].entries, [child]);
  }
  assert.deepEqual(groupHistoryEntries([...all].reverse(), [...all].reverse(), '6h'), full);
});

test('explicit empty or missing-ID provenance does not fall back to interval containment', () => {
  const child = leaf('2026-09-13T06:10:00Z');
  for (const summaryChildren of [[], ['10min-0']] as const) {
    const parent = rollup('2026-09-13T06:00:00Z', [], { summaryChildren });
    const all = [child, parent];
    const groups = groupHistoryEntries(all, all, '6h');
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.find(({ summary }) => summary)?.entries, []);
    assert.deepEqual(groups.find(({ summary }) => !summary)?.entries, [child]);
    assert.equal(groupHistoryEntries(all, [child], '6h')[0].summary, undefined);
    assert.ok(groupHistoryEntries(all, all, 'day').some(({ entries }) => entries.includes(parent)));
  }
});

test('only legacy parents infer children by full half-open containment', () => {
  const startPoint = leaf('2026-09-13T06:00:00Z', { end: '2026-09-13T06:00:00Z' });
  const last = leaf('2026-09-13T11:50:00Z');
  const endPoint = leaf('2026-09-13T12:00:00Z', { end: '2026-09-13T12:00:00Z' });
  const crossesEnd = leaf('2026-09-13T11:55:00Z');
  const parent = rollup('2026-09-13T06:00:00Z');
  const all = [endPoint, last, parent, startPoint, crossesEnd];
  const groups = groupHistoryEntries(all, all, '6h');
  assert.deepEqual(groups.find(({ summary }) => summary)?.entries, [last, startPoint]);
  assert.deepEqual(groups.filter(({ summary }) => !summary).map(memberIds), [[endPoint.id], [crossesEnd.id]]);
});

test('duplicate input IDs and repeated provenance never render duplicate parents or children', () => {
  const child = leaf('2026-09-13T06:10:00Z');
  const parent = rollup('2026-09-13T06:00:00Z', [child, child]);
  const raw = leaf('2026-09-13T06:20:00Z', { id: 'raw', summaryLevel: undefined });
  const all = Object.freeze([child, parent, child, parent, raw]);
  const filtered = Object.freeze([parent, child, parent, child, raw]);
  const groups = groupHistoryEntries(all, filtered, '6h');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].summary, parent);
  assert.deepEqual(groups[0].entries, [child]);
  assert.deepEqual(groupHistoryEntries([...all].reverse(), [...filtered].reverse(), '6h'), groups);
});

test('all granularities preserve collection IDs when filters narrow their members', () => {
  const a = leaf(day(13, 12));
  const b = leaf(day(13, 13));
  const all = [a, b];
  for (const kind of ['10min', '6h', 'day'] as const) {
    const full = groupHistoryEntries(all, all, kind);
    const filtered = groupHistoryEntries(all, [{ ...a }], kind);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].entries[0], a);
    assert.ok(full.some(({ id }) => id === filtered[0].id));
  }
});

test('empty, raw-only, invalid ranges and noncanonical filtered entries do not produce collections', () => {
  const valid = leaf(day(13));
  const all = [
    leaf(day(13), { id: 'raw', summaryLevel: undefined }),
    leaf(day(13), { id: 'invalid-start', start: 'invalid' }),
    leaf(day(13), { id: 'invalid-end', end: 'invalid' }),
    leaf(day(13), { id: 'backwards', end: day(12) }),
  ];
  for (const kind of ['10min', '6h', 'day'] as HistoryGranularity[]) {
    assert.deepEqual(groupHistoryEntries([], [], kind), []);
    assert.deepEqual(groupHistoryEntries(all, [...all, valid], kind), []);
  }
});

test('day bounds use local calendar midnights across spring and autumn DST', () => {
  inTimezone('America/New_York', () => {
    for (const [start, expectedDay, hours] of [
      ['2026-03-08T12:00:00-04:00', '2026-03-08', 23],
      ['2026-11-01T12:00:00-05:00', '2026-11-01', 25],
    ] as const) {
      const activity = leaf(start);
      const groups = groupHistoryEntries([activity], [activity], 'day');
      assert.equal(groups.length, 1);
      assert.equal(groups[0].day, expectedDay);
      assert.equal(Date.parse(groups[0].end) - Date.parse(groups[0].start), hours * 60 * 60 * 1_000);
      assert.equal(new Date(groups[0].start).getHours(), 0);
      assert.equal(new Date(groups[0].end).getHours(), 0);
      const sixHour = groupHistoryEntries([activity], [activity], '6h')[0];
      assert.equal(Date.parse(sixHour.start) % 21_600_000, 0);
      assert.equal(Date.parse(sixHour.end) - Date.parse(sixHour.start), 21_600_000);
    }
  });
});
