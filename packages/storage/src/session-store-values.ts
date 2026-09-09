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

import { randomUUID } from 'node:crypto';
import { DEFAULT_SESSION_NAME, normalizeUserSessionName } from '@maka/core/session-name';
import {
  isSessionBlockedReason,
  isSessionConversationCopy,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  isSessionStatus,
  isWorkHubCoordinationSessionId,
  subagentSessionRuntimeSummary,
  WORKHUB_COORDINATION_SESSION_ROLE,
  isSessionToolProfile,
  type SessionHeader,
  type SessionConversationCopy,
  type SessionSummary,
  type SessionRole,
  type UserMessage,
} from '@maka/core/session';
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { decodePersistedPermissionMode, isPermissionMode } from '@maka/core/permission';
import type { PersistedValue } from '@maka/core/persisted-value';
import { isSubagentWorkspaceBinding } from '@maka/core/subagent-workspace';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import { assertSafeSessionId, isSafeSessionId } from './session-store-contract.js';

export function assertCoordinationIdentityPairing(
  sessionId: string,
  role: SessionRole | undefined,
): void {
  if (isWorkHubCoordinationSessionId(sessionId) !== (role === WORKHUB_COORDINATION_SESSION_ROLE)) {
    throw new Error('WorkHub Coordination Session identity and role must be claimed together');
  }
}

export function buildSessionHeader(
  workspaceRoot: string,
  input: CreateSessionInput & { readonly role?: SessionRole },
  sessionId: string = randomUUID(),
  conversationCopy?: SessionConversationCopy,
): SessionHeader {
  if (
    input.projectId !== undefined &&
    input.projectId !== null &&
    (typeof input.projectId !== 'string' || input.projectId.length === 0)
  ) {
    throw new Error('Invalid project id');
  }
  const now = Date.now();
  assertSafeSessionId(sessionId);
  assertCoordinationIdentityPairing(sessionId, input.role);
  const name =
    input.name === undefined ? DEFAULT_SESSION_NAME : normalizeRequiredSessionName(input.name);
  const header: SessionHeader = {
    id: sessionId,
    ...(input.role === undefined ? {} : { role: input.role }),
    workspaceRoot,
    cwd: input.cwd,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    createdAt: now,
    name,
    titleIsManual: false,
    isFlagged: false,
    labels: input.labels ?? [],
    isArchived: false,
    status: input.status ?? 'active',
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    statusUpdatedAt: now,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.branchOfTurnId ? { branchOfTurnId: input.branchOfTurnId } : {}),
    ...(input.subagentParent ? { subagentParent: input.subagentParent } : {}),
    ...(input.subagentRuntime ? { subagentRuntime: input.subagentRuntime } : {}),
    ...(input.subagentSpawn ? { subagentSpawn: input.subagentSpawn } : {}),
    ...(input.subagentWorkspace ? { subagentWorkspace: input.subagentWorkspace } : {}),
    ...(conversationCopy ? { conversationCopy } : {}),
    ...(input.revisionRootSessionId ? { revisionRootSessionId: input.revisionRootSessionId } : {}),
    ...(input.revisionParentSessionId
      ? { revisionParentSessionId: input.revisionParentSessionId }
      : {}),
    ...(input.revisionOfTurnId ? { revisionOfTurnId: input.revisionOfTurnId } : {}),
    ...(input.revisionIndex !== undefined ? { revisionIndex: input.revisionIndex } : {}),
    ...(input.revisionState ? { revisionState: input.revisionState } : {}),
    hasUnread: false,
    backend: 'ai-sdk',
    ...(input.llmConnectionId === undefined ? {} : { llmConnectionId: input.llmConnectionId }),
    llmConnectionSlug: input.llmConnectionSlug,
    // A subagent Session's route is chosen by the spawn that created it and is
    // never re-targeted, so it is born frozen. Every other Session freezes on
    // its first user Message.
    connectionLocked: input.subagentParent !== undefined,
    model: input.model ?? 'default',
    ...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
    permissionMode: input.permissionMode,
    collaborationMode: input.collaborationMode ?? 'agent',
    orchestrationMode: input.orchestrationMode ?? 'default',
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    // Born on the ledger: a Session created here records its execution facts as
    // RuntimeEvents from its first turn, so there is no transcript to convert.
    // Only an imported transcript (staged at 0) and a Session written before
    // this field existed have anything for the converter to do.
    transcriptLedgerVersion: 1,
    schemaVersion: 1,
  };
  assertValidSessionLineage(header);
  return header;
}

function normalizeRequiredSessionName(name: string): string {
  const normalized = normalizeUserSessionName(name);
  if (!normalized.ok) throw new Error(normalized.error);
  return normalized.value;
}

