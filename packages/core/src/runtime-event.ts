/**
 * Canonical Runtime v2 event contract.
 *
 * This is the single internal runtime fact model. It is NOT a UI event
 * (see ./events.ts `SessionEvent`) and NOT a trace row (RunTrace) or
 * telemetry record. StoredMessage JSONL, renderer SessionEvent,
 * AgentRunStore operational rows, RunTrace, and TelemetryRepo are all
 * projections that should be written from -- or explicitly linked to -- these
 * events.
 *
 * Architecture: docs/architecture/runtime-core-architecture-draft.md
 *
 * Phase 1 scope: types + small pure helpers only. No storage, runner,
 * projection, or ledger logic lives here. Those arrive in later nodes.
 */

import {
  isMessageContent,
  normalizeMessageContent,
  type MessageContent,
  type PermissionClosureReason,
} from './events.js';
import { INTERACTION_ID_MAX_BYTES, INTERACTION_TOOL_NAME_MAX_BYTES } from './interaction.js';
import type { PermissionRequestPayload, PermissionResponse } from './permission.js';
import type { TurnOrigin } from './runtime-inputs.js';
import type { UserQuestionRequest } from './user-question.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalMember,
  isOptionalString,
  isRecord,
  isStringArray,
} from './record-schema.js';
import {
  isPermissionDecisionFields,
  isPermissionRequestPayload,
  isUserQuestionRequest,
} from './interaction-record-schema.js';
import { isTokenUsageFields, type TokenUsageFields } from './usage-record-schema.js';
import { isToolRecoveryFactEnvelope, type ToolRecoveryFactEnvelope } from './tool-recovery-fact.js';
import {
  isRuntimeEventWorkspaceFactEnvelope,
  type RuntimeEventWorkspaceFactEnvelope,
} from './workspace-version-authority.js';

// ============================================================================
// Role / Author / Status
// ============================================================================

/**
 * Conversation role the event plays in model history. Maps 1:1 with the
 * roles providers expect in a message history (user / model / tool /
 * system). Role is about *what lane* the content belongs to.
 */
export const RUNTIME_EVENT_ROLES = ['user', 'model', 'tool', 'system'] as const;
export type RuntimeEventRole = (typeof RUNTIME_EVENT_ROLES)[number];

export function isRuntimeEventRole(value: unknown): value is RuntimeEventRole {
  return typeof value === 'string' && (RUNTIME_EVENT_ROLES as readonly string[]).includes(value);
}

/**
 * Who authored the event inside the runtime. `agent` covers the model +
 * flow orchestration; `tool` covers tool execution; `system` covers the
 * runner, gate, and recovery. Author is about *which subsystem* produced
 * the fact, which is orthogonal to the model-history `role`.
 *
 * Not every (author, role) combination is meaningful, but the runtime —
 * not this type module — owns the policy that constrains them.
 */
export const RUNTIME_EVENT_AUTHORS = ['user', 'host', 'agent', 'tool', 'system'] as const;
export type RuntimeEventAuthor = (typeof RUNTIME_EVENT_AUTHORS)[number];

export function isRuntimeEventAuthor(value: unknown): value is RuntimeEventAuthor {
  return typeof value === 'string' && (RUNTIME_EVENT_AUTHORS as readonly string[]).includes(value);
}

/**
 * Lifecycle status an event asserts about its invocation/turn. Omitted on
 * ordinary in-flight content events. Terminal values (completed / failed /
 * aborted / cancelled) mark the last event of an invocation; `streaming`
 * marks a non-terminal partial event that still carries lifecycle intent
 * (e.g. a flow heartbeat) without being a content delta.
 */
export const RUNTIME_EVENT_STATUSES = [
  'streaming',
  'completed',
  'failed',
  'aborted',
  'cancelled',
] as const;
export type RuntimeEventStatus = (typeof RUNTIME_EVENT_STATUSES)[number];

export const TERMINAL_RUNTIME_EVENT_STATUSES: readonly RuntimeEventStatus[] = [
  'completed',
  'failed',
  'aborted',
  'cancelled',
];

export function isRuntimeEventStatus(value: unknown): value is RuntimeEventStatus {
  return typeof value === 'string' && (RUNTIME_EVENT_STATUSES as readonly string[]).includes(value);
}

/** Execution surface that produced a fact; absent on legacy ledgers. */
export const RUNTIME_EVENT_ORIGINS = ['provider', 'code_mode'] as const;
export type RuntimeEventOrigin = (typeof RUNTIME_EVENT_ORIGINS)[number];

