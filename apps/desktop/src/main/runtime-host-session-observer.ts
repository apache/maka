import type {
  ActiveInteractionRequestEvent,
  SessionChangedReason,
  SessionEvent,
  StoredMessage,
} from "@maka/core";
import type {
  AgentGraphClientChangedEvent,
  ShellRunPtyDataEvent,
} from "@maka/runtime";
import {
  RuntimeHostSessionProjector,
  isRuntimeHostTerminalTurn as isTerminalTurn,
  projectRuntimeHostInteractionRequest,
} from "@maka/runtime-host/adapter";
import type {
  InteractionAnsweredSnapshot,
  InteractionPendingSnapshot,
  SessionDomainChange,
  SessionContinuitySnapshot,
  SubscriptionFrame,
} from "@maka/runtime-host/protocol";
import type {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostSession,
} from "./runtime-host-client.js";
import { RuntimeHostSubscriptionError } from "@maka/runtime-host/client";

const MAX_PENDING_FRAMES = 512;

type SessionObserverClient = Pick<DesktopRuntimeHostClient, "openSession">;

export interface RuntimeHostSessionObserverTarget {
  readonly id: number;
  send(channel: string, event: SessionEvent): void;
  once(event: "destroyed", listener: () => void): void;
  off(event: "destroyed", listener: () => void): void;
}

export interface RuntimeHostSessionObserverDeps {
  client: SessionObserverClient;
  emitSessionsChanged: (
    reason: SessionChangedReason,
    sessionId: string,
    extra?: { turnId?: string },
  ) => void;
  emitSessionDomainChanged?: (change: SessionDomainChange) => void;
  emitRuntimeResourcePtyData?: (event: ShellRunPtyDataEvent) => void;
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
  seeded: boolean;
}

interface ObservedSessionState {
  readonly sessionId: string;
  readonly targets: Map<number, ObserverTargetGroup>;
  readonly watchedTurnIds: Set<string>;
  openTask: Promise<void>;
  handle?: DesktopRuntimeHostSession;
  attempt?: SessionSubscriptionAttempt;
  transcript?: StoredMessage[];
  transcriptConsumed: boolean;
  snapshot?: SessionContinuitySnapshot;
  projector?: RuntimeHostSessionProjector;
  closing: boolean;
}

interface ObserverRegistration {
  readonly state: ObservedSessionState;
  readonly group: ObserverTargetGroup;
}

interface SubscriptionFailureIdentity {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly runId?: string;
  readonly reason: string;
  readonly message: string;
}

interface SessionSubscriptionAttempt {
  readonly handle: DesktopRuntimeHostSession;
  readonly pendingFrames: SubscriptionFrame[];
  readonly failed: Promise<Error>;
  fail(error: Error): void;
  failure?: Error;
  committed: boolean;
}

interface AcquiredSessionSubscription {
  readonly attempt: SessionSubscriptionAttempt;
  readonly snapshot: SessionContinuitySnapshot;
  readonly transcript: StoredMessage[];
}

class SessionRemovedSubscriptionError extends Error {
  readonly name = "SessionRemovedSubscriptionError";
}

/**
 * Owns the Desktop-side lifetime of Host Session subscriptions.
 *
 * The initial transcript and the following frames come from one atomic Host
 * subscription. The observer seeds the live projection from the active
 * transcript, then applies offset-bearing deltas, so joining mid-Turn neither
 * loses the already-generated prefix nor renders it twice.
 */
export class RuntimeHostSessionObserver {
  readonly #states = new Map<string, ObservedSessionState>();
  readonly #observers = new Map<string, ObserverRegistration>();
  readonly #transcriptRefreshes = new Map<string, Promise<StoredMessage[]>>();
  readonly #client: SessionObserverClient;
  readonly #emitSessionsChanged: RuntimeHostSessionObserverDeps["emitSessionsChanged"];
  readonly #emitSessionDomainChanged: (change: SessionDomainChange) => void;
  readonly #emitRuntimeResourcePtyData: (event: ShellRunPtyDataEvent) => void;
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

