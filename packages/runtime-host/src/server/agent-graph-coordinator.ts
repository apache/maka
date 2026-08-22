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
  AgentGraphClientOperationError,
  type AgentGraphClientChangedEvent,
  type AgentGraphCoordinator,
} from '@maka/runtime/stream-graph-coordinator';
import {
  encodeAgentGraphTerminalCursor,
  type AgentGraphClientOperator as RuntimeAgentGraphClientOperator,
  type AgentGraphClientSnapshot as RuntimeAgentGraphClientSnapshot,
  type AgentGraphOperatorInspection as RuntimeAgentGraphOperatorInspection,
} from '@maka/runtime/stream-graph-read-model';
import { isSessionNotFoundError } from '@maka/storage/execution-stores';
import {
  AGENT_GRAPH_MAX_ACTIVITY,
  AGENT_GRAPH_MAX_CLAIMS,
  AGENT_GRAPH_MAX_CONTROL_DECISIONS,
  AGENT_GRAPH_MAX_EDGES,
  AGENT_GRAPH_MAX_INPUT_ROUTE_OPERATORS,
  AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS,
  AGENT_GRAPH_MAX_INSPECTION_CLAIMS,
  AGENT_GRAPH_MAX_INSPECTION_EDGES,
  AGENT_GRAPH_MAX_INSPECTION_RECORDS,
  AGENT_GRAPH_MAX_INSPECTION_WORK,
  AGENT_GRAPH_MAX_OPERATORS,
  AGENT_GRAPH_MAX_OPERATOR_READINESS,
  AGENT_GRAPH_MAX_OPERATOR_REFS,
  AGENT_GRAPH_MAX_READINESS_WAITS,
  AGENT_GRAPH_MAX_RECONCILIATION_FAILURES,
  AGENT_GRAPH_MAX_STOPPED_TARGETS,
  AGENT_GRAPH_MAX_TERMINAL_ACTIVITY,
  AGENT_GRAPH_MAX_WORK,
  AGENT_GRAPH_EPOCH_PAGE_SIZE,
  AGENT_GRAPH_RESULT_MAX_BYTES,
  type AgentGraphClientOperator,
  type AgentGraphClientSnapshot,
  type AgentGraphEpochListInput,
  type AgentGraphOperatorInspection,
  type AgentGraphOperatorQueryInput,
  type AgentGraphQueryInput,
  type AgentGraphStopInput,
  type OperationOutcome,
} from '../protocol/index.js';
import type { AgentGraphOperationHandlerMap } from './operation-dispatcher.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

type AgentGraphAuthority = Pick<
  AgentGraphCoordinator,
  | 'currentGraphId'
  | 'getGraphSnapshot'
  | 'getSnapshot'
  | 'inspectGraphOperator'
  | 'inspectOperator'
  | 'listGraphEpochPage'
  | 'subscribeAll'
>;

type GraphContinuity = Pick<SessionContinuityCoordinator, 'enqueueAgentGraphChanged'>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

type RootOperationFailureCode = AgentGraphClientOperationError['code'];

type GraphQueryFailureCode =
  | Exclude<RootOperationFailureCode, 'session_archived'>
  | 'persistence_failed';

/** Client-facing Runtime Host adapter over the durable Agent Graph read model. */
export class HostAgentGraphCoordinator {
  readonly handlers: AgentGraphOperationHandlerMap = {
    'agent.graph.epochs.query': (input) => this.#queryEpochs(input),
    'agent.graph.query': (input) => this.#query(input),
    'agent.graph.operator.query': (input) => this.#queryOperator(input),
    'agent.graph.stop': (input) => this.#stop(input),
  };

  readonly #authority: AgentGraphAuthority;
  readonly #stopExecution: (rootSessionId: string, expectedGraphId?: string) => Promise<void>;
  #unsubscribe: (() => void) | undefined;

