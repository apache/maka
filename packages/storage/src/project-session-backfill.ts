import type { ProjectCatalog } from './project-catalog.js';
import type { SessionStore } from './session-store.js';

export interface ProjectSessionBackfillResult {
  resolved: number;
  failed: number;
}

/**
 * Give every session that never had its project resolved a membership.
 *
 * `projectId` is three-valued — an id, an explicit `null` for "no project", or
 * absent for "never decided" — and only the last state is backfilled here, so
 * a user who deliberately detached a session keeps that choice.
 *
 * Resolution costs one `git` subprocess plus a few `realpath` calls per
 * session, which is why the work is scoped to unresolved sessions by SQL
 * rather than filtered in memory: the cost is paid once per session for the
 * lifetime of the workspace, and later startups find nothing to do.
 *
 * A session whose path can no longer be resolved is left unresolved rather
 * than forced into a project, so a transient failure is retried next start
 * instead of being frozen into a wrong grouping.
 */
export async function backfillSessionProjects(input: {
  sessions: Pick<SessionStore, 'listSessionsWithUnresolvedProject' | 'updateHeader'>;
  catalog: Pick<ProjectCatalog, 'resolveHistoricalPath'>;
}): Promise<ProjectSessionBackfillResult> {
  const pending = await input.sessions.listSessionsWithUnresolvedProject();
  let resolved = 0;
  let failed = 0;

  for (const session of pending) {
    try {
      const project = await input.catalog.resolveHistoricalPath(session.cwd);
      await input.sessions.updateHeader(session.id, { projectId: project.id });
      resolved += 1;
    } catch {
      failed += 1;
    }
  }

  return { resolved, failed };
}
