import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
  type AgentGraphIntentClaim,
} from '@maka/core/agent-graph-control';
import {
  AGENT_GRAPH_OPERATOR_PROVISION_SCHEMA_VERSION,
  type AgentGraphOperatorProvision,
} from '@maka/core/agent-graph-topology';
import { type AgentGraphScheduleUpdate } from '@maka/core/agent-graph-schedule';
import { type AgentRunHeader } from '@maka/core/agent-run';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import {
  createSessionStore,
  createSqliteSessionMetadataStore,
  OPERATIONAL_STATE_DATABASE_NAME,
} from '@maka/storage';
import { createSqliteAgentRunStore, createWorkspaceRuntimeStore } from '@maka/storage';
import { FakeBackend } from '../fake-backend.js';
import { BackendRegistry, SessionManager } from '../session-manager.js';
import { SessionActivityRegistry } from '../goal-turn-lifecycle.js';
import { AgentGraphSupervisorWakeCoordinator } from '../agent-graph-supervisor-wake.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';
import {
  AgentGraphClientOperationError,
  AgentGraphCoordinator,
  agentGraphIdForRootSession,
  type AgentGraphCoordinatorInput,
} from '../stream-graph-coordinator.js';
import { encodeAgentGraphTerminalCursor } from '../stream-graph-read-model.js';
import {
  UPDATE_AGENT_GRAPH_TOOL_NAME,
  YIELD_AGENT_GRAPH_TOOL_NAME,
  compileAgentGraphScheduleUpdate,
} from '../stream-graph-supervisor-tools.js';

