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

import type { CreateScheduledTaskInput, ScheduledTaskEffect, UpdateScheduledTaskInput } from '@maka/core/scheduled-task';
import type { DailyReviewRange, DailyReviewViewState } from './daily-review-view-state.js';

export interface SkillEntry {
  kind?: 'skill' | 'discovery_diagnostic';
  ref?: string;
  id: string;
  name: string;
  description: string;
  path: string;
  /**
   * Tools the skill *declares* it would like to use. This is a request, not
   * a grant — the active session sandbox boundary still applies. We surface
   * the list so users can see what a skill is asking for before installation.
   */
  declaredTools?: string[];
  sourceType?: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified?: boolean;
  validationStatus?: 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
  managedUpdateStatus?: 'not_managed' | 'source_missing' | 'up_to_date' | 'update_available' | 'local_modified' | 'metadata_error';
  enabled: boolean;
  pinned?: boolean;
  runtimeStatus: 'enabled' | 'disabled' | 'state_error';
  scope?: 'project' | 'workspace' | 'user' | 'custom';
  source?: 'maka' | 'agents' | 'legacy' | 'custom';
  contextStatus?:
    | 'advertised'
    | 'disabled'
    | 'invalid'
    | 'host_incompatible'
    | 'shadowed'
    | 'budget';
  contextRank?: number;
  shadowedBy?: string;
  needsReview?: boolean;
  discoveryDiagnosticReason?: 'blocked_path' | 'read_failed';
  manageable?: boolean;
}

export type SkillGovernanceStatus = 'not_managed' | 'source_missing' | 'up_to_date' | 'update_available' | 'local_modified' | 'metadata_error';
export type SkillValidationStatus = 'ok' | 'missing_lock' | 'modified' | 'metadata_error';
export type SkillValidationCode =
  | 'missing_lock'
  | 'modified'
  | 'invalid_json'
  | 'id_mismatch'
  | 'unsupported_schema'
  | 'invalid_hash'
  | 'write_failed'
  | 'lock_symlink';

export interface SkillGovernanceDetails {
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
  sourceType: 'workspace' | 'bundled' | 'managed' | 'unknown';
  userModified: boolean;
  validationStatus: SkillValidationStatus;
  enabled: boolean;
  runtimeStatus: 'enabled' | 'disabled' | 'state_error';
  validationCodes: SkillValidationCode[];
  validationMessages: string[];
  managedSourceId?: string;
  managedUpdateStatus?: SkillGovernanceStatus;
  hasManagedBaseline: boolean;
  sourceAvailable?: boolean;
  sourceChanged?: boolean;
}

export interface ManagedSkillUpdatePreview {
  skill: SkillGovernanceDetails;
  currentContent: string;
  sourceContent: string;
  baselineContent?: string;
  expectedCurrentSha256: string;
  expectedSourceSha256: string;
  summary: {
    currentLineCount: number;
    sourceLineCount: number;
    changedLineCount: number;
  };
}

/**
 * Marketplace taxonomy buckets surfaced by the 市场 tab category filter.
 * Mirrors MANAGED_SKILL_CATEGORIES in apps/desktop's managed-skill-sources;
 * the main-process reader always resolves an entry to one of these, so the
 * renderer can treat `category` as required (unknown → 效率工具 upstream).
 */
export type ManagedSkillCategory =
  | '内容创作'
  | '数据与AI'
  | '设计与UI'
  | 'DevOps与部署'
  | '文档与写作'
  | '效率工具'
  | '研究与分析';

export interface ManagedSkillSourceEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  sourceType: 'local';
}

/**
 * One entry in the built-in (内置) skill catalog shipped with the app. Mirrors
 * listBundledSkillCatalog in apps/desktop's skills module. `installed` reflects
 * whether the current workspace already has skills/<id>; nothing here is
 * auto-installed — the 内置 tab offers a per-entry install action.
 */
export interface BundledSkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: ManagedSkillCategory;
  declaredTools: string[];
  installed: boolean;
}

export type ScheduledTaskDraftInput = Omit<CreateScheduledTaskInput, 'createdBy'>;
export type ScheduledTaskUpdatePatch = UpdateScheduledTaskInput;
export type ScheduledTaskRecurrence =
  | 'none'
  | 'interval'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'cron';
export type ScheduledTaskDelivery = Extract<ScheduledTaskEffect, { kind: 'notify' }>;
export type ScheduledTaskDeliveryMethod = ScheduledTaskDelivery['channel'] | 'agent_run';

/** UI-only projection over ordinary Session catalog and shared usage facts. */
export interface DailyReviewProjectionBridge {
  load(range: DailyReviewRange, offsetDays?: number): Promise<DailyReviewViewState>;
}