  constructor(deps: RuntimeHostSessionObserverDeps) {
    this.#client = deps.client;
    this.#emitSessionsChanged = deps.emitSessionsChanged;
    this.#emitSessionDomainChanged =
      deps.emitSessionDomainChanged ?? (() => undefined);
    this.#emitRuntimeResourcePtyData =
      deps.emitRuntimeResourcePtyData ?? (() => undefined);
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

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    this.#assertOpen();
    const existing = this.#states.get(sessionId);
    if (existing) {
      await existing.openTask;
      if (!existing.transcriptConsumed) {
        existing.transcriptConsumed = true;
        return cloneMessages(existing.transcript ?? []);
      }
    }
    if (!existing) {
      const state = this.#state(sessionId);
      await state.openTask;
      state.transcriptConsumed = true;
      const transcript = cloneMessages(state.transcript ?? []);
      void this.#closeIfIdle(state);
      return transcript;
    }
    return this.#loadCurrentTranscript(sessionId);
  }

  async snapshot(sessionId: string): Promise<SessionContinuitySnapshot> {
    this.#assertOpen();
    const existing = this.#states.get(sessionId);
    if (existing) {
      await existing.openTask;
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
      return;
    }
    const state = this.#state(sessionId);
    let group = state.targets.get(target.id);
    if (!group) {
      const destroyedListener = () => {
        void this.#removeTarget(state, target.id);
      };
      group = {
        target,
        observerIds: new Set(),
        destroyedListener,
        seeded: false,
      };
      state.targets.set(target.id, group);
      target.once("destroyed", destroyedListener);
    }
    group.observerIds.add(observerId);
    this.#observers.set(observerId, { state, group });
    try {
      await state.openTask;
      this.#seedTarget(state, group);
    } catch (error) {
      this.#detachObserver(observerId);
      throw error;
    }
  }

  async unobserve(observerId: string): Promise<void> {
    const state = this.#detachObserver(observerId);
    if (state) await this.#closeIfIdle(state);
  }

