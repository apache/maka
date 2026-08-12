import type { SessionSummary } from '@maka/core/session';
import { projectRevisionLinkedSessionTree } from '@maka/core/session-revisions';

export type SessionRailProjection = {
  sessions: SessionSummary[];
  activeRowId: string | undefined;
  /**
   * Immediate linked parent of the active session, as the revision-aware tree
   * sees it (physical parent id aliased to the family representative). Titlebar
   * crumbs share this row with the rail so rename/revise cannot disagree.
   */
  activeParentSession: SessionSummary | undefined;
};

/**
 * Desktop sidebar rail projection.
 *
 * Linked children leave the rail: membership is exactly the roots of the
 * revision-aware linked tree (parent present → child nested off-rail; parent
 * missing → orphan stays a root). Nav / companion filters are flat — never
 * promote a linked child past a filtered ancestor.
 *
 * Active row and titlebar parent share that same tree: when a child is open,
 * highlight the ancestor that appears as a rail row and surface the immediate
 * parent representative for breadcrumbs.
 */
export function deriveSessionRail(
  sessions: readonly SessionSummary[],
  activeId: string | undefined,
  include: (session: SessionSummary) => boolean,
): SessionRailProjection {
  const tree = projectRevisionLinkedSessionTree(sessions, activeId);
  const parentByChildId = new Map<string, string>();
  const sessionsById = new Map<string, SessionSummary>();
  for (const root of tree.roots) {
    sessionsById.set(root.id, root);
  }
  for (const [parentId, children] of tree.childrenByParentId) {
    for (const child of children) {
      parentByChildId.set(child.id, parentId);
      sessionsById.set(child.id, child);
    }
  }

  const railSessions = tree.roots.filter(include);
  const activeParentId = activeId ? parentByChildId.get(activeId) : undefined;
  return {
    sessions: railSessions,
    activeRowId: resolveActiveRailRowId(activeId, railSessions, parentByChildId),
    activeParentSession: activeParentId ? sessionsById.get(activeParentId) : undefined,
  };
}

function resolveActiveRailRowId(
  activeId: string | undefined,
  railSessions: readonly SessionSummary[],
  parentByChildId: ReadonlyMap<string, string>,
): string | undefined {
  if (!activeId) return undefined;
  const rowIds = new Set(railSessions.map((session) => session.id));
  let currentId = activeId;
  const visited = new Set<string>();
  while (!visited.has(currentId)) {
    visited.add(currentId);
    if (rowIds.has(currentId)) return currentId;
    const parentId = parentByChildId.get(currentId);
    if (!parentId) return undefined;
    currentId = parentId;
  }
  return undefined;
}
