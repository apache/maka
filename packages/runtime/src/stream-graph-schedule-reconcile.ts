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

import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimResult,
} from '@maka/core/agent-graph-control';
import {
  AgentGraphScheduleRevisionConflictError,
  type AgentGraphScheduleControlStore,
  type AgentGraphSelectedResultInput,
  type AgentGraphScheduleUpdate,
  type AgentGraphScheduleUpdateSource,
} from '@maka/core/agent-graph-schedule';
import type {
  AgentGraphOperatorProvision,
  AgentGraphProvisionedEdge,
} from '@maka/core/agent-graph-topology';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeMessageRunIdentity } from './message-authority.js';
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
// A failed control pass can park the wave it is stopping, and nothing else may
// wake it. Retry with a capped backoff while that wave is still running.
const CONTROL_RETRY_INITIAL_DELAY_MS = 100;
const CONTROL_RETRY_MAX_DELAY_MS = 5_000;
// The eighth consecutive failure of a stop or a control read lands about 11 s
// after the first, once the backoff has reached its cap: a fault that clears
// during the ramp is never reported as stuck, while a persistent one is
// surfaced instead of leaving the graph parked behind a single failure record.
const CONTROL_STUCK_FAILURES = 8;

export interface AgentGraphScheduleStopController {
  stopAgentGraphActivation(
    identity: RuntimeMessageRunIdentity,
    input: { source: 'graph_supervisor' },
  ): Promise<void>;
  /**
   * Whether a failed stop left cleanup retained for this exact activation. A
   * terminal activation without it resolves without another runtime stop.
   */
  hasPendingAgentGraphActivationStop?(identity: RuntimeMessageRunIdentity): boolean;
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
  /** Read-only presentation observation of the complete schedule used by each wave. */
  onScheduleObserved?(schedule: AgentGraphScheduleProjection): void | Promise<void>;
  provisionOperator?(
    input: ProvisionAgentGraphOperatorInput,
  ): Promise<ProvisionAgentGraphOperatorResult>;
  hydrateInputHandoffs?(records: readonly AgentGraphRecord[]): Promise<AgentGraphInputHandoff[]>;
  resolveSelectedResultInputs?(
    inputs: readonly AgentGraphSelectedResultInput[],
  ): Promise<readonly AgentGraphRecord[]>;
  renderPrompt(input: RenderAgentGraphScheduledWorkPromptInput): string | Promise<string>;
  abortSignal?: AbortSignal;
  subscribeToScheduleChanges?(listener: () => void): () => void;
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
  selectedResultRecords: Map<string, AgentGraphRecord>;
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

  const wake = createReconciliationWake();
  // Install before reading the durable schedule: a commit during any await
  // remains pending until this reconciliation consumes it.
  const unsubscribe = input.subscribeToScheduleChanges?.(wake.notify);
  try {
    return await reconcileSchedule(input, wake);
  } finally {
    unsubscribe?.();
  }
}

function createReconciliationWake() {
  let pending = false;
  let resolve!: () => void;
  let next = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    notify() {
      pending = true;
      resolve();
    },
    async wait() {
      if (!pending) await next;
      pending = false;
      next = new Promise<void>((done) => {
        resolve = done;
      });
    },
  };
}

