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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { z } from 'zod';
import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import {
  AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
  type AgentGraphIntentClaim,
} from '@maka/core/agent-graph-control';
import {
  AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
  type AgentGraphOperatorProvision,
} from '@maka/core/agent-graph-topology';
import { type AgentGraphScheduleUpdate } from '@maka/core/agent-graph-schedule';
import {
  runtimeInvocationOutcome,
  type RuntimeInvocationRecord,
} from '@maka/core/runtime-invocation';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import { createSessionStore, isSessionNotFoundError } from '@maka/storage/session-store';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import { createSqliteAgentRunStore } from '@maka/storage/agent-run-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { FakeBackend } from '../test-only/fake-backend.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { SessionActivityRegistry } from '../goal-turn-lifecycle.js';
import { AgentGraphSupervisorWakeCoordinator } from '../agent-graph-supervisor-wake.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';
import {
  AgentGraphClientOperationError,
  AgentGraphCoordinator,
  agentGraphIdForRootSession,
  agentGraphIdForRootSessionEpoch,
  type AgentGraphCoordinatorInput,
} from '../stream-graph-coordinator.js';
import { encodeAgentGraphTerminalCursor } from '../stream-graph-read-model.js';
import {
  UPDATE_AGENT_GRAPH_TOOL_NAME,
  VIEW_AGENT_GRAPH_TOOL_NAME,
  YIELD_AGENT_GRAPH_TOOL_NAME,
  compileAgentGraphScheduleUpdate,
  type UpdateAgentGraphToolInput,
} from '../stream-graph-supervisor-tools.js';
import { projectAgentGraphRecords } from '../stream-graph-projection.js';
import { scheduledWorkIntentId } from '../stream-graph-schedule-reconcile.js';
import { testInvocationOpening } from './invocation-fixture.js';

