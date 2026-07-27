import {
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  runtimeEventHasModelVisibleContent,
  type RuntimeEvent,
  type RuntimeEventFunctionCallContent,
  type RuntimeEventFunctionResponseContent,
} from '@maka/core/runtime-event';
import type {
  ImmutableRuntimePrefixV1,
  RuntimeBoundaryCursorV1,
  RuntimeBoundaryDigest,
} from '@maka/core/runtime-boundary';
import { createRuntimeBoundaryCursor, runtimePrefixSegment } from '@maka/core/runtime-boundary';
import {
  buildContinuationReplayPlan,
  type ContinuationReplayPlanV1,
} from './continuation-replay.js';
import { PROVIDER_REPLAY_PROJECTION_VERSION } from './model-history.js';
import { resolveRuntimeRecovery, type RuntimeRecoveryResolution } from './recovery-resolver.js';

export type ToolOperationStatus =
  | 'succeeded'
  | 'failed'
  | 'indeterminate'
  | 'not_dispatched'
  | 'parked'
  | 'corruption';

export interface ToolOperation {
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: ToolOperationStatus;
  callRuntimeEventId: string;
  responseRuntimeEventId?: string;
  responseIsError?: boolean;
}

export type ResumePlanDisposition = 'safe_replay' | 'blocked';

export type RuntimeContinuationRevalidationCode =
  | 'continuation_claim_conflict'
  | 'target_run_conflict'
  | 'source_identity_changed'
  | 'source_terminal_changed'
  | 'source_cwd_changed'
  | 'source_high_water_changed'
  | 'source_ledger_identity_changed'
  | 'source_replay_changed'
  | 'workspace_identity_changed'
  | 'background_operation_started'
  | 'tool_catalog_changed'
  | 'workspace_checkpoint_changed';

export class RuntimeContinuationRevalidationError extends Error {
  readonly code: RuntimeContinuationRevalidationCode;

  constructor(code: RuntimeContinuationRevalidationCode, message: string) {
    super(message);
    this.name = 'RuntimeContinuationRevalidationError';
    this.code = code;
  }
}

export type ResumePlanDiagnosticCode =
  | 'pending_tool_result'
  | 'unmatched_tool_result'
  | 'tool_name_mismatch'
  | 'runtime_offset_mismatch'
  | 'pending_permission'
  | 'workspace_identity_mismatch'
  | 'background_operation_pending'
  | 'tool_catalog_mismatch'
  | 'runtime_ledger_unreadable'
  | 'terminal_repair_failed'
  | 'workspace_cwd_mismatch'
  | 'workspace_location_changed'
  | 'runtime_ledger_empty'
  | 'runtime_identity_mismatch'
  | 'continuation_identity_reused'
  | 'provider_resume_head_unsupported'
  | 'provider_resume_boundary_unsupported'
  | 'provider_replay_non_suffix_gap'
  | 'provider_replay_unsupported'
  | 'runtime_lineage_cycle'
  | 'runtime_lineage_depth_exceeded'
  | 'runtime_lineage_missing'
  | 'runtime_lineage_start_mismatch'
  | 'source_prefix_digest_mismatch'
  | 'workspace_ref_missing'
  | 'checkpoint_restore_failed'
  | 'source_run_unreadable'
  | 'continuation_already_exists'
  | 'continuation_authority_unavailable'
  | 'continuation_claim_repair_required'
  | 'continuation_started_indeterminate'
  | 'workspace_identity_missing'
  | 'safety_observation_unavailable'
  | 'resume_feature_disabled'
  | 'resume_candidate_missing'
  | 'tool_not_dispatched'
  | 'tool_recovery_parked'
  | 'tool_recovery_corruption'
  | 'tool_ledger_corruption'
  | 'duplicate_event_id'
  | 'semantic_lane_conflict'
  | 'protocol_marker_invalid';

export type ResumeRejectionReason =
  | 'runtime_offset_mismatch'
  | 'dangling_tool_state'
  | 'pending_permission'
  | 'workspace_identity_mismatch'
  | 'background_operation_pending'
  | 'tool_catalog_mismatch'
  | 'runtime_ledger_unreadable'
  | 'terminal_repair_failed'
  | 'workspace_cwd_mismatch'
  | 'runtime_ledger_empty'
  | 'runtime_identity_mismatch'
  | 'continuation_identity_reused'
  | 'provider_resume_head_unsupported'
  | 'provider_resume_boundary_unsupported'
  | 'provider_replay_non_suffix_gap'
  | 'provider_replay_unsupported'
  | 'runtime_lineage_cycle'
  | 'runtime_lineage_depth_exceeded'
  | 'runtime_lineage_missing'
  | 'runtime_lineage_start_mismatch'
  | 'source_prefix_digest_mismatch'
  | 'workspace_ref_missing'
  | 'checkpoint_restore_failed'
  | 'source_run_unreadable'
  | 'continuation_already_exists'
  | 'continuation_authority_unavailable'
  | 'continuation_claim_repair_required'
  | 'continuation_started_indeterminate'
  | 'workspace_identity_missing'
  | 'safety_observation_unavailable'
  | 'resume_feature_disabled'
  | 'resume_candidate_missing';

export interface ResumePlanDiagnostic {
  code: ResumePlanDiagnosticCode;
  message: string;
  eventId?: string;
  toolCallId?: string;
  toolName?: string;
  detail?: Record<string, unknown>;
}

