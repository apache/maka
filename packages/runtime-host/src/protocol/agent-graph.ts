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

import {
  requireCount,
  requireEncodedByteLimit,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const AGENT_GRAPH_CLIENT_SCHEMA_VERSION = 1 as const;
export const AGENT_GRAPH_RESULT_MAX_BYTES = 48 * 1024;
export const AGENT_GRAPH_TERMINAL_CURSOR_MAX_BYTES = 2 * 1024;
export const AGENT_GRAPH_MAX_OPERATORS = 32;
export const AGENT_GRAPH_MAX_EDGES = 64;
export const AGENT_GRAPH_MAX_WORK = 32;
export const AGENT_GRAPH_MAX_RECONCILIATION_FAILURES = 32;
export const AGENT_GRAPH_MAX_STOPPED_TARGETS = 16;
export const AGENT_GRAPH_MAX_CLAIMS = 32;
export const AGENT_GRAPH_MAX_CONTROL_DECISIONS = 16;
export const AGENT_GRAPH_MAX_ACTIVITY = 32;
export const AGENT_GRAPH_MAX_TERMINAL_ACTIVITY = 32;
export const AGENT_GRAPH_MAX_OPERATOR_REFS = 16;
export const AGENT_GRAPH_MAX_OPERATOR_READINESS = 2;
export const AGENT_GRAPH_MAX_READINESS_WAITS = 4;
export const AGENT_GRAPH_MAX_INPUT_ROUTE_OPERATORS = 4;
export const AGENT_GRAPH_MAX_WORK_INPUTS = 64;
export const AGENT_GRAPH_MAX_CONTROL_REFS = 64;
export const AGENT_GRAPH_MAX_INSPECTION_EDGES = 64;
export const AGENT_GRAPH_MAX_INSPECTION_WORK = 32;
export const AGENT_GRAPH_MAX_INSPECTION_CLAIMS = 32;
export const AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS = 32;
export const AGENT_GRAPH_MAX_INSPECTION_RECORDS = 32;
export const AGENT_GRAPH_EPOCH_PAGE_SIZE = 32;

const AGENT_GRAPH_INSTRUCTION_PREVIEW_MAX_BYTES = 2 * 1024;
const AGENT_GRAPH_REASON_MAX_BYTES = 12 * 1024;
const AGENT_GRAPH_RECONCILIATION_FAILURE_REASON_MAX_BYTES = 4 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'operation_conflict',
  'invalid_request',
  'persistence_failed',
  'internal_failure',
] as const;

const STOP_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'session_archived',
  'operation_conflict',
  'internal_failure',
] as const;

export type AgentGraphActivationStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled';

export type AgentGraphClientOperatorStatus =
  | 'not_started'
  | 'waiting'
  | 'runnable'
  | 'blocked'
  | AgentGraphActivationStatus;

export type AgentGraphClientStatus =
  | 'empty'
  | 'active'
  | 'closing'
  | 'waiting'
  | 'stopped'
  | 'failed'
  | 'completed';

export type AgentGraphRecordFacet =
  | 'message'
  | 'thinking'
  | 'error'
  | 'tool_call'
  | 'tool_dispatch'
  | 'tool_result'
  | 'artifact_update'
  | 'permission_request'
  | 'permission_decision'
  | 'user_question_request'
  | 'transfer'
  | 'usage'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'runtime_fact';

export type AgentGraphSupervisorSignal =
  | { readonly kind: 'attention'; readonly reason: 'permission_request' | 'user_question_request' }
  | {
      readonly kind: 'terminal';
      readonly status: 'completed' | 'failed' | 'aborted' | 'cancelled';
    };

export type AgentGraphReadinessWait =
  | { readonly kind: 'input_route'; readonly upstreamOperatorIds: readonly string[] }
  | {
      readonly kind: 'activation_missing' | 'activation_running';
      readonly operatorId: string;
      readonly activationId: string;
    };

export interface AgentGraphClientRunRef {
  readonly sessionId: string;
  readonly agentRunId: string;
  readonly turnId?: string;
}

export interface AgentGraphClientOperator {
  readonly operatorId: string;
  readonly childSessionId: string;
  readonly provisionId: string;
  readonly agentId: string;
  readonly provisionedAt: number;
  readonly status: AgentGraphClientOperatorStatus;
  readonly inboundEdgeIds: readonly string[];
  readonly outboundEdgeIds: readonly string[];
  readonly scheduledWorkIds: readonly string[];
  readonly readiness: readonly {
    readonly readinessId: string;
    readonly status: 'waiting' | 'runnable';
    readonly waitingFor: readonly AgentGraphReadinessWait[];
    readonly omittedWaitingFor: number;
  }[];
  readonly omitted: {
    readonly inboundEdgeIds: number;
    readonly outboundEdgeIds: number;
    readonly scheduledWorkIds: number;
    readonly readiness: number;
    readonly readinessWaits: number;
  };
  readonly currentActivation?: {
    readonly activationId: string;
    readonly status: AgentGraphActivationStatus;
    readonly recordCount: number;
    readonly firstEventTime: number;
    readonly lastEventTime: number;
    readonly terminalRecordId?: string;
    readonly run: AgentGraphClientRunRef;
  };
}

export interface AgentGraphClientEdge {
  readonly edgeId: string;
  readonly fromOperatorId: string;
  readonly toOperatorId: string;
}

export interface AgentGraphClientScheduledWork {
  readonly workId: string;
  readonly target:
    | { readonly kind: 'agent'; readonly agentId: string }
    | { readonly kind: 'preset'; readonly presetId: string }
    | { readonly kind: 'operator'; readonly operatorId: string };
  readonly inputIds: readonly string[];
  readonly selectedResultInputs?: readonly {
    readonly sourceGraphId: string;
    readonly resultId: string;
  }[];
  readonly replaces?: string;
  readonly status: 'requested' | 'stopped' | 'superseded';
  readonly instructionPreview: string;
  readonly instructionTruncated: boolean;
  readonly revision: number;
  readonly committedAt: number;
}

export interface AgentGraphClientReconciliationFailure {
  readonly workId: string;
  readonly phase: 'schedule' | 'topology' | 'stop' | 'render' | 'dispatch';
  readonly reason: string;
}

