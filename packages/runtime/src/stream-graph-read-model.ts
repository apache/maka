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

import type { AgentGraphClientClaimAdmission } from '@maka/core/agent-graph-client-projection';
import type { AgentGraphIntentClaim } from '@maka/core/agent-graph-control';
import type { AgentGraphOperatorProvision } from '@maka/core/agent-graph-topology';
import type { AgentGraphScheduleUpdate } from '@maka/core/agent-graph-schedule';
import type { SessionEvent } from '@maka/core/events';
import { failureClassFromCompleteStopReason } from '@maka/core/events';
import type {
  AgentGraphSupervisorObservation,
  AgentGraphSupervisorRuntimeEvent,
} from './stream-graph-dispatch.js';
import type {
  AgentGraphActivationStatus,
  AgentGraphRecord,
  AgentGraphRecordFacet,
  AgentGraphSupervisorSignal,
} from './stream-graph-projection.js';
import type { AgentGraphReadinessWait } from './stream-graph-readiness.js';
import {
  projectAgentGraphSchedule,
  type AgentGraphScheduleFinishView,
  type AgentGraphScheduleProjection,
  type AgentGraphScheduleWorkView,
  type AgentGraphStoppedTargetView,
} from './stream-graph-supervisor-tools.js';
import { stableHash } from './request-shape.js';

export const AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION = 1 as const;

const MAX_VISIBLE_OPERATORS = 256;
const MAX_VISIBLE_EDGES = 512;
const MAX_VISIBLE_WORK = 256;
const MAX_VISIBLE_RECONCILIATION_FAILURES = 64;
const MAX_RECONCILIATION_FAILURE_REASON_CHARS = 1_000;
const MAX_VISIBLE_STOPPED_TARGETS = 128;
const MAX_RECENT_CONTROL_DECISIONS = 32;
const MAX_VISIBLE_CLAIMS = 256;
const MAX_RECENT_ACTIVITY = 64;
export const AGENT_GRAPH_CLIENT_TERMINAL_PAGE_SIZE = 64;
const MAX_OPERATOR_INSPECTION_ACTIVATIONS = 64;
const MAX_OPERATOR_INSPECTION_RECORDS = 128;
const MAX_OPERATOR_EDGE_REFS = 64;
const MAX_OPERATOR_WORK_REFS = 64;
const MAX_OPERATOR_READINESS = 8;
const MAX_OPERATOR_READINESS_WAITS = 64;
const MAX_OPERATOR_INSPECTION_EDGES = 512;
const MAX_OPERATOR_INSPECTION_WORK = 256;
const MAX_OPERATOR_INSPECTION_CLAIMS = 256;
const MAX_INSTRUCTION_PREVIEW_CHARS = 500;

export type AgentGraphClientOperatorStatus =
  | 'not_started'
  | 'waiting'
  | 'runnable'
  | 'running'
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

export interface AgentGraphClientRunRef {
  sessionId: string;
  agentRunId: string;
  turnId?: string;
}

export interface AgentGraphClientOperator {
  operatorId: string;
  childSessionId: string;
  provisionId: string;
  agentId: string;
  provisionedAt: number;
  status: AgentGraphClientOperatorStatus;
  inboundEdgeIds: string[];
  outboundEdgeIds: string[];
  scheduledWorkIds: string[];
  readiness: Array<{
    readinessId: string;
    status: 'waiting' | 'runnable';
    waitingFor: AgentGraphReadinessWait[];
    omittedWaitingFor: number;
  }>;
  omitted: {
    inboundEdgeIds: number;
    outboundEdgeIds: number;
    scheduledWorkIds: number;
    readiness: number;
    readinessWaits: number;
  };
  currentActivation?: {
    activationId: string;
    status: AgentGraphActivationStatus;
    recordCount: number;
    firstEventTime: number;
    lastEventTime: number;
    terminalRecordId?: string;
    run: AgentGraphClientRunRef;
  };
}

export interface AgentGraphClientEdge {
  edgeId: string;
  fromOperatorId: string;
  toOperatorId: string;
}

export interface AgentGraphClientScheduledWork {
  workId: string;
  target:
    | { kind: 'agent'; agentId: string }
    | { kind: 'preset'; presetId: string }
    | { kind: 'operator'; operatorId: string };
  inputIds: string[];
  selectedResultInputs?: Array<{ sourceGraphId: string; resultId: string }>;
  replaces?: string;
  status: AgentGraphScheduleWorkView['status'];
  instructionPreview: string;
  instructionTruncated: boolean;
  revision: number;
  committedAt: number;
}

export interface AgentGraphClientReconciliationFailure {
  workId: string;
  phase: 'schedule' | 'topology' | 'stop' | 'render' | 'dispatch';
  reason: string;
}

export interface AgentGraphClientStoppedTarget {
  targetId: string;
  reason: string;
  revision: number;
  committedAt: number;
}

export interface AgentGraphClientFinish {
  resultIds: string[];
  reason: string;
  revision: number;
  committedAt: number;
}

export interface AgentGraphClientControlDecision {
  updateId: string;
  revision: number;
  committedAt: number;
  source: {
    sessionId: string;
    agentRunId: string;
    turnId: string;
    toolCallId: string;
  };
  addedWorkIds: string[];
  stoppedTargetIds: string[];
  selectedResultIds: string[];
}

export interface AgentGraphClientClaimRef {
  claimId: string;
  intentId: string;
  operatorId: string;
  childSessionId: string;
  run: AgentGraphClientRunRef;
  admissionState: AgentGraphClientClaimAdmission['state'];
  claimedAt: number;
}

export interface AgentGraphClientActivity {
  recordId: string;
  operatorId: string;
  activationId: string;
  eventTime: number;
  facets: AgentGraphRecordFacet[];
  signals: AgentGraphSupervisorSignal[];
  run: AgentGraphClientRunRef;
}

export interface AgentGraphClientTerminalHistoryPage {
  records: AgentGraphClientActivity[];
  nextCursor?: string;
}

export interface AgentGraphClientSnapshot {
  schemaVersion: typeof AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION;
  rootSessionId: string;
  graphId: string;
  orchestrationMode: 'graph' | 'swarm';
  snapshotVersion: string;
  status: AgentGraphClientStatus;
  scheduleRevision: number;
  topologyFingerprint: string;
  closed: boolean;
  latestEventTime?: number;
  operators: AgentGraphClientOperator[];
  edges: AgentGraphClientEdge[];
  work: AgentGraphClientScheduledWork[];
  reconciliationFailures: AgentGraphClientReconciliationFailure[];
  stoppedTargets: AgentGraphClientStoppedTarget[];
  finish?: AgentGraphClientFinish;
  claims: AgentGraphClientClaimRef[];
  recentControlDecisions: AgentGraphClientControlDecision[];
  recentActivity: AgentGraphClientActivity[];
  terminalHistory: AgentGraphClientTerminalHistoryPage;
  omitted: {
    operators: number;
    edges: number;
    work: number;
    reconciliationFailures: number;
    stoppedTargets: number;
    claims: number;
    controlDecisions: number;
    recentActivity: number;
  };
}

