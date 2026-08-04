import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BackendStopMode } from '@maka/core/backend-types';
import {
  agentRunMatchesHostedRootExecution,
  type AgentRunHeader,
  type RootExecutionDescriptor,
} from '@maka/core/agent-run';
import {
  INLINE_REFERENCE_MAX_COUNT,
  messageContentsEqual,
  normalizeMessageContent,
  type AttachmentRef,
  type MessageContent,
  type SessionEvent,
} from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import {
  agentGraphIdForRootSession,
  classifyTerminalRuntimeLedger,
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
  RuntimeContextCompactError,
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  RuntimeMessageAuthorityInvariantError,
  RuntimeRegenerateTurnError,
  RuntimeOwnerCleanupError,
  parseSkillInvocationTokens,
  skillInvocationInlineReferences,
  recoverAgentGraphSupervisorContextOverflow,
  type PreparedSkillInvocationMessage,
  type RuntimeContinuation,
  type SafeBoundaryContinuationPlan,
  type RuntimeHostedRootExecutionInput,
  type RuntimeMessageRunIdentity,
  type SessionManager,
  type AgentGraphSupervisorContextRecoveryDiagnostic,
  type AgentGraphSupervisorTurnOutcome,
  type GoalObservedTurnSettler,
  type GoalObservedTurnStart,
  type GoalCheckpoint,
  type GoalControlLease,
  type GoalTurnAdmission,
  type GoalTurnOutcome,
} from '@maka/runtime';
import {
  authenticateExecutionStoresWriter,
  isSessionNotFoundError,
  normalizeRootTurnAdmissionPayload,
  type ExecutionStoresWriter,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import type {
  OperationOutcome,
  ContextCompactInput,
  ContextDiagnosticsQueryInput,
  TurnQueryInput,
  TurnRegenerateInput,
  TurnResumePlan,
  TurnResumeQueryInput,
  TurnResumeStartInput,
  TurnSnapshot,
  TurnStartInput,
  TurnStopInput,
} from '../protocol/index.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import {
  type HostMessageRootState,
  type HostMessageSessionHeader,
  type HostMessageStartInput,
  type HostMessageStopClaim,
  type HostMessageStopFence,
  HostMessageCoordinator,
  type QueueFenceResult,
  type RootFollowupBatch,
} from './message-coordinator.js';
import type {
  ConnectionContext,
  ContextOperationHandlerMap,
  TurnOperationHandlerMap,
} from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { type SessionAdmissionLease, SessionAdmissionGate } from './session-admission-gate.js';
import {
  type RuntimeSessionTransientEvent,
  SessionContinuityCoordinator,
} from './session-continuity-coordinator.js';
import type {
  HostClientCapabilityCoordinator,
  SessionBindingPreview,
} from './client-capability-coordinator.js';
import {
  runtimeHostExecutionUnavailableReason,
  runtimeHostExternalTurnUnavailableReason,
  runtimeHostSafeBoundaryContinuationUnavailableReason,
} from './host-session-availability.js';

type RootTerminalInteractionFence = Pick<
  HostInteractionCoordinator,
  'assertTerminalFence' | 'claimRunClosure'
>;

interface ActiveRootTurn {
  turnId: string;
  runId: string;
  userMessageId: string | null;
  execution?: RuntimeHostedRootExecutionInput;
  continuation?: RuntimeContinuation;
  descriptor: RootExecutionDescriptor;
  observedGoalSettler?: GoalObservedTurnSettler;
  goalOutcome: ValueDeferred<GoalTurnOutcome>;
  observedGoalOutcome?: GoalTurnOutcome;
  startSettled: Deferred;
  done: Promise<void>;
  residency: RuntimeHostResidency;
  stopRequested: boolean;
  messageTransitionCommitted: boolean;
}

export type TurnStartOutcome = OperationOutcome<'turn.start'>;

type RootMessageExecution = Extract<
  RootExecutionDescriptor,
  { kind: 'external_message' | 'regenerate' }
>;

interface RootMessageStartRequestBase {
  readonly sessionId: string;
  readonly turnId: string;
  readonly archivedMessage: string;
  readonly prepareReplayContent?: (
    lease: SessionAdmissionLease,
  ) => Promise<RootMessageContentPreparation>;
}

type RootMessageStartRequest =
  | (RootMessageStartRequestBase & {
      readonly execution: Extract<RootMessageExecution, { kind: 'external_message' }>;
      readonly content: MessageContent;
      readonly turnOrchestration?: TurnStartInput['turnOrchestration'];
    })
  | (RootMessageStartRequestBase & {
      readonly execution: Extract<RootMessageExecution, { kind: 'external_message' }>;
      readonly turnOrchestration?: TurnStartInput['turnOrchestration'];
      prepareFreshContent(lease: SessionAdmissionLease): Promise<RootMessageContentPreparation>;
    })
  | (RootMessageStartRequestBase & {
      readonly execution: Extract<RootMessageExecution, { kind: 'regenerate' }>;
      readonly turnOrchestration?: undefined;
      prepareContent(): Promise<MessageContent>;
    });

export type RootMessageContentPreparation =
  | {
      readonly kind: 'ready';
      readonly content: MessageContent;
      readonly commitCapabilityBinding?: () => Promise<
        { readonly ok: true } | { readonly ok: false; readonly message: string }
      >;
    }
  | { readonly kind: 'rejected'; readonly outcome: TurnStartOutcome };

export interface HostedExternalTurnTransitionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly inputDigest: `sha256:${string}`;
  readonly archivedMessage: string;
  prepareContent(lease: SessionAdmissionLease): Promise<RootMessageContentPreparation>;
}

type RootTurnActivationInput =
  | TurnStartInput
  | {
      sessionId: string;
      turnId: string;
      content: null;
      turnOrchestration?: undefined;
    };

type TurnResumeStartOutcome = OperationOutcome<'turn.resume.start'>;

type TurnResumeStartDisposition =
  | TurnStartDisposition
  | {
      kind: 'parked';
      plan: Extract<TurnResumePlan, { disposition: 'parked' }>;
    };

type ReconstructedContinuation =
  | { disposition: 'ready'; continuation: RuntimeContinuation }
  | {
      disposition: 'parked';
      plan: Extract<TurnResumePlan, { disposition: 'parked' }>;
    };

type TurnStartDisposition =
  | { kind: 'complete'; outcome: TurnStartOutcome }
  | { kind: 'await_start'; active: ActiveRootTurn };

type TurnStopOutcome = OperationOutcome<'turn.stop'>;

type TurnStopDisposition =
  | { kind: 'complete'; outcome: TurnStopOutcome }
  | { kind: 'request_stop'; active: ActiveRootTurn }
  | { kind: 'await_terminal'; active: ActiveRootTurn };

interface DeclaredStopFence {
  readonly active: ActiveRootTurn;
  deliverStop(): Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly phase: 'pending' | 'resolved' | 'rejected';
  resolve(): void;
  reject(error: unknown): void;
}

interface ValueDeferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

interface RootTurnReservation {
  readonly kind: 'pending';
  readonly sessionId: string;
  readonly whenIdle: Deferred;
  readonly admissionSettled: Deferred;
  admissionPhase: 'prepared' | 'committing';
}

interface ParkedContinuationReservation {
  readonly kind: 'parked_continuation';
  readonly sessionId: string;
  readonly admission: RootTurnAdmission;
  readonly whenIdle: Deferred;
  readonly admissionSettled: Deferred;
}

type SessionRootReservation = RootTurnReservation | ParkedContinuationReservation;

interface GoalRootReservation extends RootTurnReservation {
  readonly turnId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly checkpoint: GoalCheckpoint;
  readonly controlLease: GoalControlLease;
  readonly text: string;
  completion?: Promise<GoalTurnOutcome>;
}

interface AgentGraphRootReservation extends RootTurnReservation {
  readonly turnId: string;
  readonly runId: string;
  readonly userMessageId: string;
  readonly input: UserMessageInput;
}

interface HostedRootReservationOptions {
  readonly label: string;
  readonly unavailableReason: string;
  readonly revokedReason: string;
  readonly execution: RootExecutionDescriptor;
  readonly normalizedInput: MessageContent;
  readonly turnOrchestration?: UserMessageInput['turnOrchestration'];
  readonly isAvailable: () => boolean;
  readonly isCurrent?: () => Promise<boolean>;
  readonly abortSignal?: AbortSignal;
}

type HostedRootDisposition = TurnStartDisposition | { kind: 'superseded' };

export interface HostGoalRootAuthority {
  beginObservedTurn(sessionId: string, turnId: string): GoalObservedTurnStart;
  matchesActive(
    sessionId: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
  ): boolean;
}

interface RecoverySessionPlan {
  sessionId: string;
  admissions: readonly RootTurnAdmission[];
  missingMessages: readonly RecoveryUserMessage[];
  pendingRecoveryClosures: readonly RootTurnAdmission[];
}

interface HostSkillInvocationPreparer {
  (input: {
    sessionId: string;
    turnId: string;
    text: string;
    skillIds: readonly string[];
  }): Promise<PreparedSkillInvocationMessage>;
}

interface HostTurnAttachmentValidator {
  validateTurnAttachments(
    sessionId: string,
    attachments: readonly AttachmentRef[],
  ): Promise<string | undefined>;
}

export class RootTurnCoordinator {
  readonly handlers: TurnOperationHandlerMap & ContextOperationHandlerMap = {
    'turn.start': (input, context) => this.startTurn(input, context),
    'turn.query': (input) => this.queryTurn(input),
    'turn.stop': (input) => this.stopTurn(input),
    'turn.regenerate': (input, context) => this.regenerateTurn(input, context),
    'turn.resume.query': (input, context) => this.queryTurnResume(input, context),
    'turn.resume.start': (input, context) => this.startTurnResume(input, context),
    'context.diagnostics.query': (input) => this.queryContextDiagnostics(input),
    'context.compact': (input, context) => this.compactContext(input, context),
  };

  readonly #activeBySession = new Map<string, ActiveRootTurn>();
  readonly #reservationsBySession = new Map<string, SessionRootReservation>();
  readonly #recoveryAdmissionsBySession = new Map<string, readonly RootTurnAdmission[]>();
  private readonly stores: ExecutionStoresWriter<'interactive'>;
  private readonly attachmentValidator: HostTurnAttachmentValidator | undefined;
  private readonly prepareSkillInvocation: HostSkillInvocationPreparer | undefined;
  #draining = false;

  constructor(
    private readonly manager: SessionManager,
    stores: ExecutionStoresWriter<'interactive'>,
    private readonly sessionAdmission: SessionAdmissionGate,
    private readonly rootAdmissionOwner: RootAdmissionOwner,
    private readonly interactions: RootTerminalInteractionFence,
    private readonly messages: HostMessageCoordinator,
    private readonly continuity: SessionContinuityCoordinator,
    private readonly acquireRecoveryResidency: () => RuntimeHostResidency,
    private readonly requestHostDrain: () => void,
    private readonly clientCapabilities: HostClientCapabilityCoordinator | undefined,
    private readonly resolveGoal: () => HostGoalRootAuthority,
    private readonly assertAutomationRecoveryAdmission?: (admission: RootTurnAdmission) => void,
    attachmentValidator?: HostTurnAttachmentValidator,
    prepareSkillInvocation?: HostSkillInvocationPreparer,
  ) {
    this.stores = authenticateExecutionStoresWriter(stores, 'interactive');
    this.attachmentValidator = attachmentValidator;
    this.prepareSkillInvocation = prepareSkillInvocation;
  }

