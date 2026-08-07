import { decodeStoredMessageForRead, type SessionEvent, type StoredMessage } from '@maka/core';
import {
  RuntimeHostSessionProjector,
  isRuntimeHostTerminalTurn as isTerminalTurn,
  type RuntimeHostTerminalTurn as TerminalTurnSnapshot,
} from '@maka/runtime-host/adapter';
import type {
  RuntimeHostConnection,
  RuntimeHostSessionSubscription,
} from '@maka/runtime-host/client';
import type {
  InteractionAnsweredSnapshot,
  InteractionPendingSnapshot,
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
  connection: RuntimeHostConnection;
  sessionId: string;
  now: () => number;
  onTurnStarted: (turn: MakaPreparedSessionTurn) => void;
  onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void;
  onInteractionPending: (pending: InteractionPendingSnapshot) => void;
  onInteractionResolved: (pending: InteractionPendingSnapshot) => void;
  onTurnTerminal: (turn: TerminalTurnSnapshot) => void;
}

export class RuntimeHostSessionChannel {
  readonly sessionId: string;
  readonly messages: StoredMessage[];
  snapshot: SessionContinuitySnapshot;
  readonly #subscription: RuntimeHostSessionSubscription;
  readonly #now: () => number;
  readonly #onTurnStarted: (turn: MakaPreparedSessionTurn) => void;
  readonly #onRuntimeResourceChanged: (sourceSessionId: string, ref: string) => void;
  readonly #onInteractionPending: (pending: InteractionPendingSnapshot) => void;
  readonly #onInteractionResolved: (pending: InteractionPendingSnapshot) => void;
  readonly #onTurnTerminal: (turn: TerminalTurnSnapshot) => void;
  readonly #turns = new Map<string, SessionEventQueue>();
  readonly #pendingFrames: SubscriptionFrame[] = [];
  readonly #pendingStartedTurns = new Map<string, MakaPreparedSessionTurn>();
  readonly #pendingOpenedInteractions: InteractionPendingSnapshot[] = [];
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
    options: Omit<RuntimeHostSessionChannelOptions, 'connection' | 'sessionId'>,
  ) {
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
  }

  static async open(
    options: RuntimeHostSessionChannelOptions,
  ): Promise<RuntimeHostSessionChannelOpenResult> {
    const subscription = await options.connection.openSessionSubscription({
      sessionId: options.sessionId,
    });
    const initialRoot = structuredClone(subscription.snapshot.rootTurn);
    const channel = new RuntimeHostSessionChannel(subscription, [], options);
    void channel.#pump();
    try {
      const messages = await subscription.loadTranscript(decodeStoredMessageForRead);
      channel.messages.push(...messages.map((message) => structuredClone(message)));
      channel.#projector = new RuntimeHostSessionProjector(
        channel.snapshot,
        channel.messages,
        options.now,
      );
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
