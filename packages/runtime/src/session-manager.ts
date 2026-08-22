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
 * SessionManager — the public Runtime API.
 *
 * Ties together:
 *   SessionStore (storage)           — SQLite persistence
 *   AgentBackend (AiSdkBackend etc) — SDK adapter
 *   ExecutionBoundary                — session sandbox authority
 *
 * `SessionStore` comes from `@maka/storage`; its public interface owns
 * persistence and same-session serialization semantics.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ActiveInteractionRequestEvent,
  SessionEvent,
  CompleteEvent,
  TextDeltaEvent,
  ErrorEvent,
  AbortEvent,
  PermissionDecisionAckEvent,
  PermissionRequestEvent,
  QueueEnqueueOutcome,
  ShellRunUpdate,
  MessageContent,
} from '@maka/core/events';
import { messageContentsEqual, normalizeMessageContent } from '@maka/core/events';
import type {
  SessionHeader,
  SessionHeaderPatch,
  SessionBlockedReason,
  SessionStatus,
  SessionSummary,
  StoredMessage,
  SubagentSessionParent,
  TurnRecord,
  UserMessage,
  PermissionDecisionMessage,
  SystemNoteMessage,
  PersistedBackendKind,
} from '@maka/core/session';
import type {
  AgentSpec,
  ChildAgentTurnInput,
  CreateSessionInput,
  BranchFromTurnInput,
  RegenerateTurnInput,
  ReviseBeforeTurnInput,
  UserMessageInput,
  SessionListFilter,
} from '@maka/core/runtime-inputs';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { UserQuestionResponse } from '@maka/core/user-question';
import type { PermissionMode } from '@maka/core/permission';
import { DEFAULT_TOOL_MODE } from '@maka/core/tool-mode';
import type {
  CreateSandboxBoundaryRequest,
  ExecutionBoundary,
  SandboxBoundaryRequest,
  SandboxBoundarySettlement,
  SettleSandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { OrchestrationMode } from '@maka/core/orchestration';
import {
  PLAN_USER_ABANDON_REASON,
  PLAN_USER_CANCEL_REASON,
  PlanConflictError,
  type ApprovePlanProposalInput,
  type PlanMutationResult,
  type PlanSessionState,
  type PlanStore,
} from '@maka/core/plan';
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';
import { DEEP_RESEARCH_SESSION_LABEL, isDeepResearchSession } from '@maka/core/explore-agent';
import { SIDE_CONVERSATION_SESSION_LABEL } from '@maka/core/side-conversation';
import {
  SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION,
  SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION,
  childSessionsForParent,
  deriveTurnRecords,
  subagentSessionRuntimeSummary,
} from '@maka/core/session';
import { decodeAgentGraphIntentClaim } from '@maka/core/agent-graph-control';
import { executionBoundaryContains } from '@maka/core/sandbox-boundary';
import { failureClassFromCompleteStopReason } from '@maka/core/events';
import { isActiveShellRunStatus } from '@maka/core/shell-run';
import { isSessionInlineRun } from '@maka/core/agent-run';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import type {
  AgentGraphOperatorProvisionRequest,
  AgentGraphOperatorProvisionResult,
  AgentGraphProvisionedEdge,
} from '@maka/core/agent-graph-topology';
import type { AgentGraphScheduleUpdateSource } from '@maka/core/agent-graph-schedule';
import type {
  AgentRunEvent,
  AgentRunHeader,
  AgentRunStore,
  RootExecutionDescriptor,
} from '@maka/core/agent-run';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { ContinuationClaimV1 } from '@maka/core/runtime-boundary';
import type {
  ContinuationClaimStateV1,
  RuntimeEventStore,
  RuntimeContinuationAuthorityStore,
} from '@maka/core/runtime-event-store';
import type { RuntimeEvent, ToolBoundaryProtocol } from '@maka/core/runtime-event';
import type { RunCompositionSnapshot } from '@maka/core/run-composition';
import type {
  SubagentWorkspaceBinding,
  SubagentWorktreeExecutor,
} from '@maka/core/subagent-workspace';
import type { SubagentPreset } from '@maka/core/subagent-settings';
import { AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION } from '@maka/core/agent-graph-topology';
import {
  classifyRuntimeEventTerminalFact,
  type RuntimeEventTerminalFact,
} from './runtime-event-read-model.js';
import {
  RuntimeReadModel,
  RuntimeReadModelError,
  type RuntimeReadModelProjectionCache,
  type RuntimeReadModelSessionView,
} from './runtime-read-model.js';
import { inspectAgentRunReadModel, type AgentRunInspectModel } from './agent-run-inspect.js';
import {
  cloneConversationRuntimeLedger as cloneConversationLedger,
  createConversationCopySlice,
  prepareConversationRuntimeLedgerCopy,
  type ConversationRuntimeLedgerCopyPlan,
} from './conversation-copy.js';
import { firstRuntimeRepairRunId, RuntimeLedgerRepair } from './runtime-ledger-repair.js';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
  effectiveRunHeaderFromTerminalFact,
  terminalRunHeaderMatchesFact,
  terminalRunStatusFromRuntimeEvent,
} from './terminal-run-commit.js';

import type { AgentBackend, BackendStopMode } from '@maka/core/backend-types';
import type { MakaTool } from './tool-runtime.js';
import type { TurnShellPlan } from './shell-detect.js';
import type { RunTraceRecorder } from './run-trace.js';
import type { ModelCallAttempt } from '@maka/core/model-call-attempt';
import type {
  ProviderRequestAttemptRecord,
  ProviderRequestCaptureLedgerRecord,
} from './provider-request-telemetry.js';
import { readLatestContextDiagnostics, type ContextDiagnostics } from './context-diagnostics.js';
import type { ModelCallCommit } from '@maka/core/agent-run';
import type { ShellRunProcessManager } from './shell-run-manager.js';
import type { SemanticCompactBlock } from './semantic-compact.js';
import type { HistoryCompactCheckpoint } from './history-compact-checkpoint.js';
import type { AgentRunLineage, RuntimeContinuationFailpoint } from './agent-run.js';
import type { RuntimeCommitResult, RuntimeCommitSink } from './runtime-commit-sink.js';
import {
  attributeSandboxBoundaryRestartClosure,
  classifyAgentRunRecovery,
  type AgentRunRecoveryDecision,
} from './agent-run-recovery.js';
import { buildInterruptedCodeModeOutcomeCommits } from './recovery-resolver.js';
import type { InvocationResult, InvocationSource } from './invocation-context.js';
import {
  isRuntimeHostedRootAuthority,
  RuntimeMessageAuthorityInvariantError,
  type RuntimeHostedRootExecutionInput,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunIdentity,
} from './message-authority.js';
import {
  RuntimeInteractionInvariantError,
  type CanonicalPermissionOutcomeReader,
  type RuntimeInteractionAuthority,
} from './interaction-authority.js';
import {
  RuntimeKernel,
  SessionQuiescentMutationBusyError,
  type BackendActivationBoundary,
  type RuntimeExecutionClaim,
  type RuntimeKernelLike,
  type ResumeContinuationOptions,
  type TurnStartOptions,
} from './runtime-kernel.js';
import { fallbackSessionTitle, sessionTitleSource } from './session-title.js';
import type { HistoryCompactCleanupRequest } from './history-compact-checkpoint-coordinator.js';
import { fingerprintAgentGraphRunnableIntent } from './stream-graph-admission.js';
import type { AgentGraphRunnableIntent } from './stream-graph-readiness.js';
import { projectAgentGraphRecords } from './stream-graph-projection.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import {
  assertAgentDefinitionRunnable,
  buildToolsForAgentDefinition,
  getBuiltinAgentDefinition,
  listBuiltinAgentDefinitions,
  requireBuiltinAgentDefinition,
  requireBuiltinAgentDefinitionByProfile,
  AGENT_WORKSPACE_WORKTREE,
  type AgentProfile,
  type AgentDefinition,
  type AgentDefinitionListItem,
  type SubagentPresetListItem,
} from './agent-catalog.js';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import { stableHash } from './request-shape.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import {
  RuntimeContinuationPlanner,
  type RuntimeContinuation,
  type RuntimeContinuationPlannerInput,
  type RuntimeContinuationSafetyObservation,
  type SafeBoundaryContinuationPlan,
} from './runtime-resume.js';

function runtimeContinuationAuthority(
  store: RuntimeEventStore | undefined,
): RuntimeContinuationAuthorityStore | undefined {
  const candidate = store as Partial<RuntimeContinuationAuthorityStore> | undefined;
  return candidate?.continuationAuthorityCapability === 'runtime_continuation_authority_v1' &&
    typeof candidate.readImmutableRuntimePrefix === 'function' &&
    typeof candidate.readImmutableRuntimeEvents === 'function' &&
    typeof candidate.claimContinuation === 'function' &&
    typeof candidate.readContinuationClaimByBoundary === 'function' &&
    typeof candidate.readContinuationClaimStateByBoundary === 'function' &&
    typeof candidate.listContinuationClaimsForRecovery === 'function' &&
    typeof candidate.commitContinuationStart === 'function' &&
    typeof candidate.commitContinuationRepairStart === 'function'
    ? (candidate as RuntimeContinuationAuthorityStore)
    : undefined;
}

function runtimeCommitSinkFromEventStore(
  store: RuntimeEventStore | undefined,
): RuntimeCommitSink | undefined {
  const candidate = store as Partial<RuntimeCommitSink> | undefined;
  return typeof candidate?.commitToolPrepared === 'function' &&
    typeof candidate.commitToolOutcome === 'function'
    ? (candidate as RuntimeCommitSink)
    : undefined;
}

export interface StopSessionInput {
  source?: 'stop_button' | 'graph_supervisor';
  mode?: BackendStopMode;
}

interface CompactSessionOptions {
  /**
   * Override the configured recent-turn tail. Supervisor overflow recovery
   * uses zero because the failed wake turn itself can contain the oversized
   * tool result that must be folded.
   */
  minRecentTurns?: number;
}

export type CompactSessionInput =
  | (CompactSessionOptions & {
      turnId?: string;
      hostedRoot?: never;
    })
  | (CompactSessionOptions & {
      turnId: string;
      hostedRoot: {
        runId: string;
        onRunStarted?: () => void | Promise<void>;
      };
    });

export type PlanSafeBoundaryContinuationInput = Omit<RuntimeContinuationPlannerInput, 'sessionId'>;

export interface PlanAuthoritativeSafeBoundaryContinuationInput {
  sourceRunId: string;
  expectedRuntimeEventHighWater?: number;
}

