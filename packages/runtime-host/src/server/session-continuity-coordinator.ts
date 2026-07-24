import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SessionEvent } from '@maka/core/events';
import {
  encodeProtocolFrame,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
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
import type { CanonicalSessionProjection } from './canonical-session-projection.js';
import type {
  SessionContinuityConnection,
  SessionContinuityFrameSink,
  SessionContinuityService,
} from './session-continuity-service.js';

const MAX_CONNECTION_SUBSCRIPTIONS = 16;
const MAX_SUBSCRIBER_QUEUED_FRAMES = 32;
const MAX_SUBSCRIBER_QUEUED_BYTES = 256 * 1024;

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
  terminalPublicationFence?: TerminalPublicationFence;
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
        const snapshot = snapshotValue(canonical, nextRevision);
        state.canonical = canonical;
        state.revision = nextRevision;
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
      if (!state || state.subscribers.size === 0) return;
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
        const kind: SessionAssistantDelta['kind'] =
          event.type === 'text_delta' ? 'text' : 'thinking';
        for (const subscriber of state.subscribers.values()) {
          this.#enqueueAssistantDelta(subscriber, sessionId, runId, event, kind);
        }
        return;
      }
      const projected = projectToolEvent(event);
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
        return {
          ok: true as const,
          value: {
            hostEpoch: this.#hostEpoch,
            subscriptionId,
            nextSequence: subscriber.nextSequence,
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
    const terminalBytes = slowConsumerFrameBytes(subscriber, this.#hostEpoch);
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
    runId: string,
    event: Extract<RuntimeSessionTransientEvent, { type: 'text_delta' | 'thinking_delta' }>,
    kind: SessionAssistantDelta['kind'],
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
      delta: { kind, turnId: event.turnId, runId, messageId: event.messageId, text },
    });
    let wireLimit = wireTextByteLimit(frame(''));
    for (const character of event.text) {
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
        !state.terminalPublicationFence
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
          value: snapshotValue(state.canonical, state.revision),
        };
      }
    }
    if (!state) {
      state = { canonical, revision: 1, subscribers: new Map() };
      this.#sessions.set(sessionId, state);
      return { changed: true, state, value: snapshotValue(canonical, 1) };
    }
    const changed = !isDeepStrictEqual(state.canonical, canonical);
    if (changed) {
      state.canonical = canonical;
      state.revision += 1;
    }
    return { changed, state, value: snapshotValue(state.canonical, state.revision) };
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

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotValue(
  canonical: CanonicalSessionProjection,
  projectionRevision: number,
): SessionContinuitySnapshot {
  return immutableClone({
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: canonical.session,
    projectionRevision,
    rootTurn: canonical.rootTurn,
    queue: canonical.queue,
  });
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
