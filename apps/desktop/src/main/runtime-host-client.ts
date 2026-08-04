import { createHash, randomUUID } from 'node:crypto';
import type { AttachmentRef } from '@maka/core/events';
import { decodeStoredMessageForRead, type StoredMessage } from '@maka/core/session';
import {
  type DirectRequestOperationKey,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  ARTIFACT_INGEST_CHUNK_MAX_BYTES,
  type InteractionAnswerInput,
  type OperationInput,
  type OperationOutput,
  type QueueRetractInput,
  type QueueRetractResult,
  type SessionCatalogFilter,
  type SessionCatalogItem,
  type SessionCatalogProjection,
  type SessionCatalogQueryResult,
  type SessionConfiguration,
  type SessionContinuitySnapshot,
  type SessionConversationCopyInput,
  type SessionConversationCopyResult,
  type SessionCreateInput,
  type ExecutionBoundarySummary,
  type SessionLifecycleState,
  type SessionMetadataPatch,
  type SessionUpdateResult,
  type SubscriptionFrame,
  type TurnInterruptInput,
  type TurnInterruptResult,
  type TurnMessageSubmitInput,
  type TurnMessageSubmitResult,
} from '@maka/runtime-host/protocol';

const MAX_OPTIMISTIC_ATTEMPTS = 3;

export type DesktopSessionConfigurationPatch = Partial<SessionConfiguration>;

export type DesktopRuntimeHostClientErrorCode =
  | 'catalog_unstable'
  | 'client_closed'
  | 'revision_conflict'
  | 'session_not_found'
  | 'unsupported_session';

export class DesktopRuntimeHostClientError extends Error {
  constructor(
    readonly code: DesktopRuntimeHostClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopRuntimeHostClientError';
  }
}

export interface DesktopRuntimeHostSession {
  readonly snapshot: SessionContinuitySnapshot;
  readonly transcript: Promise<StoredMessage[]>;
  readonly events: AsyncIterable<SubscriptionFrame>;
  close(): Promise<void>;
}

export class DesktopRuntimeHostClient {
  readonly #sessions = new Set<DesktopSessionHandle>();
  #closeTask: Promise<void> | undefined;

  constructor(private readonly connection: RuntimeHostConnection) {}

