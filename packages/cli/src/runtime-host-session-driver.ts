import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SESSION_NAME,
  decodeStoredMessageForRead,
  userFacingText,
  type ActiveInteractionRequestEvent,
  type QueueEnqueueOutcome,
  type SessionEvent,
  type SessionSummary,
  type ShellRunUpdate,
  type StoredMessage,
} from '@maka/core';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { PermissionMode } from '@maka/core/permission';
import { executionBoundaryDisplayMode } from '@maka/core/sandbox-boundary';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { ContextDiagnostics } from '@maka/runtime';
import {
  RuntimeHostSessionProjector,
  isRuntimeHostTerminalTurn as isTerminalTurn,
  type RuntimeHostTerminalTurn as TerminalTurnSnapshot,
} from '@maka/runtime-host/adapter';
import type {
  DirectRequestOperationKey,
  RuntimeHostConnection,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import { readRuntimeHostResources, readRuntimeHostSessions } from '@maka/runtime-host/client';
import type {
  InteractionAnsweredSnapshot,
  InteractionPendingSnapshot,
  OperationInput,
  OperationOutput,
  SessionCatalogItem,
  SessionCatalogProjection,
  SessionContinuitySnapshot,
  SessionUpdateResult,
  SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import type {
  InspectCwdChanges,
  MakaPreparePromptOptions,
  MakaPreparedSessionTurn,
  MakaSessionDriver,
  MakaSessionMoveResult,
  MakaSessionRewindResult,
  MakaSessionSwitchResult,
  RewindTarget,
  SessionResumeAvailability,
} from './session-driver.js';
import { inspectSessionResumeAvailability } from './session-driver.js';
import {
  cwdRank,
  firstLine,
  inspectGitCwdChanges,
  resolveMoveCwd,
} from './session-driver-policy.js';
const MAX_CATALOG_ATTEMPTS = 3;
const MAX_PENDING_FRAMES = 512;
const MAX_PENDING_EVENTS_PER_TURN = 1_024;

export interface RuntimeHostMakaSessionDriverInput {
  connection: RuntimeHostConnection;
  cwd: string;
  llmConnectionSlug: string;
  model: string;
  permissionMode?: PermissionMode;
  orchestrationMode?: OrchestrationMode;
  newId?: () => string;
  now?: () => number;
  inspectCwdChanges?: InspectCwdChanges;
}

export interface RuntimeHostMakaSessionDriver extends MakaSessionDriver {
  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]>;
  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void;
}

export function createRuntimeHostMakaSessionDriver(
  input: RuntimeHostMakaSessionDriverInput,
): RuntimeHostMakaSessionDriver {
  return new RuntimeHostMakaSessionDriverImpl(input);
}

class RuntimeHostMakaSessionDriverImpl implements RuntimeHostMakaSessionDriver {
  readonly #connection: RuntimeHostConnection;
  readonly #newId: () => string;
  readonly #now: () => number;
  readonly #inspectCwdChanges: InspectCwdChanges;
  #sessionId: string | null = null;
  #cwd: string;
  #model: string;
  #llmConnectionSlug: string;
  #thinkingLevel: ThinkingLevel | undefined;
  #permissionMode: PermissionMode;
  #activeBoundaryDisplayMode: PermissionMode | undefined;
  #orchestrationMode: OrchestrationMode;
  #channel: RuntimeHostSessionChannel | undefined;
  #channelOpening: { sessionId: string; promise: Promise<RuntimeHostSessionChannel> } | undefined;
  readonly #startedTurnReattachTails = new Map<number, Promise<void>>();
  #sessionGeneration = 0;
  #channelGeneration = 0;
  readonly #startedTurnListeners = new Set<(turn: MakaPreparedSessionTurn) => void>();
  readonly #claimedTurnIds = new Set<string>();
  readonly #shellRunListeners = new Set<(update: ShellRunUpdate) => void>();
  readonly #resolvedInteractionListeners = new Set<
    (sessionId: string, requestId: string) => void
  >();
  readonly #transcriptListeners = new Set<
    (sessionId: string, turnId: string, messages: StoredMessage[]) => void
  >();

  constructor(input: RuntimeHostMakaSessionDriverInput) {
    this.#connection = input.connection;
    this.#newId = input.newId ?? randomUUID;
    this.#now = input.now ?? Date.now;
    this.#inspectCwdChanges = input.inspectCwdChanges ?? inspectGitCwdChanges;
    this.#cwd = input.cwd;
    this.#model = input.model;
    this.#llmConnectionSlug = input.llmConnectionSlug;
    this.#permissionMode = input.permissionMode ?? 'ask';
    this.#orchestrationMode = input.orchestrationMode ?? 'default';
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = (await readRuntimeHostSessions(this.#connection))
      .flatMap(representableSession)
      .map(sessionSummary);
    return sessions
      .map((session, index) => ({ session, index }))
      .sort((left, right) => {
        const cwdDelta = cwdRank(left.session, this.#cwd) - cwdRank(right.session, this.#cwd);
        return cwdDelta !== 0 ? cwdDelta : left.index - right.index;
      })
      .map(({ session }) => session);
  }

  getSessionResumeAvailability(session: SessionSummary): Promise<SessionResumeAvailability> {
    return inspectSessionResumeAvailability(session);
  }

  async preparePrompt(
    prompt: string,
    options: MakaPreparePromptOptions = {},
  ): Promise<MakaPreparedSessionTurn> {
    const sessionId = await this.#ensureSession();
    const sessionGeneration = this.#sessionGeneration;
    const configuration = await this.#loadConfiguration(sessionId);
    this.#assertCurrentSession(sessionId, sessionGeneration);
    const channel = await this.#ensureChannel(sessionId);
    this.#assertCurrentSession(sessionId, sessionGeneration);
    this.#adoptLoadedConfiguration(configuration);
    const turnId = options.turnId ?? this.#newId();
    this.#claimedTurnIds.add(turnId);
    const events = channel.eventsForTurn(turnId);
    const modelText = options.modelText ?? prompt;
    try {
      await this.#request('turn.start', {
        sessionId,
        turnId,
        content: {
          text: modelText,
          ...(modelText === prompt ? {} : { displayText: prompt }),
        },
        ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
      });
    } catch (error) {
      channel.failTurn(turnId, error);
      throw error;
    }
    return { sessionId, turnId, events, summary: sessionSummary(configuration.session) };
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    const sessionId = this.#requireSession('compact');
    const channel = await this.#ensureChannel(sessionId);
    const turnId = this.#newId();
    this.#claimedTurnIds.add(turnId);
    const events = channel.eventsForTurn(turnId);
    try {
      await this.#request('context.compact', { sessionId, turnId });
    } catch (error) {
      channel.failTurn(turnId, error);
      throw error;
    }
    yield* events;
  }

  async *resumeLatest(): AsyncIterable<SessionEvent> {
    const sessionId = this.#requireSession('resume');
    const plan = await this.#request('turn.resume.query', { sessionId });
    if (plan.disposition !== 'ready') {
      throw new Error(`Safe-boundary resume parked: ${plan.reason}`);
    }
    const channel = await this.#ensureChannel(sessionId);
    const turnId = this.#newId();
    this.#claimedTurnIds.add(turnId);
    const events = channel.eventsForTurn(turnId);
    try {
      const result = await this.#request('turn.resume.start', {
        sessionId,
        turnId,
        sourceRunId: plan.sourceRunId,
        sourceRuntimeEventHighWater: plan.sourceRuntimeEventHighWater,
      });
      if (result.kind !== 'started') {
        channel.failTurn(turnId, new Error(`Safe-boundary resume parked: ${result.plan.reason}`));
      }
    } catch (error) {
      channel.failTurn(turnId, error);
      throw error;
    }
    yield* events;
  }

  async steer(text: string): Promise<QueueEnqueueOutcome> {
    return this.#enqueue(text, 'current_turn');
  }

  async queueMessage(text: string): Promise<QueueEnqueueOutcome> {
    return this.#enqueue(text, 'next_turn');
  }

  async takePendingFollowup(): Promise<string | null> {
    // Runtime Host owns the terminal transition and starts the queued follow-up
    // atomically. Returning its text here would make the TUI submit it twice.
    return null;
  }

  async retractQueued(): Promise<string> {
    if (!this.#sessionId) return '';
    const result = await this.#request('queue.retract', {
      originHostEpoch: this.#connection.hostEpoch,
      sessionId: this.#sessionId,
      retractId: this.#newId(),
    });
    return result.retracted.map((entry) => entry.content.text).join('\n\n');
  }

  async respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void> {
    const sessionId = this.#requireSession('respond to permission');
    const pending = this.#channel?.pendingInteraction(response.requestId);
    const answered = await this.#request('interaction.answer', {
      sessionId,
      interactionId: response.requestId,
      answer: { kind: 'sandbox_boundary', decision: response.decision },
    });
    if (pending) this.#channel?.publishInteractionAnswer(answered, pending);
  }

  async respondToUserQuestion(response: UserQuestionResponse): Promise<void> {
    const sessionId = this.#requireSession('respond to a user question');
    const pending = this.#channel?.pendingInteraction(response.requestId);
    const answered = await this.#request('interaction.answer', {
      sessionId,
      interactionId: response.requestId,
      answer: { kind: 'question', answers: response.answers },
    });
    if (pending) this.#channel?.publishInteractionAnswer(answered, pending);
  }

  async setModel(model: string, connectionSlug?: string): Promise<void> {
    const nextConnection = connectionSlug ?? this.#llmConnectionSlug;
    if (this.#sessionId) {
      const session = await this.#updateConfiguration(this.#sessionId, {
        modelTarget: { kind: 'explicit', connectionSlug: nextConnection, model },
        thinkingLevel: null,
      });
      this.#adoptConfiguration(session);
      return;
    }
    this.#model = model;
    this.#llmConnectionSlug = nextConnection;
    this.#thinkingLevel = undefined;
  }

  async setThinkingLevel(level: ThinkingLevel | undefined): Promise<void> {
    if (this.#sessionId) {
      this.#adoptConfiguration(
        await this.#updateConfiguration(this.#sessionId, { thinkingLevel: level ?? null }),
      );
      return;
    }
    this.#thinkingLevel = level;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.#sessionId) {
      const session = await this.#updateConfiguration(this.#sessionId, { permissionMode: mode });
      this.#permissionMode = session.permissionMode;
      const boundary = await this.#request('session.execution_boundary.query', {
        sessionId: this.#sessionId,
      });
      this.#activeBoundaryDisplayMode = executionBoundaryDisplayMode(boundary);
      return;
    }
    this.#permissionMode = mode;
  }

  async setOrchestrationMode(mode: OrchestrationMode): Promise<void> {
    if (this.#sessionId) {
      this.#adoptConfiguration(
        await this.#updateConfiguration(this.#sessionId, { orchestrationMode: mode }),
      );
      return;
    }
    this.#orchestrationMode = mode;
  }

  async renameSession(name: string): Promise<string> {
    const sessionId = this.#requireSession('rename');
    const session = await updateSession(this.#connection, sessionId, (current) =>
      this.#request('session.metadata.update', {
        sessionId,
        expectedRevision: current.revision,
        patch: { name },
      }),
    );
    return session.name;
  }

  async moveSession(rawCwd: string): Promise<MakaSessionMoveResult> {
    const sessionId = this.#requireSession('move');
    const nextCwd = await resolveMoveCwd(rawCwd, this.#cwd);
    const previousCwd = this.#cwd;
    if (nextCwd === previousCwd) {
      return { previousCwd, cwd: nextCwd, changed: false, oldCwdDirty: false };
    }
    const oldCwdDirty = await this.#inspectCwdChanges(previousCwd).catch(() => undefined);
    const session = await updateSession(this.#connection, sessionId, (current) =>
      this.#request('session.cwd.relocate', {
        sessionId,
        expectedRevision: current.revision,
        cwd: nextCwd,
      }),
    );
    this.#cwd = session.cwd;
    return { previousCwd, cwd: this.#cwd, changed: true, oldCwdDirty };
  }

  async switchSession(sessionId: string): Promise<MakaSessionSwitchResult> {
    const session = await getSession(this.#connection, sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const summary = sessionSummary(session);
    const availability = await inspectSessionResumeAvailability(summary);
    if (!availability.available) {
      throw new Error(
        summary.cwd ? `Session cwd no longer exists: ${summary.cwd}` : availability.reason,
      );
    }
    const boundary = await this.#request('session.execution_boundary.query', { sessionId });
    if (boundary.kind === 'external') {
      throw new Error(
        `Cannot resume externally isolated session ${sessionId} outside its owning harness.`,
      );
    }
    const expectedChannelGeneration = this.#channelGeneration;
    const nextSessionGeneration = this.#sessionGeneration + 1;
    const opened = await this.#openSessionChannel(sessionId, nextSessionGeneration);
    if (this.#channelGeneration !== expectedChannelGeneration) {
      await opened.channel.close().catch(() => undefined);
      throw new Error(`Session changed while opening Runtime Host channel: ${sessionId}`);
    }
    this.#sessionGeneration = nextSessionGeneration;
    this.#channelGeneration += 1;
    this.#sessionId = sessionId;
    await this.#replaceChannel(opened.channel);
    this.#cwd = session.cwd;
    this.#adoptConfiguration(session);
    this.#activeBoundaryDisplayMode = executionBoundaryDisplayMode(boundary);
    this.#permissionMode = boundary.kind === 'bypass' ? 'bypass' : 'ask';
    const attachedTurnId = opened.attachedTurnId ?? opened.channel.firstObservedTurnId;
    opened.channel.activate(attachedTurnId);
    return {
      summary,
      messages: opened.messages,
      ...(attachedTurnId
        ? {
            activeTurn: {
              sessionId,
              turnId: attachedTurnId,
              events: opened.channel.eventsForTurn(attachedTurnId),
            },
          }
        : {}),
    };
  }

  async listRewindTargets(): Promise<RewindTarget[]> {
    if (!this.#sessionId) return [];
    const messages = await loadCurrentMessages(this.#connection, this.#sessionId);
    const prompts = new Map<string, string>();
    const order: string[] = [];
    for (const message of messages) {
      if (message.type !== 'user' || prompts.has(message.turnId)) continue;
      prompts.set(message.turnId, userFacingText(message));
      order.push(message.turnId);
    }
    return order.reverse().map((turnId) => ({
      turnId,
      label: firstLine(prompts.get(turnId) ?? ''),
    }));
  }

  async rewindToTurn(turnId: string): Promise<MakaSessionRewindResult> {
    const sourceSessionId = this.#requireSession('rewind');
    const messages = await loadCurrentMessages(this.#connection, sourceSessionId);
    const promptMessage = messages.find(
      (message): message is Extract<StoredMessage, { type: 'user' }> =>
        message.type === 'user' && message.turnId === turnId,
    );
    if (!promptMessage) throw new Error(`Cannot rewind to turn ${turnId}: no user prompt.`);
    const targetSessionId = this.#newId();
    for (let attempt = 0; attempt < MAX_CATALOG_ATTEMPTS; attempt += 1) {
      const current = await getSession(this.#connection, sourceSessionId);
      if (!current) throw new Error(`Session not found: ${sourceSessionId}`);
      const result = await this.#request('session.revision.create', {
        sourceSessionId,
        targetSessionId,
        sourceTurnId: turnId,
        expectedSourceRevision: current.revision,
      });
      if (result.kind === 'committed') {
        return {
          ...(await this.switchSession(requireSession(result.session).id)),
          prompt: userFacingText(promptMessage),
        };
      }
    }
    throw new Error(`Session kept changing while rewinding: ${sourceSessionId}`);
  }

  startNewSession(): void {
    this.#sessionGeneration += 1;
    this.#channelGeneration += 1;
    this.#sessionId = null;
    this.#activeBoundaryDisplayMode = undefined;
    void this.#replaceChannel(undefined);
  }

  subscribeStartedTurns(listener: (turn: MakaPreparedSessionTurn) => void): () => void {
    this.#startedTurnListeners.add(listener);
    return () => this.#startedTurnListeners.delete(listener);
  }

  subscribeResolvedInteractions(
    listener: (sessionId: string, requestId: string) => void,
  ): () => void {
    this.#resolvedInteractionListeners.add(listener);
    return () => this.#resolvedInteractionListeners.delete(listener);
  }

  subscribeTranscriptReplacements(
    listener: (sessionId: string, turnId: string, messages: StoredMessage[]) => void,
  ): () => void {
    this.#transcriptListeners.add(listener);
    return () => this.#transcriptListeners.delete(listener);
  }

  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    return readRuntimeHostResources(this.#connection, sessionId);
  }

  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void {
    this.#shellRunListeners.add(listener);
    return () => this.#shellRunListeners.delete(listener);
  }

  async stop(): Promise<void> {
    const turn = this.#channel?.snapshot.rootTurn;
    if (!turn || isTerminalTurn(turn)) return;
    await this.#request('turn.stop', {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    });
  }

  getSessionId(): string | null {
    return this.#sessionId;
  }

  async getContextDiagnostics(): Promise<ContextDiagnostics> {
    if (!this.#sessionId) return { status: 'unavailable', reason: 'no_completed_request' };
    const diagnostics = await this.#request('context.diagnostics.query', {
      sessionId: this.#sessionId,
    });
    return diagnostics.status === 'unavailable'
      ? diagnostics
      : {
          ...diagnostics,
          segments: diagnostics.segments.map((segment) => ({ ...segment })),
          ...(diagnostics.compaction ? { compaction: { ...diagnostics.compaction } } : {}),
        };
  }

  getOrchestrationMode(): OrchestrationMode {
    return this.#orchestrationMode;
  }

  getPermissionMode(): PermissionMode {
    return this.#activeBoundaryDisplayMode ?? this.#permissionMode;
  }

  async #ensureSession(): Promise<string> {
    if (this.#sessionId) return this.#sessionId;
    const sessionId = this.#newId();
    const session = requireSession(
      await this.#request('session.create', {
        sessionId,
        cwd: this.#cwd,
        name: DEFAULT_SESSION_NAME,
        modelTarget: {
          kind: 'explicit',
          connectionSlug: this.#llmConnectionSlug,
          model: this.#model,
        },
        permissionMode: this.#permissionMode,
        ...(this.#orchestrationMode === 'default'
          ? {}
          : { orchestrationMode: this.#orchestrationMode }),
        ...(this.#thinkingLevel === undefined ? {} : { thinkingLevel: this.#thinkingLevel }),
      }),
    );
    this.#sessionGeneration += 1;
    this.#sessionId = sessionId;
    this.#adoptConfiguration(session);
    await this.#ensureChannel(sessionId);
    return sessionId;
  }

  async #ensureChannel(sessionId: string): Promise<RuntimeHostSessionChannel> {
    if (this.#channel?.sessionId === sessionId && !this.#channel.failed) return this.#channel;
    if (this.#channelOpening?.sessionId === sessionId) return this.#channelOpening.promise;
    const promise = this.#openChannel(sessionId);
    this.#channelOpening = { sessionId, promise };
    try {
      return await promise;
    } finally {
      if (this.#channelOpening?.promise === promise) this.#channelOpening = undefined;
    }
  }

  async #openChannel(sessionId: string): Promise<RuntimeHostSessionChannel> {
    const sessionGeneration = this.#sessionGeneration;
    const expectedChannelGeneration = this.#channelGeneration;
    const opened = await this.#openSessionChannel(sessionId, sessionGeneration);
    if (
      this.#sessionId !== sessionId ||
      this.#sessionGeneration !== sessionGeneration ||
      this.#channelGeneration !== expectedChannelGeneration
    ) {
      await opened.channel.close().catch(() => undefined);
      throw new Error(`Session changed while opening Runtime Host channel: ${sessionId}`);
    }
    this.#channelGeneration += 1;
    await this.#replaceChannel(opened.channel);
    opened.channel.activate();
    return opened.channel;
  }

  async #replaceChannel(next: RuntimeHostSessionChannel | undefined): Promise<void> {
    const previous = this.#channel;
    this.#channel = next;
    await previous?.close().catch(() => undefined);
  }

  async #enqueue(
    text: string,
    placement: 'current_turn' | 'next_turn',
  ): Promise<QueueEnqueueOutcome> {
    const sessionId = this.#sessionId;
    if (!sessionId) return { kind: 'fallback' };
    const result = await this.#request('turn.message.submit', {
      originHostEpoch: this.#connection.hostEpoch,
      sessionId,
      messageId: this.#newId(),
      content: { text },
      placement,
    });
    // A root Turn can settle between the local projection check and Host
    // admission. The Host has already started the message in that case, so it
    // must not be submitted again. Treat it as accepted; the subscription owns
    // projection of the successor Turn.
    return { kind: 'queued' };
  }

  async #updateConfiguration(
    sessionId: string,
    patch: {
      modelTarget?: { kind: 'explicit'; connectionSlug: string; model: string };
      thinkingLevel?: ThinkingLevel | null;
      permissionMode?: PermissionMode;
      orchestrationMode?: OrchestrationMode;
    },
  ): Promise<SessionCatalogProjection> {
    return updateSession(this.#connection, sessionId, (current) =>
      this.#request('session.configuration.update', {
        sessionId,
        expectedRevision: current.revision,
        configuration: {
          modelTarget:
            patch.modelTarget ??
            (current.connectionLocked
              ? {
                  kind: 'explicit',
                  connectionSlug: current.llmConnectionSlug,
                  model: current.model,
                }
              : { kind: 'default' }),
          thinkingLevel:
            patch.thinkingLevel === undefined
              ? (current.thinkingLevel ?? null)
              : patch.thinkingLevel,
          permissionMode: patch.permissionMode ?? current.permissionMode,
          collaborationMode: current.collaborationMode,
          orchestrationMode: patch.orchestrationMode ?? current.orchestrationMode,
        },
      }),
    );
  }

  #adoptConfiguration(session: SessionCatalogProjection): void {
    this.#model = session.model;
    this.#llmConnectionSlug = session.llmConnectionSlug;
    this.#thinkingLevel = session.thinkingLevel;
    this.#permissionMode = session.permissionMode;
    this.#orchestrationMode = session.orchestrationMode;
  }

  async #loadConfiguration(sessionId: string): Promise<LoadedSessionConfiguration> {
    const [session, boundary] = await Promise.all([
      getSession(this.#connection, sessionId),
      this.#request('session.execution_boundary.query', { sessionId }),
    ]);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return {
      session,
      boundaryDisplayMode:
        boundary.kind === 'external' ? undefined : executionBoundaryDisplayMode(boundary),
    };
  }

  #adoptLoadedConfiguration(configuration: LoadedSessionConfiguration): void {
    this.#adoptConfiguration(configuration.session);
    this.#activeBoundaryDisplayMode = configuration.boundaryDisplayMode;
  }

  #assertCurrentSession(sessionId: string, sessionGeneration: number): void {
    if (this.#sessionId !== sessionId || this.#sessionGeneration !== sessionGeneration) {
      throw new Error(`Session changed while loading Runtime Host state: ${sessionId}`);
    }
  }

  #requireSession(action: string): string {
    if (!this.#sessionId) throw new Error(`Cannot ${action} before a session starts.`);
    return this.#sessionId;
  }

  #publishStartedTurn(turn: MakaPreparedSessionTurn, sessionGeneration: number): void {
    if (this.#claimedTurnIds.delete(turn.turnId)) return;
    const sourceChannel = this.#channel;
    const tail = this.#startedTurnReattachTails.get(sessionGeneration) ?? Promise.resolve();
    const attempt = tail.then(() =>
      this.#reattachStartedTurn(sessionGeneration, turn.sessionId, turn.turnId),
    );
    const settled = attempt.catch(() => undefined);
    this.#startedTurnReattachTails.set(sessionGeneration, settled);
    void settled.then(() => {
      if (this.#startedTurnReattachTails.get(sessionGeneration) === settled) {
        this.#startedTurnReattachTails.delete(sessionGeneration);
      }
    });
    void attempt.catch((error) => sourceChannel?.failTurn(turn.turnId, error));
  }

  async #reattachStartedTurn(
    sessionGeneration: number,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    if (this.#sessionId !== sessionId || this.#sessionGeneration !== sessionGeneration) return;
    const expectedChannelGeneration = this.#channelGeneration;
    const opened = await this.#openSessionChannel(sessionId, sessionGeneration);
    if (
      this.#sessionId !== sessionId ||
      this.#sessionGeneration !== sessionGeneration ||
      this.#channelGeneration !== expectedChannelGeneration
    ) {
      await opened.channel.close().catch(() => undefined);
      return;
    }
    if (opened.attachedTurnId !== turnId) {
      if (opened.terminalTurn?.turnId !== turnId) {
        await opened.channel.close().catch(() => undefined);
        return;
      }
      opened.channel.seedTerminalCut(opened.terminalTurn);
    }
    let configuration: LoadedSessionConfiguration;
    try {
      configuration = await this.#loadConfiguration(sessionId);
    } catch {
      await opened.channel.close().catch(() => undefined);
      return;
    }
    if (
      this.#sessionId !== sessionId ||
      this.#sessionGeneration !== sessionGeneration ||
      this.#channelGeneration !== expectedChannelGeneration
    ) {
      await opened.channel.close().catch(() => undefined);
      return;
    }
    this.#adoptLoadedConfiguration(configuration);
    this.#channelGeneration += 1;
    await this.#replaceChannel(opened.channel);
    const turn = {
      sessionId,
      turnId,
      events: opened.channel.eventsForTurn(turnId),
      messages: opened.messages,
      summary: sessionSummary(configuration.session),
    } satisfies MakaPreparedSessionTurn;
    for (const listener of this.#startedTurnListeners) listener(turn);
    opened.channel.activate(turnId);
  }

  #openSessionChannel(
    sessionId: string,
    sessionGeneration: number,
  ): Promise<RuntimeHostSessionChannelOpenResult> {
    return RuntimeHostSessionChannel.open(
      this.#connection,
      sessionId,
      this.#now,
      (turn) => this.#publishStartedTurn(turn, sessionGeneration),
      (sourceSessionId, ref) => this.#publishRuntimeResource(sourceSessionId, ref),
      (pending) => this.#resolveExternalInteraction(pending),
      (turn) => this.#refreshTerminalTranscript(turn),
    );
  }

  #publishRuntimeResource(sourceSessionId: string, ref: string): void {
    void this.#request('runtime.resource.query', {
      kind: 'get',
      sessionId: sourceSessionId,
      ref,
    })
      .then((result) => {
        if (result.kind !== 'resource' || !result.resource) return;
        for (const listener of this.#shellRunListeners) listener(result.resource);
      })
      .catch(() => undefined);
  }

  #resolveExternalInteraction(pending: InteractionPendingSnapshot): void {
    void this.#request('interaction.query', {
      sessionId: pending.sessionId,
      interactionId: pending.interactionId,
    })
      .then((resolved) => {
        if (resolved.status === 'answered') {
          this.#channel?.publishInteractionAnswer(resolved, pending);
        }
        if (resolved.status === 'pending') return;
        for (const listener of this.#resolvedInteractionListeners) {
          listener(pending.sessionId, pending.interactionId);
        }
      })
      .catch(() => undefined);
  }

  #refreshTerminalTranscript(turn: TerminalTurnSnapshot): void {
    void loadCurrentMessages(this.#connection, turn.sessionId)
      .then((messages) => {
        if (this.#sessionId !== turn.sessionId) return;
        for (const listener of this.#transcriptListeners) {
          listener(
            turn.sessionId,
            turn.turnId,
            messages.map((message) => structuredClone(message)),
          );
        }
      })
      .catch(() => undefined);
  }

  #request<K extends DirectRequestOperationKey>(
    operation: K,
    input: OperationInput<K>,
  ): Promise<OperationOutput<K>> {
    return this.#connection.request(operation, input);
  }
}

