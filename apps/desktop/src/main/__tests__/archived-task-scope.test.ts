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
import type { SessionSummary } from '@maka/core/session';
import {
  archivedAgeThresholdMs,
  archivedProjectOptions,
  archivedTaskProjectResolver,
  availableProjectFilter,
  isArchivedTaskScopeNarrowed,
  matchesArchivedTaskQuery,
  scopeArchivedTasks,
  UNSCOPED_ARCHIVED_TASKS,
  type ArchivedTaskScope,
} from '../../renderer/features/session-navigation/testing.js';
import { runtimeHostProjectKey } from '../../renderer/application/contracts/runtime-host-project-key.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

type Task = SessionSummary & { runtimeHostId: string };

function summary(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: true,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    runtimeHostId: 'host-1',
    ...overrides,
  };
}

function scope(hostId: string, id: string, name: string, aliases?: string[]) {
  return {
    key: runtimeHostProjectKey(hostId, id),
    hostId,
    profileName: `Profile ${hostId}`,
    project: { id, name, ...(aliases ? { aliases } : {}) },
  };
}

const projectOf = archivedTaskProjectResolver([
  scope('host-1', 'alpha', 'Alpha'),
  scope('host-1', 'beta', 'Beta'),
]);
const labelOf = (session: Task) => {
  const project = projectOf(session);
  return project === null ? 'No project' : project?.label;
};

function visibleIds(rows: readonly Task[], filter: ArchivedTaskScope) {
  return scopeArchivedTasks(rows, filter, { now: NOW, projectOf, labelOf }).visible.map(
    (session) => session.id,
  );
}