/** Explicit provider-history policy; absent means visible. */
export const RUNTIME_EVENT_MODEL_VISIBILITIES = ['visible', 'hidden'] as const;
export type RuntimeEventModelVisibility = (typeof RUNTIME_EVENT_MODEL_VISIBILITIES)[number];

export function isTerminalRuntimeEventStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (TERMINAL_RUNTIME_EVENT_STATUSES as readonly string[]).includes(value)
  );
}

// ============================================================================
// Content (model-facing payload)
// ============================================================================

export interface RuntimeEventTextContent extends MessageContent {
  kind: 'text';
  /** Provider-owned text metadata such as Responses URL citations. */
  providerOptions?: Record<string, unknown>;
  /** Durable provenance for a host-authored user-role turn. */
  origin?: TurnOrigin;
  /**
   * Marks a user message steered into a running turn at a step boundary.
   * `text` stays raw for UI/transcript projections; model-replay projections
   * MUST wrap it in the steering envelope so the provider request has exactly
   * one canonical form — bare text is not an identity (a steer can equal the
   * current prompt or any historical user message verbatim).
   */
  steering?: true;
}

export interface RuntimeEventThinkingContent {
  kind: 'thinking';
  text: string;
  /** Anthropic signed thinking — MUST be re-sent on replay when present. */
  signature?: string;
  /** Provider-owned replay metadata that must survive model replay. */
  providerOptions?: Record<string, unknown>;
}

export interface RuntimeEventFunctionCallContent {
  kind: 'function_call';
  /** Matches the tool-call id the provider issued and the matching response. */
  id: string;
  name: string;
  args: unknown;
  /** Provider-owned opaque call metadata that must survive model replay. */
  providerOptions?: Record<string, unknown>;
  providerExecuted?: boolean;
}

export interface RuntimeEventFunctionResponseContent {
  kind: 'function_response';
  /** Matches RuntimeEventFunctionCallContent.id. */
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
  providerExecuted?: boolean;
  /** Raw provider result retained for provider-native replay; never rendered directly. */
  providerOutput?: unknown;
}

export interface RuntimeEventErrorContent {
  kind: 'error';
  code?: string;
  /** Stable machine-readable reason for routing; mirrors ErrorEvent.reason. */
  reason?: string;
  message: string;
  /** Adapter MUST scrub secrets before populating this field. */
  details?: string[] | Record<string, unknown>;
}

/**
 * Content union for user/model text, model thinking, function call,
 * function response, and error payloads. Discriminated by `kind` to
 * match the existing ToolResultContent convention.
 */
export type RuntimeEventContent =
  | RuntimeEventTextContent
  | RuntimeEventThinkingContent
  | RuntimeEventFunctionCallContent
  | RuntimeEventFunctionResponseContent
  | RuntimeEventErrorContent;

export const RUNTIME_EVENT_CONTENT_KINDS = [
  'text',
  'thinking',
  'function_call',
  'function_response',
  'error',
] as const;
export type RuntimeEventContentKind = (typeof RUNTIME_EVENT_CONTENT_KINDS)[number];

// ============================================================================
// Actions (control / side-effect intent)
// ============================================================================

/**
 * Token usage carried as a runtime action rather than a content payload.
 * Mirrors TokenUsageEvent / TokenUsageMessage so projections can map 1:1.
 */
export interface RuntimeEventTokenUsage extends TokenUsageFields {}

/**
 * Permission decision attached to an event. Runtime history may retain the
 * originating tool identity for self-contained conversation copies.
 */
export interface RuntimeEventPermissionDecision extends PermissionResponse {
  toolName?: string;
}

export const TOOL_BOUNDARY_PROTOCOL_V1 = 't1_after_preflight_v1' as const;
export type ToolBoundaryProtocol = typeof TOOL_BOUNDARY_PROTOCOL_V1;

/**
 * Canonical fact that the runtime crossed the durable tool-dispatch boundary.
 * Its presence means the implementation may have started; it does not assert
 * that the implementation or any external side effect actually completed.
 */
export interface RuntimeEventToolDispatch {
  protocol: ToolBoundaryProtocol;
  operationId: string;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
}

export interface RuntimeEventProtocolMarker {
  toolBoundary: ToolBoundaryProtocol;
}