export interface SpawnChildAgentInput {
  parentRunId: string;
  turnId?: string;
  spec: AgentSpec;
  prompt: string;
  abortSignal?: AbortSignal;
  onReady?: (input: { turnId: string; agentId: string; agentName: string }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

export interface SpawnChildSessionInput {
  spawnedBy: SubagentSessionParent['spawnedBy'];
  agentProfile: AgentProfile;
  /** User-approved catalog selector. The runtime resolves its frozen model target. */
  subagentId?: string;
  prompt: string;
  name?: string;
  turnId?: string;
  runId?: string;
  swarm?: SubagentSessionParent['swarm'];
  abortSignal?: AbortSignal;
  onReady?: (input: {
    childSessionId: string;
    turnId: string;
    runId: string;
    agentId: string;
    agentName: string;
    permissionMode: SessionHeader['permissionMode'];
  }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

type ResolvedSpawnChildSessionInput = SpawnChildSessionInput & {
  resolvedPreset?: SubagentPreset;
};

export interface SpawnChildSessionResult extends SpawnChildAgentResult {
  childSessionId: string;
  runId: string;
  profile: string;
}

export interface ProvisionAgentGraphOperatorInput {
  graphId: string;
  workId: string;
  agentId?: string;
  subagentId?: string;
  operatorId: string;
  source: AgentGraphScheduleUpdateSource;
  edges: AgentGraphProvisionedEdge[];
  expectedScheduleRevision: number;
}

export interface ProvisionAgentGraphOperatorResult extends AgentGraphOperatorProvisionResult {
  header: SessionHeader;
}

export interface RunClaimedAgentGraphIntentInput {
  /**
   * Embedded graph claim authority and stream-graph admission dependency.
   * Hosted execution treats this as a non-authoritative caller reference and
   * re-reads the claim through its trusted composition capability.
   */
  claimStore: AgentGraphIntentClaimStore;
  /** Complete control-plane input used to verify the durable claim fingerprint. */
  intent: AgentGraphRunnableIntent;
  graphId: string;
  intentId: string;
  prompt: string;
  /**
   * Optional control-plane gate evaluated after Session serialization and
   * immediately before a new Runtime turn is admitted. Existing durable runs
   * bypass the gate and remain recoverable.
   */
  admitExecution?: () => Promise<'executing' | 'cancelled'>;
  abortSignal?: AbortSignal;
  onReady?: (input: {
    claimId: string;
    graphId: string;
    intentId: string;
    operatorId: string;
    childSessionId: string;
    turnId: string;
    runId: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for the newly started runtime stream. */
  onEvent?: (event: SessionEvent) => void;
}

export interface ClaimedAgentGraphIntentResult extends SpawnChildSessionResult {
  claimId: string;
  graphId: string;
  intentId: string;
  operatorId: string;
}

type ResolvedClaimedAgentGraphIntentInput = Omit<
  RunClaimedAgentGraphIntentInput,
  'claimStore' | 'graphId' | 'intentId'
> & {
  claim: AgentGraphIntentClaim;
  hostedGraphExecution?: RuntimeHostedAgentGraphExecutionCapability;
};

export interface PrepareChildAgentResumeResult {
  sourceRunId: string;
  execution: SubagentExecutionRef;
  agentId: string;
  agentName: string;
  profile: string;
}

export interface ResumeChildAgentInput {
  parentRunId: string;
  sourceRunId: string;
  turnId?: string;
  prompt: string;
  abortSignal?: AbortSignal;
  onReady?: (input: {
    childSessionId?: string;
    turnId: string;
    runId?: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

export interface SpawnChildAgentResult {
  childSessionId?: string;
  agentId: string;
  agentName: string;
  turnId: string;
  runId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user';
  permissionMode: PermissionMode;
  summary: string;
  artifactIds: string[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
  eventCount: number;
  failureClass?: string;
  resumedFromRunId?: string;
  retriedFromRunId?: string;
}

export interface RetryChildAgentInput {
  parentRunId: string;
  sourceRunId: string;
  execution?: SubagentExecutionRef;
  abortSignal?: AbortSignal;
  onReady?: (input: {
    childSessionId?: string;
    turnId: string;
    runId?: string;
    agentId: string;
    agentName: string;
  }) => void | Promise<void>;
  /** Presentation-only observer for projecting child activity into a parent surface. */
  onEvent?: (event: SessionEvent) => void;
}

const CHILD_AGENT_SUMMARY_MAX_CHARS = 4_000;
const MAX_RUNTIME_LEDGER_REPAIR_ATTEMPTS = 8;

export interface AgentListItem {
  runId: string;
  turnId: string;
  parentRunId: string;
  agentId?: string;
  agentName?: string;
  status: AgentRunHeader['status'];
  permissionMode: AgentRunHeader['permissionMode'];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  failureClass?: string;
}

export interface SubagentExecutionListItem {
  execution: SubagentExecutionRef;
  agentId?: string;
  agentName?: string;
  profile?: string;
  turnId?: string;
  status: AgentRunHeader['status'];
  permissionMode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  failureClass?: string;
}

export interface AgentListResult {
  definitions: AgentDefinitionListItem[];
  /** User-configured, host-validated routes the main agent may select by id. */
  presets: SubagentPresetListItem[];
  /** Canonical mixed projection for new child Sessions and legacy same-session child AgentRuns. */
  executions: SubagentExecutionListItem[];
  /** Legacy projection retained while callers migrate to executions. */
  runs: AgentListItem[];
}

export interface AgentOutputInput {
  execution?: SubagentExecutionRef;
  runId?: string;
  turnId?: string;
  maxEvents?: number;
  maxBytes?: number;
  view?: AgentOutputView;
}

export type AgentOutputView = 'result' | 'events' | 'runtime_events' | 'all';

export interface AgentOutputCommittedResult {
  schemaVersion: 1;
  status: AgentRunHeader['status'];
  graph?: {
    graphId: string;
    workId: string;
    operatorId: string;
  };
  /** Committed Graph record containing the final non-partial model text, or the terminal record. */
  resultRecordId?: string;
  terminalRecordId?: string;
  sourceRuntimeEventId?: string;
  terminalRuntimeEventId?: string;
  text?: string;
  textTruncated: boolean;
  artifactIds: string[];
  omittedArtifactIds: number;
  failureClass?: string;
}

export interface AgentOutputResult {
  execution: SubagentExecutionRef;
  header: AgentRunHeader;
  result?: AgentOutputCommittedResult;
  events: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
  sourceHealth: AgentRunInspectModel['sourceHealth'];
  diagnostics: AgentRunInspectModel['diagnostics'];
  artifacts: ArtifactRecord[];
  truncated: {
    events: boolean;
    runtimeEvents: boolean;
    diagnostics: boolean;
    artifacts: boolean;
    bytes: boolean;
  };
  budget: {
    view: AgentOutputView;
    maxBytes: number;
    projectedBytes: number;
  };
}

// ============================================================================
// SessionStore contract (matches the storage package surface)
// ============================================================================

// StoredMessage rows remain a projection/cache surface for existing public
// shapes. RuntimeEventStore is the semantic conversation ledger.
export interface VersionedSessionHeader {
  readonly header: SessionHeader;
  readonly revision: number;
  readonly committedAt: number;
}

export interface SessionConfigurationStoreUpdate {
  readonly expectedVersion: number;
  readonly configuration: {
    readonly backend: SessionHeader['backend'];
    readonly llmConnectionSlug: string;
    readonly connectionLocked: boolean;
    readonly model: string;
    readonly thinkingLevel: SessionHeader['thinkingLevel'];
    readonly permissionMode: SessionHeader['permissionMode'];
    readonly collaborationMode: NonNullable<SessionHeader['collaborationMode']>;
    readonly orchestrationMode: NonNullable<SessionHeader['orchestrationMode']>;
    readonly labels: readonly string[];
  };
  readonly lifecycle:
    | { readonly kind: 'preserve' }
    | { readonly kind: 'clear_connection_block'; readonly statusUpdatedAt: number };
}

export interface SessionConfigurationTransitionRequest {
  readonly expectedRevision: number;
  readonly configuration: Omit<SessionConfigurationStoreUpdate['configuration'], 'labels'>;
}

export type SessionConfigurationTransitionErrorCode =
  | 'session_busy'
  | 'operation_conflict'
  | 'operation_unavailable';

export class SessionConfigurationTransitionError extends Error {
  readonly name = 'SessionConfigurationTransitionError';

  constructor(
    readonly code: SessionConfigurationTransitionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class SessionConfigurationRevisionConflictError extends Error {
  readonly name = 'SessionConfigurationRevisionConflictError';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Session configuration revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
    );
  }
}

export class RuntimeRegenerateTurnError extends Error {
  readonly name = 'RuntimeRegenerateTurnError';

  constructor(
    readonly code: 'not_found' | 'operation_conflict',
    message: string,
  ) {
    super(message);
  }
}

export interface RegenerateTurnSource {
  readonly sourceTurnId: string;
  readonly content: MessageContent;
}

export interface SessionStore {
  create(input: CreateSessionInput, initialBoundary?: ExecutionBoundary): Promise<SessionHeader>;
  createSubagent(
    input: CreateSessionInput,
    initialBoundary?: ExecutionBoundary,
  ): Promise<{ header: SessionHeader; created: boolean }>;
  readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary>;
  createSandboxBoundaryRequest?(
    input: CreateSandboxBoundaryRequest,
  ): Promise<SandboxBoundaryRequest>;
  listPendingSandboxBoundaryRequests?(sessionId: string): Promise<SandboxBoundaryRequest[]>;
  listSandboxBoundaryRestartClosures?(sessionId: string): Promise<SandboxBoundaryRequest[]>;
  settleSandboxBoundaryRequest?(
    input: SettleSandboxBoundaryRequest,
  ): Promise<SandboxBoundarySettlement>;
  setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ): Promise<ExecutionBoundary>;
  createAgentGraphOperator?(
    input: CreateSessionInput,
    request: AgentGraphOperatorProvisionRequest,
    expectedRevision: number,
    initialBoundary?: ExecutionBoundary,
  ): Promise<ProvisionAgentGraphOperatorResult>;
  list(filter?: SessionListFilter): Promise<SessionSummary[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
  readMessages(sessionId: string): Promise<StoredMessage[]>;
  readMessagesSnapshot?(sessionId: string): Promise<StoredMessage[]>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  appendMessage(sessionId: string, m: StoredMessage): Promise<void>;
  appendMessages(sessionId: string, ms: StoredMessage[]): Promise<void>;
  updateHeader(sessionId: string, patch: SessionHeaderPatch): Promise<SessionHeader>;
  updateHeaderVersioned?(
    sessionId: string,
    patch: SessionHeaderPatch,
    expectedRevision: number,
  ): Promise<VersionedSessionHeader>;
  readHeaderRecordSnapshot?(sessionId: string): Promise<VersionedSessionHeader>;
  updateSessionConfiguration?(
    sessionId: string,
    input: SessionConfigurationStoreUpdate,
  ): Promise<VersionedSessionHeader>;
  setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
  rename(sessionId: string, name: string): Promise<void>;
  setGeneratedTitleIfAbsent?(sessionId: string, title: string): Promise<SessionHeader | null>;
  remove(sessionId: string): Promise<void>;
}

export interface StrictRecoverySessionStore extends SessionStore {
  listForRecovery(): Promise<SessionHeader[]>;
  readMessagesForRecovery(sessionId: string): Promise<StoredMessage[]>;
}

export interface StrictRecoveryAgentRunStore extends AgentRunStore {
  listSessionRunsForRecovery(sessionId: string): Promise<AgentRunHeader[]>;
  readEventsForRecovery(sessionId: string, runId: string): Promise<AgentRunEvent[]>;
}

export interface StrictRecoveryStores {
  sessionStore: StrictRecoverySessionStore;
  agentRunStore: StrictRecoveryAgentRunStore;
}

// ============================================================================
// BackendRegistry — factory dispatch by the session header's durable backend
// ============================================================================

export interface BackendFactoryContext {
  sessionId: string;
  workspaceRoot: string;
  header: SessionHeader;
  store: SessionStore;
  /** Process-local cancellation for the execution that owns this activation. */
  abortSignal?: AbortSignal;
  appendMessage?: (message: StoredMessage) => Promise<void>;
  /**
   * Child-agent instruction channel. Legacy child runs and linked child
   * sessions populate this; an ordinary main-session activation leaves it
   * undefined. A
   * main-session factory that needs a system prompt must source it from
   * its own closure — do NOT route a main-session prompt through this
   * field, it is semantically the child instruction, not the session
   * system prompt.
   */
  systemPrompt?: string;
  /**
   * Optional hard tool ceiling on the *agent-permission* tools for this backend
   * activation. When present, a host may remove tools for stricter local
   * policy, but must never append, substitute, or otherwise expose an
   * agent-permission tool outside this exact set.
   *
   * Runtime protocol tools are outside that ceiling by construction (#2026).
   * `ArchiveRead` decodes a placeholder the runtime itself generated during
   * pruning; it grants no reach the parent did not already exercise, and
   * withholding it only strands content the model was explicitly told to
   * retrieve. The backend therefore binds it from the archive capability, not
   * from this set, which is why narrowing a child's allowlist can no longer
   * silently strip the decoder for placeholders that child will still receive.
   */
  tools?: readonly MakaTool[];
  /** Turn-scoped shell plan captured with a bound child tool ceiling. */
  turnShellPlan?: TurnShellPlan;
  recordRunTrace?: RunTraceRecorder;
  /** Durable AgentRun metadata row written after the private capture artifact. */
  recordProviderRequestCapture?: (capture: ProviderRequestCaptureLedgerRecord) => Promise<void>;
  /** Best-effort AgentRun row for one physical provider call. */
  recordProviderRequestAttempt?: (attempt: ProviderRequestAttemptRecord) => void;
  /**
   * Durable AgentRun row carrying the canonical accounting record for one
   * physical provider call. Distinct from the diagnostic row above: this one is
   * the metering source of truth (#1679).
   */
  recordModelCallAttempt?: (commit: ModelCallCommit<ModelCallAttempt>) => Promise<void>;
  /** Immutable Run policy snapshot; provider dispatch waits for this durable commit. */
  recordRunComposition?: (runId: string, snapshot: RunCompositionSnapshot) => Promise<void>;
  loadHistoryCompactCheckpoint?: () => Promise<HistoryCompactCheckpoint | undefined>;
  recordHistoryCompactCheckpoint?: (
    checkpoint: HistoryCompactCheckpoint,
    turnId: string,
  ) => Promise<void>;
  /**
   * Durable read of the given turn's persisted RuntimeEvents from the
   * authoritative run ledger. The Runtime reloads this projection between
   * provider requests; mid-turn compaction also derives its coverage pool from
   * the same durable facts.
   */
  loadTurnRuntimeEvents?: (turnId: string) => Promise<RuntimeEvent[]>;
  /** Whether this activation may fold its run ledger into session-scoped history. */
  allowMidTurnHistoryCompaction?: boolean;
  recordSemanticCompactBlock?: (block: SemanticCompactBlock) => void;
  shellRunContextSummary?: () => Promise<string | undefined>;
}

export type BackendFactory = (ctx: BackendFactoryContext) => AgentBackend | Promise<AgentBackend>;

export class BackendRegistry {
  private readonly factories = new Map<PersistedBackendKind, BackendFactory>();

  register(kind: PersistedBackendKind, factory: BackendFactory): void {
    this.factories.set(kind, factory);
  }

  async build(kind: PersistedBackendKind, ctx: BackendFactoryContext): Promise<AgentBackend> {
    const f = this.factories.get(kind);
    if (!f) throw new Error(`No backend factory registered for kind="${kind}"`);
    return await f(ctx);
  }

  has(kind: PersistedBackendKind): boolean {
    return this.factories.has(kind);
  }
}

// ============================================================================
// SessionManager
// ============================================================================

export interface RuntimeHostedAgentGraphExecutionCapability {
  readAgentGraphIntentClaim(
    graphId: string,
    intentId: string,
  ): Promise<AgentGraphIntentClaim | undefined>;
  readRootTurnAdmissionIdentity(
    sessionId: string,
    turnId: string,
  ): Promise<{ runId: string; userMessageId: string | null } | undefined>;
}

interface SessionManagerBaseDeps {
  store: SessionStore;
  planStore?: PlanStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  runtimeCommitSink?: RuntimeCommitSink;
  /** Host capability; RuntimeKernel gates it by the selected backend. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  childTools?: readonly MakaTool[];
  resolveChildTools?: (sessionId: string) => Promise<ResolvedChildToolActivation>;
  /** Host-owned user catalog. Runtime receives ids from models, never raw model targets. */
  subagentCatalog?: {
    list(): Promise<SubagentPresetListItem[]>;
    resolve(id: string): Promise<SubagentPreset>;
  };
  /** Host-owned filesystem isolation for worktree-backed child Sessions. */
  worktreeChildExecutor?: SubagentWorktreeExecutor;
  listArtifactsForTurn?: (sessionId: string, turnId: string) => Promise<ArtifactRecord[]>;
  /** Durable publication boundary for terminal worktree-child patches. */
  publishChildWorkspacePatch?: (input: {
    sessionId: string;
    turnId: string;
    binding: SubagentWorkspaceBinding;
    patch: Uint8Array;
  }) => Promise<ArtifactRecord>;
  /** Reject patch publication while the child still owns live Runtime Resources. */
  assertChildWorkspaceQuiescent?: (sessionId: string) => Promise<void>;
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  runtimeKernel?: RuntimeKernelLike;
  /** Optional host-owned parent run authority for runtimes that execute the parent externally. */
  isParentRunActive?: (sessionId: string, runId: string, turnId: string) => boolean;
  shellRuns?: ShellRunProcessManager;
  cleanupHistoryCompactArtifacts?: (input: HistoryCompactCleanupRequest) => Promise<void>;
  inspectContinuationSafety?: (sessionId: string) => Promise<RuntimeContinuationSafetyObservation>;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  runBackendActivation?: BackendActivationBoundary;
  safeBoundaryResumeEnabled?: boolean;
  /** Hosted composition capability. Omit for the production embedded queue. */
  messageAuthority?: RuntimeMessageAuthority;
  /** Trusted Host-owned graph readers. Hosted graph execution fails closed without them. */
  hostedAgentGraphExecution?: RuntimeHostedAgentGraphExecutionCapability;
  onContinuationLifecycleEvent?: (event: RuntimeContinuationLifecycleEvent) => void | Promise<void>;
  generateSessionTitle?: (input: {
    sessionId: string;
    header: SessionHeader;
    sourceText: string;
  }) => Promise<string | undefined>;
  onSessionTitleChanged?: (sessionId: string) => void;
}

export interface ResolvedChildToolActivation {
  readonly tools: readonly MakaTool[];
  readonly shell?: TurnShellPlan;
}

type SessionManagerInteractionDeps =
  | {
      /** Hosted composition capabilities. Omit both for embedded interaction ownership. */
      interactionAuthority: RuntimeInteractionAuthority;
      canonicalPermissionOutcomes: CanonicalPermissionOutcomeReader;
    }
  | {
      interactionAuthority?: undefined;
      canonicalPermissionOutcomes?: undefined;
    };

export type SessionManagerDeps = SessionManagerBaseDeps & SessionManagerInteractionDeps;

export type RuntimeContinuationLifecycleEvent =
  | {
      type: 'plan_approved';
      sessionId: string;
      sourceRunId: string;
      targetRunId: string;
    }
  | {
      type: 'plan_parked';
      sessionId: string;
      sourceRunId: string;
      rejectionReasons: readonly string[];
    }
  | {
      type: 'execution_started' | 'execution_completed';
      sessionId: string;
      sourceRunId: string;
      targetRunId: string;
    }
  | {
      type: 'execution_failed';
      sessionId: string;
      sourceRunId: string;
      targetRunId: string;
      errorClass: string;
    };

export class SessionManager {
  private readonly runtimeKernel: RuntimeKernelLike;
  private readonly runtimeLedgerRepair?: RuntimeLedgerRepair;
  private readonly preparedTranscriptLedgers = new Set<string>();
  private readonly runtimeCommitSink?: RuntimeCommitSink;
  private readonly activeHostedLinkedChildSessions = new Set<string>();
  private readonly childSessionSpawns = new Map<
    string,
    { requestFingerprint: string; promise: Promise<SpawnChildSessionResult> }
  >();
  private readonly claimedAgentGraphIntentRuns = new Map<
    string,
    { requestFingerprint: string; promise: Promise<ClaimedAgentGraphIntentResult> }
  >();
  private readonly claimedAgentGraphSessionTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionManagerDeps) {
    if (deps.runStore && !deps.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    if (deps.publishChildWorkspacePatch && !deps.listArtifactsForTurn) {
      throw new Error('Child workspace patch publication requires Artifact turn listing');
    }
    this.runtimeCommitSink =
      deps.runtimeCommitSink ?? runtimeCommitSinkFromEventStore(deps.runtimeEventStore);
    if (deps.runStore && deps.runtimeEventStore) {
      this.runtimeLedgerRepair = new RuntimeLedgerRepair({
        runStore: deps.runStore,
        runtimeEventStore: deps.runtimeEventStore,
        readMessages: (sessionId) => deps.store.readMessages(sessionId),
        appendMessage: (sessionId, message) => deps.store.appendMessage(sessionId, message),
        appendTurnState: (sessionId, turnId, status, lineage, options) =>
          this.appendTurnState(sessionId, turnId, status, lineage, options),
        newId: deps.newId,
        now: deps.now,
      });
    }
    this.runtimeKernel =
      deps.runtimeKernel ??
      new RuntimeKernel({
        ...deps,
        repairRunRuntimeLedger: (sessionId, runId) =>
          this.repairMissingTerminalFactOnce(sessionId, runId),
      });
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  async createSession(
    input: CreateSessionInput,
    options: { initialBoundary?: ExecutionBoundary } = {},
  ): Promise<SessionSummary> {
    const header = await this.deps.store.create(input, options.initialBoundary);
    return headerToSummary(header);
  }

  /**
   * Sessions plus the turn each one is running right now. The persisted status
   * cannot carry that: it is written only at the END of `AgentRun.begin`, it
   * reads the same before a turn starts and after it ends, and a crash between
   * a turn's end and its status write leaves `running` behind for good. The
   * live run is the fact, so a client can name what is running and — because
   * nothing survives the process — a restart reports the truth by itself.
   */
  /**
   * The turns this session is running right now. Same live fact `listSessions`
   * projects, for callers that need it about one session — notably to name the
   * turns a change is about.
   */
  runningTurnIds(sessionId: string): string[] {
    return this.runtimeKernel.runningTurnIds?.(sessionId) ?? [];
  }

  #projectLiveRunState(sessions: SessionSummary[]): SessionSummary[] {
    const runningTurnIds = this.runtimeKernel.runningTurnIds?.bind(this.runtimeKernel);
    if (!runningTurnIds) return sessions;
    return sessions.map((session) => ({
      ...session,
      runningTurnIds: runningTurnIds(session.id),
    }));
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionSummary[]> {
    return this.#projectLiveRunState(await this.deps.store.list(filter));
  }

  async listChildSessions(parentSessionId: string): Promise<SessionSummary[]> {
    const sessions = await this.deps.store.list({ subagentParentSessionId: parentSessionId });
    return this.#projectLiveRunState(childSessionsForParent(sessions, parentSessionId));
  }

  private async provisionChildWorkspace(
    parent: SessionHeader,
    definition: AgentDefinition,
    requestFingerprint: string,
  ): Promise<SubagentWorkspaceBinding | undefined> {
    if (definition.contract.workspace !== AGENT_WORKSPACE_WORKTREE) return undefined;
    const executor = this.deps.worktreeChildExecutor;
    if (!executor) {
      throw new Error(
        `Agent "${definition.id}" is unavailable: "worktree" workspace isolation requires a worktree child executor.`,
      );
    }
    const fingerprint = requestFingerprint.startsWith('sha256:')
      ? requestFingerprint.slice('sha256:'.length)
      : requestFingerprint;
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error('Child workspace request fingerprint must be SHA-256');
    }
    return executor.provision({
      leaseId: `subagent_worktree_${fingerprint.slice(0, 32)}`,
      sourceSessionId: parent.id,
      sourceCwd: parent.cwd,
      ...(parent.projectId !== undefined ? { sourceProjectId: parent.projectId } : {}),
    });
  }

  private async ensureChildWorkspace(header: SessionHeader): Promise<void> {
    const binding = header.subagentWorkspace;
    if (!binding) return;
    const executor = this.deps.worktreeChildExecutor;
    if (!executor) {
      throw new Error(
        `Child Session ${header.id} requires a worktree child executor for ${binding.worktreePath}`,
      );
    }
    if (header.cwd !== binding.worktreePath) {
      throw new Error(`Child Session ${header.id} workspace binding disagrees with its cwd`);
    }
    await executor.ensure(binding);
  }

  private hasWorktreePatchWriteBack(): boolean {
    return Boolean(
      this.deps.worktreeChildExecutor &&
        this.deps.listArtifactsForTurn &&
        this.deps.publishChildWorkspacePatch &&
        this.deps.assertChildWorkspaceQuiescent,
    );
  }

  private async isWorktreeChildExecutorAvailable(
    header: Pick<SessionHeader, 'cwd' | 'projectId'>,
  ): Promise<boolean> {
    const executor = this.deps.worktreeChildExecutor;
    if (!executor) return false;
    return await executor.isAvailable({
      sourceCwd: header.cwd,
      ...(header.projectId !== undefined ? { sourceProjectId: header.projectId } : {}),
    });
  }

  private async finalizeAndListChildTurnArtifacts(
    sessionId: string,
    turnId: string,
    status: AgentRunHeader['status'],
  ): Promise<ArtifactRecord[]> {
    const list = this.deps.listArtifactsForTurn;
    if (!list) return [];
    const artifacts = await list(sessionId, turnId);
    if (!isTerminalRunStatus(status) || !this.hasWorktreePatchWriteBack()) return artifacts;
    const header = await this.deps.store.readHeader(sessionId);
    if (!header.subagentWorkspace) return artifacts;
    const existing = artifacts.find((artifact) => artifact.source === 'subagent_writeback');
    if (existing) return artifacts;

    await this.finalizeChildWorkspacePatches(sessionId);
    const finalized = await list(sessionId, turnId);
    if (!finalized.some((artifact) => artifact.source === 'subagent_writeback')) {
      throw new Error(
        `Child Session ${sessionId} cannot reconstruct the historical workspace patch for Turn ${turnId}`,
      );
    }
    return finalized;
  }

  /** Publish the recoverable write-back owed by the latest terminal worktree child Run. */
  async finalizeChildWorkspacePatches(sessionId: string): Promise<void> {
    if (!this.hasWorktreePatchWriteBack() || !this.deps.runStore) return;
    const header = await this.deps.store.readHeader(sessionId);
    const binding = header.subagentWorkspace;
    if (!binding) return;

    const latest = (await this.deps.runStore.listSessionRuns(sessionId))
      .filter(isSessionInlineRun)
      .sort(
        (left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId),
      )[0];
    if (!latest) return;
    if (!isTerminalRunStatus(latest.status)) {
      throw new Error(
        `Child Session ${sessionId} cannot finalize its workspace while Run ${latest.runId} is nonterminal`,
      );
    }
    const artifacts = await this.deps.listArtifactsForTurn!(sessionId, latest.turnId);
    if (artifacts.some((artifact) => artifact.source === 'subagent_writeback')) return;

    await this.deps.assertChildWorkspaceQuiescent!(sessionId);
    await this.ensureChildWorkspace(header);
    const patch = await this.deps.worktreeChildExecutor!.capturePatch(binding);
    const published = await this.deps.publishChildWorkspacePatch!({
      sessionId,
      turnId: latest.turnId,
      binding,
      patch,
    });
    if (
      published.sessionId !== sessionId ||
      published.turnId !== latest.turnId ||
      published.source !== 'subagent_writeback'
    ) {
      throw new Error('Child workspace patch publisher returned a mismatched Artifact');
    }
  }

  async recoverChildWorkspacePatches(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) await this.finalizeChildWorkspacePatches(sessionId);
  }

  /** Invalidate backend snapshots now, or immediately after active turns settle. */
  refreshIdleBackends(): Promise<void> {
    return this.runtimeKernel.invalidateCachedBackends();
  }

  disposeSessionBackend(sessionId: string): Promise<void> {
    return this.runtimeKernel.disposeBackend(sessionId);
  }

  async transitionSessionConfiguration(
    sessionId: string,
    input: SessionConfigurationTransitionRequest,
  ): Promise<VersionedSessionHeader> {
    const store = this.requireSessionConfigurationStore();
    const next = await this.commitExecutionResourceTransition(
      sessionId,
      input.configuration.permissionMode,
      async () => {
        const current = await store.readHeaderRecordSnapshot(sessionId);
        if (current.revision !== input.expectedRevision) {
          throw new SessionConfigurationRevisionConflictError(
            input.expectedRevision,
            current.revision,
          );
        }
        if (current.header.isArchived) {
          throw new SessionConfigurationTransitionError(
            'operation_conflict',
            'Archived Session configuration cannot be changed',
          );
        }
        if (current.header.status === 'waiting_for_user') {
          throw new SessionConfigurationTransitionError(
            'session_busy',
            'Session has a pending Interaction',
          );
        }
        await this.assertCollaborationTransition(
          current.header,
          input.configuration.collaborationMode,
        );
        const leavingDeepResearch =
          isDeepResearchSession(current.header.labels) &&
          input.configuration.permissionMode !== 'explore';
        const labels = leavingDeepResearch
          ? current.header.labels.filter((label) => label !== DEEP_RESEARCH_SESSION_LABEL)
          : current.header.labels;
        return () =>
          store.updateSessionConfiguration(sessionId, {
            expectedVersion: input.expectedRevision,
            configuration: {
              ...input.configuration,
              labels,
            },
            lifecycle:
              current.header.blockedReason === 'NO_REAL_CONNECTION'
                ? {
                    kind: 'clear_connection_block',
                    statusUpdatedAt: this.deps.now(),
                  }
                : { kind: 'preserve' },
          });
      },
    );
    this.runtimeKernel.updateCachedHeader(sessionId, next.header);
    return next;
  }

  async relocateSessionWorkspace(
    sessionId: string,
    input: {
      readonly expectedRevision: number;
      readonly cwd: string;
      readonly projectId?: string | null;
    },
  ): Promise<VersionedSessionHeader> {
    const updateHeaderVersioned = this.deps.store.updateHeaderVersioned?.bind(this.deps.store);
    const readHeaderRecordSnapshot = this.deps.store.readHeaderRecordSnapshot?.bind(
      this.deps.store,
    );
    if (!updateHeaderVersioned || !readHeaderRecordSnapshot) {
      throw new SessionConfigurationTransitionError(
        'operation_unavailable',
        'Session workspace relocation authority is unavailable',
      );
    }
    const next = await this.runSessionQuiescentMutation([sessionId], async () => {
      if (this.runtimeKernel.hasActiveRuns(sessionId)) {
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session workspace cannot change while a Turn is active',
        );
      }
      const current = await readHeaderRecordSnapshot(sessionId);
      if (current.revision !== input.expectedRevision) {
        throw new SessionConfigurationRevisionConflictError(
          input.expectedRevision,
          current.revision,
        );
      }
      if (current.header.isArchived) {
        throw new SessionConfigurationTransitionError(
          'operation_conflict',
          'Archived Session workspace cannot be relocated',
        );
      }
      if (current.header.subagentWorkspace || current.header.subagentParent) {
        throw new SessionConfigurationTransitionError(
          'operation_unavailable',
          'Managed child Session workspaces cannot be relocated',
        );
      }
      if (current.header.status === 'waiting_for_user') {
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session has a pending Interaction',
        );
      }
      const projectIdChanged =
        input.projectId !== undefined && current.header.projectId !== input.projectId;
      if (current.header.cwd === input.cwd && !projectIdChanged) return current;

      if (current.header.cwd === input.cwd) {
        return updateHeaderVersioned(
          sessionId,
          { projectId: input.projectId },
          input.expectedRevision,
        );
      }

      const shellRunClose = await this.deps.shellRuns?.terminateSession(sessionId);
      let committed: VersionedSessionHeader;
      try {
        await this.runtimeKernel.disposeBackend(sessionId);
        committed = await updateHeaderVersioned(
          sessionId,
          {
            cwd: input.cwd,
            ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          },
          input.expectedRevision,
        );
      } catch (error) {
        if (shellRunClose) this.deps.shellRuns?.rollbackSessionClose(shellRunClose);
        throw error;
      }
      if (shellRunClose) await this.deps.shellRuns?.commitSessionClose(shellRunClose);
      this.deps.shellRuns?.resumeSession(sessionId);
      return committed;
    });
    this.runtimeKernel.updateCachedHeader(sessionId, next.header);
    return next;
  }

  async getMessages(sessionId: string): Promise<StoredMessage[]> {
    return (await this.getSessionView(sessionId)).messages;
  }

  async getContextDiagnostics(sessionId: string): Promise<ContextDiagnostics> {
    const runStore = this.deps.runStore;
    return runStore
      ? readLatestContextDiagnostics(runStore, sessionId)
      : { status: 'unavailable', reason: 'trace_unavailable' };
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (await this.getSessionView(sessionId)).turns;
  }

  async listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return [];

    const ownUpdates = await shellRuns.listSessionUpdates(sessionId);
    const ownToolCalls = new Set(ownUpdates.map((update) => update.sourceToolCallId));
    const messages = await this.readShellRunProjectionMessages(sessionId);
    if (!messages) return ownUpdates;
    const bashToolCalls = shellRunBashToolCallIds(messages);
    const inherited = new Map<
      string,
      {
        ref: string;
        turnId: string;
        toolUseId: string;
        result: ShellRunUpdate['result'];
      }
    >();
    for (const message of messages) {
      if (
        message.type === 'tool_result' &&
        bashToolCalls.has(message.toolUseId) &&
        !ownToolCalls.has(message.toolUseId) &&
        message.content.kind === 'shell_run' &&
        isActiveShellRunStatus(message.content.status)
      ) {
        const { operation: _operation, ...result } = message.content;
        inherited.set(message.toolUseId, {
          ref: message.content.ref,
          turnId: message.turnId,
          toolUseId: message.toolUseId,
          result,
        });
      }
    }
    if (inherited.size === 0) return ownUpdates;

    const inheritedFrom = await this.deps.store.readHeader(sessionId);
    const parentSessionId = inheritedFrom.revisionParentSessionId ?? inheritedFrom.parentSessionId;
    if (!parentSessionId) return ownUpdates;
    const inheritedUpdates = await Promise.all(
      [...inherited.values()].map(async (candidate) => {
        const owner = await this.resolveShellRunOwner(parentSessionId, candidate.ref);
        return {
          sessionId,
          ownership: owner
            ? {
                kind: 'source_owned',
                sourceSessionId: parentSessionId,
                ownerSessionId: owner.sessionId,
              }
            : { kind: 'source_unavailable', sourceSessionId: parentSessionId },
          sourceTurnId: candidate.turnId,
          sourceToolCallId: candidate.toolUseId,
          result: owner?.result ?? candidate.result,
        } satisfies ShellRunUpdate;
      }),
    );
    return [...ownUpdates, ...inheritedUpdates];
  }

  async getShellRunUpdate(sessionId: string, ref: string): Promise<ShellRunUpdate | null> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return null;
    const own = await shellRuns.getSessionUpdate(sessionId, ref);
    if (own) return own;

    const messages = await this.readShellRunProjectionMessages(sessionId);
    if (!messages) return null;
    const bashToolCalls = shellRunBashToolCallIds(messages);
    let candidate:
      | {
          turnId: string;
          toolUseId: string;
          result: ShellRunUpdate['result'];
        }
      | undefined;
    for (const message of messages) {
      if (
        message.type === 'tool_result' &&
        bashToolCalls.has(message.toolUseId) &&
        message.content.kind === 'shell_run' &&
        message.content.ref === ref &&
        isActiveShellRunStatus(message.content.status)
      ) {
        const { operation: _operation, ...result } = message.content;
        candidate = { turnId: message.turnId, toolUseId: message.toolUseId, result };
      }
    }
    if (!candidate) return null;

    const inheritedFrom = await this.deps.store.readHeader(sessionId);
    const parentSessionId = inheritedFrom.revisionParentSessionId ?? inheritedFrom.parentSessionId;
    if (!parentSessionId) return null;
    const owner = await this.resolveShellRunOwner(parentSessionId, ref);
    return {
      sessionId,
      ownership: owner
        ? {
            kind: 'source_owned',
            sourceSessionId: parentSessionId,
            ownerSessionId: owner.sessionId,
          }
        : { kind: 'source_unavailable', sourceSessionId: parentSessionId },
      sourceTurnId: candidate.turnId,
      sourceToolCallId: candidate.toolUseId,
      result: owner?.result ?? candidate.result,
    };
  }

  async recoverInterruptedSessions(): Promise<string[]> {
    return this.recoverInterruptedSessionsWithPolicy({ kind: 'best_effort' });
  }

  async recoverInterruptedSessionsStrict(stores: StrictRecoveryStores): Promise<string[]> {
    if (stores.sessionStore !== this.deps.store || stores.agentRunStore !== this.deps.runStore) {
      throw new Error('Strict recovery stores must match the SessionManager composition');
    }
    return this.recoverInterruptedSessionsWithPolicy({ kind: 'strict', stores });
  }

  private async recoverInterruptedSessionsWithPolicy(policy: RecoveryPolicy): Promise<string[]> {
    const interrupted = (await listSessionsForRecovery(this.deps.store, policy)).filter(
      (session) => !session.isArchived,
    );
    const recovered = new Set<string>();
    for (const session of interrupted) {
      if (this.runtimeLedgerRepair) {
        await recoverOr(
          policy,
          () => this.runtimeLedgerRepair!.repairSteeringMessagesOnce(session.id),
          0,
        );
      }
      if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
      // Fail-closed: a request whose live owner died can never be answered, so
      // it settles as `deny` with a durable `host_restarted` reason. The run
      // recovery below reads those settled rows back — it never depends on what
      // this pass happened to close (#1612).
      if (
        !this.deps.interactionAuthority &&
        this.deps.store.listPendingSandboxBoundaryRequests &&
        this.deps.store.settleSandboxBoundaryRequest
      ) {
        const pendingBoundaryRequests = await recoverOr(
          policy,
          () => this.deps.store.listPendingSandboxBoundaryRequests!(session.id),
          [],
        );
        for (const request of pendingBoundaryRequests) {
          await recoverOr(
            policy,
            () =>
              this.deps.store.settleSandboxBoundaryRequest!({
                sessionId: session.id,
                requestId: request.requestId,
                decision: 'deny',
                closureReason: 'host_restarted',
              }),
            undefined,
          );
        }
      }
      if (this.deps.planStore) {
        const planRecovery = await recoverOr(
          policy,
          () => this.deps.planStore!.interruptActiveExecution(session.id, 'runtime_recovery'),
          null,
        );
        if (planRecovery) recovered.add(session.id);
      }
      if (this.deps.shellRuns) {
        const recoveredShellRuns = await recoverOr(
          policy,
          () => this.deps.shellRuns!.recoverOrphanedSession(session.id),
          0,
        );
        if (recoveredShellRuns > 0) recovered.add(session.id);
      }
      let messages: StoredMessage[] = [];
      let messagesReadable = true;
      try {
        messages =
          policy.kind === 'strict'
            ? await policy.stores.sessionStore.readMessagesForRecovery(session.id)
            : await this.deps.store.readMessages(session.id);
      } catch (error) {
        if (policy.kind === 'strict') throw error;
        messagesReadable = false;
      }

      if (session.revisionState === 'preparing' && messagesReadable) {
        if (hasRevisionUserMessage(messages)) {
          await recoverOr(policy, () => this.commitRevisionVersion(session.id), undefined);
        } else {
          await recoverOr(policy, () => this.remove(session.id), undefined);
          recovered.add(session.id);
          continue;
        }
      }

      let continuationClaimRecovered = false;
      const continuationAuthority = runtimeContinuationAuthority(this.deps.runtimeEventStore);
      if (this.deps.runStore && continuationAuthority) {
        try {
          continuationClaimRecovered = await this.recoverContinuationClaimsBeforeProvider(
            session.id,
            continuationAuthority,
            policy,
          );
        } catch (error) {
          if (policy.kind === 'strict') throw error;
          // A configured canonical continuation authority that cannot be read
          // is not equivalent to "no continuation claim". Quarantine this
          // session from every legacy/generic repair path until the authority
          // becomes readable again.
          continue;
        }
        if (continuationClaimRecovered) recovered.add(session.id);
      }

      if (this.deps.runStore) {
        const runRecovery = await recoverOr(
          policy,
          () => this.recoverAgentRunsFromLedger(session.id, policy),
          undefined,
        );
        if (runRecovery?.hasLedger) {
          if (runRecovery.recovered || continuationClaimRecovered) {
            await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
            recovered.add(session.id);
          } else if (
            !messagesReadable &&
            (session.status === 'running' || session.status === 'waiting_for_user')
          ) {
            await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
            recovered.add(session.id);
          }
          continue;
        }
      }

      if (!messagesReadable) {
        if (session.status === 'running' || session.status === 'waiting_for_user') {
          // Recovery may run in BACKGROUND startup (#456): re-check for a
          // run the user started while this session's recovery was in
          // flight, so we never stomp a live run's status.
          if (this.runtimeKernel.hasActiveRuns(session.id)) continue;
          await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
          recovered.add(session.id);
        }
        continue;
      }

      const recoveries = interruptedTurnRecoveries(messages);
      if (recoveries.length === 0) continue;
      for (const recovery of recoveries) {
        await recoverOr(
          policy,
          () =>
            this.appendTurnState(session.id, recovery.turnId, 'failed', recovery.lineage, {
              errorClass: recovery.errorClass,
            }),
          undefined,
        );
      }
      if (session.status === 'running' || session.status === 'waiting_for_user') {
        // Same double-check as above: a message sent mid-recovery owns
        // the session status now (its own transitions will settle it).
        if (this.runtimeKernel.hasActiveRuns(session.id)) {
          recovered.add(session.id);
          continue;
        }
        await recoverOr(policy, () => this.updateStatus(session.id, 'active'), undefined);
      }
      recovered.add(session.id);
    }
    return [...recovered];
  }

  async setSessionStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
  ): Promise<SessionSummary> {
    const next = await this.deps.store.updateHeader(
      sessionId,
      buildStatusPatch(status, this.deps.now(), blockedReason),
    );
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async commitRevisionVersion(sessionId: string): Promise<SessionSummary> {
    const current = await this.deps.store.readHeader(sessionId);
    if (current.revisionState !== 'preparing') return headerToSummary(current);
    const next = await this.deps.store.updateHeader(sessionId, { revisionState: 'committed' });
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.deps.store.setFlagged(sessionId, isFlagged);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.deps.store.rename(sessionId, name);
    const header = await this.deps.store.readHeader(sessionId).catch(() => undefined);
    if (header) this.runtimeKernel.updateCachedHeader(sessionId, header);
  }

  async readExecutionBoundary(sessionId: string): Promise<ExecutionBoundary> {
    return this.deps.store.readExecutionBoundary(sessionId);
  }

  async listActiveInteractions(sessionId: string): Promise<ActiveInteractionRequestEvent[]> {
    await this.deps.store.readHeader(sessionId);
    return this.runtimeKernel.listActiveInteractions?.(sessionId) ?? [];
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const boundary = await this.deps.store.readExecutionBoundary(sessionId);
    const leavingDeepResearch = isDeepResearchSession(previous.labels) && mode !== 'explore';
    if (
      previous.permissionMode === mode &&
      executionBoundaryMatchesPermissionMode(boundary, mode) &&
      !leavingDeepResearch
    ) {
      return headerToSummary(previous);
    }

    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('当前任务正在运行，等结束后再切换权限模式。');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换权限模式。');
    }

    const labels = leavingDeepResearch
      ? previous.labels.filter((label) => label !== DEEP_RESEARCH_SESSION_LABEL)
      : previous.labels;
    const nextKind = mode === 'bypass' ? 'bypass' : 'managed';
    await this.commitExecutionBoundaryTransition(sessionId, boundary, nextKind, {
      permissionMode: mode,
      labels,
    });
    const next = await this.deps.store.readHeader(sessionId);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    await this.deps.store
      .appendMessage(sessionId, {
        type: 'system_note',
        id: this.deps.newId(),
        ts: this.deps.now(),
        kind: 'mode_change',
        data: { from: previous.permissionMode, to: mode },
      } satisfies SystemNoteMessage)
      .catch(() => undefined);
    return headerToSummary(next);
  }

  async setExecutionBoundaryKind(
    sessionId: string,
    kind: 'managed' | 'bypass',
  ): Promise<ExecutionBoundary> {
    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('当前任务正在运行，等结束后再切换沙箱边界。');
    }
    const header = await this.deps.store.readHeader(sessionId);
    if (header.status === 'waiting_for_user') {
      throw new Error('当前有沙箱边界请求正在等待确认，处理后再切换。');
    }
    const current = await this.deps.store.readExecutionBoundary(sessionId);
    const boundary = await this.commitExecutionBoundaryTransition(sessionId, current, kind);
    return boundary;
  }

  private async commitExecutionBoundaryTransition(
    sessionId: string,
    current: ExecutionBoundary,
    kind: 'managed' | 'bypass',
    projection?: {
      permissionMode: SessionHeader['permissionMode'];
      labels?: readonly string[];
    },
  ): Promise<ExecutionBoundary> {
    const nextPermissionMode = projection?.permissionMode ?? (kind === 'bypass' ? 'bypass' : 'ask');
    return this.commitExecutionResourceTransition(sessionId, nextPermissionMode, async () => {
      const latest = await this.deps.store.readExecutionBoundary(sessionId);
      if (latest.revision !== current.revision) {
        throw new SessionConfigurationTransitionError(
          'operation_conflict',
          'Session execution boundary changed before the transition',
        );
      }
      return () => this.deps.store.setExecutionBoundaryKind(sessionId, kind, projection);
    });
  }

  private async commitExecutionResourceTransition<T>(
    sessionId: string,
    nextPermissionMode: PermissionMode,
    prepareCommit: () => Promise<() => Promise<T>>,
  ): Promise<T> {
    const initialBoundary = await this.deps.store.readExecutionBoundary(sessionId);
    const initiallyNarrows = narrowsExecutionAuthority(initialBoundary, nextPermissionMode);
    const initialDescendants = initiallyNarrows
      ? await this.listLinkedDescendantSessionIds(sessionId)
      : [];
    const fencedSessionIds = [sessionId, ...initialDescendants];

    return this.runSessionQuiescentMutation<T>(fencedSessionIds, async () => {
      const currentBoundary = await this.deps.store.readExecutionBoundary(sessionId);
      const narrowsShellAuthority = narrowsExecutionAuthority(currentBoundary, nextPermissionMode);
      const descendantSessionIds = narrowsShellAuthority
        ? await this.listLinkedDescendantSessionIds(sessionId)
        : [];
      if (
        descendantSessionIds.some(
          (descendantSessionId) => !fencedSessionIds.includes(descendantSessionId),
        )
      ) {
        throw new SessionConfigurationTransitionError(
          'operation_conflict',
          'Session lineage changed before the configuration transition',
        );
      }
      const lineageSessionIds = [sessionId, ...descendantSessionIds];
      if (lineageSessionIds.some((id) => this.runtimeKernel.hasActiveRuns(id))) {
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session configuration cannot change while a linked Turn is active',
        );
      }
      if (narrowsShellAuthority && !this.deps.shellRuns) {
        throw new SessionConfigurationTransitionError(
          'operation_unavailable',
          'Session permission narrowing requires Runtime Resource authority',
        );
      }

      const commit = await prepareCommit();
      const descendantBoundaries = new Map<string, ExecutionBoundary>();
      for (const descendantSessionId of descendantSessionIds) {
        descendantBoundaries.set(
          descendantSessionId,
          await this.deps.store.readExecutionBoundary(descendantSessionId),
        );
      }
      const shellRunCloses: Array<Awaited<ReturnType<ShellRunProcessManager['terminateSession']>>> =
        [];
      try {
        if (narrowsShellAuthority) {
          for (const lineageSessionId of lineageSessionIds) {
            const close = await this.deps.shellRuns?.terminateSession(lineageSessionId);
            if (close) shellRunCloses.push(close);
          }
        }
        await Promise.all(
          lineageSessionIds.map((lineageSessionId) =>
            this.runtimeKernel.disposeBackend(lineageSessionId),
          ),
        );
      } catch {
        for (const close of shellRunCloses) this.deps.shellRuns?.rollbackSessionClose(close);
        throw new SessionConfigurationTransitionError(
          'operation_unavailable',
          'Session execution resources could not be refreshed',
        );
      }

      let result: T;
      try {
        result = await commit();
      } catch (error) {
        for (const close of shellRunCloses) this.deps.shellRuns?.rollbackSessionClose(close);
        throw error;
      }

      for (const close of shellRunCloses) await this.deps.shellRuns?.commitSessionClose(close);
      if (shellRunCloses.length > 0) {
        const committedBoundary = await this.deps.store.readExecutionBoundary(sessionId);
        this.deps.shellRuns?.resumeSession(sessionId);
        for (const [descendantSessionId, descendantBoundary] of descendantBoundaries) {
          if (executionBoundaryContains(committedBoundary, descendantBoundary)) {
            this.deps.shellRuns?.resumeSession(descendantSessionId);
          }
        }
      }
      return result;
    });
  }

  private async runSessionQuiescentMutation<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.runtimeKernel.runSessionQuiescentMutation) {
      throw new SessionConfigurationTransitionError(
        'operation_unavailable',
        'Session execution mutation authority is unavailable',
      );
    }
    try {
      return await this.runtimeKernel.runSessionQuiescentMutation(sessionIds, operation);
    } catch (error) {
      if (error instanceof SessionQuiescentMutationBusyError) {
        throw new SessionConfigurationTransitionError(
          'session_busy',
          'Session configuration cannot change while a linked Turn is active',
        );
      }
      throw error;
    }
  }

