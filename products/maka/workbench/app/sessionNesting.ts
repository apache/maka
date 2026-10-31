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
  const rootOf = (id: string) => {
    const seen = new Set<string>();
    let root = id;
    for (;;) {
      seen.add(root);
      const parent = parents.get(root);
      if (!parent || !parents.has(parent)) return root;
      // A cycle has no first conversation; its members stay where they are.
      if (seen.has(parent)) return id;
      root = parent;
    }
  };
  const children = new Map<string, string[]>();
  const nested = new Set<string>();
  for (const { id } of sessions) {
    const root = rootOf(id);
    if (root === id) continue;
    nested.add(id);
    children.set(root, [...(children.get(root) ?? []), id]);
  }
  const order = sessions
    .filter(({ id }) => !nested.has(id))
    .flatMap(({ id }) => [id, ...(children.get(id) ?? [])]);
  return { order, nested };
}
