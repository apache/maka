import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { BackendStopMode } from '@maka/core/backend-types';
import type { AgentRunHeader, RootExecutionDescriptor } from '@maka/core/agent-run';
import {
  INLINE_REFERENCE_MAX_COUNT,
  messageContentsEqual,
  normalizeMessageContent,
  type AttachmentRef,
  type MessageContent,
  type SessionEvent,
} from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import { resolveEffectiveOrchestration } from '@maka/core/orchestration';
import {
  decodeSkillInvocationResult,
  type SkillInvocationResult,
} from '@maka/core/skill-invocation';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import {
  RuntimeHostedRootConflictError,
  RuntimeHostedRootUnavailableError,
  RuntimeMessageAuthorityInvariantError,
  type RuntimeMessageRunIdentity,
} from '@maka/runtime/message-authority';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
} from '@maka/runtime/interaction-authority';
import { RuntimeRegenerateTurnError, type SessionManager } from '@maka/runtime/session-manager';
import { RuntimeOwnerCleanupError } from '@maka/runtime/runtime-kernel';
import {
  parseSkillInvocationTokens,
  type PreparedSkillInvocationMessage,
} from '@maka/runtime/skill-invocation';
import { skillInvocationInlineReferences } from '@maka/runtime/skill-invocation-receipt';
import {
  type RuntimeContinuation,
  type SafeBoundaryContinuationPlan,
} from '@maka/runtime/runtime-resume';
import {
  authenticateExecutionStoresWriter,
  isSessionNotFoundError,
  normalizeRootTurnAdmissionPayload,
  type ExecutionStoresWriter,
  type RootTurnAdmission,
} from '@maka/storage/execution-stores';
import type {
  OperationOutcome,
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
  type HostMessagePreparationInput,
  type HostMessageSessionHeader,
  type HostMessageStartInput,
  type HostMessageStopClaim,
  type HostMessageStopFence,
  HostMessageCoordinator,
  type QueueFenceResult,
  type RootFollowupBatch,
} from './message-coordinator.js';
import { messageContentDigest } from './message-content-digest.js';
import type { ConnectionContext, TurnOperationHandlerMap } from './operation-dispatcher.js';
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
import type {
  HostedExecutionAdmission,
  HostedExecutionAdmissionResult,
  HostedExecutionAuthority,
  HostedExecutionCompletion,
  HostedExecutionCompletionObserver,
  HostedExecutionIdentity,
  HostedExecutionListener,
  HostedExecutionObserver,
  HostedExecutionPreparation,
  HostedExecutionRef,
  HostedExecutionSnapshot,
  HostedExecutionStopInput,
} from './hosted-execution-authority.js';
import { completedHostedExecutionAdmission } from './hosted-execution-authority.js';
import { HostedExecutionProjectionReader } from './hosted-execution-projection.js';
import {
  hostedExecutionMessageOrigin,
  prepareHostedExecutionRecovery,
  requireHostedExecutionMessageContent,
  type HostedExecutionRecoveryPlan,
} from './hosted-execution-recovery.js';
import { HostedExecutionRegistry } from './hosted-execution-registry.js';
import {
  HostedExecutionAdmissionRegistry,
  type HostedExecutionReservation,
} from './hosted-execution-admission-registry.js';
import { waitForHostedExecutionIdleOrAbort } from './hosted-execution-wait.js';

type RootTerminalInteractionFence = Pick<
  HostInteractionCoordinator,
  'assertTerminalFence' | 'claimRunClosure'
>;

interface ActiveRootTurn {
  sessionId: string;
  turnId: string;
  runId: string;
  userMessageId: string | null;
  execution?: HostedExecutionAdmission;
  continuation?: RuntimeContinuation;
  descriptor: RootExecutionDescriptor;
  graphOwnerId?: string;
  completionObserver?: HostedExecutionCompletionObserver;
  completion: ValueDeferred<HostedExecutionCompletion>;
  observedCompletion?: HostedExecutionCompletion;
  observationSettled?: Promise<void>;
  startSettled: Deferred;
  done: Promise<void>;
  residency: RuntimeHostResidency;
  stopRequested: boolean;
  messageTransitionCommitted: boolean;
}

export type TurnStartOutcome = OperationOutcome<'turn.start'>;
type RootMessageStartOutcome =
  | { ok: true; result: TurnSnapshot }
  | Extract<TurnStartOutcome, { ok: false }>;

