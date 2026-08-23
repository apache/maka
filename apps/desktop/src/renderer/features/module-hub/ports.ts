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
  DailyReviewArchive,
  DailyReviewArchiveSummary,
  DailyReviewRange,
  DailyReviewSummary,
} from '@maka/core/daily-review';
import type { Result } from '@maka/core/result';
import type {
  CreateScheduledTaskInput,
  ScheduledTask,
  UpdateScheduledTaskInput,
} from '@maka/core/scheduled-task';
import type {
  BundledSkillCatalogEntry,
  ManagedSkillSourceEntry,
  ManagedSkillUpdatePreview,
  SkillEntry,
} from '@maka/ui';

export type ModuleHubUnsubscribe = () => void;

export interface ModuleHubRuntimeHostRef {
  readonly profileId: string;
  readonly hostId: string;
}

export interface ModuleHubRuntimeHostChangedEvent {
  readonly profileId: string;
  readonly readiness: 'connecting' | 'ready' | 'reconnecting' | 'unavailable';
  readonly hostId?: string;
  readonly isDefault: boolean;
  readonly removed?: boolean;
}

export interface ModuleHubRuntimeHostsService {
  getDefault(): Promise<ModuleHubRuntimeHostRef>;
  subscribeChanges(
    handler: (event: ModuleHubRuntimeHostChangedEvent) => void,
  ): ModuleHubUnsubscribe;
}

export type InstallSkillResult =
  | { ok: true; skill: SkillEntry }
  | {
      ok: false;
      reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed';
    };

export type ImportManagedSkillSourceResult =
  | { ok: true; source: ManagedSkillSourceEntry }
  | {
      ok: false;
      reason:
        | 'cancelled'
        | 'invalid_skill'
        | 'already_exists'
        | 'blocked_path'
        | 'write_failed';
    };

export type PreviewManagedSkillUpdateResult =
  | { ok: true; preview: ManagedSkillUpdatePreview }
  | {
      ok: false;
      reason:
        | 'not_managed'
        | 'source_missing'
        | 'metadata_error'
        | 'blocked_path'
        | 'read_failed';
    };

export type UpdateManagedSkillResult =
  | { ok: true; skill: SkillEntry }
  | {
      ok: false;
      reason:
        | 'not_managed'
        | 'source_missing'
        | 'local_modified'
        | 'metadata_error'
        | 'blocked_path'
        | 'write_failed';
    };

export type ChangeSkillRuntimeStateResult =
  | { ok: true; skill: SkillEntry }
  | {
      ok: false;
      reason: 'not_found' | 'blocked_path' | 'state_error' | 'write_failed';
    };

export type DeleteSkillResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_found' | 'blocked_path' | 'blocked_scope' | 'delete_failed';
    };

export type OpenSkillResult =
  | { ok: true; target: 'file' | 'directory' }
  | {
      ok: false;
      reason:
        | 'invalid_id'
        | 'missing'
        | 'blocked_path'
        | 'not_file'
        | 'not_directory'
        | 'open_failed';
    };

