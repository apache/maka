import type {
  ActiveInteractionRequestEvent,
  SessionChangedReason,
  SessionEvent,
  StoredMessage,
} from "@maka/core";
import type { AgentGraphClientChangedEvent } from "@maka/runtime";
import type {
  InteractionAnsweredSnapshot,
  InteractionPendingSnapshot,
  SessionMessageQueueProjection,
  SessionDomainChange,
  SessionContinuitySnapshot,
  SteeringMessageSnapshot,
  SubscriptionFrame,
  TurnSnapshot,
} from "@maka/runtime-host/protocol";
import type {
  DesktopRuntimeHostClient,
  DesktopRuntimeHostSession,
} from "./runtime-host-client.js";
import { foldRuntimeHostAssistantDelta } from "./runtime-host-assistant-delta.js";

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
  emitAgentGraphChanged?: (event: AgentGraphClientChangedEvent) => void;
  onWatchedTurnFinished?: (
    sessionId: string,
    outcome: "completed" | "abandoned",
  ) => void | Promise<void>;
  now?: () => number;
}

interface AssistantAccumulator {
  kind: "text" | "thinking";
  turnId: string;
  messageId: string;
  text: string;
}

interface ObserverTargetGroup {
  readonly target: RuntimeHostSessionObserverTarget;
  readonly observerIds: Set<string>;
  readonly destroyedListener: () => void;
  seeded: boolean;
}

type TerminalTurnSnapshot = Extract<
  TurnSnapshot,
  { status: "completed" } | { status: "failed" } | { status: "cancelled" }
>;

