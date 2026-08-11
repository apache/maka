import {
  decodeAgentGraphIntentClaim,
  type AgentGraphIntentClaim,
  type AgentGraphIntentClaimStore,
} from '@maka/core/agent-graph-control';
import type { AgentRunStore } from '@maka/core/agent-run';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type {
  ClaimedAgentGraphIntentResult,
  RunClaimedAgentGraphIntentInput,
} from './session-manager.js';
import { claimAgentGraphRunnableIntent } from './stream-graph-admission.js';
import { compareAgentGraphIdentity } from './stream-graph-identity.js';
import {
  readCommittedAgentGraphProjection,
  type AgentGraphProjection,
  type AgentGraphRecord,
} from './stream-graph-projection.js';
import {
  buildAgentGraphReadinessSnapshot,
  type AgentGraphReadinessPolicy,
  type AgentGraphReadinessSnapshot,
  type AgentGraphRunnableIntent,
} from './stream-graph-readiness.js';
import type { AgentGraphTraceTopology } from './stream-graph-trace.js';

export interface AgentGraphIntentExecutor {
  runClaimedAgentGraphIntent(
    input: RunClaimedAgentGraphIntentInput,
  ): Promise<ClaimedAgentGraphIntentResult>;
}

export interface ResolveAgentGraphPoliciesInput {
  projection: AgentGraphProjection;
  claims: readonly AgentGraphIntentClaim[];
}

export interface RenderAgentGraphIntentPromptInput {
  intent: AgentGraphRunnableIntent;
  triggerRecords: readonly AgentGraphRecord[];
}

export interface AgentGraphSupervisorObservation {
  projection: AgentGraphProjection;
  readiness: AgentGraphReadinessSnapshot;
  claims: readonly AgentGraphIntentClaim[];
}

export interface AgentGraphSupervisorActivationReady {
  intent: AgentGraphRunnableIntent;
  claim: AgentGraphIntentClaim;
  runtime: Parameters<NonNullable<RunClaimedAgentGraphIntentInput['onReady']>>[0];
}

export interface AgentGraphSupervisorRuntimeEvent {
  intent: AgentGraphRunnableIntent;
  claim: AgentGraphIntentClaim;
  event: SessionEvent;
}

/**
 * Presentation-only observer for the main-agent supervisor.
 *
 * The driver never awaits these callbacks and ignores observer failures, so
 * supervision stays beside the graph instead of becoming a data-path gate.
 */
export interface AgentGraphSupervisorObserver {
  onObservation?(observation: AgentGraphSupervisorObservation): void | Promise<void>;
  onActivationReady?(activation: AgentGraphSupervisorActivationReady): void | Promise<void>;
  onRuntimeEvent?(event: AgentGraphSupervisorRuntimeEvent): void | Promise<void>;
  onReconciliationFailure?(
    failure: import('./stream-graph-schedule-reconcile.js').AgentGraphScheduleReconciliationFailure,
  ): void | Promise<void>;
}

export interface RunAgentGraphToQuiescenceInput {
  topology: AgentGraphTraceTopology;
  runStore: Pick<AgentRunStore, 'listSessionRuns'>;
  runtimeEventStore: Pick<RuntimeEventStore, 'readImmutableRuntimeEvents'>;
  claimStore: AgentGraphIntentClaimStore;
  executor: AgentGraphIntentExecutor;
  newId: () => string;
  /**
   * Hard bound on claims first created by this invocation.
   *
   * Existing durable claims remain recoverable even when the budget is zero.
   * Resource permits and fairness are deliberately outside this structural
   * scheduling boundary.
   */
  maxNewActivations: number;
  resolvePolicies(
    input: ResolveAgentGraphPoliciesInput,
  ): readonly AgentGraphReadinessPolicy[] | Promise<readonly AgentGraphReadinessPolicy[]>;
  renderPrompt(input: RenderAgentGraphIntentPromptInput): string | Promise<string>;
  abortSignal?: AbortSignal;
  supervisor?: AgentGraphSupervisorObserver;
}

export interface AgentGraphDispatchedActivation {
  intent: AgentGraphRunnableIntent;
  claim: AgentGraphIntentClaim;
  claimCreated: boolean;
  result: ClaimedAgentGraphIntentResult;
}

export interface AgentGraphDispatchFailure {
  intent: AgentGraphRunnableIntent;
  error: unknown;
  /**
   * Present when durable admission completed before execution failed.
   */
  claim?: AgentGraphIntentClaim;
  claimCreated?: boolean;
}

export interface AgentGraphQuiescenceResult {
  /**
   * `quiescent` is not graph-wide completion. Topology/admission closure remains
   * a separate future protocol.
   */
  status: 'quiescent' | 'limit_reached' | 'failed' | 'cancelled';
  newActivationCount: number;
  observedExistingActivationCount: number;
  dispatches: AgentGraphDispatchedActivation[];
  failures: AgentGraphDispatchFailure[];
  projection: AgentGraphProjection;
  readiness: AgentGraphReadinessSnapshot;
}