export interface AgentGraphClientStoppedTarget {
  readonly targetId: string;
  readonly reason: string;
  readonly revision: number;
  readonly committedAt: number;
}

export interface AgentGraphClientFinish {
  readonly resultIds: readonly string[];
  readonly reason: string;
  readonly revision: number;
  readonly committedAt: number;
}

export interface AgentGraphClientControlDecision {
  readonly updateId: string;
  readonly revision: number;
  readonly committedAt: number;
  readonly source: {
    readonly sessionId: string;
    readonly agentRunId: string;
    readonly turnId: string;
    readonly toolCallId: string;
  };
  readonly addedWorkIds: readonly string[];
  readonly stoppedTargetIds: readonly string[];
  readonly selectedResultIds: readonly string[];
}

export interface AgentGraphClientClaimRef {
  readonly claimId: string;
  readonly intentId: string;
  readonly operatorId: string;
  readonly childSessionId: string;
  readonly run: AgentGraphClientRunRef;
  readonly admissionState: 'claimed' | 'executing' | 'cancelled';
  readonly claimedAt: number;
}

export interface AgentGraphClientActivity {
  readonly recordId: string;
  readonly operatorId: string;
  readonly activationId: string;
  readonly eventTime: number;
  readonly facets: readonly AgentGraphRecordFacet[];
  readonly signals: readonly AgentGraphSupervisorSignal[];
  readonly run: AgentGraphClientRunRef;
}

export interface AgentGraphClientSnapshot {
  readonly schemaVersion: typeof AGENT_GRAPH_CLIENT_SCHEMA_VERSION;
  readonly rootSessionId: string;
  readonly graphId: string;
  readonly orchestrationMode: 'graph' | 'swarm';
  readonly snapshotVersion: `sha256:${string}`;
  readonly status: AgentGraphClientStatus;
  readonly scheduleRevision: number;
  readonly topologyFingerprint: `sha256:${string}`;
  readonly closed: boolean;
  readonly latestEventTime?: number;
  readonly operators: readonly AgentGraphClientOperator[];
  readonly edges: readonly AgentGraphClientEdge[];
  readonly work: readonly AgentGraphClientScheduledWork[];
  readonly reconciliationFailures: readonly AgentGraphClientReconciliationFailure[];
  readonly stoppedTargets: readonly AgentGraphClientStoppedTarget[];
  readonly finish?: AgentGraphClientFinish;
  readonly claims: readonly AgentGraphClientClaimRef[];
  readonly recentControlDecisions: readonly AgentGraphClientControlDecision[];
  readonly recentActivity: readonly AgentGraphClientActivity[];
  readonly terminalHistory: {
    readonly records: readonly AgentGraphClientActivity[];
    readonly nextCursor?: string;
  };
  readonly omitted: {
    readonly operators: number;
    readonly edges: number;
    readonly work: number;
    readonly reconciliationFailures: number;
    readonly stoppedTargets: number;
    readonly claims: number;
    readonly controlDecisions: number;
    readonly recentActivity: number;
  };
}

export interface AgentGraphOperatorInspection {
  readonly schemaVersion: typeof AGENT_GRAPH_CLIENT_SCHEMA_VERSION;
  readonly rootSessionId: string;
  readonly graphId: string;
  readonly snapshotVersion: `sha256:${string}`;
  readonly operator: AgentGraphClientOperator;
  readonly inboundEdges: readonly AgentGraphClientEdge[];
  readonly outboundEdges: readonly AgentGraphClientEdge[];
  readonly work: readonly AgentGraphClientScheduledWork[];
  readonly claims: readonly AgentGraphClientClaimRef[];
  readonly activations: readonly {
    readonly activationId: string;
    readonly status: AgentGraphActivationStatus;
    readonly recordCount: number;
    readonly firstEventTime: number;
    readonly lastEventTime: number;
    readonly lastRecordId: string;
    readonly terminalRecordId?: string;
    readonly run: AgentGraphClientRunRef;
  }[];
  readonly recentRecords: readonly AgentGraphClientActivity[];
  readonly omitted: {
    readonly inboundEdges: number;
    readonly outboundEdges: number;
    readonly work: number;
    readonly claims: number;
    readonly activations: number;
    readonly records: number;
  };
}

export interface AgentGraphQueryInput {
  readonly rootSessionId: string;
  readonly graphId?: string;
  readonly terminalCursor?: string;
}

export interface AgentGraphEpochListInput {
  readonly rootSessionId: string;
  readonly beforeEpoch?: number;
}

export interface AgentGraphEpochSummary {
  readonly epoch: number;
  readonly graphId: string;
  readonly createdAt: number;
  readonly current: boolean;
}

export interface AgentGraphEpochListResult {
  readonly rootSessionId: string;
  readonly epochs: readonly AgentGraphEpochSummary[];
  readonly nextBeforeEpoch: number | null;
}

export interface AgentGraphOperatorQueryInput {
  readonly rootSessionId: string;
  readonly graphId?: string;
  readonly operatorId: string;
}

export interface AgentGraphStopInput {
  readonly rootSessionId: string;
  readonly expectedGraphId?: string;
}

export interface AgentGraphStopResult {
  readonly rootSessionId: string;
  readonly graphId: string;
}

