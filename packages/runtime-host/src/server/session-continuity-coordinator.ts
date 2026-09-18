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
import { projectToolArgsPreview } from '@maka/core/tool-quiet-preview';
import { resolveReadInput } from '@maka/runtime/read-page';
import {
  decodeRuntimeResourceRef,
  encodeProtocolMessage,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES,
  SESSION_RUNTIME_RESOURCE_CHANGES_MAX,
  SESSION_SUBSCRIPTION_FRAME_MAX_BYTES,
  SUBSCRIPTION_OPEN_RESULT_MAX_BYTES,
  SESSION_TOOL_ARGS_PREVIEW_MAX_BYTES,
  SESSION_TOOL_INTENT_MAX_BYTES,
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
  type OrderedSubscriptionFrame,
  type SessionSteeringEvent,
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
import type {
  ConnectionContext,
  SessionContinuityOperationHandlerMap,
} from './operation-dispatcher.js';
import type { RuntimeHostAccessAuthority } from './access-authority.js';
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
  readSessionTranscriptPage,
  type SubscriberTranscriptState,
  TranscriptPageRequestError,
  updateSubscriberTranscriptHighWater,
} from './session-transcript-pager.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import { projectSharedSessionMessageContent } from './shared-session-transcript.js';

const MAX_CONNECTION_SUBSCRIPTIONS = 16;
const MAX_SUBSCRIBER_QUEUED_FRAMES = 32;
const MAX_SUBSCRIBER_QUEUED_BYTES = 256 * 1024;
const ASSISTANT_BACKLOG_CHUNK_CHARACTERS = 8 * 1024;

export type { CanonicalSessionProjection } from './canonical-session-projection.js';

export type RuntimeSessionForwardedEvent = Extract<
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
      | 'steering_message'
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
  /**
   * Latest live tool_result_preview per toolUseId for the active turn.
   * Replace semantics; cleared on tool_result and terminal publication.
   * Seeded to new subscribers so mid-flight Open survives rejoin.
   */
  toolResultPreviews: Map<
    string,
    Extract<RuntimeSessionForwardedEvent, { type: 'tool_result_preview' }>
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
}

interface QueuedSubscriptionFrame {
  frame: OrderedSubscriptionFrame;
  encodedBytes: number;
}

interface Subscriber {
  connectionId: string;
  principalId: string;
  principalKind: NonNullable<ConnectionContext['principalKind']>;
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
  ptyQueue: { frame: SessionRuntimeResourcePtyDataFrame; encodedBytes: number }[];
  ptyQueuedBytes: number;
  ptyPumping: boolean;
  ptyInterests: Set<string>;
  terminalQueued: boolean;
  transcript?: SubscriberTranscriptState;
  /**
   * Streams that were already running when this subscriber opened. Their text
   * is paid out as the queue drains, so a long stream cannot overflow the queue.
   */
  assistantBacklog: Map<string, AssistantBacklog>;
  /**
   * Work that arrived while a backlog was still unpaid. A subscriber has one
   * delivery order, so anything produced after the text it is catching up on
   * waits here instead of overtaking it.
   */
  deferred: Array<() => void>;
}

