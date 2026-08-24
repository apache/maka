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

import type { AgentGraphClientProjectionStore } from '@maka/core/agent-graph-client-projection';
import type { AgentGraphIntentClaim } from '@maka/core/agent-graph-control';
import type { AgentGraphEpochBinding, AgentGraphEpochStore } from '@maka/core/agent-graph-epoch';
import type { AgentGraphEpochPage } from '@maka/core/agent-graph-epoch';
import type {
  AgentGraphScheduleControlStore,
  AgentGraphSelectedResultInput,
  AgentGraphScheduleUpdate,
} from '@maka/core/agent-graph-schedule';
import type { AgentGraphTimelineMetadataStore } from '@maka/core/agent-graph-timeline';
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import type { AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { SessionHeader } from '@maka/core/session';
import {
  AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
  AgentGraphClientProjectionConflictError,
  AgentGraphClientTerminalCursorError,
} from '@maka/core/agent-graph-client-projection';
import { decodeAgentGraphIntentClaim } from '@maka/core/agent-graph-control';
import type { MakaTool } from './tool-runtime.js';
import type { SessionManager } from './session-manager.js';
import {
  readCommittedAgentGraphProjection,
  type AgentGraphRecord,
} from './stream-graph-projection.js';
import {
  hydrateAgentGraphInputHandoffs,
  renderAgentGraphScheduledWorkPrompt,
} from './stream-graph-handoff.js';
import { buildAgentGraphReadinessSnapshot } from './stream-graph-readiness.js';
import type {
  AgentGraphSupervisorObservation,
  AgentGraphSupervisorObserver,
  AgentGraphSupervisorRuntimeEvent,
} from './stream-graph-dispatch.js';
import {
  reconcileAgentGraphSchedule,
  type AgentGraphScheduleReconciliationFailure,
  type AgentGraphScheduleReconciliationResult,
  type RenderAgentGraphScheduledWorkPromptInput,
} from './stream-graph-schedule-reconcile.js';
import {
  AGENT_GRAPH_CLIENT_TERMINAL_PAGE_SIZE,
  advanceMaterializedAgentGraphClientProjection,
  buildAgentGraphClientSnapshot,
  decodeAgentGraphTerminalCursor,
  decodeMaterializedAgentGraphClientActivity,
  decodeMaterializedAgentGraphClientSnapshot,
  decodeMaterializedAgentGraphOperatorInspection,
  materializeAgentGraphClientProjection,
  materializedAgentGraphTerminalHistoryPage,
  type AgentGraphClientSnapshot,
  type AgentGraphClientReconciliationFailure,
  type AgentGraphClientSnapshotOptions,
  type AgentGraphOperatorInspection,
  type BuildAgentGraphClientReadModelInput,
} from './stream-graph-read-model.js';
import {
  buildAgentGraphSupervisorTools,
  projectAgentGraphSchedule,
  type AgentGraphYieldPermit,
} from './stream-graph-supervisor-tools.js';
import type { AgentGraphTraceTopology } from './stream-graph-trace.js';
import { stableHash } from './request-shape.js';
import {
  readAgentGraphTimelinePage,
  type AgentGraphTimelinePage,
  type AgentGraphTimelinePageOptions,
} from './agent-graph-timeline.js';
import { isAgentGraphSupervisorMilestone } from './agent-graph-supervisor-wake.js';
import { buildAgentSwarmStatusTool, projectAgentSwarmStatus } from './agent-swarm-status-tool.js';

const DEFAULT_MAX_NEW_ACTIVATIONS = 32;
const MAX_CLIENT_PROJECTION_COMMIT_ATTEMPTS = 4;

export interface AgentGraphCoordinatorSessionStore {
  listForRecovery(): Promise<SessionHeader[]>;
  readHeader(sessionId: string): Promise<SessionHeader>;
}

export interface AgentGraphCoordinatorRuntime {
  provisionAgentGraphOperator: SessionManager['provisionAgentGraphOperator'];
  runClaimedAgentGraphIntent: SessionManager['runClaimedAgentGraphIntent'];
  stopSession: SessionManager['stopSession'];
}

export interface AgentGraphCoordinatorInput {
  sessionStore: AgentGraphCoordinatorSessionStore;
  runStore: Pick<AgentRunStore, 'listSessionRuns'>;
  runtimeEventStore: Pick<RuntimeEventStore, 'readImmutableRuntimeEvents'>;
  controlStore: AgentGraphScheduleControlStore &
    AgentGraphClientProjectionStore &
    AgentGraphTimelineMetadataStore;
  /** Durable root-to-graph identity authority. Omitted only by legacy embedded callers. */
  epochStore?: AgentGraphEpochStore;
  runtime: AgentGraphCoordinatorRuntime;
  newId: () => string;
  /** Keep an external host alive while one reconciliation driver owns runtime work. */
  acquireResidency?(rootSessionId: string): { release(): void };
  /** Restrict an attempt-local coordinator to exactly one root Session graph. */
  rootSessionId?: string;
  maxNewActivations?: number;
  renderPrompt?(input: RenderAgentGraphScheduledWorkPromptInput): string | Promise<string>;
  supervisor?: AgentGraphSupervisorObserver;
  onReconciliation?(
    rootSessionId: string,
    result: AgentGraphScheduleReconciliationResult,
  ): void | Promise<void>;
  /** Durable client projection reached a checkpoint before the whole dispatch wave settled. */
  onCheckpoint?(rootSessionId: string): void | Promise<void>;
  onError?(rootSessionId: string, error: unknown): void | Promise<void>;
}

export interface AgentGraphExecutionStopInput {
  expectedGraphId?: string;
  stopSupervisor(): Promise<void>;
  withSupervisorWakesSuppressed(operation: () => Promise<void>): Promise<void>;
}

interface GraphDriver {
  rootSessionId: string;
  graphId: string;
  requested: boolean;
  paused: boolean;
  stopping: boolean;
  stopGeneration: number;
  driveGeneration: number;
  activeDriveGeneration?: number;
  closed: boolean;
  abortController?: AbortController;
  task?: Promise<void>;
  stopTask?: Promise<void>;
  clientProjectionTask?: Promise<void>;
  clientProjectionDirty: boolean;
  runtimeFailureRunIds: Set<string>;
  lastResult?: AgentGraphScheduleReconciliationResult;
  lastError?: unknown;
  yieldWaiters: Set<GraphYieldWaiter>;
}

interface GraphYieldWaiter {
  minimumGeneration: number;
  activationReady: boolean;
  milestoneRevisions: number[];
  proof: Promise<void>;
  resolveProof(): void;
  cancelled: boolean;
}

export type AgentGraphClientChangedReason =
  | 'observation'
  | 'runtime_activity'
  | 'reconciled'
  | 'stopped';

export interface AgentGraphClientChangedEvent {
  schemaVersion: 1;
  rootSessionId: string;
  graphId: string;
  reason: AgentGraphClientChangedReason;
}

export type AgentGraphClientChangedListener = (
  event: AgentGraphClientChangedEvent,
) => void | Promise<void>;

export type AgentGraphClientOperationErrorCode =
  | 'not_found'
  | 'session_archived'
  | 'operation_conflict'
  | 'invalid_request';

export class AgentGraphClientOperationError extends Error {
  readonly name = 'AgentGraphClientOperationError';

  constructor(
    readonly code: AgentGraphClientOperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface AgentGraphClientSubscription {
  rootSessionId?: string;
  listener: AgentGraphClientChangedListener;
}

/**
 * Process-local execution authority for Session-backed agent graphs.
 *
 * Durable schedule/topology/claim rows and Runtime facts remain the recovery
 * authority. This coordinator owns only single-flight wakeups and cancellation
 * handles, so recreating it after a process restart is safe.
 */
export class AgentGraphCoordinator {
  readonly #input: AgentGraphCoordinatorInput;
  readonly #drivers = new Map<string, GraphDriver>();
  readonly #clientSubscriptions = new Set<AgentGraphClientSubscription>();
  #drainTask: Promise<unknown[]> | undefined;
  #closed = false;

  constructor(input: AgentGraphCoordinatorInput) {
    const maxNewActivations = input.maxNewActivations ?? DEFAULT_MAX_NEW_ACTIVATIONS;
    if (!Number.isSafeInteger(maxNewActivations) || maxNewActivations < 0) {
      throw new Error('Agent graph coordinator activation limit must be a non-negative integer');
    }
    if (
      input.rootSessionId !== undefined &&
      (!input.rootSessionId.trim() || input.rootSessionId.trim() !== input.rootSessionId)
    ) {
      throw new Error('Agent graph coordinator root Session scope must be a canonical identity');
    }
    this.#input = { ...input, maxNewActivations };
  }

  /**
   * Return the supervisor-only tools for an ordinary root Session.
   *
   * Child Sessions are graph operators and never receive this control surface.
   */
  async toolsForSession(rootSessionId: string): Promise<MakaTool[]> {
    await this.#assertRootSupervisor(rootSessionId);
    const driver = await this.#driver(rootSessionId);
    return [
      ...buildAgentGraphSupervisorTools({
        graphId: driver.graphId,
        scheduleStore: this.#input.controlStore,
        observeGraph: () => this.observe(rootSessionId),
        listHistoricalSelectedResults: (beforeEpoch) =>
          this.#listHistoricalSelectedResults(rootSessionId, driver.graphId, beforeEpoch),
        prepareYieldPermit: () => this.#prepareYieldPermit(driver),
        authorizeScheduleUpdate: async (request): Promise<ScheduleWakeFence> => {
          if (request.graphId !== driver.graphId || request.source.sessionId !== rootSessionId) {
            throw new Error(
              `Agent graph schedule update is not authorized for root Session ${rootSessionId}`,
            );
          }
          await this.#resolveSelectedResultInputs(
            rootSessionId,
            driver.graphId,
            request.addWork.flatMap((work) => work.selectedResultInputs ?? []),
          );
          return {
            stopGeneration: driver.stopGeneration,
            mayResumePaused: driver.paused && !driver.stopping,
          };
        },
        onScheduleUpdateCommitted: (update, authorization) => {
          this.#assertScheduleOwnedByRoot(update, rootSessionId, driver.graphId);
          this.#wakeFromSchedule(driver, decodeScheduleWakeFence(authorization));
        },
      }),
      buildAgentSwarmStatusTool({ readSnapshot: () => this.getSnapshot(rootSessionId) }),
    ];
  }

  /**
   * Read one bounded snapshot entirely from durable topology, schedule,
   * admission, AgentRun, and RuntimeEvent facts.
   */
  async getSnapshot(
    rootSessionId: string,
    options: AgentGraphClientSnapshotOptions = {},
  ): Promise<AgentGraphClientSnapshot> {
    const graphId = await this.currentGraphId(rootSessionId);
    return this.getGraphSnapshot(rootSessionId, graphId, options);
  }

  async getGraphSnapshot(
    rootSessionId: string,
    graphId: string,
    options: AgentGraphClientSnapshotOptions = {},
  ): Promise<AgentGraphClientSnapshot> {
    await this.#assertGraphBelongsToRoot(rootSessionId, graphId);
    let before: ReturnType<typeof decodeAgentGraphTerminalCursor> | undefined;
    try {
      before = options.terminalCursor
        ? decodeAgentGraphTerminalCursor(options.terminalCursor)
        : undefined;
    } catch (error) {
      throw new AgentGraphClientOperationError(
        'invalid_request',
        error instanceof Error ? error.message : 'Invalid agent graph terminal cursor',
      );
    }
    if (before && before.graphId !== graphId) {
      throw new AgentGraphClientOperationError(
        'invalid_request',
        'Agent graph terminal cursor belongs to another graph',
      );
    }
    return this.#readSnapshot(rootSessionId, graphId, before);
  }

  async readSessionState(rootSessionId: string): Promise<'absent' | 'live' | 'terminal'> {
    return this.#readSessionStateForGraph(rootSessionId, await this.currentGraphId(rootSessionId));
  }

  async readGraphState(
    rootSessionId: string,
    graphId: string,
  ): Promise<'absent' | 'live' | 'terminal'> {
    await this.#assertGraphBelongsToRoot(rootSessionId, graphId);
    return this.#readSessionStateForGraph(rootSessionId, graphId);
  }

  async listGraphEpochs(rootSessionId: string): Promise<readonly AgentGraphEpochBinding[]> {
    await this.#assertRootGraphReader(rootSessionId);
    const current = await this.currentGraphEpoch(rootSessionId);
    if (!this.#input.epochStore) return [current];
    const epochs = await this.#input.epochStore.listAgentGraphEpochs(rootSessionId);
    return epochs.length > 0 ? epochs : [current];
  }

  async listGraphEpochPage(
    rootSessionId: string,
    options: { readonly beforeEpoch?: number; readonly limit: number },
  ): Promise<AgentGraphEpochPage & { readonly currentEpoch: number }> {
    await this.#assertRootGraphReader(rootSessionId);
    if (!this.#input.epochStore) {
      const current = await this.currentGraphEpoch(rootSessionId);
      assertEpochCursorNotAhead(options.beforeEpoch, current.epoch);
      return {
        epochs:
          options.beforeEpoch === undefined || current.epoch < options.beforeEpoch ? [current] : [],
        nextBeforeEpoch: null,
        currentEpoch: current.epoch,
      };
    }
    // Page rows and the current marker must describe one storage observation:
    // a rollover between two reads would mark a non-first row current, which
    // the protocol rejects.
    const page = await this.#input.epochStore.listAgentGraphEpochPage({
      rootSessionId,
      ...options,
    });
    if (page.currentEpoch !== null) {
      assertEpochCursorNotAhead(options.beforeEpoch, page.currentEpoch);
      return {
        epochs: page.epochs,
        nextBeforeEpoch: page.nextBeforeEpoch,
        currentEpoch: page.currentEpoch,
      };
    }
    // No durable rows yet: synthesize the legacy virtual epoch identity.
    const current = await this.currentGraphEpoch(rootSessionId);
    assertEpochCursorNotAhead(options.beforeEpoch, current.epoch);
    return {
      epochs: options.beforeEpoch === undefined ? [current] : [],
      nextBeforeEpoch: null,
      currentEpoch: current.epoch,
    };
  }

  async listGraphIds(rootSessionId: string): Promise<readonly string[]> {
    requireRootSessionId(rootSessionId);
    // Retirement calls this after the Session header has been tombstoned. Keep
    // that internal cleanup path on the epoch authority while client-facing
    // epoch queries continue to validate a live root Session above.
    if (!this.#input.epochStore) return [agentGraphIdForRootSession(rootSessionId)];
    const epochs = await this.#input.epochStore.listAgentGraphEpochs(rootSessionId);
    return epochs.length > 0
      ? epochs.map(({ graphId }) => graphId)
      : [agentGraphIdForRootSession(rootSessionId)];
  }

  async hasLiveSessionState(rootSessionId: string): Promise<boolean> {
    return (await this.readSessionState(rootSessionId)) === 'live';
  }

  /**
   * Reconstruct one stable, reference-only control/data-plane timeline page.
   *
   * SQLite supplies one metadata snapshot; AgentRun and immutable RuntimeEvent
   * ledgers supply root-turn and operator activity without exposing payloads.
   */
  async getTimeline(
    rootSessionId: string,
    options: AgentGraphTimelinePageOptions = {},
  ): Promise<AgentGraphTimelinePage> {
    await this.#assertRootGraphReader(rootSessionId);
    const graphId = await this.currentGraphId(rootSessionId);
    return readAgentGraphTimelinePage({
      rootSessionId,
      graphId,
      controlStore: this.#input.controlStore,
      runStore: this.#input.runStore,
      runtimeEventStore: this.#input.runtimeEventStore,
      options,
    });
  }

  /** Inspect one operator without requiring it to be present in the bounded snapshot page. */
  async inspectOperator(
    rootSessionId: string,
    operatorId: string,
  ): Promise<AgentGraphOperatorInspection> {
    const graphId = await this.currentGraphId(rootSessionId);
    return this.inspectGraphOperator(rootSessionId, graphId, operatorId);
  }

  async inspectGraphOperator(
    rootSessionId: string,
    graphId: string,
    operatorId: string,
  ): Promise<AgentGraphOperatorInspection> {
    await this.#assertGraphBelongsToRoot(rootSessionId, graphId);
    await this.#readOrRebuildClientProjection(rootSessionId, graphId);
    const materialized = await this.#input.controlStore.readAgentGraphClientProjectionWithOperator(
      graphId,
      operatorId,
    );
    if (!materialized) {
      throw new Error(`Agent graph ${graphId} has no materialized client projection`);
    }
    const { projection: graph, operator } = materialized;
    if (
      graph.schemaVersion !== AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION ||
      graph.rootSessionId !== rootSessionId
    ) {
      throw new Error(`Invalid materialized agent graph projection ${graphId}`);
    }
    if (!operator) {
      throw new AgentGraphClientOperationError(
        'not_found',
        `Agent graph operator ${operatorId} was not found in ${graphId}`,
      );
    }
    const inspection = decodeMaterializedAgentGraphOperatorInspection(operator.payload, {
      rootSessionId,
      graphId,
      operatorId,
      snapshotVersion: operator.snapshotVersion,
    });
    inspection.snapshotVersion = graph.snapshotVersion;
    return inspection;
  }

  /**
   * Subscribe to durable-state invalidation hints for one root graph.
   *
   * The callback is presentation-only and never gates reconciliation. Clients
   * reconnect by calling getSnapshot(), not by replaying these process-local
   * hints as authority.
   */
  subscribe(rootSessionId: string, listener: AgentGraphClientChangedListener): () => void {
    const normalizedRootSessionId = requireRootSessionId(rootSessionId);
    if (this.#input.rootSessionId && normalizedRootSessionId !== this.#input.rootSessionId) {
      throw new Error(
        `Agent graph coordinator is scoped to root Session ${this.#input.rootSessionId}`,
      );
    }
    if (this.#closed) throw new Error('Agent graph coordinator is closed');
    const subscription = { rootSessionId: normalizedRootSessionId, listener };
    this.#clientSubscriptions.add(subscription);
    return () => this.#clientSubscriptions.delete(subscription);
  }

  /** Host adapter hook for multiplexing several root graphs to local clients. */
  subscribeAll(listener: AgentGraphClientChangedListener): () => void {
    if (this.#closed) throw new Error('Agent graph coordinator is closed');
    const subscription = { listener };
    this.#clientSubscriptions.add(subscription);
    return () => this.#clientSubscriptions.delete(subscription);
  }

  /** Wake reconciliation without making the caller part of the data path. */
  wake(rootSessionId: string): void {
    if (this.#closed) return;
    void this.#wake(rootSessionId);
  }

  /** Reconcile now and surface any host-level failure to explicit callers. */
  async reconcile(rootSessionId: string): Promise<AgentGraphScheduleReconciliationResult> {
    await this.#assertRootSupervisor(rootSessionId);
    const driver = await this.#driver(rootSessionId);
    driver.lastError = undefined;
    driver.paused = false;
    this.#requestDrive(driver);
    await this.waitForIdle(rootSessionId);
    if (driver.lastError !== undefined) throw driver.lastError;
    if (!driver.lastResult) {
      throw new Error(`Agent graph ${driver.graphId} produced no reconciliation result`);
    }
    return driver.lastResult;
  }

  async waitForIdle(rootSessionId: string): Promise<void> {
    const driver = await this.#driver(rootSessionId);
    while (driver.task) await driver.task;
  }

  /**
   * Rebuild every durable, non-archived root graph that has schedule intent.
   *
   * Empty ordinary Sessions are skipped; no separate in-memory registry is
   * required for restart recovery.
   */
  async recover(): Promise<string[]> {
    const recovered: string[] = [];
    for (const header of await this.#input.sessionStore.listForRecovery()) {
      if (this.#input.rootSessionId && header.id !== this.#input.rootSessionId) continue;
      if (header.subagentParent || header.isArchived) continue;
      const graphId = await this.currentGraphId(header.id);
      const updates = await this.#input.controlStore.listAgentGraphScheduleUpdates(graphId);
      if (updates.length === 0) continue;
      updates.forEach((update) => this.#assertScheduleOwnedByRoot(update, header.id, graphId));
      await this.reconcile(header.id);
      recovered.push(header.id);
    }
    return recovered;
  }

  async observe(rootSessionId: string): Promise<AgentGraphSupervisorObservation> {
    await this.#assertRootSupervisor(rootSessionId);
    const graphId = await this.currentGraphId(rootSessionId);
    const topology = await this.#readTopology(graphId);
    return this.#observeTopology(topology);
  }

  async #observeTopology(
    topology: AgentGraphTraceTopology,
  ): Promise<AgentGraphSupervisorObservation> {
    const graphId = topology.graphId;
    const [projection, listedClaims] = await Promise.all([
      readCommittedAgentGraphProjection({
        graphId,
        operators: topology.operators,
        runStore: this.#input.runStore,
        runtimeEventStore: this.#input.runtimeEventStore,
      }),
      this.#input.controlStore.listAgentGraphIntentClaims(graphId),
    ]);
    const claims = listedClaims
      .map(decodeAgentGraphIntentClaim)
      .sort((a, b) => a.intentId.localeCompare(b.intentId) || a.claimId.localeCompare(b.claimId));
    assertUniqueClaims(graphId, claims);
    return {
      projection,
      readiness: buildAgentGraphReadinessSnapshot({
        topology,
        records: projection.records,
        policies: [],
      }),
      claims,
    };
  }

  /**
   * Stop current graph execution. Durable schedule facts are retained, so a
   * later supervisor update can wake the same graph again.
   */
  async stop(rootSessionId: string): Promise<void> {
    await this.#assertRootSupervisor(rootSessionId);
    const driver = await this.#driver(rootSessionId);
    return this.#stopGraph(driver);
  }

  /** Stop the validated root supervisor and its graph under one wake fence. */
  async stopExecution(rootSessionId: string, input: AgentGraphExecutionStopInput): Promise<void> {
    await this.#assertRootSupervisor(rootSessionId);
    await input.withSupervisorWakesSuppressed(async () => {
      const driver = await this.#driver(rootSessionId);
      if (input.expectedGraphId !== undefined && driver.graphId !== input.expectedGraphId) {
        throw new AgentGraphClientOperationError(
          'operation_conflict',
          `Agent graph ${input.expectedGraphId} is no longer current`,
        );
      }
      const failures: unknown[] = [];
      try {
        await input.stopSupervisor();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#stopGraph(driver);
      } catch (error) {
        failures.push(error);
      }
      throwCollectedFailures(`Failed to stop agent graph execution ${driver.graphId}`, failures);
    });
  }

  #stopGraph(driver: GraphDriver): Promise<void> {
    if (driver.stopTask) return driver.stopTask;
    const stopTask = this.#stopDriver(driver).finally(() => {
      if (driver.stopTask === stopTask) driver.stopTask = undefined;
    });
    driver.stopTask = stopTask;
    return stopTask;
  }

  async #stopDriver(driver: GraphDriver): Promise<void> {
    driver.stopGeneration += 1;
    driver.paused = true;
    driver.stopping = true;
    driver.requested = false;
    driver.abortController?.abort();
    const failures: unknown[] = [];
    const activeTask = driver.task;
    try {
      await this.#stopKnownOperators(driver.graphId, failures);
      if (activeTask) {
        try {
          await activeTask;
        } catch (error) {
          failures.push(error);
        }
        // Re-read after the driver settles so an operator provisioned in the
        // stop race cannot escape the first topology snapshot.
        await this.#stopKnownOperators(driver.graphId, failures);
      }
    } finally {
      driver.stopping = false;
    }
    throwCollectedFailures(`Failed to stop agent graph ${driver.graphId}`, failures);
    await this.#repairClientProjectionBestEffort(driver);
    this.#notifyClientChanged(driver, 'stopped');
  }

  beginDrain(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const driver of this.#drivers.values()) {
      driver.closed = true;
      driver.abortController?.abort();
    }
    this.#drainTask = Promise.allSettled(
      [...this.#drivers.values()].map(async (driver): Promise<void> => {
        const failures: unknown[] = [];
        if (driver.stopTask) {
          try {
            await driver.stopTask;
          } catch (error) {
            failures.push(error);
          }
        }
        const activeTask = driver.task;
        await this.#stopKnownOperators(driver.graphId, failures);
        if (activeTask) {
          try {
            await activeTask;
          } catch (error) {
            failures.push(error);
          }
          await this.#stopKnownOperators(driver.graphId, failures);
        }
        if (driver.lastError !== undefined) failures.push(driver.lastError);
        throwCollectedFailures(`Failed to close agent graph ${driver.graphId}`, failures);
      }),
    ).then((results) =>
      results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    );
  }

  async close(): Promise<void> {
    this.beginDrain();
    const failures = await (this.#drainTask ?? Promise.resolve([]));
    this.#clientSubscriptions.clear();
    throwCollectedFailures('Failed to close one or more agent graph coordinators', failures);
  }

  async #drive(driver: GraphDriver): Promise<void> {
    while (driver.requested && !driver.paused && !driver.closed && !this.#closed) {
      driver.requested = false;
      driver.lastError = undefined;
      const generation = ++driver.driveGeneration;
      driver.activeDriveGeneration = generation;
      const abortController = new AbortController();
      driver.abortController = abortController;
      try {
        const result = await this.#reconcileOnce(driver, abortController.signal);
        driver.lastResult = result;
        await this.#waitForClientProjectionUpdates(driver);
        await this.#reconcileReconciliationFailures(driver, result);
        if (driver.clientProjectionDirty) {
          await this.#repairClientProjectionBestEffort(driver);
        }
        await notify(this.#input.onReconciliation, driver.rootSessionId, result);
        if (isAgentGraphSupervisorMilestone(result)) {
          for (const waiter of driver.yieldWaiters) {
            if (!waiter.cancelled && generation >= waiter.minimumGeneration) {
              waiter.milestoneRevisions.push(result.schedule.revision);
              waiter.resolveProof();
            }
          }
        }
        this.#notifyClientChanged(driver, 'reconciled');
      } catch (error) {
        if (!abortController.signal.aborted) {
          driver.lastError = error;
          await notify(this.#input.onError, driver.rootSessionId, error);
        }
      } finally {
        if (driver.abortController === abortController) driver.abortController = undefined;
        if (driver.activeDriveGeneration === generation) {
          driver.activeDriveGeneration = undefined;
        }
      }
    }
  }

  async #reconcileOnce(
    driver: GraphDriver,
    abortSignal: AbortSignal,
  ): Promise<AgentGraphScheduleReconciliationResult> {
    await this.#assertRootSupervisor(driver.rootSessionId);
    const updates = await this.#input.controlStore.listAgentGraphScheduleUpdates(driver.graphId);
    updates.forEach((update) =>
      this.#assertScheduleOwnedByRoot(update, driver.rootSessionId, driver.graphId),
    );
    return reconcileAgentGraphSchedule({
      topology: { graphId: driver.graphId, operators: [], edges: [] },
      controlStore: this.#input.controlStore,
      executor: this.#input.runtime,
      stopController: this.#input.runtime,
      provisionOperator: (input) => this.#input.runtime.provisionAgentGraphOperator(input),
      newId: this.#input.newId,
      maxNewActivations: this.#input.maxNewActivations!,
      observeGraph: (topology) => this.#observeTopology(topology),
      resolveSelectedResultInputs: (selected) =>
        this.#resolveSelectedResultInputs(driver.rootSessionId, driver.graphId, selected),
      hydrateInputHandoffs: (records) =>
        hydrateAgentGraphInputHandoffs({
          records,
          runtimeEventStore: {
            readImmutableRuntimeEvents: (sessionId, runId) => {
              const read = this.#input.runtimeEventStore.readImmutableRuntimeEvents;
              if (!read) {
                throw new Error('Agent graph handoffs require immutable RuntimeEvent reads');
              }
              return read.call(this.#input.runtimeEventStore, sessionId, runId);
            },
          },
        }),
      renderPrompt: this.#input.renderPrompt ?? renderAgentGraphScheduledWorkPrompt,
      abortSignal,
      supervisor: {
        onObservation: (observation) => {
          this.#queueClientProjectionUpdate(
            driver,
            async () => {
              await this.#materializeClientProjection(
                driver.rootSessionId,
                driver.graphId,
                observation,
              );
              this.#notifyClientChanged(driver, 'observation');
            },
            true,
          );
          void notify(this.#input.supervisor?.onObservation, observation);
        },
        onActivationReady: (activation) => {
          const generation = driver.activeDriveGeneration;
          if (generation !== undefined) {
            for (const waiter of driver.yieldWaiters) {
              if (!waiter.cancelled && generation >= waiter.minimumGeneration) {
                waiter.activationReady = true;
                waiter.resolveProof();
              }
            }
          }
          void notify(this.#input.supervisor?.onActivationReady, activation);
        },
        onRuntimeEvent: (event) => {
          if (!driver.paused) driver.requested = true;
          if (event.event.type === 'error') {
            driver.runtimeFailureRunIds.add(event.claim.targetRunId);
          }
          const activationHadError = driver.runtimeFailureRunIds.has(event.claim.targetRunId);
          if (event.event.type === 'complete' || event.event.type === 'abort') {
            driver.runtimeFailureRunIds.delete(event.claim.targetRunId);
          }
          if (isMaterializedGraphClientEvent(event.event.type)) {
            this.#queueClientProjectionUpdate(driver, async () => {
              const advancement = await this.#advanceClientProjection(
                driver,
                event,
                activationHadError,
              );
              if (
                advancement &&
                isSwarmCheckpointTransition(advancement.before, advancement.after)
              ) {
                await notify(this.#input.onCheckpoint, driver.rootSessionId);
              }
            });
          }
          void notify(this.#input.supervisor?.onRuntimeEvent, event);
        },
        onReconciliationFailure: (failure) => {
          this.#queueClientProjectionUpdate(driver, async () => {
            await this.#mergeReconciliationFailure(driver, failure);
            await notify(this.#input.onCheckpoint, driver.rootSessionId);
          });
          void notify(this.#input.supervisor?.onReconciliationFailure, failure);
        },
      },
    });
  }

  async #readClientModelInput(
    rootSessionId: string,
    reconciliationFailures?: readonly AgentGraphClientReconciliationFailure[],
  ): Promise<BuildAgentGraphClientReadModelInput> {
    const graphId = await this.currentGraphId(rootSessionId);
    return this.#readClientModelInputForGraph(rootSessionId, graphId, reconciliationFailures);
  }

  async #readClientModelInputForGraph(
    rootSessionId: string,
    graphId: string,
    reconciliationFailures?: readonly AgentGraphClientReconciliationFailure[],
  ): Promise<BuildAgentGraphClientReadModelInput> {
    await this.#assertRootGraphReader(rootSessionId);
    const [provisions, scheduleUpdates, claimAdmissions, header, existing] = await Promise.all([
      this.#input.controlStore.listAgentGraphOperatorProvisions(graphId),
      this.#input.controlStore.listAgentGraphScheduleUpdates(graphId),
      this.#input.controlStore.listAgentGraphClientClaimAdmissions(graphId),
      this.#input.sessionStore.readHeader(rootSessionId),
      this.#input.controlStore.readAgentGraphClientProjection(graphId),
    ]);
    scheduleUpdates.forEach((update) =>
      this.#assertScheduleOwnedByRoot(update, rootSessionId, graphId),
    );
    const topology = topologyFromProvisions(graphId, provisions);
    return {
      rootSessionId,
      graphId,
      provisions,
      scheduleUpdates,
      claimAdmissions,
      orchestrationMode: graphOrchestrationMode(scheduleUpdates, header),
      reconciliationFailures:
        reconciliationFailures ?? existingReconciliationFailures(existing?.payload),
      observation: await this.#observeTopology(topology),
    };
  }

  async #readOrRebuildClientProjection(rootSessionId: string, graphId: string) {
    const driver = this.#drivers.get(graphId);
    if (driver) {
      await this.#waitForClientProjectionUpdates(driver);
      if (driver.clientProjectionDirty) {
        await this.#repairClientProjectionBestEffort(driver);
      }
    }
    const existing = await this.#input.controlStore.readAgentGraphClientProjection(graphId);
    if (existing) {
      if (
        existing.schemaVersion !== AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION ||
        existing.rootSessionId !== rootSessionId
      ) {
        throw new Error(`Invalid materialized agent graph projection ${graphId}`);
      }
      if (isCurrentClientProjectionPayload(existing.payload)) return existing;
    }
    const rebuilt = await this.#rebuildClientProjection(rootSessionId, graphId);
    if (driver) driver.clientProjectionDirty = false;
    return rebuilt;
  }

  async #rebuildClientProjection(rootSessionId: string, graphId: string) {
    for (let attempt = 0; attempt < MAX_CLIENT_PROJECTION_COMMIT_ATTEMPTS; attempt += 1) {
      const expectedSnapshotVersion =
        (await this.#input.controlStore.readAgentGraphClientProjection(graphId))?.snapshotVersion ??
        null;
      const input = await this.#readClientModelInputForGraph(rootSessionId, graphId);
      try {
        return await this.#commitClientProjection(
          input,
          materializeAgentGraphClientProjection(input),
          expectedSnapshotVersion,
        );
      } catch (error) {
        if (!(error instanceof AgentGraphClientProjectionConflictError)) throw error;
      }
    }
    throw new AgentGraphClientProjectionConflictError(
      `Agent graph client projection ${graphId} kept changing during rebuild`,
    );
  }

  async #materializeClientProjection(
    rootSessionId: string,
    graphId: string,
    observation: AgentGraphSupervisorObservation,
  ): Promise<void> {
    const [provisions, scheduleUpdates, claimAdmissions, header, existing] = await Promise.all([
      this.#input.controlStore.listAgentGraphOperatorProvisions(graphId),
      this.#input.controlStore.listAgentGraphScheduleUpdates(graphId),
      this.#input.controlStore.listAgentGraphClientClaimAdmissions(graphId),
      this.#input.sessionStore.readHeader(rootSessionId),
      this.#input.controlStore.readAgentGraphClientProjection(graphId),
    ]);
    scheduleUpdates.forEach((update) =>
      this.#assertScheduleOwnedByRoot(update, rootSessionId, graphId),
    );
    const input: BuildAgentGraphClientReadModelInput = {
      rootSessionId,
      graphId,
      provisions,
      scheduleUpdates,
      claimAdmissions,
      orchestrationMode: graphOrchestrationMode(scheduleUpdates, header),
      reconciliationFailures: existingReconciliationFailures(existing?.payload),
      observation,
    };
    const expectedSnapshotVersion = existing?.snapshotVersion ?? null;
    try {
      await this.#commitClientProjection(
        input,
        materializeAgentGraphClientProjection(input),
        expectedSnapshotVersion,
      );
    } catch (error) {
      if (!(error instanceof AgentGraphClientProjectionConflictError)) throw error;
      await this.#rebuildClientProjection(rootSessionId, graphId);
    }
  }

  async #mergeReconciliationFailure(
    driver: GraphDriver,
    failure: AgentGraphScheduleReconciliationFailure,
  ): Promise<void> {
    const projected = durableReconciliationFailure(failure);
    if (!projected) return;
    const existing = await this.#input.controlStore.readAgentGraphClientProjection(driver.graphId);
    const failures = existingReconciliationFailures(existing?.payload).filter(
      (candidate) => candidate.workId !== projected.workId,
    );
    failures.push(projected);
    await this.#setReconciliationFailures(driver, failures);
  }

  async #reconcileReconciliationFailures(
    driver: GraphDriver,
    result: AgentGraphScheduleReconciliationResult,
  ): Promise<void> {
    const existing = await this.#input.controlStore.readAgentGraphClientProjection(driver.graphId);
    const existingFailures = existingReconciliationFailures(existing?.payload);
    const requestedWorkIds = new Set(
      result.schedule.work.filter((work) => work.status === 'requested').map((work) => work.workId),
    );
    const successfulWorkIds = new Set(
      result.dispatches.map((dispatch) => dispatch.intent.readinessId),
    );
    const failuresByWorkId = new Map(
      existingFailures
        .filter(
          (failure) =>
            requestedWorkIds.has(failure.workId) && !successfulWorkIds.has(failure.workId),
        )
        .map((failure) => [failure.workId, failure]),
    );
    for (const failure of result.failures) {
      const projected = durableReconciliationFailure(failure);
      if (projected && requestedWorkIds.has(projected.workId)) {
        failuresByWorkId.set(projected.workId, projected);
      }
    }
    const nextFailures = [...failuresByWorkId.values()].sort((left, right) =>
      left.workId.localeCompare(right.workId),
    );
    const currentFailures = [...existingFailures].sort((left, right) =>
      left.workId.localeCompare(right.workId),
    );
    if (
      nextFailures.length === currentFailures.length &&
      nextFailures.every(
        (failure, index) =>
          failure.workId === currentFailures[index]?.workId &&
          failure.phase === currentFailures[index]?.phase &&
          failure.reason === currentFailures[index]?.reason,
      )
    ) {
      return;
    }
    await this.#setReconciliationFailures(driver, nextFailures);
  }

  async #setReconciliationFailures(
    driver: GraphDriver,
    failures:
      | readonly AgentGraphScheduleReconciliationFailure[]
      | readonly AgentGraphClientReconciliationFailure[],
  ): Promise<void> {
    const projected = failures
      .map((failure) => ('error' in failure ? durableReconciliationFailure(failure) : failure))
      .filter((failure): failure is AgentGraphClientReconciliationFailure => Boolean(failure));
    for (let attempt = 0; attempt < MAX_CLIENT_PROJECTION_COMMIT_ATTEMPTS; attempt += 1) {
      const existing = await this.#input.controlStore.readAgentGraphClientProjection(
        driver.graphId,
      );
      const input = await this.#readClientModelInputForGraph(
        driver.rootSessionId,
        driver.graphId,
        projected,
      );
      try {
        await this.#commitClientProjection(
          input,
          materializeAgentGraphClientProjection(input),
          existing?.snapshotVersion ?? null,
        );
        return;
      } catch (error) {
        if (!(error instanceof AgentGraphClientProjectionConflictError)) throw error;
      }
    }
    throw new AgentGraphClientProjectionConflictError(
      `Agent graph client projection ${driver.graphId} kept changing while recording failures`,
    );
  }

  async #commitClientProjection(
    input: BuildAgentGraphClientReadModelInput,
    materialization: ReturnType<typeof materializeAgentGraphClientProjection>,
    expectedSnapshotVersion: string | null,
  ) {
    return this.#input.controlStore.commitAgentGraphClientProjection({
      schemaVersion: AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
      graphId: input.graphId,
      rootSessionId: input.rootSessionId,
      expectedSnapshotVersion,
      snapshotVersion: materialization.snapshot.snapshotVersion,
      snapshot: materialization.snapshot,
      replaceOperators: true,
      operators: materialization.operators.map((operator) => ({
        operatorId: operator.operator.operatorId,
        payload: operator,
      })),
      terminalActivities: materialization.terminalActivities.map((activity) => ({
        recordId: activity.recordId,
        eventTime: activity.eventTime,
        payload: activity,
      })),
      activityRecords: materialization.activityRecords.map((activity) => ({
        recordId: activity.recordId,
        eventTime: activity.eventTime,
      })),
    });
  }

  #queueClientProjectionUpdate(
    driver: GraphDriver,
    operation: () => Promise<void>,
    authoritative = false,
  ): void {
    const previous = driver.clientProjectionTask ?? Promise.resolve();
    const task = previous
      .catch(() => {
        // A later durable observation may repair a failed derived projection.
      })
      .then(async () => {
        try {
          await operation();
          if (authoritative) driver.clientProjectionDirty = false;
        } catch (error) {
          driver.clientProjectionDirty = true;
          await notify(this.#input.onError, driver.rootSessionId, error);
          throw error;
        }
      });
    driver.clientProjectionTask = task;
    void task
      .catch(() => {
        // Failure state and reporting are owned inside the serialized task.
      })
      .finally(() => {
        if (driver.clientProjectionTask === task) {
          driver.clientProjectionTask = undefined;
        }
      });
  }

  async #waitForClientProjectionUpdates(driver: GraphDriver): Promise<void> {
    await driver.clientProjectionTask?.catch(() => {
      // A best-effort repair or later durable observation may repair this
      // derived read side; graph authority never depends on it.
    });
  }

  async #repairClientProjectionBestEffort(driver: GraphDriver): Promise<void> {
    await this.#waitForClientProjectionUpdates(driver);
    try {
      await this.#rebuildClientProjection(driver.rootSessionId, driver.graphId);
      driver.clientProjectionDirty = false;
    } catch (error) {
      driver.clientProjectionDirty = true;
      await notify(this.#input.onError, driver.rootSessionId, error);
    }
  }

  async #advanceClientProjection(
    driver: GraphDriver,
    event: AgentGraphSupervisorRuntimeEvent,
    activationHadError: boolean,
  ): Promise<{ before: AgentGraphClientSnapshot; after: AgentGraphClientSnapshot } | undefined> {
    for (let attempt = 0; attempt < MAX_CLIENT_PROJECTION_COMMIT_ATTEMPTS; attempt += 1) {
      const graph = await this.#input.controlStore.readAgentGraphClientProjection(driver.graphId);
      const operator = await this.#input.controlStore.readAgentGraphClientOperatorProjection(
        driver.graphId,
        event.claim.targetOperatorId,
      );
      if (!graph || !operator) {
        throw new Error(
          `Agent graph ${driver.graphId} has no materialized runtime activity target`,
        );
      }
      const snapshot = decodeMaterializedAgentGraphClientSnapshot(graph.payload, {
        rootSessionId: driver.rootSessionId,
        graphId: driver.graphId,
        snapshotVersion: graph.snapshotVersion,
      });
      const inspection = decodeMaterializedAgentGraphOperatorInspection(operator.payload, {
        rootSessionId: driver.rootSessionId,
        graphId: driver.graphId,
        operatorId: event.claim.targetOperatorId,
        snapshotVersion: operator.snapshotVersion,
      });
      const advanced = advanceMaterializedAgentGraphClientProjection(
        snapshot,
        inspection,
        event,
        activationHadError,
      );
      if (!advanced) return undefined;
      try {
        const committed = await this.#input.controlStore.commitAgentGraphClientProjection({
          schemaVersion: AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION,
          graphId: driver.graphId,
          rootSessionId: driver.rootSessionId,
          expectedSnapshotVersion: graph.snapshotVersion,
          snapshotVersion: advanced.snapshot.snapshotVersion,
          snapshot: advanced.snapshot,
          replaceOperators: false,
          operators: [
            {
              operatorId: advanced.operator.operator.operatorId,
              payload: advanced.operator,
            },
          ],
          // AgentRun may still rewrite this yielded SessionEvent at its
          // terminal durability barrier (for example complete -> aborted in a
          // stop race). Only the authoritative RuntimeEvent fold populates the
          // immutable terminal-history table.
          terminalActivities: [],
          activityRecords: [
            {
              recordId: advanced.activity.recordId,
              eventTime: advanced.activity.eventTime,
            },
          ],
          incrementalRecordId: advanced.activity.recordId,
        });
        if (committed.snapshotVersion === advanced.snapshot.snapshotVersion) {
          this.#notifyClientChanged(driver, 'runtime_activity');
          return { before: snapshot, after: advanced.snapshot };
        }
        return undefined;
      } catch (error) {
        if (!(error instanceof AgentGraphClientProjectionConflictError)) throw error;
      }
    }
    throw new AgentGraphClientProjectionConflictError(
      `Agent graph client projection ${driver.graphId} kept changing during runtime update`,
    );
  }

  async #readTopology(graphId: string): Promise<AgentGraphTraceTopology> {
    return topologyFromProvisions(
      graphId,
      await this.#input.controlStore.listAgentGraphOperatorProvisions(graphId),
    );
  }

  async #resolveSelectedResultInputs(
    rootSessionId: string,
    currentGraphId: string,
    selectedInputs: readonly AgentGraphSelectedResultInput[],
  ): Promise<readonly AgentGraphRecord[]> {
    if (selectedInputs.length === 0) return [];
    if (!this.#input.epochStore) {
      throw new Error('Historical graph result inputs require agent graph epoch authority');
    }
    const current = await this.#input.epochStore.readAgentGraphEpochByGraphId(currentGraphId);
    if (!current || current.rootSessionId !== rootSessionId) {
      throw new Error(`Current agent graph ${currentGraphId} is not owned by ${rootSessionId}`);
    }
    const sourceGraphIds = [...new Set(selectedInputs.map((input) => input.sourceGraphId))];
    const recordsBySource = new Map<string, Map<string, AgentGraphRecord>>();
    for (const sourceGraphId of sourceGraphIds) {
      const source = await this.#input.epochStore.readAgentGraphEpochByGraphId(sourceGraphId);
      if (!source || source.rootSessionId !== rootSessionId || source.epoch >= current.epoch) {
        throw new Error(
          `Agent graph ${sourceGraphId} is not a completed earlier epoch of ${currentGraphId}`,
        );
      }
      const updates = await this.#input.controlStore.listAgentGraphScheduleUpdates(sourceGraphId);
      updates.forEach((update) =>
        this.#assertScheduleOwnedByRoot(update, rootSessionId, sourceGraphId),
      );
      const schedule = projectAgentGraphSchedule(sourceGraphId, updates);
      if (!schedule.closed || !schedule.finish) {
        throw new Error(`Agent graph ${sourceGraphId} has not selected final results`);
      }
      const requestedIds = selectedInputs
        .filter((input) => input.sourceGraphId === sourceGraphId)
        .map((input) => input.resultId);
      const selectedIds = new Set(schedule.finish.resultIds);
      const unselected = requestedIds.filter((resultId) => !selectedIds.has(resultId));
      if (unselected.length > 0) {
        throw new Error(
          `Agent graph ${sourceGraphId} did not select result ${unselected.join(', ')}`,
        );
      }
      const topology = await this.#readTopology(sourceGraphId);
      const projection = await readCommittedAgentGraphProjection({
        graphId: sourceGraphId,
        operators: topology.operators,
        runStore: this.#input.runStore,
        runtimeEventStore: this.#input.runtimeEventStore,
      });
      recordsBySource.set(
        sourceGraphId,
        new Map(projection.records.map((record) => [record.recordId, record])),
      );
    }
    return selectedInputs.map((selected) => {
      const record = recordsBySource.get(selected.sourceGraphId)?.get(selected.resultId);
      if (!record) {
        throw new Error(
          `Selected result ${selected.resultId} is not a committed record of ${selected.sourceGraphId}`,
        );
      }
      return structuredClone(record);
    });
  }

  async #listHistoricalSelectedResults(
    rootSessionId: string,
    currentGraphId: string,
    beforeEpoch?: number,
  ): Promise<{
    results: readonly AgentGraphSelectedResultInput[];
    nextBeforeEpoch: number | null;
  }> {
    if (!this.#input.epochStore) return { results: [], nextBeforeEpoch: null };
    const current = await this.#input.epochStore.readAgentGraphEpochByGraphId(currentGraphId);
    if (!current || current.rootSessionId !== rootSessionId || current.epoch <= 1) {
      return { results: [], nextBeforeEpoch: null };
    }
    const page = await this.#input.epochStore.listAgentGraphEpochPage({
      rootSessionId,
      beforeEpoch: Math.min(beforeEpoch ?? current.epoch, current.epoch),
      limit: 1,
    });
    const selected: AgentGraphSelectedResultInput[] = [];
    for (const binding of page.epochs) {
      const updates = await this.#input.controlStore.listAgentGraphScheduleUpdates(binding.graphId);
      updates.forEach((update) =>
        this.#assertScheduleOwnedByRoot(update, rootSessionId, binding.graphId),
      );
      const finish = projectAgentGraphSchedule(binding.graphId, updates).finish;
      if (!finish) continue;
      for (const resultId of finish.resultIds) {
        selected.push({ sourceGraphId: binding.graphId, resultId });
      }
    }
    return { results: selected, nextBeforeEpoch: page.nextBeforeEpoch };
  }

  async #assertRootSupervisor(rootSessionId: string): Promise<SessionHeader> {
    const header = await this.#assertRootGraphReader(rootSessionId);
    if (header.isArchived) {
      throw new AgentGraphClientOperationError(
        'session_archived',
        'Archived Sessions cannot supervise an agent graph',
      );
    }
    return header;
  }

  async #assertRootGraphReader(rootSessionId: string): Promise<SessionHeader> {
    if (this.#closed) throw new Error('Agent graph coordinator is closed');
    if (this.#input.rootSessionId && rootSessionId !== this.#input.rootSessionId) {
      throw new AgentGraphClientOperationError(
        'operation_conflict',
        `Agent graph coordinator is scoped to root Session ${this.#input.rootSessionId}`,
      );
    }
    const header = await this.#input.sessionStore.readHeader(rootSessionId);
    if (header.id !== rootSessionId) {
      throw new Error(`Session store returned ${header.id}, expected ${rootSessionId}`);
    }
    if (header.subagentParent) {
      throw new AgentGraphClientOperationError(
        'operation_conflict',
        'Agent graph client operations are available only to root Sessions',
      );
    }
    return header;
  }

  #assertScheduleOwnedByRoot(
    update: AgentGraphScheduleUpdate,
    rootSessionId: string,
    graphId: string,
  ): void {
    if (update.graphId !== graphId || update.source.sessionId !== rootSessionId) {
      throw new Error(
        `Agent graph schedule ${update.updateId} is not owned by root Session ${rootSessionId}`,
      );
    }
  }

  async currentGraphEpoch(rootSessionId: string): Promise<AgentGraphEpochBinding> {
    requireRootSessionId(rootSessionId);
    if (!this.#input.epochStore) {
      return {
        schemaVersion: 1,
        rootSessionId,
        epoch: 1,
        graphId: agentGraphIdForRootSession(rootSessionId),
        createdAt: 0,
      };
    }
    return this.#input.epochStore.resolveCurrentAgentGraphEpoch({
      rootSessionId,
      legacyGraphId: agentGraphIdForRootSession(rootSessionId),
    });
  }

  async currentGraphId(rootSessionId: string): Promise<string> {
    return (await this.currentGraphEpoch(rootSessionId)).graphId;
  }

  async advanceGraphEpoch(
    rootSessionId: string,
    expected?: AgentGraphEpochBinding,
  ): Promise<AgentGraphEpochBinding> {
    if (!this.#input.epochStore) {
      throw new Error('Agent graph epoch authority is unavailable');
    }
    const basis = expected ?? (await this.currentGraphEpoch(rootSessionId));
    if (basis.rootSessionId !== rootSessionId) {
      throw new Error('Agent graph epoch binding belongs to another root Session');
    }
    const nextGraphId = agentGraphIdForRootSessionEpoch(rootSessionId, basis.epoch + 1);
    return this.#input.epochStore.advanceAgentGraphEpoch({
      rootSessionId,
      expectedEpoch: basis.epoch,
      expectedGraphId: basis.graphId,
      nextGraphId,
    });
  }

  async beginNextGraphEpoch(
    rootSessionId: string,
    withSupervisorWakesSuppressed: (operation: () => Promise<void>) => Promise<void>,
  ): Promise<AgentGraphEpochBinding> {
    const current = await this.currentGraphEpoch(rootSessionId);
    if ((await this.#readSessionStateForGraph(rootSessionId, current.graphId)) !== 'terminal') {
      return current;
    }
    let selected = current;
    await withSupervisorWakesSuppressed(async () => {
      const driver = this.#drivers.get(current.graphId);
      while (driver?.task) await driver.task;
      const latest = await this.currentGraphEpoch(rootSessionId);
      if (latest.graphId !== current.graphId) {
        selected = latest;
        return;
      }
      if ((await this.#readSessionStateForGraph(rootSessionId, current.graphId)) !== 'terminal') {
        return;
      }
      selected = await this.advanceGraphEpoch(rootSessionId, current);
    });
    return selected;
  }

  async #readSessionStateForGraph(
    rootSessionId: string,
    graphId: string,
  ): Promise<'absent' | 'live' | 'terminal'> {
    const snapshot = buildAgentGraphClientSnapshot(
      await this.#readClientModelInputForGraph(rootSessionId, graphId),
    );
    if (snapshot.scheduleRevision === 0) return 'absent';
    return !snapshot.closed || snapshot.status === 'closing' ? 'live' : 'terminal';
  }

  async #assertGraphBelongsToRoot(rootSessionId: string, graphId: string): Promise<void> {
    await this.#assertRootGraphReader(rootSessionId);
    const current = await this.currentGraphEpoch(rootSessionId);
    const binding =
      current.graphId === graphId
        ? current
        : await this.#input.epochStore?.readAgentGraphEpochByGraphId(graphId);
    if (!binding || binding.rootSessionId !== rootSessionId) {
      throw new AgentGraphClientOperationError(
        'not_found',
        `Agent graph ${graphId} does not belong to root Session ${rootSessionId}`,
      );
    }
  }

  async #readSnapshot(
    rootSessionId: string,
    graphId: string,
    before?: ReturnType<typeof decodeAgentGraphTerminalCursor>,
  ): Promise<AgentGraphClientSnapshot> {
    const record = await this.#readOrRebuildClientProjection(rootSessionId, graphId);
    const snapshot = decodeMaterializedAgentGraphClientSnapshot(record.payload, {
      rootSessionId,
      graphId,
      snapshotVersion: record.snapshotVersion,
    });
    let terminalPage: Awaited<
      ReturnType<AgentGraphClientProjectionStore['listAgentGraphClientTerminalActivities']>
    >;
    try {
      terminalPage = await this.#input.controlStore.listAgentGraphClientTerminalActivities(
        graphId,
        {
          limit: AGENT_GRAPH_CLIENT_TERMINAL_PAGE_SIZE,
          ...(before
            ? {
                before: {
                  eventTime: before.eventTime,
                  recordId: before.recordId,
                },
              }
            : {}),
        },
      );
    } catch (error) {
      if (error instanceof AgentGraphClientTerminalCursorError) {
        throw new AgentGraphClientOperationError('invalid_request', error.message);
      }
      throw error;
    }
    snapshot.terminalHistory = materializedAgentGraphTerminalHistoryPage(
      graphId,
      terminalPage.records.map((activity) =>
        decodeMaterializedAgentGraphClientActivity(activity.payload, {
          graphId,
          recordId: activity.recordId,
          eventTime: activity.eventTime,
        }),
      ),
      terminalPage.hasMore,
    );
    return snapshot;
  }

  async #driver(rootSessionId: string): Promise<GraphDriver> {
    if (this.#input.rootSessionId && rootSessionId !== this.#input.rootSessionId) {
      throw new Error(
        `Agent graph coordinator is scoped to root Session ${this.#input.rootSessionId}`,
      );
    }
    const graphId = await this.currentGraphId(rootSessionId);
    const existing = this.#drivers.get(graphId);
    if (existing) {
      if (existing.rootSessionId !== rootSessionId) {
        throw new Error(`Agent graph ${graphId} is already bound to another root Session`);
      }
      return existing;
    }
    const created: GraphDriver = {
      rootSessionId,
      graphId,
      requested: false,
      paused: false,
      stopping: false,
      stopGeneration: 0,
      driveGeneration: 0,
      closed: false,
      clientProjectionDirty: false,
      runtimeFailureRunIds: new Set(),
      yieldWaiters: new Set(),
    };
    this.#drivers.set(graphId, created);
    return created;
  }

  async #wake(rootSessionId: string): Promise<void> {
    try {
      const driver = await this.#driver(rootSessionId);
      if (driver.stopping) return;
      driver.paused = false;
      this.#requestDrive(driver);
    } catch (error) {
      await notify(this.#input.onError, rootSessionId, error);
    }
  }

  #wakeFromSchedule(driver: GraphDriver, fence: ScheduleWakeFence): void {
    if (
      this.#closed ||
      driver.closed ||
      driver.stopping ||
      fence.stopGeneration !== driver.stopGeneration ||
      (driver.paused && !fence.mayResumePaused)
    ) {
      return;
    }
    driver.paused = false;
    this.#requestDrive(driver);
  }

  #requestDrive(driver: GraphDriver): void {
    driver.requested = true;
    if (driver.task) return;
    const residency = this.#input.acquireResidency?.(driver.rootSessionId);
    driver.task = this.#drive(driver).finally(() => {
      driver.task = undefined;
      residency?.release();
      if (driver.requested && !driver.paused && !driver.closed && !this.#closed) {
        this.#requestDrive(driver);
      }
    });
  }

  #prepareYieldPermit(driver: GraphDriver): AgentGraphYieldPermit {
    let resolveProof!: () => void;
    const proof = new Promise<void>((resolve) => {
      resolveProof = resolve;
    });
    const waiter: GraphYieldWaiter = {
      minimumGeneration: driver.activeDriveGeneration ?? driver.driveGeneration + 1,
      activationReady: false,
      milestoneRevisions: [],
      proof,
      resolveProof,
      cancelled: false,
    };
    driver.yieldWaiters.add(waiter);
    const cancel = (): void => {
      if (waiter.cancelled) return;
      waiter.cancelled = true;
      driver.yieldWaiters.delete(waiter);
    };
    return {
      acquire: async ({ scheduleRevision, observation }) => {
        try {
          if (hasLiveGraphOperator(observation) || waiter.activationReady) return true;
          while (driver.task) {
            const task = driver.task;
            const proved = await Promise.race([
              waiter.proof.then(() => true),
              task.then(() => false),
            ]);
            if (
              proved &&
              (waiter.activationReady ||
                waiter.milestoneRevisions.some((revision) => revision >= scheduleRevision))
            ) {
              return true;
            }
            if (proved) await task;
          }
          const current = await this.observe(driver.rootSessionId);
          return (
            hasLiveGraphOperator(current) ||
            waiter.activationReady ||
            waiter.milestoneRevisions.some((revision) => revision >= scheduleRevision)
          );
        } finally {
          cancel();
        }
      },
      cancel,
    };
  }

  #notifyClientChanged(driver: GraphDriver, reason: AgentGraphClientChangedReason): void {
    if (this.#clientSubscriptions.size === 0) return;
    const event: AgentGraphClientChangedEvent = {
      schemaVersion: 1,
      rootSessionId: driver.rootSessionId,
      graphId: driver.graphId,
      reason,
    };
    for (const subscription of this.#clientSubscriptions) {
      if (subscription.rootSessionId && subscription.rootSessionId !== driver.rootSessionId) {
        continue;
      }
      void notify(subscription.listener, structuredClone(event));
    }
  }

  async #stopKnownOperators(graphId: string, failures: unknown[]): Promise<void> {
    let topology: AgentGraphTraceTopology;
    try {
      topology = await this.#readTopology(graphId);
    } catch (error) {
      failures.push(error);
      return;
    }
    const stopped = await Promise.allSettled(
      topology.operators.map((operator) =>
        this.#input.runtime.stopSession(operator.sessionId, { source: 'graph_supervisor' }),
      ),
    );
    failures.push(
      ...stopped.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    );
  }
}

