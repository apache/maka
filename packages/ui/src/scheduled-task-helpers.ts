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

/**
 * Pure helpers and presentation data for the ScheduledTaskPanel.
 *
 * PR-UI-LIB-EXTRACT-0 (WAWQAQ msg `510fef52`): pulled out of the
 * 8753-line `components.tsx` kitchen-sink. All 24 helpers in this
 * file are pure logic (no React, no JSX); the example-templates const
 * and its type were also lifted here so the panel file imports a
 * single coherent helper module instead of intermingling logic with
 * its JSX. The cut is byte-for-byte equivalent — nothing renamed, no
 * behavior change, no consumers outside `components.tsx` so the
 * surface is unchanged.
 *
 * Why this file exists separately from the panel: pure helpers are
 * far cheaper to unit-test in isolation than nested inside a 6700-
 * line tsx file, and the file split documents the natural seam
 * between "what to render" and "how to compute display state".
 */

import type { BotProvider } from '@maka/core/bot-chat-settings';

import type {
  ScheduledTask,
  ScheduledTaskEffect,
  ScheduledTaskSchedule,
  ScheduledTaskStatus,
} from '@maka/core/scheduled-task';

import type { UiLocale } from '@maka/core/ui-locale';
import { BOT_DELIVERY_PROVIDERS } from '@maka/core/bot-chat-settings';
import { botDisplayLabel } from '@maka/core/bot-events';
import { compileCronExpression } from '@maka/core/cron-expression';
import { uiLocaleToIntlLocale } from '@maka/core/ui-locale';
import {
  getScheduledTaskCopy,
  type ScheduledTaskExampleTemplate,
} from './scheduled-task-copy.js';
import type {
  ScheduledTaskDelivery,
  ScheduledTaskDeliveryMethod,
  ScheduledTaskRecurrence,
} from './module-panel-types.js';