  constructor(options: {
    authority: AgentGraphAuthority;
    continuity: GraphContinuity;
    stopExecution: (rootSessionId: string, expectedGraphId?: string) => Promise<void>;
  }) {
    this.#authority = options.authority;
    this.#stopExecution = options.stopExecution;
    this.#unsubscribe = options.authority.subscribeAll((event) =>
      options.continuity.enqueueAgentGraphChanged(projectChangedEvent(event)),
    );
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #query(input: AgentGraphQueryInput): Promise<OperationOutcome<'agent.graph.query'>> {
    try {
      const options = input.terminalCursor ? { terminalCursor: input.terminalCursor } : {};
      const snapshot = input.graphId
        ? await this.#authority.getGraphSnapshot(input.rootSessionId, input.graphId, options)
        : await this.#authority.getSnapshot(input.rootSessionId, options);
      return { ok: true, result: projectSnapshot(snapshot) };
    } catch (error) {
      return graphQueryFailure(error);
    }
  }

  async #queryOperator(
    input: AgentGraphOperatorQueryInput,
  ): Promise<OperationOutcome<'agent.graph.operator.query'>> {
    try {
      const inspection = input.graphId
        ? await this.#authority.inspectGraphOperator(
            input.rootSessionId,
            input.graphId,
            input.operatorId,
          )
        : await this.#authority.inspectOperator(input.rootSessionId, input.operatorId);
      return { ok: true, result: projectInspection(inspection) };
    } catch (error) {
      return graphQueryFailure(error);
    }
  }

  async #queryEpochs(
    input: AgentGraphEpochListInput,
  ): Promise<OperationOutcome<'agent.graph.epochs.query'>> {
    try {
      const page = await this.#authority.listGraphEpochPage(input.rootSessionId, {
        ...(input.beforeEpoch === undefined ? {} : { beforeEpoch: input.beforeEpoch }),
        limit: AGENT_GRAPH_EPOCH_PAGE_SIZE,
      });
      if (input.beforeEpoch !== undefined && input.beforeEpoch > page.currentEpoch) {
        throw new AgentGraphClientOperationError(
          'invalid_request',
          `Agent graph epoch cursor ${input.beforeEpoch} is ahead of current epoch ${page.currentEpoch}`,
        );
      }
      return {
        ok: true,
        result: {
          rootSessionId: input.rootSessionId,
          epochs: page.epochs.map((binding) => ({
            epoch: binding.epoch,
            graphId: binding.graphId,
            createdAt: binding.createdAt,
            current: binding.epoch === page.currentEpoch,
          })),
          nextBeforeEpoch: page.nextBeforeEpoch,
        },
      };
    } catch (error) {
      return graphQueryFailure(error);
    }
  }

  async #stop(input: AgentGraphStopInput): Promise<OperationOutcome<'agent.graph.stop'>> {
    try {
      await this.#stopExecution(input.rootSessionId, input.expectedGraphId);
      const graphId =
        input.expectedGraphId ?? (await this.#authority.currentGraphId(input.rootSessionId));
      return {
        ok: true,
        result: {
          rootSessionId: input.rootSessionId,
          graphId,
        },
      };
    } catch (error) {
      if (error instanceof AgentGraphClientOperationError || isSessionNotFoundError(error)) {
        const code = error instanceof AgentGraphClientOperationError ? error.code : 'not_found';
        if (code === 'invalid_request') {
          return failure('internal_failure', 'Agent graph stop failed');
        }
        return failure(code, error instanceof Error ? error.message : 'Session was not found');
      }
      return failure('internal_failure', 'Agent graph stop failed');
    }
  }
}

export function projectAgentGraphClientSnapshot(
  snapshot: RuntimeAgentGraphClientSnapshot,
): AgentGraphClientSnapshot {
  return projectSnapshot(snapshot);
}

export function projectAgentGraphOperatorInspection(
  inspection: RuntimeAgentGraphOperatorInspection,
): AgentGraphOperatorInspection {
  return projectInspection(inspection);
}

