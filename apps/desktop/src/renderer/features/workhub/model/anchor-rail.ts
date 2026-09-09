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

export interface WorkHubAnchorSession {
  readonly target: { readonly sessionId: string };
  readonly projectName: string;
  readonly sessionName: string;
  readonly archived: boolean;
  readonly state: "active" | "running" | "waiting_for_user" | "blocked" | "aborted";
  readonly latestResult?: string;
  readonly updatedAt: number;
}

export type WorkHubWorkFilter = "all" | "active" | "attention" | "stopped";
export const MAX_WORKHUB_ANCHORS = 8;

/**
 * Bounded, rebuildable navigation projection. It never changes the routing
 * candidate set and owns no Session or delegation state.
 */
export function deriveWorkHubAnchors(input: {
  readonly sessions: readonly WorkHubAnchorSession[];
  readonly focusSessionId?: string;
  readonly delegatedSessionIds: readonly string[];
  readonly filter: WorkHubWorkFilter;
}): WorkHubAnchorSession[] {
  const sessionById = new Map(
    input.sessions.map((session) => [session.target.sessionId, session]),
  );
  const ordered: WorkHubAnchorSession[] = [];
  const seen = new Set<string>();
  const append = (
    sessionId: string | undefined,
  ) => {
    if (!sessionId || seen.has(sessionId)) return;
    const session = sessionById.get(sessionId);
    if (!session || !matchesWorkHubFilter(session, input.filter)) return;
    seen.add(sessionId);
    ordered.push(session);
  };

  append(input.focusSessionId);
  for (const sessionId of input.delegatedSessionIds)
    append(sessionId);
  for (const session of [...input.sessions].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  )) {
    append(session.target.sessionId);
  }
  return ordered.slice(0, MAX_WORKHUB_ANCHORS);
}

export function matchesWorkHubFilter(
  session: WorkHubAnchorSession,
  filter: WorkHubWorkFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "active")
    return (
      !session.archived &&
      (session.state === "active" || session.state === "running")
    );
  if (filter === "attention")
    return (
      !session.archived &&
      (session.state === "waiting_for_user" || session.state === "blocked")
    );
  return session.archived || session.state === "aborted";
}
