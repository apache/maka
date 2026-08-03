import {
  decodeCanonicalToolResultContent,
  projectAgentSwarmResult,
  projectToolActivityArgs,
  type CreateSandboxBoundaryRequest,
  type ExecutionBoundary,
  type SandboxBoundaryDecision,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryRequest,
  type SandboxBoundarySettlement,
  type SettleSandboxBoundaryRequest,
} from '@maka/core';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import type {
  SandboxBoundaryDecisionAckEvent,
  SandboxBoundaryRequestEvent,
  SessionEvent,
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
import type { AgentSpec } from '@maka/core/runtime-inputs';
import type { PermissionMode, ToolCategory, ToolExecutionFacts } from '@maka/core/permission';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import type {
  UserQuestion,
  UserQuestionResponse,
  UserQuestionResult,
} from '@maka/core/user-question';
import { computerUseModelCallArgs } from '@maka/core';
import type { SessionHeader } from '@maka/core/session';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { redactSecrets } from '@maka/core/redaction';
import { TOOL_BOUNDARY_PROTOCOL_V1, type RuntimeEvent } from '@maka/core';

import { recordToolArtifactsSafely, type ToolArtifactRecorder } from './tool-artifacts.js';
import { createToolOutputDeltaEmitter } from './tool-output-delta.js';
import { truncateToolOutput } from './tool-output.js';
import { stableHash } from './request-shape.js';
import { classifyError } from './provider-error-classification.js';
import type { RunTraceLike } from './run-trace.js';
import { AwaitRegistry } from './await-registry.js';
import { jsonValue } from './tool-result-output.js';
import type { ToolResultOutput } from './model-protocol.js';
import {
  buildToolOperationId,
  canonicalToolArgsHash,
  type RuntimeCommitSink,
  type ToolRecoveryMode,
} from './runtime-commit-sink.js';
import { ChildAgentRunLimiter } from './child-agent-run-limiter.js';
import type { AgentProfile } from './agent-catalog.js';
import type { SubagentExecutionRef } from './subagent-execution.js';
import { sandboxErrorMetadata, serializeSandboxError } from './sandbox/errors.js';
import { normalizeSandboxBoundaryExpansion } from './sandbox-boundary-path.js';
import { SANDBOX_BOUNDARY_UNAVAILABLE } from './sandbox-boundary-tool.js';
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
}

export interface DurableSessionEventSink {
  push(event: SessionEvent): void;
  pushAndWaitUntilConsumed(event: SessionEvent): Promise<void>;
}

export interface ToolSettlement {
  result: unknown;
  modelOutput: ToolResultOutput;
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
  /** Optional trusted facts about the executor that runs this tool. */
  executionFacts?: ToolExecutionFacts;
  /** Crash-recovery contract used by the durable tool boundary. */
  recoveryMode?: ToolRecoveryMode;
  /** Step-level admission contract. Exclusive tools cannot share an assistant step. */
  executionSemantics?: 'parallel' | 'exclusive_step';
  /** Optional permission/persistence projection derived from isolated execution args. */
  permissionArgs?: (
    args: P,
    context: Pick<MakaToolContext, 'sessionId' | 'turnId' | 'toolCallId'>,
  ) => unknown;
  /** Real tool implementation. */
  impl: (args: P, ctx: MakaToolContext) => Promise<R> | R;
  /** Optional provider-visible content mapping, used for screenshot image parts. */
  toModelOutput?: (options: {
    toolCallId: string;
    input: unknown;
    output: unknown;
  }) => ToolResultOutput | PromiseLike<ToolResultOutput>;
}

