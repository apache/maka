/**
 * Pure helpers and presentation data for the PlanReminderPanel.
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

import type {
  BotProvider,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  PlanReminderStatus,
  UiLocale,
} from '@maka/core';
import {
  BOT_DELIVERY_PROVIDERS,
  botDisplayLabel,
  uiLocaleToIntlLocale,
} from '@maka/core';
import {
  getPlanReminderCopy,
  type PlanReminderExampleTemplate,
} from './plan-reminder-copy.js';

export type PlanReminderDisplayRow =
  | { kind: 'group'; key: string; label: string; count: number }
  | { kind: 'reminder'; reminder: PlanReminder };

export function toPlanReminderDateTimeInputValue(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function planReminderPresetRunAt(preset: 'ten-minutes' | 'one-hour' | 'tomorrow-morning' | 'next-monday', now: number = Date.now()): number {
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

export function planReminderTemplateNextRunAt(template: PlanReminderExampleTemplate, now: number = Date.now()): number {
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

export function planReminderFormValidationMessage(input: {
  title: string;
  parsedRunAt: number;
  recurrence: PlanReminderRecurrence;
  cronExpression: string;
  delivery: PlanReminderDeliveryTarget;
  now: number;
}, locale: UiLocale): string | null {
  const copy = getPlanReminderCopy(locale).validation;
  if (input.title.trim().length === 0) return copy.title;
  if (!Number.isFinite(input.parsedRunAt)) return copy.timeInvalid;
  if (input.parsedRunAt < input.now) return copy.timePast;
  if (input.recurrence === 'cron' && input.cronExpression.trim().split(/\s+/).length !== 5) {
    return copy.cron;
  }
  if (input.delivery.channel === 'bot' && input.delivery.chatId.length === 0) {
    return copy.chatId;
  }
  return null;
}

export function formatPlanDeliveryProviderList(): string {
  return BOT_DELIVERY_PROVIDERS.map((provider) => botDisplayLabel(provider)).join(' / ');
}

export function comparePlanReminderForDisplay(a: PlanReminder, b: PlanReminder, locale: UiLocale): number {
  const statusDelta = planReminderStatusDisplayRank(a) - planReminderStatusDisplayRank(b);
  if (statusDelta !== 0) return statusDelta;
  if (a.status === 'scheduled' && b.status === 'scheduled') {
    return planReminderNextRunSortValue(a) - planReminderNextRunSortValue(b);
  }
  if (a.status === 'completed' && b.status === 'completed') {
    return planReminderLastRunSortValue(b) - planReminderLastRunSortValue(a);
  }
  return a.title.localeCompare(b.title, uiLocaleToIntlLocale(locale));
}

export function comparePlanReminderBySort(a: PlanReminder, b: PlanReminder, sort: 'created-desc' | 'next-run-asc' | 'updated-desc', locale: UiLocale): number {
  if (sort === 'created-desc') {
    return b.createdAt - a.createdAt || comparePlanReminderForDisplay(a, b, locale);
  }
  if (sort === 'updated-desc') {
    return b.updatedAt - a.updatedAt || comparePlanReminderForDisplay(a, b, locale);
  }
  return comparePlanReminderForDisplay(a, b, locale);
}

function planReminderStatusDisplayRank(reminder: PlanReminder): number {
  if (reminder.status === 'scheduled') return 0;
  if (reminder.status === 'paused') return 1;
  if (reminder.status === 'completed') return 2;
  return 3;
}

function planReminderNextRunSortValue(reminder: PlanReminder): number {
  return typeof reminder.nextRunAt === 'number' ? reminder.nextRunAt : Number.MAX_SAFE_INTEGER;
}

function planReminderLastRunSortValue(reminder: PlanReminder): number {
  return reminder.lastRun?.at ?? 0;
}

export function normalizePlanReminderSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function planReminderMatchesSearch(reminder: PlanReminder, query: string, locale: UiLocale): boolean {
  return planReminderSearchText(reminder, locale).toLocaleLowerCase().includes(query);
}

export function planReminderSearchText(reminder: PlanReminder, locale: UiLocale): string {
  return [
    reminder.title,
    reminder.note,
    reminder.status,
    formatPlanRecurrence(reminder, locale),
    formatPlanReminderDeliveryTargetLabel(reminder.delivery, locale),
    reminder.lastRun?.message,
    ...reminder.runs.map((run) => `${runStatusLabel(run.status, locale)} ${run.message}`),
  ].filter(Boolean).join('\n');
}

// Not exported: this display-list builder currently has no external consumer.
// Demoted (was `export`) to keep it — and its sibling helpers it references —
// out of knip's unused-export report without deleting the cohesive plan-reminder
// display API. Re-export if/when a panel adopts it.
function planReminderDisplayRows(filter: 'all' | PlanReminderStatus, reminders: PlanReminder[], locale: UiLocale): PlanReminderDisplayRow[] {
  if (filter !== 'all') return reminders.map((reminder) => ({ kind: 'reminder', reminder }));
  const rows: PlanReminderDisplayRow[] = [];
  for (const status of ['scheduled', 'paused', 'completed'] satisfies PlanReminderStatus[]) {
    const group = reminders.filter((reminder) => reminder.status === status);
    if (group.length === 0) continue;
    rows.push({ kind: 'group', key: `group-${status}`, label: planReminderStatusGroupLabel(status, locale), count: group.length });
    rows.push(...group.map((reminder) => ({ kind: 'reminder' as const, reminder })));
  }
  return rows;
}

export function planReminderStatusGroupLabel(status: PlanReminderStatus, locale: UiLocale): string {
  return getPlanReminderCopy(locale).status[status];
}

export function planReminderStatusLabel(status: PlanReminderStatus, locale: UiLocale): string {
  return planReminderStatusGroupLabel(status, locale);
}

export function planReminderRunRangeStart(range: 'day' | 'week' | 'month' | 'all', now: number): number | null {
  if (range === 'all') return null;
  const date = new Date(now);
  if (range === 'day') {
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  return now - (range === 'week' ? 7 : 30) * 24 * 60 * 60 * 1000;
}

export function planReminderEditableRunAt(reminder: PlanReminder, now: number = Date.now()): number {
  if (typeof reminder.nextRunAt === 'number' && reminder.nextRunAt > now) return reminder.nextRunAt;
  const scheduledAt = reminder.schedule.kind === 'once' ? reminder.schedule.runAt : reminder.schedule.startAt;
  return scheduledAt > now ? scheduledAt : now + 60 * 60 * 1000;
}

export function planReminderRecurrenceValue(reminder: PlanReminder): PlanReminderRecurrence {
  if (reminder.schedule.kind === 'once') return 'none';
  if (reminder.schedule.kind === 'cron') return 'cron';
  return reminder.schedule.recurrence;
}

export function duplicatePlanReminderTitle(title: string, locale: UiLocale): string {
  const suffix = getPlanReminderCopy(locale).duplicateSuffix;
  if (title.endsWith(suffix)) return title;
  return `${title}${suffix}`.slice(0, 120);
}

export function formatReminderTime(ts: number, locale: UiLocale): string {
  return new Intl.DateTimeFormat(uiLocaleToIntlLocale(locale), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

/**
 * PR-PLAN-NEXT-RUN-COUNTDOWN-0: small chip next to the absolute
 * next-run time so the user sees both "what" and "when from now"
 * in one glance. Past-due reminders read as "已过期"; very near
 * (< 60s) reads "马上"; the rest read in minute / hour / day
 * buckets so screen-reader users get a single self-contained
 * label.
 */
