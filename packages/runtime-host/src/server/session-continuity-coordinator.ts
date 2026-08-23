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

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SessionEvent, ShellRunUpdate } from '@maka/core/events';
import {
  encodeProtocolMessage,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES,
  SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
  SESSION_SUBSCRIPTION_FRAME_MAX_BYTES,
  SUBSCRIPTION_OPEN_RESULT_MAX_BYTES,
  SESSION_TOOL_NAME_MAX_BYTES,
  type AgentGraphChangedFrame,
  type AgentGraphChangedReason,
  type SessionAssistantDelta,
  type SessionContinuitySnapshot,
  type SessionDeltaFrame,
  type SessionDomainChange,
  type SessionDomainChangedFrame,
  type SessionEventFrame,
  type SessionRuntimeResourcePtyDataFrame,
  type SessionToolEvent,
  type SessionTranscriptAdvancedFrame,
  type SessionTranscriptPageInput,
  type OperationOutcome,
  type SubscriptionFrame,
  type SubscriptionOpenInput,
  type SubscriptionOpenResult,
  type LiveTurnSnapshot,
  type TurnProviderRetry,
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
import {
  createSessionTranscriptBootstrap,
  prepareSessionTranscriptOverlay,
  readSessionTranscriptPage,
  type SubscriberTranscriptState,
  TranscriptPageRequestError,
  updateSubscriberTranscriptHighWater,
} from './session-transcript-pager.js';
import {
  ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES,
  type SessionTranscriptReader,
} from './session-transcript-reader.js';

const MAX_CONNECTION_SUBSCRIPTIONS = 16;
const MAX_SUBSCRIBER_QUEUED_FRAMES = 32;
const MAX_SUBSCRIBER_QUEUED_BYTES = 256 * 1024;

export type { CanonicalSessionProjection } from './canonical-session-projection.js';

export type RuntimeSessionTransientEvent = Extract<
  SessionEvent,
  {
    type:
      | 'text_delta'
      | 'text_complete'
      | 'thinking_delta'
      | 'thinking_complete'
      | 'tool_start'
      | 'tool_output_delta'
      | 'tool_progress'
      | 'tool_result_preview'
      | 'tool_result'
      | 'provider_retry';
  }
>;

export type ReadCanonicalSessionProjection = (
  sessionId: string,
) => Promise<CanonicalSessionProjection | null>;

interface SessionProjectionState {
  canonical: CanonicalSessionProjection;
  revision: number;
  subscribers: Map<string, Subscriber>;
  assistantStreams: Map<string, ActiveAssistantStream>;
  transcriptOverlay?: CachedTranscriptOverlay;
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

interface ActiveAssistantStream {
  turnId: string;
  messageId: string;
  kind: SessionAssistantDelta['kind'];
  text: string;
  completedParts?: string[];
}

interface TerminalPublicationFence {
  turnId: string;
  runId: string;
}

interface ConnectionState {
  sink: SessionContinuityFrameSink;
  subscriptionIds: Set<string>;
  pendingOpenCount: number;
  readonly closed: Promise<void>;
  resolveClosed(): void;
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
  transcript?: SubscriberTranscriptState;
  retainedTranscriptOverlay?: RetainedTranscriptOverlay;
}

interface RetainedTranscriptOverlay {
  readonly messages: readonly Buffer[];
  readonly bytes: number;
  references: number;
}

interface CachedTranscriptOverlay {
  readonly throughSequence: number | null;
  readonly prepared: Promise<RetainedTranscriptOverlay>;
  pendingConsumers: number;
  cancelPreparation(): void;
}

interface TranscriptOverlayPreparationWaiter {
  cancelled: boolean;
  granted: boolean;
  resolve(release: () => void): void;
  reject(error: Error): void;
}

interface TranscriptOverlayPreparationPermit {
  readonly waiter: TranscriptOverlayPreparationWaiter;
  take(): () => void;
  release(): void;
}

const MAX_RETAINED_TRANSCRIPT_OVERLAY_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_OVERLAY_PREPARATION_WAITERS = 64;
// Preparation can retain the active projection, durable reconciliation, and
// final encoded snapshot at the same time; charge all three to the Host budget.
const MAX_TRANSCRIPT_OVERLAY_PREPARATION_BYTES = ACTIVE_TRANSCRIPT_OVERLAY_MAX_BYTES * 3;

class TranscriptOverlayCapacityError extends Error {
  readonly name = 'TranscriptOverlayCapacityError';
}

class TranscriptOverlayPreparationRequired extends Error {
  readonly name = 'TranscriptOverlayPreparationRequired';
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
      const result = await this.#open(context.connectionId, input);
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
    'session.transcript.page': (input, context) =>
      this.#readTranscriptPage(context.connectionId, input),
    'session.transcript.overlay.release': async (input, context) => {
      const existing = this.#subscriptions.get(input.subscriptionId);
      if (!existing) {
        return { ok: true, result: { subscriptionId: input.subscriptionId } };
      }
      const subscriber = this.#ownedSubscriber(context.connectionId, input.subscriptionId);
      if (!subscriber) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Session subscription was not found' },
        };
      }
      this.#releaseSubscriberTranscriptOverlay(subscriber);
      return { ok: true, result: { subscriptionId: input.subscriptionId } };
    },
  };

  readonly #connections = new Map<string, ConnectionState>();
  readonly #sessions = new Map<string, SessionProjectionState>();
  readonly #subscriptions = new Map<string, Subscriber>();
  readonly #pendingRefreshes = new Map<string, PendingRefresh>();
  readonly #pendingAgentGraphChanges = new Map<string, PendingAgentGraphChange>();
  readonly #pendingSessionDomainChanges = new Map<string, PendingSessionDomainChanges>();
  readonly #retainedTranscriptOverlays = new Map<readonly Buffer[], RetainedTranscriptOverlay>();
  readonly #transcriptOverlayPreparationWaiters: TranscriptOverlayPreparationWaiter[] = [];
  readonly #hostEpoch: string;
  readonly #readCanonical: ReadCanonicalSessionProjection;
  readonly #transcriptReader: SessionTranscriptReader | undefined;
  #closed = false;
  #preparingTranscriptOverlayBytes = 0;
  #retainedTranscriptOverlayBytes = 0;

  constructor(
    hostEpoch: string,
    readCanonical: ReadCanonicalSessionProjection,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly onPublicationFailure: (error: unknown) => void = () => undefined,
    transcriptReader?: SessionTranscriptReader,
    private readonly onCatalogChanged: (sessionId: string) => void = () => undefined,
  ) {
    this.#hostEpoch = hostEpoch;
    this.#readCanonical = readCanonical;
    this.#transcriptReader = transcriptReader;
  }

  attachConnection(
    connectionId: string,
    sink: SessionContinuityFrameSink,
  ): SessionContinuityConnection {
    if (this.#closed) throw new Error('Session continuity coordinator is closed');
    if (this.#connections.has(connectionId)) {
      throw new Error(`Duplicate Runtime Host connection: ${connectionId}`);
    }
    const closed = signal();
    this.#connections.set(connectionId, {
      sink,
      subscriptionIds: new Set(),
      pendingOpenCount: 0,
      closed: closed.promise,
      resolveClosed: closed.resolve,
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
    this.onCatalogChanged(sessionId);
    await this.#runInSessionLane(
      sessionId,
      async () => {
        if (this.#closed) return;
        const state = this.#sessions.get(sessionId);
        if (!state || (state.subscribers.size === 0 && !state.terminalPublicationFence)) return;
        this.#invalidateTranscriptOverlay(state);
        const canonical = await this.#readCanonicalProjection(sessionId);
        if (this.#closed || !canonical) return;
        await this.#refreshTranscriptHighWater(sessionId, state);
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

  /** Publish live PTY bytes on the same ordered Session subscription as its durable projection. */
  async enqueueRuntimeResourcePtyData(event: {
    sessionId: string;
    ref: string;
    sequence: number;
    data: string;
  }): Promise<void> {
    if (
      this.#closed ||
      Buffer.byteLength(event.data, 'utf8') > SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES
    ) {
      return;
    }
    try {
      await this.sessionAdmission.enqueueDetached(event.sessionId, () => {
        if (this.#closed) return;
        const state = this.#sessions.get(event.sessionId);
        if (!state) return;
        for (const subscriber of state.subscribers.values()) {
          const frame: SessionRuntimeResourcePtyDataFrame = {
            kind: 'subscription.runtime_resource_pty_data',
            hostEpoch: this.#hostEpoch,
            subscriptionId: subscriber.subscriptionId,
            sequence: subscriber.nextSequence,
            sessionId: event.sessionId,
            ref: event.ref,
            ptySequence: event.sequence,
            data: event.data,
          };
          if (
            Buffer.byteLength(JSON.stringify(frame), 'utf8') <= SESSION_SUBSCRIPTION_FRAME_MAX_BYTES
          ) {
            this.#enqueue(subscriber, frame);
          }
        }
      });
    } catch (error) {
      this.onPublicationFailure(error);
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

        await this.#refreshTranscriptHighWater(sessionId, state);

        const nextRevision = state.revision + 1;
        const snapshot = createSessionContinuitySnapshot(canonical, nextRevision);
        this.#invalidateTranscriptOverlay(state);
        state.canonical = canonical;
        state.revision = nextRevision;
        delete state.terminalPublicationFence;
        state.assistantStreams.clear();
        state.toolResultPreviews.clear();
        this.#broadcastProjection(state, snapshot);
        if (state.subscribers.size === 0) {
          this.#invalidateTranscriptOverlay(state);
          this.#sessions.delete(sessionId);
        }
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
      this.#invalidateTranscriptOverlay(state);
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
      if (event.type === 'provider_retry') {
        this.#publishCanonical(state, withProviderRetry(state.canonical, event));
        return;
      }
      this.#publishCanonical(state, withoutProviderRetry(state.canonical));
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        const kind: SessionAssistantDelta['kind'] =
          event.type === 'text_delta' ? 'text' : 'thinking';
        const prefixKey = assistantStreamKey(kind, event.messageId);
        const current = state.assistantStreams.get(prefixKey);
        const startOffset = current?.text.length ?? 0;
        state.assistantStreams.set(prefixKey, {
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
      if (event.type === 'text_complete' || event.type === 'thinking_complete') {
        if (event.type === 'thinking_complete') {
          const prefixKey = assistantStreamKey('thinking', event.messageId);
          const current = state.assistantStreams.get(prefixKey) ?? {
            kind: 'thinking' as const,
            turnId: event.turnId,
            messageId: event.messageId,
            text: '',
          };
          current.completedParts = [...(current.completedParts ?? []), event.text];
          state.assistantStreams.set(prefixKey, current);
          return;
        }

        const thinkingKey = assistantStreamKey('thinking', event.messageId);
        const thinking = state.assistantStreams.get(thinkingKey);
        if (thinking) {
          const finalThinking = thinking.completedParts?.join('') ?? thinking.text;
          for (const subscriber of state.subscribers.values()) {
            this.#enqueueAssistantCompletion(
              subscriber,
              sessionId,
              runId,
              thinking,
              'thinking',
              finalThinking,
            );
          }
          state.assistantStreams.delete(thinkingKey);
        }

        const textKey = assistantStreamKey('text', event.messageId);
        const text = state.assistantStreams.get(textKey);
        if (text || event.text.length > 0) {
          const current =
            text ??
            ({
              kind: 'text',
              turnId: event.turnId,
              messageId: event.messageId,
              text: '',
            } satisfies ActiveAssistantStream);
          for (const subscriber of state.subscribers.values()) {
            this.#enqueueAssistantCompletion(
              subscriber,
              sessionId,
              runId,
              current,
              'text',
              event.text,
            );
          }
          state.assistantStreams.delete(textKey);
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
          this.#invalidateTranscriptOverlay(state);
          this.#sessions.delete(sessionId);
        },
        admission,
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelTranscriptOverlayPreparationWaiters();
    for (const connectionId of [...this.#connections.keys()]) this.#closeConnection(connectionId);
    for (const state of this.#sessions.values()) this.#invalidateTranscriptOverlay(state);
    this.#sessions.clear();
    this.#subscriptions.clear();
    this.#pendingRefreshes.clear();
    this.#pendingAgentGraphChanges.clear();
    this.#pendingSessionDomainChanges.clear();
  }

  async #open(
    connectionId: string,
    input: SubscriptionOpenInput,
  ): Promise<
    | { ok: true; value: SubscriptionOpenResult }
    | {
        ok: false;
        code: 'not_found' | 'operation_conflict' | 'operation_unavailable' | 'persistence_failed';
        message: string;
      }
  > {
    const sessionId = input.sessionId;
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
    let preparationPermit: TranscriptOverlayPreparationPermit | undefined;
    let retryAfterCapacity = false;
    try {
      for (;;) {
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
            if (committed.changed) {
              this.#invalidateTranscriptOverlay(committed.state);
              this.#broadcastProjection(committed.state, committed.value);
            }
            if (this.#connections.get(connectionId) !== connection) {
              this.#scheduleInactiveStateCleanup(sessionId, committed.state);
              throw new Error('Runtime Host connection closed during subscription open');
            }

            const subscriptionId = randomUUID();
            const activeAssistantStreams = [...committed.state.assistantStreams.values()].map(
              ({ kind, turnId, messageId }) => ({ kind, turnId, messageId }),
            );
            let transcript: SubscriberTranscriptState | undefined;
            let retainedTranscriptOverlay: RetainedTranscriptOverlay | undefined;
            let cachedTranscriptOverlay: CachedTranscriptOverlay | undefined;
            let transcriptSubscriberInstalled = false;
            let transcriptBootstrap: SubscriptionOpenResult['transcript'] = null;
            try {
              if (input.transcript.kind === 'tail') {
                if (!this.#transcriptReader) {
                  return {
                    ok: false as const,
                    code: 'operation_unavailable' as const,
                    message: 'Session transcript is unavailable',
                  };
                }
                try {
                  const throughSequence =
                    await this.#transcriptReader.readDurableHighWater(sessionId);
                  cachedTranscriptOverlay = this.#prepareTranscriptOverlay(
                    committed.state,
                    sessionId,
                    throughSequence,
                    preparationPermit,
                  );
                  cachedTranscriptOverlay.pendingConsumers += 1;
                  retainedTranscriptOverlay = await Promise.race([
                    cachedTranscriptOverlay.prepared,
                    connection.closed.then(() => {
                      throw new Error('Runtime Host connection closed during subscription open');
                    }),
                  ]);
                  const created = await createSessionTranscriptBootstrap({
                    reader: this.#transcriptReader,
                    sessionId,
                    subscriptionId,
                    throughSequence,
                    rootTurn: committed.state.canonical.rootTurn,
                    activeAssistantStreams: committed.state.assistantStreams.values(),
                    maxBytes: input.transcript.maxBytes,
                    preparedOverlayMessages: retainedTranscriptOverlay.messages,
                    maxEncodedBytes: subscriptionOpenTranscriptBudget({
                      hostEpoch: this.#hostEpoch,
                      subscriptionId,
                      nextSequence: 1,
                      snapshot: committed.value,
                      activeAssistantStreams,
                      transcript: null,
                    }),
                  });
                  transcript = created.state;
                  transcriptBootstrap = created.bootstrap;
                } catch (error) {
                  if (error instanceof TranscriptOverlayPreparationRequired) throw error;
                  return {
                    ok: false as const,
                    code:
                      error instanceof TranscriptOverlayCapacityError
                        ? ('operation_unavailable' as const)
                        : ('persistence_failed' as const),
                    message:
                      error instanceof TranscriptOverlayCapacityError
                        ? 'Runtime Host transcript overlay capacity reached'
                        : 'Session transcript is unavailable',
                  };
                }
              }
              if (this.#connections.get(connectionId) !== connection) {
                this.#scheduleInactiveStateCleanup(sessionId, committed.state);
                throw new Error('Runtime Host connection closed during subscription open');
              }
              const openValue: SubscriptionOpenResult = {
                hostEpoch: this.#hostEpoch,
                subscriptionId,
                nextSequence: 1,
                snapshot: committed.value,
                activeAssistantStreams,
                transcript: transcriptBootstrap,
              };
              if (
                Buffer.byteLength(JSON.stringify(openValue), 'utf8') >
                SUBSCRIPTION_OPEN_RESULT_MAX_BYTES
              ) {
                return {
                  ok: false as const,
                  code: 'operation_unavailable' as const,
                  message: 'Session subscription state exceeds the transport limit',
                };
              }
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
                ...(transcript ? { transcript } : {}),
                ...(retainedTranscriptOverlay ? { retainedTranscriptOverlay } : {}),
              };
              if (subscriber.retainedTranscriptOverlay)
                this.#retainTranscriptOverlay(subscriber.retainedTranscriptOverlay);
              committed.state.subscribers.set(subscriptionId, subscriber);
              this.#subscriptions.set(subscriptionId, subscriber);
              connection.subscriptionIds.add(subscriptionId);
              transcriptSubscriberInstalled = subscriber.retainedTranscriptOverlay !== undefined;
              // Client expects the first delivered frame at nextSequence from the open
              // result. Capture that before enqueueing retained previews — each
              // #enqueue advances nextSequence.
              const firstSequence = subscriber.nextSequence;
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
                value: { ...openValue, nextSequence: firstSequence },
              };
            } finally {
              if (cachedTranscriptOverlay) cachedTranscriptOverlay.pendingConsumers -= 1;
              if (
                cachedTranscriptOverlay &&
                !transcriptSubscriberInstalled &&
                cachedTranscriptOverlay.pendingConsumers === 0 &&
                !this.#hasTranscriptOverlayConsumer(committed.state)
              ) {
                this.#invalidateTranscriptOverlay(committed.state, cachedTranscriptOverlay);
              }
            }
          });
        } catch (error) {
          if (!(error instanceof TranscriptOverlayPreparationRequired)) throw error;
          if (retryAfterCapacity) {
            return {
              ok: false as const,
              code: 'operation_unavailable' as const,
              message: 'Runtime Host transcript overlay capacity reached',
            };
          }
          try {
            preparationPermit = await this.#acquireTranscriptOverlayPreparation(connection);
          } catch (acquireError) {
            if (acquireError instanceof TranscriptOverlayCapacityError) {
              retryAfterCapacity = true;
              continue;
            }
            return {
              ok: false as const,
              code: 'persistence_failed' as const,
              message: 'Session transcript is unavailable',
            };
          }
        }
      }
    } finally {
      preparationPermit?.release();
      connection.pendingOpenCount -= 1;
    }
  }

  async #readTranscriptPage(
    connectionId: string,
    input: SessionTranscriptPageInput,
  ): Promise<OperationOutcome<'session.transcript.page'>> {
    const subscriber = this.#ownedSubscriber(connectionId, input.subscriptionId);
    if (!subscriber) {
      return {
        ok: false,
        error: { code: 'not_found', message: 'Session subscription was not found' },
      };
    }
    if (!this.#transcriptReader || !subscriber.transcript) {
      return {
        ok: false,
        error: { code: 'operation_unavailable', message: 'Session transcript is unavailable' },
      };
    }
    const transcript = subscriber.transcript;
    return this.sessionAdmission.run(subscriber.sessionId, async () => {
      if (this.#ownedSubscriber(connectionId, input.subscriptionId) !== subscriber) {
        return transcriptSubscriptionNotFound();
      }
      try {
        const page = await readSessionTranscriptPage({
          reader: this.#transcriptReader!,
          state: transcript,
          request: input,
        });
        if (this.#ownedSubscriber(connectionId, input.subscriptionId) !== subscriber) {
          return transcriptSubscriptionNotFound();
        }
        return { ok: true, result: page };
      } catch (error) {
        if (error instanceof TranscriptPageRequestError) {
          return {
            ok: false,
            error: { code: 'invalid_request', message: error.message },
          };
        }
        return {
          ok: false,
          error: { code: 'persistence_failed', message: 'Session transcript is unavailable' },
        };
      }
    });
  }

  #prepareTranscriptOverlay(
    state: SessionProjectionState,
    sessionId: string,
    throughSequence: number | null,
    permit: TranscriptOverlayPreparationPermit | undefined,
  ): CachedTranscriptOverlay {
    if (!this.#transcriptReader) throw new Error('Session transcript is unavailable');
    const cached = state.transcriptOverlay;
    if (cached?.throughSequence === throughSequence) return cached;
    if (cached) this.#invalidateTranscriptOverlay(state, cached);
    if (!state.canonical.rootTurn || isTerminalTurn(state.canonical.rootTurn)) {
      const prepared = Promise.resolve(this.#registerTranscriptOverlay([]));
      const entry = {
        throughSequence,
        prepared,
        pendingConsumers: 0,
        cancelPreparation: () => {},
      };
      state.transcriptOverlay = entry;
      return entry;
    }
    if (!permit) throw new TranscriptOverlayPreparationRequired();
    const release = permit.take();
    const prepared = (async () => {
      try {
        if (permit.waiter.cancelled) {
          throw new Error('Session transcript overlay preparation was cancelled');
        }
        const messages = await prepareSessionTranscriptOverlay({
          reader: this.#transcriptReader!,
          sessionId,
          throughSequence,
          rootTurn: state.canonical.rootTurn,
          activeAssistantStreams: state.assistantStreams.values(),
        });
        return this.#registerTranscriptOverlay(messages);
      } finally {
        release();
      }
    })();
    const entry = {
      throughSequence,
      prepared,
      pendingConsumers: 0,
      cancelPreparation: () => this.#cancelTranscriptOverlayPreparation(permit.waiter),
    };
    state.transcriptOverlay = entry;
    void prepared.catch(() => {
      if (state.transcriptOverlay === entry) state.transcriptOverlay = undefined;
    });
    return entry;
  }

  async #acquireTranscriptOverlayPreparation(
    connection: ConnectionState,
  ): Promise<TranscriptOverlayPreparationPermit> {
    const ticket = this.#queueTranscriptOverlayPreparation();
    let release: () => void;
    try {
      release = await Promise.race([
        ticket.ready,
        connection.closed.then(() => {
          throw new Error('Runtime Host connection closed during subscription open');
        }),
      ]);
    } catch (error) {
      this.#cancelTranscriptOverlayPreparation(ticket.waiter);
      throw error;
    }
    let available = true;
    return {
      waiter: ticket.waiter,
      take: () => {
        if (!available) {
          throw new Error('Session transcript overlay preparation permit is unavailable');
        }
        available = false;
        return release;
      },
      release: () => {
        if (!available) return;
        available = false;
        release();
      },
    };
  }

  #queueTranscriptOverlayPreparation(): {
    readonly waiter: TranscriptOverlayPreparationWaiter;
    readonly ready: Promise<() => void>;
  } {
    if (
      this.#transcriptOverlayPreparationWaiters.length >= MAX_TRANSCRIPT_OVERLAY_PREPARATION_WAITERS
    ) {
      throw new TranscriptOverlayCapacityError(
        'Runtime Host transcript overlay preparation queue reached its limit',
      );
    }
    let resolve!: (release: () => void) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<() => void>((resolveReady, rejectReady) => {
      resolve = resolveReady;
      reject = rejectReady;
    });
    const waiter: TranscriptOverlayPreparationWaiter = {
      cancelled: false,
      granted: false,
      resolve,
      reject,
    };
    this.#transcriptOverlayPreparationWaiters.push(waiter);
    this.#drainTranscriptOverlayPreparationWaiters();
    return { waiter, ready };
  }

  #releaseTranscriptOverlayPreparation(): void {
    this.#preparingTranscriptOverlayBytes -= MAX_TRANSCRIPT_OVERLAY_PREPARATION_BYTES;
    this.#drainTranscriptOverlayPreparationWaiters();
  }

  #drainTranscriptOverlayPreparationWaiters(): void {
    if (this.#closed) return;
    while (this.#transcriptOverlayPreparationWaiters.length > 0) {
      const waiter = this.#transcriptOverlayPreparationWaiters[0]!;
      if (waiter.cancelled) {
        this.#transcriptOverlayPreparationWaiters.shift();
        continue;
      }
      if (
        this.#retainedTranscriptOverlayBytes + MAX_TRANSCRIPT_OVERLAY_PREPARATION_BYTES >
        MAX_RETAINED_TRANSCRIPT_OVERLAY_BYTES
      ) {
        if (this.#preparingTranscriptOverlayBytes > 0) return;
        this.#transcriptOverlayPreparationWaiters.shift();
        waiter.cancelled = true;
        waiter.reject(
          new TranscriptOverlayCapacityError('Runtime Host transcript overlay capacity reached'),
        );
        continue;
      }
      if (
        this.#retainedTranscriptOverlayBytes +
          this.#preparingTranscriptOverlayBytes +
          MAX_TRANSCRIPT_OVERLAY_PREPARATION_BYTES >
        MAX_RETAINED_TRANSCRIPT_OVERLAY_BYTES
      ) {
        return;
      }
      this.#transcriptOverlayPreparationWaiters.shift();
      waiter.granted = true;
      this.#preparingTranscriptOverlayBytes += MAX_TRANSCRIPT_OVERLAY_PREPARATION_BYTES;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#releaseTranscriptOverlayPreparation();
      });
    }
  }

  #cancelTranscriptOverlayPreparation(waiter: TranscriptOverlayPreparationWaiter): void {
    if (waiter.cancelled) return;
    waiter.cancelled = true;
    if (!waiter.granted) {
      const index = this.#transcriptOverlayPreparationWaiters.indexOf(waiter);
      if (index >= 0) this.#transcriptOverlayPreparationWaiters.splice(index, 1);
      waiter.reject(new Error('Session transcript overlay preparation was cancelled'));
      this.#drainTranscriptOverlayPreparationWaiters();
    }
  }

  #cancelTranscriptOverlayPreparationWaiters(): void {
    for (const waiter of this.#transcriptOverlayPreparationWaiters.splice(0)) {
      waiter.cancelled = true;
      waiter.reject(new Error('Session continuity coordinator is closed'));
    }
  }

  #registerTranscriptOverlay(messages: readonly Buffer[]): RetainedTranscriptOverlay {
    const bytes = messages.reduce((total, message) => total + message.byteLength, 0);
    if (this.#retainedTranscriptOverlayBytes + bytes > MAX_RETAINED_TRANSCRIPT_OVERLAY_BYTES) {
      throw new TranscriptOverlayCapacityError('Runtime Host transcript overlay capacity reached');
    }
    const retained = { messages, bytes, references: 1 };
    this.#retainedTranscriptOverlays.set(messages, retained);
    this.#retainedTranscriptOverlayBytes += bytes;
    return retained;
  }

  #retainTranscriptOverlay(retained: RetainedTranscriptOverlay): void {
    if (
      retained.references < 1 ||
      this.#retainedTranscriptOverlays.get(retained.messages) !== retained
    ) {
      throw new Error('Session transcript overlay is no longer retained');
    }
    retained.references += 1;
  }

  #releaseTranscriptOverlay(retained: RetainedTranscriptOverlay): void {
    if (retained.references < 1) return;
    retained.references -= 1;
    if (retained.references > 0) return;
    this.#retainedTranscriptOverlays.delete(retained.messages);
    this.#retainedTranscriptOverlayBytes -= retained.bytes;
    this.#drainTranscriptOverlayPreparationWaiters();
  }

  #invalidateTranscriptOverlay(
    state: SessionProjectionState,
    expected?: CachedTranscriptOverlay,
  ): void {
    const cached = state.transcriptOverlay;
    if (!cached || (expected && cached !== expected)) return;
    state.transcriptOverlay = undefined;
    cached.cancelPreparation();
    void cached.prepared.then(
      (retained) => this.#releaseTranscriptOverlay(retained),
      () => undefined,
    );
  }

  #hasTranscriptOverlayConsumer(state: SessionProjectionState): boolean {
    return (
      (state.transcriptOverlay?.pendingConsumers ?? 0) > 0 ||
      [...state.subscribers.values()].some(
        (subscriber) => subscriber.retainedTranscriptOverlay !== undefined,
      )
    );
  }

  async #refreshTranscriptHighWater(
    sessionId: string,
    state: SessionProjectionState,
  ): Promise<void> {
    if (!this.#transcriptReader || state.subscribers.size === 0) return;
    if (![...state.subscribers.values()].some((subscriber) => subscriber.transcript)) return;
    const throughSequence = await this.#transcriptReader.readDurableHighWater(sessionId);
    for (const subscriber of state.subscribers.values()) {
      if (
        !subscriber.transcript ||
        !updateSubscriberTranscriptHighWater(subscriber.transcript, throughSequence) ||
        throughSequence === null
      ) {
        continue;
      }
      const frame: SessionTranscriptAdvancedFrame = {
        kind: 'subscription.transcript_advanced',
        hostEpoch: this.#hostEpoch,
        subscriptionId: subscriber.subscriptionId,
        sequence: subscriber.nextSequence,
        sessionId,
        throughSequence,
      };
      this.#enqueue(subscriber, frame);
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
    connection.resolveClosed();
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
      encodedBytes = encodeProtocolMessage(frame).byteLength;
    } catch {
      this.#evictSlowSubscriber(subscriber);
      return;
    }
    const terminalBytes = terminalFrameByteBudget(subscriber, this.#hostEpoch);
    // Assistant text/thinking floods arrive far faster than the
    // one-awaited-send-at-a-time flush can drain them, and the queue budget
    // exists to bound memory, not to force eviction. Fold a delta into the
    // queued tail when it continues the same stream: projectors apply deltas
    // by absolute startOffset, so a merged frame carries byte-identical
    // content, and the absorbed frame never spends a sequence, keeping later
    // frames contiguous. The in-flight head frame is never touched.
    const tail = subscriber.queue[subscriber.queue.length - 1];
    if (tail && (!subscriber.pumping || subscriber.queue.length > 1)) {
      const mergedText = mergeableAssistantDeltaText(tail.frame, frame);
      if (mergedText !== undefined && tail.frame.kind === 'subscription.session_delta') {
        const merged: SubscriptionFrame = {
          ...tail.frame,
          delta: { ...tail.frame.delta, text: mergedText },
        };
        const mergedEncodedBytes = encodeProtocolMessage(merged).byteLength;
        // Merging must preserve the wire invariants the split path
        // guarantees per frame: the decoder rejects a delta text beyond
        // SESSION_LIVE_DELTA_MAX_BYTES and any subscription frame beyond
        // SESSION_SUBSCRIPTION_FRAME_MAX_BYTES, so an oversized merge would
        // break the very subscription coalescing tries to preserve. Keep
        // the next delta as its own frame instead.
        if (
          Buffer.byteLength(mergedText, 'utf8') <= SESSION_LIVE_DELTA_MAX_BYTES &&
          mergedEncodedBytes <= SESSION_SUBSCRIPTION_FRAME_MAX_BYTES &&
          subscriber.queuedBytes - tail.encodedBytes + mergedEncodedBytes + terminalBytes <=
            MAX_SUBSCRIBER_QUEUED_BYTES
        ) {
          tail.frame = merged;
          subscriber.queuedBytes += mergedEncodedBytes - tail.encodedBytes;
          tail.encodedBytes = mergedEncodedBytes;
          return;
        }
      }
    }
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
    const encodedBytes = encodeProtocolMessage(frame).byteLength;
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
    this.#enqueueAssistantText(subscriber, sessionId, runId, event, kind, startOffset, event.text);
  }

  #enqueueAssistantCompletion(
    subscriber: Subscriber,
    sessionId: string,
    runId: string,
    current: Pick<ActiveAssistantStream, 'turnId' | 'messageId' | 'text'>,
    kind: SessionAssistantDelta['kind'],
    finalText: string,
  ): void {
    const extendsPrefix = finalText.startsWith(current.text);
    const suffix = extendsPrefix ? finalText.slice(current.text.length) : finalText;
    if (suffix) {
      this.#enqueueAssistantText(
        subscriber,
        sessionId,
        runId,
        current,
        kind,
        extendsPrefix ? current.text.length : 0,
        suffix,
        !extendsPrefix,
      );
    }
    if (subscriber.phase !== 'open') return;
    this.#enqueue(subscriber, {
      kind: 'subscription.session_delta',
      hostEpoch: this.#hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence,
      sessionId,
      delta: {
        kind,
        turnId: current.turnId,
        runId,
        messageId: current.messageId,
        startOffset: finalText.length,
        text: '',
        ...(!extendsPrefix && finalText.length === 0 ? { reset: true as const } : {}),
        complete: true,
      },
    });
  }

  #enqueueAssistantText(
    subscriber: Subscriber,
    sessionId: string,
    runId: string,
    event: Pick<ActiveAssistantStream, 'turnId' | 'messageId' | 'text'>,
    kind: SessionAssistantDelta['kind'],
    startOffset: number,
    text: string,
    reset = false,
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
        ...(reset && emittedCharacters === 0 ? { reset: true } : {}),
      },
    });
    let wireLimit = wireTextByteLimit(frame(''));
    for (const character of text) {
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
    const encodedBytes = encodeProtocolMessage(frame).byteLength;
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
    this.#connections
      .get(subscriber.connectionId)
      ?.subscriptionIds.delete(subscriber.subscriptionId);
    this.#releaseSubscriberTranscriptOverlay(subscriber);
    if (!this.#closed && state && removed) {
      if (!this.#hasTranscriptOverlayConsumer(state)) this.#invalidateTranscriptOverlay(state);
      if (state.subscribers.size === 0) {
        this.#scheduleInactiveStateCleanup(subscriber.sessionId, state);
      }
    }
  }

  #releaseSubscriberTranscriptOverlay(subscriber: Subscriber): void {
    if (subscriber.transcript) subscriber.transcript.overlayMessages = undefined;
    const retained = subscriber.retainedTranscriptOverlay;
    if (!retained) return;
    subscriber.retainedTranscriptOverlay = undefined;
    this.#releaseTranscriptOverlay(retained);
    const state = this.#sessions.get(subscriber.sessionId);
    if (state && !this.#hasTranscriptOverlayConsumer(state)) {
      this.#invalidateTranscriptOverlay(state);
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
        this.#invalidateTranscriptOverlay(state);
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
        assistantStreams: new Map(),
        toolResultPreviews: new Map(),
      };
      this.#sessions.set(sessionId, state);
      return { changed: true, state, value };
    }
    canonical = preserveProviderRetry(state.canonical, canonical);
    const changed = !isDeepStrictEqual(state.canonical, canonical);
    if (changed) {
      if (state.canonical.rootTurn?.runId !== canonical.rootTurn?.runId) {
        state.assistantStreams.clear();
        state.toolResultPreviews.clear();
      }
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

  #publishCanonical(state: SessionProjectionState, canonical: CanonicalSessionProjection): void {
    if (isDeepStrictEqual(state.canonical, canonical)) return;
    const nextRevision = state.revision + 1;
    const snapshot = createSessionContinuitySnapshot(canonical, nextRevision);
    state.canonical = immutableClone(canonical);
    state.revision = nextRevision;
    this.#broadcastProjection(state, snapshot);
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
  return encodeProtocolMessage({
    kind: 'subscription.closed',
    hostEpoch,
    subscriptionId: subscriber.subscriptionId,
    sequence: subscriber.nextSequence + 1,
    reason: 'slow_consumer',
  }).byteLength;
}

