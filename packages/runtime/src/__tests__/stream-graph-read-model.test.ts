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
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import type { AgentGraphScheduleUpdate } from '@maka/core/agent-graph-schedule';
import type {
  AgentGraphSupervisorObservation,
  AgentGraphSupervisorRuntimeEvent,
} from '../stream-graph-dispatch.js';
import type { AgentGraphActivationState, AgentGraphRecord } from '../stream-graph-projection.js';
import {
  advanceMaterializedAgentGraphClientProjection,
  buildAgentGraphClientSnapshot,
  inspectAgentGraphOperator,
  materializeAgentGraphClientProjection,
  type AgentGraphClientActivity,
} from '../stream-graph-read-model.js';

describe('agent graph client read model', () => {
  test('bounds terminal history with a reconnect-safe opaque cursor', () => {
    const graphId = 'graph-1';
    const rootSessionId = 'root-session';
    const operatorId = 'operator-1';
    const childSessionId = 'child-session';
    const records = Array.from({ length: 70 }, (_, index) =>
      terminalRecord({
        graphId,
        operatorId,
        childSessionId,
        index,
      }),
    );
    const activations = Object.fromEntries(
      records.map((record, index) => [record.activationId, activation(record, index)]),
    );
    const observation = {
      projection: {
        graphId,
        operators: [{ operatorId, sessionId: childSessionId }],
        ignoredPartialEvents: 0,
        records,
        supervisorMetaStream: [],
        state: {
          graphId,
          latestEventTime: 69,
          appliedRecordIds: records.map((record) => record.recordId),
          operators: {
            [operatorId]: {
              operatorId,
              sessionId: childSessionId,
              status: 'completed',
              currentActivationId: 'run-69',
              activations,
            },
          },
        },
      },
      readiness: {
        schemaVersion: 1,
        graphId,
        topologyFingerprint: 'sha256:topology',
        trace: { graphId },
        readiness: {},
        supervisorView: [],
      },
      claims: [],
    } as unknown as AgentGraphSupervisorObservation;
    const input = {
      rootSessionId,
      graphId,
      provisions: [provision(graphId, operatorId, childSessionId)],
      scheduleUpdates: [],
      observation,
    };

    const first = buildAgentGraphClientSnapshot(input);
    assert.equal(first.terminalHistory.records.length, 64);
    assert.ok(first.terminalHistory.nextCursor);
    assert.equal(first.terminalHistory.records[0]?.recordId, 'record-69');
    const second = buildAgentGraphClientSnapshot(input, {
      terminalCursor: first.terminalHistory.nextCursor,
    });
    assert.equal(second.terminalHistory.records.length, 6);
    assert.equal(second.terminalHistory.records[0]?.recordId, 'record-5');
    assert.equal(second.terminalHistory.nextCursor, undefined);
    assert.equal(first.snapshotVersion, second.snapshotVersion);
    assert.notEqual(first.terminalHistory.nextCursor, 'record-5');

    const inspection = inspectAgentGraphOperator(input, operatorId);
    assert.equal(inspection.activations.length, 64);
    assert.equal(inspection.omitted.activations, 6);
    assert.equal(inspection.recentRecords.length, 70);
    assert.equal(inspection.operator.childSessionId, childSessionId);
  });

  test('rejects a terminal cursor from another graph', () => {
    const firstInput = emptyInput('graph-1');
    const cursorSource = buildAgentGraphClientSnapshot({
      ...firstInput,
      provisions: [provision('graph-1', 'operator-1', 'child-1')],
      observation: observationWithOneTerminal('graph-1', 'operator-1', 'child-1'),
    });
    // One terminal record has no next page, so create a valid cursor by using
    // the first page of a larger source graph.
    const many = Array.from({ length: 65 }, (_, index) =>
      terminalRecord({
        graphId: 'graph-1',
        operatorId: 'operator-1',
        childSessionId: 'child-1',
        index,
      }),
    );
    const source = buildAgentGraphClientSnapshot({
      ...firstInput,
      provisions: [provision('graph-1', 'operator-1', 'child-1')],
      observation: observationFromRecords('graph-1', 'operator-1', 'child-1', many),
    });
    assert.equal(cursorSource.terminalHistory.nextCursor, undefined);
    assert.ok(source.terminalHistory.nextCursor);
    assert.throws(
      () =>
        buildAgentGraphClientSnapshot(emptyInput('graph-2'), {
          terminalCursor: source.terminalHistory.nextCursor,
        }),
      /another graph/,
    );
  });

  test('keeps schedule payloads bounded while preserving durable control refs', () => {
    const graphId = 'graph-1';
    const operatorId = 'operator-1';
    const childSessionId = 'child-1';
    const instruction = 'x'.repeat(600);
    const snapshot = buildAgentGraphClientSnapshot({
      rootSessionId: 'root-session',
      graphId,
      provisions: [provision(graphId, operatorId, childSessionId)],
      scheduleUpdates: [scheduleUpdate(graphId, instruction)],
      observation: observationWithOneTerminal(graphId, operatorId, childSessionId),
    });
    assert.equal(snapshot.work.length, 1);
    assert.equal(snapshot.work[0]?.instructionTruncated, true);
    assert.equal(snapshot.work[0]?.instructionPreview.length, 501);
    assert.equal(snapshot.recentControlDecisions[0]?.source.agentRunId, 'root-run');
    assert.deepEqual(snapshot.recentControlDecisions[0]?.addedWorkIds, [
      'graph_work_00000000000000000000000000000000',
    ]);
  });

  test('treats finish as admission closure until existing claims settle', () => {
    const graphId = 'graph-1';
    const operatorId = 'operator-1';
    const childSessionId = 'child-1';
    const running = terminalRecord({
      graphId,
      operatorId,
      childSessionId,
      index: 0,
    });
    running.facets = ['message'];
    running.supervisorSignals = [];
    const runningObservation = observationFromRecords(graphId, operatorId, childSessionId, [
      running,
    ]);
    const activationState =
      runningObservation.projection.state.operators[operatorId]!.activations[running.activationId]!;
    activationState.status = 'running';
    delete activationState.terminalRecordId;
    runningObservation.projection.state.operators[operatorId]!.status = 'running';
    runningObservation.claims = [
      {
        schemaVersion: 1,
        claimId: `graph_claim_${'1'.repeat(32)}`,
        graphId,
        intentId: `graph_intent_${'2'.repeat(32)}`,
        intentFingerprint: `sha256:${'3'.repeat(64)}`,
        readinessContextFingerprint: `sha256:${'4'.repeat(64)}`,
        targetOperatorId: operatorId,
        targetSessionId: childSessionId,
        targetTurnId: 'turn-0',
        targetRunId: 'run-0',
        claimedAt: 0,
      },
    ];
    const finish = finishUpdate(graphId, running.recordId);
    const closing = buildAgentGraphClientSnapshot({
      rootSessionId: 'root-session',
      graphId,
      provisions: [provision(graphId, operatorId, childSessionId)],
      scheduleUpdates: [finish],
      observation: runningObservation,
    });
    assert.equal(closing.closed, true);
    assert.equal(closing.status, 'closing');

    assert.equal(
      buildAgentGraphClientSnapshot({
        rootSessionId: 'root-session',
        graphId,
        provisions: [provision(graphId, operatorId, childSessionId)],
        scheduleUpdates: [finish],
        observation: {
          ...observationWithOneTerminal(graphId, operatorId, childSessionId),
          claims: runningObservation.claims,
        },
      }).status,
      'completed',
    );
  });

  test('bounds nested operator and inspection collections with omitted counts', () => {
    const graphId = 'graph-1';
    const operatorId = 'operator-1';
    const childSessionId = 'child-1';
    const baseProvision = provision(graphId, operatorId, childSessionId);
    const edges = Array.from({ length: 600 }, (_, index) => ({
      edgeId: `edge-${index}`,
      fromOperatorId: operatorId,
      toOperatorId: `downstream-${index}`,
    }));
    const work = Array.from({ length: 300 }, (_, index) => ({
      workId: `work-${index}`,
      target: { kind: 'operator' as const, operatorId },
      inputIds: [],
      status: 'requested' as const,
      instruction: `work ${index}`,
      revision: index + 1,
      committedAt: index + 1,
    }));
    const observation = observationWithOneTerminal(graphId, operatorId, childSessionId);
    observation.claims = Array.from({ length: 300 }, (_, index) => ({
      schemaVersion: 1,
      claimId: `claim-${index}`,
      graphId,
      intentId: `intent-${index}`,
      intentFingerprint: `sha256:${'1'.repeat(64)}`,
      readinessContextFingerprint: `sha256:${'2'.repeat(64)}`,
      targetOperatorId: operatorId,
      targetSessionId: childSessionId,
      targetTurnId: `turn-${index}`,
      targetRunId: `claimed-run-${index}`,
      claimedAt: index,
    }));
    observation.readiness.supervisorView = Array.from({ length: 80 }, (_, index) => ({
      graphId,
      topologyFingerprint: 'sha256:topology',
      readinessId: `readiness-${index}`,
      operatorId,
      policyKind: 'all_settled' as const,
      policyFingerprint: `policy-${index}`,
      readinessContextFingerprint: `context-${index}`,
      status: 'waiting' as const,
      intentIds: [],
      waitingFor: Array.from({ length: 300 }, (__, waitIndex) => ({
        kind: 'activation_running' as const,
        operatorId: `upstream-${waitIndex}`,
        activationId: `activation-${waitIndex}`,
      })),
    }));
    const input = {
      rootSessionId: 'root-session',
      graphId,
      provisions: [{ ...baseProvision, edges }],
      scheduleUpdates: [],
      schedule: {
        graphId,
        revision: 300,
        work,
        stoppedTargets: [],
        closed: false,
      },
      observation,
    } as unknown as Parameters<typeof buildAgentGraphClientSnapshot>[0];
    const snapshot = buildAgentGraphClientSnapshot(input);
    const operator = snapshot.operators[0]!;
    assert.equal(operator.outboundEdgeIds.length, 64);
    assert.equal(operator.omitted.outboundEdgeIds, 536);
    assert.equal(operator.scheduledWorkIds.length, 64);
    assert.equal(operator.omitted.scheduledWorkIds, 236);
    assert.equal(operator.readiness.length, 8);
    assert.equal(operator.omitted.readiness, 72);
    assert.equal(operator.readiness[0]?.waitingFor.length, 64);
    assert.equal('policyKind' in operator.readiness[0]!, false);
    assert.equal(operator.omitted.readinessWaits, 80 * 236);

    const inspection = inspectAgentGraphOperator(input, operatorId);
    assert.equal(inspection.outboundEdges.length, 512);
    assert.equal(inspection.omitted.outboundEdges, 88);
    assert.equal(inspection.work.length, 256);
    assert.equal(inspection.omitted.work, 44);
    assert.equal(inspection.claims.length, 256);
    assert.equal(inspection.omitted.claims, 44);
  });

  test('materializes duplicate and out-of-order runtime records deterministically', () => {
    const graphId = 'graph-order';
    const operatorId = 'operator-1';
    const childSessionId = 'child-1';
    const baseInput = runningInput(graphId, operatorId, childSessionId);
    const initial = materializeAgentGraphClientProjection(baseInput);
    const message = supervisorRuntimeEvent({
      graphId,
      operatorId,
      childSessionId,
      eventId: 'event-message',
      eventTime: 10,
      eventType: 'text_complete',
    });
    const complete = supervisorRuntimeEvent({
      graphId,
      operatorId,
      childSessionId,
      eventId: 'event-complete',
      eventTime: 20,
      eventType: 'complete',
    });

    const messageFirst = advanceMaterializedAgentGraphClientProjection(
      initial.snapshot,
      initial.operators[0]!,
      message,
      false,
    )!;
    const forward = advanceMaterializedAgentGraphClientProjection(
      messageFirst.snapshot,
      messageFirst.operator,
      complete,
      false,
    )!;
    const completeFirst = advanceMaterializedAgentGraphClientProjection(
      initial.snapshot,
      initial.operators[0]!,
      complete,
      false,
    )!;
    const reverse = advanceMaterializedAgentGraphClientProjection(
      completeFirst.snapshot,
      completeFirst.operator,
      message,
      false,
    )!;

    assert.deepEqual(
      { ...forward.snapshot, snapshotVersion: '' },
      { ...reverse.snapshot, snapshotVersion: '' },
    );
    assert.equal(forward.snapshot.snapshotVersion, reverse.snapshot.snapshotVersion);
    assert.deepEqual(forward.snapshot.recentActivity, reverse.snapshot.recentActivity);
    assert.deepEqual(forward.operator.activations, reverse.operator.activations);
    assert.equal(reverse.operator.operator.status, 'completed');
    assert.equal(
      advanceMaterializedAgentGraphClientProjection(
        forward.snapshot,
        forward.operator,
        message,
        false,
      ),
      undefined,
    );

    const canonicalRecords = forward.snapshot.recentActivity.map((activity, index) =>
      graphRecordFromActivity(graphId, activity, index),
    );
    const canonicalObservation = observationFromRecords(
      graphId,
      operatorId,
      childSessionId,
      canonicalRecords,
    );
    canonicalObservation.readiness.topologyFingerprint =
      baseInput.observation.readiness.topologyFingerprint;
    canonicalObservation.projection.state.operators[operatorId]!.activations = {
      'run-0': {
        activationId: 'run-0',
        agentRunId: 'run-0',
        status: 'completed',
        recordCount: 2,
        firstEventTime: 10,
        lastEventTime: 20,
        lastRecordId: forward.activity.recordId,
        terminalRecordId: forward.activity.recordId,
      },
    };
    canonicalObservation.projection.state.operators[operatorId]!.currentActivationId = 'run-0';
    canonicalObservation.projection.state.operators[operatorId]!.status = 'completed';
    const rebuilt = materializeAgentGraphClientProjection({
      ...baseInput,
      observation: canonicalObservation,
    });
    const {
      snapshotVersion: _rebuiltVersion,
      terminalHistory: _rebuiltTerminalHistory,
      ...rebuiltContent
    } = rebuilt.snapshot;
    const {
      snapshotVersion: _forwardVersion,
      terminalHistory: _forwardTerminalHistory,
      ...forwardContent
    } = forward.snapshot;
    assert.deepEqual(rebuiltContent, forwardContent);
    assert.equal(rebuilt.snapshot.snapshotVersion, forward.snapshot.snapshotVersion);
    assert.deepEqual(rebuilt.snapshot.recentActivity, forward.snapshot.recentActivity);
  });
});