function projectSnapshot(snapshot: RuntimeAgentGraphClientSnapshot): AgentGraphClientSnapshot {
  const operators = snapshot.operators.slice(0, AGENT_GRAPH_MAX_OPERATORS).map(projectOperator);
  const visibleOperatorIds = new Set(operators.map((operator) => operator.operatorId));
  const candidateEdges = snapshot.edges.filter(
    (edge) =>
      visibleOperatorIds.has(edge.fromOperatorId) && visibleOperatorIds.has(edge.toOperatorId),
  );
  const projected: Mutable<AgentGraphClientSnapshot> = {
    schemaVersion: 1,
    rootSessionId: snapshot.rootSessionId,
    graphId: snapshot.graphId,
    orchestrationMode: snapshot.orchestrationMode,
    snapshotVersion: requireFingerprint(snapshot.snapshotVersion),
    status: snapshot.status,
    scheduleRevision: snapshot.scheduleRevision,
    topologyFingerprint: requireFingerprint(snapshot.topologyFingerprint),
    closed: snapshot.closed,
    ...(snapshot.latestEventTime === undefined
      ? {}
      : { latestEventTime: snapshot.latestEventTime }),
    operators,
    edges: candidateEdges.slice(0, AGENT_GRAPH_MAX_EDGES).map(projectEdge),
    work: snapshot.work.slice(0, AGENT_GRAPH_MAX_WORK).map(projectWork),
    reconciliationFailures: snapshot.reconciliationFailures
      .slice(-AGENT_GRAPH_MAX_RECONCILIATION_FAILURES)
      .map((failure) => ({ ...failure })),
    stoppedTargets: snapshot.stoppedTargets
      .slice(-AGENT_GRAPH_MAX_STOPPED_TARGETS)
      .map(projectStoppedTarget),
    ...(snapshot.finish ? { finish: projectFinish(snapshot.finish) } : {}),
    claims: snapshot.claims.slice(-AGENT_GRAPH_MAX_CLAIMS).map(projectClaim),
    recentControlDecisions: snapshot.recentControlDecisions
      .slice(-AGENT_GRAPH_MAX_CONTROL_DECISIONS)
      .map(projectControlDecision),
    recentActivity: snapshot.recentActivity.slice(-AGENT_GRAPH_MAX_ACTIVITY).map(projectActivity),
    terminalHistory: {
      records: snapshot.terminalHistory.records
        .slice(0, AGENT_GRAPH_MAX_TERMINAL_ACTIVITY)
        .map(projectActivity),
      ...(snapshot.terminalHistory.nextCursor
        ? { nextCursor: snapshot.terminalHistory.nextCursor }
        : {}),
    },
    omitted: {
      operators: snapshot.omitted.operators + snapshot.operators.length - operators.length,
      edges:
        snapshot.omitted.edges +
        snapshot.edges.length -
        Math.min(candidateEdges.length, AGENT_GRAPH_MAX_EDGES),
      work: snapshot.omitted.work + Math.max(0, snapshot.work.length - AGENT_GRAPH_MAX_WORK),
      reconciliationFailures:
        snapshot.omitted.reconciliationFailures +
        Math.max(
          0,
          snapshot.reconciliationFailures.length - AGENT_GRAPH_MAX_RECONCILIATION_FAILURES,
        ),
      stoppedTargets:
        snapshot.omitted.stoppedTargets +
        Math.max(0, snapshot.stoppedTargets.length - AGENT_GRAPH_MAX_STOPPED_TARGETS),
      claims:
        snapshot.omitted.claims + Math.max(0, snapshot.claims.length - AGENT_GRAPH_MAX_CLAIMS),
      controlDecisions:
        snapshot.omitted.controlDecisions +
        Math.max(0, snapshot.recentControlDecisions.length - AGENT_GRAPH_MAX_CONTROL_DECISIONS),
      recentActivity:
        snapshot.omitted.recentActivity +
        Math.max(0, snapshot.recentActivity.length - AGENT_GRAPH_MAX_ACTIVITY),
    },
  };
  if (snapshot.terminalHistory.records.length > projected.terminalHistory.records.length) {
    updateTerminalCursor(projected);
  }
  fitSnapshot(projected);
  return projected;
}

