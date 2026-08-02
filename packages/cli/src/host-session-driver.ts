import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { setImmediate } from 'node:timers';
import type { QueueEnqueueOutcome, SessionEvent, ToolResultContent } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { InteractionPermissionAnswer } from '@maka/core/interaction';
import type { PermissionMode } from '@maka/core/permission';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import { decodeStoredMessageForRead, userFacingText } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { DEFAULT_SESSION_NAME } from '@maka/core';
import type {
  RuntimeHostConnection,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import { RuntimeHostOperationError, RuntimeHostSubscriptionError } from '@maka/runtime-host/client';
import type {
  InteractionPendingSnapshot,
  SessionCatalogItem,
  SessionCatalogProjection,
  SessionCatalogQueryResult,
  SessionContinuitySnapshot,
  SessionToolEvent,
  TurnSnapshot,
} from '@maka/runtime-host/protocol';
import type {
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaSessionDriver,
  MakaSessionDriverEvent,
  MakaSessionObservation,
  MakaSessionObservationCapability,
  MakaSessionObservationListener,
  MakaSessionMoveResult,
  MakaSessionRewindResult,
  MakaSessionSwitchResult,
  RewindTarget,
  SessionResumeAvailability,
} from './session-driver.js';
import { inspectSessionResumeAvailability } from './session-driver.js';

export interface HostMakaSessionDriverInput {
  readonly connection: RuntimeHostConnection;
  readonly cwd: string;
  readonly llmConnectionSlug: string;
  readonly model: string;
  readonly permissionMode?: PermissionMode;
  readonly orchestrationMode?: OrchestrationMode;
  readonly newId?: () => string;
}

export function createHostMakaSessionDriver(input: HostMakaSessionDriverInput): MakaSessionDriver {
  return new HostMakaSessionDriver(input);
}

class HostMakaSessionDriver implements MakaSessionDriver {
  readonly sessionObservation: MakaSessionObservationCapability;
  readonly #connection: RuntimeHostConnection;
  readonly #newId: () => string;
  #sessionId: string | null = null;
  #cwd: string;
  #llmConnectionSlug: string;
  #model: string;
  #thinkingLevel: ThinkingLevel | undefined;
  #permissionMode: PermissionMode;
  #orchestrationMode: OrchestrationMode;
  #catalog: SessionCatalogProjection | undefined;
  #transcriptRevision: number | undefined;
  #activeTurn: TurnSnapshot | undefined;
  #pendingTurnStart: Promise<TurnSnapshot> | undefined;
  #streamToken: symbol | undefined;
  #observationToken: symbol | undefined;
  #observationSubscription: RuntimeHostSessionSubscription | undefined;
  readonly #observationListeners = new Set<MakaSessionObservationListener>();
  #expectedNextTurnIds = new Set<string>();
  #messageOperations: Promise<void> = Promise.resolve();

  constructor(input: HostMakaSessionDriverInput) {
    this.#connection = input.connection;
    this.#newId = input.newId ?? randomUUID;
    this.#cwd = input.cwd;
    this.#llmConnectionSlug = input.llmConnectionSlug;
    this.#model = input.model;
    this.#permissionMode = input.permissionMode ?? 'ask';
    this.#orchestrationMode = input.orchestrationMode ?? 'default';
    this.sessionObservation = {
      reloadTranscript: () => this.#reloadTranscript(),
      subscribe: (listener) => this.#subscribeSessionObservations(listener),
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sessions: SessionSummary[] = [];
      const initial = await this.#connection.request('session.catalog.query', {
        kind: 'list_start',
        filter: { isArchived: false },
      });
      if (initial.kind !== 'page') throw new Error('Runtime Host returned an invalid Session page');
      let page: Extract<SessionCatalogQueryResult, { kind: 'page' }> = initial;
      const revision = page.revision;
      let restart = false;
      while (true) {
        for (const item of page.sessions)
          sessions.push(projectSessionSummary(requireSession(item)));
        if (page.nextCursor === null) {
          return sessions
            .map((session, index) => ({ session, index }))
            .sort((left, right) => {
              const cwdDelta =
                (left.session.cwd === this.#cwd ? 0 : 1) -
                (right.session.cwd === this.#cwd ? 0 : 1);
              return cwdDelta !== 0 ? cwdDelta : left.index - right.index;
            })
            .map(({ session }) => session);
        }
        const continuation: SessionCatalogQueryResult = await this.#connection.request(
          'session.catalog.query',
          {
            kind: 'list_continue',
            filter: { isArchived: false },
            revision,
            cursor: page.nextCursor,
          },
        );
        if (continuation.kind === 'revision_changed') {
          restart = true;
          break;
        }
        if (continuation.kind !== 'page') {
          throw new Error('Runtime Host returned an invalid Session continuation');
        }
        page = continuation;
      }
      if (!restart) break;
    }
    throw new Error('Session catalog kept changing while it was read');
  }

  getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return inspectSessionResumeAvailability(session);
  }

  async preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const sessionId = await this.#ensureSession();
    const turnId = options.turnId ?? this.#newId();
    const modelText = options.modelText ?? prompt;
    return {
      sessionId,
      turnId,
      events: this.#observeTurn(
        sessionId,
        turnId,
        {
          text: modelText,
          ...(modelText === prompt ? {} : { displayText: prompt }),
        },
        options.turnOrchestration,
      ),
    };
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    throw new Error('Session compaction is not yet available through Runtime Host');
  }

  steer(text: string): Promise<QueueEnqueueOutcome> {
    return this.#submitQueuedMessage(text, 'current_turn');
  }

  queueMessage(text: string): Promise<QueueEnqueueOutcome> {
    return this.#submitQueuedMessage(text, 'next_turn');
  }

  retractQueued(): Promise<string> {
    return this.#serializeMessageOperation(async () => {
      if (!this.#sessionId) return '';
      const result = await this.#connection.request('queue.retract', {
        originHostEpoch: this.#connection.hostEpoch,
        sessionId: this.#sessionId,
        retractId: this.#newId(),
      });
      return joinRetractedMessages(result.retracted);
    });
  }

  interrupt(): Promise<string> {
    return this.#serializeMessageOperation(async () => {
      const sessionId = this.#sessionId;
      const active = await this.#activeTurnForControl();
      if (!sessionId || !active || active.sessionId !== sessionId || isTerminalTurn(active))
        return '';
      const result = await this.#connection.request('turn.interrupt', {
        originHostEpoch: this.#connection.hostEpoch,
        sessionId,
        interruptId: this.#newId(),
        turnId: active.turnId,
        runId: active.runId,
      });
      this.#activeTurn = result.turn;
      return joinRetractedMessages(result.retracted);
    });
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    await this.#connection.request('interaction.answer', {
      interactionId: response.requestId,
      answer: {
        kind: 'permission',
        decision: response.decision,
        rememberForTurn: false,
      },
    });
  }

  async respondToPermission(
    response: InteractionPermissionAnswer & { readonly requestId: string },
  ): Promise<void> {
    await this.#connection.request('interaction.answer', {
      interactionId: response.requestId,
      answer:
        response.decision === 'allow'
          ? {
              kind: 'permission',
              decision: 'allow',
              rememberForTurn: response.rememberForTurn,
            }
          : {
              kind: 'permission',
              decision: 'deny',
              rememberForTurn: false,
            },
    });
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    await this.#connection.request('interaction.answer', {
      interactionId: response.requestId,
      answer: { kind: 'question', answers: response.answers },
    });
  }

  async setModel(model: string, connectionSlug?: string): Promise<void> {
    this.#model = model;
    if (connectionSlug) this.#llmConnectionSlug = connectionSlug;
    this.#thinkingLevel = undefined;
    await this.#commitConfiguration();
  }

  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    this.#thinkingLevel = level;
    await this.#commitConfiguration();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#permissionMode = mode;
    await this.#commitConfiguration();
  }

  async setOrchestrationMode(mode: OrchestrationMode): Promise<void> {
    this.#orchestrationMode = mode;
    await this.#commitConfiguration();
  }

  async renameSession(name: string): Promise<string> {
    if (!this.#sessionId) throw new Error('Cannot rename before a session starts.');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#requireCurrentCatalog();
      const result = await this.#connection.request('session.metadata.update', {
        sessionId: current.id,
        expectedRevision: current.revision,
        patch: { name },
      });
      if (result.kind === 'revision_conflict') {
        this.#catalog = undefined;
        continue;
      }
      const committed = requireSession(result.session);
      this.#adoptCatalog(committed);
      return committed.name;
    }
    throw new Error('Session metadata kept changing while it was updated');
  }

  async moveSession(): Promise<MakaSessionMoveResult> {
    throw new Error('Changing Session cwd is not yet available through Runtime Host');
  }

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    const session = await this.#readCatalog(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const summary = projectSessionSummary(session);
    const availability = await inspectSessionResumeAvailability(summary);
    if (!availability.available) {
      if (!summary.cwd) throw new Error('Session has no working directory and cannot be resumed.');
      throw new Error(`Session cwd no longer exists: ${summary.cwd}`);
    }
    const transcript = await this.#connection.readSessionTranscript(sessionId);
    if (transcript.boundary.kind === 'external') {
      throw new Error(
        `Cannot resume externally isolated session ${sessionId} outside its owning harness.`,
      );
    }
    this.#transcriptRevision = transcript.revision;
    this.#adoptCatalog(session);
    this.#permissionMode = requireBoundaryDisplayMode(transcript.boundary.displayMode);
    return { summary, messages: decodeTranscriptMessages(transcript.messages) };
  }

  async #reloadTranscript(): Promise<StoredMessage[]> {
    if (!this.#sessionId) return [];
    const transcript = await this.#connection.readSessionTranscript(this.#sessionId);
    if (transcript.boundary.kind === 'external') {
      throw new Error('Active Session execution boundary became externally isolated');
    }
    this.#transcriptRevision = transcript.revision;
    this.#permissionMode = requireBoundaryDisplayMode(transcript.boundary.displayMode);
    return decodeTranscriptMessages(transcript.messages);
  }

  #subscribeSessionObservations(listener: MakaSessionObservationListener): () => void {
    const shouldStart = this.#observationListeners.size === 0;
    this.#observationListeners.add(listener);
    if (shouldStart) this.#restartSessionObservation();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#observationListeners.delete(listener);
      if (this.#observationListeners.size === 0) this.#restartSessionObservation();
    };
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    if (!this.#sessionId) return [];
    const messages = decodeTranscriptMessages(
      (await this.#connection.readSessionTranscript(this.#sessionId)).messages,
    );
    const promptByTurn = new Map<string, string>();
    const order: string[] = [];
    for (const message of messages) {
      if (message.type !== 'user' || promptByTurn.has(message.turnId)) continue;
      promptByTurn.set(message.turnId, userFacingText(message));
      order.push(message.turnId);
    }
    return order
      .reverse()
      .map((turnId) => ({ turnId, label: firstLine(promptByTurn.get(turnId) ?? '') }));
  }

  async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    if (!this.#sessionId) throw new Error('Cannot rewind before a session starts.');
    const sourceSessionId = this.#sessionId;
    const transcript = await this.#connection.readSessionTranscript(sourceSessionId);
    const userMessage = decodeTranscriptMessages(transcript.messages).find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!userMessage) throw new Error(`Cannot rewind to turn ${turnId}: no user prompt.`);
    const source = await this.#readCatalog(sourceSessionId);
    if (!source) throw new Error(`Session not found: ${sourceSessionId}`);
    const targetSessionId = this.#newId();
    const revised = await this.#connection.request('session.revision.create', {
      sourceSessionId,
      targetSessionId,
      sourceTurnId: turnId,
      expectedSourceRevision: source.revision,
    });
    if (revised.kind === 'source_revision_conflict') {
      throw new Error('Session changed while the rewind target was prepared');
    }
    return {
      ...(await this.switchSession(targetSessionId)),
      prompt: userFacingText(userMessage),
    };
  }

  startNewSession(): void {
    this.#sessionId = null;
    this.#catalog = undefined;
    this.#transcriptRevision = undefined;
    this.#activeTurn = undefined;
    this.#expectedNextTurnIds.clear();
    this.#restartSessionObservation();
  }

  async stop(): Promise<void> {
    const sessionId = this.#sessionId;
    const active = await this.#activeTurnForControl();
    if (!sessionId || !active || active.sessionId !== sessionId || isTerminalTurn(active)) return;
    this.#activeTurn = await this.#connection.stopTurn({
      sessionId,
      turnId: active.turnId,
      runId: active.runId,
    });
  }

  getSessionId(): string | null {
    return this.#sessionId;
  }

  getOrchestrationMode(): OrchestrationMode {
    return this.#orchestrationMode;
  }

  getPermissionMode(): PermissionMode {
    return this.#permissionMode;
  }

  async #activeTurnForControl(): Promise<TurnSnapshot | undefined> {
    if (this.#activeTurn && !isTerminalTurn(this.#activeTurn)) return this.#activeTurn;
    return (await this.#pendingTurnStart) ?? this.#activeTurn;
  }

  async #ensureSession(): Promise<string> {
    if (this.#sessionId) return this.#sessionId;
    const sessionId = this.#newId();
    const created = requireSession(
      await this.#connection.request('session.create', {
        sessionId,
        cwd: await realpath(this.#cwd),
        name: DEFAULT_SESSION_NAME,
        modelTarget: {
          kind: 'explicit',
          connectionSlug: this.#llmConnectionSlug,
          model: this.#model,
        },
        ...(this.#thinkingLevel === undefined ? {} : { thinkingLevel: this.#thinkingLevel }),
        permissionMode: this.#permissionMode,
        orchestrationMode: this.#orchestrationMode,
      }),
    );
    this.#transcriptRevision = created.revision;
    this.#adoptCatalog(created);
    return created.id;
  }

  async *#observeTurn(
    sessionId: string,
    turnId: string,
    content: { text: string; displayText?: string },
    turnOrchestration?: MakaPreparePromptOptions['turnOrchestration'],
  ): AsyncIterable<MakaSessionDriverEvent> {
    const token = Symbol('HostMakaSessionDriver stream');
    this.#streamToken = token;
    this.#expectedNextTurnIds.clear();
    let subscription: RuntimeHostSessionSubscription | undefined;
    const pendingStart = (async () => {
      subscription = await this.#connection.openSessionSubscription({ sessionId });
      return this.#connection.startTurn({
        sessionId,
        turnId,
        content,
        ...(turnOrchestration === undefined ? {} : { turnOrchestration }),
      });
    })();
    this.#pendingTurnStart = pendingStart;
    const chainTurnIds = new Set([turnId]);
    const projectedInteractions = new Set<string>();
    let queueRevision = -1;
    let waitingForFollowup = false;
    try {
      let started: TurnSnapshot;
      try {
        started = await pendingStart;
      } finally {
        if (this.#pendingTurnStart === pendingStart) this.#pendingTurnStart = undefined;
      }
      this.#activeTurn = started;
      if (!subscription) throw new Error('Runtime Host Session subscription did not open');
      yield* projectSnapshotState(
        subscription.snapshot,
        turnId,
        projectedInteractions,
        queueRevision,
      );
      queueRevision = subscription.snapshot.queue.queueRevision;
      waitingForFollowup = subscription.snapshot.queue.followup.length > 0;

      for await (const frame of subscription) {
        if (frame.kind === 'subscription.closed') {
          throw new Error(`Runtime Host Session subscription closed: ${frame.reason}`);
        }
        if (frame.kind === 'subscription.session_delta') {
          if (!chainTurnIds.has(frame.delta.turnId)) continue;
          yield {
            id: this.#newId(),
            type: frame.delta.kind === 'text' ? 'text_delta' : 'thinking_delta',
            turnId: frame.delta.turnId,
            ts: Date.now(),
            messageId: frame.delta.messageId,
            text: frame.delta.text,
          };
          continue;
        }
        if (frame.kind === 'subscription.session_event') {
          if (!chainTurnIds.has(frame.event.turnId)) continue;
          yield projectToolEvent(sessionId, frame.event);
          continue;
        }

        const snapshot = frame.snapshot;
        const rootTurn = snapshot.rootTurn;
        if (rootTurn && !chainTurnIds.has(rootTurn.turnId)) {
          if (this.#expectedNextTurnIds.delete(rootTurn.turnId) || waitingForFollowup) {
            chainTurnIds.add(rootTurn.turnId);
          }
        }
        if (rootTurn && chainTurnIds.has(rootTurn.turnId)) this.#activeTurn = rootTurn;
        yield* projectSnapshotState(
          snapshot,
          rootTurn?.turnId ?? turnId,
          projectedInteractions,
          queueRevision,
        );
        queueRevision = snapshot.queue.queueRevision;

        if (rootTurn && chainTurnIds.has(rootTurn.turnId) && isTerminalTurn(rootTurn)) {
          if (snapshot.queue.followup.length > 0 || this.#expectedNextTurnIds.size > 0) {
            waitingForFollowup = true;
            continue;
          }
          yield* projectTerminalTurn(rootTurn);
          return;
        }
        waitingForFollowup = snapshot.queue.followup.length > 0;
      }
      throw new Error('Runtime Host Session subscription ended before the turn became terminal');
    } finally {
      await subscription?.close().catch(() => {});
      if (this.#streamToken === token) {
        this.#streamToken = undefined;
        if (this.#activeTurn && chainTurnIds.has(this.#activeTurn.turnId)) {
          this.#activeTurn = undefined;
        }
        this.#expectedNextTurnIds.clear();
        this.#restartSessionObservation();
      }
    }
  }

  #restartSessionObservation(): void {
    const token = Symbol('HostMakaSessionDriver observation');
    this.#observationToken = token;
    const previous = this.#observationSubscription;
    this.#observationSubscription = undefined;
    if (previous) void previous.close().catch(() => {});
    const sessionId = this.#sessionId;
    if (!sessionId || this.#observationListeners.size === 0) return;
    // Let switchSession return its durable cut before catch-up can reach the
    // view. The Host replay covers anything emitted during this one-tick gap.
    setImmediate(() => {
      if (this.#observationToken !== token) return;
      void this.#observeSessionLoop(sessionId, token);
    });
  }

  async #observeSessionLoop(sessionId: string, token: symbol): Promise<void> {
    let retryDelayMs = 25;
    let forceReload = false;
    while (
      this.#observationToken === token &&
      this.#sessionId === sessionId &&
      this.#observationListeners.size > 0
    ) {
      const attempt = this.#observeSession(sessionId, token, forceReload).then(
        (result) => ({ kind: 'completed' as const, result }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      );
      const outcome = await Promise.race([
        attempt,
        this.#connection.closed.then(
          () => ({ kind: 'connection_closed' as const }),
          () => ({ kind: 'connection_closed' as const }),
        ),
      ]);
      if (
        this.#observationToken !== token ||
        this.#sessionId !== sessionId ||
        this.#observationListeners.size === 0
      ) {
        return;
      }
      if (
        outcome.kind === 'connection_closed' ||
        (outcome.kind === 'failed' &&
          outcome.error instanceof RuntimeHostSubscriptionError &&
          outcome.error.reason === 'connection_closed')
      ) {
        await this.#publishObservationFailure(
          sessionId,
          'runtime_host_connection_closed',
          'Runtime Host connection closed; live Session updates are unavailable.',
        );
        return;
      }
      if (outcome.kind === 'completed' && outcome.result === 'stop') return;
      if (outcome.kind === 'failed' && !isRecoverableObservationFailure(outcome.error)) {
        const sessionRemoved =
          outcome.error instanceof RuntimeHostOperationError && outcome.error.code === 'not_found';
        await this.#publishObservationFailure(
          sessionId,
          sessionRemoved ? 'runtime_host_session_removed' : 'runtime_host_observation_failed',
          sessionRemoved
            ? 'Runtime Host Session no longer exists; live Session updates stopped.'
            : 'Runtime Host Session observation stopped after an unrecoverable subscription failure.',
        );
        return;
      }

      forceReload = true;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 250);
    }
  }

  async #observeSession(
    sessionId: string,
    token: symbol,
    forceReload: boolean,
  ): Promise<'retry' | 'stop'> {
    const subscription = await this.#connection.openSessionSubscription({ sessionId });
    if (this.#observationToken !== token) {
      await subscription.close().catch(() => {});
      return 'stop';
    }
    this.#observationSubscription = subscription;
    const projectedInteractions = new Set<string>();
    let queueRevision = -1;
    let rootFingerprint = turnFingerprint(subscription.snapshot.rootTurn);
    try {
      this.#activeTurn = subscription.snapshot.rootTurn ?? undefined;
      await this.#publishObservation({
        sessionId,
        events: projectSnapshotState(
          subscription.snapshot,
          observationTurnId(subscription.snapshot, sessionId),
          projectedInteractions,
          queueRevision,
        ),
        reloadTranscript:
          forceReload ||
          (subscription.snapshot.rootTurn !== null &&
            isTerminalTurn(subscription.snapshot.rootTurn)) ||
          subscription.snapshot.session.metadataRevision !== this.#transcriptRevision,
        cut: isRunningTurn(subscription.snapshot.rootTurn) ? 'active' : 'idle',
      });
      queueRevision = subscription.snapshot.queue.queueRevision;

      for await (const frame of subscription) {
        if (this.#observationToken !== token) return 'stop';
        if (frame.kind === 'subscription.closed') {
          if (frame.reason === 'session_removed') {
            await this.#publishObservationFailure(
              sessionId,
              'runtime_host_session_removed',
              'Runtime Host Session no longer exists; live Session updates stopped.',
            );
            return 'stop';
          }
          return 'retry';
        }
        if (frame.kind === 'subscription.session_delta') {
          await this.#publishObservation({
            sessionId,
            events: [
              {
                id: this.#newId(),
                type: frame.delta.kind === 'text' ? 'text_delta' : 'thinking_delta',
                turnId: frame.delta.turnId,
                ts: Date.now(),
                messageId: frame.delta.messageId,
                text: frame.delta.text,
              },
            ],
            reloadTranscript: false,
            cut: 'active',
          });
          continue;
        }
        if (frame.kind === 'subscription.session_event') {
          await this.#publishObservation({
            sessionId,
            events: [projectToolEvent(sessionId, frame.event)],
            reloadTranscript: false,
            cut: 'active',
          });
          continue;
        }

        const snapshot = frame.snapshot;
        const previousFingerprint = rootFingerprint;
        rootFingerprint = turnFingerprint(snapshot.rootTurn);
        this.#activeTurn = snapshot.rootTurn ?? undefined;
        const events = projectSnapshotState(
          snapshot,
          observationTurnId(snapshot, sessionId),
          projectedInteractions,
          queueRevision,
        );
        queueRevision = snapshot.queue.queueRevision;
        if (
          snapshot.rootTurn &&
          isTerminalTurn(snapshot.rootTurn) &&
          rootFingerprint !== previousFingerprint
        ) {
          events.push(...projectTerminalTurn(snapshot.rootTurn));
        }
        await this.#publishObservation({
          sessionId,
          events,
          reloadTranscript: rootFingerprint !== previousFingerprint,
          cut: isRunningTurn(snapshot.rootTurn) ? 'active' : 'idle',
        });
      }
      return 'retry';
    } finally {
      if (this.#observationSubscription === subscription) {
        this.#observationSubscription = undefined;
      }
      await subscription.close().catch(() => {});
    }
  }

  async #publishObservationFailure(
    sessionId: string,
    code:
      | 'runtime_host_connection_closed'
      | 'runtime_host_observation_failed'
      | 'runtime_host_session_removed',
    message: string,
  ): Promise<void> {
    const turnId = this.#activeTurn?.turnId ?? `session-observation-${sessionId}`;
    this.#activeTurn = undefined;
    await this.#publishObservation({
      sessionId,
      events: [
        {
          id: this.#newId(),
          type: 'error',
          turnId,
          ts: Date.now(),
          recoverable: true,
          code,
          reason: code,
          message,
        },
      ],
      reloadTranscript: false,
      cut: 'unavailable',
    });
  }

  async #publishObservation(observation: MakaSessionObservation): Promise<void> {
    if (this.#streamToken) return;
    await Promise.all(
      [...this.#observationListeners].map(async (listener) => {
        try {
          await listener(observation);
        } catch {
          // One view must not terminate the shared Host subscription.
        }
      }),
    );
  }

  #submitQueuedMessage(
    text: string,
    placement: 'current_turn' | 'next_turn',
  ): Promise<QueueEnqueueOutcome> {
    return this.#serializeMessageOperation(async () => {
      if (!this.#sessionId) return { kind: 'fallback' };
      const result = await this.#connection.request('turn.message.submit', {
        originHostEpoch: this.#connection.hostEpoch,
        sessionId: this.#sessionId,
        messageId: this.#newId(),
        content: { text },
        placement,
      });
      if (result.disposition === 'turn_started') {
        this.#expectedNextTurnIds.add(result.turnId);
      }
      return { kind: 'queued' };
    });
  }

  #serializeMessageOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#messageOperations.then(operation, operation);
    this.#messageOperations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #commitConfiguration(): Promise<void> {
    if (!this.#sessionId) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#requireCurrentCatalog();
      const result = await this.#connection.request('session.configuration.update', {
        sessionId: current.id,
        expectedRevision: current.revision,
        configuration: {
          modelTarget: {
            kind: 'explicit',
            connectionSlug: this.#llmConnectionSlug,
            model: this.#model,
          },
          thinkingLevel: this.#thinkingLevel ?? null,
          permissionMode: this.#permissionMode,
          collaborationMode: current.collaborationMode,
          orchestrationMode: this.#orchestrationMode,
        },
      });
      if (result.kind === 'revision_conflict') {
        this.#catalog = undefined;
        continue;
      }
      this.#adoptCatalog(requireSession(result.session));
      return;
    }
    throw new Error('Session configuration kept changing while it was updated');
  }

  async #requireCurrentCatalog(): Promise<SessionCatalogProjection> {
    if (!this.#sessionId) throw new Error('No active Session');
    if (this.#catalog?.id === this.#sessionId) return this.#catalog;
    const session = await this.#readCatalog(this.#sessionId);
    if (!session) throw new Error(`Session not found: ${this.#sessionId}`);
    this.#catalog = session;
    return session;
  }

  async #readCatalog(sessionId: string): Promise<SessionCatalogProjection | null> {
    const result = await this.#connection.request('session.catalog.query', {
      kind: 'get',
      sessionId,
    });
    if (result.kind !== 'session') {
      throw new Error('Runtime Host returned an invalid Session catalog result');
    }
    return result.session === null ? null : requireSession(result.session);
  }

  #adoptCatalog(session: SessionCatalogProjection): void {
    const previousSessionId = this.#sessionId;
    this.#catalog = session;
    this.#sessionId = session.id;
    this.#cwd = session.cwd;
    this.#llmConnectionSlug = session.llmConnectionSlug;
    this.#model = session.model;
    this.#thinkingLevel = session.thinkingLevel;
    this.#permissionMode = session.permissionMode;
    this.#orchestrationMode = session.orchestrationMode;
    if (previousSessionId !== session.id) this.#restartSessionObservation();
  }
}