export interface ResumePlan {
  disposition: ResumePlanDisposition;
  operations: ToolOperation[];
  diagnostics: ResumePlanDiagnostic[];
  rejectionReasons: ResumeRejectionReason[];
  requiresVerification: boolean;
  sourceRuntimeEventHighWater: number;
  directive?: string;
  runtimeEvents: RuntimeEvent[];
  replayRuntimeEvents: RuntimeEvent[];
}

export interface BuildResumePlanOptions {
  expectedRuntimeEventHighWater?: number;
}

export type RuntimeResumeFailpointId =
  | 'P0'
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'P5'
  | 'P6'
  | 'P7'
  | 'P8'
  | 'P9'
  | 'P10'
  | 'P11';

export type RuntimeResumeCommittedPrefix =
  | 'before_function_call'
  | 'after_function_call'
  | 'after_function_response'
  | 'after_terminal_event';

export interface RuntimeResumeFailpointSpec {
  id: RuntimeResumeFailpointId;
  boundary: string;
  /** Last fully committed RuntimeEvent prefix that Phase 0 may inspect. */
  committedPrefix: RuntimeResumeCommittedPrefix;
}

/**
 * Stable crash-injection catalog owned by the Phase 0 process harness.
 * Later phases may map these labels to richer boundaries, but this catalog
 * only reasons about the last fully committed RuntimeEvent prefix.
 */
export const RUNTIME_RESUME_FAILPOINTS = [
  { id: 'P0', boundary: 'before tool preparation (T1)', committedPrefix: 'before_function_call' },
  {
    id: 'P1',
    boundary: 'function_call committed before prepared journal',
    committedPrefix: 'after_function_call',
  },
  {
    id: 'P2',
    boundary: 'prepared journal committed before implementation',
    committedPrefix: 'after_function_call',
  },
  { id: 'P3', boundary: 'tool implementation in progress', committedPrefix: 'after_function_call' },
  {
    id: 'P4',
    boundary: 'side effect completed before outcome transaction (T2)',
    committedPrefix: 'after_function_call',
  },
  {
    id: 'P5',
    boundary: 'function_response committed before outcome journal',
    committedPrefix: 'after_function_response',
  },
  {
    id: 'P6',
    boundary: 'outcome transaction committed before model result delivery',
    committedPrefix: 'after_function_response',
  },
  {
    id: 'P7',
    boundary: 'tool result delivered before the next provider step',
    committedPrefix: 'after_function_response',
  },
  {
    id: 'P8',
    boundary: 'terminal RuntimeEvent commit',
    committedPrefix: 'after_function_response',
  },
  { id: 'P9', boundary: 'terminal run header commit', committedPrefix: 'after_terminal_event' },
  { id: 'P10', boundary: 'recovery decision commit', committedPrefix: 'after_terminal_event' },
  { id: 'P11', boundary: 'continuation run creation', committedPrefix: 'after_terminal_event' },
] as const satisfies readonly RuntimeResumeFailpointSpec[];

export interface ContinuationIdentity {
  invocationId: string;
  runId: string;
  turnId: string;
}

export interface SafeBoundaryContinuationFacts {
  ledgerReadable: boolean;
  terminalRepairSucceeded: boolean;
  sourceCwd: string;
  currentCwd: string;
  sourceWorkspaceIdentity: string;
  currentWorkspaceIdentity: string;
  backgroundOperationsSettled: boolean;
  availableToolNames: readonly string[];
  continuationIdentity: ContinuationIdentity;
  continuationClaimId?: string;
  /** User-anchored replay prefix inherited from continuation ancestors. */
  priorRuntimeContext?: readonly RuntimeEvent[];
  /** Versioned, segment-scoped provider replay built from immutable prefixes. */
  continuationReplayPlan?: ContinuationReplayPlanV1;
  expectedRuntimeEventHighWater?: number;
  workspaceCheckpoint?: {
    ref?: string;
    restored: boolean;
    runtimeEventHighWater: number;
  };
}

export interface RuntimeContinuation {
  sessionId: string;
  invocationId: string;
  runId: string;
  turnId: string;
  sourceInvocationId: string;
  sourceRunId: string;
  sourceTurnId: string;
  sourceRuntimeEventHighWater: number;
  /** Proposed durable claim id; only execution may acquire it. */
  claimId?: string;
  /** Replay events owned by the immediate source run. */
  sourceRuntimeContext?: RuntimeEvent[];
  /** Full user-anchored provider history, including continuation ancestors. */
  runtimeContext: RuntimeEvent[];
  /** Composite immutable ledger boundary used to build runtimeContext. */
  boundary?: RuntimeBoundaryCursorV1;
  /** Identity of the exact provider-facing replay projection. */
  providerReplayDigest?: RuntimeBoundaryDigest;
  providerProjectionVersion?: typeof PROVIDER_REPLAY_PROJECTION_VERSION;
  safetySnapshot: RuntimeContinuationSafetySnapshot;
}

export interface RuntimeContinuationSafetySnapshot {
  workspaceIdentity: string;
  backgroundOperationsSettled: true;
  availableToolNames: string[];
  workspaceCheckpoint?: {
    ref: string;
    runtimeEventHighWater: number;
  };
}

export interface RuntimeContinuationSafetyObservation {
  workspaceIdentity: string;
  /** Current location is diagnostic only and never participates in identity. */
  workspacePath?: string;
  backgroundOperationsSettled: boolean;
  availableToolNames: readonly string[];
  workspaceCheckpoint?: {
    ref?: string;
    restored: boolean;
    runtimeEventHighWater: number;
  };
}

