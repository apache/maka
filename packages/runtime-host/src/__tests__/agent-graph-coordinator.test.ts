import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionHeader } from '@maka/core';
import {
  AgentGraphOperatorNotFoundError,
  agentGraphIdForRootSession,
  decodeAgentGraphTerminalCursor,
  type AgentGraphClientActivity,
  type AgentGraphClientChangedListener,
  type AgentGraphClientSnapshot as RuntimeAgentGraphClientSnapshot,
  type AgentGraphCoordinator,
  type AgentGraphOperatorInspection as RuntimeAgentGraphOperatorInspection,
} from '@maka/runtime';
import {
  AGENT_GRAPH_RESULT_MAX_BYTES,
  decodeAgentGraphClientSnapshot,
  decodeAgentGraphOperatorInspection,
} from '../protocol/index.js';
import {
  HostAgentGraphCoordinator,
  projectAgentGraphClientSnapshot,
  projectAgentGraphOperatorInspection,
} from '../server/agent-graph-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const fingerprint = `sha256:${'a'.repeat(64)}`;

describe('Host Agent Graph coordinator', () => {
  test('serves query, inspection, stop, and forwards invalidation without owning graph lifetime', async () => {
    const snapshot = graphSnapshot();
    const inspection = operatorInspection(snapshot);
    let stoppedRoot: string | undefined;
    let listener: AgentGraphClientChangedListener | undefined;
    let unsubscribed = false;
    const invalidations: unknown[] = [];
    const coordinator = new HostAgentGraphCoordinator({
      authority: {
        getSnapshot: async () => snapshot,
        inspectOperator: async () => inspection,
        stop: async (rootSessionId) => {
          stoppedRoot = rootSessionId;
        },
        subscribeAll: (candidate) => {
          listener = candidate;
          return () => {
            unsubscribed = true;
          };
        },
      } satisfies GraphAuthority,
      sessions: { readHeaderSnapshot: async () => rootHeader() },
      continuity: { enqueueAgentGraphChanged: (event) => invalidations.push(event) },
    });

    const queried = await coordinator.handlers['agent.graph.query'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    assert.equal(queried.result.rootSessionId, 'root-1');

    const inspected = await coordinator.handlers['agent.graph.operator.query'](
      { rootSessionId: 'root-1', operatorId: 'operator-1' },
      context(),
    );
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    assert.equal(inspected.result.operator.operatorId, 'operator-1');

    const stopped = await coordinator.handlers['agent.graph.stop'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.deepEqual(stopped, {
      ok: true,
      result: { rootSessionId: 'root-1', graphId: snapshot.graphId },
    });
    assert.equal(stoppedRoot, 'root-1');

    await listener?.({
      schemaVersion: 1,
      rootSessionId: 'root-1',
      graphId: snapshot.graphId,
      reason: 'runtime_activity',
    });
    assert.deepEqual(invalidations, [
      {
        rootSessionId: 'root-1',
        graphId: snapshot.graphId,
        reason: 'runtime_activity',
      },
    ]);

    coordinator.close();
    assert.equal(unsubscribed, true);
  });

  test('returns stable root, archive, operator, and cursor failures', async () => {
    const snapshot = graphSnapshot();
    const authority = {
      getSnapshot: async () => snapshot,
      inspectOperator: async () => {
        throw new AgentGraphOperatorNotFoundError(snapshot.graphId, 'missing-operator');
      },
      stop: async () => undefined,
      subscribeAll: () => () => undefined,
    } satisfies GraphAuthority;

    const child = new HostAgentGraphCoordinator({
      authority,
      sessions: {
        readHeaderSnapshot: async () =>
          rootHeader({
            subagentParent: {
              kind: 'subagent',
              parentSessionId: 'parent-1',
              spawnedBy: {
                parentRunId: 'parent-run',
                parentTurnId: 'parent-turn',
                toolCallId: 'tool-call',
              },
              lifecycle: 'foreground',
            },
          }),
      },
      continuity: { enqueueAgentGraphChanged: () => undefined },
    });
    const childQuery = await child.handlers['agent.graph.query'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.equal(childQuery.ok, false);
    if (!childQuery.ok) assert.equal(childQuery.error.code, 'operation_conflict');
    child.close();

    const archived = new HostAgentGraphCoordinator({
      authority,
      sessions: {
        readHeaderSnapshot: async () =>
          rootHeader({ isArchived: true, status: 'archived', archivedAt: 2 }),
      },
      continuity: { enqueueAgentGraphChanged: () => undefined },
    });
    const archivedStop = await archived.handlers['agent.graph.stop'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.equal(archivedStop.ok, false);
    if (!archivedStop.ok) assert.equal(archivedStop.error.code, 'session_archived');

    const missingOperator = await archived.handlers['agent.graph.operator.query'](
      { rootSessionId: 'root-1', operatorId: 'missing-operator' },
      context(),
    );
    assert.equal(missingOperator.ok, false);
    if (!missingOperator.ok) assert.equal(missingOperator.error.code, 'not_found');

    const invalidCursor = await archived.handlers['agent.graph.query'](
      { rootSessionId: 'root-1', terminalCursor: 'Y3Vyc29y' },
      context(),
    );
    assert.equal(invalidCursor.ok, false);
    if (!invalidCursor.ok) assert.equal(invalidCursor.error.code, 'invalid_request');
    archived.close();
  });

  test('bounds large snapshots while preserving omission and terminal continuation', () => {
    const source = graphSnapshot();
    source.operators = Array.from({ length: 40 }, (_, index) =>
      graphOperator(`operator-${index}`, index),
    );
    source.edges = Array.from({ length: 200 }, (_, index) => ({
      edgeId: `edge-${index}`,
      fromOperatorId: `operator-${index % 40}`,
      toOperatorId: `operator-${(index + 1) % 40}`,
    }));
    source.recentActivity = Array.from({ length: 64 }, (_, index) => activity(index));
    source.terminalHistory = {
      records: Array.from({ length: 64 }, (_, index) => terminalActivity(index)),
    };

    const projected = projectAgentGraphClientSnapshot(source);
    assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= AGENT_GRAPH_RESULT_MAX_BYTES);
    assert.doesNotThrow(() => decodeAgentGraphClientSnapshot(projected));
    assert.ok(projected.omitted.operators >= 8);
    assert.ok(projected.omitted.edges > 0);
    assert.ok(projected.omitted.recentActivity > 0);
    assert.ok(projected.terminalHistory.records.length > 0);
    assert.ok(projected.terminalHistory.nextCursor);
    const cursor = decodeAgentGraphTerminalCursor(projected.terminalHistory.nextCursor!);
    assert.equal(cursor.recordId, projected.terminalHistory.records.at(-1)?.recordId);
  });

  test('bounds a large operator inspection without changing its identity', () => {
    const snapshot = graphSnapshot();
    const source = operatorInspection(snapshot);
    source.inboundEdges = Array.from({ length: 100 }, (_, index) => ({
      edgeId: `edge-in-${index}`,
      fromOperatorId: `upstream-${index}`,
      toOperatorId: 'operator-1',
    }));
    source.outboundEdges = Array.from({ length: 100 }, (_, index) => ({
      edgeId: `edge-out-${index}`,
      fromOperatorId: 'operator-1',
      toOperatorId: `downstream-${index}`,
    }));
    source.recentRecords = Array.from({ length: 128 }, (_, index) => activity(index));

    const projected = projectAgentGraphOperatorInspection(source);
    assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= AGENT_GRAPH_RESULT_MAX_BYTES);
    assert.equal(projected.operator.operatorId, 'operator-1');
    assert.ok(projected.omitted.inboundEdges >= 36);
    assert.ok(projected.omitted.outboundEdges >= 36);
    assert.ok(projected.omitted.records >= 96);
    assert.doesNotThrow(() => decodeAgentGraphOperatorInspection(projected));
  });
});

type GraphAuthority = Pick<
  AgentGraphCoordinator,
  'getSnapshot' | 'inspectOperator' | 'stop' | 'subscribeAll'
>;

function graphSnapshot(): RuntimeAgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root-1',
    graphId: agentGraphIdForRootSession('root-1'),
    snapshotVersion: fingerprint,
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: fingerprint,
    closed: false,
    latestEventTime: 10,
    operators: [graphOperator('operator-1', 1)],
    edges: [],
    work: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [activity(1)],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
  };
}