function isRecoverableObservationFailure(error: unknown): boolean {
  return (
    error instanceof RuntimeHostSubscriptionError &&
    (error.reason === 'slow_consumer' || error.reason === 'sequence_gap')
  );
}

function projectSnapshotState(
  snapshot: SessionContinuitySnapshot,
  turnId: string,
  projectedInteractions: Set<string>,
  previousQueueRevision: number,
): MakaSessionDriverEvent[] {
  const events: MakaSessionDriverEvent[] = [];
  if (snapshot.queue.queueRevision !== previousQueueRevision) {
    events.push({
      id: `queue-${snapshot.queue.hostEpoch}-${snapshot.queue.queueRevision}`,
      type: 'queue_update',
      turnId,
      ts: Date.now(),
      steering: snapshot.queue.steering.map((entry) => entry.content.text),
      followup: snapshot.queue.followup.map((entry) => entry.content.text),
    });
  }
  const pendingInteractionIds = new Set(
    snapshot.interactions.pending.map((interaction) => interaction.interactionId),
  );
  for (const interactionId of projectedInteractions) {
    if (pendingInteractionIds.has(interactionId)) continue;
    projectedInteractions.delete(interactionId);
    events.push({
      id: `interaction-resolved-${interactionId}`,
      type: 'host_interaction_resolved',
      turnId,
      ts: Date.now(),
      requestId: interactionId,
    });
  }
  for (const interaction of snapshot.interactions.pending) {
    if (projectedInteractions.has(interaction.interactionId)) continue;
    projectedInteractions.add(interaction.interactionId);
    const event = projectInteraction(interaction);
    if (event) events.push(event);
  }
  return events;
}