export interface SafeBoundaryContinuationPlan {
  disposition: 'continue' | 'park';
  rejectionReasons: ResumeRejectionReason[];
  diagnostics: ResumePlanDiagnostic[];
  continuation?: RuntimeContinuation;
}

export interface RuntimeContinuationPlannerInput {
  sessionId: string;
  sourceRunId: string;
  currentCwd: string;
  sourceWorkspaceIdentity: string;
  currentWorkspaceIdentity: string;
  backgroundOperationsSettled: boolean;
  availableToolNames: readonly string[];
  expectedRuntimeEventHighWater?: number;
  workspaceCheckpoint?: SafeBoundaryContinuationFacts['workspaceCheckpoint'];
}

export interface RuntimeContinuationPlannerDeps {
  readSourceRun(
    sessionId: string,
    runId: string,
  ): Promise<{
    cwd: string;
    status: string;
    continuationSource?: {
      protocol?: 'continuation_source_v2';
      claimId?: string;
      boundaryDigest?: RuntimeBoundaryDigest;
      sourceInvocationId: string;
      sourceRunId: string;
      sourceTurnId: string;
      sourceRuntimeEventHighWater: number;
      sourcePrefixDigest?: RuntimeBoundaryDigest;
      replayManifestDigest?: RuntimeBoundaryDigest;
    };
  }>;
  readImmutableRuntimePrefix(input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }): Promise<ImmutableRuntimePrefixV1>;
  readContinuationClaimByBoundary?(boundaryDigest: RuntimeBoundaryDigest): Promise<
    | {
        claimId: string;
        target: { sessionId: string; invocationId: string; runId: string; turnId: string };
      }
    | undefined
  >;
  findExistingContinuation?(
    sessionId: string,
    sourceRunId: string,
    sourceRuntimeEventHighWater: number,
  ): Promise<{ runId: string } | undefined>;
  newId(): string;
}

export class RuntimeContinuationPlanner {
  constructor(private readonly deps: RuntimeContinuationPlannerDeps) {}

  async plan(input: RuntimeContinuationPlannerInput): Promise<SafeBoundaryContinuationPlan> {
    let sourceRun: Awaited<ReturnType<RuntimeContinuationPlannerDeps['readSourceRun']>>;
    try {
      sourceRun = await this.deps.readSourceRun(input.sessionId, input.sourceRunId);
    } catch {
      return parkedPlan('source_run_unreadable', 'source AgentRun could not be read');
    }

    let prefixes: [ImmutableRuntimePrefixV1, ...ImmutableRuntimePrefixV1[]];
    try {
      prefixes = await this.readLineagePrefixes(input.sessionId, input.sourceRunId, sourceRun);
    } catch (error) {
      if (error instanceof RuntimeLineageError) {
        return parkedPlan(error.code, error.message);
      }
      return parkedPlan(
        'runtime_ledger_unreadable',
        'RuntimeEvent ledger could not be read reliably',
      );
    }
    const sourcePrefix = prefixes.at(-1)!;
    const events = [...sourcePrefix.events];
    if (
      sourcePrefix.identity.sessionId !== input.sessionId ||
      sourcePrefix.identity.runId !== input.sourceRunId
    ) {
      return parkedPlan(
        'runtime_identity_mismatch',
        'RuntimeEvent ledger does not belong to the requested source run',
      );
    }
    const replay = buildContinuationReplayPlan({
      prefixes,
      providerProjectionVersion: PROVIDER_REPLAY_PROJECTION_VERSION,
    });
    if (replay.kind === 'blocked') {
      const reason =
        replay.reason === 'provider_replay_non_suffix_gap'
          ? 'provider_replay_non_suffix_gap'
          : replay.reason === 'provider_replay_unsupported'
            ? 'provider_replay_unsupported'
            : 'runtime_ledger_unreadable';
      return parkedPlan(
        reason,
        `continuation replay segment ${replay.segmentIndex} is not replayable: ${replay.reason}`,
      );
    }
    let durableClaim:
      | {
          claimId: string;
          target: {
            sessionId: string;
            invocationId: string;
            runId: string;
            turnId: string;
          };
        }
      | undefined;
    try {
      durableClaim = await this.deps.readContinuationClaimByBoundary?.(
        replay.plan.boundary.manifestDigest,
      );
    } catch {
      return parkedPlan(
        'continuation_authority_unavailable',
        'durable continuation authority is unavailable',
      );
    }
    if (durableClaim) {
      return this.classifyExistingClaim(input.sessionId, durableClaim);
    }
    const existingContinuation = await this.deps.findExistingContinuation?.(
      input.sessionId,
      input.sourceRunId,
      sourcePrefix.position.lastEventSeq,
    );
    if (existingContinuation) {
      return parkedPlan(
        'continuation_already_exists',
        'source run already has a continuation child',
        { continuationRunId: existingContinuation.runId },
      );
    }

    return buildSafeBoundaryContinuationPlan(events, {
      ledgerReadable: true,
      terminalRepairSucceeded: hasConsistentTerminalBoundary(sourceRun.status, events),
      sourceCwd: sourceRun.cwd,
      currentCwd: input.currentCwd,
      sourceWorkspaceIdentity: input.sourceWorkspaceIdentity,
      currentWorkspaceIdentity: input.currentWorkspaceIdentity,
      backgroundOperationsSettled: input.backgroundOperationsSettled,
      availableToolNames: input.availableToolNames,
      continuationIdentity: {
        invocationId: this.deps.newId(),
        runId: this.deps.newId(),
        turnId: this.deps.newId(),
      },
      continuationClaimId: this.deps.newId(),
      continuationReplayPlan: replay.plan,
      ...(input.expectedRuntimeEventHighWater !== undefined
        ? { expectedRuntimeEventHighWater: input.expectedRuntimeEventHighWater }
        : {}),
      ...(input.workspaceCheckpoint !== undefined
        ? { workspaceCheckpoint: input.workspaceCheckpoint }
        : {}),
    });
  }

