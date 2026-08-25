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
  SESSION_MAILBOX_KINDS,
  SESSION_MAILBOX_TEXT_MAX_BYTES,
  type SessionMailboxKind,
} from '@maka/core/session-mailbox';
import {
  assertAllowedKeys,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_MAILBOX_TARGET_MAX_ITEMS = 64;
export const SESSION_MAILBOX_RESULT_MAX_BYTES = 64 * 1024;

export interface SessionMailboxTarget {
  readonly sessionId: string;
  readonly name: string;
  readonly status: 'idle' | 'running' | 'waiting_for_user';
}

export interface SessionMailboxTargetsInput {
  readonly sourceSessionId: string;
}

export interface SessionMailboxTargetsResult {
  readonly targets: readonly SessionMailboxTarget[];
}

export interface SessionMailboxSendInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageId: string;
  readonly kind: SessionMailboxKind;
  readonly text: string;
  readonly correlationId?: string;
}

export interface SessionMailboxSendResult {
  readonly messageId: string;
  readonly targetSessionId: string;
  readonly disposition: 'turn_started' | 'queued';
  readonly turnId?: string;
}

const ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'session_busy',
  'operation_conflict',
  'invalid_request',
  'outcome_unknown',
  'internal_failure',
] as const;

export const SESSION_MAILBOX_OPERATION_SPECS = {
  'session.mailbox.targets': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: decodeTargetsInput,
    decodeOutput: decodeTargetsResult,
  }),
  'session.mailbox.send': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: ERRORS,
    decodeInput: decodeSendInput,
    decodeOutput: decodeSendResult,
  }),
} as const;

function decodeTargetsInput(value: unknown): SessionMailboxTargetsInput {
  const record = requireExactRecord(value, 'session.mailbox.targets input', ['sourceSessionId']);
  return {
    sourceSessionId: requireEntityId(record.sourceSessionId, 'sourceSessionId'),
  };
}

function decodeTargetsResult(value: unknown): SessionMailboxTargetsResult {
  const record = requireExactRecord(value, 'session.mailbox.targets result', ['targets']);
  if (!Array.isArray(record.targets) || record.targets.length > SESSION_MAILBOX_TARGET_MAX_ITEMS) {
    throw invalidProtocolFrame('Invalid Session mailbox targets');
  }
  const targets = record.targets.map((value) => {
    const target = requireExactRecord(value, 'Session mailbox target', [
      'sessionId',
      'name',
      'status',
    ]);
    if (
      target.status !== 'idle' &&
      target.status !== 'running' &&
      target.status !== 'waiting_for_user'
    ) {
      throw invalidProtocolFrame('Invalid Session mailbox target status');
    }
    return {
      sessionId: requireEntityId(target.sessionId, 'target sessionId'),
      name: requireUtf8String(target.name, 'target name', 320),
      status: target.status as SessionMailboxTarget['status'],
    };
  });
  const result = { targets };
  requireEncodedByteLimit(
    result,
    'session.mailbox.targets result',
    SESSION_MAILBOX_RESULT_MAX_BYTES,
  );
  return result;
}

function decodeSendInput(value: unknown): SessionMailboxSendInput {
  const record = requireRecord(value, 'session.mailbox.send input');
  assertAllowedKeys(record, 'session.mailbox.send input', [
    'sourceSessionId',
    'targetSessionId',
    'messageId',
    'kind',
    'text',
    'correlationId',
  ]);
  if (!SESSION_MAILBOX_KINDS.includes(record.kind as SessionMailboxKind)) {
    throw invalidProtocolFrame('Invalid Session mailbox message kind');
  }
  return {
    sourceSessionId: requireEntityId(record.sourceSessionId, 'sourceSessionId'),
    targetSessionId: requireEntityId(record.targetSessionId, 'targetSessionId'),
    messageId: requireEntityId(record.messageId, 'messageId'),
    kind: record.kind as SessionMailboxKind,
    text: requireUtf8String(record.text, 'mailbox text', SESSION_MAILBOX_TEXT_MAX_BYTES),
    ...(record.correlationId === undefined
      ? {}
      : {
          correlationId: requireEntityId(record.correlationId, 'correlationId'),
        }),
  };
}

function decodeSendResult(value: unknown): SessionMailboxSendResult {
  const record = requireRecord(value, 'session.mailbox.send result');
  assertAllowedKeys(record, 'session.mailbox.send result', [
    'messageId',
    'targetSessionId',
    'disposition',
    'turnId',
  ]);
  if (record.disposition !== 'turn_started' && record.disposition !== 'queued') {
    throw invalidProtocolFrame('Invalid Session mailbox disposition');
  }
  if (
    (record.disposition === 'turn_started' && record.turnId === undefined) ||
    (record.disposition === 'queued' && record.turnId !== undefined)
  ) {
    throw invalidProtocolFrame('Invalid Session mailbox Turn identity');
  }
  const result = {
    messageId: requireEntityId(record.messageId, 'messageId'),
    targetSessionId: requireEntityId(record.targetSessionId, 'targetSessionId'),
    disposition: record.disposition,
    ...(record.turnId === undefined ? {} : { turnId: requireEntityId(record.turnId, 'turnId') }),
  };
  return result as SessionMailboxSendResult;
}
