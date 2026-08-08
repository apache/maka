import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimResult,
} from '@maka/core/agent-graph-control';
import {
  AgentGraphScheduleRevisionConflictError,
  type AgentGraphScheduleControlStore,
  type AgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdateSource,
} from '@maka/core/agent-graph-schedule';
import type {
  AgentGraphOperatorProvision,
  AgentGraphProvisionedEdge,
} from '@maka/core/agent-graph-topology';
import type { SessionEvent } from '@maka/core/events';
import { claimAgentGraphRunnableIntent } from './stream-graph-admission.js';
import type {
  AgentGraphDispatchedActivation,
  AgentGraphIntentExecutor,
  AgentGraphSupervisorObserver,
  AgentGraphSupervisorObservation,
} from './stream-graph-dispatch.js';
import type {
  ProvisionAgentGraphOperatorInput,
  ProvisionAgentGraphOperatorResult,
} from './session-manager.js';
import type { AgentGraphRecord } from './stream-graph-projection.js';
import type { AgentGraphInputHandoff } from './stream-graph-handoff.js';
import type { AgentGraphRunnableIntent } from './stream-graph-readiness.js';
import {
  projectAgentGraphSchedule,
  type AgentGraphScheduleProjection,
  type AgentGraphScheduleWorkView,
} from './stream-graph-supervisor-tools.js';
import type { AgentGraphTraceTopology } from './stream-graph-trace.js';
import { stableHash } from './request-shape.js';

const MAX_RECONCILIATION_ATTEMPTS = 8;
const SCHEDULE_INTENT_SCHEMA_VERSION = 1 as const;

export interface AgentGraphScheduleStopController {
  stopSession(sessionId: string, input: { source: 'graph_supervisor' }): Promise<void>;
}

export interface RenderAgentGraphScheduledWorkPromptInput {
  work: AgentGraphScheduleWorkView;
  inputRecords: AgentGraphRecord[];
  inputHandoffs: AgentGraphInputHandoff[];
}

export interface ReconcileAgentGraphScheduleInput {
  topology: AgentGraphTraceTopology;
  controlStore: AgentGraphScheduleControlStore;
  executor: AgentGraphIntentExecutor;
  stopController: AgentGraphScheduleStopController;
  newId: () => string;
  maxNewActivations: number;
  observeGraph(topology: AgentGraphTraceTopology): Promise<AgentGraphSupervisorObservation>;
  provisionOperator?(
    input: ProvisionAgentGraphOperatorInput,
  ): Promise<ProvisionAgentGraphOperatorResult>;
  hydrateInputHandoffs?(records: readonly AgentGraphRecord[]): Promise<AgentGraphInputHandoff[]>;
  renderPrompt(input: RenderAgentGraphScheduledWorkPromptInput): string | Promise<string>;
  abortSignal?: AbortSignal;
  supervisor?: AgentGraphSupervisorObserver;
}

export interface AgentGraphScheduleStopResult {
  targetId: string;
  reason: string;
  status: 'stopped' | 'already_terminal' | 'cancelled_before_runtime' | 'ignored_unknown';
  sessionId?: string;
  activationId?: string;
}

export interface AgentGraphScheduleDeferredWork {
  work: AgentGraphScheduleWorkView;
  reason: 'agent_topology_required' | 'input_not_committed' | 'graph_closed' | 'activation_limit';
  missingInputIds?: string[];
}

export interface AgentGraphScheduleReconciliationFailure {
  phase: 'schedule' | 'topology' | 'stop' | 'render' | 'dispatch';
  error: unknown;
  work?: AgentGraphScheduleWorkView;
  intent?: AgentGraphRunnableIntent;
  targetId?: string;
}

export interface AgentGraphScheduleReconciliationResult {
  status: 'reconciled' | 'waiting' | 'limit_reached' | 'failed' | 'cancelled' | 'stale';
  newActivationCount: number;
  observedExistingActivationCount: number;
  dispatches: AgentGraphDispatchedActivation[];
  stops: AgentGraphScheduleStopResult[];
  deferredWork: AgentGraphScheduleDeferredWork[];
  failures: AgentGraphScheduleReconciliationFailure[];
  schedule: AgentGraphScheduleProjection;
  observation: AgentGraphSupervisorObservation;
}