  async prepareRecovery(): Promise<void> {
    const sessions = await this.stores.sessionStore.listForRecovery();
    const plans: RecoverySessionPlan[] = [];
    for (const session of sessions) {
      const admissions = await this.rootAdmissionOwner.recoverSession(session.id);
      const messages = await this.stores.sessionStore.readMessagesForRecovery(session.id);
      const runs = await this.stores.agentRunStore.listSessionRunsForRecovery(session.id);
      const runsById = new Map(runs.map((run) => [run.runId, run]));
      for (const run of runs) {
        await this.stores.agentRunStore.readEventsForRecovery(session.id, run.runId);
        await this.stores.runtimeEventStore.readRuntimeEvents(session.id, run.runId);
      }
      const messageIndex = indexRecoveryMessages(messages);
      const pending: RootTurnAdmission[] = [];
      const missingMessages: RecoveryUserMessage[] = [];
      const pendingRecoveryClosures: RootTurnAdmission[] = [];
      for (const admission of admissions) {
        const run = runsById.get(admission.runId);
        const userMessages = messageIndex.userMessagesByTurnId.get(admission.turnId) ?? [];
        const messageIdOwners = admission.userMessageId
          ? (messageIndex.messagesById.get(admission.userMessageId) ?? [])
          : [];
        const executionContract = recoveryExecutionContract(admission.execution);
        if (
          admission.execution.kind === 'automation' &&
          (!run ||
            (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled'))
        ) {
          if (!this.assertAutomationRecoveryAdmission) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Automation recovery admission has no canonical authority validator',
            );
          }
          this.assertAutomationRecoveryAdmission(admission);
        }
        if (!executionContract.allowsQueueSources && admission.sourceMessages.length !== 0) {
          throw new Error(
            `Admitted Turn ${admission.turnId} has queue-independent execution with Message queue sources`,
          );
        }
        if (executionContract.requiresUserMessage !== (admission.userMessageId !== null)) {
          throw new Error(
            `Admitted Turn ${admission.turnId} has an invalid UserMessage execution contract`,
          );
        }
        if (admission.userMessageId === null) {
          if (userMessages.length > 0) {
            throw new Error(`Admitted Turn ${admission.turnId} must not record a UserMessage`);
          }
          if (!run) {
            if (executionContract.pendingWithoutRun === 'root_replay') {
              pending.push(admission);
            } else {
              pendingRecoveryClosures.push(admission);
            }
            continue;
          }
          if (admission.execution.kind === 'safe_boundary_continuation') {
            assertRunMatchesExecution(run, admission.turnId, admission.execution);
          } else {
            await this.assertRunMatchesDurableExecution(run, admission.turnId, admission.execution);
          }
          continue;
        }
        if (messageIdOwners.length > 1) {
          throw new Error(
            `Admitted Turn ${admission.turnId} has a duplicated UserMessage identity`,
          );
        }
        const messageIdOwner = messageIdOwners[0];
        if (!run && executionContract.pendingWithoutRun === 'host_recovery_closure') {
          if (userMessages.length > 1) {
            throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
          }
          const userMessage = userMessages[0];
          if (userMessage) {
            if (
              messageIdOwner !== userMessage ||
              userMessage.id !== admission.userMessageId ||
              !recoveryUserMessageOriginMatches(userMessage, admission.execution) ||
              !messageContentsEqual(
                storedUserMessageContent(userMessage),
                requireAdmissionMessageContent(admission),
              )
            ) {
              throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
            }
          } else {
            if (messageIdOwner) {
              throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
            }
            const recoveredMessage = recoveryUserMessage(admission);
            missingMessages.push(recoveredMessage);
            indexRecoveryMessage(messageIndex, recoveredMessage);
          }
          pendingRecoveryClosures.push(admission);
          continue;
        }
        if (!run) {
          if (userMessages.length > 0 || messageIdOwner) {
            throw new Error(`Admitted Turn ${admission.turnId} has a UserMessage but no Run`);
          }
          pending.push(admission);
          continue;
        }
        await this.assertRunMatchesDurableExecution(run, admission.turnId, admission.execution);
        if (userMessages.length > 1) {
          throw new Error(`Admitted Turn ${admission.turnId} has multiple UserMessages`);
        }
        const userMessage = userMessages[0];
        if (userMessage) {
          if (
            messageIdOwner !== userMessage ||
            userMessage.id !== admission.userMessageId ||
            !recoveryUserMessageOriginMatches(userMessage, admission.execution) ||
            !messageContentsEqual(
              storedUserMessageContent(userMessage),
              requireAdmissionMessageContent(admission),
            )
          ) {
            throw new Error(`Admitted Turn ${admission.turnId} does not match its UserMessage`);
          }
          continue;
        }
        if (messageIdOwner) {
          throw new Error(`Admitted Turn ${admission.turnId} reuses another message identity`);
        }
        const recoveredMessage = recoveryUserMessage(admission);
        missingMessages.push(recoveredMessage);
        indexRecoveryMessage(messageIndex, recoveredMessage);
      }
      if (pending.length > 1) {
        throw new Error(`Session ${session.id} has multiple admitted Turns without Runs`);
      }
      const admission = pending[0];
      if (admission && (session.status === 'archived' || session.isArchived)) {
        throw new Error(`Archived Session ${session.id} has an admitted Turn without a Run`);
      }
      plans.push({
        sessionId: session.id,
        admissions,
        missingMessages,
        pendingRecoveryClosures,
      });
    }

    for (const plan of plans) {
      for (const message of plan.missingMessages) {
        await this.stores.sessionStore.appendMessage(plan.sessionId, message);
      }
      for (const admission of plan.pendingRecoveryClosures) {
        if (
          admission.execution.kind === 'external_message' ||
          admission.execution.kind === 'regenerate' ||
          admission.execution.kind === 'context_compact' ||
          admission.execution.kind === 'automation' ||
          admission.execution.kind === 'safe_boundary_continuation'
        ) {
          throw new Error('Root-replay admission cannot use Host recovery closure');
        }
        await this.manager.closePendingHostedAdmission({
          sessionId: admission.sessionId,
          turnId: admission.turnId,
          runId: admission.runId,
          admittedAt: admission.admittedAt,
          execution: admission.execution,
        });
      }
      this.#recoveryAdmissionsBySession.set(plan.sessionId, plan.admissions);
    }
  }

