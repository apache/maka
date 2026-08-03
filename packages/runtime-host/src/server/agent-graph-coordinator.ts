import type { SessionHeader } from '@maka/core/session';
import {
  AgentGraphOperatorNotFoundError,
  agentGraphIdForRootSession,
  decodeAgentGraphTerminalCursor,
  encodeAgentGraphTerminalCursor,
  type AgentGraphClientChangedEvent,
  type AgentGraphClientOperator as RuntimeAgentGraphClientOperator,
  type AgentGraphClientSnapshot as RuntimeAgentGraphClientSnapshot,
  type AgentGraphCoordinator,
  type AgentGraphOperatorInspection as RuntimeAgentGraphOperatorInspection,
} from '@maka/runtime';
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
  AGENT_GRAPH_MAX_STOPPED_TARGETS,
  AGENT_GRAPH_MAX_TERMINAL_ACTIVITY,
  AGENT_GRAPH_MAX_WORK,
  AGENT_GRAPH_RESULT_MAX_BYTES,
  type AgentGraphClientOperator,
  type AgentGraphClientSnapshot,
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
  'getSnapshot' | 'inspectOperator' | 'stop' | 'subscribeAll'
>;

type SessionReader = {
  readHeaderSnapshot(sessionId: string): Promise<SessionHeader>;
};

type GraphContinuity = Pick<SessionContinuityCoordinator, 'enqueueAgentGraphChanged'>;

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

type RootOperationFailureCode =
  | 'not_found'
  | 'session_archived'
  | 'operation_conflict'
  | 'invalid_request';

type GraphQueryFailureCode =
  | Exclude<RootOperationFailureCode, 'session_archived'>
  | 'persistence_failed';

class RootOperationError extends Error {
  constructor(
    readonly code: RootOperationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'RootOperationError';
  }
}

/** Client-facing Runtime Host adapter over the durable Agent Graph read model. */
export class HostAgentGraphCoordinator {
  readonly handlers: AgentGraphOperationHandlerMap = {
    'agent.graph.query': (input) => this.#query(input),
    'agent.graph.operator.query': (input) => this.#queryOperator(input),
    'agent.graph.stop': (input) => this.#stop(input),
  };

  readonly #authority: AgentGraphAuthority;
  readonly #sessions: SessionReader;
  #unsubscribe: (() => void) | undefined;