export const AGENT_GRAPH_OPERATION_SPECS = {
  'agent.graph.epochs.query': defineOperation<
    AgentGraphEpochListInput,
    AgentGraphEpochListResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeAgentGraphEpochListInput,
    decodeOutput: decodeAgentGraphEpochListResult,
    assertOutputForInput: (input, output) => {
      assertRootIdentity(input.rootSessionId, output);
      if (input.beforeEpoch === undefined) {
        if (output.epochs.filter((entry) => entry.current).length !== 1) {
          throw invalidProtocolFrame(
            'Agent graph first epoch page must identify the current epoch',
          );
        }
      } else {
        if (output.epochs.some((entry) => entry.current)) {
          throw invalidProtocolFrame('Agent graph historical epoch pages cannot be current');
        }
        if (output.epochs.some((entry) => entry.epoch >= input.beforeEpoch!)) {
          throw invalidProtocolFrame('Agent graph epoch page did not advance its cursor');
        }
      }
    },
  }),
  'agent.graph.query': defineOperation<
    AgentGraphQueryInput,
    AgentGraphClientSnapshot,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeAgentGraphQueryInput,
    decodeOutput: decodeAgentGraphClientSnapshot,
    assertOutputForInput: (input, output) => {
      assertRootIdentity(input.rootSessionId, output);
      if (input.graphId !== undefined && input.graphId !== output.graphId) {
        throw invalidProtocolFrame('Agent graph result changed request graph identity');
      }
    },
  }),
  'agent.graph.operator.query': defineOperation<
    AgentGraphOperatorQueryInput,
    AgentGraphOperatorInspection,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeAgentGraphOperatorQueryInput,
    decodeOutput: decodeAgentGraphOperatorInspection,
    assertOutputForInput: (input, output) => {
      assertRootIdentity(input.rootSessionId, output);
      if (input.graphId !== undefined && input.graphId !== output.graphId) {
        throw invalidProtocolFrame('Agent graph operator result changed request graph identity');
      }
      if (output.operator.operatorId !== input.operatorId) {
        throw invalidProtocolFrame('Agent graph operator result changed request identity');
      }
    },
  }),
  'agent.graph.stop': defineOperation<
    AgentGraphStopInput,
    AgentGraphStopResult,
    (typeof STOP_ERRORS)[number]
  >({
    mode: 'control',
    availability: 'ready',
    errors: STOP_ERRORS,
    decodeInput: decodeAgentGraphStopInput,
    decodeOutput: decodeAgentGraphStopResult,
    assertOutputForInput: (input, output) => {
      assertRootIdentity(input.rootSessionId, output);
      if (input.expectedGraphId !== undefined && output.graphId !== input.expectedGraphId) {
        throw invalidProtocolFrame('Agent graph stop changed request graph identity');
      }
    },
  }),
} as const;

export function decodeAgentGraphQueryInput(value: unknown): AgentGraphQueryInput {
  const record = requireShapedRecord(
    value,
    'agent.graph.query input',
    ['rootSessionId'],
    ['graphId', 'terminalCursor'],
  );
  return {
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    ...(record.graphId === undefined
      ? {}
      : { graphId: requireOpaqueIdentity(record.graphId, 'graphId') }),
    ...(record.terminalCursor === undefined
      ? {}
      : { terminalCursor: requireCursor(record.terminalCursor) }),
  };
}

export function decodeAgentGraphOperatorQueryInput(value: unknown): AgentGraphOperatorQueryInput {
  const record = requireShapedRecord(
    value,
    'agent.graph.operator.query input',
    ['rootSessionId', 'operatorId'],
    ['graphId'],
  );
  return {
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    ...(record.graphId === undefined
      ? {}
      : { graphId: requireOpaqueIdentity(record.graphId, 'graphId') }),
    operatorId: requireOpaqueIdentity(record.operatorId, 'operatorId'),
  };
}

export function decodeAgentGraphEpochListInput(value: unknown): AgentGraphEpochListInput {
  const record = requireShapedRecord(
    value,
    'agent.graph.epochs.query input',
    ['rootSessionId'],
    ['beforeEpoch'],
  );
  const beforeEpoch =
    record.beforeEpoch === undefined ? undefined : requireCount(record.beforeEpoch, 'beforeEpoch');
  if (beforeEpoch === 0) throw invalidProtocolFrame('Invalid beforeEpoch');
  return {
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    ...(beforeEpoch === undefined ? {} : { beforeEpoch }),
  };
}

export function decodeAgentGraphEpochListResult(value: unknown): AgentGraphEpochListResult {
  requireEncodedByteLimit(value, 'agent.graph.epochs.query result', AGENT_GRAPH_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'agent graph epoch list', [
    'rootSessionId',
    'epochs',
    'nextBeforeEpoch',
  ]);
  const result = {
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    epochs: decodeArray(
      record.epochs,
      'agent graph epochs',
      AGENT_GRAPH_EPOCH_PAGE_SIZE,
      (entry) => {
        const epoch = requireExactRecord(entry, 'agent graph epoch', [
          'epoch',
          'graphId',
          'createdAt',
          'current',
        ]);
        const epochNumber = requireCount(epoch.epoch, 'epoch');
        if (epochNumber === 0) throw invalidProtocolFrame('Invalid epoch');
        return {
          epoch: epochNumber,
          graphId: requireOpaqueIdentity(epoch.graphId, 'graphId'),
          createdAt: requireCount(epoch.createdAt, 'createdAt'),
          current: requireBoolean(epoch.current, 'current'),
        };
      },
    ),
    nextBeforeEpoch: decodeOptionalEpochCursor(record.nextBeforeEpoch),
  };
  assertUnique(result.epochs, (entry) => String(entry.epoch), 'agent graph epoch');
  assertUnique(result.epochs, (entry) => entry.graphId, 'agent graph identity');
  if (result.epochs.filter((entry) => entry.current).length > 1) {
    throw invalidProtocolFrame('Agent graph epoch list identifies multiple current epochs');
  }
  for (let index = 1; index < result.epochs.length; index += 1) {
    if (result.epochs[index - 1]!.epoch - 1 !== result.epochs[index]!.epoch) {
      throw invalidProtocolFrame('Agent graph epoch page must be contiguous and newest-first');
    }
  }
  if (result.epochs.some((entry) => entry.current) && !result.epochs[0]?.current) {
    throw invalidProtocolFrame('Agent graph current epoch must be first');
  }
  if (result.nextBeforeEpoch !== null && result.nextBeforeEpoch !== result.epochs.at(-1)?.epoch) {
    throw invalidProtocolFrame('Agent graph epoch cursor must continue after the oldest result');
  }
  return result;
}

function decodeOptionalEpochCursor(value: unknown): number | null {
  if (value === null) return null;
  const cursor = requireCount(value, 'nextBeforeEpoch');
  if (cursor === 0) throw invalidProtocolFrame('Invalid nextBeforeEpoch');
  return cursor;
}

