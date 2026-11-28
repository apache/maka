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
import { descendsFrom, visibleAncestor } from './sessionNesting.ts';

type Groupable = {
  id: string;
  parentSessionId: string | null;
  pinned: boolean;
  updatedAt?: number;
  workspace: { projectId?: string | null; path: string };
};
type Listable = { reference: { id: string }; archived: boolean };

/** A child conversation eligible to bubble temporarily under its visible parent row. */
export type BubbledChild = {
  id: string;
  parentSessionId: string | null;
  ancestorIds?: readonly string[];
  pinned: boolean;
  archived: boolean;
};

/** Conversations listed together in the desktop's session browser. */
export type ConversationGroup<Project> = {
  key: string;
  pinned: boolean;
  project: Project | null;
  /** The workspace of a group outside any project. */
  path: string | null;
  sessions: string[];
  /** Ephemeral bubbled child rows shown one level under their visible parent. */
  nested: ReadonlySet<string>;
};

const PROJECT_SESSION_LIMIT = 6;

/** Pinned conversations, registered projects in catalog order, then other workspaces. */
export function groupConversations<Project extends Listable>(
  sessions: readonly Groupable[],
  projects: readonly Project[],
  withEmpty: boolean,
): ConversationGroup<Project>[] {
  const byProject = new Map(projects.map((project) => [project.reference.id, project]));
  const groups = new Map<string, ConversationGroup<Project>>();
  const add = (key: string, pinned: boolean, project: Project | null, path: string | null) => {
    const group: ConversationGroup<Project> = {
      key,
      pinned,
      project,
      path,
      sessions: [],
      nested: new Set<string>(),
    };
    groups.set(key, group);
    return group;
  };
  for (const session of sessions) {
    const projectId = session.workspace.projectId;
    const key = session.pinned
      ? 'pinned'
      : projectId
        ? `project:${projectId}`
        : `path:${session.workspace.path}`;
    const project = (!session.pinned && projectId && byProject.get(projectId)) || null;
    const group =
      groups.get(key) ??
      add(key, session.pinned, project, session.pinned || project ? null : session.workspace.path);
    group.sessions.push(session.id);
  }
  if (withEmpty)
    for (const project of byProject.values())
      if (!project.archived && !groups.has(`project:${project.reference.id}`))
        add(`project:${project.reference.id}`, false, project, null);
  const ordered: ConversationGroup<Project>[] = [];
  const pinned = groups.get('pinned');
  if (pinned) ordered.push(pinned);
  for (const project of byProject.values()) {
    const group = groups.get(`project:${project.reference.id}`);
    if (group) ordered.push(group);
  }
  for (const group of groups.values()) {
    if (!group.pinned && !group.project) ordered.push(group);
  }
  return ordered;
}

/**
 * Attach waiting (or currently viewed sticky) child conversations one level under
 * their nearest visible ancestor row. Already-listed or pinned children are never
 * duplicated, and orphans whose ancestor is not visible are omitted.
 */
export function attachBubbledChildren<Project>(
  groups: readonly ConversationGroup<Project>[],
  bubbles: readonly BubbledChild[],
): ConversationGroup<Project>[] {
  if (!bubbles.length) return [...groups];
  const visible = new Set<string>();
  for (const group of groups) for (const id of group.sessions) visible.add(id);
  const parents = new Map<string, string | null>();
  for (const bubble of bubbles) parents.set(bubble.id, bubble.parentSessionId);

  const byParent = new Map<string, string[]>();
  const added = new Set<string>();
  for (const bubble of bubbles) {
    if (bubble.archived || bubble.pinned || visible.has(bubble.id) || added.has(bubble.id))
      continue;
    const ancestor = visibleAncestor(bubble.id, visible, parents, bubble.ancestorIds);
    if (ancestor === null) continue;
    added.add(bubble.id);
    const list = byParent.get(ancestor);
    if (list) list.push(bubble.id);
    else byParent.set(ancestor, [bubble.id]);
  }
  if (!byParent.size) return [...groups];

  return groups.map((group) => {
    const nested = new Set(group.nested);
    const sessions: string[] = [];
    for (const id of group.sessions) {
      sessions.push(id);
      const children = byParent.get(id);
      if (children) {
        for (const childId of children) {
          sessions.push(childId);
          nested.add(childId);
        }
      }
    }
    return { ...group, sessions, nested };
  });
}