  async recover(): Promise<void> {
    for (const [sessionId, admissions] of this.#recoveryAdmissionsBySession) {
      let pending: RootTurnAdmission | undefined;
      for (const admission of admissions) {
        const run = await this.readRunIfPresent(sessionId, admission.runId);
        if (!run) {
          pending = admission;
          continue;
        }
        await this.assertRunMatchesDurableExecution(run, admission.turnId, admission.execution);
        const snapshot = await this.readCanonicalSnapshot(
          sessionId,
          admission.turnId,
          admission.runId,
          run,
        );
        if (!isTerminalSnapshot(snapshot)) {
          if (admission.execution.kind !== 'safe_boundary_continuation') {
            throw new Error(`Startup recovery left Turn ${admission.turnId} non-terminal`);
          }
          this.parkContinuationAdmission(admission);
        }
      }
      const admission = pending;
      if (!admission) continue;
      const input = activationInputForAdmission(admission);
      const disposition = await this.sessionAdmission.run(sessionId, async (lease) => {
        if (admission.execution.kind === 'safe_boundary_continuation') {
          const header = await this.stores.sessionStore.readHeaderSnapshot(sessionId);
          if (runtimeHostSafeBoundaryContinuationUnavailableReason(header)) {
            this.parkContinuationAdmission(admission);
            return undefined;
          }
        }
        const continuation =
          admission.execution.kind === 'safe_boundary_continuation'
            ? await this.reconstructAdmittedContinuation(admission)
            : undefined;
        if (continuation?.disposition === 'parked') {
          if (
            continuation.plan.reason === 'safety_check_failed' ||
            continuation.plan.reason === 'continuation_unavailable'
          ) {
            this.parkContinuationAdmission(admission);
            return undefined;
          }
          throw new Error(
            `Unable to recover admitted Turn ${admission.turnId}: ${continuation.plan.reason}`,
          );
        }
        return this.prepareAdmittedTurn(
          input,
          admission,
          this.acquireRecoveryResidency,
          lease,
          undefined,
          undefined,
          undefined,
          continuation?.continuation,
        );
      });
      if (!disposition) continue;
      const outcome = await this.resolveStartDisposition(input, disposition);
      if (!outcome.ok) {
        throw new Error(
          `Unable to recover admitted Turn ${admission.turnId}: ${outcome.error.code}`,
        );
      }
    }
    this.#recoveryAdmissionsBySession.clear();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await Promise.all(
      [...this.#reservationsBySession.values()].map(
        (reservation) => reservation.admissionSettled.promise,
      ),
    );
    const errors: unknown[] = [];
    while (errors.length === 0) {
      const active = [...this.#activeBySession.entries()];
      if (active.length === 0) break;
      const results = await Promise.allSettled(
        active.map(([sessionId, turn]) => this.stopActiveTurn(sessionId, turn)),
      );
      errors.push(
        ...results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected' && !isShutdownCancelledBackendStart(result.reason),
          )
          .map((result) => result.reason),
      );
    }
    if (this.#activeBySession.size !== 0) {
      errors.push(new Error('Runtime Host execution composition closed with active Turns'));
    }
    if (errors.length > 0)
      throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
  }

  async readSessionHeader(sessionId: string): Promise<HostMessageSessionHeader | null> {
    try {
      const header = await this.stores.sessionStore.readHeaderSnapshot(sessionId);
      if (header.conversationCopy?.state === 'preparing') return null;
      return {
        isArchived: header.isArchived || header.status === 'archived',
        unavailableReason: runtimeHostExternalTurnUnavailableReason(header),
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) return null;
      throw error;
    }
  }

  readRootState(sessionId: string): HostMessageRootState {
    const active = this.#activeBySession.get(sessionId);
    if (active) {
      return {
        kind: 'active',
        sessionId,
        turnId: active.turnId,
        runId: active.runId,
      };
    }
    return this.#reservationsBySession.has(sessionId) ? { kind: 'reserved' } : { kind: 'idle' };
  }

  startHostedExternalTransition(
    input: HostedExternalTurnTransitionInput,
    context: ConnectionContext,
  ): Promise<TurnStartOutcome> {
    return this.startRootMessage(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        execution: { kind: 'external_message', inputDigest: input.inputDigest },
        archivedMessage: input.archivedMessage,
        prepareFreshContent: input.prepareContent,
        prepareReplayContent: input.prepareContent,
      },
      context,
    );
  }

  private reserveRootTurn(sessionId: string): RootTurnReservation | undefined {
    if (
      this.#draining ||
      this.#activeBySession.has(sessionId) ||
      this.#reservationsBySession.has(sessionId)
    ) {
      return undefined;
    }
    const reservation: RootTurnReservation = {
      kind: 'pending',
      sessionId,
      whenIdle: deferred(),
      admissionSettled: deferred(),
      admissionPhase: 'prepared',
    };
    this.#reservationsBySession.set(sessionId, reservation);
    return reservation;
  }

  private parkContinuationAdmission(admission: RootTurnAdmission): void {
    const existing = this.#reservationsBySession.get(admission.sessionId);
    if (existing) {
      if (
        existing.kind !== 'parked_continuation' ||
        existing.admission.turnId !== admission.turnId ||
        existing.admission.runId !== admission.runId
      ) {
        throw new RuntimeMessageAuthorityInvariantError(
          `Session ${admission.sessionId} has conflicting parked continuations`,
        );
      }
      return;
    }
    this.#reservationsBySession.set(admission.sessionId, {
      kind: 'parked_continuation',
      sessionId: admission.sessionId,
      admission,
      whenIdle: deferred(),
      admissionSettled: deferred(),
    });
  }

  private takeParkedContinuationReservation(
    admission: RootTurnAdmission,
  ): RootTurnReservation | undefined {
    const parked = this.#reservationsBySession.get(admission.sessionId);
    if (parked?.kind !== 'parked_continuation') return;
    if (
      parked.admission.turnId !== admission.turnId ||
      parked.admission.runId !== admission.runId
    ) {
      return;
    }
    const reservation: RootTurnReservation = {
      kind: 'pending',
      sessionId: parked.sessionId,
      whenIdle: parked.whenIdle,
      admissionSettled: parked.admissionSettled,
      admissionPhase: 'prepared',
    };
    this.#reservationsBySession.set(admission.sessionId, reservation);
    return reservation;
  }

  private clearParkedContinuationAdmission(admission: RootTurnAdmission): void {
    const reservation = this.takeParkedContinuationReservation(admission);
    if (reservation) this.releaseRootReservation(reservation);
  }

  private parkedContinuationAdmission(sessionId: string): RootTurnAdmission | undefined {
    const reservation = this.#reservationsBySession.get(sessionId);
    return reservation?.kind === 'parked_continuation' ? reservation.admission : undefined;
  }

  private beginRootAdmission(reservation: RootTurnReservation): boolean {
    if (this.#reservationsBySession.get(reservation.sessionId) !== reservation) return false;
    if (reservation.admissionPhase === 'committing') return true;
    if (this.#draining) return false;
    reservation.admissionPhase = 'committing';
    return true;
  }

  private releaseRootReservation(reservation: SessionRootReservation): void {
    if (this.#reservationsBySession.get(reservation.sessionId) !== reservation) return;
    this.#reservationsBySession.delete(reservation.sessionId);
    reservation.admissionSettled.resolve();
    reservation.whenIdle.resolve();
  }

  beginDrain(): void {
    if (this.#draining) return;
    this.#draining = true;
    for (const reservation of this.#reservationsBySession.values()) {
      if (reservation.kind === 'pending' && reservation.admissionPhase === 'committing') continue;
      this.#reservationsBySession.delete(reservation.sessionId);
      reservation.admissionSettled.resolve();
      reservation.whenIdle.resolve();
    }
  }

  admitGoalTurn(
    sessionId: string,
    checkpoint: GoalCheckpoint,
    controlLease: GoalControlLease,
    text: string,
  ): GoalTurnAdmission {
    if (this.#draining) {
      return {
        kind: 'unavailable',
        reason: 'Runtime Host root authority is draining.',
      };
    }
    const active = this.#activeBySession.get(sessionId);
    if (active) return { kind: 'busy', whenIdle: active.done };
    const existing = this.#reservationsBySession.get(sessionId);
    if (existing) return { kind: 'busy', whenIdle: existing.whenIdle.promise };

    const reservation: GoalRootReservation = {
      kind: 'pending',
      sessionId,
      turnId: randomUUID(),
      runId: randomUUID(),
      userMessageId: randomUUID(),
      checkpoint,
      controlLease,
      text,
      whenIdle: deferred(),
      admissionSettled: deferred(),
      admissionPhase: 'prepared',
    };
    this.#reservationsBySession.set(sessionId, reservation);
    return {
      kind: 'prepared',
      turnId: reservation.turnId,
      start: () => {
        reservation.completion ??= this.#startGoalReservation(reservation);
        return reservation.completion;
      },
    };
  }

  async #startGoalReservation(reservation: GoalRootReservation): Promise<GoalTurnOutcome> {
    return this.#runHostedRootReservation(reservation, {
      label: 'Goal continuation',
      unavailableReason: 'Goal continuation is unavailable for this Session.',
      revokedReason: 'Goal continuation reservation was revoked.',
      execution: { kind: 'goal', goalId: reservation.checkpoint.goalId },
      normalizedInput: { text: reservation.text },
      isAvailable: () =>
        this.resolveGoal().matchesActive(
          reservation.sessionId,
          reservation.checkpoint,
          reservation.controlLease,
        ),
    });
  }

  async runAgentGraphSupervisorTurn(
    sessionId: string,
    input: UserMessageInput,
    abortSignal: AbortSignal,
    isCurrent: () => Promise<boolean>,
  ): Promise<AgentGraphSupervisorTurnOutcome> {
    if (
      input.origin?.kind !== 'agent_graph' ||
      input.origin.graphId !== agentGraphIdForRootSession(sessionId) ||
      input.turnOrchestration?.mode !== 'graph' ||
      input.turnOrchestration.source !== 'host_api'
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Agent graph supervisor Turn requires the Session graph origin and Host Graph orchestration',
      );
    }

    let reservation: AgentGraphRootReservation;
    for (;;) {
      throwIfAborted(abortSignal);
      if (this.#draining) {
        return goalErrorOutcome(input.turnId, 'Runtime Host root authority is draining.');
      }
      const active = this.#activeBySession.get(sessionId);
      const pending = this.#reservationsBySession.get(sessionId);
      const whenIdle = active?.done ?? pending?.whenIdle.promise;
      if (whenIdle) {
        await waitForRootIdleOrAbort(whenIdle, abortSignal);
        continue;
      }
      reservation = {
        kind: 'pending',
        sessionId,
        turnId: input.turnId,
        runId: randomUUID(),
        userMessageId: randomUUID(),
        input,
        whenIdle: deferred(),
        admissionSettled: deferred(),
        admissionPhase: 'prepared',
      };
      this.#reservationsBySession.set(sessionId, reservation);
      break;
    }
    return this.#runHostedRootReservation(reservation, {
      label: 'Agent graph supervisor continuation',
      unavailableReason: 'Agent graph supervisor continuation is unavailable for this Session.',
      revokedReason: 'Agent graph supervisor continuation reservation was revoked.',
      execution: {
        kind: 'agent_graph_supervisor_wake',
        graphId: input.origin.graphId,
        wakeId: input.origin.wakeId,
        attemptId: input.origin.attemptId,
      },
      normalizedInput: normalizeMessageContent(input),
      turnOrchestration: input.turnOrchestration,
      isAvailable: () => true,
      isCurrent,
      abortSignal,
    });
  }

  async recoverAgentGraphSupervisorContextOverflow(
    sessionId: string,
    compactTurnId: string,
    abortSignal: AbortSignal,
  ): Promise<AgentGraphSupervisorContextRecoveryDiagnostic | undefined> {
    let reservation: RootTurnReservation;
    for (;;) {
      throwIfAborted(abortSignal);
      if (this.#draining) {
        throw new Error('Runtime Host root authority is draining.');
      }
      const available = this.reserveRootTurn(sessionId);
      if (available) {
        reservation = available;
        break;
      }
      const active = this.#activeBySession.get(sessionId);
      const pending = this.#reservationsBySession.get(sessionId);
      const whenIdle = active?.done ?? pending?.whenIdle.promise;
      if (whenIdle) {
        await waitForRootIdleOrAbort(whenIdle, abortSignal);
      }
    }

    try {
      return await this.sessionAdmission.run(sessionId, async () => {
        throwIfAborted(abortSignal);
        if (
          this.#draining ||
          this.#reservationsBySession.get(sessionId) !== reservation ||
          !this.beginRootAdmission(reservation)
        ) {
          throw new Error('Agent graph context recovery lost its root reservation.');
        }
        return this.#runWithAbortStop(
          abortSignal,
          () =>
            this.deliverRuntimeStopIntent(sessionId, {
              source: 'graph_supervisor',
            }),
          () =>
            recoverAgentGraphSupervisorContextOverflow({
              rootSessionId: sessionId,
              compactTurnId,
              abortSignal,
              compactSession: (targetSessionId, input) =>
                this.manager.compactSession(targetSessionId, input),
            }),
        );
      });
    } finally {
      this.releaseRootReservation(reservation);
    }
  }

  private async queryContextDiagnostics(
    input: ContextDiagnosticsQueryInput,
  ): Promise<OperationOutcome<'context.diagnostics.query'>> {
    try {
      await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      return { ok: true, result: await this.manager.getContextDiagnostics(input.sessionId) };
    } catch (error) {
      if (isSessionNotFoundError(error)) return notFound('Session does not exist');
      throw error;
    }
  }

  private compactContext(
    input: ContextCompactInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'context.compact'>> {
    return this.runCommand(async () => {
      await this.awaitTerminalRootCleanup(input.sessionId);
      const activeAtEntry = this.#activeBySession.has(input.sessionId);
      let reservation = activeAtEntry ? undefined : this.reserveRootTurn(input.sessionId);
      if (!activeAtEntry && !reservation) {
        return sessionBusy('Session already has a pending root Turn');
      }
      const admissionTask = this.sessionAdmission.run(input.sessionId, async (lease) => {
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (existing) {
          this.rootAdmissionOwner.assertKnownAdmission(existing);
          if (existing.execution.kind !== 'context_compact') {
            return completedStart(
              operationConflict('Turn identity belongs to a different execution kind'),
            );
          }
          return this.prepareAdmittedTurn(
            activationInputForAdmission(existing),
            existing,
            context.acquireResidency,
            lease,
            undefined,
            undefined,
            reservation,
          );
        }

        reservation ??= this.reserveRootTurn(input.sessionId);
        if (!reservation) {
          return completedStart(sessionBusy('Session already has an active or pending root Turn'));
        }
        try {
          let header: SessionHeader;
          try {
            header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
          } catch (error) {
            if (isSessionNotFoundError(error)) {
              return completedStart(notFound('Session does not exist'));
            }
            throw error;
          }
          if (header.status === 'archived' || header.isArchived) {
            return completedStart(sessionArchived('Cannot compact an archived Session'));
          }
          const unavailableReason = runtimeHostExternalTurnUnavailableReason(header);
          if (unavailableReason) {
            return completedStart(operationUnavailable(unavailableReason));
          }
          if (
            (await this.manager.listTurns(input.sessionId)).some(
              (turn) => turn.turnId === input.turnId,
            )
          ) {
            return completedStart(operationConflict('Turn identity already exists'));
          }
          await this.manager.preflightContextCompaction(input.sessionId);
        } catch (error) {
          if (error instanceof RuntimeContextCompactError) {
            return completedStart(
              error.code === 'session_busy'
                ? sessionBusy(error.message)
                : operationUnavailable(error.message),
            );
          }
          throw error;
        }
        if (!this.beginRootAdmission(reservation)) {
          return completedStart(sessionBusy('Context compact reservation is no longer current'));
        }
        const admitted = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: null,
          execution: { kind: 'context_compact' },
          normalizedInput: null,
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        if (admitted.admission.execution.kind !== 'context_compact') {
          return completedStart(
            operationConflict('Turn identity belongs to a different execution kind'),
          );
        }
        return this.prepareAdmittedTurn(
          activationInputForAdmission(admitted.admission),
          admitted.admission,
          context.acquireResidency,
          lease,
          undefined,
          undefined,
          reservation,
        );
      });
      const disposition = await admissionTask.finally(() => {
        if (reservation) this.releaseRootReservation(reservation);
      });
      return this.resolveStartDisposition(input, disposition);
    });
  }

  async #runHostedRootReservation(
    reservation: GoalRootReservation,
    options: HostedRootReservationOptions & { isCurrent?: undefined },
  ): Promise<GoalTurnOutcome>;
  async #runHostedRootReservation(
    reservation: AgentGraphRootReservation,
    options: HostedRootReservationOptions & {
      isCurrent: () => Promise<boolean>;
    },
  ): Promise<AgentGraphSupervisorTurnOutcome>;
  async #runHostedRootReservation(
    reservation: GoalRootReservation | AgentGraphRootReservation,
    options: HostedRootReservationOptions,
  ): Promise<AgentGraphSupervisorTurnOutcome> {
    try {
      if (this.#reservationsBySession.get(reservation.sessionId) !== reservation) {
        return goalErrorOutcome(reservation.turnId, options.revokedReason);
      }
      const disposition = await this.sessionAdmission.run<HostedRootDisposition | undefined>(
        reservation.sessionId,
        async (lease) => {
          if (
            this.#draining ||
            options.abortSignal?.aborted ||
            this.#reservationsBySession.get(reservation.sessionId) !== reservation
          ) {
            return undefined;
          }
          if (this.#activeBySession.has(reservation.sessionId)) {
            throw new RuntimeMessageAuthorityInvariantError(
              `${options.label} reservation overlapped an active root Turn`,
            );
          }
          let header: SessionHeader;
          try {
            header = await this.stores.sessionStore.readHeaderSnapshot(reservation.sessionId);
          } catch (error) {
            if (isSessionNotFoundError(error)) return undefined;
            throw error;
          }
          if (header.status === 'archived' || header.isArchived) return undefined;
          if (runtimeHostExternalTurnUnavailableReason(header)) return undefined;
          if (!options.isAvailable()) return undefined;
          if (options.isCurrent && !(await options.isCurrent())) return { kind: 'superseded' };
          if (!this.beginRootAdmission(reservation)) return undefined;

          const admitted = await this.rootAdmissionOwner.admitRootTurn({
            sessionId: reservation.sessionId,
            turnId: reservation.turnId,
            proposedRunId: reservation.runId,
            proposedUserMessageId: reservation.userMessageId,
            execution: options.execution,
            normalizedInput: options.normalizedInput,
            ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
            sourceMessages: [],
            admittedAt: Date.now(),
          });
          if (admitted.kind !== 'admitted') {
            throw new RuntimeMessageAuthorityInvariantError(
              `Fresh ${options.label} root Turn identity already existed`,
            );
          }
          return this.prepareAdmittedTurn(
            {
              sessionId: reservation.sessionId,
              turnId: reservation.turnId,
              content: requireAdmissionMessageContent(admitted.admission),
              ...(options.turnOrchestration
                ? { turnOrchestration: options.turnOrchestration }
                : {}),
            },
            admitted.admission,
            this.acquireRecoveryResidency,
            lease,
            undefined,
            undefined,
            reservation,
          );
        },
      );
      if (!disposition) return goalErrorOutcome(reservation.turnId, options.unavailableReason);
      if (disposition.kind === 'superseded') {
        return {
          kind: 'superseded',
          turnId: reservation.turnId,
          reason: 'Agent graph supervisor checkpoint was superseded before root admission.',
        };
      }
      if (disposition.kind !== 'await_start') {
        return goalErrorOutcome(
          reservation.turnId,
          disposition.outcome.ok
            ? `${options.label} did not reserve execution.`
            : disposition.outcome.error.message,
        );
      }
      const outcome = await this.#awaitHostedRootOutcome(
        reservation,
        disposition.active,
        options.abortSignal,
      );
      if (!('input' in reservation)) return outcome;
      return await this.#classifyAgentGraphSupervisorOutcome(reservation, outcome);
    } catch (error) {
      if (options.abortSignal && isAbortError(error)) throw error;
      this.requestHostDrain();
      return goalErrorOutcome(reservation.turnId, errorMessage(error));
    } finally {
      this.releaseRootReservation(reservation);
    }
  }

  async #awaitHostedRootOutcome(
    reservation: GoalRootReservation | AgentGraphRootReservation,
    active: ActiveRootTurn,
    abortSignal?: AbortSignal,
  ): Promise<GoalTurnOutcome> {
    if (!abortSignal) return active.goalOutcome.promise;
    return this.#runWithAbortStop(
      abortSignal,
      () =>
        this.stopRoot(
          {
            sessionId: reservation.sessionId,
            turnId: reservation.turnId,
            runId: reservation.runId,
          },
          { source: 'graph_supervisor' },
        ),
      () => active.goalOutcome.promise,
    );
  }

  async #runWithAbortStop<T>(
    abortSignal: AbortSignal,
    requestStop: () => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    let stopTask: Promise<void> | undefined;
    const stop = (): void => {
      stopTask ??= requestStop();
      void stopTask.catch(() => undefined);
    };
    abortSignal.addEventListener('abort', stop, { once: true });
    if (abortSignal.aborted) stop();
    try {
      return await operation();
    } finally {
      abortSignal.removeEventListener('abort', stop);
      await stopTask;
    }
  }

  async #classifyAgentGraphSupervisorOutcome(
    reservation: AgentGraphRootReservation,
    outcome: GoalTurnOutcome,
  ): Promise<AgentGraphSupervisorTurnOutcome> {
    if (outcome.kind !== 'errored') return outcome;
    const snapshot = await this.readCanonicalSnapshot(
      reservation.sessionId,
      reservation.turnId,
      reservation.runId,
    );
    if (
      snapshot.status === 'failed' &&
      (snapshot.failureClass === 'context_overflow' ||
        snapshot.failureClass === 'context_budget_exhausted')
    ) {
      return {
        kind: 'context_overflow',
        turnId: reservation.turnId,
        reason: snapshot.failureClass,
      };
    }
    return outcome;
  }

  executeRoot(input: RuntimeHostedRootExecutionInput): Promise<void> {
    return this.runCommand(async () => {
      const activeAtEntry = this.#activeBySession.has(input.sessionId);
      let reservation = activeAtEntry ? undefined : this.reserveRootTurn(input.sessionId);
      if (!activeAtEntry && !reservation) {
        throw new RuntimeHostedRootConflictError(
          input.sessionId,
          'Session already has a pending root Turn',
        );
      }
      const canonicalInput = {
        ...input,
        content: normalizeMessageContent(input.content),
      };
      const admissionTask = this.sessionAdmission.run(input.sessionId, async (lease) => {
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          input.sessionId,
          input.turnId,
        );
        if (existing) {
          this.rootAdmissionOwner.assertKnownAdmission(existing);
          if (
            existing.runId !== input.runId ||
            existing.userMessageId !== input.userMessageId ||
            !isDeepStrictEqual(existing.execution, input.execution) ||
            !messageContentsEqual(
              requireAdmissionMessageContent(existing),
              canonicalInput.content,
            ) ||
            existing.sourceMessages.length !== 0
          ) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Hosted root execution identity conflicts with its durable admission',
            );
          }
          return this.prepareAdmittedTurn(
            canonicalInput,
            existing,
            this.acquireRecoveryResidency,
            lease,
            undefined,
            canonicalInput,
            reservation,
          );
        }

        reservation ??= this.reserveRootTurn(input.sessionId);
        if (!reservation) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Session already has an active or pending root Turn',
          );
        }

        let header: SessionHeader;
        try {
          header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) {
            throw new RuntimeHostedRootUnavailableError(
              input.sessionId,
              'Hosted root execution target Session is unavailable',
              { cause: error },
            );
          }
          throw error;
        }
        if (header.status === 'archived' || header.isArchived) {
          throw new RuntimeHostedRootUnavailableError(
            input.sessionId,
            'Cannot start a hosted root execution in an archived Session',
          );
        }
        const unavailableReason = runtimeHostExecutionUnavailableReason(header, input.execution);
        if (unavailableReason) {
          throw new RuntimeHostedRootUnavailableError(input.sessionId, unavailableReason);
        }
        if (this.#activeBySession.has(input.sessionId)) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Session already has an active root Turn',
          );
        }
        if (reservation && this.#reservationsBySession.get(input.sessionId) !== reservation) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Hosted root execution lost its pending reservation',
          );
        }
        if (canonicalInput.admitExecution) {
          let admission: 'executing' | 'cancelled';
          try {
            admission = await canonicalInput.admitExecution();
          } catch (error) {
            throw new HostedRootAdmissionGateError(error);
          }
          if (admission === 'cancelled') {
            throw new HostedRootAdmissionGateError(
              new Error('Turn start was cancelled before runtime admission'),
            );
          }
        }
        if (!reservation || !this.beginRootAdmission(reservation)) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Hosted root execution lost its pending reservation',
          );
        }
        const admitted = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: input.sessionId,
          turnId: input.turnId,
          proposedRunId: input.runId,
          proposedUserMessageId: input.userMessageId,
          execution: input.execution,
          normalizedInput: canonicalInput.content,
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        if (
          admitted.admission.runId !== input.runId ||
          admitted.admission.userMessageId !== input.userMessageId ||
          !isDeepStrictEqual(admitted.admission.execution, input.execution) ||
          !messageContentsEqual(
            requireAdmissionMessageContent(admitted.admission),
            canonicalInput.content,
          ) ||
          admitted.admission.sourceMessages.length !== 0
        ) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Hosted root execution admission changed identity',
          );
        }
        return this.prepareAdmittedTurn(
          canonicalInput,
          admitted.admission,
          this.acquireRecoveryResidency,
          lease,
          undefined,
          canonicalInput,
          reservation,
        );
      });
      const disposition = await admissionTask.finally(() => {
        if (reservation) this.releaseRootReservation(reservation);
      });
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) {
          if (disposition.outcome.error.code === 'session_busy') {
            throw new RuntimeHostedRootConflictError(
              input.sessionId,
              disposition.outcome.error.message,
            );
          }
          if (disposition.outcome.error.code === 'operation_unavailable') {
            throw new RuntimeHostedRootUnavailableError(
              input.sessionId,
              disposition.outcome.error.message,
            );
          }
          throw new RuntimeMessageAuthorityInvariantError(disposition.outcome.error.message);
        }
        return;
      }
      await disposition.active.startSettled.promise;
      await disposition.active.done;
    }).catch((error) => {
      if (error instanceof HostedRootAdmissionGateError) throw error.cause;
      throw error;
    });
  }

  stopRoot(
    identity: RuntimeMessageRunIdentity,
    input: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<void> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(identity.sessionId, (lease) =>
        this.declareStopFence(
          identity,
          () => this.messages.commitStopFence(identity),
          lease,
          input,
        ),
      );
      await declared?.deliverStop();
      await declared?.active.startSettled.promise;
      const disposition = await this.sessionAdmission.run(identity.sessionId, (lease) =>
        this.prepareStopDisposition(identity, () => this.messages.commitStopFence(identity), lease),
      );
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) throw new Error(disposition.outcome.error.message);
        return;
      }
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(identity.sessionId, input);
      }
      await disposition.active.done;
    });
  }

  stopSession(
    sessionId: string,
    input: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<void> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(sessionId, (lease) => {
        const active = this.#activeBySession.get(sessionId);
        if (!active) return undefined;
        const identity = {
          sessionId,
          turnId: active.turnId,
          runId: active.runId,
        };
        return this.declareStopFence(
          identity,
          () => this.messages.commitStopFence(identity),
          lease,
          input,
        );
      });
      await declared?.deliverStop();
      await declared?.active.startSettled.promise;
      const disposition = await this.sessionAdmission.run(sessionId, async (lease) => {
        if (!declared) return undefined;
        const identity = {
          sessionId,
          turnId: declared.active.turnId,
          runId: declared.active.runId,
        };
        return this.prepareStopDisposition(
          identity,
          () => this.messages.commitStopFence(identity),
          lease,
        );
      });
      if (!disposition || disposition.kind === 'complete') {
        if (disposition && !disposition.outcome.ok) {
          throw new Error(disposition.outcome.error.message);
        }
        return;
      }
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(sessionId, input);
      }
      await disposition.active.done;
    });
  }

  startFromMessage(
    input: HostMessageStartInput,
    admissionLease: SessionAdmissionLease,
  ): Promise<{ readonly turnId: string } | { readonly error: string }> {
    return this.runCommand(async () => {
      const content = normalizeMessageContent(input.content);
      if (
        input.sourceMessage.disposition !== 'turn_started' ||
        !messageContentsEqual(input.sourceMessage.content, content)
      ) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Idle Message start lost its canonical turn_started source',
        );
      }
      if (this.#activeBySession.has(input.sessionId)) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Message authority attempted an idle start while a root Turn was active',
        );
      }
      const reservation = this.reserveRootTurn(input.sessionId);
      if (!reservation) return { error: 'Another root Turn is being admitted' };
      try {
        const header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
        const unavailableReason = runtimeHostExternalTurnUnavailableReason(header);
        if (unavailableReason) return { error: unavailableReason };
        const binding = await this.clientCapabilities?.bindSession(
          input.sessionId,
          input.initiatingConnectionId,
        );
        if (binding && !binding.ok) return { error: binding.message };
        if (!this.beginRootAdmission(reservation)) {
          return { error: 'Root Turn reservation is no longer current' };
        }

        const turnId = randomUUID();
        const admitted = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: input.sessionId,
          turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: input.sourceMessage.messageId,
          execution: { kind: 'external_message' },
          normalizedInput: content,
          sourceMessages: [input.sourceMessage],
          admittedAt: Date.now(),
        });
        if (admitted.kind !== 'admitted') {
          throw new RuntimeMessageAuthorityInvariantError(
            'Fresh Message root Turn identity already existed',
          );
        }
        const disposition = await this.prepareAdmittedTurn(
          { sessionId: input.sessionId, turnId, content },
          admitted.admission,
          this.acquireRecoveryResidency,
          admissionLease,
          undefined,
          undefined,
          reservation,
        );
        if (disposition.kind !== 'await_start') {
          throw new RuntimeMessageAuthorityInvariantError(
            'Fresh Message root Turn did not reserve execution',
          );
        }
        return { turnId };
      } finally {
        this.releaseRootReservation(reservation);
      }
    });
  }

  claimStop(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
  ): Promise<HostMessageStopClaim> {
    return this.runCommand(async () => {
      const disposition = await this.prepareStopDisposition(input, commitQueueFence, admission);
      if (disposition.kind === 'complete') {
        if (!disposition.outcome.ok) {
          throw new RuntimeMessageAuthorityInvariantError(
            'Message interrupt no longer matched its admitted root Turn',
          );
        }
        return {
          deliverStop: () => Promise.resolve(),
          terminal: Promise.resolve(disposition.outcome.result),
        };
      }
      return {
        deliverStop: () =>
          disposition.kind === 'request_stop'
            ? this.deliverRuntimeStopIntent(input.sessionId)
            : Promise.resolve(),
        terminal: disposition.active.done.then(() =>
          this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
        ),
      };
    });
  }

  claimStopFence(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
  ): Promise<HostMessageStopFence> {
    return this.declareStopFence(input, commitQueueFence, admission).then((declared) => ({
      ready: declared?.active.startSettled.promise ?? Promise.resolve(),
      deliverStop: declared?.deliverStop ?? (() => Promise.resolve()),
    }));
  }

  private startTurn(input: TurnStartInput, context: ConnectionContext): Promise<TurnStartOutcome> {
    const content = normalizeMessageContent(input.content);
    const skillIds = input.skillIds ?? [];
    const hasSkillInvocation =
      skillIds.length > 0 || parseSkillInvocationTokens(content.text).length > 0;
    if (hasSkillInvocation) {
      const execution = {
        kind: 'external_message' as const,
        inputDigest: skillInvocationInputDigest(content, skillIds),
      };
      return this.startRootMessage(
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          execution,
          ...(input.turnOrchestration ? { turnOrchestration: { ...input.turnOrchestration } } : {}),
          archivedMessage: 'Cannot start a new Turn in an archived Session',
          prepareFreshContent: () =>
            this.prepareHostedSkillInvocationContent(
              input.sessionId,
              input.turnId,
              content,
              skillIds,
              context.connectionId,
            ),
        },
        context,
      );
    }
    return this.startRootMessage(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        execution: { kind: 'external_message' },
        ...(input.turnOrchestration ? { turnOrchestration: { ...input.turnOrchestration } } : {}),
        archivedMessage: 'Cannot start a new Turn in an archived Session',
        content,
      },
      context,
    );
  }

  private async prepareHostedSkillInvocationContent(
    sessionId: string,
    turnId: string,
    content: MessageContent,
    skillIds: readonly string[],
    connectionId: string,
  ): Promise<RootMessageContentPreparation> {
    if (!this.prepareSkillInvocation) {
      return {
        kind: 'rejected',
        outcome: operationUnavailable('Hosted Skill invocation authority is unavailable'),
      };
    }
    const preview = await this.previewCapabilityBinding(sessionId, connectionId, () =>
      this.prepareSkillInvocation!({ sessionId, turnId, text: content.text, skillIds }),
    );
    if (!preview.ok) {
      return { kind: 'rejected', outcome: operationConflict(preview.message) };
    }
    if (preview.value.disposition === 'blocked') {
      return {
        kind: 'rejected',
        outcome: operationConflict('Explicit Skill invocation could not be resolved'),
      };
    }
    return {
      kind: 'ready',
      content: composeHostedSkillInvocationContent(content, preview.value),
      commitCapabilityBinding: preview.commit,
    };
  }

  private regenerateTurn(
    input: TurnRegenerateInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'turn.regenerate'>> {
    if (input.sourceTurnId === input.turnId) {
      return Promise.resolve(
        operationConflict('Regenerate source and target Turn identities must differ'),
      );
    }
    return this.startRootMessage(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        execution: { kind: 'regenerate', sourceTurnId: input.sourceTurnId },
        archivedMessage: 'Cannot regenerate a Turn in an archived Session',
        prepareContent: async () =>
          (await this.manager.prepareRegenerateTurn(input.sessionId, input.sourceTurnId)).content,
      },
      context,
    );
  }

  private startRootMessage(
    request: RootMessageStartRequest,
    context: ConnectionContext,
  ): Promise<TurnStartOutcome> {
    return this.runCommand(async () => {
      await this.awaitTerminalRootCleanup(request.sessionId);
      const activeAtEntry = this.#activeBySession.has(request.sessionId);
      let reservation = activeAtEntry ? undefined : this.reserveRootTurn(request.sessionId);
      if (!activeAtEntry && !reservation) {
        return sessionBusy('Session already has a pending root Turn');
      }
      const admissionTask = this.sessionAdmission.run(request.sessionId, async (lease) => {
        const existing = await this.stores.agentRunStore.readRootTurnAdmission(
          request.sessionId,
          request.turnId,
        );
        if (existing) {
          this.rootAdmissionOwner.assertKnownAdmission(existing);
          if (existing.execution.kind !== request.execution.kind) {
            return completedStart(
              operationConflict('Turn identity belongs to a different execution kind'),
            );
          }
          if (!isDeepStrictEqual(existing.execution, request.execution)) {
            return completedStart(
              operationConflict('Turn identity belongs to a different execution payload'),
            );
          }
          let content: MessageContent;
          if (request.prepareReplayContent) {
            const prepared = await request.prepareReplayContent(lease);
            if (prepared.kind === 'rejected') return completedStart(prepared.outcome);
            content = normalizeMessageContent(prepared.content);
          } else {
            content =
              'content' in request ? request.content : requireAdmissionMessageContent(existing);
          }
          if (!rootMessageAdmissionMatches(existing, request, content)) {
            return completedStart(
              operationConflict('Turn identity was already admitted with a different payload'),
            );
          }
          const existingRun = await this.readRunIfPresent(request.sessionId, existing.runId);
          if (existingRun) {
            const snapshot = await this.readCanonicalSnapshot(
              request.sessionId,
              request.turnId,
              existing.runId,
              existingRun,
            );
            if (isTerminalSnapshot(snapshot)) {
              return completedStart({ ok: true, result: snapshot });
            }
          }
          return this.prepareAdmittedTurn(
            activationInputForAdmission(existing),
            existing,
            context.acquireResidency,
            lease,
            undefined,
            undefined,
            reservation,
          );
        }

        reservation ??= this.reserveRootTurn(request.sessionId);
        if (!reservation) {
          return completedStart(sessionBusy('Session already has an active or pending root Turn'));
        }
        let header: SessionHeader;
        try {
          header = await this.stores.sessionStore.readHeaderSnapshot(request.sessionId);
        } catch (error) {
          if (isSessionNotFoundError(error)) {
            return completedStart(notFound('Session does not exist'));
          }
          throw error;
        }
        if (header.status === 'archived' || header.isArchived) {
          return completedStart(sessionArchived(request.archivedMessage));
        }
        const unavailableReason = runtimeHostExternalTurnUnavailableReason(header);
        if (unavailableReason) return completedStart(operationUnavailable(unavailableReason));
        if (this.#activeBySession.has(request.sessionId)) {
          return completedStart(sessionBusy('Session already has an active root Turn'));
        }
        if (this.#reservationsBySession.get(request.sessionId) !== reservation) {
          return completedStart(sessionBusy('Root Turn reservation is no longer current'));
        }

        if (
          request.execution.kind === 'regenerate' &&
          (await this.manager.listTurns(request.sessionId)).some(
            (turn) => turn.turnId === request.turnId,
          )
        ) {
          return completedStart(operationConflict('Turn identity already exists'));
        }

        const prepared = await this.prepareRootMessageContent(request, lease);
        if (prepared.kind === 'rejected') return completedStart(prepared.outcome);
        const canonicalContent = preflightRootMessageContent(prepared.content);
        if (!canonicalContent.ok) return completedStart(canonicalContent.outcome);
        const attachments = canonicalContent.content.attachments ?? [];
        if (attachments.length > 0 && !this.attachmentValidator) {
          return completedStart(operationConflict('Hosted attachment authority is unavailable'));
        }
        const attachmentError = await this.attachmentValidator?.validateTurnAttachments(
          request.sessionId,
          attachments,
        );
        if (attachmentError) return completedStart(operationConflict(attachmentError));
        const binding = prepared.commitCapabilityBinding
          ? await prepared.commitCapabilityBinding()
          : await this.clientCapabilities?.bindSession(request.sessionId, context.connectionId);
        if (binding && !binding.ok) {
          return completedStart(operationConflict(binding.message));
        }
        if (!this.beginRootAdmission(reservation)) {
          return completedStart(sessionBusy('Root Turn reservation is no longer current'));
        }
        const admitted = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: request.sessionId,
          turnId: request.turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: randomUUID(),
          execution: request.execution,
          normalizedInput: canonicalContent.content,
          ...(request.turnOrchestration ? { turnOrchestration: request.turnOrchestration } : {}),
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        if (admitted.admission.execution.kind !== request.execution.kind) {
          return completedStart(
            operationConflict('Turn identity belongs to a different execution kind'),
          );
        }
        if (!rootMessageAdmissionMatches(admitted.admission, request, canonicalContent.content)) {
          return completedStart(
            operationConflict('Turn identity was already admitted with a different payload'),
          );
        }
        return this.prepareAdmittedTurn(
          activationInputForAdmission(admitted.admission),
          admitted.admission,
          context.acquireResidency,
          lease,
          undefined,
          undefined,
          reservation,
        );
      });
      const disposition = await admissionTask.finally(() => {
        if (reservation) this.releaseRootReservation(reservation);
      });
      return this.resolveStartDisposition(request, disposition);
    });
  }

  private async awaitTerminalRootCleanup(sessionId: string): Promise<void> {
    const active = this.#activeBySession.get(sessionId);
    if (!active) return;
    let snapshot: TurnSnapshot;
    try {
      snapshot = await this.readCanonicalSnapshot(sessionId, active.turnId, active.runId);
    } catch {
      return;
    }
    if (isTerminalSnapshot(snapshot)) await active.done;
  }

  private async prepareRootMessageContent(
    request: RootMessageStartRequest,
    lease: SessionAdmissionLease,
  ): Promise<RootMessageContentPreparation> {
    if ('content' in request) return { kind: 'ready', content: request.content };
    if ('prepareFreshContent' in request) return request.prepareFreshContent(lease);
    try {
      return { kind: 'ready', content: normalizeMessageContent(await request.prepareContent()) };
    } catch (error) {
      if (error instanceof RuntimeRegenerateTurnError) {
        return {
          kind: 'rejected',
          outcome:
            error.code === 'not_found' ? notFound(error.message) : operationConflict(error.message),
        };
      }
      throw error;
    }
  }

  private async queryTurnResume(
    input: TurnResumeQueryInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'turn.resume.query'>> {
    return this.sessionAdmission.run(input.sessionId, async () => {
      let header: SessionHeader;
      try {
        header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
      } catch (error) {
        if (isSessionNotFoundError(error)) return notFound('Session does not exist');
        throw error;
      }
      if (header.status === 'archived' || header.isArchived) {
        return sessionArchived('Cannot continue an archived Session');
      }
      const unavailableReason = runtimeHostSafeBoundaryContinuationUnavailableReason(header);
      if (unavailableReason) return operationUnavailable(unavailableReason);
      const reservation = this.#reservationsBySession.get(input.sessionId);
      const parkedAdmission = this.parkedContinuationAdmission(input.sessionId);
      if (
        this.#activeBySession.has(input.sessionId) ||
        (reservation &&
          (!parkedAdmission || !parkedContinuationMatchesQuery(parkedAdmission, input)))
      ) {
        return {
          ok: true,
          result: parkedTurnResumePlan(input.sessionId, 'session_busy'),
        };
      }
      const preview = await this.previewCapabilityBinding(
        input.sessionId,
        context.connectionId,
        () => this.planTurnResume(input),
      );
      return preview.ok
        ? { ok: true, result: preview.value }
        : { ok: true, result: parkedTurnResumePlan(input.sessionId, 'safety_check_failed') };
    });
  }

  private async previewCapabilityBinding<T>(
    sessionId: string,
    initiatingConnectionId: string,
    operation: () => Promise<T>,
  ): Promise<SessionBindingPreview<T>> {
    if (this.clientCapabilities) {
      return this.clientCapabilities.runWithSessionBindingPreview(
        sessionId,
        initiatingConnectionId,
        operation,
      );
    }
    return {
      ok: true,
      value: await operation(),
      commit: async () => ({ ok: true }),
    };
  }

  private startTurnResume(
    input: TurnResumeStartInput,
    context: ConnectionContext,
  ): Promise<TurnResumeStartOutcome> {
    return this.runCommand(async () => {
      const turnInput = continuationTurnInput(input.sessionId, input.turnId);
      const activeAtEntry = this.#activeBySession.has(input.sessionId);
      let reservation = activeAtEntry ? undefined : this.reserveRootTurn(input.sessionId);
      const disposition = await this.sessionAdmission
        .run<TurnResumeStartDisposition>(input.sessionId, async (lease) => {
          const existing = await this.stores.agentRunStore.readRootTurnAdmission(
            input.sessionId,
            input.turnId,
          );
          if (existing) {
            this.rootAdmissionOwner.assertKnownAdmission(existing);
            if (
              existing.execution.kind !== 'safe_boundary_continuation' ||
              existing.execution.sourceRunId !== input.sourceRunId ||
              existing.execution.sourceRuntimeEventHighWater !== input.sourceRuntimeEventHighWater
            ) {
              return {
                kind: 'complete',
                outcome: operationConflict(
                  'Turn identity was already admitted for a different continuation boundary',
                ),
              };
            }
            const header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
            const unavailableReason = runtimeHostSafeBoundaryContinuationUnavailableReason(header);
            if (unavailableReason) {
              return {
                kind: 'complete',
                outcome: operationUnavailable(unavailableReason),
              };
            }
            const active = this.#activeBySession.get(input.sessionId);
            if (active?.turnId === existing.turnId && active.runId === existing.runId) {
              return { kind: 'await_start', active };
            }
            if (active) {
              return {
                kind: 'complete',
                outcome: sessionBusy('Session already has an active root Turn'),
              };
            }
            const existingRun = await this.readRunIfPresent(input.sessionId, existing.runId);
            if (existingRun) {
              await this.assertRunMatchesDurableExecution(
                existingRun,
                existing.turnId,
                existing.execution,
              );
              const snapshot = await this.readCanonicalSnapshot(
                input.sessionId,
                input.turnId,
                existing.runId,
                existingRun,
              );
              if (isTerminalSnapshot(snapshot)) {
                this.clearParkedContinuationAdmission(existing);
                return {
                  kind: 'complete',
                  outcome: { ok: true, result: snapshot },
                };
              }
              const reconstructed = await this.reconstructAdmittedContinuation(existing);
              if (reconstructed.disposition === 'parked') {
                return { kind: 'parked', plan: reconstructed.plan };
              }
              throw new RuntimeMessageAuthorityInvariantError(
                `Non-terminal continuation Turn ${existing.turnId} became replayable`,
              );
            }
            const preview = await this.previewCapabilityBinding(
              input.sessionId,
              context.connectionId,
              () => this.reconstructAdmittedContinuation(existing),
            );
            if (!preview.ok) {
              return {
                kind: 'complete',
                outcome: operationConflict(preview.message),
              };
            }
            const reconstructed = preview.value;
            if (reconstructed.disposition === 'parked') {
              return { kind: 'parked', plan: reconstructed.plan };
            }
            const binding = await preview.commit();
            if (!binding.ok) {
              return {
                kind: 'complete',
                outcome: operationConflict(binding.message),
              };
            }
            reservation ??= this.takeParkedContinuationReservation(existing);
            return this.prepareAdmittedTurn(
              turnInput,
              existing,
              context.acquireResidency,
              lease,
              undefined,
              undefined,
              reservation,
              reconstructed.continuation,
            );
          }

          reservation ??= this.reserveRootTurn(input.sessionId);
          if (!reservation) {
            return {
              kind: 'complete',
              outcome: sessionBusy('Session already has an active or pending root Turn'),
            };
          }

          let header: SessionHeader;
          try {
            header = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
          } catch (error) {
            if (isSessionNotFoundError(error)) {
              return {
                kind: 'complete',
                outcome: notFound('Session does not exist'),
              };
            }
            throw error;
          }
          if (header.status === 'archived' || header.isArchived) {
            return {
              kind: 'complete',
              outcome: sessionArchived('Cannot continue an archived Session'),
            };
          }
          const unavailableReason = runtimeHostSafeBoundaryContinuationUnavailableReason(header);
          if (unavailableReason) {
            return {
              kind: 'complete',
              outcome: operationUnavailable(unavailableReason),
            };
          }
          if (this.#activeBySession.has(input.sessionId)) {
            return {
              kind: 'complete',
              outcome: sessionBusy('Session already has an active root Turn'),
            };
          }
          if (this.#reservationsBySession.get(input.sessionId) !== reservation) {
            return {
              kind: 'complete',
              outcome: sessionBusy('Root Turn reservation is no longer current'),
            };
          }

          const preview = await this.previewCapabilityBinding(
            input.sessionId,
            context.connectionId,
            () =>
              this.manager.planAuthoritativeSafeBoundaryContinuation(input.sessionId, {
                sourceRunId: input.sourceRunId,
                expectedRuntimeEventHighWater: input.sourceRuntimeEventHighWater,
              }),
          );
          if (!preview.ok) {
            return {
              kind: 'complete',
              outcome: operationConflict(preview.message),
            };
          }
          const plan = preview.value;
          const projection = projectTurnResumePlan(input.sessionId, plan);
          if (projection.disposition === 'parked') {
            return { kind: 'parked', plan: projection };
          }
          const planned = requirePlannedContinuation(plan);
          if (planned.sourceTurnId === input.turnId) {
            return {
              kind: 'complete',
              outcome: operationConflict(
                'Continuation Turn identity must differ from its source Turn',
              ),
            };
          }
          const continuation = { ...planned, turnId: input.turnId };
          const execution = continuationExecutionDescriptor(continuation);
          const binding = await preview.commit();
          if (!binding.ok) {
            return {
              kind: 'complete',
              outcome: operationConflict(binding.message),
            };
          }
          if (!this.beginRootAdmission(reservation)) {
            return {
              kind: 'complete',
              outcome: sessionBusy('Root Turn reservation is no longer current'),
            };
          }
          const admitted = await this.rootAdmissionOwner.admitRootTurn({
            sessionId: input.sessionId,
            turnId: input.turnId,
            proposedRunId: continuation.runId,
            proposedUserMessageId: null,
            execution,
            normalizedInput: null,
            sourceMessages: [],
            admittedAt: Date.now(),
          });
          if (
            admitted.admission.runId !== continuation.runId ||
            !isDeepStrictEqual(admitted.admission.execution, execution)
          ) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Safe-boundary continuation admission changed identity',
            );
          }
          return this.prepareAdmittedTurn(
            turnInput,
            admitted.admission,
            context.acquireResidency,
            lease,
            undefined,
            undefined,
            reservation,
            continuation,
          );
        })
        .finally(() => {
          if (reservation) this.releaseRootReservation(reservation);
        });
      if (disposition.kind === 'parked') {
        return { ok: true, result: { kind: 'parked', plan: disposition.plan } };
      }
      const outcome = await this.resolveStartDisposition(turnInput, disposition);
      return outcome.ok ? { ok: true, result: { kind: 'started', turn: outcome.result } } : outcome;
    });
  }

  private async planTurnResume(input: TurnResumeQueryInput): Promise<TurnResumePlan> {
    const plan = input.sourceRunId
      ? await this.manager.planAuthoritativeSafeBoundaryContinuation(input.sessionId, {
          sourceRunId: input.sourceRunId,
          ...(input.expectedRuntimeEventHighWater !== undefined
            ? {
                expectedRuntimeEventHighWater: input.expectedRuntimeEventHighWater,
              }
            : {}),
        })
      : await this.manager.planLatestAuthoritativeSafeBoundaryContinuation(input.sessionId);
    return projectTurnResumePlan(input.sessionId, plan);
  }

  private async reconstructAdmittedContinuation(
    admission: RootTurnAdmission,
  ): Promise<ReconstructedContinuation> {
    const execution = admission.execution;
    if (execution.kind !== 'safe_boundary_continuation') {
      throw new RuntimeMessageAuthorityInvariantError(
        'Only safe-boundary continuation admission can reconstruct a continuation',
      );
    }
    const plan = await this.manager.planAuthoritativeSafeBoundaryContinuation(admission.sessionId, {
      sourceRunId: execution.sourceRunId,
      expectedRuntimeEventHighWater: execution.sourceRuntimeEventHighWater,
    });
    const projection = projectTurnResumePlan(admission.sessionId, plan);
    if (projection.disposition === 'parked') {
      return { disposition: 'parked', plan: projection };
    }
    const planned = requirePlannedContinuation(plan);
    if (
      planned.sourceInvocationId !== execution.sourceInvocationId ||
      planned.sourceRunId !== execution.sourceRunId ||
      planned.sourceTurnId !== execution.sourceTurnId ||
      planned.sourceRuntimeEventHighWater !== execution.sourceRuntimeEventHighWater ||
      planned.boundary?.manifestDigest !== execution.boundaryDigest ||
      planned.providerReplayDigest !== execution.providerReplayDigest
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Safe-boundary continuation source proof changed after admission',
      );
    }
    if (continuationSafetyDigest(planned) !== execution.safetyDigest) {
      return {
        disposition: 'parked',
        plan: parkedTurnResumePlan(admission.sessionId, 'safety_check_failed'),
      };
    }
    return {
      disposition: 'ready',
      continuation: {
        ...planned,
        invocationId: execution.targetInvocationId,
        runId: admission.runId,
        turnId: admission.turnId,
        claimId: execution.claimId,
      },
    };
  }

  private queryTurn(input: TurnQueryInput): Promise<OperationOutcome<'turn.query'>> {
    return this.sessionAdmission.run(input.sessionId, async () => {
      const admission = await this.stores.agentRunStore.readRootTurnAdmission(
        input.sessionId,
        input.turnId,
      );
      if (!admission) return notFound('Turn was not admitted');
      this.rootAdmissionOwner.assertKnownAdmission(admission);
      return {
        ok: true,
        result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, admission.runId),
      };
    });
  }

  private stopTurn(input: TurnStopInput): Promise<OperationOutcome<'turn.stop'>> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(input.sessionId, (lease) =>
        this.declareStopFence(input, () => this.messages.commitStopFence(input), lease),
      );
      await declared?.deliverStop();
      await declared?.active.startSettled.promise;
      const disposition = await this.sessionAdmission.run(input.sessionId, (lease) =>
        this.prepareStopDisposition(input, () => this.messages.commitStopFence(input), lease),
      );
      if (disposition.kind === 'complete') return disposition.outcome;
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(input.sessionId);
      }
      await disposition.active.done;
      return {
        ok: true,
        result: await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId),
      };
    });
  }

  private async declareStopFence(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
    stopInput: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<DeclaredStopFence | undefined> {
    const active = this.#activeBySession.get(input.sessionId);
    if (!active || active.turnId !== input.turnId || active.runId !== input.runId) {
      return undefined;
    }
    if (active.startSettled.phase === 'rejected') {
      return { active, deliverStop: () => Promise.resolve() };
    }
    commitQueueFence();
    await this.interactions.claimRunClosure(input, 'turn_stopped', admission);
    const shouldDeliverStop = !active.stopRequested;
    active.stopRequested = true;
    return {
      active,
      deliverStop: () =>
        shouldDeliverStop
          ? this.deliverRuntimeStopIntent(input.sessionId, stopInput)
          : Promise.resolve(),
    };
  }

  private async prepareStopDisposition(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admissionLease: SessionAdmissionLease,
  ): Promise<TurnStopDisposition> {
    const admission = await this.stores.agentRunStore.readRootTurnAdmission(
      input.sessionId,
      input.turnId,
    );
    if (!admission) return { kind: 'complete', outcome: notFound('Turn was not admitted') };
    this.rootAdmissionOwner.assertKnownAdmission(admission);
    if (admission.runId !== input.runId) {
      return {
        kind: 'complete',
        outcome: operationConflict('Run identity does not match the admitted Turn'),
      };
    }

    const snapshot = await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId);
    const active = this.#activeBySession.get(input.sessionId);
    if (isTerminalSnapshot(snapshot)) {
      if (active?.turnId === input.turnId && active.runId === input.runId) {
        commitQueueFence();
        active.stopRequested = true;
        return { kind: 'await_terminal', active };
      }
      return { kind: 'complete', outcome: { ok: true, result: snapshot } };
    }
    const parked = this.parkedContinuationAdmission(input.sessionId);
    if (parked?.turnId === input.turnId && parked.runId === input.runId) {
      return {
        kind: 'complete',
        outcome: operationConflict(
          'Parked continuation cannot be stopped because no active provider execution exists',
        ),
      };
    }
    if (!active) {
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }
    if (active.turnId !== input.turnId || active.runId !== input.runId) {
      return {
        kind: 'complete',
        outcome: operationConflict('A different root Turn owns the active Session execution'),
      };
    }

    commitQueueFence();
    await this.interactions.claimRunClosure(input, 'turn_stopped', admissionLease);
    const shouldRequestStop = !active.stopRequested;
    active.stopRequested = true;
    return shouldRequestStop
      ? { kind: 'request_stop', active }
      : { kind: 'await_terminal', active };
  }

  private async prepareAdmittedTurn(
    input: RootTurnActivationInput,
    admission: RootTurnAdmission,
    acquireResidency: () => RuntimeHostResidency,
    admissionLease: SessionAdmissionLease,
    replacing?: ActiveRootTurn,
    execution?: RuntimeHostedRootExecutionInput,
    rootReservation?: RootTurnReservation,
    continuation?: RuntimeContinuation,
  ): Promise<TurnStartDisposition> {
    if (admission.sessionId !== input.sessionId || admission.turnId !== input.turnId) {
      throw new Error('Root Turn admission identity does not match its input');
    }
    const inputMatches =
      admission.normalizedInput === null || input.content === null
        ? admission.normalizedInput === input.content
        : messageContentsEqual(admission.normalizedInput, input.content);
    if (!inputMatches || !isDeepStrictEqual(admission.turnOrchestration, input.turnOrchestration)) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Root Turn admission payload does not match its input',
      );
    }
    const session = await this.stores.sessionStore.readHeaderSnapshot(input.sessionId);
    const unavailableReason =
      admission.execution.kind === 'safe_boundary_continuation'
        ? runtimeHostSafeBoundaryContinuationUnavailableReason(session)
        : runtimeHostExecutionUnavailableReason(session, admission.execution);
    if (unavailableReason) {
      return completedStart(operationUnavailable(unavailableReason));
    }
    const { runId } = admission;
    const existingRun = await this.readRunIfPresent(input.sessionId, runId);
    if (replacing && existingRun) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Fresh follow-up root Turn unexpectedly had an existing Run',
      );
    }
    if (existingRun) {
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        runId,
        existingRun,
      );
      if (isTerminalSnapshot(snapshot)) return completedStart({ ok: true, result: snapshot });
      const active = this.#activeBySession.get(input.sessionId);
      if (active?.turnId === input.turnId && active.runId === runId) {
        return { kind: 'await_start', active };
      }
      if (active) return completedStart(sessionBusy('Session already has an active root Turn'));
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }

    const active = this.#activeBySession.get(input.sessionId);
    const currentReservation = this.#reservationsBySession.get(input.sessionId);
    if (currentReservation && currentReservation !== rootReservation) {
      return completedStart(sessionBusy('Another root Turn is being admitted'));
    }
    if (rootReservation && currentReservation !== rootReservation) {
      return completedStart(sessionBusy('Root Turn reservation is no longer current'));
    }
    if (replacing && active !== replacing) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up root replacement lost the previous active Turn',
      );
    }
    if (active && active !== replacing) {
      if (active.turnId !== input.turnId || active.runId !== runId) {
        return completedStart(sessionBusy('Session already has an active root Turn'));
      }
      return { kind: 'await_start', active };
    }
    if (rootReservation && !this.beginRootAdmission(rootReservation)) {
      return completedStart(sessionBusy('Root Turn reservation is no longer current'));
    }

    const residency = acquireResidency();
    const messageIdentity = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId,
    };
    let messageReserved = false;
    try {
      this.messages.reserveRootTurn(messageIdentity);
      messageReserved = true;
      await this.continuity.holdTerminalPublication(
        input.sessionId,
        input.turnId,
        runId,
        admissionLease,
      );
    } catch (error) {
      if (messageReserved) this.messages.abandonRootReservation(messageIdentity);
      residency.release();
      throw error;
    }
    const startSettled = deferred();
    const goalOutcome = valueDeferred<GoalTurnOutcome>();
    const goalRegistration =
      admission.execution.kind !== 'goal' && admission.execution.kind !== 'context_compact'
        ? this.resolveGoal().beginObservedTurn(input.sessionId, input.turnId)
        : undefined;
    const entry: ActiveRootTurn = {
      turnId: input.turnId,
      runId,
      userMessageId: admission.userMessageId,
      ...(execution ? { execution } : {}),
      ...(continuation ? { continuation } : {}),
      descriptor: admission.execution,
      ...(goalRegistration?.kind === 'registered'
        ? { observedGoalSettler: goalRegistration.settle }
        : {}),
      goalOutcome,
      startSettled,
      done: Promise.resolve(),
      residency,
      stopRequested: false,
      messageTransitionCommitted: false,
    };
    if (replacing && this.#activeBySession.get(input.sessionId) !== replacing) {
      residency.release();
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up root replacement changed during execution reservation',
      );
    }
    if (rootReservation) {
      if (this.#reservationsBySession.get(input.sessionId) !== rootReservation) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Root Turn activation lost its committing reservation',
        );
      }
    }
    this.#activeBySession.set(input.sessionId, entry);
    entry.done = this.drainTurn(input, entry, startSettled);
    void entry.done.catch(() => undefined);
    if (rootReservation) {
      this.#reservationsBySession.delete(input.sessionId);
      rootReservation.admissionSettled.resolve();
      void entry.done.then(
        () => rootReservation.whenIdle.resolve(),
        () => rootReservation.whenIdle.resolve(),
      );
    }
    return { kind: 'await_start', active: entry };
  }

  private async resolveStartDisposition(
    input: Pick<RootTurnActivationInput, 'sessionId' | 'turnId'>,
    disposition: TurnStartDisposition,
  ): Promise<TurnStartOutcome> {
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.startSettled.promise;
    let result = await this.readCanonicalSnapshot(
      input.sessionId,
      input.turnId,
      disposition.active.runId,
    );
    if (isTerminalSnapshot(result)) {
      await disposition.active.done;
      result = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        disposition.active.runId,
      );
    }
    return {
      ok: true,
      result,
    };
  }

  private async drainTurn(
    input: RootTurnActivationInput,
    active: ActiveRootTurn,
    startSettled: Deferred,
  ): Promise<void> {
    let terminalTransitionStarted = false;
    try {
      const messageOrigin = rootExecutionMessageOrigin(active.descriptor);
      const onRunStarted = async (): Promise<void> => {
        await this.manager.commitRevisionVersion(input.sessionId);
        await this.continuity.refreshCanonical(input.sessionId);
        startSettled.resolve();
      };
      const stream =
        active.descriptor.kind === 'context_compact'
          ? this.manager.compactSession(input.sessionId, {
              turnId: input.turnId,
              hostedRoot: {
                runId: active.runId,
                onRunStarted,
              },
            })
          : active.continuation
            ? this.manager.resumeSafeBoundaryContinuation(active.continuation, {
                onRunStarted,
              })
            : active.execution
              ? active.execution.start({
                  runId: active.runId,
                  userMessageId: active.userMessageId,
                  onRunStarted: async () => {
                    await onRunStarted();
                    await active.execution?.onReady?.();
                  },
                })
              : this.manager.sendMessage(
                  input.sessionId,
                  {
                    turnId: input.turnId,
                    ...normalizeMessageContent(requireRootMessageContent(input)),
                    ...(active.descriptor.kind === 'regenerate'
                      ? {
                          parentTurnId: active.descriptor.sourceTurnId,
                          regeneratedFromTurnId: active.descriptor.sourceTurnId,
                        }
                      : {}),
                    ...(input.turnOrchestration
                      ? { turnOrchestration: input.turnOrchestration }
                      : {}),
                    ...(messageOrigin ? { origin: messageOrigin } : {}),
                  },
                  {
                    runId: active.runId,
                    userMessageId: active.userMessageId ?? undefined,
                    durability: 'required',
                    onRunStarted: async (startedRunId) => {
                      if (startedRunId !== active.runId) {
                        throw new Error(
                          'Runtime started a different Run than the admitted identity',
                        );
                      }
                      await onRunStarted();
                    },
                  },
                );
      for await (const event of stream) {
        if (active.execution?.onEvent) {
          try {
            active.execution.onEvent(event);
          } catch {
            // Presentation observers do not participate in execution authority.
          }
        }
        if (isRuntimeSessionTransientEvent(event)) {
          await this.continuity.acceptRuntimeEvent(input.sessionId, active.runId, event);
        } else if (isInteractionAnswerAck(event)) {
          await this.continuity.refreshCanonical(input.sessionId);
        } else if (event.type === 'user_question_request') {
          this.continuity.enqueueCanonicalRefresh(input.sessionId);
        }
      }
      const snapshot = await this.readCanonicalSnapshot(
        input.sessionId,
        input.turnId,
        active.runId,
      );
      await this.assertCompletedExecutionIdentity(input, active);
      if (!isTerminalSnapshot(snapshot)) {
        throw new Error('Runtime Turn drained without a canonical terminal fact');
      }
      if (snapshot.status === 'cancelled' && active.stopRequested) {
        startSettled.resolve();
      }
      this.observeGoalOutcome(active, goalOutcomeFromSnapshot(snapshot));
      await this.interruptPlanAfterUnsuccessfulTurn(input.sessionId, active, snapshot.status);
      terminalTransitionStarted = true;
      await this.completeTerminalTransition(input.sessionId, active);
    } catch (error) {
      let containedRunFailure = false;
      let executionAuditFailure: unknown;
      if (!terminalTransitionStarted) {
        try {
          const snapshot = await this.readCanonicalSnapshot(
            input.sessionId,
            input.turnId,
            active.runId,
          );
          if (isTerminalSnapshot(snapshot)) {
            try {
              await this.assertCompletedExecutionIdentity(input, active);
            } catch (auditFailure) {
              executionAuditFailure = auditFailure;
            }
            this.observeGoalOutcome(active, goalOutcomeFromSnapshot(snapshot));
            await this.interruptPlanAfterUnsuccessfulTurn(input.sessionId, active, snapshot.status);
            terminalTransitionStarted = true;
            await this.completeTerminalTransition(input.sessionId, active);
            containedRunFailure =
              executionAuditFailure === undefined &&
              startSettled.phase === 'resolved' &&
              ((!active.stopRequested &&
                snapshot.status === 'failed' &&
                isContainableRunFailure(error)) ||
                (active.stopRequested &&
                  snapshot.status === 'cancelled' &&
                  isStoppedInteractionAdmission(error)));
          }
        } catch {
          // Preserve the execution error unless identity audit found a stronger failure.
        }
      }
      if (containedRunFailure) return;
      const commandFailure = executionAuditFailure ?? error;
      this.observeGoalOutcome(
        active,
        goalErrorOutcome(active.turnId, errorMessage(commandFailure)),
      );
      startSettled.reject(commandFailure);
      this.requestHostDrain();
      throw commandFailure;
    } finally {
      let releaseRootOwnership = active.messageTransitionCommitted;
      if (!active.messageTransitionCommitted) {
        try {
          this.messages.abandonRootReservation({
            sessionId: input.sessionId,
            turnId: active.turnId,
            runId: active.runId,
          });
          releaseRootOwnership = true;
        } catch {
          this.requestHostDrain();
        }
      }
      if (releaseRootOwnership) {
        if (this.#activeBySession.get(input.sessionId) === active) {
          this.#activeBySession.delete(input.sessionId);
        }
        active.residency.release();
      }
      this.observeGoalOutcome(
        active,
        goalErrorOutcome(active.turnId, 'Runtime root Turn ended without a Goal outcome.'),
      );
      active.goalOutcome.resolve(active.observedGoalOutcome!);
    }
  }

  private observeGoalOutcome(active: ActiveRootTurn, outcome: GoalTurnOutcome): void {
    if (active.observedGoalOutcome) return;
    active.observedGoalOutcome = outcome;
    if (active.observedGoalSettler) void active.observedGoalSettler(outcome);
  }

  private async interruptPlanAfterUnsuccessfulTurn(
    sessionId: string,
    active: ActiveRootTurn,
    status: string,
  ): Promise<void> {
    if (status === 'completed' || !this.manager.hasPlanAuthority()) return;
    await this.manager.interruptActivePlanExecution(
      sessionId,
      status === 'cancelled'
        ? 'Plan execution was interrupted because the Runtime root Turn was cancelled.'
        : 'Plan execution was interrupted because the Runtime root Turn failed.',
      `plan_interrupt_${active.runId}`,
    );
  }

  private completeTerminalTransition(sessionId: string, active: ActiveRootTurn): Promise<void> {
    return this.sessionAdmission.run(sessionId, async (lease) => {
      if (this.#activeBySession.get(sessionId) !== active) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Terminal root Turn no longer owns the Session',
        );
      }
      const identity = {
        sessionId,
        turnId: active.turnId,
        runId: active.runId,
      };
      await this.interactions.assertTerminalFence(identity, lease);
      const batch = this.messages.beginTerminalTransition(identity);
      await this.continuity.publishTerminalProjection(
        sessionId,
        active.turnId,
        active.runId,
        lease,
      );
      if (batch.sources.length === 0) {
        this.messages.completeIdle(batch);
        active.messageTransitionCommitted = true;
        this.#activeBySession.delete(sessionId);
        return;
      }
      await this.startFollowupBatch(batch, active, lease);
    });
  }

  private async startFollowupBatch(
    batch: RootFollowupBatch,
    previous: ActiveRootTurn,
    admissionLease: SessionAdmissionLease,
  ): Promise<void> {
    const initiatingConnectionId = batch.initiatingConnectionId;
    if (!initiatingConnectionId) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up batch lost its initiating Client identity',
      );
    }
    // A confirmed follow-up must become a durable root even when a Session
    // provider is unavailable. Lost tools are omitted while ephemeral
    // capabilities bind to the Client that submitted this follow-up.
    await this.clientCapabilities?.bindConfirmedFollowup(batch.sessionId, initiatingConnectionId);

    const turnId = randomUUID();
    const admitted = await this.rootAdmissionOwner.admitRootTurn({
      sessionId: batch.sessionId,
      turnId,
      proposedRunId: randomUUID(),
      proposedUserMessageId: randomUUID(),
      execution: { kind: 'external_message' },
      normalizedInput: batch.content,
      sourceMessages: batch.sources,
      admittedAt: Date.now(),
    });
    if (admitted.kind !== 'admitted') {
      throw new RuntimeMessageAuthorityInvariantError(
        'Fresh follow-up root Turn identity already existed',
      );
    }

    const nextIdentity = {
      sessionId: batch.sessionId,
      turnId,
      runId: admitted.admission.runId,
    };
    this.messages.commitNextRoot(batch, nextIdentity);
    previous.messageTransitionCommitted = true;
    if (this.#activeBySession.get(batch.sessionId) !== previous) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up transition lost the previous root Turn',
      );
    }
    const disposition = await this.prepareAdmittedTurn(
      {
        sessionId: batch.sessionId,
        turnId,
        content: admitted.admission.normalizedInput,
      },
      admitted.admission,
      this.acquireRecoveryResidency,
      admissionLease,
      previous,
    );
    if (disposition.kind !== 'await_start') {
      throw new RuntimeMessageAuthorityInvariantError(
        'Fresh follow-up root Turn did not reserve execution',
      );
    }
  }

  private async deliverRuntimeStopIntent(
    sessionId: string,
    input: {
      source?: 'stop_button' | 'benchmark_deadline' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = { source: 'stop_button' },
  ): Promise<void> {
    await this.manager.deliverHostedRootStop(sessionId, input);
  }

  private async stopActiveTurn(sessionId: string, active: ActiveRootTurn): Promise<void> {
    const outcome = await this.stopTurn({
      sessionId,
      turnId: active.turnId,
      runId: active.runId,
    });
    if (!outcome.ok) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Unable to stop active root Turn during shutdown: ${outcome.error.code}`,
      );
    }
  }

  private async readCanonicalSnapshot(
    sessionId: string,
    turnId: string,
    runId: string,
    knownRun?: AgentRunHeader,
  ): Promise<TurnSnapshot> {
    const run = knownRun ?? (await this.readRunIfPresent(sessionId, runId));
    if (!run) return { sessionId, turnId, runId, status: 'admitted' };
    if (run.turnId !== turnId) {
      throw new Error('Admitted Turn identity does not match its Run header');
    }

    const [runEvents, runtimeEvents] = await Promise.all([
      this.stores.agentRunStore.readEvents(sessionId, runId),
      this.stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, runId),
    ]);
    const terminal = classifyTerminalRuntimeLedger(run, runtimeEvents);
    if (terminal.kind === 'fact') {
      const fact = terminal.fact;
      if (fact.runStatus === 'completed') {
        return {
          sessionId,
          turnId,
          runId,
          status: 'completed',
          terminalEventId: fact.terminalEvent.id,
        };
      }
      if (fact.runStatus === 'failed') {
        if (!fact.failureClass) throw new Error('Failed terminal fact has no failure class');
        return {
          sessionId,
          turnId,
          runId,
          status: 'failed',
          terminalEventId: fact.terminalEvent.id,
          failureClass: fact.failureClass,
        };
      }
      if (!fact.abortSource) throw new Error('Cancelled terminal fact has no abort source');
      return {
        sessionId,
        turnId,
        runId,
        status: 'cancelled',
        terminalEventId: fact.terminalEvent.id,
        abortSource: fact.abortSource,
      };
    }
    if (terminal.kind !== 'none') {
      throw new Error('Runtime ledger does not contain one canonical terminal fact');
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error('Terminal Run header has no canonical terminal RuntimeEvent');
    }
    if (run.status !== 'created' && !runEvents.some((event) => event.type === 'run_started')) {
      throw new Error('Non-created Run has no durable start fact');
    }
    return { sessionId, turnId, runId, status: run.status };
  }

  private async readRunIfPresent(
    sessionId: string,
    runId: string,
  ): Promise<AgentRunHeader | undefined> {
    try {
      return await this.stores.agentRunStore.readRun(sessionId, runId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async assertRunMatchesDurableExecution(
    run: AgentRunHeader,
    turnId: string,
    execution: RootTurnAdmission['execution'],
  ): Promise<void> {
    assertRunMatchesExecution(run, turnId, execution);
    if (execution.kind !== 'safe_boundary_continuation') return;
    const first = (
      await this.stores.runtimeEventStore.readImmutableRuntimeEvents(run.sessionId, run.runId)
    )[0];
    const start = first?.actions?.continuationStart;
    if (
      first?.invocationId !== execution.targetInvocationId ||
      first.turnId !== turnId ||
      !start ||
      start.claimId !== execution.claimId ||
      start.boundaryDigest !== execution.boundaryDigest ||
      start.replayManifestDigest !== execution.boundaryDigest ||
      start.providerReplayDigest !== execution.providerReplayDigest ||
      start.immediateSource.sessionId !== run.sessionId ||
      start.immediateSource.invocationId !== execution.sourceInvocationId ||
      start.immediateSource.runId !== execution.sourceRunId ||
      start.immediateSource.turnId !== execution.sourceTurnId ||
      start.immediateSource.highWater !== execution.sourceRuntimeEventHighWater
    ) {
      throw new RuntimeMessageAuthorityInvariantError(
        `Admitted Turn ${turnId} changed its continuation start proof`,
      );
    }
  }

  private async assertCompletedExecutionIdentity(
    input: Pick<RootTurnActivationInput, 'sessionId' | 'turnId'>,
    active: ActiveRootTurn,
  ): Promise<void> {
    const completedRun = await this.readRunIfPresent(input.sessionId, active.runId);
    if (!completedRun) {
      throw new RuntimeMessageAuthorityInvariantError(
        'Hosted root execution completed without its admitted Run',
      );
    }
    await this.assertRunMatchesDurableExecution(completedRun, input.turnId, active.descriptor);
  }

  private async runCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof RuntimeHostedRootConflictError) &&
        !(error instanceof RuntimeHostedRootUnavailableError) &&
        !(error instanceof HostedRootAdmissionGateError)
      ) {
        this.requestHostDrain();
      }
      throw error;
    }
  }
}

class HostedRootAdmissionGateError extends Error {
  readonly name = 'HostedRootAdmissionGateError';

  constructor(readonly cause: unknown) {
    super('Hosted root execution was rejected before durable admission', {
      cause,
    });
  }
}

type RecoveryUserMessage = Extract<StoredMessage, { type: 'user' }>;

interface RecoveryMessageIndex {
  userMessagesByTurnId: Map<string, RecoveryUserMessage[]>;
  messagesById: Map<string, StoredMessage[]>;
}

function requireAdmissionMessageContent(admission: RootTurnAdmission): MessageContent {
  if (admission.normalizedInput === null) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${admission.turnId} has no message input`,
    );
  }
  return admission.normalizedInput;
}

