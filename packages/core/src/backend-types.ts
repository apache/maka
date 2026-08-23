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

/**
 * AgentBackend contract types.
 *
 * The `AgentBackend` port interface and the request/response shapes that
 * cross the runtime boundary live here in @maka/core so that every backend
 * implementation (AiSdkBackend / FakeBackend) and their
 * consumers depend on a small pure-type module, not on a concrete backend
 * implementation file.
 */

import type {
  AttachmentRef,
  MessageContent,
  QuoteRef,
  SessionEvent,
  SandboxBoundaryRequestEvent,
  UserQuestionRequestEvent,
} from './events.js';
import type { InteractionClosureReason } from './interaction.js';
import type { RuntimeEvent } from './runtime-event.js';
import type { SandboxBoundaryResponse, SandboxBoundarySettlement } from './sandbox-boundary.js';
import type { StoredMessage, PersistedBackendKind } from './session.js';
import type { UserQuestionResponse } from './user-question.js';
import type { ContextBudgetDiagnostic } from './usage-stats/types.js';
import type { EffectiveOrchestration } from './orchestration.js';
import type { ToolMode } from './tool-mode.js';

export interface RuntimeContinuationMetadata {
  sourceInvocationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  sourceRuntimeEventHighWater: number;
}

export interface BackendSendInput {
  /** Durable invocation spine id; distinct from runId for continuations. */
  invocationId?: string;
  /** AgentRun id for this invocation, when the caller has a run ledger. */
  runId?: string;
  /** Caller-generated turn id shared by the persisted UserMessage and every emitted event. */
  turnId: string;
  /** Trusted per-turn cap on provider tool-call steps. */
  maxSteps?: number;
  /** Trusted effective orchestration snapshot for this run. */
  orchestration?: EffectiveOrchestration;
  /** Trusted per-run tool protocol override. Direct remains the default. */
  toolMode?: ToolMode;
  /**
   * The persisted initial user RuntimeEvent for this turn (the head anchor).
   * Mid-turn capacity compaction keeps this event verbatim in every projection
   * and needs its exact ledger identity for replay-checkable coverage.
   */
  headAnchorRuntimeEvent?: RuntimeEvent;
  text: string;
  attachments?: AttachmentRef[];
  /** Inline quoted excerpts folded into the model-facing user content. */
  quotes?: QuoteRef[];
  /**
   * Prior conversation projected from the RuntimeEvent ledger into the
   * existing StoredMessage public shape. Adapters materialize this into the
   * SDK's expected conversation shape when native RuntimeEvent replay is not
   * available.
   */
  context: StoredMessage[];
  /**
   * Optional prior RuntimeEvent ledger for model-history projection. Backends
   * prefer this when supplied and usable; `context` is the RuntimeEvent-derived
   * compatibility projection.
   */
  runtimeContext?: RuntimeEvent[];
  /** Continue from an already committed RuntimeEvent boundary without adding another user turn. */
  continuation?: RuntimeContinuationMetadata;
  /**
   * Steering pull — a LEASE, and the single atomic commit point of delivery.
   * Backends that support mid-turn steering call this at every step boundary;
   * each returned message moves to the caller's in-flight set, where it still
   * counts as pending but is past the user-retract point: it settles only by
   * durability — `ackSteering` when the echoed `steering_message` event is
   * durably persisted AND in the injection set, `nackSteering` when it
   * provably never persisted (never pushed, or the consumer detached first);
   * the dying request never carries a nacked message. Each acked message is
   * injected into the model context wrapped in a steering envelope,
   * continuing the same turn. Absent for callers that do not steer, including
   * child agents and non-interactive clients.
   */
  pullSteering?: () => readonly SteeringLease[];
  /** Confirm delivery of leased steering messages (see pullSteering). */
  ackSteering?: (leaseIds: readonly string[]) => void;
  /** Return undelivered leased steering messages to the queue (see pullSteering). */
  nackSteering?: (leaseIds: readonly string[]) => void;
  /** Exact hosted-Run Interaction authority. Omitted for embedded execution. */
  hostedInteraction?: HostedInteractionBridge;
}

export interface HostedUserQuestionAnswer {
  readonly requestId?: never;
  readonly answers: UserQuestionResponse['answers'];
}

export interface HostedUserQuestionSettlement {
  applyAnswer(answer: HostedUserQuestionAnswer): Promise<void>;
  applyClosure(reason: Exclude<InteractionClosureReason, 'timed_out'>): Promise<void>;
}

export interface HostedSandboxBoundarySettlement {
  applyDecision(settlement: SandboxBoundarySettlement): Promise<void>;
  applyClosure(reason: Exclude<InteractionClosureReason, 'timed_out'>): Promise<void>;
}

/**
 * Optional producer capability scoped to one exact hosted Run. Admission must
 * complete before a backend publishes the request or starts any local winner.
 */
export interface HostedInteractionBridge {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;

  admitUserQuestionRequest(input: {
    request: UserQuestionRequestEvent;
    settlement: HostedUserQuestionSettlement;
  }): Promise<void>;
  admitSandboxBoundaryRequest(input: {
    request: SandboxBoundaryRequestEvent;
    settlement: HostedSandboxBoundarySettlement;
  }): Promise<void>;
}

/** One leased steering message: queue identity + canonical user content. */
export interface SteeringLease {
  /** Stable user-message identity shared with the durable steering event. */
  messageId: string;
  /** Ephemeral delivery lease identity used only for ack/nack settlement. */
  id: string;
  content: MessageContent;
  /** Digest of the canonical user submission before host-side preparation. */
  submittedContentDigest?: `sha256:${string}`;
}

export interface BackendCompactHistoryInput {
  turnId: string;
  /**
   * The run this compaction belongs to. Required, not optional: a manual
   * compaction is a real model call, and a call whose run cannot be named is a
   * call nothing can bill (#1679). Unlike `send`, this path has no turn state to
   * infer it from, so the caller that opened the run states it.
   */
  runId: string;
  runtimeContext: readonly RuntimeEvent[];
  /** Override the configured recent-turn tail for an explicit recovery compaction. */
  minRecentTurns?: number;
}

export interface BackendCompactHistoryResult {
  contextBudget?: ContextBudgetDiagnostic;
}

export type BackendStopMode = 'immediate' | 'after_step';

/**
 * The live session-event vocabulary accepted from a backend. `queue_update`
 * belongs to the runtime kernel, while legacy permission requests and
 * acknowledgements were replaced by sandbox-boundary events. `send` stays
 * typed as `SessionEvent` for implementation ergonomics; the flow drops these
 * retired variants at ingress so they are never mapped, observed, or persisted
 * by a new run.
 */
export type BackendSessionEvent = Exclude<
  SessionEvent,
  Extract<
    SessionEvent,
    {
      type:
        | 'queue_update'
        | 'permission_request'
        | 'permission_answer_ack'
        | 'permission_closure_ack'
        | 'permission_decision_ack';
    }
  >
>;

export interface AgentBackend {
  readonly kind: PersistedBackendKind;
  readonly sessionId: string;
  send(input: BackendSendInput): AsyncIterable<SessionEvent>;
  compactHistory?(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult>;
  stop(reason: 'user_stop' | 'redirect', mode?: BackendStopMode): Promise<void>;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion?(response: UserQuestionResponse): Promise<void>;
  dispose(): Promise<void>;
}
