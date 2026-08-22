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
 * ScheduledTask — the single product noun for "定时任务".
 *
 * One catalog, one scheduler authority (the Runtime Host), multiple effects:
 * native delivery, a fresh Agent session, or resuming the creating session.
 */

import { compileCronExpression } from './cron-expression.js';
import { isCollaborationMode, type CollaborationMode } from './collaboration.js';
import { isOrchestrationMode, type OrchestrationMode } from './orchestration.js';
import { isThinkingLevel, type ThinkingLevel } from './model-thinking.js';
import { isPermissionMode, type PermissionMode } from './permission.js';
import { isBotDeliveryProvider, type BotProvider } from './bot-chat-settings.js';

export const SCHEDULED_TASK_TITLE_MAX_CHARS = 120;
export const SCHEDULED_TASK_INTENT_MAX_CHARS = 8_000;
export const SCHEDULED_TASK_CRON_MAX_CHARS = 80;
export const SCHEDULED_TASK_CHAT_ID_MAX_CHARS = 160;
export const SCHEDULED_TASK_SESSION_ID_MAX_CHARS = 160;
export const SCHEDULED_TASK_RUN_HISTORY_LIMIT = 20;
export const SCHEDULED_TASK_RUN_MESSAGE_MAX_CHARS = 1_024;
export const SCHEDULED_TASK_MAX_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
export const SCHEDULED_TASK_MIN_INTERVAL_SECONDS = 10;
export const SCHEDULED_TASK_MAX_INTERVAL_SECONDS = 366 * 86_400;

export const SCHEDULED_TASK_STATUSES = ['active', 'paused', 'completed', 'expired'] as const;
export type ScheduledTaskStatus = (typeof SCHEDULED_TASK_STATUSES)[number];

export const SCHEDULED_TASK_RUN_OUTCOMES = ['ok', 'failed', 'blocked'] as const;
export type ScheduledTaskRunOutcome = (typeof SCHEDULED_TASK_RUN_OUTCOMES)[number];

export type ScheduledTaskCreatedByKind = 'user' | 'agent' | 'system';

export type ScheduledTaskSchedule =
  | { kind: 'once'; runAt: number }
  | { kind: 'interval'; everySeconds: number; startAt: number }
  | {
      kind: 'calendar';
      recurrence: 'daily' | 'weekly' | 'monthly';
      anchorAt: number;
    }
  | { kind: 'cron'; expression: string; startAt: number };

export type ScheduledTaskEffect =
  | { kind: 'notify'; channel: 'local' }
  | { kind: 'notify'; channel: 'bot'; platform: BotProvider; chatId: string }
  | { kind: 'session_resume'; sessionId: string }
  | { kind: 'agent_run'; execution: ScheduledTaskExecutionTemplate };

/** Frozen at create time so later settings changes do not rewrite past jobs. */
export interface ScheduledTaskExecutionTemplate {
  readonly cwd: string;
  readonly projectId?: string | null;
  readonly llmConnectionSlug: string;
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly permissionMode: PermissionMode;
  readonly collaborationMode: CollaborationMode;
  readonly orchestrationMode: OrchestrationMode;
}

export interface ScheduledTaskRun {
  id: string;
  at: number;
  outcome: ScheduledTaskRunOutcome;
  message: string;
  sessionId?: string;
  runId?: string;
}

export interface ScheduledTaskCreatedBy {
  kind: ScheduledTaskCreatedByKind;
  /** Session that created this task when kind is agent. */
  sessionId?: string;
}

export interface ScheduledTask {
  id: string;
  title: string;
  intent: { kind: 'text'; body: string };
  schedule: ScheduledTaskSchedule;
  effect: ScheduledTaskEffect;
  status: ScheduledTaskStatus;
  nextFireAt: number | null;
  lastFireAt: number | null;
  fireCount: number;
  maxFires: number | null;
  expiresAt: number | null;
  createdBy: ScheduledTaskCreatedBy;
  createdAt: number;
  updatedAt: number;
  runs: ScheduledTaskRun[];
  lastError: string | null;
}

