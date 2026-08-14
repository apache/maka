import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import {
  archivedTaskRows,
  matchesArchivedTaskQuery,
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

describe('matchesArchivedTaskQuery', () => {
  const projectNameOf = (session: SessionSummary) =>
    session.projectId === 'p1' ? 'astryx-design' : '无项目';

  it('keeps every task while the box is empty or only whitespace', () => {
    const task = summary('a', { name: 'rail sorting' });
    assert.equal(matchesArchivedTaskQuery(task, '', projectNameOf), true);
    assert.equal(matchesArchivedTaskQuery(task, '   ', projectNameOf), true);
  });

  it('matches the task name regardless of case or surrounding spaces', () => {
    const task = summary('a', { name: 'Fix rail sorting' });
    assert.equal(matchesArchivedTaskQuery(task, '  RAIL ', projectNameOf), true);
    assert.equal(matchesArchivedTaskQuery(task, 'compaction', projectNameOf), false);
  });

  it('matches the project name, because the row shows it too', () => {
    const task = summary('a', { name: 'Fix rail sorting', projectId: 'p1' });
    assert.equal(matchesArchivedTaskQuery(task, 'astryx', projectNameOf), true);
  });

  it('matches the no-project label for a task that belongs to none', () => {
    const task = summary('a', { name: 'Analyze entire project' });
    assert.equal(matchesArchivedTaskQuery(task, '无项目', projectNameOf), true);
  });
});
