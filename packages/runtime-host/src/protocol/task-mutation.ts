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
  canTransitionTaskStatus,
  isSafeTaskId,
  isTaskKey,
  isTaskStatus,
  normalizeTaskEvidenceText,
  normalizeTaskSubject,
  sanitizeTaskLedgerTask,
  type Task,
  type TaskStatus,
} from '@maka/core/task-ledger';
import { requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const TASK_MUTATION_QUERY_MAX_CORRELATIONS = 128;
export const TASK_MUTATION_PAGE_MAX_ITEMS = 128;
export const TASK_MUTATION_PAGE_MAX_BYTES = 320 * 1024;
export const TASK_MUTATION_CURSOR_MAX_BYTES = 1024;
export const TASK_MUTATION_TOOL_CALL_ID_MAX_ENCODED_BYTES = 2 * 1024;
export const TASK_MUTATION_CORRELATIONS_MAX_ENCODED_BYTES = 192 * 1024;
export const TASK_MUTATION_QUERY_INPUT_MAX_ENCODED_BYTES = 224 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'internal_failure',
] as const;

export type TaskMutationRevision = `sha256:${string}`;

export interface TaskMutationCorrelation {
  readonly turnId: string;
  readonly toolCallId: string;
}

export interface TaskMutationChange {
  readonly taskId: string;
  readonly key: string;
  readonly subject: string;
  readonly previousStatus?: TaskStatus;
  readonly nextStatus: TaskStatus;
  readonly reason?: string;
  readonly evidence?: string;
}

export interface TaskMutationPresentation {
  readonly operation: 'create' | 'update';
  readonly correlation: TaskMutationCorrelation;
  readonly changes: readonly TaskMutationChange[];
}

export type TaskMutationLookup =
  | {
      readonly kind: 'found';
      readonly correlation: TaskMutationCorrelation;
      readonly presentation: TaskMutationPresentation;
    }
  | {
      readonly kind: 'not_found' | 'incompatible';
      readonly correlation: TaskMutationCorrelation;
    };

export type TaskMutationQueryInput =
  | {
      readonly kind: 'start';
      readonly sessionId: string;
      readonly correlations: readonly TaskMutationCorrelation[];
    }
  | {
      readonly kind: 'continue';
      readonly sessionId: string;
      readonly correlations: readonly TaskMutationCorrelation[];
      readonly revision: TaskMutationRevision;
      readonly cursor: string;
    };

export type TaskMutationQueryResult =
  | {
      readonly kind: 'page';
      readonly sessionId: string;
      readonly revision: TaskMutationRevision;
      readonly lookups: readonly TaskMutationLookup[];
      readonly nextCursor: string | null;
    }
  | {
      readonly kind: 'history_changed';
      readonly expected: TaskMutationRevision;
      readonly actual: TaskMutationRevision;
    };

export const TASK_MUTATION_OPERATION_SPECS = {
  'task.mutation.query': defineOperation<
    TaskMutationQueryInput,
    TaskMutationQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeTaskMutationQueryInput,
    decodeOutput: decodeTaskMutationQueryResult,
  }),
} as const;

export function decodeTaskMutationQueryInput(value: unknown): TaskMutationQueryInput {
  const record = requireRecord(value, 'task mutation query input');
  if (record.kind === 'start') {
    const input = requireExactRecord(record, 'task mutation query start input', [
      'kind',
      'sessionId',
      'correlations',
    ]);
    return boundedTaskMutationQueryInput({
      kind: 'start',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      correlations: taskMutationCorrelations(input.correlations),
    });
  }
  if (record.kind === 'continue') {
    const input = requireExactRecord(record, 'task mutation query continuation input', [
      'kind',
      'sessionId',
      'correlations',
      'revision',
      'cursor',
    ]);
    return boundedTaskMutationQueryInput({
      kind: 'continue',
      sessionId: requireEntityId(input.sessionId, 'sessionId'),
      correlations: taskMutationCorrelations(input.correlations),
      revision: taskMutationRevision(input.revision, 'task mutation revision'),
      cursor: taskMutationCursor(input.cursor),
    });
  }
  throw invalidProtocolFrame('Invalid task mutation query kind');
}

