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

import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary } from '@maka/core/session';

export function deriveWorktreeSessionIds(
  sessions: ReadonlyArray<SessionSummary>,
  projects: ReadonlyArray<ProjectRecord>,
): Set<string> {
  const projectsById = new Map<string, ProjectRecord>();
  for (const project of projects) {
    projectsById.set(project.id, project);
    for (const alias of project.aliases ?? []) projectsById.set(alias, project);
  }
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!session.projectId || !session.cwd) continue;
    const project = projectsById.get(session.projectId);
    if (
      project?.locations.some(
        (location) => location.isWorktree && samePath(location.path, session.cwd!),
      )
    ) {
      ids.add(session.id);
    }
  }
  return ids;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}