/** Validate and normalize a current SessionHeader before canonical persistence. */
export function normalizeSessionHeader(
  header: SessionHeader,
  sessionId: string = header.id,
): SessionHeader {
  const valid =
    header.id === sessionId &&
    (header.role === undefined || header.role === WORKHUB_COORDINATION_SESSION_ROLE) &&
    typeof header.workspaceRoot === 'string' &&
    typeof header.cwd === 'string' &&
    (header.projectId === undefined ||
      header.projectId === null ||
      (typeof header.projectId === 'string' && header.projectId.length > 0)) &&
    isFiniteNumber(header.createdAt) &&
    (header.lastMessageAt === undefined || isFiniteNumber(header.lastMessageAt)) &&
    typeof header.name === 'string' &&
    typeof header.titleIsManual === 'boolean' &&
    typeof header.isFlagged === 'boolean' &&
    Array.isArray(header.labels) &&
    header.labels.every((label) => typeof label === 'string') &&
    typeof header.isArchived === 'boolean' &&
    !Object.prototype.hasOwnProperty.call(header, 'archivedAt') &&
    isSessionStatus(header.status) &&
    (header.blockedReason === undefined || isSessionBlockedReason(header.blockedReason)) &&
    (header.statusUpdatedAt === undefined || isFiniteNumber(header.statusUpdatedAt)) &&
    (header.parentSessionId === undefined || typeof header.parentSessionId === 'string') &&
    (header.branchOfTurnId === undefined || typeof header.branchOfTurnId === 'string') &&
    isValidConversationCopyLineage(header) &&
    isValidRevisionLineage(header) &&
    isValidSubagentSessionLineage(header) &&
    isValidSessionExternalOrigin(header.externalOrigin) &&
    (header.lastReadMessageId === undefined || typeof header.lastReadMessageId === 'string') &&
    typeof header.hasUnread === 'boolean' &&
    isPersistedBackendKind(header.backend) &&
    (header.llmConnectionId === undefined ||
      (typeof header.llmConnectionId === 'string' && header.llmConnectionId.length > 0)) &&
    typeof header.llmConnectionSlug === 'string' &&
    typeof header.connectionLocked === 'boolean' &&
    typeof header.model === 'string' &&
    (header.toolProfile === undefined || isSessionToolProfile(header.toolProfile)) &&
    isPermissionMode(header.permissionMode) &&
    isCollaborationMode(header.collaborationMode) &&
    isOrchestrationMode(header.orchestrationMode) &&
    (header.transcriptLedgerVersion === undefined ||
      header.transcriptLedgerVersion === 0 ||
      header.transcriptLedgerVersion === 1) &&
    header.schemaVersion === 1;
  if (!valid) {
    throw new Error(`Invalid session header for session ${sessionId}: malformed fields`);
  }
  const normalizedName = normalizeSessionName(header.name);
  if (header.blockedReason === undefined) {
    const { blockedReason: _blockedReason, ...withoutBlockedReason } = header;
    return { ...withoutBlockedReason, name: normalizedName };
  }
  return { ...header, name: normalizedName };
}

export function decodePersistedSessionHeader(
  persisted: PersistedValue<SessionHeader>,
  sessionId?: string,
): SessionHeader {
  const header = persisted as unknown as SessionHeader;
  const permissionMode = decodePersistedPermissionMode(header.permissionMode);
  if (permissionMode === undefined) {
    return normalizeSessionHeader(header, sessionId ?? header.id);
  }
  return normalizeSessionHeader(
    permissionMode === header.permissionMode ? header : { ...header, permissionMode },
    sessionId ?? header.id,
  );
}

function isValidSessionExternalOrigin(origin: SessionHeader['externalOrigin']): boolean {
  if (origin === undefined) return true;
  return (
    typeof origin === 'object' &&
    origin !== null &&
    typeof origin.adapterId === 'string' &&
    origin.adapterId.length > 0 &&
    typeof origin.sourceSessionId === 'string' &&
    origin.sourceSessionId.length > 0
  );
}

function isValidRevisionLineage(header: SessionHeader): boolean {
  const values = [
    header.revisionRootSessionId,
    header.revisionParentSessionId,
    header.revisionOfTurnId,
    header.revisionIndex,
    header.revisionState,
  ];
  if (values.every((value) => value === undefined)) return true;
  return (
    typeof header.revisionRootSessionId === 'string' &&
    isSafeSessionId(header.revisionRootSessionId) &&
    typeof header.revisionParentSessionId === 'string' &&
    isSafeSessionId(header.revisionParentSessionId) &&
    typeof header.revisionOfTurnId === 'string' &&
    header.revisionOfTurnId.length > 0 &&
    header.revisionOfTurnId.length <= 128 &&
    Number.isSafeInteger(header.revisionIndex) &&
    header.revisionIndex! >= 2 &&
    (header.revisionState === 'preparing' || header.revisionState === 'committed')
  );
}

function assertValidSessionLineage(header: SessionHeader): void {
  if (!isValidConversationCopyLineage(header)) {
    throw new Error('Invalid Session conversation-copy lineage');
  }
  if (!isValidRevisionLineage(header)) {
    throw new Error('Invalid session revision lineage');
  }
  if (!isValidSubagentSessionLineage(header)) {
    throw new Error('Invalid subagent session lineage');
  }
}