  private async listLinkedDescendantSessionIds(sessionId: string): Promise<string[]> {
    const sessions = await this.deps.store.list();
    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
      const parentSessionId = session.subagentParent?.parentSessionId;
      if (!parentSessionId) continue;
      const children = childrenByParent.get(parentSessionId) ?? [];
      children.push(session.id);
      childrenByParent.set(parentSessionId, children);
    }
    const descendants: string[] = [];
    const pending = [...(childrenByParent.get(sessionId) ?? [])];
    const seen = new Set([sessionId]);
    while (pending.length > 0) {
      const descendantSessionId = pending.shift()!;
      if (seen.has(descendantSessionId)) continue;
      seen.add(descendantSessionId);
      descendants.push(descendantSessionId);
      pending.push(...(childrenByParent.get(descendantSessionId) ?? []));
    }
    return descendants;
  }

  async getPlanState(sessionId: string): Promise<PlanSessionState> {
    return this.requirePlanStore().readState(sessionId);
  }

  hasPlanAuthority(): boolean {
    return this.deps.planStore !== undefined;
  }

  async setCollaborationMode(sessionId: string, mode: CollaborationMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const from = previous.collaborationMode ?? 'agent';
    if (from === mode) return headerToSummary(previous);
    if (mode === 'plan' && previous.subagentParent) {
      throw new PlanConflictError('Linked child Sessions cannot enter Plan mode');
    }
    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('当前任务正在运行，等结束后再切换协作模式。');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('当前有工具调用正在等待确认，处理后再切换协作模式。');
    }
    const planState = await this.requirePlanStore().readState(sessionId);
    if (mode === 'plan' && planState.activeExecutionId) {
      throw new Error('当前计划仍在执行，结束或中断后才能切换到 Plan Mode。');
    }
    const latestProposal = planState.proposals.find(
      (proposal) => proposal.proposalId === planState.latestProposalId,
    );
    if (mode === 'agent' && latestProposal?.status === 'pending_approval') {
      throw new Error('当前方案正在等待审批，请明确放弃方案后再退出 Plan Mode。');
    }

    const next = await this.deps.store.updateHeader(sessionId, {
      collaborationMode: mode,
    });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { dimension: 'collaboration', from, to: mode },
    } satisfies SystemNoteMessage);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    await this.runtimeKernel.disposeBackend(sessionId);
    return headerToSummary(next);
  }

  async setOrchestrationMode(sessionId: string, mode: OrchestrationMode): Promise<SessionSummary> {
    const previous = await this.deps.store.readHeader(sessionId);
    const from = previous.orchestrationMode ?? 'default';
    if (from === mode) return headerToSummary(previous);
    if (this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new Error('Cannot change orchestration mode while a turn is running.');
    }
    if (previous.status === 'waiting_for_user') {
      throw new Error('Cannot change orchestration mode while a tool call awaits confirmation.');
    }
    const next = await this.deps.store.updateHeader(sessionId, { orchestrationMode: mode });
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: this.deps.newId(),
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { dimension: 'orchestration', from, to: mode },
    } satisfies SystemNoteMessage);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return headerToSummary(next);
  }

  async requestPlanRevision(
    sessionId: string,
    proposalId: string,
    operationId?: string,
  ): Promise<PlanMutationResult> {
    const input = {
      sessionId,
      proposalId,
      ...(operationId ? { operationId } : {}),
    };
    const replay = await this.isPlanOperationReplay(sessionId, operationId, input);
    if (!replay) await this.runtimeKernel.disposeBackend(sessionId);
    const result = await this.requirePlanStore().requestRevision(input);
    await this.finalizePlanCollaborationMode(sessionId, 'plan');
    return result;
  }

  async abandonPlanProposal(
    sessionId: string,
    proposalId: string,
    operationId?: string,
  ): Promise<PlanMutationResult> {
    const input = {
      sessionId,
      proposalId,
      reason: PLAN_USER_ABANDON_REASON,
      ...(operationId ? { operationId } : {}),
    };
    const replay = await this.isPlanOperationReplay(sessionId, operationId, input);
    const header = await this.deps.store.readHeader(sessionId);
    if (!replay && this.runtimeKernel.hasActiveRuns(sessionId)) {
      throw new PlanConflictError('Cannot abandon a Plan while the Session is running');
    }
    if (!replay && header.status === 'waiting_for_user') {
      throw new PlanConflictError('Cannot abandon a Plan while an Interaction is pending');
    }
    if (!replay) await this.runtimeKernel.disposeBackend(sessionId);
    const result = await this.requirePlanStore().abandonProposal(input);
    await this.finalizePlanAbandonment(sessionId, operationId, replay);
    return result;
  }

  async approvePlan(input: ApprovePlanProposalInput): Promise<PlanMutationResult> {
    const replay = await this.isPlanOperationReplay(input.sessionId, input.operationId, input);
    const header = await this.deps.store.readHeader(input.sessionId);
    if (!replay && this.runtimeKernel.hasActiveRuns(input.sessionId)) {
      throw new PlanConflictError('Cannot approve a Plan while the Session is running');
    }
    if (!replay && header.status === 'waiting_for_user') {
      throw new PlanConflictError('Cannot approve a Plan while an Interaction is pending');
    }
    if (!replay) await this.runtimeKernel.disposeBackend(input.sessionId);
    const result = await this.requirePlanStore().approveProposal(input);
    await this.finalizePlanCollaborationMode(input.sessionId, 'agent');
    return result;
  }

  async resumePlanExecution(
    sessionId: string,
    executionId: string,
    operationId?: string,
  ): Promise<PlanMutationResult> {
    const input = { sessionId, executionId };
    const replay = await this.isPlanOperationReplay(sessionId, operationId, input);
    if (!replay) await this.runtimeKernel.disposeBackend(sessionId);
    const result = await this.requirePlanStore().resumeExecution(
      sessionId,
      executionId,
      operationId,
    );
    await this.finalizePlanCollaborationMode(sessionId, 'agent');
    return result;
  }

  async cancelPlanExecution(
    sessionId: string,
    executionId: string,
    operationId?: string,
  ): Promise<PlanMutationResult> {
    const planStore = this.requirePlanStore();
    const input = {
      sessionId,
      executionId,
      reason: PLAN_USER_CANCEL_REASON,
      ...(operationId ? { operationId } : {}),
    };
    const replay = await this.isPlanOperationReplay(sessionId, operationId, input);
    if (!replay) {
      const state = await planStore.readState(sessionId);
      const execution = state.executions.find((item) => item.executionId === executionId);
      if (execution?.status !== 'interrupted') {
        throw new PlanConflictError('Only an interrupted Plan execution can be abandoned');
      }
      await this.runtimeKernel.disposeBackend(sessionId);
    }
    const result = await planStore.cancelExecution(input);
    return result;
  }

  async interruptActivePlanExecution(
    sessionId: string,
    reason: string,
    operationId?: string,
  ): Promise<PlanMutationResult | null> {
    const planStore = this.requirePlanStore();
    const replay = await this.isPlanOperationReplay(sessionId, operationId, {
      sessionId,
      reason,
    });
    if (!replay) {
      const state = await planStore.readState(sessionId);
      if (!state.activeExecutionId) return null;
      await this.runtimeKernel.disposeBackend(sessionId);
    }
    return planStore.interruptActiveExecution(sessionId, reason, operationId);
  }

  async remove(sessionId: string): Promise<void> {
    const shellRunClose = await this.deps.shellRuns?.terminateSession(sessionId);
    try {
      await this.runtimeKernel.disposeBackend(sessionId);
      await this.deps.store.remove(sessionId);
    } catch (error) {
      if (shellRunClose) this.deps.shellRuns?.rollbackSessionClose(shellRunClose);
      throw error;
    }
    if (shellRunClose) await this.deps.shellRuns?.commitSessionClose(shellRunClose);
  }

  // --------------------------------------------------------------------------
  // Send / stream — Phase 1 vertical heart
  // --------------------------------------------------------------------------

  /**
   * Send a user message and stream back normalized events. The caller
   * (desktop main) is expected to forward the events to the renderer over
   * the IPC bridge.
   *
   * Runtime v2 bridge: SessionManager remains the public facade; RuntimeKernel
   * owns AgentRun/AiSdkFlow/RuntimeRunner orchestration and ledger recording.
   */
  async *sendMessage(
    sessionId: string,
    input: UserMessageInput,
    options: TurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    if (input.origin?.kind === 'legacy_automation') {
      throw new Error('Live Turn cannot use removed Automation authority');
    }
    const repair = input.agentId ? undefined : this.runtimeLedgerRepair;
    const admitTurn = repair
      ? async () => {
          await this.ensureTranscriptLedger(sessionId, repair, 'compatibility');
          return (await options.admitTurn?.()) ?? 'admitted';
        }
      : options.admitTurn;
    const sourceText = sessionTitleSource(input);
    const onRunStarted = this.deps.generateSessionTitle
      ? async (runId: string, header: SessionHeader) => {
          await options.onRunStarted?.(runId, header);
          if (
            !header.connectionLocked &&
            !header.titleIsManual &&
            header.name === DEFAULT_SESSION_NAME &&
            sourceText
          ) {
            void this.generateTitleInBackground(sessionId, header, sourceText);
          }
        }
      : options.onRunStarted;
    yield* this.runtimeKernel.startTurn(sessionId, input, { ...options, admitTurn, onRunStarted });
  }

  private async generateTitleInBackground(
    sessionId: string,
    header: SessionHeader,
    sourceText: string,
  ): Promise<void> {
    let generated: string | undefined;
    try {
      generated = await this.deps.generateSessionTitle?.({ sessionId, header, sourceText });
    } catch {}
    try {
      const title = generated ?? fallbackSessionTitle(sourceText);
      if (!title) return;
      const next = await this.deps.store.setGeneratedTitleIfAbsent?.(sessionId, title);
      if (!next) return;
      this.runtimeKernel.updateCachedHeader(sessionId, next);
      this.deps.onSessionTitleChanged?.(sessionId);
    } catch {}
  }

  async planSafeBoundaryContinuation(
    sessionId: string,
    input: PlanSafeBoundaryContinuationInput,
  ): Promise<SafeBoundaryContinuationPlan> {
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async (targetSessionId, runId) => {
        if (!this.deps.runStore) throw new Error('AgentRunStore is not configured');
        return this.deps.runStore.readRun(targetSessionId, runId);
      },
      readImmutableRuntimePrefix: async (prefixInput) => {
        const authority = runtimeContinuationAuthority(this.deps.runtimeEventStore);
        if (!authority) {
          throw new Error('Immutable RuntimeEvent prefix reader is not configured');
        }
        return authority.readImmutableRuntimePrefix(prefixInput);
      },
      readContinuationClaimStateByBoundary: async (boundaryDigest) => {
        const authority = runtimeContinuationAuthority(this.deps.runtimeEventStore);
        if (!authority) throw new Error('Continuation authority is not configured');
        return authority.readContinuationClaimStateByBoundary(boundaryDigest);
      },
      findExistingContinuation: async (
        targetSessionId,
        sourceRunId,
        sourceRuntimeEventHighWater,
      ) => {
        if (!this.deps.runStore) throw new Error('AgentRunStore is not configured');
        return (await this.deps.runStore.listSessionRuns(targetSessionId)).find(
          (run) =>
            run.continuationSource?.sourceRunId === sourceRunId &&
            run.continuationSource.sourceRuntimeEventHighWater === sourceRuntimeEventHighWater,
        );
      },
      newId: this.deps.newId,
    });
    const plan = await planner.plan({ sessionId, ...input });
    this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
    return plan;
  }

  async planAuthoritativeSafeBoundaryContinuation(
    sessionId: string,
    input: PlanAuthoritativeSafeBoundaryContinuationInput,
  ): Promise<SafeBoundaryContinuationPlan> {
    if (this.deps.safeBoundaryResumeEnabled !== true) {
      const plan = resumeFeatureDisabledPlan();
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    if (!this.deps.runStore || !this.deps.inspectContinuationSafety) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['safety_observation_unavailable'],
        diagnostics: [
          {
            code: 'safety_observation_unavailable',
            message: 'authoritative continuation safety inspection is not configured',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    const sourceRun = await this.deps.runStore
      .readRun(sessionId, input.sourceRunId)
      .catch(() => undefined);
    if (!sourceRun) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['source_run_unreadable'],
        diagnostics: [
          { code: 'source_run_unreadable', message: 'source AgentRun could not be read' },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    if (!sourceRun.workspaceIdentity) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['workspace_identity_missing'],
        diagnostics: [
          {
            code: 'workspace_identity_missing',
            message: 'source AgentRun has no authoritative workspace identity',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    const header = await this.deps.store.readHeader(sessionId);
    let observation: RuntimeContinuationSafetyObservation;
    try {
      observation = await this.deps.inspectContinuationSafety(sessionId);
    } catch {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['safety_observation_unavailable'],
        diagnostics: [
          {
            code: 'safety_observation_unavailable',
            message: 'authoritative continuation safety inspection failed',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, input.sourceRunId, plan);
      return plan;
    }
    return this.planSafeBoundaryContinuation(sessionId, {
      sourceRunId: input.sourceRunId,
      currentCwd: header.cwd,
      sourceWorkspaceIdentity: sourceRun.workspaceIdentity,
      currentWorkspaceIdentity: observation.workspaceIdentity,
      backgroundOperationsSettled: observation.backgroundOperationsSettled,
      availableToolNames: observation.availableToolNames,
      ...(input.expectedRuntimeEventHighWater !== undefined
        ? { expectedRuntimeEventHighWater: input.expectedRuntimeEventHighWater }
        : {}),
      ...(observation.workspaceCheckpoint
        ? { workspaceCheckpoint: observation.workspaceCheckpoint }
        : {}),
    });
  }

  async planLatestAuthoritativeSafeBoundaryContinuation(
    sessionId: string,
  ): Promise<SafeBoundaryContinuationPlan> {
    if (this.deps.safeBoundaryResumeEnabled !== true) {
      const plan = resumeFeatureDisabledPlan();
      this.recordContinuationPlan(sessionId, '', plan);
      return plan;
    }
    if (!this.deps.runStore) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['resume_candidate_missing'],
        diagnostics: [
          {
            code: 'resume_candidate_missing',
            message: 'no AgentRun store is configured for resume discovery',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, '', plan);
      return plan;
    }
    const candidate = (await this.deps.runStore.listSessionRuns(sessionId))
      .filter(
        (run) => (run.status === 'failed' || run.status === 'cancelled') && isSessionInlineRun(run),
      )
      .sort(
        (left, right) => right.createdAt - left.createdAt || right.runId.localeCompare(left.runId),
      )[0];
    if (!candidate) {
      const plan: SafeBoundaryContinuationPlan = {
        disposition: 'park',
        rejectionReasons: ['resume_candidate_missing'],
        diagnostics: [
          {
            code: 'resume_candidate_missing',
            message: 'no failed or cancelled top-level continuation candidate exists',
          },
        ],
      };
      this.recordContinuationPlan(sessionId, '', plan);
      return plan;
    }
    return this.planAuthoritativeSafeBoundaryContinuation(sessionId, {
      sourceRunId: candidate.runId,
    });
  }

  async *resumeSafeBoundaryContinuation(
    continuation: RuntimeContinuation,
    options: ResumeContinuationOptions = {},
  ): AsyncIterable<SessionEvent> {
    const resume = this.runtimeKernel.resumeContinuation;
    if (!resume) throw new Error('RuntimeKernel does not support safe-boundary continuation');
    this.recordContinuationLifecycleEvent({
      type: 'execution_started',
      sessionId: continuation.sessionId,
      sourceRunId: continuation.sourceRunId,
      targetRunId: continuation.runId,
    });
    try {
      yield* resume.call(this.runtimeKernel, continuation, options);
      this.recordContinuationLifecycleEvent({
        type: 'execution_completed',
        sessionId: continuation.sessionId,
        sourceRunId: continuation.sourceRunId,
        targetRunId: continuation.runId,
      });
    } catch (error) {
      this.recordContinuationLifecycleEvent({
        type: 'execution_failed',
        sessionId: continuation.sessionId,
        sourceRunId: continuation.sourceRunId,
        targetRunId: continuation.runId,
        errorClass: continuationExecutionErrorClass(error),
      });
      throw error;
    }
  }

  private recordContinuationPlan(
    sessionId: string,
    sourceRunId: string,
    plan: SafeBoundaryContinuationPlan,
  ): void {
    if (plan.disposition === 'continue' && plan.continuation) {
      this.recordContinuationLifecycleEvent({
        type: 'plan_approved',
        sessionId,
        sourceRunId,
        targetRunId: plan.continuation.runId,
      });
      return;
    }
    this.recordContinuationLifecycleEvent({
      type: 'plan_parked',
      sessionId,
      sourceRunId,
      rejectionReasons: plan.rejectionReasons,
    });
  }

  private recordContinuationLifecycleEvent(event: RuntimeContinuationLifecycleEvent): void {
    try {
      const result = this.deps.onContinuationLifecycleEvent?.(event);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch {
      // Operational telemetry must never alter resume correctness.
    }
  }

  async *compactSession(
    sessionId: string,
    input: CompactSessionInput = {},
  ): AsyncIterable<SessionEvent> {
    yield* this.runtimeKernel.compactSession(sessionId, input);
  }

  async preflightContextCompaction(sessionId: string): Promise<void> {
    await this.runtimeKernel.preflightContextCompaction(sessionId);
  }

  async *startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
  ): AsyncIterable<SessionEvent> {
    const execution = this.runtimeKernel.claimExecution(sessionId);
    try {
      await this.ensureChildWorkspace(await this.deps.store.readHeader(sessionId));
      yield* this.runtimeKernel.startChildTurn(sessionId, input, execution);
    } finally {
      execution.release();
    }
  }

  async spawnChildAgent(
    sessionId: string,
    input: SpawnChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    const execution = this.runtimeKernel.claimExecution(sessionId);
    try {
      const definition = requireBuiltinAgentDefinition(input.spec.id);
      return await this.runChildAgent(sessionId, definition, input, execution);
    } finally {
      execution.release();
    }
  }

  /**
   * Create and run a durable linked child Session without changing the
   * parent-facing agent_spawn compatibility path.
   *
   * Cross-session provenance lives on the child header. The first AgentRun
   * intentionally carries no parentRunId, so it is an ordinary session-inline
   * run and every later child turn can reuse only the child's own history.
   */
  async spawnChildSession(
    parentSessionId: string,
    input: SpawnChildSessionInput,
  ): Promise<SpawnChildSessionResult> {
    const resolvedInput = await this.resolveChildSessionSelector(input);
    const spawnKey = childSessionSpawnKey(parentSessionId, resolvedInput);
    const requestFingerprint = childSessionRequestFingerprint(parentSessionId, resolvedInput);
    const inFlight = this.childSessionSpawns.get(spawnKey);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        throw new Error('Child-session spawn identity was reused for different work');
      }
      return await inFlight.promise;
    }
    const runtimeOwner = {
      execution: this.runtimeKernel.claimExecution(parentSessionId),
    };
    const promise = this.spawnChildSessionOnce(
      parentSessionId,
      resolvedInput,
      requestFingerprint,
      runtimeOwner,
    ).finally(() => runtimeOwner.execution.release());
    this.childSessionSpawns.set(spawnKey, { requestFingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.childSessionSpawns.get(spawnKey)?.promise === promise) {
        this.childSessionSpawns.delete(spawnKey);
      }
    }
  }

  private async resolveChildSessionSelector(
    input: SpawnChildSessionInput,
  ): Promise<ResolvedSpawnChildSessionInput> {
    if (!input.subagentId) return { ...input };
    if (!this.deps.subagentCatalog) {
      throw new Error('Configured subagent catalog is unavailable in this runtime');
    }
    const resolvedPreset = await this.deps.subagentCatalog.resolve(input.subagentId);
    if (resolvedPreset.profile !== input.agentProfile) {
      throw new Error(`Subagent preset "${input.subagentId}" profile changed during spawn`);
    }
    return { ...input, resolvedPreset };
  }

  /**
   * Atomically materialize one catalog agent as a durable child Session and a
   * monotonic graph-topology operator.
   *
   * This is metadata admission only. The reserved first turn/run is executed
   * later through the ordinary claimed graph-intent path.
   */
  async provisionAgentGraphOperator(
    input: ProvisionAgentGraphOperatorInput,
  ): Promise<ProvisionAgentGraphOperatorResult> {
    if (!this.runtimeKernel.runSessionAdmissionMutation) {
      throw new Error('Graph operator provisioning requires Runtime admission mutation authority');
    }
    return this.runtimeKernel.runSessionAdmissionMutation([input.source.sessionId], () =>
      this.provisionAgentGraphOperatorFromParentSnapshot(input),
    );
  }

  private async provisionAgentGraphOperatorFromParentSnapshot(
    input: ProvisionAgentGraphOperatorInput,
  ): Promise<ProvisionAgentGraphOperatorResult> {
    const create = this.deps.store.createAgentGraphOperator;
    if (!create || !this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error(
        'Graph operator provisioning requires SQLite Session metadata, AgentRunStore, and RuntimeEventStore',
      );
    }
    if (input.source.sessionId.length === 0) {
      throw new Error('Graph operator provision requires a supervisor Session');
    }
    const [parentHeader, sourceRun, parentBoundary] = await Promise.all([
      this.deps.store.readHeader(input.source.sessionId),
      this.deps.runStore.readRun(input.source.sessionId, input.source.runId),
      this.deps.store.readExecutionBoundary(input.source.sessionId),
    ]);
    if (
      sourceRun.sessionId !== input.source.sessionId ||
      sourceRun.runId !== input.source.runId ||
      sourceRun.turnId !== input.source.turnId
    ) {
      throw new Error('Graph schedule source does not match its durable supervisor run');
    }

    if ((input.agentId ? 1 : 0) + (input.subagentId ? 1 : 0) !== 1) {
      throw new Error('Graph operator provision requires exactly one agent or subagent preset id');
    }
    const resolvedPreset = input.subagentId
      ? await this.deps.subagentCatalog?.resolve(input.subagentId)
      : undefined;
    if (input.subagentId && !resolvedPreset) {
      throw new Error('Configured subagent catalog is unavailable in this runtime');
    }
    const definition = resolvedPreset
      ? requireBuiltinAgentDefinitionByProfile(resolvedPreset.profile)
      : requireBuiltinAgentDefinition(input.agentId!);
    const availableChildTools = await this.childToolsForSession(input.source.sessionId);
    assertAgentDefinitionRunnable({
      definition,
      tools: availableChildTools,
      worktreeChildExecutorAvailable: await this.isWorktreeChildExecutorAvailable(parentHeader),
    });
    const resolvedToolNames = buildToolsForAgentDefinition(availableChildTools, definition).map(
      (tool) => tool.name,
    );
    const childPermissionMode =
      parentHeader.permissionMode === 'bypass' ? 'bypass' : definition.permissionMode;

    const initialTurnId = this.deps.newId();
    const initialRunId = this.deps.newId();
    const identityHash = stableHash({
      schemaVersion: AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
      graphId: input.graphId,
      workId: input.workId,
    }).slice('sha256:'.length, 'sha256:'.length + 32);
    const provisionFingerprint = stableHash({
      schemaVersion: AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
      graphId: input.graphId,
      workId: input.workId,
      agentId: definition.id,
      operatorId: input.operatorId,
      source: input.source,
      edges: input.edges,
      definition: {
        definitionVersion: definition.definitionVersion,
        agentId: definition.id,
        profile: definition.profile,
        workspace: definition.contract.workspace,
        permissionMode: childPermissionMode,
        toolNames: resolvedToolNames,
        categoryPolicy: {},
        systemPrompt: definition.systemPrompt,
        ...(resolvedPreset
          ? {
              preset: {
                id: resolvedPreset.id,
                name: resolvedPreset.name,
                connectionSlug: resolvedPreset.connectionSlug,
                model: resolvedPreset.model,
                thinkingLevel: resolvedPreset.thinkingLevel,
              },
            }
          : {}),
      },
    });
    const workspace = await this.provisionChildWorkspace(
      parentHeader,
      definition,
      provisionFingerprint,
    );
    const request: AgentGraphOperatorProvisionRequest = {
      schemaVersion: AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
      provisionId: `graph_provision_${identityHash}`,
      provisionFingerprint,
      graphId: input.graphId,
      workId: input.workId,
      agentId: definition.id,
      operatorId: input.operatorId,
      initialTurnId,
      initialRunId,
      edges: input.edges.map((edge) => ({ ...edge })),
    };
    const result = await create.call(
      this.deps.store,
      {
        cwd: workspace?.worktreePath ?? parentHeader.cwd,
        ...(parentHeader.projectId !== undefined ? { projectId: parentHeader.projectId } : {}),
        name: resolvedPreset?.name ?? definition.name,
        llmConnectionSlug: resolvedPreset?.connectionSlug ?? parentHeader.llmConnectionSlug,
        model: resolvedPreset?.model ?? parentHeader.model,
        ...(resolvedPreset
          ? resolvedPreset.thinkingLevel !== undefined
            ? { thinkingLevel: resolvedPreset.thinkingLevel }
            : {}
          : parentHeader.thinkingLevel !== undefined
            ? { thinkingLevel: parentHeader.thinkingLevel }
            : {}),
        permissionMode: childPermissionMode,
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        subagentParent: {
          kind: 'subagent',
          parentSessionId: input.source.sessionId,
          spawnedBy: {
            parentRunId: input.source.runId,
            parentTurnId: input.source.turnId,
            toolCallId: input.source.toolCallId,
          },
          graph: {
            graphId: input.graphId,
            workId: input.workId,
            operatorId: input.operatorId,
          },
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION,
          definitionVersion: definition.definitionVersion,
          agentId: definition.id,
          agentName: resolvedPreset?.name ?? definition.name,
          profile: definition.profile,
          ...(resolvedPreset ? { presetId: resolvedPreset.id } : {}),
          systemPrompt: definition.systemPrompt,
          toolNames: resolvedToolNames,
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION,
          requestFingerprint: provisionFingerprint.slice('sha256:'.length),
          initialTurnId,
          initialRunId,
        },
        ...(workspace ? { subagentWorkspace: workspace } : {}),
      },
      request,
      input.expectedScheduleRevision,
      parentBoundary,
    );
    const relation = result.header.subagentParent?.graph;
    if (
      relation?.graphId !== input.graphId ||
      relation.workId !== input.workId ||
      relation.operatorId !== result.provision.operatorId ||
      result.header.id !== result.provision.targetSessionId ||
      !sameSubagentWorkspace(result.header.subagentWorkspace, workspace)
    ) {
      throw new Error('Stored graph operator provision returned mismatched Session metadata');
    }
    return result;
  }

  /**
   * Execute one durably claimed graph intent through the existing
   * session-inline child runtime primitive.
   *
   * The graph claim is admission authority only. Once its exact run identity
   * exists, the AgentRun/RuntimeEvent ledgers are execution authority and a
   * retry observes or recovers that run instead of invoking the backend again.
   */
  async runClaimedAgentGraphIntent(
    input: RunClaimedAgentGraphIntentInput,
  ): Promise<ClaimedAgentGraphIntentResult> {
    const hosted = isRuntimeHostedRootAuthority(this.deps.messageAuthority);
    const hostedGraphExecution = hosted ? this.deps.hostedAgentGraphExecution : undefined;
    if (hosted && !hostedGraphExecution) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Hosted claimed graph execution requires its trusted graph execution capability',
      );
    }
    const storedClaim = await (hostedGraphExecution ?? input.claimStore).readAgentGraphIntentClaim(
      input.graphId,
      input.intentId,
    );
    if (!storedClaim) {
      throw new Error(`Graph intent ${input.graphId}/${input.intentId} has not been claimed`);
    }
    const claim = decodeAgentGraphIntentClaim(storedClaim);
    if (claim.graphId !== input.graphId || claim.intentId !== input.intentId) {
      throw new Error('Graph intent claim store returned a mismatched identity');
    }
    assertAgentGraphIntentExecutionMatchesClaim(claim, input.intent, input.prompt);
    const resolved: ResolvedClaimedAgentGraphIntentInput = {
      claim,
      intent: input.intent,
      prompt: input.prompt,
      ...(input.admitExecution ? { admitExecution: input.admitExecution } : {}),
      ...(hostedGraphExecution ? { hostedGraphExecution } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onReady ? { onReady: input.onReady } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    };
    const requestFingerprint = claimedAgentGraphIntentRequestFingerprint(resolved);
    const inFlight = this.claimedAgentGraphIntentRuns.get(claim.claimId);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        throw new Error('Graph intent claim identity was reused for different execution input');
      }
      return await inFlight.promise;
    }
    const runtimeExecution = this.runtimeKernel.claimExecution(claim.targetSessionId);
    const promise = this.enqueueClaimedAgentGraphIntent(resolved, runtimeExecution).finally(() =>
      runtimeExecution.release(),
    );
    this.claimedAgentGraphIntentRuns.set(claim.claimId, {
      requestFingerprint,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.claimedAgentGraphIntentRuns.get(claim.claimId)?.promise === promise) {
        this.claimedAgentGraphIntentRuns.delete(claim.claimId);
      }
    }
  }

  private enqueueClaimedAgentGraphIntent(
    input: ResolvedClaimedAgentGraphIntentInput,
    runtimeExecution: RuntimeExecutionClaim,
  ): Promise<ClaimedAgentGraphIntentResult> {
    const sessionId = input.claim.targetSessionId;
    const previous = this.claimedAgentGraphSessionTails.get(sessionId) ?? Promise.resolve();
    let enteredQueue = false;
    const queuedExecution = previous
      .catch(() => {
        // A failed predecessor releases the Session slot for the next claim.
      })
      .then(() => {
        if (input.abortSignal?.aborted) {
          throw new Error('Claimed graph execution was cancelled before runtime admission');
        }
        if (runtimeExecution.stopSignal.aborted) {
          throw runtimeExecution.stopSignal.reason;
        }
        enteredQueue = true;
        return this.runClaimedAgentGraphIntentOnce(input, runtimeExecution);
      });
    const tail = queuedExecution.then(
      () => {},
      () => {},
    );
    this.claimedAgentGraphSessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.claimedAgentGraphSessionTails.get(sessionId) === tail) {
        this.claimedAgentGraphSessionTails.delete(sessionId);
      }
    });

    let rejectStopped!: (reason?: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const onRuntimeStop = (): void => {
      if (!enteredQueue) rejectStopped(runtimeExecution.stopSignal.reason);
    };
    runtimeExecution.stopSignal.addEventListener('abort', onRuntimeStop, { once: true });
    if (runtimeExecution.stopSignal.aborted) onRuntimeStop();
    return Promise.race([queuedExecution, stopped]).finally(() => {
      runtimeExecution.stopSignal.removeEventListener('abort', onRuntimeStop);
    });
  }

  private async runClaimedAgentGraphIntentOnce(
    input: ResolvedClaimedAgentGraphIntentInput,
    runtimeExecution: RuntimeExecutionClaim,
  ): Promise<ClaimedAgentGraphIntentResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Claimed graph execution requires AgentRunStore and RuntimeEventStore');
    }
    if (input.abortSignal?.aborted) {
      throw new Error('Claimed graph execution was cancelled before runtime admission');
    }

    const { claim } = input;
    const child = await this.deps.store.readHeader(claim.targetSessionId);
    await this.ensureChildWorkspace(child);
    const snapshot = child.subagentRuntime;
    if (
      child.id !== claim.targetSessionId ||
      child.subagentParent?.kind !== 'subagent' ||
      !snapshot
    ) {
      throw new Error('Claimed graph execution target must be a linked child session');
    }
    await this.assertLinkedChildBoundaryMatchesParent(
      child.subagentParent.parentSessionId,
      child.id,
    );
    const rootExecution: RootExecutionDescriptor = {
      kind: 'claimed_agent_graph_intent',
      claim,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
    };
    const readyInfo = {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: child.id,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
    };
    let readyNotification: Promise<void> | undefined;
    const notifyReady = (): Promise<void> => {
      readyNotification ??= Promise.resolve()
        .then(() => input.onReady?.(readyInfo))
        .catch(() => {
          // A presentation observer must not change graph execution.
        });
      return readyNotification;
    };

    let run = await this.deps.runStore.readRun(child.id, claim.targetRunId).catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    });
    if (run) {
      this.assertClaimedAgentGraphRun(child, snapshot, claim, run);
      if (input.hostedGraphExecution) {
        const admission = await this.requireClaimedGraphAdmissionIdentity(
          claim,
          input.hostedGraphExecution,
        );
        await this.consumeLinkedRootExecution({
          sessionId: child.id,
          turnId: claim.targetTurnId,
          runId: claim.targetRunId,
          userMessageId: admission.userMessageId,
          execution: rootExecution,
          content: { text: input.prompt },
          start: () => {
            throw new RuntimeMessageAuthorityInvariantError(
              'Hosted retry attempted to start an existing claimed graph Run',
            );
          },
        });
        run = await this.deps.runStore.readRun(child.id, claim.targetRunId);
        this.assertClaimedAgentGraphRun(child, snapshot, claim, run);
        await this.assertClaimedAgentGraphPrompt(
          child.id,
          claim.targetTurnId,
          input.prompt,
          admission.userMessageId,
        );
        await notifyReady();
        return claimedAgentGraphIntentResult(
          claim,
          await this.projectExistingChildSpawn(child, run),
        );
      }
      await this.assertClaimedAgentGraphPrompt(child.id, claim.targetTurnId, input.prompt);
      await notifyReady();
      while (
        !isTerminalRunStatus(run.status) &&
        this.runtimeKernel.hasActiveRun?.(child.id, run.runId, run.turnId)
      ) {
        await delay(25, undefined, input.abortSignal ? { signal: input.abortSignal } : undefined);
        run = await this.deps.runStore.readRun(child.id, claim.targetRunId);
      }
      if (!isTerminalRunStatus(run.status)) {
        await this.recoverAgentRunsFromLedger(child.id);
        run = await this.deps.runStore.readRun(child.id, claim.targetRunId);
      }
      this.assertClaimedAgentGraphRun(child, snapshot, claim, run);
      await this.assertClaimedAgentGraphPrompt(child.id, claim.targetTurnId, input.prompt);
      return claimedAgentGraphIntentResult(claim, await this.projectExistingChildSpawn(child, run));
    }

    await this.finalizeChildWorkspacePatches(child.id);

    const [runs, messages] = await Promise.all([
      this.deps.runStore.listSessionRuns(child.id),
      this.deps.store.readMessages(child.id),
    ]);
    const turnOwner = runs.find((candidate) => candidate.turnId === claim.targetTurnId);
    if (turnOwner) {
      throw new Error(
        `Claimed graph turn ${claim.targetTurnId} is already owned by run ${turnOwner.runId}`,
      );
    }
    if (messages.some((message) => 'turnId' in message && message.turnId === claim.targetTurnId)) {
      throw new Error(`Claimed graph turn ${claim.targetTurnId} already has durable messages`);
    }
    if (child.isArchived || child.status === 'aborted') {
      throw new Error('Claimed graph execution target child session is terminated');
    }
    if (input.abortSignal?.aborted) {
      throw new Error('Claimed graph execution was cancelled before runtime admission');
    }

    const admitExecution = input.admitExecution;
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    const identity = {
      sessionId: child.id,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
    };
    let aborted = false;
    let stopPromise: Promise<void> | undefined;
    const userMessageId = await this.claimedGraphUserMessageId(claim, input.hostedGraphExecution);
    const execution = this.consumeLinkedRootExecution({
      ...identity,
      userMessageId,
      execution: rootExecution,
      ...(admitExecution ? { admitExecution } : {}),
      content: { text: input.prompt },
      start: ({ runId, userMessageId, onRunStarted }) =>
        this.sendMessage(
          child.id,
          {
            turnId: claim.targetTurnId,
            text: input.prompt,
            agentId: snapshot.agentId,
            agentName: snapshot.agentName,
          },
          {
            runId,
            ...(userMessageId ? { userMessageId } : {}),
            durability: 'required',
            ...(admitExecution && !input.hostedGraphExecution
              ? {
                  admitTurn: async () =>
                    (await admitExecution()) === 'executing' ? 'admitted' : 'cancelled',
                }
              : {}),
            onRunStarted,
            execution: runtimeExecution,
          },
        ),
      onReady: notifyReady,
      onEvent: (event) => {
        summary.add(event);
        try {
          input.onEvent?.(event);
        } catch {
          // A presentation observer must not change graph execution.
        }
      },
    });
    const onAbort = () => {
      aborted = true;
      stopPromise ??= this.stopLinkedRoot(identity, { source: 'stop_button' });
    };
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (input.abortSignal.aborted) onAbort();
    }
    try {
      await execution;
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await stopPromise;
    }

    const completedAt = this.deps.now();
    const completedRun = await this.deps.runStore.readRun(child.id, claim.targetRunId);
    this.assertClaimedAgentGraphRun(child, snapshot, claim, completedRun);
    const failureClass = completedRun.failureClass ?? summary.failureClass;
    const artifacts = await this.finalizeAndListChildTurnArtifacts(
      child.id,
      claim.targetTurnId,
      completedRun.status,
    );
    return {
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.targetOperatorId,
      childSessionId: child.id,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      profile: snapshot.profile,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      status: agentRunStatusForSpawnResult(completedRun.status),
      permissionMode: child.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  private async claimedGraphUserMessageId(
    claim: AgentGraphIntentClaim,
    hostedGraphExecution: RuntimeHostedAgentGraphExecutionCapability | undefined,
  ): Promise<string> {
    if (!hostedGraphExecution) return this.deps.newId();
    const admission = await hostedGraphExecution.readRootTurnAdmissionIdentity(
      claim.targetSessionId,
      claim.targetTurnId,
    );
    if (!admission) return this.deps.newId();
    if (admission.runId !== claim.targetRunId) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Claimed graph RootTurn admission has a mismatched run identity',
      );
    }
    if (admission.userMessageId === null) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Claimed graph RootTurn admission is missing its user message identity',
      );
    }
    return admission.userMessageId;
  }

  private async requireClaimedGraphAdmissionIdentity(
    claim: AgentGraphIntentClaim,
    hostedGraphExecution: RuntimeHostedAgentGraphExecutionCapability,
  ): Promise<{ runId: string; userMessageId: string }> {
    const admission = await hostedGraphExecution.readRootTurnAdmissionIdentity(
      claim.targetSessionId,
      claim.targetTurnId,
    );
    if (!admission) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Existing claimed graph Run is missing its durable RootTurn admission',
      );
    }
    if (admission.runId !== claim.targetRunId) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Claimed graph RootTurn admission has a mismatched run identity',
      );
    }
    if (admission.userMessageId === null) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Claimed graph RootTurn admission is missing its user message identity',
      );
    }
    return { runId: admission.runId, userMessageId: admission.userMessageId };
  }

  private assertClaimedAgentGraphRun(
    child: SessionHeader,
    snapshot: NonNullable<SessionHeader['subagentRuntime']>,
    claim: AgentGraphIntentClaim,
    run: AgentRunHeader,
  ): void {
    if (
      run.sessionId !== child.id ||
      run.runId !== claim.targetRunId ||
      run.turnId !== claim.targetTurnId ||
      !isSessionInlineRun(run) ||
      run.agentId !== snapshot.agentId ||
      (run.agentName !== undefined && run.agentName !== snapshot.agentName)
    ) {
      throw new Error('Existing AgentRun does not match the claimed graph activation identity');
    }
  }

  private async assertClaimedAgentGraphPrompt(
    sessionId: string,
    turnId: string,
    prompt: string,
    expectedUserMessageId?: string,
  ): Promise<void> {
    const messages = await this.deps.store.readMessages(sessionId);
    const userMessages = messages.filter(
      (message): message is UserMessage => message.type === 'user' && message.turnId === turnId,
    );
    if (expectedUserMessageId !== undefined) {
      if (
        userMessages.length !== 1 ||
        userMessages[0]?.id !== expectedUserMessageId ||
        !messageContentsEqual(userMessages[0], { text: prompt })
      ) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Existing claimed graph Run does not match its durable UserMessage',
        );
      }
      return;
    }
    if (userMessages.length > 1 || (userMessages[0] && userMessages[0].text !== prompt)) {
      throw new Error('Graph intent claim identity was reused for different execution input');
    }
  }

  private async spawnChildSessionOnce(
    parentSessionId: string,
    input: ResolvedSpawnChildSessionInput,
    requestFingerprint: string,
    runtimeOwner: { execution: RuntimeExecutionClaim },
  ): Promise<SpawnChildSessionResult> {
    if (input.abortSignal?.aborted) {
      throw new Error('Child session spawn was cancelled before creation');
    }
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child session creation requires AgentRunStore and RuntimeEventStore');
    }
    const [parentHeader, parentRun, parentBoundary] = await Promise.all([
      this.deps.store.readHeader(parentSessionId),
      this.deps.runStore.readRun(parentSessionId, input.spawnedBy.parentRunId),
      this.deps.store.readExecutionBoundary(parentSessionId),
    ]);
    this.assertActiveParentRun(parentSessionId, parentRun, input.spawnedBy.parentTurnId);

    const definition = requireBuiltinAgentDefinitionByProfile(input.agentProfile);
    const availableChildTools = await this.childToolsForSession(parentSessionId);
    assertAgentDefinitionRunnable({
      definition,
      tools: availableChildTools,
      worktreeChildExecutorAvailable: await this.isWorktreeChildExecutorAvailable(parentHeader),
    });
    const resolvedToolNames = buildToolsForAgentDefinition(availableChildTools, definition).map(
      (tool) => tool.name,
    );

    const proposedTurnId = input.turnId ?? this.deps.newId();
    const proposedRunId = input.runId ?? this.deps.newId();
    const workspace = await this.provisionChildWorkspace(
      parentHeader,
      definition,
      requestFingerprint,
    );
    const creation = await this.deps.store.createSubagent(
      {
        cwd: workspace?.worktreePath ?? parentHeader.cwd,
        ...(parentHeader.projectId !== undefined ? { projectId: parentHeader.projectId } : {}),
        name: input.name ?? input.resolvedPreset?.name ?? definition.name,
        llmConnectionSlug: input.resolvedPreset?.connectionSlug ?? parentHeader.llmConnectionSlug,
        model: input.resolvedPreset?.model ?? parentHeader.model,
        ...(input.resolvedPreset
          ? input.resolvedPreset.thinkingLevel !== undefined
            ? { thinkingLevel: input.resolvedPreset.thinkingLevel }
            : {}
          : parentHeader.thinkingLevel !== undefined
            ? { thinkingLevel: parentHeader.thinkingLevel }
            : {}),
        permissionMode: definition.permissionMode,
        collaborationMode: 'agent',
        orchestrationMode: 'default',
        subagentParent: {
          kind: 'subagent',
          parentSessionId,
          spawnedBy: input.spawnedBy,
          ...(input.swarm ? { swarm: input.swarm } : {}),
          lifecycle: 'foreground',
        },
        subagentRuntime: {
          schemaVersion: SUBAGENT_SESSION_RUNTIME_SCHEMA_VERSION,
          definitionVersion: definition.definitionVersion,
          agentId: definition.id,
          agentName: input.resolvedPreset?.name ?? definition.name,
          profile: definition.profile,
          ...(input.resolvedPreset ? { presetId: input.resolvedPreset.id } : {}),
          systemPrompt: definition.systemPrompt,
          toolNames: resolvedToolNames,
          categoryPolicy: {},
        },
        subagentSpawn: {
          schemaVersion: SUBAGENT_SESSION_SPAWN_SCHEMA_VERSION,
          requestFingerprint,
          initialTurnId: proposedTurnId,
          initialRunId: proposedRunId,
        },
        ...(workspace ? { subagentWorkspace: workspace } : {}),
      },
      parentBoundary,
    );
    const child = creation.header;
    const snapshot = child.subagentRuntime;
    const spawn = child.subagentSpawn;
    if (
      !snapshot ||
      !spawn ||
      !child.subagentParent ||
      !sameSubagentWorkspace(child.subagentWorkspace, workspace)
    ) {
      throw new Error('Stored child session is missing its durable runtime or spawn identity');
    }
    try {
      runtimeOwner.execution = this.transferRuntimeExecution(runtimeOwner.execution, child.id);
    } catch (error) {
      if (creation.created) await this.updateStatus(child.id, 'aborted').catch(() => {});
      throw error;
    }
    const releaseHostedExecution = this.acquireHostedLinkedChildExecution(child.id);
    try {
      const turnId = spawn.initialTurnId;
      const runId = spawn.initialRunId;
      const readyInfo = {
        childSessionId: child.id,
        turnId,
        runId,
        agentId: snapshot.agentId,
        agentName: snapshot.agentName,
        permissionMode: child.permissionMode,
      };
      let readyNotification: Promise<void> | undefined;
      const notifyReady = (): Promise<void> => {
        readyNotification ??= Promise.resolve().then(() => input.onReady?.(readyInfo));
        return readyNotification;
      };

      // Close the create/start race: if the parent settled (or cancellation
      // arrived) while metadata was being written, retain an inspectable aborted
      // child but do not admit new foreground work.
      try {
        this.assertActiveParentRun(parentSessionId, parentRun, input.spawnedBy.parentTurnId);
        if (input.abortSignal?.aborted) {
          throw new Error('Child session spawn was cancelled before its first run');
        }
      } catch (error) {
        if (creation.created) await this.updateStatus(child.id, 'aborted').catch(() => {});
        throw error;
      }

      if (!creation.created) {
        const existing = await this.resolveExistingChildSpawn(child, input, notifyReady);
        if (existing) return existing;
      }

      // A committed metadata row without its initial AgentRun is a recoverable
      // crash boundary. Revalidate admission after the lookup: the parent or
      // caller may have settled while durable state was being inspected.
      try {
        const latestParentRun = await this.deps.runStore.readRun(
          parentSessionId,
          input.spawnedBy.parentRunId,
        );
        this.assertActiveParentRun(parentSessionId, latestParentRun, input.spawnedBy.parentTurnId);
        if (input.abortSignal?.aborted) {
          throw new Error('Child session spawn was cancelled before its first run');
        }
      } catch (error) {
        await this.updateStatus(child.id, 'aborted').catch(() => {});
        throw error;
      }

      const startedAt = this.deps.now();
      const summary = new ChildAgentSummaryAccumulator();
      let aborted = false;
      let stopPromise: Promise<void> | undefined;
      const identity = { sessionId: child.id, turnId, runId };
      const execution = this.consumeLinkedRootExecution(
        {
          ...identity,
          userMessageId: this.deps.newId(),
          execution: {
            kind: 'linked_child_initial',
            agentId: snapshot.agentId,
            agentName: snapshot.agentName,
          },
          content: { text: input.prompt },
          start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
            this.sendMessage(
              child.id,
              {
                turnId,
                text: input.prompt,
                agentId: snapshot.agentId,
                agentName: snapshot.agentName,
              },
              {
                runId: admittedRunId,
                ...(userMessageId ? { userMessageId } : {}),
                durability: 'required',
                onRunStarted,
                execution: runtimeOwner.execution,
              },
            ),
          onReady: notifyReady,
          onEvent: (event) => {
            summary.add(event);
            try {
              input.onEvent?.(event);
            } catch {
              // A presentation observer must not change the child run outcome.
            }
          },
        },
        true,
      );
      const onAbort = () => {
        aborted = true;
        stopPromise ??= this.stopLinkedRoot(identity, { source: 'stop_button' });
      };
      if (input.abortSignal) {
        input.abortSignal.addEventListener('abort', onAbort, { once: true });
        if (input.abortSignal.aborted) onAbort();
      }
      try {
        await execution;
      } finally {
        input.abortSignal?.removeEventListener('abort', onAbort);
        if (aborted) await stopPromise;
      }

      const completedAt = this.deps.now();
      const run = await this.findRunByTurnId(child.id, turnId);
      const failureClass = run?.failureClass ?? summary.failureClass;
      const artifacts = run
        ? await this.finalizeAndListChildTurnArtifacts(child.id, turnId, run.status)
        : [];
      return {
        childSessionId: child.id,
        agentId: snapshot.agentId,
        agentName: snapshot.agentName,
        profile: snapshot.profile,
        turnId,
        runId,
        status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
        permissionMode: child.permissionMode,
        summary: summary.text(),
        artifactIds: artifacts.map((artifact) => artifact.id),
        startedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        eventCount: summary.eventCount,
        ...(failureClass ? { failureClass } : {}),
      };
    } finally {
      releaseHostedExecution();
    }
  }

  private async resolveExistingChildSpawn(
    child: SessionHeader,
    input: SpawnChildSessionInput,
    notifyReady: () => Promise<void>,
  ): Promise<SpawnChildSessionResult | undefined> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return undefined;
    const snapshot = child.subagentRuntime;
    const spawn = child.subagentSpawn;
    if (!snapshot || !spawn) {
      throw new Error('Stored child session is missing its durable runtime or spawn identity');
    }
    let run = await this.deps.runStore.readRun(child.id, spawn.initialRunId).catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    });
    if (!run) return undefined;
    await notifyReady();

    while (
      !isTerminalRunStatus(run.status) &&
      this.runtimeKernel.hasActiveRun?.(child.id, run.runId, run.turnId)
    ) {
      await delay(25, undefined, input.abortSignal ? { signal: input.abortSignal } : undefined);
      run = await this.deps.runStore.readRun(child.id, spawn.initialRunId);
    }
    if (!isTerminalRunStatus(run.status)) {
      await this.recoverAgentRunsFromLedger(child.id);
      run = await this.deps.runStore.readRun(child.id, spawn.initialRunId);
    }
    return await this.projectExistingChildSpawn(child, run);
  }

  private async projectExistingChildSpawn(
    child: SessionHeader,
    run: AgentRunHeader,
  ): Promise<SpawnChildSessionResult> {
    if (!this.deps.runtimeEventStore) {
      throw new Error('Child session projection requires RuntimeEventStore');
    }
    const snapshot = child.subagentRuntime;
    if (!snapshot) throw new Error('Stored child session is missing its durable runtime snapshot');
    const [messages, runtimeEvents, artifacts] = await Promise.all([
      this.deps.store.readMessages(child.id),
      this.deps.runtimeEventStore.readRuntimeEvents(child.id, run.runId),
      this.finalizeAndListChildTurnArtifacts(child.id, run.turnId, run.status),
    ]);
    const storedSummary =
      messages
        .filter(
          (message): message is Extract<StoredMessage, { type: 'assistant' }> =>
            message.type === 'assistant' && message.turnId === run.turnId,
        )
        .at(-1)?.text ?? '';
    const runtimeText = runtimeEvents.filter(
      (
        event,
      ): event is RuntimeEvent & {
        content: Extract<NonNullable<RuntimeEvent['content']>, { kind: 'text' }>;
      } => event.role === 'model' && event.content?.kind === 'text',
    );
    const durableRuntimeSummary = runtimeText.filter((event) => !event.partial).at(-1)
      ?.content.text;
    const partialRuntimeSummary = runtimeText
      .filter((event) => event.partial)
      .map((event) => event.content.text)
      .join('');
    const completedAt = run.completedAt ?? run.updatedAt;
    return {
      childSessionId: child.id,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      profile: snapshot.profile,
      turnId: run.turnId,
      runId: run.runId,
      status: agentRunStatusForSpawnResult(run.status),
      permissionMode: child.permissionMode,
      summary: trimSummary(durableRuntimeSummary ?? (storedSummary || partialRuntimeSummary)),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt: run.createdAt,
      completedAt,
      durationMs: Math.max(0, completedAt - run.createdAt),
      eventCount: runtimeEvents.length,
      ...(run.failureClass ? { failureClass: run.failureClass } : {}),
    };
  }

  async prepareChildAgentResume(
    sessionId: string,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child AgentRun resume requires AgentRunStore and RuntimeEventStore');
    }
    const execution = await this.resolveChildAgentExecution(sessionId, sourceRunId);
    return await this.prepareChildAgentResumeForExecution(sessionId, execution, sourceRunId);
  }

  private async prepareChildAgentResumeForExecution(
    sessionId: string,
    execution: SubagentExecutionRef,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child AgentRun resume requires AgentRunStore and RuntimeEventStore');
    }
    if (execution.kind === 'child_session') {
      return await this.prepareLinkedChildSessionResume(sessionId, execution, sourceRunId);
    }
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    const source = runsById.get(sourceRunId);
    if (!source || !source.parentRunId || isSessionInlineRun(source)) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    const definition = source.agentId ? getBuiltinAgentDefinition(source.agentId) : undefined;
    if (!definition) {
      throw new Error(`AgentRun ${sourceRunId} is not a resumable built-in child agent`);
    }

    const sessionHeader = await this.deps.store.readHeader(sessionId);
    await this.ensureChildWorkspace(sessionHeader);
    assertAgentDefinitionRunnable({
      definition,
      tools: await this.childToolsForSession(sessionId),
      worktreeChildExecutorAvailable: await this.isWorktreeChildExecutorAvailable(sessionHeader),
    });
    const visited = new Set<string>();
    let cursor: AgentRunHeader | undefined = source;
    while (cursor) {
      if (visited.has(cursor.runId)) {
        throw new Error(`Child AgentRun resume lineage contains a cycle at ${cursor.runId}`);
      }
      visited.add(cursor.runId);
      if (!cursor.parentRunId || isSessionInlineRun(cursor) || cursor.agentId !== definition.id) {
        throw new Error(`Child AgentRun resume profile changed at ${cursor.runId}`);
      }
      if (
        cursor.backendKind !== sessionHeader.backend ||
        cursor.llmConnectionSlug !== sessionHeader.llmConnectionSlug ||
        cursor.modelId !== sessionHeader.model ||
        cursor.cwd !== sessionHeader.cwd ||
        cursor.permissionMode !== definition.permissionMode
      ) {
        throw new Error(`Child AgentRun resume environment changed for ${cursor.runId}`);
      }

      const events = await this.deps.runtimeEventStore
        .readRuntimeEvents(sessionId, cursor.runId)
        .catch(() => []);
      const replay = buildRuntimeEventModelReplayPlan(events);
      const unsafe = replay.diagnostics.find((diagnostic) =>
        isUnsafeChildResumeDiagnostic(diagnostic.code),
      );
      if (unsafe) {
        throw new Error(`Child AgentRun resume history is unsafe: ${unsafe.code}`);
      }
      const first = replay.items[0];
      if (!first || first.kind !== 'text' || first.role !== 'user') {
        throw new Error(
          `Child AgentRun resume source ${cursor.runId} has no user-anchored history`,
        );
      }
      const terminal = classifyTerminalRuntimeLedger(cursor, events);
      if (terminal.kind !== 'fact') {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not durably terminal`);
      }
      const effective = effectiveRunHeaderFromTerminalFact(cursor, terminal.fact);
      if (!['completed', 'failed', 'cancelled'].includes(effective.status)) {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not in a resumable state`);
      }

      const previousRunId = cursor.resumedFromRunId ?? cursor.retriedFromRunId;
      if (!previousRunId) break;
      cursor = runsById.get(previousRunId);
      if (!cursor) {
        throw new Error(`Child AgentRun resume source ${previousRunId} was not found`);
      }
    }

    this.assertChildRunHasNoSuccessor(runs, sourceRunId);
    return {
      sourceRunId,
      execution,
      agentId: definition.id,
      agentName: definition.name,
      profile: definition.profile,
    };
  }

  private async resolveChildAgentExecution(
    parentSessionId: string,
    sourceRunId: string,
  ): Promise<SubagentExecutionRef> {
    if (!this.deps.runStore) {
      throw new Error('Child AgentRun lookup requires AgentRunStore');
    }
    const legacy = await this.deps.runStore.readRun(parentSessionId, sourceRunId).catch((error) => {
      if (isNotFoundError(error)) return undefined;
      throw error;
    });
    if (legacy?.parentRunId && !isSessionInlineRun(legacy)) {
      return {
        kind: 'legacy_child_run',
        sessionId: parentSessionId,
        runId: sourceRunId,
      };
    }

    const children = await this.listChildSessions(parentSessionId);
    const matches = (
      await Promise.all(
        children.map(async (child) => {
          const run = await this.deps.runStore!.readRun(child.id, sourceRunId).catch((error) => {
            if (isNotFoundError(error)) return undefined;
            throw error;
          });
          return run && isSessionInlineRun(run) ? child.id : undefined;
        }),
      )
    ).filter((childSessionId): childSessionId is string => childSessionId !== undefined);
    if (matches.length !== 1) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    return {
      kind: 'child_session',
      sessionId: matches[0]!,
      currentRunId: sourceRunId,
    };
  }

  private async prepareLinkedChildSessionResume(
    parentSessionId: string,
    execution: Extract<SubagentExecutionRef, { kind: 'child_session' }>,
    sourceRunId: string,
  ): Promise<PrepareChildAgentResumeResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child Session resume requires AgentRunStore and RuntimeEventStore');
    }
    const child = await this.deps.store.readHeader(execution.sessionId);
    const snapshot = child.subagentRuntime;
    if (
      child.subagentParent?.kind !== 'subagent' ||
      child.subagentParent.parentSessionId !== parentSessionId ||
      !snapshot
    ) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    await this.ensureChildWorkspace(child);
    await this.assertLinkedChildBoundaryMatchesParent(parentSessionId, child.id);
    const runnableTools = buildToolsForAgentDefinition(await this.childToolsForSession(child.id), {
      id: snapshot.agentId,
      permissionMode: child.permissionMode,
      tools: snapshot.toolNames,
    });
    if (runnableTools.length !== snapshot.toolNames.length) {
      throw new Error('Child Session durable runtime tool snapshot is unavailable');
    }

    const runs = await this.deps.runStore.listSessionRuns(child.id);
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    const source = runsById.get(sourceRunId);
    if (!source || !isSessionInlineRun(source)) {
      throw new Error(`Child AgentRun resume source ${sourceRunId} was not found`);
    }
    const visited = new Set<string>();
    const replaySegments: RuntimeEvent[][] = [];
    let cursor: AgentRunHeader | undefined = source;
    while (cursor) {
      if (visited.has(cursor.runId)) {
        throw new Error(`Child AgentRun resume lineage contains a cycle at ${cursor.runId}`);
      }
      visited.add(cursor.runId);
      if (!isSessionInlineRun(cursor) || cursor.agentId !== snapshot.agentId) {
        throw new Error(`Child AgentRun resume profile changed at ${cursor.runId}`);
      }
      if (
        cursor.backendKind !== child.backend ||
        cursor.llmConnectionSlug !== child.llmConnectionSlug ||
        cursor.modelId !== child.model ||
        cursor.cwd !== child.cwd ||
        cursor.permissionMode !== child.permissionMode
      ) {
        throw new Error(`Child AgentRun resume environment changed for ${cursor.runId}`);
      }

      const events = await this.deps.runtimeEventStore
        .readRuntimeEvents(child.id, cursor.runId)
        .catch(() => []);
      const replay = buildRuntimeEventModelReplayPlan(events);
      const unsafe = replay.diagnostics.find((diagnostic) =>
        isUnsafeChildResumeDiagnostic(diagnostic.code),
      );
      if (unsafe) {
        throw new Error(`Child AgentRun resume history is unsafe: ${unsafe.code}`);
      }
      replaySegments.unshift(events);
      const terminal = classifyTerminalRuntimeLedger(cursor, events);
      if (terminal.kind !== 'fact') {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not durably terminal`);
      }
      const effective = effectiveRunHeaderFromTerminalFact(cursor, terminal.fact);
      if (!['completed', 'failed', 'cancelled'].includes(effective.status)) {
        throw new Error(`Child AgentRun resume source ${cursor.runId} is not in a resumable state`);
      }

      const previousRunId = cursor.resumedFromRunId ?? cursor.retriedFromRunId;
      if (!previousRunId) break;
      cursor = runsById.get(previousRunId);
      if (!cursor) {
        throw new Error(`Child AgentRun resume source ${previousRunId} was not found`);
      }
    }

    const replay = buildRuntimeEventModelReplayPlan(replaySegments.flat());
    const first = replay.items[0];
    if (!first || first.kind !== 'text' || first.role !== 'user') {
      throw new Error(`Child AgentRun resume source ${sourceRunId} has no user-anchored history`);
    }
    await this.effectiveRunHeaderFromRuntimeLedger(source);
    await this.finalizeChildWorkspacePatches(child.id);
    this.assertChildRunHasNoSuccessor(runs, sourceRunId);
    return {
      sourceRunId,
      execution,
      agentId: snapshot.agentId,
      agentName: snapshot.agentName,
      profile: snapshot.profile,
    };
  }

  async resumeChildAgent(
    sessionId: string,
    input: ResumeChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    let runtimeExecution = this.runtimeKernel.claimExecution(sessionId);
    try {
      throwIfChildExecutionAborted(
        input.abortSignal,
        'Child agent resume was cancelled before start',
      );
      const execution = await this.resolveChildAgentExecution(sessionId, input.sourceRunId);
      if (execution.kind === 'child_session') {
        runtimeExecution = this.transferRuntimeExecution(runtimeExecution, execution.sessionId);
        const releaseHostedExecution = this.acquireHostedLinkedChildExecution(execution.sessionId);
        try {
          const prepared = await this.prepareChildAgentResumeForExecution(
            sessionId,
            execution,
            input.sourceRunId,
          );
          return await this.resumeLinkedChildSession(
            sessionId,
            execution,
            prepared,
            input,
            runtimeExecution,
            true,
          );
        } finally {
          releaseHostedExecution();
        }
      }
      const prepared = await this.prepareChildAgentResumeForExecution(
        sessionId,
        execution,
        input.sourceRunId,
      );
      const definition = getBuiltinAgentDefinition(prepared.agentId)!;
      return await this.runChildAgent(
        sessionId,
        definition,
        input,
        runtimeExecution,
        input.sourceRunId,
      );
    } finally {
      runtimeExecution.release();
    }
  }

  private transferRuntimeExecution(
    source: RuntimeExecutionClaim,
    targetSessionId: string,
  ): RuntimeExecutionClaim {
    if (source.sessionId === targetSessionId) return source;
    let target: RuntimeExecutionClaim;
    try {
      target = this.runtimeKernel.claimExecution(targetSessionId);
    } catch (error) {
      source.release();
      throw error;
    }
    return this.handoffRuntimeExecution(source, target);
  }

  private handoffRuntimeExecution(
    source: RuntimeExecutionClaim,
    target: RuntimeExecutionClaim,
  ): RuntimeExecutionClaim {
    if (source.sessionId === target.sessionId) {
      target.release();
      return source;
    }
    const stopped = source.isStopRequested();
    source.release();
    if (stopped) {
      target.release();
      throw new Error(
        `Session ${source.sessionId} stopped before child execution ownership transferred`,
      );
    }
    return target;
  }

  private async resumeLinkedChildSession(
    parentSessionId: string,
    execution: Extract<SubagentExecutionRef, { kind: 'child_session' }>,
    prepared: PrepareChildAgentResumeResult,
    input: ResumeChildAgentInput,
    runtimeExecution: RuntimeExecutionClaim,
    hostedGateAlreadyHeld: boolean,
  ): Promise<SpawnChildAgentResult> {
    throwIfChildExecutionAborted(
      input.abortSignal,
      'Child agent resume was cancelled before start',
    );
    if (!this.deps.runStore) {
      throw new Error('Child Session resume requires AgentRunStore');
    }
    const [parentRun, child] = await Promise.all([
      this.deps.runStore.readRun(parentSessionId, input.parentRunId),
      this.deps.store.readHeader(execution.sessionId),
    ]);
    this.assertActiveParentRun(parentSessionId, parentRun, parentRun.turnId);
    if (
      child.subagentParent?.kind !== 'subagent' ||
      child.subagentParent.parentSessionId !== parentSessionId ||
      child.subagentRuntime?.agentId !== prepared.agentId
    ) {
      throw new Error(`Child AgentRun resume source ${input.sourceRunId} was not found`);
    }

    const turnId = input.turnId ?? this.deps.newId();
    const runId = this.deps.newId();
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    let stopPromise: Promise<void> | undefined;
    const identity = { sessionId: child.id, turnId, runId };
    throwIfChildExecutionAborted(
      input.abortSignal,
      'Child agent resume was cancelled before start',
    );
    const executionPromise = this.consumeLinkedRootExecution(
      {
        ...identity,
        userMessageId: this.deps.newId(),
        execution: {
          kind: 'linked_child_resume',
          agentId: prepared.agentId,
          agentName: prepared.agentName,
          sourceRunId: input.sourceRunId,
        },
        content: { text: input.prompt },
        start: ({ runId: admittedRunId, userMessageId, onRunStarted }) =>
          this.sendMessage(
            child.id,
            {
              turnId,
              text: input.prompt,
              resumedFromRunId: input.sourceRunId,
              agentId: prepared.agentId,
              agentName: prepared.agentName,
            },
            {
              runId: admittedRunId,
              ...(userMessageId ? { userMessageId } : {}),
              durability: 'required',
              onRunStarted,
              execution: runtimeExecution,
            },
          ),
        onReady: () =>
          input.onReady?.({
            childSessionId: child.id,
            turnId,
            runId,
            agentId: prepared.agentId,
            agentName: prepared.agentName,
          }),
        onEvent: (event) => {
          summary.add(event);
          try {
            input.onEvent?.(event);
          } catch {
            // A presentation observer must not change the child run outcome.
          }
        },
      },
      hostedGateAlreadyHeld,
    );
    const onAbort = () => {
      aborted = true;
      stopPromise ??= this.stopLinkedRoot(identity, { source: 'stop_button' });
    };
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (input.abortSignal.aborted) onAbort();
    }
    try {
      await executionPromise;
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await stopPromise;
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(child.id, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = run
      ? await this.finalizeAndListChildTurnArtifacts(child.id, turnId, run.status)
      : [];
    return {
      childSessionId: child.id,
      agentId: prepared.agentId,
      agentName: prepared.agentName,
      turnId,
      runId,
      resumedFromRunId: input.sourceRunId,
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: child.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  private async runChildAgent(
    sessionId: string,
    definition: AgentDefinition,
    input: SpawnChildAgentInput | ResumeChildAgentInput,
    execution: RuntimeExecutionClaim,
    resumedFromRunId?: string,
  ): Promise<SpawnChildAgentResult> {
    throwIfChildExecutionAborted(
      input.abortSignal,
      'Child agent execution was cancelled before start',
    );
    const turnId = input.turnId ?? this.deps.newId();
    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    await input.onReady?.({ turnId, agentId: definition.id, agentName: definition.name });
    const iterator = this.runtimeKernel
      .startChildTurn(
        sessionId,
        {
          turnId,
          parentRunId: input.parentRunId,
          spec: {
            id: definition.id,
            name: definition.name,
            systemPrompt: definition.systemPrompt,
          },
          prompt: input.prompt,
          ...(resumedFromRunId ? { resumedFromRunId } : {}),
        },
        execution,
      )
      [Symbol.asyncIterator]();
    const onAbort = () => {
      aborted = true;
      void iterator.return?.();
    };
    if (input.abortSignal && !input.abortSignal.aborted) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      while (!aborted) {
        const next = await iterator.next();
        if (next.done) break;
        summary.add(next.value);
        try {
          input.onEvent?.(next.value);
        } catch {
          // A presentation observer must not change the child run outcome.
        }
      }
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await iterator.return?.();
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(sessionId, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = run
      ? await this.finalizeAndListChildTurnArtifacts(sessionId, turnId, run.status)
      : [];
    return {
      agentId: definition.id,
      agentName: definition.name,
      turnId,
      ...(run?.runId ? { runId: run.runId } : {}),
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: definition.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
      ...(resumedFromRunId ? { resumedFromRunId } : {}),
    };
  }

  async retryChildAgent(
    sessionId: string,
    input: RetryChildAgentInput,
  ): Promise<SpawnChildAgentResult> {
    let runtimeExecution = this.runtimeKernel.claimExecution(sessionId);
    let hintedTargetExecution: RuntimeExecutionClaim | undefined;
    try {
      if (input.execution?.kind === 'child_session') {
        hintedTargetExecution = this.runtimeKernel.claimExecution(input.execution.sessionId);
      }
      throwIfChildExecutionAborted(
        input.abortSignal,
        'Child agent retry was cancelled before start',
      );
      if (!this.deps.runStore || !this.deps.runtimeEventStore) {
        throw new Error('Child agent retry requires AgentRunStore and RuntimeEventStore');
      }
      const execution = await this.resolveChildAgentExecution(sessionId, input.sourceRunId);
      this.assertChildRetryExecutionIdentity(input, execution);
      if (execution.kind === 'child_session') {
        if (hintedTargetExecution) {
          runtimeExecution = this.handoffRuntimeExecution(runtimeExecution, hintedTargetExecution);
          hintedTargetExecution = undefined;
        } else {
          runtimeExecution = this.transferRuntimeExecution(runtimeExecution, execution.sessionId);
        }
      }
      const releaseHostedExecution =
        execution.kind === 'child_session'
          ? this.acquireHostedLinkedChildExecution(execution.sessionId)
          : () => {};
      try {
        return await this.retryChildAgentWithExecution(
          sessionId,
          input,
          execution,
          runtimeExecution,
        );
      } finally {
        releaseHostedExecution();
      }
    } finally {
      hintedTargetExecution?.release();
      runtimeExecution.release();
    }
  }

  private assertChildRetryExecutionIdentity(
    input: RetryChildAgentInput,
    execution: SubagentExecutionRef,
  ): void {
    if (
      input.execution &&
      (input.execution.kind !== execution.kind ||
        input.execution.sessionId !== execution.sessionId ||
        (input.execution.kind === 'legacy_child_run' &&
          (execution.kind !== 'legacy_child_run' || input.execution.runId !== execution.runId)) ||
        (input.execution.kind === 'child_session' &&
          input.execution.currentRunId !== undefined &&
          input.execution.currentRunId !== input.sourceRunId))
    ) {
      throw new Error('Child agent retry execution identity changed');
    }
  }

  private async assertLinkedChildBoundaryMatchesParent(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<void> {
    const [parentBoundary, childBoundary] = await Promise.all([
      this.deps.store.readExecutionBoundary(parentSessionId),
      this.deps.store.readExecutionBoundary(childSessionId),
    ]);
    if (!executionBoundaryContains(parentBoundary, childBoundary)) {
      throw new Error('Linked child execution boundary no longer matches its parent');
    }
  }

  private async retryChildAgentWithExecution(
    sessionId: string,
    input: RetryChildAgentInput,
    execution: SubagentExecutionRef,
    runtimeExecution: RuntimeExecutionClaim,
  ): Promise<SpawnChildAgentResult> {
    throwIfChildExecutionAborted(input.abortSignal, 'Child agent retry was cancelled before start');
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child agent retry requires AgentRunStore and RuntimeEventStore');
    }
    const targetSessionId = execution.sessionId;
    const runs = await this.deps.runStore.listSessionRuns(targetSessionId);
    const rawSourceRun = runs.find((run) => run.runId === input.sourceRunId);
    if (!rawSourceRun) throw new Error('Child agent retry source run was not found');
    const sourceRun = await this.effectiveRunHeaderFromRuntimeLedger(rawSourceRun);
    let definition: {
      id: string;
      name: string;
      systemPrompt: string;
      permissionMode: PermissionMode;
      toolNames: string[];
    };
    if (execution.kind === 'child_session') {
      const [parentRun, child] = await Promise.all([
        this.deps.runStore.readRun(sessionId, input.parentRunId),
        this.deps.store.readHeader(targetSessionId),
      ]);
      this.assertActiveParentRun(sessionId, parentRun, parentRun.turnId);
      const snapshot = child.subagentRuntime;
      if (
        child.subagentParent?.kind !== 'subagent' ||
        child.subagentParent.parentSessionId !== sessionId ||
        !snapshot ||
        !isSessionInlineRun(sourceRun) ||
        sourceRun.agentId !== snapshot.agentId
      ) {
        throw new Error('Child agent retry source does not belong to the parent Session');
      }
      await this.ensureChildWorkspace(child);
      await this.assertLinkedChildBoundaryMatchesParent(sessionId, child.id);
      definition = {
        id: snapshot.agentId,
        name: snapshot.agentName,
        systemPrompt: snapshot.systemPrompt,
        permissionMode: child.permissionMode,
        toolNames: [...snapshot.toolNames],
      };
    } else {
      if (!sourceRun.parentRunId || sourceRun.parentRunId !== input.parentRunId) {
        throw new Error('Child agent retry source does not belong to the active parent run');
      }
      if (!sourceRun.agentId) throw new Error('Child agent retry source is missing its agent id');
      const resolved = requireBuiltinAgentDefinition(sourceRun.agentId);
      definition = {
        ...resolved,
        toolNames: buildToolsForAgentDefinition(
          await this.childToolsForSession(sessionId),
          resolved,
        ).map((tool) => tool.name),
      };
    }
    const authority = runtimeContinuationAuthority(this.deps.runtimeEventStore);
    const abandonedBeforeProvider =
      sourceRun.failureClass === 'continuation_abandoned_before_provider_dispatch'
        ? await isProvenRecoveredContinuationAbandonment(authority, sourceRun)
        : false;
    if (
      sourceRun.status !== 'failed' ||
      (sourceRun.failureClass !== 'RateLimit' && !abandonedBeforeProvider)
    ) {
      throw new Error(
        'Child agent retry source must be a provider rate-limit failure or a proven pre-provider continuation abandonment',
      );
    }
    if (execution.kind === 'child_session') {
      await this.finalizeChildWorkspacePatches(targetSessionId);
    }
    this.assertChildRunHasNoSuccessor(runs, sourceRun.runId);

    if (!authority || !this.deps.inspectContinuationSafety) {
      throw new Error(
        'Child agent retry continuation authority composition is incomplete; refusing legacy fallback',
      );
    }
    const continuation = await this.planDurableChildProviderRetry({
      targetSessionId,
      sourceRun,
      runs,
      authority,
      inspectSafety: this.deps.inspectContinuationSafety,
      availableToolNames: definition.toolNames,
    });
    const retryReplay = buildRuntimeEventModelReplayPlan(continuation.runtimeContext);
    const retryAnchor = retryReplay.items[0];
    if (!retryAnchor || retryAnchor.kind !== 'text' || retryAnchor.role !== 'user') {
      throw new Error('Child agent retry source has no user-anchored history');
    }
    const { turnId, runId } = continuation;

    const startedAt = this.deps.now();
    const summary = new ChildAgentSummaryAccumulator();
    let aborted = input.abortSignal?.aborted === true;
    const startChildRetry = this.runtimeKernel.startChildRetry;
    if (!startChildRetry) throw new Error('RuntimeKernel does not support child agent retry');
    const linkedIdentity = { sessionId: targetSessionId, turnId, runId };
    const emitReady = () =>
      input.onReady?.({
        ...(execution.kind === 'child_session'
          ? { childSessionId: execution.sessionId, runId }
          : {}),
        turnId,
        agentId: definition.id,
        agentName: definition.name,
      });
    const consumeEvent = (event: SessionEvent) => {
      summary.add(event);
      try {
        input.onEvent?.(event);
      } catch {
        // A presentation observer must not change the child run outcome.
      }
    };
    throwIfChildExecutionAborted(input.abortSignal, 'Child agent retry was cancelled before start');
    const executionPromise =
      execution.kind === 'child_session'
        ? this.consumeLinkedRootExecution(
            {
              ...linkedIdentity,
              userMessageId: null,
              execution: {
                kind: 'linked_child_provider_retry',
                agentId: definition.id,
                agentName: definition.name,
                sourceRunId: sourceRun.runId,
              },
              content: {
                text: retryAnchor.content,
                ...(retryAnchor.attachments ? { attachments: retryAnchor.attachments } : {}),
              },
              start: ({ onRunStarted }) =>
                startChildRetry.call(
                  this.runtimeKernel,
                  targetSessionId,
                  {
                    parentRunId: input.parentRunId,
                    spec: {
                      id: definition.id,
                      name: definition.name,
                      systemPrompt: definition.systemPrompt,
                    },
                    continuation,
                    linkedSession: true,
                    onRunStarted,
                  },
                  runtimeExecution,
                ),
              onReady: emitReady,
              onEvent: consumeEvent,
            },
            true,
          )
        : this.consumeRuntimeEvents(
            startChildRetry.call(
              this.runtimeKernel,
              targetSessionId,
              {
                parentRunId: input.parentRunId,
                spec: {
                  id: definition.id,
                  name: definition.name,
                  systemPrompt: definition.systemPrompt,
                },
                continuation,
              },
              runtimeExecution,
            ),
            emitReady,
            consumeEvent,
          );
    let stopPromise: Promise<void> | undefined;
    const onAbort = () => {
      aborted = true;
      if (execution.kind === 'child_session') {
        stopPromise ??= this.stopLinkedRoot(linkedIdentity, { source: 'stop_button' });
      } else {
        stopPromise ??= this.runtimeKernel.stopSession(targetSessionId, {
          source: 'stop_button',
        });
      }
    };
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', onAbort, { once: true });
      if (input.abortSignal.aborted) onAbort();
    }
    try {
      await executionPromise;
    } finally {
      input.abortSignal?.removeEventListener('abort', onAbort);
      if (aborted) await stopPromise;
    }

    const completedAt = this.deps.now();
    const run = await this.findRunByTurnId(targetSessionId, turnId);
    const failureClass = run?.failureClass ?? summary.failureClass;
    const artifacts = run
      ? await this.finalizeAndListChildTurnArtifacts(targetSessionId, turnId, run.status)
      : [];
    return {
      ...(execution.kind === 'child_session' ? { childSessionId: execution.sessionId } : {}),
      agentId: definition.id,
      agentName: definition.name,
      turnId,
      ...(run?.runId ? { runId: run.runId } : { runId }),
      retriedFromRunId: sourceRun.runId,
      status: run ? agentRunStatusForSpawnResult(run.status) : summary.status(aborted),
      permissionMode: definition.permissionMode,
      summary: summary.text(),
      artifactIds: artifacts.map((artifact) => artifact.id),
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      eventCount: summary.eventCount,
      ...(failureClass ? { failureClass } : {}),
    };
  }

  private async planDurableChildProviderRetry(input: {
    targetSessionId: string;
    sourceRun: AgentRunHeader;
    runs: readonly AgentRunHeader[];
    authority: RuntimeContinuationAuthorityStore;
    inspectSafety: (sessionId: string) => Promise<RuntimeContinuationSafetyObservation>;
    availableToolNames: readonly string[];
  }): Promise<RuntimeContinuation> {
    const runsById = new Map(input.runs.map((run) => [run.runId, run]));
    const planner = new RuntimeContinuationPlanner({
      readSourceRun: async (_sessionId, runId) => {
        const raw = runsById.get(runId);
        if (!raw) throw new Error(`Child agent retry lineage source ${runId} is missing`);
        const effective =
          runId === input.sourceRun.runId
            ? input.sourceRun
            : await this.effectiveRunHeaderFromRuntimeLedger(raw);
        if (effective.continuationSource) return effective;
        const previousRunId = effective.retriedFromRunId ?? effective.resumedFromRunId;
        if (!previousRunId) return effective;
        const previous = runsById.get(previousRunId);
        if (!previous) {
          throw new Error(`Child agent retry lineage source ${previousRunId} is missing`);
        }
        const prefix = await input.authority.readImmutableRuntimePrefix({
          sessionId: input.targetSessionId,
          runId: previousRunId,
        });
        return {
          ...effective,
          continuationSource: {
            sourceInvocationId: prefix.identity.invocationId,
            sourceRunId: prefix.identity.runId,
            sourceTurnId: prefix.identity.turnId,
            sourceRuntimeEventHighWater: prefix.position.lastEventSeq,
          },
        };
      },
      readImmutableRuntimePrefix: (prefixInput) =>
        input.authority.readImmutableRuntimePrefix(prefixInput),
      readContinuationClaimStateByBoundary: (boundaryDigest) =>
        input.authority.readContinuationClaimStateByBoundary(boundaryDigest),
      findExistingContinuation: async (_sessionId, sourceRunId, sourceRuntimeEventHighWater) =>
        input.runs.find(
          (run) =>
            run.continuationSource?.sourceRunId === sourceRunId &&
            run.continuationSource.sourceRuntimeEventHighWater === sourceRuntimeEventHighWater,
        ),
      newId: this.deps.newId,
    });
    const [targetHeader, safety] = await Promise.all([
      this.deps.store.readHeader(input.targetSessionId),
      input.inspectSafety(input.targetSessionId),
    ]);
    const retryPlan = await planner.plan({
      sessionId: input.targetSessionId,
      sourceRunId: input.sourceRun.runId,
      currentCwd: targetHeader.cwd,
      sourceWorkspaceIdentity: input.sourceRun.workspaceIdentity ?? input.sourceRun.cwd,
      currentWorkspaceIdentity: safety.workspaceIdentity,
      backgroundOperationsSettled: safety.backgroundOperationsSettled,
      availableToolNames: input.availableToolNames,
      ...(safety.workspaceCheckpoint ? { workspaceCheckpoint: safety.workspaceCheckpoint } : {}),
    });
    if (retryPlan.disposition !== 'continue' || !retryPlan.continuation) {
      throw new Error(
        `Child agent retry source is not safely replayable: ${retryPlan.rejectionReasons.join(', ')}`,
      );
    }
    return retryPlan.continuation;
  }

  private assertChildRunHasNoSuccessor(runs: readonly AgentRunHeader[], sourceRunId: string): void {
    if (
      runs.some(
        (run) => run.resumedFromRunId === sourceRunId || run.retriedFromRunId === sourceRunId,
      )
    ) {
      throw new Error(`Child AgentRun ${sourceRunId} already has a successor`);
    }
  }

  async listChildAgents(sessionId: string): Promise<AgentListResult> {
    const [header, tools] = await Promise.all([
      this.deps.store.readHeader(sessionId),
      this.childToolsForSession(sessionId),
    ]);
    const definitions = listBuiltinAgentDefinitions({
      tools,
      worktreeChildExecutorAvailable: await this.isWorktreeChildExecutorAvailable(header),
    });
    const presets = this.deps.subagentCatalog ? await this.deps.subagentCatalog.list() : [];
    if (!this.deps.runStore) return { definitions, presets, executions: [], runs: [] };
    const runs = await this.deps.runStore.listSessionRuns(sessionId);
    const childRuns = await Promise.all(
      runs
        .filter(
          (run): run is AgentRunHeader & { parentRunId: string } =>
            !!run.parentRunId && !isSessionInlineRun(run),
        )
        .map(
          async (run): Promise<AgentRunHeader & { parentRunId: string }> => ({
            ...(await this.effectiveRunHeaderFromRuntimeLedger(run)),
            parentRunId: run.parentRunId,
          }),
        ),
    );
    const legacyRuns = childRuns.map((run) => ({
      runId: run.runId,
      turnId: run.turnId,
      parentRunId: run.parentRunId,
      ...(run.agentId ? { agentId: run.agentId } : {}),
      ...(run.agentName ? { agentName: run.agentName } : {}),
      status: run.status,
      permissionMode: run.permissionMode,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(run.completedAt !== undefined
        ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
        : {}),
      ...(run.failureClass ? { failureClass: run.failureClass } : {}),
    }));
    const childSessionHeaders = await Promise.all(
      (await this.listChildSessions(sessionId)).map((child) =>
        this.deps.store.readHeader(child.id),
      ),
    );
    const childSessionExecutions = await Promise.all(
      childSessionHeaders.map(async (child): Promise<SubagentExecutionListItem> => {
        const childRuns = await this.deps.runStore!.listSessionRuns(child.id);
        const latest = childRuns
          .slice()
          .sort(
            (left, right) =>
              right.createdAt - left.createdAt ||
              right.updatedAt - left.updatedAt ||
              right.runId.localeCompare(left.runId),
          )[0];
        const run = latest ? await this.effectiveRunHeaderFromRuntimeLedger(latest) : undefined;
        const currentRunId = run?.runId ?? child.subagentSpawn?.initialRunId;
        return {
          execution: {
            kind: 'child_session',
            sessionId: child.id,
            ...(currentRunId ? { currentRunId } : {}),
          },
          ...(child.subagentRuntime?.agentId ? { agentId: child.subagentRuntime.agentId } : {}),
          ...(child.subagentRuntime?.agentName
            ? { agentName: child.subagentRuntime.agentName }
            : {}),
          ...(child.subagentRuntime?.profile ? { profile: child.subagentRuntime.profile } : {}),
          ...(run?.turnId ? { turnId: run.turnId } : {}),
          status: run?.status ?? (child.status === 'aborted' ? 'cancelled' : 'created'),
          permissionMode: run?.permissionMode ?? child.permissionMode,
          createdAt: run?.createdAt ?? child.createdAt,
          updatedAt: run?.updatedAt ?? child.lastUsedAt,
          ...(run?.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
          ...(run?.completedAt !== undefined
            ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
            : {}),
          ...(run?.failureClass ? { failureClass: run.failureClass } : {}),
        };
      }),
    );
    return {
      definitions,
      presets,
      executions: [
        ...childSessionExecutions,
        ...childRuns.map(
          (run): SubagentExecutionListItem => ({
            execution: {
              kind: 'legacy_child_run',
              sessionId,
              runId: run.runId,
            },
            ...(run.agentId ? { agentId: run.agentId } : {}),
            ...(run.agentName ? { agentName: run.agentName } : {}),
            turnId: run.turnId,
            status: run.status,
            permissionMode: run.permissionMode,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
            ...(run.completedAt !== undefined
              ? { durationMs: Math.max(0, run.completedAt - run.createdAt) }
              : {}),
            ...(run.failureClass ? { failureClass: run.failureClass } : {}),
          }),
        ),
      ],
      runs: legacyRuns,
    };
  }

  private async childToolsForSession(sessionId: string): Promise<readonly MakaTool[]> {
    if (!this.deps.resolveChildTools) return this.deps.childTools ?? [];
    return (await this.deps.resolveChildTools(sessionId)).tools;
  }

  async readChildAgentOutput(
    sessionId: string,
    input: AgentOutputInput,
  ): Promise<AgentOutputResult> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('agent_output requires AgentRunStore and RuntimeEventStore');
    }
    const located = await this.findChildRunForOutput(sessionId, input);
    const { header } = located;
    const inspected = await inspectAgentRunReadModel(
      this.deps.runStore,
      this.deps.runtimeEventStore,
      {
        sessionId: header.sessionId,
        runId: header.runId,
        header,
      },
    );
    const artifacts = await this.finalizeAndListChildTurnArtifacts(
      header.sessionId,
      header.turnId,
      inspected.header.status,
    );
    const maxEvents = normalizeAgentOutputMaxEvents(input.maxEvents);
    const maxBytes = normalizeAgentOutputMaxBytes(input.maxBytes);
    const view = input.view ?? 'runtime_events';
    if (view === 'result') {
      const boundedResult = buildAgentOutputCommittedResult({
        header: inspected.header,
        runtimeEvents: inspected.runtimeEvents,
        artifacts,
        maxArtifacts: maxEvents,
        maxBytes,
        ...(located.graph ? { graph: located.graph } : {}),
      });
      return {
        execution: located.execution,
        header: inspected.header,
        result: boundedResult.result,
        events: [],
        runtimeEvents: [],
        sourceHealth: inspected.sourceHealth,
        diagnostics: [],
        artifacts: [],
        truncated: {
          events: inspected.events.length > 0,
          runtimeEvents: inspected.runtimeEvents.length > 0,
          diagnostics: inspected.diagnostics.length > 0,
          artifacts: artifacts.length > 0,
          bytes: boundedResult.truncated,
        },
        budget: {
          view,
          maxBytes,
          projectedBytes: boundedResult.projectedBytes,
        },
      };
    }
    const bounded = boundAgentOutputCollections(
      {
        events: view === 'runtime_events' ? [] : tail(inspected.events, maxEvents),
        runtimeEvents: view === 'events' ? [] : tail(inspected.runtimeEvents, maxEvents),
        diagnostics: tail(inspected.diagnostics, maxEvents),
        artifacts: tail(artifacts, maxEvents),
      },
      maxBytes,
    );
    return {
      execution: located.execution,
      header: inspected.header,
      events: bounded.events,
      runtimeEvents: bounded.runtimeEvents,
      sourceHealth: inspected.sourceHealth,
      diagnostics: bounded.diagnostics,
      artifacts: bounded.artifacts,
      truncated: {
        events:
          view === 'runtime_events' ||
          inspected.events.length > maxEvents ||
          bounded.events.length < Math.min(inspected.events.length, maxEvents),
        runtimeEvents:
          view === 'events' ||
          inspected.runtimeEvents.length > maxEvents ||
          bounded.runtimeEvents.length < Math.min(inspected.runtimeEvents.length, maxEvents),
        diagnostics:
          inspected.diagnostics.length > maxEvents ||
          bounded.diagnostics.length < Math.min(inspected.diagnostics.length, maxEvents),
        artifacts:
          artifacts.length > maxEvents ||
          bounded.artifacts.length < Math.min(artifacts.length, maxEvents),
        bytes: bounded.truncated,
      },
      budget: {
        view,
        maxBytes,
        projectedBytes: bounded.projectedBytes,
      },
    };
  }

  async stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const hostedAuthority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    const ownStop = hostedAuthority
      ? hostedAuthority.stopSession(sessionId, input)
      : this.runtimeKernel.stopSession(sessionId, input);
    let childStops: PromiseSettledResult<void>[] = [];
    let childLookupError: unknown;
    try {
      const children = await this.listChildSessions(sessionId);
      childStops = await Promise.allSettled(
        children
          .filter((child) => child.subagentParent?.lifecycle === 'foreground')
          .map((child) =>
            hostedAuthority
              ? hostedAuthority.stopSession(child.id, input)
              : this.runtimeKernel.stopSession(child.id, input),
          ),
      );
    } catch (error) {
      childLookupError = error;
    }
    await ownStop;
    const childStopError = childStops.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )?.reason;
    if (childLookupError !== undefined) throw childLookupError;
    if (childStopError !== undefined) throw childStopError;
  }

  async deliverHostedRootStop(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const ownStop = this.runtimeKernel.stopSession(sessionId, input);
    const authority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    let childStops: PromiseSettledResult<void>[] = [];
    let childLookupError: unknown;
    try {
      const children = await this.listChildSessions(sessionId);
      childStops = await Promise.allSettled(
        children
          .filter((child) => child.subagentParent?.lifecycle === 'foreground')
          .map((child) =>
            authority
              ? authority.stopSession(child.id, input)
              : this.runtimeKernel.stopSession(child.id, input),
          ),
      );
    } catch (error) {
      childLookupError = error;
    }
    await ownStop;
    const childStopError = childStops.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )?.reason;
    if (childLookupError !== undefined) throw childLookupError;
    if (childStopError !== undefined) throw childStopError;
  }

  async closePendingHostedAdmission(input: {
    sessionId: string;
    turnId: string;
    runId: string;
    admittedAt: number;
    execution: Exclude<
      RootExecutionDescriptor,
      | { kind: 'regenerate' }
      | { kind: 'context_compact' }
      | { kind: 'scheduled_task' }
      | { kind: 'safe_boundary_continuation' }
    >;
  }): Promise<void> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Hosted admission recovery requires execution stores');
    }
    const session = await this.deps.store.readHeader(input.sessionId);
    const headerExtras: Partial<AgentRunHeader> = {};
    let recoveryReason: string;
    let diagnostic: Record<string, unknown>;
    let workspaceIdentity: string | undefined;
    if (input.execution.kind === 'goal') {
      headerExtras.goalId = input.execution.goalId;
      recoveryReason = 'goal_internal_admission_without_run';
      diagnostic = {
        executionKind: input.execution.kind,
        goalId: input.execution.goalId,
      };
    } else if (input.execution.kind === 'legacy_automation') {
      headerExtras.legacyAutomationId = input.execution.automationId;
      recoveryReason = 'legacy_automation_authority_removed';
      diagnostic = {
        executionKind: input.execution.kind,
        automationId: input.execution.automationId,
      };
    } else if (input.execution.kind === 'agent_graph_supervisor_wake') {
      headerExtras.agentGraphWakeId = input.execution.wakeId;
      headerExtras.agentGraphWakeAttemptId = input.execution.attemptId;
      headerExtras.orchestrationMode = 'graph';
      headerExtras.orchestrationSource = 'turn_override';
      headerExtras.agentSwarmAuthorization = 'none';
      recoveryReason = 'agent_graph_supervisor_internal_admission_without_run';
      diagnostic = {
        executionKind: input.execution.kind,
        graphId: input.execution.graphId,
        wakeId: input.execution.wakeId,
        attemptId: input.execution.attemptId,
      };
    } else if (input.execution.kind !== 'external_message') {
      if (
        session.subagentParent?.kind !== 'subagent' ||
        session.subagentRuntime?.agentId !== input.execution.agentId ||
        session.subagentRuntime.agentName !== input.execution.agentName
      ) {
        throw new Error(
          `Admitted Turn ${input.turnId} does not match its linked child Session identity`,
        );
      }

      const continuationAuthority = runtimeContinuationAuthority(this.deps.runtimeEventStore);
      if (continuationAuthority) {
        const claimState = (
          await continuationAuthority.listContinuationClaimsForRecovery(input.sessionId)
        ).find(
          (candidate) =>
            candidate.claim.target.runId === input.runId ||
            candidate.claim.target.turnId === input.turnId,
        );
        if (claimState) {
          assertClaimOwnsHostedLinkedChildAdmission(
            {
              sessionId: input.sessionId,
              turnId: input.turnId,
              runId: input.runId,
              execution: input.execution,
            },
            claimState.claim,
          );
          // The continuation claim is the durable owner of this target identity.
          // SessionManager's claim-repair saga must materialize its exact header;
          // the generic hosted-admission repair must not steal the same Run ID.
          return;
        }
      }

      if (
        input.execution.kind === 'linked_child_resume' ||
        input.execution.kind === 'linked_child_provider_retry'
      ) {
        const sourceRun = await this.deps.runStore.readRun(
          input.sessionId,
          input.execution.sourceRunId,
        );
        if (
          sourceRun.agentId !== input.execution.agentId ||
          sourceRun.agentName !== input.execution.agentName
        ) {
          throw new Error(
            `Admitted Turn ${input.turnId} source changed its trusted agent identity`,
          );
        }
        workspaceIdentity = sourceRun.workspaceIdentity;
        if (input.execution.kind === 'linked_child_resume') {
          headerExtras.resumedFromRunId = input.execution.sourceRunId;
        } else {
          headerExtras.retriedFromRunId = input.execution.sourceRunId;
        }
      }
      headerExtras.agentId = input.execution.agentId;
      headerExtras.agentName = input.execution.agentName;
      recoveryReason = 'child_internal_admission_without_run';
      diagnostic = {
        executionKind: input.execution.kind,
        ...(input.execution.kind === 'linked_child_resume' ||
        input.execution.kind === 'linked_child_provider_retry'
          ? { sourceRunId: input.execution.sourceRunId }
          : {}),
      };
    } else {
      throw new Error('External message recovery closure is not supported');
    }

    const run: AgentRunHeader = {
      runId: input.runId,
      invocationId: input.runId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      status: 'created',
      backendKind: session.backend,
      llmConnectionSlug: session.llmConnectionSlug,
      modelId: session.model,
      cwd: session.cwd,
      ...(workspaceIdentity !== undefined ? { workspaceIdentity } : {}),
      permissionMode: session.permissionMode,
      collaborationMode: session.collaborationMode ?? 'agent',
      createdAt: input.admittedAt,
      updatedAt: input.admittedAt,
      ...headerExtras,
    };
    await this.deps.runStore.createRun(run, { durable: true });

    const ts = this.deps.now();
    const terminalEvent = buildRecoveredTerminalRuntimeEvent({
      id: this.deps.newId(),
      run,
      status: 'failed',
      ts,
      failureClass: 'app_restarted',
      recoveryReason,
      diagnostic,
      message: 'app_restarted',
    });
    await commitTerminalRunWithRuntimeFact({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      newId: this.deps.newId,
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      status: 'failed',
      ts,
      terminalEvent,
      failureClass: 'app_restarted',
      runEventData: {
        recovered: true,
        recoveryReason,
        ...diagnostic,
      },
      existingEvents: [],
    });
  }

  private async consumeLinkedRootExecution(
    input: RuntimeHostedRootExecutionInput,
    hostedGateAlreadyHeld = false,
  ): Promise<void> {
    const authority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    if (authority) {
      const release = hostedGateAlreadyHeld
        ? undefined
        : this.acquireHostedLinkedChildExecution(input.sessionId);
      try {
        await authority.executeRoot(input);
        return;
      } finally {
        release?.();
      }
    }
    await this.consumeRuntimeEvents(
      input.start({
        runId: input.runId,
        userMessageId: input.userMessageId,
        onRunStarted: () => input.onReady?.(),
      }),
      undefined,
      input.onEvent,
    );
  }

  private acquireHostedLinkedChildExecution(sessionId: string): () => void {
    if (!isRuntimeHostedRootAuthority(this.deps.messageAuthority)) return () => {};
    if (this.activeHostedLinkedChildSessions.has(sessionId)) {
      throw new Error(`Child Session ${sessionId} already has an active execution`);
    }
    this.activeHostedLinkedChildSessions.add(sessionId);
    return () => {
      this.activeHostedLinkedChildSessions.delete(sessionId);
    };
  }

  private async consumeRuntimeEvents(
    events: AsyncIterable<SessionEvent>,
    onReady?: () => void | Promise<void>,
    onEvent?: (event: SessionEvent) => void,
  ): Promise<void> {
    await onReady?.();
    for await (const event of events) onEvent?.(event);
  }

  private stopLinkedRoot(
    identity: RuntimeMessageRunIdentity,
    input: StopSessionInput,
  ): Promise<void> {
    const authority = isRuntimeHostedRootAuthority(this.deps.messageAuthority)
      ? this.deps.messageAuthority
      : undefined;
    return authority
      ? authority.stopRoot(identity, input)
      : this.runtimeKernel.stopSession(identity.sessionId, input);
  }

  /** Queue a user message for mid-turn injection at the next step boundary. */
  steer(sessionId: string, text: string): QueueEnqueueOutcome {
    return this.runtimeKernel.steer(sessionId, text);
  }

  /** Queue a user message to open the turn after the current one finishes. */
  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome {
    return this.runtimeKernel.queueMessage(sessionId, text);
  }

  /** Drain the followup queue into one `\n\n`-joined prompt, or null if empty. */
  drainFollowup(sessionId: string): string | null {
    return this.runtimeKernel.drainFollowup(sessionId);
  }

  /** Take back every queued message (both queues) as one `\n\n`-joined string. */
  retractQueue(sessionId: string): string {
    return this.runtimeKernel.retractQueue(sessionId);
  }

  async *regenerateTurn(
    sessionId: string,
    input: RegenerateTurnInput,
  ): AsyncIterable<SessionEvent> {
    const execution = this.runtimeKernel.claimExecution(sessionId);
    try {
      const source = await this.prepareRegenerateTurn(sessionId, input.sourceTurnId);
      yield* this.sendMessage(
        sessionId,
        {
          turnId: input.turnId ?? this.deps.newId(),
          ...source.content,
          parentTurnId: source.sourceTurnId,
          regeneratedFromTurnId: source.sourceTurnId,
        },
        { execution },
      );
    } finally {
      execution.release();
    }
  }

  async prepareRegenerateTurn(
    sessionId: string,
    sourceTurnId: string,
  ): Promise<RegenerateTurnSource> {
    const view = await this.getSessionView(sessionId);
    const source = view.turns.find((candidate) => candidate.turnId === sourceTurnId);
    if (!source) {
      throw new RuntimeRegenerateTurnError(
        'not_found',
        `Cannot regenerate unknown Turn ${sourceTurnId}`,
      );
    }
    if (
      source.status !== 'failed' &&
      source.status !== 'aborted' &&
      source.status !== 'completed'
    ) {
      throw new RuntimeRegenerateTurnError(
        'operation_conflict',
        `Cannot regenerate Turn ${sourceTurnId} while it is ${source.status}`,
      );
    }
    const user = view.messages.find(
      (message): message is UserMessage =>
        message.type === 'user' && message.turnId === sourceTurnId,
    );
    if (!user) {
      throw new RuntimeRegenerateTurnError(
        'operation_conflict',
        `Turn ${sourceTurnId} has no UserMessage`,
      );
    }
    return {
      sourceTurnId,
      content: normalizeMessageContent(user),
    };
  }

  async branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    const slice = createConversationCopySlice(sourceView.messages, input.sourceTurnId, 'through');
    if (!slice) throw new Error(`Cannot branch from unknown turn ${input.sourceTurnId}`);
    return this.createBranchSession(sessionId, sourceView, [...slice.messages], input);
  }

  /** Canonical, repaired source view for a Host-owned cross-Session copy. */
  async readConversationCopySnapshot(sessionId: string): Promise<RuntimeReadModelSessionView> {
    const readMessagesSnapshot = this.deps.store.readMessagesSnapshot;
    if (!readMessagesSnapshot) {
      throw new Error('Conversation copy requires a side-effect-free message snapshot');
    }
    const readMessages = readMessagesSnapshot.bind(this.deps.store);
    const view = await this.getSessionView(sessionId, { readMessages });
    if (view.runs.length > 0 || view.messages.length > 0) return view;
    const messages = await readMessages(sessionId);
    if (messages.length === 0) return view;
    return {
      ...view,
      messages,
      turns: deriveTurnRecords(messages),
    };
  }

  async branchBeforeTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    const slice = createConversationCopySlice(sourceView.messages, input.sourceTurnId, 'before');
    if (!slice) throw new Error(`Cannot branch before unknown turn ${input.sourceTurnId}`);
    return this.createBranchSession(sessionId, sourceView, [...slice.messages], input);
  }

  /**
   * Create a non-destructive edit-and-resend version. Unlike branchBeforeTurn,
   * this is not a new sidebar conversation: revision lineage lets hosts fold
   * every version into one conversation slot while keeping old transcripts.
   */
  async reviseBeforeTurn(sessionId: string, input: ReviseBeforeTurnInput): Promise<SessionSummary> {
    const sourceView = await this.getSessionView(sessionId);
    const slice = createConversationCopySlice(sourceView.messages, input.sourceTurnId, 'before');
    if (!slice) throw new Error(`Cannot revise before unknown turn ${input.sourceTurnId}`);
    return this.createRevisionSession(sessionId, sourceView, [...slice.messages], input);
  }

  private async createRevisionSession(
    sessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copied: StoredMessage[],
    input: ReviseBeforeTurnInput,
  ): Promise<SessionSummary> {
    const plan = await this.prepareConversationRuntimeLedgerClone(sessionId, sourceView, copied);
    const [header, boundary] = await Promise.all([
      this.deps.store.readHeader(sessionId),
      this.deps.store.readExecutionBoundary(sessionId),
    ]);
    const revisionRootSessionId = header.revisionRootSessionId ?? sessionId;
    const family = (await this.deps.store.list()).filter(
      (candidate) =>
        candidate.id === revisionRootSessionId ||
        candidate.revisionRootSessionId === revisionRootSessionId,
    );
    const revisionIndex =
      Math.max(1, ...family.map((candidate) => candidate.revisionIndex ?? 1)) + 1;
    const next = await this.deps.store.create(
      {
        cwd: header.cwd,
        ...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
        llmConnectionSlug: header.llmConnectionSlug,
        model: header.model,
        thinkingLevel: header.thinkingLevel,
        permissionMode: header.permissionMode,
        collaborationMode: header.collaborationMode,
        orchestrationMode: header.orchestrationMode ?? 'default',
        name: header.name,
        labels: header.labels,
        // A revision of a real branch remains in that branch's conversation
        // slot; revision lineage itself must not create a branch banner.
        parentSessionId: header.parentSessionId,
        branchOfTurnId: header.branchOfTurnId,
        revisionRootSessionId,
        revisionParentSessionId: sessionId,
        revisionOfTurnId: input.sourceTurnId,
        revisionIndex,
        revisionState: 'preparing',
        status: 'active',
      },
      boundary,
    );
    try {
      const rewritten = await this.cloneConversationRuntimeLedger(next.id, copied, plan);
      if (rewritten.length > 0) await this.deps.store.appendMessages(next.id, [...rewritten]);
      await this.deps.store.appendMessage(next.id, {
        type: 'system_note',
        id: this.deps.newId(),
        ts: this.deps.now(),
        kind: 'session_start',
        data: {
          revisionRootSessionId,
          revisionParentSessionId: sessionId,
          revisionOfTurnId: input.sourceTurnId,
          revisionIndex,
          revisionState: 'preparing',
        },
      });
      await this.deps.store.updateHeader(next.id, {
        isFlagged: header.isFlagged,
        titleIsManual: header.titleIsManual,
      });
      return headerToSummary(await this.deps.store.readHeader(next.id));
    } catch (error) {
      return this.rollbackLegacyConversationCopy(next.id, error);
    }
  }

  private async createBranchSession(
    sessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copied: StoredMessage[],
    input: BranchFromTurnInput,
  ): Promise<SessionSummary> {
    const plan = await this.prepareConversationRuntimeLedgerClone(sessionId, sourceView, copied);
    const [header, boundary] = await Promise.all([
      this.deps.store.readHeader(sessionId),
      this.deps.store.readExecutionBoundary(sessionId),
    ]);
    const next = await this.deps.store.create(
      {
        cwd: header.cwd,
        ...(header.projectId !== undefined ? { projectId: header.projectId } : {}),
        llmConnectionSlug: header.llmConnectionSlug,
        model: header.model,
        thinkingLevel: header.thinkingLevel,
        permissionMode: header.permissionMode,
        collaborationMode: header.collaborationMode,
        orchestrationMode: header.orchestrationMode ?? 'default',
        name: input.name ?? `${header.name} · 分支`,
        labels: input.sideConversation
          ? [...new Set([...header.labels, SIDE_CONVERSATION_SESSION_LABEL])]
          : header.labels,
        parentSessionId: sessionId,
        branchOfTurnId: input.sourceTurnId,
        status: 'active',
      },
      boundary,
    );
    try {
      const rewritten = await this.cloneConversationRuntimeLedger(next.id, copied, plan);
      if (rewritten.length > 0) await this.deps.store.appendMessages(next.id, [...rewritten]);
      await this.deps.store.appendMessage(next.id, {
        type: 'system_note',
        id: this.deps.newId(),
        ts: this.deps.now(),
        kind: 'session_start',
        data: { parentSessionId: sessionId, branchOfTurnId: input.sourceTurnId },
      });
      return headerToSummary(await this.deps.store.readHeader(next.id));
    } catch (error) {
      return this.rollbackLegacyConversationCopy(next.id, error);
    }
  }

  async respondToSandboxBoundary(
    sessionId: string,
    response: SandboxBoundaryResponse,
  ): Promise<void> {
    if (this.deps.interactionAuthority) {
      throw new RuntimeInteractionInvariantError(
        'Hosted permission answers must use the captured continuation',
      );
    }
    await this.runtimeKernel.respondToSandboxBoundary(sessionId, response);
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    if (this.deps.interactionAuthority) {
      throw new RuntimeInteractionInvariantError(
        'Hosted question answers must use the captured continuation',
      );
    }
    await this.runtimeKernel.respondToUserQuestion?.(sessionId, response);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async findRunByTurnId(
    sessionId: string,
    turnId: string,
  ): Promise<AgentRunHeader | undefined> {
    if (!this.deps.runStore) return undefined;
    const runs = await this.deps.runStore.listSessionRuns(sessionId).catch(() => []);
    const run = runs.find((candidate) => candidate.turnId === turnId);
    return run ? this.effectiveRunHeaderFromRuntimeLedger(run) : undefined;
  }

  private assertActiveParentRun(
    parentSessionId: string,
    parentRun: AgentRunHeader,
    parentTurnId: string,
  ): void {
    if (
      parentRun.sessionId !== parentSessionId ||
      parentRun.turnId !== parentTurnId ||
      !(
        this.runtimeKernel.hasActiveRun?.(parentSessionId, parentRun.runId, parentTurnId) ||
        this.deps.isParentRunActive?.(parentSessionId, parentRun.runId, parentTurnId)
      )
    ) {
      throw new Error('Child session parent run is not active');
    }
  }

  private async resolveShellRunOwner(
    firstParentSessionId: string,
    ref: string,
  ): Promise<{ sessionId: string; result: ShellRunUpdate['result'] } | undefined> {
    const shellRuns = this.deps.shellRuns;
    if (!shellRuns) return undefined;
    let ownerSessionId: string | undefined = firstParentSessionId;
    const visited = new Set<string>();
    while (ownerSessionId && !visited.has(ownerSessionId)) {
      visited.add(ownerSessionId);
      try {
        return {
          sessionId: ownerSessionId,
          result: await shellRuns.inspectResource(ownerSessionId, ref),
        };
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        try {
          const ownerHeader = await this.deps.store.readHeader(ownerSessionId);
          ownerSessionId = ownerHeader.revisionParentSessionId ?? ownerHeader.parentSessionId;
        } catch (headerError) {
          if (isNotFoundError(headerError)) return undefined;
          throw headerError;
        }
      }
    }
    return undefined;
  }

  private async readShellRunProjectionMessages(sessionId: string): Promise<StoredMessage[] | null> {
    try {
      return await this.getMessages(sessionId);
    } catch (error) {
      if (!(error instanceof RuntimeReadModelError)) throw error;
      // ShellRun hydration is a best-effort UI projection. A legacy RuntimeEvent
      // incompatibility must not turn its retry loop into a permanent IPC error.
      try {
        return await this.deps.store.readMessages(sessionId);
      } catch {
        return null;
      }
    }
  }

  private async findChildRunForOutput(
    sessionId: string,
    input: AgentOutputInput,
  ): Promise<{
    header: AgentRunHeader;
    execution: SubagentExecutionRef;
    graph?: NonNullable<SubagentSessionParent['graph']>;
  }> {
    if (Number(!!input.execution) + Number(!!input.runId) + Number(!!input.turnId) !== 1) {
      throw new Error('agent_output requires exactly one execution, runId, or turnId locator');
    }
    if (input.execution?.kind === 'child_session') {
      const execution = input.execution;
      const child = await this.deps.store.readHeader(execution.sessionId).catch((error) => {
        if (isNotFoundError(error)) return undefined;
        throw error;
      });
      if (
        !child ||
        child.subagentParent?.kind !== 'subagent' ||
        child.subagentParent.parentSessionId !== sessionId
      ) {
        throw new Error('agent_output could not find the requested child session');
      }
      const runs = await this.deps.runStore?.listSessionRuns(child.id);
      const selected = execution.currentRunId
        ? runs?.find((run) => run.runId === execution.currentRunId)
        : runs
            ?.slice()
            .sort(
              (left, right) =>
                right.createdAt - left.createdAt ||
                right.updatedAt - left.updatedAt ||
                right.runId.localeCompare(left.runId),
            )[0];
      if (!selected || !isSessionInlineRun(selected)) {
        throw new Error('agent_output could not find the requested child session run');
      }
      const header = await this.effectiveRunHeaderFromRuntimeLedger(selected);
      return {
        header,
        execution: {
          kind: 'child_session',
          sessionId: child.id,
          currentRunId: header.runId,
        },
        ...(child.subagentParent.graph ? { graph: child.subagentParent.graph } : {}),
      };
    }

    const legacyExecution =
      input.execution?.kind === 'legacy_child_run' ? input.execution : undefined;
    if (legacyExecution && legacyExecution.sessionId !== sessionId) {
      throw new Error('agent_output could not find the requested legacy child run');
    }
    const runs = await this.deps.runStore?.listSessionRuns(sessionId);
    const header = runs?.find((run) =>
      legacyExecution
        ? run.runId === legacyExecution.runId
        : input.runId
          ? run.runId === input.runId
          : input.turnId
            ? run.turnId === input.turnId
            : false,
    );
    if (!header) throw new Error('agent_output could not find the requested child agent run');
    if (!header.parentRunId || isSessionInlineRun(header)) {
      throw new Error('agent_output only reads child agent runs');
    }
    return {
      header: await this.effectiveRunHeaderFromRuntimeLedger(header),
      execution: {
        kind: 'legacy_child_run',
        sessionId,
        runId: header.runId,
      },
    };
  }

  private async effectiveRunHeaderFromRuntimeLedger(run: AgentRunHeader): Promise<AgentRunHeader> {
    if (!this.deps.runtimeEventStore) return run;
    const runtimeEvents = await this.deps.runtimeEventStore
      .readRuntimeEvents(run.sessionId, run.runId)
      .catch(() => undefined);
    if (!runtimeEvents) return run;
    const ledger = classifyTerminalRuntimeLedger(run, runtimeEvents);
    return ledger.kind === 'fact' ? effectiveRunHeaderFromTerminalFact(run, ledger.fact) : run;
  }

  private async updateStatus(
    sessionId: string,
    status: SessionStatus,
    blockedReason?: SessionBlockedReason,
    ts = this.deps.now(),
  ): Promise<void> {
    await this.updateHeader(sessionId, buildStatusPatch(status, ts, blockedReason));
  }

  private async updateHeader(sessionId: string, patch: SessionHeaderPatch): Promise<SessionHeader> {
    const next = await this.deps.store.updateHeader(sessionId, patch);
    this.runtimeKernel.updateCachedHeader(sessionId, next);
    return next;
  }

  private async isPlanOperationReplay(
    sessionId: string,
    operationId: string | undefined,
    operationInput: unknown,
  ): Promise<boolean> {
    if (!operationId) return false;
    return (
      (await this.requirePlanStore().readOperationReceipt(
        sessionId,
        operationId,
        operationInput,
      )) !== undefined
    );
  }

  private async finalizePlanCollaborationMode(
    sessionId: string,
    mode: CollaborationMode,
  ): Promise<void> {
    const header = await this.deps.store.readHeader(sessionId);
    const changed = (header.collaborationMode ?? 'agent') !== mode;
    const next = changed
      ? await this.deps.store.updateHeader(sessionId, { collaborationMode: mode })
      : header;
    this.runtimeKernel.updateCachedHeader(sessionId, next);
  }

  private async finalizePlanAbandonment(
    sessionId: string,
    operationId: string | undefined,
    replay: boolean,
  ): Promise<void> {
    const header = await this.deps.store.readHeader(sessionId);
    const from = header.collaborationMode ?? 'agent';
    const changed = from !== 'agent';
    const next = changed
      ? await this.deps.store.updateHeader(sessionId, { collaborationMode: 'agent' })
      : header;
    this.runtimeKernel.updateCachedHeader(sessionId, next);

    if (!changed && !replay) return;
    if (!operationId) {
      await this.deps.store.appendMessage(sessionId, {
        type: 'system_note',
        id: this.deps.newId(),
        ts: this.deps.now(),
        kind: 'mode_change',
        data: { dimension: 'collaboration', from, to: 'agent' },
      } satisfies SystemNoteMessage);
      return;
    }

    const noteId = planAbandonmentNoteId(operationId);
    const messages = await this.deps.store.readMessages(sessionId);
    if (messages.some((message) => message.id === noteId)) return;
    await this.deps.store.appendMessage(sessionId, {
      type: 'system_note',
      id: noteId,
      ts: this.deps.now(),
      kind: 'mode_change',
      data: { dimension: 'collaboration', from: 'plan', to: 'agent' },
    } satisfies SystemNoteMessage);
  }

  private requirePlanStore(): PlanStore {
    if (!this.deps.planStore) throw new Error('Plan Mode is unavailable on this surface');
    return this.deps.planStore;
  }

  private requireSessionConfigurationStore(): SessionStore &
    Required<Pick<SessionStore, 'readHeaderRecordSnapshot' | 'updateSessionConfiguration'>> {
    if (!this.deps.store.readHeaderRecordSnapshot || !this.deps.store.updateSessionConfiguration) {
      throw new SessionConfigurationTransitionError(
        'operation_unavailable',
        'Session configuration authority is unavailable',
      );
    }
    return this.deps.store as SessionStore &
      Required<Pick<SessionStore, 'readHeaderRecordSnapshot' | 'updateSessionConfiguration'>>;
  }

  private async assertCollaborationTransition(
    current: SessionHeader,
    nextMode: CollaborationMode,
  ): Promise<void> {
    if ((current.collaborationMode ?? 'agent') === nextMode) return;
    if (nextMode === 'plan' && current.subagentParent) {
      throw new SessionConfigurationTransitionError(
        'operation_unavailable',
        'Linked child Sessions cannot enter Plan mode',
      );
    }
    const planStore = this.deps.planStore;
    if (!planStore) {
      throw new SessionConfigurationTransitionError(
        'operation_unavailable',
        'Collaboration mode changes require Plan authority',
      );
    }
    const planState = await planStore.readState(current.id);
    if (nextMode === 'plan' && planState.activeExecutionId) {
      throw new SessionConfigurationTransitionError(
        'session_busy',
        'An active Plan execution prevents collaboration mode changes',
      );
    }
    const latestProposal = planState.proposals.find(
      (proposal) => proposal.proposalId === planState.latestProposalId,
    );
    if (nextMode === 'agent' && latestProposal?.status === 'pending_approval') {
      throw new SessionConfigurationTransitionError(
        'operation_conflict',
        'A pending Plan proposal must be resolved before leaving Plan mode',
      );
    }
  }

  private async appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage: AgentRunLineage = {},
    options: { ts?: number; errorClass?: string; abortSource?: string } = {},
  ): Promise<void> {
    const ts = options.ts ?? this.deps.now();
    await this.deps.store.appendMessage(
      sessionId,
      buildTurnStateMessage({
        id: this.deps.newId(),
        turnId,
        ts,
        status,
        lineage,
        ...(options.abortSource ? { abortSource: options.abortSource } : {}),
        ...(options.errorClass !== undefined ? { errorClass: options.errorClass } : {}),
        partialOutputRetained: await this.turnHasRetainedOutput(sessionId, turnId),
      }),
    );
  }

  private async turnHasRetainedOutput(sessionId: string, turnId: string): Promise<boolean> {
    const messages = await this.deps.store.readMessages(sessionId).catch(() => []);
    return messagesHaveRetainedOutput(messages, turnId);
  }

  private async requireTurnForAction(
    sessionId: string,
    turnId: string,
    allowed: readonly TurnRecord['status'][],
    action: string,
  ): Promise<TurnRecord> {
    const turn = (await this.getSessionView(sessionId)).turns.find(
      (candidate) => candidate.turnId === turnId,
    );
    if (!turn) throw new Error(`Cannot ${action}: unknown turn ${turnId}`);
    if (!allowed.includes(turn.status)) {
      throw new Error(`Cannot ${action}: turn ${turnId} is ${turn.status}`);
    }
    return turn;
  }

  private async getSessionView(
    sessionId: string,
    projectionCache: RuntimeReadModelProjectionCache = this.deps.store,
  ): Promise<RuntimeReadModelSessionView> {
    const repaired = new Set<string>();
    for (let attempt = 0; attempt < MAX_RUNTIME_LEDGER_REPAIR_ATTEMPTS; attempt += 1) {
      try {
        const view = await this.readModel(projectionCache).getSessionView(sessionId);
        const runId = firstRuntimeRepairRunId(view.diagnostics, repaired);
        if (!runId) return view;
        if (!(await this.repairMissingTerminalFactOnce(sessionId, runId))) return view;
        repaired.add(runId);
      } catch (error) {
        if (!(error instanceof RuntimeReadModelError)) throw error;
        const runId = firstRuntimeRepairRunId(error.diagnostics, repaired);
        if (!runId) throw error;
        if (!(await this.repairMissingTerminalFactOnce(sessionId, runId))) throw error;
        repaired.add(runId);
      }
    }
    return this.readModel(projectionCache).getSessionView(sessionId);
  }

  private readModel(
    projectionCache: RuntimeReadModelProjectionCache = this.deps.store,
  ): RuntimeReadModel {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('RuntimeReadModel requires AgentRunStore and RuntimeEventStore');
    }
    return new RuntimeReadModel({
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      projectionCache,
      ...(this.deps.canonicalPermissionOutcomes
        ? { canonicalPermissionOutcomes: this.deps.canonicalPermissionOutcomes }
        : {}),
    });
  }

  private async repairMissingTerminalFactOnce(sessionId: string, runId: string): Promise<boolean> {
    return (
      (await this.runtimeLedgerRepair?.repairMissingTerminalFactOnce(sessionId, runId)) ?? false
    );
  }

  async prepareImportedSessionHistory(sessionId: string): Promise<void> {
    const repair = this.runtimeLedgerRepair;
    if (!repair) throw new Error('Imported Session history requires canonical Runtime stores');
    await this.ensureTranscriptLedger(sessionId, repair, 'import');
  }

  private async ensureTranscriptLedger(
    sessionId: string,
    repair: RuntimeLedgerRepair,
    source: 'compatibility' | 'import',
  ): Promise<void> {
    if (this.preparedTranscriptLedgers.has(sessionId)) return;
    const header = await this.deps.store.readHeader(sessionId);
    if (header.transcriptLedgerVersion === 0 && source !== 'import') {
      throw new Error('Imported Session history is still being prepared');
    }
    if (header.transcriptLedgerVersion !== 1) {
      await repair.materializeTranscriptLedger(header);
      await this.updateHeader(sessionId, { transcriptLedgerVersion: 1 });
    }
    this.preparedTranscriptLedgers.add(sessionId);
  }

  private async prepareConversationRuntimeLedgerClone(
    sourceSessionId: string,
    sourceView: RuntimeReadModelSessionView,
    copiedMessages: readonly StoredMessage[],
  ): Promise<ConversationRuntimeLedgerCopyPlan | undefined> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return undefined;
    return prepareConversationRuntimeLedgerCopy({
      sourceSessionId,
      sourceEvents: sourceView.events,
      copiedMessages,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
    });
  }

  private async cloneConversationRuntimeLedger(
    childSessionId: string,
    copiedMessages: readonly StoredMessage[],
    plan: ConversationRuntimeLedgerCopyPlan | undefined,
  ): Promise<readonly StoredMessage[]> {
    if (!plan || !this.deps.runStore || !this.deps.runtimeEventStore) return copiedMessages;
    const copied = await cloneConversationLedger({
      plan,
      copiedMessages,
      referenceMap: {
        mode: 'preserve_external',
        sourceSessionId: plan.sourceSessionId,
        targetSessionId: childSessionId,
      },
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      newId: this.deps.newId,
    });
    return copied.copiedMessages;
  }

  private async rollbackLegacyConversationCopy(sessionId: string, error: unknown): Promise<never> {
    try {
      await this.deps.store.remove(sessionId);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Conversation copy ${sessionId} failed and could not be removed`,
      );
    }
    throw error;
  }

  /**
   * Closes only the two provably pre-provider crash windows owned by B2:
   * claim-only and target-Run-created-without-start. A repaired claim never
   * dispatches a provider. It first materializes the exact target header
   * committed in the claim, commits a deterministic continuation-start as
   * event 1, then records an auditable failed terminal fact.
   *
   * A start written by the normal admission path is provider T1. Without an
   * exclusive cross-process owner proof we cannot know that its provider is
   * dead, so that state remains `continuation_started_indeterminate` and is
   * deliberately left non-terminal.
   */
  private async recoverContinuationClaimsBeforeProvider(
    sessionId: string,
    authority: RuntimeContinuationAuthorityStore,
    _policy: RecoveryPolicy,
  ): Promise<boolean> {
    if (!this.deps.runStore) return false;
    const states = await authority.listContinuationClaimsForRecovery(sessionId);
    let recovered = false;
    for (const initialState of states) {
      const { claim } = initialState;
      let run: AgentRunHeader;
      try {
        run = await this.deps.runStore.readRun(sessionId, claim.target.runId);
      } catch (error) {
        if (!isMissingRunError(error)) throw error;
        try {
          await this.deps.runStore.createRun(claim.targetRunHeader, { durable: true });
          run = await this.deps.runStore.readRun(sessionId, claim.target.runId);
        } catch (createError) {
          try {
            run = await this.deps.runStore.readRun(sessionId, claim.target.runId);
          } catch {
            throw createError;
          }
        }
        recovered = true;
      }
      let state =
        (await authority.readContinuationClaimStateByBoundary(claim.boundaryDigest)) ??
        initialState;
      if (
        state.startEventId
          ? !claimTargetRunHeaderIsCompatible(run, claim.targetRunHeader)
          : !isDeepStrictEqual(run, claim.targetRunHeader)
      ) {
        throw new Error(
          `Continuation claim target Run header conflicts with claim ${claim.claimId}`,
        );
      }

      let targetEvents = await readImmutableRuntimeEventsOrEmpty(
        authority,
        claim.target.sessionId,
        claim.target.runId,
      );
      if (!state.startEventId) {
        if (targetEvents.length > 0) {
          throw new Error(
            `Continuation claim ${claim.claimId} has target events without continuation-start`,
          );
        }
        const repairStart = buildContinuationRepairStartEvent(claim);
        await authority.commitContinuationRepairStart({ claim, event: repairStart });
        state =
          (await authority.readContinuationClaimStateByBoundary(claim.boundaryDigest)) ??
          (() => {
            throw new Error(`Continuation claim ${claim.claimId} disappeared during repair`);
          })();
        targetEvents = await readImmutableRuntimeEventsOrEmpty(
          authority,
          claim.target.sessionId,
          claim.target.runId,
        );
        recovered = true;
      }

      const start = targetEvents[0];
      if (!start || start.id !== state.startEventId) {
        throw new Error(`Continuation claim ${claim.claimId} has an invalid start boundary`);
      }
      const repairedBeforeProvider = state.startKind === 'claim_repair';
      if (!repairedBeforeProvider) continue;
      const failureClass = 'continuation_abandoned_before_provider_dispatch';
      const expectedTerminal = buildRecoveredTerminalRuntimeEvent({
        id: continuationRepairEventId('terminal', claim.claimId),
        run,
        status: 'failed',
        ts: Math.max(start.ts + 1, claim.claimedAt + 1),
        recoveryReason: failureClass,
        invocationId: claim.target.invocationId,
        failureClass,
        message: failureClass,
      });
      const terminal = targetEvents.find(isTerminalRuntimeEvent);
      if (terminal && !isDeepStrictEqual(terminal, expectedTerminal)) {
        throw new Error(`Continuation claim ${claim.claimId} has a conflicting repair terminal`);
      }
      const existingRunEvents = await this.deps.runStore.readEvents(
        claim.target.sessionId,
        claim.target.runId,
      );
      const projectionComplete =
        terminal !== undefined &&
        run.status === 'failed' &&
        run.failureClass === failureClass &&
        existingRunEvents.some((event) => event.type === 'run_failed');
      if (projectionComplete) continue;
      await commitTerminalRunWithRuntimeFact({
        runStore: this.deps.runStore,
        runtimeEventStore: authority,
        newId: () => continuationRepairEventId('run-terminal', claim.claimId),
        sessionId: claim.target.sessionId,
        runId: claim.target.runId,
        turnId: claim.target.turnId,
        status: 'failed',
        ts: expectedTerminal.ts,
        terminalEvent: expectedTerminal,
        failureClass,
        runEventData: {
          recovered: true,
          recoveryReason: failureClass,
          continuationClaimId: claim.claimId,
        },
        existingEvents: existingRunEvents,
      });
      recovered = true;
    }
    return recovered;
  }

  private async recoverAgentRunsFromLedger(
    sessionId: string,
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<{ hasLedger: boolean; recovered: boolean }> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore)
      return { hasLedger: false, recovered: false };
    const runs =
      policy.kind === 'strict'
        ? await policy.stores.agentRunStore.listSessionRunsForRecovery(sessionId)
        : await this.deps.runStore.listSessionRuns(sessionId);
    if (runs.length === 0) return { hasLedger: false, recovered: false };
    const continuationAuthority = runtimeContinuationAuthority(this.deps.runtimeEventStore);
    const claimOwnedUnsettledRunIds = new Set<string>();
    if (continuationAuthority) {
      for (const state of await continuationAuthority.listContinuationClaimsForRecovery(
        sessionId,
      )) {
        const events = await continuationAuthority.readImmutableRuntimeEvents(
          state.claim.target.sessionId,
          state.claim.target.runId,
        );
        if (!events.some(isTerminalRuntimeEvent)) {
          claimOwnedUnsettledRunIds.add(state.claim.target.runId);
        }
      }
    }

    // Read once per recovered session, and only when a failure actually needs
    // attributing, so healthy sessions pay nothing for the query.
    let boundaryClosures: readonly SandboxBoundaryRequest[] | undefined;
    const readBoundaryClosures = async (): Promise<readonly SandboxBoundaryRequest[]> => {
      if (!boundaryClosures) {
        boundaryClosures = this.deps.store.listSandboxBoundaryRestartClosures
          ? await recoverOr(
              policy,
              () => this.deps.store.listSandboxBoundaryRestartClosures!(sessionId),
              [],
            )
          : [];
      }
      return boundaryClosures;
    };

    let recovered = false;
    for (const run of runs) {
      if (policy.kind === 'strict') {
        await policy.stores.agentRunStore.readEventsForRecovery(sessionId, run.runId);
      }
      let inspected = await inspectAgentRunReadModel(
        this.deps.runStore,
        this.deps.runtimeEventStore,
        { sessionId, runId: run.runId, header: run },
      );
      if (inspected.sourceHealth.runtimeLedger === 'read_failed') {
        if (policy.kind === 'strict') {
          throw new Error(`RuntimeEvent ledger is unreadable for run ${run.runId}`);
        }
        continue;
      }
      if (
        policy.kind === 'strict' &&
        inspected.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'operational_ledger_read_failed' ||
            diagnostic.code === 'operational_event_corrupt',
        )
      ) {
        throw new Error(`AgentRun event ledger is unreadable for run ${run.runId}`);
      }
      if (
        claimOwnedUnsettledRunIds.has(run.runId) &&
        !inspected.runtimeEvents.some(isTerminalRuntimeEvent)
      ) {
        // Every unresolved claim target belongs to the claim saga. This
        // includes claim-only, deterministic repair-start, and live provider
        // T1 states; generic app-restart repair must never write into them.
        continue;
      }
      if (this.runtimeCommitSink) {
        const interruptedOutcomes = buildInterruptedCodeModeOutcomeCommits(
          inspected.runtimeEvents,
          this.deps.now(),
          run.toolMode ?? DEFAULT_TOOL_MODE,
        );
        let outcomeCommitFailed = false;
        for (const outcome of interruptedOutcomes) {
          const committed = await commitInterruptedOutcomeWithRetry(policy, () =>
            this.runtimeCommitSink!.commitToolOutcome(outcome),
          );
          if (!committed) {
            // Keep the run non-terminal so a later recovery pass can retry the
            // missing outcome before any terminal repair seals the ledger.
            outcomeCommitFailed = true;
          } else {
            recovered ||= committed.created;
          }
        }
        if (outcomeCommitFailed) {
          continue;
        }
        if (interruptedOutcomes.length > 0) {
          inspected = await inspectAgentRunReadModel(
            this.deps.runStore,
            this.deps.runtimeEventStore,
            { sessionId, runId: run.runId, header: run },
          );
        }
      }
      const terminalLedger = classifyTerminalRuntimeLedger(run, inspected.runtimeEvents);
      if (terminalLedger.kind === 'ambiguous') {
        if (policy.kind === 'strict') {
          throw new Error(`RuntimeEvent ledger has ambiguous terminal facts for run ${run.runId}`);
        }
        continue;
      }
      if (isTerminalRunStatus(run.status) && !inspected.terminalRuntimeFact) {
        const repaired = await this.repairMissingTerminalFactOnce(sessionId, run.runId);
        if (repaired) {
          recovered = true;
        } else if (policy.kind === 'strict') {
          throw new Error(`Unable to repair the terminal RuntimeEvent fact for run ${run.runId}`);
        }
        continue;
      }
      const runtimeDecision = this.classifyRuntimeEventRecovery(inspected);
      const classified = runtimeDecision ?? classifyAgentRunRecovery(run, inspected.events);
      if (!classified) continue;
      const decision =
        classified.status === 'failed'
          ? attributeSandboxBoundaryRestartClosure(classified, await readBoundaryClosures())
          : classified;
      if (await this.applyAgentRunRecovery(sessionId, decision, inspected, policy)) {
        recovered = true;
      }
    }
    return { hasLedger: true, recovered };
  }

  private classifyRuntimeEventRecovery(
    inspected: AgentRunInspectModel,
  ): AgentRunRecoveryDecision | undefined {
    if (isTerminalRunStatus(inspected.header.status) || !inspected.terminalRuntimeFact)
      return undefined;
    return runtimeTerminalFactToRecoveryDecision(inspected.header, inspected.terminalRuntimeFact);
  }

  private async applyAgentRunRecovery(
    sessionId: string,
    decision: AgentRunRecoveryDecision,
    inspected: AgentRunInspectModel,
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<boolean> {
    if (!this.deps.runStore || !this.deps.runtimeEventStore) return false;
    const ts = this.deps.now();
    const terminalLedger = classifyTerminalRuntimeLedger(inspected.header, inspected.runtimeEvents);
    const existingTerminal =
      inspected.terminalRuntimeFact?.terminalEvent ??
      (terminalLedger.kind === 'incomplete_single_terminal'
        ? terminalLedger.terminalEvent
        : undefined);
    const status = existingTerminal
      ? (terminalRunStatusFromRuntimeEvent(existingTerminal) ?? decision.status)
      : decision.status;
    const failureClass =
      status === 'failed' ? (decision.failureClass ?? 'app_restarted') : undefined;
    const abortSource = status === 'cancelled' ? (decision.abortSource ?? 'unknown') : undefined;
    const terminalEvent =
      existingTerminal ??
      buildRecoveredTerminalRuntimeEvent({
        id: this.deps.newId(),
        run: inspected.header,
        status,
        ts,
        recoveryReason: diagnosticRecoveryReason(decision.diagnostic),
        ...(inspected.runtimeEvents[0]?.invocationId
          ? { invocationId: inspected.runtimeEvents[0].invocationId }
          : {}),
        ...(failureClass ? { failureClass, message: failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        ...(decision.diagnostic ? { diagnostic: decision.diagnostic } : {}),
      });
    try {
      await commitTerminalRunWithRuntimeFact({
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        newId: this.deps.newId,
        sessionId,
        runId: decision.runId,
        turnId: decision.turnId,
        status,
        ts,
        terminalEvent,
        ...(failureClass ? { failureClass } : {}),
        ...(abortSource ? { abortSource } : {}),
        runEventData: { recovered: true, ...decision.diagnostic },
        existingEvents: inspected.events,
      });
    } catch (error) {
      if (policy.kind === 'strict') throw error;
      return false;
    }

    await recoverOr(
      policy,
      () =>
        this.appendTerminalTurnStateIfNeeded(
          sessionId,
          inspected.header,
          decision,
          terminalTurnStatus(status),
          {
            ts,
            ...(failureClass ? { errorClass: failureClass } : {}),
            ...(abortSource ? { abortSource } : {}),
          },
          policy,
        ),
      undefined,
    );
    return true;
  }

  private async appendTerminalTurnStateIfNeeded(
    sessionId: string,
    run: AgentRunHeader,
    decision: AgentRunRecoveryDecision,
    status: TurnRecord['status'],
    options: { ts: number; errorClass?: string; abortSource?: string },
    policy: RecoveryPolicy = { kind: 'best_effort' },
  ): Promise<void> {
    if (!isSessionInlineRun(run)) return;
    const messages = await recoverOr(
      policy,
      () => this.deps.store.readMessages(sessionId),
      [] as StoredMessage[],
    );
    const latest = latestTurnState(messages, decision.turnId);
    if (latest && isTerminalTurnStatus(latest.status) && latest.status === status) return;
    await this.appendTurnState(sessionId, decision.turnId, status, decision.lineage, options);
  }
}

function planAbandonmentNoteId(operationId: string): string {
  return `plan-abandonment-${createHash('sha256').update(operationId).digest('hex')}`;
}

function resumeFeatureDisabledPlan(): SafeBoundaryContinuationPlan {
  return {
    disposition: 'park',
    rejectionReasons: ['resume_feature_disabled'],
    diagnostics: [
      {
        code: 'resume_feature_disabled',
        message: 'safe-boundary resume is disabled by the host feature flag',
      },
    ],
  };
}

function continuationExecutionErrorClass(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as Error & { code?: unknown }).code === 'string'
  ) {
    return (error as Error & { code: string }).code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

type RecoveryPolicy = { kind: 'best_effort' } | { kind: 'strict'; stores: StrictRecoveryStores };

const MAX_BEST_EFFORT_OUTCOME_COMMIT_ATTEMPTS = 2;

function listSessionsForRecovery(
  store: SessionStore,
  policy: RecoveryPolicy,
): Promise<Array<SessionHeader | SessionSummary>> {
  return policy.kind === 'strict' ? policy.stores.sessionStore.listForRecovery() : store.list();
}

async function recoverOr<T>(
  policy: RecoveryPolicy,
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (policy.kind === 'strict') throw error;
    return fallback;
  }
}

async function commitInterruptedOutcomeWithRetry(
  policy: RecoveryPolicy,
  operation: () => Promise<RuntimeCommitResult>,
): Promise<RuntimeCommitResult | undefined> {
  const attempts = policy.kind === 'strict' ? 1 : MAX_BEST_EFFORT_OUTCOME_COMMIT_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (policy.kind === 'strict') throw error;
    }
  }
  return undefined;
}