export function decodeAgentGraphStopInput(value: unknown): AgentGraphStopInput {
  const record = requireShapedRecord(
    value,
    'agent.graph.stop input',
    ['rootSessionId'],
    ['expectedGraphId'],
  );
  return {
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    ...(record.expectedGraphId === undefined
      ? {}
      : { expectedGraphId: requireOpaqueIdentity(record.expectedGraphId, 'expectedGraphId') }),
  };
}

export function decodeAgentGraphStopResult(value: unknown): AgentGraphStopResult {
  const record = requireExactRecord(value, 'agent.graph.stop result', ['rootSessionId', 'graphId']);
  return {
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    graphId: requireOpaqueIdentity(record.graphId, 'graphId'),
  };
}

export function decodeAgentGraphClientSnapshot(value: unknown): AgentGraphClientSnapshot {
  requireEncodedByteLimit(value, 'agent.graph.query result', AGENT_GRAPH_RESULT_MAX_BYTES);
  const record = requireShapedRecord(
    value,
    'agent graph snapshot',
    [
      'schemaVersion',
      'rootSessionId',
      'graphId',
      'orchestrationMode',
      'snapshotVersion',
      'status',
      'scheduleRevision',
      'topologyFingerprint',
      'closed',
      'operators',
      'edges',
      'work',
      'reconciliationFailures',
      'stoppedTargets',
      'claims',
      'recentControlDecisions',
      'recentActivity',
      'terminalHistory',
      'omitted',
    ],
    ['latestEventTime', 'finish'],
  );
  requireSchemaVersion(record.schemaVersion);
  const snapshot: AgentGraphClientSnapshot = {
    schemaVersion: AGENT_GRAPH_CLIENT_SCHEMA_VERSION,
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    graphId: requireOpaqueIdentity(record.graphId, 'graphId'),
    orchestrationMode: requireGraphOrchestrationMode(record.orchestrationMode),
    snapshotVersion: requireFingerprint(record.snapshotVersion, 'snapshotVersion'),
    status: requireGraphStatus(record.status),
    scheduleRevision: requireCount(record.scheduleRevision, 'scheduleRevision'),
    topologyFingerprint: requireFingerprint(record.topologyFingerprint, 'topologyFingerprint'),
    closed: requireBoolean(record.closed, 'closed'),
    ...(record.latestEventTime === undefined
      ? {}
      : { latestEventTime: requireCount(record.latestEventTime, 'latestEventTime') }),
    operators: decodeArray(
      record.operators,
      'agent graph operators',
      AGENT_GRAPH_MAX_OPERATORS,
      decodeOperator,
    ),
    edges: decodeArray(record.edges, 'agent graph edges', AGENT_GRAPH_MAX_EDGES, decodeEdge),
    work: decodeArray(record.work, 'agent graph work', AGENT_GRAPH_MAX_WORK, decodeWork),
    reconciliationFailures: decodeArray(
      record.reconciliationFailures,
      'agent graph reconciliation failures',
      AGENT_GRAPH_MAX_RECONCILIATION_FAILURES,
      decodeReconciliationFailure,
    ),
    stoppedTargets: decodeArray(
      record.stoppedTargets,
      'agent graph stopped targets',
      AGENT_GRAPH_MAX_STOPPED_TARGETS,
      decodeStoppedTarget,
    ),
    ...(record.finish === undefined ? {} : { finish: decodeFinish(record.finish) }),
    claims: decodeArray(record.claims, 'agent graph claims', AGENT_GRAPH_MAX_CLAIMS, decodeClaim),
    recentControlDecisions: decodeArray(
      record.recentControlDecisions,
      'agent graph control decisions',
      AGENT_GRAPH_MAX_CONTROL_DECISIONS,
      decodeControlDecision,
    ),
    recentActivity: decodeArray(
      record.recentActivity,
      'agent graph recent activity',
      AGENT_GRAPH_MAX_ACTIVITY,
      decodeActivity,
    ),
    terminalHistory: decodeTerminalHistory(record.terminalHistory),
    omitted: decodeSnapshotOmitted(record.omitted),
  };
  assertUnique(snapshot.operators, (item) => item.operatorId, 'agent graph operator');
  assertUnique(snapshot.edges, (item) => item.edgeId, 'agent graph edge');
  assertUnique(snapshot.work, (item) => item.workId, 'agent graph work');
  assertUnique(
    snapshot.reconciliationFailures,
    (item) => item.workId,
    'agent graph reconciliation failure',
  );
  assertUnique(snapshot.claims, (item) => item.claimId, 'agent graph claim');
  return snapshot;
}

export function decodeAgentGraphOperatorInspection(value: unknown): AgentGraphOperatorInspection {
  requireEncodedByteLimit(value, 'agent.graph.operator.query result', AGENT_GRAPH_RESULT_MAX_BYTES);
  const record = requireExactRecord(value, 'agent graph operator inspection', [
    'schemaVersion',
    'rootSessionId',
    'graphId',
    'snapshotVersion',
    'operator',
    'inboundEdges',
    'outboundEdges',
    'work',
    'claims',
    'activations',
    'recentRecords',
    'omitted',
  ]);
  requireSchemaVersion(record.schemaVersion);
  const inspection: AgentGraphOperatorInspection = {
    schemaVersion: AGENT_GRAPH_CLIENT_SCHEMA_VERSION,
    rootSessionId: requireEntityId(record.rootSessionId, 'rootSessionId'),
    graphId: requireOpaqueIdentity(record.graphId, 'graphId'),
    snapshotVersion: requireFingerprint(record.snapshotVersion, 'snapshotVersion'),
    operator: decodeOperator(record.operator),
    inboundEdges: decodeArray(
      record.inboundEdges,
      'agent graph inbound edges',
      AGENT_GRAPH_MAX_INSPECTION_EDGES,
      decodeEdge,
    ),
    outboundEdges: decodeArray(
      record.outboundEdges,
      'agent graph outbound edges',
      AGENT_GRAPH_MAX_INSPECTION_EDGES,
      decodeEdge,
    ),
    work: decodeArray(
      record.work,
      'agent graph inspection work',
      AGENT_GRAPH_MAX_INSPECTION_WORK,
      decodeWork,
    ),
    claims: decodeArray(
      record.claims,
      'agent graph inspection claims',
      AGENT_GRAPH_MAX_INSPECTION_CLAIMS,
      decodeClaim,
    ),
    activations: decodeArray(
      record.activations,
      'agent graph activations',
      AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS,
      decodeActivation,
    ),
    recentRecords: decodeArray(
      record.recentRecords,
      'agent graph inspection records',
      AGENT_GRAPH_MAX_INSPECTION_RECORDS,
      decodeActivity,
    ),
    omitted: decodeInspectionOmitted(record.omitted),
  };
  assertUnique(inspection.inboundEdges, (item) => item.edgeId, 'agent graph inbound edge');
  assertUnique(inspection.outboundEdges, (item) => item.edgeId, 'agent graph outbound edge');
  assertUnique(inspection.work, (item) => item.workId, 'agent graph inspection work');
  assertUnique(inspection.claims, (item) => item.claimId, 'agent graph inspection claim');
  assertUnique(inspection.activations, (item) => item.activationId, 'agent graph activation');
  return inspection;
}