export interface CreateScheduledTaskInput {
  title: string;
  intentBody: string;
  schedule: ScheduledTaskSchedule;
  effect: ScheduledTaskEffect;
  createdBy: ScheduledTaskCreatedBy;
  maxFires?: number | null;
  expiresAt?: number | null;
}

export interface UpdateScheduledTaskInput {
  title?: string;
  intentBody?: string;
  schedule?: ScheduledTaskSchedule;
  effect?: ScheduledTaskEffect;
  maxFires?: number | null;
  expiresAt?: number | null;
}

export type ScheduledTaskNormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function isScheduledTaskStatus(value: unknown): value is ScheduledTaskStatus {
  return (
    typeof value === 'string' && (SCHEDULED_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeCreateScheduledTaskInput(
  input: unknown,
  now: number,
): ScheduledTaskNormalizeResult<CreateScheduledTaskInput & { nextFireAt: number }> {
  if (!isObject(input)) return fail('Scheduled task input must be an object');
  const title = normalizeTitle(input.title);
  if (!title.ok) return title;
  const schedule = normalizeSchedule(input.schedule, now);
  if (!schedule.ok) return schedule;
  const effect = normalizeEffect(input.effect);
  if (!effect.ok) return effect;
  const intentBody = normalizeIntent(input.intentBody ?? input.intent?.body, {
    required: effect.value.kind !== 'notify',
  });
  if (!intentBody.ok) return intentBody;
  const createdBy = normalizeCreatedBy(input.createdBy);
  if (!createdBy.ok) return createdBy;
  const maxFires = normalizeMaxFires(input.maxFires);
  if (!maxFires.ok) return maxFires;
  const expiresAt = normalizeExpiresAt(input.expiresAt, now);
  if (!expiresAt.ok) return expiresAt;
  const nextFireAt = computeNextFireAt(schedule.value, now);
  if (nextFireAt === null) {
    return fail('Schedule has no fire within one year from now');
  }
  if (expiresAt.value !== null && nextFireAt >= expiresAt.value) {
    return fail('Schedule must fire before expiresAt');
  }
  return {
    ok: true,
    value: {
      title: title.value,
      intentBody: intentBody.value,
      schedule: schedule.value,
      effect: effect.value,
      createdBy: createdBy.value,
      maxFires: maxFires.value,
      expiresAt: expiresAt.value,
      nextFireAt,
    },
  };
}

export function normalizeUpdateScheduledTaskInput(
  input: unknown,
  now: number,
): ScheduledTaskNormalizeResult<UpdateScheduledTaskInput> {
  if (!isObject(input)) return fail('Scheduled task update must be an object');
  const patch: UpdateScheduledTaskInput = {};
  if (input.title !== undefined) {
    const title = normalizeTitle(input.title);
    if (!title.ok) return title;
    patch.title = title.value;
  }
  if (input.intentBody !== undefined || input.intent !== undefined) {
    const intentBody = normalizeIntent(input.intentBody ?? input.intent?.body, { required: false });
    if (!intentBody.ok) return intentBody;
    patch.intentBody = intentBody.value;
  }
  if (input.schedule !== undefined) {
    const schedule = normalizeSchedule(input.schedule, now);
    if (!schedule.ok) return schedule;
    patch.schedule = schedule.value;
  }
  if (input.effect !== undefined) {
    const effect = normalizeEffect(input.effect);
    if (!effect.ok) return effect;
    patch.effect = effect.value;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'maxFires')) {
    const maxFires = normalizeMaxFires(input.maxFires);
    if (!maxFires.ok) return maxFires;
    patch.maxFires = maxFires.value;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'expiresAt')) {
    const expiresAt = normalizeExpiresAt(input.expiresAt, now);
    if (!expiresAt.ok) return expiresAt;
    patch.expiresAt = expiresAt.value;
  }
  return { ok: true, value: patch };
}

export function computeNextFireAt(schedule: ScheduledTaskSchedule, after: number): number | null {
  if (schedule.kind === 'once') {
    return schedule.runAt > after ? schedule.runAt : null;
  }
  if (schedule.kind === 'interval') {
    if (schedule.everySeconds < SCHEDULED_TASK_MIN_INTERVAL_SECONDS) return null;
    if (schedule.startAt > after) {
      return schedule.startAt - after <= SCHEDULED_TASK_MAX_DELAY_MS ? schedule.startAt : null;
    }
    const stepMs = schedule.everySeconds * 1000;
    const steps = Math.floor((after - schedule.startAt) / stepMs) + 1;
    const next = schedule.startAt + steps * stepMs;
    return next - after > SCHEDULED_TASK_MAX_DELAY_MS ? null : next;
  }
  if (schedule.kind === 'calendar') {
    if (schedule.anchorAt > after) {
      return schedule.anchorAt - after <= SCHEDULED_TASK_MAX_DELAY_MS ? schedule.anchorAt : null;
    }
    const next = nextCalendarFireAt(schedule, after);
    return next - after <= SCHEDULED_TASK_MAX_DELAY_MS ? next : null;
  }
  const compiled = compileCronExpression(schedule.expression);
  if (!compiled.ok) return null;
  return (
    compiled.value.nextAfter(after, {
      notBefore: schedule.startAt,
      notAfter: after + SCHEDULED_TASK_MAX_DELAY_MS,
    }) ?? null
  );
}

export function isScheduledTaskDue(task: ScheduledTask, now: number): boolean {
  return (
    task.status === 'active' &&
    typeof task.nextFireAt === 'number' &&
    task.nextFireAt <= now &&
    (task.expiresAt === null || now < task.expiresAt)
  );
}

export function appendScheduledTaskRun(
  runs: readonly ScheduledTaskRun[] | undefined,
  run: ScheduledTaskRun,
): ScheduledTaskRun[] {
  return [run, ...(runs ?? [])].slice(0, SCHEDULED_TASK_RUN_HISTORY_LIMIT);
}

/**
 * Advance lifecycle after a fire attempt. `after` is the fire timestamp.
 * Terminal when once/maxFires/expires; otherwise stays active with nextFireAt.
 */
export function nextScheduledTaskStateAfterFire(
  task: ScheduledTask,
  run: ScheduledTaskRun,
): ScheduledTask {
  const runs = appendScheduledTaskRun(task.runs, run);
  const fireCount = task.fireCount + 1;
  const updatedAt = run.at;
  const base = {
    ...task,
    lastFireAt: run.at,
    fireCount,
    lastError: run.outcome === 'ok' ? null : run.message,
    runs,
    updatedAt,
  };

  if (task.schedule.kind === 'once') {
    return { ...base, status: 'completed', nextFireAt: null };
  }
  if (task.maxFires !== null && fireCount >= task.maxFires) {
    return { ...base, status: 'completed', nextFireAt: null };
  }
  if (task.expiresAt !== null && run.at >= task.expiresAt) {
    return { ...base, status: 'expired', nextFireAt: null };
  }
  const nextFireAt = computeNextFireAt(task.schedule, run.at);
  if (nextFireAt === null) {
    return { ...base, status: 'completed', nextFireAt: null };
  }
  if (task.expiresAt !== null && nextFireAt >= task.expiresAt) {
    return { ...base, status: 'expired', nextFireAt: null };
  }
  return { ...base, status: 'active', nextFireAt };
}

export function pauseScheduledTask(task: ScheduledTask, now: number): ScheduledTask {
  if (task.status !== 'active') return task;
  return {
    ...task,
    status: 'paused',
    nextFireAt: null,
    updatedAt: now,
  };
}

export function resumeScheduledTask(
  task: ScheduledTask,
  now: number,
): ScheduledTask | { error: string } {
  if (task.status !== 'paused') return { error: 'Only paused tasks can be resumed' };
  if (task.maxFires !== null && task.fireCount >= task.maxFires) {
    return { error: 'Scheduled task fire budget is exhausted' };
  }
  if (task.schedule.kind === 'once' && task.fireCount > 0) {
    return { error: 'One-shot scheduled task has already fired' };
  }
  if (task.expiresAt !== null && now >= task.expiresAt) {
    return {
      ...task,
      status: 'expired',
      nextFireAt: null,
      updatedAt: now,
    };
  }
  const nextFireAt = computeNextFireAt(task.schedule, now);
  if (nextFireAt === null) {
    return { error: 'Schedule has no remaining fire' };
  }
  return {
    ...task,
    status: 'active',
    nextFireAt,
    updatedAt: now,
  };
}

export function compareScheduledTasksForList(a: ScheduledTask, b: ScheduledTask): number {
  const rank = (status: ScheduledTaskStatus) =>
    status === 'active' ? 0 : status === 'paused' ? 1 : 2;
  const statusDelta = rank(a.status) - rank(b.status);
  if (statusDelta !== 0) return statusDelta;
  if (a.status === 'active' || a.status === 'paused') {
    const aTime = a.nextFireAt ?? Number.POSITIVE_INFINITY;
    const bTime = b.nextFireAt ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
  } else {
    const aTime = a.lastFireAt ?? a.updatedAt;
    const bTime = b.lastFireAt ?? b.updatedAt;
    if (aTime !== bTime) return bTime - aTime;
  }
  return a.id.localeCompare(b.id);
}

function normalizeTitle(value: unknown): ScheduledTaskNormalizeResult<string> {
  if (typeof value !== 'string') return fail('Title is required');
  const title = value.trim();
  if (!title) return fail('Title is required');
  if ([...title].length > SCHEDULED_TASK_TITLE_MAX_CHARS) {
    return fail(`Title must be ${SCHEDULED_TASK_TITLE_MAX_CHARS} characters or fewer`);
  }
  return { ok: true, value: title };
}

function normalizeIntent(
  value: unknown,
  options: { required: boolean },
): ScheduledTaskNormalizeResult<string> {
  if (value === undefined || value === null) {
    return options.required ? fail('Intent body is required') : { ok: true, value: '' };
  }
  if (typeof value !== 'string') return fail('Intent body must be a string');
  const body = value.trim();
  if (!body && options.required) return fail('Intent body is required');
  if ([...body].length > SCHEDULED_TASK_INTENT_MAX_CHARS) {
    return fail(`Intent body must be ${SCHEDULED_TASK_INTENT_MAX_CHARS} characters or fewer`);
  }
  return { ok: true, value: body };
}

function normalizeSchedule(
  value: unknown,
  now: number,
): ScheduledTaskNormalizeResult<ScheduledTaskSchedule> {
  if (!isObject(value) || typeof value.kind !== 'string') {
    return fail('Schedule is required');
  }
  if (value.kind === 'once') {
    const runAt = asFiniteNumber(value.runAt);
    if (runAt === null) return fail('once schedule requires runAt');
    if (runAt <= now) return fail('once runAt must be in the future');
    if (runAt - now > SCHEDULED_TASK_MAX_DELAY_MS) {
      return fail('once runAt must be within one year');
    }
    return { ok: true, value: { kind: 'once', runAt } };
  }
  if (value.kind === 'interval') {
    const everySeconds = asFiniteNumber(value.everySeconds);
    const startAt = value.startAt === undefined ? now : asFiniteNumber(value.startAt);
    if (everySeconds === null || !Number.isInteger(everySeconds)) {
      return fail('interval schedule requires integer everySeconds');
    }
    if (startAt === null) return fail('interval schedule startAt must be a number');
    if (
      everySeconds < SCHEDULED_TASK_MIN_INTERVAL_SECONDS ||
      everySeconds > SCHEDULED_TASK_MAX_INTERVAL_SECONDS
    ) {
      return fail(
        `interval everySeconds must be between ${SCHEDULED_TASK_MIN_INTERVAL_SECONDS} and ${SCHEDULED_TASK_MAX_INTERVAL_SECONDS}`,
      );
    }
    return {
      ok: true,
      value: { kind: 'interval', everySeconds, startAt },
    };
  }
  if (value.kind === 'calendar') {
    if (
      value.recurrence !== 'daily' &&
      value.recurrence !== 'weekly' &&
      value.recurrence !== 'monthly'
    ) {
      return fail('calendar recurrence must be daily, weekly, or monthly');
    }
    const anchorAt = asFiniteNumber(value.anchorAt);
    if (anchorAt === null) return fail('calendar schedule requires anchorAt');
    return {
      ok: true,
      value: { kind: 'calendar', recurrence: value.recurrence, anchorAt },
    };
  }
  if (value.kind === 'cron') {
    if (typeof value.expression !== 'string') return fail('cron schedule requires expression');
    const expression = value.expression;
    if (!expression) return fail('cron expression is empty');
    if ([...expression].length > SCHEDULED_TASK_CRON_MAX_CHARS) {
      return fail(`cron expression must be ${SCHEDULED_TASK_CRON_MAX_CHARS} characters or fewer`);
    }
    const compiled = compileCronExpression(expression);
    if (!compiled.ok) return fail(`Invalid cron expression: ${compiled.error.code}`);
    const startAt = value.startAt === undefined ? now : asFiniteNumber(value.startAt);
    if (startAt === null) return fail('cron schedule startAt must be a number');
    return { ok: true, value: { kind: 'cron', expression, startAt } };
  }
  return fail('Unknown schedule kind');
}

function normalizeEffect(value: unknown): ScheduledTaskNormalizeResult<ScheduledTaskEffect> {
  if (!isObject(value) || typeof value.kind !== 'string') return fail('Effect is required');
  if (value.kind === 'notify') {
    if (value.channel === 'local') return { ok: true, value: { kind: 'notify', channel: 'local' } };
    if (value.channel === 'bot') {
      if (typeof value.platform !== 'string' || !isBotDeliveryProvider(value.platform)) {
        return fail('bot notify requires a deliverable platform');
      }
      if (typeof value.chatId !== 'string' || !value.chatId.trim()) {
        return fail('bot notify requires chatId');
      }
      const chatId = value.chatId.trim();
      if ([...chatId].length > SCHEDULED_TASK_CHAT_ID_MAX_CHARS) {
        return fail(`chatId must be ${SCHEDULED_TASK_CHAT_ID_MAX_CHARS} characters or fewer`);
      }
      return {
        ok: true,
        value: { kind: 'notify', channel: 'bot', platform: value.platform, chatId },
      };
    }
    return fail('notify channel must be local or bot');
  }
  if (value.kind === 'agent_run') {
    const execution = normalizeExecution(value.execution);
    if (!execution.ok) return execution;
    return { ok: true, value: { kind: 'agent_run', execution: execution.value } };
  }
  if (value.kind === 'session_resume') {
    if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) {
      return fail('session_resume requires sessionId');
    }
    const sessionId = value.sessionId.trim();
    if ([...sessionId].length > SCHEDULED_TASK_SESSION_ID_MAX_CHARS) {
      return fail(`sessionId must be ${SCHEDULED_TASK_SESSION_ID_MAX_CHARS} characters or fewer`);
    }
    return { ok: true, value: { kind: 'session_resume', sessionId } };
  }
  return fail('Unknown effect kind');
}

