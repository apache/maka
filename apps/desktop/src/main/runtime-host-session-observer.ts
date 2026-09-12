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

import type { ActiveInteractionRequestEvent, SessionEvent } from '@maka/core/events';
import type { SessionObservationMessage } from '../shared/session-execution-projection.js';
import type { SessionChangedReason, StoredMessage, TurnRecord } from '@maka/core/session';
import type { AgentGraphClientChangedEvent } from '@maka/runtime/stream-graph-coordinator';
import type { ShellRunPtyDataEvent } from '@maka/runtime/shell-run-contract';
import {
  RuntimeHostSessionProjector,
  isRuntimeHostTerminalTurn as isTerminalTurn,
  projectRuntimeHostInteractionRequest,
} from "@maka/runtime-host/adapter";
import {
  SESSION_TRANSCRIPT_RANGE_MAX_BYTES,
  type InteractionAnsweredSnapshot,
  type InteractionPendingSnapshot,
  type SessionDomainChange,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from "@maka/runtime-host/protocol";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import { RuntimeHostSubscriptionError } from "@maka/runtime-host/client";
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE,
  DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES,
  type DesktopTranscriptBatch,
  type DesktopTranscriptBatchPayload,
  type DesktopTranscriptOpenResult,
  type DesktopTranscriptRangeRequest,
  type DesktopTranscriptTailAcknowledgement,
} from '../preload/transcript-contract.js';
import {
  type PreparedSessionSubscription,
  RuntimeHostSessionSubscriptionOwner,
  SessionRemovedSubscriptionError,
} from "./runtime-host-session-subscription-owner.js";
import {
  type DesktopSequencedTranscriptMessage,
  type DesktopTranscriptReplica,
  type DesktopTranscriptReplicaChange,
  type DesktopTranscriptReplicaSnapshot,
} from './desktop-transcript-replica.js';
import {
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptPage,
  encodeDesktopTranscriptSnapshot,
} from './desktop-transcript-ipc.js';

type SessionObserverClient = Pick<DesktopRuntimeHostClient, 'openSession'> &
  Partial<Pick<DesktopRuntimeHostClient, 'listSessionTurns' | 'setSessionReadMarker' | 'queryMessageExecutions'>>;

const TRANSCRIPT_DELIVERY_TIMEOUT_MS = 30_000;
const TRANSCRIPT_DELIVERY_WINDOW = 4;

export interface RuntimeHostRendererTarget<Payload> {
  readonly id: number;
  send(channel: string, payload: Payload): void;
  once(event: "destroyed", listener: () => void): void;
  off(event: "destroyed", listener: () => void): void;
}

export type RuntimeHostSessionObserverTarget = RuntimeHostRendererTarget<SessionEvent | SessionObservationMessage>;
export type RuntimeHostTranscriptTarget = RuntimeHostRendererTarget<DesktopTranscriptBatch>;

export interface RuntimeHostSessionObserverDeps {
  cacheTranscript?: (snapshot: DesktopTranscriptReplicaSnapshot) => void;
  client: SessionObserverClient;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId: string,
    extra?: { turnId?: string },
  ) => void;
  emitSessionDomainChanged?: (change: SessionDomainChange) => void;
  emitRuntimeResourcePtyData?: (event: ShellRunPtyDataEvent) => void;
  emitRuntimeResourcePtyReset?: (sessionId: string) => void;
  emitAgentGraphChanged?: (event: AgentGraphClientChangedEvent) => void;
  onWatchedTurnFinished?: (
    sessionId: string,
    outcome: "completed" | "abandoned",
  ) => void | Promise<void>;
  emitActiveInteractionsChanged?: (
    sessionId: string,
    interactions: readonly ActiveInteractionRequestEvent[],
  ) => void;
  emitSubscriptionRecovered?: (sessionId: string) => void;
  recoverConnectionClosed?: boolean;
  now?: () => number;
}

interface ObserverTargetGroup {
  readonly target: RuntimeHostSessionObserverTarget;
  readonly observerIds: Set<string>;
  readonly destroyedListener: () => void;
}

interface ObservedSessionState {
  readonly sessionId: string;
  readonly targets: Map<number, ObserverTargetGroup>;
  readonly watchedTurnIds: Set<string>;
  readonly transcriptConsumers: Map<string, TranscriptConsumer>;
  readonly subscriptionOwner: RuntimeHostSessionSubscriptionOwner;
  pendingTranscriptConsumers: number;
  replica?: DesktopTranscriptReplica;
  snapshot?: SessionContinuitySnapshot;
  projector?: RuntimeHostSessionProjector;
  transcriptAccess: number;
  messageAdmissions: boolean;
  closing: boolean;
}

interface TranscriptConsumer {
  readonly consumerId: string;
  readonly target: RuntimeHostTranscriptTarget;
  generation: string;
  /** The standing replacement; a read naming an older one has been abandoned. */
  navigation: number;
  deliverySequence: number;
  deliveryBytes: number;
  deliveryTask?: Promise<void>;
  resetRequested: boolean;
  /**
   * Set only when the reset answers a navigation command, and stamped on that
   * snapshot so the window can tell its own answer from a replacement it did
   * not ask for. A reset from recovery or from an error carries no version:
   * the window applies it to whatever it holds, under any navigation.
   */
  resetNavigation?: number;
  /** Page answers queued behind the delivery loop so they never interleave with a change. */
  readonly pendingPages: PendingTranscriptPage[];
  pendingChange?: PendingTranscriptChange;
  readonly pendingDeliveries: Map<number, {
    readonly generation: string;
    readonly deliverySequence: number;
    resolve(): void;
    reject(error: Error): void;
  }>;
}

interface PendingTranscriptChange {
  coversFrom: number | null | undefined;
  durableThrough: number | null;
  readonly durableUpserts: Map<number, PendingTranscriptUpsert>;
  encodedBytes: number;
}

interface PendingTranscriptPage {
  readonly navigation: number;
  readonly generation: string;
  readonly batches: Iterable<DesktopTranscriptBatchPayload>;
  readonly encodedBytes: number;
}

interface PendingTranscriptUpsert {
  readonly entry: DesktopSequencedTranscriptMessage;
  readonly encodedBytes: number;
}

interface PendingTranscriptConsumer {
  readonly targetId: number;
  readonly cancelled: Promise<never>;
  cancel(): void;
}

interface ObserverRegistration {
  readonly state: ObservedSessionState;
  readonly group: ObserverTargetGroup;
  readonly ptyRef?: string;
  seeded: boolean;
}

