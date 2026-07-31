/**
 * RuntimeRunner — Runtime v2 invocation shell.
 *
 * Architecture: docs/architecture/runtime-core-architecture-draft.md
 *
 * RuntimeRunner is the invocation shell. It remains decoupled from
 * SessionManager / SessionStore so it can be exercised with fake services,
 * while still being able to wrap production AgentRun streams during the
 * Runtime v2 migration.
 *
 * Responsibilities (per the node spec):
 *   1. Run an injectable preflight gate.
 *   2. Create the InvocationContext through injected id/time providers.
 *   3. Emit (collect) the initial user RuntimeEvent for normal invocations;
 *      safe-boundary continuations reuse committed history without one.
 *   4. Dispatch to an injected AgentFlow and collect canonical RuntimeEvents.
 *   5. Return a structured result with the newly collected events and a terminal
 *      status.
 *
 * Out-of-scope (deliberately): direct SessionStore writes, projection
 * driving, operational AgentRunStore writes, and RuntimeEventStore ledger
 * writes. Those remain owned by the runtime orchestration around AgentRun while
 * SessionManager delegates invocation execution through this shell.
 */

import { isDeepStrictEqual } from 'node:util';

import {
  isTerminalRuntimeEvent,
  type RuntimeEvent,
  type RuntimeEventStatus,
  type ToolBoundaryProtocol,
} from '@maka/core/runtime-event';
import type {
  InvocationContext,
  InvocationFailure,
  InvocationProviders,
  InvocationRequest,
  InvocationResult,
  InvocationResultStatus,
} from './invocation-context.js';
import { createDefaultInvocationProviders } from './invocation-context.js';
import type { FlowInput, RunnableAgentFlow } from './agent-flow.js';
import type { RuntimeContinuation } from './runtime-resume.js';
import type { TurnOrigin } from '@maka/core/runtime-inputs';

// ============================================================================
// RuntimeGate — narrow preflight seam
// ============================================================================

/**
 * Decision returned by a RuntimeGate preflight. `ok: false` blocks the
 * invocation before any context is created or event emitted.
 */
export interface RuntimeGateDecision {
  ok: boolean;
  /** Machine-readable reason when ok === false (surfaced as failure.message). */
  reason?: string;
}

/**
 * Narrow preflight interface for readiness/blocked/running/waiting policy.
 * Kept injectable so tests can pass a stub and Phase 6 can move desktop
 * main's readiness/rebind checks behind a real implementation.
 */
export interface RuntimeGate {
  preflight(request: InvocationRequest): Promise<RuntimeGateDecision>;
}

/**
 * Functional gate from a callback. Convenient for tests; also the shape a
 * future Phase 6 gate will compose from readiness rules.
 */
export function runtimeGateFromCallback(
  preflight: (request: InvocationRequest) => Promise<RuntimeGateDecision> | RuntimeGateDecision,
): RuntimeGate {
  return {
    preflight: async (request) => preflight(request),
  };
}

// ============================================================================
// AgentFlowLike — compatibility alias
// ============================================================================

/**
 * @deprecated Use `RunnableAgentFlow` from `./agent-flow.js`.
 */
export type AgentFlowLike = RunnableAgentFlow;

// ============================================================================
// RuntimeRunnerDeps
// ============================================================================

export interface RuntimeRunnerDeps {
  flow: RunnableAgentFlow;
  /** Durable sink for the Runner-owned continuation-start fact. */
  commitContinuationStart?: (event: RuntimeEvent) => Promise<void>;
  /** Set only when the tool implementation path is guarded by canonical T1. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  /** Optional preflight gate; omitted means "always allow". */
  gate?: RuntimeGate;
  /** Injectable id/time providers. Defaults to crypto.randomUUID / Date.now. */
  providers?: InvocationProviders;
  /**
   * Whether to stop collecting at the first terminal RuntimeEvent. Defaults
   * to true for standalone runner callers; production bridges can set false
   * to keep draining cleanup/trailing events from wrapped streams.
   */
  stopOnTerminal?: boolean;
}

