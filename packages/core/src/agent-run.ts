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
import type { PersistedBackendKind } from './session.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';
import type { AgentGraphIntentClaim } from './agent-graph-control.js';
import { isToolMode, type ToolMode } from './tool-mode.js';
import { decodeRunCompositionSnapshot, type RunCompositionSnapshot } from './run-composition.js';

export const AGENT_RUN_STATUSES = [
  'created',
  'running',
  'waiting_for_user',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRunContinuationSourceV1 {
  sourceInvocationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  sourceRuntimeEventHighWater: number;
}

export interface AgentRunContinuationSourceV2 extends AgentRunContinuationSourceV1 {
  protocol: 'continuation_source_v2';
  claimId: string;
  boundaryDigest: `sha256:${string}`;
  sourcePrefixDigest: `sha256:${string}`;
  replayManifestDigest: `sha256:${string}`;
}

export type AgentRunContinuationSource =
  | AgentRunContinuationSourceV1
  | AgentRunContinuationSourceV2;

export type RootExecutionDescriptor =
  | {
      kind: 'external_message';
      inputDigest?: `sha256:${string}`;
      maxSteps?: number;
    }
  | { kind: 'regenerate'; sourceTurnId: string }
  | { kind: 'context_compact' }
  | { kind: 'scheduled_task'; scheduledTaskId: string }
  | { kind: 'legacy_automation'; automationId: string }
  | { kind: 'goal'; goalId: string }
  | {
      kind: 'agent_graph_supervisor_wake';
      graphId: string;
      wakeId: string;
      attemptId: string;
    }
  | {
      kind: 'safe_boundary_continuation';
      sourceInvocationId: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceRuntimeEventHighWater: number;
      claimId: string;
      boundaryDigest: `sha256:${string}`;
      providerReplayDigest: `sha256:${string}`;
      safetyDigest: `sha256:${string}`;
      targetInvocationId: string;
    }
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
    }
  | {
      kind: 'claimed_agent_graph_intent';
      claim: AgentGraphIntentClaim;
      agentId: string;
      agentName: string;
    };

const AGENT_RUN_CONTINUATION_SOURCE_V1_SHAPE = defineObjectShape<AgentRunContinuationSourceV1>()(
  ['sourceInvocationId', 'sourceRunId', 'sourceTurnId', 'sourceRuntimeEventHighWater'],
  [],
);
const AGENT_RUN_CONTINUATION_SOURCE_V2_SHAPE = defineObjectShape<AgentRunContinuationSourceV2>()(
  [
    'protocol',
    'claimId',
    'boundaryDigest',
    'sourceInvocationId',
    'sourceRunId',
    'sourceTurnId',
    'sourceRuntimeEventHighWater',
    'sourcePrefixDigest',
    'replayManifestDigest',
  ],
  [],
);

export interface AgentRunHeader {
  runId: string;
  /** Durable Runtime invocation spine. Optional only for legacy run headers. */
  invocationId?: string;
  sessionId: string;
  turnId: string;
  status: AgentRunStatus;
  backendKind: PersistedBackendKind;
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
  /** Effective tool protocol for this run. Optional on legacy runs. */
  toolMode?: ToolMode;
  /** Immutable composer-owned prompt and tool-surface snapshot committed before provider dispatch. */
  runComposition?: RunCompositionSnapshot;
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
  /** ScheduledTask that triggered this host-authored Run. */
  scheduledTaskId?: string;
  /** Removed Automation authority that triggered this historical Run. */
  legacyAutomationId?: string;
  /** Host-owned Goal generation that triggered this continuation Run. */
  goalId?: string;
  /** Durable graph milestone that caused this host-authored supervisor turn. */
  agentGraphWakeId?: string;
  /** Durable delivery attempt for this host-authored supervisor turn. */
  agentGraphWakeAttemptId?: string;
  /** Positive identity for a host-authored root that has no message lineage. */
  rootExecutionKind?: 'context_compact';
  failureClass?: string;
  failureMessage?: string;
  abortSource?: string;
  traceWriteError?: string;
}

