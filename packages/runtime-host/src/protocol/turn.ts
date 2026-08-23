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

import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import {
  decodeMessageContent as decodeCanonicalMessageContent,
  isCanonicalAttachmentRef,
  type MessageContent,
  type ProviderRetryReason,
} from '@maka/core/events';
import {
  isOrchestrationMode,
  isTurnOrchestrationSource,
  type TurnOrchestration,
} from '@maka/core/orchestration';
import {
  decodeSkillInvocationResult,
  type SkillInvocationResult,
} from '@maka/core/skill-invocation';
import { invalidProtocolFrame } from './errors.js';
import {
  assertExactKeys,
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireId,
  requireRecord,
  requireString,
} from './codec.js';
import { defineOperation } from './operation-spec.js';

export const TURN_FAILURE_MESSAGE_MAX_BYTES = 256;

export interface TurnStartInput {
  sessionId: string;
  turnId: string;
  content: MessageContent;
  skillIds?: string[];
  turnOrchestration?: TurnOrchestration;
  maxSteps?: number;
}

export type TurnStartResult =
  | {
      kind: 'started';
      turn: TurnSnapshot;
      skillInvocation: SkillInvocationResult;
    }
  | {
      kind: 'blocked';
      skillInvocation: SkillInvocationResult;
    };

export type { MessageContent };

export const TURN_MESSAGE_TEXT_MAX_BYTES = 48 * 1024;
export const TURN_MESSAGE_CONTENT_MAX_BYTES = 52 * 1024;
export const TURN_MESSAGE_QUOTE_MAX_COUNT = 16;
export const TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH = 32_000;
export const TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH = 200;
export const TURN_SKILL_ID_MAX_COUNT = 50;
export const TURN_SKILL_ID_MAX_LENGTH = 512;
const ATTACHMENT_NAME_MAX_BYTES = 512;
const ATTACHMENT_MIME_TYPE_MAX_BYTES = 256;
const ATTACHMENT_PATH_MAX_BYTES = 4096;

export interface TurnQueryInput {
  sessionId: string;
  turnId: string;
}

export interface TurnStopInput {
  sessionId: string;
  turnId: string;
  runId: string;
}

export interface TurnRegenerateInput {
  sessionId: string;
  sourceTurnId: string;
  turnId: string;
}

export interface TurnResumeQueryInput {
  sessionId: string;
  sourceRunId?: string;
  expectedRuntimeEventHighWater?: number;
}

export interface TurnResumeStartInput {
  sessionId: string;
  turnId: string;
  sourceRunId: string;
  sourceRuntimeEventHighWater: number;
}

export const TURN_RESUME_PARK_REASONS = [
  'resume_candidate_missing',
  'source_run_unreadable',
  'safety_check_failed',
  'continuation_already_exists',
  'continuation_repair_required',
  'continuation_started_indeterminate',
  'continuation_unavailable',
  'session_busy',
] as const;

export type TurnResumeParkReason = (typeof TURN_RESUME_PARK_REASONS)[number];

export type TurnResumePlan =
  | {
      sessionId: string;
      disposition: 'ready';
      sourceRunId: string;
      sourceTurnId: string;
      sourceRuntimeEventHighWater: number;
    }
  | {
      sessionId: string;
      disposition: 'parked';
      reason: TurnResumeParkReason;
    };

export type TurnResumeStartResult =
  | { kind: 'started'; turn: TurnSnapshot }
  | {
      kind: 'parked';
      plan: Extract<TurnResumePlan, { disposition: 'parked' }>;
    };

export type TurnRunStatus =
  | 'admitted'
  | 'created'
  | 'running'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface TurnSnapshotBase {
  sessionId: string;
  turnId: string;
  runId: string;
}

export type TurnProviderRetry =
  | {
      phase: 'scheduled';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: ProviderRetryReason;
    }
  | {
      phase: 'started';
      attempt: number;
      maxAttempts: number;
      reason: ProviderRetryReason;
    };