interface GraphObservation {
  projection: AgentGraphProjection;
  readiness: AgentGraphReadinessSnapshot;
  claims: AgentGraphIntentClaim[];
}

interface PreparedDispatch {
  intent: AgentGraphRunnableIntent;
  prompt: string;
}

type DispatchOutcome =
  | {
      status: 'fulfilled';
      dispatch: AgentGraphDispatchedActivation;
    }
  | {
      status: 'rejected';
      failure: AgentGraphDispatchFailure;
    };

/**
 * Repeatedly reconstructs graph state from durable Runtime facts and executes
 * newly runnable work until no unobserved intent remains.
 *
 * The driver owns no execution ledger. Intent claims are durable admission
 * authority; AgentRun/RuntimeEvent stores remain execution authority.
 */
export async function runAgentGraphToQuiescence(
  input: RunAgentGraphToQuiescenceInput,
): Promise<AgentGraphQuiescenceResult> {
  if (!Number.isSafeInteger(input.maxNewActivations) || input.maxNewActivations < 0) {
    throw new Error('Agent graph maxNewActivations must be a non-negative safe integer');
  }

  const processedIntentIds = new Set<string>();
  const dispatches: AgentGraphDispatchedActivation[] = [];
  const failures: AgentGraphDispatchFailure[] = [];
  let newActivationCount = 0;
  let observedExistingActivationCount = 0;
  let observation = await observeGraph(input);

  while (true) {
    if (input.abortSignal?.aborted) {
      return graphResult(
        'cancelled',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        failures,
        observation,
      );
    }

    const existingIntentIds = new Set(observation.claims.map((claim) => claim.intentId));
    const candidates = orderedRunnableIntents(observation.readiness).filter(
      (intent) => !processedIntentIds.has(intent.intentId),
    );
    const selected: AgentGraphRunnableIntent[] = [];
    let deferredByLimit = false;
    for (const intent of candidates) {
      if (
        existingIntentIds.has(intent.intentId) ||
        newActivationCount + selectedNewIntentCount(selected, existingIntentIds) <
          input.maxNewActivations
      ) {
        selected.push(intent);
      } else {
        deferredByLimit = true;
      }
    }

    if (selected.length === 0) {
      return graphResult(
        deferredByLimit ? 'limit_reached' : 'quiescent',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        failures,
        observation,
      );
    }

    const rendered = await Promise.allSettled(
      selected.map(async (intent): Promise<PreparedDispatch> => {
        const prompt = await input.renderPrompt(
          clonePlain({
            intent,
            triggerRecords: resolveTriggerRecords(observation.projection, intent),
          }),
        );
        if (!prompt.trim()) {
          throw new Error(`Agent graph intent ${intent.intentId} rendered an empty prompt`);
        }
        return { intent, prompt };
      }),
    );
    const prepared: PreparedDispatch[] = [];
    rendered.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        prepared.push(result.value);
      } else {
        failures.push({ intent: selected[index]!, error: result.reason });
      }
    });
    if (failures.length > 0) {
      observation = await observeGraph(input);
      return graphResult(
        input.abortSignal?.aborted ? 'cancelled' : 'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        failures,
        observation,
      );
    }

    const outcomes = await Promise.all(prepared.map((dispatch) => dispatchIntent(input, dispatch)));
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        dispatches.push(outcome.dispatch);
        processedIntentIds.add(outcome.dispatch.intent.intentId);
        if (outcome.dispatch.claimCreated) newActivationCount += 1;
        else observedExistingActivationCount += 1;
      } else {
        failures.push(outcome.failure);
        if (outcome.failure.claim) {
          processedIntentIds.add(outcome.failure.intent.intentId);
          if (outcome.failure.claimCreated) newActivationCount += 1;
          else observedExistingActivationCount += 1;
        }
      }
    }

    observation = await observeGraph(input);
    if (failures.length > 0) {
      return graphResult(
        input.abortSignal?.aborted ? 'cancelled' : 'failed',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        failures,
        observation,
      );
    }
    if (deferredByLimit && newActivationCount >= input.maxNewActivations) {
      return graphResult(
        'limit_reached',
        newActivationCount,
        observedExistingActivationCount,
        dispatches,
        failures,
        observation,
      );
    }
  }
}

async function observeGraph(input: RunAgentGraphToQuiescenceInput): Promise<GraphObservation> {
  const [projection, listedClaims] = await Promise.all([
    readCommittedAgentGraphProjection({
      graphId: input.topology.graphId,
      operators: input.topology.operators,
      runStore: input.runStore,
      runtimeEventStore: input.runtimeEventStore,
    }),
    input.claimStore.listAgentGraphIntentClaims(input.topology.graphId),
  ]);
  const claims = listedClaims
    .map((claim) => {
      const decoded = decodeAgentGraphIntentClaim(claim);
      if (decoded.graphId !== input.topology.graphId) {
        throw new Error(
          `Graph claim ${decoded.claimId} belongs to ${decoded.graphId}, expected ${input.topology.graphId}`,
        );
      }
      return decoded;
    })
    .sort(
      (a, b) =>
        compareAgentGraphIdentity(a.intentId, b.intentId) ||
        compareAgentGraphIdentity(a.claimId, b.claimId),
    );
  assertUniqueClaimIntents(claims);
  const policies = await input.resolvePolicies(clonePlain({ projection, claims }));
  const readiness = buildAgentGraphReadinessSnapshot({
    topology: input.topology,
    records: projection.records,
    policies,
  });
  notifySupervisor(input.supervisor?.onObservation, {
    projection,
    readiness,
    claims,
  });
  return { projection, readiness, claims };
}