function emptyInput(graphId: string) {
  return {
    rootSessionId: 'root-session',
    graphId,
    provisions: [] as AgentGraphOperatorProvision[],
    scheduleUpdates: [],
    observation: {
      projection: {
        graphId,
        operators: [],
        ignoredPartialEvents: 0,
        records: [],
        supervisorMetaStream: [],
        state: { graphId, appliedRecordIds: [], operators: {} },
      },
      readiness: {
        schemaVersion: 1,
        graphId,
        topologyFingerprint: 'sha256:empty',
        trace: { graphId },
        readiness: {},
        supervisorView: [],
      },
      claims: [],
    } as unknown as AgentGraphSupervisorObservation,
  };
}

function observationWithOneTerminal(
  graphId: string,
  operatorId: string,
  childSessionId: string,
): AgentGraphSupervisorObservation {
  return observationFromRecords(graphId, operatorId, childSessionId, [
    terminalRecord({ graphId, operatorId, childSessionId, index: 0 }),
  ]);
}

function observationFromRecords(
  graphId: string,
  operatorId: string,
  childSessionId: string,
  records: AgentGraphRecord[],
): AgentGraphSupervisorObservation {
  const activations = Object.fromEntries(
    records.map((record, index) => [record.activationId, activation(record, index)]),
  );
  return {
    projection: {
      graphId,
      operators: [{ operatorId, sessionId: childSessionId }],
      ignoredPartialEvents: 0,
      records,
      supervisorMetaStream: [],
      state: {
        graphId,
        latestEventTime: records.at(-1)?.eventTime,
        appliedRecordIds: records.map((record) => record.recordId),
        operators: {
          [operatorId]: {
            operatorId,
            sessionId: childSessionId,
            status: 'completed',
            currentActivationId: records.at(-1)!.activationId,
            activations,
          },
        },
      },
    },
    readiness: {
      schemaVersion: 1,
      graphId,
      topologyFingerprint: 'sha256:topology',
      trace: { graphId },
      readiness: {},
      supervisorView: [],
    },
    claims: [],
  } as unknown as AgentGraphSupervisorObservation;
}

