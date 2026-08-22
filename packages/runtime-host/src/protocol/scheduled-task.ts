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
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { isPermissionMode } from '@maka/core/permission';
import {
  isScheduledTaskStatus,
  SCHEDULED_TASK_CHAT_ID_MAX_CHARS,
  SCHEDULED_TASK_CRON_MAX_CHARS,
  SCHEDULED_TASK_INTENT_MAX_CHARS,
  SCHEDULED_TASK_MAX_DELAY_MS,
  SCHEDULED_TASK_MAX_INTERVAL_SECONDS,
  SCHEDULED_TASK_MIN_INTERVAL_SECONDS,
  SCHEDULED_TASK_RUN_HISTORY_LIMIT,
  SCHEDULED_TASK_RUN_MESSAGE_MAX_CHARS,
  SCHEDULED_TASK_SESSION_ID_MAX_CHARS,
  SCHEDULED_TASK_TITLE_MAX_CHARS,
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskCreatedBy,
  type ScheduledTaskEffect,
  type ScheduledTaskExecutionTemplate,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type UpdateScheduledTaskInput,
} from '@maka/core/scheduled-task';
import { isThinkingLevel } from '@maka/core/model-thinking';
import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireShapedRecord,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';

export const SCHEDULED_TASK_PAGE_MAX_ITEMS = 64;
export const SCHEDULED_TASK_CATALOG_MAX_ITEMS = 256;
export const SCHEDULED_TASK_RESULT_MAX_BYTES = 88 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;
const MUTATION_ERRORS = [...QUERY_ERRORS, 'not_found', 'operation_conflict'] as const;

export type ScheduledTaskQueryInput =
  | {
      readonly kind: 'list';
      readonly cursor?: string;
      readonly expectedRevision?: number;
    }
  | { readonly kind: 'get'; readonly taskId: string };

export type ScheduledTaskQueryResult =
  | {
      readonly kind: 'page';
      readonly revision: number;
      readonly tasks: readonly ScheduledTask[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly kind: 'task'; readonly task: ScheduledTask | null };

export type ScheduledTaskMutateInput =
  | {
      readonly kind: 'create';
      readonly input: Omit<CreateScheduledTaskInput, 'createdBy'>;
    }
  | { readonly kind: 'update'; readonly taskId: string; readonly patch: UpdateScheduledTaskInput }
  | {
      readonly kind: 'pause' | 'resume' | 'clear_history' | 'trigger_now' | 'delete';
      readonly taskId: string;
    }
  | { readonly kind: 'snooze'; readonly taskId: string; readonly delayMs: number };

export type ScheduledTaskMutateResult =
  | { readonly kind: 'task'; readonly task: ScheduledTask }
  | { readonly kind: 'deleted'; readonly taskId: string };

export const SCHEDULED_TASK_OPERATION_SPECS = {
  'scheduled-task.query': defineOperation<
    ScheduledTaskQueryInput,
    ScheduledTaskQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeScheduledTaskQueryInput,
    decodeOutput: decodeScheduledTaskQueryResult,
  }),
  'scheduled-task.mutate': defineHostPathOperation<
    ScheduledTaskMutateInput,
    ScheduledTaskMutateResult,
    (typeof MUTATION_ERRORS)[number]
  >(
    {
      mode: 'command',
      availability: 'ready',
      errors: MUTATION_ERRORS,
      decodeInput: decodeScheduledTaskMutateInput,
      decodeOutput: decodeScheduledTaskMutateResult,
    },
    scheduledTaskMutationUsesHostPath,
  ),
} as const;

function scheduledTaskMutationUsesHostPath(input: ScheduledTaskMutateInput): boolean {
  const effect =
    input.kind === 'create'
      ? input.input.effect
      : input.kind === 'update'
        ? input.patch.effect
        : undefined;
  return (
    effect?.kind === 'agent_run' &&
    (effect.execution.projectId == null || effect.execution.projectId === '')
  );
}

