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

import type {
  BranchFromTurnInput,
  RegenerateTurnInput,
  ReviseBeforeTurnInput,
  TurnOrchestration,
} from '@maka/core/runtime-inputs';
import {
  isDirectoryReference,
  DIRECTORY_REFERENCE_MAX_COUNT,
  type DirectoryReference,
  type QuoteRef,
} from '@maka/core/events';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { ClientCapabilityResponse } from '@maka/core/client-capability-grant';
import { MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { isAttachmentRef, isCanonicalStorageRef, type AttachmentRef } from '@maka/core/events';

import { isOrchestrationMode, isTurnOrchestrationSource } from '@maka/core/orchestration';

const MAX_PERMISSION_REQUEST_ID_LENGTH = 128;
const MAX_TURN_ID_LENGTH = 128;
const MAX_COPY_ID_LENGTH = 128;
const MAX_BRANCH_NAME_LENGTH = 200;
const MAX_SESSION_SEND_TEXT_LENGTH = 128_000;
const MAX_QUOTE_COUNT = 16;
const MAX_QUOTE_TEXT_LENGTH = 32_000;
const MAX_QUOTE_LABEL_LENGTH = 200;
const MAX_INLINE_REFERENCE_COUNT = 32;
const MAX_INLINE_REFERENCE_VALUE_LENGTH = 4_096;

interface WorkspaceFileReferencePosition {
  value: string;
  start: number;
}

export type RuntimeHostBranchFromTurnInput = BranchFromTurnInput & { copyId: string };
export type RuntimeHostReviseBeforeTurnInput = ReviseBeforeTurnInput & { copyId: string };

interface NormalizedSendSessionCommand {
  type: 'send';
  messageId?: string;
  turnId?: string;
  text: string;
  displayText?: string;
  skillIds?: string[];
  attachmentItems?: unknown;
  retainedAttachments?: AttachmentRef[];
  turnOrchestration?: TurnOrchestration;
  directoryReferences?: DirectoryReference[];
  quotes?: QuoteRef[];
  workspaceFileReferences?: WorkspaceFileReferencePosition[];
}
type NormalizedStopSessionInput = {
  source?: 'stop_button';
  expectedTurnId?: string;
  expectedAdmissionId?: string;
};

export function normalizeSandboxBoundaryResponse(input: unknown): SandboxBoundaryResponse {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid sandbox boundary response');
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > MAX_PERMISSION_REQUEST_ID_LENGTH
  ) {
    throw new Error('Invalid sandbox boundary response requestId');
  }
  if (value.decision !== 'allow' && value.decision !== 'deny') {
    throw new Error('Invalid sandbox boundary response decision');
  }
  return {
    requestId: value.requestId,
    decision: value.decision,
  };
}

export function normalizeClientCapabilityResponse(input: unknown): ClientCapabilityResponse {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid Client Capability response');
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > MAX_PERMISSION_REQUEST_ID_LENGTH
  ) {
    throw new Error('Invalid Client Capability response requestId');
  }
  if (value.decision !== 'allow' && value.decision !== 'deny') {
    throw new Error('Invalid Client Capability response decision');
  }
  return { requestId: value.requestId, decision: value.decision };
}

export function normalizeUserQuestionResponse(input: unknown): UserQuestionResponse {
  const value = requireObject(input, 'Invalid user question response');
  const requestId = normalizeRequiredString(
    value.requestId,
    'Invalid user question response requestId',
    MAX_PERMISSION_REQUEST_ID_LENGTH,
  );
  if (
    !Array.isArray(value.answers) ||
    value.answers.length < 1 ||
    value.answers.length > 3 ||
    value.answers.some((answer) => answer !== null && typeof answer !== 'string')
  ) {
    throw new Error('Invalid user question response answers');
  }
  return { requestId, answers: [...value.answers] as Array<string | null> };
}

export function normalizeRegenerateTurnInput(input: unknown): RegenerateTurnInput {
  const value = requireObject(input, 'Invalid regenerate turn input');
  return {
    sourceTurnId: normalizeRequiredString(
      value.sourceTurnId,
      'Invalid regenerate turn sourceTurnId',
      MAX_TURN_ID_LENGTH,
    ),
    ...normalizeOptionalTurnId(value.turnId),
  };
}

export function normalizeBranchFromTurnInput(input: unknown): BranchFromTurnInput {
  const value = requireObject(input, 'Invalid branch turn input');
  const name =
    value.name === undefined
      ? undefined
      : normalizeOptionalString(value.name, 'Invalid branch name', MAX_BRANCH_NAME_LENGTH);
  if (value.sideConversation !== undefined && typeof value.sideConversation !== 'boolean') {
    throw new Error('Invalid branch sideConversation');
  }
  return {
    sourceTurnId: normalizeRequiredString(value.sourceTurnId, 'Invalid branch sourceTurnId', MAX_TURN_ID_LENGTH),
    ...(name ? { name } : {}),
    ...(value.sideConversation === true ? { sideConversation: true } : {}),
  };
}

