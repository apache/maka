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

import {
  TASK_EVIDENCE_MAX_CHARS,
  TASK_SUBJECT_MAX_CHARS,
  isResumeTrust,
  isSafeTaskId,
  isTaskKey,
  isTaskOwner,
  isTaskStatus,
  normalizeTaskEvidenceText,
  normalizeTaskSubject,
  sanitizeTaskLedgerTask,
  type Task,
  type TaskOwner,
  validateTaskEvidence,
} from '@maka/core/task-ledger';
import { requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const TASK_LEDGER_PAGE_MAX_ITEMS = 128;
export const TASK_LEDGER_PAGE_MAX_BYTES = 48 * 1024;
export const TASK_LEDGER_CURSOR_MAX_BYTES = 512;

const TASK_REQUIRED_FIELDS = ['id', 'key', 'subject', 'status', 'createdAt', 'updatedAt'] as const;
const TASK_FIELDS = [
  ...TASK_REQUIRED_FIELDS,
  'parentId',
  'owner',
  'endedAt',
  'blockedReason',
  'failureReason',
  'completionEvidence',
  'resumeTrust',
] as const;
const TASK_OWNER_FIELDS = ['actor', 'sessionId', 'agentId', 'runId', 'turnId'] as const;
const REDACTED_TASK_TEXT = '[redacted]';

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'internal_failure',
] as const;

export type TaskLedgerRevision = `sha256:${string}`;
export type TaskLedgerTask = Readonly<Task>;

export type TaskLedgerQueryInput =
  | { readonly kind: 'list_start'; readonly sessionId: string }
  | {
      readonly kind: 'list_continue';
      readonly sessionId: string;
      readonly revision: TaskLedgerRevision;
      readonly cursor: string;
    }
  | { readonly kind: 'get'; readonly sessionId: string; readonly taskRef: string };

export type TaskLedgerQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly revision: TaskLedgerRevision;
      readonly tasks: readonly TaskLedgerTask[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expected: TaskLedgerRevision;
      readonly actual: TaskLedgerRevision;
    }
  | {
      readonly kind: 'task';
      readonly sessionId: string;
      readonly revision: TaskLedgerRevision;
      readonly task: TaskLedgerTask | null;
    };

export const TASK_LEDGER_OPERATION_SPECS = {
  'task.ledger.query': defineOperation<
    TaskLedgerQueryInput,
    TaskLedgerQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeTaskLedgerQueryInput,
    decodeOutput: decodeTaskLedgerQueryResult,
  }),
} as const;

export function decodeTaskLedgerQueryInput(value: unknown): TaskLedgerQueryInput {
  const record = requireRecord(value, 'task ledger query input');
  if (record.kind === 'list_start') {
    const input = requireExactRecord(record, 'task ledger list start input', ['kind', 'sessionId']);
    return { kind: 'list_start', sessionId: requireEntityId(input.sessionId, 'sessionId') };
  }
  if (record.kind === 'list_continue') {
    const input = requireExactRecord(record, 'task ledger list continuation input', [
      'kind',
      'sessionId',
      'revision',
      'cursor',
    ]);
    return {
      kind: 'list_continue',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      revision: taskLedgerRevision(input.revision, 'task ledger revision'),
      cursor: taskLedgerCursor(input.cursor, 'task ledger cursor'),
    };
  }
  if (record.kind === 'get') {
    const input = requireExactRecord(record, 'task ledger get input', [
      'kind',
      'sessionId',
      'taskRef',
    ]);
    return {
      kind: 'get',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      taskRef: taskReference(input.taskRef),
    };
  }
  throw invalidProtocolFrame('Invalid task ledger query kind');
}

export function decodeTaskLedgerQueryResult(value: unknown): TaskLedgerQueryResult {
  return taskLedgerQueryResult(value, 'decode');
}

export function encodeTaskLedgerQueryResult(value: unknown): TaskLedgerQueryResult {
  return taskLedgerQueryResult(value, 'encode');
}

export function encodeTaskLedgerTask(value: unknown): TaskLedgerTask {
  return taskLedgerTask(value, 'encode');
}