async function dispatchIntent(
  input: RunAgentGraphToQuiescenceInput,
  prepared: PreparedDispatch,
): Promise<DispatchOutcome> {
  let admission:
    | {
        claim: AgentGraphIntentClaim;
        created: boolean;
      }
    | undefined;
  try {
    if (input.abortSignal?.aborted) {
      throw new Error('Agent graph dispatch was cancelled before admission');
    }
    const claimed = await claimAgentGraphRunnableIntent({
      intent: prepared.intent,
      store: input.claimStore,
      newId: input.newId,
      executionInput: { prompt: prepared.prompt },
    });
    admission = claimed;
    const result = await input.executor.runClaimedAgentGraphIntent({
      claimStore: input.claimStore,
      intent: prepared.intent,
      graphId: prepared.intent.graphId,
      intentId: prepared.intent.intentId,
      prompt: prepared.prompt,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      onReady(runtime) {
        notifySupervisor(input.supervisor?.onActivationReady, {
          intent: prepared.intent,
          claim: claimed.claim,
          runtime,
        });
      },
      onEvent(event) {
        notifySupervisor(input.supervisor?.onRuntimeEvent, {
          intent: prepared.intent,
          claim: claimed.claim,
          event,
        });
      },
    });
    return {
      status: 'fulfilled',
      dispatch: {
        intent: prepared.intent,
        claim: claimed.claim,
        claimCreated: claimed.created,
        result,
      },
    };
  } catch (error) {
    return {
      status: 'rejected',
      failure: admission
        ? {
            intent: prepared.intent,
            error,
            claim: admission.claim,
            claimCreated: admission.created,
          }
        : {
            intent: prepared.intent,
            error,
          },
    };
  }
}

function orderedRunnableIntents(
  readiness: AgentGraphReadinessSnapshot,
): AgentGraphRunnableIntent[] {
  const topologicalIndex = new Map(
    readiness.trace.topologicalOrder.map((operatorId, index) => [operatorId, index]),
  );
  const intents = Object.values(readiness.readiness).flatMap((state) => state.intents);
  return intents.sort(
    (a, b) =>
      topologicalIndex.get(a.operatorId)! - topologicalIndex.get(b.operatorId)! ||
      compareAgentGraphIdentity(a.readinessId, b.readinessId) ||
      compareAgentGraphIdentity(a.intentId, b.intentId),
  );
}

function selectedNewIntentCount(
  selected: readonly AgentGraphRunnableIntent[],
  existingIntentIds: ReadonlySet<string>,
): number {
  return selected.filter((intent) => !existingIntentIds.has(intent.intentId)).length;
}

function resolveTriggerRecords(
  projection: AgentGraphProjection,
  intent: AgentGraphRunnableIntent,
): AgentGraphRecord[] {
  const recordsById = new Map(projection.records.map((record) => [record.recordId, record]));
  return intent.triggerRecordIds.map((recordId) => {
    const record = recordsById.get(recordId);
    if (!record) {
      throw new Error(
        `Agent graph intent ${intent.intentId} references missing record ${recordId}`,
      );
    }
    return record;
  });
}

function assertUniqueClaimIntents(claims: readonly AgentGraphIntentClaim[]): void {
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.intentId)) {
      throw new Error(`Graph intent ${claim.graphId}/${claim.intentId} has multiple claims`);
    }
    seen.add(claim.intentId);
  }
}

function graphResult(
  status: AgentGraphQuiescenceResult['status'],
  newActivationCount: number,
  observedExistingActivationCount: number,
  dispatches: readonly AgentGraphDispatchedActivation[],
  failures: readonly AgentGraphDispatchFailure[],
  observation: GraphObservation,
): AgentGraphQuiescenceResult {
  return {
    status,
    newActivationCount,
    observedExistingActivationCount,
    dispatches: [...dispatches],
    failures: [...failures],
    projection: observation.projection,
    readiness: observation.readiness,
  };
}

function notifySupervisor<T>(
  observer: ((input: T) => void | Promise<void>) | undefined,
  value: T,
): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer(clonePlain(value))).catch(() => {
      // Presentation-only supervision must not gate graph execution.
    });
  } catch {
    // Presentation-only supervision must not gate graph execution.
  }
}

function clonePlain<T>(value: T): T {
  return structuredClone(value);
}