async function reconcileSchedule(
  input: ReconcileAgentGraphScheduleInput,
  wake: ReturnType<typeof createReconciliationWake>,
): Promise<AgentGraphScheduleReconciliationResult> {
  const processedIntentIds = new Set<string>();
  const dispatches: AgentGraphDispatchedActivation[] = [];
  const stops: AgentGraphScheduleStopResult[] = [];
  const failures: AgentGraphScheduleReconciliationFailure[] = [];
  // Resolved historical results are immutable for the lifetime of one
  // reconciliation; cache them per source graph so repeated snapshot reads do
  // not replay the full committed projection of a closed epoch.
  const selectedResultCache: SelectedResultCache = new Map();
  // Exact stops that already succeeded in this reconciliation; later passes
  // and wakes do not stop the same activation again.
  const resolvedStops = new Set<string>();
  // Consecutive stop failures per target, reset when the target resolves.
  const stopFailureStreaks = new Map<string, number>();
  let newActivationCount = 0;
  let observedExistingActivationCount = 0;
  let snapshot = await readScheduleSnapshot(input, selectedResultCache);

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

    const stopWave = await applyScheduleStops(input, snapshot, resolvedStops);
    recordScheduleStops(input, stops, failures, stopFailureStreaks, stopWave);
    if (failures.length > 0) {
      snapshot = await readScheduleSnapshot(input, selectedResultCache);
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
    for (const record of snapshot.selectedResultRecords.values()) {
      if (committedRecords.has(record.recordId)) {
        throw new Error(
          `Selected graph result id ${record.recordId} collides with the current graph`,
        );
      }
    }
    const deferredWork: AgentGraphScheduleDeferredWork[] = [];
    let topologyChanged = false;
    let topologyStale = false;

    for (const work of orderedRequestedWork(snapshot.schedule)) {
      if (work.target.kind === 'operator' || provisionsByWork.has(work.workId)) continue;
      if (snapshot.schedule.closed) {
        deferredWork.push({ work, reason: 'graph_closed' });
        continue;
      }
      const missingInputIds = missingWorkInputIds(
        work,
        committedRecords,
        snapshot.selectedResultRecords,
      );
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
      snapshot = await readScheduleSnapshot(input, selectedResultCache);
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
      const missingInputIds = missingWorkInputIds(
        work,
        committedRecords,
        snapshot.selectedResultRecords,
      );
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
      snapshot = await readScheduleSnapshot(input, selectedResultCache);
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
        const inputRecords = [
          ...work.inputIds.map((recordId) => clonePlain(committedRecords.get(recordId)!)),
          ...(work.selectedResultInputs ?? []).map((selected) =>
            clonePlain(snapshot.selectedResultRecords.get(selectedResultKey(selected))!),
          ),
        ];
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
      snapshot = await readScheduleSnapshot(input, selectedResultCache);
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

    let waveSettled = false;
    const wave = Promise.all(
      prepared.map(async (work) => {
        const outcome = await dispatchScheduledWork(input, work, snapshot.schedule.revision);
        if (outcome.status === 'rejected') {
          notifySupervisor(input.supervisor?.onReconciliationFailure, outcome.failure);
        }
        return outcome;
      }),
    ).finally(() => {
      waveSettled = true;
      wake.notify();
    });
    let controlReadFailure: AgentGraphScheduleReconciliationFailure | undefined;
    let controlReadFailureStreak = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = CONTROL_RETRY_INITIAL_DELAY_MS;
    try {
      // A driver abort does not end this loop: the wave still owns its
      // dispatches, and a child parked behind a failed stop settles only
      // after a retry succeeds.
      while (!waveSettled) {
        await wake.wait();
        clearTimeout(retryTimer);
        retryTimer = undefined;
        if (waveSettled) break;
        let retry: boolean;
        try {
          const latest = await readScheduleSnapshot(input, selectedResultCache);
          const controls = await applyScheduleStops(input, latest, resolvedStops);
          recordScheduleStops(input, stops, failures, stopFailureStreaks, controls);
          if (controlReadFailure) {
            failures.splice(failures.indexOf(controlReadFailure), 1);
            controlReadFailure = undefined;
          }
          controlReadFailureStreak = 0;
          retry = controls.failures.length > 0;
        } catch (error) {
          if (controlReadFailure) failures.splice(failures.indexOf(controlReadFailure), 1);
          controlReadFailureStreak += 1;
          // Like a stop, a read failure notifies on its first occurrence and,
          // once, when it has persisted long enough to be stuck.
          controlReadFailure =
            controlReadFailureStreak < CONTROL_STUCK_FAILURES
              ? { phase: 'schedule', error }
              : {
                  phase: 'schedule',
                  error: new Error(
                    `Reading graph schedule controls is stuck after ${controlReadFailureStreak} consecutive failures and is still retrying`,
                    { cause: error },
                  ),
                };
          failures.push(controlReadFailure);
          if (
            controlReadFailureStreak === 1 ||
            controlReadFailureStreak === CONTROL_STUCK_FAILURES
          ) {
            notifySupervisor(input.supervisor?.onReconciliationFailure, controlReadFailure);
          }
          retry = true;
        }
        // A failed stop can keep its child, and so this wave, parked until a
        // retry succeeds. Back off instead of waiting for another commit.
        if (retry) {
          retryTimer = setTimeout(wake.notify, retryDelay);
          retryDelay = Math.min(retryDelay * 2, CONTROL_RETRY_MAX_DELAY_MS);
        } else {
          retryDelay = CONTROL_RETRY_INITIAL_DELAY_MS;
        }
      }
    } finally {
      clearTimeout(retryTimer);
      // This wave remains the sole owner of all dispatched executions, even
      // if a control-store read fails while processing a schedule wake.
      await wave;
    }
    const outcomes = await wave;
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

    const nextSnapshot = await readScheduleSnapshot(input, selectedResultCache);
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

  snapshot = await readScheduleSnapshot(input, selectedResultCache);
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
  selectedResultCache: SelectedResultCache,
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
  const schedule = projectAgentGraphSchedule(input.topology.graphId, updates);
  notifySupervisor(input.onScheduleObserved, schedule);
  const selectedInputs = schedule.work
    .filter((work) => work.status === 'requested')
    .flatMap((work) => work.selectedResultInputs ?? []);
  const selectedResultRecords = await resolveSelectedResultRecords(
    input,
    selectedInputs,
    selectedResultCache,
  );
  return {
    schedule,
    observation,
    claims,
    topology,
    provisions,
    sourceByWorkId: scheduleSourceByWorkId(updates),
    selectedResultRecords,
  };
}

/** Missing inputs include unresolved selected historical result ids so an
 * unresolvable source defers its own work item via `input_not_committed`. */
function missingWorkInputIds(
  work: AgentGraphScheduleWorkView,
  committedRecords: ReadonlyMap<string, AgentGraphRecord>,
  selectedResultRecords: ReadonlyMap<string, AgentGraphRecord>,
): string[] {
  return [
    ...work.inputIds.filter((recordId) => !committedRecords.has(recordId)),
    ...(work.selectedResultInputs ?? [])
      .filter((selected) => !selectedResultRecords.has(selectedResultKey(selected)))
      .map((selected) => selected.resultId),
  ];
}

/** Historical resolution attempts keyed by source graph id, then result id. */
type SelectedResultCache = Map<string, Map<string, AgentGraphRecord | undefined>>;

/**
 * Resolves selected historical result inputs, isolating failures per source
 * graph: an unresolvable source omits its records so dependent work items
 * defer with `input_not_committed` instead of wedging the whole graph.
 * Contract violations that commit-time authorization already rejected
 * (missing resolver, ambiguous result ids) still throw.
 */
async function resolveSelectedResultRecords(
  input: ReconcileAgentGraphScheduleInput,
  selectedInputs: readonly AgentGraphSelectedResultInput[],
  cache: SelectedResultCache,
): Promise<Map<string, AgentGraphRecord>> {
  if (selectedInputs.length === 0) return new Map();
  if (!input.resolveSelectedResultInputs) {
    throw new Error('Selected graph result inputs require a Runtime Host resolver');
  }
  const distinct = [
    ...new Map(
      selectedInputs.map((selected) => [
        `${selected.sourceGraphId}\u0000${selected.resultId}`,
        selected,
      ]),
    ).values(),
  ];
  const bySource = new Map<string, AgentGraphSelectedResultInput[]>();
  for (const selected of distinct) {
    const group = bySource.get(selected.sourceGraphId);
    if (group) {
      group.push(selected);
    } else {
      bySource.set(selected.sourceGraphId, [selected]);
    }
  }
  for (const [sourceGraphId, group] of bySource) {
    let cached = cache.get(sourceGraphId);
    if (!cached) {
      cached = new Map();
      cache.set(sourceGraphId, cached);
    }
    const pending = group.filter((selected) => !cached.has(selected.resultId));
    if (pending.length === 0) continue;
    // Cache unsuccessful attempts for this reconciliation too. Repeated
    // snapshot reads must not replay a resolver that already failed or
    // returned records that violate its identity contract.
    pending.forEach((selected) => cached.set(selected.resultId, undefined));
    let records: readonly AgentGraphRecord[];
    try {
      records = await input.resolveSelectedResultInputs(pending);
    } catch {
      continue;
    }
    if (
      records.length !== pending.length ||
      records.some((record, index) => {
        const selected = pending[index]!;
        return record.graphId !== selected.sourceGraphId || record.recordId !== selected.resultId;
      })
    ) {
      continue;
    }
    records.forEach((record) => cached.set(record.recordId, record));
  }
  const resolved = new Map<string, AgentGraphRecord>();
  const sourceByRecordId = new Map<string, string>();
  for (const selected of distinct) {
    const record = cache.get(selected.sourceGraphId)?.get(selected.resultId);
    if (!record) continue;
    const previousSource = sourceByRecordId.get(record.recordId);
    if (previousSource !== undefined && previousSource !== record.graphId) {
      throw new Error(`Selected graph result id ${record.recordId} is ambiguous`);
    }
    sourceByRecordId.set(record.recordId, record.graphId);
    resolved.set(selectedResultKey(selected), clonePlain(record));
  }
  return resolved;
}

function selectedResultKey(selected: AgentGraphSelectedResultInput): string {
  return `${selected.sourceGraphId}\u0000${selected.resultId}`;
}

function recordScheduleStops(
  input: ReconcileAgentGraphScheduleInput,
  stops: AgentGraphScheduleStopResult[],
  failures: AgentGraphScheduleReconciliationFailure[],
  streaks: Map<string, number>,
  controls: {
    stops: AgentGraphScheduleStopResult[];
    failures: AgentGraphScheduleReconciliationFailure[];
  },
): void {
  stops.push(...controls.stops);
  const resolvedTargets = new Set(controls.stops.map((stop) => stop.targetId));
  for (const targetId of resolvedTargets) streaks.delete(targetId);
  for (let index = failures.length - 1; index >= 0; index -= 1) {
    const failure = failures[index]!;
    if (failure.phase === 'stop' && failure.targetId && resolvedTargets.has(failure.targetId)) {
      failures.splice(index, 1);
    }
  }
  for (const failure of controls.failures) {
    const targetId = failure.targetId ?? '';
    const streak = (streaks.get(targetId) ?? 0) + 1;
    streaks.set(targetId, streak);
    // The stuck state travels in the message: supervisor notifications are
    // structured clones and the durable client failure keeps only the reason.
    const recorded: AgentGraphScheduleReconciliationFailure =
      streak < CONTROL_STUCK_FAILURES
        ? failure
        : {
            ...failure,
            error: new Error(
              `Stop for graph target ${targetId} is stuck after ${streak} consecutive failures and is still retrying`,
              { cause: failure.error },
            ),
          };
    // A retried stop that fails again replaces its earlier failure. The
    // supervisor hears about the first failure and, once, about a stuck stop,
    // not about every backoff attempt.
    const previous = failures.findIndex(
      (existing) => existing.phase === 'stop' && existing.targetId === failure.targetId,
    );
    if (previous >= 0) failures[previous] = recorded;
    else failures.push(recorded);
    if (streak === 1 || streak === CONTROL_STUCK_FAILURES) {
      notifySupervisor(input.supervisor?.onReconciliationFailure, recorded);
    }
  }
}

async function applyScheduleStops(
  input: ReconcileAgentGraphScheduleInput,
  snapshot: ScheduleSnapshot,
  resolvedStops: Set<string>,
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
  const targets: Array<{
    targetId: string;
    reason: string;
    identity: RuntimeMessageRunIdentity;
    status: 'stopped' | 'already_terminal';
  }> = [];
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
      const identity = {
        sessionId: activation.sessionId,
        runId: activation.activationId,
        turnId: activation.turnId,
      };
      // A durable terminal does not prove that backend cleanup succeeded.
      // Retry the exact stop only while a failed stop retains cleanup for this
      // Run; a settled historical target resolves without a runtime call.
      if (
        resolvedStops.has(stopTargetKey(targetId, identity)) ||
        !input.stopController.hasPendingAgentGraphActivationStop?.(identity)
      ) {
        immediate.push({
          targetId,
          reason,
          status: 'already_terminal',
          sessionId: activation.sessionId,
          activationId: activation.activationId,
        });
        continue;
      }
      targets.push({ targetId, reason, status: 'already_terminal', identity });
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
    const turnId = activation?.turnId ?? claim!.targetTurnId;
    const identity = { sessionId, runId: activationId, turnId };
    if (resolvedStops.has(stopTargetKey(targetId, identity))) {
      immediate.push({ targetId, reason, status: 'stopped', sessionId, activationId });
      continue;
    }
    targets.push({ targetId, reason, status: 'stopped', identity });
  }

  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<AgentGraphScheduleStopResult> => {
      await input.stopController.stopAgentGraphActivation(target.identity, {
        source: 'graph_supervisor',
      });
      return {
        targetId: target.targetId,
        reason: target.reason,
        status: target.status,
        sessionId: target.identity.sessionId,
        activationId: target.identity.runId,
      };
    }),
  );
  settled.forEach((result, index) => {
    const target = targets[index]!;
    if (result.status === 'fulfilled') {
      resolvedStops.add(stopTargetKey(target.targetId, target.identity));
      immediate.push(result.value);
      return;
    }
    failures.push({
      phase: 'stop',
      targetId: target.targetId,
      error: new Error(
        `Failed to stop graph supervisor target ${target.targetId} in ${target.identity.sessionId}`,
        { cause: result.reason },
      ),
    });
  });
  return {
    stops: immediate.sort((a, b) => compareIdentity(a.targetId, b.targetId)),
    failures,
  };
}