describe('scopeArchivedTasks', () => {
  it('keeps only tasks archived strictly more than N days ago', () => {
    const rows = [
      summary('exactly-7', { archivedAt: NOW - 7 * DAY }),
      summary('just-over-7', { archivedAt: NOW - 7 * DAY - 1 }),
      summary('exactly-30', { archivedAt: NOW - 30 * DAY }),
      summary('just-over-30', { archivedAt: NOW - 30 * DAY - 1 }),
      summary('just-over-90', { archivedAt: NOW - 90 * DAY - 1 }),
      summary('archived-in-the-future', { archivedAt: NOW + DAY }),
    ];
    assert.deepEqual(visibleIds(rows, { ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 7 }), [
      'just-over-7',
      'exactly-30',
      'just-over-30',
      'just-over-90',
    ]);
    assert.deepEqual(visibleIds(rows, { ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 30 }), [
      'just-over-30',
      'just-over-90',
    ]);
    assert.deepEqual(visibleIds(rows, { ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 90 }), [
      'just-over-90',
    ]);
  });

  it('leaves out, and counts, unknown archive times only under an age filter', () => {
    const rows = [
      summary('known-old', { archivedAt: NOW - 100 * DAY }),
      // Old by every other clock; still no archive time to judge by.
      summary('legacy', { lastMessageAt: NOW - 400 * DAY }),
      summary('legacy-elsewhere', { projectId: 'beta' }),
    ];
    const context = { now: NOW, projectOf, labelOf };
    const aged = scopeArchivedTasks(rows, { ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 7 }, context);
    assert.deepEqual(
      aged.visible.map((session) => session.id),
      ['known-old'],
    );
    assert.equal(aged.unknownArchiveTime, 2);
    // Only rows the other filters kept count as left out for their age.
    const agedLoose = scopeArchivedTasks(
      rows,
      { ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 7, project: { kind: 'none' } },
      context,
    );
    assert.equal(agedLoose.unknownArchiveTime, 1);
    const anyTime = scopeArchivedTasks(rows, UNSCOPED_ARCHIVED_TASKS, context);
    assert.deepEqual(
      anyTime.visible.map((session) => session.id),
      ['known-old', 'legacy', 'legacy-elsewhere'],
    );
    assert.equal(anyTime.unknownArchiveTime, 0);
  });

  it('filters by project, by "No project", and never claims an unnamed project', () => {
    const rows = [
      summary('a1', { projectId: 'alpha' }),
      summary('loose'),
      summary('b1', { projectId: 'beta' }),
      summary('unnamed', { projectId: 'gone' }),
      summary('a2', { projectId: 'alpha' }),
    ];
    assert.deepEqual(
      visibleIds(rows, {
        ...UNSCOPED_ARCHIVED_TASKS,
        project: { kind: 'project', key: runtimeHostProjectKey('host-1', 'alpha') },
      }),
      ['a1', 'a2'],
    );
    assert.deepEqual(visibleIds(rows, { ...UNSCOPED_ARCHIVED_TASKS, project: { kind: 'none' } }), [
      'loose',
    ]);
    assert.deepEqual(visibleIds(rows, UNSCOPED_ARCHIVED_TASKS), [
      'a1',
      'loose',
      'b1',
      'unnamed',
      'a2',
    ]);
  });

  it('combines search with the filters, searching the label the row shows', () => {
    const rows = [
      summary('Fix rail', { projectId: 'alpha', archivedAt: NOW - 40 * DAY }),
      summary('Fix rail again', { projectId: 'alpha', archivedAt: NOW - DAY }),
      summary('Fix build', { projectId: 'beta', archivedAt: NOW - 40 * DAY }),
      summary('Loose notes', { archivedAt: NOW - 40 * DAY }),
    ];
    assert.deepEqual(
      visibleIds(rows, {
        query: ' FIX ',
        minAgeDays: 30,
        project: { kind: 'project', key: runtimeHostProjectKey('host-1', 'alpha') },
      }),
      ['Fix rail'],
    );
    assert.deepEqual(visibleIds(rows, { ...UNSCOPED_ARCHIVED_TASKS, query: 'beta' }), [
      'Fix build',
    ]);
    assert.deepEqual(visibleIds(rows, { ...UNSCOPED_ARCHIVED_TASKS, query: 'no project' }), [
      'Loose notes',
    ]);
  });

  it('says a scope is narrowed by any of search, age or project', () => {
    assert.equal(isArchivedTaskScopeNarrowed(UNSCOPED_ARCHIVED_TASKS), false);
    assert.equal(isArchivedTaskScopeNarrowed({ ...UNSCOPED_ARCHIVED_TASKS, query: '   ' }), false);
    assert.equal(isArchivedTaskScopeNarrowed({ ...UNSCOPED_ARCHIVED_TASKS, query: 'x' }), true);
    assert.equal(isArchivedTaskScopeNarrowed({ ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 90 }), true);
    assert.equal(
      isArchivedTaskScopeNarrowed({ ...UNSCOPED_ARCHIVED_TASKS, project: { kind: 'none' } }),
      true,
    );
  });

  it('asks the Host to hold an age only while an age filter is on', () => {
    assert.equal(archivedAgeThresholdMs(UNSCOPED_ARCHIVED_TASKS), undefined);
    assert.equal(
      archivedAgeThresholdMs({ ...UNSCOPED_ARCHIVED_TASKS, query: 'x', project: { kind: 'none' } }),
      undefined,
    );
    assert.equal(archivedAgeThresholdMs({ ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 30 }), 30 * DAY);
  });
});

describe('archivedTaskProjectResolver', () => {
  it('keeps equal project ids on two Hosts apart', () => {
    const resolve = archivedTaskProjectResolver([
      scope('host-1', 'shared', 'Maka'),
      scope('host-2', 'shared', 'Maka'),
    ]);
    const onOne = resolve(summary('one', { projectId: 'shared', runtimeHostId: 'host-1' }));
    const onTwo = resolve(summary('two', { projectId: 'shared', runtimeHostId: 'host-2' }));
    assert.equal(onOne?.key, runtimeHostProjectKey('host-1', 'shared'));
    assert.equal(onTwo?.key, runtimeHostProjectKey('host-2', 'shared'));
    // A Host with no such project names nothing, rather than borrowing another's.
    assert.equal(
      resolve(summary('three', { projectId: 'shared', runtimeHostId: 'host-3' })),
      undefined,
    );
    // Same name on two Hosts: two entries, told apart by Host.
    assert.deepEqual(
      archivedProjectOptions(
        [
          summary('one', { projectId: 'shared', runtimeHostId: 'host-1' }),
          summary('two', { projectId: 'shared', runtimeHostId: 'host-2' }),
        ],
        resolve,
      ).projects,
      [
        { key: runtimeHostProjectKey('host-1', 'shared'), label: 'Maka · Profile host-1' },
        { key: runtimeHostProjectKey('host-2', 'shared'), label: 'Maka · Profile host-2' },
      ],
    );
  });

  it('files a task recorded under an alias under its project', () => {
    const resolve = archivedTaskProjectResolver([
      scope('host-1', 'current', 'Maka', ['retired']),
    ]);
    const aliased = resolve(summary('old', { projectId: 'retired' }));
    const current = resolve(summary('new', { projectId: 'current' }));
    assert.deepEqual(aliased, current);
    assert.equal(aliased?.key, runtimeHostProjectKey('host-1', 'current'));
    assert.equal(resolve(summary('loose')), null);
  });
});

