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
import type { UiLocale } from '@maka/core/ui-locale';
import type { SessionHistoryGroup } from '@maka/ui';
import { getShellRemainingCopy } from '../../../locales/shell-remaining-copy.js';

const UNGROUPED_KEY = '__ungrouped__';

export function deriveProjectGroups(
  sessions: ReadonlyArray<SessionSummary>,
  projects: ReadonlyArray<ProjectRecord>,
  locale: UiLocale,
): SessionHistoryGroup[] {
  const sessionsByProject = new Map<string, SessionSummary[]>();
  const canonicalProjectIds = new Map<string, string>();
  for (const project of projects) {
    canonicalProjectIds.set(project.id, project.id);
    for (const alias of project.aliases ?? []) canonicalProjectIds.set(alias, project.id);
  }
  const ungrouped: SessionSummary[] = [];

  for (const session of sessions) {
    const canonicalProjectId = session.projectId
      ? canonicalProjectIds.get(session.projectId)
      : undefined;
    if (!canonicalProjectId) {
      ungrouped.push(session);
      continue;
    }
    const bucket = sessionsByProject.get(canonicalProjectId) ?? [];
    bucket.push(session);
    sessionsByProject.set(canonicalProjectId, bucket);
  }

  const groups: SessionHistoryGroup[] = projects.map((project) => ({
    id: `project:${project.id}`,
    label: project.name,
    sessions: sessionsByProject.get(project.id) ?? [],
    project,
  }));
  if (ungrouped.length > 0) {
    groups.push({
      id: UNGROUPED_KEY,
      label: getShellRemainingCopy(locale).projects.ungrouped,
      sessions: ungrouped,
      project: undefined,
    });
  }
  return groups;
}

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

export function deriveSessionLocation(
  session: SessionSummary,
  projectsByIdentity: ReadonlyMap<string, ProjectRecord>,
): string | undefined {
  if (!session.projectId || !session.cwd) return undefined;
  const project = projectsByIdentity.get(session.projectId);
  if (!project || project.locations.length <= 1) return undefined;
  const match = project.locations.find((location) => samePath(location.path, session.cwd!));
  return match?.path;
}

/**
 * Whether two paths name the same location.
 *
 * Separators are unified first: a Host may hand back either, and `/Users/a/b`
 * and `\Users\a\b` are one directory on Windows, so mixed forms must match —
 * the worktree mark and the location line both depend on it. Windows paths
 * (drive-absolute and UNC) then fold case, matching the OS's case-insensitive
 * semantics; POSIX paths stay exact.
 */
function samePath(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (isWindowsPath(a) !== isWindowsPath(b)) return false;
  return isWindowsPath(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, '/');
  if (unified === '') return '';
  const trimmed = unified.replace(/\/+$/, '');
  if (trimmed.length === 0) {
    // The path was all separators: a POSIX root, or the UNC root `\\`.
    return unified.startsWith('//') ? '//' : '/';
  }
  // A drive root keeps its separator, or `C:\` would normalize to `C:` and
  // stop being recognised as a Windows path — losing case folding.
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}
