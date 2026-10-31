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

/**
 * One workspace group's conversations with each one another conversation in
 * the group created moved under the first of its line there, one level in,
 * in their own order. The browser shows creation one level deep, not a tree.
 */
export function nestCreated(sessions: readonly Nestable[]): {
  order: string[];
  nested: ReadonlySet<string>;
} {
  const parents = new Map(sessions.map((session) => [session.id, session.parentSessionId]));
  const roots = new Map<string, string | null>();
  const rootOf = (id: string) => {
    const path: string[] = [];
    const seen = new Set<string>();
    let at = id;
    let root: string | null;
    for (;;) {
      if (roots.has(at)) {
        root = roots.get(at)!;
        break;
      }
      if (seen.has(at)) {
        root = null;
        break;
      }
      seen.add(at);
      path.push(at);
      const parent = parents.get(at);
      if (!parent || !parents.has(parent)) {
        root = at;
        break;
      }
      at = parent;
    }
    for (const member of path) roots.set(member, root);
    return root ?? id;
  };
  const children = new Map<string, string[]>();
  const nested = new Set<string>();
  for (const { id } of sessions) {
    const root = rootOf(id);
    if (root === id) continue;
    nested.add(id);
    const siblings = children.get(root);
    if (siblings) siblings.push(id);
    else children.set(root, [id]);
  }
  const order = sessions
    .filter(({ id }) => !nested.has(id))
    .flatMap(({ id }) => [id, ...(children.get(id) ?? [])]);
  return { order, nested };
}