  private async classifyExistingClaim(
    sessionId: string,
    claim: {
      claimId: string;
      target: {
        sessionId: string;
        invocationId: string;
        runId: string;
        turnId: string;
      };
    },
  ): Promise<SafeBoundaryContinuationPlan> {
    const detail = {
      continuationClaimId: claim.claimId,
      continuationRunId: claim.target.runId,
    };
    let run: Awaited<ReturnType<RuntimeContinuationPlannerDeps['readSourceRun']>>;
    try {
      run = await this.deps.readSourceRun(sessionId, claim.target.runId);
    } catch {
      return parkedPlan(
        'continuation_claim_repair_required',
        'durable continuation claim exists but its target Run is missing',
        detail,
      );
    }
    if (isTerminalRunStatus(run.status)) {
      return parkedPlan(
        'continuation_already_exists',
        'source boundary already has a terminal continuation',
        detail,
      );
    }
    let prefix: ImmutableRuntimePrefixV1;
    try {
      prefix = await this.deps.readImmutableRuntimePrefix({
        sessionId,
        runId: claim.target.runId,
      });
    } catch {
      return parkedPlan(
        'continuation_claim_repair_required',
        'durable continuation claim target has no committed continuation-start',
        detail,
      );
    }
    const start = prefix.events[0]?.actions?.continuationStart;
    if (prefix.events.some(isTerminalRuntimeEvent)) {
      return parkedPlan(
        'continuation_claim_repair_required',
        'continuation target has a terminal fact whose Run header requires repair',
        detail,
      );
    }
    if (
      prefix.identity.sessionId === claim.target.sessionId &&
      prefix.identity.invocationId === claim.target.invocationId &&
      prefix.identity.runId === claim.target.runId &&
      prefix.identity.turnId === claim.target.turnId &&
      start?.claimId === claim.claimId
    ) {
      return parkedPlan(
        'continuation_started_indeterminate',
        'continuation-start is durable but the target Run is not terminal',
        detail,
      );
    }
    return parkedPlan(
      'continuation_claim_repair_required',
      'durable continuation claim target is missing a matching continuation-start',
      detail,
    );
  }

  private async readLineagePrefixes(
    sessionId: string,
    sourceRunId: string,
    sourceRun: Awaited<ReturnType<RuntimeContinuationPlannerDeps['readSourceRun']>>,
  ): Promise<[ImmutableRuntimePrefixV1, ...ImmutableRuntimePrefixV1[]]> {
    const immediate = await this.deps.readImmutableRuntimePrefix({
      sessionId,
      runId: sourceRunId,
    });
    const segments: ImmutableRuntimePrefixV1[] = [immediate];
    const seen = new Set<string>([sourceRunId]);
    const v2Edges: Array<{ childRunId: string; boundaryDigest: RuntimeBoundaryDigest }> = [];
    let source = sourceRun.continuationSource;
    let childRunId = sourceRunId;
    let childPrefix = immediate;
    let depth = 1;
    while (source) {
      const current = source;
      if (current.protocol === 'continuation_source_v2' && current.boundaryDigest) {
        const start = childPrefix.events[0]?.actions?.continuationStart;
        if (
          !start ||
          start.claimId !== current.claimId ||
          start.boundaryDigest !== current.boundaryDigest ||
          start.replayManifestDigest !== current.replayManifestDigest ||
          start.immediateSource.sessionId !== sessionId ||
          start.immediateSource.invocationId !== current.sourceInvocationId ||
          start.immediateSource.runId !== current.sourceRunId ||
          start.immediateSource.turnId !== current.sourceTurnId ||
          start.immediateSource.highWater !== current.sourceRuntimeEventHighWater ||
          start.immediateSource.prefixDigest !== current.sourcePrefixDigest
        ) {
          throw new RuntimeLineageError(
            'runtime_lineage_start_mismatch',
            `continuation-start does not authenticate lineage edge for ${childRunId}`,
          );
        }
        v2Edges.push({ childRunId, boundaryDigest: current.boundaryDigest });
      }
      if (seen.has(current.sourceRunId)) {
        throw new RuntimeLineageError(
          'runtime_lineage_cycle',
          'continuation source lineage contains a cycle',
        );
      }
      if (depth >= 64) {
        throw new RuntimeLineageError(
          'runtime_lineage_depth_exceeded',
          'continuation source lineage exceeds the maximum depth of 64',
        );
      }
      seen.add(current.sourceRunId);
      let run: Awaited<ReturnType<RuntimeContinuationPlannerDeps['readSourceRun']>>;
      let prefix: ImmutableRuntimePrefixV1;
      try {
        [run, prefix] = await Promise.all([
          this.deps.readSourceRun(sessionId, current.sourceRunId),
          this.deps.readImmutableRuntimePrefix({
            sessionId,
            runId: current.sourceRunId,
            upToEventSeq: current.sourceRuntimeEventHighWater,
          }),
        ]);
      } catch {
        throw new RuntimeLineageError(
          'runtime_lineage_missing',
          `continuation ancestor ${current.sourceRunId} is unavailable`,
        );
      }
      if (
        prefix.identity.sessionId !== sessionId ||
        prefix.identity.invocationId !== current.sourceInvocationId ||
        prefix.identity.runId !== current.sourceRunId ||
        prefix.identity.turnId !== current.sourceTurnId ||
        prefix.position.lastEventSeq !== current.sourceRuntimeEventHighWater
      ) {
        throw new RuntimeLineageError(
          'runtime_identity_mismatch',
          `continuation ancestor ${current.sourceRunId} identity does not match its lineage edge`,
        );
      }
      if (
        current.protocol === 'continuation_source_v2' &&
        current.sourcePrefixDigest !== prefix.prefixDigest
      ) {
        throw new RuntimeLineageError(
          'source_prefix_digest_mismatch',
          `continuation ancestor ${current.sourceRunId} prefix digest changed`,
        );
      }
      segments.unshift(prefix);
      childPrefix = prefix;
      source = run.continuationSource;
      childRunId = current.sourceRunId;
      depth += 1;
    }
    for (const edge of v2Edges) {
      const childIndex = segments.findIndex((prefix) => prefix.identity.runId === edge.childRunId);
      if (childIndex <= 0) {
        throw new RuntimeLineageError(
          'runtime_lineage_missing',
          `continuation lineage edge for ${edge.childRunId} is incomplete`,
        );
      }
      const edgeSegments = segments.slice(0, childIndex).map(runtimePrefixSegment) as [
        ReturnType<typeof runtimePrefixSegment>,
        ...ReturnType<typeof runtimePrefixSegment>[],
      ];
      if (createRuntimeBoundaryCursor(edgeSegments).manifestDigest !== edge.boundaryDigest) {
        throw new RuntimeLineageError(
          'source_prefix_digest_mismatch',
          `continuation lineage manifest changed before ${edge.childRunId}`,
        );
      }
    }
    return segments as [ImmutableRuntimePrefixV1, ...ImmutableRuntimePrefixV1[]];
  }
}

