import { isDeepStrictEqual } from 'node:util';

import type {
  AnyPermissionRequestEvent,
  PermissionAnswerAckEvent,
  PermissionClosureAckEvent,
  PermissionDecisionAckEvent,
  UserQuestionAnswerAckEvent,
  UserQuestionRequestEvent,
} from '@maka/core/events';
import type {
  InteractionCanonicalPermissionOutcome,
  InteractionClosureReason,
  InteractionPermissionRequest,
} from '@maka/core';
import type {
  HostedInteractionBridge,
  HostedPermissionAdmission,
  HostedPermissionAnswer,
  HostedPermissionCommitOutcome,
  HostedPermissionSettlement,
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

export type RuntimePermissionAnswer = HostedPermissionAnswer;

export type RuntimeUserQuestionAnswer = HostedUserQuestionAnswer;

export type RuntimePermissionOutcome =
  | { kind: 'permission_answer'; answer: RuntimePermissionAnswer }
  | { kind: 'closure'; reason: RuntimeInteractionClosureReason };

export type RuntimeUserQuestionOutcome =
  | { kind: 'question_answer'; answer: RuntimeUserQuestionAnswer }
  | { kind: 'closure'; reason: RuntimeUserQuestionClosureReason };

export type RuntimeInteractionFatalError =
  | RuntimeInteractionFailStopError
  | RuntimeInteractionInvariantError;

export interface RuntimePermissionContinuation
  extends RuntimeInteractionContinuationIdentity,
    HostedPermissionSettlement {}

export interface RuntimeUserQuestionContinuation
  extends RuntimeInteractionContinuationIdentity,
    HostedUserQuestionSettlement {}

export interface RuntimeInteractionContinuationAuthority {
  acceptPermissionRequest(input: {
    request: AnyPermissionRequestEvent;
    rememberScopeId?: string;
    continuation: RuntimePermissionContinuation;
  }): Promise<HostedPermissionAdmission>;

  commitPermissionAnswer(input: {
    continuation: RuntimePermissionContinuation;
    answer: RuntimePermissionAnswer;
  }): Promise<RuntimePermissionOutcome>;

  commitPermissionTimeout(input: {
    continuation: RuntimePermissionContinuation;
  }): Promise<RuntimePermissionOutcome>;

  acceptUserQuestionRequest(input: {
    request: UserQuestionRequestEvent;
    continuation: RuntimeUserQuestionContinuation;
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

interface TrackedContinuationBase {
  readonly requestId: string;
  readonly request: AnyPermissionRequestEvent | UserQuestionRequestEvent;
  admissionState: 'pending' | 'settled' | undefined;
  published: boolean;
  settlementStarted: boolean;
  settled: boolean;
  outcome?: RuntimePermissionOutcome | RuntimeUserQuestionOutcome;
  settlementPromise?: Promise<void>;
}

interface TrackedPermissionContinuation extends TrackedContinuationBase {
  readonly kind: 'permission';
  readonly continuation: RuntimePermissionContinuation;
}

interface TrackedQuestionContinuation extends TrackedContinuationBase {
  readonly kind: 'question';
  readonly continuation: RuntimeUserQuestionContinuation;
}

type TrackedContinuation = TrackedPermissionContinuation | TrackedQuestionContinuation;

/** Exact-Run bridge between RuntimeKernel and backend Interaction producers. */
export class RuntimeInteractionRunBinding implements HostedInteractionBridge {
  private closeReason: RuntimeInteractionRunClosureReason | undefined;
  private closePromise: Promise<void> | undefined;
  private localSettlementPromise: Promise<void> | undefined;
  private localClosuresSettled = false;
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

  async canResumeAfterSettlementAck(
    event:
      | PermissionAnswerAckEvent
      | PermissionClosureAckEvent
      | PermissionDecisionAckEvent
      | UserQuestionAnswerAckEvent,
  ): Promise<boolean> {
    if (event.type === 'permission_decision_ack') {
      throw new RuntimeInteractionInvariantError(
        `Hosted permission answer ${event.requestId} used a legacy decision acknowledgement`,
      );
    }
    const settled = this.continuations.get(event.requestId);
    const expectedKind = event.type === 'user_question_answer_ack' ? 'question' : 'permission';
    if (
      !settled ||
      settled.kind !== expectedKind ||
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

  async admitPermissionRequest(input: {
    request: AnyPermissionRequestEvent;
    rememberScopeId?: string;
    settlement: HostedPermissionSettlement;
  }): Promise<HostedPermissionAdmission> {
    const tracked = this.trackPermission(input.request, input.settlement);
    let admission: HostedPermissionAdmission;
    try {
      admission = await this.owner.acceptPermissionRequest({
        request: input.request,
        ...(input.rememberScopeId ? { rememberScopeId: input.rememberScopeId } : {}),
        continuation: tracked.continuation,
      });
    } catch (error) {
      if (!tracked.settlementStarted) this.continuations.delete(tracked.requestId);
      throw error;
    }
    if (admission?.state !== 'pending' && admission?.state !== 'settled') {
      throw new RuntimeInteractionInvariantError(
        `Interaction authority returned an invalid admission for permission ${tracked.requestId}`,
      );
    }
    if (admission.state === 'settled') {
      await this.requireSettlement(tracked, 'settled permission admission');
      tracked.admissionState = 'settled';
      return admission;
    }
    if (tracked.settlementStarted) {
      await tracked.settlementPromise;
      throw new RuntimeInteractionInvariantError(
        `Interaction authority admitted settled permission ${tracked.requestId} as pending`,
      );
    }
    tracked.admissionState = 'pending';
    return admission;
  }

  async commitPermissionAnswer(input: {
    requestId: string;
    answer: RuntimePermissionAnswer;
  }): Promise<void> {
    const tracked = this.pendingPermission(input.requestId);
    const outcome = await this.owner.commitPermissionAnswer({
      continuation: tracked.continuation,
      answer: input.answer,
    });
    await this.requireSettlement(tracked, 'permission answer commit');
    this.assertPermissionOutcome(tracked, outcome);
  }

  async commitPermissionTimeout(input: {
    requestId: string;
  }): Promise<HostedPermissionCommitOutcome> {
    const tracked = this.pendingPermission(input.requestId);
    const outcome = await this.owner.commitPermissionTimeout({
      continuation: tracked.continuation,
    });
    await this.requireSettlement(tracked, 'permission timeout commit');
    this.assertPermissionOutcome(tracked, outcome);
    return outcome;
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
      if (!tracked.settlementStarted) this.continuations.delete(tracked.requestId);
      throw error;
    }
    if (tracked.settlementStarted) {
      await tracked.settlementPromise;
      throw new RuntimeInteractionInvariantError(
        `Question ${tracked.requestId} settled during pending-only admission`,
      );
    }
    tracked.admissionState = 'pending';
  }

  assertPendingAdmission(request: AnyPermissionRequestEvent | UserQuestionRequestEvent): void {
    const tracked = this.continuations.get(request.requestId);
    const kind = request.type === 'permission_request' ? 'permission' : 'question';
    // This synchronous guard is the publication linearization point. Close and
    // settlement synchronously mark their state before starting durable work.
    if (
      !tracked ||
      tracked.kind !== kind ||
      tracked.admissionState !== 'pending' ||
      this.closeReason !== undefined ||
      tracked.settlementStarted ||
      tracked.settled ||
      tracked.published ||
      !isDeepStrictEqual(tracked.request, request)
    ) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${request.requestId} has no exact pending admission for Run ${this.runId}`,
      );
    }
    tracked.published = true;
  }

  close(reason: RuntimeInteractionRunClosureReason): Promise<void> {
    if (this.released) {
      throw new RuntimeInteractionInvariantError(
        `Interaction Run ${this.runId} was released before close`,
      );
    }
    if (this.closePromise) return this.closePromise;
    this.closeReason = reason;
    this.closePromise = Promise.resolve()
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

  private trackPermission(
    request: AnyPermissionRequestEvent,
    local: HostedPermissionSettlement,
  ): TrackedPermissionContinuation {
    this.assertNewContinuation(request);
    let tracked!: TrackedPermissionContinuation;
    const continuation: RuntimePermissionContinuation = Object.freeze({
      requestId: request.requestId,
      turnId: this.turnId,
      runId: this.runId,
      applyAnswer: (answer: RuntimePermissionAnswer) =>
        this.settleTracked(
          tracked,
          () => local.applyAnswer(answer),
          { kind: 'permission_answer', answer },
          'permission answer',
        ),
      applyClosure: (reason: RuntimeInteractionClosureReason) =>
        this.settleTracked(
          tracked,
          () => local.applyClosure(reason),
          { kind: 'closure', reason },
          'permission closure',
        ),
    });
    tracked = {
      kind: 'permission',
      requestId: request.requestId,
      request,
      continuation,
      admissionState: undefined,
      published: false,
      settlementStarted: false,
      settled: false,
    };
    this.continuations.set(request.requestId, tracked);
    return tracked;
  }

  private trackQuestion(
    request: UserQuestionRequestEvent,
    local: HostedUserQuestionSettlement,
  ): TrackedQuestionContinuation {
    this.assertNewContinuation(request);
    let tracked!: TrackedQuestionContinuation;
    const continuation: RuntimeUserQuestionContinuation = Object.freeze({
      requestId: request.requestId,
      turnId: this.turnId,
      runId: this.runId,
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
      kind: 'question',
      requestId: request.requestId,
      request,
      continuation,
      admissionState: undefined,
      published: false,
      settlementStarted: false,
      settled: false,
    };
    this.continuations.set(request.requestId, tracked);
    return tracked;
  }

  private assertNewContinuation(
    request: AnyPermissionRequestEvent | UserQuestionRequestEvent,
  ): void {
    if (this.closePromise || this.released) {
      throw new RuntimeInteractionInvariantError(
        `Interaction request ${request.requestId} registered after Run ${this.runId} started closing`,
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
    outcome: RuntimePermissionOutcome | RuntimeUserQuestionOutcome,
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
      });
    tracked.settlementPromise = settlement;
    return settlement;
  }

  private pendingPermission(requestId: string): TrackedPermissionContinuation {
    const tracked = this.continuations.get(requestId);
    if (
      !tracked ||
      tracked.kind !== 'permission' ||
      tracked.admissionState !== 'pending' ||
      tracked.settlementStarted
    ) {
      throw new RuntimeInteractionInvariantError(
        `Permission ${requestId} has no exact pending continuation for Run ${this.runId}`,
      );
    }
    return tracked;
  }

  private async requireSettlement(tracked: TrackedContinuation, operation: string): Promise<void> {
    if (!tracked.settlementPromise) {
      throw new RuntimeInteractionInvariantError(
        `Interaction ${operation} returned before exact local settlement of ${tracked.requestId}`,
      );
    }
    await tracked.settlementPromise;
    if (!tracked.settled) {
      throw new RuntimeInteractionInvariantError(
        `Interaction ${operation} did not settle ${tracked.requestId}`,
      );
    }
  }

  private assertPermissionOutcome(
    tracked: TrackedPermissionContinuation,
    outcome: RuntimePermissionOutcome,
  ): void {
    if (
      !outcome ||
      (outcome.kind !== 'permission_answer' && outcome.kind !== 'closure') ||
      !tracked.outcome ||
      !isDeepStrictEqual(outcome, tracked.outcome)
    ) {
      throw new RuntimeInteractionInvariantError(
        `Interaction authority returned an inconsistent outcome for permission ${tracked.requestId}`,
      );
    }
  }
}

function settlementMatchesAck(
  tracked: TrackedContinuation,
  event: PermissionAnswerAckEvent | PermissionClosureAckEvent | UserQuestionAnswerAckEvent,
): boolean {
  const outcome = tracked.outcome;
  if (!outcome) return false;
  switch (event.type) {
    case 'permission_answer_ack':
      return outcome.kind === 'permission_answer';
    case 'permission_closure_ack':
      return outcome.kind === 'closure' && outcome.reason === event.reason;
    case 'user_question_answer_ack':
      return outcome.kind === 'question_answer';
  }
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