export type LiveTurnSnapshot = TurnSnapshotBase & {
  status: Exclude<TurnRunStatus, 'completed' | 'failed' | 'cancelled'>;
  providerRetry?: TurnProviderRetry;
};

export type TurnSnapshot =
  | LiveTurnSnapshot
  | (TurnSnapshotBase & { status: 'completed'; terminalEventId: string })
  | (TurnSnapshotBase & {
      status: 'failed';
      terminalEventId: string;
      failureClass: string;
      failureMessage?: string;
    })
  | (TurnSnapshotBase & {
      status: 'cancelled';
      terminalEventId: string;
      abortSource: string;
    });

export const TURN_OPERATION_SPECS = {
  'turn.start': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnStartInput,
    decodeOutput: decodeTurnStartResult,
    assertOutputForInput: (input, output) => {
      if (
        output.kind === 'started' &&
        (input.sessionId !== output.turn.sessionId || input.turnId !== output.turn.turnId)
      ) {
        throw invalidProtocolFrame('Turn start changed operation identity');
      }
    },
  }),
  'turn.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnQueryInput,
    decodeOutput: decodeTurnSnapshot,
  }),
  'turn.stop': defineOperation({
    mode: 'control',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnStopInput,
    decodeOutput: decodeTurnSnapshot,
  }),
  'turn.regenerate': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnRegenerateInput,
    decodeOutput: decodeTurnSnapshot,
    assertOutputForInput: (input, output) => {
      if (input.sessionId !== output.sessionId || input.turnId !== output.turnId) {
        throw invalidProtocolFrame('Turn regenerate changed operation identity');
      }
    },
  }),
  'turn.resume.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnResumeQueryInput,
    decodeOutput: decodeTurnResumePlan,
    assertOutputForInput: (input, output) => {
      if (input.sessionId !== output.sessionId) {
        throw invalidProtocolFrame('Turn resume query changed Session identity');
      }
      if (
        output.disposition === 'ready' &&
        input.sourceRunId !== undefined &&
        input.sourceRunId !== output.sourceRunId
      ) {
        throw invalidProtocolFrame('Turn resume query changed source Run identity');
      }
      if (
        output.disposition === 'ready' &&
        input.expectedRuntimeEventHighWater !== undefined &&
        input.expectedRuntimeEventHighWater !== output.sourceRuntimeEventHighWater
      ) {
        throw invalidProtocolFrame('Turn resume query changed source RuntimeEvent high-water');
      }
    },
  }),
  'turn.resume.start': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'internal_failure',
    ] as const,
    decodeInput: decodeTurnResumeStartInput,
    decodeOutput: decodeTurnResumeStartResult,
    assertOutputForInput: (input, output) => {
      const sessionId = output.kind === 'started' ? output.turn.sessionId : output.plan.sessionId;
      if (input.sessionId !== sessionId) {
        throw invalidProtocolFrame('Turn resume start changed Session identity');
      }
      if (output.kind === 'started' && input.turnId !== output.turn.turnId) {
        throw invalidProtocolFrame('Turn resume start changed Turn identity');
      }
    },
  }),
} as const;

function decodeTurnStartInput(value: unknown): TurnStartInput {
  const record = requireShapedRecord(
    value,
    'turn.start input',
    ['sessionId', 'turnId', 'content'],
    ['skillIds', 'turnOrchestration', 'maxSteps'],
  );
  const skillIds = decodeSkillIds(record.skillIds);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    content: decodeMessageContent(record.content, skillIds.length > 0),
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(record.turnOrchestration !== undefined
      ? { turnOrchestration: decodeTurnOrchestration(record.turnOrchestration) }
      : {}),
    ...(record.maxSteps !== undefined
      ? { maxSteps: requirePositiveSafeInteger(record.maxSteps, 'maxSteps') }
      : {}),
  };
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  const decoded = requireCount(value, label);
  if (decoded === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return decoded;
}

function decodeSkillIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > TURN_SKILL_ID_MAX_COUNT ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > TURN_SKILL_ID_MAX_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(id),
    )
  ) {
    throw invalidProtocolFrame('Invalid Turn skillIds');
  }
  return [...value];
}