class RuntimeLineageError extends Error {
  constructor(
    readonly code:
      | 'runtime_lineage_cycle'
      | 'runtime_lineage_depth_exceeded'
      | 'runtime_lineage_missing'
      | 'runtime_identity_mismatch'
      | 'runtime_lineage_start_mismatch'
      | 'source_prefix_digest_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeLineageError';
  }
}

function isTerminalRunStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function hasConsistentTerminalBoundary(
  runStatus: string,
  events: readonly RuntimeEvent[],
): boolean {
  if (!isTerminalRunStatus(runStatus)) return false;
  const terminalEvents = events.filter(
    (event) => !isPartialRuntimeEvent(event) && isTerminalRuntimeEvent(event),
  );
  if (terminalEvents.length !== 1) return false;
  const eventStatus = terminalEvents[0]?.status;
  if (eventStatus === 'aborted' || eventStatus === 'cancelled') {
    return runStatus === 'cancelled';
  }
  return eventStatus === runStatus;
}

export const INDETERMINATE_TOOL_RESULT_DIRECTIVE = [
  'Tool execution was interrupted before a matching committed tool result was found.',
  'The side effects may or may not have occurred.',
  'Do not retry the tool call immediately.',
  'Use read-only inspection tools to verify the current state before deciding the next step.',
].join(' ');

export function projectToolOperationsFromRuntimeEvents(
  events: readonly RuntimeEvent[],
): ToolOperation[] {
  return projectToolOperations(events, resolveRuntimeRecovery(events));
}

function projectToolOperations(
  events: readonly RuntimeEvent[],
  recovery: RuntimeRecoveryResolution,
): ToolOperation[] {
  const callsByEventId = new Map(
    events.flatMap((event) =>
      event.content?.kind === 'function_call' ? [[event.id, event.content] as const] : [],
    ),
  );
  return recovery.decisions.flatMap((decision) => {
    if (!decision.callRuntimeEventId) return [];
    const call = callsByEventId.get(decision.callRuntimeEventId);
    if (!call) return [];
    const status: ToolOperationStatus =
      decision.status === 'completed'
        ? decision.responseIsError
          ? 'failed'
          : 'succeeded'
        : decision.status === 'definitely_not_dispatched'
          ? 'not_dispatched'
          : decision.status;
    return [
      {
        toolCallId: decision.toolCallId,
        toolName: call.name,
        args: call.args,
        status,
        callRuntimeEventId: decision.callRuntimeEventId,
        ...(decision.responseRuntimeEventId
          ? { responseRuntimeEventId: decision.responseRuntimeEventId }
          : {}),
        ...(decision.responseIsError !== undefined
          ? { responseIsError: decision.responseIsError }
          : {}),
      },
    ];
  });
}

export function buildResumePlanFromRuntimeEvents(
  events: readonly RuntimeEvent[],
  options: BuildResumePlanOptions = {},
): ResumePlan {
  const recovery = resolveRuntimeRecovery(events);
  const operations = projectToolOperations(events, recovery);
  const sourceRuntimeEventHighWater = events.length;
  const diagnostics = collectResumeDiagnostics(events, operations, options, recovery);
  const rejectionReasons = deriveRejectionReasons(diagnostics);
  const requiresVerification = operations.some((operation) => operation.status === 'indeterminate');
  const disposition: ResumePlanDisposition =
    rejectionReasons.length === 0 && !requiresVerification && !recovery.hasCorruption
      ? 'safe_replay'
      : 'blocked';

  return {
    disposition,
    operations,
    diagnostics,
    rejectionReasons,
    requiresVerification,
    sourceRuntimeEventHighWater,
    ...(requiresVerification ? { directive: INDETERMINATE_TOOL_RESULT_DIRECTIVE } : {}),
    runtimeEvents: [...events],
    replayRuntimeEvents: buildResumeReplayRuntimeEvents(events),
  };
}

