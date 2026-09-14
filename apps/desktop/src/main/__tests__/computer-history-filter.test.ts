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
import type { ComputerHistoryApplication, ComputerHistoryTimelineEntry } from '@maka/core/computer-history';
import { computerHistorySearchExcerpt } from '@maka/core/computer-history';
import { filterHistoryEntries, historySearchHint, intersectHistoryDays } from '../../renderer/features/module-hub/testing.js';

function entry(id: string, start: string, overrides: Partial<ComputerHistoryTimelineEntry> = {}): ComputerHistoryTimelineEntry {
  return {
    id, start, end: start, title: 'Observed activity', description: '',
    applications: ['com.example.Editor'], eventCount: 1, suppressedEventCount: 0,
    contextMarkdown: '', ...overrides,
  };
}

const ids = (entries: readonly ComputerHistoryTimelineEntry[]) => entries.map((value) => value.id);

test('all days includes older activity, sorts newest first and leaves the input untouched', () => {
  const entries = Object.freeze([
    Object.freeze(entry('old', '2026-08-01T09:00:00Z')),
    Object.freeze(entry('b', '2026-09-13T10:00:00Z')),
    Object.freeze(entry('middle', '2026-09-12T09:00:00Z')),
    Object.freeze(entry('a', '2026-09-13T10:00:00Z')),
  ]);
  const before = structuredClone(entries);
  const result = filterHistoryEntries(entries, '', '', '');
  assert.deepEqual(ids(result), ['a', 'b', 'middle', 'old']);
  assert.deepEqual(entries, before);
  assert.notEqual(result, entries);
  assert.equal(result[0], entries[3]);
});

test('an exact local date includes midnight and excludes both adjacent days', () => {
  const midnight = new Date(2026, 8, 13).getTime();
  const nextMidnight = new Date(2026, 8, 14).getTime();
  const entries = [
    entry('before', new Date(midnight - 1).toISOString()),
    entry('midnight', new Date(midnight).toISOString()),
    entry('last-millisecond', new Date(nextMidnight - 1).toISOString()),
    entry('next-day', new Date(nextMidnight).toISOString()),
    entry('other-month', new Date(2026, 7, 13, 12).toISOString()),
  ];
  assert.deepEqual(ids(filterHistoryEntries(entries, '2026-09-13', '', '')), ['last-millisecond', 'midnight']);
});

test('known application names, descriptions and summaries intersect with date and source filters', () => {
  const start = new Date(2026, 8, 13, 12).toISOString();
  const activity = entry('match', start, {
    description: 'Reviewed the permissions boundary',
    summaryText: 'Finalized the retention policy',
  });
  const entries = [
    activity,
    entry('wrong-day', new Date(2026, 8, 12, 12).toISOString(), {
      description: activity.description, summaryText: activity.summaryText,
    }),
    { ...activity, id: 'wrong-source', applications: ['com.example.Browser'] },
  ];
  const applications = new Map<string, ComputerHistoryApplication>([
    ['com.example.Editor', { bundleIdentifier: 'com.example.Editor', name: 'Visual Studio Code', iconDataUrl: null }],
  ]);
  for (const query of [' VISUAL STUDIO ', 'PERMISSIONS BOUNDARY', 'retention policy']) {
    assert.deepEqual(ids(filterHistoryEntries(entries, '2026-09-13', query, 'com.example.Editor', applications)), ['match']);
  }
  assert.deepEqual(filterHistoryEntries(entries, '2026-09-13', 'not observed', 'com.example.Editor', applications), []);
});

