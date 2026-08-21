import { createHash } from 'node:crypto';
import {
  PlanConflictError,
  planUserControlMutationInput,
  type PlanEvent,
  type PlanMutationResult,
} from '@maka/core/plan';
import type { SessionManager } from '@maka/runtime/session-manager';
import {
  isSessionNotFoundError,
  type ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import {
  authenticateInteractivePlanStoreWriter,
  type InteractivePlanStoreWriter,
} from '@maka/storage/plan-authority';
import {
  PLAN_PAGE_MAX_ITEMS,
  PLAN_RESULT_MAX_BYTES,
  type OperationOutcome,
  type PlanControlInput,
  type PlanControlResult,
  type PlanTurnStartInput,
  type PlanProjectionItem,
  type PlanQueryInput,
  type PlanQueryResult,
  planTurnControlInput,
} from '../protocol/index.js';
import type { ConnectionContext, PlanOperationHandlerMap } from './operation-dispatcher.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate, type SessionAdmissionLease } from './session-admission-gate.js';

type PlanRuntime = Pick<
  SessionManager,
  | 'requestPlanRevision'
  | 'abandonPlanProposal'
  | 'approvePlan'
  | 'resumePlanExecution'
  | 'cancelPlanExecution'
>;

type AdmittedPlanControlRequest =
  | { readonly kind: 'ordinary'; readonly input: PlanControlInput }
  | { readonly kind: 'plan_turn'; readonly input: PlanTurnStartInput };

export interface HostPlanCoordinatorInput {
  readonly store: InteractivePlanStoreWriter;
  readonly sessions: Pick<ExecutionSessionWriter, 'readHeaderSnapshot'>;
  readonly runtime: PlanRuntime;
  readonly sessionAdmission: SessionAdmissionGate;
  readonly isSessionActive: (sessionId: string) => boolean;
  readonly refreshContinuity: (sessionId: string, lease: SessionAdmissionLease) => Promise<void>;
  readonly onProjectionChanged: (sessionId: string) => void;
  readonly requestDrain: () => void;
  readonly root: Pick<RootTurnCoordinator, 'startHostedExternalTransition'>;
}

/** Host-owned Plan query and user-control boundary. */
export class HostPlanCoordinator {
  readonly handlers: PlanOperationHandlerMap = {
    'plan.query': (input) => this.#sessionAdmission.run(input.sessionId, () => this.#query(input)),
    'plan.control': (input) =>
      this.#sessionAdmission.run(input.sessionId, (lease) =>
        this.#control({ kind: 'ordinary', input }, lease),
      ),
    'plan.turn.start': (input, context) => this.#startTurn(input, context),
  };

  readonly #store: InteractivePlanStoreWriter;
  readonly #sessions: HostPlanCoordinatorInput['sessions'];
  readonly #runtime: PlanRuntime;
  readonly #sessionAdmission: SessionAdmissionGate;
  readonly #isSessionActive: (sessionId: string) => boolean;
  readonly #refreshContinuity: HostPlanCoordinatorInput['refreshContinuity'];
  readonly #onProjectionChanged: HostPlanCoordinatorInput['onProjectionChanged'];
  readonly #requestDrain: () => void;
  readonly #root: HostPlanCoordinatorInput['root'];

  constructor(input: HostPlanCoordinatorInput) {
    this.#store = authenticateInteractivePlanStoreWriter(input.store);
    this.#sessions = input.sessions;
    this.#runtime = input.runtime;
    this.#sessionAdmission = input.sessionAdmission;
    this.#isSessionActive = input.isSessionActive;
    this.#refreshContinuity = input.refreshContinuity;
    this.#onProjectionChanged = input.onProjectionChanged;
    this.#requestDrain = input.requestDrain;
    this.#root = input.root;
  }

  async #startTurn(
    input: PlanTurnStartInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'plan.turn.start'>> {
    let plan: PlanControlResult | undefined;
    let planFailure: Extract<OperationOutcome<'plan.control'>, { ok: false }> | undefined;
    const turn = await this.#root.startHostedExternalTransition(
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        inputDigest: planTurnInputDigest(input),
        archivedMessage: 'Cannot start Plan execution in an archived Session',
        prepareContent: async (lease) => {
          const outcome = await this.#control({ kind: 'plan_turn', input }, lease);
          if (!outcome.ok) {
            planFailure = outcome;
            return {
              kind: 'rejected',
              outcome: {
                ok: false,
                error: { code: 'operation_conflict', message: outcome.error.message },
              },
            };
          }
          plan = outcome.result;
          return { kind: 'ready', content: { text: planTurnPrompt(input, outcome.result) } };
        },
      },
      context,
    );
    if (planFailure) return { ok: false, error: planFailure.error };
    if (!turn.ok) return { ok: false, error: turn.error };
    if (!plan) {
      this.#requestDrain();
      return {
        ok: false,
        error: { code: 'internal_failure', message: 'Plan Turn transition outcome is unknown' },
      };
    }
    return { ok: true, result: { plan, turn: turn.result } };
  }

  async #query(input: PlanQueryInput): Promise<OperationOutcome<'plan.query'>> {
    const unavailable = await this.#assertSessionAvailable(input.sessionId);
    if (unavailable) return failure(unavailable.code, unavailable.message);
    try {
      const state = await this.#store.readState(input.sessionId);
      if (input.kind === 'list_continue' && input.storeVersion !== state.storeVersion) {
        return success({
          kind: 'revision_changed',
          expected: input.storeVersion,
          actual: state.storeVersion,
        });
      }
      let offset = 0;
      if (input.kind === 'list_continue') {
        try {
          offset = decodeCursor(input.cursor);
        } catch {
          return failure('invalid_request', 'Plan cursor is invalid');
        }
      }
      const items: PlanProjectionItem[] = [
        ...state.proposals.map((proposal) => ({ kind: 'proposal' as const, proposal })),
        ...state.executions.map((execution) => ({ kind: 'execution' as const, execution })),
      ];
      if (offset > items.length) {
        return failure('invalid_request', 'Plan cursor is outside the current projection');
      }
      return success(
        fitPage(
          {
            sessionId: input.sessionId,
            storeVersion: state.storeVersion,
            latestProposalId: state.latestProposalId ?? null,
            activeExecutionId: state.activeExecutionId ?? null,
          },
          items,
          offset,
        ),
      );
    } catch (error) {
      if (isSessionNotFoundError(error)) return failure('not_found', 'Session does not exist');
      return failure('internal_failure', 'Plan projection is unavailable');
    }
  }

  async #control(
    request: AdmittedPlanControlRequest,
    lease: SessionAdmissionLease,
  ): Promise<OperationOutcome<'plan.control'>> {
    const input = request.kind === 'ordinary' ? request.input : planTurnControlInput(request.input);
    let replay = false;
    try {
      replay =
        (await this.#store.readOperationReceipt(
          input.sessionId,
          input.operationId,
          planUserControlMutationInput(input),
        )) !== undefined;
    } catch (error) {
      return this.#controlFailure(error);
    }
    if (!replay) {
      const unavailable = await this.#assertSessionAvailable(input.sessionId);
      if (unavailable) return controlAvailabilityFailure(unavailable.code, unavailable.message);
      if (request.kind === 'ordinary' && this.#isSessionActive(input.sessionId)) {
        return controlFailure('session_busy', 'Session has an active root Turn');
      }
    }
    try {
      const result = await this.#applyControl(input);
      this.#onProjectionChanged(input.sessionId);
      await this.#refreshContinuity(input.sessionId, lease);
      return { ok: true, result: projectControlResult(result) };
    } catch (error) {
      return this.#controlFailure(error);
    }
  }

  #controlFailure(error: unknown): OperationOutcome<'plan.control'> {
    if (isSessionNotFoundError(error)) {
      return controlFailure('not_found', 'Session does not exist');
    }
    if (error instanceof PlanConflictError) {
      return controlFailure('operation_conflict', error.message);
    }
    this.#requestDrain();
    return controlFailure('persistence_failed', 'Plan control outcome is unknown');
  }

  #applyControl(input: PlanControlInput): Promise<PlanMutationResult> {
    switch (input.kind) {
      case 'request_revision':
        return this.#runtime.requestPlanRevision(
          input.sessionId,
          input.proposalId,
          input.operationId,
        );
      case 'abandon_proposal':
        return this.#runtime.abandonPlanProposal(
          input.sessionId,
          input.proposalId,
          input.operationId,
        );
      case 'approve_proposal':
        return this.#runtime.approvePlan({
          sessionId: input.sessionId,
          proposalId: input.proposalId,
          expectedRevision: input.expectedRevision,
          expectedStoreVersion: input.expectedStoreVersion,
          operationId: input.operationId,
        });
      case 'resume_execution':
        return this.#runtime.resumePlanExecution(
          input.sessionId,
          input.executionId,
          input.operationId,
        );
      case 'cancel_execution':
        return this.#runtime.cancelPlanExecution(
          input.sessionId,
          input.executionId,
          input.operationId,
        );
    }
  }

  async #assertSessionAvailable(sessionId: string): Promise<
    | {
        code: 'not_found' | 'session_archived' | 'internal_failure';
        message: string;
      }
    | undefined
  > {
    try {
      const header = await this.#sessions.readHeaderSnapshot(sessionId);
      if (header.isArchived) {
        return { code: 'session_archived', message: 'Session is archived' };
      }
      return undefined;
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        return { code: 'not_found', message: 'Session does not exist' };
      }
      return { code: 'internal_failure', message: 'Session authority is unavailable' };
    }
  }
}