export interface AgentGraphOperatorInspection {
  schemaVersion: typeof AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION;
  rootSessionId: string;
  graphId: string;
  snapshotVersion: string;
  operator: AgentGraphClientOperator;
  inboundEdges: AgentGraphClientEdge[];
  outboundEdges: AgentGraphClientEdge[];
  work: AgentGraphClientScheduledWork[];
  claims: AgentGraphClientClaimRef[];
  activations: Array<{
    activationId: string;
    status: AgentGraphActivationStatus;
    recordCount: number;
    firstEventTime: number;
    lastEventTime: number;
    lastRecordId: string;
    terminalRecordId?: string;
    run: AgentGraphClientRunRef;
  }>;
  recentRecords: AgentGraphClientActivity[];
  omitted: {
    inboundEdges: number;
    outboundEdges: number;
    work: number;
    claims: number;
    activations: number;
    records: number;
  };
}

export interface BuildAgentGraphClientReadModelInput {
  rootSessionId: string;
  graphId: string;
  provisions: readonly AgentGraphOperatorProvision[];
  scheduleUpdates: readonly AgentGraphScheduleUpdate[];
  schedule?: AgentGraphScheduleProjection;
  orchestrationMode?: 'graph' | 'swarm';
  reconciliationFailures?: readonly AgentGraphClientReconciliationFailure[];
  claimAdmissions?: readonly AgentGraphClientClaimAdmission[];
  observation: AgentGraphSupervisorObservation;
}

export interface AgentGraphClientMaterialization {
  snapshot: AgentGraphClientSnapshot;
  operators: AgentGraphOperatorInspection[];
  activityRecords: AgentGraphClientActivity[];
  terminalActivities: AgentGraphClientActivity[];
}

export interface AdvancedAgentGraphClientProjection {
  snapshot: AgentGraphClientSnapshot;
  operator: AgentGraphOperatorInspection;
  activity: AgentGraphClientActivity;
  terminalActivity?: AgentGraphClientActivity;
}

export interface AgentGraphClientSnapshotOptions {
  terminalCursor?: string;
}

interface BuiltReadModel {
  schedule: AgentGraphScheduleProjection;
  operators: AgentGraphClientOperator[];
  edges: AgentGraphClientEdge[];
  work: AgentGraphClientScheduledWork[];
  stoppedTargets: AgentGraphClientStoppedTarget[];
  finish?: AgentGraphClientFinish;
  claims: AgentGraphClientClaimRef[];
  recentControlDecisions: AgentGraphClientControlDecision[];
  activity: AgentGraphClientActivity[];
  scheduledWorkIdsByOperator: Map<string, string[]>;
}

/**
 * Durable, bounded graph-facing projection for untrusted presentation clients.
 *
 * Payloads remain in Session/Runtime stores. This surface carries only
 * identities, lifecycle state, wait reasons, and bounded instruction previews.
 */
export function buildAgentGraphClientSnapshot(
  input: BuildAgentGraphClientReadModelInput,
  options: AgentGraphClientSnapshotOptions = {},
): AgentGraphClientSnapshot {
  const model = buildReadModel(input);
  return snapshotFromModel(input, model, options);
}

export function materializeAgentGraphClientProjection(
  input: BuildAgentGraphClientReadModelInput,
): AgentGraphClientMaterialization {
  const model = buildReadModel(input);
  const snapshot = snapshotFromModel(input, model, {});
  return {
    snapshot,
    operators: model.operators.map((operator) =>
      inspectionFromModel(input, model, operator.operatorId, snapshot.snapshotVersion),
    ),
    activityRecords: model.activity,
    terminalActivities: terminalActivities(model.activity),
  };
}

/**
 * Advance the bounded materialized client view from one already-durable
 * SessionEvent without replaying the RuntimeEvent ledger.
 */