export interface RuntimeEventContinuationStartV2 {
  protocol: 'continuation_start_v2';
  /** Mirrors store-owned claim state; recovery never trusts this field alone. */
  provenance: 'runtime_admission' | 'claim_repair';
  claimId: string;
  boundaryDigest: `sha256:${string}`;
  immediateSource: {
    sessionId: string;
    invocationId: string;
    runId: string;
    turnId: string;
    highWater: number;
    prefixDigest: `sha256:${string}`;
  };
  replayManifestDigest: `sha256:${string}`;
  providerProjectionVersion: 1;
  providerReplayDigest: `sha256:${string}`;
}

interface RuntimeEventAnswerAcceptedIdentity {
  requestId: string;
}

export interface RuntimeEventUserQuestionAnswerAccepted
  extends RuntimeEventAnswerAcceptedIdentity {}

export interface RuntimeEventPermissionAnswerAccepted extends RuntimeEventAnswerAcceptedIdentity {}

export interface RuntimeEventPermissionClosureAccepted {
  requestId: string;
  reason: PermissionClosureReason;
}

/**
 * Control and side-effect intent carried alongside content. An event may
 * carry content, actions, both, or (rarely) neither — but a terminal
 * event without `actions.endInvocation` MUST assert a terminal `status`.
 */
export interface RuntimeEventActions {
  /** Patch applied to invocation-scoped runtime state. */
  stateDelta?: Record<string, unknown>;
  /** Artifact key → primitive delta (size/bytes/version counters, etc.). */
  artifactDelta?: Record<string, string | number | boolean>;
  /** A permission prompt raised for a tool call. */
  permissionRequest?: PermissionRequestPayload;
  /** A resolved permission decision (allow/deny) for a prior request. */
  permissionDecision?: RuntimeEventPermissionDecision;
  /** Audit fact only; the canonical permission outcome remains in InteractionStore. */
  permissionAnswerAccepted?: RuntimeEventPermissionAnswerAccepted;
  /** Audit fact that an unanswered hosted permission request was durably closed. */
  permissionClosureAccepted?: RuntimeEventPermissionClosureAccepted;
  /** A bounded in-turn question raised by a tool call. */
  userQuestionRequest?: UserQuestionRequest;
  /** Audit fact only; the canonical answer remains in InteractionStore. */
  userQuestionAnswerAccepted?: RuntimeEventUserQuestionAnswerAccepted;
  /** Hand off the invocation to another agent (multi-agent transfer). */
  transferToAgent?: string;
  /** Marks the event that closes the invocation. */
  endInvocation?: boolean;
  /** Token accounting for the model call this event summarizes. */
  tokenUsage?: RuntimeEventTokenUsage;
  /** Durable, non-model-visible T1 tool-dispatch fact. */
  toolDispatch?: RuntimeEventToolDispatch;
  /** Reserved recovery fact; only the atomic recovery-bundle writer may persist it. */
  toolRecovery?: ToolRecoveryFactEnvelope;
  /** Protocols that were actually active from the first event of this run. */
  runtimeProtocol?: RuntimeEventProtocolMarker;
  /** Durable provider-call T1 for a claimed continuation. */
  continuationStart?: RuntimeEventContinuationStartV2;
  /** Reserved workspace authority fact; only its atomic SQLite writer may persist it. */
  workspaceFact?: RuntimeEventWorkspaceFactEnvelope;
}

// ============================================================================
// Refs (links to projections / ledgers)
// ============================================================================

/**
 * Links back to the projection/ledger rows written from (or correlated
 * with) this event. Refs are diagnostics/audit pointers; a missing ref
 * never changes runtime behavior. `toolCallId` doubles as the matching
 * key for function_call ↔ function_response when provider ids differ.
 */
export interface RuntimeEventRefs {
  storedMessageId?: string;
  traceEventId?: string;
  toolCallId?: string;
  providerEventId?: string;
  /** Canonical digest of a user submission before host-side preparation. */
  sourceMessageDigest?: `sha256:${string}`;
  /** Trace-group id linking aggregate usage to physical provider attempts. */
  providerRequestTraceId?: string;
  artifactId?: string;
  /** Runtime-owned durable identity for one tool side-effect boundary. */
  operationId?: string;
  /** Provider tool-call id of the enclosing exec operation. */
  parentToolCallId?: string;
  /** Runtime-owned durable identity of the enclosing exec operation. */
  parentOperationId?: string;
  /**
   * Assistant step id for a function_call event: the id of the step's
   * text/thinking messages (their `providerEventId`). Model replay pairs a
   * step's signed thinking with its tool calls by this id. Absent on legacy
   * (per-turn) events; a missing stepId marks history that cannot be paired
   * and is replayed with the older degraded semantics.
   */
  stepId?: string;
  /** Source execution boundary for a safe-boundary continuation start fact. */
  sourceInvocationId?: string;
  sourceRunId?: string;
  sourceTurnId?: string;
  sourceRuntimeEventHighWater?: number;
}