function continuationRepairEventId(
  kind: 'start' | 'terminal' | 'run-terminal',
  claimId: string,
): string {
  return `continuation-repair-${kind}-${createHash('sha256')
    .update(`maka.continuation-repair.${kind}.v1\0${claimId}`)
    .digest('hex')
    .slice(0, 32)}`;
}

function buildContinuationRepairStartEvent(claim: ContinuationClaimV1): RuntimeEvent {
  const source = claim.boundary.segments.at(-1)!;
  return {
    id: continuationRepairEventId('start', claim.claimId),
    ...claim.target,
    ts: claim.claimedAt,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      continuationStart: {
        protocol: 'continuation_start_v2',
        provenance: 'claim_repair',
        claimId: claim.claimId,
        boundaryDigest: claim.boundaryDigest,
        immediateSource: {
          sessionId: source.identity.sessionId,
          invocationId: source.identity.invocationId,
          runId: source.identity.runId,
          turnId: source.identity.turnId,
          highWater: source.position.lastEventSeq,
          prefixDigest: source.prefixDigest,
        },
        replayManifestDigest: claim.boundary.manifestDigest,
        providerProjectionVersion: claim.providerProjectionVersion,
        providerReplayDigest: claim.providerReplayDigest,
      },
    },
  };
}

function assertClaimOwnsHostedLinkedChildAdmission(
  input: {
    sessionId: string;
    turnId: string;
    runId: string;
    execution: Exclude<RootExecutionDescriptor, { kind: 'external_message' }>;
  },
  claim: ContinuationClaimV1,
): void {
  if (
    input.execution.kind !== 'linked_child_resume' &&
    input.execution.kind !== 'linked_child_provider_retry'
  ) {
    throw new Error('Only linked child retry or resume admission can use a continuation claim');
  }
  if (
    claim.target.sessionId !== input.sessionId ||
    claim.target.runId !== input.runId ||
    claim.target.turnId !== input.turnId
  ) {
    throw new Error('Linked child admission conflicts with its continuation claim target');
  }
  const header = claim.targetRunHeader;
  const source = claim.boundary.segments.at(-1)!;
  const continuationSource = header.continuationSource;
  const continuationSourceV2 =
    continuationSource !== undefined &&
    'protocol' in continuationSource &&
    continuationSource.protocol === 'continuation_source_v2'
      ? continuationSource
      : undefined;
  if (
    header.sessionId !== claim.target.sessionId ||
    header.invocationId !== claim.target.invocationId ||
    header.runId !== claim.target.runId ||
    header.turnId !== claim.target.turnId ||
    header.status !== 'created' ||
    header.agentId !== input.execution.agentId ||
    header.agentName !== input.execution.agentName ||
    source.identity.sessionId !== input.sessionId ||
    source.identity.runId !== input.execution.sourceRunId ||
    !continuationSourceV2 ||
    continuationSourceV2.claimId !== claim.claimId ||
    continuationSourceV2.boundaryDigest !== claim.boundaryDigest ||
    continuationSourceV2.sourceRunId !== input.execution.sourceRunId
  ) {
    throw new Error('Linked child admission continuation claim identity is inconsistent');
  }
  if (
    input.execution.kind === 'linked_child_resume'
      ? header.resumedFromRunId !== input.execution.sourceRunId ||
        header.retriedFromRunId !== undefined
      : header.retriedFromRunId !== input.execution.sourceRunId ||
        header.resumedFromRunId !== undefined
  ) {
    throw new Error('Linked child admission continuation lineage is inconsistent');
  }
}