function rootMessageAdmissionMatches(
  admission: RootTurnAdmission,
  request: RootMessageStartRequest,
  content: MessageContent,
): boolean {
  return (
    isDeepStrictEqual(admission.execution, request.execution) &&
    (request.execution.kind === 'external_message' && request.execution.inputDigest
      ? true
      : messageContentsEqual(requireAdmissionMessageContent(admission), content)) &&
    isDeepStrictEqual(admission.turnOrchestration, request.turnOrchestration) &&
    admission.sourceMessages.length === 0
  );
}

function skillInvocationInputDigest(
  content: MessageContent,
  skillIds: readonly string[],
): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ content, skillIds: [...skillIds] }))
    .digest('hex')}`;
}

function composeHostedSkillInvocationContent(
  content: MessageContent,
  prepared: Exclude<PreparedSkillInvocationMessage, { disposition: 'blocked' }>,
): MessageContent {
  if (prepared.disposition === 'passthrough') return content;
  const displayText =
    content.displayText ??
    (content.text.trim().length > 0
      ? content.text
      : prepared.skillInvocation.loaded.map((skill) => `/skill:${skill.id}`).join(' '));
  const skillReferences = skillInvocationInlineReferences(
    prepared.skillInvocation.receipts,
    displayText,
  );
  const candidates = [
    ...(content.inlineReferences ?? []).filter((reference) => reference.kind !== 'skill'),
    ...skillReferences,
  ].sort((left, right) => left.start - right.start || right.value.length - left.value.length);
  const inlineReferences: NonNullable<MessageContent['inlineReferences']> = [];
  let previousEnd = 0;
  for (const reference of candidates) {
    if (inlineReferences.length === INLINE_REFERENCE_MAX_COUNT) break;
    if (reference.start < previousEnd) continue;
    inlineReferences.push(reference);
    previousEnd = reference.start + reference.value.length;
  }
  return normalizeMessageContent({
    ...content,
    text: prepared.sendText,
    displayText,
    inlineReferences,
  });
}

function preflightRootMessageContent(
  content: MessageContent,
):
  | { readonly ok: true; readonly content: MessageContent }
  | { readonly ok: false; readonly outcome: TurnStartOutcome } {
  try {
    return {
      ok: true,
      content: normalizeRootTurnAdmissionPayload(content, []).normalizedInput,
    };
  } catch {
    return {
      ok: false,
      outcome: operationConflict('Turn content exceeds durable admission limits'),
    };
  }
}

function recoveryUserMessage(admission: RootTurnAdmission): RecoveryUserMessage {
  if (!admission.userMessageId || !admission.normalizedInput) {
    throw new Error(`Admitted Turn ${admission.turnId} does not own a UserMessage`);
  }
  const origin = rootExecutionMessageOrigin(admission.execution);
  return {
    type: 'user',
    id: admission.userMessageId,
    turnId: admission.turnId,
    ts: admission.admittedAt,
    ...normalizeMessageContent(admission.normalizedInput),
    ...(origin ? { origin } : {}),
  };
}

function assertRunMatchesExecution(
  run: AgentRunHeader,
  turnId: string,
  execution: RootTurnAdmission['execution'],
): void {
  if (run.turnId !== turnId) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${turnId} does not match Run ${run.runId}`,
    );
  }
  switch (execution.kind) {
    case 'external_message':
      return;
    case 'regenerate':
    case 'context_compact':
    case 'automation':
    case 'goal':
    case 'agent_graph_supervisor_wake':
    case 'safe_boundary_continuation':
      if (agentRunMatchesHostedRootExecution(run, execution)) return;
      break;
    case 'linked_child_initial':
    case 'claimed_agent_graph_intent':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.resumedFromRunId === undefined && run.retriedFromRunId === undefined) return;
      break;
    case 'linked_child_resume':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.resumedFromRunId === execution.sourceRunId && run.retriedFromRunId === undefined) {
        return;
      }
      break;
    case 'linked_child_provider_retry':
      assertTrustedAgentIdentity(run, turnId, execution);
      if (run.retriedFromRunId === execution.sourceRunId && run.resumedFromRunId === undefined) {
        return;
      }
      break;
    default:
      assertNever(execution);
  }
  throw new RuntimeMessageAuthorityInvariantError(
    `Admitted Turn ${turnId} changed its root execution identity`,
  );
}