interface ScheduleSnapshot {
  schedule: AgentGraphScheduleProjection;
  observation: AgentGraphSupervisorObservation;
  claims: AgentGraphIntentClaim[];
  topology: AgentGraphTraceTopology;
  provisions: AgentGraphOperatorProvision[];
  sourceByWorkId: Map<string, AgentGraphScheduleUpdateSource>;
}

interface PreparedWork {
  work: AgentGraphScheduleWorkView;
  intent: AgentGraphRunnableIntent;
  prompt: string;
  provision?: AgentGraphOperatorProvision;
}

type ScheduleDispatchOutcome =
  | {
      status: 'fulfilled';
      dispatch: AgentGraphDispatchedActivation;
    }
  | {
      status: 'rejected';
      failure: AgentGraphScheduleReconciliationFailure;
      admission?: AgentGraphIntentClaimResult;
    }
  | {
      status: 'stale';
    };

/**
 * Applies durable supervisor schedule intent to existing and newly
 * materialized graph operators.
 *
 * Schedule revision and new intent admission are linearized by the control
 * store. Existing claims remain recoverable after finish; unclaimed work does
 * not cross terminal closure. Catalog-agent work is materialized through an
 * append-only topology provision before its first intent is claimed.
 */
export async function reconcileAgentGraphSchedule(
  input: ReconcileAgentGraphScheduleInput,
): Promise<AgentGraphScheduleReconciliationResult> {
  if (!Number.isSafeInteger(input.maxNewActivations) || input.maxNewActivations < 0) {
    throw new Error('Agent graph maxNewActivations must be a non-negative safe integer');
  }

  const processedIntentIds = new Set<string>();
  const dispatches: AgentGraphDispatchedActivation[] = [];
  const stops: AgentGraphScheduleStopResult[] = [];
  const failures: AgentGraphScheduleReconciliationFailure[] = [];
  let newActivationCount = 0;
  let observedExistingActivationCount = 0;
  let snapshot = await readScheduleSnapshot(input);

  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    if (input.abortSignal?.aborted) {
      return reconciliationResult(
        'cancelled',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        stops,
        [],
        failures,
        snapshot,
      );
    }

    const stopWave = await applyScheduleStops(input, snapshot);
    stops.push(...stopWave.stops);
    for (const failure of stopWave.failures) recordReconciliationFailure(input, failures, failure);
    if (failures.length > 0) {
      snapshot = await readScheduleSnapshot(input);
      return reconciliationResult(
        input.abortSignal?.aborted ? 'cancelled' : 'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        stops,
        [],
        failures,
        snapshot,
      );
    }

    const claimsByIntent = new Map(snapshot.claims.map((claim) => [claim.intentId, claim]));
    const provisionsByWork = new Map(
      snapshot.provisions.map((provision) => [provision.workId, provision]),
    );
    const committedRecords = new Map(
      snapshot.observation.projection.records.map((record) => [record.recordId, record]),
    );
    const deferredWork: AgentGraphScheduleDeferredWork[] = [];
    let topologyChanged = false;
    let topologyStale = false;

    for (const work of orderedRequestedWork(snapshot.schedule)) {
      if (work.target.kind === 'operator' || provisionsByWork.has(work.workId)) continue;
      if (snapshot.schedule.closed) {
        deferredWork.push({ work, reason: 'graph_closed' });
        continue;
      }
      const missingInputIds = work.inputIds.filter((recordId) => !committedRecords.has(recordId));
      if (missingInputIds.length > 0) {
        deferredWork.push({ work, reason: 'input_not_committed', missingInputIds });
        continue;
      }
      if (!input.provisionOperator) {
        deferredWork.push({ work, reason: 'agent_topology_required' });
        continue;
      }
      const source = snapshot.sourceByWorkId.get(work.workId);
      if (!source) {
        recordReconciliationFailure(input, failures, {
          phase: 'topology',
          work,
          error: new Error(`Graph work ${work.workId} has no durable schedule source`),
        });
        continue;
      }
      try {
        await input.provisionOperator(
          buildOperatorProvisionInput(
            snapshot.topology,
            snapshot.observation,
            work,
            source,
            snapshot.schedule.revision,
          ),
        );
        topologyChanged = true;
      } catch (error) {
        if (error instanceof AgentGraphScheduleRevisionConflictError) {
          topologyStale = true;
          break;
        }
        recordReconciliationFailure(input, failures, { phase: 'topology', work, error });
      }
    }
    if (topologyChanged || topologyStale) {
      snapshot = await readScheduleSnapshot(input);
      if (failures.length === 0) continue;
    }
    if (failures.length > 0) {
      return reconciliationResult(
        'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        stops,
        deferredWork,
        failures,
        snapshot,
      );
    }

    const candidates: Array<{
      work: AgentGraphScheduleWorkView;
      intent: AgentGraphRunnableIntent;
      existing: boolean;
    }> = [];

    for (const work of orderedRequestedWork(snapshot.schedule)) {
      if (work.target.kind !== 'operator' && !provisionsByWork.has(work.workId)) continue;
      let intent: AgentGraphRunnableIntent;
      try {
        intent = scheduledWorkIntent(
          snapshot.topology,
          snapshot.observation,
          work,
          provisionsByWork.get(work.workId),
        );
      } catch (error) {
        recordReconciliationFailure(input, failures, { phase: 'schedule', work, error });
        continue;
      }
      if (processedIntentIds.has(intent.intentId)) continue;
      const existing = claimsByIntent.has(intent.intentId);
      if (snapshot.schedule.closed && !existing) {
        deferredWork.push({ work, reason: 'graph_closed' });
        continue;
      }
      const missingInputIds = work.inputIds.filter((recordId) => !committedRecords.has(recordId));
      if (missingInputIds.length > 0) {
        deferredWork.push({
          work,
          reason: 'input_not_committed',
          missingInputIds,
        });
        continue;
      }
      candidates.push({ work, intent, existing });
    }

    if (failures.length > 0) {
      snapshot = await readScheduleSnapshot(input);
      return reconciliationResult(
        'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        stops,
        deferredWork,
        failures,
        snapshot,
      );
    }

    const selected: typeof candidates = [];
    for (const candidate of candidates) {
      if (
        candidate.existing ||
        newActivationCount + selected.filter((item) => !item.existing).length <
          input.maxNewActivations
      ) {
        selected.push(candidate);
      } else {
        deferredWork.push({ work: candidate.work, reason: 'activation_limit' });
      }
    }

    const rendered = await Promise.allSettled(
      selected.map(async ({ work, intent }): Promise<PreparedWork> => {
        const inputRecords = work.inputIds.map((recordId) =>
          clonePlain(committedRecords.get(recordId)!),
        );
        const inputHandoffs = input.hydrateInputHandoffs
          ? await input.hydrateInputHandoffs(inputRecords)
          : [];
        const prompt = await input.renderPrompt({
          work: clonePlain(work),
          inputRecords,
          inputHandoffs,
        });
        if (!prompt.trim()) {
          throw new Error(`Agent graph scheduled work ${work.workId} rendered an empty prompt`);
        }
        const provision = provisionsByWork.get(work.workId);
        return { work, intent, prompt, ...(provision ? { provision } : {}) };
      }),
    );
    const prepared: PreparedWork[] = [];
    rendered.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        prepared.push(result.value);
      } else {
        recordReconciliationFailure(input, failures, {
          phase: 'render',
          work: selected[index]!.work,
          intent: selected[index]!.intent,
          error: result.reason,
        });
      }
    });
    if (failures.length > 0) {
      snapshot = await readScheduleSnapshot(input);
      return reconciliationResult(
        'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        stops,
        deferredWork,
        failures,
        snapshot,
      );
    }

    const outcomes = await Promise.all(
      prepared.map(async (work) => {
        const outcome = await dispatchScheduledWork(input, work, snapshot.schedule.revision);
        if (outcome.status === 'rejected') {
          notifySupervisor(input.supervisor?.onReconciliationFailure, outcome.failure);
        }
        return outcome;
      }),
    );
    let stale = false;
    for (const outcome of outcomes) {
      if (outcome.status === 'stale') {
        stale = true;
        continue;
      }
      if (outcome.status === 'fulfilled') {
        dispatches.push(outcome.dispatch);
        processedIntentIds.add(outcome.dispatch.intent.intentId);
        if (outcome.dispatch.claimCreated) newActivationCount += 1;
        else observedExistingActivationCount += 1;
        continue;
      }
      failures.push(outcome.failure);
      if (outcome.admission) {
        processedIntentIds.add(outcome.failure.intent!.intentId);
        if (outcome.admission.created) newActivationCount += 1;
        else observedExistingActivationCount += 1;
      }
    }

    const nextSnapshot = await readScheduleSnapshot(input);
    if (stale || nextSnapshot.schedule.revision !== snapshot.schedule.revision) {
      snapshot = nextSnapshot;
      continue;
    }
    snapshot = nextSnapshot;
    if (failures.length > 0) {
      return reconciliationResult(
        input.abortSignal?.aborted ? 'cancelled' : 'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        stops,
        deferredWork,
        failures,
        snapshot,
      );
    }
    const status = input.abortSignal?.aborted
      ? 'cancelled'
      : deferredWork.some((item) => item.reason === 'activation_limit')
        ? 'limit_reached'
        : deferredWork.some(
              (item) =>
                item.reason === 'agent_topology_required' || item.reason === 'input_not_committed',
            )
          ? 'waiting'
          : 'reconciled';
    return reconciliationResult(
      status,
      newActivationCount,
      observedExistingActivationCount,
      dispatches,
      stops,
      deferredWork,
      failures,
      snapshot,
    );
  }

  snapshot = await readScheduleSnapshot(input);
  return reconciliationResult(
    'stale',
    newActivationCount,
    observedExistingActivationCount,
    dispatches,
    stops,
    [],
    failures,
    snapshot,
  );
}