  async listSessions(filter?: SessionCatalogFilter): Promise<SessionCatalogProjection[]> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const sessions = await this.#readCatalog(filter);
      if (sessions) return sessions;
    }
    throw new DesktopRuntimeHostClientError(
      'catalog_unstable',
      'Session catalog kept changing while Desktop read it',
    );
  }

  async getSession(sessionId: string): Promise<SessionCatalogProjection | null> {
    const result = await this.#request('session.catalog.query', { kind: 'get', sessionId });
    if (result.kind !== 'session') {
      throw new DesktopRuntimeHostClientError(
        'catalog_unstable',
        'Runtime Host returned an invalid Session catalog lookup',
      );
    }
    return result.session === null ? null : requireSessionProjection(result.session);
  }

  async createSession(input: SessionCreateInput): Promise<SessionCatalogProjection> {
    return requireSessionProjection(await this.#request('session.create', input));
  }

  updateSessionMetadata(
    sessionId: string,
    patch: SessionMetadataPatch,
  ): Promise<SessionCatalogProjection> {
    return this.#updateSession(sessionId, (current) =>
      this.#request('session.metadata.update', {
        sessionId,
        expectedRevision: current.revision,
        patch,
      }),
    );
  }

  async updateSessionConfiguration(
    sessionId: string,
    patch: DesktopSessionConfigurationPatch,
  ): Promise<SessionCatalogProjection> {
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as DesktopSessionConfigurationPatch;
    if (Object.keys(definedPatch).length === 0) return this.#requireSession(sessionId);
    return this.#updateSession(sessionId, (current) =>
      this.#request('session.configuration.update', {
        sessionId,
        expectedRevision: current.revision,
        configuration: {
          // An unlocked Session still follows the Host-owned default route.
          // Once execution or an explicit model change locks it, the resolved
          // catalog route is the explicit target that must survive this patch.
          modelTarget: current.connectionLocked
            ? {
                kind: 'explicit',
                connectionSlug: current.llmConnectionSlug,
                model: current.model,
              }
            : { kind: 'default' },
          thinkingLevel: current.thinkingLevel ?? null,
          permissionMode: current.permissionMode,
          collaborationMode: current.collaborationMode,
          orchestrationMode: current.orchestrationMode,
          ...definedPatch,
        },
      }),
    );
  }

  relocateSessionCwd(sessionId: string, cwd: string): Promise<SessionCatalogProjection> {
    return this.#updateSession(sessionId, (current) =>
      this.#request('session.cwd.relocate', {
        sessionId,
        expectedRevision: current.revision,
        cwd,
      }),
    );
  }

  async setSessionReadMarker(
    sessionId: string,
    readThroughMessageId: string,
  ): Promise<SessionCatalogProjection> {
    return requireSessionProjection(
      await this.#request('session.read_marker.set', { sessionId, readThroughMessageId }),
    );
  }

  readExecutionBoundary(sessionId: string): Promise<ExecutionBoundarySummary> {
    return this.#request('session.execution_boundary.query', { sessionId });
  }

  async setSessionLifecycle(
    sessionId: string,
    state: SessionLifecycleState,
  ): Promise<SessionCatalogProjection> {
    return requireSessionProjection(
      await this.#request('session.lifecycle.set', { sessionId, state }),
    );
  }

  async removeSession(sessionId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const current = await this.#requireSession(sessionId);
      const result = await this.#request('session.remove', {
        sessionId,
        expectedRevision: current.revision,
      });
      if (result.kind === 'removed') return;
    }
    throw revisionConflict('remove', sessionId);
  }

  async copySession(
    kind: 'branch' | 'revision',
    input: Omit<SessionConversationCopyInput, 'expectedSourceRevision'>,
  ): Promise<SessionCatalogProjection> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const source = await this.#requireSession(input.sourceSessionId);
      const request = { ...input, expectedSourceRevision: source.revision };
      const result: SessionConversationCopyResult =
        kind === 'branch'
          ? await this.#request('session.branch.create', request)
          : await this.#request('session.revision.create', request);
      if (result.kind === 'committed') return requireSessionProjection(result.session);
    }
    throw revisionConflict(`${kind} copy`, input.sourceSessionId);
  }

  async ingestAttachment(input: {
    sessionId: string;
    name: string;
    mimeType: string;
    content: Uint8Array;
    uploadId?: string;
  }): Promise<AttachmentRef> {
    const uploadId = input.uploadId ?? randomUUID();
    const digest = `sha256:${createHash('sha256').update(input.content).digest('hex')}` as const;
    let opened = false;
    try {
      const begin = await this.#request('artifact.ingest', {
        kind: 'begin',
        sessionId: input.sessionId,
        uploadId,
        name: input.name,
        mimeType: input.mimeType,
        totalBytes: input.content.byteLength,
        contentSha256: digest,
      });
      if (begin.kind === 'committed') return begin.attachment;
      if (begin.kind !== 'upload_opened') {
        throw new Error('Runtime Host did not open the Attachment upload');
      }
      opened = true;
      let offset = begin.nextOffset;
      while (offset < input.content.byteLength) {
        const chunk = input.content.subarray(
          offset,
          Math.min(input.content.byteLength, offset + ARTIFACT_INGEST_CHUNK_MAX_BYTES),
        );
        const accepted = await this.#request('artifact.ingest', {
          kind: 'chunk',
          sessionId: input.sessionId,
          uploadId,
          offset,
          chunkBase64: Buffer.from(chunk).toString('base64'),
        });
        if (accepted.kind !== 'chunk_accepted' || accepted.nextOffset <= offset) {
          throw new Error('Runtime Host did not advance the Attachment upload');
        }
        offset = accepted.nextOffset;
      }
      const committed = await this.#request('artifact.ingest', {
        kind: 'commit',
        sessionId: input.sessionId,
        uploadId,
      });
      if (committed.kind !== 'committed') {
        throw new Error('Runtime Host did not commit the Attachment upload');
      }
      return committed.attachment;
    } catch (error) {
      if (opened) {
        await this.#request('artifact.ingest', {
          kind: 'abort',
          sessionId: input.sessionId,
          uploadId,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  submitMessage(
    input: Omit<TurnMessageSubmitInput, 'originHostEpoch'>,
  ): Promise<TurnMessageSubmitResult> {
    return this.#request('turn.message.submit', {
      ...input,
      originHostEpoch: this.connection.hostEpoch,
    });
  }

  retractQueue(input: Omit<QueueRetractInput, 'originHostEpoch'>): Promise<QueueRetractResult> {
    return this.#request('queue.retract', {
      ...input,
      originHostEpoch: this.connection.hostEpoch,
    });
  }

  interruptTurn(
    input: Omit<TurnInterruptInput, 'originHostEpoch'>,
  ): Promise<TurnInterruptResult> {
    return this.#request('turn.interrupt', {
      ...input,
      originHostEpoch: this.connection.hostEpoch,
    });
  }

  answerInteraction(input: InteractionAnswerInput): Promise<OperationOutput<'interaction.answer'>> {
    return this.#request('interaction.answer', input);
  }

  queryInteraction(
    input: OperationInput<'interaction.query'>,
  ): Promise<OperationOutput<'interaction.query'>> {
    return this.#request('interaction.query', input);
  }

  startTurn(input: OperationInput<'turn.start'>): Promise<OperationOutput<'turn.start'>> {
    return this.#request('turn.start', input);
  }

  queryTurn(input: OperationInput<'turn.query'>): Promise<OperationOutput<'turn.query'>> {
    return this.#request('turn.query', input);
  }

  stopTurn(input: OperationInput<'turn.stop'>): Promise<OperationOutput<'turn.stop'>> {
    return this.#request('turn.stop', input);
  }

  regenerateTurn(
    input: OperationInput<'turn.regenerate'>,
  ): Promise<OperationOutput<'turn.regenerate'>> {
    return this.#request('turn.regenerate', input);
  }

  queryTurnResume(
    input: OperationInput<'turn.resume.query'>,
  ): Promise<OperationOutput<'turn.resume.query'>> {
    return this.#request('turn.resume.query', input);
  }

  startTurnResume(
    input: OperationInput<'turn.resume.start'>,
  ): Promise<OperationOutput<'turn.resume.start'>> {
    return this.#request('turn.resume.start', input);
  }

  queryContextDiagnostics(
    sessionId: string,
  ): Promise<OperationOutput<'context.diagnostics.query'>> {
    return this.#request('context.diagnostics.query', { sessionId });
  }

  compactContext(
    input: OperationInput<'context.compact'>,
  ): Promise<OperationOutput<'context.compact'>> {
    return this.#request('context.compact', input);
  }

  async openSession(sessionId: string): Promise<DesktopRuntimeHostSession> {
    this.#assertOpen();
    const subscription = await this.connection.openSessionSubscription({ sessionId });
    if (this.#closeTask) {
      await subscription.close().catch(() => undefined);
      throw clientClosed();
    }
    const session = new DesktopSessionHandle(subscription, () => this.#sessions.delete(session));
    this.#sessions.add(session);
    return session;
  }

  close(): Promise<void> {
    this.#closeTask ??= this.#close();
    return this.#closeTask;
  }

  async #close(): Promise<void> {
    try {
      await Promise.all([...this.#sessions].map((session) => session.close()));
    } finally {
      await this.connection.close();
    }
  }

  async #updateSession(
    sessionId: string,
    update: (current: SessionCatalogProjection) => Promise<SessionUpdateResult>,
  ): Promise<SessionCatalogProjection> {
    for (let attempt = 0; attempt < MAX_OPTIMISTIC_ATTEMPTS; attempt += 1) {
      const current = await this.#requireSession(sessionId);
      const result = await update(current);
      if (result.kind === 'committed') return requireSessionProjection(result.session);
    }
    throw revisionConflict('update', sessionId);
  }

  async #readCatalog(
    filter: SessionCatalogFilter | undefined,
  ): Promise<SessionCatalogProjection[] | undefined> {
    const first = await this.#request('session.catalog.query', {
      kind: 'list_start',
      ...(filter ? { filter } : {}),
    });
    if (first.kind !== 'page') {
      throw new DesktopRuntimeHostClientError(
        'catalog_unstable',
        'Runtime Host returned an invalid initial Session catalog page',
      );
    }
    const sessions: SessionCatalogProjection[] = [];
    const cursors = new Set<string>();
    let page: Extract<SessionCatalogQueryResult, { kind: 'page' }> = first;
    while (true) {
      sessions.push(...page.sessions.map(requireSessionProjection));
      const cursor = page.nextCursor;
      if (cursor === null) return sessions;
      if (cursors.has(cursor)) {
        throw new DesktopRuntimeHostClientError(
          'catalog_unstable',
          'Runtime Host repeated a Session catalog cursor',
        );
      }
      cursors.add(cursor);
      const next = await this.#request('session.catalog.query', {
        kind: 'list_continue',
        ...(filter ? { filter } : {}),
        revision: first.revision,
        cursor,
      });
      if (next.kind === 'revision_changed') return undefined;
      if (next.kind !== 'page') {
        throw new DesktopRuntimeHostClientError(
          'catalog_unstable',
          'Runtime Host returned an invalid Session catalog continuation',
        );
      }
      if (next.revision !== first.revision) return undefined;
      page = next;
    }
  }

  async #requireSession(sessionId: string): Promise<SessionCatalogProjection> {
    const session = await this.getSession(sessionId);
    if (session) return session;
    throw new DesktopRuntimeHostClientError(
      'session_not_found',
      `Runtime Host Session not found: ${sessionId}`,
    );
  }

  #request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationOutput<K>> {
    this.#assertOpen();
    return this.connection.request(operation, input);
  }

  #assertOpen(): void {
    if (this.#closeTask) throw clientClosed();
  }
}

