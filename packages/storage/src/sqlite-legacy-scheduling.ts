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

import { isBotDeliveryProvider } from '@maka/core/bot-chat-settings';
import type {
  ScheduledTask,
  ScheduledTaskEffect,
  ScheduledTaskRun,
  ScheduledTaskSchedule,
} from '@maka/core/scheduled-task';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalizeLegacyPlanReminderCronExpression } from './legacy-cron-expression.js';

const LEGACY_AUTOMATION_TABLES = [
  'automation_authority_state',
  'automation_definitions',
  'automation_pending_fires',
] as const;
const LAST_RELEASED_PLAN_REMINDER_WORKFLOW_VERSION = 5;
const SCHEDULED_TASK_CATALOG_MAX_ITEMS = 256;

export function assertLegacySchedulingSchema(
  database: DatabaseSync,
  versions: ReadonlyMap<string, number>,
): void {
  const automationVersion = versions.get('automation');
  const automationTables = LEGACY_AUTOMATION_TABLES.filter((table) => hasTable(database, table));
  if (automationTables.length > 0 && automationVersion === undefined) {
    throw new Error('Legacy Automation schema registry is missing');
  }
  if (
    automationVersion !== undefined &&
    ((automationVersion !== 1 && automationVersion !== 2) ||
      automationTables.length !== LEGACY_AUTOMATION_TABLES.length)
  ) {
    throw new Error('Legacy Automation schema is incomplete');
  }
  const workflowVersion = versions.get('workflow');
  if (
    workflowVersion !== undefined &&
    workflowVersion <= LAST_RELEASED_PLAN_REMINDER_WORKFLOW_VERSION &&
    !hasTable(database, 'workflow_plan_reminders')
  ) {
    throw new Error('The released Workflow schema is missing workflow_plan_reminders');
  }
  if (
    workflowVersion !== undefined &&
    workflowVersion > LAST_RELEASED_PLAN_REMINDER_WORKFLOW_VERSION &&
    hasTable(database, 'workflow_plan_reminders')
  ) {
    throw new Error('The current Workflow schema still contains released Plan Reminder state');
  }
}

export function planLegacyScheduledTasks(
  database: DatabaseSync,
  versions: ReadonlyMap<string, number>,
): ScheduledTask[] {
  const tasks = readLegacyPlanReminders(database);
  if (versions.get('automation') === 1) assertLegacyAutomationEmpty(database);
  if (tasks.length > SCHEDULED_TASK_CATALOG_MAX_ITEMS) {
    throw new Error(
      `Released scheduling catalog has ${tasks.length} records, exceeding the supported ${SCHEDULED_TASK_CATALOG_MAX_ITEMS}; reopen this workspace with the previous Maka release and reduce the catalog before upgrading`,
    );
  }
  return tasks;
}

export function insertMigratedScheduledTasks(
  database: DatabaseSync,
  tasks: readonly ScheduledTask[],
): void {
  const insert = database.prepare(`
    INSERT INTO workflow_scheduled_tasks(task_id, created_at, updated_at, record_json)
    VALUES (?, ?, ?, ?)
  `);
  for (const task of tasks) {
    insert.run(task.id, task.createdAt, task.updatedAt, JSON.stringify(task));
  }
}

function assertLegacyAutomationEmpty(database: DatabaseSync): void {
  if (!hasColumn(database, 'automation_definitions', 'durable')) {
    throw new Error('The released Automation schema is missing durable');
  }
  const definition = database
    .prepare('SELECT automation_id FROM automation_definitions LIMIT 1')
    .get() as { automation_id?: unknown } | undefined;
  if (definition) {
    throw new Error(
      `Released Automation ${String(definition.automation_id)} cannot be migrated without losing its configuration; reopen this workspace with the previous Maka release and remove or export Automation before upgrading`,
    );
  }
  if (database.prepare('SELECT 1 FROM automation_pending_fires LIMIT 1').get()) {
    throw new Error('Released Automation has an in-flight fire');
  }
}

function readLegacyPlanReminders(database: DatabaseSync): ScheduledTask[] {
  if (!hasTable(database, 'workflow_plan_reminders')) {
    return [];
  }
  return database
    .prepare(`
      SELECT reminder_id, created_at, updated_at, record_json
      FROM workflow_plan_reminders
      ORDER BY created_at, reminder_id
    `)
    .all()
    .map(decodeLegacyReminder);
}