/** Tool-owned contract for deciding what a later recovery phase may do. */
export type ToolRecoveryMode =
  | 'replay_safe'
  | 'idempotent'
  | 'reconcile'
  | 'reattach'
  | 'outcome_unknown'
  | 'never_auto_retry';

// ============================================================================
// RuntimeEvent
// ============================================================================

/**
 * The canonical runtime fact.
 *
 * Phase 0-3 identity contract: one `invocationId` maps to one `runId`.
 * Invocation identifies provider/tool execution while Run identifies its
 * durable operational ledger. Store-owned control-plane streams (for example,
 * workspace version authority) use reserved identities and have no AgentRun
 * header. A continuation creates fresh values for both;
 * `turnId` names the user turn and `ts` is Unix ms.
 *
 * `partial: true` marks a transient chunk (streaming text, progress) that
 * is superseded by a later non-partial event. Projections decide whether
 * to persist partials; model history MUST exclude them.
 */
export interface RuntimeEvent {
  /** Event uuid — used for dedup on reconnect/replay. */
  id: string;
  /** Durable invocation spine id; groups every run/turn of one request. */
  invocationId: string;
  /** Durable operational run identity (maps to AgentRunHeader.runId). */
  runId: string;
  sessionId: string;
  /** Groups all events from one agent turn (maps to StoredMessage.turnId). */
  turnId: string;
  /** Unix ms timestamp. */
  ts: number;

  /** Optional branch/agent lane for future multi-agent trees. */
  branch?: string;
  /** True for transient streaming chunks superseded by a later event. */
  partial: boolean;

  role: RuntimeEventRole;
  author: RuntimeEventAuthor;
  /** Execution surface that produced this fact; absent on legacy ledgers. */
  origin?: RuntimeEventOrigin;
  /** Explicit provider-history policy; absent means visible for legacy compatibility. */
  modelVisibility?: RuntimeEventModelVisibility;
  /** Lifecycle assertion; omitted on ordinary in-flight content events. */
  status?: RuntimeEventStatus;

  content?: RuntimeEventContent;
  actions?: RuntimeEventActions;
  refs?: RuntimeEventRefs;
}

/**
 * Every key a RuntimeEvent envelope may carry. TypeScript forces this list to
 * cover the interface, so it moves whenever the interface does — which makes it
 * the thing anything re-implementing the envelope check must be pinned to.
 *
 * A former external consumer reimplemented it and drifted: it never learned
 * `origin` or `modelVisibility`, so once Runtime emitted them every event
 * failed its envelope check. `runtime-event.test.ts` therefore holds the
 * validation corpus to this list instead of a second hand-maintained shape.
 */
export function runtimeEventEnvelopeKeys(): readonly string[] {
  return [...RUNTIME_EVENT_SHAPE.allowed];
}

/**
 * Every value each closed-domain envelope key may hold.
 *
 * Pinning the corpus to the key list closed one half of the drift the Harbor
 * exporter fell through: a key nobody wrote a case for. The other half is a
 * value nobody wrote a case for — the exporter spells these domains out again
 * in Python, and a member added here that no case carries would leave the two
 * disagreeing about what is valid with nothing red. Only the closed domains
 * appear; `branch` is free text and has nothing to enumerate.
 */
export function runtimeEventEnvelopeValueDomains(): Readonly<Record<string, readonly string[]>> {
  return {
    role: RUNTIME_EVENT_ROLES,
    author: RUNTIME_EVENT_AUTHORS,
    origin: RUNTIME_EVENT_ORIGINS,
    modelVisibility: RUNTIME_EVENT_MODEL_VISIBILITIES,
    status: RUNTIME_EVENT_STATUSES,
  };
}