async function readScheduleSnapshot(
  input: ReconcileAgentGraphScheduleInput,
): Promise<ScheduleSnapshot> {
  const [updates, provisions, claims] = await Promise.all([
    input.controlStore.listAgentGraphScheduleUpdates(input.topology.graphId),
    input.controlStore.listAgentGraphOperatorProvisions(input.topology.graphId),
    input.controlStore.listAgentGraphIntentClaims(input.topology.graphId),
  ]);
  const topology = composeProvisionedTopology(input.topology, provisions);
  const observation = await input.observeGraph(topology);
  assertGraphObservation(input.topology.graphId, observation);
  notifySupervisor(input.supervisor?.onObservation, observation);
  return {
    schedule: projectAgentGraphSchedule(input.topology.graphId, updates),
    observation,
    claims,
    topology,
    provisions,
    sourceByWorkId: scheduleSourceByWorkId(updates),
  };
}

async function applyScheduleStops(
  input: ReconcileAgentGraphScheduleInput,
  snapshot: ScheduleSnapshot,
): Promise<{
  stops: AgentGraphScheduleStopResult[];
  failures: AgentGraphScheduleReconciliationFailure[];
}> {
  const requests = new Map<string, string>();
  for (const stopped of snapshot.schedule.stoppedTargets) {
    requests.set(stopped.targetId, stopped.reason);
  }
  for (const work of snapshot.schedule.work) {
    if (work.replaces && !requests.has(work.replaces)) {
      requests.set(work.replaces, `Superseded by graph work ${work.workId}`);
    }
  }
  if (requests.size === 0) return { stops: [], failures: [] };

  const workById = new Map(snapshot.schedule.work.map((work) => [work.workId, work]));
  const claimsByIntent = new Map(snapshot.claims.map((claim) => [claim.intentId, claim]));
  const activationTargets = graphActivationTargets(snapshot.observation);
  const immediate: AgentGraphScheduleStopResult[] = [];
  const targetsBySession = new Map<
    string,
    Array<{ targetId: string; reason: string; activationId: string }>
  >();
  const failures: AgentGraphScheduleReconciliationFailure[] = [];

  for (const [targetId, reason] of requests) {
    const work = workById.get(targetId);
    const claim = work
      ? claimsByIntent.get(scheduledWorkIntentId(snapshot.schedule.graphId, work.workId))
      : undefined;
    const activation = claim
      ? activationTargets.get(claim.targetRunId)
      : activationTargets.get(targetId);
    if (activation && isTerminalActivationStatus(activation.status)) {
      immediate.push({
        targetId,
        reason,
        status: 'already_terminal',
        sessionId: activation.sessionId,
        activationId: activation.activationId,
      });
      continue;
    }
    if (work && claim) {
      try {
        const cancellation = await input.controlStore.cancelAgentGraphIntentExecution(
          snapshot.schedule.graphId,
          claim.intentId,
          reason,
        );
        if (cancellation.previousState !== 'executing' && !activation) {
          immediate.push({
            targetId,
            reason,
            status: 'cancelled_before_runtime',
            sessionId: claim.targetSessionId,
            activationId: claim.targetRunId,
          });
          continue;
        }
      } catch (error) {
        failures.push({ phase: 'stop', targetId, error });
        continue;
      }
    } else if (work) {
      immediate.push({ targetId, reason, status: 'cancelled_before_runtime' });
      continue;
    } else if (!activation) {
      immediate.push({ targetId, reason, status: 'ignored_unknown' });
      continue;
    }
    const sessionId = activation?.sessionId ?? claim!.targetSessionId;
    const activationId = activation?.activationId ?? claim!.targetRunId;
    const sessionTargets = targetsBySession.get(sessionId) ?? [];
    sessionTargets.push({
      targetId,
      reason,
      activationId,
    });
    targetsBySession.set(sessionId, sessionTargets);
  }

  const settled = await Promise.allSettled(
    [...targetsBySession].map(async ([sessionId, targets]) => {
      await input.stopController.stopSession(sessionId, { source: 'graph_supervisor' });
      return targets.map(
        (target): AgentGraphScheduleStopResult => ({
          targetId: target.targetId,
          reason: target.reason,
          status: 'stopped',
          sessionId,
          activationId: target.activationId,
        }),
      );
    }),
  );
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      immediate.push(...result.value);
      return;
    }
    const [sessionId, targets] = [...targetsBySession][index]!;
    targets.forEach((target) => {
      failures.push({
        phase: 'stop',
        targetId: target.targetId,
        error: new Error(
          `Failed to stop graph supervisor target ${target.targetId} in ${sessionId}`,
          { cause: result.reason },
        ),
      });
    });
  });
  return {
    stops: immediate.sort((a, b) => compareIdentity(a.targetId, b.targetId)),
    failures,
  };
}