  async watchTurn(sessionId: string, turnId: string): Promise<void> {
    this.#assertOpen();
    const state = this.#state(sessionId);
    state.watchedTurnIds.add(turnId);
    await state.openTask;
    const root = state.snapshot?.rootTurn;
    if (root && root.turnId === turnId && isTerminalTurn(root)) {
      this.#finishWatchedTurn(state, turnId, "completed");
      void this.#closeIfIdle(state);
    }
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
    } else if (answered.outcome.kind === "sandbox_boundary_decision") {
      this.#broadcast(answered.sessionId, {
        type: "sandbox_boundary_decision_ack",
        ...base,
        decision: answered.outcome.decision,
        status: answered.outcome.status,
        revision: answered.revision,
      });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const states = [...this.#states.values()];
    this.#states.clear();
    this.#observers.clear();
    await Promise.all(states.map((state) => this.#closeState(state)));
  }

  #state(sessionId: string): ObservedSessionState {
    const existing = this.#states.get(sessionId);
    if (existing) return existing;
    const state: ObservedSessionState = {
      sessionId,
      targets: new Map(),
      watchedTurnIds: new Set(),
      openTask: Promise.resolve(),
      transcriptConsumed: false,
      closing: false,
    };
    this.#states.set(sessionId, state);
    state.openTask = this.#open(state);
    return state;
  }

  async #open(state: ObservedSessionState): Promise<void> {
    try {
      await this.#establishSubscription(state);
    } catch (error) {
      if (error instanceof SessionRemovedSubscriptionError) {
        this.#emitSessionsChanged("deleted", state.sessionId);
      }
      await this.#closeState(state);
      throw error;
    }
  }

  async #acquireSubscription(
    state: ObservedSessionState,
  ): Promise<AcquiredSessionSubscription> {
    const handle = await this.#client.openSession(state.sessionId);
    if (state.closing) {
      await handle.close();
      throw new Error("Runtime Host Session observer closed while opening");
    }
    let fail!: (error: Error) => void;
    const failed = new Promise<Error>((resolve) => {
      fail = resolve;
    });
    const attempt: SessionSubscriptionAttempt = {
      handle,
      pendingFrames: [],
      failed,
      fail(error) {
        if (attempt.failure) return;
        attempt.failure = error;
        fail(error);
      },
      committed: false,
    };
    state.attempt = attempt;
    void this.#pump(state, attempt);
    try {
      const loaded = await Promise.race([
        handle.transcript.then(
          (transcript) => ({ kind: "transcript" as const, transcript }),
          (error: unknown) => ({ kind: "failure" as const, error: asError(error) }),
        ),
        failed.then((error) => ({ kind: "failure" as const, error })),
      ]);
      if (loaded.kind === "failure") throw loaded.error;
      if (attempt.failure) throw attempt.failure;
      if (state.closing || state.attempt !== attempt) {
        throw new Error("Runtime Host Session observer closed while opening");
      }
      validatePendingFrames(handle.snapshot, loaded.transcript, attempt.pendingFrames, this.#now);
      return {
        attempt,
        snapshot: structuredClone(handle.snapshot),
        transcript: loaded.transcript,
      };
    } catch (error) {
      if (state.attempt === attempt) state.attempt = undefined;
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async #pump(
    state: ObservedSessionState,
    attempt: SessionSubscriptionAttempt,
  ): Promise<void> {
    const { handle } = attempt;
    try {
      for await (const frame of handle.events) {
        if (state.closing) return;
        if (frame.kind === "subscription.closed") {
          throw subscriptionClosedError(frame.reason);
        }
        if (!attempt.committed) {
          if (attempt.pendingFrames.length >= MAX_PENDING_FRAMES) {
            throw new RuntimeHostSubscriptionError(
              "slow_consumer",
              "Runtime Host Session transcript could not keep up with live events",
            );
          }
          attempt.pendingFrames.push(frame);
        } else {
          this.#acceptFrame(state, frame);
        }
      }
      if (!state.closing)
        throw new Error("Runtime Host Session subscription ended unexpectedly");
    } catch (error) {
      if (state.closing) return;
      const failure = asError(error);
      if (!attempt.committed) {
        attempt.fail(failure);
        return;
      }
      if (state.handle !== handle) return;
      if (
        isRecoverableSubscriptionFailure(failure)
      ) {
        this.#recoverSubscription(state, handle, failure);
        return;
      }
      this.#handleTerminalSubscriptionFailure(state, failure);
    }
  }

  #seedTarget(state: ObservedSessionState, group: ObserverTargetGroup): void {
    if (group.seeded) return;
    group.seeded = true;
    for (const event of state.projector?.seedActive(true) ?? []) {
      this.#send(state, group, event);
    }
  }

  #acceptFrame(state: ObservedSessionState, frame: SubscriptionFrame): void {
    if (frame.kind === "subscription.runtime_resource_pty_data") {
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

  #broadcast(sessionId: string, event: SessionEvent): void {
    const state = this.#states.get(sessionId);
    if (!state) return;
    for (const group of state.targets.values()) {
      this.#send(state, group, event);
    }
  }

  #send(
    state: ObservedSessionState,
    group: ObserverTargetGroup,
    event: SessionEvent,
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
    error: unknown,
  ): void {
    const root = state.snapshot?.rootTurn;
    const reason =
      error instanceof RuntimeHostSubscriptionError
        ? error.reason
        : "subscription_closed";
    if (root && !isTerminalTurn(root)) {
      this.#broadcast(state.sessionId, {
        type: "error",
        id: `host-subscription-error:${root.runId}`,
        turnId: root.turnId,
        ts: this.#now(),
        recoverable: true,
        reason,
        message:
          error instanceof Error
            ? error.message
            : "Runtime Host Session subscription closed",
      });
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

  #recoverSubscription(
    state: ObservedSessionState,
    handle: DesktopRuntimeHostSession,
    error: unknown,
  ): void {
    const identity = subscriptionFailureIdentity(state, error);
    console.warn("[runtime-host-session-observer] recovering subscription", identity);
    const recovery = this.#establishSubscription(state, handle, error);
    state.openTask = recovery;
    void recovery.catch((recoveryError: unknown) => {
      if (state.closing || this.#states.get(state.sessionId) !== state) return;
      const recovered = subscriptionFailureIdentity(state, recoveryError);
      console.error(
        "[runtime-host-session-observer] subscription recovery failed",
        { failure: identity, recovery: recovered },
      );
      this.#handleTerminalSubscriptionFailure(state, asError(recoveryError));
    });
  }

  async #establishSubscription(
    state: ObservedSessionState,
    failed?: DesktopRuntimeHostSession,
    initialFailure?: unknown,
  ): Promise<void> {
    let failure =
      initialFailure === undefined
        ? undefined
        : subscriptionFailureIdentity(state, initialFailure);
    if (failed) await failed.close().catch(() => undefined);
    while (true) {
      if (state.closing || this.#states.get(state.sessionId) !== state) {
        throw new Error("Runtime Host Session observer closed while opening");
      }
      let acquired: AcquiredSessionSubscription;
      try {
        acquired = await this.#acquireSubscription(state);
      } catch (error) {
        if (isRecoverableSubscriptionFailure(error)) {
          failure ??= subscriptionFailureIdentity(state, error);
          continue;
        }
        throw error;
      }
      try {
        this.#commitSubscription(state, acquired, failure !== undefined);
      } catch (error) {
        if (state.attempt === acquired.attempt) state.attempt = undefined;
        await acquired.attempt.handle.close().catch(() => undefined);
        if (isRecoverableSubscriptionFailure(error)) {
          failure ??= subscriptionFailureIdentity(state, error);
          continue;
        }
        throw error;
      }
      if (failure) {
        console.info("[runtime-host-session-observer] subscription recovered", failure);
      }
      return;
    }
  }

  #commitSubscription(
    state: ObservedSessionState,
    acquired: AcquiredSessionSubscription,
    recovered: boolean,
  ): void {
    if (
      state.closing ||
      this.#states.get(state.sessionId) !== state ||
      state.attempt !== acquired.attempt
    ) {
      throw new Error("Runtime Host Session observer closed before commit");
    }
    if (acquired.attempt.failure) throw acquired.attempt.failure;
    const previousSnapshot = state.snapshot;
    const projector = new RuntimeHostSessionProjector(
      acquired.snapshot,
      acquired.transcript,
      this.#now,
    );
    const replacement =
      previousSnapshot
        ? replacementProjection(
            previousSnapshot,
            projector,
            acquired.transcript,
          )
        : undefined;

    state.attempt = undefined;
    state.handle = acquired.attempt.handle;
    state.snapshot = structuredClone(acquired.snapshot);
    state.transcript = acquired.transcript;
    state.transcriptConsumed = false;
    state.projector = projector;
    acquired.attempt.committed = true;

    if (replacement) {
      for (const event of replacement.terminalEvents) {
        this.#broadcast(state.sessionId, event);
      }
      for (const event of replacement.activeEvents) {
        this.#broadcast(state.sessionId, event);
      }
      for (const group of state.targets.values()) group.seeded = true;
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

    this.#finishPersistedWatchedTurns(state, projector, acquired.transcript);

    if (recovered) this.#emitSubscriptionRecovered(state.sessionId);

    for (const frame of acquired.attempt.pendingFrames.splice(0)) {
      this.#acceptFrame(state, frame);
    }
    void this.#closeIfIdle(state);
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
    transcript: readonly StoredMessage[],
  ): void {
    for (const turnId of [...state.watchedTurnIds]) {
      if (projector.seedStoredTerminal(turnId, transcript).length > 0) {
        this.#finishWatchedTurn(state, turnId, "completed");
      }
    }
  }

  async #loadCurrentTranscript(sessionId: string): Promise<StoredMessage[]> {
    let refresh = this.#transcriptRefreshes.get(sessionId);
    if (!refresh) {
      refresh = this.#readCurrentTranscript(sessionId);
      this.#transcriptRefreshes.set(sessionId, refresh);
      const release = () => {
        if (this.#transcriptRefreshes.get(sessionId) === refresh) {
          this.#transcriptRefreshes.delete(sessionId);
        }
      };
      void refresh.then(release, release);
    }
    return refresh.then(cloneMessages);
  }

  async #readCurrentTranscript(sessionId: string): Promise<StoredMessage[]> {
    const handle = await this.#client.openSession(sessionId);
    void drainFrames(handle.events).catch(() => undefined);
    try {
      return await handle.transcript;
    } finally {
      await handle.close();
    }
  }

  async #closeIfIdle(state: ObservedSessionState): Promise<void> {
    if (state.targets.size > 0 || state.watchedTurnIds.size > 0) return;
    await Promise.resolve();
    if (state.targets.size === 0 && state.watchedTurnIds.size === 0) {
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
    }
    const handle = state.handle;
    const attempt = state.attempt;
    state.handle = undefined;
    state.attempt = undefined;
    await Promise.all([
      handle?.close().catch(() => undefined),
      attempt && attempt.handle !== handle
        ? attempt.handle.close().catch(() => undefined)
        : undefined,
    ]);
  }

  async #removeTarget(
    state: ObservedSessionState,
    targetId: number,
  ): Promise<void> {
    const group = state.targets.get(targetId);
    if (!group) return;
    this.#detachTarget(state, group);
    await this.#closeIfIdle(state);
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
}