function decodeOperator(value: unknown): AgentGraphClientOperator {
  const record = requireShapedRecord(
    value,
    'agent graph operator',
    [
      'operatorId',
      'childSessionId',
      'provisionId',
      'agentId',
      'provisionedAt',
      'status',
      'inboundEdgeIds',
      'outboundEdgeIds',
      'scheduledWorkIds',
      'readiness',
      'omitted',
    ],
    ['currentActivation'],
  );
  return {
    operatorId: requireOpaqueIdentity(record.operatorId, 'operatorId'),
    childSessionId: requireEntityId(record.childSessionId, 'childSessionId'),
    provisionId: requireOpaqueIdentity(record.provisionId, 'provisionId'),
    agentId: requireOpaqueIdentity(record.agentId, 'agentId'),
    provisionedAt: requireCount(record.provisionedAt, 'provisionedAt'),
    status: requireOperatorStatus(record.status),
    inboundEdgeIds: decodeIdentityArray(
      record.inboundEdgeIds,
      'inboundEdgeIds',
      AGENT_GRAPH_MAX_OPERATOR_REFS,
    ),
    outboundEdgeIds: decodeIdentityArray(
      record.outboundEdgeIds,
      'outboundEdgeIds',
      AGENT_GRAPH_MAX_OPERATOR_REFS,
    ),
    scheduledWorkIds: decodeIdentityArray(
      record.scheduledWorkIds,
      'scheduledWorkIds',
      AGENT_GRAPH_MAX_OPERATOR_REFS,
    ),
    readiness: decodeArray(
      record.readiness,
      'agent graph operator readiness',
      AGENT_GRAPH_MAX_OPERATOR_READINESS,
      decodeReadiness,
    ),
    omitted: decodeOperatorOmitted(record.omitted),
    ...(record.currentActivation === undefined
      ? {}
      : { currentActivation: decodeCurrentActivation(record.currentActivation) }),
  };
}

function decodeReadiness(value: unknown): AgentGraphClientOperator['readiness'][number] {
  const record = requireExactRecord(value, 'agent graph readiness', [
    'readinessId',
    'status',
    'waitingFor',
    'omittedWaitingFor',
  ]);
  if (record.status !== 'waiting' && record.status !== 'runnable') {
    throw invalidProtocolFrame('Invalid agent graph readiness status');
  }
  return {
    readinessId: requireOpaqueIdentity(record.readinessId, 'readinessId'),
    status: record.status,
    waitingFor: decodeArray(
      record.waitingFor,
      'agent graph readiness waits',
      AGENT_GRAPH_MAX_READINESS_WAITS,
      decodeReadinessWait,
    ),
    omittedWaitingFor: requireCount(record.omittedWaitingFor, 'omittedWaitingFor'),
  };
}

function decodeReadinessWait(value: unknown): AgentGraphReadinessWait {
  const record = requireShapedRecord(
    value,
    'agent graph readiness wait',
    ['kind'],
    ['upstreamOperatorIds', 'operatorId', 'activationId'],
  );
  if (record.kind === 'input_route') {
    requireExactRecord(record, 'agent graph input route wait', ['kind', 'upstreamOperatorIds']);
    return {
      kind: record.kind,
      upstreamOperatorIds: decodeIdentityArray(
        record.upstreamOperatorIds,
        'upstreamOperatorIds',
        AGENT_GRAPH_MAX_INPUT_ROUTE_OPERATORS,
      ),
    };
  }
  if (record.kind === 'activation_missing' || record.kind === 'activation_running') {
    requireExactRecord(record, 'agent graph activation wait', [
      'kind',
      'operatorId',
      'activationId',
    ]);
    return {
      kind: record.kind,
      operatorId: requireOpaqueIdentity(record.operatorId, 'operatorId'),
      activationId: requireOpaqueIdentity(record.activationId, 'activationId'),
    };
  }
  throw invalidProtocolFrame('Invalid agent graph readiness wait kind');
}

function decodeCurrentActivation(
  value: unknown,
): NonNullable<AgentGraphClientOperator['currentActivation']> {
  const record = requireShapedRecord(
    value,
    'agent graph current activation',
    ['activationId', 'status', 'recordCount', 'firstEventTime', 'lastEventTime', 'run'],
    ['terminalRecordId'],
  );
  return {
    activationId: requireOpaqueIdentity(record.activationId, 'activationId'),
    status: requireActivationStatus(record.status),
    recordCount: requireCount(record.recordCount, 'recordCount'),
    firstEventTime: requireCount(record.firstEventTime, 'firstEventTime'),
    lastEventTime: requireCount(record.lastEventTime, 'lastEventTime'),
    ...(record.terminalRecordId === undefined
      ? {}
      : {
          terminalRecordId: requireOpaqueIdentity(record.terminalRecordId, 'terminalRecordId'),
        }),
    run: decodeRunRef(record.run),
  };
}

function decodeEdge(value: unknown): AgentGraphClientEdge {
  const record = requireExactRecord(value, 'agent graph edge', [
    'edgeId',
    'fromOperatorId',
    'toOperatorId',
  ]);
  return {
    edgeId: requireOpaqueIdentity(record.edgeId, 'edgeId'),
    fromOperatorId: requireOpaqueIdentity(record.fromOperatorId, 'fromOperatorId'),
    toOperatorId: requireOpaqueIdentity(record.toOperatorId, 'toOperatorId'),
  };
}

