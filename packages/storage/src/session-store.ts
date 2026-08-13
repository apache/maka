import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  createSqliteSessionMetadataStore,
  type SessionConfigurationMetadataUpdate,
  type SessionCatalogRevisionState,
  type SessionMetadataRecord,
  type SessionRemovalProbe,
  SessionMetadataVersionConflictError,
  type SqliteSessionMetadataStore,
  type StableSessionCreateProbe,
  type VersionedSessionIdentity,
} from './sqlite-session-metadata-store.js';
import { isDiscardableConversationCopy } from './session-conversation-copy.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import { DEFAULT_SESSION_NAME, normalizeUserSessionName } from '@maka/core/session-name';
import {
  decodeStoredMessage,
  deriveTurnRecords,
  isSessionBlockedReason,
  isSessionConversationCopy,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  isSessionStatus,
  subagentSessionRuntimeSummary,
} from '@maka/core/session';
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { isPermissionMode } from '@maka/core/permission';
import { isSubagentWorkspaceBinding } from '@maka/core/subagent-workspace';
import { WORKSPACE_AUTHORITY_SESSION_ID } from '@maka/core/workspace-version-authority';
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

import {
  isSessionToolProfile,
  type SessionHeader,
  type SessionConversationCopy,
  type SessionSummary,
  type StoredMessage,
  type TurnRecord,
  type UserMessage,
} from '@maka/core/session';

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

export class SessionReadMarkerMessageNotFoundError extends Error {
  readonly name = 'SessionReadMarkerMessageNotFoundError';
  readonly code = 'session_read_marker_message_not_found';

  constructor(
    readonly sessionId: string,
    readonly messageId: string,
  ) {
    super(`Session read marker message does not exist: ${messageId}`);
  }
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
  readonly summary: SessionSummary;
}

export interface SessionCatalogPageCursor {
  readonly activityAt: number;
  readonly sessionId: string;
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

export type StableSessionCreateInput = CreateSessionInput & {
  readonly conversationCopy?: SessionConversationCopy;
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
  readonly next: { readonly position: number; readonly byteOffset: number | null } | null;
}

export interface SessionStore {
  create(input: CreateSessionInput, initialBoundary?: ExecutionBoundary): Promise<SessionHeader>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  /** Enumerate durable metadata without reading transcript bodies. */
  listHeaders(): Promise<SessionHeader[]>;
  listForRecovery(): Promise<SessionHeader[]>;
  /** Read only the durable header without triggering connection-lock self-healing. */
  readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
  /** Read durable messages without triggering connection-lock self-healing. */
  readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]>;
  /** Read one byte-bounded page directly from the durable append-only ledger. */
  readTranscriptPageSnapshot(
    sessionId: string,
    request: SessionTranscriptPageRequest,
  ): Promise<SessionTranscriptStoragePage>;
  readTranscriptHighWaterSnapshot(sessionId: string): Promise<number | null>;
  /** Read durable messages for startup recovery. */
  readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]>;
  /** Derive durable turns without triggering connection-lock self-healing. */
  listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, message: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader>;
  markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null>;
  remove(sessionId: string): Promise<void>;
  close?(): Promise<void>;
}