function taskLedgerQueryResult(
  value: unknown,
  direction: 'encode' | 'decode',
): TaskLedgerQueryResult {
  const record = requireRecord(value, 'task ledger query result');
  if (record.kind === 'revision_changed') {
    const changed = requireExactRecord(record, 'task ledger revision changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'revision_changed',
      expected: taskLedgerRevision(changed.expected, 'expected task ledger revision'),
      actual: taskLedgerRevision(changed.actual, 'actual task ledger revision'),
    };
  }
  if (record.kind === 'task') {
    const result = requireExactRecord(record, 'task ledger task result', [
      'kind',
      'sessionId',
      'revision',
      'task',
    ]);
    return {
      kind: 'task',
      sessionId: requireEntityId(result.sessionId, 'sessionId'),
      revision: taskLedgerRevision(result.revision, 'task ledger revision'),
      task: result.task === null ? null : taskLedgerTask(result.task, direction),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid task ledger query result kind');

  const page = requireExactRecord(record, 'task ledger page result', [
    'kind',
    'sessionId',
    'revision',
    'tasks',
    'nextCursor',
  ]);
  if (!Array.isArray(page.tasks) || page.tasks.length > TASK_LEDGER_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Task ledger page exceeds item limit');
  }
  const decoded: TaskLedgerQueryResult = {
    kind: 'page',
    sessionId: requireEntityId(page.sessionId, 'sessionId'),
    revision: taskLedgerRevision(page.revision, 'task ledger revision'),
    tasks: page.tasks.map((task) => taskLedgerTask(task, direction)),
    nextCursor:
      page.nextCursor === null
        ? null
        : taskLedgerCursor(page.nextCursor, 'task ledger next cursor'),
  };
  if (jsonByteLength(decoded) > TASK_LEDGER_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Task ledger page exceeds byte limit');
  }
  return decoded;
}

function taskLedgerTask(value: unknown, direction: 'encode' | 'decode'): TaskLedgerTask {
  const record = requireRecord(value, 'task ledger task');
  assertAllowedKeys(record, 'task ledger task', TASK_FIELDS);
  if (TASK_REQUIRED_FIELDS.some((field) => !Object.hasOwn(record, field))) {
    throw invalidProtocolFrame('Invalid task ledger task fields');
  }

  const task: Task = {
    id: stableTaskId(record.id, 'task id'),
    key: taskKey(record.key),
    subject: boundedTaskText(record.subject, 'subject'),
    status: taskStatus(record.status),
    createdAt: timestamp(record.createdAt, 'task createdAt'),
    updatedAt: timestamp(record.updatedAt, 'task updatedAt'),
    ...optionalStableTaskId(record, 'parentId'),
    ...optionalOwner(record),
    ...optionalTimestamp(record, 'endedAt'),
    ...optionalTaskText(record, 'blockedReason'),
    ...optionalTaskText(record, 'failureReason'),
    ...optionalTaskText(record, 'completionEvidence'),
    ...optionalResumeTrust(record),
  };
  const projected = projectTaskForWire(task);
  if (direction === 'decode' && !hasCanonicalWireProjection(task, projected)) {
    throw invalidProtocolFrame('Task ledger task is not sanitized');
  }
  return projected;
}

function optionalStableTaskId(
  record: Record<string, unknown>,
  field: 'parentId',
): Pick<Task, 'parentId'> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? { [field]: stableTaskId(record[field], `task ${field}`) }
    : {};
}

function optionalOwner(
  record: Record<string, unknown>,
): Pick<Task, 'owner'> | Record<string, never> {
  if (!Object.hasOwn(record, 'owner')) return {};
  return { owner: taskOwner(record.owner) };
}

function taskOwner(value: unknown): TaskOwner {
  const record = requireRecord(value, 'task owner');
  assertAllowedKeys(record, 'task owner', TASK_OWNER_FIELDS);
  if (!Object.hasOwn(record, 'actor') || !isTaskOwner(record)) {
    throw invalidProtocolFrame('Invalid task owner');
  }
  return {
    actor: record.actor as TaskOwner['actor'],
    ...optionalOwnerId(record, 'sessionId'),
    ...optionalOwnerId(record, 'agentId'),
    ...optionalOwnerId(record, 'runId'),
    ...optionalOwnerId(record, 'turnId'),
  };
}

function optionalOwnerId<Field extends Exclude<keyof TaskOwner, 'actor'>>(
  record: Record<string, unknown>,
  field: Field,
): Pick<TaskOwner, Field> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? ({ [field]: stableTaskId(record[field], `task owner ${field}`) } as Pick<TaskOwner, Field>)
    : {};
}

