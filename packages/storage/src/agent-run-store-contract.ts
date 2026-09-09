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

import { isDeepStrictEqual } from 'node:util';
import {
  normalizeSubmittedTurnIntent,
  submittedTurnIntentsEqual,
  type SubmittedTurnIntent,
} from './submitted-turn-intent.js';
import { assertNoReservedWorkspaceAuthorityAppend } from './runtime-event-authority.js';
import type { BoundedEvidenceReadResult, EvidenceReadBudget } from './bounded-evidence.js';
import {
  decodeSkillInvocationResult,
  type SkillInvocationResult,
} from '@maka/core/skill-invocation';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type {
  RuntimeInvocationPageInput,
  RuntimeInvocationPageResult,
  RuntimeInvocationRecord,
  RuntimeInvocationSearchResult,
} from '@maka/core/runtime-invocation';
import {
  aggregateMessageContents,
  decodeMessageContent,
  isCanonicalAttachmentRef,
  messageContentsEqual,
  type AttachmentRef,
  type MessageContent,
} from '@maka/core/events';
import { decodeAgentGraphIntentClaim } from '@maka/core/agent-graph-control';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import {
  LATEST_CONTEXT_PROJECTION_TYPE,
  supersedesLatestContext,
  type LatestContextOrder,
  type AgentRunProjectionKey,
  type AgentRunEvent,
  type AgentRunEventType,
  type AgentRunStore,
} from '@maka/core/agent-run';
import type { RootExecutionDescriptor } from '@maka/core/runtime-invocation';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import {
  isOrchestrationMode,
  isTurnOrchestrationSource,
  type TurnOrchestration,
} from '@maka/core/orchestration';
import { validateGenericToolLedgerAppend } from '@maka/core/tool-ledger-scanner';

export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const ROOT_TURN_ADMISSION_SCHEMA_VERSION = 1 as const;
export const ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES = 64;
export const ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES = 64 * 1024;
export const ROOT_TURN_ADMISSION_MAX_RECORD_BYTES = 1024 * 1024;
export const ROOT_TURN_ADMISSION_MAX_AGGREGATED_ATTACHMENTS =
  ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES * MAX_ATTACHMENT_COUNT;

export interface RootTurnSourceMessage {
  messageId: string;
  content: MessageContent;
  submittedContentDigest?: `sha256:${string}`;
  /** The original placement before queue promotion; absent legacy records use `placement`. */
  submittedPlacement?: 'current_turn' | 'next_turn';
  /** The admission-time Skill outcome for this exact source Message. */
  skillInvocation?: SkillInvocationResult;
  /**
   * The exact-Turn intent this Message was submitted with — the Skill ids and
   * the orchestration override. Content and placement do not describe it, so
   * without this a retry that asks for a different execution mode under the
   * same Message identity aliases the earlier success. Absent on a record
   * written for a submit that carried no exact intent.
   */
  submittedIntent?: SubmittedTurnIntent;
  placement: 'current_turn' | 'next_turn';
  disposition: 'steering' | 'followup' | 'turn_started';
}

export interface RootTurnAdmission {
  schemaVersion: typeof ROOT_TURN_ADMISSION_SCHEMA_VERSION;
  sessionId: string;
  turnId: string;
  runId: string;
  userMessageId: string | null;
  execution: RootExecutionDescriptor;
  previousRootTurnId: string | null;
  normalizedInput: MessageContent | null;
  turnOrchestration?: TurnOrchestration;
  skillInvocation?: SkillInvocationResult;
  authorization?: RootTurnAdmissionAuthorization;
  sourceMessages: readonly RootTurnSourceMessage[];
  admittedAt: number;
}

export interface RootTurnAdmissionAuthorization {
  readonly kind: 'session_turn_access_request';
  readonly requestId: string;
  readonly principalId: string;
  readonly grantId: string;
  readonly approvedAt: number;
  readonly approvedBy: string;
}

export interface RootTurnStartRejection {
  schemaVersion: 1;
  sessionId: string;
  turnId: string;
  execution: RootExecutionDescriptor;
  skillInvocation: SkillInvocationResult;
  rejectedAt: number;
}

export interface AdmitRootTurnInput {
  sessionId: string;
  turnId: string;
  proposedRunId: string;
  proposedUserMessageId: string | null;
  execution: RootExecutionDescriptor;
  previousRootTurnId: string | null;
  normalizedInput: MessageContent | null;
  turnOrchestration?: TurnOrchestration;
  skillInvocation?: SkillInvocationResult;
  authorization?: RootTurnAdmissionAuthorization;
  sourceMessages: readonly RootTurnSourceMessage[];
  admittedAt: number;
}

export interface CommitRootTurnStartRejectionInput {
  sessionId: string;
  turnId: string;
  execution: RootExecutionDescriptor;
  skillInvocation: SkillInvocationResult;
  rejectedAt: number;
}

export type CommitRootTurnStartRejectionResult =
  | { kind: 'committed'; rejection: RootTurnStartRejection }
  | { kind: 'existing'; rejection: RootTurnStartRejection }
  | { kind: 'conflict'; rejection: RootTurnStartRejection };

export interface RootTurnSourceMessageReceipt {
  admission: RootTurnAdmission;
  sourceMessage: RootTurnSourceMessage;
}

export interface ImmutableSteeringMessageProof {
  event: RuntimeEvent;
}

export type AdmitRootTurnResult =
  | { kind: 'admitted'; admission: RootTurnAdmission }
  | { kind: 'existing'; admission: RootTurnAdmission }
  | { kind: 'conflict'; admission: RootTurnAdmission };