export interface SessionAuthorityStore extends SessionStore {
  /** Read a bounded set of durable messages at an inclusive transcript watermark. */
  readTranscriptMessagesSnapshot(
    sessionId: string,
    request: SessionTranscriptMessageLookupRequest,
  ): Promise<StoredMessage[]>;
  /** Observe successful durable ledger appends. Listeners must not throw. */
  subscribeTranscriptChanges(listener: (sessionId: string) => void): () => void;
  /** Wait until the SQLite authority is ready for cross-domain transactions. */
  ready(): Promise<void>;
  /** Atomically create a Session from already-converted Maka raw messages. */
  createImportedSession(
    input: CreateSessionInput,
    messages: readonly StoredMessage[],
  ): Promise<SessionHeader>;
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
  discardStableConversationCopy(sessionId: string, requestFingerprint: string): Promise<boolean>;
  listCatalogPage(
    filter: SessionListFilter | undefined,
    cursor: SessionCatalogPageCursor | undefined,
    limit: number,
    expectedRevision?: `sha256:${string}`,
  ): Promise<SessionCatalogPageResult>;
  readHeaderRecordSnapshot(sessionId: string): Promise<SessionHeaderSnapshot>;
  readCatalogRecord(sessionId: string): Promise<SessionCatalogRecord>;
  updateHeaderVersioned(
    sessionId: string,
    patch: Partial<SessionHeader>,
    expectedRevision: number,
  ): Promise<SessionHeaderSnapshot>;
  updateSessionConfiguration(
    sessionId: string,
    input: UpdateSessionConfigurationRequest,
  ): Promise<SessionHeaderSnapshot>;
  markSessionReadThroughMessage(
    sessionId: string,
    messageId: string,
  ): Promise<SessionHeaderSnapshot>;
  probeSessionRemoval(sessionId: string): Promise<ProbeSessionRemovalResult>;
  setSessionsLifecycleVersioned(
    sessions: readonly VersionedSessionIdentity[],
    state: 'active' | 'archived',
  ): Promise<SessionHeaderSnapshot[]>;
  removeSessionsVersioned(sessions: readonly VersionedSessionIdentity[]): Promise<string[]>;
  reconcileOrphanedAgentGraphRetirements(): Promise<string[]>;
  listPendingSessionRetirementCleanupIds(sessionId?: string): Promise<string[]>;
  completeSessionRetirementCleanup(sessionId: string): Promise<void>;
}

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
  ): Promise<SessionHeader> {
    await this.ensureReady();
    assertNoConversationCopyMetadata(input);
    if (input.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires createSubagent()');
    }
    const canonicalMessages = messages.map((message) =>
      decodeStoredMessage(JSON.parse(JSON.stringify(message)) as unknown),
    );
    const header: SessionHeader = {
      ...buildSessionHeader(this.workspaceRoot, input),
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
    const records = (await this.metadata.list(filter)).filter(
      (record) => record.header.conversationCopy?.state !== 'preparing',
    );
    const withPreviews: Array<{
      record: SessionMetadataRecord;
      previewMessages: StoredMessage[];
    }> = [];
    for (const record of records) {
      const previewMessages = await this.metadata.readPreviewMessages(record.header.id);
      withPreviews.push({ record, previewMessages });
    }
    withPreviews.sort((a, b) => {
      const aLastMessageAt = maxTimestamp(
        a.record.header.lastMessageAt,
        latestVisibleMessageAt(a.previewMessages),
      );
      const bLastMessageAt = maxTimestamp(
        b.record.header.lastMessageAt,
        latestVisibleMessageAt(b.previewMessages),
      );
      const tsDelta = (bLastMessageAt ?? 0) - (aLastMessageAt ?? 0);
      return tsDelta !== 0 ? tsDelta : a.record.header.id.localeCompare(b.record.header.id);
    });

    const summaries: SessionSummary[] = [];
    for (let index = 0; index < withPreviews.length; index += 1) {
      const { record, previewMessages } = withPreviews[index]!;
      const { header } = record;
      let messages = previewMessages.slice(-10);
      if (index < 3) {
        messages = (await this.metadata.readMessages(header.id)).slice(-10);
      }
      summaries.push(toSummary(header, messages));
    }
    return summaries;
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
        summary: toCatalogSummary(record.header, record.lastMessagePreview),
      })),
      hasMore: page.hasMore,
    };
  }

  async listForRecovery(): Promise<SessionHeader[]> {
    const headers = await this.listHeaders();
    for (const header of headers) {
      await this.metadata.readMessagesForRecovery(header.id);
    }
    return headers;
  }

  async listHeaders(): Promise<SessionHeader[]> {
    await this.ensureReady();
    return (await this.metadata.list())
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

  async readCatalogRecord(sessionId: string): Promise<SessionCatalogRecord> {
    await this.ensureCatalogProjectionReadable();
    const record = await this.metadata.readCatalogRecord(sessionId);
    return {
      ...projectHeaderSnapshot(record),
      summary: toCatalogSummary(record.header, record.lastMessagePreview),
    };
  }

  async readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]> {
    await this.ensureReady();
    return this.metadata.readMessages(sessionId);
  }

  async readTranscriptPageSnapshot(
    sessionId: string,
    request: SessionTranscriptPageRequest,
  ): Promise<SessionTranscriptStoragePage> {
    await this.ensureReady();
    return this.metadata.readTranscriptPage(sessionId, request);
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

  async readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]> {
    await this.ensureReady();
    return this.metadata.readMessagesForRecovery(sessionId);
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

  subscribeTranscriptChanges(listener: (sessionId: string) => void): () => void {
    this.transcriptChangeListeners.add(listener);
    return () => this.transcriptChangeListeners.delete(listener);
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    await this.ensureReady();
    return (await this.metadata.update(sessionId, patch)).header;
  }

  async updateHeaderVersioned(
    sessionId: string,
    patch: Partial<SessionHeader>,
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

  async markSessionReadThroughMessage(
    sessionId: string,
    messageId: string,
  ): Promise<SessionHeaderSnapshot> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const record = await this.readHeaderRecordSnapshot(sessionId);
      const messages = await this.readMessagesSnapshot(sessionId);
      const visibleMessages = messages.filter(isVisibleSessionMessage);
      const targetIndex = visibleMessages.findIndex((message) => message.id === messageId);
      if (targetIndex < 0) {
        throw new SessionReadMarkerMessageNotFoundError(sessionId, messageId);
      }
      const currentIndex =
        record.header.lastReadMessageId === undefined
          ? -1
          : visibleMessages.findIndex((message) => message.id === record.header.lastReadMessageId);
      const hasUnread = targetIndex < visibleMessages.length - 1;
      if (
        targetIndex < currentIndex ||
        (targetIndex === currentIndex && record.header.hasUnread === hasUnread)
      ) {
        return record;
      }
      try {
        return await this.updateHeaderVersioned(
          sessionId,
          { lastReadMessageId: messageId, hasUnread },
          record.revision,
        );
      } catch (error) {
        if (!(error instanceof SessionMetadataVersionConflictError) || attempt === 2) throw error;
      }
    }
    throw new Error('Session read marker retry loop did not terminate');
  }

  async probeSessionRemoval(sessionId: string): Promise<ProbeSessionRemovalResult> {
    await this.ensureReady();
    return projectRemovalProbe(await this.metadata.probeRemoval(sessionId));
  }

  async setSessionsLifecycleVersioned(
    sessions: readonly VersionedSessionIdentity[],
    state: 'active' | 'archived',
  ): Promise<SessionHeaderSnapshot[]> {
    await this.ensureReady();
    return (await this.metadata.setLifecycleVersioned(sessions, state)).map(projectHeaderSnapshot);
  }

  async removeSessionsVersioned(sessions: readonly VersionedSessionIdentity[]): Promise<string[]> {
    await this.ensureReady();
    return this.metadata.removeVersioned(sessions);
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

  async markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader> {
    const header = await this.readHeaderSnapshot(sessionId);
    const messages = await this.readMessagesSnapshot(sessionId);
    const effectiveLastMessageAt = maxTimestamp(
      header.lastMessageAt,
      latestVisibleMessageAt(messages),
    );
    if (
      !Number.isFinite(readThroughTs) ||
      !header.hasUnread ||
      (effectiveLastMessageAt !== undefined && effectiveLastMessageAt > readThroughTs)
    ) {
      return header;
    }
    return this.updateHeader(sessionId, { hasUnread: false });
  }

  async archive(sessionId: string): Promise<void> {
    const now = Date.now();
    await this.updateHeader(sessionId, {
      isArchived: true,
      archivedAt: now,
      status: 'archived',
      statusUpdatedAt: now,
    });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, {
      isArchived: false,
      archivedAt: undefined,
      status: 'active',
      blockedReason: undefined,
      statusUpdatedAt: Date.now(),
    });
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
    const current = await this.readHeaderSnapshot(sessionId);
    if (
      current.titleIsManual ||
      current.name !== DEFAULT_SESSION_NAME ||
      normalized.value === current.name
    ) {
      return null;
    }
    return this.updateHeader(sessionId, { name: normalized.value });
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

function buildSessionHeader(
  workspaceRoot: string,
  input: CreateSessionInput,
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
  const name =
    input.name === undefined ? DEFAULT_SESSION_NAME : normalizeRequiredSessionName(input.name);
  const header: SessionHeader = {
    id: sessionId,
    workspaceRoot,
    cwd: input.cwd,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    createdAt: now,
    lastUsedAt: now,
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
    backend: input.backend,
    llmConnectionSlug: input.llmConnectionSlug,
    connectionLocked: false,
    model: input.model ?? 'default',
    ...(input.toolProfile !== undefined ? { toolProfile: input.toolProfile } : {}),
    permissionMode: input.permissionMode,
    collaborationMode: input.collaborationMode ?? 'agent',
    orchestrationMode: input.orchestrationMode ?? 'default',
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
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
    typeof header.workspaceRoot === 'string' &&
    typeof header.cwd === 'string' &&
    (header.projectId === undefined ||
      header.projectId === null ||
      (typeof header.projectId === 'string' && header.projectId.length > 0)) &&
    isFiniteNumber(header.createdAt) &&
    isFiniteNumber(header.lastUsedAt) &&
    (header.lastMessageAt === undefined || isFiniteNumber(header.lastMessageAt)) &&
    typeof header.name === 'string' &&
    typeof header.titleIsManual === 'boolean' &&
    typeof header.isFlagged === 'boolean' &&
    Array.isArray(header.labels) &&
    header.labels.every((label) => typeof label === 'string') &&
    typeof header.isArchived === 'boolean' &&
    (header.archivedAt === undefined || isFiniteNumber(header.archivedAt)) &&
    isSessionStatus(header.status) &&
    (header.blockedReason === undefined || isSessionBlockedReason(header.blockedReason)) &&
    (header.statusUpdatedAt === undefined || isFiniteNumber(header.statusUpdatedAt)) &&
    (header.parentSessionId === undefined || typeof header.parentSessionId === 'string') &&
    (header.branchOfTurnId === undefined || typeof header.branchOfTurnId === 'string') &&
    isValidConversationCopyLineage(header) &&
    isValidRevisionLineage(header) &&
    isValidSubagentSessionLineage(header) &&
    (header.lastReadMessageId === undefined || typeof header.lastReadMessageId === 'string') &&
    typeof header.hasUnread === 'boolean' &&
    isBackendKind(header.backend) &&
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
    return (
      header.parentSessionId === copy.sourceSessionId &&
      header.branchOfTurnId === copy.sourceTurnId &&
      header.revisionRootSessionId === undefined &&
      header.revisionParentSessionId === undefined &&
      header.revisionOfTurnId === undefined &&
      header.revisionIndex === undefined &&
      header.revisionState === undefined
    );
  }
  return (
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

function isBackendKind(value: unknown): value is SessionHeader['backend'] {
  return value === 'ai-sdk' || value === 'fake';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

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

function toSummary(header: SessionHeader, messages: StoredMessage[] = []): SessionSummary {
  const preview = lastMessagePreviewForMessages(messages);
  const derivedLastMessageAt = latestVisibleMessageAt(messages);
  const lastMessageAt = maxTimestamp(header.lastMessageAt, derivedLastMessageAt);
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
    ...(preview ? { lastMessagePreview: preview } : {}),
    status: header.status,
    ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
    ...(header.statusUpdatedAt !== undefined ? { statusUpdatedAt: header.statusUpdatedAt } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.subagentParent ? { subagentParent: header.subagentParent } : {}),
    ...(header.subagentRuntime
      ? { subagentRuntime: subagentSessionRuntimeSummary(header.subagentRuntime) }
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
    llmConnectionSlug: header.llmConnectionSlug,
    connectionLocked: header.connectionLocked,
    model: header.model,
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    orchestrationMode: header.orchestrationMode ?? 'default',
    ...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
  };
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

export function projectSessionCatalogMessages(messages: readonly StoredMessage[]): {
  readonly lastMessageAt?: number;
  readonly lastMessagePreview?: string;
} {
  const lastMessageAt = latestVisibleMessageAt(messages);
  const lastMessagePreview = lastMessagePreviewForMessages(messages);
  return {
    ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
    ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
  };
}

function latestVisibleMessageAt(messages: readonly StoredMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (isVisibleSessionMessage(message)) return message.ts;
  }
  return undefined;
}

function isVisibleSessionMessage(
  message: StoredMessage,
): message is Extract<StoredMessage, { type: 'user' | 'assistant' }> {
  return message.type === 'user' || message.type === 'assistant';
}

function maxTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function normalizeSessionName(name: string): string {
  return name === 'New Session' ? DEFAULT_SESSION_NAME : name;
}

function lastMessagePreviewForMessages(messages: readonly StoredMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type === 'user') {
      // Prefer the human-facing view when the stored model text is a composed
      // envelope (e.g. explicit skill invocation).
      const text = normalizePreviewText(message.displayText ?? message.text);
      if (text) return truncatePreview(text);
      if (message.attachments && message.attachments.length > 0) return '附件';
    }
    if (message.type === 'assistant') {
      const text = normalizePreviewText(message.text);
      if (text) return truncatePreview(text);
    }
  }
  return undefined;
}

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncatePreview(text: string, maxLength = 96): string {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength - 1).join('')}…`;
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