interface SubscriptionFailureIdentity {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * Projects an owned Host Session subscription into Desktop observers.
 *
 * SessionSubscriptionOwner keeps replacement and catch-up atomic. This class
 * owns only renderer targets and the resulting Desktop projection.
 */
export class RuntimeHostSessionObserver {
  readonly #states = new Map<string, ObservedSessionState>();
  readonly #observers = new Map<string, ObserverRegistration>();
  readonly #transcriptConsumers = new Map<string, ObservedSessionState>();
  readonly #pendingTranscriptConsumers = new Map<string, PendingTranscriptConsumer>();
  readonly #client: SessionObserverClient;
  readonly #emitSessionsChanged: RuntimeHostSessionObserverDeps["emitSessionsChanged"];
  readonly #emitSessionDomainChanged: (change: SessionDomainChange) => void;
  readonly #emitRuntimeResourcePtyData: (event: ShellRunPtyDataEvent) => void;
  readonly #emitRuntimeResourcePtyReset: (sessionId: string) => void;
  readonly #cacheTranscript: (snapshot: DesktopTranscriptReplicaSnapshot) => void;
  readonly #emitAgentGraphChanged: (
    event: AgentGraphClientChangedEvent,
  ) => void;
  readonly #onWatchedTurnFinished: (
    sessionId: string,
    outcome: "completed" | "abandoned",
  ) => void | Promise<void>;
  readonly #emitActiveInteractionsChanged: (
    sessionId: string,
    interactions: readonly ActiveInteractionRequestEvent[],
  ) => void;
  readonly #emitSubscriptionRecovered: (sessionId: string) => void;
  readonly #recoverConnectionClosed: boolean;
  readonly #now: () => number;
  #closed = false;
  #transcriptAccessClock = 0;
  #transcriptPreparationBytes = 0;

  constructor(deps: RuntimeHostSessionObserverDeps) {
    this.#client = deps.client;
    this.#emitSessionsChanged = deps.emitSessionsChanged;
    this.#emitSessionDomainChanged =
      deps.emitSessionDomainChanged ?? (() => undefined);
    this.#emitRuntimeResourcePtyData =
      deps.emitRuntimeResourcePtyData ?? (() => undefined);
    this.#emitRuntimeResourcePtyReset = deps.emitRuntimeResourcePtyReset ?? (() => undefined);
    this.#cacheTranscript = deps.cacheTranscript ?? (() => undefined);
    this.#emitAgentGraphChanged =
      deps.emitAgentGraphChanged ?? (() => undefined);
    this.#onWatchedTurnFinished =
      deps.onWatchedTurnFinished ?? (() => undefined);
    this.#emitActiveInteractionsChanged =
      deps.emitActiveInteractionsChanged ?? (() => undefined);
    this.#emitSubscriptionRecovered =
      deps.emitSubscriptionRecovered ?? (() => undefined);
    this.#recoverConnectionClosed = deps.recoverConnectionClosed ?? false;
    this.#now = deps.now ?? Date.now;
  }

  async openTranscript(
    sessionId: string,
    consumerId: string,
    target: RuntimeHostTranscriptTarget,
  ): Promise<DesktopTranscriptOpenResult> {
    this.#assertOpen();
    if (
      this.#transcriptConsumers.has(consumerId) ||
      this.#pendingTranscriptConsumers.has(consumerId)
    ) {
      throw new Error('Desktop transcript consumer identity was reused');
    }
    const state = this.#state(sessionId);
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error('Desktop transcript open was cancelled'));
    });
    void cancelled.catch(() => undefined);
    const pending: PendingTranscriptConsumer = {
      targetId: target.id,
      cancelled,
      cancel,
    };
    this.#pendingTranscriptConsumers.set(consumerId, pending);
    state.pendingTranscriptConsumers += 1;
    let replica: DesktopTranscriptReplica;
    let admitted = false;
    try {
      await Promise.race([state.subscriptionOwner.waitUntilReady(), cancelled]);
      if (!state.replica?.resident) {
        await Promise.race([state.subscriptionOwner.refresh(), cancelled]);
      }
      if (this.#pendingTranscriptConsumers.get(consumerId) !== pending) await cancelled;
      replica = state.replica!;
      if (!replica?.resident) {
        throw new Error('Desktop transcript replica is unavailable');
      }
      if (!this.#touchReplica(state, state)) {
        throw new Error('Desktop transcript cache capacity was reached');
      }
      admitted = true;
    } finally {
      if (this.#pendingTranscriptConsumers.get(consumerId) === pending) {
        this.#pendingTranscriptConsumers.delete(consumerId);
      }
      state.pendingTranscriptConsumers -= 1;
      if (!admitted) {
        this.#touchReplica(state);
        void this.#closeIfIdle(state);
      }
    }
    const consumer: TranscriptConsumer = {
      consumerId,
      target,
      generation: replica.generation,
      navigation: 0,
      deliverySequence: 0,
      deliveryBytes: 0,
      resetRequested: false,
      pendingPages: [],
      pendingDeliveries: new Map(),
    };
    state.transcriptConsumers.set(consumerId, consumer);
    this.#transcriptConsumers.set(consumerId, state);
    try {
      consumer.resetRequested = true;
      await this.#scheduleTranscriptDelivery(state, consumer);
      await state.subscriptionOwner.waitUntilReady();
      if (state.replica?.generation !== consumer.generation) {
        consumer.resetRequested = true;
        await this.#scheduleTranscriptDelivery(state, consumer);
      }
      const currentReplica = state.replica;
      if (!currentReplica?.resident || currentReplica.generation !== consumer.generation) {
        throw new Error('Desktop transcript replica changed while opening');
      }
      this.#touchReplica(state);
      const readThroughMessageId = currentReplica.latestDurableVisibleMessageId();
      return {
        sessionId,
        generation: currentReplica.generation,
        hostEpoch: currentReplica.hostEpoch,
        readThroughMessageId,
      };
    } catch (error) {
      this.#detachTranscriptConsumer(state, consumer);
      await this.#closeIfIdle(state);
      throw error;
    }
  }

  async loadTranscriptBefore(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): Promise<void> {
    await this.#runTranscriptRangeOperation(request, targetId, false, async (replica, isCurrent) => {
      const page = await replica.loadBefore(
        request.anchorSequence,
        requireTranscriptRangeBytes(request.maxBytes),
        isCurrent,
      );
      return page && {
        batches: encodeDesktopTranscriptPage(this.#pageIdentity(replica, request), page, {
          direction: 'older', anchor: request.anchorSequence,
        }),
        bytes: page.durable,
      };
    });
  }

  async loadTranscriptAfter(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): Promise<void> {
    await this.#runTranscriptRangeOperation(request, targetId, false, async (replica, isCurrent) => {
      const page = await replica.loadAfter(
        request.anchorSequence,
        requireTranscriptRangeBytes(request.maxBytes),
        isCurrent,
      );
      return page && {
        batches: encodeDesktopTranscriptPage(this.#pageIdentity(replica, request), page, {
          direction: 'newer', anchor: request.anchorSequence,
        }),
        bytes: page.durable,
      };
    });
  }

  async loadTranscriptAround(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): Promise<void> {
    if (request.anchorSequence === null) {
      throw new Error('Desktop transcript around request requires an anchor');
    }
    const sequence = request.anchorSequence;
    await this.#runTranscriptRangeOperation(request, targetId, true, async (replica, isCurrent) => {
      const snapshot = await replica.loadAround(
        sequence,
        requireTranscriptRangeBytes(request.maxBytes),
        isCurrent,
      );
      return snapshot && {
        batches: encodeDesktopTranscriptSnapshot(snapshot, request.navigation),
        bytes: [...snapshot.durable, ...snapshot.overlay.map((message) => ({ message }))],
      };
    });
  }

  async loadTranscriptLatest(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): Promise<void> {
    const { state, replica, consumer } = this.#admitTranscriptNavigation(request, targetId, true);
    if (!consumer) return;
    // This answer is the tail cache, and global reclaim trims that cache even
    // while the Session is open (`#touchReplica`). Refill it first or a reader
    // returning to latest is answered with less than a tail.
    await replica.refillTail(
      requireTranscriptRangeBytes(request.maxBytes),
      this.#transcriptReadIsCurrent(state, replica, consumer, request),
    );
    if (!this.#transcriptReadIsCurrent(state, replica, consumer, request)()) return;
    consumer.resetRequested = true;
    consumer.resetNavigation = request.navigation;
    await this.#scheduleTranscriptDelivery(state, consumer);
    this.#touchReplica(state);
  }

  #pageIdentity(replica: DesktopTranscriptReplica, request: DesktopTranscriptRangeRequest) {
    return {
      sessionId: replica.sessionId,
      generation: replica.generation,
      hostEpoch: replica.hostEpoch,
      navigation: request.navigation,
    };
  }

  /**
   * Main's navigation number is a cancellation hint and nothing more: dropping
   * it would leave the system correct, because the Renderer decides what its
   * window can splice from the anchors the answers carry. What it buys is not
   * reading and shipping pages for a window the reader has already left.
   */
  #admitTranscriptNavigation(
    request: DesktopTranscriptRangeRequest,
    targetId: number | undefined,
    replaces: boolean,
  ): { state: ObservedSessionState; replica: DesktopTranscriptReplica; consumer?: TranscriptConsumer } {
    const { state, replica, consumer } = this.#requireTranscriptConsumer(request, targetId);
    const navigation = request.navigation;
    if (!Number.isSafeInteger(navigation) || navigation < 0) throw new Error('Invalid transcript navigation version');
    if (navigation < consumer.navigation) return { state, replica };
    if (replaces && navigation > consumer.navigation) {
      consumer.navigation = navigation;
      // Every queued answer was read for a window this replacement discards.
      consumer.pendingPages.splice(0).forEach((page) =>
        this.#adjustTranscriptDeliveryBytes(consumer, -page.encodedBytes),
      );
    }
    return { state, replica, consumer };
  }

  /** Asked before a read is started and again before its answer is sent. */
  #deliversTranscriptPage(consumer: TranscriptConsumer, navigation: number): boolean {
    return navigation >= consumer.navigation;
  }

  /** Whether a Host read still belongs to the window that asked for it. */
  #transcriptReadIsCurrent(
    state: ObservedSessionState,
    replica: DesktopTranscriptReplica,
    consumer: TranscriptConsumer,
    request: DesktopTranscriptRangeRequest,
  ): () => boolean {
    return () =>
      state.replica === replica &&
      state.transcriptConsumers.get(request.consumerId) === consumer &&
      this.#deliversTranscriptPage(consumer, request.navigation);
  }

  async #runTranscriptRangeOperation(
    request: DesktopTranscriptRangeRequest,
    targetId: number | undefined,
    replaces: boolean,
    operation: (
      replica: DesktopTranscriptReplica,
      isCurrent: () => boolean,
    ) => Promise<
      | { batches: Iterable<DesktopTranscriptBatchPayload>; bytes: readonly { readonly message: StoredMessage }[] }
      | undefined
    >,
  ): Promise<void> {
    const { state, replica, consumer } = this.#admitTranscriptNavigation(request, targetId, replaces);
    if (!consumer) return;
    const isCurrent = this.#transcriptReadIsCurrent(state, replica, consumer, request);
    let answer: Awaited<ReturnType<typeof operation>>;
    try {
      answer = await operation(replica, isCurrent);
    } catch (error) {
      // A replaced replica's failure is not a failure of the current window.
      if (!isCurrent()) return;
      throw error;
    }
    if (!answer || !isCurrent()) return;
    const encodedBytes = answer.bytes.reduce(
      (total, { message }) => total + encodedTranscriptMessageBytes(message),
      0,
    );
    if (!this.#adjustTranscriptDeliveryBytes(consumer, encodedBytes)) {
      throw new Error('Desktop transcript delivery capacity was reached');
    }
    consumer.pendingPages.push({
      navigation: request.navigation,
      generation: replica.generation,
      batches: answer.batches,
      encodedBytes,
    });
    await this.#scheduleTranscriptDelivery(state, consumer);
    if (isCurrent()) this.#touchReplica(state);
  }

  async closeTranscript(consumerId: string, targetId?: number): Promise<void> {
    const pending = this.#pendingTranscriptConsumers.get(consumerId);
    if (pending) {
      if (targetId !== undefined && pending.targetId !== targetId) {
        throw new Error('Desktop transcript consumer belongs to another renderer');
      }
      this.#pendingTranscriptConsumers.delete(consumerId);
      pending.cancel();
      return;
    }
    const state = this.#transcriptConsumers.get(consumerId);
    const consumer = state?.transcriptConsumers.get(consumerId);
    if (!state || !consumer) return;
    if (targetId !== undefined && consumer.target.id !== targetId) {
      throw new Error('Desktop transcript consumer belongs to another renderer');
    }
    this.#detachTranscriptConsumer(state, consumer);
    this.#touchReplica(state);
    await this.#closeIfIdle(state);
  }

  /**
   * The Renderer window reached `through`. Only this proves the reader received
   * the rows: a change a parked window refuses still leaves it off the tail, so
   * the read marker moves here and nowhere along delivery.
   */
  acknowledgeTranscriptTail(
    request: DesktopTranscriptTailAcknowledgement,
    targetId?: number,
  ): void {
    const state = this.#transcriptConsumers.get(request.consumerId);
    const consumer = state?.transcriptConsumers.get(request.consumerId);
    const replica = state?.replica;
    if (!state || !consumer || !replica?.resident) return;
    if (targetId !== undefined && consumer.target.id !== targetId) {
      throw new Error('Desktop transcript consumer belongs to another renderer');
    }
    // Sequences only name the same rows within one Session and Host epoch.
    if (state.sessionId !== request.sessionId || replica.hostEpoch !== request.hostEpoch) return;
    const durableThrough = replica.durableThrough;
    if (durableThrough === null || request.through < durableThrough) return;
    this.#markTranscriptRead(state, replica);
  }

  acknowledgeTranscript(
    consumerId: string,
    generation: string,
    deliverySequence: number,
    targetId?: number,
  ): void {
    const state = this.#transcriptConsumers.get(consumerId);
    const consumer = state?.transcriptConsumers.get(consumerId);
    if (!state || !consumer) return;
    if (targetId !== undefined && consumer.target.id !== targetId) {
      throw new Error('Desktop transcript consumer belongs to another renderer');
    }
    const pending = consumer.pendingDeliveries.get(deliverySequence);
    if (!pending || pending.generation !== generation) return;
    consumer.pendingDeliveries.delete(deliverySequence);
    pending.resolve();
  }

  async snapshot(sessionId: string): Promise<SessionContinuitySnapshot> {
    this.#assertOpen();
    const existing = this.#states.get(sessionId);
    if (existing) {
      await existing.subscriptionOwner.waitUntilReady();
      if (existing.snapshot) return structuredClone(existing.snapshot);
    }
    const handle = await this.#client.openSession(sessionId);
    try {
      return structuredClone(handle.snapshot);
    } finally {
      await handle.close();
    }
  }

  async observe(
    sessionId: string,
    observerId: string,
    target: RuntimeHostSessionObserverTarget,
    messageAdmissions = false,
    ptyRef?: string,
  ): Promise<void> {
    this.#assertOpen();
    const previous = this.#observers.get(observerId);
    if (previous) {
      if (
        previous.state.sessionId !== sessionId ||
        previous.group.target.id !== target.id
      ) {
        throw new Error("Runtime Host Session observer identity was reused");
      }
      await previous.state.subscriptionOwner.waitUntilReady();
      if (!previous.seeded) this.#seedTarget(previous.state, previous.group, observerId);
      return;
    }
    const state = this.#state(sessionId);
    if (messageAdmissions && !state.messageAdmissions) {
      state.messageAdmissions = true;
      state.projector?.enableMessageAdmissions();
    }
    let group = state.targets.get(target.id);
    if (!group) {
      const destroyedListener = () => {
        void this.#removeTarget(state, target.id);
      };
      group = {
        target,
        observerIds: new Set(),
        destroyedListener,
      };
      state.targets.set(target.id, group);
      target.once("destroyed", destroyedListener);
    }
    group.observerIds.add(observerId);
    const registration = { state, group, ptyRef, seeded: false };
    this.#observers.set(observerId, registration);
    try {
      await state.subscriptionOwner.waitUntilReady();
      if (ptyRef) await this.#syncPtyInterests(state);
      if (this.#observers.get(observerId) === registration && !registration.seeded) {
        this.#seedTarget(state, group, observerId);
      }
    } catch (error) {
      this.#detachObserver(observerId);
      throw error;
    }
  }

  async unobserve(observerId: string): Promise<void> {
    const state = this.#detachObserver(observerId);
    if (state) {
      await this.#syncPtyInterests(state);
      await this.#closeIfIdle(state);
    }
  }

  async watchTurn(sessionId: string, turnId: string): Promise<void> {
    this.#assertOpen();
    const state = this.#state(sessionId);
    state.watchedTurnIds.add(turnId);
    await state.subscriptionOwner.waitUntilReady();
    const root = state.snapshot?.rootTurn;
    if (root && root.turnId === turnId && isTerminalTurn(root)) {
      this.#finishWatchedTurn(state, turnId, "completed");
    }
    void this.#closeIfIdle(state);
  }

  observedRunningTurnIds(sessionId: string): string[] {
    const root = this.#states.get(sessionId)?.snapshot?.rootTurn;
    return root && !isTerminalTurn(root) ? [root.turnId] : [];
  }

  activeInteraction(
    sessionId: string,
    interactionId: string,
  ): InteractionPendingSnapshot | undefined {
    return this.#states
      .get(sessionId)
      ?.snapshot?.interactions.pending.find(
        (item) => item.interactionId === interactionId,
      );
  }

  listActiveInteractions(
    sessionId: string,
  ): ActiveInteractionRequestEvent[] | undefined {
    const snapshot = this.#states.get(sessionId)?.snapshot;
    return snapshot
      ? snapshot.interactions.pending.flatMap((interaction) =>
          projectRuntimeHostInteractionRequest(interaction, this.#now()),
        )
      : undefined;
  }

  async readActiveInteractions(
    sessionId: string,
  ): Promise<ActiveInteractionRequestEvent[]> {
    const cached = this.listActiveInteractions(sessionId);
    if (cached) return cached;
    const snapshot = await this.snapshot(sessionId);
    return snapshot.interactions.pending.flatMap((interaction) =>
      projectRuntimeHostInteractionRequest(interaction, this.#now()),
    );
  }

  async readInteraction(
    sessionId: string,
    interactionId: string,
  ): Promise<InteractionPendingSnapshot | undefined> {
    const cached = this.activeInteraction(sessionId, interactionId);
    if (cached) return cached;
    return (await this.snapshot(sessionId)).interactions.pending.find(
      (interaction) => interaction.interactionId === interactionId,
    );
  }

  publishInteractionAnswer(
    answered: InteractionAnsweredSnapshot,
    knownPending?: InteractionPendingSnapshot,
  ): void {
    const pending =
      knownPending ??
      this.activeInteraction(answered.sessionId, answered.interactionId);
    if (!pending) return;
    const base = {
      id: `host-interaction:${answered.interactionId}:${answered.revision}`,
      turnId: answered.turnId,
      ts: this.#now(),
      requestId: answered.interactionId,
      toolUseId: interactionToolUseId(pending),
    };
    if (answered.outcome.kind === "question_answer") {
      this.#broadcast(answered.sessionId, {
        type: "user_question_answer_ack",
        ...base,
      });
    } else if (answered.outcome.kind === "form_answer") {
      this.#broadcast(answered.sessionId, {
        type: "form_answer_ack",
        ...base,
      });
    } else if (answered.outcome.kind === "sandbox_boundary_decision") {
      this.#broadcast(answered.sessionId, {
        type: "sandbox_boundary_decision_ack",
        ...base,
        decision: answered.outcome.decision,
        status: answered.outcome.status,
        revision: answered.revision,
      });
    } else if (answered.outcome.kind === "client_capability_decision") {
      this.#broadcast(answered.sessionId, {
        type: "client_capability_decision_ack",
        ...base,
        decision: answered.outcome.decision,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pendingTranscripts = [...this.#pendingTranscriptConsumers.values()];
    this.#pendingTranscriptConsumers.clear();
    for (const pending of pendingTranscripts) pending.cancel();
    const states = [...this.#states.values()];
    this.#states.clear();
    this.#observers.clear();
    await Promise.all(states.map((state) => this.#closeState(state)));
  }

  #state(sessionId: string): ObservedSessionState {
    const existing = this.#states.get(sessionId);
    if (existing) return existing;
    let state!: ObservedSessionState;
    const subscriptionOwner = new RuntimeHostSessionSubscriptionOwner({
      client: this.#client,
      sessionId,
      now: this.#now,
      transcriptReplicaOptions: {
        accountPreparationBytes: (deltaBytes) =>
          this.#accountTranscriptPreparation(state, deltaBytes),
        onChange: (replica, change) => {
          this.#broadcastTranscriptChange(state, replica, change);
          this.#cacheTranscript(replica.snapshot());
        },
      },
      prepareActivation: (subscription, recovered) =>
        this.#prepareSubscriptionActivation(state, subscription, recovered),
      acceptFrame: (frame) => this.#acceptFrame(state, frame),
      recoveryStarted: (error) => {
        this.#broadcast(state.sessionId, { type: 'host_observation_pending' });
        console.warn(
          "[runtime-host-session-observer] recovering subscription",
          subscriptionFailureIdentity(state, error),
        );
      },
      recoveryCompleted: (error) => {
        console.info(
          "[runtime-host-session-observer] subscription recovered",
          subscriptionFailureIdentity(state, error),
        );
        void this.#closeIfIdle(state);
      },
      recoveryFailed: (initialError, error) => {
        console.error(
          "[runtime-host-session-observer] subscription recovery failed",
          {
            failure: subscriptionFailureIdentity(state, initialError),
            recovery: subscriptionFailureIdentity(state, error),
          },
        );
      },
      terminalFailure: (error) =>
        this.#handleTerminalSubscriptionFailure(state, error),
    });
    state = {
      sessionId,
      targets: new Map(),
      watchedTurnIds: new Set(),
      transcriptConsumers: new Map(),
      subscriptionOwner,
      pendingTranscriptConsumers: 0,
      transcriptAccess: 0,
      messageAdmissions: false,
      closing: false,
    };
    this.#states.set(sessionId, state);
    subscriptionOwner.start();
    return state;
  }

  #seedTarget(
    state: ObservedSessionState,
    group: ObserverTargetGroup,
    observerId?: string,
    events = state.projector?.seedActive(true) ?? [],
  ): void {
    if (!state.snapshot || !state.replica) return;
    const observerIds = observerId ? [observerId] : [...group.observerIds];
    this.#send(state, group, {
      type: 'host_observation_seed',
      observerIds,
      execution: { type: 'host_execution', available: true, rootTurn: state.snapshot.rootTurn },
      events,
    });
    // Activation may seed a subscriber before its observe() wait resumes.
    // Track delivery per registration, not per window or execution Turn.
    for (const id of observerIds) {
      const registration = this.#observers.get(id);
      if (registration) registration.seeded = true;
    }
  }

  async #acceptFrame(state: ObservedSessionState, frame: SubscriptionFrame): Promise<void> {
    if (frame.kind === 'subscription.transcript_advanced') {
      await state.replica?.advance(frame.throughSequence);
      return;
    }
    if (frame.kind === "subscription.runtime_resource_pty_data") {
      if (frame.reset) {
        this.#emitRuntimeResourcePtyReset(frame.sessionId);
        return;
      }
      this.#emitRuntimeResourcePtyData({
        sessionId: frame.sessionId,
        ref: frame.ref,
        sequence: frame.ptySequence,
        data: frame.data,
      });
      return;
    }
    if (frame.kind === "subscription.session_domain_changed") {
      this.#emitSessionDomainChanged(
        frame.domain === "runtime_resource"
          ? {
              sessionId: frame.sessionId,
              domain: frame.domain,
              resources: frame.resources,
            }
          : { sessionId: frame.sessionId, domain: frame.domain },
      );
      return;
    }
    if (frame.kind === "subscription.agent_graph_changed") {
      this.#emitAgentGraphChanged({
        schemaVersion: 1,
        rootSessionId: frame.rootSessionId,
        graphId: frame.graphId,
        reason: frame.reason,
      });
      return;
    }
    const update = state.projector?.accept(frame);
    if (!update || !state.projector) return;
    state.snapshot = state.projector.snapshot;
    if (update.previousSnapshot) {
      for (const group of state.targets.values()) this.#sendExecution(state, group);
      await this.#reconcileRemovedQueueMessages(state, update.previousSnapshot, state.snapshot);
    }
    for (const event of update.events) {
      this.#broadcast(state.sessionId, event);
      if (event.type === "tool_result") {
        this.#emitSessionsChanged("message-appended", state.sessionId, {
          turnId: event.turnId,
        });
      }
    }
    const previous = update.previousSnapshot;
    if (!previous) return;
    if (!samePendingInteractions(previous, state.snapshot)) {
      this.#emitActiveInteractions(state);
    }
    if (!sameGoal(previous.goal, state.snapshot.goal)) {
      this.#emitSessionsChanged("goal-change", state.sessionId);
    }
    const root = state.snapshot.rootTurn;
    if (update.terminalTurn) {
      this.#finishWatchedTurn(state, update.terminalTurn.turnId, "completed");
      void this.#closeIfIdle(state);
      this.#emitSessionsChanged("turn-status-change", state.sessionId, {
        turnId: update.terminalTurn.turnId,
      });
    } else {
      this.#emitSessionsChanged(
        "status-change",
        state.sessionId,
        root ? { turnId: root.turnId } : undefined,
      );
    }
    const transcriptTurn = update.terminalTurn ?? update.startedTurn;
    if (transcriptTurn) {
      this.#emitSessionsChanged("message-appended", state.sessionId, {
        turnId: transcriptTurn.turnId,
      });
    }
  }

  async #reconcileRemovedQueueMessages(
    state: ObservedSessionState,
    previous: SessionContinuitySnapshot,
    next: SessionContinuitySnapshot,
  ): Promise<void> {
    if (!state.messageAdmissions || !this.#client.queryMessageExecutions
      || previous.queue.hostEpoch !== next.queue.hostEpoch) return;
    const retained = new Set(
      [...next.queue.steering, ...next.queue.followup].map((entry) => entry.messageId),
    );
    // A queue removal can be delivery, promotion or cancellation. Only Host
    // proof can retire the transient or name the successor; the snapshot's
    // current root alone cannot. A queue contains at most 64 message identities.
    const messageIds = [...previous.queue.steering, ...previous.queue.followup]
      .filter((entry) => !retained.has(entry.messageId))
      .map((entry) => entry.messageId);
    if (messageIds.length === 0) return;
    const projector = state.projector;
    try {
      const { resolutions } = await this.#client.queryMessageExecutions({
        sessionId: state.sessionId, messageIds,
      });
      if (this.#closed || state.closing || state.projector !== projector) return;
      for (const resolution of resolutions) {
        if (resolution.state === 'pending') continue;
        const turnId = resolution.state === 'owned'
          ? resolution.turnId : (next.rootTurn ?? previous.rootTurn)?.turnId;
        if (!turnId) continue;
        this.#broadcast(state.sessionId, {
          type: 'message_admission',
          id: `host-message-resolution:${next.queue.hostEpoch}:${next.queue.queueRevision}:${resolution.messageId}`,
          turnId,
          ts: this.#now(),
          messageId: resolution.messageId,
          outcome: resolution.state === 'owned' ? 'admitted' : 'retracted',
        });
      }
    } catch {
      // Keep unproven messages visible. Durable transcript admission or the
      // next observation recovery can resolve them without guessing a result.
    }
  }

  #broadcast(sessionId: string, event: SessionEvent | SessionObservationMessage): void {
    const state = this.#states.get(sessionId);
    if (!state) return;
    for (const group of state.targets.values()) {
      this.#send(state, group, event);
    }
  }

  #sendExecution(state: ObservedSessionState, group: ObserverTargetGroup): void {
    if (!state.snapshot || !state.replica) return;
    this.#send(state, group, {
      type: 'host_execution',
      available: true,
      rootTurn: state.snapshot.rootTurn,
    });
  }

  #send(
    state: ObservedSessionState,
    group: ObserverTargetGroup,
    event: SessionEvent | SessionObservationMessage,
  ): void {
    try {
      group.target.send(sessionEventChannel(state.sessionId), event);
    } catch {
      this.#detachTarget(state, group);
      void this.#closeIfIdle(state);
    }
  }

  #publishSubscriptionFailure(
    state: ObservedSessionState,
    error: Error,
  ): void {
    const root = state.snapshot?.rootTurn;
    this.#broadcast(state.sessionId, { type: 'host_observation_pending' });
    for (const group of state.targets.values()) {
      try {
        group.target.send(sessionEventChannel(state.sessionId), {
          type: 'host_observation_error', message: error.message,
        });
      } catch {
        this.#detachTarget(state, group);
      }
    }
    this.#emitSessionsChanged(
      "status-change",
      state.sessionId,
      root ? { turnId: root.turnId } : undefined,
    );
    void this.#closeState(state);
  }

  #handleTerminalSubscriptionFailure(
    state: ObservedSessionState,
    error: Error,
  ): void {
    if (error instanceof SessionRemovedSubscriptionError) {
      this.#emitSessionsChanged("deleted", state.sessionId);
      void this.#closeState(state);
      return;
    }
    if (
      this.#recoverConnectionClosed &&
      error instanceof RuntimeHostSubscriptionError &&
      error.reason === "connection_closed"
    ) {
      void this.#closeState(state);
      return;
    }
    this.#publishSubscriptionFailure(state, error);
  }

  async #prepareSubscriptionActivation(
    state: ObservedSessionState,
    subscription: PreparedSessionSubscription,
    recovered: boolean,
  ): Promise<() => void> {
    if (state.closing || this.#states.get(state.sessionId) !== state) {
      throw new Error("Runtime Host Session observer closed before commit");
    }
    const previousSnapshot = state.snapshot;
    const previousReplica = state.replica;
    const projector = new RuntimeHostSessionProjector(
      subscription.snapshot,
      subscription.replica.projectionSeed,
      this.#now,
      subscription.activeAssistantStreams,
      state.messageAdmissions,
    );
    const terminalTurnIds = new Set<string>();
    for (const turnId of state.watchedTurnIds) {
      if (subscription.snapshot.rootTurn?.turnId !== turnId) terminalTurnIds.add(turnId);
    }
    if (previousSnapshot?.rootTurn && !isTerminalTurn(previousSnapshot.rootTurn)) {
      const nextRoot = subscription.snapshot.rootTurn;
      if (!nextRoot || nextRoot.runId !== previousSnapshot.rootTurn.runId) {
        terminalTurnIds.add(previousSnapshot.rootTurn.turnId);
      }
    }
    const recordedTurns = await this.#readMissingRecordedTurns(
      subscription.replica,
      terminalTurnIds,
    );
    if (state.closing || this.#states.get(state.sessionId) !== state) {
      throw new Error('Runtime Host Session observer closed before commit');
    }
    const replacement =
      previousSnapshot
        ? replacementProjection(
            previousSnapshot,
            projector,
            previousSnapshot.rootTurn
              ? subscription.replica.messagesForTurn(previousSnapshot.rootTurn.turnId)
              : [],
            recordedTurns,
          )
        : undefined;
    const goalChanged = previousSnapshot
      ? !sameGoal(previousSnapshot.goal, subscription.snapshot.goal)
      : false;

    return () => {
      if (
        state.closing ||
        this.#states.get(state.sessionId) !== state ||
        state.snapshot !== previousSnapshot ||
        state.replica !== previousReplica
      ) {
        throw new Error('Runtime Host Session observer changed before activation');
      }
      state.snapshot = structuredClone(subscription.snapshot);
      state.replica = subscription.replica;
      this.#cacheTranscript(subscription.replica.snapshot());
      subscription.replica.adoptResidentAccounting();
      state.projector = projector;
      previousReplica?.close();
      this.#resetTranscriptConsumers(state);
      this.#touchReplica(state);

      if (replacement) {
        for (const group of state.targets.values()) {
          this.#seedTarget(state, group, undefined, [
            ...replacement.terminalEvents, ...replacement.activeEvents,
          ]);
        }
        for (const turnId of replacement.terminalTurnIds) {
          this.#finishWatchedTurn(state, turnId, "completed");
          this.#emitSessionsChanged("turn-status-change", state.sessionId, {
            turnId,
          });
          this.#emitSessionsChanged("message-appended", state.sessionId, {
            turnId,
          });
        }
        this.#emitActiveInteractions(state);
        if (goalChanged) {
          this.#emitSessionsChanged("goal-change", state.sessionId);
        }
        const root = state.snapshot.rootTurn;
        this.#emitSessionsChanged(
          "status-change",
          state.sessionId,
          root ? { turnId: root.turnId } : undefined,
        );
        if (root && !replacement.terminalTurnIds.has(root.turnId)) {
          this.#emitSessionsChanged("message-appended", state.sessionId, {
            turnId: root.turnId,
          });
        }
      } else {
        for (const group of state.targets.values()) this.#seedTarget(state, group);
      }

      this.#finishPersistedWatchedTurns(
        state,
        projector,
        subscription.replica,
        recordedTurns,
      );

      if (recovered) this.#emitSubscriptionRecovered(state.sessionId);
    };
  }

  #emitActiveInteractions(state: ObservedSessionState): void {
    const interactions = state.snapshot?.interactions.pending.flatMap(
      (interaction) =>
        projectRuntimeHostInteractionRequest(interaction, this.#now()),
    );
    if (interactions) {
      this.#emitActiveInteractionsChanged(state.sessionId, interactions);
    }
  }

  #finishPersistedWatchedTurns(
    state: ObservedSessionState,
    projector: RuntimeHostSessionProjector,
    replica: DesktopTranscriptReplica,
    recordedTurns: ReadonlyMap<string, TurnRecord>,
  ): void {
    const root = projector.snapshot.rootTurn;
    for (const turnId of [...state.watchedTurnIds]) {
      if (root?.turnId === turnId && isTerminalTurn(root)) {
        this.#finishWatchedTurn(state, turnId, 'completed');
        continue;
      }
      const events = projector.seedStoredTerminal(turnId, replica.messagesForTurn(turnId));
      const recorded = recordedTurns.get(turnId);
      if (
        events.some(isTerminalSessionEvent) ||
        (recorded && projector.seedRecordedTerminal(recorded).length > 0)
      ) {
        this.#finishWatchedTurn(state, turnId, "completed");
      }
    }
  }

  async #readMissingRecordedTurns(
    replica: DesktopTranscriptReplica,
    turnIds: ReadonlySet<string>,
  ): Promise<Map<string, TurnRecord>> {
    const missing = [...turnIds].filter(
      (turnId) => !hasStoredTerminal(replica.messagesForTurn(turnId)),
    );
    if (missing.length === 0 || !this.#client.listSessionTurns) return new Map();
    const wanted = new Set(missing);
    return new Map(
      (await this.#client.listSessionTurns(replica.sessionId))
        .filter((turn) => wanted.has(turn.turnId))
        .map((turn) => [turn.turnId, turn]),
    );
  }

  async #closeIfIdle(state: ObservedSessionState): Promise<void> {
    if (
      state.targets.size > 0 ||
      state.watchedTurnIds.size > 0 ||
      state.transcriptConsumers.size > 0 ||
      state.pendingTranscriptConsumers > 0
    ) return;
    await Promise.resolve();
    if (
      state.targets.size === 0 &&
      state.watchedTurnIds.size === 0 &&
      state.transcriptConsumers.size === 0 &&
      state.pendingTranscriptConsumers === 0
    ) {
      await this.#closeState(state);
    }
  }

  #finishWatchedTurn(
    state: ObservedSessionState,
    turnId: string,
    outcome: "completed" | "abandoned",
  ): void {
    if (!state.watchedTurnIds.delete(turnId)) return;
    if (state.watchedTurnIds.size > 0) return;
    this.#notifyWatchedTurnFinished(state.sessionId, outcome);
  }

  #finishAllWatchedTurns(
    state: ObservedSessionState,
    outcome: "completed" | "abandoned",
  ): void {
    if (state.watchedTurnIds.size === 0) return;
    state.watchedTurnIds.clear();
    this.#notifyWatchedTurnFinished(state.sessionId, outcome);
  }

  #notifyWatchedTurnFinished(
    sessionId: string,
    outcome: "completed" | "abandoned",
  ): void {
    try {
      void Promise.resolve(
        this.#onWatchedTurnFinished(sessionId, outcome),
      ).catch(() => undefined);
    } catch {
      // A watched-turn consumer cannot break Session projection or teardown.
    }
  }

  async #closeState(state: ObservedSessionState): Promise<void> {
    if (!state.closing) {
      state.closing = true;
      this.#finishAllWatchedTurns(state, "abandoned");
      if (this.#states.get(state.sessionId) === state)
        this.#states.delete(state.sessionId);
      for (const group of state.targets.values())
        this.#detachTarget(state, group);
      for (const consumer of state.transcriptConsumers.values()) {
        this.#detachTranscriptConsumer(state, consumer);
      }
      state.replica?.close();
    }
    await state.subscriptionOwner.close();
  }

  async #removeTarget(
    state: ObservedSessionState,
    targetId: number,
  ): Promise<void> {
    const group = state.targets.get(targetId);
    if (!group) return;
    this.#detachTarget(state, group);
    await this.#syncPtyInterests(state).catch(() => undefined);
    await this.#closeIfIdle(state);
  }

  #syncPtyInterests(state: ObservedSessionState): Promise<void> {
    const refs = new Set<string>();
    for (const observer of this.#observers.values()) {
      if (observer.state === state && observer.ptyRef) refs.add(observer.ptyRef);
    }
    return state.subscriptionOwner.setPtyInterests([...refs]);
  }

  #detachTarget(state: ObservedSessionState, group: ObserverTargetGroup): void {
    if (state.targets.get(group.target.id) !== group) return;
    state.targets.delete(group.target.id);
    group.target.off("destroyed", group.destroyedListener);
    for (const observerId of group.observerIds)
      this.#observers.delete(observerId);
    group.observerIds.clear();
  }

  #detachObserver(observerId: string): ObservedSessionState | undefined {
    const registration = this.#observers.get(observerId);
    if (!registration) return undefined;
    this.#observers.delete(observerId);
    registration.group.observerIds.delete(observerId);
    if (registration.group.observerIds.size === 0) {
      this.#detachTarget(registration.state, registration.group);
    }
    return registration.state;
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new Error("Runtime Host Session observer is closed");
  }

  #broadcastTranscriptChange(
    state: ObservedSessionState,
    replica: DesktopTranscriptReplica,
    change: DesktopTranscriptReplicaChange,
  ): void {
    if (state.replica !== replica || state.closing) return;
    for (const event of
      state.projector?.noteDurableTranscriptMessages(
        change.durableUpserts.map((entry) => entry.message),
      ) ?? []) {
      this.#broadcast(state.sessionId, event);
    }
    this.#sendTranscriptChange(state, replica, change);
    this.#touchReplica(state);
    void this.#closeIfIdle(state);
  }

  #sendTranscriptChange(
    state: ObservedSessionState,
    replica: DesktopTranscriptReplica,
    change: DesktopTranscriptReplicaChange,
  ): void {
    for (const consumer of [...state.transcriptConsumers.values()]) {
      if (consumer.generation !== replica.generation) {
        this.#requestTranscriptReset(state, consumer);
      } else if (!this.#mergeTranscriptChange(consumer, change)) {
        this.#requestTranscriptReset(state, consumer);
      } else {
        void this.#scheduleTranscriptDelivery(state, consumer).catch(() => undefined);
      }
    }
  }

  #resetTranscriptConsumers(state: ObservedSessionState): void {
    for (const consumer of [...state.transcriptConsumers.values()]) {
      this.#requestTranscriptReset(state, consumer);
    }
  }

  #scheduleTranscriptDelivery(
    state: ObservedSessionState,
    consumer: TranscriptConsumer,
  ): Promise<void> {
    if (consumer.deliveryTask) return consumer.deliveryTask;
    let task!: Promise<void>;
    task = (async () => {
      try {
        while (state.transcriptConsumers.get(consumer.consumerId) === consumer) {
          if (consumer.resetRequested) {
            consumer.resetRequested = false;
            const resetNavigation = consumer.resetNavigation;
            consumer.resetNavigation = undefined;
            this.#clearPendingTranscriptChange(consumer);
            const replica = state.replica;
            if (!replica?.resident || state.closing) return;
            const deliveryBytes = resetDeliveryWorkingSetBytes(replica.residentBytes);
            if (!this.#adjustTranscriptDeliveryBytes(consumer, deliveryBytes)) {
              throw new Error('Desktop transcript delivery capacity was reached');
            }
            consumer.generation = replica.generation;
            try {
              await this.#sendTranscriptBatches(
                consumer,
                encodeDesktopTranscriptSnapshot(replica.snapshot(), resetNavigation),
              );
            } finally {
              this.#adjustTranscriptDeliveryBytes(consumer, -deliveryBytes);
            }
            continue;
          }
          const page = consumer.pendingPages.shift();
          if (page) {
            try {
              if (
                this.#deliversTranscriptPage(consumer, page.navigation) &&
                page.generation === consumer.generation &&
                state.replica?.generation === consumer.generation
              ) {
                await this.#sendTranscriptBatches(consumer, page.batches);
              }
            } finally {
              this.#adjustTranscriptDeliveryBytes(consumer, -page.encodedBytes);
            }
            continue;
          }
          const pending = consumer.pendingChange;
          if (!pending) return;
          consumer.pendingChange = undefined;
          try {
            const replica = state.replica;
            if (!replica?.resident || replica.generation !== consumer.generation) {
              consumer.resetRequested = true;
              continue;
            }
            await this.#sendTranscriptBatches(
              consumer,
              encodeDesktopTranscriptChange(
                {
                  sessionId: replica.sessionId,
                  generation: replica.generation,
                  hostEpoch: replica.hostEpoch,
                },
                {
                  coversFrom: pending.coversFrom,
                  durableThrough: pending.durableThrough,
                  durableUpserts: [...pending.durableUpserts.values()].map(({ entry }) => entry),
                },
              ),
            );
          } finally {
            this.#adjustTranscriptDeliveryBytes(consumer, -pending.encodedBytes);
          }
        }
      } catch (error) {
        if (state.transcriptConsumers.get(consumer.consumerId) === consumer) {
          consumer.resetRequested = true;
        }
        throw error;
      }
    })().finally(() => {
      if (consumer.deliveryTask === task) consumer.deliveryTask = undefined;
    });
    consumer.deliveryTask = task;
    void task.catch(() => undefined);
    return task;
  }

  #requestTranscriptReset(state: ObservedSessionState, consumer: TranscriptConsumer): void {
    consumer.resetRequested = true;
    this.#clearPendingTranscriptChange(consumer);
    void this.#scheduleTranscriptDelivery(state, consumer).catch(() => undefined);
  }

  /**
   * Coalesces tail growth for one consumer. A merged change can only keep rows
   * while each change starts where the last one ended; where it does not, the
   * rows go and the merge carries nothing but the watermark, which is enough
   * for the window to learn it has fallen behind and read forward itself.
   */
  #mergeTranscriptChange(
    consumer: TranscriptConsumer,
    change: DesktopTranscriptReplicaChange,
  ): boolean {
    if (consumer.resetRequested) return true;
    const existing = consumer.pendingChange;
    const pending = existing ?? {
      coversFrom: change.coversFrom,
      durableThrough: change.durableThrough,
      durableUpserts: new Map<number, PendingTranscriptUpsert>(),
      encodedBytes: 0,
    };
    let byteDelta = 0;
    const joins = !existing ||
      (pending.coversFrom !== undefined && pending.durableThrough === change.coversFrom);
    if (!joins) {
      for (const { encodedBytes } of pending.durableUpserts.values()) byteDelta -= encodedBytes;
      pending.durableUpserts.clear();
      pending.coversFrom = undefined;
    }
    pending.durableThrough = change.durableThrough;
    for (const entry of joins ? change.durableUpserts : []) {
      const previous = pending.durableUpserts.get(entry.sequence);
      if (previous) byteDelta -= previous.encodedBytes;
      const encodedBytes = encodedTranscriptMessageBytes(entry.message);
      pending.durableUpserts.set(entry.sequence, { entry, encodedBytes });
      byteDelta += encodedBytes;
    }
    pending.encodedBytes += byteDelta;
    consumer.pendingChange = pending;
    if (this.#adjustTranscriptDeliveryBytes(consumer, byteDelta)) return true;
    pending.encodedBytes -= byteDelta;
    this.#clearPendingTranscriptChange(consumer);
    return false;
  }

  #clearPendingTranscriptChange(consumer: TranscriptConsumer): void {
    const pending = consumer.pendingChange;
    if (!pending) return;
    consumer.pendingChange = undefined;
    this.#adjustTranscriptDeliveryBytes(consumer, -pending.encodedBytes);
  }

  #adjustTranscriptDeliveryBytes(consumer: TranscriptConsumer, delta: number): boolean {
    consumer.deliveryBytes += delta;
    if (delta <= 0 || this.#transcriptResidentBytes() <= DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES) {
      return true;
    }
    consumer.deliveryBytes -= delta;
    return false;
  }

  #transcriptResidentBytes(): number {
    let total = this.#transcriptPreparationBytes;
    for (const state of this.#states.values()) {
      total += state.replica?.residentBytes ?? 0;
      for (const consumer of state.transcriptConsumers.values()) total += consumer.deliveryBytes;
    }
    return total;
  }

  #accountTranscriptPreparation(state: ObservedSessionState, deltaBytes: number): void {
    if (!Number.isSafeInteger(deltaBytes)) {
      throw new RangeError('Invalid Desktop transcript preparation size');
    }
    if (this.#transcriptPreparationBytes + deltaBytes < 0) {
      throw new RangeError('Invalid Desktop transcript preparation release');
    }
    this.#transcriptPreparationBytes += deltaBytes;
    if (deltaBytes > 0 && !this.#touchReplica(state, state)) {
      this.#transcriptPreparationBytes -= deltaBytes;
      throw new RangeError('Desktop transcript preparation exceeds the global cache limit');
    }
  }

  #deliverTranscriptBatch(
    consumer: TranscriptConsumer,
    batch: DesktopTranscriptBatchPayload,
  ): Promise<void> {
    if (consumer.pendingDeliveries.size >= TRANSCRIPT_DELIVERY_WINDOW) {
      throw new Error('Desktop transcript consumer delivery window is full');
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const acknowledged = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const deliverySequence = ++consumer.deliverySequence;
    const pending = {
      generation: batch.generation,
      deliverySequence,
      resolve,
      reject,
    };
    consumer.pendingDeliveries.set(deliverySequence, pending);
    const timeout = setTimeout(
      () => reject(new Error('Desktop transcript delivery timed out')),
      TRANSCRIPT_DELIVERY_TIMEOUT_MS,
    );
    return (async () => {
      try {
      consumer.target.send(transcriptChannel(consumer.consumerId), {
        ...batch,
        deliverySequence,
      });
      await acknowledged;
      } finally {
        clearTimeout(timeout);
        if (consumer.pendingDeliveries.get(deliverySequence) === pending) {
          consumer.pendingDeliveries.delete(deliverySequence);
        }
      }
    })();
  }

  async #sendTranscriptBatches(
    consumer: TranscriptConsumer,
    batches: Iterable<DesktopTranscriptBatchPayload>,
  ): Promise<void> {
    const deliveries = new Set<Promise<void>>();
    // One answer goes out whole or not at all: a window assembles it as a unit,
    // and a run cut short in the middle would never complete into one.
    for (const batch of batches) {
      let delivery!: Promise<void>;
      delivery = this.#deliverTranscriptBatch(consumer, batch).finally(() => {
        deliveries.delete(delivery);
      });
      deliveries.add(delivery);
      void delivery.catch(() => undefined);
      if (deliveries.size === TRANSCRIPT_DELIVERY_WINDOW) {
        await Promise.race(deliveries);
      }
    }
    await Promise.all(deliveries);
  }

  #requireTranscriptConsumer(
    request: DesktopTranscriptRangeRequest,
    targetId?: number,
  ): {
    state: ObservedSessionState;
    replica: DesktopTranscriptReplica;
    consumer: TranscriptConsumer;
  } {
    const state = this.#transcriptConsumers.get(request.consumerId);
    const consumer = state?.transcriptConsumers.get(request.consumerId);
    const replica = state?.replica;
    if (!state || !consumer || !replica) {
      throw new Error('Desktop transcript consumer does not exist');
    }
    if (targetId !== undefined && consumer.target.id !== targetId) {
      throw new Error('Desktop transcript consumer belongs to another renderer');
    }
    // Durable transcript sequence identities belong to the Session and the
    // Runtime Host epoch, not to a Desktop replica generation. Recovery may
    // install a replacement replica (new generation, same session and host
    // epoch) after the renderer dispatches a range request; continue that
    // read against the current replica so navigation completes across
    // reconnect. When the Host itself is replaced, sequence identity is not
    // preserved, so reject the stale request instead of silently reading a
    // different slice.
    if (state.sessionId !== request.sessionId) {
      throw new Error('Desktop transcript consumer belongs to another session');
    }
    if (replica.hostEpoch !== request.hostEpoch) {
      throw new Error(
        `${DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE}: Desktop transcript host epoch changed; reopen the transcript`,
      );
    }
    return { state, replica, consumer };
  }

  #detachTranscriptConsumer(
    state: ObservedSessionState,
    consumer: TranscriptConsumer,
  ): void {
    if (state.transcriptConsumers.get(consumer.consumerId) !== consumer) return;
    state.transcriptConsumers.delete(consumer.consumerId);
    this.#transcriptConsumers.delete(consumer.consumerId);
    consumer.resetRequested = false;
    this.#clearPendingTranscriptChange(consumer);
    consumer.pendingPages.splice(0).forEach((page) =>
      this.#adjustTranscriptDeliveryBytes(consumer, -page.encodedBytes),
    );
    for (const pending of consumer.pendingDeliveries.values()) {
      pending.reject(new Error('Desktop transcript consumer was closed'));
    }
    consumer.pendingDeliveries.clear();
  }

  #touchReplica(state: ObservedSessionState, protectedState?: ObservedSessionState): boolean {
    state.transcriptAccess = ++this.#transcriptAccessClock;
    let total = this.#transcriptResidentBytes();
    const replicas: Array<{
      state: ObservedSessionState;
      replica: DesktopTranscriptReplica;
    }> = [];
    for (const candidate of this.#states.values()) {
      if (!candidate.replica) continue;
      replicas.push({ state: candidate, replica: candidate.replica });
    }
    replicas.sort((left, right) => left.state.transcriptAccess - right.state.transcriptAccess);
    for (const candidate of replicas) {
      if (total <= DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES) break;
      const before = candidate.replica.residentBytes;
      candidate.replica.trimDurable(
        Math.max(0, before - (total - DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES)),
      );
      total -= before - candidate.replica.residentBytes;
    }
    for (const candidate of replicas) {
      if (total <= DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES) break;
      if (
        candidate.state === protectedState ||
        candidate.state.pendingTranscriptConsumers > 0 ||
        candidate.state.transcriptConsumers.size > 0
      ) {
        continue;
      }
      const before = candidate.replica.residentBytes;
      candidate.replica.discard();
      total -= before;
    }
    return this.#transcriptResidentBytes() <= DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES;
  }

  #markTranscriptRead(state: ObservedSessionState, replica: DesktopTranscriptReplica): void {
    const messageId = replica.latestDurableVisibleMessageId();
    if (!messageId) return;
    const update = this.#client.setSessionReadMarker?.(state.sessionId, messageId);
    if (update) void update.catch(() => undefined);
  }
}

