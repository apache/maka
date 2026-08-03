import type { ProjectCatalog } from './project-catalog.js';
import type { SessionStore } from './session-store.js';

export interface ProjectSessionBackfillResult {
  resolved: number;
  failures: Array<{ cwd: string; reason: string }>;
}

/**
 * Give every session that never had its project resolved a membership.
 *
 * `projectId` is three-valued — an id, an explicit `null` for "no project", or
 * absent for "never decided" — and only the last state is backfilled here, so
 * a user who deliberately detached a session keeps that choice.
 *
 * Sessions are grouped by working directory before resolution: an upgrade
 * typically holds many sessions per project, and resolution costs a `git`
 * subprocess plus a catalog write each time. Each directory carries the latest
 * activity of the sessions that share it, so the rebuilt catalog keeps its real
 * recency order rather than collapsing every project to the upgrade's timestamp.
 */
export async function backfillSessionProjects(input: {
  sessions: Pick<
    SessionStore,
    'listSessionsWithUnresolvedProject' | 'updateHeader' | 'readHeaderSnapshot'
  >;
  catalog: Pick<ProjectCatalog, 'resolveHistoricalPath'>;
}): Promise<ProjectSessionBackfillResult> {
  const pending = await input.sessions.listSessionsWithUnresolvedProject();
  const byDirectory = new Map<string, { usedAt: number; sessionIds: string[] }>();
  for (const session of pending) {
    const group = byDirectory.get(session.cwd);
    if (group) {
      group.usedAt = Math.max(group.usedAt, session.usedAt);
      group.sessionIds.push(session.id);
    } else {
      byDirectory.set(session.cwd, { usedAt: session.usedAt, sessionIds: [session.id] });
    }
  }

  let resolved = 0;
  const failures: Array<{ cwd: string; reason: string }> = [];

  for (const [cwd, group] of byDirectory) {
    let projectId: string;
    try {
      projectId = (await input.catalog.resolveHistoricalPath(cwd, group.usedAt)).id;
    } catch (error) {
      failures.push({ cwd, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const sessionId of group.sessionIds) {
      try {
        // Re-check instead of writing blind: the user can detach a session
        // while this runs, and that decision must win over a stale plan.
        if ((await input.sessions.readHeaderSnapshot(sessionId)).projectId !== undefined) continue;
        await input.sessions.updateHeader(sessionId, { projectId });
        resolved += 1;
      } catch (error) {
        failures.push({ cwd, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { resolved, failures };
}
