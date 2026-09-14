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
import {
  collapseSessionRevisions,
  projectRevisionLinkedSessionTree,
  sessionRevisionFamilyId,
} from '@maka/core/session-revisions';

interface SessionFamilyProjection {
  representativeByFamilyId: ReadonlyMap<string, string>;
  parentByChildId: ReadonlyMap<string, string>;
}

// Both the stale-panel effect and the active-tab projection ask the same
// family questions during a render. Cache the immutable projection by the
// catalog array and active id so a streaming catalog revision builds the
// revision-aware maps once, rather than once per panel.
const sessionFamilyProjectionCache = new WeakMap<
  readonly SessionSummary[],
  Map<string, SessionFamilyProjection>
>();

function projectSessionFamily(
  sessions: readonly SessionSummary[],
  activeId: string,
): SessionFamilyProjection {
  const cacheKey = activeId;
  const cachedByActiveId = sessionFamilyProjectionCache.get(sessions);
  const cached = cachedByActiveId?.get(cacheKey);
  if (cached) return cached;

  const logicalSessions = collapseSessionRevisions(sessions, activeId);
  const representativeByFamilyId = new Map(
    logicalSessions.map((session) => [sessionRevisionFamilyId(session), session.id]),
  );
  const tree = projectRevisionLinkedSessionTree(sessions, activeId);
  const parentByChildId = new Map<string, string>();
  for (const [parentId, children] of tree.childrenByParentId) {
    for (const child of children) parentByChildId.set(child.id, parentId);
  }
  const projection: SessionFamilyProjection = {
    representativeByFamilyId,
    parentByChildId,
  };
  const nextCache = cachedByActiveId ?? new Map<string, SessionFamilyProjection>();
  nextCache.set(cacheKey, projection);
  if (!cachedByActiveId) sessionFamilyProjectionCache.set(sessions, nextCache);
  return projection;
}

/**
 * Whether the active Session is the source itself or a linked descendant of
 * the source. Ordinary branches deliberately do not participate:
 * their `parentSessionId` is a different lineage concept.
 */
export function isLinkedSideConversationSessionFamily(
  sourceSessionId: string,
  activeSession: SessionSummary | undefined,
  sessions: readonly SessionSummary[],
): boolean {
  if (!activeSession) return false;
  // The active source may be represented by the shell's pending Session view
  // before its catalog row arrives. Keep the panel through that refresh; a
  // missing source is only destructive once navigation has left its id.
  if (sourceSessionId === activeSession.id) return true;
  // A pending active Session has no catalog lineage yet. The controller keeps
  // the previous known family alive during that short gap; this helper itself
  // must not retain every panel for an unrelated unknown Session.
  if (!sessions.some((session) => session.id === activeSession.id)) return false;
  const sourceSession = sessions.find((session) => session.id === sourceSessionId);
  if (!sourceSession) return false;

  const {
    representativeByFamilyId,
    parentByChildId,
  } = projectSessionFamily(sessions, activeSession.id);
  const sourceId =
    representativeByFamilyId.get(sessionRevisionFamilyId(sourceSession)) ?? sourceSession.id;
  const activeId =
    representativeByFamilyId.get(sessionRevisionFamilyId(activeSession)) ?? activeSession.id;
  return reachesSession(activeId, sourceId, parentByChildId);
}

function reachesSession(
  startId: string,
  targetSessionId: string,
  parentByChildId: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>();
  let currentId: string | undefined = startId;
  while (currentId) {
    if (currentId === targetSessionId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = parentByChildId.get(currentId);
  }
  return false;
}
