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
  assertCoordinationIdentityPairing,
  buildSessionHeader,
  toSummary,
} from './session-store-values.js';
export {
  normalizeSessionHeader,
  decodePersistedSessionHeader,
  createUserMessage,
} from './session-store-values.js';
import {
  type VersionedSessionIdentity,
  SessionMetadataVersionConflictError,
  type SessionHeaderSnapshot,
  type ProbeSessionRemovalResult,
  type SessionCatalogRecord,
  type SessionCatalogPageCursor,
  EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS,
  EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS,
  type ExternalSessionImportLookupResult,
  type SessionCatalogPageResult,
  type CreateStableSessionRequest,
  type WorkHubMessageAssignmentRequest,
  type WorkHubMessageAssignmentResult,
  type CreateStableSessionResult,
  type ProbeStableSessionCreateResult,
  type UpdateSessionConfigurationRequest,
  type SessionTranscriptMessageLookupRequest,
  type SessionMessageScanRequest,
  type SessionMessageScanPage,
  type CoordinationTranscriptReference,
  type CoordinationTranscriptIndexRecord,
  type CoordinationTranscriptIndexState,
  type SessionAuthorityStore,
} from './session-store-contract.js';
export {
  isSafeSessionId,
  assertSafeSessionId,
  SessionNotFoundError,
  isSessionNotFoundError,
  type SessionHeaderSnapshot,
  type ProbeSessionRemovalResult,
  type SessionCatalogRecord,
  type SessionCatalogPageCursor,
  EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS,
  EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS,
  type ExternalSessionImportLookupResult,
  type SessionCatalogPageResult,
  type CreateStableSessionRequest,
  type WorkHubMessageAssignmentRequest,
  type WorkHubMessageAssignmentResult,
  type StableSessionCreateInput,
  type CreateStableSessionResult,
  type ProbeStableSessionCreateResult,
  type UpdateSessionConfigurationRequest,
  type SessionTranscriptStorageFragment,
  type SessionTranscriptMessageLookupRequest,
  type SessionMessageScanRequest,
  type SessionMessageScanRecord,
  type SessionMessageScanPage,
  type SessionTranscriptPageRequest,
  type SessionTranscriptStoragePage,
  type SessionTranscriptRecordScanRequest,
  type SessionTranscriptRecordScanPage,
  type SessionTurnContribution,
  type SessionTurnContributionPage,
  type SessionTurnLandmark,
  type SessionTurnLandmarkSnapshot,
  type SessionStore,
  type CoordinationTranscriptReference,
  type CoordinationTranscriptIndexRecord,
  type CoordinationTranscriptIndexState,
  type SessionAuthorityStore,
} from './session-store-contract.js';

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createSqliteSessionMetadataStore,
  type SessionCatalogRevisionState,
  type SessionMetadataRecord,
  type SessionRemovalProbe,
  type SqliteSessionMetadataStore,
  type StableSessionCreateProbe,
} from './sqlite-session-metadata-store.js';
import { isDiscardableConversationCopy } from './session-conversation-copy.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import { DEFAULT_SESSION_NAME, normalizeUserSessionName } from '@maka/core/session-name';
import {
  decodeCanonicalMessage,
  deriveTurnRecords,
  WORKHUB_COORDINATION_SESSION_ID,
} from '@maka/core/session';
import type {
  AgentGraphOperatorProvisionRequest,
  AgentGraphOperatorProvisionResult,
} from '@maka/core/agent-graph-topology';

