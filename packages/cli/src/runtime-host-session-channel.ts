import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import { type SessionEvent } from '@maka/core/events';
import {
  RuntimeHostSessionProjector,
  isRuntimeHostTerminalTurn as isTerminalTurn,
  type RuntimeHostTerminalTurn as TerminalTurnSnapshot,
} from '@maka/runtime-host/adapter';
import {
  isRuntimeHostReconnectingConnection,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import {
  InteractionAnsweredSnapshot,
  InteractionPendingSnapshot,
  SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
  SessionContinuitySnapshot,
  SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import type { MakaPreparedSessionTurn } from './session-driver.js';

const MAX_PENDING_FRAMES = 512;
const MAX_PENDING_EVENTS_PER_TURN = 1_024;

export interface RuntimeHostSessionChannelOpenResult {
  channel: RuntimeHostSessionChannel;
  messages: StoredMessage[];
  attachedTurnId?: string;
  terminalTurn?: TerminalTurnSnapshot;
}

export interface RuntimeHostSessionChannelOptions {
  connection: Pick<RuntimeHostConnection, 'openSessionSubscription'>;
  sessionId: string;
  now: () => number;
  onTurnStarted: (turn: MakaPreparedSessionTurn) => void;
  onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void;
  onInteractionPending: (pending: InteractionPendingSnapshot) => void;
  onInteractionResolved: (pending: InteractionPendingSnapshot) => void;
  onTurnTerminal: (turn: TerminalTurnSnapshot) => void;
  onTranscriptReplaced: (turnId: string, messages: readonly StoredMessage[]) => void;
  onRecovered: () => void;
}

export class RuntimeHostSessionChannel {
  readonly sessionId: string;
  readonly messages: StoredMessage[];
  snapshot: SessionContinuitySnapshot;
  readonly #connection: Pick<RuntimeHostConnection, 'openSessionSubscription'>;
  #subscription: RuntimeHostSessionSubscription;
  readonly #now: () => number;
  readonly #onTurnStarted: (turn: MakaPreparedSessionTurn) => void;
  readonly #onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void;
  readonly #onInteractionPending: (pending: InteractionPendingSnapshot) => void;
  readonly #onInteractionResolved: (pending: InteractionPendingSnapshot) => void;
  readonly #onTurnTerminal: (turn: TerminalTurnSnapshot) => void;
  readonly #onTranscriptReplaced: (turnId: string, messages: readonly StoredMessage[]) => void;
  readonly #onRecovered: () => void;
  readonly #turns = new Map<string, SessionEventQueue>();
  readonly #pendingFrames: SubscriptionFrame[] = [];
  readonly #pendingStartedTurns = new Map<string, MakaPreparedSessionTurn>();
  readonly #pendingOpenedInteractions: InteractionPendingSnapshot[] = [];
  readonly #pendingResolvedInteractions: InteractionPendingSnapshot[] = [];
  readonly #pendingTerminalTurns: TerminalTurnSnapshot[] = [];
  readonly #failedSubscriptions = new WeakSet<RuntimeHostSessionSubscription>();
  #projector: RuntimeHostSessionProjector | undefined;
  #ready = false;
  #activated = false;
  #startedTurnBarrier: string | undefined;
  #closing = false;
  #failure: Error | undefined;
  #recoveryTask: Promise<void> | undefined;

  private constructor(
    subscription: RuntimeHostSessionSubscription,
    messages: StoredMessage[],
    options: Omit<RuntimeHostSessionChannelOptions, 'connection' | 'sessionId'>,
    connection: Pick<RuntimeHostConnection, 'openSessionSubscription'>,
  ) {
    this.#connection = connection;
    this.#subscription = subscription;
    this.sessionId = subscription.snapshot.session.sessionId;
    this.snapshot = structuredClone(subscription.snapshot);
    this.messages = messages;
    this.#now = options.now;
    this.#onTurnStarted = options.onTurnStarted;
    this.#onRuntimeResourceChanged = options.onRuntimeResourceChanged;
    this.#onInteractionPending = options.onInteractionPending;
    this.#onInteractionResolved = options.onInteractionResolved;
    this.#onTurnTerminal = options.onTurnTerminal;
    this.#onTranscriptReplaced = options.onTranscriptReplaced;
    this.#onRecovered = options.onRecovered;
  }

  static async open(
    options: RuntimeHostSessionChannelOptions,
  ): Promise<RuntimeHostSessionChannelOpenResult> {
    const subscription = await options.connection.openSessionSubscription({
      sessionId: options.sessionId,
      transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
    });
    const initialRoot = structuredClone(subscription.snapshot.rootTurn);
    const channel = new RuntimeHostSessionChannel(subscription, [], options, options.connection);
    void channel.#pump(subscription);
    try {
      const recovered = await channel.#hydrateInitial(subscription);
      const root = recovered ? structuredClone(channel.snapshot.rootTurn) : initialRoot;
      return {
        channel,
        messages: channel.messages.map((message) => structuredClone(message)),
        ...(root && !isTerminalTurn(root) ? { attachedTurnId: root.turnId } : {}),
        ...(root && isTerminalTurn(root) ? { terminalTurn: root } : {}),
      };
    } catch (error) {
      await channel.close().catch(() => undefined);
      throw error;
    }
  }

  async #hydrateInitial(subscription: RuntimeHostSessionSubscription): Promise<boolean> {
    let messages: StoredMessage[] | undefined;
    try {
      messages = await subscription.loadTranscript(decodeStoredMessage);
    } catch (error) {
      if (!this.#canRecover(error)) throw error;
      this.#failedSubscriptions.add(subscription);
    }
    if (this.#failedSubscriptions.has(subscription)) {
      await this.#recover(subscription);
      if (!this.#ready) {
        throw this.#failure ?? new Error('Runtime Host Session recovery ended before hydration');
      }
      return true;
    }
    this.messages.push(...(messages ?? []).map((message) => structuredClone(message)));
    this.#projector = new RuntimeHostSessionProjector(
      this.snapshot,
      this.messages,
      this.#now,
      subscription.activeAssistantStreams,
    );
    for (const event of this.#projector.seedActive(false)) this.#emit(event);
    this.#ready = true;
    for (const frame of this.#pendingFrames.splice(0)) this.#accept(frame);
    return false;
  }

  async *eventsForTurn(turnId: string): AsyncIterable<SessionEvent> {
    try {
      yield* this.#queue(turnId);
    } finally {
      if (this.#startedTurnBarrier === turnId) {
        this.#startedTurnBarrier = undefined;
        if (!this.#closing) this.#flushStartedTurns();
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
    for (const interaction of this.snapshot.interactions.pending) {
      this.#onInteractionPending(structuredClone(interaction));
    }
    for (const interaction of this.#pendingOpenedInteractions.splice(0)) {
      this.#onInteractionPending(interaction);
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
    this.#pendingStartedTurns.clear();
    for (const queue of this.#turns.values()) queue.finish();
    await this.#subscription.close();
  }

  async #pump(subscription: RuntimeHostSessionSubscription): Promise<void> {
    try {
      for await (const frame of subscription) {
        if (this.#closing || this.#subscription !== subscription) return;
        if (!this.#ready) {
          if (this.#pendingFrames.length >= MAX_PENDING_FRAMES) {
            throw new RuntimeHostSubscriptionError(
              'slow_consumer',
              'Runtime Host transcript could not keep up with live Session events',
            );
          }
          this.#pendingFrames.push(frame);
        } else {
          this.#accept(frame);
        }
      }
      if (!this.#closing) throw new Error('Runtime Host Session subscription ended unexpectedly');
    } catch (error) {
      if (this.#closing || this.#subscription !== subscription) return;
      if (this.#canRecover(error)) {
        this.#failedSubscriptions.add(subscription);
        if (!this.#ready) return;
        if (this.#recoveryTask) {
          const schedule = () => {
            if (this.#subscription === subscription && !this.#closing) {
              this.#scheduleRecovery(subscription);
            }
          };
          void this.#recoveryTask.then(schedule, schedule);
        } else {
          this.#scheduleRecovery(subscription);
        }
        return;
      }
      this.#fail(error);
    }
  }

  #scheduleRecovery(failed: RuntimeHostSessionSubscription): void {
    if (this.#closing || this.#failure || this.#subscription !== failed || this.#recoveryTask)
      return;
    const task = this.#recover(failed);
    this.#recoveryTask = task;
    void task
      .catch((error: unknown) => {
        if (!this.#closing) this.#fail(error);
      })
      .finally(() => {
        if (this.#recoveryTask === task) this.#recoveryTask = undefined;
      });
  }

  async #recover(failed: RuntimeHostSessionSubscription): Promise<void> {
    let previous = failed;
    while (!this.#closing && !this.#failure && this.#subscription === previous) {
      await previous.close().catch(() => undefined);
      let replacement: RuntimeHostSessionSubscription;
      try {
        replacement = await this.#connection.openSessionSubscription({
          sessionId: this.sessionId,
          transcript: { kind: 'tail', maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES },
        });
      } catch (error) {
        if (this.#canRecover(error)) continue;
        throw error;
      }
      if (this.#closing || this.#failure || this.#subscription !== previous) {
        await replacement.close().catch(() => undefined);
        return;
      }
      this.#subscription = replacement;
      this.#ready = false;
      this.#pendingFrames.length = 0;
      void this.#pump(replacement);
      try {
        const messages = await replacement.loadTranscript(decodeStoredMessage);
        if (this.#failedSubscriptions.has(replacement)) {
          throw new RuntimeHostSubscriptionError(
            'connection_closed',
            'Runtime Host Session subscription closed during catch-up',
          );
        }
        if (this.#closing || this.#failure || this.#subscription !== replacement) return;
        const replacedLiveState = this.#acceptCanonicalReplacement(messages);
        this.#ready = true;
        for (const frame of this.#pendingFrames.splice(0)) this.#accept(frame);
        if (replacedLiveState) this.#onRecovered();
        return;
      } catch (error) {
        if (!this.#canRecover(error)) throw error;
        previous = replacement;
      }
    }
  }

  #acceptCanonicalReplacement(messages: StoredMessage[]): boolean {
    const replacedLiveState = this.#projector !== undefined;
    const previousSnapshot = this.snapshot;
    const nextSnapshot = structuredClone(this.#subscription.snapshot);
    this.messages.splice(
      0,
      this.messages.length,
      ...messages.map((message) => structuredClone(message)),
    );
    this.snapshot = nextSnapshot;
    this.#projector = new RuntimeHostSessionProjector(
      nextSnapshot,
      this.messages,
      this.#now,
      this.#subscription.activeAssistantStreams,
    );
    if (!replacedLiveState) {
      for (const event of this.#projector.seedActive(false)) this.#emit(event);
      return false;
    }

    const previousRoot = previousSnapshot.rootTurn;
    const root = nextSnapshot.rootTurn;
    const transcriptTurnId = root?.turnId ?? previousRoot?.turnId;
    if (transcriptTurnId) {
      this.#onTranscriptReplaced(
        transcriptTurnId,
        this.messages.map((message) => structuredClone(message)),
      );
    }

    const previousPending = new Map(
      previousSnapshot.interactions.pending.map((pending) => [pending.interactionId, pending]),
    );
    const nextPendingIds = new Set(
      nextSnapshot.interactions.pending.map((pending) => pending.interactionId),
    );
    for (const pending of previousPending.values()) {
      if (nextPendingIds.has(pending.interactionId)) continue;
      if (this.#activated) this.#onInteractionResolved(structuredClone(pending));
      else this.#pendingResolvedInteractions.push(structuredClone(pending));
    }
    for (const pending of nextSnapshot.interactions.pending) {
      if (previousPending.has(pending.interactionId)) continue;
      const copy = structuredClone(pending);
      if (this.#activated) this.#onInteractionPending(copy);
      else this.#pendingOpenedInteractions.push(copy);
    }

    if (
      previousRoot &&
      !isTerminalTurn(previousRoot) &&
      (!root || root.runId !== previousRoot.runId)
    ) {
      const terminalEvents = this.#projector.seedStoredTerminal(previousRoot.turnId, this.messages);
      if (terminalEvents.length === 0) {
        throw new RuntimeHostSubscriptionError(
          'projection_revision_invalid',
          `Runtime Host replacement omitted the terminal record for Turn ${previousRoot.turnId}`,
        );
      }
      for (const event of terminalEvents) this.#emit(event);
      this.#queue(previousRoot.turnId).finish();
    }

    if (root && !isTerminalTurn(root)) {
      for (const event of this.#projector.seedActive(false)) this.#emit(event);
      if (!previousRoot || previousRoot.runId !== root.runId) {
        const turn = {
          sessionId: this.sessionId,
          turnId: root.turnId,
          runId: root.runId,
          events: this.eventsForTurn(root.turnId),
        } satisfies MakaPreparedSessionTurn;
        if (this.#activated && !this.#startedTurnBarrier) this.#onTurnStarted(turn);
        else this.#pendingStartedTurns.set(turn.turnId, turn);
      }
    } else if (root && isTerminalTurn(root) && !sameTerminalTurn(previousRoot, root)) {
      for (const event of this.#projector.seedTerminal(root)) this.#emit(event);
      this.#queue(root.turnId).finish();
      if (this.#activated) this.#onTurnTerminal(root);
      else this.#pendingTerminalTurns.push(root);
    }
    return true;
  }

  #canRecover(error: unknown): boolean {
    if (!isRuntimeHostReconnectingConnection(this.#connection)) return false;
    if (error instanceof RuntimeHostRequestInterruptedError) {
      return error.reason === 'connection_lost';
    }
    return (
      error instanceof RuntimeHostSubscriptionError &&
      (error.reason === 'connection_closed' ||
        error.reason === 'sequence_gap' ||
        error.reason === 'projection_revision_invalid' ||
        error.reason === 'transcript_release_failed' ||
        error.reason === 'slow_consumer')
    );
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
      if (frame.reason === 'slow_consumer') {
        throw new RuntimeHostSubscriptionError(
          'slow_consumer',
          'Runtime Host Session subscription consumer fell behind',
        );
      }
      this.#fail(new Error(`Runtime Host Session subscription closed: ${frame.reason}`));
      return;
    }
    const previousPendingIds = new Set(
      this.snapshot.interactions.pending.map((interaction) => interaction.interactionId),
    );
    const update = this.#projector?.accept(frame);
    if (!update || !this.#projector) return;
    this.snapshot = this.#projector.snapshot;
    for (const interaction of this.snapshot.interactions.pending) {
      if (previousPendingIds.has(interaction.interactionId)) continue;
      const pending = structuredClone(interaction);
      if (this.#activated) this.#onInteractionPending(pending);
      else this.#pendingOpenedInteractions.push(pending);
    }
    for (const interaction of update.resolvedInteractions) {
      if (this.#activated) this.#onInteractionResolved(interaction);
      else this.#pendingResolvedInteractions.push(interaction);
    }
    for (const event of update.events) this.#emit(event);
    if (update.startedTurn && !isTerminalTurn(update.startedTurn)) {
      const turn = {
        sessionId: this.sessionId,
        turnId: update.startedTurn.turnId,
        runId: update.startedTurn.runId,
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

function sameTerminalTurn(
  previous: SessionContinuitySnapshot['rootTurn'],
  next: TerminalTurnSnapshot,
): boolean {
  return (
    previous !== null &&
    isTerminalTurn(previous) &&
    previous.runId === next.runId &&
    previous.terminalEventId === next.terminalEventId
  );
}