describe('host-managed agent graph coordinator', () => {
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
    backends.register('fake', (context) => new FakeBackend(context));
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
    const transientProjectionErrors: unknown[] = [];
    let unsubscribe: (() => void) | undefined;
    try {
      const rootSession = await manager.createSession({
        cwd: root,
        backend: 'fake',
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
      const sourceRun = (await runStore.listSessionRuns(rootSession.id)).find(
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
          const run = (await runStore.listSessionRuns(sessionId)).find(
            (candidate) =>
              candidate.agentGraphWakeAttemptId === attemptId && candidate.turnId === turnId,
          );
          return run?.status ?? 'missing';
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
      await supervisorWake.waitForIdle();
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
      const wakeRun = (await runStore.listSessionRuns(rootSession.id)).find(
        (run) => run.turnId === graphWake.turnId,
      );
      assert.ok(wakeRun);
      assert.equal(wakeRun.agentGraphWakeId, graphWake.origin.wakeId);
      assert.equal(wakeRun.agentGraphWakeAttemptId, graphWake.origin.attemptId);
      assert.equal(
        (await runtimeEventStore.readImmutableRuntimeEvents(rootSession.id, wakeRun.runId))[0]
          ?.author,
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
      let childStopEntered = false;
      await assert.rejects(
        coordinator.stopExecution(childSessions[0]!.id, {
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
        const supervisorStopFailure = new Error('supervisor stop failed');
        await assert.rejects(
          recovered.stopExecution(rootSession.id, {
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

  test('derives stable graph identity from the root Session', async () => {
    const graphId = agentGraphIdForRootSession('root-session');
    assert.match(graphId, /^agent_graph_[a-f0-9]{32}$/);
    assert.equal(graphId, agentGraphIdForRootSession('root-session'));
    assert.notEqual(graphId, agentGraphIdForRootSession('other-root'));
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
    backends.register('fake', (context) => new FakeBackend(context));
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
        backend: 'fake',
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
      const sourceRun = (await runStore.listSessionRuns(rootSession.id)).find(
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
          runStore,
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

      await coordinator.close();
      coordinator = undefined;
      recovered = create();
      const afterRestart = await recovered.getSnapshot(rootSession.id);
      assert.deepEqual(afterRestart.reconciliationFailures, beforeRestart.reconciliationFailures);
      assert.equal(afterRestart.orchestrationMode, 'swarm');
      assert.deepEqual(await recovered.recover(), [rootSession.id]);
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

  test('keeps completed graph snapshots readable after the root Session is archived', async () => {
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
    const coordinator = new AgentGraphCoordinator({
      sessionStore: {
        listForRecovery: async () => [],
        readHeader: async (sessionId: string) =>
          ({
            id: sessionId,
            status: 'archived',
            isArchived: true,
          }) as never,
      },
      runStore: { listSessionRuns: async () => [] },
      runtimeEventStore: { readImmutableRuntimeEvents: async () => [] },
      controlStore: {
        listAgentGraphOperatorProvisions: async () => [],
        listAgentGraphScheduleUpdates: async () => [],
        listAgentGraphIntentClaims: async () => [],
        listAgentGraphClientClaimAdmissions: async () => [],
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
        listAgentGraphClientTerminalActivities: async () => ({
          records: [],
          hasMore: false,
        }),
      },
      runtime: {},
      newId: randomUUID,
      rootSessionId: 'root-session',
    } as unknown as AgentGraphCoordinatorInput);
    const snapshot = await coordinator.getSnapshot('root-session');
    assert.equal(snapshot.status, 'empty');
    await assert.rejects(
      coordinator.toolsForSession('root-session'),
      /Archived Sessions cannot supervise/,
    );
    await coordinator.close();
  });

  test('fences retirement from durable open and closing graph state, not a stale client projection', async () => {
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
    const intentId = `graph_intent_${'2'.repeat(32)}`;
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
    const runningRun: AgentRunHeader = {
      sessionId: childSessionId,
      runId,
      turnId,
      invocationId: 'child-invocation',
      backendKind: 'fake',
      llmConnectionSlug: 'fake',
      modelId: 'fake',
      cwd: '/workspace',
      permissionMode: 'explore',
      status: 'running',
      createdAt: 12,
      updatedAt: 12,
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
    let runs: AgentRunHeader[] = [runningRun];
    let runtimeEvents: RuntimeEvent[] = [runningEvent];
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
      runStore: { listSessionRuns: async () => runs },
      runtimeEventStore: { readImmutableRuntimeEvents: async () => runtimeEvents },
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
    } as unknown as AgentGraphCoordinatorInput);
    try {
      assert.equal((await coordinator.getSnapshot(rootSessionId)).scheduleRevision, 0);
      assert.equal(await coordinator.readSessionState(rootSessionId), 'absent');

      scheduleUpdates = [addUpdate];
      assert.equal(await coordinator.readSessionState(rootSessionId), 'live');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), true);

      scheduleUpdates = [addUpdate, finishUpdate];
      provisions = [provision];
      claims = [claim];
      assert.equal(await coordinator.readSessionState(rootSessionId), 'live');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), true);

      runs = [{ ...runningRun, status: 'completed', completedAt: 14, updatedAt: 14 }];
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
      assert.equal(await coordinator.readSessionState(rootSessionId), 'terminal');
      assert.equal(await coordinator.hasLiveSessionState(rootSessionId), false);
    } finally {
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
      runStore: { listSessionRuns: async () => [] },
      runtimeEventStore: { readImmutableRuntimeEvents: async () => [] },
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
      runStore: { listSessionRuns: async () => [] },
      runtimeEventStore: { readImmutableRuntimeEvents: async () => [] },
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
      runStore: { listSessionRuns: async () => [] },
      runtimeEventStore: { readImmutableRuntimeEvents: async () => [] },
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
      assert.equal(residencies, 0);
    } finally {
      releaseProvisionRead();
      await coordinator.close();
      controlStore.close();
    }
  });
});

function createCoordinator(input: {
  sessionStore: ReturnType<typeof createSessionStore>;
  runStore: ReturnType<typeof createSqliteAgentRunStore>;
  runtimeEventStore: ReturnType<typeof createWorkspaceRuntimeStore>;
  controlStore: ReturnType<typeof createSqliteSessionMetadataStore>;
  manager: SessionManager;
  onReconciliation?: AgentGraphCoordinatorInput['onReconciliation'];
  onError?: AgentGraphCoordinatorInput['onError'];
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