function projectInspection(
  inspection: RuntimeAgentGraphOperatorInspection,
): AgentGraphOperatorInspection {
  const projected: Mutable<AgentGraphOperatorInspection> = {
    schemaVersion: 1,
    rootSessionId: inspection.rootSessionId,
    graphId: inspection.graphId,
    snapshotVersion: requireFingerprint(inspection.snapshotVersion),
    operator: projectOperator(inspection.operator),
    inboundEdges: inspection.inboundEdges.slice(-AGENT_GRAPH_MAX_INSPECTION_EDGES).map(projectEdge),
    outboundEdges: inspection.outboundEdges
      .slice(-AGENT_GRAPH_MAX_INSPECTION_EDGES)
      .map(projectEdge),
    work: inspection.work.slice(-AGENT_GRAPH_MAX_INSPECTION_WORK).map(projectWork),
    claims: inspection.claims.slice(-AGENT_GRAPH_MAX_INSPECTION_CLAIMS).map(projectClaim),
    activations: inspection.activations
      .slice(-AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS)
      .map(projectActivation),
    recentRecords: inspection.recentRecords
      .slice(-AGENT_GRAPH_MAX_INSPECTION_RECORDS)
      .map(projectActivity),
    omitted: {
      inboundEdges:
        inspection.omitted.inboundEdges +
        Math.max(0, inspection.inboundEdges.length - AGENT_GRAPH_MAX_INSPECTION_EDGES),
      outboundEdges:
        inspection.omitted.outboundEdges +
        Math.max(0, inspection.outboundEdges.length - AGENT_GRAPH_MAX_INSPECTION_EDGES),
      work:
        inspection.omitted.work +
        Math.max(0, inspection.work.length - AGENT_GRAPH_MAX_INSPECTION_WORK),
      claims:
        inspection.omitted.claims +
        Math.max(0, inspection.claims.length - AGENT_GRAPH_MAX_INSPECTION_CLAIMS),
      activations:
        inspection.omitted.activations +
        Math.max(0, inspection.activations.length - AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS),
      records:
        inspection.omitted.records +
        Math.max(0, inspection.recentRecords.length - AGENT_GRAPH_MAX_INSPECTION_RECORDS),
    },
  };
  fitInspection(projected);
  return projected;
}