/**
 * Derive the active desktop bubble list from live waiting sessions plus an optional
 * currently-viewed sticky bubble. When a sticky bubble leaves `waiting`, its activity
 * clears to `idle` so an approved row stays anchored without showing a stale Waiting badge.
 */
export function selectBubbledChildren<
  T extends BubbledChild & { activity: 'idle' | 'working' | 'waiting' },
>(
  waiting: readonly T[],
  visible: readonly { id: string; parentSessionId: string | null }[],
  botSession: string | null,
  sticky: T | null,
): T[] {
  const merged = new Map<string, T>();
  for (const session of waiting) {
    if (session.parentSessionId !== null) merged.set(session.id, session);
  }
  if (sticky && sticky.parentSessionId !== null && !merged.has(sticky.id)) {
    merged.set(sticky.id, sticky.activity === 'waiting' ? { ...sticky, activity: 'idle' } : sticky);
  }
  const list = [...merged.values()];
  if (botSession === null) return list;
  const parents = new Map<string, string | null>([
    ...visible.map((session) => [session.id, session.parentSessionId] as const),
    ...list.map((session) => [session.id, session.parentSessionId] as const),
  ]);
  return list.filter(
    (session) =>
      session.id !== botSession &&
      !descendsFrom(session.id, botSession, parents, session.ancestorIds),
  );
}

/**
 * Build the desktop sidebar groups shared by both rendering and keyboard stepping
 * (`mod+shift+[` / `mod+shift+]`), including bubbled waiting child rows.
 */
export function desktopSidebarGroups<Project extends Listable>(
  visible: readonly Groupable[],
  projects: readonly Project[],
  bubbles: readonly BubbledChild[],
  options: { byTime: boolean; withEmpty: boolean; attachBubbles: boolean },
): ConversationGroup<Project>[] {
  const base = options.byTime
    ? groupConversationsByTime<Project>(visible)
    : groupConversations(visible, projects, options.withEmpty);
  return options.attachBubbles ? attachBubbledChildren(base, bubbles) : base;
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

/** Step through the visible conversations, keeping a hidden current row as a starting point. */
export function browserOrder(
  groups: readonly ConversationGroup<unknown>[],
  collapsed: ReadonlySet<string>,
  current: string | null,
  expandedProjects?: ReadonlySet<string>,
): string[] {
  return groups.flatMap((group) => {
    const sessions = group.sessions;
    const limit = collapsed.has(group.key)
      ? 0
      : expandedProjects && !expandedProjects.has(group.key)
        ? projectSessionLimit(group)
        : sessions.length;
    const shown = new Set(withinLimit(group, sessions, limit));
    return sessions.filter((id) => shown.has(id) || id === current);
  });
}

/** Pinned conversations, then a single Recent group of unpinned conversations in Host page order. */
export function groupConversationsByTime<Project>(
  sessions: readonly Groupable[],
): ConversationGroup<Project>[] {
  const pinned: string[] = [];
  const recent: string[] = [];
  for (const session of sessions) {
    if (session.pinned) pinned.push(session.id);
    else recent.push(session.id);
  }

  const empty = new Set<string>();
  const groups: ConversationGroup<Project>[] = [];
  if (pinned.length)
    groups.push({
      key: 'pinned',
      pinned: true,
      project: null,
      path: null,
      sessions: pinned,
      nested: empty,
    });
  if (recent.length)
    groups.push({
      key: 'time:recent',
      pinned: false,
      project: null,
      path: null,
      sessions: recent,
      nested: empty,
    });
  return groups;
}

/** Resolve creation through an owned workspace, never a display path. */
export function groupWorkspace(
  group: ConversationGroup<Pick<AgentProject, 'reference' | 'archived' | 'available' | 'path'>>,
): AgentWorkspaceSelection | null {
  if (group.pinned || group.key.startsWith('time:')) return null;
  if (group.project) {
    if (group.project.archived || !group.project.available || !group.project.path) return null;
    return {
      kind: 'project',
      projectId: group.project.reference.id,
      path: group.project.path,
    };
  }
  const seed = group.sessions[0];
  return seed ? { kind: 'session', sessionId: seed } : null;
}
