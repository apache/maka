/**
 * AgentBackend contract types.
 *
 * The `AgentBackend` port interface and the request/response shapes that
 * cross the runtime boundary live here in @maka/core so that every backend
 * implementation (AiSdkBackend / PiAgentBackend / FakeBackend) and their
 * consumers depend on a small pure-type module, not on a concrete backend
 * implementation file.
 */

import type {
  AnyPermissionRequestEvent,
  AttachmentRef,
  MessageContent,
  QuoteRef,
  SessionEvent,
  UserQuestionRequestEvent,
} from './events.js';
import type { InteractionClosureReason } from './interaction.js';
import type { RuntimeEvent } from './runtime-event.js';
import type { StoredMessage, BackendKind } from './session.js';
import type { PermissionResponse } from './permission.js';
import type { UserQuestionResponse } from './user-question.js';
import type { ContextBudgetDiagnostic } from './usage-stats/types.js';
import type { EffectiveOrchestration } from './orchestration.js';

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
  /** Trusted effective orchestration snapshot for this run. */
  orchestration?: EffectiveOrchestration;
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
   * continuing the same turn. Absent for callers that do not steer (child
   * agents, benchmarks).
   */
  pullSteering?: () => readonly SteeringLease[];
  /** Confirm delivery of leased steering messages (see pullSteering). */
  ackSteering?: (leaseIds: readonly string[]) => void;
  /** Return undelivered leased steering messages to the queue (see pullSteering). */
  nackSteering?: (leaseIds: readonly string[]) => void;
  /** Exact hosted-Run Interaction authority. Omitted for embedded execution. */
  hostedInteraction?: HostedInteractionBridge;
}

export interface HostedPermissionAnswer {
  readonly requestId?: never;
  readonly decision: PermissionResponse['decision'];
  readonly rememberForTurn?: boolean;
  readonly reviewer?: PermissionResponse['reviewer'];
  readonly riskLevel?: PermissionResponse['riskLevel'];
}

export interface HostedUserQuestionAnswer {
  readonly requestId?: never;
  readonly answers: UserQuestionResponse['answers'];
}

export interface HostedPermissionSettlement {
  applyAnswer(answer: HostedPermissionAnswer): Promise<void>;
  applyClosure(reason: InteractionClosureReason): Promise<void>;
}

export interface HostedUserQuestionSettlement {
  applyAnswer(answer: HostedUserQuestionAnswer): Promise<void>;
  applyClosure(reason: Exclude<InteractionClosureReason, 'timed_out'>): Promise<void>;
}

export type HostedPermissionAdmission =
  | { readonly state: 'pending' }
  | { readonly state: 'settled' };

/**
 * Optional producer capability scoped to one exact hosted Run. Admission must
 * complete before a backend publishes the request or starts any local winner.
 */
export interface HostedInteractionBridge {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;

  admitPermissionRequest(input: {
    request: AnyPermissionRequestEvent;
    rememberScopeId?: string;
    settlement: HostedPermissionSettlement;
  }): Promise<HostedPermissionAdmission>;

  commitPermissionAnswer(input: {
    requestId: string;
    answer: HostedPermissionAnswer;
  }): Promise<void>;

  commitPermissionTimeout(input: { requestId: string }): Promise<void>;

  admitUserQuestionRequest(input: {
    request: UserQuestionRequestEvent;
    settlement: HostedUserQuestionSettlement;
  }): Promise<void>;
}

/** One leased steering message: queue identity + canonical user content. */
export interface SteeringLease {
  /** Stable user-message identity shared with the durable steering event. */
  messageId: string;
  /** Ephemeral delivery lease identity used only for ack/nack settlement. */
  id: string;
  content: MessageContent;
}

/** Alias for clarity at the backend boundary. */
export type PermissionDecision = PermissionResponse;

export interface BackendCompactHistoryInput {
  turnId: string;
  runtimeContext: readonly RuntimeEvent[];
}

export interface BackendCompactHistoryResult {
  contextBudget?: ContextBudgetDiagnostic;
}

export type BackendStopMode = 'immediate' | 'after_step';

/**
 * The session-event vocabulary a backend may produce. `queue_update` has
 * exactly one legal producer — the runtime kernel, which pushes it directly
 * into the turn stream, never through a backend — so a backend-yielded one is
 * forged queue state and the flow drops it at the ingress (not mapped, not
 * forwarded, not persisted). `send` stays typed as `SessionEvent` for
 * implementation ergonomics; the ingress drop enforces the vocabulary.
 */
export type BackendSessionEvent = Exclude<
  SessionEvent,
  Extract<SessionEvent, { type: 'queue_update' }>
>;

export interface AgentBackend {
  readonly kind: BackendKind;
  readonly sessionId: string;
  send(input: BackendSendInput): AsyncIterable<SessionEvent>;
  compactHistory?(input: BackendCompactHistoryInput): Promise<BackendCompactHistoryResult>;
  stop(reason: 'user_stop' | 'redirect', mode?: BackendStopMode): Promise<void>;
  respondToPermission(decision: PermissionDecision): Promise<void>;
  respondToUserQuestion?(response: UserQuestionResponse): Promise<void>;
  dispose(): Promise<void>;
}
