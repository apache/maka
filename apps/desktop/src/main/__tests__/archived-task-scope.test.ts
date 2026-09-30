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
import { type Deferred, deferred } from '@maka/core/test-only/async-primitives';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import type { SessionRemovePreviewResult } from '@maka/runtime-host/protocol';
import { getSettingsTasksCopy } from '../../renderer/locales/settings-tasks-copy.js';
import {
  archivedProjectOptions,
  availableProjectFilter,
  createPurgeConfirmationController,
  describePurgeConfirmation,
  isArchivedTaskScopeNarrowed,
  type ArchivedTaskScope,
  type PurgeConfirmation,
  scopeArchivedTasks,
  UNSCOPED_ARCHIVED_TASKS,
} from '../../renderer/features/archived-task-cleanup/testing.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

function task(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
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
    ...overrides,
  };
}

const PROJECTS: Record<string, { key: string; label: string }> = {
  alpha: { key: 'project:alpha', label: 'Alpha' },
  beta: { key: 'project:beta', label: 'Beta' },
};

/** `gone` stands for a project id this page cannot name. */
function projectOf(session: SessionSummary) {
  if (!session.projectId) return null;
  return PROJECTS[session.projectId];
}

function visibleIds(rows: readonly SessionSummary[], scope: ArchivedTaskScope) {
  return scopeArchivedTasks(rows, scope, { now: NOW, projectOf, noProjectLabel: 'No project' })
    .visible.map((session) => session.id);
}

