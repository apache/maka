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

import type { ScheduledTask, ScheduledTaskRunOutcome } from './scheduled-task.js';

export const SOURCE_RECORD_TYPES = ['mcp', 'api', 'local'] as const;
export type SourceRecordType = (typeof SOURCE_RECORD_TYPES)[number];

export const SOURCE_AUTH_TYPES = ['oauth', 'bearer', 'none'] as const;
export type SourceAuthType = (typeof SOURCE_AUTH_TYPES)[number];

export const SOURCE_RECORD_STATUSES = ['ready', 'needs_auth', 'error', 'disabled'] as const;
export type SourceRecordStatus = (typeof SOURCE_RECORD_STATUSES)[number];

export const CAPABILITY_AUDIT_PERMISSION_MODES = ['explore', 'ask', 'execute'] as const;
export type CapabilityAuditPermissionMode = (typeof CAPABILITY_AUDIT_PERMISSION_MODES)[number];

export const SCHEDULED_TASK_LAST_RUN_STATUSES = ['ok', 'error', 'skipped'] as const;
export type ScheduledTaskLastRunStatus = (typeof SCHEDULED_TASK_LAST_RUN_STATUSES)[number];

export const LOCAL_SKILL_SOURCE_SLUG = 'workspace-skills';

export interface SourceRecord {
  slug: string;
  name: string;
  type: SourceRecordType;
  enabled: boolean;
  authType: SourceAuthType;
  scopeSummary: string[];
  status: SourceRecordStatus;
  lastTestAt?: number;
  lastErrorReason?: string;
}

export interface CapabilityAuditSkillInput {
  id: string;
  name: string;
  description?: string;
  declaredTools?: readonly string[];
  enabled?: boolean;
  sourceSlug?: string;
}

export interface SkillAuditRecord {
  id: string;
  name: string;
  description: string;
  declaredTools: string[];
  enabled: boolean;
  sourceSlug: string;
  permissionMode: Exclude<CapabilityAuditPermissionMode, 'execute'>;
}

export interface ScheduledTaskAuditRecord {
  id: string;
  name: string;
  enabled: boolean;
  permissionMode: CapabilityAuditPermissionMode;
  lastRunAt?: number;
  lastRunStatus?: ScheduledTaskLastRunStatus;
}

export interface CapabilityAuditSummary {
  sourceCount: number;
  readySourceCount: number;
  needsAuthSourceCount: number;
  errorSourceCount: number;
  disabledSourceCount: number;
  skillCount: number;
  enabledSkillCount: number;
  skillsWithDeclaredTools: number;
  declaredToolKindCount: number;
  scheduledTaskCount: number;
  enabledScheduledTaskCount: number;
  executableScheduledTaskCount: number;
  failedScheduledTaskCount: number;
  skippedScheduledTaskCount: number;
}

export interface CapabilityAuditReport {
  checkedAt: number;
  sources: SourceRecord[];
  skills: SkillAuditRecord[];
  scheduledTasks: ScheduledTaskAuditRecord[];
  summary: CapabilityAuditSummary;
}

export interface DeriveCapabilityAuditReportInput {
  now?: number;
  sources?: readonly SourceRecord[];
  skills?: readonly CapabilityAuditSkillInput[];
  scheduledTasks?: readonly ScheduledTask[];
}

export function deriveCapabilityAuditReport(
  input: DeriveCapabilityAuditReportInput = {},
): CapabilityAuditReport {
  const now = Math.trunc(input.now ?? Date.now());
  const skills = normalizeSkillInputs(input.skills ?? []);
  const declaredToolKindCount = distinctDeclaredToolKinds(skills).length;
  const sources = normalizeSourceRecords(input.sources ?? []);
  const needsLocalSkillSource =
    sources.length === 0 || skills.some((skill) => skill.sourceSlug === LOCAL_SKILL_SOURCE_SLUG);
  const allSources =
    needsLocalSkillSource && !sources.some((source) => source.slug === LOCAL_SKILL_SOURCE_SLUG)
      ? [localSkillSource(skills.length, declaredToolKindCount, now), ...sources]
      : sources;
  const scheduledTasks = (input.scheduledTasks ?? []).map(scheduledTaskToAuditRecord);

  return {
    checkedAt: now,
    sources: allSources,
    skills,
    scheduledTasks,
    summary: summarizeCapabilityAudit(allSources, skills, scheduledTasks),
  };
}