export interface InitialUserRuntimeEventInput {
  id: string;
  invocationId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  ts: number;
  branch?: string;
  text: string;
  /** Human-facing view when it differs from `text`; see RuntimeEventTextContent. */
  displayText?: string;
  origin?: TurnOrigin;
  attachments?: InvocationRequest['attachments'];
  quotes?: InvocationRequest['quotes'];
  toolBoundaryProtocol?: ToolBoundaryProtocol;
}

// ============================================================================
// RuntimeRunner
// ============================================================================

export class RuntimeRunner {
  private readonly flow: RunnableAgentFlow;
  private readonly commitContinuationStart: RuntimeRunnerDeps['commitContinuationStart'];
  private readonly toolBoundaryProtocol: RuntimeRunnerDeps['toolBoundaryProtocol'];
  private readonly gate: RuntimeGate | undefined;
  private readonly providers: InvocationProviders;
  private readonly stopOnTerminal: boolean;

  constructor(deps: RuntimeRunnerDeps) {
    this.flow = deps.flow;
    this.commitContinuationStart = deps.commitContinuationStart;
    this.toolBoundaryProtocol = deps.toolBoundaryProtocol;
    this.gate = deps.gate;
    this.providers = deps.providers ?? createDefaultInvocationProviders();
    this.stopOnTerminal = deps.stopOnTerminal ?? true;
  }