type HostedRootExecutionDescriptor = Extract<
  RootExecutionDescriptor,
  {
    kind:
      | 'regenerate'
      | 'context_compact'
      | 'scheduled_task'
      | 'legacy_automation'
      | 'goal'
      | 'agent_graph_supervisor_wake'
      | 'safe_boundary_continuation';
  }
>;

export function agentRunMatchesHostedRootExecution(
  run: AgentRunHeader,
  execution: HostedRootExecutionDescriptor,
): boolean {
  if (execution.kind !== 'context_compact' && run.rootExecutionKind !== undefined) return false;
  if (execution.kind === 'regenerate') {
    return (
      run.parentTurnId === execution.sourceTurnId &&
      run.regeneratedFromTurnId === execution.sourceTurnId &&
      run.parentRunId === undefined &&
      run.resumedFromRunId === undefined &&
      run.retriedFromRunId === undefined &&
      run.agentId === undefined &&
      run.agentName === undefined &&
      run.retriedFromTurnId === undefined &&
      run.branchOfTurnId === undefined &&
      run.parentSessionId === undefined &&
      run.continuationSource === undefined &&
      run.scheduledTaskId === undefined &&
      run.legacyAutomationId === undefined &&
      run.goalId === undefined &&
      run.agentGraphWakeId === undefined &&
      run.agentGraphWakeAttemptId === undefined
    );
  }
  if (execution.kind === 'context_compact') {
    return (
      run.rootExecutionKind === 'context_compact' &&
      run.parentTurnId === undefined &&
      run.regeneratedFromTurnId === undefined &&
      run.parentRunId === undefined &&
      run.resumedFromRunId === undefined &&
      run.retriedFromRunId === undefined &&
      run.agentId === undefined &&
      run.agentName === undefined &&
      run.retriedFromTurnId === undefined &&
      run.branchOfTurnId === undefined &&
      run.parentSessionId === undefined &&
      run.continuationSource === undefined &&
      run.scheduledTaskId === undefined &&
      run.legacyAutomationId === undefined &&
      run.goalId === undefined &&
      run.agentGraphWakeId === undefined &&
      run.agentGraphWakeAttemptId === undefined
    );
  }
  if (execution.kind === 'safe_boundary_continuation') {
    const source = run.continuationSource;
    return (
      run.invocationId === execution.targetInvocationId &&
      run.parentRunId === execution.sourceRunId &&
      run.parentTurnId === execution.sourceTurnId &&
      source !== undefined &&
      'protocol' in source &&
      source.protocol === 'continuation_source_v2' &&
      source.sourceInvocationId === execution.sourceInvocationId &&
      source.sourceRunId === execution.sourceRunId &&
      source.sourceTurnId === execution.sourceTurnId &&
      source.sourceRuntimeEventHighWater === execution.sourceRuntimeEventHighWater &&
      source.claimId === execution.claimId &&
      source.boundaryDigest === execution.boundaryDigest &&
      source.replayManifestDigest === execution.boundaryDigest &&
      run.resumedFromRunId === undefined &&
      run.retriedFromRunId === undefined &&
      run.agentId === undefined &&
      run.agentName === undefined &&
      run.retriedFromTurnId === undefined &&
      run.regeneratedFromTurnId === undefined &&
      run.branchOfTurnId === undefined &&
      run.parentSessionId === undefined &&
      run.scheduledTaskId === undefined &&
      run.legacyAutomationId === undefined &&
      run.goalId === undefined &&
      run.agentGraphWakeId === undefined &&
      run.agentGraphWakeAttemptId === undefined
    );
  }
  const authorityMatches = hostedRootAuthorityMatches(run, execution);
  return (
    authorityMatches &&
    run.parentRunId === undefined &&
    run.resumedFromRunId === undefined &&
    run.retriedFromRunId === undefined &&
    run.agentId === undefined &&
    run.agentName === undefined &&
    run.parentTurnId === undefined &&
    run.retriedFromTurnId === undefined &&
    run.regeneratedFromTurnId === undefined &&
    run.branchOfTurnId === undefined &&
    run.parentSessionId === undefined &&
    run.continuationSource === undefined
  );
}