function assertEpochCursorNotAhead(beforeEpoch: number | undefined, currentEpoch: number): void {
  if (beforeEpoch !== undefined && beforeEpoch > currentEpoch) {
    throw new AgentGraphClientOperationError(
      'invalid_request',
      `Agent graph epoch cursor ${beforeEpoch} is ahead of current epoch ${currentEpoch}`,
    );
  }
}

interface ScheduleWakeFence {
  stopGeneration: number;
  mayResumePaused: boolean;
}

function decodeScheduleWakeFence(value: unknown): ScheduleWakeFence {
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isSafeInteger((value as ScheduleWakeFence).stopGeneration) ||
    typeof (value as ScheduleWakeFence).mayResumePaused !== 'boolean'
  ) {
    throw new Error('Agent graph schedule wake fence is invalid');
  }
  return value as ScheduleWakeFence;
}

function throwCollectedFailures(message: string, failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

export function agentGraphIdForRootSession(rootSessionId: string): string {
  requireRootSessionId(rootSessionId);
  const suffix = stableHash({
    schemaVersion: 1,
    rootSessionId,
  }).slice('sha256:'.length, 'sha256:'.length + 32);
  return `agent_graph_${suffix}`;
}

export function agentGraphIdForRootSessionEpoch(rootSessionId: string, epoch: number): string {
  requireRootSessionId(rootSessionId);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error('Agent graph epoch must be a positive safe integer');
  }
  if (epoch === 1) return agentGraphIdForRootSession(rootSessionId);
  const suffix = stableHash({
    schemaVersion: 2,
    rootSessionId,
    epoch,
  }).slice('sha256:'.length, 'sha256:'.length + 32);
  return `agent_graph_${suffix}`;
}