function decodeLegacyReminder(value: unknown): ScheduledTask {
  const row = record(value, 'legacy Plan Reminder row');
  const source = jsonRecord(row.record_json, 'legacy Plan Reminder');
  const id = text(source.id, 'legacy Plan Reminder id');
  const createdAt = integer(source.createdAt, 'legacy Plan Reminder createdAt');
  const updatedAt = integer(source.updatedAt, 'legacy Plan Reminder updatedAt');
  if (row.reminder_id !== id || row.created_at !== createdAt || row.updated_at !== updatedAt) {
    throw new Error(`Legacy Plan Reminder indexes contradict record JSON: ${id}`);
  }
  const releasedStatus = enumValue(source.status, ['scheduled', 'paused', 'completed'] as const);
  const enabled = boolean(source.enabled, 'legacy Plan Reminder enabled');
  const runs =
    source.runs === undefined
      ? []
      : array(source.runs, 'legacy Plan Reminder runs').map(decodeLegacyRun);
  const lastRun = source.lastRun === undefined ? runs[0] : decodeLegacyRun(source.lastRun);
  if (runs[0] && lastRun && !sameRun(runs[0], lastRun)) {
    throw new Error(`Legacy Plan Reminder lastRun contradicts runs: ${id}`);
  }
  if (runs.length === 0 && lastRun) runs.push(lastRun);
  return {
    id,
    title: text(source.title, 'legacy Plan Reminder title'),
    intent: { kind: 'text', body: text(source.note, 'legacy Plan Reminder note') },
    schedule: legacyReminderSchedule(source.schedule),
    effect: legacyReminderEffect(source.delivery),
    status:
      releasedStatus === 'scheduled' && enabled
        ? 'active'
        : releasedStatus === 'completed'
          ? 'completed'
          : 'paused',
    nextFireAt:
      releasedStatus === 'scheduled' && enabled
        ? nullableInteger(source.nextRunAt, 'nextRunAt')
        : null,
    lastFireAt: lastRun?.at ?? null,
    fireCount: integer(source.runCount, 'legacy Plan Reminder runCount'),
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt,
    updatedAt,
    runs,
    lastError: lastRun && lastRun.outcome !== 'ok' ? lastRun.message : null,
  };
}

function sameRun(left: ScheduledTaskRun, right: ScheduledTaskRun): boolean {
  return (
    left.id === right.id &&
    left.at === right.at &&
    left.outcome === right.outcome &&
    left.message === right.message
  );
}

function legacyReminderSchedule(value: unknown): ScheduledTaskSchedule {
  const source = record(value, 'legacy Plan Reminder schedule');
  if (source.kind === 'once') {
    return { kind: 'once', runAt: integer(source.runAt, 'legacy Plan Reminder runAt') };
  }
  if (source.kind === 'recurring') {
    const recurrence = enumValue(source.recurrence, ['daily', 'weekly', 'monthly'] as const);
    const startAt = integer(source.startAt, 'legacy Plan Reminder startAt');
    return recurrence === 'monthly'
      ? { kind: 'calendar', recurrence, anchorAt: startAt }
      : { kind: 'interval', everySeconds: recurrence === 'daily' ? 86_400 : 604_800, startAt };
  }
  if (source.kind === 'cron') {
    return {
      kind: 'cron',
      expression: canonicalizeLegacyPlanReminderCronExpression(
        text(source.expression, 'legacy Plan Reminder cron expression'),
      ),
      startAt: integer(source.startAt, 'legacy Plan Reminder startAt'),
    };
  }
  throw new Error('Invalid legacy Plan Reminder schedule');
}

function legacyReminderEffect(value: unknown): ScheduledTaskEffect {
  if (value === undefined || value === null) return { kind: 'notify', channel: 'local' };
  const source = record(value, 'legacy Plan Reminder delivery');
  if (source.channel === 'local') return { kind: 'notify', channel: 'local' };
  if (source.channel === 'bot' && isBotDeliveryProvider(source.platform)) {
    return {
      kind: 'notify',
      channel: 'bot',
      platform: source.platform,
      chatId: text(source.chatId, 'legacy Plan Reminder chat id'),
    };
  }
  throw new Error('Invalid legacy Plan Reminder delivery');
}

function decodeLegacyRun(value: unknown): ScheduledTaskRun {
  const source = record(value, 'legacy Plan Reminder run');
  if (source.blockReason !== undefined) {
    throw new Error('Legacy Plan Reminder block reason cannot be preserved');
  }
  return {
    id: text(source.id, 'legacy Plan Reminder run id'),
    at: integer(source.at, 'legacy Plan Reminder run at'),
    outcome:
      source.status === 'triggered'
        ? 'ok'
        : enumValue(source.status, ['blocked', 'failed'] as const),
    message: text(source.message, 'legacy Plan Reminder run message'),
  };
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') throw new Error(`Invalid ${label} record JSON`);
  try {
    return record(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid ${label} record JSON`);
    throw error;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new Error('Invalid enum value');
  return value as T[number];
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (
    database.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !==
    undefined
  );
}