describe('host-managed agent graph coordinator', () => {
  test('does not enumerate Sessions when no durable graph schedule needs recovery', async () => {
    let sessionLists = 0;
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => {
          sessionLists += 1;
          return [];
        },
      } as never,
      runtimeEventStore: {} as never,
      controlStore: {
        listAgentGraphScheduleRecoveryGraphIds: async () => [],
      } as never,
      runtime: {} as never,
      newId: randomUUID,
    });
    try {
      assert.deepEqual(await coordinator.recover(), []);
      assert.equal(sessionLists, 0);
    } finally {
      await coordinator.close();
    }
  });

  test('authorizes only selected committed results from an earlier epoch of the same root', async () => {
    const store = createSqliteSessionMetadataStore(':memory:');
    const rootSessionId = 'root-session';
    const sourceGraphId = agentGraphIdForRootSession(rootSessionId);
    const currentGraphId = agentGraphIdForRootSessionEpoch(rootSessionId, 2);
    const sourceRun: RuntimeInvocationRecord = {
      sessionId: 'source-child',
      runId: 'source-run',
      turnId: 'source-turn',
      invocationId: 'source-invocation',
      openedAt: 1,
      opening: testInvocationOpening({
        route: {
          provenance: 'runtime',
          backendKind: 'fake',
          llmConnectionId: 'fake-connection',
          llmConnectionSlug: 'fake',
          modelId: 'fake',
        },
        configuration: { cwd: '/workspace', permissionMode: 'explore' },
      }),
      terminalEvent: {
        id: 'source-terminal',
        sessionId: 'source-child',
        invocationId: 'source-invocation',
        runId: 'source-run',
        turnId: 'source-turn',
        ts: 2,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
      },
    };
    const sourceEvent: RuntimeEvent = {
      id: 'source-result-event',
      invocationId: 'source-invocation',
      sessionId: sourceRun.sessionId,
      runId: sourceRun.runId,
      turnId: sourceRun.turnId,
      ts: 2,
      role: 'model',
      author: 'agent',
      partial: false,
      content: { kind: 'text', text: 'Outcome: retain this result.' },
    };
    const selectedRecord = projectAgentGraphRecords({
      graphId: sourceGraphId,
      streams: [
        {
          operator: { operatorId: 'source-operator', sessionId: sourceRun.sessionId },
          run: sourceRun,
          events: [sourceEvent],
        },
      ],
    }).records[0]!;
    const sourceProvision: AgentGraphOperatorProvision = {
      schemaVersion: AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
      provisionId: `graph_provision_${'1'.repeat(32)}`,
      provisionFingerprint: `sha256:${'2'.repeat(64)}`,
      graphId: sourceGraphId,
      workId: `graph_work_${'3'.repeat(32)}`,
      agentId: 'source-agent',
      operatorId: 'source-operator',
      initialTurnId: sourceRun.turnId,
      initialRunId: sourceRun.runId,
      edges: [],
      targetSessionId: sourceRun.sessionId,
      provisionedAt: 1,
    };
    const controlStore = new Proxy(store, {
      get(target, property) {
        if (property === 'listAgentGraphOperatorProvisions') {
          return async (graphId: string) =>
            graphId === sourceGraphId ? [structuredClone(sourceProvision)] : [];
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await store.resolveCurrentAgentGraphEpoch({ rootSessionId, legacyGraphId: sourceGraphId });
    await store.commitAgentGraphScheduleUpdate(
      compileAgentGraphScheduleUpdate({
        graphId: sourceGraphId,
        input: {
          operation: 'finish',
          finish: { result_ids: [selectedRecord.recordId], reason: 'Publish selected output.' },
        },
        context: toolContext(rootSessionId, 'root-run-1', 'root-turn-1', 'finish-source'),
      }),
    );
    await store.advanceAgentGraphEpoch({
      rootSessionId,
      expectedEpoch: 1,
      expectedGraphId: sourceGraphId,
      nextGraphId: currentGraphId,
    });
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({ id: sessionId, status: 'active', isArchived: false }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async (sessionId: string) =>
          sessionId === sourceRun.sessionId ? [sourceRun] : [],
        readImmutableRuntimeEvents: async (sessionId, runId) =>
          sessionId === sourceRun.sessionId && runId === sourceRun.runId ? [sourceEvent] : [],
      },
      controlStore,
      epochStore: store,
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('test does not reconcile new work');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('test does not dispatch new work');
        },
        stopSession: async () => {},
      },
      newId: randomUUID,
    });
    try {
      const tools = await coordinator.toolsForSession(rootSessionId);
      const view = tools.find((tool) => tool.name === VIEW_AGENT_GRAPH_TOOL_NAME) as MakaTool<
        Record<string, never>,
        {
          historicalSelectedResults: Array<{ sourceGraphId: string; resultId: string }>;
          nextHistoricalBeforeEpoch: number | null;
        }
      >;
      const update = tools.find((tool) => tool.name === UPDATE_AGENT_GRAPH_TOOL_NAME) as MakaTool<
        UpdateAgentGraphToolInput,
        unknown
      >;
      assert.ok(view);
      assert.ok(update);
      const viewed = await view.impl({}, toolContext(rootSessionId, 'root-run-2', 'root-turn-2'));
      assert.deepEqual(viewed.historicalSelectedResults, [
        { sourceGraphId, resultId: selectedRecord.recordId },
      ]);
      assert.equal(viewed.nextHistoricalBeforeEpoch, null);
      await update.impl(
        {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'new_agent',
              agent_id: 'reader',
              instruction: 'Continue from the selected result.',
              selected_result_inputs: [
                { source_graph_id: sourceGraphId, result_id: selectedRecord.recordId },
              ],
            },
          ],
        },
        toolContext(rootSessionId, 'root-run-2', 'root-turn-2', 'use-selected'),
      );
      await assert.rejects(
        async () =>
          await update.impl(
            {
              operation: 'add_work',
              add_work: [
                {
                  target_kind: 'new_agent',
                  agent_id: 'reader',
                  instruction: 'Try an unselected record.',
                  selected_result_inputs: [
                    { source_graph_id: sourceGraphId, result_id: 'unselected-record' },
                  ],
                },
              ],
            },
            toolContext(rootSessionId, 'root-run-2', 'root-turn-2', 'use-unselected'),
          ),
        /did not select result/,
      );
      await assert.rejects(
        async () =>
          await update.impl(
            {
              operation: 'add_work',
              add_work: [
                {
                  target_kind: 'new_agent',
                  agent_id: 'reader',
                  instruction: 'Try the current graph.',
                  selected_result_inputs: [
                    { source_graph_id: currentGraphId, result_id: selectedRecord.recordId },
                  ],
                },
              ],
            },
            toolContext(rootSessionId, 'root-run-2', 'root-turn-2', 'use-current'),
          ),
        /not a completed earlier epoch/,
      );
      assert.equal((await store.listAgentGraphScheduleUpdates(currentGraphId)).length, 1);
    } finally {
      await coordinator.close();
      store.close();
    }
  });

  test('boots an empty graph from agent work and recovers it without duplicate topology', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-coordinator-'));
    const sessionStore = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    let graphRuntimeHistoryReads = 0;
    const countedRuntimeEventStore = new Proxy(runtimeEventStore, {
      get(target, property) {
        if (property === 'readImmutableRuntimeEvents') {
          return async (...args: Parameters<typeof target.readImmutableRuntimeEvents>) => {
            graphRuntimeHistoryReads += 1;
            return target.readImmutableRuntimeEvents(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (context) => new FakeBackend(context));
    const manager = new SessionManager({
      store: sessionStore,
      runStore,
      runtimeEventStore,
      backends,
      childTools: localReadTools(),
      newId: randomUUID,
      now: Date.now,
    });
    let controlStore: ReturnType<typeof createSqliteSessionMetadataStore> | undefined;
    let coordinator: AgentGraphCoordinator | undefined;
    let recovered: AgentGraphCoordinator | undefined;
    let supervisorWake: AgentGraphSupervisorWakeCoordinator | undefined;
    let delayedControlStore: ReturnType<typeof createDelayableControlStore> | undefined;
    const clientEvents: string[] = [];
    const activityTrace: Array<{ graph: string; wake: string }> = [];
    const onSessionActivityChanged = (sessionId: string): void => {
      activityTrace.push({
        graph: (coordinator ?? recovered)?.readSessionActivity(sessionId) ?? 'idle',
        wake: supervisorWake?.readSessionActivity(sessionId) ?? 'idle',
      });
    };
    const transientProjectionErrors: unknown[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
      const rootSession = await manager.createSession({
        cwd: root,
        llmConnectionSlug: 'fake',
        permissionMode: 'ask',
        name: 'Graph supervisor',
      });
      const sourceTurnId = randomUUID();
      for await (const _event of manager.sendMessage(rootSession.id, {
        turnId: sourceTurnId,
        text: 'Prepare graph work.',
      })) {
        // Drain the ordinary root turn so its source AgentRun is durable.
      }
      const sourceRun = (await runtimeEventStore.listSessionInvocations(rootSession.id)).find(
        (run) => run.turnId === sourceTurnId,
      );
      assert.ok(sourceRun);

      controlStore = createSqliteSessionMetadataStore(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      delayedControlStore = createDelayableControlStore(controlStore);
      const activities = new SessionActivityRegistry();
      let supervisorWakeTurnCount = 0;
      const supervisorWakeErrors: unknown[] = [];
      supervisorWake = new AgentGraphSupervisorWakeCoordinator({
        activityRegistry: activities,
        onSessionActivityChanged,
        wakeStore: delayedControlStore.store,
        readSnapshot: (sessionId) => (coordinator ?? recovered)!.getSnapshot(sessionId),
        startTurn: async (sessionId, input) => {
          supervisorWakeTurnCount += 1;
          for await (const _event of manager.sendMessage(sessionId, input)) {
            // A real root AgentRun consumes the durable graph wake prompt.
          }
          return { kind: 'completed', turnId: input.turnId };
        },
        inspectAttempt: async (sessionId, attemptId, turnId) => {
          const run = (await runtimeEventStore.listSessionInvocations(sessionId)).find(
            (candidate) =>
              candidate.opening.root.kind === 'agent_graph_supervisor_wake' &&
              candidate.opening.root.attemptId === attemptId &&
              candidate.turnId === turnId,
          );
          if (!run) return 'missing';
          return runtimeInvocationOutcome(run) ?? 'running';
        },
        newId: randomUUID,
        onError: (_rootSessionId, error) => {
          supervisorWakeErrors.push(error);
        },
      });
      coordinator = createCoordinator({
        sessionStore,
        runStore,
        runtimeEventStore: countedRuntimeEventStore,
        controlStore: delayedControlStore.store,
        manager,
        onSessionActivityChanged,
        onReconciliation: (rootSessionId, result) => {
          supervisorWake!.notify(rootSessionId, result);
        },
        onError: (_rootSessionId, error) => {
          transientProjectionErrors.push(error);
        },
      });
      unsubscribe = coordinator.subscribe(rootSession.id, (event) => {
        assert.equal(event.rootSessionId, rootSession.id);
        clientEvents.push(event.reason);
      });
      const tools = await coordinator.toolsForSession(rootSession.id);
      const update = tools.find((tool) => tool.name === UPDATE_AGENT_GRAPH_TOOL_NAME);
      const yieldGraph = tools.find((tool) => tool.name === YIELD_AGENT_GRAPH_TOOL_NAME);
      assert.ok(update);
      assert.ok(yieldGraph);
      const graphId = agentGraphIdForRootSession(rootSession.id);
      await assert.rejects(
        async () =>
          await update.impl(
            {
              add_work: [
                {
                  agent_id: 'local-read',
                  instruction: 'This request must not become durable.',
                  input_ids: [],
                },
              ],
            },
            toolContext('different-root', sourceRun.runId, sourceTurnId),
          ),
        /not authorized/,
      );
      assert.equal((await controlStore.listAgentGraphScheduleUpdates(graphId)).length, 0);
      const originalSupervisorActivity = activities.reserve(rootSession.id);
      assert.equal(coordinator.readSessionActivity(rootSession.id), 'idle');
      await update.impl(
        {
          add_work: [
            {
              agent_id: 'local-read',
              instruction: 'Inspect the repository and report one concrete finding.',
              input_ids: [],
            },
          ],
        },
        toolContext(rootSession.id, sourceRun.runId, sourceTurnId),
      );
      const yielded = (await yieldGraph.impl(
        { reason: 'The claimed activation is now running.' },
        toolContext(rootSession.id, sourceRun.runId, sourceTurnId, 'tool-yield-running'),
      )) as { kind: string; pendingWorkCount: number };
      assert.equal(yielded.kind, 'agent_graph_yielded');
      assert.equal(yielded.pendingWorkCount, 1);
      await coordinator.waitForIdle(rootSession.id);
      assert.equal(
        supervisorWakeTurnCount,
        0,
        'the host wake must wait until the original supervisor turn returns',
      );
      originalSupervisorActivity.release();
      assert.equal(
        coordinator.readSessionActivity(rootSession.id),
        'idle',
        'fulfilled but still open graph is not itself busy',
      );
      assert.equal(
        supervisorWake.readSessionActivity(rootSession.id),
        'running',
        'a queued supervisor wake keeps the root active after its child ends',
      );
      assert.ok(activityTrace.length > 0);
      assert.ok(
        activityTrace.every(({ graph, wake }) => graph === 'running' || wake === 'running'),
        'no idle gap between child execution, projection, checkpoint, and wake admission',
      );
      assert.ok(
        activityTrace.length < 8,
        'child text deltas do not publish catalog activity changes',
      );
      await supervisorWake.waitForIdle();
      assert.equal(supervisorWake.readSessionActivity(rootSession.id), 'idle');
      assert.deepEqual(supervisorWakeErrors, []);
      assert.equal(supervisorWakeTurnCount, 1);
      const graphWake = (await manager.getMessages(rootSession.id)).find(
        (message) => message.type === 'user' && message.origin?.kind === 'agent_graph',
      );
      assert.ok(graphWake?.type === 'user');
      assert.ok(graphWake.origin?.kind === 'agent_graph');
      assert.equal(graphWake.origin.graphId, agentGraphIdForRootSession(rootSession.id));
      assert.match(graphWake.origin.wakeId, /sha256:[a-f0-9]{64}$/);
      assert.match(graphWake.origin.attemptId, /^[0-9a-f-]{36}$/);
      assert.match(graphWake.text, /view_agent_graph/);
      assert.ok(
        (await manager.getMessages(rootSession.id)).some(
          (message) => message.type === 'assistant' && message.turnId === graphWake.turnId,
        ),
        'the original root Agent must run again and produce a deliverable response',
      );
      const wakeRun = (await runtimeEventStore.listSessionInvocations(rootSession.id)).find(
        (run) => run.turnId === graphWake.turnId,
      );
      assert.ok(wakeRun);
      assert.deepEqual(wakeRun.opening.root, {
        kind: 'agent_graph_supervisor_wake',
        wakeId: graphWake.origin.wakeId,
        attemptId: graphWake.origin.attemptId,
      });
      const wakeEvents = await runtimeEventStore.readImmutableRuntimeEvents(
        rootSession.id,
        wakeRun.runId,
      );
      assert.deepEqual(
        wakeEvents[0]?.content?.kind === 'invocation_opened'
          ? wakeEvents[0].content.root
          : undefined,
        {
          kind: 'agent_graph_supervisor_wake',
          wakeId: graphWake.origin.wakeId,
          attemptId: graphWake.origin.attemptId,
        },
        'the opening fact must name the host authority that woke this invocation',
      );
      assert.equal(
        wakeEvents[1]?.author,
        'host',
        'canonical provenance must distinguish the host-authored wake from human input',
      );
      const durableWake = await controlStore.readAgentGraphSupervisorWake(
        graphWake.origin.graphId,
        graphWake.origin.wakeId,
      );
      assert.equal(durableWake?.status, 'delivered');
      assert.equal(durableWake?.attemptCount, 1);

      const firstProvisions = await controlStore.listAgentGraphOperatorProvisions(graphId);
      assert.equal(firstProvisions.length, 1);
      assert.equal(firstProvisions[0]?.agentId, 'local-read');
      assert.equal((await controlStore.listAgentGraphIntentClaims(graphId)).length, 1);
      assert.equal((await coordinator.observe(rootSession.id)).projection.operators.length, 1);
      const historyReadsBeforeClient = graphRuntimeHistoryReads;
      const childSessions = await manager.listChildSessions(rootSession.id);
      assert.equal(childSessions.length, 1);
      assert.equal(
        childSessions[0]?.subagentParent?.graph?.operatorId,
        firstProvisions[0]?.operatorId,
      );
      const snapshot = await coordinator.getSnapshot(rootSession.id);
      assert.equal(snapshot.rootSessionId, rootSession.id);
      assert.equal(snapshot.graphId, graphId);
      assert.equal(snapshot.scheduleRevision, 1);
      assert.equal(snapshot.operators.length, 1);
      assert.equal(snapshot.operators[0]?.childSessionId, childSessions[0]?.id);
      assert.equal(snapshot.operators[0]?.agentId, 'local-read');
      assert.equal(
        snapshot.work[0]?.instructionPreview,
        'Inspect the repository and report one concrete finding.',
      );
      assert.match(snapshot.snapshotVersion, /^sha256:[a-f0-9]{64}$/);
      const readsBeforeInspection = delayedControlStore.projectionReadCounts();
      const inspection = await coordinator.inspectOperator(
        rootSession.id,
        firstProvisions[0]!.operatorId,
      );
      assert.equal(inspection.operator.childSessionId, childSessions[0]?.id);
      assert.equal(inspection.claims.length, 1);
      assert.equal(inspection.activations.length, 1);
      assert.deepEqual(delayedControlStore.projectionReadCounts(), {
        snapshot: readsBeforeInspection.snapshot + 1,
        composite: readsBeforeInspection.composite + 1,
        operator: readsBeforeInspection.operator,
        terminal: readsBeforeInspection.terminal,
      });
      assert.equal(
        graphRuntimeHistoryReads,
        historyReadsBeforeClient,
        'client reads must use the materialized SQLite projection',
      );
      const readsBeforeInvalidCursor = delayedControlStore.projectionReadCounts();
      const commitsBeforeInvalidCursor = delayedControlStore.projectionCommits.length;
      await assert.rejects(
        coordinator.getSnapshot(rootSession.id, { terminalCursor: 'invalid-cursor' }),
        (error: unknown) =>
          error instanceof AgentGraphClientOperationError && error.code === 'invalid_request',
      );
      assert.deepEqual(
        delayedControlStore.projectionReadCounts(),
        readsBeforeInvalidCursor,
        'invalid cursors must fail before reading or repairing the materialized projection',
      );
      assert.equal(
        delayedControlStore.projectionCommits.length,
        commitsBeforeInvalidCursor,
        'invalid cursors must fail before committing a repaired materialized projection',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(clientEvents.includes('reconciled'));
      assert.equal(
        clientEvents.filter((reason) => reason === 'runtime_activity').length,
        2,
        'partial text deltas must not cause projection writes or invalidations',
      );
      const incrementalProjectionCommits = delayedControlStore.projectionCommits.filter(
        (request) => request.incrementalRecordId !== undefined,
      );
      assert.equal(incrementalProjectionCommits.length, 2);
      assert.ok(
        incrementalProjectionCommits.every((request) => request.terminalActivities.length === 0),
        'yielded SessionEvents must never write immutable terminal history',
      );
      assert.equal(
        (
          await controlStore.listAgentGraphClientTerminalActivities(graphId, {
            limit: 8,
          })
        ).records.length,
        1,
        'the authoritative RuntimeEvent fold must populate terminal history',
      );
      await assert.rejects(
        coordinator.getSnapshot(rootSession.id, {
          terminalCursor: encodeAgentGraphTerminalCursor(graphId, {
            recordId: 'missing-terminal-record',
            eventTime: 1,
          }),
        }),
        (error: unknown) =>
          error instanceof AgentGraphClientOperationError && error.code === 'invalid_request',
      );
      await assert.rejects(
        coordinator.toolsForSession(childSessions[0]!.id),
        /only to root Sessions/,
      );
      await assert.rejects(
        coordinator.listGraphEpochPage(childSessions[0]!.id, { limit: 32 }),
        (error: unknown) =>
          error instanceof AgentGraphClientOperationError && error.code === 'operation_conflict',
      );
      await assert.rejects(
        coordinator.listGraphEpochPage(randomUUID(), { limit: 32 }),
        (error: unknown) => isSessionNotFoundError(error),
      );
      let childStopEntered = false;
      await assert.rejects(
        coordinator.stopExecution(childSessions[0]!.id, {
          expectedGraphId: graphId,
          stopSupervisor: async () => {
            childStopEntered = true;
          },
          withSupervisorWakesSuppressed: async (operation) => {
            childStopEntered = true;
            await operation();
          },
        }),
        /only to root Sessions/,
      );
      assert.equal(childStopEntered, false);

      const canonicalProjection = await controlStore.readAgentGraphClientProjection(graphId);
      assert.ok(canonicalProjection);
      const staleSnapshot = structuredClone(
        canonicalProjection.payload as { snapshotVersion: string },
      );
      staleSnapshot.snapshotVersion = 'snapshot-stale-v1';
      await controlStore.commitAgentGraphClientProjection({
        schemaVersion: 1,
        graphId,
        rootSessionId: rootSession.id,
        expectedSnapshotVersion: canonicalProjection.snapshotVersion,
        snapshotVersion: staleSnapshot.snapshotVersion,
        snapshot: staleSnapshot,
        replaceOperators: false,
        operators: [],
        terminalActivities: [],
        activityRecords: [],
      });
      const transientProjectionFailure = new Error('transient derived projection failure');
      delayedControlStore.failNextProjectionCommits(1, transientProjectionFailure);
      const commitsBeforeRepair = delayedControlStore.projectionCommits.length;
      const runtimeActivityBeforeRepair = clientEvents.filter(
        (reason) => reason === 'runtime_activity',
      ).length;
      await coordinator.reconcile(rootSession.id);
      await supervisorWake.waitForIdle();
      assert.equal(
        supervisorWakeTurnCount,
        1,
        'the same durable graph snapshot must not wake the supervisor twice',
      );
      assert.ok(transientProjectionErrors.includes(transientProjectionFailure));
      assert.equal(
        (await controlStore.readAgentGraphClientProjection(graphId))?.snapshotVersion,
        canonicalProjection.snapshotVersion,
        'reconcile tail must repair a one-shot projection failure without new graph activity',
      );
      assert.ok(
        delayedControlStore.projectionCommits.length >= commitsBeforeRepair + 2,
        'one failed materialization must be followed by an authoritative repair',
      );
      assert.equal(
        clientEvents.filter((reason) => reason === 'runtime_activity').length,
        runtimeActivityBeforeRepair,
        'repair liveness must not depend on new graph runtime activity',
      );

      await coordinator.close();
      unsubscribe = undefined;
      coordinator = undefined;
      const projectionFailure = new Error('derived projection unavailable');
      const derivedFailures: unknown[] = [];
      delayedControlStore.failProjectionCommits(projectionFailure);
      assert.equal(await supervisorWake.recover(), 0);
      recovered = createCoordinator({
        sessionStore,
        runStore,
        runtimeEventStore: countedRuntimeEventStore,
        controlStore: delayedControlStore.store,
        manager,
        onReconciliation: (rootSessionId, result) => {
          supervisorWake!.notify(rootSessionId, result);
        },
        onError: (_rootSessionId, error) => {
          derivedFailures.push(error);
        },
      });
      assert.deepEqual(await recovered.recover(), [rootSession.id]);
      await supervisorWake.waitForIdle();
      assert.equal(
        supervisorWakeTurnCount,
        1,
        'restart recovery must honor the persisted graph wake idempotency marker',
      );
      assert.ok(
        derivedFailures.includes(projectionFailure),
        'recover must report projection failure without failing graph authority',
      );
      assert.equal((await controlStore.listAgentGraphOperatorProvisions(graphId)).length, 1);
      assert.equal((await controlStore.listAgentGraphIntentClaims(graphId)).length, 1);
      assert.equal((await manager.listChildSessions(rootSession.id)).length, 1);

      const recoveredTools = await recovered.toolsForSession(rootSession.id);
      const delayedUpdate = recoveredTools.find(
        (tool) => tool.name === UPDATE_AGENT_GRAPH_TOOL_NAME,
      );
      assert.ok(delayedUpdate);
      const gate = delayedControlStore.holdNextCommit();
      const pendingUpdate = Promise.resolve(
        delayedUpdate.impl(
          {
            add_work: [
              {
                agent_id: 'local-read',
                instruction: 'This pre-stop update must remain paused.',
                input_ids: [],
              },
            ],
          },
          toolContext(rootSession.id, sourceRun.runId, sourceTurnId, 'tool-call-graph-stop-race'),
        ),
      );
      await gate.started;
      try {
        let mismatchedStopEntered = false;
        await assert.rejects(
          recovered.stopExecution(rootSession.id, {
            expectedGraphId: 'agent_graph_stale',
            stopSupervisor: async () => {
              mismatchedStopEntered = true;
            },
            withSupervisorWakesSuppressed: (operation) => operation(),
          }),
          (error: unknown) =>
            error instanceof AgentGraphClientOperationError && error.code === 'operation_conflict',
        );
        assert.equal(mismatchedStopEntered, false);

        const supervisorStopFailure = new Error('supervisor stop failed');
        await assert.rejects(
          recovered.stopExecution(rootSession.id, {
            expectedGraphId: graphId,
            stopSupervisor: async () => {
              throw supervisorStopFailure;
            },
            withSupervisorWakesSuppressed: (operation) => operation(),
          }),
          (error: unknown) => error === supervisorStopFailure,
        );
      } finally {
        gate.release();
      }
      assert.ok(
        derivedFailures.filter((error) => error === projectionFailure).length >= 2,
        'stop must report best-effort projection repair failure without rejecting',
      );
      await pendingUpdate;
      await recovered.waitForIdle(rootSession.id);
      assert.equal(
        (await controlStore.listAgentGraphOperatorProvisions(graphId)).length,
        1,
        'a schedule commit authorized before stop must not restart reconciliation',
      );
    } finally {
      unsubscribe?.();
      await coordinator?.close();
      await recovered?.close();
      await supervisorWake?.close();
      controlStore?.close();
      await sessionStore.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('replaying completed work cannot revive an older activation after newer work stops', async () => {
    await withActivityGraph(async ({ coordinator, rootSessionId, update, runtimeEventStore }) => {
      const initial = await coordinator.getSnapshot(rootSessionId);
      const operator = initial.operators[0]!;
      await update({
        operation: 'add_work',
        add_work: [
          {
            target_kind: 'existing_operator',
            operator_id: operator.operatorId,
            instruction: 'Complete a second independent request.',
            input_ids: [],
          },
        ],
      });
      await coordinator.waitForIdle(rootSessionId);
      const completed = await coordinator.getSnapshot(rootSessionId);
      const latestWork = completed.work.find((work) => work.revision === 2);
      assert.ok(latestWork);
      assert.equal(completed.operators[0]?.status, 'completed');
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
      const runsBeforeReplay = await runtimeEventStore.listSessionInvocations(
        operator.childSessionId,
      );
      assert.equal(runsBeforeReplay.length, 2);

      await update({
        operation: 'stop',
        stop: [{ target_id: latestWork.workId, reason: 'The second request is no longer needed.' }],
      });
      await coordinator.waitForIdle(rootSessionId);
      const replay = await coordinator.reconcile(rootSessionId);
      const snapshot = await coordinator.getSnapshot(rootSessionId);
      assert.deepEqual(replay.failures, []);
      assert.equal(snapshot.closed, false);
      assert.equal(snapshot.work.find((work) => work.revision === 1)?.status, 'requested');
      assert.equal(snapshot.operators[0]?.status, 'completed');
      assert.equal(
        coordinator.readSessionActivity(rootSessionId),
        'idle',
        'replaying an older completed claim must not replace the latest completed activation',
      );
      assert.deepEqual(
        await runtimeEventStore.listSessionInvocations(operator.childSessionId),
        runsBeforeReplay,
        'reconciliation must reuse completed claims without starting another physical Run',
      );
    });
  });

  test('new work on a completed operator stays blocked on missing input while live producers stay running', async () => {
    const producerStarted = deferred();
    const producerReleased = deferred();
    await withActivityGraph(
      async ({ coordinator, rootSessionId, update }) => {
        try {
          const operator = (await coordinator.getSnapshot(rootSessionId)).operators[0]!;
          await update({
            operation: 'add_work',
            add_work: [
              {
                target_kind: 'existing_operator',
                operator_id: operator.operatorId,
                instruction: 'Continue only after the requested upstream record is committed.',
                input_ids: ['missing-record'],
              },
            ],
          });
          await coordinator.waitForIdle(rootSessionId);
          const waiting = await coordinator.reconcile(rootSessionId);
          assert.equal(waiting.status, 'waiting');
          assert.deepEqual(waiting.failures, []);
          assert.deepEqual(
            waiting.deferredWork.map((entry) => entry.reason),
            ['input_not_committed'],
          );
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'blocked');

          await update({
            operation: 'add_work',
            add_work: [
              {
                agent_id: 'local-read',
                instruction: 'held-producer: gather another upstream result.',
                input_ids: [],
              },
            ],
          });
          await withTimeout(producerStarted.promise, 5_000, 'The graph producer did not start');
          assert.equal(
            coordinator.readSessionActivity(rootSessionId),
            'running',
            'a real child invocation takes precedence while the existing operator awaits input',
          );
          producerReleased.resolve();
          await coordinator.waitForIdle(rootSessionId);
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'blocked');
        } finally {
          producerReleased.resolve();
        }
      },
      async (input) => {
        if (!input.text.includes('held-producer:')) return;
        producerStarted.resolve();
        await producerReleased.promise;
      },
    );
  });

  test('a first child request updates activity before its claim reaches the full client projection', async (t) => {
    for (const duringWave of [false, true]) {
      await t.test(
        duringWave ? 'schedule added during a live wave' : 'schedule starts a new wave',
        async () => {
          const started = deferred();
          const released = deferred();
          const earlierStarted = deferred();
          const earlierReleased = deferred();
          let child: { sessionId: string; turnId: string } | undefined;
          let pending = 0;
          await withActivityGraph(
            async ({ coordinator, rootSessionId, update, delayedStore }) => {
              if (duringWave) {
                await update({
                  add_work: [
                    { agent_id: 'local-read', instruction: 'earlier-wave-child', input_ids: [] },
                  ],
                });
                await withTimeout(earlierStarted.promise, 5_000, 'The earlier wave did not start');
              }
              const projectionGate = delayedStore.holdProjectionCommits();
              try {
                await update({
                  add_work: [
                    { agent_id: 'local-read', instruction: 'first-request-child', input_ids: [] },
                  ],
                });
                earlierReleased.resolve();
                await withTimeout(
                  started.promise,
                  5_000,
                  'The first child request was not reached',
                );
                assert.ok(child);
                assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
                const persisted = await delayedStore.store.readAgentGraphClientProjection(
                  agentGraphIdForRootSession(rootSessionId),
                );
                assert.ok(persisted);
                assert.ok(
                  (persisted.payload as { scheduleRevision: number }).scheduleRevision <
                    (duringWave ? 3 : 2),
                  'the new child claim is still absent from the gated full client projection',
                );
                pending = 1;
                coordinator.refreshSessionInteractionActivity(child.sessionId);
                assert.equal(coordinator.readSessionActivity(rootSessionId), 'waiting_for_user');
                pending = 0;
                coordinator.refreshSessionInteractionActivity(child.sessionId);
                assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
              } finally {
                projectionGate.release();
                released.resolve();
                earlierReleased.resolve();
              }
              await coordinator.waitForIdle(rootSessionId);
              assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
            },
            async (input, sessionId) => {
              if (input.text.includes('earlier-wave-child')) {
                earlierStarted.resolve();
                await earlierReleased.promise;
                return;
              }
              if (!input.text.includes('first-request-child')) return;
              child = { sessionId, turnId: input.turnId };
              started.resolve();
              await released.promise;
            },
            (sessionId, turnId) =>
              child?.sessionId === sessionId && child.turnId === turnId ? pending : 0,
          );
        },
      );
    }
  });

  test('terminal projection failures cannot keep completed child work running', async () => {
    const started = deferred();
    const released = deferred();
    await withActivityGraph(
      async ({
        coordinator,
        rootSessionId,
        update,
        runtimeEventStore,
        delayedStore,
        errors,
        activityChanges,
      }) => {
        try {
          await update({
            add_work: [
              { agent_id: 'local-read', instruction: 'held-terminal-child', input_ids: [] },
            ],
          });
          await withTimeout(started.promise, 5_000, 'The child did not reach its terminal gate');
          const running = await coordinator.getSnapshot(rootSessionId);
          const child = running.operators.find((operator) => operator.status === 'running');
          assert.ok(child);
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');

          const failure = new Error('terminal activity projection unavailable');
          delayedStore.failProjectionCommits(failure);
          released.resolve();
          await coordinator.waitForIdle(rootSessionId);
          const runs = await runtimeEventStore.listSessionInvocations(child.childSessionId);
          assert.ok(runs.length > 0);
          assert.ok(runs.every((run) => runtimeInvocationOutcome(run) === 'completed'));
          assert.ok(errors.includes(failure));
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'blocked');
          assert.equal(activityChanges.at(-1), 'blocked');

          delayedStore.clearProjectionFailure();
          const repaired = await coordinator.getSnapshot(rootSessionId);
          assert.ok(repaired.operators.every((operator) => operator.status === 'completed'));
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
          assert.equal(activityChanges.at(-1), 'idle');
        } finally {
          released.resolve();
          delayedStore.clearProjectionFailure();
        }
      },
      undefined,
      undefined,
      async (input) => {
        if (!input.text.includes('held-terminal-child')) return;
        started.resolve();
        await released.promise;
      },
    );
  });

  test('repairing a failed graph projection publishes idle without a selected Session subscription', async () => {
    await withActivityGraph(
      async ({ coordinator, rootSessionId, activityChanges, delayedStore, errors }) => {
        const failure = new Error('activity projection temporarily unavailable');
        delayedStore.failProjectionCommits(failure);
        await coordinator.reconcile(rootSessionId);
        assert.ok(errors.includes(failure));
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'blocked');
        assert.equal(activityChanges.at(-1), 'blocked');
        const changesBeforeRepair = activityChanges.length;

        delayedStore.clearProjectionFailure();
        const snapshot = await coordinator.getSnapshot(rootSessionId);
        assert.equal(snapshot.closed, false);
        assert.ok(snapshot.work.some((work) => work.status === 'requested'));
        assert.equal(snapshot.operators[0]?.status, 'completed');
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
        assert.ok(activityChanges.length > changesBeforeRepair);
        assert.equal(
          activityChanges.at(-1),
          'idle',
          'catalog observers must be invalidated after the projection failure clears',
        );
      },
    );
  });

  test('derives stable graph identity from the root Session', async () => {
    const graphId = agentGraphIdForRootSession('root-session');
    assert.match(graphId, /^agent_graph_[a-f0-9]{32}$/);
    assert.equal(graphId, agentGraphIdForRootSession('root-session'));
    assert.notEqual(graphId, agentGraphIdForRootSession('other-root'));
  });

  test('reports asynchronous epoch lookup failures from a fire-and-forget wake', async () => {
    const controlStore = createSqliteSessionMetadataStore(':memory:');
    const failure = new Error('epoch authority unavailable');
    const errors: unknown[] = [];
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async () => {
          throw new Error('wake must fail before reading the Session');
        },
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore,
      epochStore: {
        resolveCurrentAgentGraphEpoch: async () => {
          throw failure;
        },
        advanceAgentGraphEpoch: async () => {
          throw new Error('unexpected epoch advance');
        },
        listAgentGraphEpochs: async () => [],
        readAgentGraphEpochByGraphId: async () => undefined,
        listAgentGraphEpochPage: async () => ({
          epochs: [],
          nextBeforeEpoch: null,
          currentEpoch: null,
        }),
      },
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('unexpected operator provision');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('unexpected operator dispatch');
        },
        stopSession: async () => {},
      },
      newId: randomUUID,
      onError: (_rootSessionId, error) => {
        errors.push(error);
      },
    });
    try {
      assert.equal(coordinator.wake('root-session'), undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(errors, [failure]);
    } finally {
      await coordinator.close();
      controlStore.close();
    }
  });

  test('reads the epoch page and current marker from one storage observation', async () => {
    const controlStore = createSqliteSessionMetadataStore(':memory:');
    let resolveCalls = 0;
    let headerReads = 0;
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) => {
          headerReads += 1;
          return {
            id: sessionId,
            status: 'active',
            isArchived: false,
            orchestrationMode: 'graph',
          } as never;
        },
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore,
      epochStore: {
        resolveCurrentAgentGraphEpoch: async () => {
          resolveCalls += 1;
          // A second, separate read could observe a stale epoch after a
          // rollover; the listing must not consult it when the page is
          // authoritative.
          return {
            schemaVersion: 1 as const,
            rootSessionId: 'root-session',
            epoch: 2,
            graphId: 'agent_graph_2',
            createdAt: 2,
          };
        },
        advanceAgentGraphEpoch: async () => {
          throw new Error('unexpected epoch advance');
        },
        listAgentGraphEpochs: async () => [],
        readAgentGraphEpochByGraphId: async () => undefined,
        listAgentGraphEpochPage: async () => ({
          epochs: [
            {
              schemaVersion: 1 as const,
              rootSessionId: 'root-session',
              epoch: 3,
              graphId: 'agent_graph_3',
              createdAt: 3,
            },
            {
              schemaVersion: 1 as const,
              rootSessionId: 'root-session',
              epoch: 2,
              graphId: 'agent_graph_2',
              createdAt: 2,
            },
          ],
          nextBeforeEpoch: null,
          currentEpoch: 3,
        }),
      },
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('unexpected operator provision');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('unexpected operator dispatch');
        },
        stopSession: async () => {},
      },
      newId: randomUUID,
      onError: () => {},
    });
    try {
      const page = await coordinator.listGraphEpochPage('root-session', { limit: 32 });
      assert.equal(page.currentEpoch, 3);
      assert.equal(page.epochs[0]?.graphId, 'agent_graph_3');
      assert.equal(resolveCalls, 0);
      assert.equal(headerReads, 1);
      await assert.rejects(
        coordinator.listGraphEpochPage('root-session', { beforeEpoch: 999, limit: 32 }),
        (error: unknown) =>
          error instanceof AgentGraphClientOperationError && error.code === 'invalid_request',
      );
    } finally {
      await coordinator.close();
      controlStore.close();
    }
  });

  test('lists graph ids for tombstone cleanup without reading the Session header', async () => {
    const controlStore = createSqliteSessionMetadataStore(':memory:');
    const epochs = [
      {
        schemaVersion: 1 as const,
        rootSessionId: 'removed-root',
        epoch: 2,
        graphId: 'agent_graph_2',
        createdAt: 2,
      },
      {
        schemaVersion: 1 as const,
        rootSessionId: 'removed-root',
        epoch: 1,
        graphId: 'agent_graph_1',
        createdAt: 1,
      },
    ];
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async () => {
          throw new Error('removed Session header must not be read during cleanup');
        },
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore,
      epochStore: {
        resolveCurrentAgentGraphEpoch: async () => epochs[0]!,
        advanceAgentGraphEpoch: async () => {
          throw new Error('unexpected epoch advance');
        },
        listAgentGraphEpochs: async () => epochs,
        readAgentGraphEpochByGraphId: async () => undefined,
        listAgentGraphEpochPage: async () => ({
          epochs,
          nextBeforeEpoch: null,
          currentEpoch: 2,
        }),
      },
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('unexpected operator provision');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('unexpected operator dispatch');
        },
        stopSession: async () => {},
      },
      newId: randomUUID,
      onError: () => {},
    });
    try {
      assert.deepEqual(await coordinator.listGraphIds('removed-root'), [
        'agent_graph_2',
        'agent_graph_1',
      ]);
    } finally {
      await coordinator.close();
      controlStore.close();
    }
  });

  test('advances only a finished and quiescent graph without waiting for old operator cleanup', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-epoch-cutover-'));
    const controlStore = createSqliteSessionMetadataStore(
      join(root, OPERATIONAL_STATE_DATABASE_NAME),
    );
    const rootSessionId = 'root-session';
    const graphId = agentGraphIdForRootSession(rootSessionId);
    const stopStarted = deferred();
    const releaseStop = deferred();
    let stopping: Promise<void> | undefined;
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'active',
            isArchived: false,
            orchestrationMode: 'graph',
          }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore,
      epochStore: controlStore,
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('epoch cutover cannot provision operators');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('epoch cutover cannot dispatch operators');
        },
        stopSession: async () => {
          stopStarted.resolve();
          await releaseStop.promise;
        },
      },
      newId: randomUUID,
    });
    let suppressions = 0;
    const withWakesSuppressed = async (operation: () => Promise<void>) => {
      suppressions += 1;
      await operation();
    };
    try {
      assert.equal(
        (await coordinator.beginNextGraphEpoch(rootSessionId, withWakesSuppressed)).graphId,
        graphId,
      );
      assert.equal(suppressions, 0);

      await controlStore.commitAgentGraphScheduleUpdate(
        compileAgentGraphScheduleUpdate({
          graphId,
          input: {
            operation: 'finish',
            finish: { result_ids: ['result-1'], reason: 'No work remains.' },
          },
          context: toolContext(rootSessionId, 'run-root', 'turn-root', 'tool-finish'),
        }),
      );
      t.mock.method(controlStore, 'listAgentGraphOperatorProvisions', async (id: string) =>
        id === graphId
          ? [
              {
                schemaVersion: AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
                graphId,
                provisionId: `graph_provision_${'1'.repeat(32)}`,
                provisionFingerprint: `sha256:${'2'.repeat(64)}`,
                workId: `graph_work_${'3'.repeat(32)}`,
                agentId: 'agent',
                operatorId: `graph_operator_${'4'.repeat(32)}`,
                targetSessionId: 'child-session',
                initialTurnId: 'child-turn',
                initialRunId: 'child-run',
                provisionedAt: 1,
                edges: [],
              },
            ]
          : [],
      );
      stopping = coordinator.stop(rootSessionId);
      await stopStarted.promise;
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
      const next = await withTimeout(
        coordinator.beginNextGraphEpoch(rootSessionId, withWakesSuppressed),
        5_000,
        'a terminal epoch must not block the next turn on old operator cleanup',
      );
      assert.equal(next.epoch, 2);
      assert.equal(
        coordinator.readSessionActivity(rootSessionId),
        'idle',
        'old epoch cleanup cannot keep the current Session busy',
      );
      assert.equal(next.graphId, agentGraphIdForRootSessionEpoch(rootSessionId, 2));
      assert.equal(suppressions, 1);

      const retry = await coordinator.beginNextGraphEpoch(rootSessionId, withWakesSuppressed);
      assert.equal(retry.graphId, next.graphId);
      assert.equal(suppressions, 1);
      assert.deepEqual(
        (await controlStore.listAgentGraphEpochs(rootSessionId)).map(({ epoch, graphId }) => ({
          epoch,
          graphId,
        })),
        [
          { epoch: 1, graphId },
          { epoch: 2, graphId: next.graphId },
        ],
      );
    } finally {
      releaseStop.resolve();
      await stopping;
      await coordinator.close();
      controlStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('concurrent cutovers converge on epoch 2 without skipping an epoch', async () => {
    const controlStore = createSqliteSessionMetadataStore(':memory:');
    const rootSessionId = 'root-session';
    const graphId = agentGraphIdForRootSession(rootSessionId);
    const coordinatorInput = {
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'active',
            isArchived: false,
            orchestrationMode: 'graph',
          }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore,
      epochStore: controlStore,
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('epoch cutover cannot provision operators');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('epoch cutover cannot dispatch operators');
        },
        stopSession: async () => {},
      },
      newId: randomUUID,
    } satisfies AgentGraphCoordinatorInput;
    const first = new AgentGraphCoordinator(coordinatorInput);
    const second = new AgentGraphCoordinator(coordinatorInput);
    await controlStore.commitAgentGraphScheduleUpdate(
      compileAgentGraphScheduleUpdate({
        graphId,
        input: {
          operation: 'finish',
          finish: { result_ids: ['result-1'], reason: 'No work remains.' },
        },
        context: toolContext(rootSessionId, 'run-root', 'turn-root', 'tool-finish'),
      }),
    );
    const gate = deferredGate();
    let entrants = 0;
    const withWakesSuppressed = async (operation: () => Promise<void>) => {
      entrants += 1;
      if (entrants === 2) gate.release();
      await gate.ready;
      await operation();
    };
    try {
      const [left, right] = await Promise.all([
        first.beginNextGraphEpoch(rootSessionId, withWakesSuppressed),
        second.beginNextGraphEpoch(rootSessionId, withWakesSuppressed),
      ]);
      assert.equal(left.epoch, 2);
      assert.equal(right.epoch, 2);
      assert.deepEqual(
        (await controlStore.listAgentGraphEpochs(rootSessionId)).map(({ epoch }) => epoch),
        [1, 2],
      );
    } finally {
      gate.release();
      await first.close();
      await second.close();
      controlStore.close();
    }
  });

  test('persists work-keyed reconciliation failures across coordinator recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-failure-recovery-'));
    const sessionStore = createSessionStore(root);
    const runStore = createSqliteAgentRunStore(root);
    const runtimeEventStore = createWorkspaceRuntimeStore(root);
    const controlStore = createSqliteSessionMetadataStore(
      join(root, OPERATIONAL_STATE_DATABASE_NAME),
    );
    const backends = new BackendRegistry();
    backends.register('ai-sdk', (context) => new FakeBackend(context));
    const manager = new SessionManager({
      store: sessionStore,
      runStore,
      runtimeEventStore,
      backends,
      childTools: localReadTools(),
      newId: randomUUID,
      now: Date.now,
    });
    let coordinator: AgentGraphCoordinator | undefined;
    let recovered: AgentGraphCoordinator | undefined;
    try {
      const rootSession = await manager.createSession({
        cwd: root,
        llmConnectionSlug: 'fake',
        permissionMode: 'ask',
        orchestrationMode: 'swarm',
        name: 'Failure recovery supervisor',
      });
      const sourceTurnId = randomUUID();
      for await (const _event of manager.sendMessage(rootSession.id, {
        turnId: sourceTurnId,
        text: 'Schedule failing graph work.',
      })) {
        // Drain the source turn so its AgentRun is durable.
      }
      const sourceRun = (await runtimeEventStore.listSessionInvocations(rootSession.id)).find(
        (run) => run.turnId === sourceTurnId,
      );
      assert.ok(sourceRun);
      const failingRuntime: AgentGraphCoordinatorInput['runtime'] = {
        provisionAgentGraphOperator: async () => {
          throw new Error('preset provider unavailable');
        },
        runClaimedAgentGraphIntent: manager.runClaimedAgentGraphIntent.bind(manager),
        stopSession: manager.stopSession.bind(manager),
      };
      const create = () =>
        new AgentGraphCoordinator({
          sessionStore,
          runtimeEventStore,
          controlStore,
          runtime: failingRuntime,
          newId: randomUUID,
          rootSessionId: rootSession.id,
        });
      coordinator = create();
      const update = (await coordinator.toolsForSession(rootSession.id)).find(
        (tool) => tool.name === UPDATE_AGENT_GRAPH_TOOL_NAME,
      );
      assert.ok(update);
      const committed = (await update.impl(
        {
          operation: 'add_work',
          add_work: [
            {
              target_kind: 'new_agent',
              agent_id: 'local-read',
              instruction: 'This provision is expected to fail.',
              input_ids: [],
              replacement_mode: 'none',
            },
          ],
        },
        {
          ...toolContext(rootSession.id, sourceRun.runId, sourceTurnId, 'failure-work'),
          orchestrationMode: 'swarm',
        },
      )) as { schedule: { work: Array<{ workId: string }> } };
      await coordinator.waitForIdle(rootSession.id);
      const beforeRestart = await coordinator.getSnapshot(rootSession.id);
      assert.deepEqual(beforeRestart.reconciliationFailures, [
        {
          workId: committed.schedule.work[0]!.workId,
          phase: 'topology',
          reason: 'preset provider unavailable',
        },
      ]);
      assert.equal(beforeRestart.orchestrationMode, 'swarm');
      assert.equal(coordinator.readSessionActivity(rootSession.id), 'blocked');

      await coordinator.close();
      assert.equal(coordinator.readSessionActivity(rootSession.id), 'idle');
      coordinator = undefined;
      recovered = create();
      const afterRestart = await recovered.getSnapshot(rootSession.id);
      assert.deepEqual(afterRestart.reconciliationFailures, beforeRestart.reconciliationFailures);
      assert.equal(afterRestart.orchestrationMode, 'swarm');
      assert.deepEqual(await recovered.recover(), [rootSession.id]);
      assert.equal(recovered.readSessionActivity(rootSession.id), 'blocked');
      assert.deepEqual(
        (await recovered.getSnapshot(rootSession.id)).reconciliationFailures,
        beforeRestart.reconciliationFailures,
      );
    } finally {
      await coordinator?.close();
      await recovered?.close();
      controlStore.close();
      await sessionStore.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rebuilds an exact historical graph projection without falling through to current', async () => {
    const historicalGraphId = agentGraphIdForRootSession('root-session');
    const currentGraphId = agentGraphIdForRootSessionEpoch('root-session', 2);
    const projections = new Map<
      string,
      {
        schemaVersion: 1;
        graphId: string;
        rootSessionId: string;
        snapshotVersion: string;
        payload: unknown;
        materializedAt: number;
      }
    >();
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'active',
            isArchived: true,
          }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      epochStore: {
        resolveCurrentAgentGraphEpoch: async () => ({
          schemaVersion: 1,
          rootSessionId: 'root-session',
          epoch: 2,
          graphId: currentGraphId,
          createdAt: 2,
        }),
        listAgentGraphEpochs: async () => [
          {
            schemaVersion: 1 as const,
            rootSessionId: 'root-session',
            epoch: 1,
            graphId: historicalGraphId,
            createdAt: 1,
          },
          {
            schemaVersion: 1,
            rootSessionId: 'root-session',
            epoch: 2,
            graphId: currentGraphId,
            createdAt: 2,
          },
        ],
        readAgentGraphEpochByGraphId: async (graphId: string) =>
          graphId === historicalGraphId
            ? {
                schemaVersion: 1 as const,
                rootSessionId: 'root-session',
                epoch: 1,
                graphId: historicalGraphId,
                createdAt: 1,
              }
            : graphId === currentGraphId
              ? {
                  schemaVersion: 1 as const,
                  rootSessionId: 'root-session',
                  epoch: 2,
                  graphId: currentGraphId,
                  createdAt: 2,
                }
              : undefined,
        listAgentGraphEpochPage: async () => ({
          epochs: [],
          nextBeforeEpoch: null,
          currentEpoch: null,
        }),
      },
      controlStore: {
        listAgentGraphOperatorProvisions: async () => [],
        listAgentGraphScheduleUpdates: async () => [],
        listAgentGraphIntentClaims: async () => [],
        listAgentGraphClientClaimAdmissions: async () => [],
        readAgentGraphClientProjection: async (graphId: string) => projections.get(graphId),
        commitAgentGraphClientProjection: async (request: {
          graphId: string;
          rootSessionId: string;
          snapshotVersion: string;
          snapshot: unknown;
        }) => {
          const projection = {
            schemaVersion: 1 as const,
            graphId: request.graphId,
            rootSessionId: request.rootSessionId,
            snapshotVersion: request.snapshotVersion,
            payload: request.snapshot,
            materializedAt: 1,
          };
          projections.set(request.graphId, projection);
          return projection;
        },
        readAgentGraphClientOperatorProjection: async () => undefined,
        listAgentGraphClientTerminalActivities: async () => ({
          records: [],
          hasMore: false,
        }),
      },
      runtime: {},
      newId: randomUUID,
      rootSessionId: 'root-session',
    } as unknown as AgentGraphCoordinatorInput);
    const historical = await coordinator.getGraphSnapshot('root-session', historicalGraphId);
    assert.equal(historical.graphId, historicalGraphId);
    assert.equal(historical.status, 'empty');
    const current = await coordinator.getSnapshot('root-session');
    assert.equal(current.graphId, currentGraphId);
    await assert.rejects(
      coordinator.getGraphSnapshot('root-session', agentGraphIdForRootSession('another-root')),
      (error: unknown) =>
        error instanceof AgentGraphClientOperationError && error.code === 'not_found',
    );
    await assert.rejects(
      coordinator.toolsForSession('root-session'),
      /Archived Sessions cannot supervise/,
    );
    await coordinator.close();
  });

  test('classifies retirement and activity from authoritative graph and interaction state', async (t) => {
    const rootSessionId = 'root-session';
    const childSessionId = 'child-session';
    const graphId = agentGraphIdForRootSession(rootSessionId);
    const addRequest = compileAgentGraphScheduleUpdate({
      graphId,
      input: {
        operation: 'add_work',
        add_work: [
          {
            target_kind: 'new_agent',
            agent_id: 'local-read',
            instruction: 'Inspect the repository.',
            input_ids: [],
            replacement_mode: 'none',
          },
        ],
      },
      context: toolContext(rootSessionId, 'root-run', 'root-turn', 'add-work'),
    });
    const addUpdate: AgentGraphScheduleUpdate = {
      ...addRequest,
      revision: 1,
      committedAt: 10,
    };
    const workId = addUpdate.addWork[0]!.workId;
    const stopRequest = compileAgentGraphScheduleUpdate({
      graphId,
      input: {
        operation: 'stop',
        stop: [{ target_id: workId, reason: 'The work was stopped by the user.' }],
      },
      context: toolContext(rootSessionId, 'root-run', 'root-turn', 'stop-work'),
    });
    const stopUpdate: AgentGraphScheduleUpdate = {
      ...stopRequest,
      revision: 2,
      committedAt: 20,
    };
    const finishRequest = compileAgentGraphScheduleUpdate({
      graphId,
      input: {
        operation: 'finish',
        finish: { result_ids: ['result-1'], reason: 'The result is sufficient.' },
      },
      context: toolContext(rootSessionId, 'root-run', 'root-turn', 'finish-work'),
    });
    const finishUpdate: AgentGraphScheduleUpdate = {
      ...finishRequest,
      revision: 2,
      committedAt: 20,
    };
    const operatorId = `graph_operator_${'1'.repeat(32)}`;
    const intentId = scheduledWorkIntentId(graphId, workId);
    const runId = 'child-run';
    const turnId = 'child-turn';
    const provision: AgentGraphOperatorProvision = {
      schemaVersion: AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
      provisionId: `graph_provision_${'3'.repeat(32)}`,
      provisionFingerprint: `sha256:${'4'.repeat(64)}`,
      graphId,
      workId,
      agentId: 'local-read',
      operatorId,
      initialTurnId: turnId,
      initialRunId: runId,
      edges: [],
      targetSessionId: childSessionId,
      provisionedAt: 11,
    };
    const claim: AgentGraphIntentClaim = {
      schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
      claimId: `graph_claim_${'5'.repeat(32)}`,
      graphId,
      intentId,
      intentFingerprint: `sha256:${'6'.repeat(64)}`,
      readinessContextFingerprint: `sha256:${'7'.repeat(64)}`,
      targetOperatorId: operatorId,
      targetSessionId: childSessionId,
      targetTurnId: turnId,
      targetRunId: runId,
      claimedAt: 12,
    };
    const runningRun: RuntimeInvocationRecord = {
      sessionId: childSessionId,
      invocationId: 'child-invocation',
      runId,
      turnId,
      openedAt: 12,
      opening: testInvocationOpening({
        route: {
          provenance: 'runtime',
          backendKind: 'fake',
          llmConnectionId: 'fake-connection',
          llmConnectionSlug: 'fake',
          modelId: 'fake',
        },
        configuration: { cwd: '/workspace', permissionMode: 'explore' },
      }),
    };
    const runningEvent: RuntimeEvent = {
      id: 'child-started',
      invocationId: 'child-invocation',
      sessionId: childSessionId,
      runId,
      turnId,
      ts: 13,
      role: 'model',
      author: 'agent',
      partial: false,
      content: { kind: 'text', text: 'Working.' },
    };
    let scheduleUpdates: AgentGraphScheduleUpdate[] = [];
    let provisions: AgentGraphOperatorProvision[] = [];
    let claims: AgentGraphIntentClaim[] = [];
    let runs: RuntimeInvocationRecord[] = [runningRun];
    let runtimeEvents: RuntimeEvent[] = [runningEvent];
    const pendingByTurn = new Map<string, number>();
    const activityChanges: string[] = [];
    let interactionReads = 0;
    let projection:
      | {
          schemaVersion: 1;
          graphId: string;
          rootSessionId: string;
          snapshotVersion: string;
          payload: unknown;
          materializedAt: number;
        }
      | undefined;
    const createActivityCoordinator = () =>
      new AgentGraphCoordinator({
        sessionStore: {
          listForRecovery: async () => [],
          readHeader: async (sessionId: string) =>
            ({
              id: sessionId,
              status: 'active',
              isArchived: false,
            }) as never,
        },
        runtimeEventStore: {
          listSessionInvocations: async () => runs,
          readImmutableRuntimeEvents: async (_sessionId: string, requestedRunId: string) =>
            runtimeEvents.filter((event) => event.runId === requestedRunId),
        },
        controlStore: {
          listAgentGraphOperatorProvisions: async () => provisions,
          listAgentGraphScheduleUpdates: async () => scheduleUpdates,
          listAgentGraphIntentClaims: async () => claims,
          listAgentGraphClientClaimAdmissions: async () =>
            claims.map((entry) => ({
              graphId,
              intentId: entry.intentId,
              state: 'executing' as const,
              updatedAt: 12,
            })),
          readAgentGraphClientProjection: async () => projection,
          commitAgentGraphClientProjection: async (request: {
            graphId: string;
            rootSessionId: string;
            snapshotVersion: string;
            snapshot: unknown;
          }) => {
            projection = {
              schemaVersion: 1,
              graphId: request.graphId,
              rootSessionId: request.rootSessionId,
              snapshotVersion: request.snapshotVersion,
              payload: request.snapshot,
              materializedAt: 1,
            };
            return projection;
          },
          readAgentGraphClientOperatorProjection: async () => undefined,
          listAgentGraphClientTerminalActivities: async () => ({ records: [], hasMore: false }),
        },
        runtime: {
          provisionAgentGraphOperator: async () => {
            throw new Error('lifecycle reads cannot provision operators');
          },
          runClaimedAgentGraphIntent: async () => {
            throw new Error('lifecycle reads cannot dispatch operators');
          },
          stopSession: async () => {},
        },
        newId: randomUUID,
        rootSessionId,
        readTurnPendingInteractionCount: (sessionId: string, requestedTurnId: string) => {
          assert.equal(sessionId, childSessionId);
          interactionReads += 1;
          return pendingByTurn.get(requestedTurnId);
        },
        onSessionActivityChanged: (sessionId: string) => {
          assert.equal(sessionId, rootSessionId);
          activityChanges.push(coordinator.readSessionActivity(sessionId));
        },
      } as unknown as AgentGraphCoordinatorInput);
    let coordinator = createActivityCoordinator();
    const restartActivityProjection = async (): Promise<void> => {
      // The following matrix revisits independent durable histories. A live
      // coordinator must never accept their backwards schedule revisions.
      await coordinator.close();
      projection = undefined;
      coordinator = createActivityCoordinator();
      await coordinator.toolsForSession(rootSessionId);
    };
    const activity = async (): Promise<string> => {
      projection = undefined;
      await coordinator.getSnapshot(rootSessionId);
      return coordinator.readSessionActivity(rootSessionId);
    };
    try {
      await coordinator.toolsForSession(rootSessionId);
      assert.equal((await coordinator.getSnapshot(rootSessionId)).scheduleRevision, 0);
      assert.equal(await coordinator.readSessionState(rootSessionId), 'absent');
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'clear',
      });

      scheduleUpdates = [addUpdate];
      assert.equal(await coordinator.readSessionState(rootSessionId), 'live');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), true);
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'busy',
        status: 'waiting',
      });

      provisions = [provision];
      claims = [claim];
      assert.equal(await activity(), 'running');
      runtimeEvents = [
        runningEvent,
        {
          ...runningEvent,
          id: 'permission',
          ts: 14,
          role: 'system',
          author: 'system',
          content: undefined,
          actions: {
            permissionRequest: {
              kind: 'tool_permission',
              requestId: 'permission',
              toolUseId: 'tool',
              toolName: 'Read',
              category: 'read',
              reason: 'custom',
              args: {},
              rememberForTurnAllowed: true,
            },
          },
        },
      ];
      assert.equal(await activity(), 'waiting_for_user');
      await t.test('one remaining concurrent request keeps the parent waiting', async () => {
        pendingByTurn.set(turnId, 2);
        coordinator.refreshSessionInteractionActivity(childSessionId);
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'waiting_for_user');
        const published = activityChanges.length;
        pendingByTurn.set(turnId, 1);
        coordinator.refreshSessionInteractionActivity(childSessionId);
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'waiting_for_user');
        assert.equal(activityChanges.length, published, 'same activity does not notify twice');
        assert.equal(await activity(), 'waiting_for_user', 'projection rebuild retains pending B');
        pendingByTurn.set(turnId, 0);
        coordinator.refreshSessionInteractionActivity(childSessionId);
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
        assert.equal(activityChanges.at(-1), 'running');
        assert.equal(await activity(), 'running', 'a sticky graph prompt cannot restore waiting');
      });
      await t.test('producer withdrawal resumes an open run without an answer event', async () => {
        pendingByTurn.set(turnId, 1);
        coordinator.refreshSessionInteractionActivity(childSessionId);
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'waiting_for_user');
        // The authority commits producer_cancelled; the graph event log has no answer ACK.
        pendingByTurn.set(turnId, 0);
        coordinator.refreshSessionInteractionActivity(childSessionId);
        assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
        assert.equal(await activity(), 'running');
        const reads = interactionReads;
        for (let i = 0; i < 10; i += 1) {
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
        }
        assert.equal(interactionReads, reads, 'catalog reads do not reread interaction state');
      });
      await t.test(
        'old turn counts and unrelated child invalidations cannot block this turn',
        () => {
          pendingByTurn.set('old-turn', 1);
          coordinator.refreshSessionInteractionActivity(childSessionId);
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
          const reads = interactionReads;
          coordinator.refreshSessionInteractionActivity('another-child');
          assert.equal(interactionReads, reads);
          pendingByTurn.delete('old-turn');
        },
      );
      await t.test(
        'a successor physical run retains its logical turn interaction state',
        async () => {
          const originalEvents = runtimeEvents;
          const successorRun = {
            ...runningRun,
            runId: 'successor-run',
            invocationId: 'successor-invocation',
            openedAt: 15,
          };
          runs = [runningRun, successorRun];
          runtimeEvents = [
            ...runtimeEvents,
            {
              ...runningEvent,
              id: 'successor-started',
              runId: successorRun.runId,
              invocationId: successorRun.invocationId,
              ts: 16,
            },
          ];
          pendingByTurn.set(turnId, 1);
          assert.equal(await activity(), 'waiting_for_user');
          assert.equal(
            (await coordinator.getSnapshot(rootSessionId)).operators[0]?.currentActivation?.run
              .agentRunId,
            successorRun.runId,
          );
          pendingByTurn.set(turnId, 0);
          coordinator.refreshSessionInteractionActivity(childSessionId);
          assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
          const completed: RuntimeEvent = {
            id: 'successor-completed',
            sessionId: childSessionId,
            invocationId: successorRun.invocationId,
            runId: successorRun.runId,
            turnId,
            ts: 17,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'completed',
            actions: { endInvocation: true },
          };
          runs = [runningRun, { ...successorRun, terminalEvent: completed }];
          runtimeEvents.push(completed);
          assert.equal(
            await activity(),
            'idle',
            'the completed successor fulfills the work despite its initial physical Run lacking a terminal',
          );
          assert.equal(
            (await coordinator.getSnapshot(rootSessionId)).operators[0]?.status,
            'completed',
          );
          runs = [runningRun];
          runtimeEvents = originalEvents;
        },
      );
      pendingByTurn.delete(turnId);
      scheduleUpdates = [addUpdate, stopUpdate];
      assert.equal(
        await activity(),
        'idle',
        'stopped work cannot retain its obsolete permission state',
      );
      scheduleUpdates = [addUpdate];
      runtimeEvents = [runningEvent];
      await restartActivityProjection();
      assert.equal(await activity(), 'running');
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'busy',
        status: 'active',
      });

      scheduleUpdates = [addUpdate, stopUpdate];
      runs = [
        {
          ...runningRun,
          terminalEvent: {
            id: 'child-aborted-terminal',
            sessionId: childSessionId,
            invocationId: 'child-invocation',
            runId,
            turnId,
            ts: 14,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'aborted',
          },
        },
      ];
      runtimeEvents = [
        runningEvent,
        {
          id: 'child-aborted',
          invocationId: 'child-invocation',
          sessionId: childSessionId,
          runId,
          turnId,
          ts: 14,
          role: 'system',
          author: 'system',
          partial: false,
          status: 'aborted',
          actions: { endInvocation: true },
        },
      ];
      assert.equal(await coordinator.readSessionState(rootSessionId), 'live');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), true);
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'quiescent_open',
      });

      scheduleUpdates = [addUpdate, finishUpdate];
      runs = [runningRun];
      runtimeEvents = [runningEvent];
      assert.equal(await coordinator.readSessionState(rootSessionId), 'live');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), true);
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'busy',
        status: 'closing',
      });

      runs = [
        {
          ...runningRun,
          terminalEvent: {
            id: 'child-terminal',
            sessionId: childSessionId,
            invocationId: 'child-invocation',
            runId,
            turnId,
            ts: 14,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'completed',
          },
        },
      ];
      runtimeEvents = [
        runningEvent,
        {
          id: 'child-completed',
          invocationId: 'child-invocation',
          sessionId: childSessionId,
          runId,
          turnId,
          ts: 14,
          role: 'system',
          author: 'system',
          partial: false,
          status: 'completed',
          actions: { endInvocation: true },
        },
      ];
      pendingByTurn.set(turnId, 1);
      assert.equal(await activity(), 'idle', 'terminal run wins over a stale pending snapshot');
      coordinator.refreshSessionInteractionActivity(childSessionId);
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
      pendingByTurn.delete(turnId);
      scheduleUpdates = [addUpdate];
      await restartActivityProjection();
      assert.equal(await activity(), 'idle', 'completed work in an open graph is idle');
      scheduleUpdates = [addUpdate, finishUpdate];
      assert.equal(await coordinator.readSessionState(rootSessionId), 'terminal');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), false);
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'clear',
      });

      scheduleUpdates = [addUpdate];
      runs = [
        {
          ...runningRun,
          terminalEvent: {
            id: 'child-failed-terminal',
            sessionId: childSessionId,
            invocationId: 'child-invocation',
            runId,
            turnId,
            ts: 15,
            partial: false,
            role: 'system',
            author: 'system',
            status: 'failed',
          },
        },
      ];
      runtimeEvents = [
        runningEvent,
        {
          id: 'child-failed',
          invocationId: 'child-invocation',
          sessionId: childSessionId,
          runId,
          turnId,
          ts: 15,
          role: 'system',
          author: 'system',
          partial: false,
          status: 'failed',
          actions: { endInvocation: true },
        },
      ];
      await restartActivityProjection();
      assert.deepEqual(await coordinator.readRetirementDisposition(rootSessionId), {
        kind: 'quiescent_open',
      });
      assert.equal(await activity(), 'blocked');
    } finally {
      await coordinator.close();
      const reads = interactionReads;
      pendingByTurn.set(turnId, 1);
      coordinator.refreshSessionInteractionActivity(childSessionId);
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
      assert.equal(interactionReads, reads, 'closed drivers discard interaction invalidations');
    }
  });

  test('a failed client stop remains blocked until a successful stop retry', async () => {
    const rootSessionId = 'root-session';
    const graphId = agentGraphIdForRootSession(rootSessionId);
    const started = deferred();
    const release = deferred();
    let fail = true;
    const observed: string[] = [];
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (id: string) => ({ id, status: 'active', isArchived: false }),
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore: {
        listAgentGraphOperatorProvisions: async () => [
          {
            graphId,
            provisionId: 'provision',
            operatorId: 'operator',
            targetSessionId: 'child',
            provisionedAt: 1,
            edges: [],
          },
        ],
      },
      runtime: {
        stopSession: async () => {
          started.resolve();
          await release.promise;
          if (fail) throw new Error('child could not stop');
        },
      },
      newId: randomUUID,
      onSessionActivityChanged: (id: string) => observed.push(coordinator.readSessionActivity(id)),
    } as unknown as AgentGraphCoordinatorInput);
    try {
      const stopping = coordinator.stop(rootSessionId);
      const rejected = assert.rejects(stopping, /child could not stop/);
      await started.promise;
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
      release.resolve();
      await rejected;
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'blocked');
      fail = false;
      await coordinator.stop(rootSessionId);
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'idle');
      assert.deepEqual(observed, ['running', 'blocked', 'running', 'idle']);
    } finally {
      fail = false;
      release.resolve();
      await coordinator.close();
    }
  });

  test('surfaces topology cleanup failures from close', async () => {
    const topologyFailure = new Error('graph topology unavailable');
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'active',
            isArchived: false,
          }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore: {
        listAgentGraphOperatorProvisions: async () => {
          throw topologyFailure;
        },
      },
      runtime: {},
      newId: randomUUID,
      rootSessionId: 'root-session',
    } as unknown as AgentGraphCoordinatorInput);
    await assert.rejects(
      coordinator.toolsForSession('another-root'),
      /scoped to root Session root-session/,
    );
    await coordinator.toolsForSession('root-session');
    await assert.rejects(
      coordinator.close(),
      (error: unknown) =>
        error === topologyFailure ||
        (error instanceof AggregateError &&
          error.errors.some(
            (failure) =>
              failure === topologyFailure ||
              (failure instanceof AggregateError && failure.errors.includes(topologyFailure)),
          )),
    );
  });

  test('attempts every operator stop and surfaces all close failures', async () => {
    const graphId = agentGraphIdForRootSession('root-session');
    const stopped: string[] = [];
    let releaseStops!: () => void;
    const stopsReleased = new Promise<void>((resolve) => {
      releaseStops = resolve;
    });
    let markStopsStarted!: () => void;
    const stopsStarted = new Promise<void>((resolve) => {
      markStopsStarted = resolve;
    });
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'active',
            isArchived: false,
          }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore: {
        listAgentGraphOperatorProvisions: async () =>
          ['a', 'b'].map((suffix, index) => ({
            graphId,
            provisionId: `provision-${suffix}`,
            operatorId: `operator-${suffix}`,
            targetSessionId: `child-${suffix}`,
            provisionedAt: index,
            edges: [],
          })),
      },
      runtime: {
        stopSession: async (sessionId: string) => {
          stopped.push(sessionId);
          if (stopped.length === 2) markStopsStarted();
          await stopsReleased;
          throw new Error(`cannot stop ${sessionId}`);
        },
      },
      newId: randomUUID,
      rootSessionId: 'root-session',
    } as unknown as AgentGraphCoordinatorInput);
    await coordinator.toolsForSession('root-session');
    coordinator.beginDrain();
    await stopsStarted;
    assert.deepEqual(stopped.sort(), ['child-a', 'child-b']);
    releaseStops();
    await assert.rejects(
      coordinator.close(),
      (error: unknown) =>
        error instanceof AggregateError &&
        (error.errors.length === 2 ||
          error.errors.some(
            (failure) => failure instanceof AggregateError && failure.errors.length === 2,
          )),
    );
  });

  test('rejects concurrent yield when reconciliation only waits for uncommitted input', async () => {
    const rootSessionId = 'root-session';
    const graphId = agentGraphIdForRootSession(rootSessionId);
    const controlStore = createSqliteSessionMetadataStore(':memory:');
    let releaseProvisionRead!: () => void;
    let markProvisionReadStarted!: () => void;
    const provisionReadStarted = new Promise<void>((resolve) => {
      markProvisionReadStarted = resolve;
    });
    const provisionReadReleased = new Promise<void>((resolve) => {
      releaseProvisionRead = resolve;
    });
    let holdProvisionRead = true;
    let residencies = 0;
    const gatedStore = new Proxy(controlStore, {
      get(target, property) {
        if (property === 'listAgentGraphOperatorProvisions') {
          return async (...args: Parameters<typeof target.listAgentGraphOperatorProvisions>) => {
            if (holdProvisionRead) {
              holdProvisionRead = false;
              markProvisionReadStarted();
              await provisionReadReleased;
            }
            return target.listAgentGraphOperatorProvisions(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'active',
            isArchived: false,
          }) as never,
      },
      runtimeEventStore: {
        listSessionInvocations: async () => [],
        readImmutableRuntimeEvents: async () => [],
      },
      controlStore: gatedStore,
      runtime: {
        provisionAgentGraphOperator: async () => {
          throw new Error('missing input must prevent operator provisioning');
        },
        runClaimedAgentGraphIntent: async () => {
          throw new Error('missing input must prevent runtime dispatch');
        },
        stopSession: async () => {},
      },
      newId: randomUUID,
      rootSessionId,
      acquireResidency: () => {
        residencies += 1;
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            residencies -= 1;
          },
        };
      },
    } as unknown as AgentGraphCoordinatorInput);
    try {
      const tools = await coordinator.toolsForSession(rootSessionId);
      const yieldTool = tools.find((tool) => tool.name === YIELD_AGENT_GRAPH_TOOL_NAME);
      assert.ok(yieldTool);
      await controlStore.commitAgentGraphScheduleUpdate(
        compileAgentGraphScheduleUpdate({
          graphId,
          input: {
            operation: 'add_work',
            add_work: [
              {
                target_kind: 'new_agent',
                agent_id: 'implementation',
                instruction: 'Use an upstream result that is not committed yet.',
                input_ids: ['missing-record'],
                replacement_mode: 'none',
              },
            ],
          },
          context: toolContext(rootSessionId, 'run-root', 'turn-root', 'tool-schedule'),
        }),
      );

      coordinator.wake(rootSessionId);
      await provisionReadStarted;
      assert.equal(residencies, 1);
      assert.equal(coordinator.readSessionActivity(rootSessionId), 'running');
      let settled = false;
      const yielding = Promise.resolve(
        yieldTool.impl(
          { reason: 'Wait for the missing upstream result.' },
          toolContext(rootSessionId, 'run-root', 'turn-root', 'tool-yield'),
        ),
      ).finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'yield admission must await the in-flight reconciliation');
      releaseProvisionRead();
      await assert.rejects(
        yielding,
        /no in-flight work or pending reconciliation.*future supervisor checkpoint/,
      );
      await coordinator.waitForIdle(rootSessionId);
      assert.equal(residencies, 0);
      assert.equal((await coordinator.reconcile(rootSessionId)).status, 'waiting');
      assert.equal(
        coordinator.readSessionActivity(rootSessionId),
        'blocked',
        'missing upstream input without a producer must not spin forever',
      );
      assert.equal(residencies, 0);
    } finally {
      releaseProvisionRead();
      await coordinator.close();
      controlStore.close();
    }
  });
});

