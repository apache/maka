import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  decodeStoredMessageForRead,
  decodeStoredMessageForRecovery,
} from './execution-record-codec.js';
import { appendJsonl } from './jsonl-append.js';
import { classifyJsonRecord } from './json-prefix.js';
import { importLegacySessionMetadataTree } from './session-metadata-transfer.js';
import {
  createSqliteSessionMetadataStore,
  type SqliteSessionMetadataStore,
} from './sqlite-session-metadata-store.js';
import {
  createSessionTranscriptMarker,
  decodeSessionTranscriptMarker,
  isSessionTranscriptMarker,
} from './session-transcript.js';
import { chainWrite } from './write-queue.js';
import {
  DEFAULT_SESSION_NAME,
  deriveTurnRecords,
  isCollaborationMode,
  isOrchestrationMode,
  isPermissionMode,
  isSessionBlockedReason,
  isSubagentSessionParent,
  isSubagentSessionRuntime,
  isSubagentSessionSpawn,
  isSubagentWorkspaceBinding,
  isSessionStatus,
  normalizeUserSessionName,
  subagentSessionRuntimeSummary,
} from '@maka/core';
import type {
  AgentGraphOperatorProvisionRequest,
  AgentGraphOperatorProvisionResult,
  CreateSandboxBoundaryRequest,
  CreateSessionInput,
  ExecutionBoundary,
  SandboxBoundaryRequest,
  SandboxBoundarySettlement,
  SessionHeader,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  SettleSandboxBoundaryRequest,
  TurnRecord,
  UserMessage,
} from '@maka/core';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const SQLITE_SESSION_METADATA_DATABASE_NAME = 'sessions.sqlite';

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

export interface SessionStore {
  create(input: CreateSessionInput, initialBoundary?: ExecutionBoundary): Promise<SessionHeader>;
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
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  /** Enumerate durable metadata without reading transcript bodies. */
  listHeaders(): Promise<SessionHeader[]>;
  listForRecovery(): Promise<SessionHeader[]>;
  /** Read only the durable header without triggering connection-lock self-healing. */
  readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
  /** Read durable messages without triggering connection-lock self-healing. */
  readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]>;
  /** Read messages for startup recovery, rejecting durable JSONL corruption. */
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

export function createSessionStore(workspaceRoot: string): SessionStore {
  return new SqliteSessionStore(workspaceRoot);
}

/** Legacy JSONL-header store retained only for migration and compatibility tests. */
export function createLegacyFileSessionStore(workspaceRoot: string): SessionStore {
  return new FileSessionStore(workspaceRoot);
}

class SqliteSessionStore implements SessionStore {
  private readonly files: FileSessionStore;
  private readonly metadata: SqliteSessionMetadataStore;
  private readonly ready: Promise<void>;
  private closePromise: Promise<void> | null = null;

  constructor(workspaceRoot: string) {
    this.files = new FileSessionStore(workspaceRoot);
    this.metadata = createSqliteSessionMetadataStore(
      join(workspaceRoot, SQLITE_SESSION_METADATA_DATABASE_NAME),
    );
    this.ready = importLegacySessionMetadataTree({
      workspaceRoot,
      destination: this.metadata,
    }).then(() => {});
    void this.ready.catch(() => {});
  }

