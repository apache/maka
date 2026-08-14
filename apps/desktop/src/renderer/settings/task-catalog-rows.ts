import { isLinkedSubagentSession, type SessionSummary } from '@maka/core/session';
import { collapseSessionRevisions } from '@maka/core/session-revisions';

/**
 * The archived tasks, as tasks rather than as sessions.
 *
 * `sessions.list()` returns the physical session catalog, which is not the set
 * of things a person calls a task. Two projections stand between them, and the
 * rail already applies both through `deriveSessionRail`:
 *
 * - Edit-and-resend produces one physical session per revision. They are one
 *   task, and they archive, restore, and delete as one family.
 * - A linked subagent session belongs to the task that spawned it. It is not
 *   a task of its own, and it disappears with its parent — surfacing it here
 *   would offer a delete no other surface offers.
 *
 * Collapsing before the archived filter is deliberate: the representative
 * version is a property of the whole family, not of the filter. Input order is
 * the store's own recency order and every step preserves it.
 */
export function archivedTaskRows(sessions: readonly SessionSummary[]): SessionSummary[] {
  return collapseSessionRevisions(sessions).filter(
    (session) => session.isArchived && !isLinkedSubagentSession(session),
  );
}

/**
 * Whether a task answers to what was typed in the search box.
 *
 * The project name is searchable because it is on screen: a row reads
 * "name" over "project · date", so both halves should answer to the same box.
 */
export function matchesArchivedTaskQuery(
  session: SessionSummary,
  query: string,
  projectNameOf: (session: SessionSummary) => string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  return `${session.name} ${projectNameOf(session)}`.toLocaleLowerCase().includes(needle);
}
