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

import {
  linkedSubagentParentSessionId,
  type SessionSummary,
} from '@maka/core/session';

type LinkedSession = Pick<SessionSummary, 'id' | 'subagent' | 'subagentParent'>;

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
  // A pending active Session has no lineage metadata yet. Do not destroy a
  // live Side Chat during that short catalog gap; once the row arrives the
  // normal descendant check below decides whether it belongs to this scope.
  if (!sessions.some((session) => session.id === activeSession.id)) return true;
  const sourceSession = sessions.find((session) => session.id === sourceSessionId);
  if (!sourceSession) return false;

  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  return reachesSession(activeSession, sourceSessionId, sessionsById);
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
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const visited = new Set<string>();
  let current = activeSession;
  while (!visited.has(current.id)) {
    visited.add(current.id);
    const parentSessionId = linkedSubagentParentSessionId(current);
    if (!parentSessionId) return current.id;
    const parent = sessionsById.get(parentSessionId);
    if (!parent) return current.id;
    current = parent;
  }
  return current.id;
}

function reachesSession(
  start: LinkedSession,
  targetSessionId: string,
  sessionsById: ReadonlyMap<string, LinkedSession>,
): boolean {
  const visited = new Set<string>();
  let current: LinkedSession | undefined = start;
  while (current) {
    if (current.id === targetSessionId) return true;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    const parentSessionId = linkedSubagentParentSessionId(current);
    if (!parentSessionId) return false;
    current = sessionsById.get(parentSessionId);
  }
  return false;
}