  async create(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<SessionHeader> {
    await this.ensureReady();
    if (input.subagentSpawn) {
      throw new Error('Subagent spawn metadata requires createSubagent()');
    }
    const staged = await this.files.createTranscript(input);
    try {
      return (await this.metadata.create(staged, initialBoundary)).header;
    } catch (error) {
      await this.files.remove(staged.id).catch(() => {});
      throw error;
    }
  }

  async createSubagent(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader; created: boolean }> {
    await this.ensureReady();
    const staged = await this.files.createTranscript(input);
    try {
      const result = await this.metadata.createSubagent(staged, initialBoundary);
      if (!result.created) await this.files.remove(staged.id);
      return { header: result.record.header, created: result.created };
    } catch (error) {
      await this.files.remove(staged.id).catch(() => {});
      throw error;
    }
  }

  async createAgentGraphOperator(
    input: CreateSessionInput,
    request: AgentGraphOperatorProvisionRequest,
    expectedRevision: number,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader } & AgentGraphOperatorProvisionResult> {
    await this.ensureReady();
    const staged = await this.files.createTranscript(input);
    try {
      const result = await this.metadata.createAgentGraphOperator(
        staged,
        request,
        expectedRevision,
        initialBoundary,
      );
      if (!result.created) await this.files.remove(staged.id);
      return {
        header: result.record.header,
        provision: result.provision,
        created: result.created,
      };
    } catch (error) {
      await this.files.remove(staged.id).catch(() => {});
      throw error;
    }
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
    const records = await this.metadata.list(filter);
    const withPreviews: Array<{
      header: SessionHeader;
      previewMessages: StoredMessage[];
    }> = [];
    for (const record of records) {
      const previewMessages = await this.files
        .readPreviewMessages(record.header.id)
        .catch(() => []);
      withPreviews.push({ header: record.header, previewMessages });
    }
    withPreviews.sort((a, b) => {
      const aLastMessageAt = maxTimestamp(
        a.header.lastMessageAt,
        latestVisibleMessageAt(a.previewMessages),
      );
      const bLastMessageAt = maxTimestamp(
        b.header.lastMessageAt,
        latestVisibleMessageAt(b.previewMessages),
      );
      const tsDelta = (bLastMessageAt ?? 0) - (aLastMessageAt ?? 0);
      return tsDelta !== 0 ? tsDelta : a.header.id.localeCompare(b.header.id);
    });

    const summaries: SessionSummary[] = [];
    for (let index = 0; index < withPreviews.length; index += 1) {
      const { header, previewMessages } = withPreviews[index]!;
      let messages = previewMessages.slice(-10);
      if (index < 3) {
        messages = (
          await this.files.readTranscriptMessagesSnapshot(header.id, header).catch(() => messages)
        ).slice(-10);
      }
      summaries.push(toSummary(header, messages));
    }
    return summaries;
  }

  async listForRecovery(): Promise<SessionHeader[]> {
    const headers = await this.listHeaders();
    for (const header of headers) {
      await this.files.readTranscriptMessagesForRecovery(header.id, header);
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
    await this.ensureReady();
    return (await this.metadata.read(sessionId)).header;
  }

  async readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]> {
    await this.ensureReady();
    const header = (await this.metadata.read(sessionId)).header;
    return this.files.readTranscriptMessagesSnapshot(sessionId, header);
  }

  async readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]> {
    await this.ensureReady();
    const header = (await this.metadata.read(sessionId)).header;
    return this.files.readTranscriptMessagesForRecovery(sessionId, header);
  }

  async listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessagesSnapshot(sessionId));
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const header = await this.readHeaderSnapshot(sessionId);
    return this.lockConnectionAfterFirstUserMessage(header);
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    const messages = await this.readMessagesSnapshot(sessionId);
    const header = (await this.metadata.read(sessionId)).header;
    await this.lockConnectionAfterFirstUserMessage(header, messages);
    return messages;
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    await this.ensureReady();
    await this.files.appendMessages(sessionId, messages);
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    await this.ensureReady();
    return (await this.metadata.update(sessionId, patch)).header;
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
    await this.files.remove(sessionId);
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeAfterReady();
    return this.closePromise;
  }

  private async closeAfterReady(): Promise<void> {
    await this.ready.catch(() => {});
    this.metadata.close();
  }

  private async lockConnectionAfterFirstUserMessage(
    header: SessionHeader,
    knownMessages?: StoredMessage[],
  ): Promise<SessionHeader> {
    if (header.connectionLocked) return header;
    const messages =
      knownMessages ?? (await this.files.readTranscriptMessagesSnapshot(header.id, header));
    if (!messages.some((message) => message.type === 'user')) return header;
    return this.updateHeader(header.id, { connectionLocked: true });
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }
}