interface LoadedSessionConfiguration {
  session: SessionCatalogProjection;
  boundaryDisplayMode: PermissionMode | undefined;
}

interface RuntimeHostSessionChannelOpenResult {
  channel: RuntimeHostSessionChannel;
  messages: StoredMessage[];
  attachedTurnId?: string;
  terminalTurn?: TerminalTurnSnapshot;
}

class RuntimeHostSessionChannel {
  readonly sessionId: string;
  readonly messages: StoredMessage[];
  snapshot: SessionContinuitySnapshot;
  readonly #subscription: RuntimeHostSessionSubscription;
  readonly #now: () => number;
  readonly #onTurnStarted: (turn: MakaPreparedSessionTurn) => void;
  readonly #onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void;
  readonly #onInteractionResolved: (pending: InteractionPendingSnapshot) => void;
  readonly #onTurnTerminal: (turn: TerminalTurnSnapshot) => void;
  readonly #turns = new Map<string, SessionEventQueue>();
  readonly #pendingFrames: SubscriptionFrame[] = [];
  readonly #pendingStartedTurns = new Map<string, MakaPreparedSessionTurn>();
  readonly #pendingResolvedInteractions: InteractionPendingSnapshot[] = [];
  readonly #pendingTerminalTurns: TerminalTurnSnapshot[] = [];
  #projector: RuntimeHostSessionProjector | undefined;
  #ready = false;
  #activated = false;
  #startedTurnBarrier: string | undefined;
  #closing = false;
  #failure: Error | undefined;