function interactionToolUseId(interaction: InteractionPendingSnapshot): string {
  return interaction.request.kind === "sandbox_boundary"
    ? interaction.interactionId
    : interaction.request.toolUseId;
}

function sessionEventChannel(sessionId: string): string {
  return `sessions:event:${sessionId}`;
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

function cloneMessages(messages: readonly StoredMessage[]): StoredMessage[] {
  return messages.map((message) => structuredClone(message));
}

async function drainFrames(
  frames: AsyncIterable<SubscriptionFrame>,
): Promise<void> {
  for await (const _frame of frames) {
    // A one-shot transcript read still owns a live Host subscription until it
    // closes. Drain bounded frames so transcript pagination cannot be evicted
    // as a slow consumer.
  }
}

function validatePendingFrames(
  snapshot: SessionContinuitySnapshot,
  transcript: readonly StoredMessage[],
  frames: readonly SubscriptionFrame[],
  now: () => number,
): void {
  const projector = new RuntimeHostSessionProjector(snapshot, transcript, now);
  for (const frame of frames) {
    projector.accept(frame);
  }
}

function replacementProjection(
  previous: SessionContinuitySnapshot,
  projector: RuntimeHostSessionProjector,
  transcript: readonly StoredMessage[],
): {
  terminalEvents: SessionEvent[];
  activeEvents: SessionEvent[];
  terminalTurnIds: Set<string>;
} {
  const next = projector.snapshot;
  const previousRoot = previous.rootTurn;
  const root = next.rootTurn;
  const terminalEvents: SessionEvent[] = [];
  if (previousRoot && !isTerminalTurn(previousRoot)) {
    if (!root || root.runId !== previousRoot.runId) {
      const stored = projector.seedStoredTerminal(
        previousRoot.turnId,
        transcript,
      );
      if (!stored.some(isTerminalSessionEvent)) {
        throw new RuntimeHostSubscriptionError(
          "projection_revision_invalid",
          `Runtime Host replacement omitted the terminal record for Turn ${previousRoot.turnId}`,
        );
      }
      terminalEvents.push(...stored);
    } else if (isTerminalTurn(root)) {
      terminalEvents.push(...projector.seedTerminal(root));
    }
  }
  if (
    root &&
    isTerminalTurn(root) &&
    (!previousRoot || previousRoot.runId !== root.runId)
  ) {
    terminalEvents.push(...projector.seedTerminal(root));
  }
  return {
    terminalEvents,
    activeEvents:
      root && !isTerminalTurn(root) ? projector.seedActive(true) : [],
    terminalTurnIds: new Set(
      terminalEvents.filter(isTerminalSessionEvent).map((event) => event.turnId),
    ),
  };
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

function subscriptionClosedError(
  reason: "slow_consumer" | "session_removed",
): Error {
  return reason === "session_removed"
    ? new SessionRemovedSubscriptionError(
        "Runtime Host Session was removed while it was observed",
      )
    : new RuntimeHostSubscriptionError(
        "slow_consumer",
        "Runtime Host Session subscription closed for a slow consumer",
      );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecoverableSubscriptionFailure(error: unknown): boolean {
  if (!(error instanceof RuntimeHostSubscriptionError)) return false;
  return (
    error.reason === "slow_consumer" ||
    error.reason === "sequence_gap" ||
    error.reason === "projection_revision_invalid" ||
    error.reason === "transcript_expired"
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