class FileSessionStore implements SessionStore {
  private static readonly HEADER_BUDGET = 8192;
  private static readonly MAX_HEADER_BYTES = 1024 * 1024;
  private static readonly TAIL_PREVIEW_BUDGET = 64 * 1024;
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot: string) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
  }

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    if (input.subagentSpawn) {
      throw new Error('Child-session idempotency requires the SQLite metadata control plane');
    }
    return this.createWithInitialRecord(input, 'legacy-header');
  }

  async createSubagent(
    _input: CreateSessionInput,
  ): Promise<{ header: SessionHeader; created: boolean }> {
    throw new Error('Child-session idempotency requires the SQLite metadata control plane');
  }

  async createAgentGraphOperator(
    _input: CreateSessionInput,
    _request: AgentGraphOperatorProvisionRequest,
    _expectedRevision: number,
  ): Promise<{ header: SessionHeader } & AgentGraphOperatorProvisionResult> {
    throw new Error('Graph operator provisioning requires the SQLite metadata control plane');
  }

  async readExecutionBoundary(_sessionId: string): Promise<ExecutionBoundary> {
    throw new Error('Execution boundaries require the SQLite metadata control plane');
  }

  async createSandboxBoundaryRequest(
    _input: CreateSandboxBoundaryRequest,
  ): Promise<SandboxBoundaryRequest> {
    throw new Error('Sandbox boundary requests require the SQLite metadata control plane');
  }

  async listPendingSandboxBoundaryRequests(_sessionId: string): Promise<SandboxBoundaryRequest[]> {
    throw new Error('Sandbox boundary requests require the SQLite metadata control plane');
  }

  async listSandboxBoundaryRestartClosures(_sessionId: string): Promise<SandboxBoundaryRequest[]> {
    throw new Error('Sandbox boundary requests require the SQLite metadata control plane');
  }

  async settleSandboxBoundaryRequest(
    _input: SettleSandboxBoundaryRequest,
  ): Promise<SandboxBoundarySettlement> {
    throw new Error('Sandbox boundary requests require the SQLite metadata control plane');
  }

  async setExecutionBoundaryKind(
    _sessionId: string,
    _kind: 'managed' | 'bypass',
    _projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ): Promise<ExecutionBoundary> {
    throw new Error('Execution boundaries require the SQLite metadata control plane');
  }

  async createTranscript(input: CreateSessionInput): Promise<SessionHeader> {
    return this.createWithInitialRecord(input, 'transcript-marker');
  }

  private async createWithInitialRecord(
    input: CreateSessionInput,
    initialRecord: 'legacy-header' | 'transcript-marker',
  ): Promise<SessionHeader> {
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      (typeof input.projectId !== 'string' || input.projectId.length === 0)
    ) {
      throw new Error('Invalid project id');
    }
    const now = Date.now();
    const id = randomUUID();
    // PR-UI-IPC-2 (@kenji msg 0474c3fe + @xuan msg 88d96a87):
    // session name write contract. If caller passed undefined,
    // use the canonical default; otherwise normalize the
    // user-supplied name through the same `normalizeUserSessionName`
    // gate that `rename` and `branchFromTurn` use. Empty-after-
    // sanitize on an explicit input is a REJECT — we do NOT
    // silently fall back to default, that would swallow the
    // user's intent (per @xuan caller-semantics lock).
    let resolvedName: string;
    if (input.name === undefined) {
      resolvedName = DEFAULT_SESSION_NAME;
    } else {
      const normalized = normalizeUserSessionName(input.name);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      resolvedName = normalized.value;
    }
    const header: SessionHeader = {
      id,
      workspaceRoot: this.workspaceRoot,
      cwd: input.cwd,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      createdAt: now,
      lastUsedAt: now,
      name: resolvedName,
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
      ...(input.revisionRootSessionId
        ? { revisionRootSessionId: input.revisionRootSessionId }
        : {}),
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
      permissionMode: input.permissionMode,
      collaborationMode: input.collaborationMode ?? 'agent',
      orchestrationMode: input.orchestrationMode ?? 'default',
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      schemaVersion: 1,
    };

    assertValidSessionLineage(header);

    await this.withQueue(id, async () => {
      await mkdir(this.sessionDir(id), { recursive: true });
      const firstRecord =
        initialRecord === 'legacy-header' ? header : createSessionTranscriptMarker(header.id);
      await writeFile(this.sessionPath(id), JSON.stringify(firstRecord) + '\n', 'utf8');
    });

    return header;
  }

  async list(filter?: SessionListFilter): Promise<SessionSummary[]> {
    if (filter?.subagentParentSessionId !== undefined) {
      throw new Error('Subagent session relation queries require SQLite session metadata');
    }
    let entries;
    try {
      entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    // Phase 1: read each header plus a bounded tail preview. That keeps
    // list() proportional to the number of sessions rather than full
    // transcript size, while preserving sidebar previews and timestamp
    // fallback for sessions outside the top few.
    const withHeaders: Array<{
      id: string;
      header: SessionHeader;
      previewMessages: StoredMessage[];
    }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!isSafeSessionId(entry.name)) continue;
      try {
        const header = await this.readHeaderOnly(entry.name);
        if (filter?.isArchived !== undefined && header.isArchived !== filter.isArchived) continue;
        if (filter?.isFlagged !== undefined && header.isFlagged !== filter.isFlagged) continue;
        if (filter?.labelSlug && !header.labels.includes(filter.labelSlug)) continue;
        const previewMessages = await this.readTailPreviewMessages(entry.name).catch(() => []);
        withHeaders.push({ id: entry.name, header, previewMessages });
      } catch {
        // Ignore malformed session folders in the sidebar.
      }
    }

    // Secondary key on id (lexicographic) so sessions with identical
    // lastMessageAt always sort in the same order - fixtures with
    // multiple sessions seeded at the same frozen timestamp would
    // otherwise drift across runs based on filesystem readdir order
    // (PR108k-yj per @kenji e2e-fixture determinism). Negligible cost
    // for real users; identical lastMessageAt is rare in production.
    withHeaders.sort((a, b) => {
      const aLastMessageAt = maxTimestamp(
        a.header.lastMessageAt,
        latestVisibleMessageAt(a.previewMessages),
      );
      const bLastMessageAt = maxTimestamp(
        b.header.lastMessageAt,
        latestVisibleMessageAt(b.previewMessages),
      );
      const tsDelta = (bLastMessageAt ?? 0) - (aLastMessageAt ?? 0);
      if (tsDelta !== 0) return tsDelta;
      return a.header.id.localeCompare(b.header.id);
    });

    // Phase 2: full detail read only for the most recent 3 sessions.
    // For those, keep only the last 10 messages as preview. Remaining
    // sessions use the bounded tail preview from phase 1.
    const TOP_N = 3;
    const summaries: SessionSummary[] = [];
    for (let i = 0; i < withHeaders.length; i++) {
      const { header, previewMessages } = withHeaders[i];
      let messages: StoredMessage[] = previewMessages.slice(-10);
      if (i < TOP_N) {
        try {
          const result = await this.readFilePartsUnlocked(header.id);
          messages = result.messages.slice(-10);
        } catch {
          // Fall through to the bounded tail preview from phase 1.
        }
      }
      summaries.push(toSummary(header, messages));
    }
    return summaries;
  }

  async listForRecovery(): Promise<SessionHeader[]> {
    return this.listHeaders();
  }

  async listHeaders(): Promise<SessionHeader[]> {
    let entries;
    try {
      entries = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const headers: SessionHeader[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeSessionId(entry.name)) {
        throw new Error(`Invalid Session entry: ${entry.name}`);
      }
      headers.push(await this.readHeaderOnly(entry.name));
    }
    return headers.sort((a, b) => a.id.localeCompare(b.id));
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const { header, messages } = await this.readFileParts(sessionId);
    if (!header.connectionLocked && messages.some((message) => message.type === 'user')) {
      return this.updateHeader(sessionId, { connectionLocked: true });
    }
    return header;
  }

  async readHeaderSnapshot(sessionId: string): Promise<SessionHeader> {
    try {
      return await this.readHeaderOnly(sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    const { header, messages } = await this.readFileParts(sessionId);
    if (!header.connectionLocked && messages.some((message) => message.type === 'user')) {
      await this.updateHeader(sessionId, { connectionLocked: true });
    }
    return messages;
  }

  async readMessagesSnapshot(sessionId: string): Promise<StoredMessage[]> {
    return (await this.readFileParts(sessionId)).messages;
  }

  async readPreviewMessages(sessionId: string): Promise<StoredMessage[]> {
    return this.readTailPreviewMessages(sessionId);
  }

  async readTranscriptMessagesSnapshot(
    sessionId: string,
    header: SessionHeader,
  ): Promise<StoredMessage[]> {
    return this.readTranscriptMessagesUnlocked(sessionId, header);
  }

  async readTranscriptMessagesForRecovery(
    sessionId: string,
    header: SessionHeader,
  ): Promise<StoredMessage[]> {
    return this.readTranscriptMessagesUnlocked(sessionId, header, true);
  }

  async readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]> {
    return (await this.readFilePartsUnlocked(sessionId, true)).messages;
  }

  async listTurnsSnapshot(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessagesSnapshot(sessionId));
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.withQueue(sessionId, async () => {
      const payload = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
      await appendJsonl(this.sessionPath(sessionId), payload, {
        requireExistingRecord: true,
      });
    });
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentParent')) {
      throw new Error('Subagent session parent relation is immutable');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentRuntime')) {
      throw new Error('Subagent session runtime snapshot is immutable');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentSpawn')) {
      throw new Error('Subagent session spawn identity is immutable');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'subagentWorkspace')) {
      throw new Error('Subagent session workspace binding is immutable');
    }
    let nextHeader: SessionHeader | undefined;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      nextHeader = { ...header, ...patch };
      assertValidSessionLineage(nextHeader);
      const lines = [
        JSON.stringify(nextHeader),
        ...messages.map((message) => JSON.stringify(message)),
      ];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    if (!nextHeader) throw new Error(`Failed to update session ${sessionId}`);
    return nextHeader;
  }

  async markSessionReadThrough(sessionId: string, readThroughTs: number): Promise<SessionHeader> {
    let nextHeader: SessionHeader | undefined;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      const effectiveLastMessageAt = maxTimestamp(
        header.lastMessageAt,
        latestVisibleMessageAt(messages),
      );
      if (
        !Number.isFinite(readThroughTs) ||
        !header.hasUnread ||
        (effectiveLastMessageAt !== undefined && effectiveLastMessageAt > readThroughTs)
      ) {
        nextHeader = header;
        return;
      }
      nextHeader = { ...header, hasUnread: false };
      const lines = [
        JSON.stringify(nextHeader),
        ...messages.map((message) => JSON.stringify(message)),
      ];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    if (!nextHeader) throw new Error(`Failed to update session ${sessionId}`);
    return nextHeader;
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
    // PR-UI-IPC-2: same `normalizeUserSessionName` chokepoint as
    // create + branch. Replaces the older inline trim + length-80
    // cap with the shared helper so all three write paths go
    // through a single contract (control char strip, bidi/zero-
    // width defense, NFC, code-point cap, typed reject).
    const normalized = normalizeUserSessionName(name);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }
    await this.updateHeader(sessionId, { name: normalized.value, titleIsManual: true });
  }

  async setGeneratedTitleIfAbsent(sessionId: string, title: string): Promise<SessionHeader | null> {
    const normalized = normalizeUserSessionName(title);
    if (!normalized.ok) return null;
    let nextHeader: SessionHeader | null = null;
    await this.withQueue(sessionId, async () => {
      const { header, messages } = await this.readFilePartsUnlocked(sessionId);
      if (header.titleIsManual || header.name !== DEFAULT_SESSION_NAME) return;
      if (normalized.value === header.name) return;
      nextHeader = { ...header, name: normalized.value };
      const lines = [
        JSON.stringify(nextHeader),
        ...messages.map((message) => JSON.stringify(message)),
      ];
      await this.writeAtomic(this.sessionPath(sessionId), lines.join('\n') + '\n');
    });
    return nextHeader;
  }

  async remove(sessionId: string): Promise<void> {
    await this.withQueue(sessionId, async () => {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    });
  }

  private sessionDir(sessionId: string): string {
    assertSafeSessionId(sessionId);
    return join(this.sessionsRoot, sessionId);
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'session.jsonl');
  }

  private async readHeaderOnly(sessionId: string): Promise<SessionHeader> {
    // Fast path: read only the first JSON line (the header) without
    // parsing any message payload. Used by list() to quickly scan
    // all sessions before deciding which ones need detail reads.
    const path = this.sessionPath(sessionId);
    const handle = await open(path, 'r');
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < FileSessionStore.MAX_HEADER_BYTES) {
        const buf = Buffer.alloc(
          Math.min(FileSessionStore.HEADER_BUDGET, FileSessionStore.MAX_HEADER_BYTES - offset),
        );
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        if (bytesRead === 0) break;
        chunks.push(buf.subarray(0, bytesRead));
        const region = Buffer.concat(chunks).toString('utf8');
        const firstNl = region.indexOf('\n');
        if (firstNl !== -1) {
          return decodeSessionHeader(JSON.parse(region.slice(0, firstNl)), sessionId);
        }
        offset += bytesRead;
      }
      throw new Error(`Session ${sessionId}: cannot find header line`);
    } finally {
      await handle.close();
    }
  }

  private async readTailPreviewMessages(sessionId: string): Promise<StoredMessage[]> {
    const path = this.sessionPath(sessionId);
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - FileSessionStore.TAIL_PREVIEW_BUDGET);
      const length = size - start;
      if (length <= 0) return [];
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, start);
      const text = buf.toString('utf8', 0, bytesRead);
      const rawLines = text.split('\n');
      // The first tail line is either the header (start === 0) or a partial JSONL line.
      const lines = rawLines.slice(1);
      const completeLines = text.endsWith('\n') ? lines : lines.slice(0, -1);
      const messages: StoredMessage[] = [];
      for (const line of completeLines) {
        if (line.trim().length === 0) continue;
        try {
          messages.push(decodeStoredMessageForRead(JSON.parse(line)));
        } catch {
          // Tail previews are best-effort; full reads still surface durable corruption notes.
        }
      }
      return messages;
    } finally {
      await handle.close();
    }
  }

  private async readFileParts(
    sessionId: string,
  ): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
    return this.readFilePartsUnlocked(sessionId);
  }

  private async readFilePartsUnlocked(
    sessionId: string,
    strict = false,
  ): Promise<{ header: SessionHeader; messages: StoredMessage[] }> {
    const text = await readFile(this.sessionPath(sessionId), 'utf8');
    const rawLines = text.split('\n');
    const endsWithNewline = text.endsWith('\n');
    const lines = rawLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((entry) => entry.line.trim().length > 0);
    if (lines.length === 0 || !lines[0]) throw new Error(`Session ${sessionId} is empty`);
    const header = decodeSessionHeader(JSON.parse(lines[0].line), sessionId);
    const messages: StoredMessage[] = [];
    const lastLineNumber = lines.at(-1)?.lineNumber;
    for (const entry of lines.slice(1)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.line);
      } catch (error) {
        if (
          !endsWithNewline &&
          entry.lineNumber === lastLineNumber &&
          classifyJsonRecord(entry.line) === 'incomplete-prefix'
        )
          continue;
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Session ${sessionId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        messages.push(createJsonlCorruptionNote(header, entry.lineNumber, error));
        continue;
      }
      try {
        messages.push(
          strict ? decodeStoredMessageForRecovery(parsed) : decodeStoredMessageForRead(parsed),
        );
      } catch (error) {
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Session ${sessionId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        messages.push(createJsonlCorruptionNote(header, entry.lineNumber, error));
      }
    }
    return { header, messages };
  }

  private async readTranscriptMessagesUnlocked(
    sessionId: string,
    header: SessionHeader,
    strict = false,
  ): Promise<StoredMessage[]> {
    const text = await readFile(this.sessionPath(sessionId), 'utf8');
    const rawLines = text.split('\n');
    const endsWithNewline = text.endsWith('\n');
    const lines = rawLines
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((entry) => entry.line.trim().length > 0);
    if (lines.length === 0 || !lines[0]) throw new Error(`Session ${sessionId} is empty`);

    let firstRecord: unknown;
    try {
      firstRecord = JSON.parse(lines[0].line) as unknown;
      if (isSessionTranscriptMarker(firstRecord)) {
        decodeSessionTranscriptMarker(firstRecord, sessionId);
      } else {
        decodeSessionHeader(firstRecord, sessionId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Session ${sessionId} has an invalid first JSONL record: ${detail}`);
    }

    const messages: StoredMessage[] = [];
    const lastLineNumber = lines.at(-1)?.lineNumber;
    for (const entry of lines.slice(1)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.line);
      } catch (error) {
        if (
          !endsWithNewline &&
          entry.lineNumber === lastLineNumber &&
          classifyJsonRecord(entry.line) === 'incomplete-prefix'
        ) {
          continue;
        }
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Session ${sessionId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        messages.push(createJsonlCorruptionNote(header, entry.lineNumber, error));
        continue;
      }
      try {
        messages.push(
          strict ? decodeStoredMessageForRecovery(parsed) : decodeStoredMessageForRead(parsed),
        );
      } catch (error) {
        if (strict) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Session ${sessionId} has a corrupt JSONL record at line ${entry.lineNumber}: ${detail}`,
          );
        }
        messages.push(createJsonlCorruptionNote(header, entry.lineNumber, error));
      }
    }
    return messages;
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, 'utf8');
    try {
      await replaceFileWithWindowsReaderRetry(tempPath, path);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private withQueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    assertSafeSessionId(sessionId);
    return chainWrite(this.writeQueues, sessionId, operation);
  }
}