describe('archivedProjectOptions', () => {
  it('offers each named project once, by label, and "No project" only when used', () => {
    const rows = [
      summary('b', { projectId: 'beta' }),
      summary('a', { projectId: 'alpha' }),
      summary('b2', { projectId: 'beta' }),
      summary('unnamed', { projectId: 'gone' }),
    ];
    assert.deepEqual(archivedProjectOptions(rows, projectOf), {
      projects: [
        { key: runtimeHostProjectKey('host-1', 'alpha'), label: 'Alpha' },
        { key: runtimeHostProjectKey('host-1', 'beta'), label: 'Beta' },
      ],
      hasNoProject: false,
    });
    assert.equal(archivedProjectOptions([...rows, summary('loose')], projectOf).hasNoProject, true);
  });

  it('falls back to all projects once a chosen project has no rows left', () => {
    const alpha = runtimeHostProjectKey('host-1', 'alpha');
    const options = archivedProjectOptions([summary('a', { projectId: 'alpha' })], projectOf);
    assert.deepEqual(availableProjectFilter({ kind: 'project', key: alpha }, options), {
      kind: 'project',
      key: alpha,
    });
    assert.deepEqual(
      availableProjectFilter(
        { kind: 'project', key: runtimeHostProjectKey('host-1', 'beta') },
        options,
      ),
      { kind: 'all' },
    );
    assert.deepEqual(availableProjectFilter({ kind: 'none' }, options), { kind: 'all' });
  });
});

describe('matchesArchivedTaskQuery', () => {
  const projectLabelOf = (session: SessionSummary) =>
    session.projectId === 'p1' ? 'astryx-design' : undefined;

  it('keeps every task while the box is empty or only whitespace', () => {
    const task = summary('a', { name: 'rail sorting' });
    assert.equal(matchesArchivedTaskQuery(task, '', projectLabelOf(task)), true);
    assert.equal(matchesArchivedTaskQuery(task, '   ', projectLabelOf(task)), true);
  });

  it('matches the task name regardless of case or surrounding spaces', () => {
    const task = summary('a', { name: 'Fix rail sorting' });
    assert.equal(matchesArchivedTaskQuery(task, '  RAIL ', projectLabelOf(task)), true);
    assert.equal(matchesArchivedTaskQuery(task, 'compaction', projectLabelOf(task)), false);
  });

  it('matches the project name, because the row shows it too', () => {
    const task = summary('a', { name: 'Fix rail sorting', projectId: 'p1' });
    assert.equal(matchesArchivedTaskQuery(task, 'astryx', projectLabelOf(task)), true);
  });

  it('never matches across the seam between the name and the project', () => {
    // "sorting astryx" reads like a match on the joined string and like
    // nothing at all on the row, which is the one answer a reader cannot
    // account for.
    const task = summary('a', { name: 'Fix rail sorting', projectId: 'p1' });
    assert.equal(matchesArchivedTaskQuery(task, 'sorting astryx', projectLabelOf(task)), false);
  });

  it('falls back to the name when the project could not be resolved', () => {
    const task = summary('a', { name: 'Analyze everything', projectId: 'gone' });
    assert.equal(matchesArchivedTaskQuery(task, 'analyze', projectLabelOf(task)), true);
    assert.equal(matchesArchivedTaskQuery(task, 'undefined', projectLabelOf(task)), false);
  });
});
