import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SessionEvent, ShellRunUpdate } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  encodeProtocolFrame,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
  SESSION_TOOL_NAME_MAX_BYTES,
  type AgentGraphChangedFrame,
  type AgentGraphChangedReason,
  type SessionAssistantDelta,
  type SessionContinuitySnapshot,
  type SessionDeltaFrame,
  type SessionDomainChange,
  type SessionDomainChangedFrame,
  type SessionEventFrame,
  type SessionToolEvent,
  type SessionTranscriptQueryInput,
  type OperationOutcome,
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
import { TranscriptSnapshotStore } from './transcript-snapshot-store.js';

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
      | 'tool_result_preview'
      | 'tool_result';
  }
>;

export type ReadCanonicalSessionProjection = (
  sessionId: string,
) => Promise<CanonicalSessionProjection | null>;

export type ReadSessionTranscript = (
  sessionId: string,
  rootTurn: TurnSnapshot | null,
) => Promise<readonly StoredMessage[]>;

interface SessionProjectionState {
  canonical: CanonicalSessionProjection;
  revision: number;
  subscribers: Map<string, Subscriber>;
  assistantPrefixes: Map<string, ActiveAssistantPrefix>;
  /**
   * Latest live tool_result_preview per toolUseId for the active turn.
   * Replace semantics; cleared on tool_result and terminal publication.
   * Seeded to new subscribers so mid-flight Open survives rejoin.
   */
  toolResultPreviews: Map<
    string,
    Extract<RuntimeSessionTransientEvent, { type: 'tool_result_preview' }>
  >;
  terminalPublicationFence?: TerminalPublicationFence;
}

interface ActiveAssistantPrefix {
  turnId: string;
  messageId: string;
  kind: SessionAssistantDelta['kind'];
  text: string;
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

interface PendingAgentGraphChange {
  event: {
    rootSessionId: string;
    graphId: string;
    reason: AgentGraphChangedReason;
  };
}

type SessionProjectionDomain = Exclude<SessionDomainChange['domain'], 'runtime_resource'>;

interface PendingSessionDomainChanges {
  readonly domains: Set<SessionProjectionDomain>;
  readonly runtimeResources: Map<string, { sourceSessionId: string; ref: string }>;
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
    'session.transcript.query': (input, context) =>
      this.#queryTranscript(context.connectionId, input),
  };

  readonly #connections = new Map<string, ConnectionState>();
  readonly #sessions = new Map<string, SessionProjectionState>();
  readonly #subscriptions = new Map<string, Subscriber>();
  readonly #transcriptSnapshots = new TranscriptSnapshotStore();
  readonly #pendingRefreshes = new Map<string, PendingRefresh>();
  readonly #pendingAgentGraphChanges = new Map<string, PendingAgentGraphChange>();
  readonly #pendingSessionDomainChanges = new Map<string, PendingSessionDomainChanges>();
  readonly #hostEpoch: string;
  readonly #readCanonical: ReadCanonicalSessionProjection;
  readonly #readTranscript: ReadSessionTranscript | undefined;
  #closed = false;