async function replaceFileWithWindowsReaderRetry(tempPath: string, path: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 6 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(tempPath, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
      if (!retryable || attempt === attempts) throw error;
      await delay(attempt * 10);
    }
  }
}

/** Shared guard for stores that derive filesystem paths from a session id. */
export function assertSafeSessionId(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new Error('Invalid session id');
  }
}

export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

type StoredSessionHeader = Omit<
  SessionHeader,
  | 'backend'
  | 'model'
  | 'permissionMode'
  | 'collaborationMode'
  | 'orchestrationMode'
  | 'status'
  | 'blockedReason'
  | 'titleIsManual'
> & {
  backend: string;
  model?: unknown;
  permissionMode?: unknown;
  collaborationMode?: unknown;
  orchestrationMode?: unknown;
  status?: unknown;
  blockedReason?: unknown;
  titleIsManual?: unknown;
  /** Accepted only while decoding old session headers and dropped on normalization. */
  pendingCwdReminder?: unknown;
};

function createJsonlCorruptionNote(
  header: SessionHeader,
  lineNumber: number,
  error: unknown,
): StoredMessage {
  return {
    type: 'system_note',
    id: `jsonl-corrupt-${lineNumber}`,
    ts: header.lastUsedAt ?? header.createdAt,
    kind: 'error',
    data: {
      code: 'jsonl_parse_error',
      lineNumber,
      message: error instanceof Error ? error.message : 'Invalid JSONL message line',
    },
  };
}