export function decodeScheduledTaskQueryInput(value: unknown): ScheduledTaskQueryInput {
  const record = requireRecord(value, 'ScheduledTask query input');
  if (record.kind === 'list') {
    const input = requireShapedRecord(
      record,
      'ScheduledTask list input',
      ['kind'],
      ['cursor', 'expectedRevision'],
    );
    const hasCursor = Object.hasOwn(input, 'cursor');
    const hasRevision = Object.hasOwn(input, 'expectedRevision');
    if (hasCursor !== hasRevision) {
      throw invalidProtocolFrame('ScheduledTask continuation requires cursor and revision');
    }
    return {
      kind: 'list',
      ...(hasCursor
        ? {
            cursor: decodeCursor(input.cursor),
            expectedRevision: requireCount(
              input.expectedRevision,
              'ScheduledTask expected revision',
            ),
          }
        : {}),
    };
  }
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'ScheduledTask get input', ['kind', 'taskId']);
    return { kind: 'get', taskId: requireEntityId(input.taskId, 'ScheduledTask id') };
  }
  throw invalidProtocolFrame('Invalid ScheduledTask query kind');
}

export function decodeScheduledTaskQueryResult(value: unknown): ScheduledTaskQueryResult {
  const record = requireRecord(value, 'ScheduledTask query result');
  if (record.kind === 'revision_changed') {
    const result = requireExactRecord(record, 'ScheduledTask revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: requireCount(result.expected, 'ScheduledTask expected revision'),
      actual: requireCount(result.actual, 'ScheduledTask actual revision'),
    };
  }
  if (record.kind === 'task') {
    const result = requireExactRecord(record, 'ScheduledTask get result', ['kind', 'task']);
    const decoded: ScheduledTaskQueryResult = {
      kind: 'task',
      task: result.task === null ? null : decodeScheduledTask(result.task),
    };
    requireEncodedByteLimit(decoded, 'ScheduledTask get result', SCHEDULED_TASK_RESULT_MAX_BYTES);
    return decoded;
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid ScheduledTask query result kind');
  const result = requireExactRecord(record, 'ScheduledTask page result', [
    'kind',
    'revision',
    'tasks',
    'nextCursor',
  ]);
  if (!Array.isArray(result.tasks) || result.tasks.length > SCHEDULED_TASK_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('ScheduledTask page exceeds item limit');
  }
  const decoded: ScheduledTaskQueryResult = {
    kind: 'page',
    revision: requireCount(result.revision, 'ScheduledTask revision'),
    tasks: result.tasks.map(decodeScheduledTask),
    nextCursor: result.nextCursor === null ? null : decodeCursor(result.nextCursor),
  };
  requireEncodedByteLimit(decoded, 'ScheduledTask page result', SCHEDULED_TASK_RESULT_MAX_BYTES);
  return decoded;
}

export function decodeScheduledTaskMutateInput(value: unknown): ScheduledTaskMutateInput {
  const record = requireRecord(value, 'ScheduledTask mutation input');
  if (record.kind === 'create') {
    const input = requireExactRecord(record, 'ScheduledTask create input', ['kind', 'input']);
    return { kind: 'create', input: decodeCreateInput(input.input) };
  }
  if (record.kind === 'update') {
    const input = requireExactRecord(record, 'ScheduledTask update input', [
      'kind',
      'taskId',
      'patch',
    ]);
    return {
      kind: 'update',
      taskId: requireEntityId(input.taskId, 'ScheduledTask id'),
      patch: decodeUpdateInput(input.patch),
    };
  }
  if (
    record.kind === 'pause' ||
    record.kind === 'resume' ||
    record.kind === 'clear_history' ||
    record.kind === 'trigger_now' ||
    record.kind === 'delete'
  ) {
    const input = requireExactRecord(record, 'ScheduledTask mutation input', ['kind', 'taskId']);
    return { kind: record.kind, taskId: requireEntityId(input.taskId, 'ScheduledTask id') };
  }
  if (record.kind === 'snooze') {
    const input = requireExactRecord(record, 'ScheduledTask snooze input', [
      'kind',
      'taskId',
      'delayMs',
    ]);
    const delayMs = requireCount(input.delayMs, 'ScheduledTask snooze delay');
    if (delayMs === 0 || delayMs > SCHEDULED_TASK_MAX_DELAY_MS) {
      throw invalidProtocolFrame('Invalid ScheduledTask snooze delay');
    }
    return {
      kind: 'snooze',
      taskId: requireEntityId(input.taskId, 'ScheduledTask id'),
      delayMs,
    };
  }
  throw invalidProtocolFrame('Invalid ScheduledTask mutation kind');
}

export function decodeScheduledTaskMutateResult(value: unknown): ScheduledTaskMutateResult {
  const record = requireRecord(value, 'ScheduledTask mutation result');
  if (record.kind === 'deleted') {
    const result = requireExactRecord(record, 'ScheduledTask deleted result', ['kind', 'taskId']);
    return { kind: 'deleted', taskId: requireEntityId(result.taskId, 'ScheduledTask id') };
  }
  if (record.kind !== 'task') throw invalidProtocolFrame('Invalid ScheduledTask mutation result');
  const result = requireExactRecord(record, 'ScheduledTask committed result', ['kind', 'task']);
  const decoded = { kind: 'task' as const, task: decodeScheduledTask(result.task) };
  requireEncodedByteLimit(
    decoded,
    'ScheduledTask mutation result',
    SCHEDULED_TASK_RESULT_MAX_BYTES,
  );
  return decoded;
}

export function decodeScheduledTask(value: unknown): ScheduledTask {
  const task = requireExactRecord(value, 'ScheduledTask', [
    'id',
    'title',
    'intent',
    'schedule',
    'effect',
    'status',
    'nextFireAt',
    'lastFireAt',
    'fireCount',
    'maxFires',
    'expiresAt',
    'createdBy',
    'createdAt',
    'updatedAt',
    'runs',
    'lastError',
  ]);
  const intent = requireExactRecord(task.intent, 'ScheduledTask intent', ['kind', 'body']);
  if (intent.kind !== 'text') throw invalidProtocolFrame('Invalid ScheduledTask intent');
  if (!isScheduledTaskStatus(task.status))
    throw invalidProtocolFrame('Invalid ScheduledTask status');
  if (!Array.isArray(task.runs) || task.runs.length > SCHEDULED_TASK_RUN_HISTORY_LIMIT) {
    throw invalidProtocolFrame('Invalid ScheduledTask run history');
  }
  return {
    id: requireEntityId(task.id, 'ScheduledTask id'),
    title: boundedText(task.title, 'ScheduledTask title', SCHEDULED_TASK_TITLE_MAX_CHARS, true),
    intent: {
      kind: 'text',
      body: boundedText(intent.body, 'ScheduledTask intent body', SCHEDULED_TASK_INTENT_MAX_CHARS),
    },
    schedule: decodeSchedule(task.schedule),
    effect: decodeEffect(task.effect),
    status: task.status,
    nextFireAt: nullableCount(task.nextFireAt, 'ScheduledTask nextFireAt'),
    lastFireAt: nullableCount(task.lastFireAt, 'ScheduledTask lastFireAt'),
    fireCount: requireCount(task.fireCount, 'ScheduledTask fireCount'),
    maxFires: nullablePositiveCount(task.maxFires, 'ScheduledTask maxFires'),
    expiresAt: nullableCount(task.expiresAt, 'ScheduledTask expiresAt'),
    createdBy: decodeCreatedBy(task.createdBy),
    createdAt: requireCount(task.createdAt, 'ScheduledTask createdAt'),
    updatedAt: requireCount(task.updatedAt, 'ScheduledTask updatedAt'),
    runs: task.runs.map(decodeRun),
    lastError:
      task.lastError === null
        ? null
        : boundedText(
            task.lastError,
            'ScheduledTask lastError',
            SCHEDULED_TASK_RUN_MESSAGE_MAX_CHARS,
          ),
  };
}

function decodeCreateInput(value: unknown): Omit<CreateScheduledTaskInput, 'createdBy'> {
  const input = requireShapedRecord(
    value,
    'ScheduledTask create payload',
    ['title', 'intentBody', 'schedule', 'effect'],
    ['maxFires', 'expiresAt'],
  );
  return {
    title: boundedText(input.title, 'ScheduledTask title', SCHEDULED_TASK_TITLE_MAX_CHARS, true),
    intentBody: boundedText(
      input.intentBody,
      'ScheduledTask intent body',
      SCHEDULED_TASK_INTENT_MAX_CHARS,
    ),
    schedule: decodeSchedule(input.schedule),
    effect: decodeEffect(input.effect),
    ...(Object.hasOwn(input, 'maxFires')
      ? { maxFires: nullablePositiveCount(input.maxFires, 'ScheduledTask maxFires') }
      : {}),
    ...(Object.hasOwn(input, 'expiresAt')
      ? { expiresAt: nullableCount(input.expiresAt, 'ScheduledTask expiresAt') }
      : {}),
  };
}

function decodeUpdateInput(value: unknown): UpdateScheduledTaskInput {
  const patch = requireShapedRecord(
    value,
    'ScheduledTask update payload',
    [],
    ['title', 'intentBody', 'schedule', 'effect', 'maxFires', 'expiresAt'],
  );
  if (Object.keys(patch).length === 0) throw invalidProtocolFrame('ScheduledTask update is empty');
  return {
    ...(Object.hasOwn(patch, 'title')
      ? {
          title: boundedText(
            patch.title,
            'ScheduledTask title',
            SCHEDULED_TASK_TITLE_MAX_CHARS,
            true,
          ),
        }
      : {}),
    ...(Object.hasOwn(patch, 'intentBody')
      ? {
          intentBody: boundedText(
            patch.intentBody,
            'ScheduledTask intent body',
            SCHEDULED_TASK_INTENT_MAX_CHARS,
          ),
        }
      : {}),
    ...(Object.hasOwn(patch, 'schedule') ? { schedule: decodeSchedule(patch.schedule) } : {}),
    ...(Object.hasOwn(patch, 'effect') ? { effect: decodeEffect(patch.effect) } : {}),
    ...(Object.hasOwn(patch, 'maxFires')
      ? { maxFires: nullablePositiveCount(patch.maxFires, 'ScheduledTask maxFires') }
      : {}),
    ...(Object.hasOwn(patch, 'expiresAt')
      ? { expiresAt: nullableCount(patch.expiresAt, 'ScheduledTask expiresAt') }
      : {}),
  };
}

function decodeSchedule(value: unknown): ScheduledTaskSchedule {
  const schedule = requireRecord(value, 'ScheduledTask schedule');
  if (schedule.kind === 'once') {
    const exact = requireExactRecord(schedule, 'ScheduledTask once schedule', ['kind', 'runAt']);
    return { kind: 'once', runAt: requireCount(exact.runAt, 'ScheduledTask runAt') };
  }
  if (schedule.kind === 'interval') {
    const exact = requireExactRecord(schedule, 'ScheduledTask interval schedule', [
      'kind',
      'everySeconds',
      'startAt',
    ]);
    const everySeconds = requireCount(exact.everySeconds, 'ScheduledTask interval');
    if (
      everySeconds < SCHEDULED_TASK_MIN_INTERVAL_SECONDS ||
      everySeconds > SCHEDULED_TASK_MAX_INTERVAL_SECONDS
    ) {
      throw invalidProtocolFrame('Invalid ScheduledTask interval');
    }
    return {
      kind: 'interval',
      everySeconds,
      startAt: requireCount(exact.startAt, 'ScheduledTask startAt'),
    };
  }
  if (schedule.kind === 'calendar') {
    const exact = requireExactRecord(schedule, 'ScheduledTask calendar schedule', [
      'kind',
      'recurrence',
      'anchorAt',
    ]);
    if (
      exact.recurrence !== 'daily' &&
      exact.recurrence !== 'weekly' &&
      exact.recurrence !== 'monthly'
    ) {
      throw invalidProtocolFrame('Invalid ScheduledTask calendar recurrence');
    }
    return {
      kind: 'calendar',
      recurrence: exact.recurrence,
      anchorAt: requireCount(exact.anchorAt, 'ScheduledTask anchorAt'),
    };
  }
  if (schedule.kind === 'cron') {
    const exact = requireExactRecord(schedule, 'ScheduledTask cron schedule', [
      'kind',
      'expression',
      'startAt',
    ]);
    return {
      kind: 'cron',
      expression: boundedText(
        exact.expression,
        'ScheduledTask cron expression',
        SCHEDULED_TASK_CRON_MAX_CHARS,
        true,
      ),
      startAt: requireCount(exact.startAt, 'ScheduledTask startAt'),
    };
  }
  throw invalidProtocolFrame('Invalid ScheduledTask schedule');
}

function decodeEffect(value: unknown): ScheduledTaskEffect {
  const effect = requireRecord(value, 'ScheduledTask effect');
  if (effect.kind === 'notify') {
    if (effect.channel === 'local') {
      requireExactRecord(effect, 'ScheduledTask local notification effect', ['kind', 'channel']);
      return { kind: 'notify', channel: 'local' };
    }
    if (effect.channel === 'bot') {
      const exact = requireExactRecord(effect, 'ScheduledTask bot notification effect', [
        'kind',
        'channel',
        'platform',
        'chatId',
      ]);
      if (!isBotDeliveryProvider(exact.platform)) {
        throw invalidProtocolFrame('Invalid ScheduledTask bot platform');
      }
      return {
        kind: 'notify',
        channel: 'bot',
        platform: exact.platform,
        chatId: boundedText(
          exact.chatId,
          'ScheduledTask bot chat id',
          SCHEDULED_TASK_CHAT_ID_MAX_CHARS,
          true,
        ),
      };
    }
    throw invalidProtocolFrame('Invalid ScheduledTask notification channel');
  }
  if (effect.kind === 'agent_run') {
    const exact = requireExactRecord(effect, 'ScheduledTask Agent run effect', [
      'kind',
      'execution',
    ]);
    return { kind: 'agent_run', execution: decodeExecution(exact.execution) };
  }
  if (effect.kind === 'session_resume') {
    const exact = requireExactRecord(effect, 'ScheduledTask Session resume effect', [
      'kind',
      'sessionId',
    ]);
    return {
      kind: 'session_resume',
      sessionId: boundedText(
        exact.sessionId,
        'ScheduledTask Session id',
        SCHEDULED_TASK_SESSION_ID_MAX_CHARS,
        true,
      ),
    };
  }
  throw invalidProtocolFrame('Invalid ScheduledTask effect');
}

function decodeExecution(value: unknown): ScheduledTaskExecutionTemplate {
  // `backend` left the template (#3306), but templates frozen by older builds
  // still carry it and this is a closed shape: the key must stay tolerated on
  // the way in, and it never lands on the decoded value.
  const execution = requireShapedRecord(
    value,
    'ScheduledTask execution template',
    [
      'cwd',
      'llmConnectionSlug',
      'model',
      'permissionMode',
      'collaborationMode',
      'orchestrationMode',
    ],
    ['projectId', 'thinkingLevel', 'backend'],
  );
  if (!isPermissionMode(execution.permissionMode)) {
    throw invalidProtocolFrame('Invalid ScheduledTask permission mode');
  }
  if (!isCollaborationMode(execution.collaborationMode)) {
    throw invalidProtocolFrame('Invalid ScheduledTask collaboration mode');
  }
  if (!isOrchestrationMode(execution.orchestrationMode)) {
    throw invalidProtocolFrame('Invalid ScheduledTask orchestration mode');
  }
  if (Object.hasOwn(execution, 'thinkingLevel') && !isThinkingLevel(execution.thinkingLevel)) {
    throw invalidProtocolFrame('Invalid ScheduledTask thinking level');
  }
  if (
    Object.hasOwn(execution, 'projectId') &&
    execution.projectId !== null &&
    typeof execution.projectId !== 'string'
  ) {
    throw invalidProtocolFrame('Invalid ScheduledTask project id');
  }
  return {
    cwd: boundedText(execution.cwd, 'ScheduledTask cwd', 4_096, true),
    ...(Object.hasOwn(execution, 'projectId')
      ? { projectId: execution.projectId as string | null }
      : {}),
    llmConnectionSlug: boundedText(
      execution.llmConnectionSlug,
      'ScheduledTask connection slug',
      256,
      true,
    ),
    model: boundedText(execution.model, 'ScheduledTask model', 512, true),
    ...(Object.hasOwn(execution, 'thinkingLevel')
      ? {
          thinkingLevel: execution.thinkingLevel as ScheduledTaskExecutionTemplate['thinkingLevel'],
        }
      : {}),
    permissionMode: execution.permissionMode,
    collaborationMode: execution.collaborationMode,
    orchestrationMode: execution.orchestrationMode,
  };
}

function decodeCreatedBy(value: unknown): ScheduledTaskCreatedBy {
  const createdBy = requireShapedRecord(value, 'ScheduledTask creator', ['kind'], ['sessionId']);
  if (createdBy.kind !== 'user' && createdBy.kind !== 'agent' && createdBy.kind !== 'system') {
    throw invalidProtocolFrame('Invalid ScheduledTask creator');
  }
  return {
    kind: createdBy.kind,
    ...(Object.hasOwn(createdBy, 'sessionId')
      ? { sessionId: requireEntityId(createdBy.sessionId, 'ScheduledTask creator Session id') }
      : {}),
  };
}

function decodeRun(value: unknown): ScheduledTaskRun {
  const run = requireShapedRecord(
    value,
    'ScheduledTask run',
    ['id', 'at', 'outcome', 'message'],
    ['sessionId', 'runId'],
  );
  if (run.outcome !== 'ok' && run.outcome !== 'failed' && run.outcome !== 'blocked') {
    throw invalidProtocolFrame('Invalid ScheduledTask run outcome');
  }
  return {
    id: requireEntityId(run.id, 'ScheduledTask run id'),
    at: requireCount(run.at, 'ScheduledTask run timestamp'),
    outcome: run.outcome,
    message: boundedText(
      run.message,
      'ScheduledTask run message',
      SCHEDULED_TASK_RUN_MESSAGE_MAX_CHARS,
    ),
    ...(Object.hasOwn(run, 'sessionId')
      ? { sessionId: requireEntityId(run.sessionId, 'ScheduledTask run Session id') }
      : {}),
    ...(Object.hasOwn(run, 'runId')
      ? { runId: requireEntityId(run.runId, 'ScheduledTask AgentRun id') }
      : {}),
  };
}

function decodeCursor(value: unknown): string {
  const cursor = requireEntityId(value, 'ScheduledTask cursor');
  if (!/^\d+$/.test(cursor)) throw invalidProtocolFrame('Invalid ScheduledTask cursor');
  return cursor;
}

function boundedText(value: unknown, label: string, maxChars: number, nonblank = false): string {
  if (typeof value !== 'string' || [...value].length > maxChars || (nonblank && !value.trim())) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function nullableCount(value: unknown, label: string): number | null {
  return value === null ? null : requireCount(value, label);
}

function nullablePositiveCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}