const RUNTIME_EVENT_SHAPE = defineObjectShape<RuntimeEvent>()(
  ['id', 'invocationId', 'runId', 'sessionId', 'turnId', 'ts', 'partial', 'role', 'author'],
  ['branch', 'origin', 'modelVisibility', 'status', 'content', 'actions', 'refs'],
);
const TEXT_CONTENT_SHAPE = defineObjectShape<RuntimeEventTextContent>()(
  ['kind', 'text'],
  [
    'displayText',
    'origin',
    'attachments',
    'quotes',
    'inlineReferences',
    'steering',
    'providerOptions',
  ],
);
const THINKING_CONTENT_SHAPE = defineObjectShape<RuntimeEventThinkingContent>()(
  ['kind', 'text'],
  ['signature', 'providerOptions'],
);
const FUNCTION_CALL_CONTENT_SHAPE = defineObjectShape<RuntimeEventFunctionCallContent>()(
  ['kind', 'id', 'name', 'args'],
  ['providerOptions', 'providerExecuted'],
);
const FUNCTION_RESPONSE_CONTENT_SHAPE = defineObjectShape<RuntimeEventFunctionResponseContent>()(
  ['kind', 'id', 'name', 'result'],
  ['isError', 'providerExecuted', 'providerOutput'],
);
const ERROR_CONTENT_SHAPE = defineObjectShape<RuntimeEventErrorContent>()(
  ['kind', 'message'],
  ['code', 'reason', 'details'],
);
const RUNTIME_ACTIONS_SHAPE = defineObjectShape<RuntimeEventActions>()(
  [],
  [
    'stateDelta',
    'artifactDelta',
    'permissionRequest',
    'permissionDecision',
    'permissionAnswerAccepted',
    'permissionClosureAccepted',
    'userQuestionRequest',
    'userQuestionAnswerAccepted',
    'transferToAgent',
    'endInvocation',
    'tokenUsage',
    'toolDispatch',
    'toolRecovery',
    'runtimeProtocol',
    'continuationStart',
    'workspaceFact',
  ],
);
const ANSWER_ACCEPTED_IDENTITY_SHAPE = defineObjectShape<RuntimeEventAnswerAcceptedIdentity>()(
  ['requestId'],
  [],
);
const PERMISSION_CLOSURE_ACCEPTED_SHAPE =
  defineObjectShape<RuntimeEventPermissionClosureAccepted>()(['requestId', 'reason'], []);
const RUNTIME_PERMISSION_DECISION_SHAPE = defineObjectShape<RuntimeEventPermissionDecision>()(
  ['requestId', 'decision'],
  ['rememberForTurn', 'reviewer', 'rationale', 'riskLevel', 'toolName'],
);
const UTF8 = new TextEncoder();
const RUNTIME_TOOL_DISPATCH_SHAPE = defineObjectShape<RuntimeEventToolDispatch>()(
  [
    'protocol',
    'operationId',
    'providerToolCallId',
    'toolName',
    'canonicalArgsHash',
    'recoveryMode',
  ],
  [],
);
const RUNTIME_PROTOCOL_MARKER_SHAPE = defineObjectShape<RuntimeEventProtocolMarker>()(
  ['toolBoundary'],
  [],
);
const RUNTIME_CONTINUATION_START_SHAPE = defineObjectShape<RuntimeEventContinuationStartV2>()(
  [
    'protocol',
    'provenance',
    'claimId',
    'boundaryDigest',
    'immediateSource',
    'replayManifestDigest',
    'providerProjectionVersion',
    'providerReplayDigest',
  ],
  [],
);
const RUNTIME_CONTINUATION_SOURCE_SHAPE = defineObjectShape<
  RuntimeEventContinuationStartV2['immediateSource']
>()(['sessionId', 'invocationId', 'runId', 'turnId', 'highWater', 'prefixDigest'], []);
const RUNTIME_TOKEN_USAGE_SHAPE = defineObjectShape<RuntimeEventTokenUsage>()(
  ['input', 'output'],
  [
    'cacheHitInput',
    'cacheMissInput',
    'cacheWriteInput',
    'cacheMissInputSource',
    'reasoning',
    'total',
    'rawFinishReason',
    'runtimeSteps',
    'cacheRead',
    'cacheCreation',
    'costUsd',
    'systemPromptHash',
    'contextRemaining',
    'prefixHash',
    'prefixChangeReason',
    'requestShapeHash',
    'requestShapeChangeReason',
    'promptSegments',
    'contextBudget',
    'providerRequestTraceId',
  ],
);
const RUNTIME_REFS_SHAPE = defineObjectShape<RuntimeEventRefs>()(
  [],
  [
    'storedMessageId',
    'traceEventId',
    'toolCallId',
    'providerEventId',
    'sourceMessageDigest',
    'providerRequestTraceId',
    'artifactId',
    'operationId',
    'parentToolCallId',
    'parentOperationId',
    'stepId',
    'sourceInvocationId',
    'sourceRunId',
    'sourceTurnId',
    'sourceRuntimeEventHighWater',
  ],
);

