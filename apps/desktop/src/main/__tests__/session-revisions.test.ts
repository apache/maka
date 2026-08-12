import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { collapseSessionRevisions, revisionFamilySessionIds } from '@maka/core/session-revisions';
import { type SessionSummary } from '@maka/core/session';
import { deriveSessionRevisionNavigation } from '../../renderer/session-revisions.js';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: overrides.name ?? 'Conversation',
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

describe('edit-and-resend session revisions', () => {
  it('folds durable versions into one sidebar slot after restart', () => {
    const root = summary('root', { lastMessageAt: 10 });
    const version2 = summary('version-2', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionOfTurnId: 'turn-2',
      revisionIndex: 2,
      revisionState: 'committed',
      lastMessageAt: 20,
    });
    const ordinaryBranch = summary('branch', {
      parentSessionId: 'root',
      branchOfTurnId: 'turn-1',
      lastMessageAt: 15,
    });

    assert.deepEqual(
      collapseSessionRevisions([version2, ordinaryBranch, root]).map((session) => session.id),
      ['version-2', 'branch'],
    );
  });

  it('restores the most recently continued version as the sidebar head', () => {
    const continuedRoot = summary('root', { lastMessageAt: 30 });
    const version2 = summary('version-2', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionIndex: 2,
      revisionState: 'committed',
      lastMessageAt: 20,
    });

    assert.deepEqual(
      collapseSessionRevisions([version2, continuedRoot]).map((session) => session.id),
      ['root'],
    );
  });

  it('hides a crash-orphaned draft version after restart', () => {
    const root = summary('root', { lastMessageAt: 10 });
    const draft = summary('draft', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionIndex: 2,
      revisionState: 'preparing',
    });

    assert.deepEqual(collapseSessionRevisions([draft, root]).map((session) => session.id), ['root']);
    assert.equal(deriveSessionRevisionNavigation([draft, root], 'root'), undefined);
  });

  it('keeps the selected old version in the same sidebar slot', () => {
    const root = summary('root', { lastMessageAt: 10 });
    const version2 = summary('version-2', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionIndex: 2,
      revisionState: 'committed',
      lastMessageAt: 20,
    });

    assert.deepEqual(
      collapseSessionRevisions([version2, root], 'root').map((session) => session.id),
      ['root'],
    );
  });

  it('keeps lifecycle actions scoped to versions, not ordinary branches', () => {
    const root = summary('root');
    const version2 = summary('version-2', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
    });
    const branch = summary('branch', { parentSessionId: 'root', branchOfTurnId: 'turn-1' });

    assert.deepEqual(revisionFamilySessionIds([root, version2, branch], 'version-2'), [
      'root',
      'version-2',
    ]);
    assert.deepEqual(revisionFamilySessionIds([root, version2, branch], 'branch'), ['branch']);
  });

  it('derives previous and next navigation across a revision chain', () => {
    const root = summary('root', { lastMessageAt: 10 });
    const version2 = summary('version-2', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionOfTurnId: 'turn-2',
      revisionIndex: 2,
      revisionState: 'committed',
      lastMessageAt: 20,
    });
    const version3 = summary('version-3', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'version-2',
      revisionOfTurnId: 'turn-3',
      revisionIndex: 3,
      revisionState: 'committed',
      lastMessageAt: 30,
    });

    assert.deepEqual(deriveSessionRevisionNavigation([version3, root, version2], 'version-2'), {
      current: 2,
      total: 3,
      previousSessionId: 'root',
      nextSessionId: 'version-3',
    });
  });
});