  async resume(
    continuation: RuntimeContinuation,
    options: {
      source: InvocationRequest['source'];
      context?: InvocationRequest['context'];
      orchestration?: InvocationRequest['orchestration'];
      abortSignal?: AbortSignal;
    },
  ): Promise<InvocationResult> {
    assertRuntimeContinuationEnvelope(continuation);
    return this.run({
      sessionId: continuation.sessionId,
      invocationId: continuation.invocationId,
      runId: continuation.runId,
      turnId: continuation.turnId,
      text: '',
      context: options.context ?? [],
      runtimeContext: continuation.runtimeContext,
      continuation: invocationContinuationMetadata(continuation),
      source: options.source,
      ...(options.orchestration ? { orchestration: options.orchestration } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  }

  /**
   * Run one invocation end-to-end and return a structured result.
   *
   * Event order is guaranteed: normal invocations collect the initial user
   * RuntimeEvent before any flow event; continuations collect only new events.
   * By default collection stops at the first
   * terminal RuntimeEvent; callers that wrap streams with cleanup/trailing
   * events can opt into full draining through RuntimeRunnerDeps.
   */
  async run(request: InvocationRequest): Promise<InvocationResult> {
    const startedAt = this.providers.now();
    const invocationId =
      request.invocationId ?? request.initialRuntimeEvent?.invocationId ?? this.providers.newId();
    const runId = request.runId ?? request.initialRuntimeEvent?.runId ?? this.providers.newId();
    if (request.continuation) {
      if (!request.runtimeContext) {
        throw new Error('Runtime continuation requires replay context');
      }
      if (
        request.text.length > 0 ||
        request.voiceAudio !== undefined ||
        request.attachments !== undefined ||
        request.quotes !== undefined
      ) {
        throw new Error('Runtime continuation cannot carry a new user message or attachments');
      }
      assertRuntimeContinuationEnvelope({
        sessionId: request.sessionId,
        invocationId,
        runId,
        turnId: request.turnId,
        ...request.continuation,
        runtimeContext: request.runtimeContext,
      });
    }

    // 1. Preflight (injectable gate). On failure we admit no invocation: no
    //    context, no user event, no flow dispatch.
    if (this.gate) {
      const decision = await this.gate.preflight(request);
      if (!decision.ok) {
        return this.buildResult({
          request,
          invocationId,
          runId,
          startedAt,
          finishedAt: this.providers.now(),
          status: 'failed',
          events: [],
          failure: {
            class: 'preflight',
            ...(decision.reason ? { message: decision.reason } : {}),
          },
        });
      }
    }

    // 2. Abort already signalled before dispatch. Fail fast without emitting
    //    a user event or calling the flow, mirroring the preflight path.
    if (request.abortSignal?.aborted) {
      return this.buildResult({
        request,
        invocationId,
        runId,
        startedAt,
        finishedAt: this.providers.now(),
        status: 'failed',
        events: [],
        failure: {
          class: 'aborted',
          message: 'abort signal already set before dispatch',
        },
      });
    }

    // 3. Create the invocation context through the injected providers.
    const ctx: InvocationContext = {
      sessionId: request.sessionId,
      invocationId,
      runId,
      turnId: request.turnId,
      ...(request.branch ? { branch: request.branch } : {}),
      source: request.source,
      startedAt,
      ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
      request,
      newId: this.providers.newId,
      now: this.providers.now,
    };
    if (request.initialRuntimeEvent) {
      assertInitialRuntimeEventMatchesRequest(request.initialRuntimeEvent, {
        sessionId: request.sessionId,
        invocationId,
        runId,
        turnId: request.turnId,
      });
    }

    const events: RuntimeEvent[] = [];

    // 4. A normal invocation starts with a new user fact. A continuation
    // resumes committed provider history directly and must not invent a
    // duplicate user message.
    if (!request.continuation) {
      const userEvent =
        request.initialRuntimeEvent ??
        buildInitialUserRuntimeEvent({
          id: ctx.newId(),
          invocationId: ctx.invocationId,
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          ts: ctx.startedAt,
          ...(ctx.branch ? { branch: ctx.branch } : {}),
          text: request.text,
          ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
          ...(request.quotes !== undefined ? { quotes: request.quotes } : {}),
          ...(this.toolBoundaryProtocol ? { toolBoundaryProtocol: this.toolBoundaryProtocol } : {}),
        });
      events.push(userEvent);
    } else {
      if (!this.commitContinuationStart) {
        throw new Error('Runtime continuation requires a durable continuation-start sink');
      }
      const continuationStart: RuntimeEvent = {
        id: ctx.newId(),
        invocationId: ctx.invocationId,
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        ts: ctx.startedAt,
        ...(ctx.branch ? { branch: ctx.branch } : {}),
        partial: false,
        role: 'system',
        author: 'system',
        actions: {
          stateDelta: { continuationStart: true },
          ...(this.toolBoundaryProtocol
            ? { runtimeProtocol: { toolBoundary: this.toolBoundaryProtocol } }
            : {}),
        },
        refs: {
          sourceInvocationId: request.continuation.sourceInvocationId,
          sourceRunId: request.continuation.sourceRunId,
          sourceTurnId: request.continuation.sourceTurnId,
          sourceRuntimeEventHighWater: request.continuation.sourceRuntimeEventHighWater,
        },
      };
      await this.commitContinuationStart(continuationStart);
      events.push(continuationStart);
    }
    const flowInput = buildFlowInput(request);

    // 5. Dispatch to the flow and collect canonical events. By default the
    //    first terminal event ends collection; when stopOnTerminal is false,
    //    keep draining while remembering any failure signal. A thrown error,
    //    non-completed terminal status, denied permission, non-terminal error,
    //    or incomplete model finish maps the result to 'failed'.
    let failure: InvocationFailure | undefined;
    let terminalSeen = false;
    try {
      for await (const ev of this.flow.run(ctx, flowInput)) {
        events.push(ev);
        failure ??= failureFromRuntimeEvent(ev);
        if (isTerminalRuntimeEvent(ev)) {
          terminalSeen = true;
          if (this.stopOnTerminal) {
            break;
          }
        }
      }
    } catch (error) {
      failure = {
        class: error instanceof Error && error.name ? error.name : 'error',
        ...(error instanceof Error && error.message ? { message: error.message } : {}),
      };
    }
    if (!failure && !terminalSeen) {
      failure = {
        class: 'missing_terminal_event',
        message: 'flow exhausted without a terminal RuntimeEvent',
      };
    }

    let status: InvocationResultStatus = failure ? 'failed' : 'completed';
    const finalOutput = status === 'completed' ? finalOutputFromEvents(events) : undefined;
    if (status === 'completed' && finalOutput === undefined) {
      status = 'failed';
      failure = {
        class: 'missing_final_output',
        message: 'completed invocation produced no non-empty final model text',
      };
    }
    return this.buildResult({
      request,
      invocationId,
      runId,
      startedAt,
      finishedAt: this.providers.now(),
      status,
      events,
      ...(finalOutput !== undefined ? { finalOutput } : {}),
      ...(failure ? { failure } : {}),
    });
  }

  private buildResult(args: {
    request: InvocationRequest;
    invocationId: string;
    runId: string;
    startedAt: number;
    finishedAt: number;
    status: InvocationResultStatus;
    events: RuntimeEvent[];
    finalOutput?: string;
    failure?: InvocationFailure;
  }): InvocationResult {
    return {
      invocationId: args.invocationId,
      runId: args.runId,
      sessionId: args.request.sessionId,
      turnId: args.request.turnId,
      status: args.status,
      ...(args.finalOutput !== undefined ? { finalOutput: args.finalOutput } : {}),
      events: args.events,
      ...(args.failure ? { failure: args.failure } : {}),
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
    };
  }
}

function invocationContinuationMetadata(
  continuation: RuntimeContinuation,
): NonNullable<InvocationRequest['continuation']> {
  const {
    sessionId: _sessionId,
    invocationId: _invocationId,
    runId: _runId,
    turnId: _turnId,
    runtimeContext: _runtimeContext,
    safetySnapshot: _safetySnapshot,
    ...metadata
  } = continuation;
  return metadata;
}

function assertRuntimeContinuationEnvelope(
  continuation: Omit<RuntimeContinuation, 'safetySnapshot'>,
): void {
  const sourceRuntimeContext = continuation.sourceRuntimeContext ?? continuation.runtimeContext;
  if (continuation.sourceRuntimeEventHighWater < sourceRuntimeContext.length) {
    throw new Error('Runtime continuation high-water is behind its replay context');
  }
  if (continuation.runtimeContext.length === 0) {
    throw new Error('Runtime continuation replay context must not be empty');
  }
  const mismatched = sourceRuntimeContext.find(
    (event) =>
      event.sessionId !== continuation.sessionId ||
      event.invocationId !== continuation.sourceInvocationId ||
      event.runId !== continuation.sourceRunId ||
      event.turnId !== continuation.sourceTurnId,
  );
  if (mismatched) {
    throw new Error(`Runtime continuation replay identity mismatch at event ${mismatched.id}`);
  }
  if (
    !isDeepStrictEqual(
      continuation.runtimeContext.slice(-sourceRuntimeContext.length),
      sourceRuntimeContext,
    )
  ) {
    throw new Error('Runtime continuation source replay is not the tail of provider history');
  }
  if (
    continuation.invocationId === continuation.sourceInvocationId ||
    continuation.runId === continuation.sourceRunId ||
    continuation.turnId === continuation.sourceTurnId
  ) {
    throw new Error('Runtime continuation must use fresh invocation, run, and turn identities');
  }
}

function finalOutputFromEvents(events: readonly RuntimeEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.role === 'model' &&
      event.partial !== true &&
      event.content?.kind === 'text' &&
      event.content.text.trim().length > 0
    ) {
      return event.content.text;
    }
  }
  return undefined;
}

// ============================================================================
// Helpers
// ============================================================================

export function buildInitialUserRuntimeEvent(input: InitialUserRuntimeEventInput): RuntimeEvent {
  return {
    id: input.id,
    invocationId: input.invocationId,
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ts: input.ts,
    ...(input.branch ? { branch: input.branch } : {}),
    partial: false,
    role: 'user',
    author: input.origin ? 'host' : 'user',
    content: {
      kind: 'text',
      text: input.text,
      ...(input.displayText !== undefined ? { displayText: input.displayText } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.quotes !== undefined && input.quotes.length > 0 ? { quotes: input.quotes } : {}),
    },
    ...(input.toolBoundaryProtocol
      ? { actions: { runtimeProtocol: { toolBoundary: input.toolBoundaryProtocol } } }
      : {}),
  };
}

function assertInitialRuntimeEventMatchesRequest(
  event: RuntimeEvent,
  request: Pick<InvocationRequest, 'sessionId' | 'turnId'> & {
    invocationId: string;
    runId: string;
  },
): void {
  const expectedAuthor =
    event.content?.kind === 'text' && event.content.origin !== undefined ? 'host' : 'user';
  if (
    event.sessionId !== request.sessionId ||
    event.invocationId !== request.invocationId ||
    event.runId !== request.runId ||
    event.turnId !== request.turnId ||
    event.role !== 'user' ||
    event.author !== expectedAuthor ||
    event.content?.kind !== 'text'
  ) {
    throw new Error('initial RuntimeEvent does not match the invocation request');
  }
}

function buildFlowInput(request: InvocationRequest): FlowInput {
  const continuation = request.continuation
    ? providerContinuationMetadata(request.continuation)
    : undefined;
  return {
    ...(request.lineage?.parentRunId ? { parentRunId: request.lineage.parentRunId } : {}),
    ...(request.orchestration !== undefined ? { orchestration: request.orchestration } : {}),
    text: request.text,
    ...(request.voiceAudio !== undefined ? { voiceAudio: request.voiceAudio } : {}),
    context: request.context ?? [],
    ...(request.runtimeContext !== undefined ? { runtimeContext: request.runtimeContext } : {}),
    ...(continuation !== undefined ? { continuation } : {}),
    ...(request.attachments !== undefined ? { attachments: request.attachments } : {}),
    ...(request.quotes !== undefined ? { quotes: request.quotes } : {}),
    ...(request.pullSteering !== undefined ? { pullSteering: request.pullSteering } : {}),
    ...(request.ackSteering !== undefined ? { ackSteering: request.ackSteering } : {}),
    ...(request.nackSteering !== undefined ? { nackSteering: request.nackSteering } : {}),
    ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
  };
}

function providerContinuationMetadata(
  continuation: NonNullable<InvocationRequest['continuation']>,
): FlowInput['continuation'] {
  const { sourceRuntimeContext: _sourceRuntimeContext, ...metadata } = continuation;
  return metadata;
}

/**
 * Map a terminal RuntimeEvent to a failure when its status is anything other
 * than 'completed'. A terminal event without an explicit status (e.g. one
 * that only carries actions.endInvocation) is treated as completed.
 */
function failureFromRuntimeEvent(event: RuntimeEvent): InvocationFailure | undefined {
  if (isTerminalRuntimeEvent(event)) {
    const terminalFailure = failureFromTerminalEvent(event);
    if (terminalFailure) return terminalFailure;
  }

  const content = event.content;
  if (content?.kind === 'error') {
    return {
      class: content.reason ?? content.code ?? 'runtime_error',
      message: content.message,
    };
  }

  const rawFinishReason = event.actions?.tokenUsage?.rawFinishReason;
  const finishFailure = failureFromRawFinishReason(rawFinishReason);
  if (finishFailure) return finishFailure;

  return undefined;
}

function failureFromTerminalEvent(event: RuntimeEvent): InvocationFailure | undefined {
  const status: RuntimeEventStatus | undefined = event.status;
  if (status === undefined || status === 'completed') return undefined;
  const content = event.content;
  // A failed terminal event may carry an error content (reason/code) from
  // the provider or backend. Prefer that precise class over the bare status.
  // A failed terminal with NO error content (e.g. complete(stopReason=error)
  // with no preceding error event) classifies as 'runtime_error' — not the
  // bare 'failed' — so benchmark scoring can distinguish it from other
  // failure modes and the run ledger stays consistent with the invocation.
  if (status === 'failed') {
    const message = content?.kind === 'error' ? content.message : undefined;
    const classFromContent =
      content?.kind === 'error' ? (content.reason ?? content.code) : undefined;
    const classFromState = event.actions?.stateDelta?.failureClass;
    return {
      class:
        classFromContent ?? (typeof classFromState === 'string' ? classFromState : 'runtime_error'),
      ...(message ? { message } : {}),
      terminalStatus: status,
    };
  }
  const message = content?.kind === 'error' ? content.message : undefined;
  return {
    class: status,
    ...(message ? { message } : {}),
    terminalStatus: status,
  };
}

function failureFromRawFinishReason(
  rawFinishReason: string | undefined,
): InvocationFailure | undefined {
  if (!rawFinishReason) return undefined;
  const normalized = rawFinishReason.toLowerCase().replace(/_/g, '-');
  if (normalized === 'tool-calls') {
    return {
      class: 'tool_step_cap_reached',
      message: 'model stopped at the tool-call step cap before completing the invocation',
    };
  }
  if (normalized === 'length' || normalized === 'max-tokens') {
    return {
      class: 'max_tokens',
      message: 'model stopped at the token limit before completing the invocation',
    };
  }
  return undefined;
}