function decodeTurnOrchestration(value: unknown): TurnOrchestration {
  const record = requireExactRecord(value, 'Turn orchestration', ['mode', 'source']);
  if (!isOrchestrationMode(record.mode) || !isTurnOrchestrationSource(record.source)) {
    throw invalidProtocolFrame('Invalid Turn orchestration');
  }
  return { mode: record.mode, source: record.source };
}

export function decodeMessageContent(value: unknown, allowEmptyText = false): MessageContent {
  let content: MessageContent;
  try {
    content = decodeCanonicalMessageContent(value);
  } catch {
    throw invalidProtocolFrame('Invalid Message content');
  }
  requireUtf8String(content.text, 'Message text', TURN_MESSAGE_TEXT_MAX_BYTES, allowEmptyText);
  if (content.displayText !== undefined) {
    requireUtf8String(
      content.displayText,
      'Message displayText',
      TURN_MESSAGE_TEXT_MAX_BYTES,
      true,
    );
  }
  if ((content.attachments?.length ?? 0) > MAX_ATTACHMENT_COUNT) {
    throw invalidProtocolFrame('Invalid Message attachments');
  }
  for (const attachment of content.attachments ?? []) {
    if (!isCanonicalAttachmentRef(attachment)) {
      throw invalidProtocolFrame('Invalid AttachmentRef');
    }
    requireUtf8String(attachment.name, 'AttachmentRef name', ATTACHMENT_NAME_MAX_BYTES, false);
    requireUtf8String(
      attachment.mimeType,
      'AttachmentRef mimeType',
      ATTACHMENT_MIME_TYPE_MAX_BYTES,
      false,
    );
    if (attachment.bytes > MAX_ATTACHMENT_BYTES) {
      throw invalidProtocolFrame('Invalid AttachmentRef bytes');
    }
    if (attachment.ref.kind === 'session_file') {
      requireEntityId(attachment.ref.sessionId, 'AttachmentRef sessionId');
    }
    const path =
      attachment.ref.kind === 'external_file'
        ? attachment.ref.absolutePath
        : attachment.ref.relativePath;
    requireUtf8String(path, 'AttachmentRef path', ATTACHMENT_PATH_MAX_BYTES, false);
  }
  if ((content.quotes?.length ?? 0) > TURN_MESSAGE_QUOTE_MAX_COUNT) {
    throw invalidProtocolFrame('Invalid Message quotes');
  }
  for (const quote of content.quotes ?? []) {
    requireString(quote.text, 'QuoteRef text', TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH);
    if (quote.label !== undefined) {
      requireString(quote.label, 'QuoteRef label', TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH);
    }
    if (quote.sourceTurnId !== undefined) {
      requireEntityId(quote.sourceTurnId, 'QuoteRef sourceTurnId');
    }
  }
  requireEncodedByteLimit(content, 'Message content', TURN_MESSAGE_CONTENT_MAX_BYTES);
  return content;
}