function assertTrustedAgentIdentity(
  run: AgentRunHeader,
  turnId: string,
  execution: Exclude<
    RootTurnAdmission['execution'],
    {
      kind:
        | 'external_message'
        | 'regenerate'
        | 'context_compact'
        | 'automation'
        | 'goal'
        | 'agent_graph_supervisor_wake'
        | 'safe_boundary_continuation';
    }
  >,
): void {
  if (run.agentId !== execution.agentId || run.agentName !== execution.agentName) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Admitted Turn ${turnId} changed its trusted agent identity`,
    );
  }
}

interface RecoveryExecutionContract {
  allowsQueueSources: boolean;
  requiresUserMessage: boolean;
  pendingWithoutRun: 'root_replay' | 'host_recovery_closure';
}

function recoveryExecutionContract(
  execution: RootTurnAdmission['execution'],
): RecoveryExecutionContract {
  switch (execution.kind) {
    case 'external_message':
      return {
        allowsQueueSources: true,
        requiresUserMessage: true,
        pendingWithoutRun: 'root_replay',
      };
    case 'regenerate':
      return {
        allowsQueueSources: false,
        requiresUserMessage: true,
        pendingWithoutRun: 'root_replay',
      };
    case 'context_compact':
      return {
        allowsQueueSources: false,
        requiresUserMessage: false,
        pendingWithoutRun: 'root_replay',
      };
    case 'automation':
      return {
        allowsQueueSources: false,
        requiresUserMessage: true,
        pendingWithoutRun: 'root_replay',
      };
    case 'goal':
      return {
        allowsQueueSources: false,
        requiresUserMessage: true,
        pendingWithoutRun: 'host_recovery_closure',
      };
    case 'safe_boundary_continuation':
      return {
        allowsQueueSources: false,
        requiresUserMessage: false,
        pendingWithoutRun: 'root_replay',
      };
    case 'agent_graph_supervisor_wake':
      return {
        allowsQueueSources: false,
        requiresUserMessage: true,
        pendingWithoutRun: 'host_recovery_closure',
      };
    case 'linked_child_initial':
    case 'linked_child_resume':
    case 'claimed_agent_graph_intent':
      return {
        allowsQueueSources: false,
        requiresUserMessage: true,
        pendingWithoutRun: 'host_recovery_closure',
      };
    case 'linked_child_provider_retry':
      return {
        allowsQueueSources: false,
        requiresUserMessage: false,
        pendingWithoutRun: 'host_recovery_closure',
      };
    default:
      return assertNever(execution);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported root execution descriptor: ${JSON.stringify(value)}`);
}