  constructor(options: {
    authority: AgentGraphAuthority;
    sessions: SessionReader;
    continuity: GraphContinuity;
  }) {
    this.#authority = options.authority;
    this.#sessions = options.sessions;
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
      await this.#assertRoot(input.rootSessionId, true);
      if (input.terminalCursor) {
        let cursor: ReturnType<typeof decodeAgentGraphTerminalCursor>;
        try {
          cursor = decodeAgentGraphTerminalCursor(input.terminalCursor);
        } catch {
          throw new RootOperationError('invalid_request', 'Agent graph terminal cursor is invalid');
        }
        if (cursor.graphId !== agentGraphIdForRootSession(input.rootSessionId)) {
          throw new RootOperationError(
            'invalid_request',
            'Agent graph terminal cursor belongs to another root Session',
          );
        }
      }
      const snapshot = await this.#authority.getSnapshot(input.rootSessionId, {
        ...(input.terminalCursor ? { terminalCursor: input.terminalCursor } : {}),
      });
      return { ok: true, result: projectSnapshot(snapshot) };
    } catch (error) {
      return graphQueryFailure(error);
    }
  }

  async #queryOperator(
    input: AgentGraphOperatorQueryInput,
  ): Promise<OperationOutcome<'agent.graph.operator.query'>> {
    try {
      await this.#assertRoot(input.rootSessionId, true);
      const inspection = await this.#authority.inspectOperator(
        input.rootSessionId,
        input.operatorId,
      );
      return { ok: true, result: projectInspection(inspection) };
    } catch (error) {
      if (error instanceof AgentGraphOperatorNotFoundError) {
        return failure('not_found', 'Agent graph operator was not found');
      }
      return graphQueryFailure(error);
    }
  }

  async #stop(input: AgentGraphStopInput): Promise<OperationOutcome<'agent.graph.stop'>> {
    try {
      await this.#assertRoot(input.rootSessionId, false);
      await this.#authority.stop(input.rootSessionId);
      return {
        ok: true,
        result: {
          rootSessionId: input.rootSessionId,
          graphId: agentGraphIdForRootSession(input.rootSessionId),
        },
      };
    } catch (error) {
      if (error instanceof RootOperationError || isSessionNotFoundError(error)) {
        const code = error instanceof RootOperationError ? error.code : 'not_found';
        if (code === 'invalid_request') {
          return failure('internal_failure', 'Agent graph stop failed');
        }
        return failure(code, error instanceof Error ? error.message : 'Session was not found');
      }
      return failure('internal_failure', 'Agent graph stop failed');
    }
  }

  async #assertRoot(rootSessionId: string, allowArchived: boolean): Promise<void> {
    let header: SessionHeader;
    try {
      header = await this.#sessions.readHeaderSnapshot(rootSessionId);
    } catch (error) {
      if (isSessionNotFoundError(error)) {
        throw new RootOperationError('not_found', 'Session was not found');
      }
      throw error;
    }
    if (header.subagentParent) {
      throw new RootOperationError(
        'operation_conflict',
        'Agent graph Client operations require a root Session',
      );
    }
    if (!allowArchived && (header.isArchived || header.status === 'archived')) {
      throw new RootOperationError(
        'session_archived',
        'Archived Sessions cannot stop Agent graph execution',
      );
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
    snapshotVersion: requireFingerprint(snapshot.snapshotVersion),
    status: snapshot.status,
    scheduleRevision: snapshot.scheduleRevision,
    topologyFingerprint: requireFingerprint(snapshot.topologyFingerprint),
    closed: snapshot.closed,
    ...(snapshot.latestEventTime === undefined
      ? {}
      : { latestEventTime: snapshot.latestEventTime }),
    operators,
    edges: candidateEdges.slice(0, AGENT_GRAPH_MAX_EDGES).map(clone),
    work: snapshot.work.slice(0, AGENT_GRAPH_MAX_WORK).map(clone),
    stoppedTargets: snapshot.stoppedTargets.slice(-AGENT_GRAPH_MAX_STOPPED_TARGETS).map(clone),
    ...(snapshot.finish ? { finish: clone(snapshot.finish) } : {}),
    claims: snapshot.claims.slice(-AGENT_GRAPH_MAX_CLAIMS).map(clone),
    recentControlDecisions: snapshot.recentControlDecisions
      .slice(-AGENT_GRAPH_MAX_CONTROL_DECISIONS)
      .map(clone),
    recentActivity: snapshot.recentActivity.slice(-AGENT_GRAPH_MAX_ACTIVITY).map(clone),
    terminalHistory: {
      records: snapshot.terminalHistory.records
        .slice(0, AGENT_GRAPH_MAX_TERMINAL_ACTIVITY)
        .map(clone),
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
    inboundEdges: inspection.inboundEdges.slice(-AGENT_GRAPH_MAX_INSPECTION_EDGES).map(clone),
    outboundEdges: inspection.outboundEdges.slice(-AGENT_GRAPH_MAX_INSPECTION_EDGES).map(clone),
    work: inspection.work.slice(-AGENT_GRAPH_MAX_INSPECTION_WORK).map(clone),
    claims: inspection.claims.slice(-AGENT_GRAPH_MAX_INSPECTION_CLAIMS).map(clone),
    activations: inspection.activations.slice(-AGENT_GRAPH_MAX_INSPECTION_ACTIVATIONS).map(clone),
    recentRecords: inspection.recentRecords.slice(-AGENT_GRAPH_MAX_INSPECTION_RECORDS).map(clone),
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
    const waitingFor = eligibleWaits.slice(0, AGENT_GRAPH_MAX_READINESS_WAITS).map(clone);
    return {
      ...clone(entry),
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
    ...clone(operator),
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
  if (error instanceof RootOperationError) {
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

function clone<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}
