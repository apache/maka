/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { SessionSummary } from '@maka/core/session';
import { projectRevisionLinkedSessionTree } from '@maka/core/session-revisions';

export type SessionRailProjection<T extends SessionSummary = SessionSummary> = {
  sessions: T[];
  activeRowId: string | undefined;
  /**
   * Immediate linked parent of the active session, as the revision-aware tree
   * sees it (physical parent id aliased to the family representative). Titlebar
   * crumbs share this row with the rail so rename/revise cannot disagree.
   */
  activeParentSession: T | undefined;
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
export function deriveSessionRail<T extends SessionSummary>(
  sessions: readonly T[],
  activeId: string | undefined,
  include: (session: T) => boolean,
): SessionRailProjection<T> {
  const tree = projectRevisionLinkedSessionTree(sessions, activeId);
  const sourceById = new Map(sessions.map((session) => [session.id, session]));
  const parentByChildId = new Map<string, string>();
  const sessionsById = new Map<string, T>();
  for (const root of tree.roots) {
    const source = sourceById.get(root.id);
    if (source) sessionsById.set(root.id, source);
  }
  for (const [parentId, children] of tree.childrenByParentId) {
    for (const child of children) {
      parentByChildId.set(child.id, parentId);
      const source = sourceById.get(child.id);
      if (source) sessionsById.set(child.id, source);
    }
  }

  const railSessions = tree.roots.flatMap((session) => {
    const source = sourceById.get(session.id);
    return source && include(source) ? [source] : [];
  });
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