function normalizeExecution(
  value: unknown,
): ScheduledTaskNormalizeResult<ScheduledTaskExecutionTemplate> {
  if (!isObject(value)) return fail('agent_run requires execution template');
  if (typeof value.cwd !== 'string' || !value.cwd.trim()) return fail('execution.cwd is required');
  if (typeof value.llmConnectionSlug !== 'string' || !value.llmConnectionSlug.trim()) {
    return fail('execution.llmConnectionSlug is required');
  }
  if (typeof value.model !== 'string' || !value.model.trim()) {
    return fail('execution.model is required');
  }
  if (!isPermissionMode(value.permissionMode)) {
    return fail('execution.permissionMode is required');
  }
  if (!isCollaborationMode(value.collaborationMode)) {
    return fail('execution.collaborationMode is required');
  }
  if (!isOrchestrationMode(value.orchestrationMode)) {
    return fail('execution.orchestrationMode is required');
  }
  if (value.thinkingLevel !== undefined && !isThinkingLevel(value.thinkingLevel)) {
    return fail('execution.thinkingLevel is invalid');
  }
  if (
    value.projectId !== undefined &&
    value.projectId !== null &&
    (typeof value.projectId !== 'string' || !value.projectId.trim())
  ) {
    return fail('execution.projectId is invalid');
  }
  const projectId = typeof value.projectId === 'string' ? value.projectId.trim() : value.projectId;
  return {
    ok: true,
    value: {
      cwd: value.cwd.trim(),
      ...(projectId === undefined ? {} : { projectId }),
      llmConnectionSlug: value.llmConnectionSlug.trim(),
      model: value.model.trim(),
      ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }),
      permissionMode: value.permissionMode,
      collaborationMode: value.collaborationMode,
      orchestrationMode: value.orchestrationMode,
    },
  };
}