async function isProvenRecoveredContinuationAbandonment(
  authority: RuntimeContinuationAuthorityStore | undefined,
  run: AgentRunHeader,
): Promise<boolean> {
  const continuationSource = run.continuationSource;
  const continuationSourceV2 =
    continuationSource !== undefined &&
    'protocol' in continuationSource &&
    continuationSource.protocol === 'continuation_source_v2'
      ? continuationSource
      : undefined;
  if (
    !authority ||
    !continuationSourceV2 ||
    run.failureClass !== 'continuation_abandoned_before_provider_dispatch'
  ) {
    return false;
  }
  let state: ContinuationClaimStateV1 | undefined;
  let events: RuntimeEvent[];
  try {
    state = await authority.readContinuationClaimStateByBoundary(
      continuationSourceV2.boundaryDigest,
    );
    events = await authority.readImmutableRuntimeEvents(run.sessionId, run.runId);
  } catch {
    return false;
  }
  if (!state) return false;
  const { claim } = state;
  const expectedStart = buildContinuationRepairStartEvent(claim);
  const expectedTerminal = buildRecoveredTerminalRuntimeEvent({
    id: continuationRepairEventId('terminal', claim.claimId),
    run: claim.targetRunHeader,
    status: 'failed',
    ts: Math.max(expectedStart.ts + 1, claim.claimedAt + 1),
    recoveryReason: 'continuation_abandoned_before_provider_dispatch',
    invocationId: claim.target.invocationId,
    failureClass: 'continuation_abandoned_before_provider_dispatch',
    message: 'continuation_abandoned_before_provider_dispatch',
  });
  const terminalFact = classifyRuntimeEventTerminalFact(run, events).fact;
  return (
    claim.claimId === continuationSourceV2.claimId &&
    claim.target.sessionId === run.sessionId &&
    claim.target.invocationId === run.invocationId &&
    claim.target.runId === run.runId &&
    claim.target.turnId === run.turnId &&
    claimTargetRunHeaderIsCompatible(run, claim.targetRunHeader) &&
    state.startEventId === expectedStart.id &&
    events.length === 2 &&
    isDeepStrictEqual(events[0], expectedStart) &&
    isDeepStrictEqual(events[1], expectedTerminal) &&
    terminalFact?.terminalEvent.id === expectedTerminal.id &&
    terminalRunHeaderMatchesFact(run, terminalFact)
  );
}

