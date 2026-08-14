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

function linkedTo(parentSessionId: string): Partial<SessionSummary> {
  return {
    subagentParent: {
      kind: 'subagent',
      parentSessionId,
      spawnedBy: { parentRunId: 'run-1', parentTurnId: 'turn-1', toolCallId: 'call-1' },
      lifecycle: 'foreground',
    },
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
      archivedTaskRows(family, undefined).map((session) => session.id),
      ['v3'],
    );
  });

  it('keeps a linked subagent session out of the list while its parent is there', () => {
    const sessions = [
      summary('parent', { isArchived: true, lastMessageAt: 200 }),
      summary('child', { isArchived: true, lastMessageAt: 300, ...linkedTo('parent') }),
    ];

    assert.deepEqual(
      archivedTaskRows(sessions, undefined).map((session) => session.id),
      ['parent'],
    );
  });

  it('lists a linked subagent session whose parent is gone, exactly as the rail does', () => {
    // Deleting an archived parent does not cascade to an ordinary subagent
    // child, so the child outlives it. Hiding the orphan here would leave a
    // task this page claims to clear with no surface that can reach it.
    const sessions = [summary('orphan', { isArchived: true, lastMessageAt: 300, ...linkedTo('deleted-parent') })];

    assert.deepEqual(
      archivedTaskRows(sessions, undefined).map((session) => session.id),
      ['orphan'],
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
      archivedTaskRows(sessions, undefined).map((session) => session.id),
      ['old', 'older'],
    );
  });
});

describe('matchesArchivedTaskQuery', () => {
  const projectLabelOf = (session: SessionSummary) =>
    session.projectId === 'p1' ? 'astryx-design' : undefined;

  it('keeps every task while the box is empty or only whitespace', () => {
    const task = summary('a', { name: 'rail sorting' });
    assert.equal(matchesArchivedTaskQuery(task, '', projectLabelOf), true);
    assert.equal(matchesArchivedTaskQuery(task, '   ', projectLabelOf), true);
  });

  it('matches the task name regardless of case or surrounding spaces', () => {
    const task = summary('a', { name: 'Fix rail sorting' });
    assert.equal(matchesArchivedTaskQuery(task, '  RAIL ', projectLabelOf), true);
    assert.equal(matchesArchivedTaskQuery(task, 'compaction', projectLabelOf), false);
  });

  it('matches the project name, because the row shows it too', () => {
    const task = summary('a', { name: 'Fix rail sorting', projectId: 'p1' });
    assert.equal(matchesArchivedTaskQuery(task, 'astryx', projectLabelOf), true);
  });

  it('never matches across the seam between the name and the project', () => {
    // "sorting astryx" reads like a match on the joined string and like
    // nothing at all on the row, which is the one answer a reader cannot
    // account for.
    const task = summary('a', { name: 'Fix rail sorting', projectId: 'p1' });
    assert.equal(matchesArchivedTaskQuery(task, 'sorting astryx', projectLabelOf), false);
  });

  it('falls back to the name when the project could not be resolved', () => {
    const task = summary('a', { name: 'Analyze everything', projectId: 'gone' });
    assert.equal(matchesArchivedTaskQuery(task, 'analyze', projectLabelOf), true);
    assert.equal(matchesArchivedTaskQuery(task, 'undefined', projectLabelOf), false);
  });
});