function hostedRootAuthorityMatches(
  run: AgentRunHeader,
  execution: Exclude<
    HostedRootExecutionDescriptor,
    { kind: 'regenerate' | 'context_compact' | 'safe_boundary_continuation' }
  >,
): boolean {
  switch (execution.kind) {
    case 'scheduled_task':
      return (
        run.scheduledTaskId === execution.scheduledTaskId &&
        run.legacyAutomationId === undefined &&
        run.goalId === undefined &&
        run.agentGraphWakeId === undefined &&
        run.agentGraphWakeAttemptId === undefined
      );
    case 'legacy_automation':
      return (
        run.legacyAutomationId === execution.automationId &&
        run.scheduledTaskId === undefined &&
        run.goalId === undefined &&
        run.agentGraphWakeId === undefined &&
        run.agentGraphWakeAttemptId === undefined
      );
    case 'goal':
      return (
        run.goalId === execution.goalId &&
        run.scheduledTaskId === undefined &&
        run.legacyAutomationId === undefined &&
        run.agentGraphWakeId === undefined &&
        run.agentGraphWakeAttemptId === undefined
      );
    case 'agent_graph_supervisor_wake':
      return (
        execution.wakeId.startsWith(`${execution.graphId}:`) &&
        run.agentGraphWakeId === execution.wakeId &&
        run.agentGraphWakeAttemptId === execution.attemptId &&
        run.orchestrationMode === 'graph' &&
        run.orchestrationSource === 'turn_override' &&
        run.agentSwarmAuthorization === 'none' &&
        run.scheduledTaskId === undefined &&
        run.legacyAutomationId === undefined &&
        run.goalId === undefined
      );
  }
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
  'graph_supervisor_yielded',
  'run_status_changed',
  'model_resolved',
  'model_resolve_failed',
  'model_stream_started',
  'model_stream_completed',
  'model_stream_failed',
  'send_diagnostics_recorded',
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
  'provider_request_captured',
  'provider_request_attempt_recorded',
  'model_call_attempt_recorded',
  'history_compact_checkpoint_recorded',
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

/**
 * Derived state committed with the event that authorises it (#2323).
 *
 * `latestContext` rides the canonical completed-main attempt append so the two
 * cannot disagree: there is one durable commit for the request, and the
 * projection is a product of it rather than a second record racing it. A store
 * without projections ignores this; the projection is rebuildable either way.
 */
export interface AgentRunAppendOptions {
  durable?: boolean;
  latestContext?: LatestContextProjectionInput;
}

/**
 * The projection key. Deliberately NOT an emitted event type: nothing appends
 * a record under this name. It names one derived row per session, written by
 * the transaction that commits the canonical attempt and rebuildable from the
 * ledger at any time.
 */
export const LATEST_CONTEXT_PROJECTION_TYPE = 'latest_context';

/**
 * What a projection may be keyed by: usually an event type, but not always.
 *
 * Named once so every layer that passes a key declares the same thing. A store
 * whose parameter says `AgentRunEventType` while the interface it implements
 * says otherwise only pushes the mismatch out to its callers as a cast.
 */
export type AgentRunProjectionKey = AgentRunEventType | typeof LATEST_CONTEXT_PROJECTION_TYPE;

/**
 * Everything one settled provider request commits, as one value (#2323).
 *
 * Deliberately an object rather than positional arguments: a layer that
 * forwards only the attempt used to be a silent drop — JavaScript discards the
 * extra argument and TypeScript accepts the narrower callback — so the derived
 * row never reached storage in production. Passing one object makes an
 * incomplete forward a type error instead of a missing feature.
 */
export interface ModelCallCommit<TAttempt> {
  attempt: TAttempt;
  latestContext?: LatestContextProjectionInput;
}

/**
 * The facts a latest-context projection freezes, all bound to one request.
 *
 * `orderedAt` is what makes the projection monotonic: overlapping turns append
 * on independent queues, so arrival order is not completion order, and a later
 * arrival must not move the answer backwards.
 */
export interface LatestContextProjectionInput {
  attemptId: string;
  orderedAt: number;
  snapshot: Record<string, unknown>;
}

/** How two candidate latest-context rows compare. */
export interface LatestContextOrder {
  completedAt: number;
  attemptId: string;
}

/**
 * The one ordering rule for the latest-context row.
 *
 * Lives here because two independent writers must agree on it: the storage
 * transaction deciding whether an arriving commit supersedes the stored row,
 * and the cold rebuild deciding which record of a whole ledger is the newest.
 * A warm read and a rebuild of the same session that disagreed about which
 * request is "latest" would be indistinguishable from data loss.
 *
 * Completion time, never arrival — overlapping turns append on independent
 * queues. Ties break on `attemptId` rather than on arrival, so the answer does
 * not depend on which writer got there first.
 */
export function supersedesLatestContext(
  candidate: LatestContextOrder,
  incumbent: LatestContextOrder | undefined,
): boolean {
  if (!incumbent) return true;
  if (candidate.completedAt !== incumbent.completedAt) {
    return candidate.completedAt > incumbent.completedAt;
  }
  return candidate.attemptId > incumbent.attemptId;
}

/**
 * A decoded ledger record. The ledger is append-only and outlives any single build, so `type` is
 * an open string: a reader must accept a type another version wrote, whether that version retired
 * the writer or has not shipped yet (#1942). The envelope around `type` is still validated, so
 * this tolerance does not extend to a record that gained or lost a field.
 */
export interface AgentRunEvent {
  type: string;
  id: string;
  runId: string;
  sessionId: string;
  turnId: string;
  ts: number;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * What this build may append. `AGENT_RUN_EVENT_TYPES` is the emitted catalogue, not the readable
 * one, so it stays free to shrink when a writer retires while a misspelled or retired type fails
 * to compile at the append that would persist it.
 */
export interface EmittedAgentRunEvent extends AgentRunEvent {
  type: AgentRunEventType;
}

const EMITTED_AGENT_RUN_EVENT_TYPES: ReadonlySet<string> = new Set(AGENT_RUN_EVENT_TYPES);

/** Whether this build emits `type`, and so knows what its record means. */
export function isEmittedAgentRunEventType(type: string): type is AgentRunEventType {
  return EMITTED_AGENT_RUN_EVENT_TYPES.has(type);
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
    'scheduledTaskId',
    'legacyAutomationId',
    'goalId',
    'agentGraphWakeId',
    'agentGraphWakeAttemptId',
    'rootExecutionKind',
    'failureClass',
    'failureMessage',
    'abortSource',
    'traceWriteError',
    'collaborationMode',
    'orchestrationMode',
    'orchestrationSource',
    'agentSwarmAuthorization',
    'toolMode',
    'runComposition',
  ],
);

const AGENT_RUN_EVENT_SHAPE = defineObjectShape<AgentRunEvent>()(
  ['type', 'id', 'runId', 'sessionId', 'turnId', 'ts'],
  ['message', 'data'],
);

export function decodeAgentRunHeader(value: unknown): AgentRunHeader {
  if (
    isRecord(value) &&
    value.automationId !== undefined &&
    value.legacyAutomationId === undefined
  ) {
    const { automationId, ...current } = value;
    value = { ...current, legacyAutomationId: automationId };
  }
  if (!isRecord(value) || !hasExactShape(value, AGENT_RUN_HEADER_SHAPE)) {
    throw new Error('Invalid AgentRun header schema');
  }
  const status =
    value.status === 'waiting_permission' ? ('waiting_for_user' as const) : value.status;
  const valid =
    typeof value.runId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.turnId === 'string' &&
    (AGENT_RUN_STATUSES as readonly unknown[]).includes(status) &&
    isPersistedBackendKind(value.backendKind) &&
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
    (value.rootExecutionKind === undefined || value.rootExecutionKind === 'context_compact') &&
    Number(value.scheduledTaskId !== undefined) +
      Number(value.legacyAutomationId !== undefined) +
      Number(value.goalId !== undefined) +
      Number(value.agentGraphWakeId !== undefined) <=
      1 &&
    (value.toolMode === undefined || isToolMode(value.toolMode)) &&
    (value.runComposition === undefined || isRunCompositionSnapshot(value.runComposition)) &&
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
      value.scheduledTaskId,
      value.legacyAutomationId,
      value.goalId,
      value.agentGraphWakeId,
      value.agentGraphWakeAttemptId,
      value.failureClass,
      value.failureMessage,
      value.abortSource,
      value.traceWriteError,
    ].every(isOptionalString) &&
    (value.continuationSource === undefined ||
      isAgentRunContinuationSource(value.continuationSource));
  if (!valid) throw new Error('Invalid AgentRun header schema');
  if (status !== value.status) return { ...value, status } as unknown as AgentRunHeader;
  return value as unknown as AgentRunHeader;
}