interface AssistantBacklog {
  /** Characters of the stream this subscriber has been sent. */
  sent: number;
  /** Set when the stream completed before the subscriber caught up. */
  completion?: { runId: string; stream: ActiveAssistantStream; interrupted?: true };
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
    'subscription.pty_interest.set': async (input, context) => {
      const subscriber = this.#ownedSubscriber(context.connectionId, input.subscriptionId);
      if (!subscriber || !this.#canObserve(subscriber, subscriber.sessionId)) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Session subscription was not found' },
        };
      }
      subscriber.ptyInterests = new Set(input.refs);
      // An already writing frame may finish. Everything else belongs to the
      // current visible set; reacquiring uses a fresh terminal snapshot.
      subscriber.ptyQueue = subscriber.ptyQueue.filter(
        (entry, index) =>
          (index === 0 && subscriber.ptyPumping) || subscriber.ptyInterests.has(entry.frame.ref),
      );
      subscriber.ptyQueuedBytes = subscriber.ptyQueue.reduce(
        (bytes, entry) => bytes + entry.encodedBytes,
        0,
      );
      return { ok: true, result: { subscriptionId: input.subscriptionId } };
    },
    'subscription.open': async (input, context) => {
      const result = await this.#open(context, input);
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
    'subscription.ready': async (input, context) => {
      if (!this.#ownedSubscriber(context.connectionId, input.subscriptionId)) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Session subscription was not found' },
        };
      }
      this.#activate(context.connectionId, input.subscriptionId);
      return { ok: true, result: { subscriptionId: input.subscriptionId } };
    },
    'session.transcript.page': (input, context) =>
      this.#readTranscriptPage(context.connectionId, input),
  };

  readonly #connections = new Map<string, ConnectionState>();
  readonly #sessions = new Map<string, SessionProjectionState>();
  readonly #subscriptions = new Map<string, Subscriber>();
  readonly #pendingRefreshes = new Map<string, PendingRefresh>();
  readonly #pendingAgentGraphChanges = new Map<string, PendingAgentGraphChange>();
  readonly #pendingSessionDomainChanges = new Map<string, PendingSessionDomainChanges>();
  readonly #pendingTranscriptAdvances = new Map<string, PendingRefresh>();
  readonly #hostEpoch: string;
  readonly #readCanonical: ReadCanonicalSessionProjection;
  readonly #transcriptReader: SessionTranscriptReader | undefined;
  #closed = false;
  readonly #sessionAccessAuthority:
    | Pick<RuntimeHostAccessAuthority, 'activeSessionGrant' | 'subscribeGrantRevocations'>
    | undefined;
  readonly #unsubscribeGrantRevocations: (() => void) | undefined;

  constructor(
    hostEpoch: string,
    readCanonical: ReadCanonicalSessionProjection,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly onPublicationFailure: (error: unknown) => void = () => undefined,
    transcriptReader?: SessionTranscriptReader,
    private readonly onCatalogChanged: (sessionId: string) => void = () => undefined,
    sessionAccessAuthority?: Pick<
      RuntimeHostAccessAuthority,
      'activeSessionGrant' | 'subscribeGrantRevocations'
    >,
  ) {
    this.#hostEpoch = hostEpoch;
    this.#readCanonical = readCanonical;
    this.#transcriptReader = transcriptReader;
    this.#sessionAccessAuthority = sessionAccessAuthority;
    this.#unsubscribeGrantRevocations = sessionAccessAuthority?.subscribeGrantRevocations(
      (grant) => {
        if (grant.kind !== 'session_observation') return;
        for (const subscriber of this.#subscriptions.values()) {
          if (
            subscriber.principalId === grant.principalId &&
            subscriber.sessionId === grant.sessionId
          ) {
            this.#closeSubscriber(subscriber, 'access_revoked');
          }
        }
      },
    );
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

  /** Safe for synchronous commit hooks: publishes the transcript high water after RuntimeEvents commit. */
  enqueueTranscriptAdvanced(sessionId: string): void {
    if (this.#closed || !this.#sessions.has(sessionId)) return;
    const pending = this.#pendingTranscriptAdvances.get(sessionId);
    if (pending) {
      if (pending.inFlight) pending.dirty = true;
      return;
    }
    const advance: PendingRefresh = { dirty: false, inFlight: false };
    this.#pendingTranscriptAdvances.set(sessionId, advance);
    const run = async () => {
      if (this.#closed) return;
      const state = this.#sessions.get(sessionId);
      // A fenced terminal publication advances the transcript together with
      // the terminal projection, so a turn_state row never outruns its Turn.
      if (!state || state.terminalPublicationFence) return;
      await this.#refreshTranscriptHighWater(sessionId, state);
    };
    void this.sessionAdmission
      .enqueueDetached(sessionId, async () => {
        advance.inFlight = true;
        await run();
        if (!advance.dirty) return;
        advance.dirty = false;
        await run();
      })
      .then(
        () => {
          this.#pendingTranscriptAdvances.delete(sessionId);
          if (advance.dirty) this.enqueueTranscriptAdvanced(sessionId);
        },
        (error) => {
          this.#pendingTranscriptAdvances.delete(sessionId);
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
          if (subscriber.principalKind === 'session_guest') continue;
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

  /** PTY congestion never consumes Session sequence numbers or its queue budget. */
  async enqueueRuntimeResourcePtyData(event: {
    sessionId: string;
    ref: string;
    sequence: number;
    data: string;
  }): Promise<void> {
    if (this.#closed) return;
    try {
      const state = this.#sessions.get(event.sessionId);
      if (!state) return;
      for (const subscriber of state.subscribers.values()) {
        if (!this.#canObserve(subscriber, event.sessionId)) {
          this.#closeSubscriber(subscriber, 'access_revoked');
          continue;
        }
        if (!subscriber.ptyInterests.has(event.ref)) continue;
        const frame: SessionRuntimeResourcePtyDataFrame = {
          kind: 'subscription.runtime_resource_pty_data',
          hostEpoch: this.#hostEpoch,
          subscriptionId: subscriber.subscriptionId,
          sessionId: event.sessionId,
          ref: event.ref,
          ptySequence: event.sequence,
          ...(Buffer.byteLength(event.data, 'utf8') > SESSION_RUNTIME_RESOURCE_PTY_DATA_MAX_BYTES
            ? { data: '', reset: true as const }
            : { data: event.data }),
        };
        if (
          Buffer.byteLength(JSON.stringify(frame), 'utf8') <= SESSION_SUBSCRIPTION_FRAME_MAX_BYTES
        ) {
          this.#enqueuePty(subscriber, frame);
        }
      }
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
            const projected =
              change.domain === 'runtime_resource' && subscriber.principalKind === 'session_guest'
                ? {
                    ...change,
                    resources: change.resources.filter(
                      (resource) => resource.sourceSessionId === subscriber.sessionId,
                    ),
                  }
                : change;
            if (projected.domain === 'runtime_resource' && projected.resources.length === 0) {
              continue;
            }
            const frame: SessionDomainChangedFrame = {
              kind: 'subscription.session_domain_changed',
              hostEpoch: this.#hostEpoch,
              subscriptionId: subscriber.subscriptionId,
              sequence: subscriber.nextSequence,
              ...projected,
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
        state.canonical = canonical;
        state.revision = nextRevision;
        delete state.terminalPublicationFence;
        // A subscriber still being paid a stream's prefix has not seen the end
        // of it. The Turn ending does not make that text untrue, so each
        // backlog keeps its own copy of the stream and finishes paying it; the
        // terminal projection queues behind that, never over it.
        for (const subscriber of state.subscribers.values()) {
          for (const [key, backlog] of subscriber.assistantBacklog) {
            if (backlog.completion) continue;
            const stream = state.assistantStreams.get(key);
            if (!stream) {
              subscriber.assistantBacklog.delete(key);
              continue;
            }
            backlog.completion = { runId: rootTurn.runId, stream: { ...stream } };
          }
        }
        state.assistantStreams.clear();
        state.toolResultPreviews.clear();
        this.#broadcastProjection(state, snapshot);
        for (const subscriber of state.subscribers.values()) {
          this.#payAssistantBacklog(subscriber, state);
        }
        if (state.subscribers.size === 0) this.#sessions.delete(sessionId);
      },
      admission,
    );
  }

  async acceptRuntimeEvent(
    sessionId: string,
    runId: string,
    event: RuntimeSessionForwardedEvent,
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
          if (subscriber.assistantBacklog.has(prefixKey)) {
            // This text is part of the prefix still being paid out; the payout
            // reads the accumulated stream, so it carries this delta already.
            this.#payAssistantBacklog(subscriber, state);
          } else {
            this.#deliverInOrder(subscriber, () =>
              this.#enqueueAssistantDelta(subscriber, sessionId, runId, event, kind, startOffset),
            );
          }
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
            this.#completeAssistantStream(
              subscriber,
              state,
              runId,
              thinkingKey,
              thinking,
              finalThinking,
            );
          }
          state.assistantStreams.delete(thinkingKey);
        }

        const textKey = assistantStreamKey('text', event.messageId);
        const text = state.assistantStreams.get(textKey);
        if (text || event.text.length > 0 || event.interrupted) {
          const current =
            text ??
            ({
              kind: 'text',
              turnId: event.turnId,
              messageId: event.messageId,
              text: '',
            } satisfies ActiveAssistantStream);
          for (const subscriber of state.subscribers.values()) {
            this.#completeAssistantStream(
              subscriber,
              state,
              runId,
              textKey,
              current,
              event.text,
              event.interrupted,
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
      for (const subscriber of state.subscribers.values()) {
        const frame: SessionEventFrame = {
          kind: 'subscription.session_event',
          hostEpoch: this.#hostEpoch,
          subscriptionId: subscriber.subscriptionId,
          sequence: subscriber.nextSequence,
          sessionId,
          runId,
          event: projectSessionEvent(
            event,
            sessionId,
            subscriber.principalKind === 'session_guest',
          ),
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
    this.#unsubscribeGrantRevocations?.();
    for (const connectionId of [...this.#connections.keys()]) this.#closeConnection(connectionId);
    this.#sessions.clear();
    this.#subscriptions.clear();
    this.#pendingRefreshes.clear();
    this.#pendingTranscriptAdvances.clear();
    this.#pendingAgentGraphChanges.clear();
    this.#pendingSessionDomainChanges.clear();
  }

  async #open(
    context: ConnectionContext,
    input: SubscriptionOpenInput,
  ): Promise<
    | { ok: true; value: SubscriptionOpenResult }
    | {
        ok: false;
        code:
          | 'not_found'
          | 'operation_conflict'
          | 'operation_unavailable'
          | 'persistence_failed'
          | 'transcript_preparing';
        message: string;
      }
  > {
    const connectionId = context.connectionId;
    const identity = connectionIdentity(context);
    const sessionId = input.sessionId;
    const connection = this.#connections.get(connectionId);
    if (!connection) throw new Error('Runtime Host connection is not attached to continuity');
    if (!this.#canObserve(identity, sessionId)) {
      return { ok: false, code: 'not_found', message: 'Session was not found' };
    }
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
        const activeAssistantStreams = [...committed.state.assistantStreams.values()].map(
          ({ kind, turnId, messageId }) => ({ kind, turnId, messageId }),
        );
        let transcript: SubscriberTranscriptState | undefined;
        let transcriptBootstrap: SubscriptionOpenResult['transcript'] = null;
        if (input.transcript.kind === 'tail') {
          if (!this.#transcriptReader) {
            return {
              ok: false as const,
              code: 'operation_unavailable' as const,
              message: 'Session transcript is unavailable',
            };
          }
          try {
            const throughSequence = await this.#transcriptReader.readDurableHighWater(sessionId);
            const snapshot = projectSessionSnapshot(committed.value, identity.principalKind);
            const created = await createSessionTranscriptBootstrap({
              reader: this.#transcriptReader,
              sessionId,
              subscriptionId,
              throughSequence,
              maxBytes: input.transcript.maxBytes,
              projection: identity.principalKind === 'session_guest' ? 'shared' : 'owner',
              maxEncodedBytes: subscriptionOpenTranscriptBudget({
                hostEpoch: this.#hostEpoch,
                subscriptionId,
                nextSequence: 1,
                snapshot,
                activeAssistantStreams,
                transcript: null,
              }),
            });
            transcript = created.state;
            transcriptBootstrap = created.bootstrap;
          } catch (error) {
            // The client can only retry, but a projection that outgrew its
            // bounds is a Host defect and has to leave a trace here.
            this.onPublicationFailure(error);
            return {
              ok: false as const,
              code: 'persistence_failed' as const,
              message: 'Session transcript is unavailable',
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
          snapshot: projectSessionSnapshot(committed.value, identity.principalKind),
          activeAssistantStreams,
          transcript: transcriptBootstrap,
        };
        if (
          Buffer.byteLength(JSON.stringify(openValue), 'utf8') > SUBSCRIPTION_OPEN_RESULT_MAX_BYTES
        ) {
          return {
            ok: false as const,
            code: 'operation_unavailable' as const,
            message: 'Session subscription state exceeds the transport limit',
          };
        }
        if (!this.#canObserve(identity, sessionId)) {
          return {
            ok: false as const,
            code: 'not_found' as const,
            message: 'Session was not found',
          };
        }
        const subscriber: Subscriber = {
          connectionId,
          principalId: identity.principalId,
          principalKind: identity.principalKind,
          sessionId,
          subscriptionId,
          sink: connection.sink,
          phase: 'open',
          activated: false,
          nextSequence: 1,
          lastFlushedSequence: 0,
          queue: [],
          ptyQueue: [],
          ptyInterests: new Set(),
          ptyQueuedBytes: 0,
          ptyPumping: false,
          queuedBytes: 0,
          pumping: false,
          terminalQueued: false,
          assistantBacklog: new Map(
            [...committed.state.assistantStreams.keys()].map((key) => [key, { sent: 0 }]),
          ),
          deferred: [],
          ...(transcript ? { transcript } : {}),
        };
        committed.state.subscribers.set(subscriptionId, subscriber);
        this.#subscriptions.set(subscriptionId, subscriber);
        connection.subscriptionIds.add(subscriptionId);
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
              event: projectSessionEvent(
                preview,
                sessionId,
                subscriber.principalKind === 'session_guest',
              ),
            };
            this.#enqueue(subscriber, frame);
          }
        }
        this.#payAssistantBacklog(subscriber, committed.state);
        return {
          ok: true as const,
          value: { ...openValue, nextSequence: firstSequence },
        };
      });
    } finally {
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
    const connection = this.#connections.get(connectionId);
    if (!connection || !this.#canObserve(subscriber, subscriber.sessionId)) {
      this.#closeSubscriber(subscriber, 'access_revoked');
      return transcriptSubscriptionNotFound();
    }
    const transcript = subscriber.transcript;
    return this.sessionAdmission.run(subscriber.sessionId, async () => {
      if (
        this.#ownedSubscriber(connectionId, input.subscriptionId) !== subscriber ||
        this.#connections.get(connectionId) !== connection ||
        !this.#canObserve(subscriber, subscriber.sessionId)
      ) {
        return transcriptSubscriptionNotFound();
      }
      try {
        const page = await readSessionTranscriptPage({
          reader: this.#transcriptReader!,
          state: transcript,
          request: input,
        });
        if (
          this.#ownedSubscriber(connectionId, input.subscriptionId) !== subscriber ||
          this.#connections.get(connectionId) !== connection ||
          !this.#canObserve(subscriber, subscriber.sessionId)
        ) {
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
    this.#pumpPty(subscriber);
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

  #enqueue(subscriber: Subscriber, frame: OrderedSubscriptionFrame): void {
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
        const merged: OrderedSubscriptionFrame = {
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
    this.#closeSubscriber(subscriber, 'slow_consumer');
  }

  #enqueuePty(subscriber: Subscriber, frame: SessionRuntimeResourcePtyDataFrame): void {
    if (subscriber.phase !== 'open' || subscriber.terminalQueued) return;
    let encodedBytes = encodeProtocolMessage(frame).byteLength;
    if (subscriber.ptyQueue.length >= 8 || subscriber.ptyQueuedBytes + encodedBytes > 128 * 1024) {
      // Reset is session-wide for terminal consumers, so one marker covers
      // every omitted resource without an unbounded per-resource dirty set.
      const inFlight = subscriber.ptyPumping ? subscriber.ptyQueue[0] : undefined;
      subscriber.ptyQueue = inFlight ? [inFlight] : [];
      subscriber.ptyQueuedBytes = inFlight?.encodedBytes ?? 0;
      frame = { ...frame, data: '', reset: true };
      encodedBytes = encodeProtocolMessage(frame).byteLength;
    }
    subscriber.ptyQueue.push({ frame, encodedBytes });
    subscriber.ptyQueuedBytes += encodedBytes;
    this.#pumpPty(subscriber);
  }

  #pumpPty(subscriber: Subscriber): void {
    if (subscriber.ptyPumping || !subscriber.activated || subscriber.phase !== 'open') return;
    const queued = subscriber.ptyQueue[0];
    if (!queued) return;
    subscriber.ptyPumping = true;
    void Promise.resolve()
      .then(() => {
        if (subscriber.phase !== 'open') return;
        return subscriber.sink.send(queued.frame);
      })
      .then(
        () => {
          subscriber.ptyPumping = false;
          if (subscriber.ptyQueue[0] === queued) {
            subscriber.ptyQueue.shift();
            subscriber.ptyQueuedBytes -= queued.encodedBytes;
          }
          this.#pumpPty(subscriber);
        },
        () => this.#removeSubscriber(subscriber),
      );
  }

  #closeSubscriber(subscriber: Subscriber, reason: 'slow_consumer' | 'access_revoked'): void {
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
      reason,
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

  #canObserve(
    identity: { readonly principalId: string; readonly principalKind: Subscriber['principalKind'] },
    sessionId: string,
  ): boolean {
    return (
      identity.principalKind !== 'session_guest' ||
      this.#sessionAccessAuthority?.activeSessionGrant(
        identity.principalId,
        sessionId,
        'session_observation',
      ) !== undefined
    );
  }

  #enqueueAssistantDelta(
    subscriber: Subscriber,
    sessionId: string,
    runId: string,
    event: Extract<RuntimeSessionForwardedEvent, { type: 'text_delta' | 'thinking_delta' }>,
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
    interrupted?: true,
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
        ...(interrupted ? { interrupted: true } : {}),
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
        if (subscriber.assistantBacklog.size > 0) {
          const state = this.#sessions.get(subscriber.sessionId);
          if (state) this.#payAssistantBacklog(subscriber, state);
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
    subscriber.ptyQueue = [];
    subscriber.ptyQueuedBytes = 0;
    const state = this.#sessions.get(subscriber.sessionId);
    const removed = state?.subscribers.delete(subscriber.subscriptionId);
    this.#subscriptions.delete(subscriber.subscriptionId);
    this.#connections
      .get(subscriber.connectionId)
      ?.subscriptionIds.delete(subscriber.subscriptionId);
    subscriber.assistantBacklog.clear();
    subscriber.deferred = [];
    if (!this.#closed && state && removed && state.subscribers.size === 0) {
      this.#scheduleInactiveStateCleanup(subscriber.sessionId, state);
    }
  }

  /**
   * Sends a subscriber the in-flight assistant text it joined too late to see,
   * one frame at a time while its queue has room. Live deltas for such a stream
   * are withheld until the backlog catches up, so offsets stay contiguous.
   */
  #payAssistantBacklog(subscriber: Subscriber, state: SessionProjectionState): void {
    const rootTurn = state.canonical.rootTurn;
    for (const [key, backlog] of subscriber.assistantBacklog) {
      const { completion } = backlog;
      const stream = completion?.stream ?? state.assistantStreams.get(key);
      const runId = completion?.runId ?? rootTurn?.runId;
      if (!stream || !runId || (!completion && stream.turnId !== rootTurn?.turnId)) {
        subscriber.assistantBacklog.delete(key);
        continue;
      }
      while (backlog.sent < stream.text.length) {
        if (
          subscriber.phase !== 'open' ||
          subscriber.queue.length >= MAX_SUBSCRIBER_QUEUED_FRAMES / 2 ||
          subscriber.queuedBytes >= MAX_SUBSCRIBER_QUEUED_BYTES / 2
        ) {
          return;
        }
        const chunk = stream.text.slice(
          backlog.sent,
          backlog.sent + ASSISTANT_BACKLOG_CHUNK_CHARACTERS,
        );
        this.#enqueueAssistantText(
          subscriber,
          subscriber.sessionId,
          runId,
          stream,
          stream.kind,
          backlog.sent,
          chunk,
        );
        backlog.sent += chunk.length;
      }
      subscriber.assistantBacklog.delete(key);
      if (completion) {
        this.#enqueueAssistantCompletion(
          subscriber,
          subscriber.sessionId,
          runId,
          stream,
          stream.kind,
          stream.text,
          completion.interrupted,
        );
      }
    }
    this.#drainDeferred(subscriber);
  }

  #completeAssistantStream(
    subscriber: Subscriber,
    state: SessionProjectionState,
    runId: string,
    key: string,
    stream: ActiveAssistantStream,
    finalText: string,
    interrupted?: true,
  ): void {
    const backlog = subscriber.assistantBacklog.get(key);
    const held = backlog ? stream.text.slice(0, backlog.sent) : stream.text;
    if (backlog && finalText.startsWith(held)) {
      backlog.completion = {
        runId,
        stream: { ...stream, text: finalText },
        ...(interrupted ? { interrupted } : {}),
      };
      this.#payAssistantBacklog(subscriber, state);
      return;
    }
    subscriber.assistantBacklog.delete(key);
    this.#deliverInOrder(subscriber, () =>
      this.#enqueueAssistantCompletion(
        subscriber,
        subscriber.sessionId,
        runId,
        { ...stream, text: held },
        stream.kind,
        finalText,
        interrupted,
      ),
    );
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
      this.#deliverInOrder(subscriber, () => {
        this.#enqueue(subscriber, {
          kind: 'subscription.session_projection',
          hostEpoch: this.#hostEpoch,
          subscriptionId: subscriber.subscriptionId,
          sequence: subscriber.nextSequence,
          snapshot: projectSessionSnapshot(snapshot, subscriber.principalKind),
        });
      });
    }
  }

  /**
   * Runs `work` now, or behind whatever this subscriber is still catching up
   * on. Every assistant frame and projection goes through here, so the order a
   * subscriber sees is the order the Host produced.
   */
  #deliverInOrder(subscriber: Subscriber, work: () => void): void {
    if (subscriber.assistantBacklog.size === 0 && subscriber.deferred.length === 0) {
      work();
      return;
    }
    subscriber.deferred.push(work);
  }

  #drainDeferred(subscriber: Subscriber): void {
    while (
      subscriber.assistantBacklog.size === 0 &&
      subscriber.deferred.length > 0 &&
      subscriber.phase === 'open'
    ) {
      subscriber.deferred.shift()?.();
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
          ts: event.ts,
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

function connectionIdentity(context: ConnectionContext): {
  readonly principalId: string;
  readonly principalKind: Subscriber['principalKind'];
} {
  if (!context.principalKind) {
    throw new Error('Runtime Host connection has no authenticated principal kind');
  }
  return { principalId: context.principal, principalKind: context.principalKind };
}

function projectSessionSnapshot(
  snapshot: SessionContinuitySnapshot,
  principalKind: Subscriber['principalKind'],
): SessionContinuitySnapshot {
  if (principalKind !== 'session_guest') return snapshot;
  const projectEntry = <T extends { readonly content: import('@maka/core/events').MessageContent }>(
    entry: T,
  ): T => ({
    ...entry,
    content: projectSharedSessionMessageContent(entry.content, snapshot.session.sessionId),
  });
  return {
    ...snapshot,
    queue: {
      ...snapshot.queue,
      steering: snapshot.queue.steering.map(projectEntry),
      followup: snapshot.queue.followup.map(projectEntry),
    },
  };
}

function projectSessionEvent(
  event: Exclude<
    RuntimeSessionForwardedEvent,
    {
      type:
        | 'text_delta'
        | 'thinking_delta'
        | 'text_complete'
        | 'thinking_complete'
        | 'provider_retry';
    }
  >,
  sessionId: string,
  shared = false,
): SessionToolEvent | SessionSteeringEvent {
  if (event.type === 'steering_message') {
    // The durable steering echo: forwarded verbatim so subscribers render the
    // interjection in place instead of depending on observing the transient
    // in-flight queue state.
    return {
      type: 'steering_message',
      id: event.id,
      turnId: event.turnId,
      ts: event.ts,
      messageId: event.messageId,
      content: shared
        ? projectSharedSessionMessageContent(event.content, sessionId)
        : structuredClone(event.content),
    };
  }
  const identity = {
    id: event.id,
    turnId: event.turnId,
    ts: event.ts,
    toolUseId: event.toolUseId,
  };
  switch (event.type) {
    case 'tool_start': {
      const shellRunRef = toolStartShellRunRef(event);
      return {
        type: event.type,
        ...identity,
        toolName: boundedUtf8(event.toolName, SESSION_TOOL_NAME_MAX_BYTES),
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(event.activityKind === undefined ? {} : { activityKind: event.activityKind }),
        ...(event.displayName === undefined
          ? {}
          : { displayName: boundedUtf8(event.displayName, SESSION_TOOL_NAME_MAX_BYTES) }),
        ...(event.intent === undefined
          ? {}
          : { intent: boundedUtf8(event.intent, SESSION_TOOL_INTENT_MAX_BYTES) }),
        // A correlated hidden-shell poll publishes only its correlation ref:
        // the frame is deliberately minimal (#3569), so no args preview rides
        // along. Every other live tool start names itself for compact rows.
        ...(shellRunRef ? {} : projectArgsPreviewForWire(event.toolName, event.args)),
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(shellRunRef ? { shellRunRef } : {}),
      };
    }
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

/**
 * Build the wire `argsPreview` spread for a live `tool_start`. The preview is
 * computed and bounded in `@maka/core`; the extra byte check here is the
 * wire-budget guard so a formatter change cannot silently bloat frames.
 */
function projectArgsPreviewForWire(toolName: string, args: unknown): { argsPreview?: unknown } {
  const preview = projectToolArgsPreview(toolName, args);
  if (preview === undefined) return {};
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > SESSION_TOOL_ARGS_PREVIEW_MAX_BYTES) {
    return {};
  }
  return { argsPreview: preview };
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

function toolStartShellRunRef(
  event: Extract<RuntimeSessionForwardedEvent, { type: 'tool_start' }>,
): string | undefined {
  if (event.toolName !== 'Read' && event.toolName !== 'StopBackgroundTask') return undefined;
  const ref =
    event.args !== null && typeof event.args === 'object'
      ? event.toolName === 'Read'
        ? (event.args as { path?: unknown }).path
        : (event.args as { ref?: unknown }).ref
      : undefined;
  if (typeof ref !== 'string') return undefined;
  try {
    return decodeRuntimeResourceRef(resolveReadInput({ path: ref }).path);
  } catch {
    return undefined;
  }
}