export interface RootTurnAdmissionStore {
  admitRootTurn(input: AdmitRootTurnInput): Promise<AdmitRootTurnResult>;
  readRootTurnAdmission(sessionId: string, turnId: string): Promise<RootTurnAdmission | undefined>;
  readRootTurnContinuationAdmission(
    sessionId: string,
    sourceTurnId: string,
    sourceRunId: string,
  ): Promise<RootTurnAdmission | undefined>;
  readRootTurnSourceMessageReceipt(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<RootTurnSourceMessageReceipt | undefined>;
  listRootTurnAdmissionsForRecovery(sessionId: string): Promise<RootTurnAdmission[]>;
}

export interface RootTurnStartRejectionStore {
  readRootTurnStartRejection(
    sessionId: string,
    turnId: string,
  ): Promise<RootTurnStartRejection | undefined>;
  commitRootTurnStartRejection(
    input: CommitRootTurnStartRejectionInput,
  ): Promise<CommitRootTurnStartRejectionResult>;
}

export interface DurableAgentRunStore
  extends AgentRunStore,
    RootTurnAdmissionStore,
    RootTurnStartRejectionStore {
  readEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>>;
  readEventsByTypeBounded(
    sessionId: string,
    runId: string,
    type: AgentRunEventType,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<AgentRunEvent>>;
  readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventsForEvidence(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  readEventProjection(
    sessionId: string,
    type: AgentRunProjectionKey,
  ): Promise<AgentRunEvent | null | undefined>;
  readEventLedgerRevision(sessionId: string): Promise<string>;
  repairEventProjection(
    sessionId: string,
    type: AgentRunProjectionKey,
    event: AgentRunEvent | null,
    options: { ifLedgerRevision: string; replaceEventId?: string },
  ): Promise<void>;
  ready?(): Promise<void>;
  close?(): void;
}

export type { BoundedEvidenceReadResult, EvidenceReadBudget } from './bounded-evidence.js';

export interface ConversationCopyRuntimeEventBatch {
  readonly runId: string;
  readonly events: readonly RuntimeEvent[];
}

export interface RuntimeEventScanBudget {
  readonly maxBatchBytes: number;
  readonly maxRecordBytes: number;
  readonly maxImmutableRecords: number;
  readonly maxImmutableBytes: number;
  readonly maxPartialRecords: number;
  readonly maxPartialBytes: number;
}

export type RuntimeEventScanResult = { readonly status: 'complete' | 'limit_exceeded' };

export interface DurableRuntimeEventStore extends RuntimeEventStore {
  listSessionInvocations(sessionId: string): Promise<RuntimeInvocationRecord[]>;
  readRunInvocation(sessionId: string, runId: string): Promise<RuntimeInvocationRecord | undefined>;
  listSessionInvocationsBounded(
    sessionId: string,
    limit: number,
  ): Promise<RuntimeInvocationSearchResult>;
  listSessionInvocationsPage(
    sessionId: string,
    input: RuntimeInvocationPageInput,
  ): Promise<RuntimeInvocationPageResult>;
  readInvocation(sessionId: string, invocationId: string): Promise<RuntimeInvocationRecord>;
  /** Visit one ordered, bounded SQLite snapshot without retaining the immutable ledger. */
  scanRuntimeEvents(
    sessionId: string,
    runId: string,
    budget: RuntimeEventScanBudget,
    visit: (events: readonly RuntimeEvent[]) => void,
  ): Promise<RuntimeEventScanResult>;
  readRuntimeEventsBounded(
    sessionId: string,
    runId: string,
    budget: EvidenceReadBudget,
  ): Promise<BoundedEvidenceReadResult<RuntimeEvent>>;
  importConversationCopyRuntimeEvents(
    sessionId: string,
    batches: readonly ConversationCopyRuntimeEventBatch[],
  ): Promise<void>;
  readImmutableRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]>;
  readImmutableSteeringMessageProof(
    sessionId: string,
    messageId: string,
  ): Promise<ImmutableSteeringMessageProof | undefined>;
  repairImmutableSteeringMessageProofsForRecovery(sessionId: string): Promise<void>;
}

export function normalizeRootTurnStartRejection(
  input: CommitRootTurnStartRejectionInput,
): RootTurnStartRejection {
  return normalizeStoredRootTurnStartRejection(
    {
      schemaVersion: 1,
      sessionId: input.sessionId,
      turnId: input.turnId,
      execution: input.execution,
      skillInvocation: input.skillInvocation,
      rejectedAt: input.rejectedAt,
    },
    input.sessionId,
    input.turnId,
  );
}

export function normalizeStoredRootTurnStartRejection(
  value: unknown,
  sessionId: string,
  turnId: string,
): RootTurnStartRejection {
  assertSafeId(sessionId, 'Invalid session id');
  assertSafeId(turnId, 'Invalid turn id');
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'sessionId',
      'turnId',
      'execution',
      'skillInvocation',
      'rejectedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.sessionId !== sessionId ||
    value.turnId !== turnId ||
    !Number.isSafeInteger(value.rejectedAt) ||
    (value.rejectedAt as number) < 0
  ) {
    throw new Error(`Invalid root Turn start rejection for turn ${turnId}`);
  }
  const execution = normalizeRootExecutionDescriptor(value.execution);
  if (execution.kind !== 'external_message') {
    throw new Error('Root Turn start rejection requires external message execution');
  }
  const skillInvocation = decodeSkillInvocationResult(value.skillInvocation);
  if (skillInvocation.loaded.length !== 0 || skillInvocation.failed.length === 0) {
    throw new Error('Root Turn start rejection requires only failed Skill invocations');
  }
  const rejection = {
    schemaVersion: 1 as const,
    sessionId,
    turnId,
    execution,
    skillInvocation,
    rejectedAt: value.rejectedAt as number,
  };
  assertRootTurnAdmissionSerializedSize(`${JSON.stringify(rejection)}\n`);
  Object.freeze(rejection.execution);
  return Object.freeze(rejection);
}

export function normalizeAdmitRootTurnInput(input: AdmitRootTurnInput): RootTurnAdmission {
  assertSafeId(input.sessionId, 'Invalid session id');
  assertSafeId(input.turnId, 'Invalid turn id');
  assertSafeId(input.proposedRunId, 'Invalid run id');
  if (input.proposedUserMessageId !== null) {
    assertSafeId(input.proposedUserMessageId, 'Invalid user message id');
  }
  if (input.previousRootTurnId !== null) {
    assertSafeId(input.previousRootTurnId, 'Invalid previous root turn id');
    if (input.previousRootTurnId === input.turnId) {
      throw new Error('Root turn admission cannot reference itself');
    }
  }
  if (!Number.isSafeInteger(input.admittedAt) || input.admittedAt < 0) {
    throw new Error('Invalid root turn admission timestamp');
  }
  const { normalizedInput, sourceMessages } = normalizeRootTurnAdmissionPayload(
    input.normalizedInput,
    input.sourceMessages,
  );
  const turnOrchestration = normalizeTurnOrchestration(input.turnOrchestration);
  const skillInvocation =
    input.skillInvocation === undefined
      ? undefined
      : decodeSkillInvocationResult(input.skillInvocation);
  const authorization = normalizeRootTurnAdmissionAuthorization(input.authorization);
  const execution = normalizeRootExecutionDescriptor(input.execution);
  if (execution.kind === 'legacy_automation') {
    throw new Error('New root admission cannot use removed Automation authority');
  }
  const admission: RootTurnAdmission = {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.proposedRunId,
    userMessageId: input.proposedUserMessageId,
    execution,
    previousRootTurnId: input.previousRootTurnId,
    normalizedInput,
    ...(turnOrchestration ? { turnOrchestration } : {}),
    ...(skillInvocation ? { skillInvocation } : {}),
    ...(authorization ? { authorization } : {}),
    sourceMessages,
    admittedAt: input.admittedAt,
  };
  assertRootTurnAdmissionContract(admission);
  assertRootTurnAdmissionRecordSize(admission);
  return deepFreezeRootTurnAdmission(admission);
}

/** Whether a proposed admission satisfies the complete durable record contract and size bound. */
export function rootTurnAdmissionRecordFits(input: AdmitRootTurnInput): boolean {
  try {
    normalizeAdmitRootTurnInput(input);
    return true;
  } catch {
    return false;
  }
}

export function shouldPreserveCheckpointProjectionDuringAppend(
  current: AgentRunEvent | null | undefined,
  candidate: AgentRunEvent,
): boolean {
  if (!current) return false;
  const currentSourceBound = historyCompactProjectionIsSourceBound(current);
  const candidateSourceBound = historyCompactProjectionIsSourceBound(candidate);
  if (currentSourceBound !== candidateSourceBound) return currentSourceBound;
  const currentCoverage = historyCompactProjectionCoverage(current);
  const candidateCoverage = historyCompactProjectionCoverage(candidate);
  return (
    currentCoverage !== undefined &&
    (candidateCoverage === undefined || currentCoverage > candidateCoverage)
  );
}

export function shouldPreserveProjectionDuringRepair(
  current: AgentRunEvent | null | undefined,
  candidate: AgentRunEvent | null,
  type: AgentRunProjectionKey,
): boolean {
  if (!current) return false;
  if (type === LATEST_CONTEXT_PROJECTION_TYPE) {
    // Same ordering rule as the append-time guard, so repair and write cannot
    // disagree about which request is the latest one. An incumbent whose order
    // cannot be read is NOT preserved: the reader already treats an
    // undecodable row as unanswered and rebuilds from the ledger, so keeping
    // it would make that rebuild unwritable and leave every later refresh
    // rescanning the whole session (#2323).
    const incumbent = latestContextOrder(current);
    if (!incumbent) return false;
    const arriving = candidate && latestContextOrder(candidate);
    if (!arriving) return true;
    return !supersedesLatestContext(arriving, incumbent);
  }
  if (type !== 'history_compact_checkpoint_recorded') return true;
  const currentSourceBound = historyCompactProjectionIsSourceBound(current);
  const candidateSourceBound = candidate ? historyCompactProjectionIsSourceBound(candidate) : false;
  if (currentSourceBound !== candidateSourceBound) return currentSourceBound;
  const currentCoverage = historyCompactProjectionCoverage(current);
  const candidateCoverage = candidate && historyCompactProjectionCoverage(candidate);
  return (
    currentCoverage !== undefined &&
    (candidateCoverage === null ||
      candidateCoverage === undefined ||
      currentCoverage >= candidateCoverage)
  );
}

/**
 * The ordering facts a stored latest-context row carries, or `undefined` when
 * the row cannot state them — a damaged snapshot, or one written by a shape
 * this build does not understand.
 */
export function latestContextOrder(event: AgentRunEvent): LatestContextOrder | undefined {
  const data = event.data as { completedAt?: unknown; attemptId?: unknown } | undefined;
  if (!data || typeof data.completedAt !== 'number' || typeof data.attemptId !== 'string') {
    return undefined;
  }
  return { completedAt: data.completedAt, attemptId: data.attemptId };
}

export function historyCompactProjectionIsSourceBound(event: AgentRunEvent): boolean {
  const checkpoint = event.data?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  const source = (checkpoint as { source?: unknown }).source;
  if (!source || typeof source !== 'object') return false;
  return (source as { kind?: unknown }).kind === 'runtime_event_projection';
}

export function assertNoReservedToolLedgerFact(event: RuntimeEvent): void {
  assertNoReservedWorkspaceAuthorityAppend(event);
  if (event.actions?.continuationStart !== undefined) {
    throw new Error('Continuation start facts require SQLite continuation authority');
  }
  const validation = validateGenericToolLedgerAppend(event);
  if (validation.ok) return;
  if (validation.code === 'reserved_recovery_fact') {
    throw new Error('Tool recovery facts require the atomic recovery bundle writer');
  }
  if (validation.code === 'reserved_tool_boundary_fact') {
    throw new Error('Durable tool facts require the atomic tool boundary writer');
  }
  throw new Error(`RuntimeEvent ${event.id} violates its semantic lane`);
}

export function canonicalizeRuntimeEventForStorage(event: RuntimeEvent): RuntimeEvent {
  return encodeCanonicalRuntimeEvent(event).event;
}

export function isToolLedgerBearingEvent(event: RuntimeEvent): boolean {
  return (
    event.content?.kind === 'function_call' ||
    event.content?.kind === 'function_response' ||
    event.actions?.toolDispatch !== undefined ||
    event.actions?.toolRecovery !== undefined
  );
}

export function historyCompactProjectionCoverage(event: AgentRunEvent): number | undefined {
  const checkpoint = event.data?.checkpoint;
  if (!checkpoint || typeof checkpoint !== 'object') return undefined;
  const coverage = (checkpoint as { coverage?: unknown }).coverage;
  if (!coverage || typeof coverage !== 'object') return undefined;
  const eventCount = (coverage as { eventCount?: unknown }).eventCount;
  return typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0
    ? eventCount
    : undefined;
}

export function isProjectedAgentRunEvent(
  value: unknown,
  sessionId: string,
  type: string,
): value is AgentRunEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<AgentRunEvent>;
  return (
    event.type === type &&
    event.sessionId === sessionId &&
    typeof event.id === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.turnId === 'string' &&
    Number.isFinite(event.ts)
  );
}