function normalizeSkillInputs(skills: readonly CapabilityAuditSkillInput[]): SkillAuditRecord[] {
  return skills.map((skill, index) => {
    const id = normalizeNonEmptyString(skill.id) ?? `skill-${index + 1}`;
    const declaredTools = uniqueNonEmptyStrings(skill.declaredTools ?? []);
    return {
      id,
      name: normalizeNonEmptyString(skill.name) ?? id,
      description: normalizeNonEmptyString(skill.description) ?? '',
      declaredTools,
      enabled: skill.enabled ?? true,
      sourceSlug: normalizeNonEmptyString(skill.sourceSlug) ?? LOCAL_SKILL_SOURCE_SLUG,
      permissionMode: declaredTools.length > 0 ? 'ask' : 'explore',
    };
  });
}

function normalizeSourceRecords(sources: readonly SourceRecord[]): SourceRecord[] {
  return sources.map((source, index) => {
    const slug = normalizeNonEmptyString(source.slug) ?? `source-${index + 1}`;
    return {
      slug,
      name: normalizeNonEmptyString(source.name) ?? slug,
      type: source.type,
      enabled: source.enabled,
      authType: source.authType,
      scopeSummary: uniqueNonEmptyStrings(source.scopeSummary),
      status: source.status,
      ...(typeof source.lastTestAt === 'number'
        ? { lastTestAt: Math.trunc(source.lastTestAt) }
        : {}),
      ...(source.lastErrorReason ? { lastErrorReason: source.lastErrorReason } : {}),
    };
  });
}

function localSkillSource(
  skillCount: number,
  declaredToolKindCount: number,
  now: number,
): SourceRecord {
  const hasSkills = skillCount > 0;
  return {
    slug: LOCAL_SKILL_SOURCE_SLUG,
    name: '工作区 skills 目录',
    type: 'local',
    enabled: hasSkills,
    authType: 'none',
    scopeSummary: hasSkills
      ? [`${skillCount} 个本地 Skill`, `${declaredToolKindCount} 类声明工具`]
      : ['等待添加本地 Skill'],
    status: hasSkills ? 'ready' : 'disabled',
    ...(hasSkills ? { lastTestAt: now } : { lastErrorReason: '未检测到已安装 Skill' }),
  };
}

function scheduledTaskToAuditRecord(task: ScheduledTask): ScheduledTaskAuditRecord {
  const lastRun = task.runs[0];
  return {
    id: task.id,
    name: task.title,
    enabled: task.status === 'active',
    permissionMode: scheduledTaskPermissionMode(task),
    ...(lastRun ? { lastRunAt: lastRun.at } : {}),
    ...(lastRun ? { lastRunStatus: mapScheduledTaskRunOutcome(lastRun.outcome) } : {}),
  };
}

function scheduledTaskPermissionMode(task: ScheduledTask): CapabilityAuditPermissionMode {
  if (task.status === 'completed' || task.status === 'expired') return 'explore';
  if (task.status === 'paused') return 'ask';
  return 'execute';
}

function mapScheduledTaskRunOutcome(outcome: ScheduledTaskRunOutcome): ScheduledTaskLastRunStatus {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'blocked') return 'skipped';
  return 'error';
}

function summarizeCapabilityAudit(
  sources: readonly SourceRecord[],
  skills: readonly SkillAuditRecord[],
  scheduledTasks: readonly ScheduledTaskAuditRecord[],
): CapabilityAuditSummary {
  return {
    sourceCount: sources.length,
    readySourceCount: sources.filter((source) => source.status === 'ready').length,
    needsAuthSourceCount: sources.filter((source) => source.status === 'needs_auth').length,
    errorSourceCount: sources.filter((source) => source.status === 'error').length,
    disabledSourceCount: sources.filter((source) => source.status === 'disabled').length,
    skillCount: skills.length,
    enabledSkillCount: skills.filter((skill) => skill.enabled).length,
    skillsWithDeclaredTools: skills.filter((skill) => skill.declaredTools.length > 0).length,
    declaredToolKindCount: distinctDeclaredToolKinds(skills).length,
    scheduledTaskCount: scheduledTasks.length,
    enabledScheduledTaskCount: scheduledTasks.filter((task) => task.enabled).length,
    executableScheduledTaskCount: scheduledTasks.filter((task) => task.permissionMode === 'execute')
      .length,
    failedScheduledTaskCount: scheduledTasks.filter((task) => task.lastRunStatus === 'error')
      .length,
    skippedScheduledTaskCount: scheduledTasks.filter((task) => task.lastRunStatus === 'skipped')
      .length,
  };
}

function distinctDeclaredToolKinds(
  skills: readonly Pick<SkillAuditRecord, 'declaredTools'>[],
): string[] {
  return uniqueNonEmptyStrings(skills.flatMap((skill) => skill.declaredTools));
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}