export function normalizeReviseBeforeTurnInput(input: unknown): ReviseBeforeTurnInput {
  const value = requireObject(input, 'Invalid revision turn input');
  return {
    sourceTurnId: normalizeRequiredString(
      value.sourceTurnId,
      'Invalid revision sourceTurnId',
      MAX_TURN_ID_LENGTH,
    ),
  };
}

export function normalizeRuntimeHostBranchFromTurnInput(
  input: unknown,
): RuntimeHostBranchFromTurnInput {
  const value = requireObject(input, 'Invalid branch turn input');
  return {
    ...normalizeBranchFromTurnInput(value),
    copyId: normalizeRequiredString(value.copyId, 'Invalid conversation copyId', MAX_COPY_ID_LENGTH),
  };
}

export function normalizeRuntimeHostReviseBeforeTurnInput(
  input: unknown,
): RuntimeHostReviseBeforeTurnInput {
  const value = requireObject(input, 'Invalid revision turn input');
  return {
    ...normalizeReviseBeforeTurnInput(value),
    copyId: normalizeRequiredString(value.copyId, 'Invalid conversation copyId', MAX_COPY_ID_LENGTH),
  };
}

export function normalizeSessionSendCommand(input: unknown): NormalizedSendSessionCommand | undefined {
  const value = requireObject(input, 'Invalid session command');
  if (value.type !== 'send') return undefined;
  const text = normalizeSendText(value.text);
  const displayText =
    value.displayText === undefined ? undefined : normalizeSendText(value.displayText);
  const skillIds = normalizeSessionSkillIds(value.skillIds);
  if (!text.trim() && skillIds.length === 0) {
    throw new Error('Invalid send text');
  }
  return {
    type: 'send',
    ...normalizeOptionalSendMessageId(value.messageId),
    ...normalizeOptionalSendTurnId(value.turnId),
    text,
    ...(displayText !== undefined ? { displayText } : {}),
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(value.attachmentItems !== undefined ? { attachmentItems: value.attachmentItems } : {}),
    ...normalizeOptionalRetainedAttachments(value.retainedAttachments),
    ...(value.turnOrchestration !== undefined
      ? { turnOrchestration: normalizeTurnOrchestration(value.turnOrchestration) }
      : {}),
    ...normalizeOptionalDirectoryReferences(value.directoryReferences),
    ...normalizeOptionalQuotes(value.quotes),
    ...normalizeOptionalWorkspaceFileReferences(
      value.workspaceFileReferences,
      displayText ?? text,
    ),
  };
}

function normalizeOptionalSendMessageId(input: unknown): { messageId?: string } {
  if (input === undefined) return {};
  return {
    messageId: normalizeRequiredString(input, 'Invalid send messageId', MAX_TURN_ID_LENGTH),
  };
}

function normalizeOptionalRetainedAttachments(
  input: unknown,
): { retainedAttachments?: AttachmentRef[] } {
  if (input === undefined) return {};
  if (
    !Array.isArray(input) ||
    input.length > MAX_ATTACHMENT_COUNT ||
    !input.every(isAttachmentRef)
  ) {
    throw new Error('Invalid retained attachments');
  }
  return input.length > 0
    ? { retainedAttachments: input.map((attachment) => structuredClone(attachment)) }
    : {};
}

function normalizeOptionalWorkspaceFileReferences(
  input: unknown,
  displayText: string,
): { workspaceFileReferences?: WorkspaceFileReferencePosition[] } {
  if (input === undefined) return {};
  if (!Array.isArray(input) || input.length > MAX_INLINE_REFERENCE_COUNT) {
    throw new Error('Invalid send workspace file references');
  }
  const workspaceFileReferences = input.map((entry) => {
    const value = requireObject(entry, 'Invalid send workspace file reference');
    const tokenValue = normalizeRequiredString(
      value.value,
      'Invalid send workspace file reference value',
      MAX_INLINE_REFERENCE_VALUE_LENGTH,
    );
    if (
      !tokenValue.startsWith('@') ||
      tokenValue.length === 1 ||
      !isCanonicalStorageRef({
        kind: 'workspace_file',
        relativePath: tokenValue.slice(1),
      })
    ) {
      throw new Error('Invalid send workspace file reference value');
    }
    if (
      typeof value.start !== 'number' ||
      !Number.isSafeInteger(value.start) ||
      value.start < 0 ||
      displayText.slice(value.start, value.start + tokenValue.length) !== tokenValue
    ) {
      throw new Error('Invalid send workspace file reference start');
    }
    return { value: tokenValue, start: value.start };
  });
  return workspaceFileReferences.length > 0 ? { workspaceFileReferences } : {};
}

