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

export function discoveryWorkerTools(
  effect: AgentScheduledEffect | undefined,
): DiscoveryWorkerTools {
  return effect?.kind === 'discovery' ? (effect.workerTools ?? 'read_only') : 'read_only';
}

export function discoveryCadence(schedule?: Schedule): IntervalCadence {
  return schedule?.kind === 'interval' ? (schedule.cadence ?? 'fixed') : 'after_completion';
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
  if (
    !preserve &&
    ((!sameMinutes && !Number.isSafeInteger(minutes)) ||
      interval < 1 ||
      interval > 0xffffffff ||
      !Number.isSafeInteger(start))
  )
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