class DesktopSessionHandle implements DesktopRuntimeHostSession {
  readonly snapshot: SessionContinuitySnapshot;
  readonly transcript: Promise<StoredMessage[]>;
  readonly events: AsyncIterable<SubscriptionFrame>;
  #closeTask: Promise<void> | undefined;

  constructor(
    private readonly subscription: RuntimeHostSessionSubscription,
    private readonly onClose: () => void,
  ) {
    this.snapshot = subscription.snapshot;
    this.events = subscription;
    this.transcript = subscription.loadTranscript(decodeStoredMessageForRead);
    void this.transcript.catch(() => undefined);
  }

  close(): Promise<void> {
    this.#closeTask ??= this.subscription.close().finally(this.onClose);
    return this.#closeTask;
  }
}

function requireSessionProjection(item: SessionCatalogItem): SessionCatalogProjection {
  if (!('kind' in item)) return item;
  throw new DesktopRuntimeHostClientError(
    'unsupported_session',
    `Runtime Host Session is not representable by this Desktop Client: ${item.id}`,
  );
}

function clientClosed(): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError('client_closed', 'Desktop Runtime Host Client is closed');
}

function revisionConflict(operation: string, sessionId: string): DesktopRuntimeHostClientError {
  return new DesktopRuntimeHostClientError(
    'revision_conflict',
    `Runtime Host Session kept changing during ${operation}: ${sessionId}`,
  );
}
