import { isPermissionMode, type PermissionMode } from './permission.js';
import { isCollaborationMode, type CollaborationMode } from './collaboration.js';
import {
  isAgentSwarmAuthorizationSource,
  isEffectiveOrchestrationSource,
  isOrchestrationMode,
  type AgentSwarmAuthorizationSource,
  type EffectiveOrchestrationSource,
  type OrchestrationMode,
} from './orchestration.js';
import type { BackendKind } from './session.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';

export const AGENT_RUN_STATUSES = [
  'created',
  'running',
  'waiting_permission',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRunContinuationSource {
  sourceInvocationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  sourceRuntimeEventHighWater: number;
}

export type RootExecutionDescriptor =
  | { kind: 'external_message' }
  | {
      kind: 'linked_child_initial';
      agentId: string;
      agentName: string;
    }
  | {
      kind: 'linked_child_resume';
      agentId: string;
      agentName: string;
      sourceRunId: string;
    }
  | {
      kind: 'linked_child_provider_retry';
      agentId: string;
      agentName: string;
      sourceRunId: string;
    };

const AGENT_RUN_CONTINUATION_SOURCE_SHAPE = defineObjectShape<AgentRunContinuationSource>()(
  ['sourceInvocationId', 'sourceRunId', 'sourceTurnId', 'sourceRuntimeEventHighWater'],
  [],
);

export interface AgentRunHeader {
  runId: string;
  /** Durable Runtime invocation spine. Optional only for legacy run headers. */
  invocationId?: string;
  sessionId: string;
  turnId: string;
  status: AgentRunStatus;
  backendKind: BackendKind;
  llmConnectionSlug: string;
  modelId: string;
  cwd: string;
  /** Authoritative host identity for the workspace observed when the run was created. */
  workspaceIdentity?: string;
  permissionMode: PermissionMode;
  /** Snapshot of the session collaboration mode. Optional on legacy runs. */
  collaborationMode?: CollaborationMode;
  /** Effective orchestration mode for this run. Optional on legacy runs. */
  orchestrationMode?: OrchestrationMode;
  /** Whether the effective mode came from the session or this turn. */
  orchestrationSource?: EffectiveOrchestrationSource;
  /** Narrow authority for the parent agent_swarm envelope. */
  agentSwarmAuthorization?: AgentSwarmAuthorizationSource;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  parentRunId?: string;
  /** Immediate child AgentRun continued by this run. */
  resumedFromRunId?: string;
  /** Immediate child AgentRun whose provider step is retried by this run. */
  retriedFromRunId?: string;
  agentId?: string;
  agentName?: string;
  parentTurnId?: string;
  retriedFromTurnId?: string;
  regeneratedFromTurnId?: string;
  branchOfTurnId?: string;
  parentSessionId?: string;
  /** Durable claim that this run is the continuation child for one source boundary. */
  continuationSource?: AgentRunContinuationSource;
  /** Non-user trigger for this run (e.g. a scheduled automation fire). */
  automationId?: string;
  failureClass?: string;
  failureMessage?: string;
  abortSource?: string;
  traceWriteError?: string;
}

export interface AgentRunInputSummary {
  textLength: number;
  attachmentCount: number;
}

export const AGENT_RUN_EVENT_TYPES = [
  'run_created',
  'run_started',
  'turn_started',
  'sandbox_context_resolved',
  'plan_context_resolved',
  'plan_submitted',
  'plan_execution_started',
  'plan_progress_updated',
  'plan_execution_completed',
  'plan_execution_cancelled',
  'plan_execution_interrupted',
  'plan_execution_resumed',
  'plan_transition_failed',
  'run_status_changed',
  'model_resolved',
  'model_resolve_failed',
  'model_stream_started',
  'model_stream_completed',
  'model_stream_failed',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'skill_catalog_built',
  'skill_searched',
  'skill_loaded',
  'skill_load_failed',
  'permission_requested',
  'permission_decided',
  'permission_failed',
  'approval_routed',
  'auto_review_started',
  'auto_review_decided',
  'auto_review_failed',
  'sandbox_escalation_requested',
  'sandbox_escalation_granted',
  'sandbox_escalation_denied',
  'sandbox_escalation_applied',
  'sandbox_escalation_failed',
  'sandbox_denial_detected',
  'usage_recorded',
  'provider_request_captured',
  'provider_request_attempt_recorded',
  'history_compact_checkpoint_recorded',
  'active_full_compact_block_recorded',
  'semantic_compact_block_recorded',
  'task_gate_decided',
  'abort_requested',
  'run_completed',
  'run_failed',
  'run_cancelled',
  'trace_write_failed',
  'event_corrupt',
] as const;

export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number];

export interface AgentRunEvent {
  type: AgentRunEventType;
  id: string;
  runId: string;
  sessionId: string;
  turnId: string;
  ts: number;
  message?: string;
  data?: Record<string, unknown>;
}

const AGENT_RUN_HEADER_SHAPE = defineObjectShape<AgentRunHeader>()(
  [
    'runId',
    'sessionId',
    'turnId',
    'status',
    'backendKind',
    'llmConnectionSlug',
    'modelId',
    'cwd',
    'permissionMode',
    'createdAt',
    'updatedAt',
  ],
  [
    'invocationId',
    'completedAt',
    'parentRunId',
    'resumedFromRunId',
    'retriedFromRunId',
    'agentId',
    'agentName',
    'parentTurnId',
    'retriedFromTurnId',
    'regeneratedFromTurnId',
    'branchOfTurnId',
    'parentSessionId',
    'workspaceIdentity',
    'continuationSource',
    'automationId',
    'failureClass',
    'failureMessage',
    'abortSource',
    'traceWriteError',
    'collaborationMode',
    'orchestrationMode',
    'orchestrationSource',
    'agentSwarmAuthorization',
  ],
);