export function decodeRuntimeEvent(value: unknown): RuntimeEvent {
  if (
    !isRecord(value) ||
    !hasExactShape(value, RUNTIME_EVENT_SHAPE) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.invocationId !== 'string' ||
    value.invocationId.length === 0 ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    typeof value.turnId !== 'string' ||
    value.turnId.length === 0 ||
    !isFiniteNumber(value.ts) ||
    !isOptionalString(value.branch) ||
    typeof value.partial !== 'boolean' ||
    !isRuntimeEventRole(value.role) ||
    !isRuntimeEventAuthor(value.author) ||
    !isOptionalMember(value.origin, RUNTIME_EVENT_ORIGINS) ||
    !isOptionalMember(value.modelVisibility, RUNTIME_EVENT_MODEL_VISIBILITIES) ||
    (value.status !== undefined && !isRuntimeEventStatus(value.status)) ||
    (value.content !== undefined && !isRuntimeEventContent(value.content)) ||
    (value.actions !== undefined && !isRuntimeEventActions(value.actions)) ||
    (value.refs !== undefined && !isRuntimeEventRefs(value.refs))
  ) {
    throw new Error('Invalid RuntimeEvent schema');
  }
  if (isRecord(value.content) && value.content.kind === 'text') {
    return {
      ...value,
      content: {
        kind: 'text',
        ...normalizeMessageContent(value.content as unknown as MessageContent),
        ...(value.content.origin !== undefined
          ? { origin: value.content.origin as TurnOrigin }
          : {}),
        ...(value.content.steering === true ? { steering: true as const } : {}),
      },
    } as unknown as RuntimeEvent;
  }
  return value as unknown as RuntimeEvent;
}

function isRuntimeEventContent(value: unknown): value is RuntimeEventContent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'text':
      if (
        !hasExactShape(value, TEXT_CONTENT_SHAPE) ||
        (value.origin !== undefined && !isTurnOrigin(value.origin)) ||
        (value.steering !== undefined && value.steering !== true) ||
        (value.providerOptions !== undefined && !isRecord(value.providerOptions))
      ) {
        return false;
      }
      return isMessageContent({
        text: value.text,
        ...(value.displayText !== undefined ? { displayText: value.displayText } : {}),
        ...(value.attachments !== undefined ? { attachments: value.attachments } : {}),
        ...(value.quotes !== undefined ? { quotes: value.quotes } : {}),
        ...(value.inlineReferences !== undefined
          ? { inlineReferences: value.inlineReferences }
          : {}),
      });
    case 'thinking':
      return (
        hasExactShape(value, THINKING_CONTENT_SHAPE) &&
        typeof value.text === 'string' &&
        isOptionalString(value.signature) &&
        (value.providerOptions === undefined || isRecord(value.providerOptions))
      );
    case 'function_call':
      return (
        hasExactShape(value, FUNCTION_CALL_CONTENT_SHAPE) &&
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        Object.hasOwn(value, 'args') &&
        (value.providerOptions === undefined || isRecord(value.providerOptions)) &&
        (value.providerExecuted === undefined || typeof value.providerExecuted === 'boolean')
      );
    case 'function_response':
      return (
        hasExactShape(value, FUNCTION_RESPONSE_CONTENT_SHAPE) &&
        typeof value.id === 'string' &&
        typeof value.name === 'string' &&
        Object.hasOwn(value, 'result') &&
        (value.isError === undefined || typeof value.isError === 'boolean') &&
        (value.providerExecuted === undefined || typeof value.providerExecuted === 'boolean')
      );
    case 'error':
      return (
        hasExactShape(value, ERROR_CONTENT_SHAPE) &&
        isOptionalString(value.code) &&
        isOptionalString(value.reason) &&
        typeof value.message === 'string' &&
        (value.details === undefined || isStringArray(value.details) || isRecord(value.details))
      );
    default:
      return false;
  }
}

function isTurnOrigin(value: unknown): value is TurnOrigin {
  if (!isRecord(value)) return false;
  if (value.kind === 'scheduled_task') {
    return Object.keys(value).length === 2 && typeof value.scheduledTaskId === 'string';
  }
  if (value.kind === 'goal') {
    return Object.keys(value).length === 2 && typeof value.goalId === 'string';
  }
  return (
    value.kind === 'agent_graph' &&
    Object.keys(value).length === 4 &&
    typeof value.graphId === 'string' &&
    typeof value.wakeId === 'string' &&
    typeof value.attemptId === 'string'
  );
}