  constructor(
    hostEpoch: string,
    readCanonical: ReadCanonicalSessionProjection,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly onPublicationFailure: (error: unknown) => void = () => undefined,
    readTranscript?: ReadSessionTranscript,
  ) {
    this.#hostEpoch = hostEpoch;
    this.#readCanonical = readCanonical;
    this.#readTranscript = readTranscript;
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

  /** Coalesce process-local graph invalidations onto the root Session sequence. */
  enqueueAgentGraphChanged(event: {
    rootSessionId: string;
    graphId: string;
    reason: AgentGraphChangedReason;
  }): void {
    if (this.#closed) return;
    const pending = this.#pendingAgentGraphChanges.get(event.rootSessionId);
    if (pending) {
      pending.event = { ...event };
      return;
    }
    const change: PendingAgentGraphChange = { event: { ...event } };
    this.#pendingAgentGraphChanges.set(event.rootSessionId, change);
    void this.sessionAdmission
      .enqueueDetached(event.rootSessionId, () => {
        if (this.#pendingAgentGraphChanges.get(event.rootSessionId) !== change) return;
        this.#pendingAgentGraphChanges.delete(event.rootSessionId);
        if (this.#closed) return;
        const state = this.#sessions.get(event.rootSessionId);
        if (!state) return;
        for (const subscriber of state.subscribers.values()) {
          const frame: AgentGraphChangedFrame = {
            kind: 'subscription.agent_graph_changed',
            hostEpoch: this.#hostEpoch,
            subscriptionId: subscriber.subscriptionId,
            sequence: subscriber.nextSequence,
            ...change.event,
          };
          this.#enqueue(subscriber, frame);
        }
      })
      .catch((error: unknown) => {
        if (this.#pendingAgentGraphChanges.get(event.rootSessionId) === change) {
          this.#pendingAgentGraphChanges.delete(event.rootSessionId);
        }
        this.onPublicationFailure(error);
      });
  }

  /** Coalesce domain projection invalidations onto the Session subscription sequence. */
  enqueueSessionDomainChanged(sessionId: string, domain: SessionProjectionDomain): void {
    if (this.#closed) return;
    const pending = this.#pendingSessionDomainChanges.get(sessionId);
    if (pending) {
      pending.domains.add(domain);
      return;
    }
    const changes: PendingSessionDomainChanges = {
      domains: new Set([domain]),
      runtimeResources: new Map(),
    };
    this.#pendingSessionDomainChanges.set(sessionId, changes);
    this.#scheduleSessionDomainChanges(sessionId, changes);
  }

  /** Publish one lightweight source invalidation to every active Session view that may inherit it. */
  enqueueRuntimeResourceChanged(update: ShellRunUpdate): void {
    if (this.#closed) return;
    const resource = { sourceSessionId: update.sessionId, ref: update.result.ref };
    const key = JSON.stringify([resource.sourceSessionId, resource.ref]);
    for (const sessionId of this.#sessions.keys()) {
      const pending = this.#pendingSessionDomainChanges.get(sessionId);
      if (pending) {
        pending.runtimeResources.set(key, resource);
        continue;
      }
      const changes: PendingSessionDomainChanges = {
        domains: new Set(),
        runtimeResources: new Map([[key, resource]]),
      };
      this.#pendingSessionDomainChanges.set(sessionId, changes);
      this.#scheduleSessionDomainChanges(sessionId, changes);
    }
  }

  #scheduleSessionDomainChanges(sessionId: string, changes: PendingSessionDomainChanges): void {
    void this.sessionAdmission
      .enqueueDetached(sessionId, () => {
        if (this.#pendingSessionDomainChanges.get(sessionId) !== changes) return;
        this.#pendingSessionDomainChanges.delete(sessionId);
        if (this.#closed) return;
        const state = this.#sessions.get(sessionId);
        if (!state) return;
        const frames: SessionDomainChange[] = [...changes.domains].map((domain) => ({
          sessionId,
          domain,
        }));
        const runtimeResources = [...changes.runtimeResources.values()];
        for (
          let offset = 0;
          offset < runtimeResources.length;
          offset += SESSION_RUNTIME_RESOURCE_CHANGES_MAX
        ) {
          frames.push({
            sessionId,
            domain: 'runtime_resource',
            resources: runtimeResources.slice(
              offset,
              offset + SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
            ),
          });
        }
        for (const change of frames) {
          for (const subscriber of state.subscribers.values()) {
            const frame: SessionDomainChangedFrame = {
              kind: 'subscription.session_domain_changed',
              hostEpoch: this.#hostEpoch,
              subscriptionId: subscriber.subscriptionId,
              sequence: subscriber.nextSequence,
              ...change,
            };
            this.#enqueue(subscriber, frame);
          }
        }
      })
      .catch((error: unknown) => {
        if (this.#pendingSessionDomainChanges.get(sessionId) === changes) {
          this.#pendingSessionDomainChanges.delete(sessionId);
        }
        this.onPublicationFailure(error);
      });
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
        delete state.terminalPublicationFence;
        state.assistantPrefixes.clear();
        state.toolResultPreviews.clear();
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
    await this.sessionAdmission.run(sessionId, async () => {
      let state = this.#sessions.get(sessionId);
      if (!state) {
        const canonical = await this.#readCanonicalProjection(sessionId);
        if (!canonical) throw new Error('Runtime event belongs to a missing Session');
        state = this.#commitCanonical(sessionId, canonical).state;
      }
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
        const prefixKey = assistantPrefixKey(kind, event.messageId);
        const current = state.assistantPrefixes.get(prefixKey);
        const startOffset = current?.text.length ?? 0;
        state.assistantPrefixes.set(prefixKey, {
          turnId: event.turnId,
          messageId: event.messageId,
          kind,
          text: (current?.text ?? '') + event.text,
        });
        for (const subscriber of state.subscribers.values()) {
          this.#enqueueAssistantDelta(subscriber, sessionId, runId, event, kind, startOffset);
        }
        return;
      }
      if (event.type === 'tool_result_preview') {
        state.toolResultPreviews.set(event.toolUseId, event);
      } else if (event.type === 'tool_result') {
        state.toolResultPreviews.delete(event.toolUseId);
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
          this.#transcriptSnapshots.deleteSession(sessionId);
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
    this.#transcriptSnapshots.close();
    this.#pendingRefreshes.clear();
    this.#pendingAgentGraphChanges.clear();
    this.#pendingSessionDomainChanges.clear();
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
        // Seed retained live previews so a mid-turn rejoin still has Open facts.
        const rootTurn = committed.state.canonical.rootTurn;
        if (rootTurn && !isTerminalTurn(rootTurn)) {
          for (const preview of committed.state.toolResultPreviews.values()) {
            if (preview.turnId !== rootTurn.turnId) continue;
            const frame: SessionEventFrame = {
              kind: 'subscription.session_event',
              hostEpoch: this.#hostEpoch,
              subscriptionId: subscriber.subscriptionId,
              sequence: subscriber.nextSequence,
              sessionId,
              runId: rootTurn.runId,
              event: projectToolEvent(preview),
            };
            this.#enqueue(subscriber, frame);
          }
        }
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

  async #queryTranscript(
    connectionId: string,
    input: SessionTranscriptQueryInput,
  ): Promise<OperationOutcome<'session.transcript.query'>> {
    const subscriber = this.#ownedSubscriber(connectionId, input.subscriptionId);
    if (!subscriber) {
      return {
        ok: false,
        error: { code: 'not_found', message: 'Session subscription was not found' },
      };
    }
    if (!this.#readTranscript) {
      return {
        ok: false,
        error: { code: 'operation_unavailable', message: 'Session transcript is unavailable' },
      };
    }
    if (input.kind === 'continue') {
      return this.#transcriptSnapshots.continue({
        connectionId,
        subscriptionId: input.subscriptionId,
        snapshotId: input.snapshotId,
        cursor: { messageIndex: input.messageIndex, byteOffset: input.byteOffset },
      });
    }
    const readTranscript = this.#readTranscript;
    return this.sessionAdmission.run(subscriber.sessionId, async () => {
      if (this.#ownedSubscriber(connectionId, input.subscriptionId) !== subscriber) {
        return transcriptSubscriptionNotFound();
      }
      try {
        const state = this.#sessions.get(subscriber.sessionId);
        const messages = await readTranscript(
          subscriber.sessionId,
          state?.canonical.rootTurn ?? null,
        );
        if (this.#ownedSubscriber(connectionId, input.subscriptionId) !== subscriber) {
          return transcriptSubscriptionNotFound();
        }
        return this.#transcriptSnapshots.start({
          connectionId,
          subscriptionId: subscriber.subscriptionId,
          sessionId: subscriber.sessionId,
          messages: mergeActiveAssistantPrefixes(messages, state?.assistantPrefixes.values()),
        });
      } catch {
        return {
          ok: false,
          error: { code: 'persistence_failed', message: 'Session transcript is unavailable' },
        };
      }
    });
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
    this.#transcriptSnapshots.deleteConnection(connectionId);
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
    runId: string,
    event: Extract<RuntimeSessionTransientEvent, { type: 'text_delta' | 'thinking_delta' }>,
    kind: SessionAssistantDelta['kind'],
    startOffset: number,
  ): void {
    let chunk = '';
    let rawBytes = 0;
    let wireBytes = 0;
    let emittedCharacters = 0;
    const frame = (text: string): SessionDeltaFrame => ({
      kind: 'subscription.session_delta',
      hostEpoch: this.#hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence,
      sessionId,
      delta: {
        kind,
        turnId: event.turnId,
        runId,
        messageId: event.messageId,
        startOffset: startOffset + emittedCharacters,
        text,
      },
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
        emittedCharacters += chunk.length;
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
    this.#transcriptSnapshots.deleteSubscription(subscriber.subscriptionId);
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
        (!state.canonical.rootTurn || isTerminalTurn(state.canonical.rootTurn))
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
      state = {
        canonical,
        revision: 1,
        subscribers: new Map(),
        assistantPrefixes: new Map(),
        toolResultPreviews: new Map(),
      };
      this.#sessions.set(sessionId, state);
      return { changed: true, state, value };
    }
    const changed = !isDeepStrictEqual(state.canonical, canonical);
    if (changed) {
      const nextRevision = state.revision + 1;
      const value = createSessionContinuitySnapshot(canonical, nextRevision);
      state.canonical = canonical;
      state.revision = nextRevision;
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

function assistantPrefixKey(kind: SessionAssistantDelta['kind'], messageId: string): string {
  return `${kind}\0${messageId}`;
}

function mergeActiveAssistantPrefixes(
  messages: readonly StoredMessage[],
  prefixes: Iterable<ActiveAssistantPrefix> | undefined,
): readonly StoredMessage[] {
  const activePrefixes = prefixes ? [...prefixes] : [];
  if (activePrefixes.length === 0) return messages;
  const messageIndexById = new Map(messages.map((message, index) => [message.id, index]));
  let merged: StoredMessage[] | undefined;
  for (const prefix of activePrefixes) {
    const messageIndex = messageIndexById.get(prefix.messageId);
    if (messageIndex === undefined) {
      throw new Error('Active assistant prefix has no matching transcript message');
    }
    const message = merged?.[messageIndex] ?? messages[messageIndex];
    if (message?.type !== 'assistant' || message.turnId !== prefix.turnId) {
      throw new Error('Active assistant prefix has no matching transcript message');
    }
    let nextMessage: StoredMessage;
    if (prefix.kind === 'text') {
      const text = mergeAssistantPrefix(message.text, prefix.text);
      if (text === message.text) continue;
      nextMessage = { ...message, text };
    } else {
      if (!message.thinking) {
        throw new Error('Active thinking prefix has no matching transcript content');
      }
      const text = mergeAssistantPrefix(message.thinking.text, prefix.text);
      if (text === message.thinking.text) continue;
      nextMessage = { ...message, thinking: { ...message.thinking, text } };
    }
    if (!merged) merged = [...messages];
    merged[messageIndex] = nextMessage;
  }
  return merged ?? messages;
}

function mergeAssistantPrefix(durable: string, active: string): string {
  if (active.startsWith(durable)) return active;
  if (durable.startsWith(active)) return durable;
  throw new Error('Active assistant prefix conflicts with the durable transcript');
}

function transcriptSubscriptionNotFound(): OperationOutcome<'session.transcript.query'> {
  return {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  };
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
    case 'tool_result_preview':
      return {
        type: event.type,
        ...identity,
        isError: event.isError,
        content: event.content,
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
