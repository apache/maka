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
import { deriveSessionRail } from '../session-rail.js';

/**
 * The archived tasks, counted the way the rail counts tasks.
 *
 * `sessions.list()` returns the physical session catalog, which is not the set
 * of things a person calls a task: edit-and-resend produces one session per
 * revision, and a linked subagent session belongs to the task that spawned it.
 * `deriveSessionRail` already owns both rules — including the one that is easy
 * to get wrong on a second pass, that a linked child whose parent is gone stays
 * a row of its own instead of vanishing from every surface at once. Reusing it
 * is what makes a row here mean what a row there means; a second projection
 * would only mean it approximately.
 *
 * No active session is passed. The rail passes one so it can highlight the row
 * you are on, but that also pins a family's representative to whichever
 * revision happens to be open — which would move a row's name, date and
 * position here for a reason this page never shows. The rail additionally hides
 * in-flight companion forks, another property of its own view rather than of
 * the archived catalog.
 */
export function archivedTaskRows<T extends SessionSummary>(sessions: readonly T[]): T[] {
  return deriveSessionRail(sessions, undefined, (session) => session.isArchived).sessions;
}

/** Whether an archived row remains because its ordinary parent task was deleted. */
export function isOrphanedSubagentTask(
  session: SessionSummary,
  knownSessionIds: ReadonlySet<string>,
): boolean {
  const parentSessionId =
    session.subagent?.parentSessionId ?? session.subagentParent?.parentSessionId;
  return parentSessionId !== undefined && !knownSessionIds.has(parentSessionId);
}

/**
 * Whether a task answers to what was typed in the search box.
 *
 * The project name is searchable because it is on screen: a row reads "name"
 * over "project · date", so both halves answer to the same box. They are
 * joined by a newline rather than a space so a query can never match across
 * the seam and produce a row whose highlight the reader cannot find. A task
 * whose project could not be resolved answers to its name alone — `join`
 * renders the missing half as nothing, never as the word "undefined".
 */
export function matchesArchivedTaskQuery<T extends SessionSummary>(
  session: T,
  query: string,
  projectLabelOf: (session: T) => string | undefined,
): boolean {
  const haystack = [session.name, projectLabelOf(session)].join('\n');
  return haystack.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
