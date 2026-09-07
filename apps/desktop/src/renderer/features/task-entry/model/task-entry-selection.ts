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

import { findProjectByIdentity } from '@maka/core/project';
import { UNRESOLVED_NEW_TASK_DRAFT_KEY } from '../../../new-task-reload-intent.js';
import type {
  TaskEntryCatalog,
  TaskEntryHost,
  TaskEntryTarget,
} from '../ports.js';

export type ReadyTaskEntryHost = Extract<
  TaskEntryHost,
  { readonly readiness: 'ready'; readonly state: 'available' }
>;

export function selectAvailableProfile(
  catalog: TaskEntryCatalog,
  current: string | undefined,
): string | undefined {
  const available = catalog.hosts.filter(isReadyTaskEntryHost);
  if (current && available.some((host) => host.profile.id === current)) return current;
  if (available.some((host) => host.profile.id === catalog.defaultProfileId)) {
    return catalog.defaultProfileId;
  }
  return available[0]?.profile.id ??
    catalog.hosts.find((host) => host.profile.id === catalog.defaultProfileId)?.profile.id ??
    catalog.hosts[0]?.profile.id;
}

export function resolveProjectSelection(
  host: ReadyTaskEntryHost,
  requested: string | null | undefined,
): string | null | undefined {
  if (requested === null && host.capabilities.selectNoProject) return null;
  if (typeof requested === 'string') {
    const project = findProjectByIdentity(host.projects, requested);
    if (project?.available && project.archivedAt === undefined) return project.id;
  }
  if (host.defaultProjectId) {
    const project = findProjectByIdentity(host.projects, host.defaultProjectId);
    if (project?.available && project.archivedAt === undefined) return project.id;
  }
  if (host.selectedProjectId === null && host.capabilities.selectNoProject) return null;
  if (typeof host.selectedProjectId === 'string') {
    const project = findProjectByIdentity(host.projects, host.selectedProjectId);
    if (project?.available && project.archivedAt === undefined) return project.id;
  }
  return host.capabilities.selectNoProject ? null : undefined;
}

export function taskEntryDraftKey(target: TaskEntryTarget | undefined): string {
  return target
    ? JSON.stringify(['new-task', target.profileId, target.hostId, target.projectId])
    : UNRESOLVED_NEW_TASK_DRAFT_KEY;
}

export function isReadyTaskEntryHost(host: TaskEntryHost): host is ReadyTaskEntryHost {
  return host.readiness === 'ready' && host.state === 'available';
}
