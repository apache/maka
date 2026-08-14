import { isLinkedSubagentSession, type SessionSummary } from '@maka/core/session';
import { collapseSessionRevisions } from '@maka/core/session-revisions';

export type TaskScope = 'all' | 'archived';

/**
 * Logical task rows for the task management page.
 *
 * `sessions.list()` returns the physical catalog, which is not the set of
 * things a person calls a task. Two projections stand between them, and the
 * rail already applies both through `deriveSessionRail`:
 *
 * - Edit-and-resend produces one physical session per revision. They are one
 *   task, and they archive, restore, and delete as one family.
 * - A linked subagent session belongs to the task that spawned it. It is not
 *   a task of its own, and it disappears with its parent — surfacing it here
 *   would offer a delete no other surface offers.
 *
 * Collapsing before the archived filter is deliberate: the representative
 * version is a property of the whole family, so both scopes name the same row.
 * Input order is the store's own recency order and every step preserves it.
 */
export function projectTaskRows(
  sessions: readonly SessionSummary[],
  scope: TaskScope,
): SessionSummary[] {
  const rows = collapseSessionRevisions(sessions).filter(
    (session) => !isLinkedSubagentSession(session),
  );
  return scope === 'archived' ? rows.filter((session) => session.isArchived) : rows;
}