import type {
  CreateSandboxBoundaryRequest,
  ExecutionBoundary,
  SandboxBoundaryRequest,
  SandboxBoundarySettlement,
  SettleSandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';

import type { CreateSessionInput, SessionListFilter } from '@maka/core/runtime-inputs';

import type {
  SessionHeader,
  SessionHeaderPatch,
  SessionExternalOrigin,
  SessionSummary,
  StoredMessage,
  TurnRecord,
  AssistantMessage,
  UserMessage,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationReplacementAbortedMessage,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubActionClaim,
  WorkHubActionClaimOutcome,
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
  WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import type {
  MarkMessagesHandedOffInput,
  PendingMessageAdmission,
} from './message-admission-store.js';
import { projectSessionCatalogMessages } from './session-message-projection.js';
export { projectSessionCatalogMessages };

export function createSessionStore(workspaceRoot: string): SessionAuthorityStore {
  return new SqliteSessionStore(workspaceRoot);
}

class SqliteSessionStore implements SessionAuthorityStore {
  private readonly metadata: SqliteSessionMetadataStore;
  private readonly workspaceRoot: string;
  private readonly transcriptChangeListeners = new Set<(sessionId: string) => void>();
  private closePromise: Promise<void> | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    const databaseLease = acquireOperationalStateDatabase(workspaceRoot);
    this.metadata = createSqliteSessionMetadataStore(
      join(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME),
      { databaseLease },
    );
  }

  private ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  ready(): Promise<void> {
    return this.ensureReady();
  }

  async create(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<SessionHeader> {
    await this.ensureReady();
    assertNoConversationCopyMetadata(input);
    if (input.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires createSubagent()');
    }
    return (
      await this.metadata.create(buildSessionHeader(this.workspaceRoot, input), initialBoundary)
    ).header;
  }

  async createImportedSession(
    input: CreateSessionInput,
    messages: readonly StoredMessage[],
    externalOrigin: SessionExternalOrigin,
  ): Promise<SessionHeader> {
    await this.ensureReady();
    assertNoConversationCopyMetadata(input);
    if (input.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires createSubagent()');
    }
    const canonicalMessages = messages.map((message) =>
      decodeCanonicalMessage(JSON.parse(JSON.stringify(message)) as unknown),
    );
    const header: SessionHeader = {
      ...buildSessionHeader(this.workspaceRoot, input),
      externalOrigin,
      transcriptLedgerVersion: 0,
    };
    const outcome = await this.metadata.importSession(
      header,
      canonicalMessages,
      projectSessionCatalogMessages(canonicalMessages),
    );
    if (outcome !== 'imported') {
      throw new Error(`Generated Session id already exists: ${header.id}`);
    }
    return (await this.metadata.read(header.id)).header;
  }

  async lookupExternalSessionImports(
    adapterId: string,
    sourceSessionIds: readonly string[],
    recentSessionIdLimit: number,
  ): Promise<readonly ExternalSessionImportLookupResult[]> {
    await this.ensureReady();
    if (typeof adapterId !== 'string' || adapterId.trim().length === 0) {
      throw new Error('External Session import lookup adapter id must not be empty');
    }
    if (
      !Array.isArray(sourceSessionIds) ||
      sourceSessionIds.length > EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS
    ) {
      throw new Error(
        `External Session import lookup accepts at most ${EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS} source ids`,
      );
    }
    const uniqueSourceSessionIds: string[] = [];
    const seen = new Set<string>();
    for (const sourceSessionId of sourceSessionIds) {
      if (typeof sourceSessionId !== 'string' || sourceSessionId.length === 0) {
        throw new Error('External Session import lookup source id must not be empty');
      }
      if (!seen.has(sourceSessionId)) {
        seen.add(sourceSessionId);
        uniqueSourceSessionIds.push(sourceSessionId);
      }
    }
    if (
      !Number.isSafeInteger(recentSessionIdLimit) ||
      recentSessionIdLimit < 1 ||
      recentSessionIdLimit > EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS
    ) {
      throw new Error(
        `External Session import lookup recent id limit must be between 1 and ${EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS}`,
      );
    }
    if (uniqueSourceSessionIds.length === 0) return [];
    return this.metadata.lookupExternalSessionImports(
      adapterId,
      uniqueSourceSessionIds,
      recentSessionIdLimit,
    );
  }

  async probeStableSessionCreate(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<ProbeStableSessionCreateResult> {
    await this.ensureReady();
    return projectStableSessionCreateProbe(
      await this.metadata.probeStableSessionCreate(sessionId, requestFingerprint),
    );
  }

  async createStableSession(
    request: CreateStableSessionRequest,
    initialBoundary?: ExecutionBoundary,
  ): Promise<CreateStableSessionResult> {
    await this.ensureReady();
    // Asserted here as well as in the header builder so a malformed request is
    // refused before claimStableSessionCreate() writes a durable claim for the
    // identity it names.
    assertCoordinationIdentityPairing(request.sessionId, request.input.role);
    if (
      request.input.conversationCopy &&
      request.input.conversationCopy.requestFingerprint !== request.requestFingerprint
    ) {
      throw new Error('Conversation copy fingerprint does not match the stable create request');
    }
    if (request.input.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires createSubagent()');
    }
    const probe = await this.metadata.claimStableSessionCreate(
      request.sessionId,
      request.requestFingerprint,
    );
    if (probe.kind === 'existing') {
      return { kind: 'existing', record: projectHeaderSnapshot(probe.record) };
    }
    if (probe.kind === 'conflict') return probe;

    const result = await this.metadata.createStableSession(
      buildSessionHeader(
        this.workspaceRoot,
        request.input,
        request.sessionId,
        request.input.conversationCopy,
      ),
      request.requestFingerprint,
      initialBoundary,
    );
    return result.kind === 'created' || result.kind === 'existing'
      ? { kind: result.kind, record: projectHeaderSnapshot(result.record) }
      : result;
  }

  async assignWorkHubMessage(
    request: WorkHubMessageAssignmentRequest,
  ): Promise<WorkHubMessageAssignmentResult> {
    await this.ensureReady();
    const create = request.create;
    if (create) {
      assertCoordinationIdentityPairing(create.sessionId, create.input.role);
      if (create.sessionId !== request.assignment.targetSessionId) {
        throw new Error('WorkHub assignment create identity does not match its target');
      }
    }
    const result = await this.metadata.assignWorkHubMessage({
      assignment: request.assignment,
      admission: request.admission,
      projection: projectSessionCatalogMessages([request.assignment]),
      ...(request.supersession ? { supersession: request.supersession } : {}),
      ...(create
        ? {
            create: {
              header: buildSessionHeader(
                this.workspaceRoot,
                create.input,
                create.sessionId,
                create.input.conversationCopy,
              ),
              requestFingerprint: create.requestFingerprint,
            },
          }
        : {}),
    });
    if (result.kind === 'assigned') {
      for (const listener of this.transcriptChangeListeners) {
        listener(WORKHUB_COORDINATION_SESSION_ID);
      }
    }
    return result;
  }

  async readWorkHubAssignment(
    actionId: string,
  ): Promise<WorkHubDelegationAssignedMessage | undefined> {
    const message = await this.readWorkHubCoordinationMessage(
      `wha_${workHubIdentitySuffix(actionId)}`,
    );
    return message?.type === 'workhub_coordination' && message.kind === 'delegation_assigned'
      ? message
      : undefined;
  }

  async readActiveWorkHubAssignmentsByTarget(
    targetSessionIds: readonly string[],
    maxAssignmentsPerTarget?: number,
  ): Promise<readonly WorkHubDelegationAssignedMessage[]> {
    await this.ensureReady();
    return this.metadata.readActiveWorkHubAssignmentsByTarget(
      targetSessionIds,
      maxAssignmentsPerTarget,
    );
  }

  async readWorkHubReplacement(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementRequestedMessage | undefined> {
    const message = await this.readWorkHubCoordinationMessage(
      `whp_${workHubIdentitySuffix(delegationId)}`,
    );
    return message?.type === 'workhub_coordination' &&
      message.kind === 'delegation_replacement_requested'
      ? message
      : undefined;
  }

  async readWorkHubReplacementAbort(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementAbortedMessage | undefined> {
    const message = await this.readWorkHubCoordinationMessage(
      `whb_${workHubIdentitySuffix(delegationId)}`,
    );
    return message?.type === 'workhub_coordination' &&
      message.kind === 'delegation_replacement_aborted'
      ? message
      : undefined;
  }

  async readWorkHubSupersession(
    delegationId: string,
  ): Promise<WorkHubDelegationSupersededMessage | undefined> {
    const message = await this.readWorkHubCoordinationMessage(
      `whx_${workHubIdentitySuffix(delegationId)}`,
    );
    return message?.type === 'workhub_coordination' && message.kind === 'delegation_superseded'
      ? message
      : undefined;
  }

  async readWorkHubStopRequest(
    delegationId: string,
  ): Promise<WorkHubDelegationStopRequestedMessage | undefined> {
    const message = await this.readWorkHubCoordinationMessage(
      `whq_${workHubIdentitySuffix(delegationId)}`,
    );
    return message?.type === 'workhub_coordination' && message.kind === 'delegation_stop_requested'
      ? message
      : undefined;
  }

  async readWorkHubStopResolution(
    delegationId: string,
  ): Promise<WorkHubDelegationStopResolvedMessage | undefined> {
    const message = await this.readWorkHubCoordinationMessage(
      `whz_${workHubIdentitySuffix(delegationId)}`,
    );
    return message?.type === 'workhub_coordination' && message.kind === 'delegation_stop_resolved'
      ? message
      : undefined;
  }

  async claimWorkHubAction(claim: WorkHubActionClaim): Promise<WorkHubActionClaimOutcome> {
    await this.ensureReady();
    return this.metadata.claimWorkHubAction(claim);
  }

  async readWorkHubActionClaim(actionId: string): Promise<WorkHubActionClaim | undefined> {
    await this.ensureReady();
    return this.metadata.readWorkHubActionClaim(actionId);
  }

  private async readWorkHubCoordinationMessage(
    messageId: string,
  ): Promise<StoredMessage | undefined> {
    await this.ensureReady();
    return this.metadata.readMessageById(WORKHUB_COORDINATION_SESSION_ID, messageId);
  }

  async discardStableConversationCopy(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<boolean> {
    await this.ensureReady();
    if (!(await this.metadata.hasStableSessionCreateClaim(sessionId, requestFingerprint))) {
      throw new Error('Session is not owned by the matching stable create request');
    }
    const probe = await this.metadata.probeStableSessionCreate(sessionId, requestFingerprint);
    if (probe.kind === 'conflict') {
      throw new Error('Stable Session identity belongs to a different request');
    }
    if (probe.kind === 'existing') {
      const copy = probe.record.header.conversationCopy;
      if (
        copy?.requestFingerprint !== requestFingerprint ||
        !isDiscardableConversationCopy(probe.record.header)
      ) {
        throw new Error('Only a matching incomplete conversation copy can be discarded');
      }
    }
    return this.metadata.discardStableSessionCreate(sessionId, requestFingerprint);
  }

  async createSubagent(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader; created: boolean }> {
    await this.ensureReady();
    assertNoConversationCopyMetadata(input);
    const result = await this.metadata.createSubagent(
      buildSessionHeader(this.workspaceRoot, input),
      initialBoundary,
    );
    return { header: result.record.header, created: result.created };
  }

  async createAgentGraphOperator(
    input: CreateSessionInput,
    request: AgentGraphOperatorProvisionRequest,
    expectedRevision: number,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader } & AgentGraphOperatorProvisionResult> {
    await this.ensureReady();
    assertNoConversationCopyMetadata(input);
    const result = await this.metadata.createAgentGraphOperator(
      buildSessionHeader(this.workspaceRoot, input),
      request,
      expectedRevision,
      initialBoundary,
    );
    return {
      header: result.record.header,
      provision: result.provision,
      created: result.created,
    };
  }

  async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary> {
    await this.ensureReady();
    return this.metadata.readExecutionBoundary(sessionId);
  }

  async createSandboxBoundaryRequest(
    input: CreateSandboxBoundaryRequest,
  ): Promise<SandboxBoundaryRequest> {
    await this.ensureReady();
    return this.metadata.createSandboxBoundaryRequest(input);
  }

  async readSandboxBoundaryRequest(
    sessionId: string,
    requestId: string,
  ): Promise<SandboxBoundaryRequest | undefined> {
    await this.ensureReady();
    return this.metadata.readSandboxBoundaryRequest(sessionId, requestId);
  }

  async listPendingSandboxBoundaryRequests(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    await this.ensureReady();
    return this.metadata.listPendingSandboxBoundaryRequests(sessionId);
  }

  async listSandboxBoundaryRestartClosures(sessionId: string): Promise<SandboxBoundaryRequest[]> {
    await this.ensureReady();
    return this.metadata.listSandboxBoundaryRestartClosures(sessionId);
  }

  async hasExplicitSandboxBoundaryDenial(
    identities: readonly { sessionId: string; runId: string; turnId: string }[],
  ): Promise<boolean> {
    await this.ensureReady();
    return this.metadata.hasExplicitSandboxBoundaryDenial(identities);
  }

  async settleSandboxBoundaryRequest(
    input: SettleSandboxBoundaryRequest,
  ): Promise<SandboxBoundarySettlement> {
    await this.ensureReady();
    return this.metadata.settleSandboxBoundaryRequest(input);
  }

  async setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ): Promise<ExecutionBoundary> {
    await this.ensureReady();
    return this.metadata.setExecutionBoundaryKind(sessionId, kind, projection);
  }

  async list(filter?: SessionListFilter): Promise<SessionSummary[]> {
    await this.ensureReady();
    return (await this.metadata.list(filter, 'ordinary'))
      .filter((record) => record.header.conversationCopy?.state !== 'preparing')
      .map((record) => toCatalogSummary(record.header, record.lastMessagePreview));
  }

  async listCatalogPage(
    filter: SessionListFilter | undefined,
    cursor: SessionCatalogPageCursor | undefined,
    limit: number,
    expectedRevision?: `sha256:${string}`,
  ): Promise<SessionCatalogPageResult> {
    await this.ensureCatalogProjectionReadable();
    const page = await this.metadata.listCatalogPage(filter ?? {}, cursor, limit);
    const revision = projectCatalogRevision(page.revision);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return {
        kind: 'revision_changed',
        expectedRevision,
        actualRevision: revision,
      };
    }

    return {
      kind: 'page',
      revision,
      records: page.records.map((record) => ({
        ...projectHeaderSnapshot(record),
        activityAt: record.activityAt,
        summary: toCatalogSummary(record.header, record.lastMessagePreview),
      })),
      hasMore: page.hasMore,
    };
  }

  async listForRecovery(): Promise<SessionHeader[]> {
    return this.listHeaders();
  }

  async listHeaders(): Promise<SessionHeader[]> {
    await this.ensureReady();
    return (await this.metadata.list(undefined, 'recoverable'))
      .map((record) => record.header)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async readHeaderSnapshot(sessionId: string): Promise<SessionHeader> {
    return (await this.readHeaderRecordSnapshot(sessionId)).header;
  }

  async readHeaderRecordSnapshot(sessionId: string): Promise<SessionHeaderSnapshot> {
    await this.ensureReady();
    // `maka --resume <legacy-id>` reads the header before any list; the
    // import runs in ensureReady, so the first post-upgrade resume of a
    // pre-cutover session sees its imported rows.
    return projectHeaderSnapshot(await this.metadata.read(sessionId));
  }

  async readCatalogRecord(
    sessionId: string,
    roleScope: 'ordinary' | 'recoverable' = 'ordinary',
  ): Promise<SessionCatalogRecord> {
    await this.ensureCatalogProjectionReadable();
    const record = await this.metadata.readCatalogRecord(sessionId, roleScope);
    return {
      ...projectHeaderSnapshot(record),
      activityAt: record.activityAt,
      summary: toCatalogSummary(record.header, record.lastMessagePreview),
    };
  }

  async readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]> {
    await this.ensureReady();
    return this.metadata.readMessages(sessionId);
  }

  async readTranscriptMessagesSnapshot(
    sessionId: string,
    request: SessionTranscriptMessageLookupRequest,
  ): Promise<StoredMessage[]> {
    await this.ensureReady();
    return this.metadata.readTranscriptMessages(sessionId, request);
  }

  async readTranscriptHighWaterSnapshot(sessionId: string): Promise<number | null> {
    await this.ensureReady();
    return this.metadata.readTranscriptHighWater(sessionId);
  }

  async readCoordinationTranscriptIndexState(): Promise<CoordinationTranscriptIndexState> {
    await this.ensureReady();
    return this.metadata.readCoordinationTranscriptIndexState();
  }

  async appendCoordinationTranscriptIndex(
    records: readonly CoordinationTranscriptReference[],
  ): Promise<void> {
    await this.ensureReady();
    return this.metadata.appendCoordinationTranscriptIndex(records);
  }

  async readCoordinationTranscriptIndex(request: {
    direction: 'older' | 'newer';
    throughSequence: number;
    position: number;
    limit: number;
  }): Promise<readonly CoordinationTranscriptIndexRecord[]> {
    await this.ensureReady();
    return this.metadata.readCoordinationTranscriptIndex(request);
  }

  async listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessagesSnapshot(sessionId));
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    return this.readHeaderSnapshot(sessionId);
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.readMessagesSnapshot(sessionId);
  }

  async readMessagesAfter(
    sessionId: string,
    request: SessionMessageScanRequest,
  ): Promise<SessionMessageScanPage> {
    await this.ensureReady();
    return this.metadata.readMessagesAfter(sessionId, request);
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.ensureReady();
    await this.metadata.appendMessages(
      sessionId,
      messages,
      projectSessionCatalogMessages(messages),
    );
    for (const listener of this.transcriptChangeListeners) listener(sessionId);
  }

  /** @see SqliteSessionMetadataStore.commitMessageCatalogProjection */
  async commitMessageCatalogProjection(
    sessionId: string,
    message: UserMessage | AssistantMessage,
  ): Promise<void> {
    await this.ensureReady();
    await this.metadata.commitMessageCatalogProjection(sessionId, message);
  }

  async commitMessageAdmission(
    admission: PendingMessageAdmission,
  ): Promise<PendingMessageAdmission> {
    await this.ensureReady();
    return this.metadata.commitMessageAdmission(admission);
  }

  async readMessageAdmission(
    sessionId: string,
    messageId: string,
  ): Promise<PendingMessageAdmission | undefined> {
    await this.ensureReady();
    return this.metadata.readMessageAdmission(sessionId, messageId);
  }

  async hasCancelledMessageAdmission(sessionId: string, messageId: string): Promise<boolean> {
    await this.ensureReady();
    return this.metadata.hasCancelledMessageAdmission(sessionId, messageId);
  }

  async claimMessageAdmissionCancellation(sessionId: string, messageId: string, claimId: string) {
    await this.ensureReady();
    return this.metadata.claimMessageAdmissionCancellation(sessionId, messageId, claimId);
  }

  async listMessageAdmissions(sessionId: string): Promise<readonly PendingMessageAdmission[]> {
    await this.ensureReady();
    return this.metadata.listMessageAdmissions(sessionId);
  }

  async markMessagesHandedOff(input: MarkMessagesHandedOffInput): Promise<void> {
    await this.ensureReady();
    await this.metadata.markMessagesHandedOff(input);
    for (const listener of this.transcriptChangeListeners) listener(input.sessionId);
  }

  async updateMessageAdmission(admission: PendingMessageAdmission): Promise<void> {
    await this.ensureReady();
    await this.metadata.updateMessageAdmission(admission);
  }

  async reorderMessageAdmissions(sessionId: string, messageIds: readonly string[]): Promise<void> {
    await this.ensureReady();
    await this.metadata.reorderMessageAdmissions(sessionId, messageIds);
  }

  async cancelMessageAdmissions(sessionId: string, messageIds: readonly string[]): Promise<void> {
    await this.ensureReady();
    await this.metadata.cancelMessageAdmissions(sessionId, messageIds);
  }

  subscribeTranscriptChanges(listener: (sessionId: string) => void): () => void {
    this.transcriptChangeListeners.add(listener);
    return () => this.transcriptChangeListeners.delete(listener);
  }

  async updateHeader(sessionId: string, patch: SessionHeaderPatch): Promise<SessionHeader> {
    await this.ensureReady();
    return (await this.metadata.update(sessionId, patch)).header;
  }

  async updateHeaderVersioned(
    sessionId: string,
    patch: SessionHeaderPatch,
    expectedRevision: number,
  ): Promise<SessionHeaderSnapshot> {
    await this.ensureReady();
    return projectHeaderSnapshot(
      await this.metadata.update(sessionId, patch, {
        expectedVersion: expectedRevision,
        skipNoop: true,
      }),
    );
  }

  async updateSessionConfiguration(
    sessionId: string,
    input: UpdateSessionConfigurationRequest,
  ): Promise<SessionHeaderSnapshot> {
    await this.ensureReady();
    return projectHeaderSnapshot(await this.metadata.updateSessionConfiguration(sessionId, input));
  }

  async probeSessionRemoval(sessionId: string): Promise<ProbeSessionRemovalResult> {
    await this.ensureReady();
    return projectRemovalProbe(await this.metadata.probeRemoval(sessionId));
  }

  async setSessionsArchivedVersioned(
    sessions: readonly VersionedSessionIdentity[],
    isArchived: boolean,
  ): Promise<SessionHeaderSnapshot[]> {
    await this.ensureReady();
    return (await this.metadata.setArchivedVersioned(sessions, isArchived)).map(
      projectHeaderSnapshot,
    );
  }

  async removeSessionsVersioned(
    sessions: readonly VersionedSessionIdentity[],
    archiveSessions: readonly VersionedSessionIdentity[] = [],
  ): Promise<string[]> {
    await this.ensureReady();
    return this.metadata.removeVersioned(sessions, archiveSessions);
  }

  async reconcileOrphanedAgentGraphRetirements(): Promise<string[]> {
    await this.ensureReady();
    return this.metadata.reconcileOrphanedAgentGraphRetirements();
  }

  async listPendingSessionRetirementCleanupIds(sessionId?: string): Promise<string[]> {
    await this.ensureReady();
    return this.metadata.listPendingSessionRetirementCleanupIds(sessionId);
  }

  async completeSessionRetirementCleanup(sessionId: string): Promise<void> {
    await this.ensureReady();
    await this.metadata.completeSessionRetirementCleanup(sessionId);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.updateHeader(sessionId, { isFlagged });
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const normalized = normalizeUserSessionName(name);
    if (!normalized.ok) throw new Error(normalized.error);
    await this.updateHeader(sessionId, {
      name: normalized.value,
      titleIsManual: true,
    });
  }

  async setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null> {
    const normalized = normalizeUserSessionName(title);
    if (!normalized.ok) return null;
    // A generated title only ever fills an absence. Writing at the revision the
    // check read makes a rename that lands between the two a winner rather than
    // something this silently overwrites; a revision that moved for any other
    // reason is re-read, so losing the race stays the only way to answer null.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await this.readHeaderRecordSnapshot(sessionId);
      const current = record.header;
      if (
        current.titleIsManual ||
        current.name !== DEFAULT_SESSION_NAME ||
        normalized.value === current.name
      ) {
        return null;
      }
      try {
        return (
          await this.updateHeaderVersioned(sessionId, { name: normalized.value }, record.revision)
        ).header;
      } catch (error) {
        if (!(error instanceof SessionMetadataVersionConflictError)) throw error;
      }
    }
    // Losing the race every attempt reads the same as losing it once: the
    // Session keeps whichever name the writer that won gave it.
    return null;
  }

  async remove(sessionId: string): Promise<void> {
    await this.ensureReady();
    await this.metadata.remove(sessionId);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeAfterReady();
    return this.closePromise;
  }

  private async closeAfterReady(): Promise<void> {
    // Ensure the one-time import has settled before closing the database so
    // a concurrent close cannot race an in-flight migration.
    await this.ensureReady();
    this.metadata.close();
  }

  private async ensureCatalogProjectionReadable(): Promise<void> {
    await this.ensureReady();
  }
}

function workHubIdentitySuffix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 48);
}