function projectOperator(
  operator: RuntimeAgentGraphClientOperator,
): Mutable<AgentGraphClientOperator> {
  const readiness = operator.readiness.slice(0, AGENT_GRAPH_MAX_OPERATOR_READINESS).map((entry) => {
    const eligibleWaits = entry.waitingFor.filter(
      (wait) =>
        wait.kind !== 'input_route' ||
        wait.upstreamOperatorIds.length <= AGENT_GRAPH_MAX_INPUT_ROUTE_OPERATORS,
    );
    const waitingFor = eligibleWaits
      .slice(0, AGENT_GRAPH_MAX_READINESS_WAITS)
      .map(projectReadinessWait);
    return {
      readinessId: entry.readinessId,
      status: entry.status,
      waitingFor,
      omittedWaitingFor: entry.omittedWaitingFor + entry.waitingFor.length - waitingFor.length,
    };
  });
  const extraOmittedWaits = operator.readiness
    .slice(0, AGENT_GRAPH_MAX_OPERATOR_READINESS)
    .reduce((count, entry, index) => {
      const visible = readiness[index]?.waitingFor.length ?? 0;
      return count + entry.waitingFor.length - visible;
    }, 0);
  const omittedReadinessWaits = operator.readiness
    .slice(AGENT_GRAPH_MAX_OPERATOR_READINESS)
    .reduce((count, entry) => count + entry.waitingFor.length, 0);
  const inboundEdgeIds = operator.inboundEdgeIds.slice(-AGENT_GRAPH_MAX_OPERATOR_REFS);
  const outboundEdgeIds = operator.outboundEdgeIds.slice(-AGENT_GRAPH_MAX_OPERATOR_REFS);
  const scheduledWorkIds = operator.scheduledWorkIds.slice(-AGENT_GRAPH_MAX_OPERATOR_REFS);
  return {
    operatorId: operator.operatorId,
    childSessionId: operator.childSessionId,
    provisionId: operator.provisionId,
    agentId: operator.agentId,
    provisionedAt: operator.provisionedAt,
    status: operator.status,
    inboundEdgeIds,
    outboundEdgeIds,
    scheduledWorkIds,
    readiness,
    omitted: {
      inboundEdgeIds:
        operator.omitted.inboundEdgeIds + operator.inboundEdgeIds.length - inboundEdgeIds.length,
      outboundEdgeIds:
        operator.omitted.outboundEdgeIds + operator.outboundEdgeIds.length - outboundEdgeIds.length,
      scheduledWorkIds:
        operator.omitted.scheduledWorkIds +
        operator.scheduledWorkIds.length -
        scheduledWorkIds.length,
      readiness: operator.omitted.readiness + operator.readiness.length - readiness.length,
      readinessWaits: operator.omitted.readinessWaits + extraOmittedWaits + omittedReadinessWaits,
    },
    ...(operator.currentActivation
      ? {
          currentActivation: {
            activationId: operator.currentActivation.activationId,
            status: operator.currentActivation.status,
            recordCount: operator.currentActivation.recordCount,
            firstEventTime: operator.currentActivation.firstEventTime,
            lastEventTime: operator.currentActivation.lastEventTime,
            ...(operator.currentActivation.terminalRecordId
              ? { terminalRecordId: operator.currentActivation.terminalRecordId }
              : {}),
            run: projectRunRef(operator.currentActivation.run),
          },
        }
      : {}),
  };
}

function projectReadinessWait(
  wait: RuntimeAgentGraphClientOperator['readiness'][number]['waitingFor'][number],
): Mutable<AgentGraphClientOperator['readiness'][number]['waitingFor'][number]> {
  return wait.kind === 'input_route'
    ? { kind: wait.kind, upstreamOperatorIds: [...wait.upstreamOperatorIds] }
    : {
        kind: wait.kind,
        operatorId: wait.operatorId,
        activationId: wait.activationId,
      };
}

function projectEdge(
  edge: RuntimeAgentGraphClientSnapshot['edges'][number],
): Mutable<AgentGraphClientSnapshot['edges'][number]> {
  return {
    edgeId: edge.edgeId,
    fromOperatorId: edge.fromOperatorId,
    toOperatorId: edge.toOperatorId,
  };
}

function projectWork(
  work: RuntimeAgentGraphClientSnapshot['work'][number],
): Mutable<AgentGraphClientSnapshot['work'][number]> {
  return {
    workId: work.workId,
    target:
      work.target.kind === 'agent'
        ? { kind: work.target.kind, agentId: work.target.agentId }
        : work.target.kind === 'preset'
          ? { kind: work.target.kind, presetId: work.target.presetId }
          : { kind: work.target.kind, operatorId: work.target.operatorId },
    inputIds: [...work.inputIds],
    ...(work.selectedResultInputs
      ? { selectedResultInputs: work.selectedResultInputs.map((input) => ({ ...input })) }
      : {}),
    ...(work.replaces ? { replaces: work.replaces } : {}),
    status: work.status,
    instructionPreview: work.instructionPreview,
    instructionTruncated: work.instructionTruncated,
    revision: work.revision,
    committedAt: work.committedAt,
  };
}

function projectStoppedTarget(
  target: RuntimeAgentGraphClientSnapshot['stoppedTargets'][number],
): Mutable<AgentGraphClientSnapshot['stoppedTargets'][number]> {
  return {
    targetId: target.targetId,
    reason: target.reason,
    revision: target.revision,
    committedAt: target.committedAt,
  };
}

