import { isDeepStrictEqual } from 'node:util';

import type {
  SandboxBoundaryDecisionAckEvent,
  SandboxBoundaryRequestEvent,
  UserQuestionAnswerAckEvent,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import type {
  InteractionCanonicalPermissionOutcome,
  InteractionClosureReason,
  InteractionPermissionRequest,
} from '@maka/core/interaction';
import type { SandboxBoundarySettlement } from '@maka/core/sandbox-boundary';
import type {
  HostedInteractionBridge,
  HostedSandboxBoundarySettlement,
  HostedUserQuestionAnswer,
  HostedUserQuestionSettlement,
} from '@maka/core/backend-types';

export type RuntimeInteractionClosureReason = InteractionClosureReason;

export type RuntimeInteractionRunClosureReason = Extract<
  RuntimeInteractionClosureReason,
  'turn_stopped' | 'turn_terminal'
>;

export type RuntimeUserQuestionClosureReason = Exclude<InteractionClosureReason, 'timed_out'>;

export interface RuntimeInteractionContinuationIdentity {
  readonly requestId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface RuntimeInteractionRunIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export type RuntimeUserQuestionAnswer = HostedUserQuestionAnswer;

export type RuntimeUserQuestionOutcome =
  | { kind: 'question_answer'; answer: RuntimeUserQuestionAnswer }
  | { kind: 'closure'; reason: RuntimeUserQuestionClosureReason };

export type RuntimeSandboxBoundaryOutcome =
  | { kind: 'sandbox_boundary_decision'; settlement: SandboxBoundarySettlement }
  | { kind: 'closure'; reason: RuntimeUserQuestionClosureReason };

export type RuntimeInteractionFatalError =
  | RuntimeInteractionFailStopError
  | RuntimeInteractionInvariantError;

export interface RuntimeUserQuestionContinuation
  extends RuntimeInteractionContinuationIdentity,
    HostedUserQuestionSettlement {
  waitForPublication(): Promise<void>;
}

export interface RuntimeSandboxBoundaryContinuation
  extends RuntimeInteractionContinuationIdentity,
    HostedSandboxBoundarySettlement {
  waitForPublication(): Promise<void>;
}

export interface RuntimeInteractionContinuationAuthority {
  acceptUserQuestionRequest(input: {
    request: UserQuestionRequestEvent;
    continuation: RuntimeUserQuestionContinuation;
  }): Promise<void>;
  acceptSandboxBoundaryRequest(input: {
    request: SandboxBoundaryRequestEvent;
    continuation: RuntimeSandboxBoundaryContinuation;
  }): Promise<void>;
}

export interface RuntimeInteractionRunFacet
  extends RuntimeInteractionContinuationAuthority,
    RuntimeInteractionRunIdentity {}

export interface RuntimeInteractionRunOwner extends RuntimeInteractionRunFacet {
  close(reason: RuntimeInteractionRunClosureReason): Promise<void>;
  release(): void;
}

export interface CanonicalPermissionOutcomeRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly request: InteractionPermissionRequest;
  readonly outcome: InteractionCanonicalPermissionOutcome;
}

export interface CanonicalPermissionOutcomeReader {
  readPermissionOutcome(requestId: string): Promise<CanonicalPermissionOutcomeRecord | undefined>;
}

export interface RuntimeInteractionAuthority {
  bindRun(identity: RuntimeInteractionRunIdentity): RuntimeInteractionRunOwner;
}

export class RuntimeInteractionClosedError extends Error {
  readonly name = 'RuntimeInteractionClosedError';

  constructor(
    readonly requestId: string,
    readonly reason: RuntimeInteractionClosureReason,
  ) {
    super(`Interaction request ${requestId} was already closed: ${reason}`);
  }
}

export type RuntimeInteractionAdmissionRejectionReason =
  | 'capacity_exceeded'
  | 'invalid_request'
  | 'not_published'
  | 'run_closed'
  | 'request_settled'
  | 'authority_draining';

export class RuntimeInteractionAdmissionRejectedError extends Error {
  readonly name = 'RuntimeInteractionAdmissionRejectedError';
  readonly closureReason: RuntimeInteractionRunClosureReason | undefined;

  constructor(
    readonly requestId: string,
    readonly reason: RuntimeInteractionAdmissionRejectionReason,
    authorityFailureOrClosureReason?: unknown,
  ) {
    const closureReason =
      reason === 'run_closed'
        ? (authorityFailureOrClosureReason as RuntimeInteractionRunClosureReason)
        : undefined;
    super(
      reason === 'run_closed'
        ? `Interaction request ${requestId} was not admitted because its run closed: ${closureReason}`
        : `Interaction request ${requestId} was not admitted: ${reason}`,
      reason === 'not_published' ? { cause: authorityFailureOrClosureReason } : undefined,
    );
    this.closureReason = closureReason;
  }
}

export class RuntimeInteractionInvariantError extends Error {
  readonly name = 'RuntimeInteractionInvariantError';
}

export class RuntimeInteractionFailStopError extends Error {
  readonly name = 'RuntimeInteractionFailStopError';

  constructor(
    message: string,
    readonly authorityFailure: unknown,
  ) {
    super(message, { cause: authorityFailure });
  }
}

type LocalClosureFinalizer = () => void;

type HostedInteractionRequestEvent = UserQuestionRequestEvent | SandboxBoundaryRequestEvent;
type HostedInteractionSettlementAckEvent =
  | UserQuestionAnswerAckEvent
  | SandboxBoundaryDecisionAckEvent;
type RuntimeHostedInteractionOutcome = RuntimeUserQuestionOutcome | RuntimeSandboxBoundaryOutcome;

interface TrackedContinuationBase {
  readonly requestId: string;
  readonly request: HostedInteractionRequestEvent;
  readonly publicationBarrier: Promise<void>;
  completePublicationBarrier(): void;
  admissionState: 'pending' | 'settled' | undefined;
  published: boolean;
  settlementStarted: boolean;
  settled: boolean;
  outcome?: RuntimeHostedInteractionOutcome;
  settlementPromise?: Promise<void>;
}

interface TrackedQuestionContinuation extends TrackedContinuationBase {
  readonly continuation: RuntimeUserQuestionContinuation;
}

interface TrackedSandboxBoundaryContinuation extends TrackedContinuationBase {
  readonly request: SandboxBoundaryRequestEvent;
  readonly continuation: RuntimeSandboxBoundaryContinuation;
}

type TrackedContinuation = TrackedQuestionContinuation | TrackedSandboxBoundaryContinuation;

/** Exact-Run bridge between RuntimeKernel and backend Interaction producers. */
export class RuntimeInteractionRunBinding implements HostedInteractionBridge {
  private closeReason: RuntimeInteractionRunClosureReason | undefined;
  private closePromise: Promise<void> | undefined;
  private localSettlementPromise: Promise<void> | undefined;
  private localClosuresSettled = false;
  private publicationsSealed = false;
  private released = false;
  private readonly localClosureFinalizers: LocalClosureFinalizer[] = [];
  private readonly continuations = new Map<string, TrackedContinuation>();

  constructor(readonly owner: RuntimeInteractionRunOwner) {}

  get sessionId(): string {
    return this.owner.sessionId;
  }

  get turnId(): string {
    return this.owner.turnId;
  }

  get runId(): string {
    return this.owner.runId;
  }

  async canResumeAfterSettlementAck(event: HostedInteractionSettlementAckEvent): Promise<boolean> {
    const settled = this.continuations.get(event.requestId);
    if (
      !settled ||
      settled.request.turnId !== event.turnId ||
      settled.request.toolUseId !== event.toolUseId ||
      !settled.settlementPromise
    ) {
      throw new RuntimeInteractionInvariantError(
        `Interaction acknowledgement ${event.requestId} has no exact local settlement`,
      );
    }
    await settled.settlementPromise;
    if (!settled.settled || !settlementMatchesAck(settled, event)) {
      throw new RuntimeInteractionInvariantError(
        `Interaction acknowledgement ${event.requestId} has no exact local settlement`,
      );
    }
    for (const tracked of this.continuations.values()) {
      if (tracked === settled) continue;
      if (!tracked.settled) return false;
    }
    return true;
  }

  async admitUserQuestionRequest(input: {
    request: UserQuestionRequestEvent;
    settlement: HostedUserQuestionSettlement;
  }): Promise<void> {
    const tracked = this.trackQuestion(input.request, input.settlement);
    try {
      await this.owner.acceptUserQuestionRequest({
        request: input.request,
        continuation: tracked.continuation,
      });
    } catch (error) {
      tracked.completePublicationBarrier();
      if (!tracked.settlementStarted) this.continuations.delete(tracked.requestId);
      throw error;
    }
    if (tracked.settlementStarted) {
      try {
        await tracked.settlementPromise;
        throw new RuntimeInteractionInvariantError(
          `Question ${tracked.requestId} settled during pending-only admission`,
        );
      } finally {
        tracked.completePublicationBarrier();
      }
    }
    tracked.admissionState = 'pending';
    if (this.publicationsSealed) {
      tracked.completePublicationBarrier();
      throw new RuntimeInteractionInvariantError(
        `Question ${tracked.requestId} completed admission after Interaction publication sealed`,
      );
    }
  }

  async admitSandboxBoundaryRequest(input: {
    request: SandboxBoundaryRequestEvent;
    settlement: HostedSandboxBoundarySettlement;
  }): Promise<void> {
    const tracked = this.trackSandboxBoundary(input.request, input.settlement);
    try {
      await this.owner.acceptSandboxBoundaryRequest({
        request: input.request,
        continuation: tracked.continuation,
      });
    } catch (error) {
      tracked.completePublicationBarrier();
      if (!tracked.settlementStarted) this.continuations.delete(tracked.requestId);
      throw error;
    }
    if (tracked.settlementStarted) {
      try {
        await tracked.settlementPromise;
        throw new RuntimeInteractionInvariantError(
          `Sandbox boundary ${tracked.requestId} settled during pending-only admission`,
        );
      } finally {
        tracked.completePublicationBarrier();
      }
    }
    tracked.admissionState = 'pending';
    if (this.publicationsSealed) {
      tracked.completePublicationBarrier();
      throw new RuntimeInteractionInvariantError(
        `Sandbox boundary ${tracked.requestId} completed admission after Interaction publication sealed`,
      );
    }
  }

  assertPendingAdmission(request: HostedInteractionRequestEvent): void {
    const tracked = this.continuations.get(request.requestId);
    // This synchronous guard is the publication linearization point. Close
    // blocks new tracking but lets its pre-existing exact admissions reach
    // this point; settlement still invalidates publication synchronously.
    if (
      this.publicationsSealed ||
      !tracked ||
      tracked.admissionState !== 'pending' ||
      tracked.settlementStarted ||
      tracked.settled ||
      tracked.published ||
      !isDeepStrictEqual(tracked.request, request)
    ) {
      this.sealPublications();
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${request.requestId} has no exact pending admission for Run ${this.runId}`,
      );
    }
    tracked.published = true;
    tracked.completePublicationBarrier();
  }

  sealPublications(): void {
    if (this.publicationsSealed) return;
    this.publicationsSealed = true;
    for (const tracked of this.continuations.values()) {
      if (
        tracked.admissionState === 'pending' &&
        !tracked.published &&
        !tracked.settlementStarted
      ) {
        tracked.completePublicationBarrier();
      }
    }
  }

  close(reason: RuntimeInteractionRunClosureReason): Promise<void> {
    if (this.released) {
      throw new RuntimeInteractionInvariantError(
        `Interaction Run ${this.runId} was released before close`,
      );
    }
    if (this.closePromise) return this.closePromise;
    this.closeReason = reason;
    const publicationBarriers = [...this.continuations.values()].map(
      (tracked) => tracked.publicationBarrier,
    );
    this.closePromise = Promise.all(publicationBarriers)
      .then(() => this.owner.close(reason))
      .catch((error: unknown) => {
        if (
          error instanceof RuntimeInteractionAdmissionRejectedError ||
          error instanceof RuntimeInteractionClosedError ||
          error instanceof RuntimeInteractionInvariantError ||
          error instanceof RuntimeInteractionFailStopError
        ) {
          throw error;
        }
        throw new RuntimeInteractionFailStopError(
          `Could not durably close Interaction Run ${this.runId}`,
          error,
        );
      });
    return this.closePromise;
  }

  deferLocalClosure(finalizer: LocalClosureFinalizer): void {
    if (this.localSettlementPromise || this.localClosuresSettled || this.released) {
      throw new RuntimeInteractionInvariantError(
        `Interaction Run ${this.runId} registered local closure after settlement`,
      );
    }
    this.localClosureFinalizers.push(finalizer);
  }

  settleLocalClosures(): Promise<void> {
    if (!this.closePromise) {
      throw new RuntimeInteractionInvariantError(
        `Interaction Run ${this.runId} settled local continuations before durable close`,
      );
    }
    this.localSettlementPromise ??= (async () => {
      await this.closePromise;
      for (const finalizer of this.localClosureFinalizers) finalizer();
      const escaped = [...this.continuations.values()].filter((tracked) => !tracked.settled);
      if (escaped.length > 0) {
        throw new RuntimeInteractionInvariantError(
          `Interaction Run ${this.runId} closed with unsettled continuations: ${escaped
            .map((tracked) => tracked.requestId)
            .join(', ')}`,
        );
      }
      this.localClosuresSettled = true;
    })();
    return this.localSettlementPromise;
  }

  release(): void {
    if (!this.closePromise || !this.localClosuresSettled) {
      throw new RuntimeInteractionInvariantError(
        `Interaction Run ${this.runId} released before durable close and local settlement`,
      );
    }
    if (this.released) return;
    try {
      this.owner.release();
    } catch (error) {
      throw error instanceof RuntimeInteractionInvariantError ||
        error instanceof RuntimeInteractionFailStopError
        ? error
        : new RuntimeInteractionFailStopError(
            `Could not release Interaction Run ${this.runId}`,
            error,
          );
    }
    this.released = true;
    this.continuations.clear();
  }

  private trackQuestion(
    request: UserQuestionRequestEvent,
    local: HostedUserQuestionSettlement,
  ): TrackedQuestionContinuation {
    this.assertNewContinuation(request);
    let tracked!: TrackedQuestionContinuation;
    const publication = createInteractionPublicationBarrier();
    const continuation: RuntimeUserQuestionContinuation = Object.freeze({
      requestId: request.requestId,
      turnId: this.turnId,
      runId: this.runId,
      waitForPublication: () => publication.publicationBarrier,
      applyAnswer: (answer: RuntimeUserQuestionAnswer) =>
        this.settleTracked(
          tracked,
          () => local.applyAnswer(answer),
          { kind: 'question_answer', answer },
          'question answer',
        ),
      applyClosure: (reason: RuntimeUserQuestionClosureReason) =>
        this.settleTracked(
          tracked,
          () => local.applyClosure(reason),
          { kind: 'closure', reason },
          'question closure',
        ),
    });
    tracked = {
      requestId: request.requestId,
      request,
      continuation,
      ...publication,
      admissionState: undefined,
      published: false,
      settlementStarted: false,
      settled: false,
    };
    this.continuations.set(request.requestId, tracked);
    return tracked;
  }

  private trackSandboxBoundary(
    request: SandboxBoundaryRequestEvent,
    local: HostedSandboxBoundarySettlement,
  ): TrackedSandboxBoundaryContinuation {
    this.assertNewContinuation(request);
    let tracked!: TrackedSandboxBoundaryContinuation;
    const publication = createInteractionPublicationBarrier();
    const continuation: RuntimeSandboxBoundaryContinuation = Object.freeze({
      requestId: request.requestId,
      turnId: this.turnId,
      runId: this.runId,
      waitForPublication: () => publication.publicationBarrier,
      applyDecision: (settlement: SandboxBoundarySettlement) =>
        this.settleTracked(
          tracked,
          () => local.applyDecision(settlement),
          { kind: 'sandbox_boundary_decision', settlement },
          'sandbox boundary decision',
        ),
      applyClosure: (reason: RuntimeUserQuestionClosureReason) =>
        this.settleTracked(
          tracked,
          () => local.applyClosure(reason),
          { kind: 'closure', reason },
          'sandbox boundary closure',
        ),
    });
    tracked = {
      requestId: request.requestId,
      request,
      continuation,
      ...publication,
      admissionState: undefined,
      published: false,
      settlementStarted: false,
      settled: false,
    };
    this.continuations.set(request.requestId, tracked);
    return tracked;
  }

  private assertNewContinuation(request: HostedInteractionRequestEvent): void {
    if (this.closeReason !== undefined) {
      throw new RuntimeInteractionAdmissionRejectedError(
        request.requestId,
        'run_closed',
        this.closeReason,
      );
    }
    if (this.publicationsSealed || this.released) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${request.requestId} registered after Run ${this.runId} sealed Interaction publication`,
      );
    }
    if (request.turnId !== this.turnId) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${request.requestId} has mismatched Run identity`,
      );
    }
    if (this.continuations.has(request.requestId)) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${request.requestId} registered more than once`,
      );
    }
  }

  private settleTracked(
    tracked: TrackedContinuation,
    apply: () => Promise<void>,
    outcome: RuntimeHostedInteractionOutcome,
    operation: string,
  ): Promise<void> {
    if (tracked.settlementStarted) {
      return Promise.reject(
        new RuntimeInteractionInvariantError(
          `Interaction ${operation} did not exact-take ${tracked.requestId}`,
        ),
      );
    }
    tracked.settlementStarted = true;
    const settlement = Promise.resolve()
      .then(apply)
      .then(() => {
        tracked.outcome = outcome;
        tracked.settled = true;
      })
      .finally(() => tracked.completePublicationBarrier());
    tracked.settlementPromise = settlement;
    return settlement;
  }
}