function optionalTimestamp(
  record: Record<string, unknown>,
  field: 'endedAt',
): Pick<Task, 'endedAt'> | Record<string, never> {
  return Object.hasOwn(record, field) ? { [field]: timestamp(record[field], `task ${field}`) } : {};
}

function optionalTaskText<Field extends 'blockedReason' | 'failureReason' | 'completionEvidence'>(
  record: Record<string, unknown>,
  field: Field,
): Pick<Task, Field> | Record<string, never> {
  return Object.hasOwn(record, field)
    ? ({ [field]: boundedTaskText(record[field], field) } as Pick<Task, Field>)
    : {};
}

function optionalResumeTrust(
  record: Record<string, unknown>,
): Pick<Task, 'resumeTrust'> | Record<string, never> {
  if (!Object.hasOwn(record, 'resumeTrust')) return {};
  if (!isResumeTrust(record.resumeTrust)) throw invalidProtocolFrame('Invalid task resumeTrust');
  return { resumeTrust: record.resumeTrust };
}

function boundedTaskText(
  value: unknown,
  field: 'subject' | 'blockedReason' | 'failureReason' | 'completionEvidence',
): string {
  const maxCharacters = field === 'subject' ? TASK_SUBJECT_MAX_CHARS : TASK_EVIDENCE_MAX_CHARS;
  if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > maxCharacters) {
    throw invalidProtocolFrame(`Invalid task ${field}`);
  }
  return value;
}

function projectTaskForWire(task: Task): Task {
  const sanitized = sanitizeTaskLedgerTask(task);
  const { blockedReason, failureReason, completionEvidence, ...identity } = sanitized;
  const projected: Task = {
    ...identity,
    subject: canonicalWireSubject(sanitized.subject),
    ...canonicalWireEvidence(blockedReason, 'blockedReason'),
    ...canonicalWireEvidence(failureReason, 'failureReason'),
    ...canonicalWireEvidence(completionEvidence, 'completionEvidence'),
  };
  if (validateTaskEvidence(projected).ok) return projected;
  if (projected.resumeTrust !== undefined && projected.resumeTrust !== 'trusted') return projected;
  return { ...projected, resumeTrust: 'needs_revalidation' };
}

function hasCanonicalWireProjection(task: Task, projected: Task): boolean {
  return (
    task.subject === projected.subject &&
    task.blockedReason === projected.blockedReason &&
    task.failureReason === projected.failureReason &&
    task.completionEvidence === projected.completionEvidence &&
    task.resumeTrust === projected.resumeTrust
  );
}

function canonicalWireSubject(value: string): string {
  const normalized = normalizeTaskSubject(value);
  if (normalized.ok) return normalized.value;
  if (value.trim().length === 0) return REDACTED_TASK_TEXT;
  throw invalidProtocolFrame('Invalid task subject');
}

function canonicalWireEvidence<
  Field extends 'blockedReason' | 'failureReason' | 'completionEvidence',
>(value: string | undefined, field: Field): Pick<Task, Field> | Record<string, never> {
  if (value === undefined) return {};
  const normalized = normalizeTaskEvidenceText(value, field);
  if (normalized.ok) return { [field]: normalized.value } as Pick<Task, Field>;
  if (value.trim().length === 0) return {};
  throw invalidProtocolFrame(`Invalid task ${field}`);
}

function stableTaskId(value: unknown, label: string): string {
  if (!isSafeTaskId(value)) throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function taskKey(value: unknown): string {
  if (!isTaskKey(value)) throw invalidProtocolFrame('Invalid task key');
  return value;
}

function taskReference(value: unknown): string {
  if (!isSafeTaskId(value) && !isTaskKey(value)) {
    throw invalidProtocolFrame('Invalid task reference');
  }
  return value;
}

function taskStatus(value: unknown): Task['status'] {
  if (!isTaskStatus(value)) throw invalidProtocolFrame('Invalid task status');
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function taskLedgerRevision(value: unknown, label: string): TaskLedgerRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as TaskLedgerRevision;
}

function taskLedgerCursor(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > TASK_LEDGER_CURSOR_MAX_BYTES
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidProtocolFrame(`Unknown ${label} field`);
  }
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
