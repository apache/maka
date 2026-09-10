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
  SessionConversationCopy,
  SessionExternalOrigin,
  SessionSummary,
  SessionRole,
  StoredMessage,
  TurnRecord,
  TurnStateMessage,
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
import type { MessageAdmissionStore, PendingMessageAdmission } from './message-admission-store.js';

/**
 * Local Session persistence contract. Implementations own atomic domain writes;
 * consumers do not receive a database handle or a generic transaction callback.
 * This is the live-state boundary, not the immutable checkpoint Repository.
 */

export interface VersionedSessionIdentity {
  readonly sessionId: string;
  readonly expectedVersion: number;
}

export interface SessionConfigurationMetadataUpdate {
  readonly expectedVersion: number;
  readonly configuration: {
    readonly backend: SessionHeader['backend'];
    readonly llmConnectionId: string;
    readonly llmConnectionSlug: string;
    readonly connectionLocked: boolean;
    readonly model: string;
    readonly thinkingLevel: SessionHeader['thinkingLevel'];
    readonly permissionMode: SessionHeader['permissionMode'];
    readonly collaborationMode: NonNullable<SessionHeader['collaborationMode']>;
    readonly orchestrationMode: NonNullable<SessionHeader['orchestrationMode']>;
    readonly labels: readonly string[];
  };
  readonly lifecycle:
    | { readonly kind: 'preserve' }
    | {
        readonly kind: 'clear_connection_block';
        readonly statusUpdatedAt: number;
      };
}

export class SessionMetadataConflictError extends Error {
  readonly name: string = 'SessionMetadataConflictError';
}

export class AgentGraphIntentClaimConflictError extends SessionMetadataConflictError {
  readonly name = 'AgentGraphIntentClaimConflictError';
}

export class AgentGraphScheduleUpdateConflictError extends SessionMetadataConflictError {
  readonly name = 'AgentGraphScheduleUpdateConflictError';
}

export class SessionMetadataVersionConflictError extends SessionMetadataConflictError {
  readonly name = 'SessionMetadataVersionConflictError';