/**
 * Decode the legacy line-1 JSONL header into the current canonical shape.
 *
 * Kept public for one-way importers so file and SQLite storage apply exactly
 * the same compatibility defaults and validation rules.
 */
export function decodeSessionHeader(value: unknown, sessionId: string): SessionHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid session header for session ${sessionId}: expected an object`);
  }
  const header = value as StoredSessionHeader;
  const permissionMode = isPermissionMode(header.permissionMode) ? header.permissionMode : 'ask';
  const collaborationMode = isCollaborationMode(header.collaborationMode)
    ? header.collaborationMode
    : 'agent';
  const orchestrationMode = isOrchestrationMode(header.orchestrationMode)
    ? header.orchestrationMode
    : 'default';
  const model =
    typeof header.model === 'string' && header.model.length > 0 ? header.model : 'default';
  const status = resolveMigratedStatus(header);
  const blockedReason =
    status === 'blocked' && isSessionBlockedReason(header.blockedReason)
      ? header.blockedReason
      : undefined;
  const statusFields = {
    status,
    blockedReason,
    statusUpdatedAt:
      header.statusUpdatedAt ??
      header.archivedAt ??
      header.lastMessageAt ??
      header.lastUsedAt ??
      header.createdAt,
  };
  const titleIsManual =
    typeof header.titleIsManual === 'boolean'
      ? header.titleIsManual
      : normalizeSessionName(header.name) !== DEFAULT_SESSION_NAME;
  if (header.backend === 'claude') {
    return normalizeMigratedHeader(
      {
        ...header,
        ...statusFields,
        titleIsManual,
        backend: 'ai-sdk',
        model,
        permissionMode,
        collaborationMode,
        orchestrationMode,
      },
      sessionId,
    );
  }
  if (header.backend === 'pi-agent') {
    return normalizeMigratedHeader(
      {
        ...header,
        ...statusFields,
        titleIsManual,
        backend: 'pi-agent',
        model,
        permissionMode,
        collaborationMode,
        orchestrationMode,
      },
      sessionId,
    );
  }
  if (header.backend === 'pi') {
    return normalizeMigratedHeader(
      {
        ...header,
        ...statusFields,
        titleIsManual,
        backend: 'pi-agent',
        model,
        permissionMode,
        collaborationMode,
        orchestrationMode,
      },
      sessionId,
    );
  }
  return normalizeMigratedHeader(
    {
      ...header,
      ...statusFields,
      titleIsManual,
      backend: header.backend === 'ai-sdk' ? 'ai-sdk' : 'fake',
      model,
      permissionMode,
      collaborationMode,
      orchestrationMode,
    },
    sessionId,
  );
}

function resolveMigratedStatus(header: StoredSessionHeader): SessionHeader['status'] {
  if (header.isArchived) return 'archived';
  if (isSessionStatus(header.status) && header.status !== 'archived') return header.status;
  return 'active';
}

function normalizeMigratedHeader(
  header: SessionHeader & { pendingCwdReminder?: unknown },
  sessionId: string,
): SessionHeader {
  const { pendingCwdReminder: _legacyPendingCwdReminder, ...normalizedHeader } = header;
  return normalizeSessionHeader(normalizedHeader, sessionId);
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
    isValidRevisionLineage(header) &&
    isValidSubagentSessionLineage(header) &&
    (header.lastReadMessageId === undefined || typeof header.lastReadMessageId === 'string') &&
    typeof header.hasUnread === 'boolean' &&
    isBackendKind(header.backend) &&
    typeof header.llmConnectionSlug === 'string' &&
    typeof header.connectionLocked === 'boolean' &&
    typeof header.model === 'string' &&
    isPermissionMode(header.permissionMode) &&
    isCollaborationMode(header.collaborationMode) &&
    isOrchestrationMode(header.orchestrationMode) &&
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
  if (!isValidRevisionLineage(header)) {
    throw new Error('Invalid session revision lineage');
  }
  if (!isValidSubagentSessionLineage(header)) {
    throw new Error('Invalid subagent session lineage');
  }
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
  return value === 'ai-sdk' || value === 'fake' || value === 'pi-agent';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toSummary(header: SessionHeader, messages: StoredMessage[] = []): SessionSummary {
  const preview = lastMessagePreview(messages);
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

function latestVisibleMessageAt(messages: StoredMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type === 'user' || message.type === 'assistant') return message.ts;
  }
  return undefined;
}

function maxTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function normalizeSessionName(name: string): string {
  return name === 'New Session' ? DEFAULT_SESSION_NAME : name;
}

function lastMessagePreview(messages: StoredMessage[]): string | undefined {
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
}): UserMessage {
  return {
    type: 'user',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    text: input.text,
    ...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
    attachments: input.attachments,
  };
}