function decodeWork(value: unknown): AgentGraphClientScheduledWork {
  const record = requireShapedRecord(
    value,
    'agent graph work',
    [
      'workId',
      'target',
      'inputIds',
      'status',
      'instructionPreview',
      'instructionTruncated',
      'revision',
      'committedAt',
    ],
    ['replaces', 'selectedResultInputs'],
  );
  if (
    record.status !== 'requested' &&
    record.status !== 'stopped' &&
    record.status !== 'superseded'
  ) {
    throw invalidProtocolFrame('Invalid agent graph work status');
  }
  const inputIds = decodeIdentityArray(record.inputIds, 'inputIds', AGENT_GRAPH_MAX_WORK_INPUTS);
  return {
    workId: requireOpaqueIdentity(record.workId, 'workId'),
    target: decodeWorkTarget(record.target),
    inputIds,
    ...(record.selectedResultInputs === undefined
      ? {}
      : {
          selectedResultInputs: decodeSelectedResultInputs(
            record.selectedResultInputs,
            new Set(inputIds),
          ),
        }),
    ...(record.replaces === undefined
      ? {}
      : { replaces: requireOpaqueIdentity(record.replaces, 'replaces') }),
    status: record.status,
    instructionPreview: requireUtf8String(
      record.instructionPreview,
      'instructionPreview',
      AGENT_GRAPH_INSTRUCTION_PREVIEW_MAX_BYTES,
    ),
    instructionTruncated: requireBoolean(record.instructionTruncated, 'instructionTruncated'),
    revision: requireCount(record.revision, 'revision'),
    committedAt: requireCount(record.committedAt, 'committedAt'),
  };
}

function decodeSelectedResultInputs(
  value: unknown,
  currentInputIds: ReadonlySet<string>,
): Array<{ sourceGraphId: string; resultId: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_GRAPH_MAX_WORK_INPUTS) {
    throw invalidProtocolFrame('Invalid selected graph result inputs');
  }
  // The durable schedule contract caps current and selected historical inputs
  // COMBINED at AGENT_GRAPH_MAX_WORK_INPUTS; the decoder must not admit a
  // wider frame than the contract it projects.
  if (currentInputIds.size + value.length > AGENT_GRAPH_MAX_WORK_INPUTS) {
    throw invalidProtocolFrame('Graph input ids exceed the combined current and historical cap');
  }
  const selected = value.map((item) => {
    const record = requireExactRecord(item, 'selected graph result input', [
      'sourceGraphId',
      'resultId',
    ]);
    return {
      sourceGraphId: requireOpaqueIdentity(record.sourceGraphId, 'sourceGraphId'),
      resultId: requireOpaqueIdentity(record.resultId, 'resultId'),
    };
  });
  assertUnique(selected, (item) => item.resultId, 'selected graph result');
  if (selected.some((item) => currentInputIds.has(item.resultId))) {
    throw invalidProtocolFrame('Graph input ids are ambiguous across current and historical data');
  }
  return selected;
}

function decodeReconciliationFailure(value: unknown): AgentGraphClientReconciliationFailure {
  const record = requireExactRecord(value, 'agent graph reconciliation failure', [
    'workId',
    'phase',
    'reason',
  ]);
  if (
    record.phase !== 'schedule' &&
    record.phase !== 'topology' &&
    record.phase !== 'stop' &&
    record.phase !== 'render' &&
    record.phase !== 'dispatch'
  ) {
    throw invalidProtocolFrame('Invalid agent graph reconciliation failure phase');
  }
  return {
    workId: requireOpaqueIdentity(record.workId, 'workId'),
    phase: record.phase,
    reason: requireUtf8String(
      record.reason,
      'reason',
      AGENT_GRAPH_RECONCILIATION_FAILURE_REASON_MAX_BYTES,
    ),
  };
}

function decodeWorkTarget(value: unknown): AgentGraphClientScheduledWork['target'] {
  const record = requireShapedRecord(
    value,
    'agent graph work target',
    ['kind'],
    ['agentId', 'presetId', 'operatorId'],
  );
  if (record.kind === 'agent') {
    requireExactRecord(record, 'agent graph agent target', ['kind', 'agentId']);
    return { kind: record.kind, agentId: requireOpaqueIdentity(record.agentId, 'agentId') };
  }
  if (record.kind === 'operator') {
    requireExactRecord(record, 'agent graph operator target', ['kind', 'operatorId']);
    return {
      kind: record.kind,
      operatorId: requireOpaqueIdentity(record.operatorId, 'operatorId'),
    };
  }
  if (record.kind === 'preset') {
    requireExactRecord(record, 'agent graph preset target', ['kind', 'presetId']);
    return {
      kind: record.kind,
      presetId: requireOpaqueIdentity(record.presetId, 'presetId'),
    };
  }
  throw invalidProtocolFrame('Invalid agent graph work target');
}

function decodeStoppedTarget(value: unknown): AgentGraphClientStoppedTarget {
  const record = requireExactRecord(value, 'agent graph stopped target', [
    'targetId',
    'reason',
    'revision',
    'committedAt',
  ]);
  return {
    targetId: requireOpaqueIdentity(record.targetId, 'targetId'),
    reason: requireUtf8String(record.reason, 'stop reason', AGENT_GRAPH_REASON_MAX_BYTES),
    revision: requireCount(record.revision, 'revision'),
    committedAt: requireCount(record.committedAt, 'committedAt'),
  };
}

function decodeFinish(value: unknown): AgentGraphClientFinish {
  const record = requireExactRecord(value, 'agent graph finish', [
    'resultIds',
    'reason',
    'revision',
    'committedAt',
  ]);
  return {
    resultIds: decodeIdentityArray(record.resultIds, 'resultIds', AGENT_GRAPH_MAX_CONTROL_REFS),
    reason: requireUtf8String(record.reason, 'finish reason', AGENT_GRAPH_REASON_MAX_BYTES),
    revision: requireCount(record.revision, 'revision'),
    committedAt: requireCount(record.committedAt, 'committedAt'),
  };
}