  constructor(
    readonly sessionId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Session metadata version conflict for ${sessionId}: expected ${expectedVersion}, found ${actualVersion}`,
    );
  }
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) throw new Error(`Invalid Session id: ${sessionId}`);
}
export class SessionNotFoundError extends Error {
  readonly name = 'SessionNotFoundError';
  readonly code = 'session_not_found';

  constructor(readonly sessionId: string) {
    super(`Session metadata not found: ${sessionId}`);
  }
}

export function isSessionNotFoundError(error: unknown): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError;
}

export interface SessionHeaderSnapshot {
  readonly header: SessionHeader;
  readonly revision: number;
  readonly committedAt: number;
}

export type ProbeSessionRemovalResult =
  | { readonly kind: 'present'; readonly record: SessionHeaderSnapshot }
  | { readonly kind: 'removed' }
  | { readonly kind: 'absent' };

export interface SessionCatalogRecord extends SessionHeaderSnapshot {
  readonly activityAt: number;
  readonly summary: SessionSummary;
}

export interface SessionCatalogPageCursor {
  readonly activityAt: number;
  readonly sessionId: string;
}

export const EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS = 256;
export const EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS = 16;

export interface ExternalSessionImportLookupResult {
  readonly sourceSessionId: string;
  readonly livePublishedImportCount: number;
  readonly recentSessionIds: readonly string[];
}

export type SessionCatalogPageResult =
  | {
      readonly kind: 'page';
      readonly revision: `sha256:${string}`;
      readonly records: readonly SessionCatalogRecord[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: `sha256:${string}`;
      readonly actualRevision: `sha256:${string}`;
    };

export interface CreateStableSessionRequest {
  readonly sessionId: string;
  readonly requestFingerprint: string;
  readonly input: StableSessionCreateInput;
}

export interface WorkHubMessageAssignmentRequest {
  readonly assignment: WorkHubDelegationAssignedMessage;
  readonly admission: PendingMessageAdmission;
  /** Present exactly when this assignment atomically supersedes an earlier link. */
  readonly supersession?: WorkHubDelegationSupersededMessage;
  /** Present exactly when the assignment creates its target Session. */
  readonly create?: CreateStableSessionRequest;
}

export interface WorkHubMessageAssignmentResult {
  readonly kind: 'assigned' | 'existing';
  readonly targetCreated: boolean;
  readonly assignment: WorkHubDelegationAssignedMessage;
}

export type StableSessionCreateInput = CreateSessionInput & {
  readonly conversationCopy?: SessionConversationCopy;
  readonly role?: SessionRole;
};

export type CreateStableSessionResult =
  | { readonly kind: 'created'; readonly record: SessionHeaderSnapshot }
  | { readonly kind: 'existing'; readonly record: SessionHeaderSnapshot }
  | {
      readonly kind: 'conflict';
      readonly reason: 'identity_mismatch' | 'removed';
    };

export type ProbeStableSessionCreateResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'existing'; readonly record: SessionHeaderSnapshot }
  | {
      readonly kind: 'conflict';
      readonly reason: 'identity_mismatch' | 'removed';
    };

export type UpdateSessionConfigurationRequest = SessionConfigurationMetadataUpdate;

export interface SessionTranscriptStorageFragment {
  readonly sequence: number;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly payloadDigest: `sha256:${string}` | null;
  readonly data: Buffer;
}

export interface SessionTranscriptMessageLookupRequest {
  readonly messageIds: readonly string[];
  readonly throughSequence: number | null;
  readonly maxBytes: number;
  readonly maxMessages: number;
}

/**
 * One page of a Session's legacy rows, for the converter that lifts history onto
 * the ledger and for coordination facts merged with Runtime history through the
 * WorkHub transcript index.
 */
export interface SessionMessageScanRequest {
  /** Exclusive lower bound; omit to start at the first row. */
  readonly afterSequence?: number;
  /**
   * Walk towards older rows instead, from this exclusive upper bound. Records
   * then come back newest first, so the byte budget truncates at the older end,
   * which is the end the walk is heading for. Pass at most one bound.
   */
  readonly beforeSequence?: number;
  readonly maxStoredBytes: number;
  readonly maxMessages: number;
}

export interface SessionMessageScanRecord {
  readonly sequence: number;
  readonly message: StoredMessage;
}

export interface SessionMessageScanPage {
  readonly records: readonly SessionMessageScanRecord[];
  /**
   * The Session's last legacy sequence. It rides along with every page so the
   * converter can place a turn relative to the whole transcript without a read
   * that is proportional to it.
   */
  readonly highWaterSequence: number | null;
}

export interface SessionTranscriptPageRequest {
  readonly direction: 'older' | 'newer';
  /** Inclusive durable high-water mark. Omit only for the first read. */
  readonly throughSequence?: number | null;
  /** Inclusive sequence position for this read. Defaults to the watermark edge. */
  readonly position?: number;
  /** Continuation byte offset within position. */
  readonly byteOffset?: number;
  readonly maxBytes: number;
  readonly maxMessages: number;
}

export interface SessionTranscriptStoragePage {
  readonly throughSequence: number | null;
  /** Returned in traversal order for the requested direction. */
  readonly fragments: readonly SessionTranscriptStorageFragment[];
  readonly rawBytes: number;
  readonly next: {
    readonly position: number;
    readonly byteOffset: number | null;
  } | null;
}

export interface SessionTranscriptRecordScanRequest {
  readonly direction: 'older' | 'newer';
  readonly throughSequence?: number | null;
  readonly position?: number;
  readonly maxStoredBytes: number;
  readonly maxMessages: number;
}

export interface SessionTranscriptRecordScanPage {
  readonly throughSequence: number | null;
  readonly records: readonly { readonly sequence: number; readonly message: StoredMessage }[];
  readonly nextPosition: number | null;
}

export interface SessionTurnContribution {
  readonly turnId: string;
  readonly firstSequence: number;
  readonly latestState: {
    readonly sequence: number;
    readonly message: TurnStateMessage;
  } | null;
  readonly userPromptPreview: string | null;
}

export interface SessionTurnContributionPage {
  readonly throughSequence: number | null;
  readonly contributions: readonly SessionTurnContribution[];
  readonly nextPosition: number | null;
}

export interface SessionTurnLandmark {
  readonly turnId: string;
  readonly sequence: number;
  readonly label: string;
}

export interface SessionTurnLandmarkSnapshot {
  readonly throughSequence: number | null;
  readonly landmarks: readonly SessionTurnLandmark[];
}

export interface SessionStore {
  create(input: CreateSessionInput, initialBoundary?: ExecutionBoundary): Promise<SessionHeader>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  /** Enumerate durable metadata without reading transcript bodies. */
  listHeaders(): Promise<SessionHeader[]>;
  listForRecovery(): Promise<SessionHeader[]>;
  /** Read only the durable header without triggering connection-lock self-healing. */
  readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
  readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]>;
  readTranscriptHighWaterSnapshot(sessionId: string): Promise<number | null>;
  listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  readMessagesAfter(
    sessionId: string,
    request: SessionMessageScanRequest,
  ): Promise<SessionMessageScanPage>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void>;
  /** Commit the Session-list facts a durable message carries. */
  commitMessageCatalogProjection(
    sessionId: string,
    message: UserMessage | AssistantMessage,
  ): Promise<void>;
  updateHeader(sessionId: string, patch: SessionHeaderPatch): Promise<SessionHeader>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null>;
  remove(sessionId: string): Promise<void>;
  close?(): Promise<void>;
}

/** Rebuildable ordering only; the message body remains in its original store. */
export interface CoordinationTranscriptReference {
  readonly source: 'legacy' | 'runtime';
  readonly sourceSequence: number;
}
export interface CoordinationTranscriptIndexRecord extends CoordinationTranscriptReference {
  readonly sequence: number;
}
export interface CoordinationTranscriptIndexState {
  readonly highWater: number | null;
  readonly legacy: number | null;
  readonly runtime: number | null;
}

export interface SessionAuthorityStore extends SessionStore, MessageAdmissionStore {
  readCoordinationTranscriptIndexState(): Promise<CoordinationTranscriptIndexState>;
  appendCoordinationTranscriptIndex(
    records: readonly CoordinationTranscriptReference[],
  ): Promise<void>;
  readCoordinationTranscriptIndex(request: {
    direction: 'older' | 'newer';
    throughSequence: number;
    position: number;
    limit: number;
  }): Promise<readonly CoordinationTranscriptIndexRecord[]>;
  /** Read a bounded set of durable messages at an inclusive transcript watermark. */
  readTranscriptMessagesSnapshot(
    sessionId: string,
    request: SessionTranscriptMessageLookupRequest,
  ): Promise<StoredMessage[]>;
  /**
   * Instance-local invalidation after successful ledger appends, not a durable
   * changefeed or a guarantee about remote writers. Listeners must not throw.
   */
  subscribeTranscriptChanges(listener: (sessionId: string) => void): () => void;
  /** Wait until the durable authority is ready for cross-domain transactions. */
  ready(): Promise<void>;
  /** Atomically create a Session from already-converted Maka raw messages. */
  createImportedSession(
    input: CreateSessionInput,
    messages: readonly StoredMessage[],
    externalOrigin: SessionExternalOrigin,
  ): Promise<SessionHeader>;
  /** Look up live published imports for a bounded page of source Sessions. */
  lookupExternalSessionImports(
    adapterId: string,
    sourceSessionIds: readonly string[],
    recentSessionIdLimit: number,
  ): Promise<readonly ExternalSessionImportLookupResult[]>;
  createSubagent(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader; created: boolean }>;
  createAgentGraphOperator(
    input: CreateSessionInput,
    request: AgentGraphOperatorProvisionRequest,
    expectedRevision: number,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader } & AgentGraphOperatorProvisionResult>;
  readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary>;
  createSandboxBoundaryRequest(
    input: CreateSandboxBoundaryRequest,
  ): Promise<SandboxBoundaryRequest>;
  readSandboxBoundaryRequest(
    sessionId: string,
    requestId: string,
  ): Promise<SandboxBoundaryRequest | undefined>;
  listPendingSandboxBoundaryRequests(sessionId: string): Promise<SandboxBoundaryRequest[]>;
  /** Requests already closed against the user because the host restarted. */
  listSandboxBoundaryRestartClosures(sessionId: string): Promise<SandboxBoundaryRequest[]>;
  hasExplicitSandboxBoundaryDenial(
    identities: readonly { sessionId: string; runId: string; turnId: string }[],
  ): Promise<boolean>;
  settleSandboxBoundaryRequest(
    input: SettleSandboxBoundaryRequest,
  ): Promise<SandboxBoundarySettlement>;
  setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ): Promise<ExecutionBoundary>;
  probeStableSessionCreate(
    sessionId: string,
    requestFingerprint: string,
  ): Promise<ProbeStableSessionCreateResult>;
  createStableSession(
    request: CreateStableSessionRequest,
    initialBoundary?: ExecutionBoundary,
  ): Promise<CreateStableSessionResult>;
  /**
   * Commit the coordination linkage, target admission and optional target creation
   * as one durable fact. Retry of the same operation returns its original result;
   * conflicting identity reuse fails without changing either Session.
   * Callers may dispatch the target only after this operation succeeds.
   */
  assignWorkHubMessage(
    request: WorkHubMessageAssignmentRequest,
  ): Promise<WorkHubMessageAssignmentResult>;
  readWorkHubAssignment(actionId: string): Promise<WorkHubDelegationAssignedMessage | undefined>;
  /** Newest active assignment first, across every requested target. */
  readActiveWorkHubAssignmentsByTarget(
    targetSessionIds: readonly string[],
    maxAssignmentsPerTarget?: number,
  ): Promise<readonly WorkHubDelegationAssignedMessage[]>;
  readWorkHubReplacement(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementRequestedMessage | undefined>;
  readWorkHubReplacementAbort(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementAbortedMessage | undefined>;
  readWorkHubSupersession(
    delegationId: string,
  ): Promise<WorkHubDelegationSupersededMessage | undefined>;
  readWorkHubStopRequest(
    delegationId: string,
  ): Promise<WorkHubDelegationStopRequestedMessage | undefined>;
  readWorkHubStopResolution(
    delegationId: string,
  ): Promise<WorkHubDelegationStopResolvedMessage | undefined>;
  /**
   * Durably binds one action identity to one exact WorkHub operation before its
   * effect. Survives removal of the target Session so a committed destructive
   * claim can still converge afterwards.
   */
  claimWorkHubAction(claim: WorkHubActionClaim): Promise<WorkHubActionClaimOutcome>;
  readWorkHubActionClaim(actionId: string): Promise<WorkHubActionClaim | undefined>;
  discardStableConversationCopy(sessionId: string, requestFingerprint: string): Promise<boolean>;
  listCatalogPage(
    filter: SessionListFilter | undefined,
    cursor: SessionCatalogPageCursor | undefined,
    limit: number,
    expectedRevision?: `sha256:${string}`,
  ): Promise<SessionCatalogPageResult>;
  readHeaderRecordSnapshot(sessionId: string): Promise<SessionHeaderSnapshot>;
  readCatalogRecord(
    sessionId: string,
    roleScope?: 'ordinary' | 'recoverable',
  ): Promise<SessionCatalogRecord>;
  updateHeaderVersioned(
    sessionId: string,
    patch: SessionHeaderPatch,
    expectedRevision: number,
  ): Promise<SessionHeaderSnapshot>;
  updateSessionConfiguration(
    sessionId: string,
    input: UpdateSessionConfigurationRequest,
  ): Promise<SessionHeaderSnapshot>;
  probeSessionRemoval(sessionId: string): Promise<ProbeSessionRemovalResult>;
  setSessionsArchivedVersioned(
    sessions: readonly VersionedSessionIdentity[],
    isArchived: boolean,
  ): Promise<SessionHeaderSnapshot[]>;
  removeSessionsVersioned(
    sessions: readonly VersionedSessionIdentity[],
    archiveSessions?: readonly VersionedSessionIdentity[],
  ): Promise<string[]>;
  reconcileOrphanedAgentGraphRetirements(): Promise<string[]>;
  listPendingSessionRetirementCleanupIds(sessionId?: string): Promise<string[]>;
  completeSessionRetirementCleanup(sessionId: string): Promise<void>;
}