function provision(
  graphId: string,
  operatorId: string,
  childSessionId: string,
): AgentGraphOperatorProvision {
  return {
    schemaVersion: 1,
    provisionId: 'graph_provision_00000000000000000000000000000000',
    provisionFingerprint: `sha256:${'0'.repeat(64)}`,
    graphId,
    workId: 'graph_work_00000000000000000000000000000000',
    agentId: 'local-read',
    operatorId,
    initialTurnId: 'turn-0',
    initialRunId: 'run-0',
    edges: [],
    targetSessionId: childSessionId,
    provisionedAt: 0,
  };
}

function scheduleUpdate(graphId: string, instruction: string): AgentGraphScheduleUpdate {
  return {
    schemaVersion: 1,
    updateId: 'graph_update_00000000000000000000000000000000',
    updateFingerprint: `sha256:${'1'.repeat(64)}`,
    graphId,
    source: {
      sessionId: 'root-session',
      runId: 'root-run',
      turnId: 'root-turn',
      toolCallId: 'root-tool-call',
    },
    addWork: [
      {
        workId: 'graph_work_00000000000000000000000000000000',
        target: { kind: 'agent', agentId: 'local-read' },
        instruction,
        inputIds: [],
      },
    ],
    stop: [],
    revision: 1,
    committedAt: 1,
  };
}

