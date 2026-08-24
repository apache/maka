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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AGENT_GRAPH_MAX_OPERATORS,
  AGENT_GRAPH_OPERATION_SPECS,
  AGENT_GRAPH_RESULT_MAX_BYTES,
  decodeAgentGraphClientSnapshot,
  decodeAgentGraphEpochListInput,
  decodeAgentGraphEpochListResult,
  decodeAgentGraphOperatorInspection,
  decodeAgentGraphOperatorQueryInput,
  decodeAgentGraphQueryInput,
  decodeAgentGraphStopInput,
  decodeAgentGraphStopResult,
  decodeHostFrame,
  type AgentGraphClientSnapshot,
  type AgentGraphOperatorInspection,
} from '../protocol/index.js';

const fingerprint = `sha256:${'a'.repeat(64)}` as const;

describe('Agent Graph Client protocol', () => {
  test('round-trips canonical inputs and bounded projections', () => {
    assert.deepEqual(decodeAgentGraphEpochListInput({ rootSessionId: 'root-1', beforeEpoch: 2 }), {
      rootSessionId: 'root-1',
      beforeEpoch: 2,
    });
    assert.deepEqual(
      decodeAgentGraphEpochListResult({
        rootSessionId: 'root-1',
        epochs: [
          { epoch: 2, graphId: 'agent_graph_2', createdAt: 10, current: true },
          { epoch: 1, graphId: 'agent_graph_1', createdAt: 0, current: false },
        ],
        nextBeforeEpoch: null,
      }).epochs.map(({ epoch, graphId, current }) => ({ epoch, graphId, current })),
      [
        { epoch: 2, graphId: 'agent_graph_2', current: true },
        { epoch: 1, graphId: 'agent_graph_1', current: false },
      ],
    );
    assert.deepEqual(decodeAgentGraphQueryInput({ rootSessionId: 'root-1' }), {
      rootSessionId: 'root-1',
    });
    assert.deepEqual(
      decodeAgentGraphQueryInput({
        rootSessionId: 'root-1',
        graphId: 'agent_graph_1',
        terminalCursor: 'Y3Vyc29y',
      }),
      { rootSessionId: 'root-1', graphId: 'agent_graph_1', terminalCursor: 'Y3Vyc29y' },
    );
    assert.deepEqual(
      decodeAgentGraphOperatorQueryInput({
        rootSessionId: 'root-1',
        graphId: 'agent_graph_1',
        operatorId: 'operator:1',
      }),
      { rootSessionId: 'root-1', graphId: 'agent_graph_1', operatorId: 'operator:1' },
    );
    assert.deepEqual(
      decodeAgentGraphStopInput({
        rootSessionId: 'root-1',
        expectedGraphId: 'agent_graph_1',
      }),
      { rootSessionId: 'root-1', expectedGraphId: 'agent_graph_1' },
    );
    assert.deepEqual(
      decodeAgentGraphStopResult({ rootSessionId: 'root-1', graphId: 'agent_graph_1' }),
      { rootSessionId: 'root-1', graphId: 'agent_graph_1' },
    );

    const snapshot = graphSnapshot();
    const inspection = operatorInspection(snapshot);
    assert.deepEqual(decodeAgentGraphClientSnapshot(snapshot), snapshot);
    assert.deepEqual(decodeAgentGraphOperatorInspection(inspection), inspection);
    AGENT_GRAPH_OPERATION_SPECS['agent.graph.query'].assertOutputForInput?.(
      { rootSessionId: 'root-1' },
      snapshot,
    );
    AGENT_GRAPH_OPERATION_SPECS['agent.graph.operator.query'].assertOutputForInput?.(
      { rootSessionId: 'root-1', operatorId: 'operator:1' },
      inspection,
    );
  });

  test('rejects unknown nested fields, invalid correlation, and unbounded pages', () => {
    const snapshot = graphSnapshot();
    assertInvalid(() =>
      decodeAgentGraphEpochListResult({
        rootSessionId: 'root-1',
        epochs: [{ epoch: 2, graphId: 'agent_graph_2', createdAt: 10, current: true }],
        nextBeforeEpoch: 1,
      }),
    );
    assertInvalid(() =>
      decodeAgentGraphEpochListInput({ rootSessionId: 'root-1', beforeEpoch: 0 }),
    );
    assertInvalid(() =>
      AGENT_GRAPH_OPERATION_SPECS['agent.graph.epochs.query'].assertOutputForInput?.(
        { rootSessionId: 'root-1', beforeEpoch: 2 },
        {
          rootSessionId: 'root-1',
          epochs: [{ epoch: 2, graphId: 'agent_graph_2', createdAt: 10, current: true }],
          nextBeforeEpoch: null,
        },
      ),
    );
    assertInvalid(() =>
      decodeAgentGraphClientSnapshot({
        ...snapshot,
        operators: [{ ...snapshot.operators[0], privatePrompt: 'secret' }],
      }),
    );
    assertInvalid(() =>
      decodeAgentGraphClientSnapshot({
        ...snapshot,
        operators: [
          {
            ...snapshot.operators[0],
            readiness: [{ ...snapshot.operators[0]!.readiness[0], policyKind: 'map' }],
          },
        ],
      }),
    );
    assertInvalid(() =>
      decodeAgentGraphClientSnapshot({
        ...snapshot,
        operators: Array.from({ length: AGENT_GRAPH_MAX_OPERATORS + 1 }, (_, index) => ({
          ...snapshot.operators[0],
          operatorId: `operator-${index}`,
        })),
      }),
    );
    assertInvalid(() =>
      decodeAgentGraphQueryInput({ rootSessionId: 'root-1', terminalCursor: 'not/base64' }),
    );
    assertInvalid(() =>
      AGENT_GRAPH_OPERATION_SPECS['agent.graph.query'].assertOutputForInput?.(
        { rootSessionId: 'another-root' },
        snapshot,
      ),
    );
    assertInvalid(() =>
      AGENT_GRAPH_OPERATION_SPECS['agent.graph.query'].assertOutputForInput?.(
        { rootSessionId: 'root-1', graphId: 'another-graph' },
        snapshot,
      ),
    );
    assertInvalid(() =>
      AGENT_GRAPH_OPERATION_SPECS['agent.graph.operator.query'].assertOutputForInput?.(
        { rootSessionId: 'root-1', operatorId: 'another-operator' },
        operatorInspection(snapshot),
      ),
    );
    assertInvalid(() =>
      decodeAgentGraphClientSnapshot({
        ...snapshot,
        snapshotVersion: 'not-a-fingerprint',
      }),
    );
  });

  test('decodes graph invalidation on the existing Session subscription sequence', () => {
    const frame = {
      kind: 'subscription.agent_graph_changed' as const,
      hostEpoch: 'epoch-1',
      subscriptionId: 'subscription-1',
      sequence: 3,
      rootSessionId: 'root-1',
      graphId: 'agent_graph_1',
      reason: 'runtime_activity' as const,
    };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assertInvalid(() => decodeHostFrame({ ...frame, reason: 'payload_changed' }));
    assertInvalid(() => decodeHostFrame({ ...frame, runtimePayload: { text: 'secret' } }));
  });

  test('rejects an encoded projection above the operation result budget', () => {
    const snapshot = graphSnapshot();
    const oversized = {
      ...snapshot,
      finish: {
        resultIds: [],
        reason: 'x'.repeat(AGENT_GRAPH_RESULT_MAX_BYTES),
        revision: 1,
        committedAt: 1,
      },
    };
    assertInvalid(() => decodeAgentGraphClientSnapshot(oversized));
  });
});