test('date filtering uses half-open overlap, including containing intervals and midnight point events', () => {
  const at = (day: number, hour = 0) => new Date(2026, 8, day, hour).toISOString();
  const entries = [
    entry('ends-at-start', at(12, 23), { end: at(13) }),
    entry('crosses-start', at(12, 23), { end: at(13, 1) }),
    entry('contains-day', at(12), { end: at(15) }),
    entry('ends-at-end', at(13, 23), { end: at(14) }),
    entry('crosses-end', at(13, 23), { end: at(14, 1) }),
    entry('starts-at-end', at(14), { end: at(14, 1) }),
    entry('point-at-start', at(13)),
    entry('point-at-end', at(14)),
    entry('invalid', 'invalid'),
    entry('backwards', at(13, 12), { end: at(12) }),
  ];
  assert.deepEqual(ids(filterHistoryEntries(entries, '2026-09-13', '', '')), [
    'crosses-end', 'ends-at-end', 'point-at-start', 'crosses-start', 'contains-day',
  ]);
});

test('normalized whitespace tokens AND across metadata, actual filename and on-demand full-body excerpts', () => {
  const prefix = 'Observed context. '.repeat(800);
  const body = `${prefix}\n<AXWebArea> unique-tail Ｃａｆé`;
  const activity = Object.freeze(entry('full', '2026-09-13T10:00:00Z', {
    title: 'API review', description: 'Saved investigation',
    keywords: Object.freeze(['任务评测', 'Agent Native']),
    summaryText: prefix.slice(0, 12_000),
    documentName: '2026-09-13_10-00_10min_review-notes.md',
    contextMarkdown: 'private-draft-only',
    suggestion: { type: 'skill', name: 'suggestion-only', description: 'hidden suggestion' },
  }));
  const apps = new Map([['com.example.Editor', {
    bundleIdentifier: 'com.example.Editor', name: 'Visual Studio Code', iconDataUrl: null,
  }]]);
  for (const query of [
    'ＡＰＩ\t任务评测\nunique-tail   <axwebarea>  review-notes.md　VISUAL',
    'native agent', 'ＣＡＦＥ\u0301', 'unique-tail unique-tail',
  ]) {
    const projected = { ...activity, searchText: computerHistorySearchExcerpt(body, query) };
    assert.ok(projected.searchText.length <= 2048);
    assert.deepEqual(filterHistoryEntries([projected], '', query, '', apps), [projected], query);
  }
  for (const query of ['API nonexistent', 'private-draft-only', 'suggestion-only', 'full', '48KiB']) {
    assert.deepEqual(filterHistoryEntries([activity], '', query, '', apps), [], query);
  }
  assert.deepEqual(filterHistoryEntries([activity], '', 'unique-tail', 'wrong-source', apps), []);
  assert.deepEqual(filterHistoryEntries([activity], '2026-09-14', 'unique-tail', '', apps), []);
  assert.equal(activity.searchText, undefined, 'idle entries do not project full bodies');
});

test('legacy previews still match, explicit empty body excerpts take precedence, and results remain chronological', () => {
  const old = entry('old', '2026-09-13T08:00:00Z', { summaryText: 'legacy café body' });
  const newest = entry('new', '2026-09-13T10:00:00Z', { searchText: 'body café' });
  const empty = { ...newest, id: 'empty', searchText: '', summaryText: 'must-not-match' };
  assert.deepEqual(ids(filterHistoryEntries([old, newest, empty], '', 'cafe\u0301 body', '')), ['new', 'old']);
  assert.deepEqual(filterHistoryEntries([empty], '', 'must-not-match', ''), []);
  assert.deepEqual(ids(filterHistoryEntries([old, newest], '', '\t \n　', '')), ['new', 'old']);
});