export function assertSafeId(value: string, message: string): void {
  if (!isSafeId(value)) throw new Error(message);
}

export function assertIdentitySearchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new RangeError('AgentRun identity search limit must be an integer between 1 and 256');
  }
}

export function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value);
}

export function isGraphControlIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

export function normalizeRootTurnAdmission(
  value: unknown,
  sessionId: string,
  turnId: string,
): RootTurnAdmission {
  if (!isPlainRecord(value)) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: expected an object`);
  }
  const record = value;
  const valid =
    record.schemaVersion === ROOT_TURN_ADMISSION_SCHEMA_VERSION &&
    record.sessionId === sessionId &&
    record.turnId === turnId &&
    typeof record.runId === 'string' &&
    isSafeId(record.runId) &&
    (record.userMessageId === null ||
      (typeof record.userMessageId === 'string' && isSafeId(record.userMessageId))) &&
    (record.previousRootTurnId === null ||
      (typeof record.previousRootTurnId === 'string' &&
        isSafeId(record.previousRootTurnId) &&
        record.previousRootTurnId !== turnId)) &&
    Number.isSafeInteger(record.admittedAt) &&
    (record.admittedAt as number) >= 0 &&
    hasRootTurnAdmissionKeys(record);
  if (!valid) {
    throw new Error(`Invalid root turn admission for turn ${turnId}: malformed fields`);
  }
  const { normalizedInput, sourceMessages } = normalizeRootTurnAdmissionPayload(
    record.normalizedInput,
    record.sourceMessages,
  );
  const turnOrchestration = normalizeTurnOrchestration(record.turnOrchestration);
  const skillInvocation =
    record.skillInvocation === undefined
      ? undefined
      : decodeSkillInvocationResult(record.skillInvocation);
  const authorization = normalizeRootTurnAdmissionAuthorization(record.authorization);
  const admission: RootTurnAdmission = {
    schemaVersion: ROOT_TURN_ADMISSION_SCHEMA_VERSION,
    sessionId,
    turnId,
    runId: record.runId as string,
    userMessageId: record.userMessageId as string | null,
    execution: normalizeRootExecutionDescriptor(record.execution),
    previousRootTurnId: record.previousRootTurnId as string | null,
    normalizedInput,
    ...(turnOrchestration ? { turnOrchestration } : {}),
    ...(skillInvocation ? { skillInvocation } : {}),
    ...(authorization ? { authorization } : {}),
    sourceMessages,
    admittedAt: record.admittedAt as number,
  };
  assertRootTurnAdmissionContract(admission);
  assertRootTurnAdmissionRecordSize(admission);
  return deepFreezeRootTurnAdmission(admission);
}

export function decodeRootSourceMessageProofPointer(
  value: unknown,
  sessionId: string,
  messageId: string,
): { readonly turnId: string } {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'sessionId', 'messageId', 'turnId']) ||
    value.schemaVersion !== 1 ||
    value.sessionId !== sessionId ||
    value.messageId !== messageId ||
    typeof value.turnId !== 'string' ||
    !isSafeId(value.turnId)
  ) {
    throw new Error(`Invalid root source message proof: ${messageId}`);
  }
  return Object.freeze({ turnId: value.turnId });
}

export function orderRootTurnAdmissionChain(
  sessionId: string,
  admissions: readonly RootTurnAdmission[],
): RootTurnAdmission[] {
  if (admissions.length === 0) return [];
  const byTurnId = new Map(admissions.map((admission) => [admission.turnId, admission]));
  if (byTurnId.size !== admissions.length) {
    throw new Error(`Session ${sessionId} has duplicate root turn admissions`);
  }
  for (const admission of admissions) {
    const predecessor = admission.previousRootTurnId;
    if (predecessor !== null && !byTurnId.has(predecessor)) {
      throw new Error(
        `Root turn admission ${admission.turnId} has missing predecessor ${predecessor}`,
      );
    }
  }
  const roots = admissions.filter((admission) => admission.previousRootTurnId === null);
  if (roots.length !== 1) {
    throw new Error(`Session ${sessionId} must have exactly one root turn admission root`);
  }
  const childByTurnId = new Map<string, RootTurnAdmission>();
  for (const admission of admissions) {
    const predecessor = admission.previousRootTurnId;
    if (predecessor === null) continue;
    const existing = childByTurnId.get(predecessor);
    if (existing) {
      throw new Error(
        `Root turn admission ${predecessor} branches to ${existing.turnId} and ${admission.turnId}`,
      );
    }
    childByTurnId.set(predecessor, admission);
  }

  const ordered: RootTurnAdmission[] = [];
  let current: RootTurnAdmission | undefined = roots[0];
  while (current) {
    ordered.push(current);
    current = childByTurnId.get(current.turnId);
  }
  if (ordered.length !== admissions.length) {
    throw new Error(`Session ${sessionId} root turn admissions do not form one linear chain`);
  }
  return ordered;
}

export function normalizeRootTurnMessageContent(
  value: unknown,
  description: string,
  maxAttachments: number,
): MessageContent {
  let normalized: MessageContent;
  try {
    normalized = decodeMessageContent(value);
  } catch {
    if (isPlainRecord(value) && Array.isArray(value.attachments)) {
      const invalidAttachmentIndex = value.attachments.findIndex(
        (attachment) => !isCanonicalAttachmentRef(attachment),
      );
      if (invalidAttachmentIndex >= 0) {
        throw new Error(`Invalid ${description} attachment at index ${invalidAttachmentIndex}`);
      }
    }
    throw new Error(`Invalid ${description}`);
  }
  if (normalized.text.length === 0 || (normalized.attachments?.length ?? 0) > maxAttachments) {
    throw new Error(`Invalid ${description}`);
  }
  for (const [index, attachment] of (normalized.attachments ?? []).entries()) {
    if (!isValidRootTurnAttachment(attachment)) {
      throw new Error(`Invalid ${description} attachment at index ${index}`);
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') > ROOT_TURN_ADMISSION_MAX_CONTENT_BYTES
  ) {
    throw new Error(`Invalid ${description}: content exceeds size limit`);
  }
  deepFreezeRootTurnMessageContent(normalized);
  return normalized;
}

export function isValidRootTurnAttachment(attachment: AttachmentRef): boolean {
  return isCanonicalAttachmentRef(attachment) && attachment.bytes <= MAX_ATTACHMENT_BYTES;
}

export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: MessageContent,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent;
  sourceMessages: readonly RootTurnSourceMessage[];
};
export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: null,
  sourceMessagesValue: unknown,
): {
  normalizedInput: null;
  sourceMessages: readonly RootTurnSourceMessage[];
};
export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: unknown,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent | null;
  sourceMessages: readonly RootTurnSourceMessage[];
};
export function normalizeRootTurnAdmissionPayload(
  normalizedInputValue: unknown,
  sourceMessagesValue: unknown,
): {
  normalizedInput: MessageContent | null;
  sourceMessages: readonly RootTurnSourceMessage[];
} {
  const sourceMessages = normalizeRootTurnSourceMessages(sourceMessagesValue);
  if (normalizedInputValue === null) {
    if (sourceMessages.length > 0) {
      throw new Error('Root turn admission without input cannot have source messages');
    }
    return { normalizedInput: null, sourceMessages };
  }
  const normalizedInputMaxAttachments =
    sourceMessages.length > 1
      ? ROOT_TURN_ADMISSION_MAX_AGGREGATED_ATTACHMENTS
      : MAX_ATTACHMENT_COUNT;
  const normalizedInput = normalizeRootTurnMessageContent(
    normalizedInputValue,
    'root turn normalized input',
    normalizedInputMaxAttachments,
  );
  if (sourceMessages.length > 0) {
    const expectedInput = normalizeRootTurnMessageContent(
      aggregateMessageContents(sourceMessages.map((source) => source.content)),
      'root turn aggregated source content',
      normalizedInputMaxAttachments,
    );
    if (!messageContentsEqual(normalizedInput, expectedInput)) {
      throw new Error('Root turn admission input content does not match source messages');
    }
  }
  const turnStartedCount = sourceMessages.filter(
    (source) => source.disposition === 'turn_started',
  ).length;
  if (turnStartedCount > 0 && (turnStartedCount !== 1 || sourceMessages.length !== 1)) {
    throw new Error('Root turn admission turn_started source must be the only source message');
  }
  return { normalizedInput, sourceMessages };
}

export function normalizeRootTurnSourceMessages(value: unknown): readonly RootTurnSourceMessage[] {
  if (!Array.isArray(value) || value.length > ROOT_TURN_ADMISSION_MAX_SOURCE_MESSAGES) {
    throw new Error('Invalid root turn source messages: expected a bounded array');
  }
  const messageIds = new Set<string>();
  const normalized = value.map((item, index): RootTurnSourceMessage => {
    if (
      !isPlainRecord(item) ||
      !hasExactKeys(item, [
        'messageId',
        'content',
        'placement',
        'disposition',
        ...(Object.hasOwn(item, 'submittedContentDigest') ? ['submittedContentDigest'] : []),
        ...(Object.hasOwn(item, 'submittedPlacement') ? ['submittedPlacement'] : []),
        ...(Object.hasOwn(item, 'submittedIntent') ? ['submittedIntent'] : []),
        ...(Object.hasOwn(item, 'skillInvocation') ? ['skillInvocation'] : []),
      ])
    ) {
      throw new Error(`Invalid root turn source message at index ${index}`);
    }
    const {
      messageId,
      content,
      submittedContentDigest,
      submittedPlacement,
      submittedIntent,
      skillInvocation,
      placement,
      disposition,
    } = item;
    if (
      typeof messageId !== 'string' ||
      !isSafeId(messageId) ||
      (placement !== 'current_turn' && placement !== 'next_turn') ||
      (disposition !== 'steering' &&
        disposition !== 'followup' &&
        disposition !== 'turn_started') ||
      (disposition === 'steering' && placement !== 'current_turn') ||
      (disposition === 'followup' && placement !== 'next_turn') ||
      (submittedPlacement !== undefined &&
        submittedPlacement !== 'current_turn' &&
        submittedPlacement !== 'next_turn') ||
      (submittedContentDigest !== undefined && !isSha256Digest(submittedContentDigest))
    ) {
      throw new Error(`Invalid root turn source message at index ${index}`);
    }
    if (messageIds.has(messageId)) {
      throw new Error(`Duplicate root turn source message id: ${messageId}`);
    }
    messageIds.add(messageId);
    return Object.freeze({
      messageId,
      content: normalizeRootTurnMessageContent(
        content,
        `root turn source message content at index ${index}`,
        MAX_ATTACHMENT_COUNT,
      ),
      ...(submittedContentDigest !== undefined ? { submittedContentDigest } : {}),
      ...(submittedPlacement !== undefined ? { submittedPlacement } : {}),
      ...(submittedIntent !== undefined
        ? { submittedIntent: normalizeSubmittedTurnIntent(submittedIntent) }
        : {}),
      ...(skillInvocation !== undefined
        ? { skillInvocation: decodeSkillInvocationResult(skillInvocation) }
        : {}),
      placement,
      disposition,
    });
  });
  return Object.freeze(normalized);
}

export function rootTurnAdmissionPayloadsEqual(
  left: RootTurnAdmission,
  right: RootTurnAdmission,
): boolean {
  return (
    isDeepStrictEqual(left.execution, right.execution) &&
    isDeepStrictEqual(left.turnOrchestration, right.turnOrchestration) &&
    isDeepStrictEqual(left.skillInvocation, right.skillInvocation) &&
    isDeepStrictEqual(left.authorization, right.authorization) &&
    (left.normalizedInput === null || right.normalizedInput === null
      ? left.normalizedInput === right.normalizedInput
      : messageContentsEqual(left.normalizedInput, right.normalizedInput)) &&
    left.sourceMessages.length === right.sourceMessages.length &&
    left.sourceMessages.every((source, index) => {
      const other = right.sourceMessages[index];
      return (
        other !== undefined &&
        source.messageId === other.messageId &&
        source.placement === other.placement &&
        source.disposition === other.disposition &&
        source.submittedContentDigest === other.submittedContentDigest &&
        (source.submittedPlacement ?? source.placement) ===
          (other.submittedPlacement ?? other.placement) &&
        submittedTurnIntentsEqual(source.submittedIntent, other.submittedIntent) &&
        isDeepStrictEqual(source.skillInvocation, other.skillInvocation) &&
        messageContentsEqual(source.content, other.content)
      );
    })
  );
}

export function assertRootTurnAdmissionRecordSize(admission: RootTurnAdmission): void {
  assertRootTurnAdmissionSerializedSize(`${JSON.stringify(admission)}\n`);
}

export function assertRootTurnAdmissionSerializedSize(serialized: string): void {
  if (Buffer.byteLength(serialized, 'utf8') > ROOT_TURN_ADMISSION_MAX_RECORD_BYTES) {
    throw new Error('Invalid root turn admission: record exceeds size limit');
  }
}

export function assertRootTurnAdmissionContract(admission: RootTurnAdmission): void {
  const execution = admission.execution;
  const providerRetry = execution.kind === 'linked_child_provider_retry';
  const inputlessExecution =
    execution.kind === 'safe_boundary_continuation' || execution.kind === 'context_compact';
  const sourceBatch = execution.kind === 'external_message' && admission.sourceMessages.length > 1;
  const messageLessExecution = inputlessExecution || providerRetry || sourceBatch;
  if (execution.kind === 'agent_graph_supervisor_wake') {
    if (
      admission.turnOrchestration?.mode !== 'graph' ||
      admission.turnOrchestration.source !== 'host_api'
    ) {
      throw new Error(
        'Invalid root turn admission contract: Agent Graph supervisor wake requires Host Graph orchestration',
      );
    }
  } else if (admission.turnOrchestration && execution.kind !== 'external_message') {
    throw new Error(
      'Invalid root turn admission contract: orchestration override is not authorized for this execution',
    );
  }
  if ((admission.userMessageId === null) !== messageLessExecution) {
    throw new Error(
      'Invalid root turn admission contract: execution has an invalid UserMessage requirement',
    );
  }
  if ((admission.normalizedInput === null) !== inputlessExecution) {
    throw new Error(
      'Invalid root turn admission contract: execution has an invalid input requirement',
    );
  }
  if (execution.kind !== 'external_message' && admission.sourceMessages.length !== 0) {
    throw new Error(
      'Invalid root turn admission contract: host-authored execution cannot have source messages',
    );
  }
  if (admission.skillInvocation && execution.kind !== 'external_message') {
    throw new Error(
      'Invalid root turn admission contract: Skill invocation requires external message execution',
    );
  }
  if (
    admission.authorization &&
    execution.kind !== 'external_message' &&
    execution.kind !== 'regenerate'
  ) {
    throw new Error(
      'Invalid root turn admission contract: authorization proof requires external message or regenerate execution',
    );
  }
  if (execution.kind === 'claimed_agent_graph_intent') {
    if (
      execution.claim.targetSessionId !== admission.sessionId ||
      execution.claim.targetTurnId !== admission.turnId ||
      execution.claim.targetRunId !== admission.runId
    ) {
      throw new Error(
        'Invalid root turn admission contract: agent graph claim target does not match admission identity',
      );
    }
    if (admission.userMessageId === null) {
      throw new Error(
        'Invalid root turn admission contract: agent graph execution requires a UserMessage',
      );
    }
  }
  if (
    (execution.kind === 'linked_child_resume' ||
      execution.kind === 'linked_child_provider_retry') &&
    execution.sourceRunId === admission.runId
  ) {
    throw new Error(
      'Invalid root turn admission contract: linked child source Run cannot be the admitted Run',
    );
  }
  if (
    execution.kind === 'safe_boundary_continuation' &&
    (execution.sourceRunId === admission.runId ||
      execution.sourceTurnId === admission.turnId ||
      execution.sourceInvocationId === execution.targetInvocationId ||
      admission.normalizedInput !== null)
  ) {
    throw new Error(
      'Invalid root turn admission contract: safe-boundary continuation identity is invalid',
    );
  }
  if (execution.kind === 'regenerate' && execution.sourceTurnId === admission.turnId) {
    throw new Error(
      'Invalid root turn admission contract: regenerate source Turn cannot be the admitted Turn',
    );
  }
  if (
    execution.kind === 'external_message' &&
    admission.sourceMessages.some(
      (source) =>
        source.disposition === 'turn_started' && source.messageId !== admission.userMessageId,
    )
  ) {
    throw new Error(
      'Invalid root turn admission contract: turn-started source must own the UserMessage',
    );
  }
}

export function deepFreezeRootTurnAdmission(admission: RootTurnAdmission): RootTurnAdmission {
  if (admission.execution.kind === 'claimed_agent_graph_intent') {
    Object.freeze(admission.execution.claim);
  }
  Object.freeze(admission.execution);
  if (admission.turnOrchestration) Object.freeze(admission.turnOrchestration);
  if (admission.skillInvocation) Object.freeze(admission.skillInvocation);
  if (admission.authorization) Object.freeze(admission.authorization);
  if (admission.normalizedInput) deepFreezeRootTurnMessageContent(admission.normalizedInput);
  for (const sourceMessage of admission.sourceMessages) {
    deepFreezeRootTurnMessageContent(sourceMessage.content);
    Object.freeze(sourceMessage);
  }
  Object.freeze(admission.sourceMessages);
  return Object.freeze(admission);
}

export function normalizeTurnOrchestration(value: unknown): TurnOrchestration | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['mode', 'source']) ||
    !isOrchestrationMode(value.mode) ||
    !isTurnOrchestrationSource(value.source)
  ) {
    throw new Error('Invalid root turn orchestration');
  }
  return Object.freeze({ mode: value.mode, source: value.source });
}

export function normalizeRootTurnAdmissionAuthorization(
  value: unknown,
): RootTurnAdmissionAuthorization | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'requestId',
      'principalId',
      'grantId',
      'approvedAt',
      'approvedBy',
    ]) ||
    value.kind !== 'session_turn_access_request' ||
    typeof value.requestId !== 'string' ||
    !isSafeId(value.requestId) ||
    typeof value.principalId !== 'string' ||
    !isGraphControlIdentity(value.principalId) ||
    typeof value.grantId !== 'string' ||
    !isSafeId(value.grantId) ||
    !Number.isSafeInteger(value.approvedAt) ||
    (value.approvedAt as number) < 0 ||
    typeof value.approvedBy !== 'string' ||
    !isGraphControlIdentity(value.approvedBy)
  ) {
    throw new Error('Invalid root turn admission authorization');
  }
  return Object.freeze({
    kind: value.kind,
    requestId: value.requestId,
    principalId: value.principalId,
    grantId: value.grantId,
    approvedAt: value.approvedAt as number,
    approvedBy: value.approvedBy,
  });
}

export function hasRootTurnAdmissionKeys(record: Record<string, unknown>): boolean {
  const keys = [
    'schemaVersion',
    'sessionId',
    'turnId',
    'runId',
    'userMessageId',
    'execution',
    'previousRootTurnId',
    'normalizedInput',
    'sourceMessages',
    'admittedAt',
  ];
  const optionalKeys = ['turnOrchestration', 'skillInvocation', 'authorization'].filter((key) =>
    Object.hasOwn(record, key),
  );
  return hasExactKeys(record, [...keys, ...optionalKeys]);
}

export function normalizeRootExecutionDescriptor(value: unknown): RootExecutionDescriptor {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Invalid root execution descriptor');
  }
  if (value.kind === 'external_message') {
    const allowedKeys = ['kind', 'inputDigest', 'maxSteps'];
    if (!Object.keys(value).every((key) => allowedKeys.includes(key))) {
      throw new Error('Invalid root execution descriptor');
    }
    if (value.inputDigest !== undefined && !isSha256Digest(value.inputDigest)) {
      throw new Error('Invalid root execution descriptor');
    }
    if (
      value.maxSteps !== undefined &&
      (typeof value.maxSteps !== 'number' ||
        !Number.isSafeInteger(value.maxSteps) ||
        value.maxSteps <= 0)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: 'external_message',
      ...(value.inputDigest !== undefined ? { inputDigest: value.inputDigest } : {}),
      ...(value.maxSteps !== undefined ? { maxSteps: value.maxSteps } : {}),
    });
  }
  if (value.kind === 'workhub_coordination') {
    if (
      !hasExactKeys(
        value,
        value.operation === undefined
          ? ['kind', 'inputDigest']
          : [
              'kind',
              'inputDigest',
              'operation',
              ...(value.actionId === undefined ? [] : ['actionId']),
            ],
      ) ||
      (value.operation !== undefined && value.operation !== 'action') ||
      (value.actionId !== undefined &&
        (typeof value.actionId !== 'string' || !isSafeId(value.actionId))) ||
      !isSha256Digest(value.inputDigest)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: 'workhub_coordination',
      ...(value.operation === 'action' ? { operation: 'action' as const } : {}),
      inputDigest: value.inputDigest,
      ...(typeof value.actionId === 'string' ? { actionId: value.actionId } : {}),
    });
  }
  if (value.kind === 'regenerate') {
    if (
      !hasExactKeys(value, ['kind', 'sourceTurnId']) ||
      typeof value.sourceTurnId !== 'string' ||
      !isSafeId(value.sourceTurnId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({ kind: 'regenerate', sourceTurnId: value.sourceTurnId });
  }
  if (value.kind === 'context_compact') {
    if (!hasExactKeys(value, ['kind'])) throw new Error('Invalid root execution descriptor');
    return Object.freeze({ kind: 'context_compact' });
  }
  if (value.kind === 'scheduled_task') {
    if (
      !hasExactKeys(value, [
        'kind',
        'scheduledTaskId',
        ...(Object.hasOwn(value, 'executionFingerprint') ? ['executionFingerprint'] : []),
      ]) ||
      typeof value.scheduledTaskId !== 'string' ||
      !isSafeId(value.scheduledTaskId) ||
      (value.executionFingerprint !== undefined && !isSha256Digest(value.executionFingerprint))
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: 'scheduled_task',
      scheduledTaskId: value.scheduledTaskId,
      ...(value.executionFingerprint !== undefined
        ? { executionFingerprint: value.executionFingerprint }
        : {}),
    });
  }
  if (value.kind === 'automation' || value.kind === 'legacy_automation') {
    if (
      !hasExactKeys(value, ['kind', 'automationId']) ||
      typeof value.automationId !== 'string' ||
      !isSafeId(value.automationId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({ kind: 'legacy_automation', automationId: value.automationId });
  }
  if (value.kind === 'goal') {
    if (
      !hasExactKeys(value, ['kind', 'goalId']) ||
      typeof value.goalId !== 'string' ||
      !isSafeId(value.goalId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({ kind: 'goal', goalId: value.goalId });
  }
  if (value.kind === 'agent_graph_supervisor_wake') {
    if (
      !hasExactKeys(value, ['kind', 'graphId', 'wakeId', 'attemptId']) ||
      typeof value.graphId !== 'string' ||
      !isGraphControlIdentity(value.graphId) ||
      typeof value.wakeId !== 'string' ||
      !isGraphControlIdentity(value.wakeId) ||
      !value.wakeId.startsWith(`${value.graphId}:`) ||
      typeof value.attemptId !== 'string' ||
      !isGraphControlIdentity(value.attemptId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: value.kind,
      graphId: value.graphId,
      wakeId: value.wakeId,
      attemptId: value.attemptId,
    });
  }
  if (value.kind === 'safe_boundary_continuation') {
    const keys = [
      'kind',
      'sourceInvocationId',
      'sourceRunId',
      'sourceTurnId',
      'sourceRuntimeEventHighWater',
      'claimId',
      'boundaryDigest',
      'providerReplayDigest',
      'safetyDigest',
      'targetInvocationId',
    ];
    if (
      !hasExactKeys(value, keys) ||
      typeof value.sourceInvocationId !== 'string' ||
      !isSafeId(value.sourceInvocationId) ||
      typeof value.sourceRunId !== 'string' ||
      !isSafeId(value.sourceRunId) ||
      typeof value.sourceTurnId !== 'string' ||
      !isSafeId(value.sourceTurnId) ||
      !Number.isSafeInteger(value.sourceRuntimeEventHighWater) ||
      (value.sourceRuntimeEventHighWater as number) < 1 ||
      typeof value.claimId !== 'string' ||
      !isSafeId(value.claimId) ||
      !isSha256Digest(value.boundaryDigest) ||
      !isSha256Digest(value.providerReplayDigest) ||
      !isSha256Digest(value.safetyDigest) ||
      typeof value.targetInvocationId !== 'string' ||
      !isSafeId(value.targetInvocationId)
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    return Object.freeze({
      kind: value.kind,
      sourceInvocationId: value.sourceInvocationId,
      sourceRunId: value.sourceRunId,
      sourceTurnId: value.sourceTurnId,
      sourceRuntimeEventHighWater: value.sourceRuntimeEventHighWater as number,
      claimId: value.claimId,
      boundaryDigest: value.boundaryDigest,
      providerReplayDigest: value.providerReplayDigest,
      safetyDigest: value.safetyDigest,
      targetInvocationId: value.targetInvocationId,
    });
  }
  if (value.kind === 'claimed_agent_graph_intent') {
    if (
      !hasExactKeys(value, ['kind', 'claim', 'agentId', 'agentName']) ||
      typeof value.agentId !== 'string' ||
      !isSafeId(value.agentId) ||
      typeof value.agentName !== 'string' ||
      value.agentName.length === 0 ||
      Buffer.byteLength(value.agentName, 'utf8') > 256
    ) {
      throw new Error('Invalid root execution descriptor');
    }
    let claim;
    try {
      claim = decodeAgentGraphIntentClaim(value.claim);
    } catch {
      throw new Error('Invalid root execution descriptor');
    }
    Object.freeze(claim);
    return Object.freeze({
      kind: value.kind,
      claim,
      agentId: value.agentId,
      agentName: value.agentName,
    });
  }
  if (
    value.kind !== 'linked_child_initial' &&
    value.kind !== 'linked_child_resume' &&
    value.kind !== 'linked_child_provider_retry'
  ) {
    throw new Error('Invalid root execution descriptor');
  }
  const hasSource = value.kind !== 'linked_child_initial';
  if (
    !hasExactKeys(
      value,
      hasSource
        ? ['kind', 'agentId', 'agentName', 'sourceRunId']
        : ['kind', 'agentId', 'agentName'],
    ) ||
    typeof value.agentId !== 'string' ||
    !isSafeId(value.agentId) ||
    typeof value.agentName !== 'string' ||
    value.agentName.length === 0 ||
    Buffer.byteLength(value.agentName, 'utf8') > 256 ||
    (hasSource && (typeof value.sourceRunId !== 'string' || !isSafeId(value.sourceRunId)))
  ) {
    throw new Error('Invalid root execution descriptor');
  }
  if (value.kind === 'linked_child_initial') {
    return Object.freeze({
      kind: value.kind,
      agentId: value.agentId,
      agentName: value.agentName,
    });
  }
  return Object.freeze({
    kind: value.kind,
    agentId: value.agentId,
    agentName: value.agentName,
    sourceRunId: value.sourceRunId as string,
  });
}

export function deepFreezeRootTurnMessageContent(content: MessageContent): void {
  for (const attachment of content.attachments ?? []) {
    Object.freeze(attachment.ref);
    Object.freeze(attachment);
  }
  if (content.attachments) Object.freeze(content.attachments);
  for (const reference of content.directoryReferences ?? []) Object.freeze(reference);
  if (content.directoryReferences) Object.freeze(content.directoryReferences);
  for (const quote of content.quotes ?? []) Object.freeze(quote);
  if (content.quotes) Object.freeze(content.quotes);
  Object.freeze(content);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

export function sanitizeJson(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
