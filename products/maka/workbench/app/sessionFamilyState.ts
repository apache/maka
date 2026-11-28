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

export type FamilyMember = {
  id: string;
  createdAt?: number;
  updatedAt: number;
  activity: 'idle' | 'working' | 'waiting';
};

/**
 * Keep family members in stable creation order so switching siblings by position
 * or shortcut never jumps as status changes.
 */
export function sortFamilySessions<T extends FamilyMember>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => {
    const aCreated = a.createdAt ?? a.updatedAt;
    const bCreated = b.createdAt ?? b.updatedAt;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id.localeCompare(b.id);
  });
}

/** Step to the previous (-1) or next (1) sibling in stable creation order, clamped at edges. */
export function siblingTarget<T extends FamilyMember>(
  siblings: readonly T[],
  currentId: string,
  delta: -1 | 1,
): T | null {
  const ordered = sortFamilySessions(siblings);
  const index = ordered.findIndex((item) => item.id === currentId);
  if (index === -1) return null;
  const next = index + delta;
  if (next < 0 || next >= ordered.length) return null;
  return ordered[next] ?? null;
}

export function familySummary(children: readonly Pick<FamilyMember, 'activity'>[]): {
  total: number;
  waiting: number;
  working: number;
} {
  let waiting = 0;
  let working = 0;
  for (const child of children) {
    if (child.activity === 'waiting') waiting += 1;
    else if (child.activity === 'working') working += 1;
  }
  return { total: children.length, waiting, working };
}

/**
 * Name a child's workspace only when it differs from its parent's workspace.
 * Worktree paths under a `.worktrees/` segment render as `wt/<name>`.
 */
export function workspaceDifferenceLabel(
  childPath: string | null | undefined,
  parentPath: string | null | undefined,
): string {
  if (!childPath || !parentPath || childPath === parentPath) return '';
  const parts = childPath.split(/[\/]/).filter(Boolean);
  const leaf = parts.at(-1) || childPath;
  const wtIndex = parts.lastIndexOf('.worktrees');
  if (wtIndex !== -1 && wtIndex === parts.length - 2) return `wt/${leaf}`;
  return leaf;
}
