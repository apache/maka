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
  isAgentSwarmSupervisorCheckpoint,
  projectAgentSwarmStatus,
  renderAgentSwarmSupervisorWake,
  shouldWakeAgentSwarmSupervisor,
} from '../agent-swarm-status-tool.js';
import type {
  AgentGraphClientOperator,
  AgentGraphClientSnapshot,
} from '../stream-graph-read-model.js';

describe('asynchronous agent swarm status', () => {
  test('does not wake while work runs and omits child activity details', () => {
    const snapshot = swarmSnapshot([operator('work-1', 'running')]);
    const status = projectAgentSwarmStatus(snapshot);
    assert.equal(status.status, 'running');
    assert.equal(isAgentSwarmSupervisorCheckpoint(snapshot), false);
    assert.deepEqual(status.items, [
      {
        workId: 'work-1',
        status: 'running',
        operatorId: 'operator-work-1',
        childSessionId: 'session-work-1',
        runId: 'run-work-1',
      },
    ]);
    assert.doesNotMatch(JSON.stringify(status), /recentActivity|instruction|reasoning|tool/);
  });

  test('wakes on explicit failure without waiting for the remaining work', () => {
    const snapshot = swarmSnapshot([operator('work-1', 'failed'), operator('work-2', 'running')]);
    const status = projectAgentSwarmStatus(snapshot);
    assert.equal(status.status, 'needs_attention');
    assert.equal(status.counts.failed, 1);
    assert.equal(status.counts.running, 1);
    assert.equal(isAgentSwarmSupervisorCheckpoint(snapshot), true);
  });

  test('wakes when every scheduled item has settled', () => {
    const snapshot = swarmSnapshot([
      operator('work-1', 'completed'),
      operator('work-2', 'completed'),
    ]);
    assert.equal(projectAgentSwarmStatus(snapshot).status, 'settled');
    assert.equal(isAgentSwarmSupervisorCheckpoint(snapshot), true);
  });

  test('projects a durable reconciliation failure without child runtime state', () => {
    const snapshot = swarmSnapshot([]);
    snapshot.work = [
      {
        workId: 'work-failed',
        target: { kind: 'preset', presetId: 'deepseek-flash-reader' },
        inputIds: [],
        status: 'requested',
        instructionPreview: 'Read one bounded area.',
        instructionTruncated: false,
        revision: 1,
        committedAt: 1,
      },
    ];
    snapshot.reconciliationFailures = [
      { workId: 'work-failed', phase: 'dispatch', reason: 'provider unavailable' },
    ];

    const status = projectAgentSwarmStatus(snapshot);
    assert.equal(status.status, 'needs_attention');
    assert.deepEqual(status.items, [
      {
        workId: 'work-failed',
        status: 'failed',
        failurePhase: 'dispatch',
        failureReason: 'provider unavailable',
      },
    ]);
    assert.equal(shouldWakeAgentSwarmSupervisor('root', undefined, snapshot), true);
  });

  test('shares durable swarm policy without treating an ordinary graph as a swarm', () => {
    const graph = swarmSnapshot([operator('work-1', 'failed')]);
    graph.orchestrationMode = 'graph';

    assert.equal(shouldWakeAgentSwarmSupervisor('root', undefined, graph), undefined);
    assert.equal(renderAgentSwarmSupervisorWake('root', graph), undefined);
  });
});

function swarmSnapshot(operators: AgentGraphClientOperator[]): AgentGraphClientSnapshot {
  return {
    schemaVersion: 1,
    rootSessionId: 'root',
    graphId: 'graph-root',
    orchestrationMode: 'swarm',
    snapshotVersion: 'snapshot-1',
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: 'fingerprint',
    closed: false,
    operators,
    edges: [],
    work: operators.map((entry) => ({
      workId: entry.scheduledWorkIds[0]!,
      target: { kind: 'preset', presetId: 'deepseek-flash-reader' },
      inputIds: [],
      status: 'requested',
      instructionPreview: 'Read one bounded area.',
      instructionTruncated: false,
      revision: 1,
      committedAt: 1,
    })),
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
}

function operator(
  workId: string,
  status: 'running' | 'completed' | 'failed',
): AgentGraphClientOperator {
  return {
    operatorId: `operator-${workId}`,
    childSessionId: `session-${workId}`,
    provisionId: `provision-${workId}`,
    agentId: 'researcher',
    provisionedAt: 1,
    status,
    inboundEdgeIds: [],
    outboundEdgeIds: [],
    scheduledWorkIds: [workId],
    readiness: [],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
    currentActivation: {
      activationId: `activation-${workId}`,
      status,
      recordCount: 1,
      firstEventTime: 1,
      lastEventTime: 2,
      run: { sessionId: `session-${workId}`, agentRunId: `run-${workId}` },
    },
  };
}