export interface ModuleHubSkillsService {
  list(host: ModuleHubRuntimeHostRef): Promise<SkillEntry[]>;
  listManagedSources(host: ModuleHubRuntimeHostRef): Promise<ManagedSkillSourceEntry[]>;
  listBundledCatalog(host: ModuleHubRuntimeHostRef): Promise<BundledSkillCatalogEntry[]>;
  importManagedSource(host: ModuleHubRuntimeHostRef): Promise<ImportManagedSkillSourceResult>;
  installManaged(sourceId: string, host: ModuleHubRuntimeHostRef): Promise<InstallSkillResult>;
  installBundled(id: string, host: ModuleHubRuntimeHostRef): Promise<InstallSkillResult>;
  previewUpdate(
    skillId: string,
    host: ModuleHubRuntimeHostRef,
  ): Promise<PreviewManagedSkillUpdateResult>;
  updateManaged(
    skillId: string,
    options: {
      force?: boolean;
      expectedCurrentSha256?: string;
      expectedSourceSha256?: string;
    },
    host: ModuleHubRuntimeHostRef,
  ): Promise<UpdateManagedSkillResult>;
  setEnabled(
    skillId: string,
    enabled: boolean,
    host: ModuleHubRuntimeHostRef,
  ): Promise<ChangeSkillRuntimeStateResult>;
  setPinned(
    skillRef: string,
    pinned: boolean,
    host: ModuleHubRuntimeHostRef,
  ): Promise<ChangeSkillRuntimeStateResult>;
  delete(skillRef: string, host: ModuleHubRuntimeHostRef): Promise<DeleteSkillResult>;
  open(
    skillId: string,
    target: 'file' | 'directory',
    host: ModuleHubRuntimeHostRef,
  ): Promise<OpenSkillResult>;
}

export type ScheduledTaskCreateInput = Omit<CreateScheduledTaskInput, 'createdBy'>;

export interface ModuleHubScheduledTasksService {
  list(host: ModuleHubRuntimeHostRef): Promise<ScheduledTask[]>;
  create(
    input: ScheduledTaskCreateInput,
    host: ModuleHubRuntimeHostRef,
  ): Promise<ScheduledTask>;
  update(
    id: string,
    patch: UpdateScheduledTaskInput,
    host: ModuleHubRuntimeHostRef,
  ): Promise<ScheduledTask>;
  setEnabled(
    id: string,
    enabled: boolean,
    host: ModuleHubRuntimeHostRef,
  ): Promise<ScheduledTask>;
  triggerNow(id: string, host: ModuleHubRuntimeHostRef): Promise<ScheduledTask>;
  snooze(id: string, host: ModuleHubRuntimeHostRef): Promise<ScheduledTask>;
  clearRunHistory(id: string, host: ModuleHubRuntimeHostRef): Promise<ScheduledTask>;
  delete(id: string, host: ModuleHubRuntimeHostRef): Promise<void>;
  subscribeChanges(
    handler: (event: {
      type: 'scheduled_tasks_changed';
      reason: string;
      taskId?: string;
      ts: number;
    }) => void,
  ): ModuleHubUnsubscribe;
  subscribeDue(
    handler: (task: Pick<ScheduledTask, 'id' | 'title'>) => void,
  ): ModuleHubUnsubscribe;
}

export interface ModuleHubClientSettingsService {
  readonly supported: boolean;
  getKeepSystemAwake(): Promise<boolean>;
  setKeepSystemAwake(next: boolean): Promise<boolean>;
  subscribeChanges(handler: () => void): ModuleHubUnsubscribe;
}

export interface ModuleHubDailyReviewService {
  day(
    offsetDays: number,
    daySpan: number | undefined,
    host: ModuleHubRuntimeHostRef,
  ): Promise<Result<DailyReviewSummary>>;
  runOnce(input: {
    range: DailyReviewRange;
    offsetDays?: number;
    modelKey?: string;
  }): Promise<{ archiveId: string }>;
  listArchives(): Promise<DailyReviewArchiveSummary[]>;
  getArchive(archiveId: string): Promise<DailyReviewArchive | null>;
  saveMarkdownToFile(input: {
    markdown: string;
    defaultName: string;
  }): Promise<
    | { ok: true; path: string }
    | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
  >;
}

export interface ModuleHubClipboardService {
  writeText(text: string): Promise<void>;
}

/** Environment capabilities owned by the Module Hub feature slice. */
export interface ModuleHubServices {
  runtimeHosts: ModuleHubRuntimeHostsService;
  skills: ModuleHubSkillsService;
  scheduledTasks: ModuleHubScheduledTasksService;
  clientSettings: ModuleHubClientSettingsService;
  dailyReview: ModuleHubDailyReviewService;
  clipboard: ModuleHubClipboardService;
}
