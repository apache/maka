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

import type { UiLocale } from '@maka/core/ui-locale';
import type { SessionHistoryGroup } from '@maka/ui';
import type {
  SessionNavigationProjectScope,
  SessionNavigationSession,
} from '../ports.js';
import { getShellRemainingCopy } from '../../../locales/shell-remaining-copy.js';
import { runtimeHostProjectKey } from '../../../application/contracts/runtime-host-project-key.js';

const UNGROUPED_KEY = '__ungrouped__';

/** The rail row a Project scope is drawn as. */
export function projectGroupId(scopeKey: string): string {
  return `project:${scopeKey}`;
}

/** The rail row a Host's project-less Sessions are drawn as. */
export function ungroupedGroupId(hostId: string): string {
  return `${UNGROUPED_KEY}:${hostId}`;
}

function scopedProjectLabel(projectName: string, profileName: string): string {
  return `${projectName} · ${profileName}`;
}

/** Groups every Session by its owning Runtime Host and Project at one level. */
export function deriveSessionNavigationGroups(
  sessions: readonly SessionNavigationSession[],
  projectScopes: readonly SessionNavigationProjectScope[],
  locale: UiLocale,
): SessionHistoryGroup[] {
  const canonicalKeys = new Map<string, string>();
  const sessionsByProject = new Map<string, SessionNavigationSession[]>();
  for (const scope of projectScopes) {
    canonicalKeys.set(
      runtimeHostProjectKey(scope.hostId, scope.project.id),
      scope.key,
    );
    for (const alias of scope.project.aliases ?? []) {
      canonicalKeys.set(runtimeHostProjectKey(scope.hostId, alias), scope.key);
    }
  }

  const ungroupedByHost = new Map<string, SessionNavigationSession[]>();
  for (const session of sessions) {
    if (!session.projectId) {
      const bucket = ungroupedByHost.get(session.runtimeHostId) ?? [];
      bucket.push(session);
      ungroupedByHost.set(session.runtimeHostId, bucket);
      continue;
    }
    const observed = runtimeHostProjectKey(
      session.runtimeHostId,
      session.projectId,
    );
    const key = canonicalKeys.get(observed) ?? `missing:${observed}`;
    const bucket = sessionsByProject.get(key) ?? [];
    bucket.push(session);
    sessionsByProject.set(key, bucket);
  }

  const groups = projectScopes.map((scope): SessionHistoryGroup => {
    const key = scope.key;
    return {
      id: projectGroupId(key),
      label: scopedProjectLabel(scope.project.name, scope.profileName),
      sessions: sessionsByProject.get(key) ?? [],
      // The UI treats this id as an opaque action target. Scope it here so
      // equal Host-local UUIDs can never route a mutation to another Host.
      project: { ...scope.project, id: key },
    };
  });

  const known = new Set(projectScopes.map((scope) => scope.key));
  for (const [key, missingSessions] of sessionsByProject) {
    if (known.has(key)) continue;
    const first = missingSessions[0]!;
    const pathName = first.cwd
      ?.replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .at(-1);
    groups.push({
      id: projectGroupId(key),
      label: scopedProjectLabel(
        pathName || first.projectId || 'Project',
        first.profileName,
      ),
      sessions: missingSessions,
    });
  }

  for (const [hostId, ungrouped] of ungroupedByHost) {
    const profileName = ungrouped[0]!.profileName;
    groups.push({
      id: ungroupedGroupId(hostId),
      label: scopedProjectLabel(
        getShellRemainingCopy(locale).projects.ungrouped,
        profileName,
      ),
      sessions: ungrouped,
    });
  }
  return groups;
}