function decodeControlDecision(value: unknown): AgentGraphClientControlDecision {
  const record = requireExactRecord(value, 'agent graph control decision', [
    'updateId',
    'revision',
    'committedAt',
    'source',
    'addedWorkIds',
    'stoppedTargetIds',
    'selectedResultIds',
  ]);
  const source = requireExactRecord(record.source, 'agent graph control source', [
    'sessionId',
    'agentRunId',
    'turnId',
    'toolCallId',
  ]);
  return {
    updateId: requireOpaqueIdentity(record.updateId, 'updateId'),
    revision: requireCount(record.revision, 'revision'),
    committedAt: requireCount(record.committedAt, 'committedAt'),
    source: {
      sessionId: requireEntityId(source.sessionId, 'sessionId'),
      agentRunId: requireOpaqueIdentity(source.agentRunId, 'agentRunId'),
      turnId: requireOpaqueIdentity(source.turnId, 'turnId'),
      toolCallId: requireOpaqueIdentity(source.toolCallId, 'toolCallId'),
    },
    addedWorkIds: decodeIdentityArray(
      record.addedWorkIds,
      'addedWorkIds',
      AGENT_GRAPH_MAX_CONTROL_REFS,
    ),
    stoppedTargetIds: decodeIdentityArray(
      record.stoppedTargetIds,
      'stoppedTargetIds',
      AGENT_GRAPH_MAX_CONTROL_REFS,
    ),
    selectedResultIds: decodeIdentityArray(
      record.selectedResultIds,
      'selectedResultIds',
      AGENT_GRAPH_MAX_CONTROL_REFS,
    ),
  };
}

function decodeClaim(value: unknown): AgentGraphClientClaimRef {
  const record = requireExactRecord(value, 'agent graph claim', [
    'claimId',
    'intentId',
    'operatorId',
    'childSessionId',
    'run',
    'admissionState',
    'claimedAt',
  ]);
  if (
    record.admissionState !== 'claimed' &&
    record.admissionState !== 'executing' &&
    record.admissionState !== 'cancelled'
  ) {
    throw invalidProtocolFrame('Invalid agent graph claim admission state');
  }
  return {
    claimId: requireOpaqueIdentity(record.claimId, 'claimId'),
    intentId: requireOpaqueIdentity(record.intentId, 'intentId'),
    operatorId: requireOpaqueIdentity(record.operatorId, 'operatorId'),
    childSessionId: requireEntityId(record.childSessionId, 'childSessionId'),
    run: decodeRunRef(record.run),
    admissionState: record.admissionState,
    claimedAt: requireCount(record.claimedAt, 'claimedAt'),
  };
}

function decodeActivity(value: unknown): AgentGraphClientActivity {
  const record = requireExactRecord(value, 'agent graph activity', [
    'recordId',
    'operatorId',
    'activationId',
    'eventTime',
    'facets',
    'signals',
    'run',
  ]);
  return {
    recordId: requireOpaqueIdentity(record.recordId, 'recordId'),
    operatorId: requireOpaqueIdentity(record.operatorId, 'operatorId'),
    activationId: requireOpaqueIdentity(record.activationId, 'activationId'),
    eventTime: requireCount(record.eventTime, 'eventTime'),
    facets: decodeArray(record.facets, 'agent graph activity facets', 18, requireFacet),
    signals: decodeArray(record.signals, 'agent graph activity signals', 2, decodeSignal),
    run: decodeRunRef(record.run),
  };
}

function decodeActivation(value: unknown): AgentGraphOperatorInspection['activations'][number] {
  const record = requireShapedRecord(
    value,
    'agent graph activation',
    [
      'activationId',
      'status',
      'recordCount',
      'firstEventTime',
      'lastEventTime',
      'lastRecordId',
      'run',
    ],
    ['terminalRecordId'],
  );
  return {
    activationId: requireOpaqueIdentity(record.activationId, 'activationId'),
    status: requireActivationStatus(record.status),
    recordCount: requireCount(record.recordCount, 'recordCount'),
    firstEventTime: requireCount(record.firstEventTime, 'firstEventTime'),
    lastEventTime: requireCount(record.lastEventTime, 'lastEventTime'),
    lastRecordId: requireOpaqueIdentity(record.lastRecordId, 'lastRecordId'),
    ...(record.terminalRecordId === undefined
      ? {}
      : {
          terminalRecordId: requireOpaqueIdentity(record.terminalRecordId, 'terminalRecordId'),
        }),
    run: decodeRunRef(record.run),
  };
}

function decodeRunRef(value: unknown): AgentGraphClientRunRef {
  const record = requireShapedRecord(
    value,
    'agent graph run reference',
    ['sessionId', 'agentRunId'],
    ['turnId'],
  );
  return {
    sessionId: requireEntityId(record.sessionId, 'sessionId'),
    agentRunId: requireOpaqueIdentity(record.agentRunId, 'agentRunId'),
    ...(record.turnId === undefined
      ? {}
      : { turnId: requireOpaqueIdentity(record.turnId, 'turnId') }),
  };
}

function decodeSignal(value: unknown): AgentGraphSupervisorSignal {
  const record = requireShapedRecord(value, 'agent graph signal', ['kind'], ['reason', 'status']);
  if (record.kind === 'attention') {
    requireExactRecord(record, 'agent graph attention signal', ['kind', 'reason']);
    if (record.reason !== 'permission_request' && record.reason !== 'user_question_request') {
      throw invalidProtocolFrame('Invalid agent graph attention reason');
    }
    return { kind: record.kind, reason: record.reason };
  }
  if (record.kind === 'terminal') {
    requireExactRecord(record, 'agent graph terminal signal', ['kind', 'status']);
    if (
      record.status !== 'completed' &&
      record.status !== 'failed' &&
      record.status !== 'aborted' &&
      record.status !== 'cancelled'
    ) {
      throw invalidProtocolFrame('Invalid agent graph terminal status');
    }
    return { kind: record.kind, status: record.status };
  }
  throw invalidProtocolFrame('Invalid agent graph signal kind');
}

