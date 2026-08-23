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
import { describe, test } from 'node:test';
import {
  AgentGraphClientOperationError,
  agentGraphIdForRootSession,
  type AgentGraphClientChangedListener,
  type AgentGraphCoordinator,
} from '@maka/runtime/stream-graph-coordinator';
import {
  decodeAgentGraphTerminalCursor,
  type AgentGraphClientActivity,
  type AgentGraphClientSnapshot as RuntimeAgentGraphClientSnapshot,
  type AgentGraphOperatorInspection as RuntimeAgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import { AGENT_GRAPH_RESULT_MAX_BYTES, decodeAgentGraphClientSnapshot } from '../protocol/index.js';
import {
  HostAgentGraphCoordinator,
  projectAgentGraphClientSnapshot,
} from '../server/agent-graph-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const fingerprint = `sha256:${'a'.repeat(64)}`;

describe('Host Agent Graph coordinator', () => {
  test('serves query, inspection, stop, and forwards invalidation without owning graph lifetime', async () => {
    const snapshot = graphSnapshot();
    const inspection = operatorInspection(snapshot);
    let stoppedRoot: string | undefined;
    let stoppedGraph: string | undefined;
    let listener: AgentGraphClientChangedListener | undefined;
    let unsubscribed = false;
    const invalidations: unknown[] = [];
    const authority = {
      currentGraphId: async () => snapshot.graphId,
      listGraphEpochPage: async () => ({
        epochs: [
          {
            schemaVersion: 1 as const,
            rootSessionId: 'root-1',
            epoch: 1,
            graphId: snapshot.graphId,
            createdAt: 0,
          },
        ],
        nextBeforeEpoch: null,
        currentEpoch: 1,
      }),
      getSnapshot: async () => snapshot,
      getGraphSnapshot: async () => snapshot,
      inspectOperator: async () => inspection,
      inspectGraphOperator: async () => inspection,
      subscribeAll: (candidate: AgentGraphClientChangedListener) => {
        listener = candidate;
        return () => {
          unsubscribed = true;
        };
      },
    } satisfies GraphAuthority;
    const coordinator = new HostAgentGraphCoordinator({
      authority,
      continuity: { enqueueAgentGraphChanged: (event) => invalidations.push(event) },
      stopExecution: async (rootSessionId, expectedGraphId) => {
        stoppedRoot = rootSessionId;
        stoppedGraph = expectedGraphId;
      },
    });

    const queried = await coordinator.handlers['agent.graph.query'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    assert.equal(queried.result.rootSessionId, 'root-1');
    assert.deepEqual(queried.result.work[0]?.target, {
      kind: 'preset',
      presetId: 'deepseek-flash-reader',
    });
    const epochs = await coordinator.handlers['agent.graph.epochs.query'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.deepEqual(epochs, {
      ok: true,
      result: {
        rootSessionId: 'root-1',
        epochs: [{ epoch: 1, graphId: snapshot.graphId, createdAt: 0, current: true }],
        nextBeforeEpoch: null,
      },
    });

    const inspected = await coordinator.handlers['agent.graph.operator.query'](
      { rootSessionId: 'root-1', operatorId: 'operator-1' },
      context(),
    );
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    assert.equal(inspected.result.operator.operatorId, 'operator-1');

    const stopped = await coordinator.handlers['agent.graph.stop'](
      { rootSessionId: 'root-1', expectedGraphId: snapshot.graphId },
      context(),
    );
    assert.deepEqual(stopped, {
      ok: true,
      result: { rootSessionId: 'root-1', graphId: snapshot.graphId },
    });
    assert.equal(stoppedRoot, 'root-1');
    assert.equal(stoppedGraph, snapshot.graphId);

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
    const authority = {
      currentGraphId: async () => agentGraphIdForRootSession('root-1'),
      listGraphEpochPage: async () => {
        throw new AgentGraphClientOperationError('not_found', 'Session was not found');
      },
      getSnapshot: async (_rootSessionId: string, options?: { terminalCursor?: string }) => {
        throw new AgentGraphClientOperationError(
          options?.terminalCursor ? 'invalid_request' : 'operation_conflict',
          options?.terminalCursor
            ? 'Agent graph terminal activity cursor is stale or invalid'
            : 'Agent graph client operations are available only to root Sessions',
        );
      },
      getGraphSnapshot: async () => {
        throw new AgentGraphClientOperationError('not_found', 'Agent graph was not found');
      },
      inspectOperator: async () => {
        throw new AgentGraphClientOperationError('not_found', 'Agent graph operator was not found');
      },
      inspectGraphOperator: async () => {
        throw new AgentGraphClientOperationError('not_found', 'Agent graph operator was not found');
      },
      subscribeAll: () => () => undefined,
    } satisfies GraphAuthority;

    const child = new HostAgentGraphCoordinator({
      authority,
      continuity: { enqueueAgentGraphChanged: () => undefined },
      stopExecution: async () => {
        throw new AgentGraphClientOperationError(
          'session_archived',
          'Archived Sessions cannot supervise an agent graph',
        );
      },
    });
    const childQuery = await child.handlers['agent.graph.query'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.equal(childQuery.ok, false);
    if (!childQuery.ok) assert.equal(childQuery.error.code, 'operation_conflict');

    const archivedStop = await child.handlers['agent.graph.stop'](
      { rootSessionId: 'root-1', expectedGraphId: agentGraphIdForRootSession('root-1') },
      context(),
    );
    assert.equal(archivedStop.ok, false);
    if (!archivedStop.ok) assert.equal(archivedStop.error.code, 'session_archived');

    const missingOperator = await child.handlers['agent.graph.operator.query'](
      { rootSessionId: 'root-1', operatorId: 'missing-operator' },
      context(),
    );
    assert.equal(missingOperator.ok, false);
    if (!missingOperator.ok) assert.equal(missingOperator.error.code, 'not_found');

    const invalidCursor = await child.handlers['agent.graph.query'](
      { rootSessionId: 'root-1', terminalCursor: 'Y3Vyc29y' },
      context(),
    );
    assert.equal(invalidCursor.ok, false);
    if (!invalidCursor.ok) assert.equal(invalidCursor.error.code, 'invalid_request');
    child.close();
  });

  test('pages graph epochs newest-first without losing current identity', async () => {
    const source = graphSnapshot();
    const epochs = Array.from({ length: 35 }, (_, index) => ({
      schemaVersion: 1 as const,
      rootSessionId: 'root-1',
      epoch: index + 1,
      graphId: `agent_graph_${index + 1}`,
      createdAt: index,
    }));
    const authority = {
      currentGraphId: async () => epochs.at(-1)!.graphId,
      listGraphEpochPage: async (
        _rootSessionId: string,
        options: { beforeEpoch?: number; limit: number },
      ) => {
        const eligible = epochs.filter(
          (entry) => entry.epoch < (options.beforeEpoch ?? Number.POSITIVE_INFINITY),
        );
        const page = eligible.slice(-options.limit).reverse();
        return {
          epochs: page,
          nextBeforeEpoch: eligible.length > page.length ? page.at(-1)!.epoch : null,
          currentEpoch: 35,
        };
      },
      getSnapshot: async () => source,
      getGraphSnapshot: async () => source,
      inspectOperator: async () => operatorInspection(source),
      inspectGraphOperator: async () => operatorInspection(source),
      subscribeAll: () => () => undefined,
    } satisfies GraphAuthority;
    const coordinator = new HostAgentGraphCoordinator({
      authority,
      continuity: { enqueueAgentGraphChanged: () => undefined },
      stopExecution: async () => undefined,
    });

    const first = await coordinator.handlers['agent.graph.epochs.query'](
      { rootSessionId: 'root-1' },
      context(),
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.result.epochs.length, 32);
    assert.equal(first.result.epochs[0]?.epoch, 35);
    assert.equal(first.result.epochs[0]?.current, true);
    assert.equal(first.result.nextBeforeEpoch, 4);

    const second = await coordinator.handlers['agent.graph.epochs.query'](
      { rootSessionId: 'root-1', beforeEpoch: first.result.nextBeforeEpoch! },
      context(),
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(
      second.result.epochs.map(({ epoch, current }) => ({ epoch, current })),
      [
        { epoch: 3, current: false },
        { epoch: 2, current: false },
        { epoch: 1, current: false },
      ],
    );
    assert.equal(second.result.nextBeforeEpoch, null);

    const ahead = await coordinator.handlers['agent.graph.epochs.query'](
      { rootSessionId: 'root-1', beforeEpoch: 999 },
      context(),
    );
    assert.equal(ahead.ok, false);
    if (!ahead.ok) assert.equal(ahead.error.code, 'invalid_request');
    coordinator.close();
  });

  test('bounds large snapshots while preserving omission and terminal continuation', () => {
    const source = graphSnapshot();
    source.operators = Array.from({ length: 40 }, (_, index) => {
      const operator = graphOperator(`operator-${index}`, index);
      const status = index < 8 ? ('running' as const) : ('completed' as const);
      return {
        ...operator,
        status,
        currentActivation: { ...operator.currentActivation, status },
      };
    });
    source.edges = Array.from({ length: 200 }, (_, index) => ({
      edgeId: `edge-${index}`,
      fromOperatorId: `operator-${index % 40}`,
      toOperatorId: `operator-${(index + 1) % 40}`,
    }));
    source.recentActivity = Array.from({ length: 64 }, (_, index) => activity(index));
    source.terminalHistory = {
      records: Array.from({ length: 64 }, (_, index) => terminalActivity(63 - index)),
    };

    const projected = projectAgentGraphClientSnapshot(source);
    assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= AGENT_GRAPH_RESULT_MAX_BYTES);
    assert.doesNotThrow(() => decodeAgentGraphClientSnapshot(projected));
    assert.equal(projected.operators.length + projected.omitted.operators, source.operators.length);
    assert.equal(projected.edges.length + projected.omitted.edges, source.edges.length);
    assert.equal(
      projected.recentActivity.length + projected.omitted.recentActivity,
      source.recentActivity.length,
    );
    assert.deepEqual(
      projected.operators.slice(0, 8).map((operator) => operator.operatorId),
      Array.from({ length: 8 }, (_, index) => `operator-${index}`),
      'byte fitting must retain every live operator before terminal operators',
    );
    assert.deepEqual(
      projected.recentActivity.map((record) => record.recordId),
      source.recentActivity
        .slice(source.recentActivity.length - projected.recentActivity.length)
        .map((record) => record.recordId),
      'byte fitting must retain the latest recent activity',
    );
    const firstOperator = projected.operators[0]!;
    assert.equal(
      firstOperator.inboundEdgeIds.length + firstOperator.omitted.inboundEdgeIds,
      source.operators[0]!.inboundEdgeIds.length,
    );
    assert.deepEqual(firstOperator.readiness[0]?.waitingFor, []);
    assert.equal(firstOperator.readiness[0]?.omittedWaitingFor, 1);
    assert.equal(firstOperator.omitted.readinessWaits, 1);
    assert.ok(projected.terminalHistory.records.length > 0);
    assert.ok(projected.terminalHistory.nextCursor);
    const cursor = decodeAgentGraphTerminalCursor(projected.terminalHistory.nextCursor!);
    assert.equal(cursor.recordId, projected.terminalHistory.records.at(-1)?.recordId);
  });

  test('projects only allowlisted Runtime fields onto the wire', () => {
    const source = graphSnapshot();
    Object.assign(source.operators[0]!, { privatePrompt: 'operator-secret' });
    Object.assign(source.operators[0]!.readiness[0]!, {
      policyKind: 'map',
      privatePolicy: 'readiness-secret',
    });
    Object.assign(source.recentActivity[0]!, { privatePayload: 'activity-secret' });

    const projected = projectAgentGraphClientSnapshot(source);
    assert.equal(JSON.stringify(projected).includes('secret'), false);
    assert.doesNotThrow(() => decodeAgentGraphClientSnapshot(projected));
  });

  test('rejects work whose current and selected historical inputs exceed the combined cap', () => {
    const work = {
      workId: 'work-1',
      target: { kind: 'agent', agentId: 'local-read' },
      inputIds: Array.from({ length: 64 }, (_, index) => `input-${index}`),
      selectedResultInputs: [{ sourceGraphId: 'graph-prev', resultId: 'result-1' }],
      status: 'requested',
      instructionPreview: 'continue',
      instructionTruncated: false,
      revision: 1,
      committedAt: 1,
    };
    const frame = {
      schemaVersion: 1,
      rootSessionId: 'session-root',
      graphId: 'graph-1',
      orchestrationMode: 'graph',
      snapshotVersion: `sha256:${'a'.repeat(64)}`,
      status: 'active',
      scheduleRevision: 1,
      topologyFingerprint: `sha256:${'b'.repeat(64)}`,
      closed: false,
      operators: [],
      edges: [],
      work: [work],
      reconciliationFailures: [],
      stoppedTargets: [],
      claims: [],
      recentControlDecisions: [],
      recentActivity: [],
      terminalHistory: { records: [] },
      omitted: {
        operators: 0,
        edges: 0,
        work: 0,
        reconciliationFailures: 0,
        stoppedTargets: 0,
        claims: 0,
        controlDecisions: 0,
        recentActivity: 0,
      },
    };
    // The durable schedule contract caps current + selected historical inputs
    // combined at 64; 64 + 1 must not decode (#2992 P3 follow-up).
    assert.throws(() => decodeAgentGraphClientSnapshot(frame), /combined current and historical/);
    const atCap = {
      ...frame,
      work: [{ ...work, inputIds: work.inputIds.slice(0, 63) }],
    };
    assert.doesNotThrow(() => decodeAgentGraphClientSnapshot(atCap));
  });
});

type GraphAuthority = Pick<
  AgentGraphCoordinator,
  | 'currentGraphId'
  | 'getGraphSnapshot'
  | 'getSnapshot'
  | 'inspectGraphOperator'
  | 'inspectOperator'
  | 'listGraphEpochPage'
  | 'subscribeAll'
>;

function graphSnapshot(): RuntimeAgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root-1',
    graphId: agentGraphIdForRootSession('root-1'),
    orchestrationMode: 'swarm',
    snapshotVersion: fingerprint,
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: fingerprint,
    closed: false,
    latestEventTime: 10,
    operators: [graphOperator('operator-1', 1)],
    edges: [],
    work: [
      {
        workId: 'work-1',
        target: { kind: 'preset', presetId: 'deepseek-flash-reader' },
        inputIds: [],
        status: 'requested',
        instructionPreview: 'Inspect independently.',
        instructionTruncated: false,
        revision: 1,
        committedAt: 1,
      },
    ],
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [],
    recentControlDecisions: [],
    recentActivity: [activity(1)],
    terminalHistory: { records: [] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 0,
      reconciliationFailures: 0,
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

function context(): ConnectionContext {
  return {
    hostEpoch: 'epoch-1',
    connectionId: 'connection-1',
    principal: 'local_os_user',
    acquireResidency: () => ({ release() {} }),
  };
}