function normalizeTurnOrchestration(input: unknown): TurnOrchestration {
  const value = requireObject(input, 'Invalid turn orchestration');
  if (!isOrchestrationMode(value.mode) || !isTurnOrchestrationSource(value.source)) {
    throw new Error('Invalid turn orchestration');
  }
  return { mode: value.mode, source: value.source };
}

function normalizeOptionalQuotes(input: unknown): { quotes?: QuoteRef[] } {
  if (input === undefined) return {};
  if (!Array.isArray(input) || input.length > MAX_QUOTE_COUNT) {
    throw new Error('Invalid send quotes');
  }
  const quotes = input.map((entry) => {
    const value = requireObject(entry, 'Invalid send quote');
    const label =
      value.label === undefined
        ? undefined
        : normalizeOptionalString(value.label, 'Invalid send quote label', MAX_QUOTE_LABEL_LENGTH);
    const sourceTurnId =
      value.sourceTurnId === undefined
        ? undefined
        : normalizeRequiredString(
            value.sourceTurnId,
            'Invalid send quote sourceTurnId',
            MAX_TURN_ID_LENGTH,
          );
    return {
      text: normalizeRequiredString(value.text, 'Invalid send quote text', MAX_QUOTE_TEXT_LENGTH),
      ...(label ? { label } : {}),
      ...(sourceTurnId ? { sourceTurnId } : {}),
    };
  });
  return quotes.length > 0 ? { quotes } : {};
}

function normalizeSendText(input: unknown): string {
  if (typeof input !== 'string' || input.length > MAX_SESSION_SEND_TEXT_LENGTH) {
    throw new Error('Invalid send text');
  }
  return input;
}

export function normalizeSessionSkillIds(input: unknown): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > 50 ||
    input.some(
      (id) =>
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 512 ||
        // The field name is retained for wire compatibility. Values may be a
        // legacy id or a stable scope-aware ref such as project:maka:writer.
        !/^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(id),
    )
  ) {
    throw new Error('Invalid send skillIds');
  }
  return [...input];
}

export function normalizeStopSessionInput(input: unknown): NormalizedStopSessionInput {
  if (input === undefined) return {};
  const value = requireObject(input, 'Invalid stop session input');
  if (value.source !== undefined && value.source !== 'stop_button') {
    throw new Error('Invalid stop session source');
  }
  const expectedTurnId = value.expectedTurnId === undefined
    ? undefined
    : normalizeRequiredString(
        value.expectedTurnId,
        'Invalid stop session expectedTurnId',
        MAX_TURN_ID_LENGTH,
      );
  const expectedAdmissionId = value.expectedAdmissionId === undefined
    ? undefined
    : normalizeRequiredString(
        value.expectedAdmissionId,
        'Invalid stop session expectedAdmissionId',
        MAX_TURN_ID_LENGTH,
      );
  return {
    ...(value.source ? { source: 'stop_button' as const } : {}),
    ...(expectedTurnId ? { expectedTurnId } : {}),
    ...(expectedAdmissionId ? { expectedAdmissionId } : {}),
  };
}

function requireObject(input: unknown, errorMessage: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(errorMessage);
  }
  return input as Record<string, unknown>;
}

function normalizeRequiredString(input: unknown, errorMessage: string, maxLength: number): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maxLength) {
    throw new Error(errorMessage);
  }
  return input;
}

function normalizeOptionalString(input: unknown, errorMessage: string, maxLength: number): string | undefined {
  if (typeof input !== 'string') {
    throw new Error(errorMessage);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw new Error(errorMessage);
  }
  return trimmed;
}

function normalizeOptionalTurnId(input: unknown): { turnId?: string } {
  if (input === undefined) return {};
  return {
    turnId: normalizeRequiredString(input, 'Invalid turnId', MAX_TURN_ID_LENGTH),
  };
}

function normalizeOptionalSendTurnId(input: unknown): { turnId?: string } {
  if (input === undefined || input === '') return {};
  return {
    turnId: normalizeRequiredString(input, 'Invalid send turnId', MAX_TURN_ID_LENGTH),
  };
}

function normalizeOptionalDirectoryReferences(
  input: unknown,
): { directoryReferences?: DirectoryReference[] } {
  if (input === undefined) return {};
  if (
    !Array.isArray(input) ||
    input.length > DIRECTORY_REFERENCE_MAX_COUNT ||
    !input.every(isDirectoryReference)
  ) {
    throw new Error('Invalid directory references');
  }
  return input.length ? { directoryReferences: input.map((ref) => ({ ...ref })) } : {};
}