export type RootMessageExecution = Extract<
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

export type RootMessageStartRequest =
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
      readonly skillInvocation?: SkillInvocationResult;
      readonly commitCapabilityBinding?: () => Promise<
        { readonly ok: true } | { readonly ok: false; readonly message: string }
      >;
    }
  | {
      readonly kind: 'rejected';
      readonly outcome: RootMessageStartOutcome;
      readonly skillInvocation?: SkillInvocationResult;
    };

export interface HostedExternalTurnTransitionInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly inputDigest: `sha256:${string}`;
  readonly archivedMessage: string;
  prepareContent(lease: SessionAdmissionLease): Promise<RootMessageContentPreparation>;
}

interface RootTurnActivationInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly content: MessageContent | null;
  readonly turnOrchestration?: TurnStartInput['turnOrchestration'];
}

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
  | { kind: 'complete'; outcome: RootMessageStartOutcome }
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

type RootTurnReservation = HostedExecutionReservation;

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

export class RootTurnCoordinator implements HostedExecutionAuthority {
  readonly handlers: Pick<TurnOperationHandlerMap, 'turn.resume.query' | 'turn.resume.start'> = {
    'turn.resume.query': (input, context) => this.queryTurnResume(input, context),
    'turn.resume.start': (input, context) => this.startTurnResume(input, context),
  };