  private constructor(
    subscription: RuntimeHostSessionSubscription,
    messages: StoredMessage[],
    now: () => number,
    onTurnStarted: (turn: MakaPreparedSessionTurn) => void,
    onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void,
    onInteractionResolved: (pending: InteractionPendingSnapshot) => void,
    onTurnTerminal: (turn: TerminalTurnSnapshot) => void,
  ) {
    this.#subscription = subscription;
    this.sessionId = subscription.snapshot.session.sessionId;
    this.snapshot = structuredClone(subscription.snapshot);
    this.messages = messages;
    this.#now = now;
    this.#onTurnStarted = onTurnStarted;
    this.#onRuntimeResourceChanged = onRuntimeResourceChanged;
    this.#onInteractionResolved = onInteractionResolved;
    this.#onTurnTerminal = onTurnTerminal;
  }

  static async open(
    connection: RuntimeHostConnection,
    sessionId: string,
    now: () => number,
    onTurnStarted: (turn: MakaPreparedSessionTurn) => void,
    onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void,
    onInteractionResolved: (pending: InteractionPendingSnapshot) => void,
    onTurnTerminal: (turn: TerminalTurnSnapshot) => void,
  ): Promise<RuntimeHostSessionChannelOpenResult> {
    const subscription = await connection.openSessionSubscription({ sessionId });
    const initialRoot = structuredClone(subscription.snapshot.rootTurn);
    const channel = new RuntimeHostSessionChannel(
      subscription,
      [],
      now,
      onTurnStarted,
      onRuntimeResourceChanged,
      onInteractionResolved,
      onTurnTerminal,
    );
    void channel.#pump();
    try {
      const messages = await subscription.loadTranscript(decodeStoredMessageForRead);
      channel.messages.push(...messages.map((message) => structuredClone(message)));
      channel.#projector = new RuntimeHostSessionProjector(channel.snapshot, channel.messages, now);
      for (const event of channel.#projector.seedActive(false)) channel.#emit(event);
      channel.#ready = true;
      for (const frame of channel.#pendingFrames.splice(0)) channel.#accept(frame);
      return {
        channel,
        messages: channel.messages.map((message) => structuredClone(message)),
        ...(initialRoot && !isTerminalTurn(initialRoot)
          ? { attachedTurnId: initialRoot.turnId }
          : {}),
        ...(initialRoot && isTerminalTurn(initialRoot) ? { terminalTurn: initialRoot } : {}),
      };
    } catch (error) {
      await channel.close().catch(() => undefined);
      throw error;
    }
  }

  async *eventsForTurn(turnId: string): AsyncIterable<SessionEvent> {
    try {
      yield* this.#queue(turnId);
    } finally {
      if (this.#startedTurnBarrier === turnId) {
        this.#startedTurnBarrier = undefined;
        this.#flushStartedTurns();
      }
    }
  }

  get failed(): boolean {
    return this.#failure !== undefined;
  }

  get firstObservedTurnId(): string | undefined {
    return this.#pendingStartedTurns.keys().next().value;
  }

  activate(claimedTurnId?: string): void {
    if (this.#closing || this.#activated) return;
    this.#activated = true;
    if (claimedTurnId) {
      this.#pendingStartedTurns.delete(claimedTurnId);
      this.#startedTurnBarrier = claimedTurnId;
    } else {
      this.#flushStartedTurns();
    }
    for (const interaction of this.#pendingResolvedInteractions.splice(0)) {
      this.#onInteractionResolved(interaction);
    }
    for (const turn of this.#pendingTerminalTurns.splice(0)) this.#onTurnTerminal(turn);
  }

  #flushStartedTurns(): void {
    for (const turn of this.#pendingStartedTurns.values()) this.#onTurnStarted(turn);
    this.#pendingStartedTurns.clear();
  }

  seedTerminalCut(turn: TerminalTurnSnapshot): void {
    if (!this.#projector) return;
    for (const event of this.#projector.seedTerminal(turn)) this.#emit(event);
    this.#queue(turn.turnId).finish();
  }

  failTurn(turnId: string, error: unknown): void {
    this.#queue(turnId).fail(error);
  }

  pendingInteraction(interactionId: string): InteractionPendingSnapshot | undefined {
    return this.snapshot.interactions.pending.find(
      (interaction) => interaction.interactionId === interactionId,
    );
  }

  publishInteractionAnswer(
    answered: InteractionAnsweredSnapshot,
    pending: InteractionPendingSnapshot,
  ): void {
    const base = {
      id: `host-interaction:${answered.interactionId}:${answered.revision}`,
      turnId: answered.turnId,
      ts: this.#now(),
      requestId: answered.interactionId,
      toolUseId:
        pending.request.kind === 'sandbox_boundary'
          ? pending.interactionId
          : pending.request.toolUseId,
    };
    if (answered.outcome.kind === 'question_answer') {
      this.#emit({ type: 'user_question_answer_ack', ...base });
    } else if (answered.outcome.kind === 'sandbox_boundary_decision') {
      this.#emit({
        type: 'sandbox_boundary_decision_ack',
        ...base,
        decision: answered.outcome.decision,
        status: answered.outcome.status,
        revision: answered.revision,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const queue of this.#turns.values()) queue.finish();
    await this.#subscription.close();
  }

  async #pump(): Promise<void> {
    try {
      for await (const frame of this.#subscription) {
        if (this.#closing) return;
        if (!this.#ready) {
          if (this.#pendingFrames.length >= MAX_PENDING_FRAMES) {
            throw new Error('Runtime Host transcript could not keep up with live Session events');
          }
          this.#pendingFrames.push(frame);
        } else {
          this.#accept(frame);
        }
      }
      if (!this.#closing) throw new Error('Runtime Host Session subscription ended unexpectedly');
    } catch (error) {
      if (this.#closing) return;
      this.#fail(error);
    }
  }

  #accept(frame: SubscriptionFrame): void {
    if (frame.kind === 'subscription.session_domain_changed') {
      if (frame.domain === 'runtime_resource') {
        for (const resource of frame.resources) {
          this.#onRuntimeResourceChanged(resource.sourceSessionId, resource.ref);
        }
      }
      return;
    }
    if (frame.kind === 'subscription.closed') {
      this.#fail(new Error(`Runtime Host Session subscription closed: ${frame.reason}`));
      return;
    }
    const update = this.#projector?.accept(frame);
    if (!update || !this.#projector) return;
    this.snapshot = this.#projector.snapshot;
    for (const interaction of update.resolvedInteractions) {
      if (this.#activated) this.#onInteractionResolved(interaction);
      else this.#pendingResolvedInteractions.push(interaction);
    }
    for (const event of update.events) this.#emit(event);
    if (update.startedTurn && !isTerminalTurn(update.startedTurn)) {
      const turn = {
        sessionId: this.sessionId,
        turnId: update.startedTurn.turnId,
        events: this.eventsForTurn(update.startedTurn.turnId),
      } satisfies MakaPreparedSessionTurn;
      if (this.#activated && !this.#startedTurnBarrier) this.#onTurnStarted(turn);
      else this.#pendingStartedTurns.set(turn.turnId, turn);
    }
    if (update.terminalTurn) {
      this.#queue(update.terminalTurn.turnId).finish();
      if (this.#activated) this.#onTurnTerminal(update.terminalTurn);
      else this.#pendingTerminalTurns.push(update.terminalTurn);
    }
  }

  #emit(event: SessionEvent): void {
    this.#queue(event.turnId).push(event);
  }

  #queue(turnId: string): SessionEventQueue {
    let queue = this.#turns.get(turnId);
    if (!queue) {
      queue = new SessionEventQueue();
      this.#turns.set(turnId, queue);
      if (this.#failure) queue.fail(this.#failure);
    }
    return queue;
  }

  #fail(error: unknown): void {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const queue of this.#turns.values()) queue.fail(this.#failure);
  }
}

class SessionEventQueue implements AsyncIterable<SessionEvent>, AsyncIterator<SessionEvent> {
  readonly #items: SessionEvent[] = [];
  #waiting:
    | { resolve(value: IteratorResult<SessionEvent>): void; reject(error: unknown): void }
    | undefined;
  #done = false;
  #finishAfterItems = false;
  #error: unknown;

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return this;
  }

  next(): Promise<IteratorResult<SessionEvent>> {
    const item = this.#items.shift();
    if (item) return Promise.resolve({ done: false, value: item });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#done || this.#finishAfterItems) {
      this.#done = true;
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#waiting)
      return Promise.reject(new Error('Session event stream already has a reader'));
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  push(event: SessionEvent): void {
    if (this.#done || this.#finishAfterItems || this.#error !== undefined) return;
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting.resolve({ done: false, value: event });
      return;
    }
    if (this.#items.length >= MAX_PENDING_EVENTS_PER_TURN) {
      this.fail(new Error('Runtime Host Session event consumer is too slow'));
      return;
    }
    this.#items.push(event);
  }

  finish(): void {
    if (this.#done || this.#error !== undefined) return;
    this.#finishAfterItems = true;
    if (this.#items.length === 0) {
      this.#done = true;
      this.#waiting?.resolve({ done: true, value: undefined });
      this.#waiting = undefined;
    }
  }

  fail(error: unknown): void {
    if (this.#done || this.#error !== undefined) return;
    this.#error = error;
    this.#items.length = 0;
    this.#waiting?.reject(error);
    this.#waiting = undefined;
  }
}

async function getSession(
  connection: RuntimeHostConnection,
  sessionId: string,
): Promise<SessionCatalogProjection | null> {
  const result = await connection.request('session.catalog.query', { kind: 'get', sessionId });
  if (result.kind !== 'session') throw new Error('Runtime Host returned an invalid Session lookup');
  return result.session === null ? null : requireSession(result.session);
}

function representableSession(item: SessionCatalogItem): SessionCatalogProjection[] {
  return 'kind' in item ? [] : [item];
}

function requireSession(item: SessionCatalogItem): SessionCatalogProjection {
  if (!('kind' in item)) return item;
  throw new Error(`Runtime Host Session is not representable by this CLI: ${item.id}`);
}

async function updateSession(
  connection: RuntimeHostConnection,
  sessionId: string,
  update: (current: SessionCatalogProjection) => Promise<SessionUpdateResult>,
): Promise<SessionCatalogProjection> {
  for (let attempt = 0; attempt < MAX_CATALOG_ATTEMPTS; attempt += 1) {
    const current = await getSession(connection, sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    const result = await update(current);
    if (result.kind === 'committed') return requireSession(result.session);
  }
  throw new Error(`Session kept changing while updating: ${sessionId}`);
}

async function loadCurrentMessages(
  connection: RuntimeHostConnection,
  sessionId: string,
): Promise<StoredMessage[]> {
  const subscription = await connection.openSessionSubscription({ sessionId });
  const draining = (async () => {
    for await (const _frame of subscription) {
      // The transcript is pinned to the subscription snapshot. Drain newer
      // frames only to preserve the bounded transport while the read runs.
    }
  })();
  try {
    return await subscription.loadTranscript(decodeStoredMessageForRead);
  } finally {
    await subscription.close().catch(() => undefined);
    await draining.catch(() => undefined);
  }
}

function sessionSummary(session: SessionCatalogProjection): SessionSummary {
  return {
    id: session.id,
    cwd: session.cwd,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
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
    ...(session.subagent === undefined ? {} : { subagent: session.subagent }),
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