async function withActivityGraph(
  run: (fixture: {
    coordinator: AgentGraphCoordinator;
    rootSessionId: string;
    runtimeEventStore: ReturnType<typeof createWorkspaceRuntimeStore>;
    delayedStore: ReturnType<typeof createDelayableControlStore>;
    activityChanges: string[];
    errors: unknown[];
    update(input: UpdateAgentGraphToolInput): Promise<unknown>;
  }) => Promise<void>,
  beforeReply?: (input: BackendSendInput, sessionId: string) => Promise<void>,
  readTurnPendingInteractionCount?: AgentGraphCoordinatorInput['readTurnPendingInteractionCount'],
  beforeComplete?: (input: BackendSendInput) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-graph-activity-'));
  const sessionStore = createSessionStore(root);
  const runStore = createSqliteAgentRunStore(root);
  const runtimeEventStore = createWorkspaceRuntimeStore(root);
  const controlStore = createSqliteSessionMetadataStore(
    join(root, OPERATIONAL_STATE_DATABASE_NAME),
  );
  const delayedStore = createDelayableControlStore(controlStore);
  const backends = new BackendRegistry();
  backends.register(
    'ai-sdk',
    (context) =>
      new (class extends FakeBackend {
        override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          await beforeReply?.(input, this.sessionId);
          yield {
            type: 'text_complete',
            id: randomUUID(),
            turnId: input.turnId,
            ts: Date.now(),
            messageId: randomUUID(),
            text: 'A completed graph result.',
          };
          await beforeComplete?.(input);
          yield {
            type: 'complete',
            id: randomUUID(),
            turnId: input.turnId,
            ts: Date.now(),
            stopReason: 'end_turn',
          };
        }
      })(context),
  );
  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    backends,
    childTools: localReadTools(),
    newId: randomUUID,
    now: Date.now,
  });
  const activityChanges: string[] = [];
  const errors: unknown[] = [];
  const coordinator = createCoordinator({
    sessionStore,
    runStore,
    runtimeEventStore,
    controlStore: delayedStore.store,
    manager,
    readTurnPendingInteractionCount,
    // These are the global catalog invalidations. No graph subscription is installed.
    onSessionActivityChanged: (id) => activityChanges.push(coordinator.readSessionActivity(id)),
    onError: (_id, error) => {
      errors.push(error);
    },
  });
  try {
    const session = await manager.createSession({
      cwd: root,
      llmConnectionSlug: 'fake',
      permissionMode: 'ask',
    });
    const turnId = randomUUID();
    for await (const _event of manager.sendMessage(session.id, {
      turnId,
      text: 'Prepare graph work.',
    })) {
    }
    const sourceRun = (await runtimeEventStore.listSessionInvocations(session.id)).find(
      (candidate) => candidate.turnId === turnId,
    )!;
    const tool = (await coordinator.toolsForSession(session.id)).find(
      (candidate) => candidate.name === UPDATE_AGENT_GRAPH_TOOL_NAME,
    )!;
    const update = async (input: UpdateAgentGraphToolInput) =>
      await tool.impl(input, toolContext(session.id, sourceRun.runId, turnId, randomUUID()));
    await update({
      add_work: [
        { agent_id: 'local-read', instruction: 'Complete the initial graph work.', input_ids: [] },
      ],
    });
    await coordinator.waitForIdle(session.id);
    assert.equal((await coordinator.getSnapshot(session.id)).operators[0]?.status, 'completed');
    assert.equal(
      coordinator.readSessionActivity(session.id),
      'idle',
      'completed work in an open graph is idle',
    );
    await run({
      coordinator,
      rootSessionId: session.id,
      runtimeEventStore,
      delayedStore,
      activityChanges,
      errors,
      update,
    });
  } finally {
    await coordinator.close();
    controlStore.close();
    await sessionStore.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

function createCoordinator(input: {
  sessionStore: ReturnType<typeof createSessionStore>;
  runStore: ReturnType<typeof createSqliteAgentRunStore>;
  runtimeEventStore: ReturnType<typeof createWorkspaceRuntimeStore>;
  controlStore: ReturnType<typeof createSqliteSessionMetadataStore>;
  manager: SessionManager;
  onReconciliation?: AgentGraphCoordinatorInput['onReconciliation'];
  onError?: AgentGraphCoordinatorInput['onError'];
  onSessionActivityChanged?: AgentGraphCoordinatorInput['onSessionActivityChanged'];
  readTurnPendingInteractionCount?: AgentGraphCoordinatorInput['readTurnPendingInteractionCount'];
}): AgentGraphCoordinator {
  return new AgentGraphCoordinator({
    ...input,
    runtime: input.manager,
    newId: randomUUID,
    maxNewActivations: 4,
  });
}

function createDelayableControlStore(store: ReturnType<typeof createSqliteSessionMetadataStore>): {
  store: ReturnType<typeof createSqliteSessionMetadataStore>;
  projectionCommits: Array<Parameters<typeof store.commitAgentGraphClientProjection>[0]>;
  projectionReadCounts(): {
    snapshot: number;
    composite: number;
    operator: number;
    terminal: number;
  };
  failProjectionCommits(error: unknown): void;
  clearProjectionFailure(): void;
  holdProjectionCommits(): { release(): void };
  failNextProjectionCommits(count: number, error: unknown): void;
  holdNextCommit(): { started: Promise<void>; release(): void };
} {
  let gate:
    | {
        started(): void;
        release: Promise<void>;
      }
    | undefined;
  const projectionCommits: Array<Parameters<typeof store.commitAgentGraphClientProjection>[0]> = [];
  let projectionFailure: unknown;
  let remainingProjectionFailures: number | 'always' = 0;
  let projectionGate: Promise<void> | undefined;
  let snapshotProjectionReads = 0;
  let compositeProjectionReads = 0;
  let operatorProjectionReads = 0;
  let terminalActivityReads = 0;
  const proxy = new Proxy(store, {
    get(target, property) {
      if (property === 'commitAgentGraphScheduleUpdate') {
        return async (...args: Parameters<typeof target.commitAgentGraphScheduleUpdate>) => {
          const activeGate = gate;
          gate = undefined;
          if (activeGate) {
            activeGate.started();
            await activeGate.release;
          }
          return target.commitAgentGraphScheduleUpdate(...args);
        };
      }
      if (property === 'commitAgentGraphClientProjection') {
        return async (...args: Parameters<typeof target.commitAgentGraphClientProjection>) => {
          projectionCommits.push(structuredClone(args[0]));
          await projectionGate;
          if (remainingProjectionFailures === 'always') {
            throw projectionFailure;
          }
          if (remainingProjectionFailures > 0) {
            remainingProjectionFailures -= 1;
            throw projectionFailure;
          }
          return target.commitAgentGraphClientProjection(...args);
        };
      }
      if (property === 'readAgentGraphClientProjectionWithOperator') {
        return async (
          ...args: Parameters<typeof target.readAgentGraphClientProjectionWithOperator>
        ) => {
          compositeProjectionReads += 1;
          return target.readAgentGraphClientProjectionWithOperator(...args);
        };
      }
      if (property === 'readAgentGraphClientOperatorProjection') {
        return async (
          ...args: Parameters<typeof target.readAgentGraphClientOperatorProjection>
        ) => {
          operatorProjectionReads += 1;
          return target.readAgentGraphClientOperatorProjection(...args);
        };
      }
      if (property === 'readAgentGraphClientProjection') {
        return async (...args: Parameters<typeof target.readAgentGraphClientProjection>) => {
          snapshotProjectionReads += 1;
          return target.readAgentGraphClientProjection(...args);
        };
      }
      if (property === 'listAgentGraphClientTerminalActivities') {
        return async (
          ...args: Parameters<typeof target.listAgentGraphClientTerminalActivities>
        ) => {
          terminalActivityReads += 1;
          return target.listAgentGraphClientTerminalActivities(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    store: proxy,
    projectionCommits,
    projectionReadCounts: () => ({
      snapshot: snapshotProjectionReads,
      composite: compositeProjectionReads,
      operator: operatorProjectionReads,
      terminal: terminalActivityReads,
    }),
    failProjectionCommits(error) {
      projectionFailure = error;
      remainingProjectionFailures = 'always';
    },
    clearProjectionFailure() {
      remainingProjectionFailures = 0;
      projectionFailure = undefined;
    },
    holdProjectionCommits() {
      const gate = deferred();
      projectionGate = gate.promise;
      return {
        release() {
          projectionGate = undefined;
          gate.resolve();
        },
      };
    },
    failNextProjectionCommits(count, error) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Projection failure count must be a positive integer');
      }
      projectionFailure = error;
      remainingProjectionFailures = count;
    },
    holdNextCommit() {
      if (gate) throw new Error('A delayed graph schedule commit is already pending');
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { started: markStarted, release: released };
      return { started, release };
    },
  };
}

function localReadTools(): MakaTool[] {
  return ['Read', 'Glob', 'Grep'].map((name) => ({
    name,
    displayName: name,
    description: `${name} fixture`,
    parameters: z.object({}).passthrough(),
    categoryHint: 'read',
    impl: async () => ({ ok: true }),
  }));
}

function deferredGate(): { readonly ready: Promise<void>; release(): void } {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

function toolContext(
  sessionId: string,
  runId: string,
  turnId: string,
  toolCallId = 'tool-call-graph-start',
): MakaToolContext {
  return {
    sessionId,
    runId,
    turnId,
    toolCallId,
    cwd: '/workspace',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
}