export function decodeTaskMutationQueryResult(value: unknown): TaskMutationQueryResult {
  return taskMutationQueryResult(value, 'decode');
}

export function encodeTaskMutationQueryResult(value: unknown): TaskMutationQueryResult {
  return taskMutationQueryResult(value, 'encode');
}

function taskMutationQueryResult(
  value: unknown,
  direction: 'encode' | 'decode',
): TaskMutationQueryResult {
  const record = requireRecord(value, 'task mutation query result');
  if (record.kind === 'history_changed') {
    const changed = requireExactRecord(record, 'task mutation history changed result', [
      'kind',
      'expected',
      'actual',
    ]);
    return {
      kind: 'history_changed',
      expected: taskMutationRevision(changed.expected, 'expected task mutation revision'),
      actual: taskMutationRevision(changed.actual, 'actual task mutation revision'),
    };
  }
  if (record.kind !== 'page') throw invalidProtocolFrame('Invalid task mutation query result kind');
  const page = requireExactRecord(record, 'task mutation query page', [
    'kind',
    'sessionId',
    'revision',
    'lookups',
    'nextCursor',
  ]);
  if (!Array.isArray(page.lookups) || page.lookups.length > TASK_MUTATION_PAGE_MAX_ITEMS) {
    throw invalidProtocolFrame('Task mutation page exceeds item limit');
  }
  const decoded: TaskMutationQueryResult = {
    kind: 'page',
    sessionId: requireEntityId(page.sessionId, 'sessionId'),
    revision: taskMutationRevision(page.revision, 'task mutation revision'),
    lookups: page.lookups.map((lookup) => taskMutationLookup(lookup, direction)),
    nextCursor: page.nextCursor === null ? null : taskMutationCursor(page.nextCursor),
  };
  if (jsonByteLength(decoded) > TASK_MUTATION_PAGE_MAX_BYTES) {
    throw invalidProtocolFrame('Task mutation page exceeds byte limit');
  }
  return decoded;
}

function taskMutationCorrelations(value: unknown): readonly TaskMutationCorrelation[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > TASK_MUTATION_QUERY_MAX_CORRELATIONS
  ) {
    throw invalidProtocolFrame('Invalid task mutation correlations');
  }
  const correlations = value.map(taskMutationCorrelation);
  if (
    taskMutationCorrelationsEncodedByteLength(correlations) >
    TASK_MUTATION_CORRELATIONS_MAX_ENCODED_BYTES
  ) {
    throw invalidProtocolFrame('Task mutation correlations exceed byte limit');
  }
  const unique = new Set(correlations.map(correlationKey));
  if (unique.size !== correlations.length) {
    throw invalidProtocolFrame('Duplicate task mutation correlation');
  }
  return correlations;
}

function taskMutationCorrelation(value: unknown): TaskMutationCorrelation {
  const correlation = requireExactRecord(value, 'task mutation correlation', [
    'turnId',
    'toolCallId',
  ]);
  if (
    typeof correlation.toolCallId !== 'string' ||
    correlation.toolCallId.length === 0 ||
    jsonByteLength(correlation.toolCallId) > TASK_MUTATION_TOOL_CALL_ID_MAX_ENCODED_BYTES
  ) {
    throw invalidProtocolFrame('Invalid toolCallId');
  }
  return {
    turnId: requireEntityId(correlation.turnId, 'turnId'),
    toolCallId: correlation.toolCallId,
  };
}

export function taskMutationCorrelationsEncodedByteLength(
  correlations: readonly TaskMutationCorrelation[],
): number {
  return jsonByteLength(correlations);
}

