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
import type { RuntimeHostProfileKind } from '@maka/runtime-host/profile-kind';

export type TaskEntryUnsubscribe = () => void;

export interface TaskEntryHostRef {
  readonly profileId: string;
  readonly hostId: string;
}

export interface TaskEntryError {
  readonly title: string;
  readonly description?: string;
  readonly profileId: string;
}

export interface TaskEntryTarget extends TaskEntryHostRef {
  readonly projectId: string | null;
}

/** A Project together with the Runtime Host that owns its identity and mutations. */
export interface TaskEntryProjectScope extends TaskEntryHostRef {
  /** Opaque Desktop-wide identity for this Host-local Project. */
  readonly key: string;
  readonly profileName: string;
  readonly profileKind: RuntimeHostProfileKind;
  readonly project: ProjectRecord;
  readonly capabilities: TaskEntryProjectCapabilities;
}

export interface TaskEntryProjectCapabilities {
  readonly chooseClientDirectory: boolean;
  readonly chooseHostDirectory: boolean;
  readonly selectNoProject: boolean;
}

export interface TaskEntryHostProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: RuntimeHostProfileKind;
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
  addProject(host: TaskEntryHostRef, name?: string): Promise<TaskEntryProjectMutationResult>;
  relinkProject(
    host: TaskEntryHostRef,
    projectId: string,
  ): Promise<TaskEntryProjectMutationResult>;
  /**
   * Name a project that was just registered. A remote Host's directory browser
   * has no name field of its own, so the name typed before it opened is applied
   * here, once the folder is known.
   */
  renameProject(
    host: TaskEntryHostRef,
    projectId: string,
    name: string,
  ): Promise<void>;
  archiveProject(host: TaskEntryHostRef, projectId: string): Promise<void>;
  restoreProject(host: TaskEntryHostRef, projectId: string): Promise<void>;
}

export interface TaskEntryServices {
  readonly catalog: TaskEntryCatalogService;
}
