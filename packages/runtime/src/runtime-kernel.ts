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

import type { AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { ContinuationClaimV1, ImmutableRuntimePrefixV1 } from '@maka/core/runtime-boundary';
import type { RuntimeEvent, ToolBoundaryProtocol } from '@maka/core/runtime-event';
import type {
  RuntimeContinuationAuthorityStore,
  RuntimeEventStore,
} from '@maka/core/runtime-event-store';
import { isSessionInlineRun } from '@maka/core/agent-run';
import type {
  ActiveInteractionRequestEvent,
  CompleteEvent,
  QueueEnqueueOutcome,
  QueueUpdateEvent,
  SessionEvent,
  TokenUsageEvent,
} from '@maka/core/events';
import type {
  SessionBlockedReason,
  SessionHeader,
  SessionHeaderPatch,
  SessionStatus,
  StoredMessage,
  SystemNoteMessage,
  TurnRecord,
  TurnStateMessage,
} from '@maka/core/session';
import { isDeepStrictEqual } from 'node:util';
import type { ChildAgentTurnInput, UserMessageInput } from '@maka/core/runtime-inputs';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import {
  resolveEffectiveOrchestration,
  type EffectiveOrchestration,
} from '@maka/core/orchestration';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { DEFAULT_TOOL_MODE, type ToolMode } from '@maka/core/tool-mode';
import {
  AgentRun,
  ContinuationStartCommitError,
  type AgentRunActiveSession,
  type AgentRunBeginResult,
  type AgentRunDurability,
  type AgentRunLineage,
  type RuntimeContinuationFailpoint,
} from './agent-run.js';
import { AiSdkFlow, mapSessionEventToRuntimeEvent } from './ai-sdk-flow.js';
import type { AgentBackend, SteeringLease } from '@maka/core/backend-types';
import type { MakaTool } from './tool-runtime.js';
import type {
  InvocationContext,
  InvocationResult,
  InvocationSource,
} from './invocation-context.js';
import {
  issueRuntimeContinuationAdmissionReceipt,
  RuntimeRunner,
  runAdmittedRuntimeContinuation,
} from './runtime-runner.js';
import type {
  BackendFactoryContext,
  BackendRegistry,
  CompactSessionInput,
  ResolvedChildToolActivation,
  SessionStore,
  StopSessionInput,
} from './session-manager.js';
import type { TurnShellPlan } from './shell-detect.js';
import type { ShellRunProcessManager } from './shell-run-manager.js';
import {
  buildStatusPatch,
  buildTurnStateMessage,
  normalizeStopSessionSource,
  turnHasRetainedOutput as messagesHaveRetainedOutput,
} from './session-projection-helpers.js';
import {
  assertAgentDefinitionRunnable,
  buildToolsForAgentDefinition,
  requireBuiltinAgentDefinition,
} from './agent-catalog.js';
import { loadLatestHistoryCompactCheckpointFromRunLedger } from './history-compact-ledger.js';
import {
  canReplaceHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from './history-compact-checkpoint.js';
import {
  HistoryCompactCheckpointCoordinator,
  type HistoryCompactCleanupRequest,
} from './history-compact-checkpoint-coordinator.js';
import { shouldAppendContextCompactionFailedOpenNote } from './context-budget.js';
import {
  buildResumePlanFromRuntimeEvents,
  RuntimeContinuationRevalidationError,
  type RuntimeContinuation,
  type RuntimeContinuationSafetyObservation,
} from './runtime-resume.js';
import { buildContinuationReplayPlan } from './continuation-replay.js';
import { PROVIDER_REPLAY_PROJECTION_VERSION } from './model-history.js';
import {
  matchingTerminalRuntimeEvents,
  terminalRunStatusFromRuntimeEvent,
} from './terminal-run-commit.js';
import {
  RuntimeMessageAuthorityInvariantError,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunIdentity,
  type RuntimeMessageRunOwner,
} from './message-authority.js';
import {
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  bindRuntimeInteractionRun,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunBinding,
  type RuntimeInteractionRunClosureReason,
} from './interaction-authority.js';
import { DeliveryAckQueue, isDeliveryAckQueueClosed } from './delivery-ack-queue.js';

export interface RuntimeKernelLike {
  claimExecution(sessionId: string): RuntimeExecutionClaim;
  runSessionAdmissionMutation?<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T>;
  runSessionQuiescentMutation?<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T>;
  startTurn(
    sessionId: string,
    input: UserMessageInput,
    options?: TurnStartOptions,
  ): AsyncIterable<SessionEvent>;
  resumeContinuation?(
    continuation: RuntimeContinuation,
    options?: ResumeContinuationOptions,
  ): AsyncIterable<SessionEvent>;
  compactSession(sessionId: string, input?: CompactSessionInput): AsyncIterable<SessionEvent>;
  preflightContextCompaction(sessionId: string): Promise<void>;
  startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
    execution?: RuntimeExecutionClaim,
  ): AsyncIterable<SessionEvent>;
  startChildRetry?(
    sessionId: string,
    input: ChildAgentRetryInput,
    execution?: RuntimeExecutionClaim,
  ): AsyncIterable<SessionEvent>;
  stopSession(sessionId: string, input?: StopSessionInput): Promise<void>;
  respondToSandboxBoundary(sessionId: string, response: SandboxBoundaryResponse): Promise<void>;
  listActiveInteractions?(sessionId: string): ActiveInteractionRequestEvent[];
  respondToUserQuestion?(sessionId: string, response: UserQuestionResponse): Promise<void>;
  /** Queue a user message for mid-turn injection at the next step boundary. */
  steer(sessionId: string, text: string): QueueEnqueueOutcome;
  /** Queue a user message to open the turn after the current one finishes. */
  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome;
  /** Drain the followup queue into one `\n\n`-joined prompt, or null if empty. */
  drainFollowup(sessionId: string): string | null;
  /** Take back every queued message (both queues) as one `\n\n`-joined string. */
  retractQueue(sessionId: string): string;
  hasActiveRuns(sessionId: string): boolean;
  /**
   * The turns of the runs in flight for this session. The same fact
   * `hasActiveRuns` reports, named — which is what lets a client tell a turn
   * that has not started yet from one that already ended.
   *
   * A set, not one turn: a session can carry concurrent runs, and a client
   * asking "is anything OTHER than my own turn running" cannot answer that
   * from an arbitrary one of them.
   */
  runningTurnIds?(sessionId: string): string[];
  hasActiveRun?(sessionId: string, runId: string, turnId?: string): boolean;
  updateCachedHeader(sessionId: string, header: SessionHeader): void;
  invalidateBackend(sessionId: string): Promise<void>;
  invalidateCachedBackends(): Promise<void>;
  disposeBackend(sessionId: string): Promise<void>;
}

export class SessionQuiescentMutationBusyError extends Error {
  readonly name = 'SessionQuiescentMutationBusyError';

  constructor(readonly sessionIds: readonly string[]) {
    super('Session mutation cannot start while an execution claim is active');
  }
}

export class RuntimeContextCompactError extends Error {
  readonly name = 'RuntimeContextCompactError';

  constructor(
    readonly code: 'operation_unavailable' | 'session_busy',
    message: string,
  ) {
    super(message);
  }
}

export interface TurnStartOptions {
  runId?: string;
  userMessageId?: string;
  durability?: AgentRunDurability;
  /**
   * Resolve turn admission after this Session has registered a pending start
   * and immediately before AgentRun begins durable/Backend activation.
   */
  admitTurn?: () => Promise<'admitted' | 'cancelled'>;
  onRunStarted?: (runId: string, initialHeader: SessionHeader) => void | Promise<void>;
  execution?: RuntimeExecutionClaim;
}

export interface ResumeContinuationOptions {
  onRunStarted?: () => void | Promise<void>;
}

export interface RuntimeExecutionClaim {
  readonly sessionId: string;
  readonly stopSignal: AbortSignal;
  isStopRequested(): boolean;
  release(): void;
}

export class RuntimeOwnerCleanupError extends Error {
  readonly name = 'RuntimeOwnerCleanupError';

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export interface ChildAgentRetryInput {
  parentRunId: string;
  spec: ChildAgentTurnInput['spec'];
  continuation: RuntimeContinuation;
  /** Retry an ordinary session-inline AgentRun inside a linked child Session. */
  linkedSession?: boolean;
  onRunStarted?: () => void | Promise<void>;
}

/**
 * An embedded session's authoritative pending-message queues plus its event
 * sink. Hosted composition never creates this state; its Host owns admission,
 * snapshots, leases, and follow-up drain.
 */
interface PendingSteeringMessage extends SteeringLease {}

/**
 * A pulled lease is bound to the turn that pulled it: only the issuing turn's
 * backend can settle it (ack/nack stay valid even after ownership moved to an
 * overlapping turn — invalidating a delivered lease would leave it in-flight
 * and redeliver an already-executed message), and no other turn's retract/
 * clear/release may reclaim it while its delivery is still undetermined.
 */
interface LeasedSteeringMessage extends PendingSteeringMessage {
  issuingTurnId: string;
}

interface SessionSteeringState {
  /** Messages waiting to be injected into the running turn at a step boundary. */
  steering: PendingSteeringMessage[];
  /**
   * Leased to the running turn's backend but not yet settled. pull() is the
   * single atomic commit point: an in-flight lease is committed to that
   * turn's delivery — retract/clear reclaim only QUEUED messages — and it
   * settles exactly once, decided solely by the persistence fact: ack when
   * the steering event is durably consumed (even under abort), nack when it
   * provably never persisted. Snapshots count in-flight as still pending so
   * the UI keeps showing the message until it lands in the transcript.
   */
  inFlight: LeasedSteeringMessage[];
  /** Messages waiting to open the next turn. */
  followup: string[];
  /** Pushes a `queue_update` into the active turn's stream; unset when idle. */
  sink?: (event: QueueUpdateEvent) => void;
  activeTurnId?: string;
}

export type BackendActivationBoundary = <T>(operation: () => Promise<T> | T) => Promise<T>;

interface ChildToolActivation {
  readonly tools: readonly MakaTool[];
  readonly shell?: TurnShellPlan;
}

function requireChildToolActivation(
  activation: ChildToolActivation | undefined,
): ChildToolActivation {
  if (!activation) throw new Error('Child tool activation was not prepared');
  return activation;
}

export interface RuntimeKernelDeps {
  store: SessionStore;
  runStore?: AgentRunStore;
  runtimeEventStore?: RuntimeEventStore;
  /** Host capability; each run still gates it by the selected backend. */
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  backends: BackendRegistry;
  newId: () => string;
  now: () => number;
  childTools?: readonly MakaTool[];
  resolveChildTools?: (sessionId: string) => Promise<ResolvedChildToolActivation>;
  runtimeSource?: InvocationSource;
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  repairRunRuntimeLedger?: (sessionId: string, runId: string) => Promise<boolean>;
  shellRuns?: ShellRunProcessManager;
  cleanupHistoryCompactArtifacts?: (input: HistoryCompactCleanupRequest) => Promise<void>;
  inspectContinuationSafety?: (sessionId: string) => Promise<RuntimeContinuationSafetyObservation>;
  safeBoundaryResumeEnabled?: boolean;
  continuationFailpoint?: (point: RuntimeContinuationFailpoint) => Promise<void>;
  runBackendActivation?: BackendActivationBoundary;
  /** Hosted composition capability. When present, the Host owns all message queues. */
  messageAuthority?: RuntimeMessageAuthority;
  /** Hosted composition capability. Omit for embedded interaction ownership. */
  interactionAuthority?: RuntimeInteractionAuthority;
}

export type { HistoryCompactCleanupRequest } from './history-compact-checkpoint-coordinator.js';

interface BackendGeneration extends AgentRunActiveSession {
  sessionId: string;
  generation: number;
  route: { kind: 'parent' } | { kind: 'child'; activeKey: string };
  phase: 'active' | 'stopping' | 'disposing' | 'failed' | 'terminated';
  backend: AgentBackend;
  stopBackend: AgentBackend['stop'];
  stopState:
    | { kind: 'idle' }
    | { kind: 'pending'; task: Promise<void> }
    | { kind: 'failed'; error: unknown };
  disposal?: Promise<BackendDisposalOutcome>;
  disposalFailure?: Error;
  cachedHeader: SessionHeader;
  activeRuns: Map<string, AgentRun>;
  turnToRunId: Map<string, string>;
}

interface StopTarget {
  active?: BackendGeneration;
  readonly generation: number;
  readonly runs: Map<string, StopRunTarget>;
  delivery: { kind: 'pending' } | { kind: 'delivered' } | { kind: 'failed'; error: unknown };
}

interface StopRunTarget {
  run?: AgentRun;
  readonly runId: string;
  readonly turnId: string;
  readonly lineage: AgentRunLineage;
  readonly sessionInline: boolean;
  stopCompleted: boolean;
}

interface StopOperation {
  abortSource: string | undefined;
  ts: number;
  statusProjected: boolean;
  turnProjections: Map<
    string,
    {
      id: string;
      turnId: string;
      lineage: AgentRunLineage;
      message?: TurnStateMessage;
      projected: boolean;
    }
  >;
  abortNote: SystemNoteMessage;
  abortNoteProjected: boolean;
  targets: Map<number, StopTarget>;
  queue: Promise<void>;
}

interface SessionStopIntent {
  input: StopSessionInput;
  readonly claims: Set<PendingExecutionClaim>;
}

type ExecutionClaimOutcome = { ok: true } | { ok: false; error: unknown };

interface PendingExecutionClaim {
  readonly handle: RuntimeExecutionClaim;
  readonly sessionId: string;
  readonly abortController: AbortController;
  readonly cancellation: RuntimeExecutionCancellation;
  readonly admissionBarrier: Promise<void>;
  readonly settled: Promise<void>;
  resolveSettled(): void;
  rejectSettled(error: unknown): void;
  phase: 'pending' | 'attached' | 'reserved' | 'released' | 'failed';
  run?: AgentRun;
  stopIntent?: SessionStopIntent;
  finalization?: ExecutionClaimOutcome;
}

type BackendDisposalOutcome = { ok: true } | { ok: false; error: unknown };

interface BackendInvalidationState {
  readonly outcome: Promise<BackendDisposalOutcome>;
  resolve(outcome: BackendDisposalOutcome): void;
  disposal?: Promise<void>;
  failure?: Error;
}

interface InteractionRequestOwner {
  sessionId: string;
  turnId: string;
  generation: number;
  request: ActiveInteractionRequestEvent;
}

export class RuntimeKernel implements RuntimeKernelLike {
  private readonly active = new Map<string, BackendGeneration>();
  private readonly childActive = new Map<string, BackendGeneration>();
  private readonly backendGenerations = new Map<number, BackendGeneration>();
  private readonly backendActivationBuilds = new Map<string, Promise<BackendGeneration>>();
  private readonly stopOperations = new Map<string, StopOperation>();
  private readonly stopAttempts = new Map<string, Promise<void>>();
  private readonly executionClaims = new Map<string, Set<PendingExecutionClaim>>();
  private readonly sessionMutationTails = new Map<string, Promise<void>>();
  private readonly executionClaimStates = new WeakMap<
    RuntimeExecutionClaim,
    PendingExecutionClaim
  >();
  private readonly stopIntents = new Map<string, SessionStopIntent>();
  private readonly historyCompactCoordinator: HistoryCompactCheckpointCoordinator;
  private readonly pendingContinuationClaims = new Set<string>();
  private readonly pendingContinuationSessions = new Set<string>();
  private readonly steeringBySession = new Map<string, SessionSteeringState>();
  private readonly backendInvalidations = new Map<string, BackendInvalidationState>();
  private readonly interactionRequestOwners = new Map<string, InteractionRequestOwner>();
  private nextBackendGeneration = 0;
  private readonly interactionRuns = new Map<AgentRun, RuntimeInteractionRunBinding>();

  constructor(private readonly deps: RuntimeKernelDeps) {
    if (deps.runStore && !deps.runtimeEventStore) {
      throw new Error('RuntimeEventStore is required when AgentRunStore is configured');
    }
    this.historyCompactCoordinator = new HistoryCompactCheckpointCoordinator(deps);
  }

  private async runBackendActivation<T>(operation: () => Promise<T> | T): Promise<T> {
    return await (this.deps.runBackendActivation?.(operation) ?? operation());
  }

  claimExecution(sessionId: string): RuntimeExecutionClaim {
    if (this.stopIntents.has(sessionId)) {
      throw new Error(`Session ${sessionId} is stopping and cannot admit a new execution`);
    }
    let resolveSettled!: () => void;
    let rejectSettled!: (error: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });
    // A failed claim may have no concurrent stop subscriber; stop still observes this same promise.
    void settled.catch(() => undefined);
    const abortController = new AbortController();
    const cancellation = new RuntimeExecutionCancellation(sessionId);
    const handle: RuntimeExecutionClaim = {
      sessionId,
      stopSignal: abortController.signal,
      isStopRequested: () => state.stopIntent !== undefined,
      release: () => this.releaseExecutionClaim(state),
    };
    const state: PendingExecutionClaim = {
      handle,
      sessionId,
      abortController,
      cancellation,
      admissionBarrier: this.sessionMutationTails.get(sessionId) ?? Promise.resolve(),
      settled,
      resolveSettled,
      rejectSettled,
      phase: 'pending',
    };
    let claims = this.executionClaims.get(sessionId);
    if (!claims) {
      claims = new Set();
      this.executionClaims.set(sessionId, claims);
    }
    claims.add(state);
    this.executionClaimStates.set(handle, state);
    return handle;
  }

  async runSessionAdmissionMutation<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const ids = this.normalizeSessionMutationIds(sessionIds);
    return this.enqueueSessionMutation(ids, operation);
  }

  async runSessionQuiescentMutation<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const ids = this.normalizeSessionMutationIds(sessionIds);
    if (ids.some((sessionId) => (this.executionClaims.get(sessionId)?.size ?? 0) > 0)) {
      throw new SessionQuiescentMutationBusyError(ids);
    }
    return this.enqueueSessionMutation(ids, operation);
  }

  private normalizeSessionMutationIds(sessionIds: readonly string[]): string[] {
    const ids = [...new Set(sessionIds)].sort();
    if (ids.length === 0 || ids.some((sessionId) => sessionId.length === 0)) {
      throw new Error('Session mutation requires at least one valid Session identity');
    }
    return ids;
  }

  private async enqueueSessionMutation<T>(
    ids: readonly string[],
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const precedingMutations = ids.map(
      (sessionId) => this.sessionMutationTails.get(sessionId) ?? Promise.resolve(),
    );
    const preceding = Promise.all(precedingMutations).then(() => undefined);
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const tail = preceding.then(() => completion);
    for (const sessionId of ids) this.sessionMutationTails.set(sessionId, tail);
    void tail.then(() => {
      for (const sessionId of ids) {
        if (this.sessionMutationTails.get(sessionId) === tail) {
          this.sessionMutationTails.delete(sessionId);
        }
      }
    });

    try {
      await preceding;
      return await operation();
    } finally {
      complete();
    }
  }

  private takeExecutionClaim(
    sessionId: string,
    supplied?: RuntimeExecutionClaim,
  ): PendingExecutionClaim {
    const handle = supplied ?? this.claimExecution(sessionId);
    const state = this.executionClaimStates.get(handle);
    if (!state || state.sessionId !== sessionId || state.phase !== 'pending') {
      throw new Error(`Execution claim does not own pending admission for session ${sessionId}`);
    }
    return state;
  }

  private async enterExecutionClaim(execution: PendingExecutionClaim): Promise<void> {
    await execution.admissionBarrier;
    if (execution.phase !== 'pending') {
      throw new Error(
        `Execution claim cannot enter admission from phase ${execution.phase} for session ${execution.sessionId}`,
      );
    }
  }

  private attachExecutionClaim(execution: PendingExecutionClaim, run: AgentRun): void {
    if (execution.phase !== 'pending') {
      throw new Error(
        `Execution claim cannot attach Run ${run.runId} from phase ${execution.phase}`,
      );
    }
    execution.run = run;
    execution.phase = 'attached';
    if (execution.stopIntent) run.stop(execution.stopIntent.input.source);
  }

  private reserveExecutionClaim(
    execution: PendingExecutionClaim,
    active: BackendGeneration,
    run: AgentRun,
  ): void {
    if (execution.phase !== 'attached' || execution.run !== run) {
      throw new Error(`Execution claim does not own attached Run ${run.runId}`);
    }
    try {
      if (execution.stopIntent) {
        this.claimRunForStop(execution.sessionId, execution.stopIntent.input, active, run);
      }
    } catch (error) {
      this.unregisterRun(active, run);
      execution.phase = 'failed';
      this.settleExecutionClaim(execution, { ok: false, error });
      throw error;
    }
    execution.phase = 'reserved';
  }

  private settleReservedExecutionClaim(
    execution: PendingExecutionClaim,
    run: AgentRun,
    outcome: ExecutionClaimOutcome,
  ): void {
    if (
      (execution.phase === 'attached' || execution.phase === 'failed') &&
      execution.run === run &&
      !outcome.ok
    ) {
      return;
    }
    if (execution.phase !== 'reserved' || execution.run !== run) {
      throw new Error(`Execution claim cannot settle reserved Run ${run.runId}`);
    }
    execution.phase = outcome.ok ? 'released' : 'failed';
    this.settleExecutionClaim(execution, outcome);
  }

  private releaseExecutionClaim(execution: PendingExecutionClaim): void {
    if (execution.phase !== 'pending' && execution.phase !== 'attached') return;
    if (execution.phase === 'attached' && execution.stopIntent) {
      this.settleStoppedAttachedExecution(execution);
      return;
    }
    execution.phase = 'released';
    this.settleExecutionClaim(execution, { ok: true });
  }

  private settleExecutionClaim(
    execution: PendingExecutionClaim,
    outcome: ExecutionClaimOutcome,
  ): void {
    const claims = this.executionClaims.get(execution.sessionId);
    claims?.delete(execution);
    if (claims?.size === 0) this.executionClaims.delete(execution.sessionId);
    if (outcome.ok) execution.resolveSettled();
    else execution.rejectSettled(outcome.error);
  }

  private async finalizeExecutionClaimRun(
    execution: PendingExecutionClaim,
    run: AgentRun,
    finalize: () => Promise<void>,
  ): Promise<void> {
    let outcome: ExecutionClaimOutcome;
    try {
      await finalize();
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (execution.phase === 'attached' && execution.run === run) {
      execution.finalization = outcome;
      this.settleStoppedAttachedExecution(execution);
    }
    if (!outcome.ok) throw outcome.error;
  }

  private settleStoppedAttachedExecution(execution: PendingExecutionClaim): void {
    if (execution.phase !== 'attached' || !execution.stopIntent || !execution.finalization) {
      return;
    }
    const outcome = execution.finalization;
    execution.phase = outcome.ok ? 'released' : 'failed';
    this.settleExecutionClaim(execution, outcome);
  }

  async *startTurn(
    sessionId: string,
    input: UserMessageInput,
    options: TurnStartOptions = {},
  ): AsyncIterable<SessionEvent> {
    if (this.pendingContinuationSessions.has(sessionId)) {
      throw new Error('Cannot start a turn while a runtime continuation is being claimed');
    }
    const execution = this.takeExecutionClaim(sessionId, options.execution);
    try {
      await this.enterExecutionClaim(execution);
      const header = await this.deps.store.readHeader(sessionId);
      let workspaceIdentity: string | undefined;
      if (this.deps.safeBoundaryResumeEnabled === true && this.deps.inspectContinuationSafety) {
        try {
          workspaceIdentity = (await this.deps.inspectContinuationSafety(sessionId))
            .workspaceIdentity;
        } catch {
          // A new turn remains usable without continuation metadata. Actual
          // continuation claims inspect the same facts strictly below.
        }
      }
      const run = new AgentRun({
        sessionId,
        header,
        userInput: input,
        runId: options.runId,
        userMessageId: options.userMessageId,
        durability: options.durability,
        store: this.deps.store,
        runStore: this.deps.runStore,
        runtimeEventStore: this.deps.runtimeEventStore,
        ...(this.deps.toolBoundaryProtocol
          ? { toolBoundaryProtocol: this.deps.toolBoundaryProtocol }
          : {}),
        repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
        newId: this.deps.newId,
        now: this.deps.now,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        hooks: {
          reserveRun: async (targetSessionId, nextHeader, activeRun) => {
            const active = await this.reserveParentRun(
              targetSessionId,
              nextHeader,
              activeRun,
              execution,
            );
            this.reserveExecutionClaim(execution, active, activeRun);
            return active;
          },
          unregisterRun: (active, activeRun) => this.unregisterParentRun(active, activeRun),
          updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
          updateStatus: (targetSessionId, status, blockedReason, ts) =>
            this.updateStatus(targetSessionId, status, blockedReason, ts),
          appendTurnState: (targetSessionId, turnId, status, lineage, options) =>
            this.appendTurnState(targetSessionId, turnId, status, lineage, options),
        },
      });
      if (options.admitTurn && (await options.admitTurn()) === 'cancelled') {
        throw new Error('Turn start was cancelled before runtime admission');
      }
      this.attachExecutionClaim(execution, run);
      yield* this.runAgentTurn(sessionId, input, run, execution, {
        steering: true,
        onRunStarted: options.onRunStarted,
        initialHeader: header,
      });
    } finally {
      this.releaseExecutionClaim(execution);
    }
  }

  async *resumeContinuation(
    continuationInput: RuntimeContinuation,
    options: ResumeContinuationOptions = {},
  ): AsyncIterable<SessionEvent> {
    const continuation = snapshotRuntimeContinuation(continuationInput);
    const claimKey = [
      continuation.sessionId,
      continuation.sourceRunId,
      continuation.sourceRuntimeEventHighWater,
    ].join(':');
    if (this.pendingContinuationClaims.has(claimKey)) {
      throw new Error('Runtime continuation source claim is already in progress');
    }
    if (this.pendingContinuationSessions.has(continuation.sessionId)) {
      throw new Error('Runtime continuation session claim is already in progress');
    }
    const execution = this.takeExecutionClaim(continuation.sessionId);
    this.pendingContinuationClaims.add(claimKey);
    this.pendingContinuationSessions.add(continuation.sessionId);
    try {
      yield* this.resumeContinuationClaimed(continuation, execution, options);
    } finally {
      this.pendingContinuationClaims.delete(claimKey);
      this.pendingContinuationSessions.delete(continuation.sessionId);
      this.releaseExecutionClaim(execution);
    }
  }

  private async *resumeContinuationClaimed(
    continuation: RuntimeContinuation,
    execution: PendingExecutionClaim,
    options: ResumeContinuationOptions,
  ): AsyncIterable<SessionEvent> {
    await this.enterExecutionClaim(execution);
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Runtime continuation requires AgentRunStore and RuntimeEventStore');
    }
    const continuationAuthority = requireRuntimeContinuationAuthority(this.deps.runtimeEventStore);
    if (
      this.hasActiveRuns(continuation.sessionId) ||
      (this.executionClaims.get(continuation.sessionId)?.size ?? 0) > 1
    ) {
      throw new Error('Cannot continue while another run is active');
    }

    const header = await this.deps.store.readHeader(continuation.sessionId);
    const sourceRun = await this.deps.runStore.readRun(
      continuation.sessionId,
      continuation.sourceRunId,
    );
    const sourceEvents = await revalidateContinuationBoundary(continuationAuthority, continuation);
    assertContinuationSourceUnchanged(continuation, sourceRun, sourceEvents);
    await this.revalidateContinuationSafety(continuation);

    const userInput: UserMessageInput = {
      turnId: continuation.turnId,
      text: '',
      parentRunId: continuation.sourceRunId,
      parentTurnId: continuation.sourceTurnId,
    };
    const effectiveOrchestration = effectiveOrchestrationForRun(sourceRun, header);
    const effectiveToolMode = effectiveToolModeForRun(sourceRun);
    const claimedAt = this.deps.now();
    const targetRunHeader = continuationTargetRunHeaderForExecution({
      continuation,
      sessionHeader: header,
      userInput,
      workspaceIdentity: continuation.safetySnapshot.workspaceIdentity,
      effectiveOrchestration,
      effectiveToolMode,
      claimedAt,
    });
    const claim = continuationClaimForExecution(continuation, claimedAt, targetRunHeader);
    const claimResult = await continuationAuthority.claimContinuation({ claim });
    if (claimResult.kind !== 'acquired') {
      throw new RuntimeContinuationRevalidationError(
        'continuation_claim_conflict',
        `Runtime continuation boundary is already claimed by ${claimResult.claim.claimId}`,
      );
    }
    await this.deps.continuationFailpoint?.('after_continuation_claim_committed');

    const sessionRuns = await this.deps.runStore.listSessionRuns(continuation.sessionId);
    const existingClaim = sessionRuns.find(
      (runHeader) =>
        runHeader.continuationSource?.sourceRunId === continuation.sourceRunId &&
        runHeader.continuationSource.sourceRuntimeEventHighWater ===
          continuation.sourceRuntimeEventHighWater,
    );
    if (existingClaim) {
      throw new RuntimeContinuationRevalidationError(
        'continuation_claim_conflict',
        `Runtime continuation source already has a continuation child: ${existingClaim.runId}`,
      );
    }
    const existingTarget = sessionRuns.find((runHeader) => runHeader.runId === continuation.runId);
    if (existingTarget) {
      throw new RuntimeContinuationRevalidationError(
        'target_run_conflict',
        'Runtime continuation target run already exists',
      );
    }

    const continuationToolBoundaryProtocol = this.deps.toolBoundaryProtocol;
    const run = new AgentRun({
      sessionId: continuation.sessionId,
      header,
      userInput,
      runId: continuation.runId,
      invocationId: continuation.invocationId,
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      ...(continuationToolBoundaryProtocol
        ? { toolBoundaryProtocol: continuationToolBoundaryProtocol }
        : {}),
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      workspaceIdentity: continuation.safetySnapshot.workspaceIdentity,
      effectiveOrchestration,
      claimedRunHeader: claim.targetRunHeader,
      effectiveToolMode,
      continuationFailpoint: this.deps.continuationFailpoint,
      commitContinuationStart: async (startedAt) => {
        const source = claim.boundary.segments.at(-1)!;
        const eventId = this.deps.newId();
        const result = await continuationAuthority.commitContinuationStart({
          claim,
          event: {
            id: eventId,
            ...claim.target,
            ts: startedAt,
            partial: false,
            role: 'system',
            author: 'system',
            actions: {
              ...(continuationToolBoundaryProtocol
                ? {
                    runtimeProtocol: {
                      toolBoundary: continuationToolBoundaryProtocol,
                    },
                  }
                : {}),
              continuationStart: {
                protocol: 'continuation_start_v2',
                provenance: 'runtime_admission',
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
          },
        });
        if (!result.created) {
          throw new Error(
            'Continuation-start already existed; refusing to reissue provider admission',
          );
        }
        return { startEventId: eventId, created: true };
      },
      hooks: {
        reserveRun: async (targetSessionId, nextHeader, activeRun) => {
          const active = await this.reserveParentRun(
            targetSessionId,
            nextHeader,
            activeRun,
            execution,
          );
          this.reserveExecutionClaim(execution, active, activeRun);
          return active;
        },
        unregisterRun: (active, activeRun) => this.unregisterParentRun(active, activeRun),
        updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
        updateStatus: (targetSessionId, status, blockedReason, ts) =>
          this.updateStatus(targetSessionId, status, blockedReason, ts),
        appendTurnState: (targetSessionId, turnId, status, lineage, options) =>
          this.appendTurnState(targetSessionId, turnId, status, lineage, options),
      },
    });

    this.attachExecutionClaim(execution, run);
    yield* this.runAgentContinuation(
      continuation,
      run,
      execution,
      {
        sessionId: continuation.sessionId,
        turnId: continuation.turnId,
        runId: continuation.runId,
      },
      options.onRunStarted,
      () => this.revalidateContinuationSafety(continuation),
    );
  }

  async *compactSession(
    sessionId: string,
    input: CompactSessionInput = {},
  ): AsyncIterable<SessionEvent> {
    const execution = this.takeExecutionClaim(sessionId);
    try {
      yield* this.compactSessionClaimed(sessionId, input, execution);
    } finally {
      this.releaseExecutionClaim(execution);
    }
  }

  async preflightContextCompaction(sessionId: string): Promise<void> {
    const execution = this.takeExecutionClaim(sessionId);
    try {
      await this.enterExecutionClaim(execution);
      if (this.hasActiveRuns(sessionId)) {
        throw new RuntimeContextCompactError(
          'session_busy',
          'Cannot compact while a Turn is running',
        );
      }
      const header = await this.deps.store.readHeader(sessionId);
      await this.requireContextCompactionBackend(sessionId, header, execution);
    } finally {
      this.releaseExecutionClaim(execution);
    }
  }

  private async *compactSessionClaimed(
    sessionId: string,
    input: CompactSessionInput,
    execution: PendingExecutionClaim,
  ): AsyncIterable<SessionEvent> {
    await this.enterExecutionClaim(execution);
    if (
      input.minRecentTurns !== undefined &&
      (!Number.isSafeInteger(input.minRecentTurns) || input.minRecentTurns < 0)
    ) {
      throw new Error('Runtime compaction minRecentTurns must be a non-negative safe integer');
    }
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new RuntimeContextCompactError(
        'operation_unavailable',
        'Runtime compaction requires execution stores',
      );
    }
    if (this.hasActiveRuns(sessionId)) {
      throw new RuntimeContextCompactError(
        'session_busy',
        'Cannot compact while a Turn is running',
      );
    }

    const header = await this.deps.store.readHeader(sessionId);
    const turnId = input.turnId ?? this.deps.newId();
    const run = new AgentRun({
      sessionId,
      header,
      userInput: { turnId, text: '' },
      rootExecutionKind: 'context_compact',
      ...(input.hostedRoot ? { runId: input.hostedRoot.runId } : {}),
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      ...(this.deps.toolBoundaryProtocol
        ? { toolBoundaryProtocol: this.deps.toolBoundaryProtocol }
        : {}),
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      effectiveOrchestration: resolveEffectiveOrchestration('default', undefined),
      hooks: {
        reserveRun: async (targetSessionId, nextHeader, activeRun) => {
          const active = await this.reserveParentRun(
            targetSessionId,
            nextHeader,
            activeRun,
            execution,
          );
          this.reserveExecutionClaim(execution, active, activeRun);
          return active;
        },
        unregisterRun: (active, activeRun) => this.unregisterParentRun(active, activeRun),
        updateHeader: (targetSessionId, patch) => this.updateHeader(targetSessionId, patch),
        updateStatus: (targetSessionId, status, blockedReason, ts) =>
          this.updateStatus(targetSessionId, status, blockedReason, ts),
        appendTurnState: (targetSessionId, nextTurnId, status, lineage, options) =>
          this.appendTurnState(targetSessionId, nextTurnId, status, lineage, options),
      },
    });

    this.attachExecutionClaim(execution, run);
    const owners = this.createRunOwnerScope(run, execution);
    let begin: Awaited<ReturnType<typeof run.beginOperation>>;
    try {
      if (input.hostedRoot) {
        owners.bindMessage(this.deps.messageAuthority, {
          sessionId,
          turnId,
          runId: run.runId,
        });
      }
      begin = await this.runBackendActivation(() => run.beginOperation());
      await input.hostedRoot?.onRunStarted?.();
      this.settleReservedExecutionClaim(execution, run, { ok: true });
    } catch (error) {
      await this.finalizeFailedRunStart(owners, run, execution, error);
      return;
    }

    try {
      if (run.isStopped()) return;
      if (!begin.backend.compactHistory) {
        throw new Error(`Backend ${header.backend} changed runtime compaction capability`);
      }
      this.assertRunCanDispatch(run, begin.backend);
      const result = await begin.backend.compactHistory({
        turnId: run.turnId,
        runId: run.runId,
        runtimeContext: begin.runtimeContext,
        ...(input.minRecentTurns !== undefined ? { minRecentTurns: input.minRecentTurns } : {}),
      });
      if (run.isStopped()) return;
      const tokenUsageEvent: TokenUsageEvent = {
        type: 'token_usage',
        id: this.deps.newId(),
        turnId: run.turnId,
        ts: this.deps.now(),
        input: 0,
        output: 0,
        ...(result.contextBudget ? { contextBudget: result.contextBudget } : {}),
      };
      const completeEvent: CompleteEvent = {
        type: 'complete',
        id: this.deps.newId(),
        turnId: run.turnId,
        ts: this.deps.now(),
        stopReason: 'end_turn',
      };
      const invocation = this.compactInvocationContext({
        sessionId,
        runId: run.runId,
        turnId: run.turnId,
        startedAt: begin.startedAt,
      });
      await run.acceptMappedEvent(
        tokenUsageEvent,
        mapSessionEventToRuntimeEvent(tokenUsageEvent, invocation),
        { requireTerminalWrite: true },
      );
      if (run.isStopped()) return;
      await run.recordStoredSessionEvent(tokenUsageEvent);
      if (run.isStopped()) return;
      if (shouldAppendContextCompactionFailedOpenNote(result.contextBudget)) {
        const note: SystemNoteMessage = {
          type: 'system_note',
          id: this.deps.newId(),
          turnId: run.turnId,
          ts: this.deps.now(),
          kind: 'context_compaction_failed_open',
        };
        await this.deps.store.appendMessage(sessionId, note).catch(() => {});
      }
      yield tokenUsageEvent;
      if (run.isStopped()) return;
      await run.acceptMappedEvent(
        completeEvent,
        mapSessionEventToRuntimeEvent(completeEvent, invocation),
        { requireTerminalWrite: true },
      );
      if (run.isStopped()) return;
      yield completeEvent;
    } catch (error) {
      await run.recordFailure(error);
      throw error;
    } finally {
      const failures = new FailureCollector();
      await failures.capture(() => owners.finalize());
      await failures.capture(() => owners.releaseMessage());
      failures.throwIfAny(`Runtime compaction cleanup failed for ${run.runId}`);
    }
  }

  private async requireContextCompactionBackend(
    sessionId: string,
    header: SessionHeader,
    execution: PendingExecutionClaim,
  ): Promise<BackendGeneration> {
    const active = await this.runBackendActivation(() =>
      this.ensureActive(sessionId, header, execution),
    );
    if (!active.backend.compactHistory) {
      throw new RuntimeContextCompactError(
        'operation_unavailable',
        `Backend ${header.backend} does not support runtime compaction`,
      );
    }
    return active;
  }

  async *startChildTurn(
    sessionId: string,
    input: ChildAgentTurnInput,
    suppliedExecution?: RuntimeExecutionClaim,
  ): AsyncIterable<SessionEvent> {
    const execution = this.takeExecutionClaim(sessionId, suppliedExecution);
    try {
      yield* this.startChildTurnClaimed(sessionId, input, execution);
    } finally {
      this.releaseExecutionClaim(execution);
    }
  }

  private async *startChildTurnClaimed(
    sessionId: string,
    input: ChildAgentTurnInput,
    execution: PendingExecutionClaim,
  ): AsyncIterable<SessionEvent> {
    await this.enterExecutionClaim(execution);
    const parentHeader = await this.deps.store.readHeader(sessionId);
    const definition = requireBuiltinAgentDefinition(input.spec.id);
    let childActivation: ChildToolActivation | undefined;
    const childHeader: SessionHeader = {
      ...parentHeader,
      permissionMode: definition.permissionMode,
      connectionLocked: true,
    };
    const userInput: UserMessageInput = {
      turnId: input.turnId,
      text: input.prompt,
      parentRunId: input.parentRunId,
      ...(input.resumedFromRunId ? { resumedFromRunId: input.resumedFromRunId } : {}),
      agentId: definition.id,
      agentName: definition.name,
    };
    const activeKey = childActiveKey(sessionId, input.turnId);
    const run = new AgentRun({
      sessionId,
      header: childHeader,
      userInput,
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      ...(this.deps.toolBoundaryProtocol
        ? { toolBoundaryProtocol: this.deps.toolBoundaryProtocol }
        : {}),
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      effectiveOrchestration: resolveEffectiveOrchestration('default', undefined),
      recordSessionMessages: false,
      hooks: {
        reserveRun: async (targetSessionId, nextHeader, activeRun) => {
          const activation = requireChildToolActivation(childActivation);
          const active = await this.reserveChildRun(
            activeKey,
            targetSessionId,
            nextHeader,
            definition.systemPrompt,
            activation.tools,
            activation.shell,
            activeRun,
            execution,
          );
          this.reserveExecutionClaim(execution, active, activeRun);
          return active;
        },
        unregisterRun: (active, activeRun) => this.unregisterChildRun(active, activeRun),
        updateHeader: async (_targetSessionId, patch) => ({ ...childHeader, ...patch }),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    this.attachExecutionClaim(execution, run);
    yield* this.runAgentTurn(sessionId, userInput, run, execution, {
      prepareBackendActivation: async () => {
        const available = await this.childToolActivationForSession(sessionId);
        assertAgentDefinitionRunnable({ definition, tools: available.tools });
        childActivation = {
          tools: buildToolsForAgentDefinition(available.tools, definition),
          ...(available.shell ? { shell: available.shell } : {}),
        };
      },
    });
  }

  async *startChildRetry(
    sessionId: string,
    input: ChildAgentRetryInput,
    suppliedExecution?: RuntimeExecutionClaim,
  ): AsyncIterable<SessionEvent> {
    const execution = this.takeExecutionClaim(sessionId, suppliedExecution);
    try {
      yield* this.startChildRetryClaimed(sessionId, input, execution);
    } finally {
      this.releaseExecutionClaim(execution);
    }
  }

  private async *startChildRetryClaimed(
    sessionId: string,
    input: ChildAgentRetryInput,
    execution: PendingExecutionClaim,
  ): AsyncIterable<SessionEvent> {
    const continuation = snapshotRuntimeContinuation(input.continuation);
    await this.enterExecutionClaim(execution);
    if (continuation.sessionId !== sessionId) {
      throw new Error('Child retry continuation belongs to a different session');
    }
    const parentHeader = await this.deps.store.readHeader(sessionId);
    const linkedSnapshot = input.linkedSession ? parentHeader.subagentRuntime : undefined;
    if (
      input.linkedSession &&
      (parentHeader.subagentParent?.kind !== 'subagent' ||
        !linkedSnapshot ||
        linkedSnapshot.agentId !== input.spec.id)
    ) {
      throw new Error('Linked child retry is missing its durable runtime snapshot');
    }
    const definition = linkedSnapshot
      ? {
          id: linkedSnapshot.agentId,
          name: linkedSnapshot.agentName,
          systemPrompt: linkedSnapshot.systemPrompt,
          permissionMode: parentHeader.permissionMode,
          tools: linkedSnapshot.toolNames,
        }
      : requireBuiltinAgentDefinition(input.spec.id);
    const preflightActivation = await this.childToolActivationForSession(sessionId);
    if (!linkedSnapshot) {
      assertAgentDefinitionRunnable({
        definition: requireBuiltinAgentDefinition(input.spec.id),
        tools: preflightActivation.tools,
      });
    }
    const preflightChildTools = buildToolsForAgentDefinition(preflightActivation.tools, definition);
    if (linkedSnapshot && preflightChildTools.length !== linkedSnapshot.toolNames.length) {
      throw new Error('Linked child retry durable runtime tool snapshot is unavailable');
    }
    const childHeader: SessionHeader = linkedSnapshot
      ? parentHeader
      : {
          ...parentHeader,
          permissionMode: definition.permissionMode,
          connectionLocked: true,
        };
    const userInput: UserMessageInput = {
      turnId: continuation.turnId,
      text: '',
      ...(!linkedSnapshot ? { parentRunId: input.parentRunId } : {}),
      retriedFromRunId: continuation.sourceRunId,
      agentId: definition.id,
      agentName: definition.name,
    };
    const effectiveOrchestration = resolveEffectiveOrchestration('default', undefined);
    if (!this.deps.runStore || !this.deps.runtimeEventStore) {
      throw new Error('Child retry continuation requires AgentRunStore and RuntimeEventStore');
    }
    const sourceRun = await this.deps.runStore.readRun(sessionId, continuation.sourceRunId);
    const effectiveToolMode = effectiveToolModeForRun(sourceRun);
    const continuationAuthority = requireRuntimeContinuationAuthority(this.deps.runtimeEventStore);
    const sourceEvents = await revalidateContinuationBoundary(continuationAuthority, continuation);
    assertContinuationSourceUnchanged(continuation, sourceRun, sourceEvents);
    await this.revalidateContinuationSafety(
      continuation,
      preflightChildTools.map((tool) => tool.name),
    );

    const claimedAt = this.deps.now();
    const targetRunHeader = continuationTargetRunHeaderForExecution({
      continuation,
      sessionHeader: childHeader,
      userInput,
      workspaceIdentity: continuation.safetySnapshot.workspaceIdentity,
      effectiveOrchestration,
      effectiveToolMode,
      claimedAt,
    });
    const claim = continuationClaimForExecution(continuation, claimedAt, targetRunHeader);
    const claimResult = await continuationAuthority.claimContinuation({
      claim,
    });
    if (claimResult.kind !== 'acquired') {
      throw new RuntimeContinuationRevalidationError(
        'continuation_claim_conflict',
        `Child retry continuation boundary is already claimed by ${claimResult.claim.claimId}`,
      );
    }
    await this.deps.continuationFailpoint?.('after_continuation_claim_committed');
    const continuationToolBoundaryProtocol = this.deps.toolBoundaryProtocol;
    const durableAdmission: {
      claimedRunHeader: AgentRunHeader;
      commitContinuationStart: (
        startedAt: number,
      ) => Promise<{ startEventId: string; created: true }>;
    } = {
      claimedRunHeader: claim.targetRunHeader,
      commitContinuationStart: async (startedAt) => {
        const source = claim.boundary.segments.at(-1)!;
        const eventId = this.deps.newId();
        const result = await continuationAuthority.commitContinuationStart({
          claim,
          event: {
            id: eventId,
            ...claim.target,
            ts: startedAt,
            partial: false,
            role: 'system',
            author: 'system',
            actions: {
              ...(continuationToolBoundaryProtocol
                ? {
                    runtimeProtocol: {
                      toolBoundary: continuationToolBoundaryProtocol,
                    },
                  }
                : {}),
              continuationStart: {
                protocol: 'continuation_start_v2',
                provenance: 'runtime_admission',
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
          },
        });
        if (!result.created) {
          throw new Error(
            'Continuation-start already existed; refusing to reissue provider admission',
          );
        }
        return { startEventId: eventId, created: true };
      },
    };
    const activeKey = childActiveKey(sessionId, continuation.turnId);
    let childActivation: ChildToolActivation | undefined;
    const run = new AgentRun({
      sessionId,
      header: childHeader,
      userInput,
      runId: continuation.runId,
      invocationId: continuation.invocationId,
      store: this.deps.store,
      runStore: this.deps.runStore,
      runtimeEventStore: this.deps.runtimeEventStore,
      ...(continuationToolBoundaryProtocol
        ? { toolBoundaryProtocol: continuationToolBoundaryProtocol }
        : {}),
      repairRunRuntimeLedger: this.deps.repairRunRuntimeLedger,
      newId: this.deps.newId,
      now: this.deps.now,
      workspaceIdentity: continuation.safetySnapshot.workspaceIdentity,
      effectiveOrchestration,
      effectiveToolMode,
      ...durableAdmission,
      recordSessionMessages: false,
      hooks: {
        reserveRun: async (targetSessionId, nextHeader, activeRun) => {
          let active: BackendGeneration;
          if (linkedSnapshot) {
            active = await this.reserveParentRun(targetSessionId, nextHeader, activeRun, execution);
          } else {
            const activation = requireChildToolActivation(childActivation);
            active = await this.reserveChildRun(
              activeKey,
              targetSessionId,
              nextHeader,
              definition.systemPrompt,
              activation.tools,
              activation.shell,
              activeRun,
              execution,
            );
          }
          this.reserveExecutionClaim(execution, active, activeRun);
          return active;
        },
        unregisterRun: (active, activeRun) =>
          linkedSnapshot
            ? this.unregisterParentRun(active, activeRun)
            : this.unregisterChildRun(active, activeRun),
        updateHeader: (targetSessionId, patch) =>
          linkedSnapshot
            ? this.updateHeader(targetSessionId, patch)
            : Promise.resolve({ ...childHeader, ...patch }),
        updateStatus: (targetSessionId, status, blockedReason, ts) =>
          linkedSnapshot
            ? this.updateStatus(targetSessionId, status, blockedReason, ts)
            : Promise.resolve(),
        appendTurnState: (targetSessionId, turnId, status, lineage, options) =>
          linkedSnapshot
            ? this.appendTurnState(targetSessionId, turnId, status, lineage, options)
            : Promise.resolve(),
      },
    });

    this.attachExecutionClaim(execution, run);
    // The retry replays without a second user prompt; the source boundary is
    // consumed through claim + continuation-start T1.
    yield* this.runAgentContinuation(
      continuation,
      run,
      execution,
      input.linkedSession === true
        ? {
            sessionId,
            turnId: continuation.turnId,
            runId: continuation.runId,
          }
        : undefined,
      input.onRunStarted,
      async () => {
        const available = await this.childToolActivationForSession(sessionId);
        if (!linkedSnapshot) {
          assertAgentDefinitionRunnable({
            definition: requireBuiltinAgentDefinition(input.spec.id),
            tools: available.tools,
          });
        }
        const tools = buildToolsForAgentDefinition(available.tools, definition);
        if (linkedSnapshot && tools.length !== linkedSnapshot.toolNames.length) {
          throw new Error('Linked child retry durable runtime tool snapshot is unavailable');
        }
        childActivation = {
          tools,
          ...(available.shell ? { shell: available.shell } : {}),
        };
        await this.revalidateContinuationSafety(
          continuation,
          tools.map((tool) => tool.name),
        );
      },
    );
  }

  private async *runAgentTurn(
    sessionId: string,
    input: UserMessageInput,
    run: AgentRun,
    execution: PendingExecutionClaim,
    options: {
      steering?: boolean;
      onRunStarted?: (runId: string, initialHeader: SessionHeader) => void | Promise<void>;
      initialHeader?: SessionHeader;
      prepareBackendActivation?: () => Promise<void>;
    } = {},
  ): AsyncIterable<SessionEvent> {
    const { steering = false, onRunStarted, initialHeader, prepareBackendActivation } = options;
    const sessionEvents = new DeliveryAckQueue<SessionEvent>();
    const { abortController, release: releaseExecutionAbort } =
      this.inheritExecutionAbort(execution);
    let flowDone = false;
    const owners = this.createRunOwnerScope(run, execution);
    let begin: AgentRunBeginResult;
    try {
      if (steering) {
        owners.bindMessage(this.deps.messageAuthority, {
          sessionId,
          turnId: run.turnId,
          runId: run.runId,
        });
      }
      begin = await this.runBackendActivation(async () => {
        await prepareBackendActivation?.();
        const started = await run.begin();
        await owners.bindInteraction(this.deps.interactionAuthority, {
          sessionId,
          turnId: run.turnId,
          runId: run.runId,
        });
        return started;
      });
      if (onRunStarted && initialHeader) await onRunStarted(run.runId, initialHeader);
    } catch (error) {
      releaseExecutionAbort();
      await this.finalizeFailedRunStart(owners, run, execution, error);
      return;
    }

    const interactionRun = owners.interactionRun;
    const messageOwner = owners.messageOwner;

    // Steering is a top-level-turn affordance only; child agent turns run
    // without a queue. Hosted ownership is bound before begin so a pre-start
    // cancellation can release the exact admitted owner. The pull hook still
    // re-checks this run's turnId so stale or overlapping runs cannot drain
    // messages queued for the current owner.
    let pullSteering: (() => readonly SteeringLease[]) | undefined;
    let ackSteering: ((leaseIds: readonly string[]) => void) | undefined;
    let nackSteering: ((leaseIds: readonly string[]) => void) | undefined;
    if (messageOwner) {
      pullSteering = () => messageOwner?.pull() ?? [];
      ackSteering = (leaseIds) => messageOwner?.ack(leaseIds);
      nackSteering = (leaseIds) => messageOwner?.nack(leaseIds);
    } else if (steering) {
      const state = this.ensureSteering(sessionId);
      state.sink = (event) => {
        void sessionEvents.push(event).catch(() => {});
      };
      state.activeTurnId = run.turnId;
      // Lease, don't consume: pulled messages move to in-flight and only an
      // ack (durable + injected) removes them; a nack or a retract/clear/
      // release reclaims them, so an abort window can never drop text.
      pullSteering = () => {
        const current = this.steeringBySession.get(sessionId);
        if (!current || current.activeTurnId !== run.turnId) return [];
        if (current.steering.length === 0) return [];
        const leased = current.steering.splice(0);
        current.inFlight.push(
          ...leased.map((message) => ({ ...message, issuingTurnId: run.turnId })),
        );
        return leased.map((message) => ({ ...message }));
      };
      // Settlement is keyed by lease id + issuing turn, NOT by current
      // ownership: an overlapping turn that takes the owner slot must not
      // invalidate the issuer's ack (the message was delivered to ITS
      // provider) or intercept its nack. A late settle for a reclaimed lease
      // finds no match and is a no-op.
      ackSteering = (leaseIds) => {
        const current = this.steeringBySession.get(sessionId);
        if (!current) return;
        const ids = new Set(leaseIds);
        const before = current.inFlight.length;
        current.inFlight = current.inFlight.filter(
          (message) => !(ids.has(message.id) && message.issuingTurnId === run.turnId),
        );
        if (current.inFlight.length !== before) this.emitQueueUpdate(sessionId, current);
      };
      nackSteering = (leaseIds) => {
        const current = this.steeringBySession.get(sessionId);
        if (!current) return;
        const ids = new Set(leaseIds);
        const returned = current.inFlight.filter(
          (message) => ids.has(message.id) && message.issuingTurnId === run.turnId,
        );
        if (returned.length === 0) return;
        current.inFlight = current.inFlight.filter(
          (message) => !(ids.has(message.id) && message.issuingTurnId === run.turnId),
        );
        if (current.activeTurnId === run.turnId) {
          // Back to the FRONT of the queue: a re-pull at the next step
          // boundary preserves the user's original ordering.
          current.steering = [
            ...returned.map(({ id, messageId, content }) => ({ id, messageId, content })),
            ...current.steering,
          ];
        } else {
          // The issuer no longer owns the queue (an overlapping turn took
          // over and possibly released): it will never pull again, so the
          // steering queue would strand the text ownerless. The followup
          // queue is its only safe home — the same direction a release-time
          // fold takes.
          current.followup = [
            ...returned.map((message) => message.content.text),
            ...current.followup,
          ];
        }
        this.emitQueueUpdate(sessionId, current);
      };
    }

    const aiSdkFlow = new AiSdkFlow({
      backend: begin.backend,
      stopBackend: this.stopBackendFor(begin.backend),
      beforeDispatch: () => this.assertRunCanDispatch(run, begin.backend),
      ...(interactionRun ? { hostedInteraction: interactionRun } : {}),
      drainAfterTerminal: true,
      onSessionEvent: async (sessionEvent, runtimeEvent) => {
        this.assertInteractionPublication(interactionRun, sessionEvent);
        await run.acceptMappedEvent(sessionEvent, runtimeEvent, {
          requireTerminalWrite: Boolean(this.deps.runtimeEventStore),
          allowInteractionResume: await interactionResumeAllowed(interactionRun, sessionEvent),
        });
        this.observeInteractionEvent(sessionId, begin.backend, sessionEvent);
        await sessionEvents.push(sessionEvent);
      },
      onError: async (error) => {
        if (!isDeliveryAckQueueClosed(error)) {
          await run.recordFailure(error);
          sessionEvents.fail(error);
        }
      },
      onFinally: async () => {
        flowDone = true;
        try {
          await owners.finalize();
          // Release Runtime access BEFORE the event stream closes. Embedded
          // queues still emit their final steering → followup projection here;
          // a hosted owner is only sealed, then the Host performs that handoff
          // under its Session admission gate. The outer finally remains an
          // idempotent backstop for paths that never reach this hook.
          if (messageOwner) owners.releaseMessage();
          else if (steering) this.releaseSteeringTurn(sessionId, run.turnId);
          sessionEvents.close();
        } catch (error) {
          sessionEvents.fail(error);
          throw error;
        }
      },
    });
    const runner = new RuntimeRunner({
      flow: aiSdkFlow,
      providers: { newId: this.deps.newId, now: this.deps.now },
      stopOnTerminal: false,
      ...(run.toolBoundaryProtocol ? { toolBoundaryProtocol: run.toolBoundaryProtocol } : {}),
    });
    if (run.isStopped()) abortController.abort();
    const runnerResult = runner
      .run({
        sessionId,
        invocationId: begin.initialRuntimeEvent.invocationId,
        runId: run.runId,
        turnId: run.turnId,
        ...(begin.backendInput.orchestration
          ? { orchestration: begin.backendInput.orchestration }
          : {}),
        ...(begin.backendInput.toolMode ? { toolMode: begin.backendInput.toolMode } : {}),
        text: input.text,
        ...(begin.backendInput.attachments ? { attachments: begin.backendInput.attachments } : {}),
        ...(begin.backendInput.quotes ? { quotes: begin.backendInput.quotes } : {}),
        context: begin.backendInput.context,
        ...(begin.backendInput.runtimeContext !== undefined
          ? { runtimeContext: begin.backendInput.runtimeContext }
          : {}),
        initialRuntimeEvent: begin.initialRuntimeEvent,
        source: this.deps.runtimeSource ?? 'desktop',
        lineage: run.lineage,
        ...(pullSteering ? { pullSteering } : {}),
        ...(ackSteering ? { ackSteering } : {}),
        ...(nackSteering ? { nackSteering } : {}),
        abortSignal: abortController.signal,
      })
      .then(
        async (result) => {
          if (!flowDone) {
            try {
              flowDone = true;
              await owners.finalize();
              owners.releaseMessage();
              sessionEvents.close();
            } catch (error) {
              sessionEvents.fail(error);
              throw error;
            }
          }
          await this.deps.runtimeInvocationObserver?.(result);
          return result;
        },
        (error) => {
          sessionEvents.fail(error);
          throw error;
        },
      );

    try {
      for await (const event of sessionEvents) {
        yield event;
      }
      await runnerResult;
    } finally {
      try {
        await this.cleanupRunExecution({
          run,
          flow: aiSdkFlow,
          flowDone,
          abortController,
          sessionEvents,
          runnerResult,
          interactionRun,
          finalizeRun: () => owners.finalize(),
          releaseOwner: () => {
            if (messageOwner) owners.releaseMessage();
            else if (steering) this.releaseSteeringTurn(sessionId, run.turnId);
          },
        });
      } finally {
        this.clearInteractionRequestOwners(sessionId, run.turnId);
        releaseExecutionAbort();
      }
    }
  }

  private async *runAgentContinuation(
    continuation: RuntimeContinuation,
    run: AgentRun,
    execution: PendingExecutionClaim,
    messageOwner?: RuntimeMessageRunIdentity,
    onRunStarted?: () => void | Promise<void>,
    revalidateSafety?: () => Promise<void>,
  ): AsyncIterable<SessionEvent> {
    const sessionEvents = new DeliveryAckQueue<SessionEvent>();
    const { abortController, release: releaseExecutionAbort } =
      this.inheritExecutionAbort(execution);
    let flowDone = false;
    const owners = this.createRunOwnerScope(run, execution);
    let begin: Awaited<ReturnType<AgentRun['beginContinuation']>>;
    try {
      if (messageOwner) owners.bindMessage(this.deps.messageAuthority, messageOwner);
      begin = await this.runBackendActivation(async () => {
        if (!revalidateSafety) {
          throw new Error('Durable continuation omitted final safety revalidation');
        }
        await revalidateSafety();
        const started = await run.beginContinuation(continuation);
        await owners.bindInteraction(this.deps.interactionAuthority, {
          sessionId: continuation.sessionId,
          turnId: run.turnId,
          runId: run.runId,
        });
        return started;
      });
      await onRunStarted?.();
    } catch (error) {
      releaseExecutionAbort();
      if (error instanceof ContinuationStartCommitError) {
        await owners.abandonUnstartedContinuation(error);
        return;
      }
      await this.finalizeFailedRunStart(owners, run, execution, error);
      return;
    }

    const interactionRun = owners.interactionRun;

    const aiSdkFlow = new AiSdkFlow({
      backend: begin.backend,
      stopBackend: this.stopBackendFor(begin.backend),
      beforeDispatch: () => this.assertRunCanDispatch(run, begin.backend),
      ...(interactionRun ? { hostedInteraction: interactionRun } : {}),
      drainAfterTerminal: true,
      onSessionEvent: async (sessionEvent, runtimeEvent) => {
        this.assertInteractionPublication(interactionRun, sessionEvent);
        await run.acceptMappedEvent(sessionEvent, runtimeEvent, {
          requireTerminalWrite: true,
          allowInteractionResume: await interactionResumeAllowed(interactionRun, sessionEvent),
        });
        this.observeInteractionEvent(continuation.sessionId, begin.backend, sessionEvent);
        await sessionEvents.push(sessionEvent);
      },
      onError: async (error) => {
        if (!isDeliveryAckQueueClosed(error)) {
          await run.recordFailure(error);
          sessionEvents.fail(error);
        }
      },
      onFinally: async () => {
        flowDone = true;
        try {
          await owners.finalize();
          owners.releaseMessage();
          sessionEvents.close();
        } catch (error) {
          sessionEvents.fail(error);
          throw error;
        }
      },
    });
    const runner = new RuntimeRunner({
      flow: aiSdkFlow,
      providers: { newId: this.deps.newId, now: this.deps.now },
      stopOnTerminal: false,
      ...(run.toolBoundaryProtocol ? { toolBoundaryProtocol: run.toolBoundaryProtocol } : {}),
    });
    if (run.isStopped()) abortController.abort();
    let runnerFailure: unknown;
    const runnerResult = runAdmittedRuntimeContinuation(
      runner,
      issueRuntimeContinuationAdmissionReceipt(
        runner,
        continuation,
        'continuationStartAdmission' in begin
          ? begin.continuationStartAdmission
          : (() => {
              throw new Error('Durable continuation is missing its start admission');
            })(),
        { orchestration: run.effectiveOrchestration, toolMode: run.toolMode },
      ),
      {
        source: this.deps.runtimeSource ?? 'desktop',
        abortSignal: abortController.signal,
      },
    ).then(
      async (result) => {
        if (!flowDone) {
          try {
            flowDone = true;
            await owners.finalize();
            owners.releaseMessage();
            sessionEvents.close();
          } catch (error) {
            runnerFailure = error;
            sessionEvents.fail(error);
            throw error;
          }
        }
        await this.deps.runtimeInvocationObserver?.(result);
        return result;
      },
      (error) => {
        runnerFailure = error;
        sessionEvents.fail(error);
        throw error;
      },
    );

    try {
      for await (const event of sessionEvents) {
        yield event;
      }
      await runnerResult;
    } finally {
      try {
        await this.cleanupRunExecution({
          run,
          flow: aiSdkFlow,
          flowDone,
          abortController,
          sessionEvents,
          runnerResult,
          interactionRun,
          ...(runnerFailure !== undefined ? { runnerFailure } : {}),
          finalizeRun: () => owners.finalize(),
          releaseOwner: () => owners.releaseMessage(),
        });
      } finally {
        this.clearInteractionRequestOwners(continuation.sessionId, run.turnId);
        releaseExecutionAbort();
      }
    }
  }

  private async revalidateContinuationSafety(
    continuation: RuntimeContinuation,
    availableToolNames?: readonly string[],
  ): Promise<void> {
    if (!this.deps.inspectContinuationSafety) {
      throw new Error('Runtime continuation requires an authoritative safety inspector');
    }
    const observation = await this.deps.inspectContinuationSafety(continuation.sessionId);
    assertContinuationSafetyUnchanged(
      continuation,
      availableToolNames ? { ...observation, availableToolNames } : observation,
    );
  }

  private inheritExecutionAbort(execution: PendingExecutionClaim): {
    abortController: AbortController;
    release(): void;
  } {
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort(execution.abortController.signal.reason);
    execution.abortController.signal.addEventListener('abort', onAbort, { once: true });
    if (execution.abortController.signal.aborted) onAbort();
    return {
      abortController,
      release: () => execution.abortController.signal.removeEventListener('abort', onAbort),
    };
  }

  private async finalizeFailedRunStart(
    owners: RuntimeRunOwnerScope,
    run: AgentRun,
    execution: PendingExecutionClaim,
    error: unknown,
  ): Promise<void> {
    try {
      await owners.failStart(error);
    } catch (failure) {
      if (run.isStopped() && isExecutionCancellation(failure, execution.cancellation)) return;
      throw failure;
    }
  }

  private createRunOwnerScope(
    run: AgentRun,
    execution: PendingExecutionClaim,
  ): RuntimeRunOwnerScope {
    return new RuntimeRunOwnerScope(run, {
      registerInteraction: (binding) => this.registerInteractionRun(run, binding),
      releaseInteraction: (binding) => this.releaseInteractionRun(run, binding),
      settleReservedExecution: (outcome) =>
        this.settleReservedExecutionClaim(execution, run, outcome),
      finalizeExecution: (operation) => this.finalizeExecutionClaimRun(execution, run, operation),
    });
  }

  private async cleanupRunExecution(input: {
    run: AgentRun;
    flow: AiSdkFlow;
    flowDone: boolean;
    abortController: AbortController;
    sessionEvents: DeliveryAckQueue<SessionEvent>;
    runnerResult: Promise<InvocationResult>;
    interactionRun: RuntimeInteractionRunBinding | undefined;
    runnerFailure?: unknown;
    finalizeRun: () => Promise<void>;
    releaseOwner: () => void;
  }): Promise<void> {
    const failures = new FailureCollector();

    if (!input.flowDone) {
      input.run.stop('stop_button');
      let interactionClose: Promise<void> | undefined;
      try {
        interactionClose = input.interactionRun?.close(interactionClosureReason(input.run));
      } catch (error) {
        failures.add(error);
      }
      const backendStop = input.flow.stop('user_stop');
      input.abortController.abort();
      input.sessionEvents.close();
      await Promise.all([
        failures.capture(() => interactionClose),
        failures.capture(() => backendStop),
      ]);
      if (input.runnerFailure !== undefined) {
        await failures.capture(() => input.run.recordFailure(input.runnerFailure));
      }
    }

    await input.runnerResult.catch(() => undefined);
    await failures.capture(input.finalizeRun);
    await failures.capture(input.releaseOwner);
    const message = `Run cleanup failed for ${input.run.runId}`;
    try {
      failures.throwIfAny(message);
    } catch (error) {
      if (containsRuntimeOwnerCleanupFailure(error)) {
        throw runtimeOwnerCleanupFailure(message, error);
      }
      throw error;
    }
  }

  private registerInteractionRun(run: AgentRun, binding: RuntimeInteractionRunBinding): void {
    if (
      binding.sessionId !== run.sessionId ||
      binding.turnId !== run.turnId ||
      binding.runId !== run.runId ||
      this.interactionRuns.has(run)
    ) {
      throw new RuntimeInteractionFailStopError(
        `RuntimeKernel could not register exact Interaction Run ${run.runId}`,
        new Error('Interaction Run identity or ownership mismatch'),
      );
    }
    this.interactionRuns.set(run, binding);
  }

  private releaseInteractionRun(run: AgentRun, binding: RuntimeInteractionRunBinding): void {
    const current = this.interactionRuns.get(run);
    if (current && current !== binding) {
      throw new RuntimeInteractionFailStopError(
        `RuntimeKernel could not release exact Interaction Run ${run.runId}`,
        new Error('Interaction Run owner changed before release'),
      );
    }
    binding.release();
    if (current === binding) this.interactionRuns.delete(run);
  }

  private assertInteractionPublication(
    binding: RuntimeInteractionRunBinding | undefined,
    event: SessionEvent,
  ): void {
    if (
      binding &&
      (event.type === 'user_question_request' || event.type === 'sandbox_boundary_request')
    ) {
      binding.assertPendingAdmission(event);
    }
  }

  private compactInvocationContext(input: {
    sessionId: string;
    runId: string;
    turnId: string;
    startedAt: number;
  }): InvocationContext {
    const request = {
      sessionId: input.sessionId,
      invocationId: input.runId,
      runId: input.runId,
      turnId: input.turnId,
      text: '',
      context: [],
      source: this.deps.runtimeSource ?? 'desktop',
    } satisfies InvocationContext['request'];
    return {
      sessionId: input.sessionId,
      invocationId: input.runId,
      runId: input.runId,
      turnId: input.turnId,
      source: this.deps.runtimeSource ?? 'desktop',
      startedAt: input.startedAt,
      request,
      newId: this.deps.newId,
      now: this.deps.now,
    };
  }

  stopSession(sessionId: string, input: StopSessionInput = {}): Promise<void> {
    const existing = this.stopAttempts.get(sessionId);
    if (existing) return existing;
    const intent: SessionStopIntent = { input, claims: new Set() };
    this.stopIntents.set(sessionId, intent);
    const executions = [...(this.executionClaims.get(sessionId) ?? [])];
    for (const execution of executions) {
      execution.stopIntent = intent;
      intent.claims.add(execution);
    }
    for (const execution of executions) execution.run?.stop(input.source);
    for (const execution of executions) {
      execution.abortController.abort(execution.cancellation);
    }
    const attempt = this.stopSessionAttempt(sessionId, intent).finally(() => {
      if (this.stopAttempts.get(sessionId) === attempt) {
        this.stopAttempts.delete(sessionId);
      }
      if (this.stopIntents.get(sessionId) === intent) {
        this.stopIntents.delete(sessionId);
      }
    });
    this.stopAttempts.set(sessionId, attempt);
    return attempt;
  }

  private async stopSessionAttempt(sessionId: string, intent: SessionStopIntent): Promise<void> {
    // Interrupt clears both queues before the abort lands; the emitted empty
    // snapshot lets the UI collapse its pending bar, and callers refill their
    // editor from the mirror captured before the clear.
    this.clearSteering(sessionId);
    const failures: unknown[] = [];
    let operation = this.stopOperations.get(sessionId);
    try {
      for (const active of this.backendGenerationsFor(sessionId)) {
        for (const run of active.activeRuns.values()) {
          operation = this.claimRunForStop(sessionId, intent.input, active, run) ?? operation;
        }
      }
    } catch (error) {
      failures.push(error);
    }

    const claimResults = await Promise.allSettled(
      [...intent.claims].map((execution) => execution.settled),
    );
    for (const result of claimResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 0) {
      const message = `Session ${sessionId} stop ownership failed`;
      const error = failures.length === 1 ? failures[0] : new AggregateError(failures, message);
      if (containsRuntimeOwnerCleanupFailure(error)) {
        throw runtimeOwnerCleanupFailure(message, error);
      }
      throw error;
    }

    operation = this.stopOperations.get(sessionId) ?? operation;
    if (operation) {
      await this.enqueueStopOperation(sessionId, operation, intent.input, true);
    }
  }

  private claimRunForStop(
    sessionId: string,
    input: StopSessionInput,
    active: BackendGeneration,
    run: AgentRun,
  ): StopOperation | undefined {
    run.stop(input.source);
    if (!run.hasPendingStop()) return this.stopOperations.get(sessionId);
    const existingOperation = this.stopOperations.get(sessionId);
    const operation = existingOperation ?? this.buildStopOperation(input);
    const existingTarget = operation.targets.get(active.generation);
    const target =
      existingTarget ??
      ({
        active,
        generation: active.generation,
        runs: new Map(),
        delivery: { kind: 'pending' },
      } satisfies StopTarget);
    const needsRun = !target.runs.has(run.runId);
    const projection =
      needsRun && run.isSessionInline() && !operation.turnProjections.has(run.runId)
        ? {
            id: this.deps.newId(),
            turnId: run.turnId,
            lineage: run.lineage,
            projected: false,
          }
        : undefined;

    if (!existingOperation) this.stopOperations.set(sessionId, operation);
    if (!existingTarget) {
      operation.targets.set(active.generation, target);
    }
    if (needsRun) {
      target.runs.set(run.runId, {
        run,
        runId: run.runId,
        turnId: run.turnId,
        lineage: run.lineage,
        sessionInline: run.isSessionInline(),
        stopCompleted: false,
      });
      if (projection) operation.turnProjections.set(run.runId, projection);
    }
    return operation;
  }

  private buildStopOperation(input: StopSessionInput): StopOperation {
    const abortSource = normalizeStopSessionSource(input.source);
    const ts = this.deps.now();
    return {
      abortSource,
      ts,
      statusProjected: false,
      turnProjections: new Map(),
      abortNote: {
        type: 'system_note',
        id: this.deps.newId(),
        ts,
        kind: 'abort',
        ...(abortSource ? { data: { source: abortSource } } : {}),
      },
      abortNoteProjected: false,
      targets: new Map(),
      queue: Promise.resolve(),
    };
  }

  private enqueueStopOperation(
    sessionId: string,
    operation: StopOperation,
    input: StopSessionInput,
    deliverPending: boolean,
  ): Promise<void> {
    const attempt = operation.queue
      .catch(() => undefined)
      .then(() => this.advanceStopOperation(sessionId, operation, input, deliverPending));
    operation.queue = attempt.catch(() => undefined);
    return attempt;
  }

  private async advanceStopOperation(
    sessionId: string,
    operation: StopOperation,
    input: StopSessionInput,
    deliverPending: boolean,
  ): Promise<void> {
    const stoppedRuns = new Map(
      [...operation.targets.values()].flatMap((target) => [...target.runs.entries()]),
    );
    const failures = new FailureCollector();
    let newlyFailed = false;
    const interactionClosures = [...stoppedRuns.values()].map(async (target) => {
      const run = target.run;
      if (!run) return;
      try {
        await this.interactionRuns.get(run)?.close('turn_stopped');
      } catch (error) {
        newlyFailed = true;
        failures.add(
          interactionFailStop(
            `Could not durably close stopped Runs for session ${sessionId}`,
            error,
          ),
        );
      }
    });
    const undelivered = deliverPending
      ? [...operation.targets.values()].filter((target) => target.delivery.kind === 'pending')
      : [];
    const backendStops = undelivered.map(async (target) => {
      try {
        const active = target.active;
        if (!active) {
          throw new Error(`Backend generation ${target.generation} lost its pending stop owner`);
        }
        if (active.phase === 'active') active.phase = 'stopping';
        await active.stopBackend('user_stop', input.mode);
        target.delivery = { kind: 'delivered' };
      } catch (error) {
        newlyFailed = true;
        target.delivery = { kind: 'failed', error };
        failures.add(error);
      }
    });
    await Promise.all([...interactionClosures, ...backendStops]);
    if (newlyFailed) {
      const message = `Stop cleanup failed for session ${sessionId}`;
      try {
        failures.throwIfAny(message);
      } catch (error) {
        if (containsRuntimeOwnerCleanupFailure(error)) {
          throw runtimeOwnerCleanupFailure(message, error);
        }
        throw error;
      }
    }

    if (!operation.statusProjected) {
      await this.updateStatus(sessionId, 'aborted', undefined, operation.ts);
      operation.statusProjected = true;
    }
    for (const projection of operation.turnProjections.values()) {
      if (projection.projected) continue;
      projection.message ??= buildTurnStateMessage({
        id: projection.id,
        turnId: projection.turnId,
        ts: operation.ts,
        status: 'aborted',
        lineage: projection.lineage,
        ...(operation.abortSource ? { abortSource: operation.abortSource } : {}),
        partialOutputRetained: await this.turnHasRetainedOutput(sessionId, projection.turnId),
      });
      await this.appendStopProjection(sessionId, projection.message);
      projection.projected = true;
    }
    if (!operation.abortNoteProjected) {
      await this.appendStopProjection(sessionId, operation.abortNote);
      operation.abortNoteProjected = true;
    }
    // The Session projection above now reads as aborted. The ledger has to say
    // the same thing before this stop reports success: a Run left non-terminal
    // here stays that way, because the stream that would have finalized it is
    // exactly the one the stop could not wake.
    //
    // Without a Host interaction authority, Runtime owns terminal settlement.
    // A Hosted Run's terminal fact belongs to the Host, which also parks
    // provider-indeterminate Runs that a stop must not resolve on its behalf.
    for (const target of stoppedRuns.values()) {
      if (!this.deps.interactionAuthority) {
        try {
          await target.run?.settleStopTerminal();
        } catch (error) {
          // Leave the target unfinished so the operation stays pending and a
          // retried stop settles it again, the same way a failed projection
          // write is retried above.
          failures.add(error);
          continue;
        }
      }
      target.run?.completeStop();
      target.stopCompleted = true;
    }
    const completed =
      operation.statusProjected &&
      operation.abortNoteProjected &&
      [...operation.turnProjections.values()].every((projection) => projection.projected) &&
      [...operation.targets.values()].every(
        (target) =>
          target.delivery.kind !== 'pending' &&
          [...target.runs.values()].every((run) => run.stopCompleted),
      );
    if (completed && this.stopOperations.get(sessionId) === operation) {
      this.stopOperations.delete(sessionId);
    }
    await Promise.all(
      [...operation.targets.values()].map((target) =>
        target.active ? this.settleBackendGenerationAfterRunExit(target.active) : Promise.resolve(),
      ),
    );
    for (const target of operation.targets.values()) {
      if (target.delivery.kind === 'failed') failures.add(target.delivery.error);
    }
    failures.throwIfAny(`Stop cleanup failed for session ${sessionId}`);
  }

  private async appendStopProjection(sessionId: string, message: StoredMessage): Promise<void> {
    const existing = (await this.deps.store.readMessages(sessionId)).find(
      (candidate) => candidate.id === message.id,
    );
    if (existing) {
      if (!isDeepStrictEqual(existing, message)) {
        throw new Error(`stop projection ${message.id} conflicts with an existing message`);
      }
      return;
    }
    await this.deps.store.appendMessage(sessionId, message);
  }

  async respondToSandboxBoundary(
    sessionId: string,
    response: SandboxBoundaryResponse,
  ): Promise<void> {
    const key = interactionOwnerKey(sessionId, response.requestId);
    const owner = this.interactionRequestOwners.get(key);
    if (owner?.request.type !== 'sandbox_boundary_request') {
      throw new Error(`No pending sandbox boundary request ${response.requestId}`);
    }
    const active = this.backendGenerations.get(owner.generation);
    if (
      !active ||
      active.sessionId !== sessionId ||
      active.phase === 'terminated' ||
      active.phase === 'failed'
    ) {
      this.interactionRequestOwners.delete(key);
      throw new Error(`Sandbox boundary request owner is unavailable: ${response.requestId}`);
    }
    await active.backend.respondToSandboxBoundary(response);
  }

  listActiveInteractions(sessionId: string): ActiveInteractionRequestEvent[] {
    return [...this.interactionRequestOwners.values()]
      .filter((owner) => owner.sessionId === sessionId)
      .sort((left, right) => left.request.ts - right.request.ts)
      .map((owner) => owner.request);
  }

  async respondToUserQuestion(sessionId: string, response: UserQuestionResponse): Promise<void> {
    if (this.deps.interactionAuthority) {
      throw new RuntimeInteractionInvariantError(
        'Hosted user questions must settle through their captured continuation',
      );
    }
    const generations = this.backendGenerationsFor(sessionId);
    await Promise.all(
      generations.map((active) => active.backend.respondToUserQuestion?.(response)),
    );
  }

  // --------------------------------------------------------------------------
  // Steering / followup queues (authoritative source of truth)
  // --------------------------------------------------------------------------

  steer(sessionId: string, text: string): QueueEnqueueOutcome {
    this.assertEmbeddedMessageQueue('steer');
    // Steering's delivery contract is anchored to the runtime event ledger
    // (fail-closed persist + durable-consume ack). Without a RuntimeEventStore
    // that anchor does not exist — same condition as requireTerminalWrite —
    // so fall back to a fresh turn, whose user message the SessionStore
    // persists with the ordinary turn-open guarantee.
    if (!this.deps.runtimeEventStore) return { kind: 'fallback' };
    // Double responsibility (codex): with no live steering owner to inject
    // into — the turn just ended, begin() failed, or only child/compact runs
    // are active (they never consume this queue) — tell the caller to open a
    // fresh turn instead so the message is never dropped.
    const state = this.liveSteeringState(sessionId);
    if (!state) return { kind: 'fallback' };
    const messageId = this.deps.newId();
    state.steering.push({ id: messageId, messageId, content: { text } });
    this.emitQueueUpdate(sessionId, state);
    return { kind: 'queued' };
  }

  queueMessage(sessionId: string, text: string): QueueEnqueueOutcome {
    this.assertEmbeddedMessageQueue('queueMessage');
    const state = this.liveSteeringState(sessionId);
    if (!state) return { kind: 'fallback' };
    state.followup.push(text);
    this.emitQueueUpdate(sessionId, state);
    return { kind: 'queued' };
  }

  drainFollowup(sessionId: string): string | null {
    this.assertEmbeddedMessageQueue('drainFollowup');
    const state = this.steeringBySession.get(sessionId);
    if (!state || state.followup.length === 0) return null;
    const drained = state.followup.splice(0);
    this.emitQueueUpdate(sessionId, state);
    return drained.join('\n\n');
  }

  retractQueue(sessionId: string): string {
    this.assertEmbeddedMessageQueue('retractQueue');
    const state = this.steeringBySession.get(sessionId);
    if (!state) return '';
    // Retract reclaims QUEUED messages only. pull() is the single atomic
    // commit point of delivery: an in-flight lease is already committed to
    // the running turn — its durable append may land at any moment, so
    // handing its text back to the user here would refill AND execute the
    // same directive. An in-flight lease settles only by the persistence
    // fact (ack when the ledger owns it, nack back to a queue otherwise).
    const all = [...state.steering.map((message) => message.content.text), ...state.followup];
    state.steering = [];
    state.followup = [];
    this.emitQueueUpdate(sessionId, state);
    return all.join('\n\n');
  }

  private ensureSteering(sessionId: string): SessionSteeringState {
    const existing = this.steeringBySession.get(sessionId);
    if (existing) return existing;
    const created: SessionSteeringState = { steering: [], inFlight: [], followup: [] };
    this.steeringBySession.set(sessionId, created);
    return created;
  }

  private assertEmbeddedMessageQueue(operation: string): void {
    if (this.deps.messageAuthority) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Hosted Runtime cannot ${operation}; the Runtime Host owns message admission and queues`,
      );
    }
  }

  /**
   * The session's steering state only while a steering-capable top-level run
   * owns it (sink registered after begin() succeeded and not yet released).
   * Child agent and compact runs never establish ownership, so their activity
   * alone yields undefined — enqueue must fall back rather than strand text.
   */
  private liveSteeringState(sessionId: string): SessionSteeringState | undefined {
    const state = this.steeringBySession.get(sessionId);
    return state?.sink ? state : undefined;
  }

  private emitQueueUpdate(sessionId: string, state: SessionSteeringState): void {
    state.sink?.({
      type: 'queue_update',
      id: this.deps.newId(),
      turnId: state.activeTurnId ?? '',
      ts: this.deps.now(),
      steering: [
        ...state.inFlight.map((message) => message.content.text),
        ...state.steering.map((message) => message.content.text),
      ],
      followup: [...state.followup],
    });
  }

  private clearSteering(sessionId: string): void {
    const state = this.steeringBySession.get(sessionId);
    if (!state) return;
    // Same commit-point rule as retractQueue: only QUEUED messages are
    // clearable. An in-flight lease is already committed to the running
    // turn's delivery and settles only by the persistence fact.
    if (state.steering.length === 0 && state.followup.length === 0) return;
    state.steering = [];
    state.followup = [];
    this.emitQueueUpdate(sessionId, state);
  }

  private releaseSteeringTurn(sessionId: string, turnId: string): void {
    const state = this.steeringBySession.get(sessionId);
    if (!state) return;
    // A release folds only the leases THIS turn issued; an overlapping turn's
    // in-flight lease stays for its issuer to settle (acked = delivered, so
    // folding it into followup would redeliver an already-executed message).
    const own = state.inFlight.filter((message) => message.issuingTurnId === turnId);
    if (state.activeTurnId !== turnId) {
      // Not (or no longer) the owner. The issuer's backend settles every
      // lease before its turn ends, so `own` is normally empty; this is a
      // backstop that keeps a never-settled lease from stranding invisibly.
      if (own.length === 0) return;
      state.inFlight = state.inFlight.filter((message) => message.issuingTurnId !== turnId);
      state.followup = [...own.map((message) => message.content.text), ...state.followup];
      this.emitQueueUpdate(sessionId, state);
      return;
    }
    // Stranded steering (arrived after the final step boundary, so no step is
    // left to consume it) becomes the head of the followup queue instead of
    // vanishing — the next turn opens with it first (grok-build safety). The
    // migration is a queue change, so emit the final snapshot BEFORE the sink
    // is cleared; otherwise observers stay on the stale pre-fold snapshot.
    if (state.steering.length > 0 || own.length > 0) {
      state.followup = [
        ...own.map((message) => message.content.text),
        ...state.steering.map((message) => message.content.text),
        ...state.followup,
      ];
      state.inFlight = state.inFlight.filter((message) => message.issuingTurnId !== turnId);
      state.steering = [];
      this.emitQueueUpdate(sessionId, state);
    }
    state.sink = undefined;
    state.activeTurnId = undefined;
  }

  hasActiveRuns(sessionId: string): boolean {
    return this.backendGenerationsFor(sessionId).some((active) => active.activeRuns.size > 0);
  }

  runningTurnIds(sessionId: string): string[] {
    const turnIds: string[] = [];
    for (const active of this.backendGenerationsFor(sessionId)) {
      for (const run of active.activeRuns.values()) {
        if (!turnIds.includes(run.turnId)) turnIds.push(run.turnId);
      }
    }
    return turnIds;
  }

  hasActiveRun(sessionId: string, runId: string, turnId?: string): boolean {
    return this.backendGenerationsFor(sessionId).some((active) => {
      const run = active.activeRuns.get(runId);
      return run !== undefined && (turnId === undefined || run.turnId === turnId);
    });
  }

  updateCachedHeader(sessionId: string, header: SessionHeader): void {
    const active = this.active.get(sessionId);
    if (active) active.cachedHeader = header;
  }

  async invalidateBackend(sessionId: string): Promise<void> {
    this.ensureBackendInvalidation(sessionId);
    await this.flushBackendInvalidation(sessionId);
  }

  async invalidateCachedBackends(): Promise<void> {
    const sessionIds = new Set(
      [...this.backendGenerations.values()].map((generation) => generation.sessionId),
    );
    for (const sessionId of this.backendInvalidations.keys()) sessionIds.add(sessionId);
    await Promise.all(
      [...sessionIds].map(async (sessionId) => {
        const failedGeneration = this.backendGenerationsFor(sessionId).find(
          (generation) => generation.phase === 'failed',
        );
        if (failedGeneration) {
          const retained = await failedGeneration.disposal;
          if (!retained?.ok) throw retained?.error ?? failedGeneration.disposalFailure;
        }
        const invalidation = this.ensureBackendInvalidation(sessionId);
        await this.flushBackendInvalidation(sessionId);
        const outcome = await invalidation.outcome;
        if (!outcome.ok) throw outcome.error;
      }),
    );
  }

  async disposeBackend(sessionId: string): Promise<void> {
    const invalidation = this.ensureBackendInvalidation(sessionId);
    await this.startBackendDisposal(sessionId, invalidation);
    const outcome = await invalidation.outcome;
    if (!outcome.ok) throw outcome.error;
  }

  private async disposeBackendNow(sessionId: string): Promise<BackendDisposalOutcome> {
    const generations = this.backendGenerationsFor(sessionId);
    this.steeringBySession.delete(sessionId);
    this.historyCompactCoordinator.clear(sessionId);
    let disposalError: unknown;
    for (const active of generations) {
      const outcome = await this.quarantineBackendGeneration(active);
      if (!outcome.ok) disposalError ??= outcome.error;
    }
    return disposalError === undefined ? { ok: true } : { ok: false, error: disposalError };
  }

  private backendGenerationsFor(sessionId: string): BackendGeneration[] {
    return [...this.backendGenerations.values()].filter(
      (generation) => generation.sessionId === sessionId && generation.phase !== 'terminated',
    );
  }

  /**
   * Track every request a session can park on until its settlement ack lands,
   * so a surface that was not mounted when the request streamed by can still
   * read it back and render the prompt (#2072).
   */
  private observeInteractionEvent(
    sessionId: string,
    backend: AgentBackend,
    event: SessionEvent,
  ): void {
    if (
      event.type !== 'sandbox_boundary_request' &&
      event.type !== 'user_question_request' &&
      event.type !== 'sandbox_boundary_decision_ack' &&
      event.type !== 'user_question_answer_ack'
    ) {
      return;
    }
    const key = interactionOwnerKey(sessionId, event.requestId);
    if (
      event.type === 'sandbox_boundary_decision_ack' ||
      event.type === 'user_question_answer_ack'
    ) {
      this.interactionRequestOwners.delete(key);
      return;
    }
    const generation = [...this.backendGenerations.values()].find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.backend === backend &&
        candidate.phase !== 'terminated',
    );
    if (!generation) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${event.requestId} has no active backend owner`,
      );
    }
    const existing = this.interactionRequestOwners.get(key);
    if (
      existing &&
      (existing.generation !== generation.generation || existing.turnId !== event.turnId)
    ) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${event.requestId} has conflicting owners`,
      );
    }
    this.interactionRequestOwners.set(key, {
      sessionId,
      turnId: event.turnId,
      generation: generation.generation,
      request: event,
    });
  }

  private clearInteractionRequestOwners(sessionId: string, turnId: string): void {
    for (const [key, owner] of this.interactionRequestOwners) {
      if (owner.sessionId === sessionId && owner.turnId === turnId) {
        this.interactionRequestOwners.delete(key);
      }
    }
  }

  private stopBackendFor(backend: AgentBackend): AgentBackend['stop'] {
    for (const active of this.backendGenerations.values()) {
      if (active.backend === backend) return active.stopBackend;
    }
    throw new Error(`Backend stop owner is unavailable for session ${backend.sessionId}`);
  }

  private createBackendStopOwner(active: BackendGeneration): AgentBackend['stop'] {
    return (reason, mode) => {
      if (active.stopState.kind === 'failed') {
        return Promise.reject(active.stopState.error);
      }
      if (active.stopState.kind === 'pending') return active.stopState.task;
      if (active.phase === 'active') active.phase = 'stopping';
      const attempt = Promise.resolve()
        .then(() => active.backend.stop(reason, mode))
        .catch(async (stopError: unknown) => {
          const disposal = await this.quarantineBackendGeneration(active);
          const failure = disposal.ok
            ? stopError
            : new AggregateError(
                [stopError, disposal.error],
                `Backend generation ${active.generation} stop and disposal failed`,
              );
          active.stopState = { kind: 'failed', error: failure };
          throw failure;
        });
      active.stopState = { kind: 'pending', task: attempt };
      const clear = (): void => {
        if (active.stopState.kind === 'pending' && active.stopState.task === attempt) {
          active.stopState = { kind: 'idle' };
        }
      };
      void attempt.then(clear, clear);
      return attempt;
    };
  }

  private quarantineBackendGeneration(active: BackendGeneration): Promise<BackendDisposalOutcome> {
    if (active.phase === 'terminated') return Promise.resolve({ ok: true });
    if (active.phase === 'failed') {
      return active.disposal ?? Promise.resolve({ ok: false, error: active.disposalFailure });
    }
    active.phase = 'disposing';
    active.disposal ??= this.disposeBackendGeneration(active);
    return active.disposal;
  }

  private disposeBackendGeneration(active: BackendGeneration): Promise<BackendDisposalOutcome> {
    return (async () => {
      let result: BackendDisposalOutcome;
      try {
        await active.backend.dispose();
        result = { ok: true };
      } catch (error) {
        result = { ok: false, error };
      }
      if (result.ok) {
        if (active.activeRuns.size === 0 && !this.stopOperationReferences(active)) {
          this.terminateBackendGeneration(active);
        }
      } else {
        active.disposalFailure = new Error(
          `Backend generation ${active.generation} is permanently quarantined after disposal failed`,
          { cause: result.error },
        );
        active.phase = 'failed';
      }
      return result;
    })();
  }

  private terminateBackendGeneration(active: BackendGeneration): void {
    if (
      active.phase === 'failed' ||
      active.activeRuns.size > 0 ||
      this.stopOperationReferences(active)
    ) {
      return;
    }
    active.phase = 'terminated';
    this.detachBackendGeneration(active);
    this.backendGenerations.delete(active.generation);
  }

  private detachBackendGeneration(active: BackendGeneration): void {
    if (this.active.get(active.sessionId) === active) this.active.delete(active.sessionId);
    for (const [key, child] of this.childActive.entries()) {
      if (child === active) this.childActive.delete(key);
    }
  }

  private stopOperationReferences(active: BackendGeneration): boolean {
    return [...this.stopOperations.values()].some((operation) =>
      [...operation.targets.values()].some((target) => target.active === active),
    );
  }

  /**
   * Builds the backend recorder hooks shared by `ensureActive` and
   * `ensureChildActive`. The two paths are structurally identical except for
   * which active-session map they resolve against — captured here by
   * `resolveActive`, so each call site binds its own resolver. Callers retain
   * the intentionally divergent fields (`allowMidTurnHistoryCompaction`,
   * `shellRunContextSummary`, system prompt/tools source) at their own sites.
   */
  private buildBackendRecorderHooks(input: {
    resolveActive: () => BackendGeneration | undefined;
    sessionId: string;
  }): Pick<
    BackendFactoryContext,
    | 'recordRunTrace'
    | 'recordProviderRequestCapture'
    | 'recordProviderRequestAttempt'
    | 'recordModelCallAttempt'
    | 'recordRunComposition'
    | 'loadHistoryCompactCheckpoint'
    | 'recordHistoryCompactCheckpoint'
    | 'loadTurnRuntimeEvents'
    | 'recordSemanticCompactBlock'
  > {
    const { resolveActive, sessionId } = input;
    const runFor = (turnId: string): AgentRun | undefined => {
      const active = resolveActive();
      const runId = active?.turnToRunId.get(turnId);
      return runId ? active?.activeRuns.get(runId) : undefined;
    };
    return {
      recordRunTrace: (event) => {
        runFor(event.turnId)?.recordRunTrace(event);
      },
      ...(this.deps.runStore
        ? {
            recordProviderRequestCapture: (capture) => {
              const run = runFor(capture.turnId);
              if (!run)
                return Promise.reject(new Error('No active AgentRun for provider request capture'));
              return run.recordProviderRequestCapture(capture);
            },
            recordProviderRequestAttempt: (attempt) => {
              runFor(attempt.turnId)?.recordProviderRequestAttempt(attempt);
            },
            // Resolved by runId rather than turnId: the canonical record names
            // the run it belongs to, so it needs no turn-to-run indirection.
            recordModelCallAttempt: (commit) => {
              const run = resolveActive()?.activeRuns.get(commit.attempt.runId);
              return run?.recordModelCallAttempt(commit) ?? Promise.resolve();
            },
            recordRunComposition: (runId, snapshot) => {
              const run = resolveActive()?.activeRuns.get(runId);
              if (!run) {
                return Promise.reject(new Error('No active AgentRun for Run Composition'));
              }
              return run.recordRunComposition(snapshot);
            },
            loadHistoryCompactCheckpoint: () => this.historyCompactCoordinator.load(sessionId),
            recordHistoryCompactCheckpoint: (
              checkpoint: HistoryCompactCheckpoint,
              turnId: string,
            ) => this.historyCompactCoordinator.record(sessionId, checkpoint, runFor(turnId)),
          }
        : {}),
      ...(this.deps.runtimeEventStore
        ? {
            loadTurnRuntimeEvents: (turnId: string) => {
              const run = runFor(turnId);
              if (!run)
                return Promise.reject(new Error('No active AgentRun for turn runtime events'));
              return run.loadTurnRuntimeEvents();
            },
          }
        : {}),
      recordSemanticCompactBlock: (block) => {
        runFor(block.turnId)?.recordSemanticCompactBlock(block);
      },
    };
  }

  private async ensureActive(
    sessionId: string,
    header: SessionHeader,
    execution: PendingExecutionClaim,
  ): Promise<BackendGeneration> {
    await this.clearBackendQuarantineForActivation(sessionId, execution);
    let existing = this.active.get(sessionId);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    await this.waitForBackendDisposal(sessionId);
    existing = this.active.get(sessionId);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    const entry = await this.shareBackendActivation(`parent:${sessionId}`, async () => {
      const current = this.active.get(sessionId);
      if (current) return current;
      const subagent = await this.resolveSubagentActivation(header);
      const backend = await this.deps.backends.build(header.backend, {
        sessionId,
        workspaceRoot: header.workspaceRoot,
        header,
        store: this.deps.store,
        abortSignal: execution.abortController.signal,
        ...(subagent
          ? {
              systemPrompt: subagent.systemPrompt,
              tools: subagent.tools,
              ...(subagent.shell ? { turnShellPlan: subagent.shell } : {}),
            }
          : {}),
        ...this.buildBackendRecorderHooks({
          resolveActive: () => this.active.get(sessionId),
          sessionId,
        }),
        allowMidTurnHistoryCompaction: Boolean(this.deps.runtimeEventStore),
        shellRunContextSummary: () =>
          this.deps.shellRuns?.buildContextSummary(sessionId) ?? Promise.resolve(undefined),
      });
      await this.rejectCancelledBackendActivation(backend, header, { kind: 'parent' }, execution);
      const generation = this.createBackendGeneration(sessionId, backend, header, {
        kind: 'parent',
      });
      this.active.set(sessionId, generation);
      return generation;
    });
    entry.cachedHeader = header;
    return entry;
  }

  private async shareBackendActivation(
    activationKey: string,
    activate: () => Promise<BackendGeneration>,
  ): Promise<BackendGeneration> {
    let activation = this.backendActivationBuilds.get(activationKey);
    if (!activation) {
      activation = activate();
      this.backendActivationBuilds.set(activationKey, activation);
    }
    try {
      return await activation;
    } finally {
      if (this.backendActivationBuilds.get(activationKey) === activation) {
        this.backendActivationBuilds.delete(activationKey);
      }
    }
  }

  private async resolveSubagentActivation(
    header: SessionHeader,
  ): Promise<{ systemPrompt: string; tools: MakaTool[]; shell?: TurnShellPlan } | undefined> {
    const snapshot = header.subagentRuntime;
    if (!snapshot) {
      if (header.subagentParent) {
        throw new Error('Linked child session is missing its durable runtime snapshot');
      }
      return undefined;
    }
    if (!header.subagentParent) {
      throw new Error('Subagent runtime snapshot requires a linked child session');
    }
    const snapshotDefinition = {
      id: snapshot.agentId,
      permissionMode: header.permissionMode,
      tools: snapshot.toolNames,
    };
    const available = await this.childToolActivationForSession(header.id);
    const tools = buildToolsForAgentDefinition(available.tools, snapshotDefinition);
    if (tools.length !== snapshot.toolNames.length) {
      throw new Error('Subagent runtime tool snapshot is unavailable');
    }
    return {
      systemPrompt: snapshot.systemPrompt,
      tools,
      ...(available.shell ? { shell: available.shell } : {}),
    };
  }

  private async childToolActivationForSession(sessionId: string): Promise<ChildToolActivation> {
    if (!this.deps.resolveChildTools) return { tools: this.deps.childTools ?? [] };
    return await this.deps.resolveChildTools(sessionId);
  }

  private async ensureChildActive(
    activeKey: string,
    sessionId: string,
    header: SessionHeader,
    systemPrompt: string,
    tools: readonly MakaTool[],
    turnShellPlan: TurnShellPlan | undefined,
    execution: PendingExecutionClaim,
  ): Promise<BackendGeneration> {
    await this.clearBackendQuarantineForActivation(sessionId, execution);
    let existing = this.childActive.get(activeKey);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    await this.waitForBackendDisposal(sessionId);
    existing = this.childActive.get(activeKey);
    if (existing) {
      existing.cachedHeader = header;
      return existing;
    }
    const entry = await this.shareBackendActivation(`child:${activeKey}`, async () => {
      const current = this.childActive.get(activeKey);
      if (current) return current;
      const backend = await this.deps.backends.build(header.backend, {
        sessionId,
        workspaceRoot: header.workspaceRoot,
        header,
        store: this.deps.store,
        abortSignal: execution.abortController.signal,
        appendMessage: async () => {},
        systemPrompt,
        tools,
        ...(turnShellPlan ? { turnShellPlan } : {}),
        ...this.buildBackendRecorderHooks({
          resolveActive: () => this.childActive.get(activeKey),
          sessionId,
        }),
        // A child-only ledger cannot claim coverage of the parent session prefix.
        allowMidTurnHistoryCompaction: false,
      });
      await this.rejectCancelledBackendActivation(
        backend,
        header,
        { kind: 'child', activeKey },
        execution,
      );
      const generation = this.createBackendGeneration(sessionId, backend, header, {
        kind: 'child',
        activeKey,
      });
      this.childActive.set(activeKey, generation);
      return generation;
    });
    entry.cachedHeader = header;
    return entry;
  }

  private async reserveParentRun(
    sessionId: string,
    header: SessionHeader,
    run: AgentRun,
    execution: PendingExecutionClaim,
  ): Promise<BackendGeneration> {
    const active = await this.ensureActive(sessionId, header, execution);
    this.reserveGenerationRun(active, run);
    return active;
  }

  private async reserveChildRun(
    activeKey: string,
    sessionId: string,
    header: SessionHeader,
    systemPrompt: string,
    tools: readonly MakaTool[],
    turnShellPlan: TurnShellPlan | undefined,
    run: AgentRun,
    execution: PendingExecutionClaim,
  ): Promise<BackendGeneration> {
    const active = await this.ensureChildActive(
      activeKey,
      sessionId,
      header,
      systemPrompt,
      tools,
      turnShellPlan,
      execution,
    );
    this.reserveGenerationRun(active, run);
    return active;
  }

  private createBackendGeneration(
    sessionId: string,
    backend: AgentBackend,
    header: SessionHeader,
    route: BackendGeneration['route'],
  ): BackendGeneration {
    const active: BackendGeneration = {
      sessionId,
      generation: ++this.nextBackendGeneration,
      route,
      phase: 'active',
      backend,
      stopBackend: undefined as never,
      stopState: { kind: 'idle' },
      cachedHeader: header,
      activeRuns: new Map(),
      turnToRunId: new Map(),
    };
    active.stopBackend = this.createBackendStopOwner(active);
    this.backendGenerations.set(active.generation, active);
    return active;
  }

  private async rejectCancelledBackendActivation(
    backend: AgentBackend,
    header: SessionHeader,
    route: BackendGeneration['route'],
    execution: PendingExecutionClaim,
  ): Promise<void> {
    if (!execution.abortController.signal.aborted) return;
    const generation = this.createBackendGeneration(execution.sessionId, backend, header, route);
    const disposal = await this.quarantineBackendGeneration(generation);
    if (!disposal.ok) {
      throw new AggregateError(
        [execution.cancellation, disposal.error],
        `Cancelled backend activation disposal failed for session ${execution.sessionId}`,
      );
    }
    throw execution.cancellation;
  }

  private reserveGenerationRun(active: BackendGeneration, run: AgentRun): void {
    if (
      active.phase !== 'active' ||
      this.backendGenerations.get(active.generation) !== active ||
      !this.isCurrentGeneration(active)
    ) {
      throw new Error(
        `Backend generation ${active.generation} no longer owns activation for session ${active.sessionId}`,
      );
    }
    if (active.activeRuns.has(run.runId) || active.turnToRunId.has(run.turnId)) {
      throw new Error(`Backend generation ${active.generation} already reserved this Run identity`);
    }
    active.activeRuns.set(run.runId, run);
    active.turnToRunId.set(run.turnId, run.runId);
  }

  private assertRunCanDispatch(run: AgentRun, backend: AgentBackend): void {
    const active = [...this.backendGenerations.values()].find(
      (candidate) => candidate.backend === backend,
    );
    if (
      run.isStopped() ||
      !active ||
      active.phase !== 'active' ||
      !this.isCurrentGeneration(active) ||
      active.activeRuns.get(run.runId) !== run ||
      active.turnToRunId.get(run.turnId) !== run.runId
    ) {
      throw new Error(`Run ${run.runId} no longer owns an active backend generation`);
    }
  }

  private isCurrentGeneration(active: BackendGeneration): boolean {
    return active.route.kind === 'parent'
      ? this.active.get(active.sessionId) === active
      : this.childActive.get(active.route.activeKey) === active;
  }

  private unregisterRun(active: AgentRunActiveSession, run: AgentRun): void {
    active.activeRuns.delete(run.runId);
    if (active.turnToRunId.get(run.turnId) === run.runId) {
      active.turnToRunId.delete(run.turnId);
    }
  }

  private async unregisterParentRun(active: AgentRunActiveSession, run: AgentRun): Promise<void> {
    this.unregisterRun(active, run);
    await this.settleRunStopOperation(active.sessionId, run);
    await this.settleBackendGenerationAfterRunExit(active as BackendGeneration);
    await this.flushBackendInvalidation(active.sessionId);
  }

  private async unregisterChildRun(active: AgentRunActiveSession, run: AgentRun): Promise<void> {
    this.unregisterRun(active, run);
    if (active.activeRuns.size > 0) return;
    await this.settleRunStopOperation(active.sessionId, run);
    const generation = active as BackendGeneration;
    await this.settleBackendGenerationAfterRunExit(generation);
    if (generation.phase === 'active') {
      await this.quarantineBackendGeneration(generation);
    }
    await this.settleBackendGenerationAfterRunExit(generation);
    await this.flushBackendInvalidation(active.sessionId);
  }

  private async settleRunStopOperation(sessionId: string, run: AgentRun): Promise<void> {
    const operation = this.stopOperations.get(sessionId);
    if (
      !operation ||
      ![...operation.targets.values()].some((target) => target.runs.get(run.runId)?.run === run)
    ) {
      return;
    }
    try {
      await this.enqueueStopOperation(sessionId, operation, {}, false);
    } catch {
      // A later public retry continues the retained canonical projection.
    } finally {
      this.releaseStoppedRunReferences(operation, run);
    }
  }

  private releaseStoppedRunReferences(operation: StopOperation, run: AgentRun): void {
    for (const target of operation.targets.values()) {
      const stoppedRun = target.runs.get(run.runId);
      if (stoppedRun?.run === run) stoppedRun.run = undefined;
      if (
        target.active &&
        target.delivery.kind !== 'pending' &&
        ![...target.runs.values()].some((candidate) => candidate.run)
      ) {
        target.active = undefined;
      }
    }
  }

  private async settleBackendGenerationAfterRunExit(active: BackendGeneration): Promise<void> {
    if (active.activeRuns.size > 0 || this.stopOperationReferences(active)) return;
    if (active.phase === 'stopping') {
      active.phase = 'active';
      return;
    }
    if (active.phase !== 'disposing') return;
    const outcome = await active.disposal;
    if (outcome?.ok) this.terminateBackendGeneration(active);
  }

  private async flushBackendInvalidation(sessionId: string): Promise<void> {
    const invalidation = this.backendInvalidations.get(sessionId);
    if (!invalidation || this.hasActiveRuns(sessionId)) return;
    await this.startBackendDisposal(sessionId, invalidation);
  }

  private async waitForBackendDisposal(sessionId: string): Promise<void> {
    const invalidation = this.backendInvalidations.get(sessionId);
    if (!invalidation?.disposal) return;
    const outcome = await invalidation.outcome;
    if (!outcome.ok) throw invalidation.failure ?? outcome.error;
  }

  private async clearBackendQuarantineForActivation(
    sessionId: string,
    execution: PendingExecutionClaim,
  ): Promise<void> {
    const ownsCurrentStop =
      execution.phase === 'attached' &&
      execution.stopIntent !== undefined &&
      this.stopIntents.get(sessionId) === execution.stopIntent;
    if (this.stopOperations.has(sessionId) && !ownsCurrentStop) {
      throw new Error(`Session ${sessionId} is quarantined by a retained stop operation`);
    }
    for (const generation of this.backendGenerationsFor(sessionId)) {
      if (generation.phase === 'failed') {
        throw generation.disposalFailure ?? new Error('Backend generation disposal failed');
      }
      if (generation.phase === 'stopping') {
        throw new Error(
          `Backend generation ${generation.generation} is stopping for session ${sessionId}`,
        );
      }
      if (generation.phase === 'disposing') {
        const outcome = await generation.disposal;
        if (!outcome?.ok) {
          throw generation.disposalFailure ?? outcome?.error;
        }
        if (generation.activeRuns.size > 0 || this.stopOperationReferences(generation)) {
          throw new Error(
            `Backend generation ${generation.generation} is quarantined for session ${sessionId}`,
          );
        }
        this.terminateBackendGeneration(generation);
      }
    }

    const invalidation = this.backendInvalidations.get(sessionId);
    if (!invalidation) return;
    await this.flushBackendInvalidation(sessionId);
    if (this.hasActiveRuns(sessionId)) {
      throw new Error(`Backend generation is quarantined for session ${sessionId}`);
    }
    await this.startBackendDisposal(sessionId, invalidation);
    const outcome = await invalidation.outcome;
    if (!outcome.ok) throw invalidation.failure ?? outcome.error;
  }

  private async startBackendDisposal(
    sessionId: string,
    invalidation: BackendInvalidationState,
  ): Promise<void> {
    if (!invalidation.disposal) {
      invalidation.disposal = (async () => {
        let outcome: BackendDisposalOutcome;
        try {
          outcome = await this.disposeBackendNow(sessionId);
        } catch (error) {
          outcome = { ok: false, error };
        }
        if (!outcome.ok) {
          invalidation.failure = new Error(
            `Backend invalidation is permanently quarantined for session ${sessionId}`,
            { cause: outcome.error },
          );
        }
        invalidation.resolve(outcome);
        if (outcome.ok && this.backendInvalidations.get(sessionId) === invalidation) {
          this.backendInvalidations.delete(sessionId);
        }
      })();
    }
    await invalidation.disposal;
  }

  private ensureBackendInvalidation(sessionId: string): BackendInvalidationState {
    const existing = this.backendInvalidations.get(sessionId);
    if (existing) return existing;
    let resolve!: (outcome: BackendDisposalOutcome) => void;
    const outcome = new Promise<BackendDisposalOutcome>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const invalidation = { outcome, resolve };
    this.backendInvalidations.set(sessionId, invalidation);
    return invalidation;
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
    this.updateCachedHeader(sessionId, next);
    return next;
  }

  private async appendTurnState(
    sessionId: string,
    turnId: string,
    status: TurnRecord['status'],
    lineage: AgentRunLineage = {},
    options: { id?: string; ts?: number; errorClass?: string; abortSource?: string } = {},
  ): Promise<void> {
    const ts = options.ts ?? this.deps.now();
    await this.deps.store.appendMessage(
      sessionId,
      buildTurnStateMessage({
        id: options.id ?? this.deps.newId(),
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
}

function requireRuntimeContinuationAuthority(
  store: RuntimeEventStore,
): RuntimeContinuationAuthorityStore {
  const candidate = store as Partial<RuntimeContinuationAuthorityStore>;
  if (
    candidate.continuationAuthorityCapability !== 'runtime_continuation_authority_v1' ||
    typeof candidate.readImmutableRuntimeEvents !== 'function' ||
    typeof candidate.readImmutableRuntimePrefix !== 'function' ||
    typeof candidate.claimContinuation !== 'function' ||
    typeof candidate.readContinuationClaimStateByBoundary !== 'function' ||
    typeof candidate.listContinuationClaimsForRecovery !== 'function' ||
    typeof candidate.commitContinuationStart !== 'function' ||
    typeof candidate.commitContinuationRepairStart !== 'function'
  ) {
    throw new Error('Runtime continuation requires SQLite continuation authority');
  }
  return candidate as RuntimeContinuationAuthorityStore;
}

async function revalidateContinuationBoundary(
  store: RuntimeContinuationAuthorityStore,
  continuation: RuntimeContinuation,
): Promise<RuntimeEvent[]> {
  if (
    !continuation.boundary ||
    !continuation.providerReplayDigest ||
    continuation.providerProjectionVersion !== PROVIDER_REPLAY_PROJECTION_VERSION
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_identity_changed',
      'Runtime continuation is missing its versioned immutable boundary',
    );
  }
  const prefixes: ImmutableRuntimePrefixV1[] = [];
  const immediateSourceIndex = continuation.boundary.segments.length - 1;
  for (const [index, segment] of continuation.boundary.segments.entries()) {
    const prefix = await store.readImmutableRuntimePrefix({
      sessionId: segment.identity.sessionId,
      runId: segment.identity.runId,
      // Ancestor segments are immutable lineage pins. The immediate source is
      // different: execution must observe its latest durable head so H+1
      // cannot be hidden by rereading only the already-planned prefix.
      ...(index === immediateSourceIndex ? {} : { upToEventSeq: segment.position.lastEventSeq }),
    });
    if (
      !isDeepStrictEqual(prefix.identity, segment.identity) ||
      !isDeepStrictEqual(prefix.position, segment.position) ||
      prefix.prefixDigest !== segment.prefixDigest
    ) {
      throw new RuntimeContinuationRevalidationError(
        'source_identity_changed',
        `Runtime continuation boundary changed for ${segment.identity.runId}`,
      );
    }
    prefixes.push(prefix);
  }
  const replay = buildContinuationReplayPlan({
    prefixes: prefixes as [ImmutableRuntimePrefixV1, ...ImmutableRuntimePrefixV1[]],
    providerProjectionVersion: continuation.providerProjectionVersion,
  });
  if (
    replay.kind !== 'replayable' ||
    replay.plan.boundary.manifestDigest !== continuation.boundary.manifestDigest ||
    replay.plan.providerReplayDigest !== continuation.providerReplayDigest ||
    !isDeepStrictEqual(replay.plan.runtimeContext, continuation.runtimeContext)
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_replay_changed',
      'Runtime continuation replay changed after planning',
    );
  }
  return [...prefixes.at(-1)!.events];
}

function continuationClaimForExecution(
  continuation: RuntimeContinuation,
  claimedAt: number,
  targetRunHeader: AgentRunHeader,
): ContinuationClaimV1 {
  if (
    !continuation.claimId ||
    !continuation.boundary ||
    !continuation.providerReplayDigest ||
    continuation.providerProjectionVersion !== PROVIDER_REPLAY_PROJECTION_VERSION
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_identity_changed',
      'Runtime continuation is missing its durable claim identity',
    );
  }
  return {
    protocol: 'continuation_claim_v1',
    claimId: continuation.claimId,
    boundaryDigest: continuation.boundary.manifestDigest,
    boundary: continuation.boundary,
    providerProjectionVersion: continuation.providerProjectionVersion,
    providerReplayDigest: continuation.providerReplayDigest,
    target: {
      sessionId: continuation.sessionId,
      invocationId: continuation.invocationId,
      runId: continuation.runId,
      turnId: continuation.turnId,
    },
    targetRunHeader,
    claimedAt,
  };
}

function continuationTargetRunHeaderForExecution(input: {
  continuation: RuntimeContinuation;
  sessionHeader: SessionHeader;
  userInput: UserMessageInput;
  workspaceIdentity: string;
  effectiveOrchestration: EffectiveOrchestration;
  effectiveToolMode: ToolMode;
  claimedAt: number;
}): AgentRunHeader {
  const {
    continuation,
    sessionHeader,
    userInput,
    effectiveOrchestration,
    effectiveToolMode,
    claimedAt,
  } = input;
  if (!continuation.claimId || !continuation.boundary) {
    throw new RuntimeContinuationRevalidationError(
      'source_identity_changed',
      'Runtime continuation is missing its durable target-header identity',
    );
  }
  const source = continuation.boundary.segments.at(-1)!;
  return {
    runId: continuation.runId,
    invocationId: continuation.invocationId,
    sessionId: continuation.sessionId,
    turnId: continuation.turnId,
    status: 'created',
    backendKind: sessionHeader.backend,
    llmConnectionSlug: sessionHeader.llmConnectionSlug,
    modelId: sessionHeader.model,
    cwd: sessionHeader.cwd,
    workspaceIdentity: input.workspaceIdentity,
    permissionMode: sessionHeader.permissionMode,
    collaborationMode: sessionHeader.collaborationMode ?? 'agent',
    orchestrationMode: effectiveOrchestration.mode,
    orchestrationSource: effectiveOrchestration.source,
    agentSwarmAuthorization: effectiveOrchestration.agentSwarmAuthorization,
    toolMode: effectiveToolMode,
    createdAt: claimedAt,
    updatedAt: claimedAt,
    ...(userInput.parentRunId ? { parentRunId: userInput.parentRunId } : {}),
    ...(userInput.resumedFromRunId ? { resumedFromRunId: userInput.resumedFromRunId } : {}),
    ...(userInput.retriedFromRunId ? { retriedFromRunId: userInput.retriedFromRunId } : {}),
    ...(userInput.parentTurnId ? { parentTurnId: userInput.parentTurnId } : {}),
    ...(userInput.retriedFromTurnId ? { retriedFromTurnId: userInput.retriedFromTurnId } : {}),
    ...(userInput.regeneratedFromTurnId
      ? { regeneratedFromTurnId: userInput.regeneratedFromTurnId }
      : {}),
    ...(userInput.branchOfTurnId ? { branchOfTurnId: userInput.branchOfTurnId } : {}),
    ...(userInput.parentSessionId ? { parentSessionId: userInput.parentSessionId } : {}),
    ...(userInput.agentId ? { agentId: userInput.agentId } : {}),
    ...(userInput.agentName ? { agentName: userInput.agentName } : {}),
    continuationSource: {
      protocol: 'continuation_source_v2',
      claimId: continuation.claimId,
      boundaryDigest: continuation.boundary.manifestDigest,
      sourceInvocationId: source.identity.invocationId,
      sourceRunId: source.identity.runId,
      sourceTurnId: source.identity.turnId,
      sourceRuntimeEventHighWater: source.position.lastEventSeq,
      sourcePrefixDigest: source.prefixDigest,
      replayManifestDigest: continuation.boundary.manifestDigest,
    },
  };
}

function assertContinuationSourceUnchanged(
  continuation: RuntimeContinuation,
  sourceRun: AgentRunHeader,
  sourceEvents: readonly RuntimeEvent[],
): void {
  if (
    sourceRun.runId !== continuation.sourceRunId ||
    sourceRun.turnId !== continuation.sourceTurnId ||
    sourceRun.sessionId !== continuation.sessionId
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_identity_changed',
      'Runtime continuation source run identity changed after planning',
    );
  }
  const terminalEvents = matchingTerminalRuntimeEvents(sourceRun, sourceEvents);
  const terminalStatus =
    terminalEvents.length === 1 ? terminalRunStatusFromRuntimeEvent(terminalEvents[0]!) : undefined;
  if (terminalStatus === undefined || terminalStatus !== sourceRun.status) {
    throw new RuntimeContinuationRevalidationError(
      'source_terminal_changed',
      'Runtime continuation source is no longer terminal',
    );
  }
  if (sourceEvents.length !== continuation.sourceRuntimeEventHighWater) {
    throw new RuntimeContinuationRevalidationError(
      'source_high_water_changed',
      'Runtime continuation source high-water changed after planning',
    );
  }
  const mismatchedEvent = sourceEvents.find(
    (event) =>
      event.sessionId !== continuation.sessionId ||
      event.invocationId !== continuation.sourceInvocationId ||
      event.runId !== continuation.sourceRunId ||
      event.turnId !== continuation.sourceTurnId,
  );
  if (mismatchedEvent) {
    throw new RuntimeContinuationRevalidationError(
      'source_ledger_identity_changed',
      'Runtime continuation source ledger identity changed after planning',
    );
  }
  if (continuation.boundary) {
    // Composite immutable-prefix and provider replay equality were already
    // revalidated by revalidateContinuationBoundary().
    return;
  }
  const replayPlan = buildResumePlanFromRuntimeEvents(sourceEvents, {
    expectedRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
  });
  const sourceRuntimeContext = continuation.sourceRuntimeContext ?? continuation.runtimeContext;
  if (
    replayPlan.disposition !== 'safe_replay' ||
    !isDeepStrictEqual(replayPlan.replayRuntimeEvents, sourceRuntimeContext)
  ) {
    throw new RuntimeContinuationRevalidationError(
      'source_replay_changed',
      'Runtime continuation replay context changed after planning',
    );
  }
}

function assertContinuationSafetyUnchanged(
  continuation: RuntimeContinuation,
  observation: RuntimeContinuationSafetyObservation,
): void {
  const snapshot = continuation.safetySnapshot;
  if (observation.workspaceIdentity !== snapshot.workspaceIdentity) {
    throw new RuntimeContinuationRevalidationError(
      'workspace_identity_changed',
      'Runtime continuation workspace identity changed after planning',
    );
  }
  if (!observation.backgroundOperationsSettled) {
    throw new RuntimeContinuationRevalidationError(
      'background_operation_started',
      'Runtime continuation background operation started after planning',
    );
  }
  const plannedToolNames = [...new Set(snapshot.availableToolNames)].sort();
  const currentToolNames = [...new Set(observation.availableToolNames)].sort();
  if (!isDeepStrictEqual(plannedToolNames, currentToolNames)) {
    throw new RuntimeContinuationRevalidationError(
      'tool_catalog_changed',
      `Runtime continuation tool catalog changed after planning: planned [${plannedToolNames.join(
        ', ',
      )}], current [${currentToolNames.join(', ')}]`,
    );
  }
  if (snapshot.workspaceCheckpoint) {
    const current = observation.workspaceCheckpoint;
    if (
      !current?.restored ||
      current.ref !== snapshot.workspaceCheckpoint.ref ||
      current.runtimeEventHighWater !== snapshot.workspaceCheckpoint.runtimeEventHighWater
    ) {
      throw new RuntimeContinuationRevalidationError(
        'workspace_checkpoint_changed',
        'Runtime continuation workspace checkpoint changed after planning',
      );
    }
  }
}

function snapshotRuntimeContinuation(continuation: RuntimeContinuation): RuntimeContinuation {
  return deepFreezeContinuationValue(structuredClone(continuation));
}

function deepFreezeContinuationValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreezeContinuationValue(nested);
  }
  return Object.freeze(value);
}

interface RuntimeRunOwnerScopeCallbacks {
  registerInteraction(binding: RuntimeInteractionRunBinding): void;
  releaseInteraction(binding: RuntimeInteractionRunBinding): void;
  settleReservedExecution(outcome: ExecutionClaimOutcome): void;
  finalizeExecution(operation: () => Promise<void>): Promise<void>;
}

class RuntimeRunOwnerScope {
  interactionRun: RuntimeInteractionRunBinding | undefined;
  messageOwner: RuntimeMessageRunOwner | undefined;

  private messageReleased = false;
  private reservedExecutionSettled = false;
  private finalizePromise: Promise<void> | undefined;

  constructor(
    private readonly run: AgentRun,
    private readonly callbacks: RuntimeRunOwnerScopeCallbacks,
  ) {}

  async bindInteraction(
    authority: RuntimeInteractionAuthority | undefined,
    identity: { sessionId: string; turnId: string; runId: string },
  ): Promise<void> {
    try {
      if (authority) {
        this.interactionRun = await bindRuntimeInteractionRun(authority, identity);
        this.callbacks.registerInteraction(this.interactionRun);
      }
    } catch (error) {
      this.settleReservedExecution({ ok: false, error });
      throw error;
    }
    this.settleReservedExecution({ ok: true });
  }

  bindMessage(
    authority: RuntimeMessageAuthority | undefined,
    identity: { sessionId: string; turnId: string; runId: string },
  ): void {
    if (!authority) return;
    this.messageOwner = authority.bindRun(identity);
  }

  async failStart(error: unknown): Promise<never> {
    this.settleReservedExecution({ ok: false, error });
    let failure = error;
    if (this.interactionRun) {
      try {
        await this.interactionRun.close(interactionClosureReason(this.run));
        await this.interactionRun.settleLocalClosures();
        this.callbacks.releaseInteraction(this.interactionRun);
      } catch (closeError) {
        failure = new AggregateError(
          [failure, closeError],
          'Interaction owner bind cleanup failed',
        );
      }
    }
    try {
      this.releaseMessage();
    } catch (releaseError) {
      failure = new AggregateError([failure, releaseError], 'Message owner bind cleanup failed');
    }
    await this.run.recordFailure(failure);
    await this.callbacks.finalizeExecution(() => this.run.finalize());
    throw failure;
  }

  async abandonUnstartedContinuation(error: unknown): Promise<never> {
    this.settleReservedExecution({ ok: false, error });
    this.releaseMessage();
    await this.callbacks.finalizeExecution(async () => undefined);
    throw error;
  }

  finalize(): Promise<void> {
    if (!this.finalizePromise) {
      this.interactionRun?.sealPublications();
      this.finalizePromise = this.callbacks.finalizeExecution(() => this.finalizeOwnedRun());
    }
    return this.finalizePromise;
  }

  releaseMessage(): void {
    if (!this.messageOwner || this.messageReleased) return;
    this.messageReleased = true;
    try {
      this.messageOwner.release();
    } catch (error) {
      throw runtimeOwnerCleanupFailure(`Message owner release failed for ${this.run.runId}`, error);
    }
  }

  private settleReservedExecution(outcome: ExecutionClaimOutcome): void {
    if (this.reservedExecutionSettled) return;
    this.reservedExecutionSettled = true;
    this.callbacks.settleReservedExecution(outcome);
  }

  private async finalizeOwnedRun(): Promise<void> {
    const failures = new FailureCollector();
    const interactionRun = this.interactionRun;
    if (interactionRun) {
      await failures.capture(async () => {
        await interactionRun.close(interactionClosureReason(this.run));
        await interactionRun.settleLocalClosures();
      });
    }

    await failures.capture(() => this.run.finalize());
    if (!failures.hasFailures && interactionRun) {
      await failures.capture(() => this.callbacks.releaseInteraction(interactionRun));
    }
    const message = `Interaction and Run finalization failed for ${this.run.runId}`;
    try {
      failures.throwIfAny(message);
    } catch (error) {
      throw runtimeOwnerCleanupFailure(message, error);
    }
  }
}

function childActiveKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function effectiveOrchestrationForRun(
  run: AgentRunHeader,
  session: SessionHeader,
): EffectiveOrchestration {
  if (
    run.orchestrationMode !== undefined &&
    run.orchestrationSource !== undefined &&
    run.agentSwarmAuthorization !== undefined
  ) {
    return {
      mode: run.orchestrationMode,
      source: run.orchestrationSource,
      agentSwarmAuthorization: run.agentSwarmAuthorization,
    };
  }
  return resolveEffectiveOrchestration(session.orchestrationMode, undefined);
}

function effectiveToolModeForRun(run: AgentRunHeader): ToolMode {
  return run.toolMode ?? DEFAULT_TOOL_MODE;
}

async function interactionResumeAllowed(
  interactionRun: RuntimeInteractionRunBinding | undefined,
  event: SessionEvent,
): Promise<boolean> {
  if (
    !interactionRun ||
    (event.type !== 'user_question_answer_ack' && event.type !== 'sandbox_boundary_decision_ack')
  ) {
    return true;
  }
  return await interactionRun.canResumeAfterSettlementAck(event);
}

function interactionClosureReason(run: AgentRun): RuntimeInteractionRunClosureReason {
  return run.isStopped() ? 'turn_stopped' : 'turn_terminal';
}

function interactionFailStop(message: string, error: unknown): Error {
  return error instanceof RuntimeInteractionFailStopError
    ? error
    : new RuntimeInteractionFailStopError(message, error);
}

function runtimeOwnerCleanupFailure(message: string, error: unknown): Error {
  return error instanceof RuntimeOwnerCleanupError ||
    error instanceof RuntimeMessageAuthorityInvariantError ||
    error instanceof RuntimeInteractionInvariantError ||
    error instanceof RuntimeInteractionFailStopError
    ? error
    : new RuntimeOwnerCleanupError(message, error);
}

function containsRuntimeOwnerCleanupFailure(error: unknown): boolean {
  if (
    error instanceof RuntimeOwnerCleanupError ||
    error instanceof RuntimeMessageAuthorityInvariantError ||
    error instanceof RuntimeInteractionInvariantError ||
    error instanceof RuntimeInteractionFailStopError
  ) {
    return true;
  }
  return (
    error instanceof AggregateError &&
    error.errors.some((nested) => containsRuntimeOwnerCleanupFailure(nested))
  );
}

class RuntimeExecutionCancellation extends Error {
  constructor(sessionId: string) {
    super(`Execution for session ${sessionId} was cancelled before dispatch`);
    this.name = 'RuntimeExecutionCancellation';
  }
}

function isExecutionCancellation(
  error: unknown,
  cancellation: RuntimeExecutionCancellation,
): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current !== null && (typeof current === 'object' || typeof current === 'function')) {
    if (current === cancellation) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

class FailureCollector {
  private readonly failures: unknown[] = [];
  private readonly seen = new Set<unknown>();

  get hasFailures(): boolean {
    return this.failures.length > 0;
  }

  add(error: unknown): void {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) this.add(nested);
      return;
    }
    if (this.seen.has(error)) return;
    this.seen.add(error);
    this.failures.push(error);
  }

  async capture(operation: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.add(error);
    }
  }

  throwIfAny(message: string): void {
    if (this.failures.length === 1) throw this.failures[0];
    if (this.failures.length > 1) throw new AggregateError(this.failures, message);
  }
}

function interactionOwnerKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`;
}

export type { AgentRunLineage };
