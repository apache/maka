import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SessionEvent } from '@maka/core/events';
import {
  encodeProtocolFrame,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_TOOL_NAME_MAX_BYTES,
  type SessionAssistantDelta,
  type SessionContinuitySnapshot,
  type SessionDeltaFrame,
  type SessionEventFrame,
  type SessionToolEvent,
  type SubscriptionFrame,
  type SubscriptionOpenResult,
  type TurnSnapshot,
} from '../protocol/index.js';
import type { SessionContinuityOperationHandlerMap } from './operation-dispatcher.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import {
  type CanonicalSessionProjection,
  createSessionContinuitySnapshot,
} from './canonical-session-projection.js';
import type {
  SessionContinuityConnection,
  SessionContinuityFrameSink,
  SessionContinuityService,
} from './session-continuity-service.js';

const MAX_CONNECTION_SUBSCRIPTIONS = 16;
const MAX_SUBSCRIBER_QUEUED_FRAMES = 32;
const MAX_SUBSCRIBER_QUEUED_BYTES = 256 * 1024;
const MAX_LIVE_REPLAY_ITEMS = 8;
const MAX_LIVE_REPLAY_RETAINED_BYTES = 96 * 1024;
const MAX_LIVE_REPLAY_ASSISTANT_BYTES = 64 * 1024;
const MAX_LIVE_REPLAY_ASSISTANT_WIRE_BYTES = 80 * 1024;

export type { CanonicalSessionProjection } from './canonical-session-projection.js';

export type RuntimeSessionTransientEvent = Extract<
  SessionEvent,
  {
    type:
      | 'text_delta'
      | 'thinking_delta'
      | 'tool_start'
      | 'tool_output_delta'
      | 'tool_progress'
      | 'tool_result';
  }
>;

export type ReadCanonicalSessionProjection = (
  sessionId: string,
) => Promise<CanonicalSessionProjection | null>;

interface SessionProjectionState {
  canonical: CanonicalSessionProjection;
  revision: number;
  subscribers: Map<string, Subscriber>;
  liveReplay?: LiveTurnReplay;
  terminalPublicationFence?: TerminalPublicationFence;
}

type LiveReplayItem =
  | {
      readonly kind: 'assistant_delta';
      readonly delta: Omit<SessionAssistantDelta, 'text'>;
      chunks: string[];
      textBytes: number;
      wireTextBytes: number;
    }
  | { readonly kind: 'tool_event'; readonly event: SessionToolEvent };

interface LiveTurnReplay {
  readonly turnId: string;
  readonly runId: string;
  items: LiveReplayItem[];
  retainedBytes: number;
}

interface TerminalPublicationFence {
  turnId: string;
  runId: string;
}

interface ConnectionState {
  sink: SessionContinuityFrameSink;
  subscriptionIds: Set<string>;
  pendingOpenCount: number;
}

interface QueuedSubscriptionFrame {
  frame: SubscriptionFrame;
  encodedBytes: number;
}

interface Subscriber {
  connectionId: string;
  sessionId: string;
  subscriptionId: string;
  sink: SessionContinuityFrameSink;
  phase: 'open' | 'closing' | 'closed';
  activated: boolean;
  nextSequence: number;
  lastFlushedSequence: number;
  queue: QueuedSubscriptionFrame[];
  queuedBytes: number;
  pumping: boolean;
  terminalQueued: boolean;
}

interface PendingRefresh {
  dirty: boolean;
  inFlight: boolean;
}

export class SessionContinuityCoordinator implements SessionContinuityService {
  readonly handlers: SessionContinuityOperationHandlerMap = {
    'subscription.open': async (input, context) => {
      const result = await this.#open(context.connectionId, input.sessionId);
      return result.ok
        ? { ok: true, result: result.value }
        : { ok: false, error: { code: result.code, message: result.message } };
    },
    'subscription.close': async (input, context) => {
      const closed = this.#closeSubscription(context.connectionId, input.subscriptionId);
      return closed
        ? { ok: true, result: { subscriptionId: input.subscriptionId } }
        : {
            ok: false,
            error: { code: 'not_found', message: 'Session subscription was not found' },
          };
    },
  };

  readonly #connections = new Map<string, ConnectionState>();
  readonly #sessions = new Map<string, SessionProjectionState>();
  readonly #subscriptions = new Map<string, Subscriber>();
  readonly #pendingRefreshes = new Map<string, PendingRefresh>();
  readonly #hostEpoch: string;
  readonly #readCanonical: ReadCanonicalSessionProjection;
  #closed = false;