export function advanceMaterializedAgentGraphClientProjection(
  snapshotInput: AgentGraphClientSnapshot,
  inspectionInput: AgentGraphOperatorInspection,
  runtime: AgentGraphSupervisorRuntimeEvent,
  activationHadError: boolean,
): AdvancedAgentGraphClientProjection | undefined {
  const projected = projectClientSessionEvent(runtime.event, activationHadError);
  if (!projected) return undefined;
  if (
    snapshotInput.graphId !== runtime.intent.graphId ||
    inspectionInput.graphId !== runtime.intent.graphId ||
    inspectionInput.operator.operatorId !== runtime.claim.targetOperatorId ||
    inspectionInput.operator.childSessionId !== runtime.claim.targetSessionId
  ) {
    throw new Error('Agent graph runtime activity does not match its materialized projection');
  }
  const activity: AgentGraphClientActivity = {
    recordId: clientRuntimeRecordId(runtime),
    operatorId: runtime.claim.targetOperatorId,
    activationId: runtime.claim.targetRunId,
    eventTime: runtime.event.ts,
    facets: projected.facets,
    signals: projected.signals,
    run: {
      sessionId: runtime.claim.targetSessionId,
      agentRunId: runtime.claim.targetRunId,
      turnId: runtime.claim.targetTurnId,
    },
  };
  const snapshot = structuredClone(snapshotInput);
  const inspection = structuredClone(inspectionInput);
  if (
    snapshot.recentActivity.some((record) => record.recordId === activity.recordId) ||
    inspection.recentRecords.some((record) => record.recordId === activity.recordId)
  ) {
    return undefined;
  }
  const previousActivation = inspection.activations.find(
    (activation) => activation.activationId === runtime.claim.targetRunId,
  );
  const incomingIsLast =
    !previousActivation ||
    compareActivityKey(
      runtime.event.ts,
      activity.recordId,
      previousActivation.lastEventTime,
      previousActivation.lastRecordId,
    ) > 0;
  const previousTerminalRecord = previousActivation?.terminalRecordId
    ? inspection.recentRecords.find(
        (record) => record.recordId === previousActivation.terminalRecordId,
      )
    : undefined;
  const previousIsTerminal =
    previousActivation !== undefined &&
    ['completed', 'failed', 'aborted', 'cancelled'].includes(previousActivation.status);
  const incomingTerminalWins =
    projected.terminalStatus !== undefined &&
    (!previousIsTerminal ||
      (previousTerminalRecord !== undefined &&
        compareClientActivity(activity, previousTerminalRecord) > 0));
  const activationStatus: AgentGraphActivationStatus = incomingTerminalWins
    ? projected.terminalStatus!
    : previousIsTerminal
      ? previousActivation.status
      : 'running';
  const terminalRecordId = incomingTerminalWins
    ? activity.recordId
    : previousActivation?.terminalRecordId;
  const nextActivation = previousActivation
    ? {
        ...previousActivation,
        status: activationStatus,
        recordCount: previousActivation.recordCount + 1,
        firstEventTime: Math.min(previousActivation.firstEventTime, runtime.event.ts),
        lastEventTime: incomingIsLast ? runtime.event.ts : previousActivation.lastEventTime,
        lastRecordId: incomingIsLast ? activity.recordId : previousActivation.lastRecordId,
        ...(terminalRecordId ? { terminalRecordId } : {}),
      }
    : {
        activationId: runtime.claim.targetRunId,
        status: activationStatus,
        recordCount: 1,
        firstEventTime: runtime.event.ts,
        lastEventTime: runtime.event.ts,
        lastRecordId: activity.recordId,
        ...(projected.terminalStatus ? { terminalRecordId: activity.recordId } : {}),
        run: { ...activity.run },
      };
  const activationCount =
    inspection.omitted.activations + inspection.activations.length + (previousActivation ? 0 : 1);
  inspection.activations = [
    ...inspection.activations.filter(
      (activation) => activation.activationId !== nextActivation.activationId,
    ),
    nextActivation,
  ]
    .sort(
      (a, b) =>
        a.firstEventTime - b.firstEventTime || compareIdentity(a.activationId, b.activationId),
    )
    .slice(-MAX_OPERATOR_INSPECTION_ACTIVATIONS);
  inspection.omitted.activations = Math.max(0, activationCount - inspection.activations.length);
  const currentActivation = inspection.activations.at(-1);
  let operatorStatus = inspection.operator.status;
  if (currentActivation?.activationId === nextActivation.activationId) {
    operatorStatus = projected.terminalStatus
      ? projected.terminalStatus
      : ['completed', 'failed', 'aborted', 'cancelled'].includes(operatorStatus)
        ? operatorStatus
        : projected.signals.some((signal) => signal.kind === 'attention') ||
            operatorStatus === 'blocked'
          ? 'blocked'
          : 'running';
  }
  inspection.operator.status = operatorStatus;
  if (currentActivation) {
    const currentRun =
      currentActivation.activationId === nextActivation.activationId
        ? activity.run
        : inspection.operator.currentActivation?.run;
    if (!currentRun) {
      throw new Error('Agent graph activation is missing its materialized run reference');
    }
    inspection.operator.currentActivation = {
      activationId: currentActivation.activationId,
      status: currentActivation.status,
      recordCount: currentActivation.recordCount,
      firstEventTime: currentActivation.firstEventTime,
      lastEventTime: currentActivation.lastEventTime,
      ...(currentActivation.terminalRecordId
        ? { terminalRecordId: currentActivation.terminalRecordId }
        : {}),
      run: { ...currentRun },
    };
  }
  const inspectionRecordCount = inspection.omitted.records + inspection.recentRecords.length + 1;
  inspection.recentRecords = [...inspection.recentRecords, activity]
    .sort(compareClientActivity)
    .slice(-MAX_OPERATOR_INSPECTION_RECORDS);
  inspection.omitted.records = Math.max(0, inspectionRecordCount - inspection.recentRecords.length);

  const visibleOperatorIndex = snapshot.operators.findIndex(
    (operator) => operator.operatorId === inspection.operator.operatorId,
  );
  if (visibleOperatorIndex >= 0) {
    snapshot.operators[visibleOperatorIndex] = structuredClone(inspection.operator);
  }
  const activityCount = snapshot.omitted.recentActivity + snapshot.recentActivity.length + 1;
  snapshot.recentActivity = [...snapshot.recentActivity, activity]
    .sort(compareClientActivity)
    .slice(-MAX_RECENT_ACTIVITY);
  snapshot.omitted.recentActivity = Math.max(0, activityCount - snapshot.recentActivity.length);
  snapshot.latestEventTime = Math.max(snapshot.latestEventTime ?? 0, runtime.event.ts);
  snapshot.status = patchedGraphStatus(snapshot, inspection.operator);
  snapshot.snapshotVersion = clientSnapshotVersion(snapshot);
  inspection.snapshotVersion = snapshot.snapshotVersion;
  return {
    snapshot,
    operator: inspection,
    activity,
    ...(projected.terminalStatus ? { terminalActivity: activity } : {}),
  };
}

function snapshotFromModel(
  input: BuildAgentGraphClientReadModelInput,
  model: BuiltReadModel,
  options: AgentGraphClientSnapshotOptions,
): AgentGraphClientSnapshot {
  const visibleOperators = boundOperators(model.operators);
  const visibleOperatorIds = new Set(visibleOperators.map((operator) => operator.operatorId));
  const candidateEdges = model.edges.filter(
    (edge) =>
      visibleOperatorIds.has(edge.fromOperatorId) && visibleOperatorIds.has(edge.toOperatorId),
  );
  const edges = candidateEdges.slice(0, MAX_VISIBLE_EDGES);
  const work = boundWork(model.work);
  const allReconciliationFailures = normalizeReconciliationFailures(
    input.reconciliationFailures ?? [],
  );
  const reconciliationFailures = allReconciliationFailures.slice(
    -MAX_VISIBLE_RECONCILIATION_FAILURES,
  );
  const stoppedTargets = model.stoppedTargets.slice(-MAX_VISIBLE_STOPPED_TARGETS);
  const claims = model.claims.slice(-MAX_VISIBLE_CLAIMS);
  const recentControlDecisions = model.recentControlDecisions.slice(-MAX_RECENT_CONTROL_DECISIONS);
  const recentActivity = model.activity.slice(-MAX_RECENT_ACTIVITY);
  const snapshot: AgentGraphClientSnapshot = {
    schemaVersion: AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION,
    rootSessionId: input.rootSessionId,
    graphId: input.graphId,
    orchestrationMode: input.orchestrationMode ?? 'graph',
    snapshotVersion: '',
    status: graphStatus(model.schedule, model.operators, model.claims, model.activity),
    scheduleRevision: model.schedule.revision,
    topologyFingerprint: input.observation.readiness.topologyFingerprint,
    closed: model.schedule.closed,
    ...(input.observation.projection.state.latestEventTime !== undefined
      ? { latestEventTime: input.observation.projection.state.latestEventTime }
      : {}),
    operators: visibleOperators,
    edges,
    work,
    reconciliationFailures,
    stoppedTargets,
    ...(model.finish ? { finish: model.finish } : {}),
    claims,
    recentControlDecisions,
    recentActivity,
    terminalHistory: terminalHistoryPage(input.graphId, model.activity, options.terminalCursor),
    omitted: {
      operators: model.operators.length - visibleOperators.length,
      edges: model.edges.length - edges.length,
      work: model.work.length - work.length,
      reconciliationFailures: allReconciliationFailures.length - reconciliationFailures.length,
      stoppedTargets: model.stoppedTargets.length - stoppedTargets.length,
      claims: model.claims.length - claims.length,
      controlDecisions: model.recentControlDecisions.length - recentControlDecisions.length,
      recentActivity: model.activity.length - recentActivity.length,
    },
  };
  snapshot.snapshotVersion = clientSnapshotVersion(snapshot);
  return snapshot;
}

