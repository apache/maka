/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type {
  AgentScheduledInput,
  AgentScheduledEffect,
  AgentScheduledDetail,
  AgentScheduledTarget,
  AgentSchedules,
  AgentScheduledSummary,
  DiscoveryToolGroup,
  IntervalCadence,
  ModelSelection,
  Schedule,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/index.js';

export type DiscoveryApproval = {
  target: AgentScheduledTarget;
  model: ModelSelection;
  thinkingLevel: ThinkingLevel | null;
};
type DiscoveryEffect = Extract<AgentScheduledEffect, { kind: 'discovery' }>;
export type DiscoveryWorkerTools = NonNullable<DiscoveryEffect['workerTools']>;

export type DiscoveryToolSelection = NonNullable<DiscoveryEffect['selectedTools']>;
export type DiscoveryToolPreview = Extract<AgentSchedules, { kind: 'discovery_tools' }>;

// Preserve the actual choices when a catalog changes, including the category of each alias.
export function selectedDiscoveryTools(
  preview: DiscoveryToolPreview,
  requested?: DiscoveryToolSelection | null,
  approvedNames?: string[] | null,
  draftGroups?: ReadonlyMap<DiscoveryToolGroup, ReadonlySet<string>>,
): DiscoveryToolSelection {
  const approved = approvedNames ? new Set(approvedNames) : null;
  return Object.fromEntries(
    Object.entries(preview.groups).filter(([name, group]) => {
      if (approved && !approved.has(name)) return false;
      const explicitNames = group && draftGroups?.get(group);
      if (explicitNames) return explicitNames.has(name);
      if (requested) return Object.hasOwn(requested, name) && requested[name] === group;
      // An exact grant from a preset-only plan can include plugin management.
      return approved !== null || group !== 'plugin_management';
    }),
  );
}

export function approvedDiscoveryNames(
  preview: DiscoveryToolPreview,
  selection: DiscoveryToolSelection,
) {
  const readsFiles = Object.values(selection).includes('read_files');
  return preview.names.filter((name) =>
    name === 'UpdateWatchScope' || name === 'UpdateWorkspaceMap'
      ? readsFiles
      : !Object.hasOwn(preview.groups, name) || Object.hasOwn(selection, name),
  );
}

export function discoveryWorkerTools(
  effect: AgentScheduledEffect | undefined,
): DiscoveryWorkerTools {
  return effect?.kind === 'discovery' ? (effect.workerTools ?? 'read_only') : 'read_only';
}

export function discoveryCadence(schedule?: Schedule): IntervalCadence {
  return schedule?.kind === 'interval' ? (schedule.cadence ?? 'fixed') : 'after_completion';
}

export function discoveryIntervalError(minutes: number, original?: Schedule) {
  if (original && original.kind !== 'interval') return null;
  const previous = original?.everySeconds;
  const keepSeconds = previous !== undefined && minutes === previous / 60;
  if (!keepSeconds && !Number.isSafeInteger(minutes)) return 'invalid';
  const seconds = keepSeconds ? previous : minutes * 60;
  if (seconds < 1) return 'invalid';
  return seconds > 0xffffffff ? 'too_long' : null;
}

export function discoveryInput(
  approval: DiscoveryApproval,
  title: string,
  intent: string,
  minutes: number,
  now: number,
  timezone: string,
  existing?: AgentScheduledDetail | null,
  options: { cadence?: IntervalCadence; workerTools?: DiscoveryWorkerTools } = {},
): AgentScheduledInput {
  const original = existing?.task.schedule;
  const originalInterval = original?.kind === 'interval' ? original : null;
  const sameMinutes = originalInterval !== null && minutes === originalInterval.everySeconds / 60;
  const originalCadence = discoveryCadence(original);
  const cadence = options.cadence ?? originalCadence;
  const workerTools =
    options.workerTools ?? (existing ? discoveryWorkerTools(existing.task.effect) : 'read_only');
  const preserve = original && (!originalInterval || (sameMinutes && cadence === originalCadence));
  const interval = sameMinutes ? originalInterval.everySeconds : minutes * 60;
  const start = now + interval * 1000;
  if (!preserve && (discoveryIntervalError(minutes, original) || !Number.isSafeInteger(start)))
    throw new Error('invalid_discovery_settings');
  return {
    task: {
      title,
      intentBody: intent.trim(),
      schedule: preserve
        ? original
        : { kind: 'interval', everySeconds: interval, startAt: start, cadence },
      effect: { kind: 'discovery', ...approval, workerTools },
      maxFires: existing?.task.maxFires ?? null,
      expiresAt: existing?.task.expiresAt ?? null,
    },
    timezone: existing?.timezone ?? timezone,
    misfire: existing?.misfire ?? 'latest',
  };
}

export async function discoveryTasks(
  first: AgentSchedules,
  next: (cursor: string, revision: number) => Promise<AgentSchedules>,
): Promise<AgentScheduledSummary[]> {
  if (first.kind !== 'page') throw new Error('scheduler_page_changed');
  const tasks = [...first.tasks];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await next(cursor, first.revision);
    if (page.kind !== 'page') throw new Error('scheduler_page_changed');
    tasks.push(...page.tasks);
    cursor = page.nextCursor;
  }
  return tasks;
}