export function formatReminderCountdown(ts: number, locale: UiLocale, now: number = Date.now()): string {
  const copy = getPlanReminderCopy(locale).countdown;
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

export function formatPlanRecurrence(reminder: PlanReminder, locale: UiLocale): string {
  const copy = getPlanReminderCopy(locale).recurrence;
  if (reminder.schedule.kind === 'once') return copy.once;
  if (reminder.schedule.kind === 'cron') return copy.cron(reminder.schedule.expression);
  return copy.recurring[reminder.schedule.recurrence];
}

export function runStatusLabel(status: NonNullable<PlanReminder['lastRun']>['status'], locale: UiLocale): string {
  return getPlanReminderCopy(locale).runStatus[status];
}

export function formatPlanReminderDeliveryTargetLabel(delivery: PlanReminderDeliveryTarget, locale: UiLocale): string {
  const copy = getPlanReminderCopy(locale).delivery;
  if (delivery.channel === 'local') return copy.local;
  return copy.bot(botDisplayLabel(delivery.platform), delivery.chatId);
}

/**
 * Initial field values for the plan-reminder form dialog
 * (PlanReminderFormDialog, issue #1044). The panel builds one seed per open
 * (create / template / edit / duplicate) and the dialog mounts with it, so
 * the seeds are pure mappings — they live here with the other form helpers,
 * not in the component file.
 */
export interface PlanReminderFormSeed {
  editingId: string | null;
  title: string;
  note: string;
  runAtLocal: string;
  recurrence: PlanReminderRecurrence;
  cronExpression: string;
  deliveryChannel: PlanReminderDeliveryTarget['channel'];
  deliveryPlatform: BotProvider;
  deliveryChatId: string;
}

/** Blank create-mode seed (one hour from now, no recurrence, local delivery). */
export function createPlanReminderFormSeed(now: number = Date.now()): PlanReminderFormSeed {
  return {
    editingId: null,
    title: '',
    note: '',
    runAtLocal: toPlanReminderDateTimeInputValue(now + 60 * 60 * 1000),
    recurrence: 'none',
    cronExpression: '0 9 * * 1-5',
    deliveryChannel: 'local',
    deliveryPlatform: 'telegram',
    deliveryChatId: '',
  };
}

/** Create-mode seed prefilled from an example template. */
export function planReminderTemplateSeed(template: PlanReminderExampleTemplate, now: number = Date.now()): PlanReminderFormSeed {
  return {
    ...createPlanReminderFormSeed(now),
    title: template.title,
    note: template.note,
    recurrence: template.recurrence,
    cronExpression: template.cronExpression,
    runAtLocal: toPlanReminderDateTimeInputValue(planReminderTemplateNextRunAt(template, now)),
  };
}

function planReminderReminderSeed(reminder: PlanReminder): PlanReminderFormSeed {
  return {
    editingId: reminder.id,
    title: reminder.title,
    note: reminder.note,
    runAtLocal: toPlanReminderDateTimeInputValue(planReminderEditableRunAt(reminder)),
    recurrence: planReminderRecurrenceValue(reminder),
    cronExpression: reminder.schedule.kind === 'cron' ? reminder.schedule.expression : '0 9 * * 1-5',
    deliveryChannel: reminder.delivery.channel,
    ...(reminder.delivery.channel === 'bot'
      ? { deliveryPlatform: reminder.delivery.platform, deliveryChatId: reminder.delivery.chatId }
      : { deliveryPlatform: 'telegram' as BotProvider, deliveryChatId: '' }),
  };
}

/** Edit-mode seed prefilled from an existing reminder. */
export function planReminderEditSeed(reminder: PlanReminder): PlanReminderFormSeed {
  return planReminderReminderSeed(reminder);
}

/** Create-mode seed copying an existing reminder under a 副本 title. */
export function planReminderDuplicateSeed(reminder: PlanReminder, locale: UiLocale): PlanReminderFormSeed {
  return {
    ...planReminderReminderSeed(reminder),
    editingId: null,
    title: duplicatePlanReminderTitle(reminder.title, locale),
  };
}