export function inspectAgentGraphOperator(
  input: BuildAgentGraphClientReadModelInput,
  operatorId: string,
): AgentGraphOperatorInspection {
  const expectedOperatorId = requireIdentity(operatorId, 'operator id');
  const model = buildReadModel(input);
  const snapshotVersion = snapshotFromModel(input, model, {}).snapshotVersion;
  return inspectionFromModel(input, model, expectedOperatorId, snapshotVersion);
}

function inspectionFromModel(
  input: BuildAgentGraphClientReadModelInput,
  model: BuiltReadModel,
  expectedOperatorId: string,
  snapshotVersion: string,
): AgentGraphOperatorInspection {
  const operator = model.operators.find((candidate) => candidate.operatorId === expectedOperatorId);
  if (!operator) {
    throw new Error(`Agent graph operator ${expectedOperatorId} was not found`);
  }
  const runtimeState = input.observation.projection.state.operators[expectedOperatorId];
  const allActivations = runtimeState
    ? Object.values(runtimeState.activations).sort(
        (a, b) =>
          a.firstEventTime - b.firstEventTime || compareIdentity(a.activationId, b.activationId),
      )
    : [];
  const visibleActivations = allActivations.slice(-MAX_OPERATOR_INSPECTION_ACTIVATIONS);
  const allRecords = model.activity.filter((record) => record.operatorId === expectedOperatorId);
  const recentRecords = allRecords.slice(-MAX_OPERATOR_INSPECTION_RECORDS);
  const inboundEdges = model.edges.filter((edge) => edge.toOperatorId === expectedOperatorId);
  const visibleInboundEdges = inboundEdges.slice(-MAX_OPERATOR_INSPECTION_EDGES);
  const outboundEdges = model.edges.filter((edge) => edge.fromOperatorId === expectedOperatorId);
  const visibleOutboundEdges = outboundEdges.slice(-MAX_OPERATOR_INSPECTION_EDGES);
  const operatorWorkIds = new Set(model.scheduledWorkIdsByOperator.get(expectedOperatorId) ?? []);
  const work = model.work.filter((entry) => operatorWorkIds.has(entry.workId));
  const visibleWork = work.slice(-MAX_OPERATOR_INSPECTION_WORK);
  const claims = model.claims.filter((claim) => claim.operatorId === expectedOperatorId);
  const visibleClaims = claims.slice(-MAX_OPERATOR_INSPECTION_CLAIMS);
  const claimByRunId = new Map(
    model.claims
      .filter((claim) => claim.operatorId === expectedOperatorId)
      .map((claim) => [claim.run.agentRunId, claim]),
  );
  return {
    schemaVersion: AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION,
    rootSessionId: input.rootSessionId,
    graphId: input.graphId,
    snapshotVersion,
    operator,
    inboundEdges: visibleInboundEdges,
    outboundEdges: visibleOutboundEdges,
    work: visibleWork,
    claims: visibleClaims,
    activations: visibleActivations.map((activation) => ({
      activationId: activation.activationId,
      status: activation.status,
      recordCount: activation.recordCount,
      firstEventTime: activation.firstEventTime,
      lastEventTime: activation.lastEventTime,
      lastRecordId: activation.lastRecordId,
      ...(activation.terminalRecordId ? { terminalRecordId: activation.terminalRecordId } : {}),
      run: runRefForActivation(
        operator.childSessionId,
        activation.agentRunId,
        claimByRunId.get(activation.agentRunId),
        allRecords,
      ),
    })),
    recentRecords,
    omitted: {
      inboundEdges: inboundEdges.length - visibleInboundEdges.length,
      outboundEdges: outboundEdges.length - visibleOutboundEdges.length,
      work: work.length - visibleWork.length,
      claims: claims.length - visibleClaims.length,
      activations: allActivations.length - visibleActivations.length,
      records: allRecords.length - recentRecords.length,
    },
  };
}