  readonly #executions = new HostedExecutionRegistry<ActiveRootTurn>();
  readonly #admissions: HostedExecutionAdmissionRegistry;
  readonly #recoveryPlansBySession = new Map<string, HostedExecutionRecoveryPlan>();
  private readonly stores: ExecutionStoresWriter<'interactive'>;
  private readonly executionProjection: HostedExecutionProjectionReader;
  private readonly attachmentValidator: HostTurnAttachmentValidator | undefined;
  private readonly prepareSkillInvocation: HostSkillInvocationPreparer | undefined;

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
    private readonly resolveExecutionObserver: () => HostedExecutionObserver,
    private readonly assertScheduledTaskRecoveryAdmission?: (
      admission: RootTurnAdmission,
    ) => Promise<void>,
    attachmentValidator?: HostTurnAttachmentValidator,
    prepareSkillInvocation?: HostSkillInvocationPreparer,
  ) {
    this.stores = authenticateExecutionStoresWriter(stores, 'interactive');
    this.executionProjection = new HostedExecutionProjectionReader(this.stores);
    this.#admissions = new HostedExecutionAdmissionRegistry((sessionId) =>
      this.#executions.has(sessionId),
    );
    this.attachmentValidator = attachmentValidator;
    this.prepareSkillInvocation = prepareSkillInvocation;
  }

  async prepareRecovery(): Promise<void> {
    const plans = await prepareHostedExecutionRecovery({
      stores: this.stores,
      rootAdmissions: this.rootAdmissionOwner,
      projection: this.executionProjection,
      runtime: this.manager,
      ...(this.assertScheduledTaskRecoveryAdmission
        ? { assertScheduledTaskAdmission: this.assertScheduledTaskRecoveryAdmission }
        : {}),
    });
    for (const plan of plans) {
      this.#recoveryPlansBySession.set(plan.sessionId, plan);
    }
  }

  async recover(): Promise<void> {
    for (const [sessionId, plan] of this.#recoveryPlansBySession) {
      for (const admission of plan.admissions) {
        const run = await this.readRunIfPresent(sessionId, admission.runId);
        if (!run) continue;
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
      const admission = plan.rootReplayAdmission;
      if (!admission) continue;
      // Session recovery may have materialized this Run after the replay plan was prepared.
      if (await this.readRunIfPresent(sessionId, admission.runId)) continue;
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
    this.#recoveryPlansBySession.clear();
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.#admissions.waitForSettledAdmissions();
    const errors: unknown[] = [];
    while (errors.length === 0) {
      const active = [...this.#executions.entries()];
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
    if (this.#executions.size !== 0) {
      errors.push(new Error('Runtime Host execution composition closed with active Turns'));
    }
    this.#executions.close();
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
    const active = this.#executions.get(sessionId);
    if (active) {
      return {
        kind: 'active',
        sessionId,
        turnId: active.turnId,
        runId: active.runId,
      };
    }
    return this.#admissions.has(sessionId) ? { kind: 'reserved' } : { kind: 'idle' };
  }

  startHostedExternalTransition(
    input: HostedExternalTurnTransitionInput,
    context: ConnectionContext,
  ): Promise<RootMessageStartOutcome> {
    return this.startInteractiveRootMessage(
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
    return this.#admissions.reserve(sessionId);
  }

  private parkContinuationAdmission(admission: RootTurnAdmission): void {
    this.#admissions.park(admission);
  }

  private takeParkedContinuationReservation(
    admission: RootTurnAdmission,
  ): RootTurnReservation | undefined {
    return this.#admissions.takeParked(admission);
  }

  private clearParkedContinuationAdmission(admission: RootTurnAdmission): void {
    this.#admissions.clearParked(admission);
  }

  private parkedContinuationAdmission(sessionId: string): RootTurnAdmission | undefined {
    return this.#admissions.parked(sessionId);
  }

  private beginRootAdmission(reservation: RootTurnReservation): boolean {
    return this.#admissions.begin(reservation);
  }

  private releaseRootReservation(reservation: RootTurnReservation): void {
    this.#admissions.release(reservation);
  }

  beginDrain(): void {
    this.#admissions.beginDrain();
  }

  async runExclusiveSessionOperation<T>(
    input: {
      readonly sessionId: string;
      readonly abortSignal: AbortSignal;
      readonly stopSource?: HostedExecutionStopInput['source'];
    },
    operation: () => Promise<T>,
  ): Promise<T> {
    const { sessionId, abortSignal } = input;
    let reservation: RootTurnReservation;
    for (;;) {
      throwIfAborted(abortSignal);
      if (this.#admissions.isDraining) {
        throw new Error('Runtime Host root authority is draining.');
      }
      const available = this.reserveRootTurn(sessionId);
      if (available) {
        reservation = available;
        break;
      }
      const active = this.#executions.get(sessionId);
      const pending = this.#admissions.get(sessionId);
      const whenIdle = active?.done ?? pending?.whenIdle.promise;
      if (whenIdle) {
        await waitForHostedExecutionIdleOrAbort(whenIdle, abortSignal);
      }
    }

    try {
      return await this.sessionAdmission.run(sessionId, async () => {
        throwIfAborted(abortSignal);
        if (
          this.#admissions.isDraining ||
          this.#admissions.get(sessionId) !== reservation ||
          !this.beginRootAdmission(reservation)
        ) {
          throw new Error('Exclusive Session operation lost its root reservation.');
        }
        return this.#runWithAbortStop(
          abortSignal,
          () =>
            this.deliverRuntimeStopIntent(sessionId, {
              ...(input.stopSource ? { source: input.stopSource } : {}),
            }),
          operation,
        );
      });
    } finally {
      this.releaseRootReservation(reservation);
    }
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

  prepare(sessionId: string): HostedExecutionPreparation {
    if (this.#admissions.isDraining) {
      return {
        kind: 'unavailable',
        reason: 'Runtime Host execution authority is draining.',
      };
    }
    const active = this.#executions.get(sessionId);
    if (active) {
      return {
        kind: 'busy',
        whenIdle: active.done,
        execution: { sessionId, turnId: active.turnId, runId: active.runId },
      };
    }
    const pending = this.#admissions.get(sessionId);
    if (pending) return { kind: 'busy', whenIdle: pending.whenIdle.promise };
    const reservation = this.reserveRootTurn(sessionId);
    if (!reservation) {
      return {
        kind: 'unavailable',
        reason: 'Runtime Host execution admission is unavailable.',
      };
    }
    let consumed = false;
    return {
      kind: 'prepared',
      admission: Object.freeze({
        sessionId,
        admit: (input: HostedExecutionAdmission) => {
          if (consumed) {
            return Promise.reject(new Error('Hosted Execution preparation was already consumed'));
          }
          if (input.sessionId !== sessionId) {
            return Promise.reject(new Error('Hosted Execution preparation changed Session'));
          }
          consumed = true;
          return this.#admit(input, reservation);
        },
        release: () => {
          if (consumed) return;
          consumed = true;
          this.releaseRootReservation(reservation);
        },
      }),
    };
  }

  admit(input: HostedExecutionAdmission): Promise<HostedExecutionAdmissionResult> {
    return this.#admit(input);
  }

  #admit(
    input: HostedExecutionAdmission,
    preparedReservation?: RootTurnReservation,
  ): Promise<HostedExecutionAdmissionResult> {
    return this.runCommand(async () => {
      const activeAtEntry = this.#executions.has(input.sessionId);
      let reservation =
        preparedReservation ?? (activeAtEntry ? undefined : this.reserveRootTurn(input.sessionId));
      if (preparedReservation && this.#admissions.get(input.sessionId) !== preparedReservation) {
        throw new RuntimeHostedRootConflictError(
          input.sessionId,
          'Hosted Execution preparation is no longer current',
        );
      }
      if (!activeAtEntry && !reservation) {
        throw new RuntimeHostedRootConflictError(
          input.sessionId,
          'Session already has a pending root Turn',
        );
      }
      const canonicalInput = {
        ...input,
        content: input.content === null ? null : normalizeMessageContent(input.content),
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
            !isDeepStrictEqual(existing.turnOrchestration, input.turnOrchestration) ||
            !hostedExecutionContentMatches(existing, canonicalInput.content) ||
            existing.sourceMessages.length !== 0
          ) {
            throw new RuntimeMessageAuthorityInvariantError(
              'Hosted root execution identity conflicts with its durable admission',
            );
          }
          await runHostedExecutionAdmissionGate(canonicalInput.admitExecution);
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
        if (this.#executions.has(input.sessionId)) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Session already has an active root Turn',
          );
        }
        if (reservation && this.#admissions.get(input.sessionId) !== reservation) {
          throw new RuntimeHostedRootConflictError(
            input.sessionId,
            'Hosted root execution lost its pending reservation',
          );
        }
        await runHostedExecutionAdmissionGate(canonicalInput.admitExecution);
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
          ...(input.turnOrchestration ? { turnOrchestration: input.turnOrchestration } : {}),
          sourceMessages: [],
          admittedAt: Date.now(),
        });
        if (
          admitted.admission.runId !== input.runId ||
          admitted.admission.userMessageId !== input.userMessageId ||
          !isDeepStrictEqual(admitted.admission.execution, input.execution) ||
          !hostedExecutionContentMatches(admitted.admission, canonicalInput.content) ||
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
        this.#executions.publish(disposition.outcome.result);
        return completedHostedExecutionAdmission(disposition.outcome.result);
      }
      await disposition.active.startSettled.promise;
      const snapshot = await this.readCanonicalSnapshot(input.sessionId, input.turnId, input.runId);
      this.#executions.publish(snapshot);
      return Object.freeze({
        snapshot,
        completion: disposition.active.completion.promise,
        settled: disposition.active.done,
      });
    }).catch((error) => {
      if (error instanceof HostedRootAdmissionGateError) throw error.cause;
      throw error;
    });
  }

  lookup(sessionId: string, turnId: string): Promise<HostedExecutionIdentity | undefined> {
    return this.runCommand(async () => {
      const admission = await this.stores.agentRunStore.readRootTurnAdmission(sessionId, turnId);
      if (!admission) return undefined;
      this.rootAdmissionOwner.assertKnownAdmission(admission);
      return {
        sessionId,
        turnId,
        runId: admission.runId,
        userMessageId: admission.userMessageId,
        descriptor: admission.execution,
      };
    });
  }

  read(execution: HostedExecutionRef): Promise<HostedExecutionSnapshot> {
    return this.runCommand(() =>
      this.readCanonicalSnapshot(execution.sessionId, execution.turnId, execution.runId),
    );
  }

  async requestStop(input: HostedExecutionStopInput): Promise<HostedExecutionSnapshot> {
    await this.stopRoot(input.execution, {
      ...(input.source ? { source: input.source } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
    return await this.read(input.execution);
  }

  reconcile(execution: HostedExecutionRef): Promise<HostedExecutionSnapshot> {
    return this.read(execution);
  }

  subscribe(listener: HostedExecutionListener): () => void {
    return this.#executions.subscribe(listener);
  }

  whenIdle(sessionId: string): Promise<void> | undefined {
    return (
      this.#executions.get(sessionId)?.done ?? this.#admissions.get(sessionId)?.whenIdle.promise
    );
  }

  stopRoot(
    identity: RuntimeMessageRunIdentity,
    input: {
      source?: 'stop_button' | 'graph_supervisor';
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
        if (!disposition.outcome.ok) throwHostedStopError(identity.sessionId, disposition.outcome);
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
      source?: 'stop_button' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<void> {
    return this.runCommand(async () => {
      const declared = await this.sessionAdmission.run(sessionId, (lease) => {
        const active = this.#executions.get(sessionId);
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
          throwHostedStopError(sessionId, disposition.outcome);
        }
        return;
      }
      if (disposition.kind === 'request_stop') {
        await this.deliverRuntimeStopIntent(sessionId, input);
      }
      await disposition.active.done;
    });
  }

  async stopAgentGraphSupervisor(
    sessionId: string,
    input: {
      source?: 'stop_button' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<void> {
    const graphId = agentGraphIdForRootSession(sessionId);
    const identity = await this.runCommand(() =>
      this.sessionAdmission.run(sessionId, () => {
        const active = this.#executions.get(sessionId);
        if (!active || !activeRootOwnsAgentGraph(active, graphId)) return undefined;
        return {
          sessionId,
          turnId: active.turnId,
          runId: active.runId,
        };
      }),
    );
    if (identity) await this.stopRoot(identity, input);
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
      if (this.#executions.has(input.sessionId)) {
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
        const turnId = randomUUID();
        const hasSkillInvocation = parseSkillInvocationTokens(content.text).length > 0;
        const prepared = hasSkillInvocation
          ? await this.prepareHostedSkillInvocationContent(
              input.sessionId,
              turnId,
              content,
              [],
              input.initiatingConnectionId,
            )
          : ({ kind: 'ready', content } as const);
        if (prepared.kind === 'rejected') {
          return {
            error: prepared.outcome.ok
              ? 'Hosted Skill invocation was rejected'
              : prepared.outcome.error.message,
          };
        }
        const canonicalContent = preflightRootMessageContent(prepared.content);
        if (!canonicalContent.ok)
          return { error: 'Prepared message content exceeds durable limits' };
        const binding = prepared.commitCapabilityBinding
          ? await prepared.commitCapabilityBinding()
          : await this.clientCapabilities?.bindSession(
              input.sessionId,
              input.initiatingConnectionId,
            );
        if (binding && !binding.ok) return { error: binding.message };
        if (!this.beginRootAdmission(reservation)) {
          return { error: 'Root Turn reservation is no longer current' };
        }

        const admitted = await this.rootAdmissionOwner.admitRootTurn({
          sessionId: input.sessionId,
          turnId,
          proposedRunId: randomUUID(),
          proposedUserMessageId: input.sourceMessage.messageId,
          execution: {
            kind: 'external_message',
            inputDigest: messageContentDigest(content),
          },
          normalizedInput: canonicalContent.content,
          sourceMessages: [
            {
              ...input.sourceMessage,
              content: normalizeMessageContent(canonicalContent.content),
            },
          ],
          admittedAt: Date.now(),
        });
        if (admitted.kind !== 'admitted') {
          throw new RuntimeMessageAuthorityInvariantError(
            'Fresh Message root Turn identity already existed',
          );
        }
        const disposition = await this.prepareAdmittedTurn(
          {
            sessionId: input.sessionId,
            turnId,
            content: canonicalContent.content,
          },
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

  prepareMessage(
    input: HostMessagePreparationInput,
  ): Promise<
    | { readonly kind: 'ready'; readonly content: MessageContent }
    | { readonly kind: 'rejected'; readonly error: string }
  > {
    return this.runCommand(async () => {
      const content = normalizeMessageContent(input.content);
      if (parseSkillInvocationTokens(content.text).length === 0) {
        return { kind: 'ready', content };
      }
      const prepare = () =>
        this.prepareSkillInvocationContent(input.sessionId, input.turnId, content, []);
      if (input.placement === 'current_turn') return prepare();
      const preview = await this.previewCapabilityBinding(
        input.sessionId,
        input.initiatingConnectionId,
        prepare,
      );
      return preview.ok ? preview.value : { kind: 'rejected', error: preview.message };
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

  async prepareHostedSkillInvocationContent(
    sessionId: string,
    turnId: string,
    content: MessageContent,
    skillIds: readonly string[],
    connectionId: string,
  ): Promise<RootMessageContentPreparation> {
    const preview = await this.previewCapabilityBinding(sessionId, connectionId, () =>
      this.prepareSkillInvocationContent(sessionId, turnId, content, skillIds),
    );
    if (!preview.ok) {
      return { kind: 'rejected', outcome: operationConflict(preview.message) };
    }
    if (preview.value.kind === 'rejected') {
      return {
        kind: 'rejected',
        outcome: operationConflict(preview.value.error),
        skillInvocation: preview.value.skillInvocation,
      };
    }
    return {
      kind: 'ready',
      content: preview.value.content,
      skillInvocation: preview.value.skillInvocation,
      commitCapabilityBinding: preview.commit,
    };
  }

  private async prepareSkillInvocationContent(
    sessionId: string,
    turnId: string,
    content: MessageContent,
    skillIds: readonly string[],
  ): Promise<
    | {
        readonly kind: 'ready';
        readonly content: MessageContent;
        readonly skillInvocation: SkillInvocationResult;
      }
    | {
        readonly kind: 'rejected';
        readonly error: string;
        readonly skillInvocation?: SkillInvocationResult;
      }
  > {
    if (!this.prepareSkillInvocation) {
      return {
        kind: 'rejected',
        error: 'Hosted Skill invocation authority is unavailable',
      };
    }
    const prepared = await this.prepareSkillInvocation({
      sessionId,
      turnId,
      text: content.text,
      skillIds,
    });
    let skillInvocation: SkillInvocationResult;
    try {
      skillInvocation = decodeSkillInvocationResult(prepared.skillInvocation);
    } catch {
      return {
        kind: 'rejected',
        error: 'Hosted Skill invocation feedback is invalid',
      };
    }
    return prepared.disposition === 'blocked'
      ? {
          kind: 'rejected',
          error: 'Explicit Skill invocation could not be resolved',
          skillInvocation,
        }
      : {
          kind: 'ready',
          content: composeHostedSkillInvocationContent(content, {
            ...prepared,
            skillInvocation,
          }),
          skillInvocation,
        };
  }

  startInteractiveRootMessage(
    request: RootMessageStartRequest,
    context: ConnectionContext,
  ): Promise<RootMessageStartOutcome> {
    return this.runCommand(async () => {
      await this.awaitTerminalRootCleanup(request.sessionId);
      const activeAtEntry = this.#executions.has(request.sessionId);
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
              'content' in request
                ? request.content
                : requireHostedExecutionMessageContent(existing);
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
        if (this.#executions.has(request.sessionId)) {
          return completedStart(sessionBusy('Session already has an active root Turn'));
        }
        if (this.#admissions.get(request.sessionId) !== reservation) {
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
          ...(prepared.skillInvocation ? { skillInvocation: prepared.skillInvocation } : {}),
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
    const active = this.#executions.get(sessionId);
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
      return {
        kind: 'ready',
        content: normalizeMessageContent(await request.prepareContent()),
      };
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
      const reservation = this.#admissions.get(input.sessionId);
      const parkedAdmission = this.parkedContinuationAdmission(input.sessionId);
      if (
        this.#executions.has(input.sessionId) ||
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
        : {
            ok: true,
            result: parkedTurnResumePlan(input.sessionId, 'safety_check_failed'),
          };
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
      const activeAtEntry = this.#executions.has(input.sessionId);
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
            const active = this.#executions.get(input.sessionId);
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
          if (this.#executions.has(input.sessionId)) {
            return {
              kind: 'complete',
              outcome: sessionBusy('Session already has an active root Turn'),
            };
          }
          if (this.#admissions.get(input.sessionId) !== reservation) {
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

  private async declareStopFence(
    input: Pick<TurnStopInput, 'sessionId' | 'turnId' | 'runId'>,
    commitQueueFence: () => QueueFenceResult,
    admission: SessionAdmissionLease,
    stopInput: {
      source?: 'stop_button' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = {},
  ): Promise<DeclaredStopFence | undefined> {
    const active = this.#executions.get(input.sessionId);
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
    const active = this.#executions.get(input.sessionId);
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
    execution?: HostedExecutionAdmission,
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
      const active = this.#executions.get(input.sessionId);
      if (active?.turnId === input.turnId && active.runId === runId) {
        return { kind: 'await_start', active };
      }
      if (active) return completedStart(sessionBusy('Session already has an active root Turn'));
      throw new Error('Admitted non-terminal Turn has no active Runtime Host execution');
    }

    const active = this.#executions.get(input.sessionId);
    const currentReservation = this.#admissions.get(input.sessionId);
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
    const graphOwnerId = await this.resolveGraphOwnerId(session, admission);
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
    const completion = valueDeferred<HostedExecutionCompletion>();
    const completionObserver = this.resolveExecutionObserver().begin({
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId,
      descriptor: admission.execution,
    });
    const entry: ActiveRootTurn = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId,
      userMessageId: admission.userMessageId,
      ...(execution ? { execution } : {}),
      ...(continuation ? { continuation } : {}),
      descriptor: admission.execution,
      ...(graphOwnerId ? { graphOwnerId } : {}),
      ...(completionObserver ? { completionObserver } : {}),
      completion,
      startSettled,
      done: Promise.resolve(),
      residency,
      stopRequested: false,
      messageTransitionCommitted: false,
    };
    if (replacing && this.#executions.get(input.sessionId) !== replacing) {
      residency.release();
      throw new RuntimeMessageAuthorityInvariantError(
        'Follow-up root replacement changed during execution reservation',
      );
    }
    if (rootReservation) {
      if (this.#admissions.get(input.sessionId) !== rootReservation) {
        throw new RuntimeMessageAuthorityInvariantError(
          'Root Turn activation lost its committing reservation',
        );
      }
    }
    this.#executions.activate(entry, replacing);
    entry.done = this.drainTurn(input, entry, startSettled);
    void entry.done.catch(() => undefined);
    if (rootReservation) {
      this.#admissions.activated(rootReservation, entry.done);
    }
    return { kind: 'await_start', active: entry };
  }

  private async resolveStartDisposition(
    input: Pick<RootTurnActivationInput, 'sessionId' | 'turnId'>,
    disposition: TurnStartDisposition,
  ): Promise<RootMessageStartOutcome> {
    if (disposition.kind === 'complete') return disposition.outcome;
    await disposition.active.startSettled.promise;
    const result = await this.readCanonicalSnapshot(
      input.sessionId,
      input.turnId,
      disposition.active.runId,
    );
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
      const messageOrigin = hostedExecutionMessageOrigin(active.descriptor);
      const onRunStarted = async (): Promise<void> => {
        await this.manager.commitRevisionVersion(input.sessionId);
        await this.continuity.refreshCanonical(input.sessionId);
        startSettled.resolve();
      };
      const stream = active.execution
        ? active.execution.start({
            runId: active.runId,
            userMessageId: active.userMessageId,
            onRunStarted: async () => {
              await onRunStarted();
              await active.execution?.onReady?.();
            },
          })
        : active.descriptor.kind === 'context_compact'
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
                  ...(active.descriptor.kind === 'external_message' &&
                  active.descriptor.maxSteps !== undefined
                    ? { maxSteps: active.descriptor.maxSteps }
                    : {}),
                  ...(messageOrigin ? { origin: messageOrigin } : {}),
                },
                {
                  runId: active.runId,
                  userMessageId: active.userMessageId ?? undefined,
                  durability: 'required',
                  onRunStarted: async (startedRunId) => {
                    if (startedRunId !== active.runId) {
                      throw new Error('Runtime started a different Run than the admitted identity');
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
      this.observeExecutionCompletion(active, { kind: 'terminal', snapshot });
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
            this.observeExecutionCompletion(active, {
              kind: 'terminal',
              snapshot,
            });
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
      this.observeExecutionCompletion(active, {
        kind: 'authority_error',
        execution: active,
        reason: errorMessage(commandFailure),
      });
      startSettled.reject(commandFailure);
      this.requestHostDrain();
      throw commandFailure;
    } finally {
      this.observeExecutionCompletion(active, {
        kind: 'authority_error',
        execution: active,
        reason: 'Runtime root Turn ended without a canonical completion.',
      });
      await active.observationSettled?.catch(() => this.requestHostDrain());
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
        this.#executions.release(active);
        active.residency.release();
      }
      active.completion.resolve(active.observedCompletion!);
      this.#executions.publish(active);
    }
  }

  private observeExecutionCompletion(
    active: ActiveRootTurn,
    completion: HostedExecutionCompletion,
  ): void {
    if (active.observedCompletion) return;
    active.observedCompletion = completion;
    const settlement = active.completionObserver?.(completion);
    if (settlement) active.observationSettled = Promise.resolve(settlement);
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
      if (this.#executions.get(sessionId) !== active) {
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
        this.#executions.release(active);
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
      execution: {
        kind: 'external_message',
        inputDigest: messageContentDigest(batch.submittedContent),
      },
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
    if (this.#executions.get(batch.sessionId) !== previous) {
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
      source?: 'stop_button' | 'graph_supervisor';
      mode?: BackendStopMode;
    } = { source: 'stop_button' },
  ): Promise<void> {
    await this.manager.deliverHostedRootStop(sessionId, input);
  }

  private async stopActiveTurn(sessionId: string, active: ActiveRootTurn): Promise<void> {
    await this.stopRoot({
      sessionId,
      turnId: active.turnId,
      runId: active.runId,
    });
  }

  private async readCanonicalSnapshot(
    sessionId: string,
    turnId: string,
    runId: string,
    knownRun?: AgentRunHeader,
  ): Promise<TurnSnapshot> {
    return this.executionProjection.read({ sessionId, turnId, runId }, knownRun);
  }

  private async readRunIfPresent(
    sessionId: string,
    runId: string,
  ): Promise<AgentRunHeader | undefined> {
    return this.executionProjection.readRunIfPresent(sessionId, runId);
  }

  private async resolveGraphOwnerId(
    session: SessionHeader,
    admission: RootTurnAdmission,
  ): Promise<string | undefined> {
    if (admission.execution.kind === 'context_compact') return undefined;
    const mode =
      admission.execution.kind === 'safe_boundary_continuation'
        ? ((
            await this.stores.agentRunStore.readRun(
              admission.sessionId,
              admission.execution.sourceRunId,
            )
          ).orchestrationMode ??
          resolveEffectiveOrchestration(session.orchestrationMode, undefined).mode)
        : resolveEffectiveOrchestration(session.orchestrationMode, admission.turnOrchestration)
            .mode;
    return mode === 'graph' || mode === 'swarm'
      ? agentGraphIdForRootSession(admission.sessionId)
      : undefined;
  }

  private async assertRunMatchesDurableExecution(
    run: AgentRunHeader,
    turnId: string,
    execution: RootTurnAdmission['execution'],
  ): Promise<void> {
    await this.executionProjection.assertRunIdentityAndContinuation(run, turnId, execution);
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
    super('Hosted root execution was rejected before Runtime admission', {
      cause,
    });
  }
}

async function runHostedExecutionAdmissionGate(
  gate: HostedExecutionAdmission['admitExecution'],
): Promise<void> {
  if (!gate) return;
  let admission: 'executing' | 'cancelled';
  try {
    admission = await gate();
  } catch (error) {
    throw new HostedRootAdmissionGateError(error);
  }
  if (admission === 'cancelled') {
    throw new HostedRootAdmissionGateError(
      new Error('Turn start was cancelled before Runtime admission'),
    );
  }
}

function throwHostedStopError(
  sessionId: string,
  outcome: Extract<TurnStopOutcome, { ok: false }>,
): never {
  switch (outcome.error.code) {
    case 'operation_conflict':
      throw new RuntimeHostedRootConflictError(sessionId, outcome.error.message);
    default:
      throw new RuntimeHostedRootUnavailableError(sessionId, outcome.error.message);
  }
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
      : messageContentsEqual(requireHostedExecutionMessageContent(admission), content)) &&
    isDeepStrictEqual(admission.turnOrchestration, request.turnOrchestration) &&
    admission.sourceMessages.length === 0
  );
}

function hostedExecutionContentMatches(
  admission: RootTurnAdmission,
  content: MessageContent | null,
): boolean {
  return admission.normalizedInput === null || content === null
    ? admission.normalizedInput === content
    : messageContentsEqual(admission.normalizedInput, content);
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
  | { readonly ok: false; readonly outcome: RootMessageStartOutcome } {
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

function continuationTurnInput(sessionId: string, turnId: string): RootTurnActivationInput {
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
    ...(admission.execution.kind === 'external_message' &&
    admission.execution.maxSteps !== undefined
      ? { maxSteps: admission.execution.maxSteps }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('Agent graph supervisor Turn was aborted', 'AbortError');
}

function isTerminalSnapshot(snapshot: TurnSnapshot): boolean {
  return (
    snapshot.status === 'completed' ||
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled'
  );
}

function activeRootOwnsAgentGraph(active: ActiveRootTurn, graphId: string): boolean {
  return active.graphOwnerId === graphId;
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
    event.type === 'text_complete' ||
    event.type === 'thinking_delta' ||
    event.type === 'thinking_complete' ||
    event.type === 'tool_start' ||
    event.type === 'tool_output_delta' ||
    event.type === 'tool_progress' ||
    event.type === 'tool_result_preview' ||
    event.type === 'tool_result'
  );
}

function isInteractionAnswerAck(event: SessionEvent): boolean {
  return event.type === 'user_question_answer_ack';
}

function completedStart(outcome: RootMessageStartOutcome): TurnStartDisposition {
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