interface ObservedSessionState {
  readonly sessionId: string;
  readonly targets: Map<number, ObserverTargetGroup>;
  readonly pendingFrames: SubscriptionFrame[];
  readonly accumulators: Map<string, AssistantAccumulator>;
  readonly watchedTurnIds: Set<string>;
  openTask: Promise<void>;
  handle?: DesktopRuntimeHostSession;
  transcript?: StoredMessage[];
  transcriptConsumed: boolean;
  snapshot?: SessionContinuitySnapshot;
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
          projectInteractionRequest(interaction, this.#now()),
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
      projectInteractionRequest(interaction, this.#now()),
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
      accumulators: new Map(),
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
      this.#seedAccumulators(state);
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

  #seedAccumulators(state: ObservedSessionState): void {
    const root = state.snapshot?.rootTurn;
    if (!root || isTerminalTurn(root)) return;
    for (const message of state.transcript ?? []) {
      if (message.type !== "assistant" || message.turnId !== root.turnId)
        continue;
      if (message.thinking?.text) {
        state.accumulators.set(accumulatorKey("thinking", message.id), {
          kind: "thinking",
          turnId: root.turnId,
          messageId: message.id,
          text: message.thinking.text,
        });
      }
      if (message.text) {
        state.accumulators.set(accumulatorKey("text", message.id), {
          kind: "text",
          turnId: root.turnId,
          messageId: message.id,
          text: message.text,
        });
      }
    }
  }

  #seedTarget(state: ObservedSessionState, group: ObserverTargetGroup): void {
    if (group.seeded) return;
    group.seeded = true;
    const snapshot = state.snapshot;
    const root = snapshot?.rootTurn;
    if (snapshot && root && !isTerminalTurn(root)) {
      for (const accumulator of state.accumulators.values()) {
        this.#send(state, group, {
          type: accumulator.kind === "text" ? "text_delta" : "thinking_delta",
          id: `host-seed:${root.runId}:${accumulator.kind}:${accumulator.messageId}`,
          turnId: accumulator.turnId,
          messageId: accumulator.messageId,
          ts: this.#now(),
          text: accumulator.text,
        });
      }
      for (const interaction of snapshot.interactions.pending) {
        for (const event of projectInteractionRequest(
          interaction,
          this.#now(),
        )) {
          this.#send(state, group, event);
        }
      }
      for (const entry of rootQueueInFlight(snapshot.queue)) {
        if (state.transcript?.some((message) => message.id === entry.messageId))
          continue;
        this.#send(state, group, {
          type: "steering_message",
          id: `host-queue:${snapshot.queue.hostEpoch}:${snapshot.queue.queueRevision}:${entry.entryId}`,
          turnId: root.turnId,
          messageId: entry.messageId,
          ts: this.#now(),
          content: structuredClone(entry.content),
        });
      }
      if (queueHasEntries(snapshot.queue)) {
        this.#send(
          state,
          group,
          projectQueueUpdate(snapshot.queue, root.turnId, this.#now()),
        );
      }
    }
  }

  #acceptFrame(state: ObservedSessionState, frame: SubscriptionFrame): void {
    if (frame.kind === "subscription.session_delta") {
      const delta = frame.delta;
      const key = accumulatorKey(delta.kind, delta.messageId);
      const current = state.accumulators.get(key);
      const previousText = current?.text ?? "";
      const folded = foldRuntimeHostAssistantDelta(previousText, delta);
      state.accumulators.set(key, {
        kind: delta.kind,
        turnId: delta.turnId,
        messageId: delta.messageId,
        text: folded.text,
      });
      if (folded.tail.length > 0) {
        this.#broadcast(state.sessionId, {
          type: delta.kind === "text" ? "text_delta" : "thinking_delta",
          id: frameIdentity(frame),
          turnId: delta.turnId,
          messageId: delta.messageId,
          ts: this.#now(),
          text: folded.tail,
        });
      }
      return;
    }
    if (frame.kind === "subscription.session_event") {
      const event = projectToolEvent(frame);
      if (event) {
        this.#broadcast(state.sessionId, event);
        if (event.type === "tool_result") {
          this.#emitSessionsChanged("message-appended", state.sessionId, {
            turnId: event.turnId,
          });
        }
      }
      return;
    }
    if (frame.kind === "subscription.session_projection") {
      this.#acceptProjection(state, frame.snapshot);
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
  }

  #acceptProjection(
    state: ObservedSessionState,
    snapshot: SessionContinuitySnapshot,
  ): void {
    const previous = state.snapshot;
    state.snapshot = structuredClone(snapshot);
    if (!sameGoal(previous?.goal, snapshot.goal)) {
      this.#emitSessionsChanged("goal-change", state.sessionId);
    }
    for (const interaction of newlyPendingInteractions(previous, snapshot)) {
      for (const event of projectInteractionRequest(interaction, this.#now())) {
        this.#broadcast(state.sessionId, event);
      }
    }
    const previousRoot = previous?.rootTurn;
    const root = snapshot.rootTurn;
    if (root && queueChanged(previous?.queue, snapshot.queue)) {
      for (const entry of newlyInFlight(previous?.queue, snapshot.queue)) {
        this.#broadcast(state.sessionId, {
          type: "steering_message",
          id: `host-queue:${snapshot.queue.hostEpoch}:${snapshot.queue.queueRevision}:${entry.entryId}`,
          turnId: root.turnId,
          messageId: entry.messageId,
          ts: this.#now(),
          content: structuredClone(entry.content),
        });
      }
      this.#broadcast(
        state.sessionId,
        projectQueueUpdate(snapshot.queue, root.turnId, this.#now()),
      );
    }
    if (root && (!previousRoot || previousRoot.runId !== root.runId)) {
      state.accumulators.clear();
      this.#emitSessionsChanged("status-change", state.sessionId, {
        turnId: root.turnId,
      });
    }
    if (root && isTerminalTurn(root) && !sameTerminalTurn(previousRoot, root)) {
      this.#publishTerminal(state, root);
      this.#finishWatchedTurn(state, root.turnId, "completed");
      void this.#closeIfIdle(state);
      this.#emitSessionsChanged("turn-status-change", state.sessionId, {
        turnId: root.turnId,
      });
      this.#emitSessionsChanged("message-appended", state.sessionId, {
        turnId: root.turnId,
      });
    } else {
      this.#emitSessionsChanged(
        "status-change",
        state.sessionId,
        root ? { turnId: root.turnId } : undefined,
      );
    }
  }

  #publishTerminal(
    state: ObservedSessionState,
    root: TerminalTurnSnapshot,
  ): void {
    for (const accumulator of state.accumulators.values()) {
      this.#broadcast(state.sessionId, {
        type:
          accumulator.kind === "text" ? "text_complete" : "thinking_complete",
        id: `${root.terminalEventId}:${accumulator.kind}:${accumulator.messageId}`,
        turnId: root.turnId,
        messageId: accumulator.messageId,
        ts: this.#now(),
        text: accumulator.text,
      });
    }
    if (root.status === "completed") {
      this.#broadcast(state.sessionId, {
        type: "complete",
        id: root.terminalEventId,
        turnId: root.turnId,
        ts: this.#now(),
        stopReason: "end_turn",
      });
    } else if (root.status === "failed") {
      this.#broadcast(state.sessionId, {
        type: "error",
        id: root.terminalEventId,
        turnId: root.turnId,
        ts: this.#now(),
        recoverable: false,
        reason: root.failureClass,
        message: `Turn failed: ${root.failureClass}`,
      });
    } else {
      this.#broadcast(state.sessionId, {
        type: "abort",
        id: root.terminalEventId,
        turnId: root.turnId,
        ts: this.#now(),
        reason: abortReason(root.abortSource),
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

function projectInteractionRequest(
  interaction: InteractionPendingSnapshot,
  now: number,
): ActiveInteractionRequestEvent[] {
  const base = {
    id: `host-interaction:${interaction.interactionId}:${interaction.revision}`,
    turnId: interaction.turnId,
    ts: now,
    requestId: interaction.interactionId,
    toolUseId: interactionToolUseId(interaction),
  };
  if (interaction.request.kind === "question") {
    return [
      {
        type: "user_question_request",
        ...base,
        questions: interaction.request.questions.map((question) => ({
          question: question.question,
          options: question.options.map((option) => ({ ...option })),
        })),
      },
    ];
  }
  if (interaction.request.kind === "sandbox_boundary") {
    return [
      {
        type: "sandbox_boundary_request",
        ...base,
        justification: interaction.request.justification,
        expansion: interaction.request.expansion,
      },
    ];
  }
  return [];
}

function projectToolEvent(
  frame: Extract<SubscriptionFrame, { kind: "subscription.session_event" }>,
): SessionEvent | undefined {
  const event = frame.event;
  const base = {
    id: event.id,
    turnId: event.turnId,
    ts: event.ts,
    toolUseId: event.toolUseId,
  };
  if (event.type === "tool_start") {
    return {
      type: event.type,
      ...base,
      toolName: event.toolName,
      args: undefined,
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...(event.activityKind ? { activityKind: event.activityKind } : {}),
      ...(event.displayName ? { displayName: event.displayName } : {}),
      ...(event.stepId ? { stepId: event.stepId } : {}),
    };
  }
  if (event.type === "tool_output_delta") {
    return {
      type: event.type,
      ...base,
      sessionId: frame.sessionId,
      toolCallId: event.toolUseId,
      seq: event.seq,
      stream: event.stream,
      chunk: event.chunk,
      redacted: event.redacted,
      createdAt: event.createdAt,
    };
  }
  if (event.type === "tool_progress")
    return { type: event.type, ...base, chunk: event.chunk };
  return {
    type: "tool_result",
    ...base,
    isError: event.status === "errored",
    content: { kind: "text", text: "" },
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
  };
}

function newlyPendingInteractions(
  previous: SessionContinuitySnapshot | undefined,
  next: SessionContinuitySnapshot,
): InteractionPendingSnapshot[] {
  const previousIds = new Set(
    previous?.interactions.pending.map(
      (interaction) => interaction.interactionId,
    ) ?? [],
  );
  return next.interactions.pending.filter(
    (interaction) => !previousIds.has(interaction.interactionId),
  );
}

function queueChanged(
  previous: SessionMessageQueueProjection | undefined,
  next: SessionMessageQueueProjection,
): boolean {
  return (
    previous === undefined ||
    previous.hostEpoch !== next.hostEpoch ||
    previous.queueRevision !== next.queueRevision
  );
}

function newlyInFlight(
  previous: SessionMessageQueueProjection | undefined,
  next: SessionMessageQueueProjection,
): Extract<SteeringMessageSnapshot, { state: "in_flight" }>[] {
  const previousInFlight = new Set(
    previous?.steering
      .filter((entry) => entry.state === "in_flight")
      .map((entry) => entry.entryId) ?? [],
  );
  return rootQueueInFlight(next).filter(
    (entry) => !previousInFlight.has(entry.entryId),
  );
}

function rootQueueInFlight(
  queue: SessionMessageQueueProjection | undefined,
): Extract<SteeringMessageSnapshot, { state: "in_flight" }>[] {
  return (queue?.steering ?? []).filter(
    (
      entry,
    ): entry is Extract<SteeringMessageSnapshot, { state: "in_flight" }> =>
      entry.state === "in_flight",
  );
}

function queueHasEntries(
  queue: SessionMessageQueueProjection | undefined,
): boolean {
  return (queue?.steering.length ?? 0) > 0 || (queue?.followup.length ?? 0) > 0;
}

function projectQueueUpdate(
  queue: SessionMessageQueueProjection,
  turnId: string,
  now: number,
): Extract<SessionEvent, { type: "queue_update" }> {
  return {
    type: "queue_update",
    id: `host-queue:${queue.hostEpoch}:${queue.queueRevision}`,
    turnId,
    ts: now,
    steering: queue.steering.map((entry) => entry.content.text),
    followup: queue.followup.map((entry) => entry.content.text),
  };
}

function interactionToolUseId(interaction: InteractionPendingSnapshot): string {
  return interaction.request.kind === "sandbox_boundary"
    ? interaction.interactionId
    : interaction.request.toolUseId;
}

function accumulatorKey(kind: "text" | "thinking", messageId: string): string {
  return `${kind}\0${messageId}`;
}

function frameIdentity(frame: SubscriptionFrame): string {
  return `host-frame:${frame.hostEpoch}:${frame.subscriptionId}:${frame.sequence}`;
}

function sessionEventChannel(sessionId: string): string {
  return `sessions:event:${sessionId}`;
}

function isTerminalTurn(turn: TurnSnapshot): turn is TerminalTurnSnapshot {
  return (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "cancelled"
  );
}

function sameTerminalTurn(
  previous: TurnSnapshot | null | undefined,
  next: TurnSnapshot,
): boolean {
  return (
    previous !== null &&
    previous !== undefined &&
    isTerminalTurn(previous) &&
    isTerminalTurn(next) &&
    previous.runId === next.runId &&
    previous.terminalEventId === next.terminalEventId
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

function abortReason(
  source: string,
): Extract<SessionEvent, { type: "abort" }>["reason"] {
  if (source.includes("timeout")) return "timeout";
  if (source.includes("crash") || source.includes("restart")) return "crash";
  if (source.includes("redirect")) return "redirect";
  return "user_stop";
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