function buildReadModel(input: BuildAgentGraphClientReadModelInput): BuiltReadModel {
  requireIdentity(input.rootSessionId, 'root Session id');
  requireIdentity(input.graphId, 'graph id');
  assertObservation(input.graphId, input.observation);
  const schedule =
    input.schedule ?? projectAgentGraphSchedule(input.graphId, input.scheduleUpdates);
  const provisionByOperator = provisionsByOperator(input.graphId, input.provisions);
  const edges = uniqueEdges(input.graphId, input.provisions);
  const claims = clientClaims(input.graphId, input.observation.claims, input.claimAdmissions ?? []);
  const activity = input.observation.projection.records
    .map(clientActivity)
    .sort(compareClientActivity);
  const work = schedule.work.map(clientWork);
  const operators = input.observation.projection.operators.map((binding) => {
    const provision = provisionByOperator.get(binding.operatorId);
    if (!provision || provision.targetSessionId !== binding.sessionId) {
      throw new Error(
        `Agent graph operator ${binding.operatorId} has no matching durable provision`,
      );
    }
    const allReadiness = input.observation.readiness.supervisorView
      .filter((entry) => entry.operatorId === binding.operatorId)
      .map((entry) => ({
        readinessId: entry.readinessId,
        status: entry.status,
        waitingFor: entry.waitingFor.slice(0, MAX_OPERATOR_READINESS_WAITS).map(cloneWait),
        omittedWaitingFor: Math.max(0, entry.waitingFor.length - MAX_OPERATOR_READINESS_WAITS),
      }));
    const readiness = allReadiness.slice(0, MAX_OPERATOR_READINESS);
    const state = input.observation.projection.state.operators[binding.operatorId];
    const currentActivation = state?.activations[state.currentActivationId];
    const currentClaim = currentActivation
      ? claims.find(
          (claim) =>
            claim.operatorId === binding.operatorId &&
            claim.run.agentRunId === currentActivation.agentRunId,
        )
      : undefined;
    const operatorRecords = activity.filter((record) => record.operatorId === binding.operatorId);
    const currentRecord = currentActivation
      ? [...operatorRecords]
          .reverse()
          .find((record) => record.activationId === currentActivation.activationId)
      : undefined;
    const allInboundEdgeIds = edges
      .filter((edge) => edge.toOperatorId === binding.operatorId)
      .map((edge) => edge.edgeId);
    const inboundEdgeIds = allInboundEdgeIds.slice(-MAX_OPERATOR_EDGE_REFS);
    const allOutboundEdgeIds = edges
      .filter((edge) => edge.fromOperatorId === binding.operatorId)
      .map((edge) => edge.edgeId);
    const outboundEdgeIds = allOutboundEdgeIds.slice(-MAX_OPERATOR_EDGE_REFS);
    const allScheduledWorkIds = work
      .filter(
        (entry) =>
          entry.workId === provision.workId ||
          (entry.target.kind === 'operator' && entry.target.operatorId === binding.operatorId),
      )
      .map((entry) => entry.workId);
    const scheduledWorkIds = allScheduledWorkIds.slice(-MAX_OPERATOR_WORK_REFS);
    return {
      operatorId: binding.operatorId,
      childSessionId: binding.sessionId,
      provisionId: provision.provisionId,
      agentId: provision.agentId,
      provisionedAt: provision.provisionedAt,
      status: operatorStatus(state?.status, readiness, currentRecord),
      inboundEdgeIds,
      outboundEdgeIds,
      scheduledWorkIds,
      readiness,
      omitted: {
        inboundEdgeIds: allInboundEdgeIds.length - inboundEdgeIds.length,
        outboundEdgeIds: allOutboundEdgeIds.length - outboundEdgeIds.length,
        scheduledWorkIds: allScheduledWorkIds.length - scheduledWorkIds.length,
        readiness: allReadiness.length - readiness.length,
        readinessWaits: allReadiness.reduce((total, entry) => total + entry.omittedWaitingFor, 0),
      },
      ...(currentActivation
        ? {
            currentActivation: {
              activationId: currentActivation.activationId,
              status: currentActivation.status,
              recordCount: currentActivation.recordCount,
              firstEventTime: currentActivation.firstEventTime,
              lastEventTime: currentActivation.lastEventTime,
              ...(currentActivation.terminalRecordId
                ? { terminalRecordId: currentActivation.terminalRecordId }
                : {}),
              run: runRefForActivation(
                binding.sessionId,
                currentActivation.agentRunId,
                currentClaim,
                operatorRecords,
              ),
            },
          }
        : {}),
    } satisfies AgentGraphClientOperator;
  });
  const stoppedTargets = schedule.stoppedTargets.map(clientStoppedTarget);
  const finish = schedule.finish ? clientFinish(schedule.finish) : undefined;
  const recentControlDecisions = input.scheduleUpdates
    .slice()
    .sort((a, b) => a.revision - b.revision)
    .map((update) => ({
      updateId: update.updateId,
      revision: update.revision,
      committedAt: update.committedAt,
      source: {
        sessionId: update.source.sessionId,
        agentRunId: update.source.runId,
        turnId: update.source.turnId,
        toolCallId: update.source.toolCallId,
      },
      addedWorkIds: update.addWork.map((entry) => entry.workId),
      stoppedTargetIds: update.stop.map((entry) => entry.targetId),
      selectedResultIds: update.finish ? [...update.finish.resultIds] : [],
    }));
  return {
    schedule,
    operators,
    edges,
    work,
    stoppedTargets,
    ...(finish ? { finish } : {}),
    claims,
    recentControlDecisions,
    activity,
    scheduledWorkIdsByOperator: new Map(
      operators.map((operator) => [
        operator.operatorId,
        work
          .filter(
            (entry) =>
              entry.workId === provisionByOperator.get(operator.operatorId)?.workId ||
              (entry.target.kind === 'operator' && entry.target.operatorId === operator.operatorId),
          )
          .map((entry) => entry.workId),
      ]),
    ),
  };
}

function operatorStatus(
  runtimeStatus: AgentGraphActivationStatus | undefined,
  readiness: AgentGraphClientOperator['readiness'],
  currentRecord: AgentGraphClientActivity | undefined,
): AgentGraphClientOperatorStatus {
  if (runtimeStatus === 'running') {
    return currentRecord?.signals.some((signal) => signal.kind === 'attention')
      ? 'blocked'
      : 'running';
  }
  if (runtimeStatus) return runtimeStatus;
  if (readiness.some((entry) => entry.status === 'runnable')) return 'runnable';
  if (readiness.length > 0) return 'waiting';
  return 'not_started';
}

function graphStatus(
  schedule: AgentGraphScheduleProjection,
  operators: readonly AgentGraphClientOperator[],
  claims: readonly AgentGraphClientClaimRef[],
  activity: readonly AgentGraphClientActivity[],
): AgentGraphClientStatus {
  if (schedule.closed) {
    const terminalRunIds = new Set(
      activity
        .filter((record) => record.signals.some((signal) => signal.kind === 'terminal'))
        .map((record) => record.run.agentRunId),
    );
    const observedRunIds = new Set(activity.map((record) => record.run.agentRunId));
    const unsettledClaim = claims.some(
      (claim) =>
        !terminalRunIds.has(claim.run.agentRunId) &&
        (claim.admissionState !== 'cancelled' || observedRunIds.has(claim.run.agentRunId)),
    );
    const runningOperator = operators.some((operator) =>
      ['running', 'blocked'].includes(operator.status),
    );
    return unsettledClaim || runningOperator ? 'closing' : 'completed';
  }
  if (operators.length === 0 && schedule.work.length === 0) return 'empty';
  if (operators.some((operator) => ['running', 'blocked', 'runnable'].includes(operator.status))) {
    return 'active';
  }
  const activeWork = schedule.work.filter((work) => work.status === 'requested');
  if (activeWork.length === 0 && schedule.stoppedTargets.length > 0) return 'stopped';
  if (
    operators.length > 0 &&
    operators.every((operator) => ['failed', 'aborted', 'cancelled'].includes(operator.status))
  ) {
    return 'failed';
  }
  return 'waiting';
}