function isRuntimeEventActions(value: unknown): value is RuntimeEventActions {
  if (!isRecord(value) || !hasExactShape(value, RUNTIME_ACTIONS_SHAPE)) return false;
  if (
    value.permissionClosureAccepted !== undefined &&
    Object.keys(value).some((key) => key !== 'permissionClosureAccepted')
  ) {
    return false;
  }
  return (
    (value.stateDelta === undefined || isRecord(value.stateDelta)) &&
    (value.artifactDelta === undefined ||
      (isRecord(value.artifactDelta) &&
        Object.values(value.artifactDelta).every(
          (item) => typeof item === 'string' || typeof item === 'boolean' || isFiniteNumber(item),
        ))) &&
    (value.permissionRequest === undefined ||
      isPermissionRequestPayload(value.permissionRequest)) &&
    (value.permissionDecision === undefined ||
      isRuntimeEventPermissionDecision(value.permissionDecision)) &&
    (value.permissionAnswerAccepted === undefined ||
      isRuntimeEventAnswerAcceptedIdentity(value.permissionAnswerAccepted)) &&
    (value.permissionClosureAccepted === undefined ||
      isRuntimeEventPermissionClosureAccepted(value.permissionClosureAccepted)) &&
    (value.userQuestionRequest === undefined || isUserQuestionRequest(value.userQuestionRequest)) &&
    (value.userQuestionAnswerAccepted === undefined ||
      isRuntimeEventAnswerAcceptedIdentity(value.userQuestionAnswerAccepted)) &&
    isOptionalString(value.transferToAgent) &&
    (value.endInvocation === undefined || typeof value.endInvocation === 'boolean') &&
    (value.tokenUsage === undefined || isRuntimeTokenUsage(value.tokenUsage)) &&
    (value.toolDispatch === undefined || isRuntimeToolDispatch(value.toolDispatch)) &&
    (value.toolRecovery === undefined || isToolRecoveryFactEnvelope(value.toolRecovery)) &&
    (value.runtimeProtocol === undefined || isRuntimeProtocolMarker(value.runtimeProtocol)) &&
    (value.continuationStart === undefined ||
      isRuntimeContinuationStart(value.continuationStart)) &&
    (value.workspaceFact === undefined || isRuntimeEventWorkspaceFactEnvelope(value.workspaceFact))
  );
}

function isRuntimeEventPermissionDecision(value: unknown): value is RuntimeEventPermissionDecision {
  return (
    isRecord(value) &&
    hasExactShape(value, RUNTIME_PERMISSION_DECISION_SHAPE) &&
    typeof value.requestId === 'string' &&
    isPermissionDecisionFields(value) &&
    (value.toolName === undefined ||
      (typeof value.toolName === 'string' &&
        value.toolName.length > 0 &&
        UTF8.encode(value.toolName).byteLength <= INTERACTION_TOOL_NAME_MAX_BYTES))
  );
}

function isRuntimeEventAnswerAcceptedIdentity(
  value: unknown,
): value is RuntimeEventAnswerAcceptedIdentity {
  return (
    isRecord(value) &&
    hasExactShape(value, ANSWER_ACCEPTED_IDENTITY_SHAPE) &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    UTF8.encode(value.requestId).byteLength <= INTERACTION_ID_MAX_BYTES
  );
}

function isRuntimeEventPermissionClosureAccepted(
  value: unknown,
): value is RuntimeEventPermissionClosureAccepted {
  return (
    isRecord(value) &&
    hasExactShape(value, PERMISSION_CLOSURE_ACCEPTED_SHAPE) &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    UTF8.encode(value.requestId).byteLength <= INTERACTION_ID_MAX_BYTES &&
    value.reason === 'timed_out'
  );
}

function isRuntimeToolDispatch(value: unknown): value is RuntimeEventToolDispatch {
  return (
    isRecord(value) &&
    hasExactShape(value, RUNTIME_TOOL_DISPATCH_SHAPE) &&
    value.protocol === TOOL_BOUNDARY_PROTOCOL_V1 &&
    typeof value.operationId === 'string' &&
    typeof value.providerToolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    typeof value.canonicalArgsHash === 'string' &&
    (value.recoveryMode === 'replay_safe' ||
      value.recoveryMode === 'idempotent' ||
      value.recoveryMode === 'reconcile' ||
      value.recoveryMode === 'reattach' ||
      value.recoveryMode === 'outcome_unknown' ||
      value.recoveryMode === 'never_auto_retry')
  );
}