function finishUpdate(graphId: string, resultId: string): AgentGraphScheduleUpdate {
  return {
    schemaVersion: 1,
    updateId: `graph_update_${'5'.repeat(32)}`,
    updateFingerprint: `sha256:${'6'.repeat(64)}`,
    graphId,
    source: {
      sessionId: 'root-session',
      runId: 'root-run',
      turnId: 'root-turn',
      toolCallId: 'finish-tool-call',
    },
    addWork: [],
    stop: [],
    finish: {
      resultIds: [resultId],
      reason: 'Enough evidence is available.',
    },
    revision: 1,
    committedAt: 1,
  };
}

function terminalRecord(input: {
  graphId: string;
  operatorId: string;
  childSessionId: string;
  index: number;
}): AgentGraphRecord {
  return {
    schemaVersion: 1,
    recordId: `record-${input.index}`,
    graphId: input.graphId,
    operatorId: input.operatorId,
    activationId: `run-${input.index}`,
    sessionId: input.childSessionId,
    agentRunId: `run-${input.index}`,
    eventTime: input.index,
    orderKey: {
      runCreatedAt: input.index,
      operatorId: input.operatorId,
      runId: `run-${input.index}`,
      committedEventOrdinal: 0,
      runtimeEventId: `event-${input.index}`,
    },
    type: 'agent_runtime_event',
    facets: ['completed'],
    supervisorSignals: [{ kind: 'terminal', status: 'completed' }],
    source: {
      kind: 'runtime_event',
      runtimeEventId: `event-${input.index}`,
      sessionId: input.childSessionId,
      runId: `run-${input.index}`,
      turnId: `turn-${input.index}`,
      ts: input.index,
    },
  };
}