  constructor(
    hostEpoch: string,
    readCanonical: ReadCanonicalSessionProjection,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly onPublicationFailure: (error: unknown) => void = () => undefined,
  ) {
    this.#hostEpoch = hostEpoch;
    this.#readCanonical = readCanonical;
  }

  attachConnection(
    connectionId: string,
    sink: SessionContinuityFrameSink,
  ): SessionContinuityConnection {
    if (this.#closed) throw new Error('Session continuity coordinator is closed');
    if (this.#connections.has(connectionId)) {
      throw new Error(`Duplicate Runtime Host connection: ${connectionId}`);
    }
    this.#connections.set(connectionId, {
      sink,
      subscriptionIds: new Set(),
      pendingOpenCount: 0,
    });
    let attached = true;
    return {
      activate: (subscriptionId) => {
        if (attached) this.#activate(connectionId, subscriptionId);
      },
      abort: (subscriptionId) => {
        if (attached) this.#abortSubscription(connectionId, subscriptionId);
      },
      close: () => {
        if (!attached) return;
        attached = false;
        this.#closeConnection(connectionId);
      },
    };
  }

  async refreshCanonical(sessionId: string, admission?: SessionAdmissionLease): Promise<void> {
    await this.#runInSessionLane(
      sessionId,
      async () => {
        if (this.#closed) return;
        const state = this.#sessions.get(sessionId);
        if (!state || (state.subscribers.size === 0 && !state.terminalPublicationFence)) return;
        const canonical = await this.#readCanonicalProjection(sessionId);
        if (this.#closed || !canonical) return;
        const committed = this.#commitCanonical(sessionId, canonical);
        if (committed.changed) this.#broadcastProjection(committed.state, committed.value);
      },
      admission,
    );
  }

  /** Safe for synchronous commit hooks: this only schedules and coalesces lane work. */
  enqueueCanonicalRefresh(sessionId: string): void {
    if (this.#closed) return;
    const pending = this.#pendingRefreshes.get(sessionId);
    if (pending) {
      if (pending.inFlight) pending.dirty = true;
      return;
    }
    const refresh: PendingRefresh = { dirty: false, inFlight: false };
    this.#pendingRefreshes.set(sessionId, refresh);
    void this.sessionAdmission
      .enqueueDetached(sessionId, async (lease) => {
        refresh.inFlight = true;
        await this.refreshCanonical(sessionId, lease);
        if (!refresh.dirty) return;
        refresh.dirty = false;
        await this.refreshCanonical(sessionId, lease);
      })
      .then(
        () => {
          this.#pendingRefreshes.delete(sessionId);
          if (refresh.dirty) this.enqueueCanonicalRefresh(sessionId);
        },
        (error) => {
          this.#pendingRefreshes.delete(sessionId);
          this.onPublicationFailure(error);
        },
      );
  }

  async holdTerminalPublication(
    sessionId: string,
    turnId: string,
    runId: string,
    admission?: SessionAdmissionLease,
  ): Promise<void> {
    await this.#runInSessionLane(
      sessionId,
      async () => {
        if (this.#closed) throw new Error('Session continuity coordinator is closed');
        const state = this.#sessions.get(sessionId);
        const existing = state?.terminalPublicationFence;
        if (existing) {
          if (existing.turnId === turnId && existing.runId === runId) return;
          throw new Error('Session already has a different terminal publication fence');
        }

        const canonical = await this.#readCanonicalProjection(sessionId);
        if (this.#closed) throw new Error('Session continuity coordinator is closed');
        if (!canonical) throw new Error('Cannot fence a missing Session projection');
        const rootTurn = requirePublicationFenceIdentity(canonical, sessionId, { turnId, runId });
        if (isTerminalTurn(rootTurn)) {
          throw new Error(
            'Terminal publication fence identity does not match a non-terminal canonical Turn',
          );
        }
        const committed = this.#commitCanonical(sessionId, canonical);
        committed.state.terminalPublicationFence = { turnId, runId };
        if (committed.changed) this.#broadcastProjection(committed.state, committed.value);
      },
      admission,
    );
  }

  async publishTerminalProjection(
    sessionId: string,
    turnId: string,
    runId: string,
    admission?: SessionAdmissionLease,
  ): Promise<void> {
    await this.#runInSessionLane(
      sessionId,
      async () => {
        if (this.#closed) throw new Error('Session continuity coordinator is closed');
        const state = this.#sessions.get(sessionId);
        const fence = state?.terminalPublicationFence;
        if (!state || !fence || fence.turnId !== turnId || fence.runId !== runId) {
          throw new Error('Terminal publication does not own the Session continuity fence');
        }
        const canonical = await this.#readCanonicalProjection(sessionId);
        if (this.#closed) throw new Error('Session continuity coordinator is closed');
        if (!canonical) {
          throw new Error('Canonical Session projection is not terminal for the fenced Turn');
        }
        const rootTurn = requirePublicationFenceIdentity(canonical, sessionId, fence);
        if (!isTerminalTurn(rootTurn)) {
          throw new Error('Canonical Session projection is not terminal for the fenced Turn');
        }
        if (isDeepStrictEqual(state.canonical, canonical)) {
          throw new Error('Fenced terminal projection was already published');
        }

        const nextRevision = state.revision + 1;
        const snapshot = createSessionContinuitySnapshot(canonical, nextRevision);
        state.canonical = canonical;
        state.revision = nextRevision;
        delete state.liveReplay;
        delete state.terminalPublicationFence;
        this.#broadcastProjection(state, snapshot);
        if (state.subscribers.size === 0) this.#sessions.delete(sessionId);
      },
      admission,
    );
  }

  async acceptRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeSessionTransientEvent,
  ): Promise<void> {
    if (
      (event.type === 'text_delta' || event.type === 'thinking_delta') &&
      event.text.length === 0
    ) {
      return;
    }
    if (
      (event.type === 'tool_output_delta' && event.chunk.length === 0) ||
      (event.type === 'tool_progress' &&
        (typeof event.chunk === 'string' ? event.chunk : event.chunk.text).length === 0)
    ) {
      return;
    }
    await this.sessionAdmission.run(sessionId, () => {
      const state = this.#sessions.get(sessionId);
      if (!state) return;
      const rootTurn = state.canonical.rootTurn;
      if (
        !rootTurn ||
        rootTurn.sessionId !== sessionId ||
        rootTurn.turnId !== event.turnId ||
        rootTurn.runId !== runId ||
        isTerminalTurn(rootTurn) ||
        (event.type === 'tool_output_delta' && event.sessionId !== sessionId)
      ) {
        throw new Error('Runtime event does not belong to the canonical active root Turn');
      }
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        const delta: SessionAssistantDelta = {
          kind: event.type === 'text_delta' ? 'text' : 'thinking',
          turnId: event.turnId,
          runId,
          messageId: event.messageId,
          text: event.text,
        };
        const replayText = boundedJsonTextTail(
          delta.text,
          MAX_LIVE_REPLAY_ASSISTANT_BYTES,
          MAX_LIVE_REPLAY_ASSISTANT_WIRE_BYTES,
        );
        this.#recordLiveReplay(state, rootTurn, {
          kind: 'assistant_delta',
          delta: {
            kind: delta.kind,
            turnId: delta.turnId,
            runId: delta.runId,
            messageId: delta.messageId,
          },
          chunks: [replayText],
          textBytes: Buffer.byteLength(replayText, 'utf8'),
          wireTextBytes: jsonStringContentBytes(replayText),
        });
        for (const subscriber of state.subscribers.values()) {
          this.#enqueueAssistantDelta(subscriber, sessionId, delta);
        }
        return;
      }
      const projected = projectToolEvent(event);
      this.#recordLiveReplay(state, rootTurn, { kind: 'tool_event', event: projected });
      for (const subscriber of state.subscribers.values()) {
        const frame: SessionEventFrame = {
          kind: 'subscription.session_event',
          hostEpoch: this.#hostEpoch,
          subscriptionId: subscriber.subscriptionId,
          sequence: subscriber.nextSequence,
          sessionId,
          runId,
          event: projected,
        };
        this.#enqueue(subscriber, frame);
      }
    });
  }

  async retireSessions(
    sessionIds: readonly string[],
    admission: SessionAdmissionLease,
  ): Promise<void> {
    for (const sessionId of new Set(sessionIds)) {
      await this.#runInSessionLane(
        sessionId,
        () => {
          const state = this.#sessions.get(sessionId);
          if (!state) return;
          for (const subscriber of state.subscribers.values()) {
            this.#enqueueSessionRemoved(subscriber);
          }
          this.#sessions.delete(sessionId);
        },
        admission,
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const connectionId of [...this.#connections.keys()]) this.#closeConnection(connectionId);
    this.#sessions.clear();
    this.#subscriptions.clear();
    this.#pendingRefreshes.clear();
  }

  async #open(
    connectionId: string,
    sessionId: string,
  ): Promise<
    | { ok: true; value: SubscriptionOpenResult }
    | { ok: false; code: 'not_found' | 'operation_conflict'; message: string }
  > {
    const connection = this.#connections.get(connectionId);
    if (!connection) throw new Error('Runtime Host connection is not attached to continuity');
    if (
      connection.subscriptionIds.size + connection.pendingOpenCount >=
      MAX_CONNECTION_SUBSCRIPTIONS
    ) {
      return {
        ok: false,
        code: 'operation_conflict',
        message: 'Runtime Host connection subscription limit reached',
      };
    }
    connection.pendingOpenCount += 1;
    try {
      return await this.sessionAdmission.run(sessionId, async () => {
        if (this.#connections.get(connectionId) !== connection) {
          throw new Error('Runtime Host connection closed during subscription open');
        }
        const canonical = await this.#readCanonicalProjection(sessionId);
        if (this.#connections.get(connectionId) !== connection) {
          throw new Error('Runtime Host connection closed during subscription open');
        }
        if (!canonical) {
          return {
            ok: false as const,
            code: 'not_found' as const,
            message: 'Session was not found',
          };
        }
        const committed = this.#commitCanonical(sessionId, canonical);
        if (committed.changed) this.#broadcastProjection(committed.state, committed.value);
        if (this.#connections.get(connectionId) !== connection) {
          this.#scheduleInactiveStateCleanup(sessionId, committed.state);
          throw new Error('Runtime Host connection closed during subscription open');
        }

        const subscriptionId = randomUUID();
        const subscriber: Subscriber = {
          connectionId,
          sessionId,
          subscriptionId,
          sink: connection.sink,
          phase: 'open',
          activated: false,
          nextSequence: 1,
          lastFlushedSequence: 0,
          queue: [],
          queuedBytes: 0,
          pumping: false,
          terminalQueued: false,
        };
        committed.state.subscribers.set(subscriptionId, subscriber);
        this.#subscriptions.set(subscriptionId, subscriber);
        connection.subscriptionIds.add(subscriptionId);
        const nextSequence = subscriber.nextSequence;
        this.#enqueueLiveReplay(subscriber, committed.state.liveReplay);
        return {
          ok: true as const,
          value: {
            hostEpoch: this.#hostEpoch,
            subscriptionId,
            nextSequence,
            snapshot: committed.value,
          },
        };
      });
    } finally {
      connection.pendingOpenCount -= 1;
    }
  }

  #activate(connectionId: string, subscriptionId: string): void {
    const subscriber = this.#ownedSubscriber(connectionId, subscriptionId);
    if (!subscriber || subscriber.activated || subscriber.phase === 'closed') return;
    subscriber.activated = true;
    this.#pump(subscriber);
  }

  #abortSubscription(connectionId: string, subscriptionId: string): void {
    const subscriber = this.#ownedSubscriber(connectionId, subscriptionId);
    if (subscriber) this.#removeSubscriber(subscriber);
  }

  #closeSubscription(connectionId: string, subscriptionId: string): boolean {
    const connection = this.#connections.get(connectionId);
    if (!connection) return false;
    const subscriber = this.#subscriptions.get(subscriptionId);
    if (!subscriber) return true;
    if (
      subscriber.connectionId !== connectionId ||
      !connection.subscriptionIds.has(subscriptionId)
    ) {
      return false;
    }
    this.#removeSubscriber(subscriber);
    return true;
  }

  #closeConnection(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (!connection) return;
    for (const subscriptionId of [...connection.subscriptionIds]) {
      const subscriber = this.#ownedSubscriber(connectionId, subscriptionId);
      if (subscriber) this.#removeSubscriber(subscriber);
    }
    this.#connections.delete(connectionId);
  }

  #enqueue(subscriber: Subscriber, frame: SubscriptionFrame): void {
    if (subscriber.phase !== 'open' || subscriber.terminalQueued) return;
    let encodedBytes: number;
    try {
      encodedBytes = encodeProtocolFrame(frame).byteLength;
    } catch {
      this.#evictSlowSubscriber(subscriber);
      return;
    }
    const terminalBytes = terminalFrameByteBudget(subscriber, this.#hostEpoch);
    if (
      subscriber.queue.length >= MAX_SUBSCRIBER_QUEUED_FRAMES - 1 ||
      subscriber.queuedBytes + encodedBytes + terminalBytes > MAX_SUBSCRIBER_QUEUED_BYTES
    ) {
      this.#evictSlowSubscriber(subscriber);
      return;
    }
    subscriber.queue.push({ frame, encodedBytes });
    subscriber.queuedBytes += encodedBytes;
    subscriber.nextSequence += 1;
    if (subscriber.activated) this.#pump(subscriber);
  }

  #evictSlowSubscriber(subscriber: Subscriber): void {
    if (subscriber.phase !== 'open') return;
    subscriber.phase = 'closing';
    const inFlight = subscriber.pumping ? subscriber.queue[0] : undefined;
    subscriber.queue = [];
    subscriber.queuedBytes = 0;
    subscriber.nextSequence = (inFlight?.frame.sequence ?? subscriber.lastFlushedSequence) + 1;
    const frame: SubscriptionFrame = {
      kind: 'subscription.closed',
      hostEpoch: this.#hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence,
      reason: 'slow_consumer',
    };
    subscriber.nextSequence += 1;
    subscriber.terminalQueued = true;
    const encodedBytes = encodeProtocolFrame(frame).byteLength;
    if (inFlight) {
      subscriber.queue.push(inFlight);
      subscriber.queuedBytes += inFlight.encodedBytes;
    }
    subscriber.queue.push({ frame, encodedBytes });
    subscriber.queuedBytes += encodedBytes;
    if (subscriber.activated) this.#pump(subscriber);
  }

  #enqueueAssistantDelta(
    subscriber: Subscriber,
    sessionId: string,
    delta: SessionAssistantDelta,
  ): void {
    let chunk = '';
    let rawBytes = 0;
    let wireBytes = 0;
    const frame = (text: string): SessionDeltaFrame => ({
      kind: 'subscription.session_delta',
      hostEpoch: this.#hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence,
      sessionId,
      delta: { ...delta, text },
    });
    let wireLimit = wireTextByteLimit(frame(''));
    for (const character of delta.text) {
      const rawCharacterBytes = Buffer.byteLength(character, 'utf8');
      const wireCharacterBytes = jsonStringContentBytes(character);
      if (
        chunk.length > 0 &&
        (rawBytes + rawCharacterBytes > SESSION_LIVE_DELTA_MAX_BYTES ||
          wireBytes + wireCharacterBytes > wireLimit)
      ) {
        this.#enqueue(subscriber, frame(chunk));
        if (subscriber.phase !== 'open') return;
        chunk = '';
        rawBytes = 0;
        wireBytes = 0;
        wireLimit = wireTextByteLimit(frame(''));
      }
      if (rawCharacterBytes > SESSION_LIVE_DELTA_MAX_BYTES || wireCharacterBytes > wireLimit) {
        throw new Error('Session delta character exceeds the wire frame budget');
      }
      chunk += character;
      rawBytes += rawCharacterBytes;
      wireBytes += wireCharacterBytes;
    }
    if (chunk.length > 0 && subscriber.phase === 'open') this.#enqueue(subscriber, frame(chunk));
  }

  #enqueueSessionRemoved(subscriber: Subscriber): void {
    if (subscriber.phase !== 'open' || subscriber.terminalQueued) return;
    const frame: SubscriptionFrame = {
      kind: 'subscription.closed',
      hostEpoch: this.#hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence,
      reason: 'session_removed',
    };
    const encodedBytes = encodeProtocolFrame(frame).byteLength;
    if (
      subscriber.queue.length >= MAX_SUBSCRIBER_QUEUED_FRAMES ||
      subscriber.queuedBytes + encodedBytes > MAX_SUBSCRIBER_QUEUED_BYTES
    ) {
      throw new Error('Session removal terminal headroom was not preserved');
    }
    subscriber.queue.push({ frame, encodedBytes });
    subscriber.queuedBytes += encodedBytes;
    subscriber.nextSequence += 1;
    subscriber.terminalQueued = true;
    if (subscriber.activated) this.#pump(subscriber);
  }

  #enqueueLiveReplay(subscriber: Subscriber, replay: LiveTurnReplay | undefined): void {
    if (!replay) return;
    for (const item of replay.items) {
      if (item.kind === 'assistant_delta') {
        this.#enqueueAssistantDelta(subscriber, subscriber.sessionId, {
          ...item.delta,
          text: item.chunks.join(''),
        });
      } else {
        this.#enqueue(subscriber, {
          kind: 'subscription.session_event',
          hostEpoch: this.#hostEpoch,
          subscriptionId: subscriber.subscriptionId,
          sequence: subscriber.nextSequence,
          sessionId: subscriber.sessionId,
          runId: replay.runId,
          event: item.event,
        });
      }
      if (subscriber.phase !== 'open') return;
    }
  }

  #recordLiveReplay(
    state: SessionProjectionState,
    rootTurn: TurnSnapshot,
    item: LiveReplayItem,
  ): void {
    let replay = state.liveReplay;
    if (!replay || replay.turnId !== rootTurn.turnId || replay.runId !== rootTurn.runId) {
      replay = {
        turnId: rootTurn.turnId,
        runId: rootTurn.runId,
        items: [],
        retainedBytes: 0,
      };
      state.liveReplay = replay;
    }
    const previous = replay.items.at(-1);
    if (!previous || !mergeLiveReplayItems(previous, item)) replay.items.push(item);
    replay.retainedBytes = liveReplayBytes(replay.items);
    while (
      replay.items.length > MAX_LIVE_REPLAY_ITEMS ||
      replay.retainedBytes > MAX_LIVE_REPLAY_RETAINED_BYTES
    ) {
      replay.items.shift();
      replay.retainedBytes = liveReplayBytes(replay.items);
    }
  }

  #pump(subscriber: Subscriber): void {
    if (subscriber.pumping || !subscriber.activated || subscriber.phase === 'closed') return;
    const queued = subscriber.queue[0];
    if (!queued) return;
    subscriber.pumping = true;
    let flushed: Promise<void>;
    try {
      flushed = subscriber.sink.send(queued.frame);
    } catch {
      this.#removeSubscriber(subscriber);
      return;
    }
    void flushed.then(
      () => {
        subscriber.pumping = false;
        if (subscriber.phase === 'closed') return;
        if (subscriber.queue[0] === queued) {
          subscriber.queue.shift();
          subscriber.queuedBytes -= queued.encodedBytes;
        }
        subscriber.lastFlushedSequence = queued.frame.sequence;
        if (queued.frame.kind === 'subscription.closed') {
          this.#removeSubscriber(subscriber);
          return;
        }
        this.#pump(subscriber);
      },
      () => this.#removeSubscriber(subscriber),
    );
  }

  #removeSubscriber(subscriber: Subscriber): void {
    if (subscriber.phase === 'closed') return;
    subscriber.phase = 'closed';
    subscriber.queue = [];
    subscriber.queuedBytes = 0;
    const state = this.#sessions.get(subscriber.sessionId);
    const removed = state?.subscribers.delete(subscriber.subscriptionId);
    this.#subscriptions.delete(subscriber.subscriptionId);
    this.#connections
      .get(subscriber.connectionId)
      ?.subscriptionIds.delete(subscriber.subscriptionId);
    if (!this.#closed && state && removed && state.subscribers.size === 0) {
      this.#scheduleInactiveStateCleanup(subscriber.sessionId, state);
    }
  }

  #ownedSubscriber(connectionId: string, subscriptionId: string): Subscriber | undefined {
    const connection = this.#connections.get(connectionId);
    if (!connection?.subscriptionIds.has(subscriptionId)) return;
    const subscriber = this.#subscriptions.get(subscriptionId);
    if (subscriber?.connectionId === connectionId) return subscriber;
  }

  #scheduleInactiveStateCleanup(sessionId: string, state: SessionProjectionState): void {
    if (this.#closed) return;
    void this.sessionAdmission.enqueueDetached(sessionId, () => {
      if (
        this.#sessions.get(sessionId) === state &&
        state.subscribers.size === 0 &&
        !state.terminalPublicationFence &&
        !isActiveTurn(state.canonical.rootTurn)
      ) {
        this.#sessions.delete(sessionId);
      }
    });
  }

  async #readCanonicalProjection(sessionId: string): Promise<CanonicalSessionProjection | null> {
    const canonical = await this.#readCanonical(sessionId);
    return canonical ? immutableClone(canonical) : null;
  }

  #commitCanonical(
    sessionId: string,
    canonical: CanonicalSessionProjection,
  ): { changed: boolean; state: SessionProjectionState; value: SessionContinuitySnapshot } {
    let state = this.#sessions.get(sessionId);
    if (state?.terminalPublicationFence) {
      const rootTurn = requirePublicationFenceIdentity(
        canonical,
        sessionId,
        state.terminalPublicationFence,
      );
      if (isTerminalTurn(rootTurn)) {
        return {
          changed: false,
          state,
          value: createSessionContinuitySnapshot(state.canonical, state.revision),
        };
      }
    }
    if (!state) {
      const value = createSessionContinuitySnapshot(canonical, 1);
      state = { canonical, revision: 1, subscribers: new Map() };
      this.#sessions.set(sessionId, state);
      return { changed: true, state, value };
    }
    const changed = !isDeepStrictEqual(state.canonical, canonical);
    if (changed) {
      const nextRevision = state.revision + 1;
      const value = createSessionContinuitySnapshot(canonical, nextRevision);
      state.canonical = canonical;
      state.revision = nextRevision;
      if (!sameActiveTurn(state.liveReplay, canonical.rootTurn)) delete state.liveReplay;
      return { changed, state, value };
    }
    return {
      changed,
      state,
      value: createSessionContinuitySnapshot(state.canonical, state.revision),
    };
  }

  #broadcastProjection(state: SessionProjectionState, snapshot: SessionContinuitySnapshot): void {
    for (const subscriber of state.subscribers.values()) {
      this.#enqueue(subscriber, {
        kind: 'subscription.session_projection',
        hostEpoch: this.#hostEpoch,
        subscriptionId: subscriber.subscriptionId,
        sequence: subscriber.nextSequence,
        snapshot,
      });
    }
  }

  #runInSessionLane<T>(
    sessionId: string,
    operation: () => Promise<T> | T,
    admission?: SessionAdmissionLease,
  ): Promise<T> {
    return admission
      ? this.sessionAdmission.runAdmitted(sessionId, admission, operation)
      : this.sessionAdmission.run(sessionId, operation);
  }
}