async function dispatchScheduledWork(
  input: ReconcileAgentGraphScheduleInput,
  prepared: PreparedWork,
  expectedRevision: number,
): Promise<ScheduleDispatchOutcome> {
  let admission: AgentGraphIntentClaimResult | undefined;
  try {
    if (input.abortSignal?.aborted) {
      throw new Error('Agent graph scheduled work was cancelled before admission');
    }
    admission = await claimAgentGraphRunnableIntent({
      intent: prepared.intent,
      store: {
        claimAgentGraphIntent: (request) =>
          input.controlStore.claimAgentGraphIntentAtScheduleRevision(request, expectedRevision),
      },
      newId: input.newId,
      ...(prepared.provision
        ? {
            targetTurnId: prepared.provision.initialTurnId,
            targetRunId: prepared.provision.initialRunId,
          }
        : {}),
      executionInput: { prompt: prepared.prompt },
    });
    const result = await input.executor.runClaimedAgentGraphIntent({
      claimStore: input.controlStore,
      intent: prepared.intent,
      graphId: prepared.intent.graphId,
      intentId: prepared.intent.intentId,
      prompt: prepared.prompt,
      async admitExecution() {
        const transition =
          await input.controlStore.beginAgentGraphIntentExecutionAtScheduleRevision(
            prepared.intent.graphId,
            prepared.intent.intentId,
            expectedRevision,
          );
        return transition.state === 'cancelled' ? 'cancelled' : 'executing';
      },
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      onReady(runtime) {
        notifySupervisor(input.supervisor?.onActivationReady, {
          intent: prepared.intent,
          claim: admission!.claim,
          runtime,
        });
      },
      onEvent(event: SessionEvent) {
        notifySupervisor(input.supervisor?.onRuntimeEvent, {
          intent: prepared.intent,
          claim: admission!.claim,
          event,
        });
      },
    });
    return {
      status: 'fulfilled',
      dispatch: {
        intent: prepared.intent,
        claim: admission.claim,
        claimCreated: admission.created,
        result,
      },
    };
  } catch (error) {
    if (error instanceof AgentGraphScheduleRevisionConflictError) {
      return { status: 'stale' };
    }
    return {
      status: 'rejected',
      failure: {
        phase: 'dispatch',
        work: prepared.work,
        intent: prepared.intent,
        error,
      },
      ...(admission ? { admission } : {}),
    };
  }
}

