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

import { decodeCanonicalToolResultContent } from '@maka/core/tool-result-record-schema';
import { projectAgentSwarmResult } from '@maka/core/agent-swarm';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';
import {
  type CreateSandboxBoundaryRequest,
  type ExecutionBoundary,
  type SandboxBoundaryDecision,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryRequest,
  type SandboxBoundarySettlement,
  type SettleSandboxBoundaryRequest,
} from '@maka/core/sandbox-boundary';
import { serializedByteLength } from '@maka/core/serialized-byte-length';
import { encodeToolStepProgress, ToolOutcomeUnknownError } from '@maka/core/events';
import type {
  SandboxBoundaryDecisionAckEvent,
  SandboxBoundaryRequestEvent,
  SessionEvent,
  ToolResultPreviewContent,
  SandboxDenialSignal,
  ToolActivityKind,
  ToolOutputStream,
  ToolResultContent,
  ToolResultEvent,
  ToolStartEvent,
  ToolUncertainOutcomeSignal,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import type { ToolCallMessage, ToolResultMessage } from '@maka/core/session';
import type {
  HostedInteractionBridge,
  HostedSandboxBoundarySettlement,
  HostedUserQuestionAnswer,
  HostedUserQuestionSettlement,
} from '@maka/core/backend-types';
import type { PermissionMode, ToolCategory, ToolExecutionFacts } from '@maka/core/permission';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type {
  UserQuestion,
  UserQuestionResponse,
  UserQuestionResult,
} from '@maka/core/user-question';
import { computerUseModelCallArgs } from '@maka/core/computer-use';
import type { SessionHeader } from '@maka/core/session';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { redactSecrets } from '@maka/core/redaction';
import {
  decodeRuntimeEvent,
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST,
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC,
  TOOL_BOUNDARY_PROTOCOL_V1,
  type RuntimeEvent,
  type RuntimeEventManagedWorkspaceMutationV2,
} from '@maka/core/runtime-event';
import { isDeepStrictEqual } from 'node:util';

import { recordToolArtifactsSafely, type ToolArtifactRecorder } from './tool-artifacts.js';
import { computerActionFields, describeComputerUseArgsViolation } from './computer-use-codec.js';
import { createToolOutputDeltaEmitter } from './tool-output-delta.js';
import { truncateToolOutput } from './tool-output.js';
import { stableHash } from './request-shape.js';
import { classifyError } from './provider-error-classification.js';
import type { RunTraceLike } from './run-trace.js';
import { AwaitRegistry } from './await-registry.js';
import type { ToolResultOutput } from './model-protocol.js';
import {
  compatibilityToolResultProjection,
  encodeDefaultDurableToolResultOutput,
  encodeDurableToolResultOutput,
  encodeDurableToolResultOutputWithArtifacts,
} from './durable-tool-result-projection.js';
import {
  DURABLE_TOOL_RESULT_PROJECTION_FAILURE,
  type DurableProjectionArtifactRef,
  type DurableToolResultProjection,
} from '@maka/core/durable-tool-result-projection';
import {
  buildToolOperationId,
  canonicalToolArgsHash,
  type RuntimeCommitSink,
  type ToolRecoveryMode,
} from './runtime-commit-sink.js';
import { AdmissionLimiter } from './admission-limiter.js';
import type { AgentProfile } from './agent-catalog.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import {
  SandboxCommandError,
  sandboxErrorMetadata,
  serializeSandboxError,
} from './sandbox/errors.js';
import {
  normalizeSandboxBoundaryExpansion,
  SandboxBoundaryDeclarationError,
} from './sandbox-boundary-path.js';
import {
  REQUEST_SANDBOX_BOUNDARY_TOOL_NAME,
  SANDBOX_BOUNDARY_DENIED_FOR_TURN,
  SANDBOX_BOUNDARY_UNAVAILABLE,
} from './sandbox-boundary-tool.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionClosedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeInteractionClosureReason,
  type RuntimeUserQuestionClosureReason,
} from './interaction-authority.js';

export interface ResolvedMakaToolCall {
  tool: MakaTool;
  turnId: string;
  stepId?: string;
  toolCallId: string;
  input: unknown;
  providerOptions?: Record<string, unknown>;
  abortSignal: AbortSignal;
  eventSink: DurableSessionEventSink;
  origin?: 'provider' | 'code_mode';
  parentToolCallId?: string;
  parentOperationId?: string;
  maxResultBytes?: number;
}

export interface DurableSessionEventSink {
  push(event: SessionEvent): void;
  pushAndWaitUntilConsumed(event: SessionEvent): Promise<void>;
}

export interface ToolSettlement {
  result: unknown;
  providerError?: string;
}

export type MakaToolPreparationContext = Pick<
  MakaToolContext,
  | 'sessionId'
  | 'runId'
  | 'turnId'
  | 'cwd'
  | 'executionBoundary'
  | 'permissionMode'
  | 'toolCallId'
  | 'abortSignal'
>;

export interface PreparedMakaToolExecution<R = unknown> {
  execute(context: MakaToolContext): Promise<R> | R;
  cancel(): Promise<void> | void;
}

export interface MakaTool<P = any, R = unknown> {
  /** Canonical (Claude-SDK-style) name. Pi adapter translates to canonical. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Zod schema describing the tool's argument shape. */
  parameters: unknown;
  /** Optional UI display name. */
  displayName?: string;
  /** Stable semantic category used by UI presentation; never carries styling. */
  activityKind?: ToolActivityKind;
  /** Optional trusted category override for custom tools. */
  categoryHint?: ToolCategory;
  /** Host-owned admission contract, independent of model/UI tool categorization. */
  hostAdmission?: 'client_capability';
  /** Optional trusted facts about the executor that runs this tool. */
  executionFacts?: ToolExecutionFacts;
  /**
   * Provider-native tool declaration. Hosted tools execute at the provider;
   * client-executed tools such as ApplyPatch still settle through ToolRuntime.
   */
  providerTool?: {
    readonly kind: 'openai-apply-patch' | 'openai-web-search' | 'anthropic-web-search-20250305';
    readonly searchContextSize?: 'low' | 'medium' | 'high';
    readonly maxUses?: number;
  };
  /** Crash-recovery contract used by the durable tool boundary. */
  recoveryMode?: ToolRecoveryMode;
  /** Durable execution profile selected by the Host before T1. */
  durableExecutionProfile?: 'managed_mutation_v1';
  /**
   * Pure Write/Edit transform for managed mutation mode. It receives only the
   * frozen arguments and must not read or mutate the live workspace.
   */
  managedMutationTransform?: (args: P) => Promise<R> | R;
  /** Step-level admission contract. Exclusive tools cannot share an assistant step. */
  executionSemantics?: 'parallel' | 'exclusive_step';
  /** Nested CodeMode admission. Ordinary tools are nestable by default. */
  nesting?: 'nestable' | 'direct_only';
  /** Optional permission/persistence projection derived from isolated execution args. */
  permissionArgs?: (
    args: P,
    context: Pick<MakaToolContext, 'sessionId' | 'turnId' | 'toolCallId'>,
  ) => unknown;
  /** Optional preparation that settles before ToolRuntime crosses its durable T1 cut. */
  prepareExecution?: (
    args: P,
    context: MakaToolPreparationContext,
  ) => Promise<PreparedMakaToolExecution<R>>;
  /**
   * Real tool implementation. Implementations must observe `ctx.abortSignal` and
   * settle promptly after it aborts. Runtime-owned nested calls await this
   * settlement instead of detaching, so late side effects cannot outlive `exec`.
   */
  impl: (args: P, ctx: MakaToolContext) => Promise<R> | R;
  /** Optional synchronous provider-visible content mapping, used for screenshot image parts. */
  toModelOutput?: (options: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }) => ToolResultOutput;
}