function isRunCompositionSnapshot(value: unknown): value is RunCompositionSnapshot {
  try {
    decodeRunCompositionSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

function isAgentRunContinuationSource(value: unknown): value is AgentRunContinuationSource {
  if (!isRecord(value)) return false;
  const common =
    typeof value.sourceInvocationId === 'string' &&
    typeof value.sourceRunId === 'string' &&
    typeof value.sourceTurnId === 'string' &&
    typeof value.sourceRuntimeEventHighWater === 'number' &&
    Number.isSafeInteger(value.sourceRuntimeEventHighWater) &&
    value.sourceRuntimeEventHighWater >= 0;
  if (!common) return false;
  if (hasExactShape(value, AGENT_RUN_CONTINUATION_SOURCE_V1_SHAPE)) return true;
  return (
    hasExactShape(value, AGENT_RUN_CONTINUATION_SOURCE_V2_SHAPE) &&
    value.protocol === 'continuation_source_v2' &&
    typeof value.claimId === 'string' &&
    value.claimId.length > 0 &&
    typeof value.sourceInvocationId === 'string' &&
    value.sourceInvocationId.length > 0 &&
    typeof value.sourceRunId === 'string' &&
    value.sourceRunId.length > 0 &&
    typeof value.sourceTurnId === 'string' &&
    value.sourceTurnId.length > 0 &&
    typeof value.sourceRuntimeEventHighWater === 'number' &&
    value.sourceRuntimeEventHighWater > 0 &&
    isSha256Digest(value.boundaryDigest) &&
    isSha256Digest(value.sourcePrefixDigest) &&
    isSha256Digest(value.replayManifestDigest) &&
    value.replayManifestDigest === value.boundaryDigest
  );
}

function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function decodeAgentRunEvent(value: unknown): AgentRunEvent {
  if (
    !isRecord(value) ||
    !hasExactShape(value, AGENT_RUN_EVENT_SHAPE) ||
    typeof value.type !== 'string' ||
    value.type.trim().length === 0 ||
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

/**
 * Decode guard for a durable run header. `'fake'` stays accepted: runs written
 * by builds that shipped FakeBackend must keep decoding (#3211).
 */
function isPersistedBackendKind(value: unknown): value is PersistedBackendKind {
  return value === 'ai-sdk' || value === 'fake';
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
    event: EmittedAgentRunEvent,
    options?: AgentRunAppendOptions,
  ): Promise<void>;
  readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
  /**
   * `undefined` means uninitialized; `null` is an initialized empty projection.
   *
   * The key is a projection name, which is usually an event type but need not
   * be: `latest_context` names a derived row nothing appends under (#2323).
   */
  readEventProjection?(
    sessionId: string,
    type: AgentRunProjectionKey,
  ): Promise<AgentRunEvent | null | undefined>;
  /** Rewrites derived state after the canonical event ledger repairs an absent or damaged projection. */
  repairEventProjection?(
    sessionId: string,
    type: AgentRunProjectionKey,
    event: AgentRunEvent | null,
    options?: { replaceEventId?: string },
  ): Promise<void>;
}

/**
 * Whether a run contributes directly to the owning session's transcript.
 * Top-level continuations carry parent lineage for recovery, but unlike
 * child-agent runs their output remains part of the parent session
 * conversation. A legacy child retry may also carry continuation authority;
 * its agent identity keeps it outside the owning session transcript.
 */
export function isSessionInlineRun(run: {
  readonly parentRunId?: string;
  readonly continuationSource?: unknown;
  readonly agentId?: string;
}): boolean {
  return (
    run.parentRunId === undefined ||
    (run.continuationSource !== undefined && run.agentId === undefined)
  );
}