function graphSnapshot(): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root-1',
    graphId: 'agent_graph_1',
    orchestrationMode: 'swarm',
    snapshotVersion: fingerprint,
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: fingerprint,
    closed: false,
    latestEventTime: 10,
    operators: [
      {
        operatorId: 'operator:1',
        childSessionId: 'child-1',
        provisionId: 'provision:1',
        agentId: 'agent:1',
        provisionedAt: 1,
        status: 'blocked',
        inboundEdgeIds: ['edge:1'],
        outboundEdgeIds: [],
        scheduledWorkIds: ['work:1'],
        readiness: [
          {
            readinessId: 'readiness:1',
            status: 'waiting',
            waitingFor: [{ kind: 'input_route', upstreamOperatorIds: ['operator:0'] }],
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
          activationId: 'activation:1',
          status: 'running',
          recordCount: 1,
          firstEventTime: 10,
          lastEventTime: 10,
          run: { sessionId: 'child-1', agentRunId: 'run:1', turnId: 'turn:1' },
        },
      },
    ],
    edges: [{ edgeId: 'edge:1', fromOperatorId: 'operator:0', toOperatorId: 'operator:1' }],
    work: [
      {
        workId: 'work:1',
        target: { kind: 'operator', operatorId: 'operator:1' },
        inputIds: ['record:1'],
        status: 'requested',
        instructionPreview: 'Inspect the result.',
        instructionTruncated: false,
        revision: 1,
        committedAt: 1,
      },
      {
        workId: 'work:2',
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
    claims: [
      {
        claimId: 'claim:1',
        intentId: 'intent:1',
        operatorId: 'operator:1',
        childSessionId: 'child-1',
        run: { sessionId: 'child-1', agentRunId: 'run:1', turnId: 'turn:1' },
        admissionState: 'executing',
        claimedAt: 2,
      },
    ],
    recentControlDecisions: [],
    recentActivity: [activity()],
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

function operatorInspection(snapshot: AgentGraphClientSnapshot): AgentGraphOperatorInspection {
  return {
    schemaVersion: 1,
    rootSessionId: snapshot.rootSessionId,
    graphId: snapshot.graphId,
    snapshotVersion: snapshot.snapshotVersion,
    operator: snapshot.operators[0]!,
    inboundEdges: snapshot.edges,
    outboundEdges: [],
    work: snapshot.work,
    claims: snapshot.claims,
    activations: [
      {
        activationId: 'activation:1',
        status: 'running',
        recordCount: 1,
        firstEventTime: 10,
        lastEventTime: 10,
        lastRecordId: 'record:1',
        run: { sessionId: 'child-1', agentRunId: 'run:1', turnId: 'turn:1' },
      },
    ],
    recentRecords: [activity()],
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

function activity() {
  return {
    recordId: 'record:1',
    operatorId: 'operator:1',
    activationId: 'activation:1',
    eventTime: 10,
    facets: ['permission_request'] as const,
    signals: [{ kind: 'attention', reason: 'permission_request' }] as const,
    run: { sessionId: 'child-1', agentRunId: 'run:1', turnId: 'turn:1' },
  };
}

function assertInvalid(operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) => error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
  );
}