function projectFinish(
  finish: NonNullable<RuntimeAgentGraphClientSnapshot['finish']>,
): Mutable<NonNullable<AgentGraphClientSnapshot['finish']>> {
  return {
    resultIds: [...finish.resultIds],
    reason: finish.reason,
    revision: finish.revision,
    committedAt: finish.committedAt,
  };
}

function projectClaim(
  claim: RuntimeAgentGraphClientSnapshot['claims'][number],
): Mutable<AgentGraphClientSnapshot['claims'][number]> {
  return {
    claimId: claim.claimId,
    intentId: claim.intentId,
    operatorId: claim.operatorId,
    childSessionId: claim.childSessionId,
    run: projectRunRef(claim.run),
    admissionState: claim.admissionState,
    claimedAt: claim.claimedAt,
  };
}

function projectControlDecision(
  decision: RuntimeAgentGraphClientSnapshot['recentControlDecisions'][number],
): Mutable<AgentGraphClientSnapshot['recentControlDecisions'][number]> {
  return {
    updateId: decision.updateId,
    revision: decision.revision,
    committedAt: decision.committedAt,
    source: {
      sessionId: decision.source.sessionId,
      agentRunId: decision.source.agentRunId,
      turnId: decision.source.turnId,
      toolCallId: decision.source.toolCallId,
    },
    addedWorkIds: [...decision.addedWorkIds],
    stoppedTargetIds: [...decision.stoppedTargetIds],
    selectedResultIds: [...decision.selectedResultIds],
  };
}

function projectActivity(
  activity: RuntimeAgentGraphClientSnapshot['recentActivity'][number],
): Mutable<AgentGraphClientSnapshot['recentActivity'][number]> {
  return {
    recordId: activity.recordId,
    operatorId: activity.operatorId,
    activationId: activity.activationId,
    eventTime: activity.eventTime,
    facets: [...activity.facets],
    signals: activity.signals.map((signal) =>
      signal.kind === 'attention'
        ? { kind: signal.kind, reason: signal.reason }
        : { kind: signal.kind, status: signal.status },
    ),
    run: projectRunRef(activity.run),
  };
}

function projectActivation(
  activation: RuntimeAgentGraphOperatorInspection['activations'][number],
): Mutable<AgentGraphOperatorInspection['activations'][number]> {
  return {
    activationId: activation.activationId,
    status: activation.status,
    recordCount: activation.recordCount,
    firstEventTime: activation.firstEventTime,
    lastEventTime: activation.lastEventTime,
    lastRecordId: activation.lastRecordId,
    ...(activation.terminalRecordId ? { terminalRecordId: activation.terminalRecordId } : {}),
    run: projectRunRef(activation.run),
  };
}

function projectRunRef(
  run: RuntimeAgentGraphClientSnapshot['recentActivity'][number]['run'],
): Mutable<AgentGraphClientSnapshot['recentActivity'][number]['run']> {
  return {
    sessionId: run.sessionId,
    agentRunId: run.agentRunId,
    ...(run.turnId ? { turnId: run.turnId } : {}),
  };
}