async function readImmutableRuntimeEventsOrEmpty(
  authority: RuntimeContinuationAuthorityStore,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent[]> {
  return authority.readImmutableRuntimeEvents(sessionId, runId);
}

function claimTargetRunHeaderIsCompatible(
  actual: AgentRunHeader,
  expected: AgentRunHeader,
): boolean {
  const immutable = (header: AgentRunHeader) => {
    const {
      status: _status,
      updatedAt: _updatedAt,
      completedAt: _completedAt,
      failureClass: _failureClass,
      failureMessage: _failureMessage,
      abortSource: _abortSource,
      traceWriteError: _traceWriteError,
      ...rest
    } = header;
    return rest;
  };
  return isDeepStrictEqual(immutable(actual), immutable(expected));
}

function isMissingRunError(error: unknown): boolean {
  return (
    isNotFoundError(error) ||
    (error instanceof Error && /unknown run|run does not exist|missing run/i.test(error.message))
  );
}

// ============================================================================
// Helpers
// ============================================================================

export function headerToSummary(h: SessionHeader): SessionSummary {
  const summary: SessionSummary = {
    id: h.id,
    cwd: h.cwd,
    ...(h.projectId !== undefined ? { projectId: h.projectId } : {}),
    name: h.name === 'New Session' ? DEFAULT_SESSION_NAME : h.name,
    isFlagged: h.isFlagged,
    isArchived: h.isArchived,
    labels: h.labels,
    hasUnread: h.hasUnread,
    status: h.status,
    ...(h.blockedReason ? { blockedReason: h.blockedReason } : {}),
    ...(h.statusUpdatedAt !== undefined ? { statusUpdatedAt: h.statusUpdatedAt } : {}),
    ...(h.parentSessionId ? { parentSessionId: h.parentSessionId } : {}),
    ...(h.branchOfTurnId ? { branchOfTurnId: h.branchOfTurnId } : {}),
    ...(h.subagentParent ? { subagentParent: h.subagentParent } : {}),
    ...(h.subagentRuntime
      ? { subagentRuntime: subagentSessionRuntimeSummary(h.subagentRuntime) }
      : {}),
    ...(h.subagentWorkspace ? { subagentWorkspace: h.subagentWorkspace } : {}),
    ...(h.revisionRootSessionId ? { revisionRootSessionId: h.revisionRootSessionId } : {}),
    ...(h.revisionParentSessionId ? { revisionParentSessionId: h.revisionParentSessionId } : {}),
    ...(h.revisionOfTurnId ? { revisionOfTurnId: h.revisionOfTurnId } : {}),
    ...(h.revisionIndex !== undefined ? { revisionIndex: h.revisionIndex } : {}),
    ...(h.revisionState ? { revisionState: h.revisionState } : {}),
    backend: h.backend,
    llmConnectionSlug: h.llmConnectionSlug,
    connectionLocked: h.connectionLocked,
    model: h.model,
    permissionMode: h.permissionMode ?? 'ask',
    collaborationMode: h.collaborationMode ?? 'agent',
    orchestrationMode: h.orchestrationMode ?? 'default',
  };
  if (h.thinkingLevel !== undefined) summary.thinkingLevel = h.thinkingLevel;
  if (h.lastMessageAt !== undefined) {
    summary.lastMessageAt = h.lastMessageAt;
  }
  return summary;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function sameSubagentWorkspace(
  left: SubagentWorkspaceBinding | undefined,
  right: SubagentWorkspaceBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.leaseId === right.leaseId &&
    left.gitCommonDir === right.gitCommonDir &&
    left.worktreePath === right.worktreePath &&
    left.branch === right.branch &&
    left.baseCommit === right.baseCommit
  );
}

function childSessionSpawnKey(
  parentSessionId: string,
  input: Pick<SpawnChildSessionInput, 'spawnedBy' | 'swarm'>,
): string {
  return JSON.stringify([
    1,
    parentSessionId,
    input.spawnedBy.parentRunId,
    input.spawnedBy.toolCallId,
    input.swarm?.swarmId ?? null,
    input.swarm?.itemId ?? null,
  ]);
}

function childSessionRequestFingerprint(
  parentSessionId: string,
  input: Pick<
    ResolvedSpawnChildSessionInput,
    'spawnedBy' | 'agentProfile' | 'prompt' | 'swarm' | 'resolvedPreset'
  >,
): string {
  const payload = input.resolvedPreset
    ? [
        2,
        parentSessionId,
        input.spawnedBy.parentRunId,
        input.spawnedBy.parentTurnId,
        input.spawnedBy.toolCallId,
        input.agentProfile,
        input.resolvedPreset,
        input.prompt,
        input.swarm?.swarmId ?? null,
        input.swarm?.itemId ?? null,
      ]
    : [
        1,
        parentSessionId,
        input.spawnedBy.parentRunId,
        input.spawnedBy.parentTurnId,
        input.spawnedBy.toolCallId,
        input.agentProfile,
        input.prompt,
        input.swarm?.swarmId ?? null,
        input.swarm?.itemId ?? null,
      ];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function claimedAgentGraphIntentRequestFingerprint(
  input: Pick<ResolvedClaimedAgentGraphIntentInput, 'claim' | 'prompt'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([1, input.claim, input.prompt]))
    .digest('hex');
}

function assertAgentGraphIntentExecutionMatchesClaim(
  claim: AgentGraphIntentClaim,
  intent: AgentGraphRunnableIntent,
  prompt: string,
): void {
  if (
    intent.graphId !== claim.graphId ||
    intent.intentId !== claim.intentId ||
    intent.readinessContextFingerprint !== claim.readinessContextFingerprint ||
    intent.operatorId !== claim.targetOperatorId ||
    intent.targetSessionId !== claim.targetSessionId ||
    fingerprintAgentGraphRunnableIntent({
      intent,
      executionInput: { prompt },
    }) !== claim.intentFingerprint
  ) {
    throw new Error('Claimed graph intent execution does not match its durable claim');
  }
}

function claimedAgentGraphIntentResult(
  claim: AgentGraphIntentClaim,
  result: SpawnChildSessionResult,
): ClaimedAgentGraphIntentResult {
  return {
    claimId: claim.claimId,
    graphId: claim.graphId,
    intentId: claim.intentId,
    operatorId: claim.targetOperatorId,
    ...result,
  };
}

function executionBoundaryMatchesPermissionMode(
  boundary: ExecutionBoundary,
  mode: PermissionMode,
): boolean {
  if (mode === 'bypass') return boundary.kind === 'bypass';
  if (boundary.kind !== 'managed') return false;
  return mode === 'explore'
    ? boundary.profile.name === 'read-only'
    : boundary.profile.name !== 'read-only';
}

function narrowsExecutionAuthority(
  boundary: ExecutionBoundary,
  nextPermissionMode: PermissionMode,
): boolean {
  if (nextPermissionMode === 'bypass') return false;
  if (boundary.kind !== 'managed') return true;
  return nextPermissionMode === 'explore' && boundary.profile.name !== 'read-only';
}

function agentRunStatusForSpawnResult(
  status: AgentRunHeader['status'],
): SpawnChildAgentResult['status'] {
  if (status === 'waiting_for_user') return 'waiting_for_user';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  if (status === 'running' || status === 'created') return 'running';
  return 'completed';
}

function isUnsafeChildResumeDiagnostic(code: string): boolean {
  return (
    code === 'unmatched_tool_call' ||
    code === 'unmatched_tool_result' ||
    code === 'tool_id_mismatch' ||
    code === 'unsupported_role' ||
    code === 'unsupported_content'
  );
}

function trimSummary(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= CHILD_AGENT_SUMMARY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, CHILD_AGENT_SUMMARY_MAX_CHARS - 1)}…`;
}

class ChildAgentSummaryAccumulator {
  eventCount = 0;
  failureClass: string | undefined;
  private terminalStatus: SpawnChildAgentResult['status'] | undefined;
  private lastTextComplete = '';
  private textDeltaTail = '';
  private textDeltaTruncated = false;
  private lastError = '';

  add(event: SessionEvent): void {
    this.eventCount += 1;
    switch (event.type) {
      case 'text_complete':
        this.lastTextComplete = trimSummary(event.text);
        break;
      case 'text_delta':
        this.appendTextDelta(event.text);
        break;
      case 'error':
        this.terminalStatus = 'failed';
        this.lastError = trimSummary(event.message);
        break;
      case 'abort':
        this.terminalStatus = 'cancelled';
        break;
      case 'complete':
        this.failureClass = failureClassFromCompleteStopReason(event.stopReason);
        if (this.failureClass) this.terminalStatus = 'failed';
        else if (event.stopReason === 'user_stop') this.terminalStatus = 'cancelled';
        else this.terminalStatus = 'completed';
        break;
    }
  }

  status(aborted: boolean): SpawnChildAgentResult['status'] {
    if (aborted) return 'cancelled';
    return this.terminalStatus ?? 'running';
  }

  text(): string {
    if (this.lastTextComplete.trim()) return this.lastTextComplete;
    if (this.textDeltaTail.trim()) {
      return this.textDeltaTruncated
        ? `…${this.textDeltaTail.slice(1)}`
        : this.textDeltaTail.trim();
    }
    return this.lastError;
  }

  private appendTextDelta(text: string): void {
    this.textDeltaTail += text;
    if (this.textDeltaTail.length <= CHILD_AGENT_SUMMARY_MAX_CHARS) return;
    this.textDeltaTruncated = true;
    this.textDeltaTail = this.textDeltaTail.slice(-CHILD_AGENT_SUMMARY_MAX_CHARS);
  }
}

interface InterruptedTurnRecovery {
  turnId: string;
  errorClass: string;
  lineage: Partial<
    Pick<
      UserMessageInput,
      | 'parentTurnId'
      | 'retriedFromTurnId'
      | 'regeneratedFromTurnId'
      | 'branchOfTurnId'
      | 'parentSessionId'
    >
  >;
}

function hasRevisionUserMessage(messages: readonly StoredMessage[]): boolean {
  let boundary = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.type === 'system_note' &&
      message.kind === 'session_start' &&
      message.data &&
      typeof message.data === 'object' &&
      'revisionRootSessionId' in message.data
    ) {
      boundary = index;
    }
  }
  return boundary >= 0 && messages.slice(boundary + 1).some((message) => message.type === 'user');
}

function interruptedTurnRecoveries(messages: readonly StoredMessage[]): InterruptedTurnRecovery[] {
  const byTurn = new Map<
    string,
    {
      hasAssistant: boolean;
      states: Array<Extract<StoredMessage, { type: 'turn_state' }>>;
    }
  >();
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId;
    if (!turnId) continue;
    const bucket = byTurn.get(turnId) ?? { hasAssistant: false, states: [] };
    if (message.type === 'assistant') bucket.hasAssistant = true;
    if (message.type === 'turn_state') bucket.states.push(message);
    byTurn.set(turnId, bucket);
  }

  const recoveries: InterruptedTurnRecovery[] = [];
  for (const [turnId, bucket] of byTurn) {
    const latest = bucket.states.at(-1);
    if (!latest) continue;
    if (latest.status === 'running') {
      recoveries.push({
        turnId,
        errorClass: 'app_restarted',
        lineage: turnStateLineage(latest),
      });
      continue;
    }
    const failed = [...bucket.states].reverse().find((state) => state.status === 'failed');
    if (latest.status === 'completed' && !bucket.hasAssistant && failed) {
      recoveries.push({
        turnId,
        errorClass: failed.errorClass ?? 'unknown',
        lineage: turnStateLineage(failed),
      });
    }
  }
  return recoveries;
}

function turnStateLineage(
  state: Extract<StoredMessage, { type: 'turn_state' }>,
): Partial<
  Pick<
    UserMessageInput,
    | 'parentTurnId'
    | 'retriedFromTurnId'
    | 'regeneratedFromTurnId'
    | 'branchOfTurnId'
    | 'parentSessionId'
  >
> {
  return {
    ...(state.parentTurnId ? { parentTurnId: state.parentTurnId } : {}),
    ...(state.retriedFromTurnId ? { retriedFromTurnId: state.retriedFromTurnId } : {}),
    ...(state.regeneratedFromTurnId ? { regeneratedFromTurnId: state.regeneratedFromTurnId } : {}),
    ...(state.branchOfTurnId ? { branchOfTurnId: state.branchOfTurnId } : {}),
    ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}),
  };
}

function isTerminalRunStatus(status: AgentRunHeader['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalTurnStatus(status: TurnRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted';
}

function terminalTurnStatus(status: AgentRunRecoveryDecision['status']): TurnRecord['status'] {
  if (status === 'cancelled') return 'aborted';
  return status;
}

function diagnosticRecoveryReason(diagnostic: Record<string, unknown> | undefined): string {
  const recoveryReason = diagnostic?.recoveryReason;
  return typeof recoveryReason === 'string' && recoveryReason.length > 0
    ? recoveryReason
    : 'agent_run_recovery';
}

function latestTurnState(
  messages: readonly StoredMessage[],
  turnId: string,
): Extract<StoredMessage, { type: 'turn_state' }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === 'turn_state' && message.turnId === turnId) return message;
  }
  return undefined;
}

function runtimeTerminalFactToRecoveryDecision(
  header: AgentRunHeader,
  fact: RuntimeEventTerminalFact,
): AgentRunRecoveryDecision {
  return {
    runId: fact.runId,
    turnId: fact.turnId,
    status: fact.runStatus,
    ...(fact.failureClass ? { failureClass: fact.failureClass } : {}),
    ...(fact.abortSource ? { abortSource: fact.abortSource } : {}),
    diagnostic: {
      recoveryReason: 'runtime_event_terminal_fact',
      runtimeEventId: fact.terminalEvent.id,
      runtimeEventStatus: fact.terminalEvent.status,
    },
    lineage: headerLineage(header),
  };
}

function headerLineage(header: AgentRunHeader): AgentRunRecoveryDecision['lineage'] {
  return {
    ...(header.parentRunId ? { parentRunId: header.parentRunId } : {}),
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId
      ? { regeneratedFromTurnId: header.regeneratedFromTurnId }
      : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
  };
}

function normalizeAgentOutputMaxEvents(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

const DEFAULT_AGENT_OUTPUT_MAX_BYTES = 32 * 1024;
const MAX_AGENT_OUTPUT_MAX_BYTES = 128 * 1024;

function normalizeAgentOutputMaxBytes(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AGENT_OUTPUT_MAX_BYTES;
  }
  return Math.min(MAX_AGENT_OUTPUT_MAX_BYTES, Math.max(1024, Math.floor(value)));
}

function buildAgentOutputCommittedResult(input: {
  header: AgentRunHeader;
  runtimeEvents: readonly RuntimeEvent[];
  artifacts: readonly ArtifactRecord[];
  maxArtifacts: number;
  maxBytes: number;
  graph?: NonNullable<SubagentSessionParent['graph']>;
}): {
  result: AgentOutputCommittedResult;
  projectedBytes: number;
  truncated: boolean;
} {
  const finalTextEvent = findLastMatching(
    input.runtimeEvents,
    (event) =>
      event.role === 'model' &&
      event.partial !== true &&
      event.content?.kind === 'text' &&
      event.content.text.trim().length > 0,
  );
  const graphRecords =
    input.graph && input.runtimeEvents.length > 0
      ? projectAgentGraphRecords({
          graphId: input.graph.graphId,
          streams: [
            {
              operator: {
                operatorId: input.graph.operatorId,
                sessionId: input.header.sessionId,
              },
              run: input.header,
              events: input.runtimeEvents,
            },
          ],
        }).records
      : [];
  const graphRecordByRuntimeEventId = new Map(
    graphRecords.map((record) => [record.source.runtimeEventId, record]),
  );
  const terminalRecord = findLastMatching(graphRecords, (record) =>
    record.supervisorSignals.some((signal) => signal.kind === 'terminal'),
  );
  const outputRecord = finalTextEvent
    ? graphRecordByRuntimeEventId.get(finalTextEvent.id)
    : undefined;
  let artifactIds = tail(
    input.artifacts.map((artifact) => artifact.id),
    input.maxArtifacts,
  );
  const base = (): AgentOutputCommittedResult => ({
    schemaVersion: 1,
    status: input.header.status,
    ...(input.graph ? { graph: { ...input.graph } } : {}),
    ...(outputRecord || terminalRecord
      ? { resultRecordId: (outputRecord ?? terminalRecord)!.recordId }
      : {}),
    ...(terminalRecord ? { terminalRecordId: terminalRecord.recordId } : {}),
    ...(finalTextEvent ? { sourceRuntimeEventId: finalTextEvent.id } : {}),
    ...(terminalRecord ? { terminalRuntimeEventId: terminalRecord.source.runtimeEventId } : {}),
    textTruncated: false,
    artifactIds,
    omittedArtifactIds: Math.max(0, input.artifacts.length - artifactIds.length),
    ...(input.header.failureClass ? { failureClass: input.header.failureClass } : {}),
  });

  while (artifactIds.length > 0 && serializedBytes(base()) > input.maxBytes) {
    artifactIds = artifactIds.slice(1);
  }

  const text = finalTextEvent?.content?.kind === 'text' ? finalTextEvent.content.text : undefined;
  const withoutText = base();
  if (text === undefined) {
    return {
      result: withoutText,
      projectedBytes: serializedBytes(withoutText),
      truncated: withoutText.omittedArtifactIds > 0,
    };
  }
  const fullResult = { ...withoutText, text };
  const fullBytes = serializedBytes(fullResult);
  if (fullBytes <= input.maxBytes) {
    return {
      result: fullResult,
      projectedBytes: fullBytes,
      truncated: withoutText.omittedArtifactIds > 0,
    };
  }

  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  let best: AgentOutputCommittedResult = { ...withoutText, textTruncated: true };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate: AgentOutputCommittedResult = {
      ...withoutText,
      text: `${codePoints.slice(0, middle).join('')}…`,
      textTruncated: true,
    };
    if (serializedBytes(candidate) <= input.maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    result: best,
    projectedBytes: serializedBytes(best),
    truncated: true,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function findLastMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (predicate(item)) return item;
  }
  return undefined;
}

function boundAgentOutputCollections(
  input: {
    events: AgentRunEvent[];
    runtimeEvents: RuntimeEvent[];
    diagnostics: AgentRunInspectModel['diagnostics'];
    artifacts: ArtifactRecord[];
  },
  maxBytes: number,
): {
  events: AgentRunEvent[];
  runtimeEvents: RuntimeEvent[];
  diagnostics: AgentRunInspectModel['diagnostics'];
  artifacts: ArtifactRecord[];
  projectedBytes: number;
  truncated: boolean;
} {
  let remaining = maxBytes;
  let projectedBytes = 0;
  let truncated = false;

  const takeBoundedTail = <T>(items: readonly T[]): T[] => {
    const selected: T[] = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]!;
      const bytes = serializedBytes(item);
      if (bytes > remaining) {
        truncated = true;
        break;
      }
      selected.push(item);
      projectedBytes += bytes;
      remaining -= bytes;
    }
    selected.reverse();
    return selected;
  };

  // RuntimeEvents are the semantic child transcript and therefore receive the
  // budget first. AgentRun events and diagnostics remain available through
  // explicit views without duplicating an unbounded second event stream.
  const runtimeEvents = takeBoundedTail(input.runtimeEvents);
  const events = takeBoundedTail(input.events);
  const diagnostics = takeBoundedTail(input.diagnostics);
  const artifacts = takeBoundedTail(input.artifacts);
  return { events, runtimeEvents, diagnostics, artifacts, projectedBytes, truncated };
}

function tail<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return items.slice(items.length - max);
}

function shellRunBashToolCallIds(messages: readonly StoredMessage[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      message.type === 'tool_call' && message.toolName === 'Bash' ? [message.id] : [],
    ),
  );
}

function throwIfChildExecutionAborted(signal: AbortSignal | undefined, message: string): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error(message), { name: 'AbortError' });
}

// Re-export the suppressed-unused types so this file is the canonical home
// for them. (Avoids TS "imported but unused" warnings.)
export type {
  TextDeltaEvent,
  CompleteEvent,
  ErrorEvent,
  AbortEvent,
  PermissionRequestEvent,
  PermissionDecisionAckEvent,
  PermissionDecisionMessage,
};