export function buildResumeReplayRuntimeEvents(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const pairedCallIds = collectPairedCallIds(events);
  const replayEvents: RuntimeEvent[] = [];

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (!content) {
      replayEvents.push(event);
      continue;
    }
    if (content.kind === 'function_call') {
      if (pairedCallIds.has(content.id)) replayEvents.push(event);
      continue;
    }
    if (content.kind === 'function_response') {
      if (pairedCallIds.has(content.id)) replayEvents.push(event);
      continue;
    }
    replayEvents.push(event);
  }

  return replayEvents;
}

export function buildSafeBoundaryContinuationPlan(
  events: readonly RuntimeEvent[],
  facts: SafeBoundaryContinuationFacts,
): SafeBoundaryContinuationPlan {
  const expectedRuntimeEventHighWater =
    facts.workspaceCheckpoint?.runtimeEventHighWater ?? facts.expectedRuntimeEventHighWater;
  const replayPlan = buildResumePlanFromRuntimeEvents(events, {
    ...(expectedRuntimeEventHighWater !== undefined ? { expectedRuntimeEventHighWater } : {}),
  });
  const phaseOneDiagnostics = collectPendingPermissionDiagnostics(events);
  const phaseOneRejectionReasons: ResumeRejectionReason[] = [];
  if (phaseOneDiagnostics.length > 0) phaseOneRejectionReasons.push('pending_permission');
  const source = events[0];
  if (!source) {
    phaseOneDiagnostics.push({
      code: 'runtime_ledger_empty',
      message: 'safe-boundary continuation requires at least one RuntimeEvent',
    });
    phaseOneRejectionReasons.push('runtime_ledger_empty');
  } else {
    const mismatchedEvent = events.find(
      (event) =>
        event.sessionId !== source.sessionId ||
        event.invocationId !== source.invocationId ||
        event.runId !== source.runId ||
        event.turnId !== source.turnId,
    );
    if (mismatchedEvent) {
      phaseOneDiagnostics.push({
        code: 'runtime_identity_mismatch',
        message: 'RuntimeEvent ledger contains more than one source execution identity',
        eventId: mismatchedEvent.id,
      });
      phaseOneRejectionReasons.push('runtime_identity_mismatch');
    }
    if (
      facts.continuationIdentity.invocationId === source.invocationId ||
      facts.continuationIdentity.runId === source.runId ||
      facts.continuationIdentity.turnId === source.turnId
    ) {
      phaseOneDiagnostics.push({
        code: 'continuation_identity_reused',
        message: 'continuation must use fresh invocation, run, and turn identities',
      });
      phaseOneRejectionReasons.push('continuation_identity_reused');
    }
  }
  if (!facts.ledgerReadable) {
    phaseOneDiagnostics.push({
      code: 'runtime_ledger_unreadable',
      message: 'RuntimeEvent ledger could not be read reliably',
    });
    phaseOneRejectionReasons.push('runtime_ledger_unreadable');
  }
  if (!facts.terminalRepairSucceeded) {
    phaseOneDiagnostics.push({
      code: 'terminal_repair_failed',
      message: 'source run terminal repair did not complete successfully',
    });
    phaseOneRejectionReasons.push('terminal_repair_failed');
  }
  if (normalizeCwd(facts.sourceCwd) !== normalizeCwd(facts.currentCwd)) {
    phaseOneDiagnostics.push({
      code: 'workspace_location_changed',
      message: 'workspace location differs from the source resume boundary',
      detail: { sourceCwd: facts.sourceCwd, currentCwd: facts.currentCwd },
    });
  }
  if (facts.sourceWorkspaceIdentity !== facts.currentWorkspaceIdentity) {
    phaseOneDiagnostics.push({
      code: 'workspace_identity_mismatch',
      message: 'current workspace identity differs from the source resume boundary',
      detail: {
        sourceWorkspaceIdentity: facts.sourceWorkspaceIdentity,
        currentWorkspaceIdentity: facts.currentWorkspaceIdentity,
      },
    });
    phaseOneRejectionReasons.push('workspace_identity_mismatch');
  }
  if (!facts.backgroundOperationsSettled) {
    phaseOneDiagnostics.push({
      code: 'background_operation_pending',
      message: 'a background or child operation is not settled',
    });
    phaseOneRejectionReasons.push('background_operation_pending');
  }
  if (facts.workspaceCheckpoint) {
    if (!facts.workspaceCheckpoint.ref) {
      phaseOneDiagnostics.push({
        code: 'workspace_ref_missing',
        message: 'workspace checkpoint does not contain a restorable ref',
      });
      phaseOneRejectionReasons.push('workspace_ref_missing');
    } else if (!facts.workspaceCheckpoint.restored) {
      phaseOneDiagnostics.push({
        code: 'checkpoint_restore_failed',
        message: 'workspace checkpoint ref could not be restored',
        detail: { workspaceRef: facts.workspaceCheckpoint.ref },
      });
      phaseOneRejectionReasons.push('checkpoint_restore_failed');
    }
  }
  const compositeReplay = facts.continuationReplayPlan;
  const sourceReplayRuntimeEvents =
    compositeReplay?.segments.at(-1)?.replayRuntimeEvents ?? replayPlan.replayRuntimeEvents;
  const modelRuntimeContext = compositeReplay?.runtimeContext ?? [
    ...(facts.priorRuntimeContext ?? []),
    ...sourceReplayRuntimeEvents,
  ];
  const availableToolNames = new Set(facts.availableToolNames);
  const unavailableToolNames = [
    ...new Set(
      modelRuntimeContext
        .flatMap((event) => (event.content?.kind === 'function_call' ? [event.content.name] : []))
        .filter((toolName) => !availableToolNames.has(toolName)),
    ),
  ].sort();
  if (unavailableToolNames.length > 0) {
    phaseOneDiagnostics.push({
      code: 'tool_catalog_mismatch',
      message: 'one or more tools from the source boundary are unavailable',
      detail: { unavailableToolNames },
    });
    phaseOneRejectionReasons.push('tool_catalog_mismatch');
  }
  const firstModelVisibleEvent = modelRuntimeContext.find(runtimeEventHasModelVisibleContent);
  if (
    source &&
    !phaseOneRejectionReasons.includes('runtime_identity_mismatch') &&
    firstModelVisibleEvent?.role !== 'user'
  ) {
    phaseOneDiagnostics.push({
      code: 'provider_resume_head_unsupported',
      message: 'provider replay must start at a user boundary for continuation',
      ...(firstModelVisibleEvent ? { eventId: firstModelVisibleEvent.id } : {}),
      detail: { firstRole: firstModelVisibleEvent?.role ?? null },
    });
    phaseOneRejectionReasons.push('provider_resume_head_unsupported');
  }
  const lastModelVisibleEvent = findLastModelVisibleEvent(modelRuntimeContext);
  if (
    source &&
    !phaseOneRejectionReasons.includes('runtime_identity_mismatch') &&
    lastModelVisibleEvent?.role !== 'user' &&
    lastModelVisibleEvent?.role !== 'tool'
  ) {
    phaseOneDiagnostics.push({
      code: 'provider_resume_boundary_unsupported',
      message: 'provider replay must end at a user or tool boundary for continuation',
      ...(lastModelVisibleEvent ? { eventId: lastModelVisibleEvent.id } : {}),
      detail: { lastRole: lastModelVisibleEvent?.role ?? null },
    });
    phaseOneRejectionReasons.push('provider_resume_boundary_unsupported');
  }
  if (replayPlan.disposition !== 'safe_replay' || phaseOneRejectionReasons.length > 0 || !source) {
    return {
      disposition: 'park',
      rejectionReasons: [...replayPlan.rejectionReasons, ...phaseOneRejectionReasons],
      diagnostics: [...replayPlan.diagnostics, ...phaseOneDiagnostics],
    };
  }

  return {
    disposition: 'continue',
    rejectionReasons: [],
    diagnostics: phaseOneDiagnostics,
    continuation: {
      sessionId: source.sessionId,
      ...facts.continuationIdentity,
      sourceInvocationId: source.invocationId,
      sourceRunId: source.runId,
      sourceTurnId: source.turnId,
      sourceRuntimeEventHighWater:
        compositeReplay?.segments.at(-1)?.boundary.position.lastEventSeq ??
        replayPlan.sourceRuntimeEventHighWater,
      ...(compositeReplay && compositeReplay.segments.length > 1
        ? { sourceRuntimeContext: [...sourceReplayRuntimeEvents] }
        : facts.priorRuntimeContext?.length
          ? { sourceRuntimeContext: replayPlan.replayRuntimeEvents }
          : {}),
      runtimeContext: [...modelRuntimeContext],
      ...(facts.continuationClaimId ? { claimId: facts.continuationClaimId } : {}),
      ...(compositeReplay
        ? {
            boundary: compositeReplay.boundary,
            providerReplayDigest: compositeReplay.providerReplayDigest,
            providerProjectionVersion: compositeReplay.providerProjectionVersion,
          }
        : {}),
      safetySnapshot: {
        workspaceIdentity: facts.currentWorkspaceIdentity,
        backgroundOperationsSettled: true,
        availableToolNames: [...new Set(facts.availableToolNames)].sort(),
        ...(facts.workspaceCheckpoint?.ref
          ? {
              workspaceCheckpoint: {
                ref: facts.workspaceCheckpoint.ref,
                runtimeEventHighWater: facts.workspaceCheckpoint.runtimeEventHighWater,
              },
            }
          : {}),
      },
    },
  };
}