function decodeTerminalHistory(value: unknown): AgentGraphClientSnapshot['terminalHistory'] {
  const record = requireShapedRecord(
    value,
    'agent graph terminal history',
    ['records'],
    ['nextCursor'],
  );
  return {
    records: decodeArray(
      record.records,
      'agent graph terminal activity',
      AGENT_GRAPH_MAX_TERMINAL_ACTIVITY,
      decodeActivity,
    ),
    ...(record.nextCursor === undefined ? {} : { nextCursor: requireCursor(record.nextCursor) }),
  };
}

function decodeOperatorOmitted(value: unknown): AgentGraphClientOperator['omitted'] {
  const record = requireExactRecord(value, 'agent graph operator omitted counts', [
    'inboundEdgeIds',
    'outboundEdgeIds',
    'scheduledWorkIds',
    'readiness',
    'readinessWaits',
  ]);
  return {
    inboundEdgeIds: requireCount(record.inboundEdgeIds, 'omitted inboundEdgeIds'),
    outboundEdgeIds: requireCount(record.outboundEdgeIds, 'omitted outboundEdgeIds'),
    scheduledWorkIds: requireCount(record.scheduledWorkIds, 'omitted scheduledWorkIds'),
    readiness: requireCount(record.readiness, 'omitted readiness'),
    readinessWaits: requireCount(record.readinessWaits, 'omitted readinessWaits'),
  };
}

function decodeSnapshotOmitted(value: unknown): AgentGraphClientSnapshot['omitted'] {
  const record = requireExactRecord(value, 'agent graph snapshot omitted counts', [
    'operators',
    'edges',
    'work',
    'reconciliationFailures',
    'stoppedTargets',
    'claims',
    'controlDecisions',
    'recentActivity',
  ]);
  return {
    operators: requireCount(record.operators, 'omitted operators'),
    edges: requireCount(record.edges, 'omitted edges'),
    work: requireCount(record.work, 'omitted work'),
    reconciliationFailures: requireCount(
      record.reconciliationFailures,
      'omitted reconciliationFailures',
    ),
    stoppedTargets: requireCount(record.stoppedTargets, 'omitted stoppedTargets'),
    claims: requireCount(record.claims, 'omitted claims'),
    controlDecisions: requireCount(record.controlDecisions, 'omitted controlDecisions'),
    recentActivity: requireCount(record.recentActivity, 'omitted recentActivity'),
  };
}

function decodeInspectionOmitted(value: unknown): AgentGraphOperatorInspection['omitted'] {
  const record = requireExactRecord(value, 'agent graph inspection omitted counts', [
    'inboundEdges',
    'outboundEdges',
    'work',
    'claims',
    'activations',
    'records',
  ]);
  return {
    inboundEdges: requireCount(record.inboundEdges, 'omitted inboundEdges'),
    outboundEdges: requireCount(record.outboundEdges, 'omitted outboundEdges'),
    work: requireCount(record.work, 'omitted work'),
    claims: requireCount(record.claims, 'omitted claims'),
    activations: requireCount(record.activations, 'omitted activations'),
    records: requireCount(record.records, 'omitted records'),
  };
}

function decodeIdentityArray(value: unknown, label: string, maxItems: number): string[] {
  const identities = decodeArray(value, label, maxItems, (item) =>
    requireOpaqueIdentity(item, label),
  );
  assertUnique(identities, (item) => item, label);
  return identities;
}

function decodeArray<T>(
  value: unknown,
  label: string,
  maxItems: number,
  decode: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value.map(decode);
}

function assertUnique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  if (new Set(items.map(key)).size !== items.length) {
    throw invalidProtocolFrame(`Duplicate ${label} identity`);
  }
}

function assertRootIdentity(
  rootSessionId: string,
  output: { readonly rootSessionId: string },
): void {
  if (output.rootSessionId !== rootSessionId) {
    throw invalidProtocolFrame('Agent graph result changed request identity');
  }
}

function requireSchemaVersion(value: unknown): void {
  if (value !== AGENT_GRAPH_CLIENT_SCHEMA_VERSION) {
    throw invalidProtocolFrame('Unsupported agent graph client schema');
  }
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolFrame(`Invalid ${label}`);
  return value;
}

function requireOpaqueIdentity(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value;
}

function requireFingerprint(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidProtocolFrame(`Invalid ${label}`);
  }
  return value as `sha256:${string}`;
}

function requireCursor(value: unknown): string {
  const cursor = requireUtf8String(
    value,
    'agent graph terminal cursor',
    AGENT_GRAPH_TERMINAL_CURSOR_MAX_BYTES,
  );
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalidProtocolFrame('Invalid agent graph terminal cursor');
  }
  return cursor;
}

function requireActivationStatus(value: unknown): AgentGraphActivationStatus {
  if (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'aborted' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid agent graph activation status');
}

function requireOperatorStatus(value: unknown): AgentGraphClientOperatorStatus {
  if (
    value === 'not_started' ||
    value === 'waiting' ||
    value === 'runnable' ||
    value === 'blocked'
  ) {
    return value;
  }
  return requireActivationStatus(value);
}

function requireGraphStatus(value: unknown): AgentGraphClientStatus {
  if (
    value === 'empty' ||
    value === 'active' ||
    value === 'closing' ||
    value === 'waiting' ||
    value === 'stopped' ||
    value === 'failed' ||
    value === 'completed'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid agent graph status');
}

function requireGraphOrchestrationMode(value: unknown): 'graph' | 'swarm' {
  if (value === 'graph' || value === 'swarm') return value;
  throw invalidProtocolFrame('Invalid agent graph orchestration mode');
}

function requireFacet(value: unknown): AgentGraphRecordFacet {
  if (
    value === 'message' ||
    value === 'thinking' ||
    value === 'error' ||
    value === 'tool_call' ||
    value === 'tool_dispatch' ||
    value === 'tool_result' ||
    value === 'artifact_update' ||
    value === 'permission_request' ||
    value === 'permission_decision' ||
    value === 'user_question_request' ||
    value === 'transfer' ||
    value === 'usage' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'aborted' ||
    value === 'cancelled' ||
    value === 'runtime_fact'
  ) {
    return value;
  }
  throw invalidProtocolFrame('Invalid agent graph record facet');
}