function indexRecoveryMessages(messages: readonly StoredMessage[]): RecoveryMessageIndex {
  const index: RecoveryMessageIndex = {
    userMessagesByTurnId: new Map(),
    messagesById: new Map(),
  };
  for (const message of messages) indexRecoveryMessage(index, message);
  return index;
}

function storedUserMessageContent(message: RecoveryUserMessage): MessageContent {
  return normalizeMessageContent(message);
}

function recoveryUserMessageOriginMatches(
  message: RecoveryUserMessage,
  execution: RootTurnAdmission['execution'],
): boolean {
  const expected = rootExecutionMessageOrigin(execution);
  return expected === undefined || isDeepStrictEqual(message.origin, expected);
}

function rootExecutionMessageOrigin(execution: RootExecutionDescriptor) {
  switch (execution.kind) {
    case 'automation':
      return {
        kind: 'automation' as const,
        automationId: execution.automationId,
      };
    case 'goal':
      return { kind: 'goal' as const, goalId: execution.goalId };
    case 'agent_graph_supervisor_wake':
      return {
        kind: 'agent_graph' as const,
        graphId: execution.graphId,
        wakeId: execution.wakeId,
        attemptId: execution.attemptId,
      };
    default:
      return undefined;
  }
}

function continuationTurnInput(
  sessionId: string,
  turnId: string,
): Extract<RootTurnActivationInput, { content: null }> {
  return {
    sessionId,
    turnId,
    content: null,
  };
}

