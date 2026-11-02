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

/**
 * The browser's groups: pinned conversations first, then each workspace in
 * the order of its latest loaded conversation, then, when `withEmpty`, the
 * active projects with none loaded.
 */
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
  return [...groups.values()].map(({ members, ...group }) => {
    const { order, nested } = nestCreated(members);
    return { ...group, sessions: order, nested };
  });
}

/**
 * The conversations in the order the browser lists them: a collapsed group's
 * are left out, except `current`, so stepping from it still has neighbors.
 */
export function browserOrder(
  groups: readonly ConversationGroup<unknown>[],
  collapsed: ReadonlySet<string>,
  current: string | null,
): string[] {
  return groups.flatMap((group) =>
    collapsed.has(group.key) ? group.sessions.filter((id) => id === current) : group.sessions,
  );
}