function requireUtf8String(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireEncodedByteLimit(value: unknown, label: string, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
}

function decodeTurnQueryInput(value: unknown): TurnQueryInput {
  const record = requireExactRecord(value, 'turn.query input', ['sessionId', 'turnId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
  };
}

function decodeTurnStopInput(value: unknown): TurnStopInput {
  const record = requireExactRecord(value, 'turn.stop input', ['sessionId', 'turnId', 'runId']);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
}

function decodeTurnRegenerateInput(value: unknown): TurnRegenerateInput {
  const record = requireExactRecord(value, 'turn.regenerate input', [
    'sessionId',
    'sourceTurnId',
    'turnId',
  ]);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    sourceTurnId: requireEntityId(record.sourceTurnId, 'sourceTurnId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
  };
}

function decodeTurnResumeQueryInput(value: unknown): TurnResumeQueryInput {
  const record = requireShapedRecord(
    value,
    'turn.resume.query input',
    ['sessionId'],
    ['sourceRunId', 'expectedRuntimeEventHighWater'],
  );
  if (record.expectedRuntimeEventHighWater !== undefined && record.sourceRunId === undefined) {
    throw invalidProtocolFrame('Turn resume high-water requires a source Run');
  }
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    ...(record.sourceRunId !== undefined
      ? { sourceRunId: requireEntityId(record.sourceRunId, 'sourceRunId') }
      : {}),
    ...(record.expectedRuntimeEventHighWater !== undefined
      ? {
          expectedRuntimeEventHighWater: requirePositiveCount(
            record.expectedRuntimeEventHighWater,
            'expectedRuntimeEventHighWater',
          ),
        }
      : {}),
  };
}

function decodeTurnResumeStartInput(value: unknown): TurnResumeStartInput {
  const record = requireExactRecord(value, 'turn.resume.start input', [
    'sessionId',
    'turnId',
    'sourceRunId',
    'sourceRuntimeEventHighWater',
  ]);
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    sourceRunId: requireEntityId(record.sourceRunId, 'sourceRunId'),
    sourceRuntimeEventHighWater: requirePositiveCount(
      record.sourceRuntimeEventHighWater,
      'sourceRuntimeEventHighWater',
    ),
  };
}

export function decodeTurnResumePlan(value: unknown): TurnResumePlan {
  const record = requireRecord(value, 'Turn resume plan');
  if (record.disposition === 'ready') {
    assertExactKeys(record, 'ready Turn resume plan', [
      'sessionId',
      'disposition',
      'sourceRunId',
      'sourceTurnId',
      'sourceRuntimeEventHighWater',
    ]);
    return {
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      disposition: 'ready',
      sourceRunId: requireEntityId(record.sourceRunId, 'sourceRunId'),
      sourceTurnId: requireEntityId(record.sourceTurnId, 'sourceTurnId'),
      sourceRuntimeEventHighWater: requirePositiveCount(
        record.sourceRuntimeEventHighWater,
        'sourceRuntimeEventHighWater',
      ),
    };
  }
  if (record.disposition === 'parked') {
    assertExactKeys(record, 'parked Turn resume plan', ['sessionId', 'disposition', 'reason']);
    if (!(TURN_RESUME_PARK_REASONS as readonly unknown[]).includes(record.reason)) {
      throw invalidProtocolFrame('Invalid Turn resume park reason');
    }
    return {
      sessionId: requireEntityId(record.sessionId, 'sessionId'),
      disposition: 'parked',
      reason: record.reason as TurnResumeParkReason,
    };
  }
  throw invalidProtocolFrame('Invalid Turn resume disposition');
}

export function decodeTurnResumeStartResult(value: unknown): TurnResumeStartResult {
  const record = requireRecord(value, 'Turn resume start result');
  if (record.kind === 'started') {
    assertExactKeys(record, 'started Turn resume result', ['kind', 'turn']);
    return { kind: 'started', turn: decodeTurnSnapshot(record.turn) };
  }
  if (record.kind === 'parked') {
    assertExactKeys(record, 'parked Turn resume result', ['kind', 'plan']);
    const plan = decodeTurnResumePlan(record.plan);
    if (plan.disposition !== 'parked') {
      throw invalidProtocolFrame('Parked Turn resume result requires a parked plan');
    }
    return { kind: 'parked', plan };
  }
  throw invalidProtocolFrame('Invalid Turn resume start result');
}

export function decodeTurnStartResult(value: unknown): TurnStartResult {
  const record = requireRecord(value, 'Turn start result');
  let skillInvocation: SkillInvocationResult;
  try {
    skillInvocation = decodeSkillInvocationResult(record.skillInvocation);
  } catch {
    throw invalidProtocolFrame('Invalid Turn start Skill invocation result');
  }
  if (record.kind === 'started') {
    assertExactKeys(record, 'started Turn result', ['kind', 'turn', 'skillInvocation']);
    return { kind: 'started', turn: decodeTurnSnapshot(record.turn), skillInvocation };
  }
  if (record.kind === 'blocked') {
    assertExactKeys(record, 'blocked Turn result', ['kind', 'skillInvocation']);
    if (skillInvocation.loaded.length !== 0 || skillInvocation.failed.length === 0) {
      throw invalidProtocolFrame('Blocked Turn requires only failed Skill invocations');
    }
    return { kind: 'blocked', skillInvocation };
  }
  throw invalidProtocolFrame('Invalid Turn start result');
}