test('match hints identify hidden-field hits without labeling nonmatching parents or obvious title hits', () => {
  const activity = entry('one', '2026-09-13T10:00:00Z', {
    title: 'API review', keywords: ['Agent Native'], searchText: '<AXWebArea> evidence',
    documentName: 'review-notes.md',
  });
  const apps = new Map();
  assert.equal(historySearchHint(activity, 'API', apps), undefined);
  assert.equal(historySearchHint(activity, '\n　', apps), undefined);
  assert.equal(historySearchHint(activity, 'API missing', apps), undefined);
  assert.deepEqual(historySearchHint(activity, 'API native', apps), { kind: 'keywordMatch', text: 'Agent Native' });
  assert.deepEqual(historySearchHint(activity, 'API <axwebarea>', apps), { kind: 'bodyMatch', text: '<AXWebArea> evidence' });
  assert.deepEqual(historySearchHint(activity, 'API notes.md', apps), { kind: 'filenameMatch', text: 'review-notes.md' });
  const tail = historySearchHint({ ...activity, searchText: `${'Résumé ＡＰＩ e\u0301 '.repeat(900)}\n<Script>TailOnly</Script>  exact evidence` }, 'tailonly', apps);
  assert.equal(tail?.kind, 'bodyMatch');
  assert.ok(tail?.text.includes('<Script>TailOnly</Script> exact evidence'));
  assert.ok(tail!.text.length < 200);
});

test('local day intersection handles an exclusive end, point, invalid and backwards ranges', () => {
  const start = new Date(2026, 8, 12, 23).toISOString();
  const midnight = new Date(2026, 8, 14).toISOString();
  assert.deepEqual(intersectHistoryDays({ start, end: midnight }), ['2026-09-12', '2026-09-13']);
  assert.deepEqual(intersectHistoryDays({ start: midnight, end: midnight }), ['2026-09-14']);
  assert.deepEqual(intersectHistoryDays({ start: 'invalid', end: midnight }), []);
  assert.deepEqual(intersectHistoryDays({ start, end: 'invalid' }), []);
  assert.deepEqual(intersectHistoryDays({ start: midnight, end: start }), []);
});

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

test('UTC+8 cross-midnight rollup matches both local dates while source and search still intersect', () => {
  inTimezone('Asia/Shanghai', () => {
    const rollup = entry('rollup', '2026-09-13T12:00:00Z', {
      end: '2026-09-13T18:00:00Z', summaryLevel: '6h', summaryText: 'Reviewed retention',
    });
    assert.deepEqual(intersectHistoryDays(rollup), ['2026-09-13', '2026-09-14']);
    for (const day of ['2026-09-13', '2026-09-14']) {
      assert.deepEqual(filterHistoryEntries([rollup], day, 'retention', 'com.example.Editor'), [rollup]);
      assert.deepEqual(filterHistoryEntries([rollup], day, 'missing', 'com.example.Editor'), []);
      assert.deepEqual(filterHistoryEntries([rollup], day, 'retention', 'com.example.Browser'), []);
    }
    assert.deepEqual(filterHistoryEntries([rollup], '2026-09-15', '', ''), []);
  });
});

test('local date stepping follows both DST transitions without losing or inventing dates', () => {
  inTimezone('America/New_York', () => {
    for (const [start, end, expected] of [
      ['2026-03-07T23:30:00-05:00', '2026-03-10T00:00:00-04:00', ['2026-03-07', '2026-03-08', '2026-03-09']],
      ['2026-10-31T23:30:00-04:00', '2026-11-03T00:00:00-05:00', ['2026-10-31', '2026-11-01', '2026-11-02']],
    ] as const) {
      const activity = entry('dst', start, { end });
      assert.deepEqual(intersectHistoryDays(activity), expected);
      for (const day of expected) {
        assert.deepEqual(filterHistoryEntries([activity], day, '', ''), [activity]);
      }
    }
    assert.deepEqual(intersectHistoryDays({
      start: '2026-11-01T01:30:00-04:00', end: '2026-11-01T01:30:00-05:00',
    }), ['2026-11-01']);
  });
});

test('date stepping resets midnight after a zone skips its midnight hour', () => {
  inTimezone('America/Sao_Paulo', () => {
    assert.deepEqual(intersectHistoryDays({
      start: '2018-11-03T23:30:00-03:00', end: '2018-11-05T00:30:00-02:00',
    }), ['2018-11-03', '2018-11-04', '2018-11-05']);
    assert.deepEqual(intersectHistoryDays({
      start: '2018-11-03T23:30:00-03:00', end: '2018-11-05T00:00:00-02:00',
    }), ['2018-11-03', '2018-11-04']);
  });
});
