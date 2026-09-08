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

import type { SessionHeader } from '@maka/core/session';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { agentGraphIdForRootSession } from '@maka/runtime/stream-graph-coordinator';
import type {
  AgentGraphClientActivity,
  AgentGraphClientClaimRef,
  AgentGraphClientOperator,
  AgentGraphClientScheduledWork,
  AgentGraphClientSnapshot,
  AgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import { turnSession } from './scenarios-chat.js';
import { TURN_SESSION_ID } from './seed-helpers.js';

const OPERATOR_IDS = [
  'collector',
  'planner',
  'researcher',
  'reviewer',
  'writer',
  'publisher',
] as const;
const EDGE_PAIRS = [
  ['collector', 'planner'],
  ['collector', 'researcher'],
  ['collector', 'reviewer'],
  ['researcher', 'writer'],
  ['writer', 'publisher'],
] as const;
const SNAPSHOT_VERSION = `sha256:${'a'.repeat(64)}`;
const TOPOLOGY_FINGERPRINT = `sha256:${'b'.repeat(64)}`;

export function agentGraphTopologySession(now: number): SessionHeader {
  return {
    ...turnSession(now),
    name: 'Agent Graph topology fixture',
    orchestrationMode: 'graph',
  };
}

export async function seedAgentGraphTopology(workspaceRoot: string, now: number): Promise<void> {
  const graphId = agentGraphIdForRootSession(TURN_SESSION_ID);
  const operators = OPERATOR_IDS.map((operatorId, index) =>
    fixtureOperator(operatorId, index, now),
  );
  const visibleWork = fixtureWork('work-publisher-visible', 'publisher', 'Publish the final report', now);
  const omittedWork = fixtureWork(
    'work-publisher-snapshot-omitted',
    'publisher',
    'Notify downstream consumers',
    now - 1,
  );
  const edges = EDGE_PAIRS.map(([fromOperatorId, toOperatorId]) => ({
    edgeId: `edge-${fromOperatorId}-${toOperatorId}`,
    fromOperatorId,
    toOperatorId,
  }));
  const permissionActivity: AgentGraphClientActivity = {
    recordId: 'record-publisher-permission',
    operatorId: 'publisher',
    activationId: 'activation-publisher',
    eventTime: now - 3_000,
    facets: ['permission_request'],
    signals: [{ kind: 'attention', reason: 'permission_request' }],
    run: { sessionId: 'child-publisher', agentRunId: 'run-publisher', turnId: 'turn-publisher' },
  };
  const terminalActivity: AgentGraphClientActivity = {
    ...permissionActivity,
    recordId: 'record-publisher-terminal',
    eventTime: now - 1_000,
    facets: ['completed'],
    signals: [{ kind: 'terminal', status: 'completed' }],
  };
  const claim: AgentGraphClientClaimRef = {
    claimId: 'claim-publisher',
    intentId: 'intent-publisher',
    operatorId: 'publisher',
    childSessionId: 'child-publisher',
    run: terminalActivity.run,
    admissionState: 'executing',
    claimedAt: now - 4_000,
  };
  const snapshot: AgentGraphClientSnapshot = {
    schemaVersion: 1,
    rootSessionId: TURN_SESSION_ID,
    graphId,
    orchestrationMode: 'graph',
    snapshotVersion: SNAPSHOT_VERSION,
    status: 'active',
    scheduleRevision: 1,
    topologyFingerprint: TOPOLOGY_FINGERPRINT,
    closed: false,
    latestEventTime: terminalActivity.eventTime,
    operators,
    edges,
    work: [visibleWork],
    reconciliationFailures: [],
    stoppedTargets: [],
    claims: [claim],
    recentControlDecisions: [],
    recentActivity: [permissionActivity, terminalActivity],
    terminalHistory: { records: [terminalActivity] },
    omitted: {
      operators: 0,
      edges: 0,
      work: 1,
      reconciliationFailures: 0,
      stoppedTargets: 0,
      claims: 0,
      controlDecisions: 0,
      recentActivity: 0,
    },
  };
  const inspections = operators.map((operator) =>
    fixtureInspection(snapshot, operator, [visibleWork, omittedWork]),
  );
  const store = createAgentGraphControlStore(workspaceRoot);
  try {
    await store.commitAgentGraphClientProjection({
      schemaVersion: 1,
      graphId,
      rootSessionId: TURN_SESSION_ID,
      expectedSnapshotVersion: null,
      snapshotVersion: SNAPSHOT_VERSION,
      snapshot,
      replaceOperators: true,
      operators: inspections.map((inspection) => ({
        operatorId: inspection.operator.operatorId,
        payload: inspection,
      })),
      terminalActivities: [
        {
          recordId: terminalActivity.recordId,
          eventTime: terminalActivity.eventTime,
          payload: terminalActivity,
        },
      ],
      activityRecords: [permissionActivity, terminalActivity].map((activity) => ({
        recordId: activity.recordId,
        eventTime: activity.eventTime,
      })),
    });
  } finally {
    store.close();
  }
}

function fixtureOperator(
  operatorId: (typeof OPERATOR_IDS)[number],
  index: number,
  now: number,
): AgentGraphClientOperator {
  const publisher = operatorId === 'publisher';
  return {
    operatorId,
    childSessionId: `child-${operatorId}`,
    provisionId: `provision-${operatorId}`,
    agentId: operatorId,
    provisionedAt: now - (OPERATOR_IDS.length - index + 4) * 1_000,
    status: publisher ? 'completed' : operatorId === 'writer' ? 'waiting' : 'running',
    inboundEdgeIds: EDGE_PAIRS.filter(([, target]) => target === operatorId).map(
      ([source, target]) => `edge-${source}-${target}`,
    ),
    outboundEdgeIds: EDGE_PAIRS.filter(([source]) => source === operatorId).map(
      ([source, target]) => `edge-${source}-${target}`,
    ),
    scheduledWorkIds: publisher
      ? ['work-publisher-visible', 'work-publisher-snapshot-omitted']
      : [],
    readiness:
      operatorId === 'writer'
        ? [
            {
              readinessId: 'readiness-writer',
              status: 'waiting',
              waitingFor: [{ kind: 'input_route', upstreamOperatorIds: ['researcher'] }],
              omittedWaitingFor: 0,
            },
          ]
        : [],
    omitted: {
      inboundEdgeIds: 0,
      outboundEdgeIds: 0,
      scheduledWorkIds: 0,
      readiness: 0,
      readinessWaits: 0,
    },
    ...(publisher
      ? {
          currentActivation: {
            activationId: 'activation-publisher',
            status: 'completed' as const,
            recordCount: 2,
            firstEventTime: now - 3_000,
            lastEventTime: now - 1_000,
            terminalRecordId: 'record-publisher-terminal',
            run: {
              sessionId: 'child-publisher',
              agentRunId: 'run-publisher',
              turnId: 'turn-publisher',
            },
          },
        }
      : {}),
  };
}

function fixtureWork(
  workId: string,
  operatorId: string,
  instructionPreview: string,
  committedAt: number,
): AgentGraphClientScheduledWork {
  return {
    workId,
    target: { kind: 'operator', operatorId },
    inputIds: [],
    status: 'requested',
    instructionPreview,
    instructionTruncated: false,
    revision: 1,
    committedAt,
  };
}

function fixtureInspection(
  snapshot: AgentGraphClientSnapshot,
  operator: AgentGraphClientOperator,
  publisherWork: readonly AgentGraphClientScheduledWork[],
): AgentGraphOperatorInspection {
  const publisher = operator.operatorId === 'publisher';
  return {
    schemaVersion: 1,
    rootSessionId: snapshot.rootSessionId,
    graphId: snapshot.graphId,
    snapshotVersion: snapshot.snapshotVersion,
    operator,
    inboundEdges: snapshot.edges.filter((edge) => edge.toOperatorId === operator.operatorId),
    outboundEdges: snapshot.edges.filter((edge) => edge.fromOperatorId === operator.operatorId),
    work: publisher ? [...publisherWork] : [],
    claims: publisher ? snapshot.claims : [],
    activations:
      publisher && operator.currentActivation
        ? [
            {
              ...operator.currentActivation,
              lastRecordId: 'record-publisher-terminal',
            },
          ]
        : [],
    recentRecords: publisher ? snapshot.recentActivity : [],
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