function requireRootMessageContent(input: RootTurnActivationInput): MessageContent {
  if (input.content === null) {
    throw new RuntimeMessageAuthorityInvariantError(
      `Continuation Turn ${input.turnId} cannot enter message execution`,
    );
  }
  return input.content;
}

function activationInputForAdmission(admission: RootTurnAdmission): RootTurnActivationInput {
  if (admission.normalizedInput === null) {
    return continuationTurnInput(admission.sessionId, admission.turnId);
  }
  return {
    sessionId: admission.sessionId,
    turnId: admission.turnId,
    content: normalizeMessageContent(admission.normalizedInput),
    ...(admission.turnOrchestration
      ? { turnOrchestration: { ...admission.turnOrchestration } }
      : {}),
  };
}

function projectTurnResumePlan(
  sessionId: string,
  plan: SafeBoundaryContinuationPlan,
): TurnResumePlan {
  if (plan.disposition === 'continue') {
    const continuation = requirePlannedContinuation(plan);
    return {
      sessionId,
      disposition: 'ready',
      sourceRunId: continuation.sourceRunId,
      sourceTurnId: continuation.sourceTurnId,
      sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
    };
  }
  const reasons = new Set(plan.rejectionReasons);
  let reason: Extract<TurnResumePlan, { disposition: 'parked' }>['reason'];
  if (reasons.has('resume_candidate_missing')) reason = 'resume_candidate_missing';
  else if (reasons.has('source_run_unreadable') || reasons.has('runtime_ledger_unreadable')) {
    reason = 'source_run_unreadable';
  } else if (reasons.has('continuation_already_exists')) {
    reason = 'continuation_already_exists';
  } else if (reasons.has('continuation_started_indeterminate')) {
    reason = 'continuation_started_indeterminate';
  } else if (reasons.has('continuation_claim_repair_required')) {
    reason = 'continuation_repair_required';
  } else if (
    reasons.has('resume_feature_disabled') ||
    reasons.has('continuation_authority_unavailable') ||
    reasons.has('safety_observation_unavailable')
  ) {
    reason = 'continuation_unavailable';
  } else {
    reason = 'safety_check_failed';
  }
  return parkedTurnResumePlan(sessionId, reason);
}