function graphOperator(operatorId: string, index: number) {
  return {
    operatorId,
    childSessionId: `child-${index}`,
    provisionId: `provision-${index}`,
    agentId: `agent-${index}`,
    provisionedAt: index,
    status: 'running' as const,
    inboundEdgeIds: Array.from({ length: 64 }, (_, item) => `edge-in-${index}-${item}`),
    outboundEdgeIds: Array.from({ length: 64 }, (_, item) => `edge-out-${index}-${item}`),
    scheduledWorkIds: Array.from({ length: 64 }, (_, item) => `work-${index}-${item}`),
    readiness: [
      {
        readinessId: `readiness-${index}`,
        policyKind: 'all_settled' as const,
        status: 'waiting' as const,
        waitingFor: [
          {
            kind: 'input_route' as const,
            upstreamOperatorIds: Array.from(
              { length: 16 },
              (_, item) => `upstream-${index}-${item}`,
            ),
          },
        ],
        omittedWaitingFor: 0,
      },
    ],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
    currentActivation: {
      activationId: `activation-${index}`,
      status: 'running' as const,
      recordCount: 1,
      firstEventTime: index,
      lastEventTime: index,
      run: {
        sessionId: `child-${index}`,
        agentRunId: `run-${index}`,
        turnId: `turn-${index}`,
      },
    },
  };
}

function operatorInspection(
  snapshot: RuntimeAgentGraphClientSnapshot,
): RuntimeAgentGraphOperatorInspection {
  return {
    schemaVersion: 1,
    rootSessionId: snapshot.rootSessionId,
    graphId: snapshot.graphId,
    snapshotVersion: snapshot.snapshotVersion,
    operator: snapshot.operators[0]!,
    inboundEdges: [],
    outboundEdges: [],
    work: [],
    claims: [],
    activations: [],
    recentRecords: [],
    omitted: {
      inboundEdges: 0,
      outboundEdges: 0,
      work: 0,
      claims: 0,
      activations: 0,
      records: 0,
    },
  };
}

function activity(index: number): AgentGraphClientActivity {
  return {
    recordId: `record-${index}`,
    operatorId: `operator-${index % 40}`,
    activationId: `activation-${index}`,
    eventTime: index,
    facets: ['message'],
    signals: [],
    run: {
      sessionId: `child-${index % 40}`,
      agentRunId: `run-${index}`,
      turnId: `turn-${index}`,
    },
  };
}

function terminalActivity(index: number): AgentGraphClientActivity {
  return {
    ...activity(index),
    facets: ['completed'],
    signals: [{ kind: 'terminal', status: 'completed' }],
  };
}

function rootHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    id: 'root-1',
    label: 'Root',
    model: 'fake',
    provider: 'fake',
    createdAt: 1,
    lastUsedAt: 1,
    status: 'active',
    isArchived: false,
    ...overrides,
  } as SessionHeader;
}

function context(): ConnectionContext {
  return {
    hostEpoch: 'epoch-1',
    connectionId: 'connection-1',
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
}