function projectInteraction(
  interaction: InteractionPendingSnapshot,
): MakaSessionDriverEvent | undefined {
  if (interaction.request.kind === 'permission') {
    return {
      id: `interaction-${interaction.interactionId}`,
      type: 'host_interaction_permission_request',
      turnId: interaction.turnId,
      ts: Date.now(),
      requestId: interaction.interactionId,
      toolUseId: interaction.request.toolUseId,
      prompt: interaction.request.prompt,
    };
  }
  return {
    id: `interaction-${interaction.interactionId}`,
    type: 'user_question_request',
    turnId: interaction.turnId,
    ts: Date.now(),
    requestId: interaction.interactionId,
    toolUseId: interaction.request.toolUseId,
    questions: interaction.request.questions.map((question) => ({
      question: question.question,
      options: question.options.map((option) => ({ ...option })),
    })),
  };
}

function projectToolEvent(sessionId: string, event: SessionToolEvent): SessionEvent {
  switch (event.type) {
    case 'tool_start':
      return {
        ...event,
        args: undefined,
      };
    case 'tool_output_delta':
      return {
        ...event,
        sessionId,
        toolCallId: event.toolUseId,
      };
    case 'tool_progress':
      return event;
    case 'tool_result':
      return {
        id: event.id,
        type: event.type,
        turnId: event.turnId,
        ts: event.ts,
        toolUseId: event.toolUseId,
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        isError: event.status === 'errored',
        content: projectedToolResultContent(event.status),
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      };
  }
}