function parkedTurnResumePlan(
  sessionId: string,
  reason: Extract<TurnResumePlan, { disposition: 'parked' }>['reason'],
): Extract<TurnResumePlan, { disposition: 'parked' }> {
  return { sessionId, disposition: 'parked', reason };
}

function parkedContinuationMatchesQuery(
  admission: RootTurnAdmission,
  input: TurnResumeQueryInput,
): boolean {
  const execution = admission.execution;
  if (execution.kind !== 'safe_boundary_continuation') return false;
  return (
    (input.sourceRunId === undefined || input.sourceRunId === execution.sourceRunId) &&
    (input.expectedRuntimeEventHighWater === undefined ||
      input.expectedRuntimeEventHighWater === execution.sourceRuntimeEventHighWater)
  );
}

function requirePlannedContinuation(plan: SafeBoundaryContinuationPlan): RuntimeContinuation {
  if (plan.disposition !== 'continue' || !plan.continuation) {
    throw new RuntimeMessageAuthorityInvariantError(
      'Ready continuation plan omitted its Runtime continuation',
    );
  }
  return plan.continuation;
}

function continuationExecutionDescriptor(
  continuation: RuntimeContinuation,
): Extract<RootExecutionDescriptor, { kind: 'safe_boundary_continuation' }> {
  const boundaryDigest = continuation.boundary?.manifestDigest;
  if (!continuation.claimId || !boundaryDigest || !continuation.providerReplayDigest) {
    throw new RuntimeMessageAuthorityInvariantError(
      'Authoritative continuation plan omitted its durable replay proof',
    );
  }
  return {
    kind: 'safe_boundary_continuation',
    sourceInvocationId: continuation.sourceInvocationId,
    sourceRunId: continuation.sourceRunId,
    sourceTurnId: continuation.sourceTurnId,
    sourceRuntimeEventHighWater: continuation.sourceRuntimeEventHighWater,
    claimId: continuation.claimId,
    boundaryDigest,
    providerReplayDigest: continuation.providerReplayDigest,
    safetyDigest: continuationSafetyDigest(continuation),
    targetInvocationId: continuation.invocationId,
  };
}

export function continuationSafetyDigest(continuation: RuntimeContinuation): `sha256:${string}` {
  const snapshot = continuation.safetySnapshot;
  const body = JSON.stringify([
    'runtime_continuation_safety_v1',
    snapshot.workspaceIdentity,
    snapshot.backgroundOperationsSettled,
    [...new Set(snapshot.availableToolNames)].sort(),
    snapshot.workspaceCheckpoint
      ? [snapshot.workspaceCheckpoint.ref, snapshot.workspaceCheckpoint.runtimeEventHighWater]
      : null,
  ]);
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function indexRecoveryMessage(index: RecoveryMessageIndex, message: StoredMessage): void {
  appendIndexed(index.messagesById, message.id, message);
  if (message.type === 'user') {
    appendIndexed(index.userMessagesByTurnId, message.turnId, message);
  }
}

function appendIndexed<K, V>(index: Map<K, V[]>, key: K, value: V): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}

function deferred(): Deferred {
  let phase: Deferred['phase'] = 'pending';
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    get phase() {
      return phase;
    },
    resolve: () => {
      if (phase !== 'pending') return;
      phase = 'resolved';
      resolvePromise();
    },
    reject: (error) => {
      if (phase !== 'pending') return;
      phase = 'rejected';
      rejectPromise(error);
    },
  };
}

function valueDeferred<T>(): ValueDeferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

function goalOutcomeFromSnapshot(snapshot: TurnSnapshot): GoalTurnOutcome {
  if (snapshot.status === 'completed') {
    return { kind: 'completed', turnId: snapshot.turnId };
  }
  if (snapshot.status === 'cancelled') {
    return { kind: 'aborted', turnId: snapshot.turnId };
  }
  if (snapshot.status === 'failed') {
    return {
      kind: 'errored',
      turnId: snapshot.turnId,
      reason: `Turn ended with ${snapshot.failureClass}`,
    };
  }
  return goalErrorOutcome(snapshot.turnId, `Turn ended in non-terminal status ${snapshot.status}`);
}

function goalErrorOutcome(turnId: string, reason: string): GoalTurnOutcome {
  return { kind: 'errored', turnId, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('Agent graph supervisor Turn was aborted', 'AbortError');
}

async function waitForRootIdleOrAbort(whenIdle: Promise<void>, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Agent graph supervisor Turn was aborted', 'AbortError'));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    void whenIdle.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isTerminalSnapshot(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

function isShutdownCancelledBackendStart(error: unknown): boolean {
  // The Host began draining while a Turn was still starting its backend, so
  // the interaction bind was rejected with authority_draining. The Turn never
  // ran; its drain rejects with this FailStopError and the Host is already
  // shutting down. Treating it as a shutdown failure would fail the whole
  // Host close — it is the expected consequence of stopping mid-start, not a
  // resource that failed to close.
  return (
    error instanceof RuntimeInteractionFailStopError &&
    error.authorityFailure instanceof RuntimeInteractionAdmissionRejectedError &&
    error.authorityFailure.reason === 'authority_draining'
  );
}

function isContainableRunFailure(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !(error instanceof RuntimeOwnerCleanupError) &&
    !(error instanceof RuntimeMessageAuthorityInvariantError) &&
    !(error instanceof RuntimeInteractionInvariantError) &&
    !(error instanceof RuntimeInteractionFailStopError)
  );
}

function isStoppedInteractionAdmission(
  error: unknown,
): error is RuntimeInteractionAdmissionRejectedError {
  return (
    error instanceof RuntimeInteractionAdmissionRejectedError &&
    error.reason === 'run_closed' &&
    error.closureReason === 'turn_stopped'
  );
}

function isRuntimeSessionTransientEvent(
  event: SessionEvent,
): event is RuntimeSessionTransientEvent {
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_delta' ||
    event.type === 'tool_start' ||
    event.type === 'tool_output_delta' ||
    event.type === 'tool_progress' ||
    event.type === 'tool_result'
  );
}

function isInteractionAnswerAck(event: SessionEvent): boolean {
  return event.type === 'user_question_answer_ack';
}

function completedStart(outcome: TurnStartOutcome): TurnStartDisposition {
  return { kind: 'complete', outcome };
}

function notFound(message: string) {
  return { ok: false, error: { code: 'not_found', message } } as const;
}

function sessionBusy(message: string) {
  return { ok: false, error: { code: 'session_busy', message } } as const;
}

function sessionArchived(message: string) {
  return { ok: false, error: { code: 'session_archived', message } } as const;
}

function operationUnavailable(message: string) {
  return {
    ok: false,
    error: { code: 'operation_unavailable', message },
  } as const;
}

function operationConflict(message: string) {
  return { ok: false, error: { code: 'operation_conflict', message } } as const;
}