const AGENT_RUN_EVENT_SHAPE = defineObjectShape<AgentRunEvent>()(
  ['type', 'id', 'runId', 'sessionId', 'turnId', 'ts'],
  ['message', 'data'],
);

export function decodeAgentRunHeader(value: unknown): AgentRunHeader {
  if (!isRecord(value) || !hasExactShape(value, AGENT_RUN_HEADER_SHAPE)) {
    throw new Error('Invalid AgentRun header schema');
  }
  const valid =
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    (AGENT_RUN_STATUSES as readonly unknown[]).includes(value.status) &&
    isBackendKind(value.backendKind) &&
    typeof value.llmConnectionSlug === 'string' &&
    typeof value.modelId === 'string' &&
    typeof value.cwd === 'string' &&
    isPermissionMode(value.permissionMode) &&
    (value.collaborationMode === undefined || isCollaborationMode(value.collaborationMode)) &&
    (value.orchestrationMode === undefined || isOrchestrationMode(value.orchestrationMode)) &&
    (value.orchestrationSource === undefined ||
      isEffectiveOrchestrationSource(value.orchestrationSource)) &&
    (value.agentSwarmAuthorization === undefined ||
      isAgentSwarmAuthorizationSource(value.agentSwarmAuthorization)) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt) &&
    isOptionalString(value.invocationId) &&
    (value.completedAt === undefined || isFiniteNumber(value.completedAt)) &&
    [
      value.parentRunId,
      value.resumedFromRunId,
      value.retriedFromRunId,
      value.agentId,
      value.agentName,
      value.parentTurnId,
      value.retriedFromTurnId,
      value.regeneratedFromTurnId,
      value.branchOfTurnId,
      value.parentSessionId,
      value.workspaceIdentity,
      value.automationId,
      value.failureClass,
      value.failureMessage,
      value.abortSource,
      value.traceWriteError,
    ].every(isOptionalString) &&
    (value.continuationSource === undefined ||
      (isRecord(value.continuationSource) &&
        hasExactShape(value.continuationSource, AGENT_RUN_CONTINUATION_SOURCE_SHAPE) &&
        typeof value.continuationSource.sourceInvocationId === 'string' &&
        typeof value.continuationSource.sourceRunId === 'string' &&
        typeof value.continuationSource.sourceTurnId === 'string' &&
        typeof value.continuationSource.sourceRuntimeEventHighWater === 'number' &&
        Number.isSafeInteger(value.continuationSource.sourceRuntimeEventHighWater) &&
        value.continuationSource.sourceRuntimeEventHighWater >= 0));
  if (!valid) throw new Error('Invalid AgentRun header schema');
  return value as unknown as AgentRunHeader;
}

export function decodeAgentRunEvent(value: unknown): AgentRunEvent {
  if (
    !isRecord(value) ||
    !hasExactShape(value, AGENT_RUN_EVENT_SHAPE) ||
    !(AGENT_RUN_EVENT_TYPES as readonly unknown[]).includes(value.type) ||
    typeof value.id !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.turnId !== 'string' ||
    !isFiniteNumber(value.ts) ||
    !isOptionalString(value.message) ||
    (value.data !== undefined && !isRecord(value.data))
  ) {
    throw new Error('Invalid AgentRun event schema');
  }
  return value as unknown as AgentRunEvent;
}

function isBackendKind(value: unknown): value is BackendKind {
  return value === 'ai-sdk' || value === 'fake' || value === 'pi-agent';
}

export interface AgentRunStore {
  createRun(header: AgentRunHeader, options?: { durable?: boolean }): Promise<AgentRunHeader>;
  updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
    options?: { durable?: boolean },
  ): Promise<AgentRunHeader>;
  readRun(sessionId: string, runId: string): Promise<AgentRunHeader>;
  listSessionRuns(sessionId: string): Promise<AgentRunHeader[]>;
  appendEvent(
    sessionId: string,
    runId: string,
    event: AgentRunEvent,
    options?: { durable?: boolean },
  ): Promise<void>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  /** `undefined` means uninitialized; `null` is an initialized empty projection. */
  readEventProjection?(
    sessionId: string,
    type: AgentRunEventType,
  ): Promise<AgentRunEvent | null | undefined>;
  /** Rewrites derived state after the canonical event ledger repairs an absent or damaged projection. */
  repairEventProjection?(
    sessionId: string,
    type: AgentRunEventType,
    event: AgentRunEvent | null,
    options?: { replaceEventId?: string },
  ): Promise<void>;
}

/**
 * Whether a run contributes directly to the owning session's transcript.
 * Continuations carry parent lineage for recovery, but unlike child-agent runs
 * their output remains part of the parent session conversation.
 */
export function isSessionInlineRun(run: {
  readonly parentRunId?: string;
  readonly continuationSource?: unknown;
}): boolean {
  return run.parentRunId === undefined || run.continuationSource !== undefined;
}