function isRuntimeProtocolMarker(value: unknown): value is RuntimeEventProtocolMarker {
  return (
    isRecord(value) &&
    hasExactShape(value, RUNTIME_PROTOCOL_MARKER_SHAPE) &&
    value.toolBoundary === TOOL_BOUNDARY_PROTOCOL_V1
  );
}

function isRuntimeContinuationStart(value: unknown): value is RuntimeEventContinuationStartV2 {
  return (
    isRecord(value) &&
    hasExactShape(value, RUNTIME_CONTINUATION_START_SHAPE) &&
    value.protocol === 'continuation_start_v2' &&
    (value.provenance === 'runtime_admission' || value.provenance === 'claim_repair') &&
    isNonEmptyString(value.claimId) &&
    isSha256Digest(value.boundaryDigest) &&
    isRecord(value.immediateSource) &&
    hasExactShape(value.immediateSource, RUNTIME_CONTINUATION_SOURCE_SHAPE) &&
    isNonEmptyString(value.immediateSource.sessionId) &&
    isNonEmptyString(value.immediateSource.invocationId) &&
    isNonEmptyString(value.immediateSource.runId) &&
    isNonEmptyString(value.immediateSource.turnId) &&
    Number.isSafeInteger(value.immediateSource.highWater) &&
    (value.immediateSource.highWater as number) > 0 &&
    isSha256Digest(value.immediateSource.prefixDigest) &&
    isSha256Digest(value.replayManifestDigest) &&
    value.providerProjectionVersion === 1 &&
    isSha256Digest(value.providerReplayDigest)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRuntimeTokenUsage(value: unknown): value is RuntimeEventTokenUsage {
  return (
    isRecord(value) && hasExactShape(value, RUNTIME_TOKEN_USAGE_SHAPE) && isTokenUsageFields(value)
  );
}

function isRuntimeEventRefs(value: unknown): value is RuntimeEventRefs {
  return (
    isRecord(value) &&
    hasExactShape(value, RUNTIME_REFS_SHAPE) &&
    [
      value.storedMessageId,
      value.traceEventId,
      value.toolCallId,
      value.providerEventId,
      value.providerRequestTraceId,
      value.artifactId,
      value.operationId,
      value.parentToolCallId,
      value.parentOperationId,
      value.stepId,
      value.sourceInvocationId,
      value.sourceRunId,
      value.sourceTurnId,
    ].every(isOptionalString) &&
    (value.sourceMessageDigest === undefined || isSha256Digest(value.sourceMessageDigest)) &&
    (value.sourceRuntimeEventHighWater === undefined ||
      (typeof value.sourceRuntimeEventHighWater === 'number' &&
        Number.isSafeInteger(value.sourceRuntimeEventHighWater) &&
        value.sourceRuntimeEventHighWater >= 0))
  );
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * True if the event marks the end of its invocation — either by asserting
 * a terminal `status` or by carrying `actions.endInvocation === true`.
 * A single terminal event SHOULD carry exactly one of these signals.
 */
export function isTerminalRuntimeEvent(event: RuntimeEvent): boolean {
  if (event.status !== undefined && isTerminalRuntimeEventStatus(event.status)) return true;
  return event.actions?.endInvocation === true;
}

/** True for transient streaming/progress chunks that a later event supersedes. */
export function isPartialRuntimeEvent(event: RuntimeEvent): boolean {
  return event.partial === true;
}

/**
 * True if the event carries content whose kind is eligible for model
 * history projection: text, thinking, function_call, or function_response.
 * Error-only content and pure action/refs events are NOT model-visible.
 *
 * This is a content-kind check only. Callers still apply `partial`
 * filtering (partial chunks are never replayed into the next model call).
 */
export function runtimeEventHasModelVisibleContent(event: RuntimeEvent): boolean {
  if (event.modelVisibility === 'hidden') return false;
  const content = event.content;
  if (!content) return false;
  switch (content.kind) {
    case 'text':
      return content.text.length > 0;
    case 'thinking':
    case 'function_call':
    case 'function_response':
      return true;
    case 'error':
      return false;
  }
}

let __runtimeEventSeq = 0;

/**
 * Best-effort unique id for runtime events. Monotonic within a process so
 * two ids never collide even when generated in the same millisecond.
 *
 * Runtime/runner layers MAY replace this with a stronger uuid source; it
 * exists here only so early adopters and tests have a default. Tests that
 * need deterministic ids SHOULD pass literal strings rather than rely on
 * this helper's exact output.
 */
export function createRuntimeEventId(prefix = 'rt-event'): string {
  __runtimeEventSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${__runtimeEventSeq.toString(36)}`;
}