function boundedTaskMutationQueryInput(input: TaskMutationQueryInput): TaskMutationQueryInput {
  if (jsonByteLength(input) > TASK_MUTATION_QUERY_INPUT_MAX_ENCODED_BYTES) {
    throw invalidProtocolFrame('Task mutation query input exceeds byte limit');
  }
  return input;
}

function taskMutationLookup(value: unknown, direction: 'encode' | 'decode'): TaskMutationLookup {
  const record = requireRecord(value, 'task mutation lookup');
  if (record.kind === 'not_found' || record.kind === 'incompatible') {
    const lookup = requireExactRecord(record, 'task mutation unresolved lookup', [
      'kind',
      'correlation',
    ]);
    return { kind: record.kind, correlation: taskMutationCorrelation(lookup.correlation) };
  }
  if (record.kind !== 'found') throw invalidProtocolFrame('Invalid task mutation lookup kind');
  const lookup = requireExactRecord(record, 'task mutation found lookup', [
    'kind',
    'correlation',
    'presentation',
  ]);
  const correlation = taskMutationCorrelation(lookup.correlation);
  const presentation = taskMutationPresentation(lookup.presentation, direction);
  if (correlationKey(correlation) !== correlationKey(presentation.correlation)) {
    throw invalidProtocolFrame('Task mutation lookup correlation mismatch');
  }
  return { kind: 'found', correlation, presentation };
}

function taskMutationPresentation(
  value: unknown,
  direction: 'encode' | 'decode',
): TaskMutationPresentation {
  const record = requireExactRecord(value, 'task mutation presentation', [
    'operation',
    'correlation',
    'changes',
  ]);
  if (record.operation !== 'create' && record.operation !== 'update') {
    throw invalidProtocolFrame('Invalid task mutation operation');
  }
  if (
    !Array.isArray(record.changes) ||
    record.changes.length === 0 ||
    record.changes.length > 200 ||
    (record.operation === 'update' && record.changes.length !== 1)
  ) {
    throw invalidProtocolFrame('Invalid task mutation changes');
  }
  const changes = record.changes.map((change) => taskMutationChange(change, direction));
  if (record.operation === 'create') {
    const taskIds = new Set<string>();
    const taskKeys = new Set<string>();
    for (const change of changes) {
      if (
        change.previousStatus !== undefined ||
        change.nextStatus !== 'pending' ||
        change.reason !== undefined ||
        change.evidence !== undefined ||
        taskIds.has(change.taskId) ||
        taskKeys.has(change.key)
      ) {
        throw invalidProtocolFrame('Invalid create task mutation changes');
      }
      taskIds.add(change.taskId);
      taskKeys.add(change.key);
    }
  } else {
    const change = changes[0];
    if (
      change?.previousStatus === undefined ||
      !canTransitionTaskStatus(change.previousStatus, change.nextStatus, { explicitReopen: true })
    ) {
      throw invalidProtocolFrame('Invalid update task mutation change');
    }
  }
  return {
    operation: record.operation,
    correlation: taskMutationCorrelation(record.correlation),
    changes,
  };
}

