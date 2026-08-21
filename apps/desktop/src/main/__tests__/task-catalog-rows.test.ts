import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import {
  archivedTaskRows,
  isOrphanedSubagentTask,
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
  /**
   * One fixture, one assertion, every rule of the projection at once: a
   * revision family that must fold to its newest member, a linked child that
   * must stay hidden under a parent that is listed, a linked child whose parent
   * is gone and so must be listed on its own, and an active task that must be
   * dropped. Store order is deliberately not recency order — `v2` (200) is
   * followed by `parent` (400) — so a projection that sorted rather than
   * preserved would be caught here rather than pass by coincidence.
   */
  it('lists archived tasks the way the rail counts them, in store order', () => {
    const sessions = [
      summary('v1', { isArchived: true, lastMessageAt: 100 }),
      summary('v2', {
        isArchived: true,
        lastMessageAt: 200,
        revisionRootSessionId: 'v1',
        revisionParentSessionId: 'v1',
      }),
      summary('parent', { isArchived: true, lastMessageAt: 400 }),
      summary('child', { isArchived: true, lastMessageAt: 500, ...linkedTo('parent') }),
      summary('orphan', { isArchived: true, lastMessageAt: 50, ...linkedTo('deleted-parent') }),
      summary('active', { lastMessageAt: 900 }),
    ];

    assert.deepEqual(
      archivedTaskRows(sessions).map((session) => session.id),
      ['v2', 'parent', 'orphan'],
    );
  });

  it('does not let the open session decide which revision represents a task', () => {
    // The rail passes an active id so it can highlight a row; this page has no
    // selection, and pinning the representative to whichever revision happens
    // to be open would move a row's name and date for a reason it never shows.
    const family = [
      summary('v1', { isArchived: true, lastMessageAt: 100 }),
      summary('v2', {
        isArchived: true,
        lastMessageAt: 200,
        revisionRootSessionId: 'v1',
        revisionParentSessionId: 'v1',
      }),
    ];

    assert.deepEqual(
      archivedTaskRows(family).map((session) => session.id),
      ['v2'],
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

describe('isOrphanedSubagentTask', () => {
  it('labels ordinary linked Sessions only when their parent is missing', () => {
    const projected = summary('projected-child', {
      subagent: {
        parentSessionId: 'deleted-parent',
        agentId: 'implementation',
        agentName: 'Implementation',
        profile: 'implementation',
      },
    });
    const local = summary('local-child', linkedTo('deleted-parent'));
    assert.equal(isOrphanedSubagentTask(projected, new Set(['projected-child'])), true);
    assert.equal(
      isOrphanedSubagentTask(projected, new Set(['projected-child', 'deleted-parent'])),
      false,
    );
    assert.equal(isOrphanedSubagentTask(local, new Set(['local-child'])), true);
  });
});