function collectPendingPermissionDiagnostics(
  events: readonly RuntimeEvent[],
): ResumePlanDiagnostic[] {
  const pending = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const request = event.actions?.permissionRequest;
    if (request) pending.set(request.requestId, event);
    const decision = event.actions?.permissionDecision;
    if (decision) pending.delete(decision.requestId);
    const accepted = event.actions?.permissionAnswerAccepted;
    if (accepted) pending.delete(accepted.requestId);
    const closed = event.actions?.permissionClosureAccepted;
    if (closed) pending.delete(closed.requestId);
  }
  return [...pending.entries()].map(([requestId, event]) => ({
    code: 'pending_permission',
    message: 'permission request has no committed decision',
    eventId: event.id,
    detail: { requestId },
  }));
}

function normalizeCwd(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function findLastModelVisibleEvent(events: readonly RuntimeEvent[]): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && runtimeEventHasModelVisibleContent(event)) return event;
  }
  return undefined;
}

function parkedPlan(
  reason: ResumeRejectionReason & ResumePlanDiagnosticCode,
  message: string,
  detail?: Record<string, unknown>,
): SafeBoundaryContinuationPlan {
  return {
    disposition: 'park',
    rejectionReasons: [reason],
    diagnostics: [{ code: reason, message, ...(detail ? { detail } : {}) }],
  };
}