function requireRootSessionId(rootSessionId: string): string {
  const normalized = rootSessionId.trim();
  if (!normalized || normalized !== rootSessionId) {
    throw new Error('Agent graph root Session id must be a non-empty canonical identity');
  }
  return normalized;
}

function isMaterializedGraphClientEvent(
  type: AgentGraphSupervisorRuntimeEvent['event']['type'],
): boolean {
  return ![
    'text_delta',
    'thinking_delta',
    'tool_output_delta',
    'tool_progress',
    'tool_result_preview',
    'queue_update',
    'provider_retry',
  ].includes(type);
}

function isSwarmCheckpointTransition(
  before: AgentGraphClientSnapshot,
  after: AgentGraphClientSnapshot,
): boolean {
  if (after.orchestrationMode !== 'swarm') return false;
  const previous = projectAgentSwarmStatus(before);
  const current = projectAgentSwarmStatus(after);
  if (current.status === 'settled' && previous.status !== 'settled') return true;
  const attention = (snapshot: ReturnType<typeof projectAgentSwarmStatus>): string[] =>
    snapshot.items
      .filter((item) => ['blocked', 'failed', 'aborted', 'cancelled'].includes(item.status))
      .map((item) => `${item.workId}:${item.status}`)
      .sort();
  const previousAttention = attention(previous);
  const currentAttention = attention(current);
  return (
    previousAttention.length !== currentAttention.length ||
    currentAttention.some((entry, index) => entry !== previousAttention[index])
  );
}

