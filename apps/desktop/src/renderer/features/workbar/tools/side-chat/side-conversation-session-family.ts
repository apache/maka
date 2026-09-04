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

type LinkedSession = SessionSummary;

/**
 * Whether the active Session is the source itself or a linked descendant of
 * the source. Ordinary branches deliberately do not participate:
 * their `parentSessionId` is a different lineage concept.
 */
export function isLinkedSideConversationSessionFamily(
  sourceSessionId: string,
  activeSession: LinkedSession | undefined,
  sessions: readonly LinkedSession[],
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

  const logicalSessions = collapseSessionRevisions(sessions, activeSession.id);
  const representativeByFamilyId = new Map(
    logicalSessions.map((session) => [sessionRevisionFamilyId(session), session.id]),
  );
  const sourceId =
    representativeByFamilyId.get(sessionRevisionFamilyId(sourceSession)) ?? sourceSession.id;
  const activeId =
    representativeByFamilyId.get(sessionRevisionFamilyId(activeSession)) ?? activeSession.id;
  const tree = projectRevisionLinkedSessionTree(sessions, activeSession.id);
  const parentByChildId = new Map<string, string>();
  for (const [parentId, children] of tree.childrenByParentId) {
    for (const child of children) parentByChildId.set(child.id, parentId);
  }
  return reachesSession(activeId, sourceId, parentByChildId);
}

/**
 * Stable key for a linked Session family. Using the active Session's root,
 * rather than whichever panel happens to be listed first, keeps the mounted
 * Workbar surface stable when one of several retained panels is closed.
 */
export function linkedSideConversationFamilyRootId(
  activeSession: LinkedSession | undefined,
  sessions: readonly LinkedSession[],
): string | undefined {
  if (!activeSession) return undefined;
  if (!sessions.some((session) => session.id === activeSession.id)) return undefined;
  const logicalSessions = collapseSessionRevisions(sessions, activeSession.id);
  const activeRepresentative =
    logicalSessions.find(
      (session) => sessionRevisionFamilyId(session) === sessionRevisionFamilyId(activeSession),
    ) ?? activeSession;
  const tree = projectRevisionLinkedSessionTree(sessions, activeSession.id);
  const parentByChildId = new Map<string, string>();
  for (const [parentId, children] of tree.childrenByParentId) {
    for (const child of children) parentByChildId.set(child.id, parentId);
  }
  const visited = new Set<string>();
  let currentId = activeRepresentative.id;
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const parentId = parentByChildId.get(currentId);
    if (!parentId) return currentId;
    currentId = parentId;
  }
  return currentId;
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