function assistantStreamKey(kind: SessionAssistantDelta['kind'], messageId: string): string {
  return `${kind}\0${messageId}`;
}

function transcriptSubscriptionNotFound(): OperationOutcome<'session.transcript.page'> {
  return {
    ok: false,
    error: { code: 'not_found', message: 'Session subscription was not found' },
  };
}

function terminalFrameByteBudget(subscriber: Subscriber, hostEpoch: string): number {
  return Math.max(
    slowConsumerFrameBytes(subscriber, hostEpoch),
    encodeProtocolMessage({
      kind: 'subscription.closed',
      hostEpoch,
      subscriptionId: subscriber.subscriptionId,
      sequence: subscriber.nextSequence + 1,
      reason: 'session_removed',
    }).byteLength,
  );
}

/**
 * Returns the concatenated text when `next` continues `tail`'s assistant
 * stream contiguously, making the two frames safe to ship as one. Reset and
 * completion frames never merge: a reset must land on its own boundary and a
 * completion closes the stream.
 */
function mergeableAssistantDeltaText(
  tail: SubscriptionFrame,
  next: SubscriptionFrame,
): string | undefined {
  if (tail.kind !== 'subscription.session_delta' || next.kind !== 'subscription.session_delta')
    return undefined;
  const a = tail.delta;
  const b = next.delta;
  if (
    a.kind !== b.kind ||
    a.turnId !== b.turnId ||
    a.runId !== b.runId ||
    a.messageId !== b.messageId
  )
    return undefined;
  if (a.complete === true || b.complete === true || a.reset === true || b.reset === true)
    return undefined;
  if (a.startOffset + a.text.length !== b.startOffset) return undefined;
  return a.text + b.text;
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

function isLiveTurn(turn: TurnSnapshot): turn is LiveTurnSnapshot {
  return !isTerminalTurn(turn);
}

function withProviderRetry(
  canonical: CanonicalSessionProjection,
  event: Extract<SessionEvent, { type: 'provider_retry' }>,
): CanonicalSessionProjection {
  const rootTurn = canonical.rootTurn;
  if (!rootTurn || !isLiveTurn(rootTurn)) return canonical;
  const providerRetry: TurnProviderRetry =
    event.phase === 'scheduled'
      ? {
          phase: 'scheduled',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.reason,
        }
      : {
          phase: 'started',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          reason: event.reason,
        };
  return { ...canonical, rootTurn: { ...rootTurn, providerRetry } };
}

function withoutProviderRetry(canonical: CanonicalSessionProjection): CanonicalSessionProjection {
  const rootTurn = canonical.rootTurn;
  if (!rootTurn || !isLiveTurn(rootTurn) || rootTurn.providerRetry === undefined) {
    return canonical;
  }
  const { providerRetry: _providerRetry, ...cleared } = rootTurn;
  return { ...canonical, rootTurn: cleared };
}

function preserveProviderRetry(
  current: CanonicalSessionProjection,
  next: CanonicalSessionProjection,
): CanonicalSessionProjection {
  const currentTurn = current.rootTurn;
  const nextTurn = next.rootTurn;
  if (
    !currentTurn ||
    !nextTurn ||
    !isLiveTurn(currentTurn) ||
    !isLiveTurn(nextTurn) ||
    currentTurn.runId !== nextTurn.runId ||
    currentTurn.turnId !== nextTurn.turnId ||
    currentTurn.providerRetry === undefined
  ) {
    return next;
  }
  if (nextTurn.providerRetry !== undefined) return next;
  return { ...next, rootTurn: { ...nextTurn, providerRetry: currentTurn.providerRetry } };
}

function wireTextByteLimit(frame: SessionDeltaFrame): number {
  return RUNTIME_HOST_MAX_MESSAGE_BYTES - encodeProtocolMessage(frame).byteLength;
}

function subscriptionOpenTranscriptBudget(result: SubscriptionOpenResult): number {
  const withoutTranscriptBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  // Replacing the JSON literal null with the bootstrap object preserves every
  // other byte in the result.
  return SUBSCRIPTION_OPEN_RESULT_MAX_BYTES - withoutTranscriptBytes + 4;
}

function jsonStringContentBytes(value: string): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded.slice(1, -1), 'utf8');
}

function projectToolEvent(
  event: Exclude<
    RuntimeSessionTransientEvent,
    {
      type:
        | 'text_delta'
        | 'thinking_delta'
        | 'text_complete'
        | 'thinking_complete'
        | 'provider_retry';
    }
  >,
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
        ...(event.isError && event.content.kind === 'text' && event.content.sandboxFailure
          ? { sandboxFailureReason: event.content.sandboxFailure.reason }
          : {}),
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

function signal(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
