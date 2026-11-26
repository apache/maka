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

import type {
  AgentProject,
  AgentWorkspaceSelection,
} from '../../../../packages/plugin-sdk/src/index.js';
import { creationRoots, nestCreated } from './sessionNesting.ts';

type Groupable = {
  id: string;
  parentSessionId: string | null;
  pinned: boolean;
  updatedAt?: number;
  workspace: { projectId?: string | null; path: string };
};
type Listable = { reference: { id: string }; archived: boolean };

/** Conversations listed together in the desktop's session browser. */
export type ConversationGroup<Project> = {
  key: string;
  pinned: boolean;
  project: Project | null;
  /** The workspace of a group outside any project. */
  path: string | null;
  sessions: string[];
  /** The conversations shown under the one that created them. */
  nested: ReadonlySet<string>;
};

const PROJECT_SESSION_LIMIT = 6;

// An explicit pin makes the conversation a separate root, even if its creator is pinned.
const groupingParent = (session: Groupable) => (session.pinned ? null : session.parentSessionId);

/** Pinned conversations, registered projects in catalog order, then other workspaces. */
export function groupConversations<Project extends Listable>(
  sessions: readonly Groupable[],
  projects: readonly Project[],
  withEmpty: boolean,
): ConversationGroup<Project>[] {
  const byProject = new Map(projects.map((project) => [project.reference.id, project]));
  const groups = new Map<string, ConversationGroup<Project> & { members: Groupable[] }>();
  const add = (key: string, pinned: boolean, project: Project | null, path: string | null) => {
    const group = {
      key,
      pinned,
      project,
      path,
      sessions: [],
      nested: new Set<string>(),
      members: [],
    };
    groups.set(key, group);
    return group;
  };
  const roots = creationRoots(sessions, groupingParent);
  for (const session of sessions) {
    const { pinned, workspace } = roots.get(session.id) ?? session;
    const projectId = workspace.projectId;
    const key = pinned ? 'pinned' : projectId ? `project:${projectId}` : `path:${workspace.path}`;
    const project = (!pinned && projectId && byProject.get(projectId)) || null;
    const group =
      groups.get(key) ?? add(key, pinned, project, pinned || project ? null : workspace.path);
    group.members.push(session);
  }
  if (withEmpty)
    for (const project of byProject.values())
      if (!project.archived && !groups.has(`project:${project.reference.id}`))
        add(`project:${project.reference.id}`, false, project, null);
  const ordered = [];
  const pinned = groups.get('pinned');
  if (pinned) ordered.push(pinned);
  for (const project of byProject.values()) {
    const group = groups.get(`project:${project.reference.id}`);
    if (group) ordered.push(group);
  }
  for (const group of groups.values()) {
    if (!group.pinned && !group.project) ordered.push(group);
  }
  return ordered.map(({ members, ...group }) => {
    const { order, nested } = nestCreated(members, groupingParent);
    return { ...group, sessions: order, nested };
  });
}

export function projectSessionLimit(group: ConversationGroup<unknown>): number {
  return group.key.startsWith('project:') ? PROJECT_SESSION_LIMIT : group.sessions.length;
}

/** Top-level conversations in `group`; the limit counts only these. */
export function topLevelCount(group: ConversationGroup<unknown>): number {
  return group.sessions.length - group.nested.size;
}

/** The first `limit` top-level conversations, each with those nested under it. */
export function withinLimit(
  group: ConversationGroup<unknown>,
  sessions: readonly string[],
  limit: number,
): string[] {
  let top = 0;
  let open = false;
  return sessions.filter((id) => {
    if (!group.nested.has(id)) open = ++top <= limit;
    return open;
  });
}

/** Each flattened family under its visible root. */
export function foldableFamilies(group: ConversationGroup<unknown>): Map<string, string[]> {
  const families = new Map<string, string[]>();
  let parent: string | null = null;
  for (const id of group.sessions) {
    if (!group.nested.has(id)) parent = id;
    else if (parent !== null) {
      const members = families.get(parent);
      if (members) members.push(id);
      else families.set(parent, [id]);
    }
  }
  return families;
}

export type FamilyFoldOverrides = ReadonlyMap<string, 'open' | 'folded'>;

export function familyIsFolded(
  parent: string,
  pinned: boolean,
  overrides: FamilyFoldOverrides,
): boolean {
  const override = overrides.get(parent);
  return pinned ? override !== 'open' : override === 'folded';
}

/** The group's conversations without those folded under their creator. */
export function unfoldedSessions(
  group: ConversationGroup<unknown>,
  overrides: FamilyFoldOverrides,
  current: string | null = null,
): string[] {
  const hidden = new Set<string>();
  for (const [parent, members] of foldableFamilies(group))
    if (familyIsFolded(parent, group.pinned, overrides))
      for (const id of members) if (id !== current) hidden.add(id);
  return hidden.size ? group.sessions.filter((id) => !hidden.has(id)) : group.sessions;
}

/**
 * Step through the visible conversations, keeping a hidden current row as a
 * starting point. Without `familyFoldOverrides`, as in the terminal, nothing folds.
 */
export function browserOrder(
  groups: readonly ConversationGroup<unknown>[],
  collapsed: ReadonlySet<string>,
  current: string | null,
  expandedProjects?: ReadonlySet<string>,
  familyFoldOverrides?: FamilyFoldOverrides,
): string[] {
  return groups.flatMap((group) => {
    const sessions = familyFoldOverrides
      ? unfoldedSessions(group, familyFoldOverrides, current)
      : group.sessions;
    const limit = collapsed.has(group.key)
      ? 0
      : expandedProjects && !expandedProjects.has(group.key)
        ? projectSessionLimit(group)
        : sessions.length;
    const shown = new Set(withinLimit(group, sessions, limit));
    return sessions.filter((id) => shown.has(id) || id === current);
  });
}

/** Pinned families, then remaining conversations bucketed by recency in Host page order. */
export function groupConversationsByTime<Project>(
  sessions: readonly Groupable[],
  now = Date.now(),
): ConversationGroup<Project>[] {
  const roots = creationRoots(sessions, groupingParent);
  const ref = new Date(now);
  const todayMs = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const yesterdayMs = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1).getTime();

  const buckets = {
    pinned: [] as Groupable[],
    'time:today': [] as Groupable[],
    'time:yesterday': [] as Groupable[],
    'time:earlier': [] as Groupable[],
  };
  for (const session of sessions) {
    const root = roots.get(session.id) ?? session;
    const ts = root.updatedAt ?? 0;
    const key = root.pinned
      ? 'pinned'
      : ts >= todayMs
        ? 'time:today'
        : ts >= yesterdayMs
          ? 'time:yesterday'
          : 'time:earlier';
    buckets[key].push(session);
  }

  return Object.entries(buckets).flatMap(([key, members]) => {
    if (!members.length) return [];
    const { order, nested } = nestCreated(members, groupingParent);
    return [
      {
        key,
        pinned: key === 'pinned',
        project: null,
        path: null,
        sessions: order,
        nested,
      },
    ];
  });
}

/** Resolve creation through an owned workspace, never a display path. */
export function groupWorkspace(
  group: ConversationGroup<Pick<AgentProject, 'reference' | 'archived' | 'available' | 'path'>>,
): AgentWorkspaceSelection | null {
  if (group.pinned || group.key.startsWith('time:')) return null;
  if (group.project) {
    const project = group.project;
    if (project.archived || !project.available || !project.path) return null;
    return { kind: 'project', projectId: project.reference.id, path: project.path };
  }
  const sessionId = group.sessions[0];
  return sessionId ? { kind: 'session', sessionId } : null;
}