export interface MakaToolContext {
  sessionId: string;
  runId?: string;
  turnId: string;
  /** Session working directory. */
  cwd: string;
  /** Authoritative session boundary read immediately before Runtime-dispatched execution. */
  executionBoundary?: ExecutionBoundary;
  permissionMode?: PermissionMode;
  toolCallId: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
  /** Diagnostic-only trace projection. It must never affect tool execution. */
  emitRunTrace?: (
    type:
      | 'tool_started'
      | 'tool_completed'
      | 'tool_failed'
      | 'skill_searched'
      | 'skill_loaded'
      | 'skill_load_failed',
    message: string,
    data?: Record<string, unknown>,
  ) => void;
  spawnChildAgent?: (input: {
    spec: AgentSpec;
    prompt: string;
    /** Optional per-child signal, always composed with the owning tool invocation signal. */
    abortSignal?: AbortSignal;
    onReady?: (input: {
      turnId: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
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
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  prepareChildAgentResume?: (sourceRunId: string) => Promise<{
    sourceRunId: string;
    execution: SubagentExecutionRef;
    agentId: string;
    agentName: string;
    profile: string;
  }>;
  resumeChildAgent?: (input: {
    sourceRunId: string;
    prompt: string;
    /** Optional per-child signal, always composed with the owning tool invocation signal. */
    abortSignal?: AbortSignal;
    onReady?: (input: {
      childSessionId?: string;
      turnId: string;
      runId?: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  retryChildAgent?: (input: {
    sourceRunId: string;
    execution?: SubagentExecutionRef;
    /** Optional per-child signal, always composed with the owning tool invocation signal. */
    abortSignal?: AbortSignal;
    onReady?: (input: {
      childSessionId?: string;
      turnId: string;
      runId?: string;
      agentId: string;
      agentName: string;
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
 * Per-step tool-availability gating for the execute boundary. `ToolAvailabilityRuntime`
 * installs it each turn: `gatedNames` is the static set of tools that may be
 * hidden this turn (group members when economy is on); `activeNames` returns the
 * model-visible set for the step currently executing, recomputed before each
 * step. The guard rejects a *gated* tool that is not yet active — core tools and
 * the repair fallback are never in `gatedNames`, so they are never gated.
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

const SUBAGENT_TOOL_LIMIT_MESSAGE =
  '只读探索并发过多：同一轮最多 5 个子代理。请等待已有探索完成后再继续。';
const CLIENT_CAPABILITY_BOUNDARY_MESSAGE =
  'Client Capability tools require the Bypass execution boundary because their client-side effects cannot be sandboxed by the Host. Switch this Session to Bypass and retry.';

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
  invocationId?: string;
  materializeDefaultToolResultOutput?: (options: {
    toolCallId: string;
    output: unknown;
  }) => ToolResultOutput | PromiseLike<ToolResultOutput>;
  spawnChildAgent?: (input: {
    parentRunId: string;
    spec: AgentSpec;
    prompt: string;
    abortSignal: AbortSignal;
    onReady?: (input: {
      turnId: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
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
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  prepareChildAgentResume?: (sourceRunId: string) => Promise<{
    sourceRunId: string;
    execution: SubagentExecutionRef;
    agentId: string;
    agentName: string;
    profile: string;
  }>;
  resumeChildAgent?: (input: {
    parentRunId: string;
    sourceRunId: string;
    prompt: string;
    abortSignal: AbortSignal;
    onReady?: (input: {
      childSessionId?: string;
      turnId: string;
      runId?: string;
      agentId: string;
      agentName: string;
    }) => void | Promise<void>;
    onEvent?: (event: SessionEvent) => void;
  }) => Promise<unknown>;
  retryChildAgent?: (input: {
    parentRunId: string;
    sourceRunId: string;
    execution?: SubagentExecutionRef;
    abortSignal: AbortSignal;
    onReady?: (input: {
      childSessionId?: string;
      turnId: string;
      runId?: string;
      agentId: string;
      agentName: string;
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
}

interface DurableToolAttempt {
  operationId: string;
  responseEventId: string;
  commitOutcome(
    result: unknown,
    isError: boolean,
    durationMs?: number,
  ): Promise<{ id: string; operationId: string; ts: number }>;
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
  private childAgentRunLimiter = new ChildAgentRunLimiter(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
  /**
   * Tool-availability gating for the execute boundary. Set by the backend each
   * turn from `ToolAvailabilityRuntime`. Undefined when gating is off (economy
   * off / no hidden groups) — the guard is then fully inert.
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
  private lastAmbiguousComputerSignature: string | undefined;
  private readonly recentSandboxDenials = new Set<string>();
  private readonly durableToolAttempts = new Map<string, DurableToolAttempt>();
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

  async respondToSandboxBoundaryRequest(
    turnId: string,
    response: { requestId: string; decision: SandboxBoundaryDecision },
  ): Promise<boolean> {
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

  async respondToSandboxBoundaryResponse(response: {
    requestId: string;
    decision: SandboxBoundaryDecision;
  }): Promise<boolean> {
    if (!this.sandboxBoundaryRequests.has(response.requestId)) return false;
    return this.respondToSandboxBoundaryRequest(this.turnId, response);
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
    const result = await this.executeTool(
      call.tool,
      call.turnId,
      call.eventSink,
      call.input,
      {
        toolCallId: call.toolCallId,
        abortSignal: call.abortSignal,
        ...(call.providerOptions !== undefined ? { providerOptions: call.providerOptions } : {}),
      },
      call.stepId,
    );
    const providerError = providerToolErrorMessage(result);
    const modelOutput = providerError
      ? { type: 'error-text' as const, value: new Error(providerError).toString() }
      : call.tool.toModelOutput
        ? await call.tool.toModelOutput({
            toolCallId: call.toolCallId,
            input: call.input,
            output: result,
          })
        : this.input.materializeDefaultToolResultOutput
          ? await this.input.materializeDefaultToolResultOutput({
              toolCallId: call.toolCallId,
              output: result,
            })
          : typeof result === 'string'
            ? { type: 'text' as const, value: result }
            : { type: 'json' as const, value: jsonValue(result) };
    return { result, modelOutput };
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
    this.childAgentRunLimiter = new ChildAgentRunLimiter(MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
    priorChildAgentRunLimiter.close(
      new Error('Child agent run permit scope ended before capacity became available'),
    );
    this.activeSubagentToolCount = 0;
    this.gating = undefined;
    this.lastFailedToolCallSignature = undefined;
    this.failedToolCallStreak = 0;
    this.lastAmbiguousComputerSignature = undefined;
    this.recentSandboxDenials.clear();
    this.durableToolAttempts.clear();
    this.stepAdmissions.clear();
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
  private recordLoopGateOutcome(signature: string, failed: boolean): void {
    if (!failed) {
      this.lastFailedToolCallSignature = undefined;
      this.failedToolCallStreak = 0;
      return;
    }
    if (signature === this.lastFailedToolCallSignature) {
      this.failedToolCallStreak += 1;
    } else {
      this.lastFailedToolCallSignature = signature;
      this.failedToolCallStreak = 1;
    }
  }

  async writeSyntheticToolResult(
    toolUseId: string,
    turnId: string,
    text: string,
    queue: DurableSessionEventSink,
    sandboxDenial?: SandboxDenialSignal,
    sandboxFailure?: Extract<ToolResultContent, { kind: 'text' }>['sandboxFailure'],
    uncertainOutcome?: ToolUncertainOutcomeSignal,
  ): Promise<void> {
    const content: ToolResultContent = {
      kind: 'text',
      text: formatSyntheticToolErrorText(text),
      ...(sandboxDenial ? { sandboxDenial } : {}),
      ...(sandboxFailure ? { sandboxFailure } : {}),
      ...(uncertainOutcome ? { uncertainOutcome } : {}),
    };
    const durableAttempt = this.durableToolAttempts.get(durableAttemptKey(turnId, toolUseId));
    const durableOutcome = await durableAttempt?.commitOutcome(content, true);
    const msg: ToolResultMessage = {
      type: 'tool_result',
      id: this.input.newId(),
      turnId,
      ts: this.input.now(),
      toolUseId,
      isError: true,
      content,
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
    },
    stepId?: string,
  ): Promise<unknown> {
    const executionArgs = snapshotToolArgs(args);
    const toolUseId = ctx.toolCallId;
    // Registration is synchronous and happens before the first await, so
    // parallel Runtime settlements cannot race past exclusive admission.
    const admissionFailure = this.admitToolForStep(tool, stepId);
    let permissionArgs = executionArgs;
    let permissionArgsError: unknown;
    try {
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
    const now = this.input.now();
    const toolIntent = describeToolIntent(tool, persistedArgs);
    const trace = this.input.getRunTrace?.() ?? null;

    const runId = this.input.runId;
    const invocationId = this.input.invocationId ?? runId;
    if (this.input.runtimeCommitSink && !runId) {
      throw new RuntimeCommitBoundaryError(
        'T1',
        new Error('Durable tool execution requires a run id'),
      );
    }
    // Exclusive-step rejection is preflight: it must remain on the generic
    // call/response lane instead of claiming the T1 dispatch protocol. If the
    // call carried an operationId here, AgentRun would (correctly) skip its
    // generic projection assuming commitToolPrepared already persisted it;
    // the synthetic response would then become an orphan.
    const operationId =
      this.input.runtimeCommitSink && invocationId && !admissionFailure
        ? buildToolOperationId({ invocationId, providerToolCallId: toolUseId })
        : undefined;
    const startEv: ToolStartEvent = {
      type: 'tool_start',
      id: operationId ? `${operationId}_call` : this.input.newId(),
      turnId,
      ts: now,
      toolUseId,
      toolName: tool.name,
      ...(operationId ? { operationId } : {}),
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      args: structuredClone(persistedArgs),
      ...(ctx.providerOptions !== undefined
        ? { providerOptions: structuredClone(ctx.providerOptions) }
        : {}),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(toolIntent ? { intent: toolIntent } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
    };
    const callMsg: ToolCallMessage = {
      type: 'tool_call',
      id: toolUseId,
      turnId,
      ts: now,
      toolName: tool.name,
      ...(tool.activityKind ? { activityKind: tool.activityKind } : {}),
      ...(tool.displayName ? { displayName: tool.displayName } : {}),
      ...(toolIntent ? { intent: toolIntent } : {}),
      args: structuredClone(persistedArgs),
      ...(ctx.providerOptions !== undefined
        ? { providerOptions: structuredClone(ctx.providerOptions) }
        : {}),
      // Persist the same step id the tool_start event carries so the UI
      // timeline and post-restart backfill can pair this call with its step.
      ...(stepId !== undefined ? { stepId } : {}),
    };
    await this.input.appendMessage(callMsg);
    queue.push(startEv);
    trace?.emit('tool', 'tool_started', 'Tool execution started', {
      toolUseId,
      toolName: tool.name,
      ...(tool.categoryHint !== undefined ? { categoryHint: tool.categoryHint } : {}),
    });
    const callSignature = `${tool.name} ${loopGateArgsKey(executionArgs, toolUseId)}`;
    if (admissionFailure) {
      await this.writeSyntheticToolResult(toolUseId, turnId, admissionFailure, queue);
      trace?.emit('tool', 'tool_failed', 'Tool rejected by exclusive-step admission', {
        toolUseId,
        toolName: tool.name,
        stepId,
        status: 'error',
        errorClass: 'ExclusiveStepConflict',
      });
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(admissionFailure);
    }
    const computerSemanticSignature =
      tool.categoryHint === 'computer_use'
        ? computerUseSemanticSignature(permissionArgs)
        : undefined;
    if (permissionArgsError !== undefined) {
      const msg =
        tool.categoryHint === 'computer_use'
          ? 'Computer Use arguments failed validation'
          : formatSyntheticToolErrorText(permissionArgsError);
      await this.writeSyntheticToolResult(toolUseId, turnId, msg, queue);
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
            ? summarizePersistedArgs(persistedArgs)
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
      this.recordLoopGateOutcome(callSignature, true);
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
    if (
      computerSemanticSignature &&
      computerSemanticSignature === this.lastAmbiguousComputerSignature
    ) {
      const reason = formatAmbiguousComputerLoopGateText();
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
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
    if (
      callSignature === this.lastFailedToolCallSignature &&
      this.failedToolCallStreak >= LOOP_GATE_IDENTICAL_THRESHOLD - 1
    ) {
      const reason = formatLoopGateText(tool.name);
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
      trace?.emit('tool', 'tool_failed', 'Loop-gate blocked a repeated identical failing call', {
        toolUseId,
        toolName: tool.name,
        status: 'error',
        errorClass: 'LoopGate',
      });
      return this.errorReturn(reason);
    }

    // Tool-availability execute-boundary guard (Codex Δ5). Uses the step-start
    // snapshot, NOT a cumulative loaded-set: if one step emits `load_tools(g)`
    // and a tool from group `g` in parallel, that tool is not yet active (it
    // activates only in the next request projection), so it is rejected here —
    // before permission eval and before the real impl. This also closes the AI
    // SDK `activeTools` leak (vercel/ai#8653). The rejection is recoverable: the
    // model loads via `load_tools`, then retries next step.
    if (
      this.gating &&
      this.gating.gatedNames.has(tool.name) &&
      !this.gating.activeNames().has(tool.name)
    ) {
      const reason = formatDeferredNotLoadedText(tool.name);
      await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
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
    if (tool.categoryHint === 'client_capability') {
      try {
        clientCapabilityBoundary = await this.readExecutionBoundary();
      } catch (error) {
        const reason = formatSyntheticToolErrorText(error);
        await this.writeSyntheticToolResult(toolUseId, turnId, reason, queue);
        trace?.emit('tool', 'tool_failed', 'Client Capability boundary read failed', {
          toolUseId,
          toolName: tool.name,
          status: 'error',
          errorClass: 'ExecutionBoundaryUnavailable',
        });
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(reason);
      }
      if (clientCapabilityBoundary.kind !== 'bypass') {
        await this.writeSyntheticToolResult(
          toolUseId,
          turnId,
          CLIENT_CAPABILITY_BOUNDARY_MESSAGE,
          queue,
        );
        trace?.emit('tool', 'tool_failed', 'Client Capability blocked by execution boundary', {
          toolUseId,
          toolName: tool.name,
          status: 'error',
          errorClass: 'ClientCapabilityBoundary',
        });
        this.recordLoopGateOutcome(callSignature, true);
        return this.errorReturn(CLIENT_CAPABILITY_BOUNDARY_MESSAGE);
      }
    }

    const reservedSubagentSlot = this.reserveSubagentSlot(tool);
    if (!reservedSubagentSlot) {
      trace?.emit('tool', 'tool_failed', 'Tool execution rejected by runtime limit', {
        toolUseId,
        toolName: tool.name,
        errorClass: 'RuntimeLimit',
        boundary: 'subagent_tool_admission',
      });
      await this.writeSyntheticToolResult(toolUseId, turnId, SUBAGENT_TOOL_LIMIT_MESSAGE, queue);
      this.recordLoopGateOutcome(callSignature, true);
      return this.errorReturn(SUBAGENT_TOOL_LIMIT_MESSAGE);
    }

    let durableAttempt: DurableToolAttempt | undefined;
    try {
      durableAttempt = await this.prepareDurableToolAttempt({
        tool,
        startEvent: startEv,
        persistedArgs,
        abortSignal: ctx.abortSignal,
        ...(invocationId ? { invocationId } : {}),
        ...(runId ? { runId } : {}),
      });
    } catch (error) {
      if (reservedSubagentSlot) this.releaseSubagentSlot(tool);
      throw error;
    }
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
    });
    // Loop-gate outcome for the real impl. Default failed; the success path below
    // overwrites it from the derived result status, and the finally records it
    // once for every exit (return or throw). The pre-impl guards record their own
    // failures above, since they early-return before this point.
    let attemptFailed = true;
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
        const result = await tool.impl(structuredClone(executionArgs) as never, {
          sessionId: this.input.sessionId,
          turnId,
          ...(runId ? { runId } : {}),
          cwd: this.input.header.cwd,
          executionBoundary,
          permissionMode: this.input.header.permissionMode,
          toolCallId: toolUseId,
          abortSignal: ctx.abortSignal,
          emitOutput: output.emit,
          ...(trace
            ? {
                emitRunTrace: (
                  type:
                    | 'tool_started'
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
          }),
          askUserQuestion: (questions) => this.askUserQuestion(turnId, toolUseId, questions, queue),
          requestSandboxBoundary: (expansion, justification) =>
            this.requestSandboxBoundary(turnId, toolUseId, expansion, justification, queue),
        });
        output.flush();
        const durationMs = this.input.now() - startedAt;

        const content = coerceResultContent(result);
        const toolResultStatus = deriveToolResultStatus(content, result);
        const durableOutcome = await durableAttempt?.commitOutcome(
          content,
          toolResultStatus !== 'success',
          durationMs,
        );
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
          durationMs,
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
      if (err instanceof RuntimeCommitBoundaryError) throw err;
      if (isInteractionControlError(err)) throw err;
      output.flush();
      const sandboxError = serializeSandboxError(err);
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
        const durableOutcome = await durableAttempt?.commitOutcome(
          terminalFailure.content,
          true,
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
          durationMs,
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
        return this.errorReturn(terminalFailure.message);
      }
      const msg =
        tool.categoryHint === 'computer_use'
          ? `Computer Use failed: ${errorClass}`
          : uncertainOutcome
            ? `outcome_unknown: ${formatSyntheticToolErrorText(err)}`
            : formatSyntheticToolErrorText(err);
      await this.writeSyntheticToolResult(
        toolUseId,
        turnId,
        msg,
        queue,
        sandboxDenialSignalFromError(err),
        sandboxBoundaryFailureSignal(sandboxError),
        uncertainOutcome,
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
      this.recordLoopGateOutcome(callSignature, attemptFailed);
      if (reservedSubagentSlot) this.releaseSubagentSlot(tool);
    }
  }

  private async prepareDurableToolAttempt(input: {
    tool: MakaTool;
    startEvent: ToolStartEvent;
    persistedArgs: unknown;
    abortSignal: AbortSignal;
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
      content: {
        kind: 'function_call',
        id: input.startEvent.toolUseId,
        name: input.tool.name,
        args: structuredClone(input.persistedArgs),
        ...(input.startEvent.providerOptions !== undefined
          ? { providerOptions: structuredClone(input.startEvent.providerOptions) }
          : {}),
      },
      refs: {
        operationId,
        toolCallId: input.startEvent.toolUseId,
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
      actions: {
        toolDispatch: {
          protocol: TOOL_BOUNDARY_PROTOCOL_V1,
          operationId,
          providerToolCallId: input.startEvent.toolUseId,
          toolName: input.tool.name,
          canonicalArgsHash,
          recoveryMode,
        },
      },
      refs: { operationId, toolCallId: input.startEvent.toolUseId },
    };
    try {
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
    let committedOutcome: { id: string; operationId: string; ts: number } | undefined;
    return {
      operationId,
      responseEventId: `${operationId}_response`,
      commitOutcome: async (result, isError, durationMs) => {
        if (committedOutcome) return committedOutcome;
        const responseEvent: RuntimeEvent = {
          id: `${operationId}_response`,
          invocationId,
          runId,
          sessionId: this.input.sessionId,
          turnId: input.startEvent.turnId,
          ts: this.input.now(),
          partial: false,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: input.startEvent.toolUseId,
            name: input.tool.name,
            result,
            ...(isError ? { isError: true } : {}),
          },
          refs: {
            operationId,
            toolCallId: input.startEvent.toolUseId,
          },
          ...(durationMs !== undefined ? { actions: { stateDelta: { durationMs } } } : {}),
        };
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
    };
  }

  private admitToolForStep(tool: MakaTool, stepId: string | undefined): string | undefined {
    if (!stepId) return undefined;
    const existing = this.stepAdmissions.get(stepId) ?? { callCount: 0 };
    const exclusive = tool.executionSemantics === 'exclusive_step';
    if (existing.exclusiveToolName) {
      return `Tool ${tool.name} cannot share an assistant step with exclusive tool ${existing.exclusiveToolName}. Retry it in a separate step.`;
    }
    if (exclusive && existing.callCount > 0) {
      return `Exclusive tool ${tool.name} cannot share an assistant step with other tool calls. Retry it in a separate step.`;
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
  }): Pick<
    MakaToolContext,
    | 'spawnChildAgent'
    | 'spawnChildSession'
    | 'prepareChildAgentResume'
    | 'resumeChildAgent'
    | 'retryChildAgent'
  > {
    const parentRunId = this.input.runId;
    if (!parentRunId) return {};
    const limiter = this.childAgentRunLimiter;
    const runWithPermit = async <T>(
      mode: 'spawn' | 'spawn_session' | 'resume' | 'retry',
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
          mode,
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
            mode,
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
        mode,
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
          mode,
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
          mode,
          status: abortSignal.aborted ? 'aborted' : 'error',
          durationMs: Math.max(0, this.input.now() - childStartedAt),
        });
        throw error;
      } finally {
        permit.release();
      }
    };

    const spawnChildAgent = this.input.spawnChildAgent;
    const spawnChildSession = this.input.spawnChildSession;
    const prepareChildAgentResume = this.input.prepareChildAgentResume;
    const resumeChildAgent = this.input.resumeChildAgent;
    const retryChildAgent = this.input.retryChildAgent;
    return {
      ...(spawnChildAgent
        ? {
            spawnChildAgent: async (spawnInput) => {
              const abortSignal = composeChildAbortSignal(
                input.abortSignal,
                spawnInput.abortSignal,
              );
              return await runWithPermit(
                'spawn',
                abortSignal,
                async () =>
                  await spawnChildAgent({
                    parentRunId,
                    spec: spawnInput.spec,
                    prompt: spawnInput.prompt,
                    abortSignal,
                    ...(spawnInput.onReady ? { onReady: spawnInput.onReady } : {}),
                    ...(spawnInput.onEvent ? { onEvent: spawnInput.onEvent } : {}),
                  }),
              );
            },
          }
        : {}),
      ...(spawnChildSession
        ? {
            spawnChildSession: async (spawnInput) => {
              const abortSignal = composeChildAbortSignal(
                input.abortSignal,
                spawnInput.abortSignal,
              );
              return await runWithPermit(
                'spawn_session',
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
                    ...(spawnInput.onReady ? { onReady: spawnInput.onReady } : {}),
                    ...(spawnInput.onEvent ? { onEvent: spawnInput.onEvent } : {}),
                  }),
              );
            },
          }
        : {}),
      ...(prepareChildAgentResume
        ? {
            prepareChildAgentResume: (sourceRunId) => prepareChildAgentResume(sourceRunId),
          }
        : {}),
      ...(resumeChildAgent
        ? {
            resumeChildAgent: async (resumeInput) => {
              const abortSignal = composeChildAbortSignal(
                input.abortSignal,
                resumeInput.abortSignal,
              );
              return await runWithPermit(
                'resume',
                abortSignal,
                async () =>
                  await resumeChildAgent({
                    parentRunId,
                    sourceRunId: resumeInput.sourceRunId,
                    prompt: resumeInput.prompt,
                    abortSignal,
                    ...(resumeInput.onReady ? { onReady: resumeInput.onReady } : {}),
                    ...(resumeInput.onEvent ? { onEvent: resumeInput.onEvent } : {}),
                  }),
              );
            },
          }
        : {}),
      ...(retryChildAgent
        ? {
            retryChildAgent: async (retryInput) => {
              const abortSignal = composeChildAbortSignal(
                input.abortSignal,
                retryInput.abortSignal,
              );
              return await runWithPermit(
                'retry',
                abortSignal,
                async () =>
                  await retryChildAgent({
                    parentRunId,
                    sourceRunId: retryInput.sourceRunId,
                    ...(retryInput.execution ? { execution: retryInput.execution } : {}),
                    abortSignal,
                    ...(retryInput.onReady ? { onReady: retryInput.onReady } : {}),
                    ...(retryInput.onEvent ? { onEvent: retryInput.onEvent } : {}),
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
    queue: DurableSessionEventSink,
  ): Promise<UserQuestionResult> {
    const hostedRun = this.interactionRun();
    const requestId = this.input.newId();
    const parked = this.userQuestions.park(requestId, {
      toolUseId,
      questions,
      hosted: hostedRun !== undefined,
    });
    if (hostedRun) void parked.catch(() => undefined);
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
      try {
        await hostedRun.admitUserQuestionRequest({
          request,
          settlement,
        });
      } catch (error) {
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
    queue.push(request);
    const response = await parked;
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
  }

  private async requestSandboxBoundary(
    turnId: string,
    toolUseId: string,
    expansion: SandboxBoundaryExpansion,
    justification: string,
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
      // This one does fire in production. The desktop app supplies both store
      // callbacks unconditionally (`session-stream.ts`), but the CLI supplies
      // them only on the `tui` surface (`runtime-bootstrap.ts`), so every
      // non-TUI CLI surface reaches here for any call that is not a hosted run.
      throw new Error(SANDBOX_BOUNDARY_UNAVAILABLE);
    }
    const normalized = await normalizeSandboxBoundaryExpansion(expansion, this.input.header.cwd);
    const normalizedJustification = justification.trim();
    if (typeof justification !== 'string' || normalizedJustification.length === 0) {
      throw new Error('Sandbox boundary justification must not be empty');
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
    if (creation) {
      try {
        await creation;
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
      try {
        await hostedRun.admitSandboxBoundaryRequest({
          request: requestEvent,
          settlement,
        });
      } catch (error) {
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
    queue.push(requestEvent);
    const settlement = await parked;
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
    return settlement;
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

/**
 * Recoverable message returned when a gated tool is invoked before its group is
 * loaded. Tells the model exactly how to self-correct: load via `load_tools`,
 * then retry on a later step.
 */
export function formatDeferredNotLoadedText(toolName: string): string {
  return (
    `Tool "${toolName}" is available but not loaded yet. ` +
    `Call load_tools to load its group first, then call "${toolName}" on a later step.`
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

function uncertainOutcomeSignalFromError(error: unknown): ToolUncertainOutcomeSignal | undefined {
  if (!(error instanceof ToolOutcomeUnknownError)) return undefined;
  return {
    code: 'outcome_unknown',
    retrySafe: false,
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
    parts.push(
      '该失败很可能来自 Maka sandbox。请先尝试不扩大边界的替代方案；只有工具明确返回 sandbox_boundary_required 和具体 expansion 时，才能请求会话边界扩张。不要从命令文本猜测权限，也不要静默绕过 sandbox。',
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
  if (content.kind === 'explore_agent' && content.ok === false) {
    return content.reason === 'aborted' ? 'aborted' : 'error';
  }
  if (content.kind === 'subagent') {
    if (content.status === 'completed') return 'success';
    if (content.status === 'cancelled') return 'aborted';
    return 'error';
  }
  if (content.kind === 'agent_swarm') {
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
  if (content.kind === 'explore_agent') {
    return {
      kind: content.kind,
      status: content.terminalStatus ?? (content.ok ? 'completed' : 'failed'),
    };
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

function describeToolIntent(tool: MakaTool, args: unknown): string | undefined {
  if (tool.categoryHint !== 'subagent' || tool.name !== 'ExploreAgent') return undefined;
  if (!args || typeof args !== 'object') return undefined;
  const objective = (args as { objective?: unknown }).objective;
  if (typeof objective !== 'string') return undefined;
  const normalized = redactSecrets(objective.replace(/\s+/g, ' ').trim());
  if (normalized.length === 0) return undefined;
  const capped = normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`;
  return `只读探索：${capped}`;
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