function slowConsumerFrameBytes(subscriber: Subscriber, hostEpoch: string): number {
  return encodeProtocolFrame({
    kind: 'subscription.closed',
    hostEpoch,
    subscriptionId: subscriber.subscriptionId,
    sequence: subscriber.nextSequence + 1,
    reason: 'slow_consumer',
  }).byteLength;
}

function terminalFrameByteBudget(subscriber: Subscriber, hostEpoch: string): number {
  return Math.max(
    slowConsumerFrameBytes(subscriber, hostEpoch),
    encodeProtocolFrame({
      kind: 'subscription.closed',
      hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence + 1,
      reason: 'session_removed',
    }).byteLength,
  );
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function mergeLiveReplayItems(previous: LiveReplayItem, next: LiveReplayItem): boolean {
  if (
    previous.kind !== 'assistant_delta' ||
    next.kind !== 'assistant_delta' ||
    previous.delta.kind !== next.delta.kind ||
    previous.delta.turnId !== next.delta.turnId ||
    previous.delta.runId !== next.delta.runId ||
    previous.delta.messageId !== next.delta.messageId
  ) {
    return false;
  }
  previous.chunks.push(...next.chunks);
  previous.textBytes += next.textBytes;
  previous.wireTextBytes += next.wireTextBytes;
  trimLiveAssistantReplay(previous);
  return true;
}

function liveReplayBytes(items: readonly LiveReplayItem[]): number {
  return items.reduce((total, item) => {
    if (item.kind === 'assistant_delta') {
      return total + item.wireTextBytes + Buffer.byteLength(JSON.stringify(item.delta), 'utf8');
    }
    return total + Buffer.byteLength(JSON.stringify(item.event), 'utf8');
  }, 0);
}

function trimLiveAssistantReplay(item: Extract<LiveReplayItem, { kind: 'assistant_delta' }>): void {
  while (
    item.textBytes > MAX_LIVE_REPLAY_ASSISTANT_BYTES ||
    item.wireTextBytes > MAX_LIVE_REPLAY_ASSISTANT_WIRE_BYTES
  ) {
    const first = item.chunks[0];
    if (first === undefined) {
      item.textBytes = 0;
      item.wireTextBytes = 0;
      return;
    }
    const firstBytes = Buffer.byteLength(first, 'utf8');
    const firstWireBytes = jsonStringContentBytes(first);
    const rawExcess = Math.max(0, item.textBytes - MAX_LIVE_REPLAY_ASSISTANT_BYTES);
    const wireExcess = Math.max(0, item.wireTextBytes - MAX_LIVE_REPLAY_ASSISTANT_WIRE_BYTES);
    if (firstBytes <= rawExcess || firstWireBytes <= wireExcess) {
      item.chunks.shift();
      item.textBytes -= firstBytes;
      item.wireTextBytes -= firstWireBytes;
      continue;
    }
    const bounded = boundedJsonTextTail(first, firstBytes - rawExcess, firstWireBytes - wireExcess);
    item.chunks[0] = bounded;
    item.textBytes += Buffer.byteLength(bounded, 'utf8') - firstBytes;
    item.wireTextBytes += jsonStringContentBytes(bounded) - firstWireBytes;
  }
}

function sameActiveTurn(replay: LiveTurnReplay | undefined, turn: TurnSnapshot | null): boolean {
  return (
    replay !== undefined &&
    isActiveTurn(turn) &&
    replay.turnId === turn.turnId &&
    replay.runId === turn.runId
  );
}

function isActiveTurn(turn: TurnSnapshot | null): turn is TurnSnapshot {
  return turn !== null && !isTerminalTurn(turn);
}

function requirePublicationFenceIdentity(
  canonical: CanonicalSessionProjection,
  sessionId: string,
  fence: TerminalPublicationFence,
): TurnSnapshot {
  const rootTurn = canonical.rootTurn;
  if (
    canonical.session.sessionId !== sessionId ||
    !rootTurn ||
    rootTurn.sessionId !== sessionId ||
    rootTurn.turnId !== fence.turnId ||
    rootTurn.runId !== fence.runId
  ) {
    throw new Error('Canonical Session projection identity does not match its publication fence');
  }
  return rootTurn;
}

function isTerminalTurn(turn: TurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}

function wireTextByteLimit(frame: SessionDeltaFrame): number {
  return RUNTIME_HOST_MAX_FRAME_BYTES - encodeProtocolFrame(frame).byteLength;
}

function jsonStringContentBytes(value: string): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded.slice(1, -1), 'utf8');
}