function patchedGraphStatus(
  snapshot: AgentGraphClientSnapshot,
  patchedOperator: AgentGraphClientOperator,
): AgentGraphClientStatus {
  const operators = snapshot.operators.map((operator) =>
    operator.operatorId === patchedOperator.operatorId ? patchedOperator : operator,
  );
  if (snapshot.closed) {
    if (
      snapshot.omitted.operators > 0 ||
      snapshot.omitted.claims > 0 ||
      operators.some((operator) => ['running', 'blocked'].includes(operator.status))
    ) {
      return 'closing';
    }
    const operatorByRunId = new Map(
      operators
        .filter((operator) => operator.currentActivation)
        .map((operator) => [operator.currentActivation!.run.agentRunId, operator]),
    );
    return snapshot.claims.every((claim) => {
      if (claim.admissionState === 'cancelled') {
        return !operatorByRunId.has(claim.run.agentRunId);
      }
      const operator = operatorByRunId.get(claim.run.agentRunId);
      return (
        operator !== undefined &&
        ['completed', 'failed', 'aborted', 'cancelled'].includes(operator.status)
      );
    })
      ? 'completed'
      : 'closing';
  }
  return operators.some((operator) => ['running', 'blocked', 'runnable'].includes(operator.status))
    ? 'active'
    : operators.length === 0 && snapshot.work.length === 0
      ? 'empty'
      : snapshot.work.every((work) => work.status !== 'requested') &&
          snapshot.stoppedTargets.length > 0
        ? 'stopped'
        : operators.length > 0 &&
            operators.every((operator) =>
              ['failed', 'aborted', 'cancelled'].includes(operator.status),
            )
          ? 'failed'
          : 'waiting';
}

function projectClientSessionEvent(
  event: SessionEvent,
  activationHadError: boolean,
):
  | {
      facets: AgentGraphRecordFacet[];
      signals: AgentGraphSupervisorSignal[];
      terminalStatus?: Extract<
        AgentGraphActivationStatus,
        'completed' | 'failed' | 'aborted' | 'cancelled'
      >;
    }
  | undefined {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'tool_output_delta':
    case 'tool_progress':
    case 'tool_result_preview':
    case 'queue_update':
    case 'provider_retry':
      return undefined;
    case 'text_complete':
    case 'steering_message':
      return { facets: ['message'], signals: [] };
    case 'thinking_complete':
      return { facets: ['thinking'], signals: [] };
    case 'tool_start':
      return { facets: ['tool_call'], signals: [] };
    case 'tool_result':
      return { facets: ['tool_result'], signals: [] };
    case 'permission_request':
      return {
        facets: ['permission_request'],
        signals: [{ kind: 'attention', reason: 'permission_request' }],
      };
    case 'permission_decision_ack':
      return { facets: ['permission_decision'], signals: [] };
    case 'user_question_request':
      return {
        facets: ['user_question_request'],
        signals: [{ kind: 'attention', reason: 'user_question_request' }],
      };
    case 'token_usage':
      return { facets: ['usage'], signals: [] };
    case 'error':
      return { facets: ['error'], signals: [] };
    case 'abort':
      return {
        facets: ['aborted'],
        signals: [{ kind: 'terminal', status: 'aborted' }],
        terminalStatus: 'aborted',
      };
    case 'complete': {
      const terminalStatus =
        event.stopReason === 'user_stop'
          ? 'aborted'
          : activationHadError || failureClassFromCompleteStopReason(event.stopReason)
            ? 'failed'
            : 'completed';
      return {
        facets: [terminalStatus],
        signals: [{ kind: 'terminal', status: terminalStatus }],
        terminalStatus,
      };
    }
    case 'plan_submitted':
      return { facets: ['runtime_fact'], signals: [] };
  }
}