describe('scopeArchivedTasks', () => {
  it('keeps only tasks archived strictly more than N days ago', () => {
    const rows = [
      task('exactly-7', { archivedAt: NOW - 7 * DAY }),
      task('just-over-7', { archivedAt: NOW - 7 * DAY - 1 }),
      task('exactly-30', { archivedAt: NOW - 30 * DAY }),
      task('just-over-30', { archivedAt: NOW - 30 * DAY - 1 }),
      task('just-over-90', { archivedAt: NOW - 90 * DAY - 1 }),
      task('archived-in-the-future', { archivedAt: NOW + DAY }),
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
      task('known-old', { archivedAt: NOW - 100 * DAY }),
      // Old by every other clock; still no archive time to judge by.
      task('legacy', { lastMessageAt: NOW - 400 * DAY }),
      task('legacy-elsewhere', { projectId: 'beta' }),
    ];
    const context = { now: NOW, projectOf, noProjectLabel: 'No project' };
    const aged = scopeArchivedTasks(rows, { ...UNSCOPED_ARCHIVED_TASKS, minAgeDays: 7 }, context);
    assert.deepEqual(
      aged.visible.map((session) => session.id),
      ['known-old'],
    );
    assert.equal(aged.unknownArchiveTime, 2);
    // Only the rows the other filters kept are counted as left out for age.
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
      task('a1', { projectId: 'alpha' }),
      task('loose'),
      task('b1', { projectId: 'beta' }),
      task('unnamed', { projectId: 'gone' }),
      task('a2', { projectId: 'alpha' }),
    ];
    assert.deepEqual(
      visibleIds(rows, {
        ...UNSCOPED_ARCHIVED_TASKS,
        project: { kind: 'project', key: 'project:alpha' },
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
      task('Fix rail', { projectId: 'alpha', archivedAt: NOW - 40 * DAY }),
      task('Fix rail again', { projectId: 'alpha', archivedAt: NOW - DAY }),
      task('Fix build', { projectId: 'beta', archivedAt: NOW - 40 * DAY }),
      task('Loose notes', { archivedAt: NOW - 40 * DAY }),
    ];
    assert.deepEqual(
      visibleIds(rows, {
        query: ' FIX ',
        minAgeDays: 30,
        project: { kind: 'project', key: 'project:alpha' },
      }),
      ['Fix rail'],
    );
    // The project label is on screen, so it answers to the box too.
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
});

describe('archivedProjectOptions', () => {
  it('offers each named project once, by label, and "No project" only when used', () => {
    const rows = [
      task('b', { projectId: 'beta' }),
      task('a', { projectId: 'alpha' }),
      task('b2', { projectId: 'beta' }),
      task('unnamed', { projectId: 'gone' }),
    ];
    assert.deepEqual(archivedProjectOptions(rows, projectOf), {
      projects: [PROJECTS.alpha, PROJECTS.beta],
      hasNoProject: false,
    });
    assert.equal(archivedProjectOptions([...rows, task('loose')], projectOf).hasNoProject, true);
  });

  it('falls back to all projects once a chosen project has no rows left', () => {
    const options = archivedProjectOptions([task('a', { projectId: 'alpha' })], projectOf);
    assert.deepEqual(
      availableProjectFilter({ kind: 'project', key: 'project:alpha' }, options),
      { kind: 'project', key: 'project:alpha' },
    );
    assert.deepEqual(availableProjectFilter({ kind: 'project', key: 'project:beta' }, options), {
      kind: 'all',
    });
    assert.deepEqual(availableProjectFilter({ kind: 'none' }, options), { kind: 'all' });
  });
});

describe('purge confirmation', () => {
  const preview: SessionRemovePreviewResult = {
    archivableSubtaskCount: 1,
    removedSubtaskCount: 2,
    worktreeCount: 3,
    bytes: 4096,
  };

  function harness() {
    const requests: Array<{
      ids: readonly string[];
      answer: Deferred<SessionRemovePreviewResult>;
    }> = [];
    let state: PurgeConfirmation | undefined;
    const controller = createPurgeConfirmationController({
      previewRemovals: (ids) => {
        const answer = deferred<SessionRemovePreviewResult>();
        requests.push({ ids, answer });
        return answer.promise;
      },
      onChange: (next) => {
        state = next;
      },
    });
    return { controller, requests, state: () => state };
  }

  it('deletes exactly the ids it previewed, and only once the preview settles', async () => {
    const { controller, requests, state } = harness();
    const shown = ['a', 'b'];
    controller.open(shown, true);
    // The list changing underneath the dialog does not change what it deletes.
    shown.push('c');
    assert.deepEqual(requests[0]?.ids, ['a', 'b']);
    assert.equal(state()?.preview.kind, 'loading');
    assert.equal(controller.confirm(), undefined, 'no delete while the preview computes');
    assert.notEqual(state(), undefined);

    requests[0]?.answer.resolve(preview);
    await Promise.resolve();
    assert.deepEqual(state()?.preview, { kind: 'ready', preview });
    assert.deepEqual(controller.confirm(), ['a', 'b']);
    assert.equal(state(), undefined);
    assert.equal(controller.confirm(), undefined, 'a closed dialog deletes nothing');
  });

  it('keeps a failed preview usable: cancel, or delete the counted tasks', async () => {
    const { controller, requests, state } = harness();
    controller.open(['a'], false);
    requests[0]?.answer.reject(new Error('Host unavailable'));
    await Promise.resolve();
    assert.deepEqual(state(), { sessionIds: ['a'], narrowed: false, preview: { kind: 'failed' } });
    controller.cancel();
    assert.equal(state(), undefined);

    controller.open(['a'], false);
    requests[1]?.answer.reject(new Error('Host unavailable'));
    await Promise.resolve();
    assert.deepEqual(controller.confirm(), ['a']);
  });

  it('ignores a preview that lands after its dialog closed or was replaced', async () => {
    const { controller, requests, state } = harness();
    controller.open(['old'], false);
    controller.cancel();
    requests[0]?.answer.resolve(preview);
    await Promise.resolve();
    assert.equal(state(), undefined, 'a cancelled dialog does not reopen');

    controller.open(['first'], false);
    controller.open(['second'], true);
    requests[1]?.answer.resolve(preview);
    await Promise.resolve();
    assert.deepEqual(state(), {
      sessionIds: ['second'],
      narrowed: true,
      preview: { kind: 'loading' },
    });
  });

  it('reports failure at once without a Desktop preview service', () => {
    let state: PurgeConfirmation | undefined;
    const controller = createPurgeConfirmationController({
      onChange: (next) => {
        state = next;
      },
    });
    controller.open(['a'], false);
    assert.equal(state?.preview.kind, 'failed');
  });

  it('states the Host figures when known and only the certainties when not', () => {
    const copy = getSettingsTasksCopy('en');
    const size = (bytes: number) => `${bytes} B`;
    const ready = describePurgeConfirmation(
      { sessionIds: ['a', 'b'], narrowed: true, preview: { kind: 'ready', preview } },
      copy,
      size,
    );
    assert.equal(ready.title, 'Delete the 2 tasks shown?');
    assert.match(ready.description, /2 child tasks and 3 subagent worktrees/);
    assert.match(ready.description, /About 4096 B of task data \(an estimate\)/);
    assert.match(ready.description, /1 ordinary subtask is kept/);

    const nothingKept = describePurgeConfirmation(
      {
        sessionIds: ['a'],
        narrowed: false,
        preview: { kind: 'ready', preview: { ...preview, archivableSubtaskCount: 0 } },
      },
      copy,
      size,
    );
    assert.equal(nothingKept.title, 'Clear the 1 archived task?');
    assert.doesNotMatch(nothingKept.description, /kept and moved/);

    const failed = describePurgeConfirmation(
      { sessionIds: ['a', 'b', 'c'], narrowed: false, preview: { kind: 'failed' } },
      copy,
      size,
    );
    assert.equal(failed.title, 'Clear all 3 archived tasks?');
    assert.match(failed.description, /Could not work out what else will be removed/);
    assert.match(failed.description, /Any ordinary subtasks are kept/);
    assert.doesNotMatch(failed.description, /child task|B of task data/);
  });
});
