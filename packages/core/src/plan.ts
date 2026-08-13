export const PLAN_PROPOSAL_STATUSES = ['pending_approval', 'stale', 'approved'] as const;
export type PlanProposalStatus = (typeof PLAN_PROPOSAL_STATUSES)[number];

export const PLAN_EXECUTION_STATUSES = ['active', 'completed', 'cancelled', 'interrupted'] as const;
export type PlanExecutionStatus = (typeof PLAN_EXECUTION_STATUSES)[number];

export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export const PLAN_ENTITY_ID_MAX_CHARS = 128;
export const PLAN_TEXT_MAX_BYTES = 16 * 1024;
export const PLAN_LIFECYCLE_REASON_MAX_BYTES = 1024;
export const PLAN_PROJECTION_ITEM_MAX_BYTES = 60 * 1024;
export const PLAN_MAX_STEPS = 50;
export const PLAN_MAX_FILES_PER_STEP = 50;
export const PLAN_MAX_RISKS = 20;
export const PLAN_STEP_TITLE_MAX_CHARS = 30;

const PLAN_ENTITY_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${PLAN_ENTITY_ID_MAX_CHARS}}$`);
const PLAN_TEXT_ENCODER = new TextEncoder();

export function isCanonicalPlanEntityId(value: string): boolean {
  return PLAN_ENTITY_ID_PATTERN.test(value);
}

export function planEncodedByteLength(value: unknown): number {
  return PLAN_TEXT_ENCODER.encode(JSON.stringify(value) ?? 'null').byteLength;
}

export function isPlanTextWithinLimit(value: string, maxBytes = PLAN_TEXT_MAX_BYTES): boolean {
  return PLAN_TEXT_ENCODER.encode(value).byteLength <= maxBytes;
}

export interface PlanStepDefinition {
  id: string;
  title: string;
  description: string;
  files?: string[];
  complexity?: 'low' | 'medium' | 'high';
}

export interface PlanProposal {
  planId: string;
  proposalId: string;
  sessionId: string;
  turnId: string;
  revision: number;
  supersedesProposalId?: string;
  /** Interrupted execution whose remaining work this proposal replans. */
  sourceExecutionId?: string;
  title: string;
  overview?: string;
  steps: PlanStepDefinition[];
  risks?: string[];
  status: PlanProposalStatus;
  submittedAt: number;
}

export interface PlanExecutionStep extends PlanStepDefinition {
  status: PlanStepStatus;
  note?: string;
  updatedAt: number;
}

export interface PlanExecution {
  executionId: string;
  planId: string;
  proposalId: string;
  sessionId: string;
  status: PlanExecutionStatus;
  steps: PlanExecutionStep[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  cancelledAt?: number;
  interruptedAt?: number;
  cancelReason?: string;
  interruptionReason?: string;
}

export interface PlanSessionState {
  schemaVersion: 1;
  sessionId: string;
  storeVersion: number;
  proposals: PlanProposal[];
  executions: PlanExecution[];
  latestProposalId?: string;
  activeExecutionId?: string;
}

interface PlanEventBase {
  id: string;
  /** Fingerprint of the mutation input used to reconcile an exact retry. */
  operationFingerprint?: string;
  sessionId: string;
  ts: number;
  storeVersion: number;
}

export type PlanEvent =
  | (PlanEventBase & {
      type: 'plan_submitted';
      proposal: PlanProposal;
    })
  | (PlanEventBase & {
      type: 'plan_revision_requested';
      proposalId: string;
    })
  | (PlanEventBase & {
      type: 'plan_abandoned';
      proposalId: string;
      reason: string;
    })
  | (PlanEventBase & {
      type: 'plan_approved';
      proposalId: string;
      execution: PlanExecution;
    })
  | (PlanEventBase & {
      type: 'plan_progress_updated';
      executionId: string;
      steps: PlanExecutionStep[];
      explanation?: string;
    })
  | (PlanEventBase & {
      type: 'plan_execution_completed';
      executionId: string;
      steps: PlanExecutionStep[];
    })
  | (PlanEventBase & {
      type: 'plan_execution_cancelled';
      executionId: string;
      reason: string;
    })
  | (PlanEventBase & {
      type: 'plan_execution_interrupted';
      executionId: string;
      reason: string;
    })
  | (PlanEventBase & {
      type: 'plan_execution_resumed';
      executionId: string;
    });

export interface SubmitPlanProposalInput {
  operationId?: string;
  sessionId: string;
  turnId: string;
  title: string;
  overview?: string;
  steps: PlanStepDefinition[];
  risks?: string[];
  sourceExecutionId?: string;
}

export function isPlanProposalLifecycleAdmissible(
  input: Pick<SubmitPlanProposalInput, 'title' | 'overview' | 'steps' | 'risks'>,
): boolean {
  const id = 'x'.repeat(PLAN_ENTITY_ID_MAX_CHARS);
  const timestamp = Number.MAX_SAFE_INTEGER;
  const proposal: PlanProposal = {
    planId: id,
    proposalId: id,
    sessionId: id,
    turnId: id,
    revision: Number.MAX_SAFE_INTEGER,
    supersedesProposalId: id,
    sourceExecutionId: id,
    title: input.title,
    ...(input.overview ? { overview: input.overview } : {}),
    steps: structuredClone(input.steps),
    ...(input.risks ? { risks: structuredClone(input.risks) } : {}),
    status: 'pending_approval',
    submittedAt: timestamp,
  };
  const execution = worstCasePlanExecution(proposal, id, timestamp);
  return (
    planEncodedByteLength({ kind: 'proposal', proposal }) <= PLAN_PROJECTION_ITEM_MAX_BYTES &&
    planEncodedByteLength({ kind: 'execution', execution }) <= PLAN_PROJECTION_ITEM_MAX_BYTES
  );
}

export function worstCasePlanExecution(
  proposal: Pick<PlanProposal, 'planId' | 'proposalId' | 'sessionId' | 'steps'>,
  executionId: string,
  timestamp = Number.MAX_SAFE_INTEGER,
): PlanExecution {
  const reason = 'x'.repeat(PLAN_LIFECYCLE_REASON_MAX_BYTES);
  return {
    executionId,
    planId: proposal.planId,
    proposalId: proposal.proposalId,
    sessionId: proposal.sessionId,
    status: 'cancelled',
    steps: proposal.steps.map((step) => ({
      ...structuredClone(step),
      status: 'pending',
      updatedAt: timestamp,
    })),
    startedAt: timestamp,
    updatedAt: timestamp,
    interruptedAt: timestamp,
    interruptionReason: reason,
    cancelledAt: timestamp,
    cancelReason: reason,
  };
}

export interface ApprovePlanProposalInput {
  operationId?: string;
  sessionId: string;
  proposalId: string;
  expectedRevision: number;
  expectedStoreVersion?: number;
}

export interface RequestPlanRevisionInput {
  operationId?: string;
  sessionId: string;
  proposalId: string;
}

export interface AbandonPlanProposalInput {
  operationId?: string;
  sessionId: string;
  proposalId: string;
  reason: string;
}

export interface UpdatePlanExecutionInput {
  operationId?: string;
  sessionId: string;
  executionId: string;
  steps: Array<{
    id: string;
    status: PlanStepStatus;
    note?: string;
  }>;
  explanation?: string;
}

export interface CancelPlanExecutionInput {
  operationId?: string;
  sessionId: string;
  executionId: string;
  reason: string;
}

export interface PlanMutationResult {
  event: PlanEvent;
  state: PlanSessionState;
}

export const PLAN_USER_ABANDON_REASON = 'User exited Plan Mode before approval.';
export const PLAN_USER_CANCEL_REASON = 'User abandoned the interrupted plan.';

export type PlanUserControlInput =
  | {
      readonly kind: 'request_revision' | 'abandon_proposal';
      readonly sessionId: string;
      readonly proposalId: string;
      readonly operationId: string;
    }
  | {
      readonly kind: 'approve_proposal';
      readonly sessionId: string;
      readonly proposalId: string;
      readonly expectedRevision: number;
      readonly expectedStoreVersion: number;
      readonly operationId: string;
    }
  | {
      readonly kind: 'resume_execution' | 'cancel_execution';
      readonly sessionId: string;
      readonly executionId: string;
      readonly operationId: string;
    };

export function planUserControlMutationInput(
  input: PlanUserControlInput,
):
  | RequestPlanRevisionInput
  | AbandonPlanProposalInput
  | ApprovePlanProposalInput
  | CancelPlanExecutionInput
  | { operationId: string; sessionId: string; executionId: string } {
  switch (input.kind) {
    case 'request_revision':
      return {
        operationId: input.operationId,
        sessionId: input.sessionId,
        proposalId: input.proposalId,
      };
    case 'abandon_proposal':
      return {
        operationId: input.operationId,
        sessionId: input.sessionId,
        proposalId: input.proposalId,
        reason: PLAN_USER_ABANDON_REASON,
      };
    case 'approve_proposal':
      return {
        operationId: input.operationId,
        sessionId: input.sessionId,
        proposalId: input.proposalId,
        expectedRevision: input.expectedRevision,
        expectedStoreVersion: input.expectedStoreVersion,
      };
    case 'resume_execution':
      return {
        operationId: input.operationId,
        sessionId: input.sessionId,
        executionId: input.executionId,
      };
    case 'cancel_execution':
      return {
        operationId: input.operationId,
        sessionId: input.sessionId,
        executionId: input.executionId,
        reason: PLAN_USER_CANCEL_REASON,
      };
  }
}

export interface PlanStore {
  readState(sessionId: string): Promise<PlanSessionState>;
  readOperationReceipt(
    sessionId: string,
    operationId: string,
    operationInput: unknown,
  ): Promise<PlanEvent | undefined>;
  submitProposal(input: SubmitPlanProposalInput): Promise<PlanMutationResult>;
  requestRevision(input: RequestPlanRevisionInput): Promise<PlanMutationResult>;
  abandonProposal(input: AbandonPlanProposalInput): Promise<PlanMutationResult>;
  approveProposal(input: ApprovePlanProposalInput): Promise<PlanMutationResult>;
  updateExecution(input: UpdatePlanExecutionInput): Promise<PlanMutationResult>;
  cancelExecution(input: CancelPlanExecutionInput): Promise<PlanMutationResult>;
  interruptActiveExecution(
    sessionId: string,
    reason: string,
    operationId?: string,
  ): Promise<PlanMutationResult | null>;
  resumeExecution(
    sessionId: string,
    executionId: string,
    operationId?: string,
  ): Promise<PlanMutationResult>;
}

export class PlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanConflictError';
  }
}

export function emptyPlanSessionState(sessionId: string): PlanSessionState {
  return {
    schemaVersion: 1,
    sessionId,
    storeVersion: 0,
    proposals: [],
    executions: [],
  };
}

export function activePlanExecution(state: PlanSessionState): PlanExecution | undefined {
  if (!state.activeExecutionId) return undefined;
  return state.executions.find((execution) => execution.executionId === state.activeExecutionId);
}

export function latestPlanProposal(state: PlanSessionState): PlanProposal | undefined {
  if (!state.latestProposalId) return undefined;
  return state.proposals.find((proposal) => proposal.proposalId === state.latestProposalId);
}
