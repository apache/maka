import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { projectTaskRows } from '../../renderer/settings/task-catalog-rows.js';

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

describe('projectTaskRows', () => {
  it('folds an edit-and-resend family into the one task a person archived', () => {
    const family = [
      summary('v3', { isArchived: true, lastMessageAt: 300, revisionRootSessionId: 'v1', revisionParentSessionId: 'v2' }),
      summary('v2', { isArchived: true, lastMessageAt: 200, revisionRootSessionId: 'v1', revisionParentSessionId: 'v1' }),
      summary('v1', { isArchived: true, lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      projectTaskRows(family, 'archived').map((session) => session.id),
      ['v3'],
    );
    assert.deepEqual(
      projectTaskRows(family, 'all').map((session) => session.id),
      ['v3'],
    );
  });

  it('hides a revision that is still preparing', () => {
    const family = [
      summary('draft', {
        lastMessageAt: 400,
        revisionRootSessionId: 'root',
        revisionParentSessionId: 'root',
        revisionState: 'preparing',
      }),
      summary('root', { lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      projectTaskRows(family, 'all').map((session) => session.id),
      ['root'],
    );
  });

  it('keeps linked subagent sessions out of the task list', () => {
    const sessions = [
      summary('parent', { lastMessageAt: 200 }),
      summary('child', {
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
      projectTaskRows(sessions, 'all').map((session) => session.id),
      ['parent'],
    );
  });

  it('leaves ordinary branch sessions as separate tasks', () => {
    const sessions = [summary('a', { lastMessageAt: 200 }), summary('b', { lastMessageAt: 100 })];

    assert.deepEqual(
      projectTaskRows(sessions, 'all').map((session) => session.id),
      ['a', 'b'],
    );
  });

  it('narrows to archived tasks without reordering the store', () => {
    const sessions = [
      summary('active', { lastMessageAt: 300 }),
      summary('old', { isArchived: true, lastMessageAt: 200 }),
      summary('older', { isArchived: true, lastMessageAt: 100 }),
    ];

    assert.deepEqual(
      projectTaskRows(sessions, 'archived').map((session) => session.id),
      ['old', 'older'],
    );
  });
});