function projectedToolResultContent(
  status: Extract<SessionToolEvent, { type: 'tool_result' }>['status'],
): ToolResultContent {
  return {
    kind: 'text',
    text:
      status === 'errored'
        ? 'Tool failed. The complete result will load from the durable transcript.'
        : 'Tool completed. The complete result will load from the durable transcript.',
  };
}

function projectTerminalTurn(turn: TurnSnapshot): SessionEvent[] {
  if (turn.status === 'completed') {
    return [
      {
        id: turn.terminalEventId,
        type: 'complete',
        turnId: turn.turnId,
        ts: Date.now(),
        stopReason: 'end_turn',
      },
    ];
  }
  if (turn.status === 'cancelled') {
    return [
      {
        id: turn.terminalEventId,
        type: 'abort',
        turnId: turn.turnId,
        ts: Date.now(),
        reason: turn.abortSource === 'redirect' ? 'redirect' : 'user_stop',
      },
    ];
  }
  if (turn.status === 'failed') {
    return [
      {
        id: turn.terminalEventId,
        type: 'error',
        turnId: turn.turnId,
        ts: Date.now(),
        recoverable: false,
        reason: turn.failureClass,
        message: `Turn failed: ${turn.failureClass}`,
      },
    ];
  }
  return [];
}

function observationTurnId(snapshot: SessionContinuitySnapshot, sessionId: string): string {
  return snapshot.rootTurn?.turnId ?? `session-observation-${sessionId}`;
}

