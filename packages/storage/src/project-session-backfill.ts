import type { ProjectCatalog } from './project-catalog.js';
import type { SessionAuthorityStore } from './session-store.js';
import { SessionMetadataVersionConflictError } from './sqlite-session-metadata-store.js';

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
 *
 * Each assignment is fenced by the metadata revision the session was listed at.
 * This runs during startup while a window is already open, so a user detaching
 * a session mid-resolution would otherwise be overwritten by a plan made before
 * they decided; the fenced write simply loses instead.
 */
export async function backfillSessionProjects(input: {
  sessions: Pick<
    SessionAuthorityStore,
    'listSessionsWithUnresolvedProject' | 'updateHeaderVersioned'
  >;
  catalog: Pick<ProjectCatalog, 'resolveHistoricalPath'>;
}): Promise<ProjectSessionBackfillResult> {
  const pending = await input.sessions.listSessionsWithUnresolvedProject();
  const byDirectory = new Map<string, { usedAt: number; sessions: UnresolvedSession[] }>();
  for (const session of pending) {
    const group = byDirectory.get(session.cwd);
    if (group) {
      group.usedAt = Math.max(group.usedAt, session.usedAt);
      group.sessions.push(session);
    } else {
      byDirectory.set(session.cwd, { usedAt: session.usedAt, sessions: [session] });
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
    for (const session of group.sessions) {
      try {
        await input.sessions.updateHeaderVersioned(session.id, { projectId }, session.revision);
        resolved += 1;
      } catch (error) {
        // Someone changed the session first. Whatever they decided outranks a
        // plan formed before it, and a still-unresolved session is retried on
        // the next start, so this is not a failure to report.
        if (error instanceof SessionMetadataVersionConflictError) continue;
        failures.push({ cwd, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { resolved, failures };
}

type UnresolvedSession = Awaited<
  ReturnType<SessionAuthorityStore['listSessionsWithUnresolvedProject']>
>[number];