export interface MakaToolContext {
  sessionId: string;
  runId?: string;
  orchestrationMode?: OrchestrationMode;
  turnId: string;
  /** Session working directory. */
  cwd: string;
  /** Authoritative session boundary read immediately before Runtime-dispatched execution. */
  executionBoundary?: ExecutionBoundary;
  permissionMode?: PermissionMode;
  toolCallId: string;
  /** Runtime-owned durable identity of this tool operation, when enabled. */
  operationId?: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
  /** Live-only bounded progress for multi-step tools. */
  emitProgress?: (current: number, total: number) => void;
  /** Diagnostic-only trace projection. It must never affect tool execution. */
  emitRunTrace?: (
    type:
      | 'tool_started'
      | 'tool_searched'
      | 'tool_completed'
      | 'tool_failed'
      | 'skill_searched'
      | 'skill_loaded'
      | 'skill_load_failed',
    message: string,
    data?: Record<string, unknown>,
  ) => void;
  spawnChildSession?: (input: {
    agentProfile: AgentProfile;
    subagentId?: string;
    prompt: string;
    /** Optional swarm identity, scoped to the owning tool call. */
    swarm?: {
      swarmId: string;
      itemId: string;
    };
    /** Optional per-child signal, always composed with the owning tool invocation signal. */
    abortSignal?: AbortSignal;
    onReady?: (input: {
      childSessionId: string;
      turnId: string;
      runId: string;
      agentId: string;
      agentName: string;
      permissionMode: PermissionMode;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: {
    execution?: SubagentExecutionRef;
    runId?: string;
    turnId?: string;
    maxEvents?: number;
    maxBytes?: number;
    view?: 'result' | 'events' | 'runtime_events' | 'all';
  }) => Promise<unknown>;
  askUserQuestion?: (questions: UserQuestion[]) => Promise<UserQuestionResult>;
  requestSandboxBoundary?: (
    expansion: SandboxBoundaryExpansion,
    justification: string,
  ) => Promise<SandboxBoundarySettlement>;
}

export type AppendMessageFn = (m: ToolCallMessage | ToolResultMessage) => Promise<void>;
export type ToolTelemetryRecorder = (record: ToolInvocationRecord) => void;

/**
 * Per-step tool-availability gating for the execute boundary. `gatedNames` is
 * the immutable searchable set and `activeNames` returns the model-visible
 * snapshot for the step currently executing.
 */
export interface ToolGating {
  gatedNames: ReadonlySet<string>;
  activeNames: () => ReadonlySet<string>;
}

export const TOOL_ERROR_RESULT_MAX_CHARS = 4000;
export const MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN = 5;
export const MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN = 32;
export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

/**
 * Loop-gate: block a tool call once this many byte-identical calls (same tool +
 * same args) have FAILED back-to-back with nothing different in between. Mirrors
 * opencode's doom-loop threshold (#92: "same tool+args failing N times"). A
 * success, or any different tool/args, resets the streak — so legitimate polling
 * (re-run the same status check until it passes) and iterate-then-retry (edit a
 * file, re-run the same failing test) are never gated; only a no-progress loop of
 * identical *failures* is.
 */
export const LOOP_GATE_IDENTICAL_THRESHOLD = 3;
const SANDBOX_BOUNDARY_FAILURE_ROUND_LIMIT = 3;

type SandboxBoundaryFailureKind = 'invalid' | 'unresolved';
type SandboxBoundaryFailureDetails = Extract<ToolResultContent, { kind: 'text' }>['sandboxFailure'];

const SUBAGENT_TOOL_LIMIT_MESSAGE =
  '子代理并发过多：同一轮最多 5 个子代理。请等待已有任务完成后再继续。';
const CLIENT_CAPABILITY_BOUNDARY_MESSAGE =
  'Client Capability tools require the Bypass execution boundary because their client-side effects cannot be sandboxed by the Host. Switch this Session to Bypass and retry.';
const CLIENT_CAPABILITY_PREPARATION_MESSAGE =
  'Client Capability tool is missing its Host admission preparation contract.';

function composeChildAbortSignal(
  invocationSignal: AbortSignal,
  childSignal: AbortSignal | undefined,
): AbortSignal {
  if (!childSignal || childSignal === invocationSignal) return invocationSignal;
  return AbortSignal.any([invocationSignal, childSignal]);
}

export interface ToolRuntimeInput {
  sessionId: string;
  header: SessionHeader;
  connection: RuntimeExecutionConnection;
  modelId: string;
  appendMessage: AppendMessageFn;
  readExecutionBoundary: () => Promise<ExecutionBoundary>;
  createSandboxBoundaryRequest?: (
    input: CreateSandboxBoundaryRequest,
  ) => Promise<SandboxBoundaryRequest>;
  settleSandboxBoundaryRequest?: (
    input: SettleSandboxBoundaryRequest,
  ) => Promise<SandboxBoundarySettlement>;
  newId: () => string;
  now: () => number;
  getPermissionPauseTarget: () => { pause(): void; resume(): void } | null;
  /**
   * The ONE turn this ToolRuntime serves, fixed at construction alongside its
   * run identity. A backend instance is shared by concurrently overlapping
   * turns, so nothing a tool reads back from the backend can be trusted to
   * still describe the turn that dispatched it (#1990).
   */
  turnId: string;
  hostedInteraction?: HostedInteractionBridge;
  /**
   * Durable identity of the ONE run this ToolRuntime serves, fixed at
   * construction. It is deliberately a value and not a getter: a backend
   * instance is shared by concurrently overlapping runs, so anything a tool
   * reads back from the backend's "current" state can already belong to a
   * different run by the time the tool executes (#1990).
   */
  runId?: string;
  orchestrationMode?: OrchestrationMode;
  invocationId?: string;
  prepareDurableProjectionArtifact?: (input: {
    turnId: string;
    bytes: Uint8Array;
    mediaType: string;
  }) => {
    ref: Extract<DurableProjectionArtifactRef, { kind: 'session_file' }>;
    persist(): Promise<void>;
    /** Reclaim this publication when the projection is rejected (#4283). */
    retract?(): Promise<void>;
  };
  spawnChildSession?: (input: {
    parentRunId: string;
    parentTurnId: string;
    toolCallId: string;
    agentProfile: AgentProfile;
    subagentId?: string;
    prompt: string;
    swarm?: {
      swarmId: string;
      itemId: string;
    };
    abortSignal: AbortSignal;
    onReady?: (input: {
      childSessionId: string;
      turnId: string;
      runId: string;
      agentId: string;
      agentName: string;
      permissionMode: PermissionMode;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  listChildAgents?: () => Promise<unknown>;
  readChildAgentOutput?: (input: {
    execution?: SubagentExecutionRef;
    runId?: string;
    turnId?: string;
    maxEvents?: number;
    maxBytes?: number;
    view?: 'result' | 'events' | 'runtime_events' | 'all';
  }) => Promise<unknown>;
  getRunTrace?: () => RunTraceLike | null;
  recordToolInvocation?: ToolTelemetryRecorder;
  recordToolArtifacts?: ToolArtifactRecorder;
  /** Optional Phase 2 T1/T2 commit boundary for hosts that persist RuntimeEvents. */
  runtimeCommitSink?: RuntimeCommitSink;
  /** Host-owned managed mutation admission. It may never fall back after returning a profile. */
  admitManagedMutation?: (input: {
    readonly operationId: string;
    readonly toolName: string;
    readonly persistedArgs: unknown;
    readonly abortSignal: AbortSignal;
  }) => Promise<RuntimeManagedMutationAdmission>;
}

interface RuntimeManagedMutationOperationValue<T> {
  readonly result: T;
  readonly outcome: {
    readonly content: ToolResultContent;
    readonly isError: boolean;
    readonly durationMs: number;
    readonly modelProjection: DurableToolResultProjection;
  };
}

/**
 * The only operation evidence exposed to the workspace owner. Runtime keeps
 * the provider-facing value private so the owner cannot replace the live
 * result while committing a different durable response.
 */
export interface RuntimeManagedMutationOperationProof {
  readonly content: ToolResultContent;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly modelProjection: DurableToolResultProjection;
}

export type RuntimeManagedMutationSettlement =
  | {
      readonly kind: 'workspace_successor_committed';
      readonly durableOutcome: RuntimeEvent;
    }
  | {
      readonly kind: 'no_workspace_change_committed' | 'operation_failed_no_effect_committed';
      /** Exact value returned to the provider and canonicalized for durable replay. */
      readonly providerResult: unknown;
      readonly durableOutcome: RuntimeEvent;
    }
  | { readonly kind: 'unsettled'; readonly error: unknown };

export interface RuntimeManagedMutationAdmission {
  readonly durableDispatch: Readonly<RuntimeEventManagedWorkspaceMutationV2>;
  execute(
    operation: () => Promise<RuntimeManagedMutationOperationProof>,
  ): Promise<RuntimeManagedMutationSettlement>;
  /** Idempotent for an unused, failed-T1, or already executed admission. */
  dispose(): Promise<void>;
}

interface DurableToolAttempt {
  operationId: string;
  responseEventId: string;
  commitOutcome(
    result: unknown,
    isError: boolean,
    modelProjection: DurableToolResultProjection,
    durationMs?: number,
  ): Promise<{ id: string; operationId: string; ts: number }>;
  adoptCommittedOutcome(
    event: RuntimeEvent,
    result: ToolResultContent,
    isError: boolean,
    modelProjection: DurableToolResultProjection,
    durationMs: number,
  ): { id: string; operationId: string; ts: number };
}

class RuntimeCommitBoundaryError extends Error {
  constructor(
    readonly phase: 'T1' | 'T2',
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${phase} runtime commit failed: ${detail}`, { cause });
    this.name = 'RuntimeCommitBoundaryError';
  }
}

class RuntimeManagedMutationUnsettledError extends Error {
  constructor(cause: unknown) {
    super(
      `Managed workspace mutation remains unsettled: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'RuntimeManagedMutationUnsettledError';
  }
}

class ToolResultLimitError extends Error {
  constructor() {
    super('Tool result byte limit exceeded');
    this.name = 'ToolResultLimitError';
  }
}

export function isRuntimeCommitBoundaryError(error: unknown): boolean {
  return error instanceof RuntimeCommitBoundaryError;
}

export class ToolRuntime {
  private readonly sandboxBoundaryRequests = new AwaitRegistry<
    SandboxBoundarySettlement,
    { toolUseId: string; creation?: Promise<SandboxBoundaryRequest>; hosted: boolean }
  >();
  private readonly userQuestions = new AwaitRegistry<
    UserQuestionResponse,
    { toolUseId: string; questions: UserQuestion[]; hosted: boolean }
  >();
  private readonly turnId: string;
  private readonly hostedInteraction: HostedInteractionBridge | undefined;
  private sandboxBoundaryClosureDeferred = false;
  private questionClosureDeferred = false;
  private activeSubagentToolCount = 0;
  private childAgentRunLimiter = new AdmissionLimiter(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
  /**
   * Tool-availability gating for the execute boundary. Set by the backend each
   * turn from `ToolAvailabilityRuntime`. Undefined when nothing is searchable.
   */
  private gating?: ToolGating;
  /**
   * Loop-gate state: the signature (tool + canonical args) of the last *failed*
   * call and how many byte-identical calls have failed back-to-back, including
   * the most recent. A success or a different call clears it (see
   * {@link recordLoopGateOutcome}). Only a consecutive count is needed, so two
   * fields suffice. Reset each turn.
   */
  private lastFailedToolCallSignature: string | undefined;
  private failedToolCallStreak = 0;
  private lastFailedToolCallBoundaryKind: SandboxBoundaryFailureKind | undefined;
  private lastFailedToolCallBoundaryDetails: SandboxBoundaryFailureDetails;
  private lastAmbiguousComputerSignature: string | undefined;
  private readonly recentSandboxDenials = new Set<string>();
  private sandboxBoundaryDenied = false;
  private sandboxBoundaryDecisionGeneration = 0;
  private sandboxBoundaryInvalidRounds = 0;
  private sandboxBoundaryUnresolvedRounds = 0;
  private readonly sandboxBoundaryInvalidSteps = new Set<string>();
  private readonly sandboxBoundaryUnresolvedSteps = new Set<string>();
  private sandboxBoundaryRequestInFlight = false;
  private sandboxBoundaryFinalizationRequested = false;
  private readonly durableToolAttempts = new Map<string, DurableToolAttempt>();
  private readonly activeToolSettlements = new Set<Promise<unknown>>();
  private readonly readExecutionBoundary: NonNullable<ToolRuntimeInput['readExecutionBoundary']>;
  private readonly stepAdmissions = new Map<
    string,
    { callCount: number; exclusiveToolName?: string }
  >();
  constructor(private readonly input: ToolRuntimeInput) {
    if (!input.readExecutionBoundary) {
      throw new Error('ToolRuntime requires explicit execution boundary authority');
    }
    const hosted = input.hostedInteraction;
    if (hosted && (hosted.sessionId !== input.sessionId || hosted.turnId !== input.turnId)) {
      throw new RuntimeInteractionInvariantError(
        `ToolRuntime received a mismatched hosted Interaction Run for turn ${input.turnId}`,
      );
    }
    this.turnId = input.turnId;
    this.hostedInteraction = hosted;
    this.readExecutionBoundary = input.readExecutionBoundary;
  }

  async endTurn(reason: 'completed' | 'aborted' = 'completed'): Promise<void> {
    const turnId = this.turnId;
    const boundaryRequests = this.sandboxBoundaryRequests.entries();
    const hasHostedBoundaryPending = boundaryRequests.some(([, request]) => request.hosted);
    const boundarySettlementErrors: unknown[] = [];
    const embeddedBoundaryRequests = boundaryRequests.filter(([, request]) => !request.hosted);
    if (embeddedBoundaryRequests.length > 0) {
      if (!this.input.settleSandboxBoundaryRequest) {
        boundarySettlementErrors.push(
          new Error('Sandbox boundary settlement is unavailable on this surface'),
        );
      } else {
        const results = await Promise.allSettled(
          embeddedBoundaryRequests.map(async ([requestId, metadata]) => {
            try {
              await metadata.creation;
            } catch {
              return;
            }
            await this.input.settleSandboxBoundaryRequest?.({
              sessionId: this.input.sessionId,
              requestId,
              decision: 'deny',
            });
          }),
        );
        for (const result of results) {
          if (result.status === 'rejected') boundarySettlementErrors.push(result.reason);
        }
      }
    }

    const hasHostedPending = this.userQuestions.entries().some(([, question]) => question.hosted);
    if (hasHostedBoundaryPending) {
      this.sandboxBoundaryClosureDeferred = true;
      this.finishDeferredSandboxBoundaryTurnClosure();
    } else {
      this.sandboxBoundaryRequests.close(
        (requestId) =>
          new Error(`Turn ${turnId} ${reason} before sandbox boundary ${requestId} was settled`),
      );
      this.sandboxBoundaryClosureDeferred = false;
    }
    if (hasHostedPending) {
      this.questionClosureDeferred = true;
      this.finishDeferredQuestionTurnClosure();
    } else {
      this.userQuestions.close(
        (requestId) =>
          new Error(`Turn ${turnId} ${reason} before user question ${requestId} was answered`),
      );
      this.questionClosureDeferred = false;
    }
    this.resetTurnState();
    // The stop path settles the run's terminal fact right after the
    // backend's stop resolves, and that stop awaits this method. Unwinds
    // already in flight commit their T2 outcomes on their own microtask
    // chains, so wait for them here: the terminal event stays the ledger's
    // immutable tail instead of racing an outcome in behind it (#2253).
    // Bounded, not open-ended: every rejection above has already been
    // dispatched, and running impls observe the turn abort signal.
    await Promise.allSettled([...this.activeToolSettlements]);
    if (boundarySettlementErrors.length > 0) {
      throw new AggregateError(
        boundarySettlementErrors,
        `Could not durably deny every sandbox boundary request for turn ${turnId}`,
      );
    }
  }

  respondToUserQuestion(response: UserQuestionResponse): boolean {
    const turnId = this.turnId;
    if (!response || typeof response.requestId !== 'string' || !Array.isArray(response.answers)) {
      throw new Error('Invalid user question response');
    }
    const pending = this.userQuestions
      .entries()
      .find(([requestId]) => requestId === response.requestId)?.[1];
    if (!pending) return false;
    if (pending.hosted) {
      throw new RuntimeInteractionInvariantError(
        `Hosted question ${response.requestId} must settle through its captured continuation`,
      );
    }
    return this.settleUserQuestionAnswer(turnId, response, pending);
  }

  async respondToSandboxBoundaryResponse(response: {
    requestId: string;
    decision: SandboxBoundaryDecision;
  }): Promise<boolean> {
    if (!this.sandboxBoundaryRequests.has(response.requestId)) return false;
    if (
      !response ||
      typeof response.requestId !== 'string' ||
      (response.decision !== 'allow' && response.decision !== 'deny')
    ) {
      throw new Error('Invalid sandbox boundary response');
    }
    const pending = this.sandboxBoundaryRequests
      .entries()
      .find(([requestId]) => requestId === response.requestId);
    if (!pending) return false;
    if (pending[1].hosted) {
      throw new RuntimeInteractionInvariantError(
        `Hosted sandbox boundary ${response.requestId} must settle through its captured continuation`,
      );
    }
    if (!this.input.settleSandboxBoundaryRequest) {
      throw new Error('Sandbox boundary settlement is unavailable on this surface');
    }
    const settlement = await this.input.settleSandboxBoundaryRequest({
      sessionId: this.input.sessionId,
      requestId: response.requestId,
      decision: response.decision,
    });
    return this.sandboxBoundaryRequests.resolve(response.requestId, settlement) !== null;
  }

  private settleUserQuestionAnswer(
    turnId: string,
    response: UserQuestionResponse,
    pending: { toolUseId: string; questions: UserQuestion[]; hosted: boolean },
  ): boolean {
    if (
      response.answers.length !== pending.questions.length ||
      response.answers.some(
        (answer) => answer !== null && (typeof answer !== 'string' || answer.length === 0),
      )
    ) {
      throw new Error('Invalid user question response');
    }
    const resolved = this.userQuestions.resolve(response.requestId, response) !== null;
    this.finishDeferredQuestionTurnClosure();
    return resolved;
  }

  closeUserQuestion(
    turnId: string,
    requestId: string,
    reason: RuntimeInteractionClosureReason,
  ): boolean {
    const closed =
      this.userQuestions.reject(requestId, new RuntimeInteractionClosedError(requestId, reason)) !==
      null;
    this.finishDeferredQuestionTurnClosure();
    return closed;
  }

  pendingUserQuestionCount(): number {
    return this.userQuestions.pendingCount();
  }

  /**
   * Settle one resolved Maka tool call. Tool/business failures resolve with a
   * provider-facing error output; durable runtime commit failures still reject.
   */
  async settleToolCall(call: ResolvedMakaToolCall): Promise<ToolSettlement> {
    const settlement = this.performToolSettlement(call);
    // Tracked so endTurn can wait out unwinds already in flight (#2253):
    // their T2 outcomes must land before the stop path settles the run's
    // terminal fact, and nested Code Mode calls route through here too.
    // The caller observes the settlement itself; the tracking handler only
    // removes the entry.
    this.activeToolSettlements.add(settlement);
    const untrack = () => this.activeToolSettlements.delete(settlement);
    void settlement.then(untrack, untrack);
    return settlement;
  }

  private async performToolSettlement(call: ResolvedMakaToolCall): Promise<ToolSettlement> {
    const result = await this.executeTool(
      call.tool,
      call.turnId,
      call.eventSink,
      call.input,
      {
        toolCallId: call.toolCallId,
        abortSignal: call.abortSignal,
        origin: call.origin ?? 'provider',
        ...(call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {}),
        ...(call.parentOperationId ? { parentOperationId: call.parentOperationId } : {}),
        ...(call.maxResultBytes !== undefined ? { maxResultBytes: call.maxResultBytes } : {}),
        ...(call.providerOptions !== undefined ? { providerOptions: call.providerOptions } : {}),
      },
      call.stepId,
    );
    const providerError = providerToolErrorMessage(result);
    return { result, ...(providerError ? { providerError } : {}) };
  }

  private projectToolResult(
    tool: MakaTool,
    turnId: string,
    toolCallId: string,
    input: unknown,
    result: unknown,
  ): DurableToolResultProjection | PromiseLike<DurableToolResultProjection> {
    try {
      const providerError = providerToolErrorMessage(result);
      if (providerError) {
        return encodeDurableToolResultOutput(
          tool.providerTool?.kind === 'openai-apply-patch'
            ? {
                type: 'json' as const,
                value: { status: 'failed' as const, output: providerError },
              }
            : { type: 'error-text' as const, value: new Error(providerError).toString() },
          this.input.sessionId,
        );
      }
      if (!tool.toModelOutput) {
        return encodeDefaultDurableToolResultOutput(result, this.input.sessionId);
      }
      const output = tool.toModelOutput({ toolCallId, input, output: result });
      // Projection is deliberately synchronous and total at the tool boundary.
      // Fail closed for untyped/plugin implementations that violate the
      // contract so a completed effect can never be stranded before T2.
      if (isPromiseLike<ToolResultOutput>(output)) {
        return DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
      }
      const encode = (resolved: ToolResultOutput) =>
        encodeDurableToolResultOutputWithArtifacts(
          resolved,
          this.input.sessionId,
          this.input.prepareDurableProjectionArtifact
            ? ({ bytes, mediaType }) =>
                this.input.prepareDurableProjectionArtifact!({
                  turnId,
                  bytes,
                  mediaType,
                })
            : undefined,
        );
      return encode(output);
    } catch {
      return DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
    }
  }

  /**
   * Install the per-step tool-availability gating used at the execute boundary.
   * The backend recomputes the active snapshot before each step; the guard in
   * `executeTool` rejects a gated tool whose name is not in it. Pass `undefined`
   * to disable gating.
   */
  setGating(gating: ToolGating | undefined): void {
    this.gating = gating;
  }

  resetTurnState(): void {
    const priorChildAgentRunLimiter = this.childAgentRunLimiter;
    this.childAgentRunLimiter = new AdmissionLimiter(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    priorChildAgentRunLimiter.close(
      new Error('Child agent run permit scope ended before capacity became available'),
    );
    this.activeSubagentToolCount = 0;
    this.gating = undefined;
    this.lastFailedToolCallSignature = undefined;
    this.failedToolCallStreak = 0;
    this.lastFailedToolCallBoundaryKind = undefined;
    this.lastFailedToolCallBoundaryDetails = undefined;
    this.lastAmbiguousComputerSignature = undefined;
    this.recentSandboxDenials.clear();
    this.sandboxBoundaryDenied = false;
    this.sandboxBoundaryDecisionGeneration = 0;
    this.sandboxBoundaryInvalidRounds = 0;
    this.sandboxBoundaryUnresolvedRounds = 0;
    this.sandboxBoundaryInvalidSteps.clear();
    this.sandboxBoundaryUnresolvedSteps.clear();
    this.sandboxBoundaryRequestInFlight = false;
    this.sandboxBoundaryFinalizationRequested = false;
    this.durableToolAttempts.clear();
    this.stepAdmissions.clear();
  }

  hasSandboxBoundaryDenial(): boolean {
    return this.sandboxBoundaryDenied;
  }

  shouldFinalizeSandboxBoundary(): boolean {
    return this.sandboxBoundaryFinalizationRequested;
  }

  forceSandboxBoundaryFinalization(): void {
    this.sandboxBoundaryFinalizationRequested = true;
  }

  private recordSandboxBoundaryFailure(
    kind: SandboxBoundaryFailureKind,
    correctionStep: string,
    decisionGeneration?: number,
  ): void {
    if (
      decisionGeneration !== undefined &&
      decisionGeneration !== this.sandboxBoundaryDecisionGeneration
    ) {
      return;
    }
    if (this.sandboxBoundaryDenied) {
      this.sandboxBoundaryFinalizationRequested = true;
      return;
    }
    const steps =
      kind === 'invalid' ? this.sandboxBoundaryInvalidSteps : this.sandboxBoundaryUnresolvedSteps;
    if (steps.has(correctionStep)) return;
    steps.add(correctionStep);
    if (kind === 'invalid') this.sandboxBoundaryInvalidRounds += 1;
    else this.sandboxBoundaryUnresolvedRounds += 1;
    if (
      this.sandboxBoundaryInvalidRounds >= SANDBOX_BOUNDARY_FAILURE_ROUND_LIMIT ||
      this.sandboxBoundaryUnresolvedRounds >= SANDBOX_BOUNDARY_FAILURE_ROUND_LIMIT
    ) {
      this.sandboxBoundaryFinalizationRequested = true;
    }
  }

  private resetSandboxBoundaryFailureRounds(): void {
    this.sandboxBoundaryInvalidRounds = 0;
    this.sandboxBoundaryUnresolvedRounds = 0;
    this.sandboxBoundaryInvalidSteps.clear();
    this.sandboxBoundaryUnresolvedSteps.clear();
    this.sandboxBoundaryFinalizationRequested = false;
  }

  /**
   * Record the terminal outcome of one tool call for the loop-gate. A success (or
   * any call with a different signature) resets the streak; a failure with the
   * same signature as the last failure extends it. Called once per call at every
   * exit — the pre-impl guards call it explicitly before their early returns, and
   * the impl section calls it from its `finally`. The pre-block itself is the one
   * exception: a blocked call records nothing, so the streak stays parked at the
   * threshold and every further identical repeat keeps being blocked.
   */
  private recordLoopGateOutcome(
    signature: string,
    failed: boolean,
    boundaryKind?: SandboxBoundaryFailureKind,
    boundaryDetails?: SandboxBoundaryFailureDetails,
  ): void {
    if (!failed) {
      this.lastFailedToolCallSignature = undefined;
      this.failedToolCallStreak = 0;
      this.lastFailedToolCallBoundaryKind = undefined;
      this.lastFailedToolCallBoundaryDetails = undefined;
      return;
    }
    if (signature === this.lastFailedToolCallSignature) {
      this.failedToolCallStreak += 1;
    } else {
      this.lastFailedToolCallSignature = signature;
      this.failedToolCallStreak = 1;
    }
    this.lastFailedToolCallBoundaryKind = boundaryKind;
    this.lastFailedToolCallBoundaryDetails = boundaryDetails;
  }

  private async writeSyntheticToolResult(
    toolUseId: string,
    turnId: string,
    toolName: string,
    text: string,
    queue: DurableSessionEventSink,
    sandboxDenial?: SandboxDenialSignal,
    sandboxFailure?: Extract<ToolResultContent, { kind: 'text' }>['sandboxFailure'],
    uncertainOutcome?: ToolUncertainOutcomeSignal,
    activityIdentity: {
      origin?: 'provider' | 'code_mode';
      modelVisibility?: 'visible' | 'hidden';
      parentToolCallId?: string;
      parentOperationId?: string;
    } = {},
    attempt?: DurableToolAttempt,
  ): Promise<void> {
    const content: ToolResultContent = {
      kind: 'text',
      text: formatSyntheticToolErrorText(text),
      ...(sandboxDenial ? { sandboxDenial } : {}),
      ...(sandboxFailure ? { sandboxFailure } : {}),
      ...(uncertainOutcome ? { uncertainOutcome } : {}),
    };
    // The executor passes its own attempt (#2253): a stop lands endTurn's
    // resetTurnState before a parked tool unwinds, so by the time the
    // rejection reaches the catch that writes this result, the map below is
    // already empty. A result written without the attempt loses its
    // operationId, and a response for a dispatched operation with no
    // operation identity is exactly what the tool ledger refuses as
    // identity_conflict. The map lookup remains for the pre-dispatch
    // guards, where no attempt exists and no identity is owed.
    const durableAttempt =
      attempt ?? this.durableToolAttempts.get(durableAttemptKey(turnId, toolUseId));
    const modelProjection =
      compatibilityToolResultProjection(
        {
          kind: 'function_response',
          id: toolUseId,
          name: toolName,
          result: content,
          isError: true,
        },
        this.input.sessionId,
      ) ?? DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
    const durableOutcome = await durableAttempt?.commitOutcome(content, true, modelProjection);
    const msg: ToolResultMessage = {
      type: 'tool_result',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      toolUseId,
      isError: true,
      content,
      ...activityIdentity,
    };
    await this.input.appendMessage(msg);
    queue.push({
      type: 'tool_result',
      id: durableOutcome?.id ?? this.input.newId(),
      turnId,
      ts: durableOutcome?.ts ?? this.input.now(),
      toolUseId,
      ...(durableOutcome ? { operationId: durableOutcome.operationId } : {}),
      isError: true,
      content,
      modelProjection,
      ...activityIdentity,
    } satisfies ToolResultEvent);
  }

  private async executeTool(
    tool: MakaTool,
    turnId: string,
    queue: DurableSessionEventSink,
    args: unknown,
    ctx: {
      toolCallId: string;
      abortSignal: AbortSignal;
      providerOptions?: Record<string, unknown>;
      origin: 'provider' | 'code_mode';
      parentToolCallId?: string;
      parentOperationId?: string;
      maxResultBytes?: number;
    },
    stepId?: string,
  ): Promise<unknown> {
    const rawExecutionArgs = snapshotToolArgs(args);
    const sandboxBoundaryDecisionGeneration = this.sandboxBoundaryDecisionGeneration;
    const toolUseId = ctx.toolCallId;
    // Registration is synchronous and happens before the first await, so
    // parallel Runtime settlements cannot race past exclusive admission.
    const directOnlyFailure =
      ctx.origin === 'code_mode' && tool.nesting === 'direct_only'
        ? `Tool ${tool.name} is direct-only and cannot run inside exec.`
        : undefined;
    const admissionFailure = directOnlyFailure ?? this.admitToolForStep(tool, stepId);
    const executionArgs = rawExecutionArgs;
    let permissionArgs = executionArgs;
    let permissionArgsError: unknown;
    if (directOnlyFailure === undefined) {
      try {
        // A surface that cannot carry a sandbox-boundary request rejects the
        // operation before it interprets the requested expansion. Preserve that
        // availability contract even when an older caller sends a legacy shape.
        const sandboxBoundaryUnavailable =
          tool.name === 'request_sandbox_boundary' &&
          !this.interactionRun() &&
          (!this.input.createSandboxBoundaryRequest || !this.input.settleSandboxBoundaryRequest);
        if (!sandboxBoundaryUnavailable) {
          await validateDeclaredToolArgs(tool.parameters, rawExecutionArgs);
        }
        permissionArgs = tool.permissionArgs
          ? snapshotToolArgs(
              tool.permissionArgs(structuredClone(executionArgs) as never, {
                sessionId: this.input.sessionId,
                turnId,
                toolCallId: toolUseId,
              }),
            )
          : executionArgs;
      } catch (error) {
        permissionArgsError = error;
      }
    }
    // The args written into the `tool_start` event, the persisted `tool_call`
    // message and the durable ledger — that is, the record of the call the
    // model reads back on its next turn (`model-history.ts` replays
    // `event.content.args`).
    //
    // Computer Use used the host's approval summary here. That projection
    // exists to decide and display a permission: it renames `window_id` to
    // `windowId`, adds `approvalClass` and `rememberForTurnAllowed`, and drops
    // every argument it does not need. On the real ToolRuntime a model that
    // sent {action:'press_key', app, window_id, observation_id, element_id,
    // text:'cmd+s'} read back {action, approvalClass, rememberForTurnAllowed,
    // app, windowId, observationId} — a key the tool rejects, two fields it
    // never sent, no element, and a press_key with no key. It then went on
    // calling it that way.
    //
    // The permission prompt still reads `permissionArgs`, and the approval
    // scope key is still computed from the raw call, so this only changes what
    // is written down. `computerUseModelCallArgs` keeps the same privacy rule
    // — screen-derived and user-typed values are reduced to a shape — and
    // speaks the tool's own argument names.
    const persistedArgs =
      tool.categoryHint === 'computer_use'
        ? snapshotToolArgs(computerUseModelCallArgs(permissionArgs))
        : permissionArgs;
    // What the model will read back as its own call. The approval summary is
    // the host's projection for deciding a permission, and using it here taught
    // the model to call the tool with `approvalClass`, `rememberForTurnAllowed`
    // and `windowId` — two fields it does not take and one key in a dialect it
    // rejects. Same privacy boundary, names the tool accepts.
    //
    // The same projection as the audit record, since `computerUseModelCallArgs`
    // became what both are written with. It was spelled out twice, which meant
    // running it twice per call and leaving two expressions to drift apart. The
    // two names stay because the roles are different — one is what the host
    // records, one is what the model reads — and a divergence would go here.
    const modelFacingArgs = persistedArgs;
    const now = this.input.now();
    const trace = this.input.getRunTrace?.() ?? null;
    const runId = this.input.runId;
    const invocationId = this.input.invocationId ?? runId;
    if (this.input.runtimeCommitSink && !runId) {
      throw new RuntimeCommitBoundaryError(
        'T1',
        new Error('Durable tool execution requires a run id'),
      );
    }
    const callSignature = `${ctx.origin}:${tool.name} ${loopGateArgsKey(executionArgs, toolUseId)}`;
    const boundaryAuthorityAttempt = isBoundaryAuthorityAttempt(tool.name, executionArgs);
    const boundaryCorrectionStep =
      stepId ?? ctx.parentToolCallId ?? ctx.parentOperationId ?? toolUseId;
    const computerSemanticSignature =
      tool.categoryHint === 'computer_use'
        ? computerUseSemanticSignature(permissionArgs)
        : undefined;
    const repeatedAmbiguousComputerTarget =
      computerSemanticSignature !== undefined &&
      computerSemanticSignature === this.lastAmbiguousComputerSignature;
    const repeatedFailedCall =
      callSignature === this.lastFailedToolCallSignature &&
      this.failedToolCallStreak >= LOOP_GATE_IDENTICAL_THRESHOLD - 1;
    const deferredToolNotLoaded =
      this.gating !== undefined &&
      this.gating.gatedNames.has(tool.name) &&
      !this.gating.activeNames().has(tool.name);
    const activityIdentity = {
      origin: ctx.origin,
      modelVisibility: ctx.origin === 'code_mode' ? ('hidden' as const) : ('visible' as const),
      ...(ctx.parentToolCallId ? { parentToolCallId: ctx.parentToolCallId } : {}),
      ...(ctx.parentOperationId ? { parentOperationId: ctx.parentOperationId } : {}),
    };
    // Which lane carries this call's `function_call` fact is not knowable here.
    // A pre-dispatch refusal — exclusive-step admission, arguments the schema
    // rejects, either loop gate, a deferred tool used before its load, a
    // boundary read, the subagent cap — never crosses T1, so its call and its
    // synthetic response both belong on the generic call/response lane. Only a
    // call that reaches `prepareDurableToolAttempt` may claim the T1 dispatch
    // protocol, because only `commitToolPrepared` persists the call under that
    // identity; tag a refusal and AgentRun skips the generic projection
    // (`isAtomicToolBoundaryProjection`) waiting for a commit that never comes,
    // leaving the response an `orphan_response` the ledger refuses — which took
    // the whole turn down with it (#2234).
    //
    // The predecessor of this block answered that by predicting the refusals up
    // front: every guard below was hoisted into a `preflightRejected` boolean
    // read at construction time. It is correct only while the prediction and
    // the guards agree, and nothing holds them together — a new refusal path,
    // or a guard that grows a condition its hoisted twin does not, silently
    // restores the orphan. Deciding at push time cannot drift, because the
    // decision IS the code path taken.
    const dispatchOperationId =
      this.input.runtimeCommitSink && invocationId
        ? buildToolOperationId({ invocationId, providerToolCallId: toolUseId })
        : undefined;
    const callEventFacts = {
      type: 'tool_start' as const,
      turnId,
      ts: now,
      toolUseId,
      toolName: tool.name,
      ...activityIdentity,
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      args: structuredClone(persistedArgs),
      ...(ctx.providerOptions !== undefined
        ? { providerOptions: structuredClone(ctx.providerOptions) }
        : {}),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
    };
    let callEvent: ToolStartEvent | undefined;
    const buildCallEvent = (lane: 'dispatch' | 'preflight'): ToolStartEvent => {
      if (callEvent) return callEvent;
      const operationId = lane === 'dispatch' ? dispatchOperationId : undefined;
      callEvent = {
        ...callEventFacts,
        id: operationId ? `${operationId}_call` : this.input.newId(),
        ...(operationId ? { operationId } : {}),
      };
      return callEvent;
    };
    let callEventPublished = false;
    const publishCallEvent = (event: ToolStartEvent): void => {
      if (callEventPublished) return;
      queue.push(event);
      callEventPublished = true;
    };
    const callMsg: ToolCallMessage = {
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: now,
      toolName: tool.name,
      ...activityIdentity,
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      args: structuredClone(persistedArgs),
      ...(ctx.providerOptions !== undefined
        ? { providerOptions: structuredClone(ctx.providerOptions) }
        : {}),
      // Persist the same step id the tool_start event carries so the UI
      // timeline and post-restart backfill can pair this call with its step.
      ...(stepId !== undefined ? { stepId } : {}),
    };
    let callMessageAppended = false;
    const appendCallMessage = async (): Promise<void> => {
      if (callMessageAppended) return;
      await this.input.appendMessage(callMsg);
      callMessageAppended = true;
    };
    const emitToolStartedTrace = (): void => {
      trace?.emit('tool', 'tool_started', 'Tool execution started', {
        toolUseId,
        toolName: tool.name,
        ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
      });
    };
    /**
     * One pre-dispatch refusal: the call fact on the generic lane, then the
     * refusal the model reads, on the same lane. Every refusal below routes
     * through here so the pair can never be split across lanes again.
     */
    const refuseBeforeDispatch = async (
      text: string,
      sandboxFailure?: Extract<ToolResultContent, { kind: 'text' }>['sandboxFailure'],
    ): Promise<void> => {
      await appendCallMessage();
      publishCallEvent(buildCallEvent('preflight'));
      emitToolStartedTrace();
      await this.writeSyntheticToolResult(
        toolUseId,
        turnId,
        tool.name,
        text,
        queue,
        undefined,
        sandboxFailure,
        undefined,
        activityIdentity,
      );
    };
    if (admissionFailure) {
      const boundaryKind = boundaryAuthorityAttempt ? ('invalid' as const) : undefined;
      if (boundaryKind) {
        this.recordSandboxBoundaryFailure(
          boundaryKind,
          boundaryCorrectionStep,
          sandboxBoundaryDecisionGeneration,
        );
      }
      await refuseBeforeDispatch(admissionFailure);
      trace?.emit('tool', 'tool_failed', 'Tool rejected by exclusive-step admission', {
        toolUseId,
        toolName: tool.name,
        stepId,
        status: 'error',
        errorClass: 'ExclusiveStepConflict',
      });
      this.recordLoopGateOutcome(callSignature, true, boundaryKind);
      return this.errorReturn(admissionFailure);
    }
    if (permissionArgsError !== undefined) {
      const boundaryKind = boundaryAuthorityAttempt ? ('invalid' as const) : undefined;
      if (boundaryKind) {
        this.recordSandboxBoundaryFailure(
          boundaryKind,
          boundaryCorrectionStep,
          sandboxBoundaryDecisionGeneration,
        );
      }
      // Computer Use keeps its own formatter: the generic one relays whatever
      // the error carries, and these arguments can hold typed text. The
      // replacement names the offending fields and nothing else, so a model
      // that got the shape wrong can fix it instead of re-sending it.
      const violation =
        tool.categoryHint === 'computer_use'
          ? describeComputerUseArgsViolation(permissionArgsError, executionArgs)
          : undefined;
      const msg =
        tool.categoryHint === 'computer_use'
          ? violation
            ? `Computer Use arguments failed validation: ${violation}`
            : 'Computer Use arguments failed validation'
          : // Same correction Computer Use gets, from the same place: the
            // tool's own schema. Relaying only the error taught nothing about
            // the shape the tool does accept, so a model that got the keys
            // wrong could only re-send them.
            formatToolArgsViolationText({
              toolName: tool.name,
              parameters: tool.parameters,
              args: executionArgs,
              error: permissionArgsError,
            });
      await refuseBeforeDispatch(msg);
      this.input.recordToolInvocation?.({
        sessionId: this.input.sessionId,
        turnId,
        toolCallId: toolUseId,
        toolName: tool.name,
        providerId: this.input.connection.providerType,
        modelId: this.input.modelId,
        durationMs: 0,
        status: 'error',
        errorClass: 'InvalidArguments',
        argsSummary:
          tool.categoryHint === 'computer_use'
            ? // The key names the model actually sent, which nothing else keeps.
              // Persisted arguments are the host's approval projection and the
              // model-facing record is the corrected one, so a call refused for
              // its shape left no trace of the shape it had — and diagnosing a
              // run where twenty of twenty-seven calls were refused had to
              // infer it from the wording of the refusal. Names only: a value
              // here can be typed text.
              `${summarizePersistedArgs(persistedArgs)} sent=${Object.keys(
                (executionArgs as Record<string, unknown> | null) ?? {},
              )
                .sort()
                .join(',')}`
            : summarizeArgs(tool.name, executionArgs),
        bytesIn: byteLength(persistedArgs),
        bytesOut: byteLength(msg),
        startedAt: now,
      });
      trace?.emit('tool', 'tool_failed', 'Tool arguments failed validation', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'InvalidArguments',
      });
      this.recordLoopGateOutcome(callSignature, true, boundaryKind);
      return this.errorReturn(msg);
    }

    // Loop-gate (#92): block this call up front — before the guards and the real
    // impl — if this exact call (tool + canonical args) has already FAILED
    // back-to-back the last (THRESHOLD-1) times. Re-running an identical failing
    // call cannot change the outcome; it only drains the turn. Checked first so a
    // tool that keeps failing the availability guard (not loaded) or permission
    // also trips it — those rejections count as failures (see
    // recordLoopGateOutcome). A success or any different call resets the streak,
    // so polling and iterate-then-retry are never gated. Recoverable: the model
    // is told to change its approach. The block itself records no outcome, so the
    // streak stays parked and every further identical repeat stays blocked.
    if (repeatedAmbiguousComputerTarget) {
      const reason = formatAmbiguousComputerLoopGateText();
      await refuseBeforeDispatch(reason);
      trace?.emit('tool', 'tool_failed', 'Blocked repeated ambiguous Computer Use target', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'AmbiguousComputerTarget',
      });
      return this.errorReturn(reason);
    }
    if (
      this.lastAmbiguousComputerSignature &&
      computerSemanticSignature &&
      computerSemanticSignature !== this.lastAmbiguousComputerSignature
    ) {
      this.lastAmbiguousComputerSignature = undefined;
    }
    if (repeatedFailedCall) {
      const reason = formatLoopGateText(tool.name);
      if (this.lastFailedToolCallBoundaryKind) {
        this.recordSandboxBoundaryFailure(
          this.lastFailedToolCallBoundaryKind,
          boundaryCorrectionStep,
          sandboxBoundaryDecisionGeneration,
        );
      }
      await refuseBeforeDispatch(reason, this.lastFailedToolCallBoundaryDetails);
      trace?.emit('tool', 'tool_failed', 'Loop-gate blocked a repeated identical failing call', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'LoopGate',
      });
      return this.errorReturn(reason);
    }

    // Tool-availability execute-boundary guard. Uses the step-start snapshot,
    // NOT the turn's live activation map: a tool_search result becomes callable
    // only on the next provider step.
    if (deferredToolNotLoaded) {
      const reason = formatDeferredNotLoadedText(tool.name);
      await refuseBeforeDispatch(reason);
      trace?.emit('tool', 'tool_failed', 'Deferred tool used before load', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'DeferredNotLoaded',
      });
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(reason);
    }

    let clientCapabilityBoundary: ExecutionBoundary | undefined;
    let preparedExecution: PreparedMakaToolExecution | undefined;
    if (tool.hostAdmission === 'client_capability') {
      try {
        clientCapabilityBoundary = await this.readExecutionBoundary();
      } catch (error) {
        const reason = formatSyntheticToolErrorText(error);
        await refuseBeforeDispatch(reason);
        trace?.emit('tool', 'tool_failed', 'Client Capability boundary read failed', {
          toolUseId,
          toolName: tool.name,
          status: 'error',
          errorClass: 'ExecutionBoundaryUnavailable',
        });
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
      const admissionFailure = !tool.prepareExecution
        ? CLIENT_CAPABILITY_PREPARATION_MESSAGE
        : clientCapabilityBoundary.kind !== 'bypass' && this.input.header.permissionMode !== 'ask'
          ? CLIENT_CAPABILITY_BOUNDARY_MESSAGE
          : undefined;
      if (admissionFailure) {
        await refuseBeforeDispatch(admissionFailure, {
          reason: 'requires_bypass',
          source: 'client_capability',
        });
        trace?.emit('tool', 'tool_failed', 'Client Capability blocked by execution boundary', {
          toolUseId,
          toolName: tool.name,
          status: 'error',
          errorClass: 'ClientCapabilityBoundary',
        });
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(admissionFailure);
      }
      // Narrowed by admissionFailure above; Bypass still prepares so the
      // provider cannot regain a direct pre-T1 dispatch path.
      const prepareExecution = tool.prepareExecution!;
      const pauseTarget = this.input.getPermissionPauseTarget();
      pauseTarget?.pause();
      try {
        preparedExecution = await prepareExecution(structuredClone(executionArgs) as never, {
          sessionId: this.input.sessionId,
          turnId,
          ...(runId ? { runId } : {}),
          cwd: this.input.header.cwd,
          executionBoundary: clientCapabilityBoundary,
          permissionMode: this.input.header.permissionMode,
          toolCallId: toolUseId,
          abortSignal: ctx.abortSignal,
        });
      } catch (error) {
        const reason = formatSyntheticToolErrorText(error);
        await refuseBeforeDispatch(reason);
        trace?.emit('tool', 'tool_failed', 'Client Capability preparation failed', {
          toolUseId,
          toolName: tool.name,
          status: 'error',
          errorClass: 'ClientCapabilityPreparation',
        });
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      } finally {
        pauseTarget?.resume();
      }
    }

    let managedMutationAdmission: RuntimeManagedMutationAdmission | undefined;
    if (tool.durableExecutionProfile === 'managed_mutation_v1') {
      if (
        (tool.name !== 'Write' && tool.name !== 'Edit') ||
        tool.recoveryMode !== 'reconcile' ||
        !tool.managedMutationTransform ||
        !dispatchOperationId ||
        !this.input.runtimeCommitSink ||
        !this.input.admitManagedMutation
      ) {
        const reason = 'Managed workspace mutation admission is unavailable before T1';
        await refuseBeforeDispatch(reason);
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
      try {
        managedMutationAdmission = await this.input.admitManagedMutation({
          operationId: dispatchOperationId,
          toolName: tool.name,
          persistedArgs: structuredClone(persistedArgs),
          abortSignal: ctx.abortSignal,
        });
      } catch (error) {
        const reason = `Managed workspace mutation admission failed: ${formatSyntheticToolErrorText(error)}`;
        await refuseBeforeDispatch(reason);
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
    }

    const reservedSubagentSlot = this.reserveSubagentSlot(tool);
    if (!reservedSubagentSlot) {
      await preparedExecution?.cancel();
      await disposeManagedMutationAdmission(managedMutationAdmission);
      trace?.emit('tool', 'tool_failed', 'Tool execution rejected by runtime limit', {
        toolUseId,
        toolName: tool.name,
        errorClass: 'RuntimeLimit',
        boundary: 'subagent_tool_admission',
      });
      await refuseBeforeDispatch(SUBAGENT_TOOL_LIMIT_MESSAGE);
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(SUBAGENT_TOOL_LIMIT_MESSAGE);
    }

    let durableAttempt: DurableToolAttempt | undefined;
    try {
      durableAttempt = await this.prepareDurableToolAttempt({
        tool,
        startEvent: buildCallEvent('dispatch'),
        persistedArgs,
        modelFacingArgs,
        abortSignal: ctx.abortSignal,
        ...(managedMutationAdmission
          ? { managedMutation: managedMutationAdmission.durableDispatch }
          : {}),
        ...(invocationId ? { invocationId } : {}),
        ...(runId ? { runId } : {}),
      });
    } catch (error) {
      await preparedExecution?.cancel();
      if (reservedSubagentSlot) this.releaseSubagentSlot(tool);
      await disposeManagedMutationAdmission(managedMutationAdmission);
      throw error;
    }
    await appendCallMessage();
    publishCallEvent(buildCallEvent('dispatch'));
    emitToolStartedTrace();
    if (durableAttempt) {
      this.durableToolAttempts.set(durableAttemptKey(turnId, toolUseId), durableAttempt);
    }
    const startedAt = this.input.now();
    const output = createToolOutputDeltaEmitter({
      sessionId: this.input.sessionId,
      turnId,
      toolUseId,
      newId: this.input.newId,
      now: this.input.now,
      push: (event) => queue.push(event),
      ...activityIdentity,
    });
    // Loop-gate outcome for the real impl. Default failed; the success path below
    // overwrites it from the derived result status, and the finally records it
    // once for every exit (return or throw). The pre-impl guards record their own
    // failures above, since they early-return before this point.
    let attemptFailed = true;
    let attemptBoundaryKind: SandboxBoundaryFailureKind | undefined;
    let attemptBoundaryDetails: SandboxBoundaryFailureDetails;
    try {
      // Pause the stream idle watchdog for the whole tool execution. In the
      // ai-sdk step loop a tool runs *between* model requests — the tool-call
      // step's stream already finished and the next request has not started —
      // so provider silence here is expected, not a stalled model stream. A
      // long-running tool (apt-get install, a build, an ML training step, a
      // subagent loop) must not trip the idle timeout and abort the whole
      // invocation; the tool carries its own timeout (e.g. Bash timeout_ms)
      // and the trial/run layer is the outer backstop.
      const pauseTarget = this.input.getPermissionPauseTarget();
      pauseTarget?.pause();
      try {
        const runId = this.input.runId;
        const executionBoundary = clientCapabilityBoundary ?? (await this.readExecutionBoundary());
        const toolContext: MakaToolContext = {
          sessionId: this.input.sessionId,
          turnId,
          ...(runId ? { runId } : {}),
          ...(this.input.orchestrationMode
            ? { orchestrationMode: this.input.orchestrationMode }
            : {}),
          cwd: this.input.header.cwd,
          executionBoundary,
          permissionMode: this.input.header.permissionMode,
          toolCallId: toolUseId,
          // The id the call event actually carries, not the candidate: by here
          // `prepareDurableToolAttempt` has pushed it on the dispatch lane.
          ...(callEvent?.operationId ? { operationId: callEvent.operationId } : {}),
          abortSignal: ctx.abortSignal,
          emitOutput: output.emit,
          emitProgress: (current, total) => {
            const chunk = encodeToolStepProgress({ current, total });
            if (!chunk) return;
            queue.push({
              type: 'tool_progress',
              id: this.input.newId(),
              turnId,
              ts: this.input.now(),
              toolUseId,
              chunk,
              ...activityIdentity,
            });
          },
          ...(trace
            ? {
                emitRunTrace: (
                  type:
                    | 'tool_started'
                    | 'tool_searched'
                    | 'tool_completed'
                    | 'tool_failed'
                    | 'skill_searched'
                    | 'skill_loaded'
                    | 'skill_load_failed',
                  message: string,
                  data?: Record<string, unknown>,
                ) =>
                  trace.emit(type.startsWith('skill_') ? 'skill' : 'tool', type, message, {
                    toolUseId,
                    toolName: tool.name,
                    ...(data ?? {}),
                  }),
              }
            : {}),
          ...(this.input.listChildAgents ? { listChildAgents: this.input.listChildAgents } : {}),
          ...(this.input.readChildAgentOutput
            ? { readChildAgentOutput: this.input.readChildAgentOutput }
            : {}),
          ...this.buildChildAgentContext({
            turnId,
            abortSignal: ctx.abortSignal,
            trace,
            toolUseId,
            toolName: tool.name,
            queue,
            activityIdentity,
          }),
          askUserQuestion: (questions) =>
            this.askUserQuestion(turnId, toolUseId, questions, ctx.abortSignal, queue),
          requestSandboxBoundary: (expansion, justification) =>
            this.requestSandboxBoundary(
              turnId,
              toolUseId,
              expansion,
              justification,
              ctx.abortSignal,
              queue,
            ),
        };
        const invokeTool = () =>
          preparedExecution
            ? preparedExecution.execute(toolContext)
            : tool.impl(structuredClone(executionArgs) as never, toolContext);
        const invokeManagedTransform = () =>
          tool.managedMutationTransform!(structuredClone(executionArgs) as never);
        const prepareOperationValue = async (
          immutableSnapshot = false,
        ): Promise<RuntimeManagedMutationOperationValue<unknown>> => {
          const rawResult = await (immutableSnapshot ? invokeManagedTransform() : invokeTool());
          const result = immutableSnapshot
            ? snapshotManagedToolResult(rawResult, ctx.maxResultBytes)
            : rawResult;
          if (
            !immutableSnapshot &&
            ctx.maxResultBytes !== undefined &&
            serializedByteLength(result, ctx.maxResultBytes) > ctx.maxResultBytes
          ) {
            throw new ToolResultLimitError();
          }
          const content = immutableSnapshot
            ? Object.freeze(coerceResultContent(result))
            : coerceResultContent(result);
          const projected = this.projectToolResult(tool, turnId, toolUseId, executionArgs, result);
          const modelProjection = isPromiseLike(projected) ? await projected : projected;
          const outcome = {
            content,
            isError: deriveToolResultStatus(content, result) !== 'success',
            durationMs: this.input.now() - startedAt,
            modelProjection,
          };
          const value = {
            result,
            outcome: immutableSnapshot ? Object.freeze(outcome) : outcome,
          };
          return immutableSnapshot ? Object.freeze(value) : value;
        };
        let settledExecution:
          | {
              kind: 'managed';
              value: RuntimeManagedMutationOperationValue<unknown>;
              durableOutcome: RuntimeEvent;
            }
          | { kind: 'generic'; value: RuntimeManagedMutationOperationValue<unknown> };
        if (managedMutationAdmission) {
          const operationLifecycle: {
            state: 'open' | 'running' | 'settled' | 'closed';
          } = { state: 'open' };
          let operationPromise: Promise<RuntimeManagedMutationOperationProof> | undefined;
          let runtimeOwnedValue: RuntimeManagedMutationOperationValue<unknown> | undefined;
          const executeManagedOperation = (): Promise<RuntimeManagedMutationOperationProof> => {
            if (operationLifecycle.state !== 'open') {
              if (operationLifecycle.state === 'closed') {
                return Promise.reject(new Error('Managed mutation operation capability is closed'));
              }
              return Promise.reject(
                new Error('Managed mutation owner invoked the operation more than once'),
              );
            }
            operationLifecycle.state = 'running';
            operationPromise = (async () => {
              try {
                const value = await prepareOperationValue(true);
                runtimeOwnedValue = value;
                return {
                  // The canonical content is already recursively immutable, so
                  // the owner can read it without receiving a mutable alias.
                  content: value.outcome.content,
                  isError: value.outcome.isError,
                  durationMs: value.outcome.durationMs,
                  modelProjection: value.outcome.modelProjection,
                };
              } finally {
                if (operationLifecycle.state === 'running') {
                  operationLifecycle.state = 'settled';
                }
              }
            })();
            // Runtime also observes the promise so a careless owner cannot
            // turn an un-awaited operation rejection into an unhandled one.
            void operationPromise.catch(() => undefined);
            return operationPromise;
          };
          let settlement: unknown;
          let ownerFailed = false;
          let ownerError: unknown;
          try {
            settlement = await managedMutationAdmission.execute(executeManagedOperation);
          } catch (error) {
            ownerFailed = true;
            ownerError = error;
          }
          const ownerSettledWhileOperationRunning = operationLifecycle.state === 'running';
          if (ownerSettledWhileOperationRunning) {
            try {
              await operationPromise;
            } catch {
              // The terminal state is invalid regardless of how the detached
              // operation settles. Join it so no side effect can occur later.
            } finally {
              operationLifecycle.state = 'closed';
            }
            throw new RuntimeManagedMutationUnsettledError(
              new Error('Managed mutation owner settled before the operation completed', {
                ...(ownerFailed ? { cause: ownerError } : {}),
              }),
            );
          }
          operationLifecycle.state = 'closed';
          if (ownerFailed) {
            // Once managed T1 is durable, an admission/owner failure may never
            // fall through to the generic synthetic T2 path. Only the owner can
            // prove that a successor was accepted or the candidate was safely
            // discarded; every other failure remains unsettled for recovery.
            throw new RuntimeManagedMutationUnsettledError(ownerError);
          }
          const normalized = normalizeManagedMutationSettlement(settlement, ctx.maxResultBytes);
          if (normalized.kind === 'workspace_successor_committed') {
            if (!runtimeOwnedValue) {
              throw new RuntimeManagedMutationUnsettledError(
                new Error(
                  'Managed mutation owner committed success without executing the operation',
                ),
              );
            }
            settledExecution = {
              kind: 'managed',
              value: runtimeOwnedValue,
              durableOutcome: normalized.durableOutcome,
            };
          } else {
            settledExecution = {
              kind: 'managed',
              value: normalized.value,
              durableOutcome: normalized.durableOutcome,
            };
          }
        } else {
          settledExecution = { kind: 'generic', value: await prepareOperationValue() };
        }
        const { result, outcome } = settledExecution.value;
        output.flush();
        const { content, durationMs, modelProjection } = outcome;
        // Keep the full provider-facing terminal classification. `isError` is
        // sufficient for the durable response envelope, but it intentionally
        // collapses `aborted` into an error bit and therefore cannot drive live
        // tool status, telemetry, or subagent lifecycle projection.
        const toolResultStatus = deriveToolResultStatus(content, result);
        let durableOutcome: { id: string; operationId: string; ts: number } | undefined;
        if (settledExecution.kind === 'managed') {
          if (!durableAttempt) {
            throw new RuntimeManagedMutationUnsettledError(
              new Error('Managed mutation settlement has no durable T1 attempt'),
            );
          }
          durableOutcome = durableAttempt.adoptCommittedOutcome(
            settledExecution.durableOutcome,
            content,
            outcome.isError,
            modelProjection,
            durationMs,
          );
        } else {
          durableOutcome = await durableAttempt?.commitOutcome(
            content,
            outcome.isError,
            modelProjection,
            durationMs,
          );
        }
        if (hasSandboxDenial(content)) {
          const denialKey = sandboxDenialKey(tool.name, this.input.header.cwd, executionArgs);
          this.recentSandboxDenials.add(denialKey);
          if (content.kind === 'terminal' || content.kind === 'shell_run') {
            this.recentSandboxDenials.add(
              sandboxDenialKey('Bash', this.input.header.cwd, {
                command: content.cmd,
              }),
            );
          }
          trace?.emit(
            'sandbox',
            'sandbox_denial_detected',
            'Command likely failed because of sandbox enforcement',
            {
              toolUseId,
              toolName: tool.name,
              commandHash: denialKey,
            },
          );
        }
        const resultMsg: ToolResultMessage = {
          type: 'tool_result',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          toolUseId,
          isError: toolResultStatus !== 'success',
          content,
          durationMs,
          ...activityIdentity,
        };
        await this.input.appendMessage(resultMsg);
        queue.push({
          type: 'tool_result',
          id: durableOutcome?.id ?? this.input.newId(),
          turnId,
          ts: durableOutcome?.ts ?? this.input.now(),
          toolUseId,
          ...(durableOutcome ? { operationId: durableOutcome.operationId } : {}),
          isError: toolResultStatus !== 'success',
          content,
          modelProjection,
          durationMs,
          ...activityIdentity,
        } satisfies ToolResultEvent);

        this.input.recordToolInvocation?.({
          sessionId: this.input.sessionId,
          turnId,
          toolCallId: toolUseId,
          toolName: tool.name,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          durationMs,
          status: toolResultStatus,
          argsSummary:
            tool.categoryHint === 'computer_use'
              ? summarizePersistedArgs(persistedArgs)
              : summarizeArgs(tool.name, executionArgs),
          resultSummary: summarizeToolResultForTelemetry(content),
          bytesIn: byteLength(persistedArgs),
          bytesOut: byteLength(result),
          startedAt,
        });
        trace?.emit('tool', 'tool_completed', 'Tool execution completed', {
          toolUseId,
          toolName: tool.name,
          durationMs,
          status: toolResultStatus,
          resultSummary: summarizeToolResultForTelemetry(content),
        });

        void recordToolArtifactsSafely(
          {
            sessionId: this.input.sessionId,
            turnId,
            toolUseId,
            toolName: tool.name,
            cwd: this.input.header.cwd,
            args: structuredClone(persistedArgs),
            result,
          },
          this.input.recordToolArtifacts,
          (message) => {
            queue.push({
              type: 'tool_progress',
              id: this.input.newId(),
              turnId,
              ts: this.input.now(),
              toolUseId,
              chunk: message,
              ...activityIdentity,
            });
          },
        );

        attemptFailed = toolResultStatus !== 'success';
        if (isAmbiguousComputerFailure(result)) {
          this.lastAmbiguousComputerSignature = computerSemanticSignature;
        } else if (computerSemanticSignature) {
          this.lastAmbiguousComputerSignature = undefined;
        }
        return result;
      } finally {
        pauseTarget?.resume();
      }
    } catch (err) {
      if (
        err instanceof RuntimeCommitBoundaryError ||
        err instanceof RuntimeManagedMutationUnsettledError
      ) {
        throw err;
      }
      // Admission exists only after the owner has selected managed mode and
      // Runtime has committed its T1 dispatch. From that point onward every
      // normalization, size check, adoption, publication, and telemetry error
      // is recovery-owned. It may never fall through to generic synthetic T2.
      if (managedMutationAdmission) {
        throw new RuntimeManagedMutationUnsettledError(err);
      }
      if (isInteractionControlError(err)) throw err;
      output.flush();
      const sandboxError = serializeSandboxError(err);
      attemptBoundaryKind = sandboxBoundaryFailureKind(sandboxError);
      attemptBoundaryDetails = sandboxBoundaryFailureSignal(sandboxError);
      if (attemptBoundaryKind) {
        this.recordSandboxBoundaryFailure(
          attemptBoundaryKind,
          boundaryCorrectionStep,
          sandboxBoundaryDecisionGeneration,
        );
      }
      const uncertainOutcome = uncertainOutcomeSignalFromError(err);
      const errorClass = uncertainOutcome ? 'OutcomeUnknown' : classifyError(err);
      const terminalFailure = coerceTerminalFailure(
        tool,
        this.input.header.cwd,
        executionArgs,
        err,
      );
      if (terminalFailure) {
        if (terminalFailure.sandboxDenied) {
          const denialKey = sandboxDenialKey(tool.name, this.input.header.cwd, executionArgs);
          this.recentSandboxDenials.add(denialKey);
          trace?.emit(
            'sandbox',
            'sandbox_denial_detected',
            'Command likely failed because of sandbox enforcement',
            {
              toolUseId,
              toolName: tool.name,
              commandHash: denialKey,
            },
          );
        }
        const durationMs = Math.max(0, this.input.now() - startedAt);
        const terminalResult = this.errorReturn(terminalFailure.message);
        const projected = this.projectToolResult(
          tool,
          turnId,
          toolUseId,
          executionArgs,
          terminalResult,
        );
        const modelProjection = isPromiseLike(projected) ? await projected : projected;
        const durableOutcome = await durableAttempt?.commitOutcome(
          terminalFailure.content,
          true,
          modelProjection,
          durationMs,
        );
        const resultMsg: ToolResultMessage = {
          type: 'tool_result',
          id: this.input.newId(),
          turnId,
          ts: this.input.now(),
          toolUseId,
          isError: true,
          content: terminalFailure.content,
          durationMs,
          ...activityIdentity,
        };
        await this.input.appendMessage(resultMsg);
        queue.push({
          type: 'tool_result',
          id: durableOutcome?.id ?? this.input.newId(),
          turnId,
          ts: durableOutcome?.ts ?? this.input.now(),
          toolUseId,
          ...(durableOutcome ? { operationId: durableOutcome.operationId } : {}),
          isError: true,
          content: terminalFailure.content,
          modelProjection,
          durationMs,
          ...activityIdentity,
        } satisfies ToolResultEvent);
        this.input.recordToolInvocation?.({
          sessionId: this.input.sessionId,
          turnId,
          toolCallId: toolUseId,
          toolName: tool.name,
          providerId: this.input.connection.providerType,
          modelId: this.input.modelId,
          durationMs,
          status: 'error',
          errorClass,
          argsSummary:
            tool.categoryHint === 'computer_use'
              ? summarizePersistedArgs(persistedArgs)
              : summarizeArgs(tool.name, executionArgs),
          resultSummary: summarizeToolResultForTelemetry(terminalFailure.content),
          bytesIn: byteLength(persistedArgs),
          bytesOut: byteLength(terminalFailure.content),
          startedAt,
        });
        trace?.emit('tool', 'tool_failed', 'Tool execution failed', {
          toolUseId,
          toolName: tool.name,
          durationMs,
          status: 'error',
          errorClass,
          ...(sandboxError ? { sandbox: sandboxError } : {}),
        });
        return terminalResult;
      }
      const msg =
        err instanceof ToolResultLimitError
          ? err.message
          : tool.categoryHint === 'computer_use'
            ? `Computer Use failed: ${errorClass}`
            : uncertainOutcome
              ? `outcome_unknown: ${formatSyntheticToolErrorText(err)}`
              : formatSyntheticToolErrorText(err);
      await this.writeSyntheticToolResult(
        toolUseId,
        turnId,
        tool.name,
        msg,
        queue,
        sandboxDenialSignalFromError(err),
        attemptBoundaryDetails,
        uncertainOutcome,
        activityIdentity,
        durableAttempt,
      );
      this.input.recordToolInvocation?.({
        sessionId: this.input.sessionId,
        turnId,
        toolCallId: toolUseId,
        toolName: tool.name,
        providerId: this.input.connection.providerType,
        modelId: this.input.modelId,
        durationMs: Math.max(0, this.input.now() - startedAt),
        status: 'error',
        errorClass,
        argsSummary:
          tool.categoryHint === 'computer_use'
            ? summarizePersistedArgs(persistedArgs)
            : summarizeArgs(tool.name, executionArgs),
        bytesIn: byteLength(persistedArgs),
        bytesOut: 0,
        startedAt,
      });
      trace?.emit('tool', 'tool_failed', 'Tool execution failed', {
        toolUseId,
        toolName: tool.name,
        durationMs: Math.max(0, this.input.now() - startedAt),
        status: 'error',
        errorClass,
        ...(sandboxError ? { sandbox: sandboxError } : {}),
      });
      return sandboxError ? { error: msg, sandbox: sandboxError } : this.errorReturn(msg);
    } finally {
      this.recordLoopGateOutcome(
        callSignature,
        attemptFailed,
        attemptBoundaryKind,
        attemptBoundaryDetails,
      );
      if (reservedSubagentSlot) this.releaseSubagentSlot(tool);
      await disposeManagedMutationAdmission(managedMutationAdmission);
    }
  }

  private async prepareDurableToolAttempt(input: {
    tool: MakaTool;
    startEvent: ToolStartEvent;
    persistedArgs: unknown;
    /** The projection the model replays as its own call. */
    modelFacingArgs: unknown;
    abortSignal: AbortSignal;
    managedMutation?: Readonly<RuntimeEventManagedWorkspaceMutationV2>;
    invocationId?: string;
    runId?: string;
  }): Promise<DurableToolAttempt | undefined> {
    const sink = this.input.runtimeCommitSink;
    if (!sink) return undefined;
    const runId = input.runId;
    const invocationId = input.invocationId;
    if (!runId) {
      throw new RuntimeCommitBoundaryError(
        'T1',
        new Error('Durable tool execution requires a run id'),
      );
    }
    if (!invocationId) {
      throw new RuntimeCommitBoundaryError(
        'T1',
        new Error('Durable tool execution requires an invocation id'),
      );
    }
    const operationId = input.startEvent.operationId;
    if (!operationId)
      throw new RuntimeCommitBoundaryError('T1', new Error('Tool start has no operation id'));
    const stateDelta: Record<string, unknown> = {};
    if (input.startEvent.activityKind !== undefined)
      stateDelta.activityKind = input.startEvent.activityKind;
    if (input.startEvent.displayName !== undefined)
      stateDelta.displayName = input.startEvent.displayName;
    if (input.startEvent.intent !== undefined) stateDelta.intent = input.startEvent.intent;
    const callEvent: RuntimeEvent = {
      id: input.startEvent.id,
      invocationId,
      runId,
      sessionId: this.input.sessionId,
      turnId: input.startEvent.turnId,
      ts: input.startEvent.ts,
      partial: false,
      role: 'model',
      author: 'agent',
      origin: input.startEvent.origin ?? 'provider',
      modelVisibility: input.startEvent.modelVisibility ?? 'visible',
      content: {
        kind: 'function_call',
        id: input.startEvent.toolUseId,
        name: input.tool.name,
        args: structuredClone(input.modelFacingArgs),
        ...(input.startEvent.providerOptions !== undefined
          ? { providerOptions: structuredClone(input.startEvent.providerOptions) }
          : {}),
      },
      refs: {
        operationId,
        toolCallId: input.startEvent.toolUseId,
        ...(input.startEvent.parentToolCallId
          ? { parentToolCallId: input.startEvent.parentToolCallId }
          : {}),
        ...(input.startEvent.parentOperationId
          ? { parentOperationId: input.startEvent.parentOperationId }
          : {}),
        ...(input.startEvent.stepId ? { stepId: input.startEvent.stepId } : {}),
      },
      ...(Object.keys(stateDelta).length > 0 ? { actions: { stateDelta } } : {}),
    };
    const canonicalArgsHash = canonicalToolArgsHash(input.tool.name, input.persistedArgs);
    const recoveryMode = input.tool.recoveryMode ?? 'never_auto_retry';
    const dispatchEvent: RuntimeEvent = {
      id: `${operationId}_dispatch`,
      invocationId,
      runId,
      sessionId: this.input.sessionId,
      turnId: input.startEvent.turnId,
      ts: input.startEvent.ts,
      partial: false,
      role: 'system',
      author: 'system',
      origin: input.startEvent.origin ?? 'provider',
      modelVisibility: input.startEvent.modelVisibility ?? 'visible',
      actions: {
        toolDispatch: {
          protocol: TOOL_BOUNDARY_PROTOCOL_V1,
          resultProjectionVersion: 1,
          operationId,
          providerToolCallId: input.startEvent.toolUseId,
          toolName: input.tool.name,
          canonicalArgsHash,
          recoveryMode,
          ...(input.managedMutation ? { managedMutation: input.managedMutation } : {}),
        },
      },
      refs: {
        operationId,
        toolCallId: input.startEvent.toolUseId,
        ...(input.startEvent.parentToolCallId
          ? { parentToolCallId: input.startEvent.parentToolCallId }
          : {}),
        ...(input.startEvent.parentOperationId
          ? { parentOperationId: input.startEvent.parentOperationId }
          : {}),
      },
    };
    try {
      if (input.managedMutation) {
        decodeRuntimeEvent(dispatchEvent);
        const persistedPath =
          input.persistedArgs &&
          typeof input.persistedArgs === 'object' &&
          !Array.isArray(input.persistedArgs)
            ? (input.persistedArgs as { path?: unknown }).path
            : undefined;
        if (
          (input.tool.name !== 'Write' && input.tool.name !== 'Edit') ||
          typeof persistedPath !== 'string' ||
          input.managedMutation.expectedPath !== persistedPath ||
          input.managedMutation.pathPolicyVersion !== 3 ||
          input.managedMutation.executionProfileDigest !==
            MANAGED_MUTATION_EXECUTION_PROFILE_V1_DIGEST
        ) {
          throw new Error('Managed mutation admission does not match the durable tool call');
        }
      }
      this.assertDurableDispatchNotAborted(input.tool.name, input.abortSignal);
      const prepared = await sink.commitToolPrepared({
        operationId,
        journalEventId: `${operationId}_prepared`,
        runtimeEvent: callEvent,
        dispatchRuntimeEvent: dispatchEvent,
        providerToolCallId: input.startEvent.toolUseId,
        toolName: input.tool.name,
        canonicalArgsHash,
        recoveryMode,
        committedAt: this.input.now(),
      });
      if (!prepared.created) {
        throw new Error(`Tool operation ${operationId} is already claimed`);
      }
    } catch (error) {
      throw new RuntimeCommitBoundaryError('T1', error);
    }
    const buildResponseEvent = (
      result: unknown,
      isError: boolean,
      modelProjection: DurableToolResultProjection,
      durationMs: number | undefined,
      ts: number,
    ): RuntimeEvent => ({
      id: `${operationId}_response`,
      invocationId,
      runId,
      sessionId: this.input.sessionId,
      turnId: input.startEvent.turnId,
      ts,
      partial: false,
      role: 'tool',
      author: 'tool',
      origin: input.startEvent.origin ?? 'provider',
      modelVisibility: input.startEvent.modelVisibility ?? 'visible',
      content: {
        kind: 'function_response',
        id: input.startEvent.toolUseId,
        name: input.tool.name,
        result,
        ...(isError ? { isError: true } : {}),
        modelProjection,
      },
      refs: {
        operationId,
        toolCallId: input.startEvent.toolUseId,
        ...(input.startEvent.parentToolCallId
          ? { parentToolCallId: input.startEvent.parentToolCallId }
          : {}),
        ...(input.startEvent.parentOperationId
          ? { parentOperationId: input.startEvent.parentOperationId }
          : {}),
      },
      ...(durationMs !== undefined ? { actions: { stateDelta: { durationMs } } } : {}),
    });
    let committedOutcome: { id: string; operationId: string; ts: number } | undefined;
    return {
      operationId,
      responseEventId: `${operationId}_response`,
      commitOutcome: async (result, isError, modelProjection, durationMs) => {
        if (committedOutcome) return committedOutcome;
        const responseEvent = buildResponseEvent(
          result,
          isError,
          modelProjection,
          durationMs,
          this.input.now(),
        );
        try {
          await sink.commitToolOutcome({
            operationId,
            journalEventId: `${operationId}_outcome`,
            runtimeEvent: responseEvent,
            committedAt: responseEvent.ts,
          });
        } catch (error) {
          throw new RuntimeCommitBoundaryError('T2', error);
        }
        committedOutcome = {
          id: responseEvent.id,
          operationId,
          ts: responseEvent.ts,
        };
        this.durableToolAttempts.delete(
          durableAttemptKey(input.startEvent.turnId, input.startEvent.toolUseId),
        );
        return committedOutcome;
      },
      adoptCommittedOutcome: (event, result, isError, modelProjection, durationMs) => {
        if (committedOutcome) return committedOutcome;
        const expected = buildResponseEvent(result, isError, modelProjection, durationMs, event.ts);
        if (!Number.isFinite(event.ts) || !isDeepStrictEqual(event, expected)) {
          throw new RuntimeCommitBoundaryError(
            'T2',
            new Error('Managed mutation settlement returned a mismatched durable outcome'),
          );
        }
        committedOutcome = { id: event.id, operationId, ts: event.ts };
        this.durableToolAttempts.delete(
          durableAttemptKey(input.startEvent.turnId, input.startEvent.toolUseId),
        );
        return committedOutcome;
      },
    };
  }

  private admitToolForStep(tool: MakaTool, stepId: string | undefined): string | undefined {
    if (!stepId) return undefined;
    const existing = this.stepAdmissions.get(stepId) ?? { callCount: 0 };
    const exclusive = tool.executionSemantics === 'exclusive_step';
    if (existing.exclusiveToolName) {
      // Say first that nothing happened. A model reading only "cannot share a
      // step" cannot tell a refusal apart from a failure and may re-send a call
      // that did run.
      return `Tool ${tool.name} did not run: ${existing.exclusiveToolName} cannot share an assistant step with other tool calls. Send ${tool.name} again in a later step.`;
    }
    if (exclusive && existing.callCount > 0) {
      return `Tool ${tool.name} did not run: it cannot share an assistant step with other tool calls. Send ${tool.name} again in a step where it is the only call.`;
    }
    existing.callCount += 1;
    if (exclusive) existing.exclusiveToolName = tool.name;
    this.stepAdmissions.set(stepId, existing);
    return undefined;
  }

  private assertDurableDispatchNotAborted(toolName: string, abortSignal: AbortSignal): void {
    if (!abortSignal.aborted) return;
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error(`Tool ${toolName} was cancelled before durable dispatch`);
  }

  private reserveSubagentSlot(tool: MakaTool): boolean {
    if (tool.categoryHint !== 'subagent') return true;
    if (this.activeSubagentToolCount >= MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN) return false;
    this.activeSubagentToolCount += 1;
    return true;
  }

  private releaseSubagentSlot(tool: MakaTool): void {
    if (tool.categoryHint !== 'subagent') return;
    this.activeSubagentToolCount = Math.max(0, this.activeSubagentToolCount - 1);
  }

  private errorReturn(message: string): unknown {
    return { error: message };
  }

  private buildChildAgentContext(input: {
    turnId: string;
    abortSignal: AbortSignal;
    trace: RunTraceLike | null;
    toolUseId: string;
    toolName: string;
    queue: DurableSessionEventSink;
    activityIdentity: {
      origin?: 'provider' | 'code_mode';
      modelVisibility?: 'visible' | 'hidden';
      parentToolCallId?: string;
      parentOperationId?: string;
    };
  }): Pick<MakaToolContext, 'spawnChildSession'> {
    const parentRunId = this.input.runId;
    if (!parentRunId) return {};
    const limiter = this.childAgentRunLimiter;
    const runWithPermit = async <T>(
      abortSignal: AbortSignal,
      execute: () => Promise<T>,
    ): Promise<T> => {
      const waitingForPermit = limiter.activeCount >= limiter.capacity || limiter.waitingCount > 0;
      if (waitingForPermit) {
        input.trace?.emit('tool', 'tool_started', 'Child run waiting for shared runtime capacity', {
          toolUseId: input.toolUseId,
          toolName: input.toolName,
          boundary: 'shared_child_run_permit',
          stage: 'waiting',
          mode: 'spawn_session',
          activeChildRuns: limiter.activeCount,
          waitingChildRuns: limiter.waitingCount + 1,
          capacity: limiter.capacity,
        });
      }
      let permit;
      try {
        permit = await limiter.acquire(abortSignal);
      } catch (error) {
        input.trace?.emit(
          'tool',
          'tool_failed',
          'Child run did not acquire shared runtime capacity',
          {
            toolUseId: input.toolUseId,
            toolName: input.toolName,
            boundary: 'shared_child_run_permit',
            stage: 'cancelled_while_waiting',
            mode: 'spawn_session',
            status: abortSignal.aborted ? 'aborted' : 'error',
          },
        );
        throw error;
      }
      const childStartedAt = this.input.now();
      input.trace?.emit('tool', 'tool_started', 'Child run execution started', {
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        boundary: 'child_run_execution',
        stage: 'started',
        mode: 'spawn_session',
        waitedForPermit: waitingForPermit,
        activeChildRuns: limiter.activeCount,
        waitingChildRuns: limiter.waitingCount,
        capacity: limiter.capacity,
      });
      try {
        if (abortSignal.aborted) {
          throw abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error('Child agent run cancelled before it started');
        }
        const result = await execute();
        input.trace?.emit('tool', 'tool_completed', 'Child run execution completed', {
          toolUseId: input.toolUseId,
          toolName: input.toolName,
          boundary: 'child_run_execution',
          stage: 'completed',
          mode: 'spawn_session',
          status: 'success',
          durationMs: Math.max(0, this.input.now() - childStartedAt),
        });
        return result;
      } catch (error) {
        input.trace?.emit('tool', 'tool_failed', 'Child run execution failed', {
          toolUseId: input.toolUseId,
          toolName: input.toolName,
          boundary: 'child_run_execution',
          stage: 'completed',
          mode: 'spawn_session',
          status: abortSignal.aborted ? 'aborted' : 'error',
          durationMs: Math.max(0, this.input.now() - childStartedAt),
        });
        throw error;
      } finally {
        permit.release();
      }
    };

    const spawnChildSession = this.input.spawnChildSession;
    return {
      ...(spawnChildSession
        ? {
            spawnChildSession: async (spawnInput) => {
              const abortSignal = composeChildAbortSignal(
                input.abortSignal,
                spawnInput.abortSignal,
              );
              return await runWithPermit(
                abortSignal,
                async () =>
                  await spawnChildSession({
                    parentRunId,
                    parentTurnId: input.turnId,
                    toolCallId: input.toolUseId,
                    agentProfile: spawnInput.agentProfile,
                    ...(spawnInput.subagentId ? { subagentId: spawnInput.subagentId } : {}),
                    prompt: spawnInput.prompt,
                    ...(spawnInput.swarm ? { swarm: spawnInput.swarm } : {}),
                    abortSignal,
                    onReady: async (ready) => {
                      // Live-only Open for linked agent_spawn while the tool
                      // is still in flight. Terminal outcome remains tool_result.
                      input.queue.push({
                        type: 'tool_result_preview',
                        id: this.input.newId(),
                        turnId: input.turnId,
                        ts: this.input.now(),
                        toolUseId: input.toolUseId,
                        isError: false,
                        content: {
                          kind: 'subagent',
                          childSessionId: ready.childSessionId,
                          agentId: ready.agentId,
                          agentName: ready.agentName,
                          turnId: ready.turnId,
                          runId: ready.runId,
                          status: 'running',
                          permissionMode: ready.permissionMode,
                        } satisfies ToolResultPreviewContent,
                        ...input.activityIdentity,
                      });
                      await spawnInput.onReady?.(ready);
                    },
                    ...(spawnInput.onEvent ? { onEvent: spawnInput.onEvent } : {}),
                  }),
              );
            },
          }
        : {}),
    };
  }

  private async askUserQuestion(
    turnId: string,
    toolUseId: string,
    questions: UserQuestion[],
    abortSignal: AbortSignal,
    queue: DurableSessionEventSink,
  ): Promise<UserQuestionResult> {
    throwIfAborted(abortSignal);
    const hostedRun = this.interactionRun();
    const requestId = this.input.newId();
    const parked = this.userQuestions.park(requestId, {
      toolUseId,
      questions,
      hosted: hostedRun !== undefined,
    });
    const onAbort = (): void => {
      if (hostedRun) return;
      this.userQuestions.reject(requestId, abortErrorFromSignal(abortSignal));
      this.finishDeferredQuestionTurnClosure();
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (hostedRun) void parked.catch(() => undefined);
    try {
      const request: UserQuestionRequestEvent = {
        type: 'user_question_request',
        id: this.input.newId(),
        turnId,
        ts: this.input.now(),
        requestId,
        toolUseId,
        questions,
      };
      if (hostedRun) {
        const settlement = this.createUserQuestionSettlement(turnId, requestId);
        const admission = hostedRun.admitUserQuestionRequest({ request, settlement });
        try {
          await racePromiseWithAbort(admission, abortSignal);
        } catch (error) {
          if (abortSignal.aborted) {
            void admission.catch((admissionError) => {
              this.userQuestions.reject(
                requestId,
                admissionError instanceof Error
                  ? admissionError
                  : new RuntimeInteractionFailStopError(
                      `Could not confirm admission for question ${requestId}`,
                      admissionError,
                    ),
              );
              this.finishDeferredQuestionTurnClosure();
            });
            throw abortErrorFromSignal(abortSignal);
          }
          this.userQuestions.reject(
            requestId,
            error instanceof Error
              ? error
              : new RuntimeInteractionFailStopError(
                  `Could not confirm admission for question ${requestId}`,
                  error,
                ),
          );
          this.finishDeferredQuestionTurnClosure();
          await parked.catch(() => undefined);
          throw interactionAuthorityError(
            `Could not confirm admission for question ${requestId}`,
            error,
          );
        }
      }
      throwIfAborted(abortSignal);
      queue.push(request);
      const response = await racePromiseWithAbort(parked, abortSignal);
      throwIfAborted(abortSignal);
      const answerAck = {
        type: 'user_question_answer_ack',
        id: this.input.newId(),
        turnId,
        ts: this.input.now(),
        requestId,
        toolUseId,
      } as const;
      if (hostedRun) await this.publishHostedSettlementAck(queue, answerAck);
      else queue.push(answerAck);
      return {
        answers: questions.map((question, index) => ({
          question: question.question,
          answer: response.answers[index] ?? null,
        })),
      };
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  private async requestSandboxBoundary(
    turnId: string,
    toolUseId: string,
    expansion: SandboxBoundaryExpansion,
    justification: string,
    abortSignal: AbortSignal,
    queue: DurableSessionEventSink,
  ): Promise<SandboxBoundarySettlement> {
    throwIfAborted(abortSignal);
    if (this.sandboxBoundaryFinalizationRequested) {
      throw new SandboxCommandError({
        domain: 'command',
        stage: 'validation',
        reason: 'invalid_boundary_declaration',
        recoverable: false,
        message: 'Sandbox boundary negotiation is closed for this Turn.',
      });
    }
    if (this.sandboxBoundaryDenied) {
      this.sandboxBoundaryFinalizationRequested = true;
      throw new SandboxCommandError({
        domain: 'command',
        stage: 'validation',
        reason: 'invalid_boundary_declaration',
        recoverable: false,
        message: SANDBOX_BOUNDARY_DENIED_FOR_TURN,
      });
    }
    if (this.sandboxBoundaryRequestInFlight) {
      throw new SandboxCommandError({
        domain: 'command',
        stage: 'validation',
        reason: 'invalid_boundary_declaration',
        recoverable: true,
        message: 'A sandbox boundary request is already pending for this Turn.',
      });
    }
    this.sandboxBoundaryRequestInFlight = true;
    try {
      return await this.performSandboxBoundaryRequest(
        turnId,
        toolUseId,
        expansion,
        justification,
        abortSignal,
        queue,
      );
    } finally {
      this.sandboxBoundaryRequestInFlight = false;
    }
  }

  private async performSandboxBoundaryRequest(
    turnId: string,
    toolUseId: string,
    expansion: SandboxBoundaryExpansion,
    justification: string,
    abortSignal: AbortSignal,
    queue: DurableSessionEventSink,
  ): Promise<SandboxBoundarySettlement> {
    const hostedRun = this.interactionRun();
    if (
      !hostedRun &&
      (!this.input.createSandboxBoundaryRequest || !this.input.settleSandboxBoundaryRequest)
    ) {
      // This is the sentence a model actually reads. `sandbox-boundary-tool.ts`
      // guards the same condition, but ToolRuntime injects the callback
      // unconditionally a few lines above, so that guard answers only an
      // embedder that builds its own context — never a production tool call.
      //
      // This remains part of the embedding API. Runtime Host supplies the
      // interaction capability for production clients, while an embedder can
      // still construct ToolRuntime without one.
      throw new SandboxCommandError({
        domain: 'command',
        stage: 'validation',
        reason: 'invalid_boundary_declaration',
        recoverable: false,
        message: SANDBOX_BOUNDARY_UNAVAILABLE,
      });
    }
    let normalized: SandboxBoundaryExpansion;
    try {
      normalized = await racePromiseWithAbort(
        normalizeSandboxBoundaryExpansion(expansion, this.input.header.cwd),
        abortSignal,
      );
    } catch (error) {
      if (!(error instanceof SandboxBoundaryDeclarationError)) throw error;
      throw new SandboxCommandError({
        domain: 'command',
        stage: 'validation',
        reason: 'invalid_boundary_declaration',
        recoverable: true,
        message: error.message,
      });
    }
    const normalizedJustification = typeof justification === 'string' ? justification.trim() : '';
    if (typeof justification !== 'string' || normalizedJustification.length === 0) {
      throw new SandboxCommandError({
        domain: 'command',
        stage: 'validation',
        reason: 'invalid_boundary_declaration',
        recoverable: true,
        message: 'Sandbox boundary justification must not be empty.',
      });
    }
    const requestId = this.input.newId();
    const requestEvent: SandboxBoundaryRequestEvent = {
      type: 'sandbox_boundary_request',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      requestId,
      toolUseId,
      justification: normalizedJustification,
      expansion: normalized,
    };
    let creation: Promise<SandboxBoundaryRequest> | undefined;
    if (!hostedRun) {
      // Embedded execution publishes the canonical row directly. Hosted
      // execution delegates both preflight and publication to the Host so a
      // rejected admission cannot leave an ownerless pending row behind.
      const runId = this.input.runId;
      creation = this.input.createSandboxBoundaryRequest!({
        sessionId: this.input.sessionId,
        requestId,
        turnId,
        ...(runId ? { runId } : {}),
        expansion: normalized,
        justification: normalizedJustification,
      });
    }
    const parked = this.sandboxBoundaryRequests.park(requestId, {
      toolUseId,
      ...(creation ? { creation } : {}),
      hosted: hostedRun !== undefined,
    });
    void parked.catch(() => undefined);
    let abortDeny: Promise<void> | undefined;
    const onAbort = (): void => {
      if (hostedRun) return;
      const wasPending = this.sandboxBoundaryRequests.has(requestId);
      this.sandboxBoundaryRequests.reject(requestId, abortErrorFromSignal(abortSignal));
      if (wasPending && creation) {
        // Embedded execution owns both the local wait and its durable row.
        abortDeny = creation.then(() =>
          this.input.settleSandboxBoundaryRequest!({
            sessionId: this.input.sessionId,
            requestId,
            decision: 'deny',
          }).then(() => undefined),
        );
      }
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      if (creation) {
        try {
          await racePromiseWithAbort(creation, abortSignal);
        } catch (error) {
          this.sandboxBoundaryRequests.reject(
            requestId,
            error instanceof Error ? error : new Error(String(error)),
          );
          throw error;
        }
      }
      if (hostedRun) {
        const settlement = this.createSandboxBoundarySettlement(turnId, requestId);
        const admission = hostedRun.admitSandboxBoundaryRequest({
          request: requestEvent,
          settlement,
        });
        try {
          await racePromiseWithAbort(admission, abortSignal);
        } catch (error) {
          if (abortSignal.aborted) {
            void admission.catch((admissionError) => {
              this.sandboxBoundaryRequests.reject(
                requestId,
                admissionError instanceof Error
                  ? admissionError
                  : new RuntimeInteractionFailStopError(
                      `Could not confirm admission for sandbox boundary ${requestId}`,
                      admissionError,
                    ),
              );
              this.finishDeferredSandboxBoundaryTurnClosure();
            });
            throw abortErrorFromSignal(abortSignal);
          }
          this.sandboxBoundaryRequests.reject(
            requestId,
            error instanceof Error
              ? error
              : new RuntimeInteractionFailStopError(
                  `Could not confirm admission for sandbox boundary ${requestId}`,
                  error,
                ),
          );
          this.finishDeferredSandboxBoundaryTurnClosure();
          await parked.catch(() => undefined);
          throw interactionAuthorityError(
            `Could not confirm admission for sandbox boundary ${requestId}`,
            error,
          );
        }
      }
      throwIfAborted(abortSignal);
      queue.push(requestEvent);
      const settlement = await racePromiseWithAbort(parked, abortSignal);
      throwIfAborted(abortSignal);
      const decisionAck: SandboxBoundaryDecisionAckEvent = {
        type: 'sandbox_boundary_decision_ack',
        id: this.input.newId(),
        turnId,
        ts: this.input.now(),
        requestId,
        toolUseId,
        decision: settlement.request.status === 'denied' ? 'deny' : 'allow',
        status:
          settlement.request.status === 'pending'
            ? (() => {
                throw new Error(`Sandbox boundary request ${requestId} is still pending`);
              })()
            : settlement.request.status,
        revision: settlement.boundary.revision,
      };
      if (hostedRun) await this.publishHostedSettlementAck(queue, decisionAck);
      else queue.push(decisionAck);
      if (settlement.request.status === 'denied') {
        this.sandboxBoundaryDecisionGeneration += 1;
        this.sandboxBoundaryDenied = true;
      } else if (settlement.request.status === 'approved') {
        this.sandboxBoundaryDecisionGeneration += 1;
        this.sandboxBoundaryDenied = false;
        this.resetSandboxBoundaryFailureRounds();
      } else {
        this.recordSandboxBoundaryFailure('unresolved', `request:${requestId}`);
      }
      return settlement;
    } finally {
      abortSignal.removeEventListener('abort', onAbort);
      if (abortDeny) await abortDeny;
    }
  }

  private interactionRun(): HostedInteractionBridge | undefined {
    return this.hostedInteraction;
  }

  private async publishHostedSettlementAck(
    queue: DurableSessionEventSink,
    event: SessionEvent,
  ): Promise<void> {
    try {
      await queue.pushAndWaitUntilConsumed(event);
    } catch (error) {
      throw new RuntimeInteractionFailStopError(
        `Could not durably acknowledge hosted ${event.type}`,
        error,
      );
    }
  }

  private finishDeferredQuestionTurnClosure(): void {
    const turnId = this.turnId;
    if (!this.questionClosureDeferred || this.userQuestions.pendingCount() !== 0) {
      return;
    }
    this.questionClosureDeferred = false;
    this.userQuestions.close(
      (requestId) =>
        new RuntimeInteractionInvariantError(
          `Hosted question ${requestId} escaped exact Run closure`,
        ),
    );
  }

  private finishDeferredSandboxBoundaryTurnClosure(): void {
    const turnId = this.turnId;
    if (!this.sandboxBoundaryClosureDeferred || this.sandboxBoundaryRequests.pendingCount() !== 0) {
      return;
    }
    this.sandboxBoundaryClosureDeferred = false;
    this.sandboxBoundaryRequests.close(
      (requestId) =>
        new RuntimeInteractionInvariantError(
          `Hosted sandbox boundary ${requestId} escaped exact Run closure`,
        ),
    );
  }

  private createSandboxBoundarySettlement(
    turnId: string,
    requestId: string,
  ): HostedSandboxBoundarySettlement {
    return Object.freeze({
      applyDecision: async (settlement: SandboxBoundarySettlement): Promise<void> => {
        if (
          settlement.request.sessionId !== this.input.sessionId ||
          settlement.request.requestId !== requestId
        ) {
          throw new RuntimeInteractionInvariantError(
            `Sandbox boundary settlement ${requestId} changed identity`,
          );
        }
        if (this.sandboxBoundaryRequests.resolve(requestId, settlement) === null) {
          throw new RuntimeInteractionInvariantError(
            `Sandbox boundary settlement did not take ${requestId} from turn ${turnId}`,
          );
        }
        this.finishDeferredSandboxBoundaryTurnClosure();
      },
      applyClosure: async (reason: RuntimeUserQuestionClosureReason): Promise<void> => {
        if (
          this.sandboxBoundaryRequests.reject(
            requestId,
            new RuntimeInteractionClosedError(requestId, reason),
          ) === null
        ) {
          throw new RuntimeInteractionInvariantError(
            `Sandbox boundary closure did not take ${requestId} from turn ${turnId}`,
          );
        }
        this.finishDeferredSandboxBoundaryTurnClosure();
      },
    });
  }

  private createUserQuestionSettlement(
    turnId: string,
    requestId: string,
  ): HostedUserQuestionSettlement {
    return Object.freeze({
      applyAnswer: async (answer: HostedUserQuestionAnswer): Promise<void> => {
        if (Object.hasOwn(answer, 'requestId')) {
          throw new RuntimeInteractionInvariantError(
            `Question settlement ${requestId} received a routed answer`,
          );
        }
        const pending = this.userQuestions
          .entries()
          .find(([candidateId]) => candidateId === requestId)?.[1];
        if (
          !pending ||
          !this.settleUserQuestionAnswer(
            turnId,
            { requestId, answers: [...answer.answers] },
            pending,
          )
        ) {
          throw new RuntimeInteractionInvariantError(
            `Question settlement did not take ${requestId} from turn ${turnId}`,
          );
        }
      },
      applyClosure: async (reason: RuntimeUserQuestionClosureReason): Promise<void> => {
        if (!this.closeUserQuestion(turnId, requestId, reason)) {
          throw new RuntimeInteractionInvariantError(
            `Question closure did not take ${requestId} from turn ${turnId}`,
          );
        }
      },
    });
  }
}

async function validateDeclaredToolArgs(parameters: unknown, args: unknown): Promise<void> {
  if (!parameters || (typeof parameters !== 'object' && typeof parameters !== 'function')) {
    return;
  }
  const schema = parameters as {
    safeParseAsync?: (
      value: unknown,
    ) => PromiseLike<{ success: true; data: unknown } | { success: false; error: unknown }>;
    safeParse?: (
      value: unknown,
    ) => { success: true; data: unknown } | { success: false; error: unknown };
    validate?: (
      value: unknown,
    ) =>
      | { success: true; value: unknown }
      | { success: false; error: unknown }
      | PromiseLike<{ success: true; value: unknown } | { success: false; error: unknown }>;
    '~standard'?: {
      validate?: (
        value: unknown,
      ) =>
        | { value: unknown }
        | { issues: readonly unknown[] }
        | PromiseLike<{ value: unknown } | { issues: readonly unknown[] }>;
    };
  };

  if (typeof schema.safeParseAsync === 'function') {
    const parsed = await schema.safeParseAsync(args);
    if (parsed.success) return;
    throw parsed.error;
  }
  if (typeof schema.safeParse === 'function') {
    const parsed = schema.safeParse(args);
    if (parsed.success) return;
    throw parsed.error;
  }
  if (typeof schema.validate === 'function') {
    const parsed = await schema.validate(args);
    if (parsed.success) return;
    throw parsed.error;
  }
  if (typeof schema['~standard']?.validate === 'function') {
    const parsed = await schema['~standard'].validate(args);
    if ('value' in parsed) return;
    throw new Error('Tool arguments failed declared schema validation', { cause: parsed.issues });
  }
}

function isInteractionControlError(error: unknown): boolean {
  return (
    error instanceof RuntimeInteractionAdmissionRejectedError ||
    error instanceof RuntimeInteractionClosedError ||
    error instanceof RuntimeInteractionInvariantError ||
    error instanceof RuntimeInteractionFailStopError
  );
}

function interactionAuthorityError(message: string, error: unknown): Error {
  return isInteractionControlError(error)
    ? (error as Error)
    : new RuntimeInteractionFailStopError(message, error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortErrorFromSignal(signal);
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error =
    reason instanceof Error
      ? new Error(reason.message, { cause: reason })
      : new Error(typeof reason === 'string' ? reason : 'Operation aborted', {
          ...(reason !== undefined ? { cause: reason } : {}),
        });
  error.name = 'AbortError';
  return error;
}

function racePromiseWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortErrorFromSignal(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortErrorFromSignal(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Recoverable message returned when a searchable tool is invoked before it is
 * active in the current step snapshot.
 */
export function formatDeferredNotLoadedText(toolName: string): string {
  return (
    `Tool "${toolName}" is available but not loaded yet. ` +
    `Call tool_search to activate it first, then call "${toolName}" on a later step.`
  );
}

/**
 * Canonical key for a tool call's args; order-independent so identical calls
 * match. Hashed, not the raw args, so large Write/Edit payloads are not retained
 * (only the last signature is kept per turn). Args that cannot be canonicalized
 * (cyclic / throwing getters — impossible for JSON tool args, but be safe) fall
 * back to the unique call id, so distinct calls never collapse into one signature
 * and trip a false block, and no raw args are retained.
 */
function loopGateArgsKey(args: unknown, callId: string): string {
  try {
    return stableHash(args ?? null);
  } catch {
    return `unhashable:${callId}`;
  }
}

function computerUseSemanticSignature(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  if (
    record.action !== 'click_element' &&
    record.action !== 'set_value' &&
    record.action !== 'select_text' &&
    record.action !== 'secondary_action'
  )
    return undefined;
  try {
    const elementIdentity = stableElementIdentity(record.element_identity);
    return stableHash({
      action: record.action,
      app: record.app,
      window_id: record.window_id,
      ...(elementIdentity === undefined
        ? { element_id: record.element_id }
        : { element_identity: elementIdentity }),
      value: record.value,
      text: record.text,
    });
  } catch {
    return undefined;
  }
}

function stableElementIdentity(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    role: record.role,
    label: record.label,
    value: record.value,
    frame: record.frame,
  };
}

/**
 * Recoverable message returned when the loop-gate blocks a repeated identical
 * failing call. Tells the model the retry is pointless and to change its approach.
 */
export function formatLoopGateText(toolName: string): string {
  return (
    `Blocked: this exact ${toolName} call (identical arguments) has already failed ` +
    `repeatedly with no change between attempts, so it was not run again — the result ` +
    `would be the same. Change the arguments or take a different step (for example ` +
    `Read the file or inspect the relevant state) before retrying.`
  );
}

export function formatAmbiguousComputerLoopGateText(): string {
  return (
    'Blocked: this Computer Use semantic target was already rejected as ambiguous ' +
    'after a fresh observation. Do not retry the same element identity or guess ' +
    'between duplicates; choose a uniquely identified target or stop.'
  );
}

export function formatSyntheticToolErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(raw || 'Tool failed');
  if (redacted.length <= TOOL_ERROR_RESULT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, TOOL_ERROR_RESULT_MAX_CHARS - 1)}…`;
}

function stringKeys(shape: object): string[] {
  return Object.keys(shape).filter((key) => key.length > 0);
}

/**
 * The argument names one call to this tool accepts, or undefined when the
 * schema cannot answer that question for the call at hand.
 *
 * Computer Use learned this the expensive way: a refusal that named only what
 * was wrong left the model re-sending the same wrong shape, twenty times in a
 * twenty-seven call run. Every other tool refuses the same way, and every other
 * tool also carries the answer in its own schema.
 *
 * Undefined and `[]` are different answers and callers must keep them apart:
 * `[]` means the schema says this call takes nothing, undefined means the
 * schema was not readable here — a union with no resolvable branch, a provider
 * schema that is not a plain object. Rendering undefined as an empty list would
 * tell a model its call takes no arguments when in fact nothing is known.
 *
 * Names only, never values: these arguments carry file contents, shell
 * commands and typed text. Field names are the model's own input vocabulary.
 */
export function toolParameterFields(
  parameters: unknown,
  args?: unknown,
  categoryHint?: string,
): string[] | undefined {
  // Computer Use is one flat `z.object` standing in for a per-action union,
  // because a function-tool JSON schema has to have an object at the top. Its
  // shape therefore names every field of every action, and reading it here
  // broke the policy stated below in the one place it matters most: a model
  // whose `click_element` had a camelCase key was told `maka_computer` takes
  // `menu`, `duration` and `region`, added one, and was refused again. The
  // strict union knows which fields go with which action, and answers
  // undefined — say nothing — for an action it does not recognise.
  if (categoryHint === 'computer_use') {
    return computerActionFields((args as { action?: unknown } | undefined)?.action);
  }
  try {
    return readSchemaFields(parameters, args);
  } catch {
    // Schemas are third-party objects with getters; an unreadable one degrades
    // to "no field list", never to a wrong one.
    return undefined;
  }
}

function readSchemaFields(schema: unknown, args: unknown): string[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const candidate = schema as {
    shape?: unknown;
    options?: unknown;
    jsonSchema?: unknown;
    _zod?: { def?: { discriminator?: unknown } };
  };
  // z.object(...), including one carrying .refine()/.superRefine() checks —
  // those keep the object type in Zod 4 and so keep .shape.
  if (candidate.shape && typeof candidate.shape === 'object') {
    return stringKeys(candidate.shape as object);
  }
  if (Array.isArray(candidate.options)) {
    const discriminator = candidate._zod?.def?.discriminator;
    // A plain union has no key that says which branch was meant. Merging the
    // branches would advertise combinations the schema rejects, so say nothing.
    if (typeof discriminator !== 'string') return undefined;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
    const selector = (args as Record<string, unknown>)[discriminator];
    if (selector === undefined) return undefined;
    for (const option of candidate.options) {
      const optionShape = (option as { shape?: unknown }).shape;
      if (!optionShape || typeof optionShape !== 'object') continue;
      const literal = (optionShape as Record<string, { value?: unknown }>)[discriminator];
      if (literal?.value === selector) return stringKeys(optionShape as object);
    }
    // The discriminator itself is wrong; which branch was meant is unknown.
    return undefined;
  }
  // Provider schemas (MCP tools and anything declared through `jsonSchema`).
  const json = candidate.jsonSchema;
  if (json && typeof json === 'object') {
    const properties = (json as { properties?: unknown }).properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      return stringKeys(properties as object);
    }
  }
  return undefined;
}

/**
 * Model-facing text for a call refused before it ran because its arguments did
 * not fit the tool. The relayed error says what was wrong; the field list says
 * what would be right, which is the half a model cannot reconstruct and will
 * otherwise guess at by re-sending the same call.
 */
export function formatToolArgsViolationText(input: {
  toolName: string;
  parameters?: unknown;
  categoryHint?: string;
  args?: unknown;
  error: unknown;
}): string {
  const fields = toolParameterFields(input.parameters, input.args, input.categoryHint);
  const guidance =
    fields === undefined
      ? ''
      : fields.length > 0
        ? ` ${input.toolName} takes ${fields.map((field) => `\`${field}\``).join(', ')}.`
        : ` ${input.toolName} takes no arguments.`;
  const prefix = `Tool "${input.toolName}" arguments failed validation: `;
  // The guidance is the part worth keeping, so a long relayed error is what
  // gives way to the cap, not the field list.
  const budget = TOOL_ERROR_RESULT_MAX_CHARS - prefix.length - guidance.length;
  const detail = formatSyntheticToolErrorText(input.error);
  const bounded =
    detail.length <= Math.max(budget, 1) ? detail : `${detail.slice(0, Math.max(budget - 1, 0))}…`;
  return `${prefix}${bounded}${guidance}`;
}

function sandboxBoundaryFailureSignal(
  metadata: ReturnType<typeof serializeSandboxError>,
): Extract<ToolResultContent, { kind: 'text' }>['sandboxFailure'] {
  if (metadata?.reason !== 'sandbox_boundary_required' && metadata?.reason !== 'requires_bypass') {
    return undefined;
  }
  return {
    reason: metadata.reason,
    ...(metadata.requiredExpansion
      ? { requiredExpansion: metadata.requiredExpansion as SandboxBoundaryExpansion }
      : {}),
  };
}

function sandboxBoundaryFailureKind(
  metadata: ReturnType<typeof serializeSandboxError>,
): SandboxBoundaryFailureKind | undefined {
  if (metadata?.reason === 'invalid_boundary_declaration') return 'invalid';
  if (metadata?.reason === 'sandbox_boundary_required' || metadata?.reason === 'requires_bypass') {
    return 'unresolved';
  }
  return undefined;
}

function uncertainOutcomeSignalFromError(error: unknown): ToolUncertainOutcomeSignal | undefined {
  if (!(error instanceof ToolOutcomeUnknownError)) return undefined;
  return {
    code: 'outcome_unknown',
    retrySafe: false,
  };
}

function normalizeManagedMutationSettlement(
  settlement: unknown,
  maxResultBytes: number | undefined,
):
  | {
      kind: 'workspace_successor_committed';
      durableOutcome: RuntimeEvent;
    }
  | {
      kind: 'no_workspace_change_committed' | 'operation_failed_no_effect_committed';
      value: RuntimeManagedMutationOperationValue<unknown>;
      durableOutcome: RuntimeEvent;
    } {
  if (!settlement || typeof settlement !== 'object' || Array.isArray(settlement)) {
    throw new Error('Managed mutation owner returned an invalid settlement');
  }
  const record = settlement as unknown as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'unsettled') {
    throw new RuntimeManagedMutationUnsettledError(record.error);
  }
  if (
    kind !== 'workspace_successor_committed' &&
    kind !== 'no_workspace_change_committed' &&
    kind !== 'operation_failed_no_effect_committed'
  ) {
    throw new Error('Managed mutation owner returned an unknown settlement kind');
  }
  const durableOutcomeValue = Object.hasOwn(record, 'durableOutcome')
    ? record.durableOutcome
    : undefined;
  if (
    !durableOutcomeValue ||
    typeof durableOutcomeValue !== 'object' ||
    Array.isArray(durableOutcomeValue)
  ) {
    throw new Error('Managed mutation settlement has no durable outcome');
  }
  const durableOutcome = durableOutcomeValue as RuntimeEvent;

  if (kind === 'workspace_successor_committed') {
    return {
      kind,
      durableOutcome,
    };
  }

  if (!Object.hasOwn(record, 'providerResult')) {
    throw new Error('Managed no-effect settlement has no provider result');
  }
  const providerResult = snapshotManagedToolResult(record.providerResult, maxResultBytes);
  const response = durableOutcome.content;
  const expectedError = kind === 'operation_failed_no_effect_committed';
  if (
    response?.kind !== 'function_response' ||
    response.modelProjection === undefined ||
    (expectedError ? response.isError !== true : response.isError === true)
  ) {
    throw new Error('Managed no-effect settlement has the wrong durable outcome state');
  }
  const content = Object.freeze(coerceResultContent(providerResult));
  const outcome = Object.freeze({
    content,
    isError: expectedError,
    modelProjection: response.modelProjection,
    durationMs:
      typeof durableOutcome.actions?.stateDelta?.durationMs === 'number'
        ? durableOutcome.actions.stateDelta.durationMs
        : 0,
  });
  return {
    kind,
    value: Object.freeze({
      result: providerResult,
      outcome,
    }),
    durableOutcome,
  };
}

function coerceResultContent(raw: unknown): ToolResultContent {
  if (typeof raw === 'string') return { kind: 'text', text: raw };
  if (raw && typeof raw === 'object') {
    const obj = raw as { kind?: string; text?: string };
    if (typeof obj.kind === 'string') {
      try {
        return decodeCanonicalToolResultContent(raw);
      } catch {
        return { kind: 'json', value: raw };
      }
    }
    if (typeof obj.text === 'string') return { kind: 'text', text: obj.text };
    return { kind: 'json', value: raw };
  }
  return { kind: 'text', text: String(raw ?? '') };
}

/**
 * Builds the one durable JSON representation while enforcing its byte budget.
 * The walk stops at the first over-budget token and never retains a mutable
 * tool/owner-owned object alias.
 */
const MANAGED_RESULT_MAX_BYTES = MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC.resultSnapshot.maxBytes;
const MANAGED_RESULT_MAX_DEPTH = MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC.resultSnapshot.maxDepth;
const MANAGED_RESULT_MAX_NODES = MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC.resultSnapshot.maxNodes;
const MANAGED_RESULT_MAX_PROPERTIES =
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC.resultSnapshot.maxProperties;
const MANAGED_RESULT_MAX_ARRAY_LENGTH =
  MANAGED_MUTATION_EXECUTION_PROFILE_V1_SPEC.resultSnapshot.maxArrayLength;

function snapshotManagedToolResult(value: unknown, maxBytes: number | undefined): unknown {
  const budget: ManagedResultSnapshotBudget = {
    bytes: 0,
    limit:
      maxBytes === undefined
        ? MANAGED_RESULT_MAX_BYTES
        : Number.isFinite(maxBytes) && maxBytes >= 0
          ? Math.min(Math.floor(maxBytes), MANAGED_RESULT_MAX_BYTES)
          : 0,
    nodes: 0,
    properties: 0,
    active: new WeakSet<object>(),
  };
  return snapshotStrictJsonValue(value, budget, '$', 0);
}

interface ManagedResultSnapshotBudget {
  bytes: number;
  limit: number;
  nodes: number;
  properties: number;
  active: WeakSet<object>;
}

function snapshotStrictJsonValue(
  value: unknown,
  budget: ManagedResultSnapshotBudget,
  path: string,
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > MANAGED_RESULT_MAX_NODES || depth > MANAGED_RESULT_MAX_DEPTH) {
    throw new ToolResultLimitError();
  }
  if (value === null) {
    consumeManagedResultBytes(budget, 4);
    return null;
  }
  if (typeof value === 'string') {
    consumeManagedJsonStringBytes(budget, value);
    return value;
  }
  if (typeof value === 'boolean') {
    consumeManagedResultBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Managed tool result must be strict JSON: ${path} is not finite`);
    }
    const canonical = Object.is(value, -0) ? 0 : value;
    consumeManagedResultBytes(budget, JSON.stringify(canonical).length);
    return canonical;
  }
  if (value === undefined) {
    throw new Error(`Managed tool result must be strict JSON: ${path} is undefined`);
  }
  if (typeof value !== 'object') {
    throw new Error(`Managed tool result must be strict JSON: ${path} has an unsupported type`);
  }
  if (budget.active.has(value)) {
    throw new Error(`Managed tool result must be strict JSON: ${path} is cyclic`);
  }
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Managed tool result must be strict JSON: ${path} is not a plain object`);
    }
  }
  if ('toJSON' in value) {
    throw new Error(`Managed tool result must be strict JSON: ${path} defines toJSON`);
  }

  budget.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MANAGED_RESULT_MAX_ARRAY_LENGTH) throw new ToolResultLimitError();
      consumeManagedResultBytes(budget, 1);
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) consumeManagedResultBytes(budget, 1);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) {
          throw new Error(`Managed tool result must be strict JSON: ${path} is a sparse array`);
        }
        if (!('value' in descriptor)) {
          throw new Error(
            `Managed tool result must be strict JSON: ${path}[${index}] is an accessor`,
          );
        }
        output.push(
          snapshotStrictJsonValue(descriptor.value, budget, `${path}[${index}]`, depth + 1),
        );
      }
      consumeManagedResultBytes(budget, 1);
      return Object.freeze(output);
    }

    consumeManagedResultBytes(budget, 1);
    const output: Record<string, unknown> = {};
    let emitted = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      budget.properties += 1;
      if (budget.properties > MANAGED_RESULT_MAX_PROPERTIES) throw new ToolResultLimitError();
      if (emitted > 0) consumeManagedResultBytes(budget, 1);
      consumeManagedJsonStringBytes(budget, key);
      consumeManagedResultBytes(budget, 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new Error(`Managed tool result must be strict JSON: ${path}.${key} is an accessor`);
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: snapshotStrictJsonValue(descriptor.value, budget, `${path}.${key}`, depth + 1),
        writable: true,
      });
      emitted += 1;
    }
    consumeManagedResultBytes(budget, 1);
    return Object.freeze(output);
  } finally {
    budget.active.delete(value);
  }
}

function consumeManagedJsonStringBytes(budget: ManagedResultSnapshotBudget, value: string): void {
  consumeManagedResultBytes(budget, 1);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let bytes: number;
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes = 2;
    } else if (code <= 0x1f) {
      bytes = 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4;
        index += 1;
      } else {
        bytes = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes = 6;
    } else if (code <= 0x7f) {
      bytes = 1;
    } else if (code <= 0x7ff) {
      bytes = 2;
    } else {
      bytes = 3;
    }
    consumeManagedResultBytes(budget, bytes);
  }
  consumeManagedResultBytes(budget, 1);
}

function consumeManagedResultBytes(budget: ManagedResultSnapshotBudget, bytes: number): void {
  if (budget.bytes > budget.limit - bytes) throw new ToolResultLimitError();
  budget.bytes += bytes;
}

function coerceTerminalFailure(
  tool: MakaTool,
  cwd: string,
  args: unknown,
  err: unknown,
): {
  content: Extract<ToolResultContent, { kind: 'terminal' }>;
  message: string;
  sandboxDenied: boolean;
} | null {
  if (tool.name !== 'Bash' || !err || typeof err !== 'object') return null;
  const error = err as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    stdoutTruncated?: unknown;
    stderrTruncated?: unknown;
    reason?: unknown;
    sandboxed?: unknown;
    sandboxType?: unknown;
  };
  if (typeof error.code !== 'number') return null;
  const command =
    args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
      ? (args as { command: string }).command
      : '';
  const stdout = redactSecrets(String(error.stdout ?? ''));
  const stderr = redactSecrets(String(error.stderr ?? ''));
  const sandboxDenied = error.reason === 'sandbox_denial' && error.sandboxed === true;
  return {
    content: {
      kind: 'terminal',
      cwd,
      cmd: redactSecrets(command),
      status: error.code === 124 ? 'timed_out' : error.code === 130 ? 'cancelled' : 'failed',
      exitCode: error.code,
      output: {
        mode: 'pipes',
        stdout,
        stderr,
        stdoutTruncated: error.stdoutTruncated === true,
        stderrTruncated: error.stderrTruncated === true,
        redacted: stdout !== String(error.stdout ?? '') || stderr !== String(error.stderr ?? ''),
      },
      ...(sandboxDenied
        ? {
            sandboxDenial: {
              likely: true,
              ...(error.sandboxType === 'macos-seatbelt' || error.sandboxType === 'linux'
                ? { backend: error.sandboxType }
                : {}),
            },
          }
        : {}),
    },
    // The in-turn result the model acts on is just this message (the structured
    // content above goes to session history). Without the actual output the
    // model is blind to *why* the command failed, so fold in a bounded tail of
    // stderr/stdout — the tail is where shell errors land.
    message: buildTerminalFailureMessage(error.code, stdout, stderr, sandboxDenied),
    sandboxDenied,
  };
}

function buildTerminalFailureMessage(
  code: number,
  stdout: string,
  stderr: string,
  sandboxDenied: boolean,
): string {
  const parts = [`命令退出码 ${code}`];
  const view = (text: string) =>
    truncateToolOutput(text, {
      maxLines: 40,
      maxBytes: 1500,
      direction: 'tail',
    }).content.trim();
  const stderrView = view(stderr);
  if (stderrView) parts.push(`--- stderr ---\n${stderrView}`);
  const stdoutView = view(stdout);
  if (stdoutView) parts.push(`--- stdout ---\n${stdoutView}`);
  if (sandboxDenied) {
    // Naming only the marker left the model knowing a boundary could be widened
    // and not by what: the tool that widens it is `request_sandbox_boundary`.
    parts.push(
      '该失败很可能来自 Maka sandbox。请先尝试不扩大边界的替代方案；只有工具明确返回 sandbox_boundary_required 和具体 expansion 时，才能调用 request_sandbox_boundary 请求会话边界扩张，并在 expansion 里只写那一条路径。不要从命令文本猜测权限，也不要静默绕过 sandbox。',
    );
  }
  return parts.join('\n\n');
}

function hasSandboxDenial(
  content: ToolResultContent,
): content is Extract<ToolResultContent, { kind: 'text' | 'terminal' | 'shell_run' }> {
  return 'sandboxDenial' in content && content.sandboxDenial?.likely === true;
}

function sandboxDenialSignalFromError(error: unknown): SandboxDenialSignal | undefined {
  const metadata = sandboxErrorMetadata(error);
  if (!metadata) return undefined;
  const backend =
    metadata.backend === 'macos-seatbelt' || metadata.backend === 'linux'
      ? metadata.backend
      : undefined;
  if (metadata.reason === 'sandbox_denial' || metadata.reason === 'sandbox_denied') {
    return { likely: true, ...(backend ? { backend } : {}) };
  }
  return undefined;
}

function sandboxDenialKey(toolName: string, cwd: string, args: unknown): string {
  const command =
    args && typeof args === 'object' && typeof (args as { command?: unknown }).command === 'string'
      ? (args as { command: string }).command
      : '';
  return `${toolName}\u0000${cwd}\u0000${command}`;
}

function isBoundaryAuthorityAttempt(toolName: string, args: unknown): boolean {
  if (toolName === REQUEST_SANDBOX_BOUNDARY_TOOL_NAME) return true;
  if (toolName !== 'Bash' || !args || typeof args !== 'object') return false;
  const record = args as Record<string, unknown>;
  return (
    Object.hasOwn(record, 'boundary_intent') &&
    record.boundary_intent !== undefined &&
    record.boundary_intent !== 'current'
  );
}

function deriveToolResultStatus(
  content: ToolResultContent,
  raw?: unknown,
): ToolInvocationRecord['status'] {
  if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as { error?: unknown }).error === 'string' &&
    (raw as { error: string }).error.length > 0
  )
    return 'error';
  if (content.kind === 'subagent') {
    if (content.status === 'completed') return 'success';
    if (content.status === 'cancelled') return 'aborted';
    return 'error';
  }
  if (content.kind === 'agent_swarm') {
    if (content.status === 'failed') return 'error';
    return content.status === 'cancelled' ? 'aborted' : 'success';
  }
  if (content.kind === 'rive_workflow' && content.ok === false) return 'error';
  if (content.kind === 'web_search_error') return 'error';
  // Bash returns terminal facts instead of throwing for ordinary shell failure.
  // The explicit status is the shared classification point for isError,
  // telemetry, and loop-gate failure streaks.
  if (content.kind === 'terminal') {
    if (content.status === 'completed') return 'success';
    if (content.status === 'cancelled') return 'aborted';
    return 'error';
  }
  if (
    content.kind === 'shell_run' &&
    content.operation?.kind === 'pty_control' &&
    content.operation.failed
  )
    return 'error';
  // All other structured results are successful tool executions. That includes
  // ShellRun observations: their embedded process status stays model-visible,
  // but reading or returning the observation itself succeeded.
  return 'success';
}

function summarizeToolResultForTelemetry(
  content: ToolResultContent,
): NonNullable<ToolInvocationRecord['resultSummary']> {
  if (content.kind === 'agent_swarm') {
    const projection = projectAgentSwarmResult(content);
    return {
      kind: content.kind,
      status: projection.status,
      itemCount: projection.itemCount,
      startedItemCount: projection.startedItemCount,
      completedItemCount: projection.completedItemCount,
      failedItemCount: projection.failedItemCount,
      cancelledItemCount: projection.cancelledItemCount,
      artifactCount: projection.artifactCount,
    };
  }
  if (content.kind === 'terminal' || content.kind === 'shell_run' || content.kind === 'subagent') {
    return { kind: content.kind, status: content.status };
  }
  if (content.kind === 'rive_workflow') {
    return {
      kind: content.kind,
      status: content.state ?? (content.ok ? 'completed' : 'failed'),
    };
  }
  return { kind: content.kind };
}

function isAmbiguousComputerFailure(raw: unknown): boolean {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      (raw as { error?: unknown }).error === 'stale_frame' &&
      (raw as { failureClass?: unknown }).failureClass === 'ambiguous_target',
  );
}

function durableAttemptKey(turnId: string, toolUseId: string): string {
  return JSON.stringify([turnId, toolUseId]);
}

async function disposeManagedMutationAdmission(
  admission: RuntimeManagedMutationAdmission | undefined,
): Promise<void> {
  try {
    await admission?.dispose();
  } catch {
    // Cleanup is best-effort. It must never rewrite a durable terminal outcome,
    // nor obscure the primary pre-T1 or execution failure.
  }
}

function providerToolErrorMessage(output: unknown): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const record = output as Record<string, unknown>;
  if (typeof record.error !== 'string' || record.error.length === 0) return undefined;
  if (typeof record.modelText === 'string' && record.modelText.length > 0) {
    return record.modelText;
  }
  if (typeof record.text === 'string' && record.text.length > 0) {
    return record.text;
  }
  return record.error;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function summarizeArgs(toolName: string, args: unknown): string {
  const projected =
    toolName === 'WebSearch'
      ? projectWebSearchTelemetryArgs(args)
      : projectToolActivityArgs(toolName, args);
  const raw = typeof projected === 'string' ? projected : JSON.stringify(projected ?? null);
  const text = toolName === 'WriteStdin' ? raw : redactSecrets(raw);
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

function projectWebSearchTelemetryArgs(args: unknown): Record<string, number> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const limit = (args as { limit?: unknown }).limit;
  return typeof limit === 'number' && Number.isFinite(limit) ? { limit } : {};
}

function summarizePersistedArgs(args: unknown): string {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? null);
  const text = redactSecrets(raw);
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return Buffer.byteLength(text, 'utf8');
}

function snapshotToolArgs(value: unknown): unknown {
  return snapshotJsonValue(value, new WeakSet<object>());
}

function snapshotJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Tool arguments must not contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => snapshotJsonValue(entry, seen)));
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error(`Tool argument ${key} must be a plain data property`);
    }
    output[key] = snapshotJsonValue(descriptor.value, seen);
  }
  return Object.freeze(output);
}
