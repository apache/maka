import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionSummary, SubagentSessionParent } from '@maka/core';
import { deriveSessionRail } from '../../renderer/session-rail.js';
import { sessionMatchesNavSelection } from '../../renderer/session-nav-filter.js';
import { makeSessionSummary } from './session-list-render-helpers.js';

function childRelation(parentSessionId: string): SubagentSessionParent {
  return {
    kind: 'subagent',
    parentSessionId,
    spawnedBy: {
      parentRunId: 'run',
      parentTurnId: 'turn',
      toolCallId: 'tool',
    },
    lifecycle: 'foreground',
  };
}

function chatsInclude(session: SessionSummary): boolean {
  return sessionMatchesNavSelection(session, { section: 'sessions', filter: 'chats' });
}

describe('deriveSessionRail', () => {
  it('lists only revision-tree roots and never nests linked children', () => {
    const parent = makeSessionSummary({ id: 'parent', name: 'Parent', lastMessageAt: 10 });
    const child = makeSessionSummary({
      id: 'child',
      name: 'Child',
      lastMessageAt: 20,
      subagentParent: childRelation(parent.id),
    });
    const peer = makeSessionSummary({ id: 'peer', name: 'Peer', lastMessageAt: 5 });

    const rail = deriveSessionRail([parent, child, peer], child.id, chatsInclude);

    assert.deepEqual(
      rail.sessions.map((session) => session.id),
      [parent.id, peer.id],
    );
    assert.equal(rail.activeRowId, parent.id);
  });

  it('keeps an orphan linked child on the rail when its parent is gone', () => {
    const other = makeSessionSummary({ id: 'other', name: 'Other', lastMessageAt: 1 });
    const orphan = makeSessionSummary({
      id: 'orphan',
      name: 'Orphan child',
      lastMessageAt: 2,
      subagentParent: childRelation('deleted-parent'),
    });

    const rail = deriveSessionRail([other, orphan], orphan.id, chatsInclude);

    assert.deepEqual(
      rail.sessions.map((session) => session.id),
      [other.id, orphan.id],
    );
    assert.equal(rail.activeRowId, orphan.id);
  });

  it('does not promote a linked child when only the parent fails the nav filter', () => {
    const archivedParent = makeSessionSummary({
      id: 'archived-parent',
      name: 'Archived parent',
      isArchived: true,
      lastMessageAt: 10,
    });
    const activeChild = makeSessionSummary({
      id: 'active-child',
      name: 'Active child',
      lastMessageAt: 20,
      subagentParent: childRelation(archivedParent.id),
    });
    const liveParent = makeSessionSummary({
      id: 'live-parent',
      name: 'Live parent',
      lastMessageAt: 30,
    });

    const rail = deriveSessionRail(
      [archivedParent, activeChild, liveParent],
      activeChild.id,
      chatsInclude,
    );

    assert.deepEqual(
      rail.sessions.map((session) => session.id),
      [liveParent.id],
    );
    // Parent is off the chats rail; no row can represent the open child.
    assert.equal(rail.activeRowId, undefined);
  });

  it('highlights the revision representative when the physical parent was revised', () => {
    const parentV1 = makeSessionSummary({
      id: 'parent-v1',
      name: 'Parent v1',
      lastMessageAt: 1,
    });
    const parentV2 = makeSessionSummary({
      id: 'parent-v2',
      name: 'Parent v2',
      lastMessageAt: 3,
      revisionRootSessionId: 'parent-v1',
      revisionParentSessionId: 'parent-v1',
      revisionIndex: 2,
      revisionState: 'committed',
    });
    const child = makeSessionSummary({
      id: 'child',
      name: 'Child',
      lastMessageAt: 2,
      subagentParent: childRelation(parentV1.id),
    });

    const rail = deriveSessionRail([parentV1, parentV2, child], child.id, chatsInclude);

    assert.deepEqual(
      rail.sessions.map((session) => session.id),
      [parentV2.id],
    );
    assert.equal(rail.activeRowId, parentV2.id);
    // Titlebar parent shares the same representative, not the physical parent-v1 name.
    assert.equal(rail.activeParentSession?.id, parentV2.id);
    assert.equal(rail.activeParentSession?.name, 'Parent v2');
  });

  it('surfaces no titlebar parent for ordinary roots or orphans', () => {
    const root = makeSessionSummary({ id: 'root', name: 'Root', lastMessageAt: 1 });
    const orphan = makeSessionSummary({
      id: 'orphan',
      name: 'Orphan',
      lastMessageAt: 2,
      subagentParent: childRelation('missing'),
    });

    assert.equal(
      deriveSessionRail([root], root.id, chatsInclude).activeParentSession,
      undefined,
    );
    assert.equal(
      deriveSessionRail([orphan], orphan.id, chatsInclude).activeParentSession,
      undefined,
    );
  });

  it('applies flagged and archived filters flat against rail roots only', () => {
    const parent = makeSessionSummary({
      id: 'parent',
      name: 'Parent',
      lastMessageAt: 10,
    });
    const archivedChild = makeSessionSummary({
      id: 'archived-child',
      name: 'Archived child',
      isArchived: true,
      lastMessageAt: 20,
      subagentParent: childRelation(parent.id),
    });
    const flaggedChild = makeSessionSummary({
      id: 'flagged-child',
      name: 'Flagged child',
      isFlagged: true,
      lastMessageAt: 30,
      subagentParent: childRelation(parent.id),
    });
    const archivedParent = makeSessionSummary({
      id: 'archived-parent',
      name: 'Archived parent',
      isArchived: true,
      lastMessageAt: 40,
    });
    const activeChildOfArchived = makeSessionSummary({
      id: 'active-child',
      name: 'Active child',
      lastMessageAt: 50,
      subagentParent: childRelation(archivedParent.id),
    });
    const sessions = [
      parent,
      archivedChild,
      flaggedChild,
      archivedParent,
      activeChildOfArchived,
    ];

    const chats = deriveSessionRail(sessions, parent.id, (session) =>
      sessionMatchesNavSelection(session, { section: 'sessions', filter: 'chats' }),
    );
    assert.deepEqual(
      chats.sessions.map((session) => session.id),
      [parent.id],
    );

    const flagged = deriveSessionRail(sessions, flaggedChild.id, (session) =>
      sessionMatchesNavSelection(session, { section: 'sessions', filter: 'flagged' }),
    );
    assert.deepEqual(
      flagged.sessions.map((session) => session.id),
      [],
    );
    assert.equal(flagged.activeRowId, undefined);

    const archived = deriveSessionRail(sessions, archivedParent.id, (session) =>
      sessionMatchesNavSelection(session, { section: 'sessions', filter: 'archived' }),
    );
    assert.deepEqual(
      archived.sessions.map((session) => session.id),
      [archivedParent.id],
    );
  });
});