function hasLiveGraphOperator(observation: AgentGraphSupervisorObservation): boolean {
  return observation.projection.operators.some(
    (operator) => observation.projection.state.operators[operator.operatorId]?.status === 'running',
  );
}

export function topologyFromProvisions(
  graphId: string,
  provisions: readonly AgentGraphOperatorProvision[],
): AgentGraphTraceTopology {
  const operators = new Map<string, { operatorId: string; sessionId: string }>();
  const sessions = new Map<string, string>();
  const edges = new Map<string, { edgeId: string; fromOperatorId: string; toOperatorId: string }>();
  for (const provision of [...provisions].sort(
    (a, b) => a.provisionedAt - b.provisionedAt || a.provisionId.localeCompare(b.provisionId),
  )) {
    if (provision.graphId !== graphId) {
      throw new Error(`Graph provision ${provision.provisionId} belongs to ${provision.graphId}`);
    }
    const existingOperator = operators.get(provision.operatorId);
    if (existingOperator && existingOperator.sessionId !== provision.targetSessionId) {
      throw new Error(`Graph operator ${provision.operatorId} has conflicting Session bindings`);
    }
    const existingSession = sessions.get(provision.targetSessionId);
    if (existingSession && existingSession !== provision.operatorId) {
      throw new Error(`Graph Session ${provision.targetSessionId} has multiple operators`);
    }
    operators.set(provision.operatorId, {
      operatorId: provision.operatorId,
      sessionId: provision.targetSessionId,
    });
    sessions.set(provision.targetSessionId, provision.operatorId);
    for (const edge of provision.edges) {
      const existingEdge = edges.get(edge.edgeId);
      if (
        existingEdge &&
        (existingEdge.fromOperatorId !== edge.fromOperatorId ||
          existingEdge.toOperatorId !== edge.toOperatorId)
      ) {
        throw new Error(`Graph edge ${edge.edgeId} has conflicting endpoints`);
      }
      edges.set(edge.edgeId, { ...edge });
    }
  }
  return {
    graphId,
    operators: [...operators.values()].sort((a, b) => a.operatorId.localeCompare(b.operatorId)),
    edges: [...edges.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
  };
}

function assertUniqueClaims(graphId: string, claims: readonly AgentGraphIntentClaim[]): void {
  const intentIds = new Set<string>();
  for (const claim of claims) {
    if (claim.graphId !== graphId) {
      throw new Error(`Graph claim ${claim.claimId} belongs to ${claim.graphId}`);
    }
    if (intentIds.has(claim.intentId)) {
      throw new Error(`Graph ${graphId} contains duplicate claim intent ${claim.intentId}`);
    }
    intentIds.add(claim.intentId);
  }
}

function graphOrchestrationMode(
  updates: readonly AgentGraphScheduleUpdate[],
  header: SessionHeader,
): 'graph' | 'swarm' {
  const first = [...updates].sort((a, b) => a.revision - b.revision)[0];
  if (first?.source.orchestrationMode === 'swarm') return 'swarm';
  if (first?.source.orchestrationMode === 'graph') return 'graph';
  return header.orchestrationMode === 'swarm' ? 'swarm' : 'graph';
}

function isCurrentClientProjectionPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Partial<AgentGraphClientSnapshot>;
  return (
    (snapshot.orchestrationMode === 'graph' || snapshot.orchestrationMode === 'swarm') &&
    Array.isArray(snapshot.reconciliationFailures) &&
    typeof snapshot.omitted?.reconciliationFailures === 'number'
  );
}