function projectToolEvent(
  event: Exclude<RuntimeSessionTransientEvent, { type: 'text_delta' | 'thinking_delta' }>,
): SessionToolEvent {
  const identity = {
    id: event.id,
    turnId: event.turnId,
    ts: event.ts,
    toolUseId: event.toolUseId,
  };
  switch (event.type) {
    case 'tool_start':
      return {
        type: event.type,
        ...identity,
        toolName: boundedUtf8(event.toolName, SESSION_TOOL_NAME_MAX_BYTES),
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(event.activityKind === undefined ? {} : { activityKind: event.activityKind }),
        ...(event.displayName === undefined
          ? {}
          : { displayName: boundedUtf8(event.displayName, SESSION_TOOL_NAME_MAX_BYTES) }),
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      };
    case 'tool_output_delta':
      return {
        type: event.type,
        ...identity,
        seq: event.seq,
        stream: event.stream,
        chunk: event.chunk,
        redacted: event.redacted,
        createdAt: event.createdAt,
      };
    case 'tool_progress':
      return {
        type: event.type,
        ...identity,
        chunk: boundedUtf8(
          typeof event.chunk === 'string' ? event.chunk : event.chunk.text,
          SESSION_LIVE_DELTA_MAX_BYTES,
        ),
      };
    case 'tool_result':
      return {
        type: event.type,
        ...identity,
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        status: event.isError ? 'errored' : 'completed',
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      };
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bounded = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

function boundedJsonTextTail(value: string, maxRawBytes: number, maxWireBytes: number): string {
  if (
    Buffer.byteLength(value, 'utf8') <= maxRawBytes &&
    jsonStringContentBytes(value) <= maxWireBytes
  ) {
    return value;
  }
  const characters: string[] = [];
  let rawBytes = 0;
  let wireBytes = 0;
  for (const character of Array.from(value).reverse()) {
    const rawCharacterBytes = Buffer.byteLength(character, 'utf8');
    const wireCharacterBytes = jsonStringContentBytes(character);
    if (
      rawBytes + rawCharacterBytes > maxRawBytes ||
      wireBytes + wireCharacterBytes > maxWireBytes
    ) {
      break;
    }
    characters.push(character);
    rawBytes += rawCharacterBytes;
    wireBytes += wireCharacterBytes;
  }
  return characters.reverse().join('');
}