function activation(record: AgentGraphRecord, index: number): AgentGraphActivationState {
  return {
    activationId: record.activationId,
    agentRunId: record.agentRunId,
    status: 'completed',
    recordCount: 1,
    firstEventTime: index,
    lastEventTime: index,
    lastRecordId: record.recordId,
    terminalRecordId: record.recordId,
  };
}

function runningInput(graphId: string, operatorId: string, childSessionId: string) {
  const input = emptyInput(graphId);
  input.provisions = [provision(graphId, operatorId, childSessionId)];
  input.observation.projection.operators = [{ operatorId, sessionId: childSessionId }];
  return input;
}

function supervisorRuntimeEvent(input: {
  graphId: string;
  operatorId: string;
  childSessionId: string;
  eventId: string;
  eventTime: number;
  eventType: 'text_complete' | 'complete';
}): AgentGraphSupervisorRuntimeEvent {
  return {
    intent: {
      graphId: input.graphId,
    },
    claim: {
      targetOperatorId: input.operatorId,
      targetSessionId: input.childSessionId,
      targetRunId: 'run-0',
      targetTurnId: 'turn-0',
    },
    event: {
      id: input.eventId,
      type: input.eventType,
      ts: input.eventTime,
      sessionId: input.childSessionId,
      runId: 'run-0',
      turnId: 'turn-0',
      ...(input.eventType === 'complete' ? { stopReason: 'end_turn' } : { text: 'message' }),
    },
  } as unknown as AgentGraphSupervisorRuntimeEvent;
}

function graphRecordFromActivity(
  graphId: string,
  activity: AgentGraphClientActivity,
  index: number,
): AgentGraphRecord {
  return {
    schemaVersion: 1,
    recordId: activity.recordId,
    graphId,
    operatorId: activity.operatorId,
    activationId: activity.activationId,
    sessionId: activity.run.sessionId,
    agentRunId: activity.run.agentRunId,
    eventTime: activity.eventTime,
    orderKey: {
      runCreatedAt: 0,
      operatorId: activity.operatorId,
      runId: activity.run.agentRunId,
      committedEventOrdinal: index,
      runtimeEventId: `runtime-${index}`,
    },
    type: 'agent_runtime_event',
    facets: [...activity.facets],
    supervisorSignals: activity.signals.map((signal) => ({ ...signal })),
    source: {
      kind: 'runtime_event',
      runtimeEventId: `runtime-${index}`,
      sessionId: activity.run.sessionId,
      runId: activity.run.agentRunId,
      turnId: activity.run.turnId ?? 'turn-0',
      ts: activity.eventTime,
    },
  };
}