function turnFingerprint(turn: TurnSnapshot | null): string {
  if (!turn) return 'idle';
  return `${turn.turnId}:${turn.runId}:${turn.status}:${
    isTerminalTurn(turn) ? turn.terminalEventId : ''
  }`;
}

function isRunningTurn(turn: TurnSnapshot | null): boolean {
  return turn !== null && !isTerminalTurn(turn);
}

function requireSession(item: SessionCatalogItem): SessionCatalogProjection {
  if ('kind' in item) {
    throw new Error(`Session ${item.id} cannot be represented by this Runtime Host client`);
  }
  return item;
}

function projectSessionSummary(session: SessionCatalogProjection): SessionSummary {
  return {
    id: session.id,
    cwd: session.cwd,
    ...(session.projectId !== undefined ? { projectId: session.projectId } : {}),
    name: session.name,
    isFlagged: session.isFlagged,
    isArchived: session.isArchived,
    labels: [...session.labels],
    hasUnread: session.hasUnread,
    ...(session.lastMessageAt === undefined ? {} : { lastMessageAt: session.lastMessageAt }),
    ...(session.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: session.lastMessagePreview }),
    status: session.status,
    ...(session.blockedReason === undefined ? {} : { blockedReason: session.blockedReason }),
    ...(session.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: session.statusUpdatedAt }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.branchOfTurnId === undefined ? {} : { branchOfTurnId: session.branchOfTurnId }),
    ...(session.revisionRootSessionId === undefined
      ? {}
      : { revisionRootSessionId: session.revisionRootSessionId }),
    ...(session.revisionParentSessionId === undefined
      ? {}
      : { revisionParentSessionId: session.revisionParentSessionId }),
    ...(session.revisionOfTurnId === undefined
      ? {}
      : { revisionOfTurnId: session.revisionOfTurnId }),
    ...(session.revisionIndex === undefined ? {} : { revisionIndex: session.revisionIndex }),
    ...(session.revisionState === undefined ? {} : { revisionState: session.revisionState }),
    backend: session.backend,
    llmConnectionSlug: session.llmConnectionSlug,
    connectionLocked: session.connectionLocked,
    model: session.model,
    ...(session.thinkingLevel === undefined ? {} : { thinkingLevel: session.thinkingLevel }),
    permissionMode: session.permissionMode,
    collaborationMode: session.collaborationMode,
    orchestrationMode: session.orchestrationMode,
  };
}

function joinRetractedMessages(
  messages: readonly { readonly content: { readonly text: string } }[],
): string {
  return messages.map((message) => message.content.text).join('\n\n');
}

function isTerminalTurn(
  turn: TurnSnapshot,
): turn is Extract<TurnSnapshot, { status: 'completed' | 'failed' | 'cancelled' }> {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}

function requireBoundaryDisplayMode(mode: PermissionMode | null): PermissionMode {
  if (mode === null) throw new Error('Externally isolated Session has no local permission mode');
  return mode;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? '(empty prompt)'
  );
}

function decodeTranscriptMessages(records: readonly unknown[]): StoredMessage[] {
  return records.map((record) => decodeStoredMessageForRead(record));
}