function createInteractionPublicationBarrier(): Pick<
  TrackedContinuationBase,
  'publicationBarrier' | 'completePublicationBarrier'
> {
  let complete!: () => void;
  const publicationBarrier = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    publicationBarrier,
    completePublicationBarrier: complete,
  };
}

function settlementMatchesAck(
  tracked: TrackedContinuation,
  event: HostedInteractionSettlementAckEvent,
): boolean {
  const outcome = tracked.outcome;
  if (!outcome) return false;
  if (event.type === 'user_question_answer_ack') return outcome.kind === 'question_answer';
  if (outcome.kind !== 'sandbox_boundary_decision') return false;
  const { request, boundary } = outcome.settlement;
  return (
    event.decision === (request.status === 'denied' ? 'deny' : 'allow') &&
    event.status === request.status &&
    event.revision === boundary.revision
  );
}

export async function bindRuntimeInteractionRun(
  authority: RuntimeInteractionAuthority,
  identity: RuntimeInteractionRunIdentity,
): Promise<RuntimeInteractionRunBinding> {
  let owner: RuntimeInteractionRunOwner;
  try {
    owner = authority.bindRun(identity);
  } catch (error) {
    throw error instanceof RuntimeInteractionInvariantError ||
      error instanceof RuntimeInteractionFailStopError
      ? error
      : new RuntimeInteractionFailStopError(
          `Could not bind Interaction Run ${identity.runId}`,
          error,
        );
  }
  if (
    owner.sessionId !== identity.sessionId ||
    owner.turnId !== identity.turnId ||
    owner.runId !== identity.runId
  ) {
    const mismatch = new RuntimeInteractionInvariantError(
      'Interaction authority returned a mismatched Run',
    );
    try {
      await owner.close('turn_terminal');
      owner.release();
    } catch (error) {
      throw new RuntimeInteractionFailStopError(
        `Could not reclaim mismatched Interaction Run ${identity.runId}`,
        new AggregateError([mismatch, error]),
      );
    }
    throw mismatch;
  }
  return new RuntimeInteractionRunBinding(owner);
}
