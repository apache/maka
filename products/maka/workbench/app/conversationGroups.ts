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
import { nestCreated } from './sessionNesting.ts';

type Groupable = {
  id: string;
  parentSessionId: string | null;
  pinned: boolean;
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
    const { order, nested } = nestCreated(members);
    return { ...group, sessions: order, nested };
  });
}

export function projectSessionLimit(group: ConversationGroup<unknown>): number {
  return group.key.startsWith('project:') ? PROJECT_SESSION_LIMIT : group.sessions.length;
}

// A family this large folds behind one row; folding a smaller one would save
// at most a row.
const FOLDED_FAMILY_SIZE = 3;

/**
 * The group's conversations that created at least three listed under them,
 * each with those conversations in list order.
 */
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
  for (const [id, members] of families)
    if (members.length < FOLDED_FAMILY_SIZE) families.delete(id);
  return families;
}

/**
 * The group's conversations without those folded under their creator; a
 * family is folded while its creator is in `folded`.
 */
export function unfoldedSessions(
  group: ConversationGroup<unknown>,
  folded: ReadonlySet<string>,
  current: string | null = null,
): string[] {
  const hidden = new Set<string>();
  for (const [parent, members] of foldableFamilies(group))
    if (folded.has(parent)) for (const id of members) if (id !== current) hidden.add(id);
  return hidden.size ? group.sessions.filter((id) => !hidden.has(id)) : group.sessions;
}

/**
 * Step through the visible conversations, keeping a hidden current row as a
 * starting point. Without `foldedFamilies`, as in the terminal, nothing folds.
 */
export function browserOrder(
  groups: readonly ConversationGroup<unknown>[],
  collapsed: ReadonlySet<string>,
  current: string | null,
  expandedProjects?: ReadonlySet<string>,
  foldedFamilies?: ReadonlySet<string>,
): string[] {
  return groups.flatMap((group) => {
    const sessions = foldedFamilies
      ? unfoldedSessions(group, foldedFamilies, current)
      : group.sessions;
    const limit = collapsed.has(group.key)
      ? 0
      : expandedProjects && !expandedProjects.has(group.key)
        ? projectSessionLimit(group)
        : sessions.length;
    return sessions.filter((id, index) => index < limit || id === current);
  });
}

/** Resolve creation through an owned workspace, never a display path. */
export function groupWorkspace(
  group: ConversationGroup<Pick<AgentProject, 'reference' | 'archived' | 'available' | 'path'>>,
): AgentWorkspaceSelection | null {
  if (group.pinned) return null;
  if (group.project) {
    const project = group.project;
    if (project.archived || !project.available || !project.path) return null;
    return { kind: 'project', projectId: project.reference.id, path: project.path };
  }
  const sessionId = group.sessions[0];
  return sessionId ? { kind: 'session', sessionId } : null;
}
