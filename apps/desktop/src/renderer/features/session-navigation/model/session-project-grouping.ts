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

export function deriveSessionLocation(
  session: SessionSummary,
  project: ProjectRecord | undefined,
): string | undefined {
  if (!session.projectId || !session.cwd) return undefined;
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
 * (drive-absolute and explicit backslash UNC) then fold case, matching the
 * OS's case-insensitive semantics; POSIX paths stay exact, including `//`.
 */
function samePath(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  // A leading `//` alone is also a valid POSIX path. An original `\\` prefix
  // identifies UNC even when the other side uses forward slashes.
  const windowsPath = isWindowsPath(left, a) || isWindowsPath(right, b);
  return windowsPath ? a.toLowerCase() === b.toLowerCase() : a === b;
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

function isWindowsPath(original: string, normalized: string): boolean {
  return /^[A-Za-z]:\//.test(normalized) || original.startsWith('\\\\');
}
