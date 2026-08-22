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

import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import { type SessionEvent } from '@maka/core/events';
import {
  createRuntimeHostSessionProjectionSeed,
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
  type GoalProjection,
} from '@maka/runtime-host/protocol';
import type { MakaPreparedSessionTurn } from './session-driver.js';

const MAX_PENDING_FRAMES = 512;
const MAX_PENDING_EVENTS_PER_TURN = 1_024;
const LAG_REARM_PENDING_EVENTS = MAX_PENDING_EVENTS_PER_TURN / 2;
const MAX_RECOVERY_ATTEMPTS_WITHOUT_LIVE_FRAME = 8;
const RECOVERY_BACKOFF_INITIAL_MS = 25;
const RECOVERY_BACKOFF_MAX_MS = 500;
const RECOVERY_STABLE_AFTER_MS = 1_000;

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
  /**
   * Fired when the folded session projection's goal changes (set / settle /
   * pause / resume / clear). The projection stream is the authoritative push
   * channel for goal state — the same one the desktop observer diffs.
   */
  onGoalChanged: (goal: GoalProjection | null) => void;
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
  readonly #onGoalChanged: (goal: GoalProjection | null) => void;
  readonly #onRecovered: () => void;
  readonly #turns = new Map<string, SessionEventQueue>();
  readonly #pendingFrames: SubscriptionFrame[] = [];
  readonly #pendingStartedTurns = new Map<string, MakaPreparedSessionTurn>();
  readonly #pendingOpenedInteractions: InteractionPendingSnapshot[] = [];
  readonly #pendingResolvedInteractions: InteractionPendingSnapshot[] = [];
  readonly #pendingTerminalTurns: TerminalTurnSnapshot[] = [];
  readonly #failedSubscriptions = new WeakSet<RuntimeHostSessionSubscription>();
  readonly #retiringSubscriptions = new WeakSet<RuntimeHostSessionSubscription>();
  #projector: RuntimeHostSessionProjector | undefined;
  #ready = false;
  #activated = false;
  #startedTurnBarrier: string | undefined;
  #closing = false;
  #failure: Error | undefined;
  #recoveryTask: Promise<void> | undefined;
  #recoveryAttemptsWithoutLiveFrame = 0;
  #recoveryAwaitingLiveFrame: RuntimeHostSessionSubscription | undefined;
  #recoveryStableTimer: ReturnType<typeof setTimeout> | undefined;

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
    this.#onGoalChanged = options.onGoalChanged;
    this.#onRecovered = options.onRecovered;
  }

  static async open(
    options: RuntimeHostSessionChannelOptions,
  ): Promise<RuntimeHostSessionChannelOpenResult> {
    const subscription = await options.connection.openSessionSubscription({
      sessionId: options.sessionId,
      transcript: {
        kind: 'tail',
        maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
      },
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
      createRuntimeHostSessionProjectionSeed(this.messages, this.snapshot),
      this.#now,
      subscription.activeAssistantStreams,
    );
    for (const event of this.#projector.seedActive(false)) this.#emit(event);
    this.#ready = true;
    try {
      for (const frame of this.#pendingFrames.splice(0)) this.#accept(frame);
    } catch (error) {
      if (!this.#canRecover(error)) throw error;
      this.#failedSubscriptions.add(subscription);
      await this.#recover(subscription);
      if (!this.#ready) {
        throw this.#failure ?? new Error('Runtime Host Session recovery ended before hydration');
      }
      return true;
    }
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
    this.#clearRecoveryStableTimer();
    this.#recoveryAwaitingLiveFrame = undefined;
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
          if (frame.kind !== 'subscription.closed') this.#observeRecoveryLiveFrame(subscription);
        }
      }
      // A stream that ends without a subscription.closed frame is a broken
      // live channel, not a terminal state: the Host may have torn the
      // subscription down mid-recovery (e.g. slow_consumer eviction while the
      // transcript reload was still buffering). Route it through the same
      // resync recovery as an explicit close instead of killing the channel.
      if (!this.#closing)
        throw new RuntimeHostSubscriptionError(
          'connection_closed',
          'Runtime Host Session subscription ended unexpectedly',
        );
    } catch (error) {
      if (this.#closing || this.#subscription !== subscription) return;
      // A subscription retired because a turn consumer fell behind is closed
      // deliberately; its pump must not turn that expected close into a
      // channel failure. The guard also drops a genuine error racing the
      // deliberate close on this pump; that is safe because the replacement
      // subscription's own pump and recovery path re-surface any real
      // failure through #fail.
      if (this.#retiringSubscriptions.has(subscription)) return;
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
    this.#clearRecoveryStableTimer();
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
      if (this.#recoveryAwaitingLiveFrame === previous) {
        this.#recoveryAwaitingLiveFrame = undefined;
      }
      await previous.close().catch(() => undefined);
      await this.#waitForRecoveryAttempt();
      if (this.#closing || this.#failure || this.#subscription !== previous) return;
      let replacement: RuntimeHostSessionSubscription;
      try {
        replacement = await this.#connection.openSessionSubscription({
          sessionId: this.sessionId,
          transcript: {
            kind: 'tail',
            maxBytes: SESSION_TRANSCRIPT_BOOTSTRAP_MAX_BYTES,
          },
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
        this.#recoveryAwaitingLiveFrame = replacement;
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
    if (!sameGoalProjection(previousSnapshot.goal, nextSnapshot.goal)) {
      this.#onGoalChanged(nextSnapshot.goal === null ? null : structuredClone(nextSnapshot.goal));
    }
    this.#projector = new RuntimeHostSessionProjector(
      nextSnapshot,
      createRuntimeHostSessionProjectionSeed(this.messages, nextSnapshot),
      this.#now,
      this.#subscription.activeAssistantStreams,
    );
    // A canonical replacement is a sequence cut. No queued event from the
    // retired subscription may replay after the transcript/snapshot has
    // established newer state; active, terminal, and interaction state is
    // seeded again below from the replacement authority.
    for (const queue of this.#turns.values()) queue.cutBacklog();
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

  async #waitForRecoveryAttempt(): Promise<void> {
    if (this.#recoveryAttemptsWithoutLiveFrame >= MAX_RECOVERY_ATTEMPTS_WITHOUT_LIVE_FRAME) {
      throw new RuntimeHostSubscriptionError(
        'connection_closed',
        'Runtime Host Session subscription recovery exhausted its retry budget',
      );
    }
    if (this.#recoveryAttemptsWithoutLiveFrame > 0) {
      const delayMs = Math.min(
        RECOVERY_BACKOFF_INITIAL_MS * 2 ** (this.#recoveryAttemptsWithoutLiveFrame - 1),
        RECOVERY_BACKOFF_MAX_MS,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    this.#recoveryAttemptsWithoutLiveFrame += 1;
  }

  #scheduleRecoveryStable(subscription: RuntimeHostSessionSubscription): void {
    this.#clearRecoveryStableTimer();
    const timer = setTimeout(() => {
      if (!this.#closing && this.#subscription === subscription && this.#ready) {
        this.#recoveryAttemptsWithoutLiveFrame = 0;
      }
      if (this.#recoveryStableTimer === timer) this.#recoveryStableTimer = undefined;
    }, RECOVERY_STABLE_AFTER_MS);
    timer.unref?.();
    this.#recoveryStableTimer = timer;
  }

  #observeRecoveryLiveFrame(subscription: RuntimeHostSessionSubscription): void {
    if (this.#recoveryAwaitingLiveFrame !== subscription) return;
    this.#recoveryAwaitingLiveFrame = undefined;
    this.#scheduleRecoveryStable(subscription);
  }

  #clearRecoveryStableTimer(): void {
    if (this.#recoveryStableTimer !== undefined) clearTimeout(this.#recoveryStableTimer);
    this.#recoveryStableTimer = undefined;
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
    const previousGoal = this.snapshot.goal;
    const update = this.#projector?.accept(frame);
    if (!update || !this.#projector) return;
    this.snapshot = this.#projector.snapshot;
    if (!sameGoalProjection(previousGoal, this.snapshot.goal)) {
      // Clone like the canonical-replacement path above: listeners receive
      // their own copy, so a mutating listener cannot corrupt the live
      // snapshot regardless of which path delivered the change.
      this.#onGoalChanged(this.snapshot.goal === null ? null : structuredClone(this.snapshot.goal));
    }
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
      queue = new SessionEventQueue(() => this.#noteTurnConsumerLagging());
      this.#turns.set(turnId, queue);
      if (this.#failure) queue.fail(this.#failure);
    }
    return queue;
  }

  /**
   * A turn consumer that cannot keep up is a slow client: retire the healthy
   * subscription through the same recovery path a Host eviction would take so
   * the session re-syncs from canonical state instead of dying mid-turn.
   *
   * Note this escalates a single lagging queue to a session-wide recovery.
   * That is a benign superset even when the lagging queue belongs to an
   * abandoned old turn: the resync heals every turn's state, and the
   * per-queue lag latch plus hysteresis keep a wedged consumer from looping
   * resubscribes.
   */
  #noteTurnConsumerLagging(): void {
    if (this.#closing || this.#failure || !this.#ready) return;
    const subscription = this.#subscription;
    this.#retiringSubscriptions.add(subscription);
    this.#scheduleRecovery(subscription);
  }

  #fail(error: unknown): void {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const queue of this.#turns.values()) queue.fail(this.#failure);
  }
}

class SessionEventQueue implements AsyncIterable<SessionEvent>, AsyncIterator<SessionEvent> {
  readonly #items: SessionEvent[] = [];
  readonly #onLag: () => void;
  #waiting:
    | {
        resolve(value: IteratorResult<SessionEvent>): void;
        reject(error: unknown): void;
      }
    | undefined;
  #done = false;
  #finishAfterItems = false;
  #error: unknown;
  #lagging = false;

  constructor(onLag: () => void) {
    this.#onLag = onLag;
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return this;
  }

  next(): Promise<IteratorResult<SessionEvent>> {
    const item = this.#items.shift();
    if (item) {
      // Re-arm with hysteresis: a consumer that has drained half the backlog
      // is making progress, so a later lag episode may trigger another
      // recovery; a wedged consumer never drains and cannot loop resubscribes.
      if (this.#items.length <= LAG_REARM_PENDING_EVENTS) this.#lagging = false;
      return Promise.resolve({ done: false, value: item });
    }
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#done || this.#finishAfterItems) {
      this.#done = true;
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#waiting)
      return Promise.reject(new Error('Session event stream already has a reader'));
    // A canonical cut can empty a lagged queue before its consumer resumes.
    // Waiting again proves the consumer caught up and may arm a later episode.
    this.#lagging = false;
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
      // A consumer that falls behind must not kill the stream. Shed deltas
      // (text/thinking ranges are healed by the next canonical resync or
      // completion; tool_output_delta chunks are seq-deduped transient UI
      // updates healed by the terminal tool_result and the durable
      // transcript) and make room for every other event; the channel
      // resubscribes to re-sync state, like the Desktop subscription owner
      // does (#2630).
      if (isSheddableDelta(event)) {
        this.#noteLag();
        return;
      }
      const shedIndex = this.#items.findIndex(isSheddableDelta);
      if (shedIndex !== -1) {
        this.#items.splice(shedIndex, 1);
      } else if (isGuaranteedOutcome(event)) {
        // Turn-terminal outcomes and tool results always land, even when the
        // backlog holds no delta to evict: without a turn outcome the
        // consumer reaches end-of-stream without a result, and without a
        // tool_result the live tool card stays running until the durable
        // transcript heals it. The oldest queued event is sacrificed.
        this.#items.shift();
      } else {
        // A non-delta, non-outcome event with nothing sheddable to evict
        // (e.g. a tool_call begin behind an all-control backlog) is dropped;
        // the durable transcript heals the final state. Documented boundary
        // for v1.
        this.#noteLag();
        return;
      }
      this.#noteLag();
    }
    this.#items.push(event);
  }

  /** Drop unseen pre-cut work, retaining an unconsumed terminal guarantee. */
  cutBacklog(): void {
    const terminal = this.#finishAfterItems ? this.#items.find(isTurnTerminalOutcome) : undefined;
    this.#items.length = 0;
    if (terminal) this.#items.push(terminal);
  }

  #noteLag(): void {
    if (this.#lagging) return;
    this.#lagging = true;
    this.#onLag();
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

function isSheddableDelta(event: SessionEvent): boolean {
  // tool_output_delta is sheddable by design: its chunks are transient UI
  // updates with a monotonic per-tool `seq` (renderers de-dupe and order by
  // it, so a shed range leaves a gap, never corruption), and the terminal
  // tool_result plus the durable transcript heal the tool's final output.
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'tool_output_delta'
  );
}

function isGuaranteedOutcome(event: SessionEvent): boolean {
  // complete/abort/error close the turn; text/thinking completion carries the
  // authoritative assistant accumulator; tool_result is the authoritative
  // terminal result for its tool. Losing any of them leaves a consumer with
  // an incomplete outcome even though the projector has already settled it.
  return (
    isTurnTerminalOutcome(event) ||
    event.type === 'text_complete' ||
    event.type === 'thinking_complete' ||
    event.type === 'tool_result'
  );
}

function isTurnTerminalOutcome(event: SessionEvent): boolean {
  return event.type === 'complete' || event.type === 'abort' || event.type === 'error';
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

/**
 * Goal identity + revision: GoalManager.commit bumps the revision on every
 * accepted transition, so this pair detects every set/settle/pause/resume/
 * clear without a field-by-field compare.
 */
function sameGoalProjection(a: GoalProjection | null, b: GoalProjection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.goalId === b.goalId && a.revision === b.revision;
}
