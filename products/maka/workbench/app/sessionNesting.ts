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

type Nestable = { id: string; parentSessionId: string | null };

/** The first loaded creator of each conversation; cycles have no root. */
export function creationRoots<T extends Nestable>(
  sessions: readonly T[],
  parentOf = (session: T) => session.parentSessionId,
): ReadonlyMap<string, T | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, T | null>();
  for (const session of sessions) {
    if (roots.has(session.id)) continue;
    const path: string[] = [];
    let at = session;
    let root: T | null;
    for (;;) {
      const known = roots.get(at.id);
      if (known !== undefined) {
        root = known;
        break;
      }
      // Revisiting a pending entry means this path has no root.
      roots.set(at.id, null);
      path.push(at.id);
      const parentId = parentOf(at);
      const parent = parentId === null ? undefined : byId.get(parentId);
      if (!parent) {
        root = at;
        break;
      }
      at = parent;
    }
    for (const id of path) roots.set(id, root);
  }
  return roots;
}

/**
 * One workspace group's conversations with each one another conversation in
 * the group created moved under the first of its line there, one level in,
 * in their own order. The browser shows creation one level deep, not a tree.
 */
export function nestCreated(sessions: readonly Nestable[]): {
  order: string[];
  nested: ReadonlySet<string>;
} {
  const roots = creationRoots(sessions);
  const children = new Map<string, string[]>();
  const nested = new Set<string>();
  for (const { id } of sessions) {
    const root = roots.get(id);
    if (!root || root.id === id) continue;
    nested.add(id);
    const siblings = children.get(root.id);
    if (siblings) siblings.push(id);
    else children.set(root.id, [id]);
  }
  const order = sessions
    .filter(({ id }) => !nested.has(id))
    .flatMap(({ id }) => [id, ...(children.get(id) ?? [])]);
  return { order, nested };
}

/** The desktop's ordinary list puts Bot workers under its own entry; inbox and archive keep them. */
export function workspaceSessions<T extends Nestable>(
  sessions: readonly T[],
  ancestor: string | null,
  filter: 'all' | 'archived' | 'needs_you',
  desktop: boolean,
): T[] {
  if (ancestor === null) return [...sessions];
  sessions = sessions.filter((session) => session.id !== ancestor);
  if (!desktop || filter !== 'all') return [...sessions];
  const parents = new Map(sessions.map((session) => [session.id, session.parentSessionId]));
  const verdicts = new Map<string, boolean>();
  const descends = (id: string): boolean => {
    const path: string[] = [];
    let at: string | null | undefined = parents.get(id);
    let result = false;
    while (at != null && path.length <= sessions.length) {
      if (at === ancestor) {
        result = true;
        break;
      }
      const known = verdicts.get(at);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(at);
      at = parents.get(at);
    }
    for (const member of path) verdicts.set(member, result);
    return result;
  };
  return sessions.filter((session) => !descends(session.id));
}