function normalizeCreatedBy(value: unknown): ScheduledTaskNormalizeResult<ScheduledTaskCreatedBy> {
  if (!isObject(value) || typeof value.kind !== 'string') {
    return fail('createdBy is required');
  }
  if (value.kind !== 'user' && value.kind !== 'agent' && value.kind !== 'system') {
    return fail('createdBy.kind must be user, agent, or system');
  }
  if (value.kind === 'agent') {
    if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) {
      return fail('agent createdBy requires sessionId');
    }
    return { ok: true, value: { kind: 'agent', sessionId: value.sessionId.trim() } };
  }
  return {
    ok: true,
    value: {
      kind: value.kind,
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    },
  };
}

function normalizeMaxFires(value: unknown): ScheduledTaskNormalizeResult<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const n = asFiniteNumber(value);
  if (n === null || n < 1 || n > 10_000 || !Number.isInteger(n)) {
    return fail('maxFires must be an integer from 1 to 10000');
  }
  return { ok: true, value: n };
}

function normalizeExpiresAt(
  value: unknown,
  now: number,
): ScheduledTaskNormalizeResult<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const n = asFiniteNumber(value);
  if (n === null || n <= now) return fail('expiresAt must be in the future');
  return { ok: true, value: n };
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function nextCalendarFireAt(
  schedule: Extract<ScheduledTaskSchedule, { kind: 'calendar' }>,
  after: number,
): number {
  const anchor = new Date(schedule.anchorAt);
  if (schedule.recurrence === 'daily') {
    const next = new Date(after);
    next.setHours(
      anchor.getHours(),
      anchor.getMinutes(),
      anchor.getSeconds(),
      anchor.getMilliseconds(),
    );
    if (next.getTime() <= after) next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (schedule.recurrence === 'weekly') {
    const next = new Date(after);
    next.setHours(
      anchor.getHours(),
      anchor.getMinutes(),
      anchor.getSeconds(),
      anchor.getMilliseconds(),
    );
    const dayDelta = (anchor.getDay() - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + dayDelta);
    if (next.getTime() <= after) next.setDate(next.getDate() + 7);
    return next.getTime();
  }
  const afterDate = new Date(after);
  for (let offset = 0; offset <= 480; offset += 1) {
    const candidate = addMonthsClamped(anchor, afterDate, offset);
    if (candidate > after) return candidate;
  }
  return addMonthsClamped(anchor, afterDate, 481);
}

function addMonthsClamped(anchor: Date, base: Date, offset: number): number {
  const targetMonth = base.getMonth() + offset;
  const year = base.getFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(
    year,
    month,
    Math.min(anchor.getDate(), lastDay),
    anchor.getHours(),
    anchor.getMinutes(),
    anchor.getSeconds(),
    anchor.getMilliseconds(),
  ).getTime();
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}
