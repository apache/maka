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
import type { ChatDefaultsSettings } from '@maka/core/settings';

export type TaskEntryUnsubscribe = () => void;

export interface TaskEntryHostRef {
  readonly profileId: string;
  readonly hostId: string;
}

export interface TaskEntryTarget extends TaskEntryHostRef {
  readonly projectId: string | null;
}

export interface TaskEntryProjectCapabilities {
  readonly chooseClientDirectory: boolean;
  readonly chooseHostDirectory: boolean;
  readonly selectNoProject: boolean;
}

export interface TaskEntryHostProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: 'local' | 'remote';
}

export type TaskEntryHost =
  | {
      readonly profile: TaskEntryHostProfile;
      readonly hostId: string;
      readonly readiness: 'ready';
      readonly state: 'available';
      readonly projects: readonly ProjectRecord[];
      readonly capabilities: TaskEntryProjectCapabilities;
      readonly selectedProjectId: string | null | undefined;
      readonly defaultProjectId?: string;
      readonly chatDefaults: Pick<
        ChatDefaultsSettings,
        'permissionMode' | 'thinkingLevel'
      >;
      readonly projectPath?: string;
      readonly branch?: string;
    }
  | {
      readonly profile: TaskEntryHostProfile;
      readonly hostId: string;
      readonly readiness: 'ready';
      readonly state: 'error';
      readonly message: string;
    }
  | {
      readonly profile: TaskEntryHostProfile;
      readonly readiness: 'connecting' | 'reconnecting' | 'unavailable';
      readonly message?: string;
    };

export interface TaskEntryCatalog {
  readonly defaultProfileId: string;
  readonly hosts: readonly TaskEntryHost[];
}

export type TaskEntryProjectMutationResult =
  | { readonly ok: true; readonly project: ProjectRecord }
  | { readonly ok: false; readonly reason: 'cancelled' };

/** The minimum environment capability needed by Task Entry / Workspace. */
export interface TaskEntryCatalogService {
  getCatalog(): Promise<TaskEntryCatalog>;
  subscribeChanges(handler: () => void): TaskEntryUnsubscribe;
  addProject(host: TaskEntryHostRef): Promise<TaskEntryProjectMutationResult>;
  relinkProject(
    host: TaskEntryHostRef,
    projectId: string,
  ): Promise<TaskEntryProjectMutationResult>;
}

export interface TaskEntryServices {
  readonly catalog: TaskEntryCatalogService;
}