function clientRuntimeRecordId(runtime: AgentGraphSupervisorRuntimeEvent): string {
  return `graph_record_${stableHash({
    graphId: runtime.intent.graphId,
    operatorId: runtime.claim.targetOperatorId,
    sessionId: runtime.claim.targetSessionId,
    runId: runtime.claim.targetRunId,
    runtimeEventId: runtime.event.id,
  }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function boundOperators(
  operators: readonly AgentGraphClientOperator[],
): AgentGraphClientOperator[] {
  const live = operators.filter(
    (operator) => !['completed', 'failed', 'aborted', 'cancelled'].includes(operator.status),
  );
  const terminal = operators
    .filter((operator) => ['completed', 'failed', 'aborted', 'cancelled'].includes(operator.status))
    .sort(
      (a, b) =>
        (a.currentActivation?.lastEventTime ?? a.provisionedAt) -
          (b.currentActivation?.lastEventTime ?? b.provisionedAt) ||
        compareIdentity(a.operatorId, b.operatorId),
    );
  if (live.length >= MAX_VISIBLE_OPERATORS) {
    return live.slice(0, MAX_VISIBLE_OPERATORS);
  }
  return [...live, ...terminal.slice(-(MAX_VISIBLE_OPERATORS - live.length))];
}

function boundWork(
  work: readonly AgentGraphClientScheduledWork[],
): AgentGraphClientScheduledWork[] {
  const live = work.filter((entry) => entry.status === 'requested');
  const terminal = work.filter((entry) => entry.status !== 'requested');
  if (live.length >= MAX_VISIBLE_WORK) return live.slice(0, MAX_VISIBLE_WORK);
  return [...live, ...terminal.slice(-(MAX_VISIBLE_WORK - live.length))];
}

function terminalHistoryPage(
  graphId: string,
  activity: readonly AgentGraphClientActivity[],
  cursor: string | undefined,
): AgentGraphClientTerminalHistoryPage {
  const terminal = terminalActivities(activity);
  let start = 0;
  if (cursor !== undefined) {
    const decoded = decodeAgentGraphTerminalCursor(cursor);
    if (decoded.graphId !== graphId) {
      throw new Error('Agent graph terminal history cursor belongs to another graph');
    }
    const index = terminal.findIndex(
      (record) => record.recordId === decoded.recordId && record.eventTime === decoded.eventTime,
    );
    if (index < 0) {
      throw new Error('Agent graph terminal history cursor is stale or invalid');
    }
    start = index + 1;
  }
  const records = terminal.slice(start, start + AGENT_GRAPH_CLIENT_TERMINAL_PAGE_SIZE);
  const hasMore = start + records.length < terminal.length;
  return {
    records,
    ...(hasMore && records.length > 0
      ? {
          nextCursor: encodeAgentGraphTerminalCursor(graphId, records[records.length - 1]!),
        }
      : {}),
  };
}

function terminalActivities(
  activity: readonly AgentGraphClientActivity[],
): AgentGraphClientActivity[] {
  return activity
    .filter((record) => record.signals.some((signal) => signal.kind === 'terminal'))
    .sort((a, b) => b.eventTime - a.eventTime || compareIdentity(b.recordId, a.recordId));
}

export function materializedAgentGraphTerminalHistoryPage(
  graphId: string,
  records: readonly AgentGraphClientActivity[],
  hasMore: boolean,
): AgentGraphClientTerminalHistoryPage {
  return {
    records: records.map((record) => structuredClone(record)),
    ...(hasMore && records.length > 0
      ? {
          nextCursor: encodeAgentGraphTerminalCursor(graphId, records[records.length - 1]!),
        }
      : {}),
  };
}

function clientWork(work: AgentGraphScheduleWorkView): AgentGraphClientScheduledWork {
  const instructionTruncated = work.instruction.length > MAX_INSTRUCTION_PREVIEW_CHARS;
  return {
    workId: work.workId,
    target: { ...work.target },
    inputIds: [...work.inputIds],
    ...(work.selectedResultInputs
      ? { selectedResultInputs: work.selectedResultInputs.map((input) => ({ ...input })) }
      : {}),
    ...(work.replaces ? { replaces: work.replaces } : {}),
    status: work.status,
    instructionPreview: instructionTruncated
      ? `${work.instruction.slice(0, MAX_INSTRUCTION_PREVIEW_CHARS)}…`
      : work.instruction,
    instructionTruncated,
    revision: work.revision,
    committedAt: work.committedAt,
  };
}

function clientStoppedTarget(stopped: AgentGraphStoppedTargetView): AgentGraphClientStoppedTarget {
  return {
    targetId: stopped.targetId,
    reason: stopped.reason,
    revision: stopped.revision,
    committedAt: stopped.committedAt,
  };
}

function clientFinish(finish: AgentGraphScheduleFinishView): AgentGraphClientFinish {
  return {
    resultIds: [...finish.resultIds],
    reason: finish.reason,
    revision: finish.revision,
    committedAt: finish.committedAt,
  };
}

function clientClaims(
  graphId: string,
  claims: readonly AgentGraphIntentClaim[],
  admissions: readonly AgentGraphClientClaimAdmission[],
): AgentGraphClientClaimRef[] {
  const admissionByIntent = new Map<string, AgentGraphClientClaimAdmission['state']>();
  for (const admission of admissions) {
    if (admissionByIntent.has(admission.intentId)) {
      throw new Error(`Duplicate agent graph admission for ${admission.intentId}`);
    }
    admissionByIntent.set(admission.intentId, admission.state);
  }
  return [...claims]
    .sort((a, b) => a.claimedAt - b.claimedAt || compareIdentity(a.claimId, b.claimId))
    .map((claim) => {
      if (claim.graphId !== graphId) {
        throw new Error(`Agent graph claim ${claim.claimId} belongs to another graph`);
      }
      return {
        claimId: claim.claimId,
        intentId: claim.intentId,
        operatorId: claim.targetOperatorId,
        childSessionId: claim.targetSessionId,
        run: {
          sessionId: claim.targetSessionId,
          agentRunId: claim.targetRunId,
          turnId: claim.targetTurnId,
        },
        admissionState: admissionByIntent.get(claim.intentId) ?? 'executing',
        claimedAt: claim.claimedAt,
      };
    });
}

function clientActivity(record: AgentGraphRecord): AgentGraphClientActivity {
  return {
    recordId: record.recordId,
    operatorId: record.operatorId,
    activationId: record.activationId,
    eventTime: record.eventTime,
    facets: [...record.facets],
    signals: record.supervisorSignals.map((signal) => ({ ...signal })),
    run: {
      sessionId: record.sessionId,
      agentRunId: record.agentRunId,
      turnId: record.source.turnId,
    },
  };
}

function runRefForActivation(
  sessionId: string,
  agentRunId: string,
  claim: AgentGraphClientClaimRef | undefined,
  records: readonly AgentGraphClientActivity[],
): AgentGraphClientRunRef {
  const turnId =
    claim?.run.turnId ?? records.find((record) => record.run.agentRunId === agentRunId)?.run.turnId;
  return {
    sessionId,
    agentRunId,
    ...(turnId ? { turnId } : {}),
  };
}

function provisionsByOperator(
  graphId: string,
  provisions: readonly AgentGraphOperatorProvision[],
): Map<string, AgentGraphOperatorProvision> {
  const result = new Map<string, AgentGraphOperatorProvision>();
  for (const provision of [...provisions].sort(
    (a, b) => a.provisionedAt - b.provisionedAt || compareIdentity(a.provisionId, b.provisionId),
  )) {
    if (provision.graphId !== graphId) {
      throw new Error(`Agent graph provision ${provision.provisionId} belongs to another graph`);
    }
    const existing = result.get(provision.operatorId);
    if (
      existing &&
      (existing.targetSessionId !== provision.targetSessionId ||
        existing.agentId !== provision.agentId)
    ) {
      throw new Error(
        `Agent graph operator ${provision.operatorId} has conflicting durable provisions`,
      );
    }
    result.set(provision.operatorId, provision);
  }
  return result;
}

function uniqueEdges(
  graphId: string,
  provisions: readonly AgentGraphOperatorProvision[],
): AgentGraphClientEdge[] {
  const edges = new Map<string, AgentGraphClientEdge>();
  for (const provision of provisions) {
    if (provision.graphId !== graphId) {
      throw new Error(`Agent graph provision ${provision.provisionId} belongs to another graph`);
    }
    for (const edge of provision.edges) {
      const existing = edges.get(edge.edgeId);
      if (
        existing &&
        (existing.fromOperatorId !== edge.fromOperatorId ||
          existing.toOperatorId !== edge.toOperatorId)
      ) {
        throw new Error(`Agent graph edge ${edge.edgeId} has conflicting endpoints`);
      }
      edges.set(edge.edgeId, { ...edge });
    }
  }
  return [...edges.values()].sort((a, b) => compareIdentity(a.edgeId, b.edgeId));
}

function assertObservation(graphId: string, observation: AgentGraphSupervisorObservation): void {
  if (
    observation.projection.graphId !== graphId ||
    observation.readiness.graphId !== graphId ||
    observation.readiness.trace.graphId !== graphId
  ) {
    throw new Error('Agent graph client observation belongs to another graph');
  }
}

function cloneWait(wait: AgentGraphReadinessWait): AgentGraphReadinessWait {
  return wait.kind === 'input_route'
    ? { ...wait, upstreamOperatorIds: [...wait.upstreamOperatorIds] }
    : { ...wait };
}

export function encodeAgentGraphTerminalCursor(
  graphId: string,
  activity: Pick<AgentGraphClientActivity, 'recordId' | 'eventTime'>,
): string {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION,
      graphId,
      recordId: activity.recordId,
      eventTime: activity.eventTime,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeAgentGraphTerminalCursor(cursor: string): {
  graphId: string;
  recordId: string;
  eventTime: number;
} {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > 2_048 ||
    cursor.trim() !== cursor
  ) {
    throw new Error('Invalid agent graph terminal history cursor');
  }
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const canonical = Buffer.from(json, 'utf8').toString('base64url');
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      canonical !== cursor ||
      Object.keys(value).sort().join(',') !== 'eventTime,graphId,recordId,schemaVersion' ||
      value.schemaVersion !== AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION ||
      typeof value.eventTime !== 'number' ||
      !Number.isSafeInteger(value.eventTime) ||
      value.eventTime < 0
    ) {
      throw new Error('invalid cursor envelope');
    }
    return {
      graphId: requireIdentity(value.graphId, 'cursor graph id'),
      recordId: requireIdentity(value.recordId, 'cursor record id'),
      eventTime: value.eventTime,
    };
  } catch {
    throw new Error('Invalid agent graph terminal history cursor');
  }
}

export function decodeMaterializedAgentGraphClientSnapshot(
  value: unknown,
  expected: {
    rootSessionId: string;
    graphId: string;
    snapshotVersion: string;
  },
): AgentGraphClientSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid materialized agent graph client snapshot');
  }
  const snapshot = value as Partial<AgentGraphClientSnapshot>;
  if (
    snapshot.schemaVersion !== AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION ||
    snapshot.rootSessionId !== expected.rootSessionId ||
    snapshot.graphId !== expected.graphId ||
    (snapshot.orchestrationMode !== 'graph' && snapshot.orchestrationMode !== 'swarm') ||
    snapshot.snapshotVersion !== expected.snapshotVersion ||
    !Array.isArray(snapshot.operators) ||
    !Array.isArray(snapshot.edges) ||
    !Array.isArray(snapshot.work) ||
    !Array.isArray(snapshot.reconciliationFailures) ||
    !Array.isArray(snapshot.stoppedTargets) ||
    !Array.isArray(snapshot.claims) ||
    !Array.isArray(snapshot.recentControlDecisions) ||
    !Array.isArray(snapshot.recentActivity) ||
    !snapshot.terminalHistory ||
    !Array.isArray(snapshot.terminalHistory.records)
  ) {
    throw new Error('Invalid materialized agent graph client snapshot');
  }
  return structuredClone(snapshot as AgentGraphClientSnapshot);
}

export function decodeMaterializedAgentGraphOperatorInspection(
  value: unknown,
  expected: {
    rootSessionId: string;
    graphId: string;
    operatorId: string;
    snapshotVersion: string;
  },
): AgentGraphOperatorInspection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid materialized agent graph operator inspection');
  }
  const inspection = value as Partial<AgentGraphOperatorInspection>;
  if (
    inspection.schemaVersion !== AGENT_GRAPH_CLIENT_SNAPSHOT_SCHEMA_VERSION ||
    inspection.rootSessionId !== expected.rootSessionId ||
    inspection.graphId !== expected.graphId ||
    inspection.snapshotVersion !== expected.snapshotVersion ||
    inspection.operator?.operatorId !== expected.operatorId ||
    !Array.isArray(inspection.inboundEdges) ||
    !Array.isArray(inspection.outboundEdges) ||
    !Array.isArray(inspection.work) ||
    !Array.isArray(inspection.claims) ||
    !Array.isArray(inspection.activations) ||
    !Array.isArray(inspection.recentRecords)
  ) {
    throw new Error('Invalid materialized agent graph operator inspection');
  }
  return structuredClone(inspection as AgentGraphOperatorInspection);
}

export function decodeMaterializedAgentGraphClientActivity(
  value: unknown,
  expected: {
    graphId: string;
    recordId: string;
    eventTime: number;
  },
): AgentGraphClientActivity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid materialized agent graph client activity');
  }
  const activity = value as Partial<AgentGraphClientActivity>;
  if (
    activity.recordId !== expected.recordId ||
    activity.eventTime !== expected.eventTime ||
    !activity.operatorId ||
    !activity.activationId ||
    !Array.isArray(activity.facets) ||
    !Array.isArray(activity.signals) ||
    !activity.run ||
    typeof activity.run.sessionId !== 'string' ||
    typeof activity.run.agentRunId !== 'string'
  ) {
    throw new Error(`Invalid materialized agent graph client activity for ${expected.graphId}`);
  }
  return structuredClone(activity as AgentGraphClientActivity);
}

function requireIdentity(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Invalid agent graph ${name}`);
  }
  return value;
}