function fitSnapshot(snapshot: Mutable<AgentGraphClientSnapshot>): void {
  while (encodedBytes(snapshot) > AGENT_GRAPH_RESULT_MAX_BYTES) {
    if (snapshot.terminalHistory.records.length > 1) {
      snapshot.terminalHistory.records.pop();
      updateTerminalCursor(snapshot);
      continue;
    }
    if (snapshot.recentActivity.shift()) {
      snapshot.omitted.recentActivity += 1;
      continue;
    }
    if (snapshot.recentControlDecisions.shift()) {
      snapshot.omitted.controlDecisions += 1;
      continue;
    }
    if (snapshot.stoppedTargets.shift()) {
      snapshot.omitted.stoppedTargets += 1;
      continue;
    }
    if (snapshot.reconciliationFailures.shift()) {
      snapshot.omitted.reconciliationFailures += 1;
      continue;
    }
    if (snapshot.claims.shift()) {
      snapshot.omitted.claims += 1;
      continue;
    }
    const terminalWorkIndex = snapshot.work.findIndex((entry) => entry.status !== 'requested');
    const removedWork = snapshot.work.splice(
      terminalWorkIndex < 0 ? snapshot.work.length - 1 : terminalWorkIndex,
      1,
    )[0];
    if (removedWork) {
      snapshot.omitted.work += 1;
      continue;
    }
    if (snapshot.edges.pop()) {
      snapshot.omitted.edges += 1;
      continue;
    }
    const terminalOperatorIndex = snapshot.operators.findIndex((entry) =>
      ['completed', 'failed', 'aborted', 'cancelled'].includes(entry.status),
    );
    const operator = snapshot.operators.splice(
      terminalOperatorIndex < 0 ? snapshot.operators.length - 1 : terminalOperatorIndex,
      1,
    )[0];
    if (operator) {
      snapshot.omitted.operators += 1;
      const retainedEdges = snapshot.edges.filter(
        (edge) =>
          edge.fromOperatorId !== operator.operatorId && edge.toOperatorId !== operator.operatorId,
      );
      snapshot.omitted.edges += snapshot.edges.length - retainedEdges.length;
      snapshot.edges = retainedEdges;
      continue;
    }
    throw new Error('Agent graph snapshot cannot fit the Runtime Host wire limit');
  }
}

function fitInspection(inspection: Mutable<AgentGraphOperatorInspection>): void {
  while (encodedBytes(inspection) > AGENT_GRAPH_RESULT_MAX_BYTES) {
    if (inspection.recentRecords.shift()) {
      inspection.omitted.records += 1;
      continue;
    }
    if (inspection.activations.shift()) {
      inspection.omitted.activations += 1;
      continue;
    }
    if (inspection.claims.shift()) {
      inspection.omitted.claims += 1;
      continue;
    }
    if (inspection.work.shift()) {
      inspection.omitted.work += 1;
      continue;
    }
    if (inspection.inboundEdges.shift()) {
      inspection.omitted.inboundEdges += 1;
      continue;
    }
    if (inspection.outboundEdges.shift()) {
      inspection.omitted.outboundEdges += 1;
      continue;
    }
    throw new Error('Agent graph operator inspection cannot fit the Runtime Host wire limit');
  }
}

function updateTerminalCursor(snapshot: Mutable<AgentGraphClientSnapshot>): void {
  const last = snapshot.terminalHistory.records.at(-1);
  if (last) {
    snapshot.terminalHistory.nextCursor = encodeAgentGraphTerminalCursor(snapshot.graphId, last);
  }
}

function projectChangedEvent(event: AgentGraphClientChangedEvent): {
  rootSessionId: string;
  graphId: string;
  reason: AgentGraphClientChangedEvent['reason'];
} {
  return {
    rootSessionId: event.rootSessionId,
    graphId: event.graphId,
    reason: event.reason,
  };
}

function graphQueryFailure(error: unknown): {
  ok: false;
  error: { code: GraphQueryFailureCode; message: string };
} {
  if (error instanceof AgentGraphClientOperationError) {
    return error.code === 'session_archived'
      ? failure('operation_conflict', error.message)
      : failure(error.code, error.message);
  }
  if (isSessionNotFoundError(error)) return failure('not_found', 'Session was not found');
  return failure('persistence_failed', 'Agent graph projection is unavailable');
}

function failure<Code extends RootOperationFailureCode | 'persistence_failed' | 'internal_failure'>(
  code: Code,
  message: string,
): { ok: false; error: { code: Code; message: string } } {
  return { ok: false, error: { code, message } };
}

function requireFingerprint(value: string): `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Agent graph projection contains an invalid fingerprint');
  }
  return value as `sha256:${string}`;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
