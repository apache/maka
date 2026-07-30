import {
  projectLinkedSessionTree,
  type LinkedSessionTree,
  type SessionSummary,
} from './session.js';

export function sessionRevisionFamilyId(session: SessionSummary): string {
  return session.revisionRootSessionId ?? session.id;
}

function freshness(session: SessionSummary): number {
  return session.lastMessageAt ?? session.statusUpdatedAt ?? 0;
}

export function visibleSessionRevisionMembers(
  members: readonly SessionSummary[],
  activeId?: string,
): SessionSummary[] {
  return members.filter(
    (session) =>
      !session.revisionParentSessionId ||
      session.id === activeId ||
      session.revisionState !== 'preparing',
  );
}

function compareFreshness(left: SessionSummary, right: SessionSummary): number {
  if ((left.lastMessageAt !== undefined) !== (right.lastMessageAt !== undefined)) {
    return left.lastMessageAt !== undefined ? -1 : 1;
  }
  const delta = freshness(right) - freshness(left);
  return delta !== 0 ? delta : left.id.localeCompare(right.id);
}

/**
 * Fold physical edit-and-resend versions into one logical conversation row.
 * Ordinary branch sessions have no revisionRootSessionId and remain separate.
 */
export function collapseSessionRevisions(
  sessions: readonly SessionSummary[],
  activeId?: string,
): SessionSummary[] {
  const families = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const root = sessionRevisionFamilyId(session);
    const members = families.get(root) ?? [];
    members.push(session);
    families.set(root, members);
  }

  const selected = new Map<string, string>();
  for (const [root, members] of families) {
    const active = activeId ? members.find((session) => session.id === activeId) : undefined;
    if (active) {
      selected.set(root, active.id);
      continue;
    }
    const visible = visibleSessionRevisionMembers(members, activeId);
    const candidates = visible.length > 0 ? visible : [...members];
    candidates.sort(compareFreshness);
    selected.set(root, candidates[0]!.id);
  }

  return sessions.filter(
    (session) => selected.get(sessionRevisionFamilyId(session)) === session.id,
  );
}

/**
 * Build the host-facing child-session tree over logical revision rows.
 *
 * Child relations remain durably anchored to the exact physical parent that
 * spawned them. This read model aliases every physical revision id to the
 * currently selected representative so edit-and-resend cannot orphan a child
 * in Desktop/TUI projection.
 */
export function projectRevisionLinkedSessionTree(
  sessions: readonly SessionSummary[],
  activeId?: string,
): LinkedSessionTree {
  const logicalSessions = collapseSessionRevisions(sessions, activeId);
  const representativeByFamilyId = new Map(
    logicalSessions.map((session) => [sessionRevisionFamilyId(session), session.id]),
  );
  const parentSessionIdAliases = new Map<string, string>();
  for (const session of sessions) {
    const representativeId = representativeByFamilyId.get(sessionRevisionFamilyId(session));
    if (representativeId) parentSessionIdAliases.set(session.id, representativeId);
  }
  return projectLinkedSessionTree(logicalSessions, { parentSessionIdAliases });
}

/** Every durable physical version represented by a logical conversation row. */
export function revisionFamilySessionIds(
  sessions: readonly SessionSummary[],
  sessionId: string,
): string[] {
  const target = sessions.find((session) => session.id === sessionId);
  if (!target) return [sessionId];
  const root = sessionRevisionFamilyId(target);
  return sessions
    .filter((session) => sessionRevisionFamilyId(session) === root)
    .map((session) => session.id);
}