export function toScheduledTaskLocalDateTimeValue(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduledTaskTemplateNextRunAt(template: ScheduledTaskExampleTemplate, now: number = Date.now()): number {
  const nextRun = new Date(now);
  nextRun.setSeconds(0, 0);
  nextRun.setHours(template.nextRun.hour, template.nextRun.minute, 0, 0);
  if (typeof template.nextRun.weekday === 'number') {
    const daysUntilTarget = (template.nextRun.weekday - nextRun.getDay() + 7) % 7;
    nextRun.setDate(nextRun.getDate() + daysUntilTarget);
  }
  if (nextRun.getTime() <= now) {
    nextRun.setDate(nextRun.getDate() + (typeof template.nextRun.weekday === 'number' ? 7 : 1));
  }
  return nextRun.getTime();
}

export type ScheduledTaskValidationField = 'title' | 'time' | 'cron' | 'chatId';

export function scheduledTaskFormValidation(input: {
  title: string;
  parsedRunAt: number;
  recurrence: ScheduledTaskRecurrence;
  cronExpression: string;
  delivery: ScheduledTaskEffect;
  now: number;
}, locale: UiLocale): { field: ScheduledTaskValidationField; message: string } | null {
  const copy = getScheduledTaskCopy(locale).validation;
  if (input.title.trim().length === 0) {
    return { field: 'title', message: copy.title };
  }
  if (!Number.isFinite(input.parsedRunAt)) {
    return { field: 'time', message: copy.timeInvalid };
  }
  if (input.parsedRunAt <= input.now) {
    return { field: 'time', message: copy.timePast };
  }
  if (input.recurrence === 'cron' && !compileCronExpression(input.cronExpression).ok) {
    return { field: 'cron', message: copy.cron };
  }
  if (
    input.delivery.kind === 'notify' &&
    input.delivery.channel === 'bot' &&
    input.delivery.chatId.length === 0
  ) {
    return { field: 'chatId', message: copy.chatId };
  }
  return null;
}

export function formatScheduledTaskDeliveryProviderList(): string {
  return BOT_DELIVERY_PROVIDERS.map((provider) => botDisplayLabel(provider)).join(' / ');
}

export function compareScheduledTaskForDisplay(a: ScheduledTask, b: ScheduledTask, locale: UiLocale): number {
  const statusDelta = scheduledTaskStatusDisplayRank(a) - scheduledTaskStatusDisplayRank(b);
  if (statusDelta !== 0) return statusDelta;
  if (a.status === 'active' && b.status === 'active') {
    return scheduledTaskNextRunSortValue(a) - scheduledTaskNextRunSortValue(b);
  }
  if (a.status === 'completed' && b.status === 'completed') {
    return scheduledTaskLastRunSortValue(b) - scheduledTaskLastRunSortValue(a);
  }
  return a.title.localeCompare(b.title, uiLocaleToIntlLocale(locale));
}

export function compareScheduledTaskBySort(a: ScheduledTask, b: ScheduledTask, sort: 'created-desc' | 'next-run-asc' | 'updated-desc', locale: UiLocale): number {
  if (sort === 'created-desc') {
    return b.createdAt - a.createdAt || compareScheduledTaskForDisplay(a, b, locale);
  }
  if (sort === 'updated-desc') {
    return b.updatedAt - a.updatedAt || compareScheduledTaskForDisplay(a, b, locale);
  }
  return compareScheduledTaskForDisplay(a, b, locale);
}

function scheduledTaskStatusDisplayRank(task: ScheduledTask): number {
  if (task.status === 'active') return 0;
  if (task.status === 'paused') return 1;
  if (task.status === 'completed') return 2;
  return 3;
}

function scheduledTaskNextRunSortValue(task: ScheduledTask): number {
  return task.nextFireAt ?? Number.MAX_SAFE_INTEGER;
}

function scheduledTaskLastRunSortValue(task: ScheduledTask): number {
  return task.runs[0]?.at ?? 0;
}

export function normalizeScheduledTaskSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function scheduledTaskMatchesSearch(task: ScheduledTask, query: string, locale: UiLocale): boolean {
  return scheduledTaskSearchText(task, locale).toLocaleLowerCase().includes(query);
}

export function scheduledTaskSearchText(task: ScheduledTask, locale: UiLocale): string {
  return [
    task.title,
    task.intent.body,
    task.status,
    formatScheduledTaskRecurrence(task, locale),
    formatScheduledTaskDeliveryTargetLabel(task.effect, locale),
    task.runs[0]?.message,
    ...task.runs.map((run) => `${runStatusLabel(run.outcome, locale)} ${run.message}`),
  ].filter(Boolean).join('\n');
}

export function scheduledTaskStatusGroupLabel(status: ScheduledTaskStatus, locale: UiLocale): string {
  return getScheduledTaskCopy(locale).status[status];
}

export function scheduledTaskStatusLabel(status: ScheduledTaskStatus, locale: UiLocale): string {
  return scheduledTaskStatusGroupLabel(status, locale);
}

export function scheduledTaskRunRangeStart(range: 'day' | 'week' | 'month' | 'all', now: number): number | null {
  if (range === 'all') return null;
  const date = new Date(now);
  if (range === 'day') {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  return now - (range === 'week' ? 7 : 30) * 24 * 60 * 60 * 1000;
}

export function scheduledTaskEditableRunAt(task: ScheduledTask, now: number = Date.now()): number {
  if (task.nextFireAt !== null && task.nextFireAt > now) return task.nextFireAt;
  const scheduledAt = task.schedule.kind === 'once'
    ? task.schedule.runAt
    : task.schedule.kind === 'calendar'
      ? task.schedule.anchorAt
      : task.schedule.startAt;
  return scheduledAt > now ? scheduledAt : now + 60 * 60 * 1000;
}

export function scheduledTaskRecurrenceValue(task: ScheduledTask): ScheduledTaskRecurrence {
  if (task.schedule.kind === 'once') return 'none';
  if (task.schedule.kind === 'interval') return 'interval';
  if (task.schedule.kind === 'cron') return 'cron';
  if (task.schedule.kind === 'calendar') return task.schedule.recurrence;
  return 'none';
}

export function duplicateScheduledTaskTitle(title: string, locale: UiLocale): string {
  const suffix = getScheduledTaskCopy(locale).duplicateSuffix;
  if (title.endsWith(suffix)) return title;
  return `${title}${suffix}`.slice(0, 120);
}

export function formatTaskTime(ts: number, locale: UiLocale): string {
  return new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

/**
 * Small chip next to the absolute
 * next-run time so the user sees both "what" and "when from now"
 * in one glance. Past-due tasks read as "已过期"; very near
 * (< 60s) reads "马上"; the rest read in minute / hour / day
 * buckets so screen-reader users get a single self-contained
 * label.
 */
export function formatTaskCountdown(ts: number, locale: UiLocale, now: number = Date.now()): string {
  const copy = getScheduledTaskCopy(locale).countdown;
  const diffMs = ts - now;
  if (diffMs <= -60_000) return copy.overdue;
  if (diffMs < 60_000) return copy.soon;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return copy.minutes(diffMin);
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return copy.hours(diffHour);
  const diffDay = Math.round(diffHour / 24);
  if (diffDay === 1) return copy.tomorrow;
  if (diffDay < 7) return copy.days(diffDay);
  if (diffDay < 30) return copy.weeks(Math.round(diffDay / 7));
  return copy.months(Math.round(diffDay / 30));
}

export function formatScheduledTaskRecurrence(task: ScheduledTask, locale: UiLocale): string {
  const copy = getScheduledTaskCopy(locale).recurrence;
  if (task.schedule.kind === 'once') return copy.once;
  if (task.schedule.kind === 'cron') return copy.cron(task.schedule.expression);
  if (task.schedule.kind === 'calendar') return copy.recurring[task.schedule.recurrence];
  return copy.interval(task.schedule.everySeconds);
}

export function runStatusLabel(status: ScheduledTask['runs'][number]['outcome'], locale: UiLocale): string {
  return getScheduledTaskCopy(locale).runStatus[status];
}

export function formatScheduledTaskDeliveryTargetLabel(effect: ScheduledTaskEffect, locale: UiLocale): string {
  const copy = getScheduledTaskCopy(locale).delivery;
  if (effect.kind !== 'notify') return getScheduledTaskCopy(locale).detail.agentDelivery;
  if (effect.channel === 'local') return copy.local;
  return copy.bot(botDisplayLabel(effect.platform), effect.chatId);
}

/**
 * Initial field values for the scheduled-task form dialog
 * (ScheduledTaskFormDialog, issue #1044). The panel builds one seed per open
 * (create / template / edit / duplicate) and the dialog mounts with it, so
 * the seeds are pure mappings — they live here with the other form helpers,
 * not in the component file.
 */
export interface ScheduledTaskFormSeed {
  editingId: string | null;
  title: string;
  note: string;
  runAtLocal: string;
  recurrence: ScheduledTaskRecurrence;
  cronExpression: string;
  deliveryMethod: ScheduledTaskDeliveryMethod;
  deliveryPlatform: BotProvider;
  deliveryChatId: string;
  /** UI does not expose interval cadence editing; preserve it instead of coercing to once. */
  lockedSchedule?: Extract<ScheduledTaskSchedule, { kind: 'interval' }>;
  /** Agent execution is frozen at creation and must never be rewritten as notification delivery. */
  lockedEffect?: Exclude<ScheduledTaskEffect, { kind: 'notify' }>;
}

/**
 * Absolute time for a one-tap task preset.
 *
 * "Next Monday" means the NEXT one: `((8 - day) % 7) || 7` never returns 0, so
 * asking on a Monday schedules seven days out rather than nine hours ago. The
 * two morning presets pin 09:00 local and clear the smaller fields, so the
 * time a user gets is the one the label promised regardless of when they
 * asked.
 */
export function scheduledTaskPresetRunAt(
  preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday',
  now: number = Date.now(),
): number {
  if (preset === 'ten-minutes') return now + 10 * 60 * 1000;
  if (preset === 'one-hour') return now + 60 * 60 * 1000;
  const date = new Date(now);
  if (preset === 'tomorrow-morning') {
    date.setDate(date.getDate() + 1);
    date.setHours(9, 0, 0, 0);
    return date.getTime();
  }
  const day = date.getDay();
  const daysUntilNextMonday = ((8 - day) % 7) || 7;
  date.setDate(date.getDate() + daysUntilNextMonday);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** Blank create-mode seed (one hour from now, no recurrence, local delivery). */
export function createScheduledTaskFormSeed(now: number = Date.now()): ScheduledTaskFormSeed {
  return {
    editingId: null,
    title: '',
    note: '',
    runAtLocal: toScheduledTaskLocalDateTimeValue(now + 60 * 60 * 1000),
    recurrence: 'none',
    cronExpression: '0 9 * * 1-5',
    deliveryMethod: 'local',
    deliveryPlatform: 'telegram',
    deliveryChatId: '',
  };
}

/** Create-mode seed prefilled from an example template. */
export function scheduledTaskTemplateSeed(template: ScheduledTaskExampleTemplate, now: number = Date.now()): ScheduledTaskFormSeed {
  return {
    ...createScheduledTaskFormSeed(now),
    title: template.title,
    note: template.note,
    recurrence: template.recurrence,
    cronExpression: template.cronExpression,
    runAtLocal: toScheduledTaskLocalDateTimeValue(scheduledTaskTemplateNextRunAt(template, now)),
  };
}

function scheduledTaskFormSeedFromTask(task: ScheduledTask): ScheduledTaskFormSeed {
  return {
    editingId: task.id,
    title: task.title,
    note: task.intent.body,
    runAtLocal: toScheduledTaskLocalDateTimeValue(scheduledTaskEditableRunAt(task)),
    recurrence: scheduledTaskRecurrenceValue(task),
    cronExpression: task.schedule.kind === 'cron' ? task.schedule.expression : '0 9 * * 1-5',
    deliveryMethod: task.effect.kind === 'notify' ? task.effect.channel : 'agent_run',
    ...(task.effect.kind === 'notify' && task.effect.channel === 'bot'
      ? { deliveryPlatform: task.effect.platform, deliveryChatId: task.effect.chatId }
      : { deliveryPlatform: 'telegram' as BotProvider, deliveryChatId: '' }),
    ...(task.schedule.kind === 'interval' ? { lockedSchedule: task.schedule } : {}),
    ...(task.effect.kind !== 'notify' ? { lockedEffect: task.effect } : {}),
  };
}

/** Edit-mode seed prefilled from an existing task. */
export function scheduledTaskEditSeed(task: ScheduledTask): ScheduledTaskFormSeed {
  return scheduledTaskFormSeedFromTask(task);
}

/** Create-mode seed copying an existing task under a 副本 title. */
export function scheduledTaskDuplicateSeed(task: ScheduledTask, locale: UiLocale): ScheduledTaskFormSeed {
  return {
    ...scheduledTaskFormSeedFromTask(task),
    editingId: null,
    title: duplicateScheduledTaskTitle(task.title, locale),
  };
}
