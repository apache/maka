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
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireId,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { MESSAGE_QUEUE_MAX_ENTRIES } from './message-queue-limits.js';
import { defineOperation } from './operation-spec.js';
import { TURN_MESSAGE_TEXT_MAX_BYTES } from './turn.js';

interface QueueEntryCommand {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly entryId: string;
}

export interface QueueEntryRetractInput extends QueueEntryCommand {
  readonly retractId: string;
}

export interface QueueEntryPromoteInput extends QueueEntryCommand {
  readonly promoteId: string;
}

export interface QueueEntryUpdateInput extends QueueEntryCommand {
  readonly updateId: string;
  readonly expectedQueueRevision: number;
  readonly text: string;
}

export interface QueueEntriesReorderInput {
  readonly originHostEpoch: string;
  readonly sessionId: string;
  readonly reorderId: string;
  readonly expectedQueueRevision: number;
  readonly entryIds: readonly string[];
}

export interface QueueMutationResult {
  readonly queueRevision: number;
}

const QUEUE_MUTATION_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'outcome_unknown',
  'internal_failure',
] as const;

export const QUEUE_MUTATION_OPERATION_SPECS = {
  'queue.entry.retract': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: QUEUE_MUTATION_ERRORS,
    decodeInput: decodeQueueEntryRetractInput,
    decodeOutput: decodeQueueMutationResult,
  }),
  'queue.entry.promote': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: QUEUE_MUTATION_ERRORS,
    decodeInput: decodeQueueEntryPromoteInput,
    decodeOutput: decodeQueueMutationResult,
  }),
  'queue.entry.update': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: QUEUE_MUTATION_ERRORS,
    decodeInput: decodeQueueEntryUpdateInput,
    decodeOutput: decodeQueueMutationResult,
  }),
  'queue.entries.reorder': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: QUEUE_MUTATION_ERRORS,
    decodeInput: decodeQueueEntriesReorderInput,
    decodeOutput: decodeQueueMutationResult,
  }),
} as const;

export function decodeQueueEntryRetractInput(value: unknown): QueueEntryRetractInput {
  const command = decodeEntryCommand(value, 'queue.entry.retract input', 'retractId');
  const { operationId, ...identity } = command;
  return { ...identity, retractId: requireEntityId(operationId, 'retractId') };
}

export function decodeQueueEntryPromoteInput(value: unknown): QueueEntryPromoteInput {
  const command = decodeEntryCommand(value, 'queue.entry.promote input', 'promoteId');
  const { operationId, ...identity } = command;
  return { ...identity, promoteId: requireEntityId(operationId, 'promoteId') };
}

export function decodeQueueEntryUpdateInput(value: unknown): QueueEntryUpdateInput {
  const record = requireExactRecord(value, 'queue.entry.update input', [
    'originHostEpoch',
    'sessionId',
    'entryId',
    'updateId',
    'expectedQueueRevision',
    'text',
  ]);
  const text = requireUtf8String(record.text, 'Message text', TURN_MESSAGE_TEXT_MAX_BYTES);
  if (text.trim().length === 0) throw invalidProtocolFrame('Invalid Message text');
  return {
    ...decodeEntryIdentity(record),
    updateId: requireEntityId(record.updateId, 'updateId'),
    expectedQueueRevision: requireCount(record.expectedQueueRevision, 'expectedQueueRevision'),
    text,
  };
}

export function decodeQueueEntriesReorderInput(value: unknown): QueueEntriesReorderInput {
  const record = requireExactRecord(value, 'queue.entries.reorder input', [
    'originHostEpoch',
    'sessionId',
    'reorderId',
    'expectedQueueRevision',
    'entryIds',
  ]);
  if (!Array.isArray(record.entryIds) || record.entryIds.length > MESSAGE_QUEUE_MAX_ENTRIES) {
    throw invalidProtocolFrame('Invalid reorder entry identities');
  }
  const entryIds = record.entryIds.map((entryId) => requireEntityId(entryId, 'entryId'));
  if (new Set(entryIds).size !== entryIds.length) {
    throw invalidProtocolFrame('Invalid reorder entry identities');
  }
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    reorderId: requireEntityId(record.reorderId, 'reorderId'),
    expectedQueueRevision: requireCount(record.expectedQueueRevision, 'expectedQueueRevision'),
    entryIds,
  };
}

export function decodeQueueMutationResult(value: unknown): QueueMutationResult {
  const record = requireExactRecord(value, 'queue mutation result', ['queueRevision']);
  return { queueRevision: requireCount(record.queueRevision, 'queueRevision') };
}

function decodeEntryCommand(
  value: unknown,
  label: string,
  operationIdKey: 'retractId' | 'promoteId',
): QueueEntryCommand & { readonly operationId: unknown } {
  const record = requireExactRecord(value, label, [
    'originHostEpoch',
    'sessionId',
    'entryId',
    operationIdKey,
  ]);
  return { ...decodeEntryIdentity(record), operationId: record[operationIdKey] };
}

function decodeEntryIdentity(record: Record<string, unknown>): QueueEntryCommand {
  return {
    originHostEpoch: requireId(record.originHostEpoch, 'originHostEpoch'),
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    entryId: requireEntityId(record.entryId, 'entryId'),
  };
}
