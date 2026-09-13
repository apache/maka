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
import { filterHistoryEntries } from '../../renderer/features/module-hub/testing.js';

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
    { ...activity, id: 'wrong-day', start: new Date(2026, 8, 12, 12).toISOString() },
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