function compareActivityKey(
  eventTimeA: number,
  recordIdA: string,
  eventTimeB: number,
  recordIdB: string,
): number {
  return eventTimeA - eventTimeB || compareIdentity(recordIdA, recordIdB);
}

function compareClientActivity(
  a: Pick<AgentGraphClientActivity, 'eventTime' | 'recordId'>,
  b: Pick<AgentGraphClientActivity, 'eventTime' | 'recordId'>,
): number {
  return compareActivityKey(a.eventTime, a.recordId, b.eventTime, b.recordId);
}

function clientSnapshotVersion(snapshot: AgentGraphClientSnapshot): string {
  const {
    snapshotVersion: _snapshotVersion,
    terminalHistory: _terminalHistory,
    ...boundedContent
  } = snapshot;
  return stableHash(boundedContent);
}

function normalizeReconciliationFailures(
  failures: readonly AgentGraphClientReconciliationFailure[],
): AgentGraphClientReconciliationFailure[] {
  const byWorkId = new Map<string, AgentGraphClientReconciliationFailure>();
  for (const failure of failures) {
    const workId = requireIdentity(failure.workId, 'reconciliation failure work id');
    const reason = failure.reason.trim().slice(0, MAX_RECONCILIATION_FAILURE_REASON_CHARS);
    if (!reason) continue;
    byWorkId.set(workId, { workId, phase: failure.phase, reason });
  }
  return [...byWorkId.values()].sort((a, b) => compareIdentity(a.workId, b.workId));
}

function compareIdentity(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
