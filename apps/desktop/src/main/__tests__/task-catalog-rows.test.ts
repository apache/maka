import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import {
  archivedTaskRows,
  filterArchivedTasks,
  NO_PROJECT_FILTER,
} from '../../renderer/settings/task-catalog-rows.js';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
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

describe('archivedTaskRows', () => {
  it('folds an edit-and-resend family into the one task a person archived', () => {
    const family = [
      summary('v3', {
        isArchived: true,
        lastMessageAt: 300,
        revisionRootSessionId: 'v1',
        revisionParentSessionId: 'v2',
      }),
      summary('v2', {
        isArchived: true,
        lastMessageAt: 200,
        revisionRootSessionId: 'v1',
        revisionParentSessionId: 'v1',
      }),
      summary('v1', { isArchived: true, lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      archivedTaskRows(family).map((session) => session.id),
      ['v3'],
    );
  });

  it('hides a revision that is still preparing', () => {
    const family = [
      summary('draft', {
        isArchived: true,
        lastMessageAt: 400,
        revisionRootSessionId: 'root',
        revisionParentSessionId: 'root',
        revisionState: 'preparing',
      }),
      summary('root', { isArchived: true, lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      archivedTaskRows(family).map((session) => session.id),
      ['root'],
    );
  });

  it('keeps linked subagent sessions out of the list', () => {
    const sessions = [
      summary('parent', { isArchived: true, lastMessageAt: 200 }),
      summary('child', {
        isArchived: true,
        lastMessageAt: 300,
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'parent',
          spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
          lifecycle: 'foreground',
        },
      }),
    ];

    assert.deepEqual(
      archivedTaskRows(sessions).map((session) => session.id),
      ['parent'],
    );
  });

  it('leaves ordinary branch sessions as separate tasks', () => {
    const sessions = [
      summary('a', { isArchived: true, lastMessageAt: 200 }),
      summary('b', { isArchived: true, lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      archivedTaskRows(sessions).map((session) => session.id),
      ['a', 'b'],
    );
  });

  it('drops active tasks without reordering the store', () => {
    const sessions = [
      summary('active', { lastMessageAt: 300 }),
      summary('old', { isArchived: true, lastMessageAt: 200 }),
      summary('newer-active', { lastMessageAt: 150 }),
      summary('older', { isArchived: true, lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      archivedTaskRows(sessions).map((session) => session.id),
      ['old', 'older'],
    );
  });
});

describe('filterArchivedTasks', () => {
  const rows = [
    summary('a', { name: 'Rebuild the session rail', isArchived: true, projectId: 'p1' }),
    summary('b', { name: 'Fix the CI type error', isArchived: true, projectId: 'p2' }),
    summary('c', { name: 'Weather in Guiyang', isArchived: true }),
  ];
  const projectNameOf = (id: string) => ({ p1: 'maka-agent', p2: 'astryx' })[id];
  const all = { query: '', projectId: null };

  it('passes everything through when nothing is asked of it', () => {
    assert.deepEqual(
      filterArchivedTasks(rows, all, projectNameOf).map((s) => s.id),
      ['a', 'b', 'c'],
    );
  });

  it('matches the task name case-insensitively', () => {
    assert.deepEqual(
      filterArchivedTasks(rows, { ...all, query: '  RAIL ' }, projectNameOf).map((s) => s.id),
      ['a'],
    );
  });

  it('matches the project name, which is on screen next to the task', () => {
    assert.deepEqual(
      filterArchivedTasks(rows, { ...all, query: 'astryx' }, projectNameOf).map((s) => s.id),
      ['b'],
    );
  });

  it('narrows to one project', () => {
    assert.deepEqual(
      filterArchivedTasks(rows, { ...all, projectId: 'p1' }, projectNameOf).map((s) => s.id),
      ['a'],
    );
  });

  it('narrows to tasks that belong to no project', () => {
    assert.deepEqual(
      filterArchivedTasks(rows, { ...all, projectId: NO_PROJECT_FILTER }, projectNameOf).map(
        (s) => s.id,
      ),
      ['c'],
    );
  });

  it('applies the search and the project filter together', () => {
    assert.deepEqual(
      filterArchivedTasks(rows, { query: 'fix', projectId: 'p1' }, projectNameOf).map((s) => s.id),
      [],
    );
  });
});