function existingReconciliationFailures(value: unknown): AgentGraphClientReconciliationFailure[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidates = (value as Partial<AgentGraphClientSnapshot>).reconciliationFailures;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((failure) =>
    failure &&
    typeof failure === 'object' &&
    !Array.isArray(failure) &&
    typeof failure.workId === 'string' &&
    typeof failure.reason === 'string' &&
    (failure.phase === 'schedule' ||
      failure.phase === 'topology' ||
      failure.phase === 'stop' ||
      failure.phase === 'render' ||
      failure.phase === 'dispatch')
      ? [{ workId: failure.workId, phase: failure.phase, reason: failure.reason }]
      : [],
  );
}

function durableReconciliationFailure(
  failure: AgentGraphScheduleReconciliationFailure,
): AgentGraphClientReconciliationFailure | undefined {
  const workId = failure.work?.workId ?? failure.targetId;
  if (!workId) return undefined;
  const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return {
    workId,
    phase: failure.phase,
    reason: reason.trim().slice(0, 1_000) || 'Unknown reconciliation failure',
  };
}

function notify<T extends unknown[]>(
  callback: ((...args: T) => void | Promise<void>) | undefined,
  ...args: T
): Promise<void> {
  if (!callback) return Promise.resolve();
  return Promise.resolve()
    .then(() => callback(...args))
    .then(
      () => {},
      () => {},
    );
}
