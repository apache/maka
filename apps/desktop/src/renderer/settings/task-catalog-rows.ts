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

/** Sentinel project filter value for tasks that belong to no project. */
export const NO_PROJECT_FILTER = 'none';

export interface ArchivedTaskFilter {
  /** Free text matched against the task name and its project name. */
  query: string;
  /** A project id, `NO_PROJECT_FILTER`, or null for every project. */
  projectId: string | null;
}

/**
 * Narrow the archived tasks to what the toolbar is asking for.
 *
 * Separate from `archivedTaskRows` because the two answer different
 * questions: that one decides what a task *is*, this one decides which of
 * them you are currently looking at. Only this one changes as you type.
 */
export function filterArchivedTasks(
  rows: readonly SessionSummary[],
  filter: ArchivedTaskFilter,
  projectNameOf: (projectId: string) => string | undefined,
): SessionSummary[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return rows.filter((session) => {
    if (filter.projectId !== null) {
      const belongsTo =
        filter.projectId === NO_PROJECT_FILTER
          ? session.projectId === undefined
          : session.projectId === filter.projectId;
      if (!belongsTo) return false;
    }
    if (query.length === 0) return true;
    // The project name is searchable because it is on screen: a row reads
    // "name · project", so both halves should answer to the same box.
    const projectName = session.projectId ? projectNameOf(session.projectId) : undefined;
    return `${session.name} ${projectName ?? ''}`.toLocaleLowerCase().includes(query);
  });
}