function stopTargetKey(targetId: string, identity: RuntimeMessageRunIdentity): string {
  return [targetId, identity.sessionId, identity.runId, identity.turnId].join('\u0000');
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
    ...(work.selectedResultInputs?.length
      ? { selectedResultInputs: work.selectedResultInputs }
      : {}),
    ...(work.replaces ? { replaces: work.replaces } : {}),
  });
  const readinessContextFingerprint = stableHash({
    schemaVersion: SCHEDULE_INTENT_SCHEMA_VERSION,
    graphId: topology.graphId,
    workId: work.workId,
    operatorId,
    targetSessionId: topologyBinding.sessionId,
    inputIds: work.inputIds,
    ...(work.selectedResultInputs?.length
      ? { selectedResultInputs: work.selectedResultInputs }
      : {}),
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
    triggerRecordIds: [
      ...work.inputIds,
      ...(work.selectedResultInputs ?? []).map((input) => input.resultId),
    ],
  };
}

export function scheduledWorkIntentId(graphId: string, workId: string): string {
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
    ...(work.target.executorId ? { executorId: work.target.executorId } : {}),
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
    turnId: string;
    status: string;
  }
> {
  const targets = new Map<
    string,
    {
      sessionId: string;
      activationId: string;
      turnId: string;
      status: string;
    }
  >();
  const sourceByActivation = new Map(
    observation.projection.records.map((record) => [record.activationId, record.source]),
  );
  for (const binding of observation.projection.operators) {
    const state = observation.projection.state.operators[binding.operatorId];
    for (const activation of Object.values(state?.activations ?? {})) {
      if (targets.has(activation.activationId)) {
        throw new Error(
          `Graph activation ${activation.activationId} belongs to multiple operators`,
        );
      }
      const source = sourceByActivation.get(activation.activationId);
      if (!source) throw new Error(`Graph activation ${activation.activationId} has no source`);
      targets.set(activation.activationId, {
        sessionId: binding.sessionId,
        activationId: activation.activationId,
        turnId: source.turnId,
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