function fitPage(
  header: {
    readonly sessionId: string;
    readonly storeVersion: number;
    readonly latestProposalId: string | null;
    readonly activeExecutionId: string | null;
  },
  allItems: readonly PlanProjectionItem[],
  offset: number,
): Extract<PlanQueryResult, { kind: 'page' }> {
  const items: PlanProjectionItem[] = [];
  const limit = Math.min(allItems.length, offset + PLAN_PAGE_MAX_ITEMS);
  for (let index = offset; index < limit; index += 1) {
    const candidate = [...items, structuredClone(allItems[index]!)];
    const nextOffset = offset + candidate.length;
    const page = planPage(header, candidate, nextOffset, allItems.length);
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > PLAN_RESULT_MAX_BYTES) {
      if (items.length === 0) throw new Error('Persisted Plan item exceeds its wire invariant');
      break;
    }
    items.push(candidate.at(-1)!);
  }
  return planPage(header, items, offset + items.length, allItems.length);
}

function planPage(
  header: Parameters<typeof fitPage>[0],
  items: readonly PlanProjectionItem[],
  nextOffset: number,
  total: number,
): Extract<PlanQueryResult, { kind: 'page' }> {
  return {
    kind: 'page',
    ...header,
    items,
    nextCursor: nextOffset < total ? String(nextOffset) : null,
  };
}

function decodeCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) throw new PlanConflictError('Invalid Plan cursor');
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new PlanConflictError('Invalid Plan cursor');
  return offset;
}

function projectControlResult(result: PlanMutationResult): PlanControlResult {
  return projectControlEvent(result.event);
}

function projectControlEvent(event: PlanEvent): PlanControlResult {
  return {
    sessionId: event.sessionId,
    storeVersion: event.storeVersion,
    eventType: event.type,
    proposalId: proposalId(event),
    executionId: executionId(event),
  };
}

function proposalId(event: PlanEvent): string | null {
  if (event.type === 'plan_submitted') return event.proposal.proposalId;
  return 'proposalId' in event ? event.proposalId : null;
}

function executionId(event: PlanEvent): string | null {
  if (event.type === 'plan_approved') return event.execution.executionId;
  return 'executionId' in event ? event.executionId : null;
}

function success(result: PlanQueryResult): OperationOutcome<'plan.query'> {
  return { ok: true, result };
}

function failure(
  code: 'not_found' | 'session_archived' | 'invalid_request' | 'internal_failure',
  message: string,
): OperationOutcome<'plan.query'> {
  return { ok: false, error: { code, message } };
}

function controlFailure(
  code: 'not_found' | 'session_busy' | 'operation_conflict' | 'persistence_failed',
  message: string,
): OperationOutcome<'plan.control'> {
  return { ok: false, error: { code, message } };
}

function controlAvailabilityFailure(
  code: 'not_found' | 'session_archived' | 'internal_failure',
  message: string,
): OperationOutcome<'plan.control'> {
  return { ok: false, error: { code, message } };
}

function planTurnInputDigest(input: PlanTurnStartInput): `sha256:${string}` {
  const canonical =
    input.kind === 'approve_proposal'
      ? [
          input.kind,
          input.sessionId,
          input.proposalId,
          input.expectedRevision,
          input.expectedStoreVersion,
        ]
      : [input.kind, input.sessionId, input.executionId];
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

function planTurnPrompt(input: PlanTurnStartInput, result: PlanControlResult): string {
  if (input.kind === 'approve_proposal') {
    if (result.executionId === null) {
      throw new PlanConflictError('Plan approval did not create an execution');
    }
    return `Execute the approved plan execution ${result.executionId}.`;
  }
  return `Resume the approved plan execution ${input.executionId}.`;
}