/**
 * The reserved identity and the reserved role are one fact, and the invariant
 * belongs to every creator that builds a header — subagents and Agent Graph
 * operators included, whose inputs carry no role today.
 */
function assertNoConversationCopyMetadata(input: CreateSessionInput): void {
  if (Object.prototype.hasOwnProperty.call(input, 'conversationCopy')) {
    throw new Error('Conversation copy metadata requires createStableSession()');
  }
}

function projectHeaderSnapshot(record: SessionMetadataRecord): SessionHeaderSnapshot {
  return {
    header: record.header,
    revision: record.metadataVersion,
    committedAt: record.committedAt,
  };
}

function projectRemovalProbe(probe: SessionRemovalProbe): ProbeSessionRemovalResult {
  return probe.kind === 'present'
    ? { kind: 'present', record: projectHeaderSnapshot(probe.record) }
    : probe;
}

function projectCatalogRevision(state: SessionCatalogRevisionState): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(`${state.epoch}:${state.generation}`)
    .digest('hex')}`;
}

function projectStableSessionCreateProbe(
  probe: StableSessionCreateProbe,
): ProbeStableSessionCreateResult {
  return probe.kind === 'existing'
    ? { kind: 'existing', record: projectHeaderSnapshot(probe.record) }
    : probe;
}

function toCatalogSummary(
  header: SessionHeader,
  lastMessagePreview: string | undefined,
): SessionSummary {
  return {
    ...toSummary(header),
    ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
  };
}