function interactionToolUseId(interaction: InteractionPendingSnapshot): string {
  return interaction.request.kind === "sandbox_boundary"
    ? interaction.interactionId
    : interaction.request.toolUseId;
}

function sessionEventChannel(sessionId: string): string {
  return `sessions:event:${sessionId}`;
}

function transcriptChannel(consumerId: string): string {
  return `sessions:transcript:${consumerId}`;
}

function encodedTranscriptMessageBytes(message: StoredMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function requireTranscriptRangeBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES
  ) {
    throw new Error('Invalid Desktop transcript range byte limit');
  }
  return value;
}

function resetDeliveryWorkingSetBytes(residentBytes: number): number {
  return (
    Math.min(residentBytes, SESSION_TRANSCRIPT_RANGE_MAX_BYTES) +
    Math.min(
      residentBytes,
      (TRANSCRIPT_DELIVERY_WINDOW * 2 + 1) * DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
    )
  );
}

function sameGoal(
  previous: SessionContinuitySnapshot["goal"] | undefined,
  next: SessionContinuitySnapshot["goal"],
): boolean {
  if (previous === null || previous === undefined) return next === null;
  return (
    next !== null &&
    previous.goalId === next.goalId &&
    previous.revision === next.revision
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function replacementProjection(
  previous: SessionContinuitySnapshot,
  projector: RuntimeHostSessionProjector,
  transcript: readonly StoredMessage[],
  recordedTurns: ReadonlyMap<string, TurnRecord>,
): {
  terminalEvents: SessionEvent[];
  activeEvents: SessionEvent[];
  terminalTurnIds: Set<string>;
} {
  const next = projector.snapshot;
  const previousRoot = previous.rootTurn;
  const root = next.rootTurn;
  const terminalEvents: SessionEvent[] = [];
  const seedEvents = projector.seedActive(true);
  if (previousRoot && !isTerminalTurn(previousRoot)) {
    if (!root || root.runId !== previousRoot.runId) {
      const stored = projector.seedStoredTerminal(
        previousRoot.turnId,
        transcript,
      );
      if (!stored.some(isTerminalSessionEvent)) {
        const recorded = recordedTurns.get(previousRoot.turnId);
        if (recorded) stored.push(...projector.seedRecordedTerminal(recorded));
      }
      if (!stored.some(isTerminalSessionEvent)) {
        throw new RuntimeHostSubscriptionError(
          "projection_revision_invalid",
          `Runtime Host replacement omitted the terminal record for Turn ${previousRoot.turnId}`,
        );
      }
      terminalEvents.push(...stored);
    } else if (isTerminalTurn(root)) {
      terminalEvents.push(...seedEvents.splice(0), ...projector.seedTerminal(root));
    }
  }
  if (
    root &&
    isTerminalTurn(root) &&
    (!previousRoot || previousRoot.runId !== root.runId)
  ) {
    terminalEvents.push(...seedEvents.splice(0), ...projector.seedTerminal(root));
  }
  return {
    terminalEvents,
    activeEvents: seedEvents,
    terminalTurnIds: new Set(
      terminalEvents.filter(isTerminalSessionEvent).map((event) => event.turnId),
    ),
  };
}

function hasStoredTerminal(messages: readonly StoredMessage[]): boolean {
  return messages.some(
    (message) =>
      message.type === 'turn_state' &&
      message.status !== 'running',
  );
}

function isTerminalSessionEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "complete" | "error" | "abort" }> {
  return (
    event.type === "complete" ||
    event.type === "error" ||
    event.type === "abort"
  );
}

function samePendingInteractions(
  previous: SessionContinuitySnapshot,
  next: SessionContinuitySnapshot,
): boolean {
  if (previous.interactions.pending.length !== next.interactions.pending.length) {
    return false;
  }
  const revisions = new Map(
    previous.interactions.pending.map((interaction) => [
      interaction.interactionId,
      interaction.revision,
    ]),
  );
  return next.interactions.pending.every(
    (interaction) =>
      revisions.get(interaction.interactionId) === interaction.revision,
  );
}

function subscriptionFailureIdentity(
  state: ObservedSessionState,
  error: unknown,
): SubscriptionFailureIdentity {
  const root = state.snapshot?.rootTurn;
  return {
    sessionId: state.sessionId,
    ...(root ? { turnId: root.turnId, runId: root.runId } : {}),
    reason:
      error instanceof RuntimeHostSubscriptionError
        ? error.reason
        : "subscription_closed",
    message:
      error instanceof Error
        ? error.message
        : "Runtime Host Session subscription closed",
  };
}