function isValidConversationCopyLineage(header: SessionHeader): boolean {
  const copy = header.conversationCopy;
  if (copy === undefined) return true;
  if (
    !isSessionConversationCopy(copy) ||
    !isSafeSessionId(copy.sourceSessionId) ||
    copy.sourceSessionId === header.id ||
    header.subagentParent !== undefined
  ) {
    return false;
  }
  if (copy.kind === 'branch') {
    const revisionClear =
      header.revisionRootSessionId === undefined &&
      header.revisionParentSessionId === undefined &&
      header.revisionOfTurnId === undefined &&
      header.revisionIndex === undefined &&
      header.revisionState === undefined;
    if (!revisionClear || header.parentSessionId !== copy.sourceSessionId) {
      return false;
    }
    // An empty copy (absent `sourceTurnId`) records provenance
    // (`parentSessionId`) but must not fabricate a `branchOfTurnId`, and is only
    // valid for a side conversation; a through-turn copy must anchor to it.
    return copy.sourceTurnId === undefined
      ? header.branchOfTurnId === undefined && copy.intent === 'side_conversation'
      : header.branchOfTurnId === copy.sourceTurnId;
  }
  // Revision copies always carry a turn boundary (enforced at decode).
  return (
    copy.sourceTurnId !== undefined &&
    header.revisionParentSessionId === copy.sourceSessionId &&
    header.revisionOfTurnId === copy.sourceTurnId
  );
}

function isValidSubagentSessionLineage(header: SessionHeader): boolean {
  if (header.subagentParent === undefined) {
    return (
      header.subagentRuntime === undefined &&
      header.subagentSpawn === undefined &&
      header.subagentWorkspace === undefined
    );
  }
  if (
    !isSubagentSessionParent(header.subagentParent) ||
    !isSafeSessionId(header.subagentParent.parentSessionId) ||
    header.parentSessionId !== undefined ||
    header.branchOfTurnId !== undefined ||
    header.revisionRootSessionId !== undefined ||
    header.revisionParentSessionId !== undefined ||
    header.revisionOfTurnId !== undefined ||
    header.revisionIndex !== undefined ||
    header.revisionState !== undefined
  ) {
    return false;
  }
  return (
    (header.subagentRuntime === undefined &&
      header.subagentSpawn === undefined &&
      header.subagentWorkspace === undefined) ||
    (isSubagentSessionRuntime(header.subagentRuntime) &&
      isSubagentSessionSpawn(header.subagentSpawn) &&
      (header.subagentWorkspace === undefined ||
        isSubagentWorkspaceBinding(header.subagentWorkspace)))
  );
}

/**
 * Decode guard for a durable session header. `'fake'` stays accepted:
 * narrowing it here would make every session written by a build that shipped
 * FakeBackend fail `normalizeSessionHeader` and read back as malformed (#3211).
 */
function isPersistedBackendKind(value: unknown): value is SessionHeader['backend'] {
  return value === 'ai-sdk' || value === 'fake';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function toSummary(header: SessionHeader): SessionSummary {
  const lastMessageAt = header.lastMessageAt;
  return {
    id: header.id,
    cwd: header.cwd,
    ...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
    name: normalizeSessionName(header.name),
    isFlagged: header.isFlagged,
    isArchived: header.isArchived,
    labels: header.labels,
    hasUnread: header.hasUnread,
    lastMessageAt,
    status: header.status,
    ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
    ...(header.statusUpdatedAt !== undefined ? { statusUpdatedAt: header.statusUpdatedAt } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.subagentParent ? { subagentParent: header.subagentParent } : {}),
    ...(header.subagentRuntime
      ? {
          subagentRuntime: subagentSessionRuntimeSummary(header.subagentRuntime),
        }
      : {}),
    ...(header.subagentWorkspace ? { subagentWorkspace: header.subagentWorkspace } : {}),
    ...(header.revisionRootSessionId
      ? { revisionRootSessionId: header.revisionRootSessionId }
      : {}),
    ...(header.revisionParentSessionId
      ? { revisionParentSessionId: header.revisionParentSessionId }
      : {}),
    ...(header.revisionOfTurnId ? { revisionOfTurnId: header.revisionOfTurnId } : {}),
    ...(header.revisionIndex !== undefined ? { revisionIndex: header.revisionIndex } : {}),
    ...(header.revisionState ? { revisionState: header.revisionState } : {}),
    backend: header.backend,
    ...(header.llmConnectionId === undefined ? {} : { llmConnectionId: header.llmConnectionId }),
    llmConnectionSlug: header.llmConnectionSlug,
    connectionLocked: header.connectionLocked,
    model: header.model,
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
    ...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
  };
}

export function normalizeSessionName(name: string): string {
  return name === 'New Session' ? DEFAULT_SESSION_NAME : name;
}

export function createUserMessage(input: {
  turnId: string;
  text: string;
  displayText?: string;
  attachments?: UserMessage['attachments'];
  inlineReferences?: UserMessage['inlineReferences'];
}): UserMessage {
  return {
    type: 'user',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    text: input.text,
    ...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
    attachments: input.attachments,
    ...(input.inlineReferences !== undefined ? { inlineReferences: input.inlineReferences } : {}),
  };
}