function taskMutationChange(value: unknown, direction: 'encode' | 'decode'): TaskMutationChange {
  const record = requireRecord(value, 'task mutation change');
  assertAllowedKeys(record, 'task mutation change', [
    'taskId',
    'key',
    'subject',
    'previousStatus',
    'nextStatus',
    'reason',
    'evidence',
  ]);
  for (const field of ['taskId', 'key', 'subject', 'nextStatus'] as const) {
    if (!Object.hasOwn(record, field)) throw invalidProtocolFrame('Invalid task mutation fields');
  }
  if (!isSafeTaskId(record.taskId)) throw invalidProtocolFrame('Invalid task mutation taskId');
  if (!isTaskKey(record.key)) throw invalidProtocolFrame('Invalid task mutation task key');
  if (!isTaskStatus(record.nextStatus)) throw invalidProtocolFrame('Invalid task mutation status');
  if (record.previousStatus !== undefined && !isTaskStatus(record.previousStatus)) {
    throw invalidProtocolFrame('Invalid previous task mutation status');
  }
  const subject = canonicalSubject(record.subject, direction);
  const reason = optionalDetail(record.reason, record.nextStatus, 'reason', direction);
  const evidence = optionalDetail(record.evidence, record.nextStatus, 'evidence', direction);
  if (
    ((record.nextStatus === 'blocked' || record.nextStatus === 'failed') && !reason) ||
    (record.nextStatus === 'completed' && !evidence)
  ) {
    throw invalidProtocolFrame('Task mutation status requires exact detail');
  }
  return {
    taskId: record.taskId,
    key: record.key,
    subject,
    ...(record.previousStatus !== undefined ? { previousStatus: record.previousStatus } : {}),
    nextStatus: record.nextStatus,
    ...(reason !== undefined ? { reason } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

function canonicalSubject(value: unknown, direction: 'encode' | 'decode'): string {
  if (typeof value !== 'string' || Array.from(value).length > TASK_SUBJECT_MAX_CHARS) {
    throw invalidProtocolFrame('Invalid task mutation subject');
  }
  const sanitized = sanitizeTaskLedgerText(value, 'subject');
  const normalized = normalizeTaskSubject(sanitized);
  const canonical = normalized.ok
    ? normalized.value
    : sanitized.trim().length === 0
      ? '[redacted]'
      : null;
  if (canonical === null || (direction === 'decode' && canonical !== value)) {
    throw invalidProtocolFrame('Task mutation subject is not sanitized');
  }
  return canonical;
}

function optionalDetail(
  value: unknown,
  status: TaskStatus,
  kind: 'reason' | 'evidence',
  direction: 'encode' | 'decode',
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Array.from(value).length > TASK_EVIDENCE_MAX_CHARS) {
    throw invalidProtocolFrame(`Invalid task mutation ${kind}`);
  }
  if (
    (kind === 'reason' && status !== 'blocked' && status !== 'failed') ||
    (kind === 'evidence' && status !== 'completed')
  ) {
    throw invalidProtocolFrame(`Task mutation ${kind} is incompatible with status`);
  }
  const field =
    kind === 'evidence'
      ? 'completionEvidence'
      : status === 'blocked'
        ? 'blockedReason'
        : 'failureReason';
  const sanitized = sanitizeTaskLedgerText(value, field);
  const normalized = normalizeTaskEvidenceText(sanitized, field);
  const canonical = normalized.ok
    ? normalized.value
    : sanitized.trim().length === 0
      ? undefined
      : null;
  if (canonical === null || (direction === 'decode' && canonical !== value)) {
    throw invalidProtocolFrame(`Task mutation ${kind} is not sanitized`);
  }
  return canonical;
}

function sanitizeTaskLedgerText(
  value: string,
  field: 'subject' | 'blockedReason' | 'failureReason' | 'completionEvidence',
): string {
  const task: Task = {
    id: 'task-mutation-wire-sanitizer',
    key: 'T1',
    subject: field === 'subject' ? value : 'Task mutation',
    status:
      field === 'blockedReason'
        ? 'blocked'
        : field === 'failureReason'
          ? 'failed'
          : field === 'completionEvidence'
            ? 'completed'
            : 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...(field !== 'subject' ? { [field]: value } : {}),
  };
  return sanitizeTaskLedgerTask(task)[field] ?? '';
}

function taskMutationRevision(value: unknown, label: string): TaskMutationRevision {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as TaskMutationRevision;
}

function taskMutationCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > TASK_MUTATION_CURSOR_MAX_BYTES
  ) {
    throw invalidProtocolFrame('Invalid task mutation cursor');
  }
  return value;
}

function correlationKey(correlation: TaskMutationCorrelation): string {
  return JSON.stringify([correlation.turnId, correlation.toolCallId]);
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
