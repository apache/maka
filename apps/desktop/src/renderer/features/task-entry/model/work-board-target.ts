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

import { findProjectByIdentity, type ProjectRecord } from '@maka/core/project';
import type { WorkBoardItem } from '@maka/core/work-board';
import { isReadyTaskEntryHost, type ReadyTaskEntryHost } from './task-entry-selection.js';
import type { TaskEntryCatalog, TaskEntryTarget } from '../ports.js';
type ProjectTaskEntryTarget = TaskEntryTarget & { readonly projectId: string };

export type WorkBoardStartTargetResult =
  | { readonly ok: true; readonly target: ProjectTaskEntryTarget; readonly project: ProjectRecord }
  | {
      readonly ok: false;
      readonly reason: 'inbox' | 'unavailable' | 'ambiguous';
      readonly message: string;
    };

/** Resolve a board project's identity to one explicit, available Host target. */
export function resolveWorkBoardStartTarget(
  item: WorkBoardItem,
  catalog: TaskEntryCatalog,
  preferredHost?: { readonly profileId: string; readonly hostId: string },
): WorkBoardStartTargetResult {
  if (item.scope.kind !== 'project') {
    return { ok: false, reason: 'inbox', message: 'Inbox items need a project target before they can start a task.' };
  }
  const projectIdentity = item.scope.projectId;
  const matches = catalog.hosts
    .filter((host): host is ReadyTaskEntryHost => isReadyTaskEntryHost(host) && typeof host.hostId === 'string')
    .map((host: ReadyTaskEntryHost) => {
      const project = findProjectByIdentity(host.projects, projectIdentity);
      if (!project || !project.available || project.archivedAt !== undefined) return undefined;
      return {
        target: { profileId: host.profile.id, hostId: host.hostId, projectId: project.id },
        project,
      };
    })
    .filter((value): value is { target: ProjectTaskEntryTarget; project: ProjectRecord } => value !== undefined);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'The project is not available on a connected Runtime Host.',
    };
  }
  if (preferredHost) {
    const preferred = matches.find(
      (match) => match.target.profileId === preferredHost.profileId && match.target.hostId === preferredHost.hostId,
    );
    if (preferred) return { ok: true, ...preferred };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message: 'This project is available on more than one Runtime Host; choose a Host explicitly.',
    };
  }
  const only = matches[0];
  return { ok: true, target: only.target, project: only.project };
}
