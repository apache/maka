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
  readonly pendingFrames: SubscriptionFrame[];
  readonly watchedTurnIds: Set<string>;
  openTask: Promise<void>;
  handle?: DesktopRuntimeHostSession;
  transcript?: StoredMessage[];
  transcriptConsumed: boolean;
  snapshot?: SessionContinuitySnapshot;
  projector?: RuntimeHostSessionProjector;
  ready: boolean;
  closing: boolean;
}

interface ObserverRegistration {
  readonly state: ObservedSessionState;
  readonly group: ObserverTargetGroup;
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
    this.#now = deps.now ?? Date.now;
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    this.#assertOpen();
    const existing = this.#states.get(sessionId);
    if (existing && !existing.transcriptConsumed) {
      await existing.openTask;
      existing.transcriptConsumed = true;
      return cloneMessages(existing.transcript ?? []);
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
      pendingFrames: [],
      watchedTurnIds: new Set(),
      openTask: Promise.resolve(),
      transcriptConsumed: false,
      ready: false,
      closing: false,
    };
    state.openTask = this.#open(state);
    this.#states.set(sessionId, state);
    return state;
  }

  async #open(state: ObservedSessionState): Promise<void> {
    try {
      const handle = await this.#client.openSession(state.sessionId);
      if (state.closing) {
        await handle.close();
        throw new Error("Runtime Host Session observer closed while opening");
      }
      state.handle = handle;
      state.snapshot = structuredClone(handle.snapshot);
      void this.#pump(state, handle);
      state.transcript = await handle.transcript;
      if (state.closing)
        throw new Error("Runtime Host Session observer closed while opening");
      state.projector = new RuntimeHostSessionProjector(
        handle.snapshot,
        state.transcript,
        this.#now,
      );
      state.ready = true;
      for (const group of state.targets.values())
        this.#seedTarget(state, group);
      for (const frame of state.pendingFrames.splice(0))
        this.#acceptFrame(state, frame);
    } catch (error) {
      await this.#closeState(state);
      throw error;
    }
  }

  async #pump(
    state: ObservedSessionState,
    handle: DesktopRuntimeHostSession,
  ): Promise<void> {
    try {
      for await (const frame of handle.events) {
        if (state.closing) return;
        if (!state.ready) {
          if (state.pendingFrames.length >= MAX_PENDING_FRAMES) {
            throw new Error(
              "Runtime Host Session initial transcript could not keep up with live events",
            );
          }
          state.pendingFrames.push(frame);
        } else {
          this.#acceptFrame(state, frame);
        }
      }
      if (!state.closing) {
        this.#publishSubscriptionFailure(
          state,
          new Error("Runtime Host Session subscription ended unexpectedly"),
        );
      }
    } catch (error) {
      if (!state.closing) this.#publishSubscriptionFailure(state, error);
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
    if (frame.kind === "subscription.closed") {
      if (frame.reason === "session_removed") {
        this.#emitSessionsChanged("deleted", state.sessionId);
        void this.#closeState(state);
      } else {
        this.#publishSubscriptionFailure(
          state,
          new Error(
            "Runtime Host Session subscription closed for a slow consumer",
          ),
        );
      }
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
    if (root && !isTerminalTurn(root)) {
      this.#broadcast(state.sessionId, {
        type: "error",
        id: `host-subscription-error:${root.runId}`,
        turnId: root.turnId,
        ts: this.#now(),
        recoverable: true,
        reason: "subscription_closed",
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
    state.handle = undefined;
    await handle?.close().catch(() => undefined);
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