function scheduledWorkIntent(
  topology: AgentGraphTraceTopology,
  observation: AgentGraphSupervisorObservation,
  work: AgentGraphScheduleWorkView,
  provision?: AgentGraphOperatorProvision,
): AgentGraphRunnableIntent {
  if (work.target.kind !== 'operator') {
    if (
      !provision ||
      provision.workId !== work.workId ||
      (work.target.kind === 'agent' ? provision.agentId !== work.target.agentId : false)
    ) {
      throw new Error(`Graph work ${work.workId} has no matching topology provision`);
    }
  } else if (provision) {
    throw new Error(`Existing-operator graph work ${work.workId} cannot own a provision`);
  }
  const operatorId =
    work.target.kind === 'operator' ? work.target.operatorId : provision!.operatorId;
  const topologyBinding = topology.operators.find((operator) => operator.operatorId === operatorId);
  const observedBinding = observation.projection.operators.find(
    (operator) => operator.operatorId === operatorId,
  );
  if (!topologyBinding || !observedBinding) {
    throw new Error(`Graph work ${work.workId} references unknown operator ${operatorId}`);
  }
  if (topologyBinding.sessionId !== observedBinding.sessionId) {
    throw new Error(`Graph operator ${operatorId} changed session identity during reconciliation`);
  }
  const policyFingerprint = stableHash({
    schemaVersion: SCHEDULE_INTENT_SCHEMA_VERSION,
    kind: 'supervisor',
    graphId: topology.graphId,
    workId: work.workId,
    target: work.target,
    inputIds: work.inputIds,
    ...(work.replaces ? { replaces: work.replaces } : {}),
  });
  const readinessContextFingerprint = stableHash({
    schemaVersion: SCHEDULE_INTENT_SCHEMA_VERSION,
    graphId: topology.graphId,
    workId: work.workId,
    operatorId,
    targetSessionId: topologyBinding.sessionId,
    inputIds: work.inputIds,
  });
  return {
    schemaVersion: 1,
    intentId: scheduledWorkIntentId(topology.graphId, work.workId),
    graphId: topology.graphId,
    readinessContextFingerprint,
    policyFingerprint,
    readinessId: work.workId,
    operatorId,
    targetSessionId: topologyBinding.sessionId,
    policyKind: 'supervisor',
    triggerRouteIds: [],
    triggerRecordIds: [...work.inputIds],
  };
}

