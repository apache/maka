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
 * Resolve the nearest ancestor of `id` that is present in `visible`, walking
 * parent links through `parents` while guarding against cycles.
 */
export function visibleAncestor(
  id: string,
  visible: ReadonlySet<string>,
  parents: ReadonlyMap<string, string | null>,
): string | null {
  const seen = new Set<string>([id]);
  let at = parents.get(id) ?? null;
  while (at !== null) {
    if (visible.has(at)) return at;
    if (seen.has(at)) return null;
    seen.add(at);
    at = parents.get(at) ?? null;
  }
  return null;
}

/** Whether `id` descends from `ancestor` through `parents`, guarding against cycles. */
export function descendsFrom(
  id: string,
  ancestor: string | null,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  if (ancestor === null) return false;
  const seen = new Set<string>([id]);
  let at = parents.get(id) ?? null;
  while (at !== null) {
    if (at === ancestor) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    at = parents.get(at) ?? null;
  }
  return false;
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
  return sessions.filter((session) => !descendsFrom(session.id, ancestor, parents));
}