function requirePositiveCount(value: unknown, label: string): number {
  const count = requireCount(value, label);
  if (count === 0) throw invalidProtocolFrame(`Invalid ${label}`);
  return count;
}

export function decodeTurnSnapshot(value: unknown): TurnSnapshot {
  const record = requireRecord(value, 'Turn snapshot');
  const base = {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    turnId: requireEntityId(record.turnId, 'turnId'),
    runId: requireEntityId(record.runId, 'runId'),
  };
  const status = requireTurnRunStatus(record.status);
  if (status === 'completed') {
    assertExactKeys(record, 'completed Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
    };
  }
  if (status === 'failed') {
    requireShapedRecord(
      record,
      'failed Turn snapshot',
      ['sessionId', 'turnId', 'runId', 'status', 'terminalEventId', 'failureClass'],
      ['failureMessage'],
    );
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      failureClass: requireString(record.failureClass, 'failureClass', 128),
      ...(record.failureMessage !== undefined
        ? {
            failureMessage: requireUtf8String(
              record.failureMessage,
              'failureMessage',
              TURN_FAILURE_MESSAGE_MAX_BYTES,
              false,
            ),
          }
        : {}),
    };
  }
  if (status === 'cancelled') {
    assertExactKeys(record, 'cancelled Turn snapshot', [
      'sessionId',
      'turnId',
      'runId',
      'status',
      'terminalEventId',
      'abortSource',
    ]);
    return {
      ...base,
      status,
      terminalEventId: requireId(record.terminalEventId, 'terminalEventId'),
      abortSource: requireString(record.abortSource, 'abortSource', 128),
    };
  }
  requireShapedRecord(
    record,
    'non-terminal Turn snapshot',
    ['sessionId', 'turnId', 'runId', 'status'],
    ['providerRetry'],
  );
  return {
    ...base,
    status,
    ...(record.providerRetry !== undefined
      ? { providerRetry: decodeTurnProviderRetry(record.providerRetry) }
      : {}),
  };
}

export function decodeTurnProviderRetry(value: unknown): TurnProviderRetry {
  const record = requireRecord(value, 'Turn provider retry');
  const phase = record.phase;
  const attempt = requirePositiveCount(record.attempt, 'attempt');
  const maxAttempts = requirePositiveCount(record.maxAttempts, 'maxAttempts');
  if (attempt > maxAttempts) throw invalidProtocolFrame('Invalid Turn provider retry');
  const reason = requireProviderRetryReason(record.reason);
  if (phase === 'scheduled') {
    assertExactKeys(record, 'scheduled Turn provider retry', [
      'phase',
      'attempt',
      'maxAttempts',
      'delayMs',
      'reason',
    ]);
    return {
      phase,
      attempt,
      maxAttempts,
      delayMs: requireCount(record.delayMs, 'delayMs'),
      reason,
    };
  }
  if (phase === 'started') {
    assertExactKeys(record, 'started Turn provider retry', [
      'phase',
      'attempt',
      'maxAttempts',
      'reason',
    ]);
    return { phase, attempt, maxAttempts, reason };
  }
  throw invalidProtocolFrame('Invalid Turn provider retry');
}

function requireProviderRetryReason(value: unknown): ProviderRetryReason {
  if (
    value === 'network' ||
    value === 'provider_unavailable' ||
    value === 'rate_limit' ||
    value === 'timeout' ||
    value === 'unknown'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Turn provider retry reason');
}

function requireTurnRunStatus(value: unknown): TurnRunStatus {
  if (
    value === 'admitted' ||
    value === 'created' ||
    value === 'running' ||
    value === 'waiting_for_user' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid Turn run status');
}