function scheduledWorkIntentId(graphId: string, workId: string): string {
  const hash = stableHash({
    schemaVersion: SCHEDULE_INTENT_SCHEMA_VERSION,
    graphId,
    workId,
  });
  return `graph_intent_${hash.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function buildOperatorProvisionInput(
  topology: AgentGraphTraceTopology,
  observation: AgentGraphSupervisorObservation,
  work: AgentGraphScheduleWorkView,
  source: AgentGraphScheduleUpdateSource,
  expectedScheduleRevision: number,
): ProvisionAgentGraphOperatorInput {
  if (work.target.kind === 'operator') {
    throw new Error(`Graph work ${work.workId} targets an existing operator`);
  }
  const operatorHash = stableHash({
    schemaVersion: SCHEDULE_INTENT_SCHEMA_VERSION,
    kind: 'dynamic_operator',
    graphId: topology.graphId,
    workId: work.workId,
  });
  const operatorId = `graph_operator_${operatorHash.slice(
    'sha256:'.length,
    'sha256:'.length + 32,
  )}`;
  const recordsById = new Map(
    observation.projection.records.map((record) => [record.recordId, record]),
  );
  const sourceOperatorIds = [
    ...new Set(work.inputIds.map((recordId) => recordsById.get(recordId)!.operatorId)),
  ].sort(compareIdentity);
  const edges: AgentGraphProvisionedEdge[] = sourceOperatorIds.map((fromOperatorId) => {
    const edgeHash = stableHash({
      schemaVersion: SCHEDULE_INTENT_SCHEMA_VERSION,
      kind: 'dynamic_edge',
      graphId: topology.graphId,
      workId: work.workId,
      fromOperatorId,
      toOperatorId: operatorId,
    });
    return {
      edgeId: `graph_edge_${edgeHash.slice('sha256:'.length, 'sha256:'.length + 32)}`,
      fromOperatorId,
      toOperatorId: operatorId,
    };
  });
  return {
    graphId: topology.graphId,
    workId: work.workId,
    ...(work.target.kind === 'preset'
      ? { subagentId: work.target.presetId }
      : { agentId: work.target.agentId }),
    operatorId,
    source,
    edges,
    expectedScheduleRevision,
  };
}

function composeProvisionedTopology(
  baseline: AgentGraphTraceTopology,
  provisions: readonly AgentGraphOperatorProvision[],
): AgentGraphTraceTopology {
  const operators = baseline.operators.map((operator) => ({ ...operator }));
  const edges = baseline.edges.map((edge) => ({ ...edge }));
  const operatorById = new Map(operators.map((operator) => [operator.operatorId, operator]));
  const edgeById = new Map(edges.map((edge) => [edge.edgeId, edge]));

  for (const provision of [...provisions].sort((a, b) =>
    compareIdentity(a.provisionId, b.provisionId),
  )) {
    if (provision.graphId !== baseline.graphId) {
      throw new Error(`Topology provision ${provision.provisionId} belongs to another graph`);
    }
    const existingOperator = operatorById.get(provision.operatorId);
    if (existingOperator) {
      throw new Error(`Topology provision reuses existing operator ${provision.operatorId}`);
    }
    const binding = {
      operatorId: provision.operatorId,
      sessionId: provision.targetSessionId,
    };
    operators.push(binding);
    operatorById.set(binding.operatorId, binding);
    for (const edge of provision.edges) {
      const existingEdge = edgeById.get(edge.edgeId);
      if (existingEdge) {
        throw new Error(`Topology provision reuses existing edge ${edge.edgeId}`);
      }
      const copy = { ...edge };
      edges.push(copy);
      edgeById.set(copy.edgeId, copy);
    }
  }
  for (const edge of edges) {
    if (!operatorById.has(edge.fromOperatorId) || !operatorById.has(edge.toOperatorId)) {
      throw new Error(`Graph edge ${edge.edgeId} references an unknown operator`);
    }
  }
  return {
    graphId: baseline.graphId,
    operators,
    edges,
  };
}

function scheduleSourceByWorkId(
  updates: readonly AgentGraphScheduleUpdate[],
): Map<string, AgentGraphScheduleUpdateSource> {
  const sources = new Map<string, AgentGraphScheduleUpdateSource>();
  for (const update of updates) {
    for (const work of update.addWork) {
      const existing = sources.get(work.workId);
      if (existing && !sameScheduleSource(existing, update.source)) {
        throw new Error(`Graph work ${work.workId} has conflicting schedule sources`);
      }
      sources.set(work.workId, { ...update.source });
    }
  }
  return sources;
}

function sameScheduleSource(
  left: AgentGraphScheduleUpdateSource,
  right: AgentGraphScheduleUpdateSource,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.toolCallId === right.toolCallId
  );
}

function orderedRequestedWork(
  schedule: AgentGraphScheduleProjection,
): AgentGraphScheduleWorkView[] {
  return schedule.work
    .filter((work) => work.status === 'requested')
    .sort(
      (a, b) =>
        a.revision - b.revision ||
        a.committedAt - b.committedAt ||
        compareIdentity(a.workId, b.workId),
    );
}

function graphActivationTargets(observation: AgentGraphSupervisorObservation): Map<
  string,
  {
    sessionId: string;
    activationId: string;
    status: string;
  }
> {
  const targets = new Map<
    string,
    {
      sessionId: string;
      activationId: string;
      status: string;
    }
  >();
  for (const binding of observation.projection.operators) {
    const state = observation.projection.state.operators[binding.operatorId];
    for (const activation of Object.values(state?.activations ?? {})) {
      if (targets.has(activation.activationId)) {
        throw new Error(
          `Graph activation ${activation.activationId} belongs to multiple operators`,
        );
      }
      targets.set(activation.activationId, {
        sessionId: binding.sessionId,
        activationId: activation.activationId,
        status: activation.status,
      });
    }
  }
  return targets;
}

function isTerminalActivationStatus(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'aborted' || status === 'cancelled'
  );
}

function assertGraphObservation(
  graphId: string,
  observation: AgentGraphSupervisorObservation,
): void {
  if (
    observation.projection.graphId !== graphId ||
    observation.readiness.graphId !== graphId ||
    observation.readiness.trace.graphId !== graphId
  ) {
    throw new Error('Agent graph schedule observation belongs to another graph');
  }
}

function reconciliationResult(
  status: AgentGraphScheduleReconciliationResult['status'],
  newActivationCount: number,
  observedExistingActivationCount: number,
  dispatches: readonly AgentGraphDispatchedActivation[],
  stops: readonly AgentGraphScheduleStopResult[],
  deferredWork: readonly AgentGraphScheduleDeferredWork[],
  failures: readonly AgentGraphScheduleReconciliationFailure[],
  snapshot: ScheduleSnapshot,
): AgentGraphScheduleReconciliationResult {
  return {
    status,
    newActivationCount,
    observedExistingActivationCount,
    dispatches: [...dispatches],
    stops: dedupeStops(stops),
    deferredWork: deferredWork.map((item) => clonePlain(item)),
    failures: [...failures],
    schedule: snapshot.schedule,
    observation: snapshot.observation,
  };
}

function recordReconciliationFailure(
  input: ReconcileAgentGraphScheduleInput,
  failures: AgentGraphScheduleReconciliationFailure[],
  failure: AgentGraphScheduleReconciliationFailure,
): void {
  failures.push(failure);
  notifySupervisor(input.supervisor?.onReconciliationFailure, failure);
}

function dedupeStops(
  stops: readonly AgentGraphScheduleStopResult[],
): AgentGraphScheduleStopResult[] {
  const byTarget = new Map<string, AgentGraphScheduleStopResult>();
  for (const stop of stops) byTarget.set(stop.targetId, stop);
  return [...byTarget.values()].sort((a, b) => compareIdentity(a.targetId, b.targetId));
}

function notifySupervisor<T>(
  observer: ((input: T) => void | Promise<void>) | undefined,
  value: T,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(clonePlain(value))).catch(() => {
      // Presentation-only supervision must not gate reconciliation.
    });
  } catch {
    // Presentation-only supervision must not gate reconciliation.
  }
}

function compareIdentity(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clonePlain<T>(value: T): T {
  return structuredClone(value);
}