function collectResumeDiagnostics(
  events: readonly RuntimeEvent[],
  operations: readonly ToolOperation[],
  options: BuildResumePlanOptions,
  recovery: RuntimeRecoveryResolution,
): ResumePlanDiagnostic[] {
  const diagnostics: ResumePlanDiagnostic[] = [];
  const operationsById = new Map(operations.map((operation) => [operation.toolCallId, operation]));
  if (
    options.expectedRuntimeEventHighWater !== undefined &&
    options.expectedRuntimeEventHighWater !== events.length
  ) {
    diagnostics.push({
      code: 'runtime_offset_mismatch',
      message: 'RuntimeEvent high-water does not match the expected checkpoint offset',
      detail: {
        expectedRuntimeEventHighWater: options.expectedRuntimeEventHighWater,
        actualRuntimeEventHighWater: events.length,
      },
    });
  }

  for (const operation of operations) {
    if (operation.status === 'indeterminate') {
      diagnostics.push({
        code: 'pending_tool_result',
        message: 'function_call has no matching committed function_response',
        eventId: operation.callRuntimeEventId,
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
      });
    } else if (operation.status === 'not_dispatched') {
      diagnostics.push({
        code: 'tool_not_dispatched',
        message: 'function_call did not cross the durable tool dispatch boundary',
        eventId: operation.callRuntimeEventId,
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
      });
    } else if (operation.status === 'corruption') {
      diagnostics.push({
        code: 'tool_recovery_corruption',
        message: 'tool recovery facts conflict',
        eventId: operation.callRuntimeEventId,
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
      });
    } else if (operation.status === 'parked') {
      diagnostics.push({
        code: 'tool_recovery_parked',
        message: 'tool recovery reached a terminal parked decision',
        eventId: operation.callRuntimeEventId,
        toolCallId: operation.toolCallId,
        toolName: operation.toolName,
      });
    }
  }

  for (const issue of recovery.issues) {
    if (issue.code === 'protocol_marker_invalid') {
      diagnostics.push({
        code: issue.code,
        message: 'runtime protocol marker is only valid on the first canonical event',
        eventId: issue.eventId,
      });
    } else if (issue.code === 'duplicate_event_id') {
      diagnostics.push({
        code: issue.code,
        message: 'immutable RuntimeEvent identity is duplicated',
        eventId: issue.eventId,
      });
    } else if (issue.code === 'semantic_lane_conflict') {
      diagnostics.push({
        code: issue.code,
        message: 'RuntimeEvent claims more than one authoritative tool semantic lane',
        eventId: issue.eventId,
      });
    } else {
      diagnostics.push({
        code: 'tool_ledger_corruption',
        message: `immutable tool ledger is corrupt: ${issue.code}`,
        eventId: issue.eventId,
        detail: { issueCode: issue.code },
      });
    }
  }

  for (const decision of recovery.decisions) {
    if (
      decision.status !== 'corruption' ||
      decision.callRuntimeEventId ||
      decision.reason === 'orphan_response'
    )
      continue;
    diagnostics.push({
      code: 'tool_recovery_corruption',
      message: `tool recovery fact is corrupt: ${decision.reason}`,
      eventId: decision.dispatchRuntimeEventId ?? decision.responseRuntimeEventId,
      toolCallId: decision.toolCallId,
      ...(decision.toolName ? { toolName: decision.toolName } : {}),
    });
  }

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (content?.kind !== 'function_response') continue;
    const operation = operationsById.get(content.id);
    if (!operation) {
      diagnostics.push({
        code: 'unmatched_tool_result',
        message: 'function_response has no prior matching function_call',
        eventId: event.id,
        toolCallId: content.id,
        toolName: content.name,
      });
      continue;
    }
    if (operation.toolName !== content.name) {
      diagnostics.push({
        code: 'tool_name_mismatch',
        message: 'function_response tool name differs from matching function_call',
        eventId: event.id,
        toolCallId: content.id,
        toolName: content.name,
        detail: {
          callToolName: operation.toolName,
          responseToolName: content.name,
        },
      });
    }
  }

  return diagnostics;
}

function deriveRejectionReasons(
  diagnostics: readonly ResumePlanDiagnostic[],
): ResumeRejectionReason[] {
  const reasons = new Set<ResumeRejectionReason>();
  for (const diagnostic of diagnostics) {
    switch (diagnostic.code) {
      case 'runtime_offset_mismatch':
        reasons.add('runtime_offset_mismatch');
        break;
      case 'pending_tool_result':
      case 'tool_not_dispatched':
      case 'tool_recovery_parked':
      case 'tool_recovery_corruption':
      case 'tool_ledger_corruption':
      case 'duplicate_event_id':
      case 'semantic_lane_conflict':
      case 'protocol_marker_invalid':
      case 'unmatched_tool_result':
      case 'tool_name_mismatch':
        reasons.add('dangling_tool_state');
        break;
    }
  }
  return [...reasons];
}

function collectPairedCallIds(events: readonly RuntimeEvent[]): Set<string> {
  const calls = new Map<string, RuntimeEventFunctionCallContent>();
  const paired = new Set<string>();

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const content = event.content;
    if (content?.kind === 'function_call') {
      calls.set(content.id, content);
      continue;
    }
    if (content?.kind === 'function_response' && hasMatchingCall(calls.get(content.id), content)) {
      paired.add(content.id);
    }
  }

  return paired;
}

function hasMatchingCall(
  call: RuntimeEventFunctionCallContent | undefined,
  response: RuntimeEventFunctionResponseContent,
): boolean {
  return call !== undefined && call.name === response.name;
}
